// Race-free adapter between the offscreen document's interrupt byte (a
// Uint8Array over a SharedArrayBuffer) and pyodide.setInterruptBuffer().
//
// Pyodide polls the buffer from the running interpreter with a plain
// read-then-clear (pyodide.asm.mjs, _Py_CheckEmscriptenSignals_Helper):
//
//   let result = buffer[0];  // reads 0 ...
//   buffer[0] = 0;           // ... and wipes a SIGINT stored in between
//   return result;
//
// The offscreen document writes SIGINT from another thread, so a Ctrl-C that
// lands between those two statements is silently lost: Python keeps running
// and the offscreen interrupt deadline restarts the worker, losing the
// user's variables. In a tight `while True: pass` the poll runs constantly,
// which made this hit about 1 in 10 Ctrl-Cs.
//
// The adapter turns Pyodide's clear into a compare-and-swap against the value
// Pyodide last read, so a signal that arrives after the read survives until
// the next poll. Reads stay plain loads, so Pyodide's other reader
// (checkInterrupt, which only peeks) behaves as before.
//
// No DOM, chrome.* or Pyodide imports, so Node tests can exercise it
// directly (tests/interrupt-buffer.test.mjs).

const SIGNAL_INDEX = 0;
const NO_SIGNAL = 0;

/**
 * @param {Uint8Array} view one-byte view over a SharedArrayBuffer
 * @returns {{0: number}} object to pass to pyodide.setInterruptBuffer()
 */
export function atomicInterruptBuffer(view) {
  if (!(view instanceof Uint8Array) || !(view.buffer instanceof SharedArrayBuffer)) {
    throw new TypeError("atomicInterruptBuffer needs a Uint8Array over a SharedArrayBuffer");
  }
  let lastRead = NO_SIGNAL;
  return {
    get [SIGNAL_INDEX]() {
      lastRead = Atomics.load(view, SIGNAL_INDEX);
      return lastRead;
    },
    set [SIGNAL_INDEX](value) {
      if (value === NO_SIGNAL) {
        // Clear only what Pyodide saw; a newer signal stays pending.
        Atomics.compareExchange(view, SIGNAL_INDEX, lastRead, NO_SIGNAL);
      } else {
        Atomics.store(view, SIGNAL_INDEX, value);
      }
    },
  };
}
