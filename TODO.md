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
- [ ] **README screenshots.** Add a screenshot or short GIF of the popup near
  the top of the README (a prompt with a result, plus the completion menu
  open). Add a `make screenshots` rule that reuses the smoke-test Puppeteer
  setup in `.cache/chrome-test/`: drive `popup.html` through a fixed session
  and write PNGs to a committed `docs/` path, so the images can be regenerated
  after UI changes instead of captured by hand.
- [ ] **Publish to the Chrome Web Store.** Today users must install `uv`, build,
  and load the extension unpacked. A listing needs: a developer account, the
  `make zip` package (including the upstream license notices for Pyodide and
  CPython), store screenshots (1280x800 or 640x400) and a 440x280 promo tile,
  a privacy policy or disclosures (no data collected, no network access), and
  a justification for the `offscreen` permission and `wasm-unsafe-eval`. Add an
  install link to the README once it's live.
- [x] Autocomplete UX for long candidate lists (e.g. `math.<tab><tab>`):
  replaced the transcript listing with a transient, filter-as-you-type menu
  above the input line.
