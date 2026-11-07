// Web Worker running Pyodide. Owns the Python interpreter state and the
// incomplete multi-line source. Spawned by offscreen.js, one worker per
// session generation; the offscreen <-> worker protocol is private to the two
// files:
//
// offscreen -> worker
//   {type: "init", sessionId, interruptBuffer: Uint8Array(SAB) | null}
//   {type: "exec", id, line}
//   {type: "complete", id, source}
//   {type: "discard"}                 idle Ctrl-C: drop pending multi-line source
// worker -> offscreen (every message carries sessionId)
//   {type: "ready", banner, timings}
//   {type: "init-error", message}
//   {type: "output", kind: "stdout"|"stderr"|"info", text}   <= OUTPUT_CHUNK_CHARS
//   {type: "overflow"}                once per execution; asks for an interrupt
//   {type: "exec-done", id, status: "complete"|"incomplete"|"exit"}
//   {type: "complete-result", id, matches}   matches replace the whole `source`
//   {type: "fatal", message}          interpreter unusable; session must restart

import { loadPyodide } from "./vendor/pyodide/pyodide.mjs";

const PYODIDE_INDEX_URL = new URL("./vendor/pyodide/", import.meta.url).href;
const PRELOADED_MODULES = ["math", "random", "statistics"];
const KIB = 1024;
// All character counts are JavaScript UTF-16 code units.
const OUTPUT_BUDGET_CHARS = 16 * KIB; // per execution, including the notice
const OUTPUT_CHUNK_CHARS = 4 * KIB;
const OUTPUT_FLUSH_DELAY_MS = 50;
const TRUNCATION_NOTICE = "\n[output truncated at 16 Ki characters; interrupting]\n";
const OUTPUT_CONTENT_BUDGET = OUTPUT_BUDGET_CHARS - TRUNCATION_NOTICE.length;
// Python-side pre-truncation per write, so a giant str never crosses into JS.
// Code points <= UTF-16 units, so this is always enough to detect overflow.
const PY_WRITE_CAP = OUTPUT_BUDGET_CHARS + 1;
// Must not be "<console>" or "<exec>": Console keeps traceback frames from the
// first frame with one of those filenames, and our glue would show up.
const PY_SETUP_FILENAME = "<repl-glue>";
const RESULT_INCOMPLETE = "incomplete";
const RESULT_COMPLETE = "complete";
const RESULT_EXIT = "exit";

// Python glue. Runs once in the worker's interpreter. `_repl_emit(kind, s)` is
// the JS output sink; it returns False once this execution's budget is spent.
const PY_SETUP = `
import builtins, json, sys
from pyodide.console import Console

class _ReplExit(BaseException):
    """Raised by exit()/quit(); the worker turns it into a session reset."""

class _Quitter:
    def __init__(self, name):
        self.name = name
    def __repr__(self):
        return f"Use {self.name}() or Ctrl-D (i.e. EOF) to exit"
    def __call__(self, code=None):
        raise _ReplExit()

_repl_state = {"suppressed": False}

def _repl_writer(kind):
    def write(s):
        if _repl_state["suppressed"] or not s:
            return
        if not _repl_emit(kind, s[:${PY_WRITE_CAP}]):
            _repl_state["suppressed"] = True
    return write

_repl_stdout = _repl_writer("stdout")
_repl_stderr = _repl_writer("stderr")

_repl_ns = {"__name__": "__main__", "__doc__": None}
exec("import ${PRELOADED_MODULES.join(", ")}", _repl_ns)
for _name in ("exit", "quit"):
    _repl_ns[_name] = _Quitter(_name)
    setattr(builtins, _name, _repl_ns[_name])
del _name

class _ReplCaught:
    """Carries KeyboardInterrupt/SystemExit out of the console's asyncio task.

    asyncio re-raises those two from Task steps, which would escape the
    webloop as an uncaught worker error instead of reaching the future."""
    __slots__ = ("exc",)
    def __init__(self, exc):
        self.exc = exc

class _ReplConsole(Console):
    async def runcode(self, source, code):
        try:
            return await super().runcode(source, code)
        except (KeyboardInterrupt, SystemExit, _ReplExit) as e:
            return _ReplCaught(e)

# CPython 3.14's codeop reports some plain syntax errors ("1+") as
# _IncompleteInputError; the interactive interpreter shows them as SyntaxError.
_REPL_INCOMPLETE_ERR = "_IncompleteInputError: incomplete input"
_REPL_SYNTAX_ERR = "SyntaxError: invalid syntax"

_repl_console = _ReplConsole(
    _repl_ns,
    stdout_callback=_repl_stdout,
    stderr_callback=_repl_stderr,
)

def _repl_format_exc(console, e):
    try:
        return console.formattraceback(e)
    except BaseException:
        import traceback
        return "".join(traceback.format_exception(e))

async def _repl_run_line(line):
    _repl_state["suppressed"] = False
    fut = _repl_console.push(line)
    if fut.syntax_check == "syntax-error":
        _repl_stderr(fut.formatted_error.replace(_REPL_INCOMPLETE_ERR, _REPL_SYNTAX_ERR))
        return "${RESULT_COMPLETE}"
    if fut.syntax_check == "incomplete":
        return "${RESULT_INCOMPLETE}"
    try:
        value = await fut
    except (_ReplExit, SystemExit):
        return "${RESULT_EXIT}"
    except BaseException as e:
        _repl_stderr(getattr(fut, "formatted_error", None) or _repl_format_exc(_repl_console, e))
        return "${RESULT_COMPLETE}"
    if isinstance(value, _ReplCaught):
        if isinstance(value.exc, (_ReplExit, SystemExit)):
            return "${RESULT_EXIT}"
        _repl_stderr(_repl_format_exc(_repl_console, value.exc))
        return "${RESULT_COMPLETE}"
    if value is not None:
        builtins._ = value
        try:
            text = repr(value)
        except (_ReplExit, SystemExit):
            return "${RESULT_EXIT}"
        except BaseException as e:
            _repl_stderr(_repl_format_exc(_repl_console, e))
            return "${RESULT_COMPLETE}"
        _repl_stdout(text + "\\n")
    return "${RESULT_COMPLETE}"

def _repl_complete(source):
    # Full replacements of the source (protocol: popup replaces its text up to
    # the cursor), not just the completed word.
    matches, start = _repl_console.complete(source)
    prefix = source[:start]
    return json.dumps([prefix + m for m in matches])

def _repl_discard():
    _repl_console.buffer.clear()

_repl_version = sys.version.split()[0]
`;

const t0 = performance.now();
let sessionId = null;
let runLine = null;
let completeSource = null;
let discardPending = null;

// Output batching state for the current execution.
let usedChars = 0;
let overflowed = false;
let pending = []; // [{kind, text}], consecutive same-kind segments merged
let pendingChars = 0;
let flushTimer = null;

function post(message) {
  self.postMessage({ ...message, sessionId });
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function appendPending(kind, text) {
  if (text.length === 0) return;
  const last = pending[pending.length - 1];
  if (last && last.kind === kind) last.text += text;
  else pending.push({ kind, text });
  pendingChars += text.length;
}

function flushOutput() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const { kind, text } of pending) {
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + OUTPUT_CHUNK_CHARS, text.length);
      // Don't split a surrogate pair across chunks.
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
      post({ type: "output", kind, text: text.slice(i, end) });
      i = end;
    }
  }
  pending = [];
  pendingChars = 0;
}

function scheduleFlush() {
  // Only fires when the worker's event loop is free (e.g. during an await);
  // synchronous Python relies on the chunk-size flush instead.
  if (flushTimer === null) flushTimer = setTimeout(flushOutput, OUTPUT_FLUSH_DELAY_MS);
}

// Called synchronously from Python for every stdout/stderr write.
function emit(kind, text) {
  if (overflowed) return false;
  const remaining = OUTPUT_CONTENT_BUDGET - usedChars;
  if (text.length > remaining) {
    let cut = text.slice(0, remaining);
    if (cut.length > 0 && isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
    appendPending(kind, cut);
    usedChars += cut.length;
    appendPending("info", TRUNCATION_NOTICE);
    usedChars += TRUNCATION_NOTICE.length;
    overflowed = true;
    flushOutput();
    post({ type: "overflow" });
    return false;
  }
  appendPending(kind, text);
  usedChars += text.length;
  if (pendingChars >= OUTPUT_CHUNK_CHARS) flushOutput();
  else scheduleFlush();
  return true;
}

function beginExecution() {
  usedChars = 0;
  overflowed = false;
  pending = [];
  pendingChars = 0;
}

async function init(message) {
  sessionId = message.sessionId;
  const tLoad = performance.now();
  const pyodide = await loadPyodide({
    indexURL: PYODIDE_INDEX_URL,
    // Interpreter-level output outside an execution (should not happen) goes
    // to the worker console, never to the transcript.
    stdout: (s) => console.log("[py]", s),
    stderr: (s) => console.warn("[py]", s),
  });
  const tLoaded = performance.now();
  if (message.interruptBuffer) pyodide.setInterruptBuffer(message.interruptBuffer);
  pyodide.globals.set("_repl_emit", emit);
  pyodide.runPython(PY_SETUP, { filename: PY_SETUP_FILENAME });
  const tSetup = performance.now();
  runLine = pyodide.globals.get("_repl_run_line");
  completeSource = pyodide.globals.get("_repl_complete");
  discardPending = pyodide.globals.get("_repl_discard");
  const version = pyodide.globals.get("_repl_version");
  // Two short lines so the 400 px popup never wraps mid-phrase.
  const banner = `Python ${version} (offline)\n${PRELOADED_MODULES.join(", ")} imported`;
  post({
    type: "ready",
    banner,
    timings: {
      workerStartToInit: tLoad - t0,
      loadPyodide: tLoaded - tLoad,
      setup: tSetup - tLoaded,
      total: tSetup - t0,
    },
  });
}

async function exec(message) {
  beginExecution();
  let status;
  try {
    status = await runLine(message.line);
  } catch (err) {
    if (err && err.constructor && err.constructor.name === "PythonError") {
      // A Python exception escaped the glue (e.g. KeyboardInterrupt landing
      // between statements of _repl_run_line). Show it; the session survives.
      emit("stderr", errorMessage(err).replace(/\n?$/, "\n"));
      status = RESULT_COMPLETE;
    } else {
      flushOutput();
      post({ type: "fatal", message: errorMessage(err) });
      return;
    }
  }
  flushOutput();
  post({ type: "exec-done", id: message.id, status });
}

function complete(message) {
  let matches;
  try {
    matches = JSON.parse(completeSource(message.source));
  } catch (err) {
    console.warn("[worker] completion failed:", err);
    matches = [];
  }
  post({ type: "complete-result", id: message.id, matches });
}

async function handle(message) {
  switch (message.type) {
    case "init":
      try {
        await init(message);
      } catch (err) {
        console.error("[worker] init failed:", err);
        post({ type: "init-error", message: errorMessage(err) });
      }
      return;
    case "exec":
      if (runLine === null) return; // init failed; offscreen already knows
      await exec(message);
      return;
    case "complete":
      if (completeSource === null) return;
      complete(message);
      return;
    case "discard":
      if (discardPending !== null) discardPending();
      return;
    default:
      console.warn("[worker] unknown message", message);
  }
}

// Pyodide's interrupt machinery can surface stray promise rejections after a
// KeyboardInterrupt. They don't mean the interpreter is broken (real failures
// come back through exec()/init()), so log instead of letting them look like
// worker crashes.
if (typeof self.addEventListener === "function") {
  self.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    console.warn("[worker] ignored unhandled rejection:", event.reason);
  });
}

// Serialize message handling: Python executions, completions and discards run
// strictly in arrival order, never interleaved across an await.
let queue = Promise.resolve();
self.onmessage = (event) => {
  const message = event.data;
  queue = queue
    .then(() => handle(message))
    .catch((err) => {
      console.error("[worker] handler failed:", err);
      post({ type: "fatal", message: errorMessage(err) });
    });
};
