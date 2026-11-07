# TODO

- [x] **Ctrl-C sometimes misses the 1 s interrupt deadline.** Fixed: Pyodide's
  non-atomic read-then-clear of the interrupt byte dropped ~1 in 10 Ctrl-Cs
  (not load); `interrupt-buffer.js` clears it with a compare-and-swap instead.
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
