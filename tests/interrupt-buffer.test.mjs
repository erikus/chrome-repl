// Unit tests for the race-free interrupt buffer adapter.
// Run: node --test tests/  (part of `make test`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { atomicInterruptBuffer } from "../interrupt-buffer.js";

const SIGINT = 2; // offscreen.js SIGINT
const BUFFER_BYTES = 1; // offscreen.js INTERRUPT_BUFFER_BYTES

function sharedView() {
  return new Uint8Array(new SharedArrayBuffer(BUFFER_BYTES));
}

// Pyodide's poll (_Py_CheckEmscriptenSignals_Helper), with a hook for a store
// from the other thread between its read and its clear.
function pyodidePoll(buffer, betweenReadAndClear = () => {}) {
  const result = buffer[0];
  betweenReadAndClear();
  buffer[0] = 0;
  return result;
}

test("raw Uint8Array loses a signal stored between Pyodide's read and clear", () => {
  // Documents the Pyodide race the adapter exists for.
  const view = sharedView();
  assert.equal(pyodidePoll(view, () => Atomics.store(view, 0, SIGINT)), 0);
  assert.equal(pyodidePoll(view), 0, "signal was wiped");
});

test("adapter keeps a signal stored between Pyodide's read and clear", () => {
  const view = sharedView();
  const buffer = atomicInterruptBuffer(view);
  assert.equal(pyodidePoll(buffer, () => Atomics.store(view, 0, SIGINT)), 0);
  assert.equal(Atomics.load(view, 0), SIGINT);
  assert.equal(pyodidePoll(buffer), SIGINT, "next poll delivers it");
  assert.equal(Atomics.load(view, 0), 0, "and consumes it");
});

test("adapter delivers and clears a signal pending before the poll", () => {
  const view = sharedView();
  const buffer = atomicInterruptBuffer(view);
  assert.equal(pyodidePoll(buffer), 0);
  Atomics.store(view, 0, SIGINT);
  assert.equal(pyodidePoll(buffer), SIGINT);
  assert.equal(pyodidePoll(buffer), 0, "delivered once");
});

test("adapter: an offscreen reset between read and clear stays reset", () => {
  const view = sharedView();
  const buffer = atomicInterruptBuffer(view);
  Atomics.store(view, 0, SIGINT);
  assert.equal(pyodidePoll(buffer, () => Atomics.store(view, 0, 0)), SIGINT);
  assert.equal(Atomics.load(view, 0), 0);
});

test("adapter: nonzero writes pass through", () => {
  const view = sharedView();
  const buffer = atomicInterruptBuffer(view);
  buffer[0] = SIGINT;
  assert.equal(Atomics.load(view, 0), SIGINT);
});

test("adapter rejects a non-shared buffer", () => {
  assert.throws(() => atomicInterruptBuffer(new Uint8Array(BUFFER_BYTES)), TypeError);
});
