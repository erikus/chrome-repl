// Offscreen document: owns the REPL session (transcript, history, prompt,
// status), relays popup ports, and supervises the Pyodide worker.
// Popup protocol: docs/protocol.md. Worker protocol: header of worker.js.

import {
  MAX_BLOCK_CHARS,
  MAX_COMPLETION_CANDIDATES,
  MAX_COMPLETION_CHARS,
  MAX_LINE_CHARS,
  MSG_OFFSCREEN_PING,
  OFFSCREEN_TARGET,
  PORT_NAME,
  PROMPT_CONTINUATION,
  PROMPT_PRIMARY,
} from "./protocol.js";

const KIB = 1024;
const MAX_TRANSCRIPT_LINES = 200;
const MAX_TRANSCRIPT_CHARS = 32 * KIB;
const MAX_HISTORY_ENTRIES = 50;
const MAX_HISTORY_CHARS = 16 * KIB;
const SNAPSHOT_MIN_INTERVAL_MS = 50;
const INTERRUPT_GRACE_MS = 1000;
const INIT_TIMEOUT_MS = 30000;
const INTERRUPT_BUFFER_BYTES = 1;
const SIGINT = 2; // value Pyodide's interrupt buffer expects for KeyboardInterrupt
const WORKER_URL = new URL("./worker.js", import.meta.url);

const STATUS_STARTING = "starting";
const STATUS_READY = "ready";
const STATUS_RUNNING = "running";
const STATUS_ERROR = "error";

const KIND_INPUT = "input";
const KIND_STDOUT = "stdout";
const KIND_STDERR = "stderr";
const KIND_INFO = "info";
const WORKER_OUTPUT_KINDS = new Set([KIND_STDOUT, KIND_STDERR, KIND_INFO]);

const NOTICE_INTERRUPT_RESTART =
  "KeyboardInterrupt: Python did not stop, so it was restarted. Variables and history were lost.\n";
const workerCrashNotice = (why) =>
  `Python stopped unexpectedly (${why}) and was restarted. Variables and history were lost.\n`;

const t0 = performance.now();
const log = (...args) => console.log(`[offscreen +${(performance.now() - t0).toFixed(1)} ms]`, ...args);

// ---------------------------------------------------------------------------
// Session state

let session = null; // see freshSession()
let revision = 0; // global and monotonic, across sessions
let worker = null;
let interruptView = null; // Uint8Array over a SharedArrayBuffer, or null
let interruptTimer = null;
let initTimer = null;
let pendingBlockChars = 0; // chars of the incomplete multi-line block in the worker
let nextWorkerRequestId = 1;
let runningExecId = null;
const pendingCompletions = new Map(); // worker request id -> {port, requestId}

function freshSession() {
  return {
    id: crypto.randomUUID(),
    status: STATUS_STARTING,
    prompt: PROMPT_PRIMARY,
    banner: "",
    transcript: [], // [{kind, text, lines}]
    transcriptChars: 0,
    transcriptLines: 0,
    history: [],
    historyChars: 0,
    error: null,
    runningSince: null,
  };
}

function countLines(text) {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n += 1;
  if (!text.endsWith("\n")) n += 1;
  return n;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function appendTranscript(kind, text) {
  if (text.length === 0) return;
  const t = session.transcript;
  const last = t[t.length - 1];
  if (last && last.kind === kind && kind !== KIND_INPUT) {
    session.transcriptChars -= last.text.length;
    session.transcriptLines -= last.lines;
    last.text += text;
    last.lines = countLines(last.text);
    session.transcriptChars += last.text.length;
    session.transcriptLines += last.lines;
  } else {
    const entry = { kind, text, lines: countLines(text) };
    t.push(entry);
    session.transcriptChars += text.length;
    session.transcriptLines += entry.lines;
  }
  evictTranscript();
  markDirty();
}

// Evict oldest content until both caps hold, trimming the oldest entry at a
// line boundary where possible rather than always dropping it whole.
function evictTranscript() {
  const t = session.transcript;
  while (
    t.length > 0 &&
    (session.transcriptChars > MAX_TRANSCRIPT_CHARS || session.transcriptLines > MAX_TRANSCRIPT_LINES)
  ) {
    const first = t[0];
    const excessChars = session.transcriptChars - MAX_TRANSCRIPT_CHARS;
    const excessLines = session.transcriptLines - MAX_TRANSCRIPT_LINES;
    let cut = Math.max(0, excessChars);
    if (excessLines > 0) {
      let pos = -1;
      for (let k = 0; k < excessLines; k += 1) {
        pos = first.text.indexOf("\n", pos + 1);
        if (pos === -1) break;
      }
      cut = Math.max(cut, pos === -1 ? first.text.length : pos + 1);
    }
    if (cut > 0 && cut < first.text.length) {
      const nl = first.text.indexOf("\n", cut - 1);
      if (nl !== -1) cut = nl + 1;
      else if (isHighSurrogate(first.text.charCodeAt(cut - 1))) cut += 1;
    }
    session.transcriptChars -= first.text.length;
    session.transcriptLines -= first.lines;
    if (cut >= first.text.length || cut === 0) {
      t.shift();
    } else {
      first.text = first.text.slice(cut);
      first.lines = countLines(first.text);
      session.transcriptChars += first.text.length;
      session.transcriptLines += first.lines;
    }
  }
}

function appendHistory(line) {
  const h = session.history;
  h.push(line);
  session.historyChars += line.length;
  while (h.length > MAX_HISTORY_ENTRIES || session.historyChars > MAX_HISTORY_CHARS) {
    session.historyChars -= h.shift().length;
  }
}

function snapshotMessage() {
  return {
    type: "snapshot",
    sessionId: session.id,
    revision,
    state: {
      status: session.status,
      prompt: session.prompt,
      banner: session.banner,
      transcript: session.transcript.map(({ kind, text }) => ({ kind, text })),
      history: session.history.slice(),
      error: session.error,
      runningSince: session.runningSince,
    },
  };
}

function statusMessage() {
  return {
    type: "status",
    sessionId: session.id,
    status: session.status,
    prompt: session.prompt,
    runningSince: session.runningSince,
  };
}

function setStatus(status, { prompt = session.prompt, error = session.error } = {}) {
  const changed = status !== session.status || prompt !== session.prompt;
  session.status = status;
  session.prompt = prompt;
  session.error = error;
  session.runningSince = status === STATUS_RUNNING ? (session.runningSince ?? Date.now()) : null;
  if (changed) broadcastStatus();
  markDirty();
}

// ---------------------------------------------------------------------------
// Popup ports: immediate status messages, coalesced ack-gated snapshots

const ports = new Map(); // port -> {awaitingAck, dirty, timer, lastSentAt}

function safePost(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch (err) {
    log("post to popup failed, dropping port:", err);
    dropPort(port);
    return false;
  }
}

function broadcastStatus() {
  const message = statusMessage();
  for (const port of [...ports.keys()]) safePost(port, message);
}

function markDirty() {
  revision += 1;
  for (const [port, ps] of ports) scheduleSnapshot(port, ps);
}

function scheduleSnapshot(port, ps) {
  ps.dirty = true;
  if (ps.awaitingAck !== null || ps.timer !== null) return;
  const wait = Math.max(0, ps.lastSentAt + SNAPSHOT_MIN_INTERVAL_MS - performance.now());
  ps.timer = setTimeout(() => {
    ps.timer = null;
    sendSnapshot(port, ps);
  }, wait);
}

function sendSnapshot(port, ps) {
  if (!ps.dirty || ps.awaitingAck !== null || !ports.has(port)) return;
  const message = snapshotMessage();
  ps.dirty = false;
  ps.awaitingAck = message.revision;
  ps.lastSentAt = performance.now();
  safePost(port, message);
}

function dropPort(port) {
  const ps = ports.get(port);
  if (!ps) return;
  if (ps.timer !== null) clearTimeout(ps.timer);
  ports.delete(port);
  for (const [id, pc] of pendingCompletions) if (pc.port === port) pendingCompletions.delete(id);
}

function onConnect(port) {
  if (port.name !== PORT_NAME) return;
  const ps = { awaitingAck: null, dirty: true, timer: null, lastSentAt: -Infinity };
  ports.set(port, ps);
  port.onDisconnect.addListener(() => dropPort(port));
  port.onMessage.addListener((message) => onPortMessage(port, ps, message));
  log(`popup connected (session ${session.id}, status ${session.status})`);
  // Reopening the popup retries a failed startup.
  if (session.status === STATUS_ERROR) {
    startSession();
    return; // startSession() marks dirty, which sends the first snapshot
  }
  sendSnapshot(port, ps);
}

function onPortMessage(port, ps, message) {
  if (!message || typeof message.type !== "string") return;
  switch (message.type) {
    case "ack":
      if (typeof message.revision === "number" && ps.awaitingAck !== null && message.revision >= ps.awaitingAck) {
        ps.awaitingAck = null;
        if (ps.dirty) scheduleSnapshot(port, ps);
      }
      return;
    case "submit":
      onSubmit(port, message);
      return;
    case "complete":
      onComplete(port, message);
      return;
    case "listing":
      if (typeof message.text === "string") appendTranscript(KIND_INFO, message.text);
      return;
    case "interrupt":
      onInterrupt(typeof message.line === "string" ? message.line : "");
      return;
    case "clear":
      clearTranscript();
      return;
    case "reset":
      startSession();
      return;
    default:
      log("unknown popup message", message.type);
  }
}

// Ctrl-L: like a terminal clear, the banner goes too; only a reset brings it back.
function clearTranscript() {
  session.banner = "";
  session.transcript = [];
  session.transcriptChars = 0;
  session.transcriptLines = 0;
  markDirty();
}

function rejectSubmit(port, requestId, reason) {
  safePost(port, { type: "submit-result", requestId, accepted: false, reason });
}

function onSubmit(port, { requestId, line }) {
  if (typeof line !== "string") return rejectSubmit(port, requestId, "invalid input");
  if (session.status === STATUS_RUNNING) return rejectSubmit(port, requestId, "busy: code is still running");
  if (session.status === STATUS_STARTING) return rejectSubmit(port, requestId, "Python is still starting");
  if (session.status !== STATUS_READY) return rejectSubmit(port, requestId, "Python is not available");
  if (line.length > MAX_LINE_CHARS) {
    return rejectSubmit(port, requestId, `line too long (${line.length} > ${MAX_LINE_CHARS} characters)`);
  }
  const blockChars = pendingBlockChars + line.length + 1;
  if (blockChars > MAX_BLOCK_CHARS) {
    return rejectSubmit(port, requestId, `block too long (> ${MAX_BLOCK_CHARS} characters); Ctrl-C to discard it`);
  }
  safePost(port, { type: "submit-result", requestId, accepted: true });

  appendTranscript(KIND_INPUT, `${session.prompt}${line}\n`);
  if (line.trim() !== "") appendHistory(line);
  pendingBlockChars = blockChars;
  if (interruptView) Atomics.store(interruptView, 0, 0);
  runningExecId = nextWorkerRequestId++;
  worker.postMessage({ type: "exec", id: runningExecId, line });
  setStatus(STATUS_RUNNING);
}

function emptyCompletion(port, requestId) {
  safePost(port, { type: "complete-result", requestId, matches: [], truncated: false });
}

function onComplete(port, { requestId, source }) {
  if (typeof source !== "string" || source.length > MAX_LINE_CHARS || session.status !== STATUS_READY) {
    return emptyCompletion(port, requestId);
  }
  const id = nextWorkerRequestId++;
  pendingCompletions.set(id, { port, requestId });
  worker.postMessage({ type: "complete", id, source });
}

function capCompletions(rawMatches) {
  const unique = [...new Set(rawMatches.filter((m) => typeof m === "string"))].sort();
  const matches = [];
  let chars = 0;
  for (const m of unique) {
    if (matches.length >= MAX_COMPLETION_CANDIDATES || chars + m.length > MAX_COMPLETION_CHARS) break;
    matches.push(m);
    chars += m.length;
  }
  return { matches, truncated: matches.length < unique.length };
}

function onInterrupt(line) {
  if (session.status === STATUS_RUNNING) {
    requestInterrupt();
    return;
  }
  // Idle Ctrl-C: echo, drop pending multi-line source, back to the primary prompt.
  appendTranscript(KIND_INPUT, `${session.prompt}${line.slice(0, MAX_LINE_CHARS)}^C\n`);
  appendTranscript(KIND_STDERR, "KeyboardInterrupt\n");
  pendingBlockChars = 0;
  if (worker && session.status === STATUS_READY) worker.postMessage({ type: "discard" });
  setStatus(session.status, { prompt: PROMPT_PRIMARY });
}

function requestInterrupt() {
  if (interruptTimer !== null) return; // already in progress
  if (!interruptView) {
    log("interrupt: no SharedArrayBuffer, restarting worker");
    startSession(NOTICE_INTERRUPT_RESTART);
    return;
  }
  Atomics.store(interruptView, 0, SIGINT);
  const sessionAtRequest = session.id;
  interruptTimer = setTimeout(() => {
    interruptTimer = null;
    if (session.id !== sessionAtRequest || session.status !== STATUS_RUNNING) return;
    log(`interrupt not honoured within ${INTERRUPT_GRACE_MS} ms, restarting worker`);
    startSession(NOTICE_INTERRUPT_RESTART);
  }, INTERRUPT_GRACE_MS);
}

function clearInterruptState() {
  if (interruptTimer !== null) clearTimeout(interruptTimer);
  interruptTimer = null;
  if (interruptView) Atomics.store(interruptView, 0, 0);
}

// ---------------------------------------------------------------------------
// Worker supervision

function stopWorker() {
  clearInterruptState();
  if (initTimer !== null) clearTimeout(initTimer);
  initTimer = null;
  if (worker) worker.terminate();
  worker = null;
  interruptView = null;
  runningExecId = null;
  pendingBlockChars = 0;
  for (const { port, requestId } of pendingCompletions.values()) emptyCompletion(port, requestId);
  pendingCompletions.clear();
}

function createInterruptView() {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function") return null;
  try {
    return new Uint8Array(new SharedArrayBuffer(INTERRUPT_BUFFER_BYTES));
  } catch (err) {
    log("SharedArrayBuffer unavailable:", err);
    return null;
  }
}

// Start (or restart) a session: clears all session state before the new
// worker exists, so nothing from the old generation can leak in.
function startSession(notice = null) {
  stopWorker();
  session = freshSession();
  if (notice) appendTranscript(KIND_INFO, notice);

  const tSpawn = performance.now();
  interruptView = createInterruptView();
  log(`starting session ${session.id}; interrupt via ${interruptView ? "SharedArrayBuffer" : "worker restart"}`);
  const w = new Worker(WORKER_URL, { type: "module" });
  worker = w;
  const sessionId = session.id;
  const isCurrent = () => worker === w && session.id === sessionId;

  w.onmessage = (event) => {
    const message = event.data;
    if (!isCurrent() || !message || message.sessionId !== sessionId) return; // stale generation
    onWorkerMessage(message, tSpawn);
  };
  w.onerror = (event) => {
    event.preventDefault();
    if (!isCurrent()) return;
    const why = event.message || "failed to load the Python worker";
    log("worker error:", why);
    onWorkerFailure(why);
  };
  w.onmessageerror = () => {
    if (isCurrent()) onWorkerFailure("unreadable message from worker");
  };
  w.postMessage({ type: "init", sessionId, interruptBuffer: interruptView });

  initTimer = setTimeout(() => {
    initTimer = null;
    if (isCurrent() && session.status === STATUS_STARTING) {
      onWorkerFailure(`Python did not start within ${INIT_TIMEOUT_MS / 1000} s`);
    }
  }, INIT_TIMEOUT_MS);

  broadcastStatus();
  markDirty();
}

function onWorkerFailure(why) {
  if (session.status === STATUS_STARTING || session.status === STATUS_ERROR) {
    // Init failure: don't loop restarting; surface it. Reopening the popup or
    // a reset retries.
    stopWorker();
    setStatus(STATUS_ERROR, { prompt: PROMPT_PRIMARY, error: `Python failed to start: ${why}` });
    return;
  }
  startSession(workerCrashNotice(why));
}

function onWorkerMessage(message, tSpawn) {
  switch (message.type) {
    case "ready": {
      if (initTimer !== null) clearTimeout(initTimer);
      initTimer = null;
      const t = message.timings || {};
      const fmt = (v) => (typeof v === "number" ? v.toFixed(1) : "?");
      log(
        `Python ready ${fmt(performance.now() - tSpawn)} ms after spawn ` +
          `(worker: start->init ${fmt(t.workerStartToInit)}, loadPyodide ${fmt(t.loadPyodide)}, ` +
          `setup ${fmt(t.setup)}, total ${fmt(t.total)} ms)`,
      );
      session.banner = typeof message.banner === "string" ? message.banner : "";
      setStatus(STATUS_READY, { prompt: PROMPT_PRIMARY, error: null });
      return;
    }
    case "init-error":
      onWorkerFailure(String(message.message));
      return;
    case "fatal":
      log("worker fatal:", message.message);
      onWorkerFailure(String(message.message));
      return;
    case "output":
      if (WORKER_OUTPUT_KINDS.has(message.kind) && typeof message.text === "string") {
        appendTranscript(message.kind, message.text);
      }
      return;
    case "overflow":
      if (session.status === STATUS_RUNNING) requestInterrupt();
      return;
    case "exec-done": {
      if (message.id !== runningExecId) return;
      runningExecId = null;
      clearInterruptState();
      if (message.status === "exit") {
        startSession();
        return;
      }
      const incomplete = message.status === "incomplete";
      if (!incomplete) pendingBlockChars = 0;
      setStatus(STATUS_READY, { prompt: incomplete ? PROMPT_CONTINUATION : PROMPT_PRIMARY });
      return;
    }
    case "complete-result": {
      const pc = pendingCompletions.get(message.id);
      if (!pc) return;
      pendingCompletions.delete(message.id);
      const { matches, truncated } = capCompletions(Array.isArray(message.matches) ? message.matches : []);
      // Each match is a full replacement for the `source` the popup sent.
      safePost(pc.port, { type: "complete-result", requestId: pc.requestId, matches, truncated });
      return;
    }
    default:
      log("unknown worker message", message.type);
  }
}

// ---------------------------------------------------------------------------
// Wiring. Handlers are installed before the readiness probe can succeed.

chrome.runtime.onConnect.addListener(onConnect);
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== OFFSCREEN_TARGET) return false;
  if (message.type === MSG_OFFSCREEN_PING) sendResponse({ ok: true });
  return false;
});

log(`loaded; crossOriginIsolated=${globalThis.crossOriginIsolated}`);
startSession();
