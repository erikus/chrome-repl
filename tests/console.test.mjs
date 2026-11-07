// Loads the trimmed Pyodide bundle from vendor/pyodide/ and exercises
// pyodide.console.Console the way worker.js will. Guards the stdlib allowlist
// in scripts/fetch_pyodide.py: any ModuleNotFoundError fails the test.
//
// Run: node --test tests/
// Set PYODIDE_TRACE_MODULES=1 to print every stdlib file loaded (used to
// re-derive the allowlist against an --untrimmed vendor build).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "pyodide");
const CONSOLE_FILENAME = "<console>";
const EXPECTED_PYTHON_MAJOR_MINOR = "3.14";
const TRACE_ENV = "PYODIDE_TRACE_MODULES";
const LOAD_TIMEOUT_MS = 60_000;

// Python helper: awaits a ConsoleFuture, sets builtins._ like the real REPL,
// and returns [repr(result) | null]. Awaiting a ConsoleFuture PyProxy
// directly from JS destroys it, which would lose `formatted_error`.
const AWAIT_FUT_SRC = `
import builtins
from pyodide.ffi import to_js

async def await_fut(fut):
    res = await fut
    if res is not None:
        builtins._ = res
    return to_js([None if res is None else repr(res)], depth=1)

await_fut
`;

const fetchCalls = [];
let pyodide;
let console_;
let awaitFut;
const stdout = [];
const stderr = [];

// Returns {status, value?, error?}. status is the Console syntax_check.
async function push(line) {
  const fut = console_.push(line);
  try {
    const status = fut.syntax_check;
    if (status === "incomplete") return { status };
    if (status === "syntax-error") return { status, error: fut.formatted_error };
    const wrapped = awaitFut(fut);
    try {
      const [value] = await wrapped;
      return { status, value };
    } catch (e) {
      return { status, error: fut.formatted_error ?? String(e) };
    } finally {
      wrapped.destroy?.();
    }
  } finally {
    fut.destroy();
  }
}

async function run(line) {
  const r = await push(line);
  assert.equal(r.status, "complete", `${line}: ${JSON.stringify(r)}`);
  assert.ok(!r.error, `${line} raised:\n${r.error}`);
  return r.value;
}

before(async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    fetchCalls.push(String(url));
    return realFetch(url, ...rest);
  };
  const { loadPyodide } = await import(pathToFileURL(path.join(VENDOR_DIR, "pyodide.mjs")).href);
  pyodide = await loadPyodide({ indexURL: VENDOR_DIR + path.sep });
  const { Console } = pyodide.pyimport("pyodide.console");
  console_ = Console.callKwargs({ filename: CONSOLE_FILENAME });
  console_.stdout_callback = (s) => { stdout.push(s); };
  console_.stderr_callback = (s) => { stderr.push(s); };
  awaitFut = pyodide.runPython(AWAIT_FUT_SRC);
}, { timeout: LOAD_TIMEOUT_MS });

after(() => {
  if (pyodide && process.env[TRACE_ENV]) {
    const files = pyodide.runPython(`
import sys
sorted({f.split(".zip/", 1)[1] for m in list(sys.modules.values())
        if isinstance(f := getattr(m, "__file__", None), str) and ".zip/" in f})
`).toJs();
    process.stdout.write(`# loaded stdlib files:\n${files.join("\n")}\n`);
  }
});

test("Python version matches the pinned release", () => {
  const version = pyodide.runPython("import sys; sys.version.split()[0]");
  process.stdout.write(`# Pyodide ${pyodide.version}, Python ${version}\n`);
  assert.ok(version.startsWith(EXPECTED_PYTHON_MAJOR_MINOR + "."), version);
});

test("math, random, statistics import and evaluate", async () => {
  await run("import math, random, statistics");
  assert.equal(await run("math.sqrt(2)"), "1.4142135623730951");
  assert.equal(await run("statistics.mean([1,2,3])"), "2");
  const roll = Number(await run("random.randint(1,6)"));
  assert.ok(Number.isInteger(roll) && roll >= 1 && roll <= 6, String(roll));
  assert.equal(await run("_"), String(roll), "builtins._ holds the last result");
  // Pull in the heavier statistics/random paths (fractions, decimal, bisect...).
  await run("statistics.stdev([1,2,3,4]); statistics.median([3,1,2]); statistics.quantiles([1,2,3,4,5])");
  await run("statistics.NormalDist(0,1).cdf(1); statistics.linear_regression([1,2,3],[2,4,6])");
  await run("random.sample(range(10),3); random.choices([1,2],k=3); random.seed('x'); random.gauss(0,1)");
  await run("from fractions import Fraction; from decimal import Decimal; Fraction(1,3) + Decimal('1.1').as_integer_ratio()[0]");
});

test("multi-line for loop: incomplete, then runs on blank line", async () => {
  stdout.length = 0;
  assert.equal((await push("for i in range(3):")).status, "incomplete");
  assert.equal((await push("    print(i * i)")).status, "incomplete");
  const done = await push("");
  assert.equal(done.status, "complete");
  assert.equal(done.value, undefined, "None converts to undefined via to_js");
  assert.equal(stdout.join(""), "0\n1\n4\n");
});

test("tracebacks are CPython-formatted and trimmed to user frames", async () => {
  const r = await push("1/0");
  assert.equal(r.status, "complete");
  assert.equal(
    r.error,
    'Traceback (most recent call last):\n  File "<console>", line 1, in <module>\nZeroDivisionError: division by zero\n',
  );
  const nameErr = await push("pritn(1)");
  assert.match(nameErr.error, /NameError: name 'pritn' is not defined. Did you mean: 'print'\?/);
  const syntax = await push("def f(:");
  assert.equal(syntax.status, "syntax-error");
  assert.match(syntax.error, /File "<console>", line 1/);
});

test("help() works offline", async () => {
  stdout.length = 0;
  await run("help(math.sqrt)");
  assert.match(stdout.join(""), /sqrt\(x, \/\)/);
});

test('complete("math.") matches rlcompleter over dir(math)', async () => {
  const [candidates, start] = console_.complete("math.").toJs();
  assert.equal(start, 0);
  // rlcompleter.attr_matches: public names, "(" appended to callables.
  const expected = pyodide.runPython(`
import math
sorted(f"math.{n}(" if callable(getattr(math, n)) else f"math.{n}"
       for n in dir(math) if not n.startswith("_"))
`).toJs();
  assert.deepEqual([...candidates].sort(), expected);
  assert.ok(candidates.includes("math.sqrt("));
  assert.ok(candidates.includes("math.pi"));
  const [stat, statStart] = console_.complete("x = statistics.me").toJs();
  assert.equal(statStart, 4);
  assert.deepEqual([...stat].sort(), ["statistics.mean(", "statistics.median(", "statistics.median_grouped(", "statistics.median_high(", "statistics.median_low("]);
});

test("import numpy fails locally without any network attempt", async () => {
  const r = await push("import numpy");
  assert.equal(r.status, "complete");
  assert.match(r.error, /ModuleNotFoundError: No module named 'numpy'/);
  assert.deepEqual(fetchCalls, [], "fetch() must never be called");
});
