# TODO

- [ ] **Ctrl-C sometimes misses the 1 s interrupt deadline.** In about 1 of 6
  `make smoke` runs, `while True: pass` + Ctrl-C did not stop within
  `offscreen.js`'s 1 s interrupt timeout. The SharedArrayBuffer path normally
  stops it in 2–3 ms. The fallback then restarts the worker, and the user
  loses their variables. Seen once, while a visible Chrome for Testing window
  was also running (machine under load?). Next steps: reproduce in a loop and
  log when the interrupt byte is written versus when `KeyboardInterrupt` is
  raised. Then consider re-signalling, a longer or adaptive deadline, or a
  confirm-before-restart step.
- [ ] Autocomplete UX for long candidate lists (e.g. `math.<tab><tab>`):
  consider a transient, filter-as-you-type listing instead of appending
  to the transcript.
