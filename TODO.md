# TODO

- [x] **Ctrl-C sometimes misses the 1 s interrupt deadline.** Fixed: Pyodide's
  non-atomic read-then-clear of the interrupt byte dropped ~1 in 10 Ctrl-Cs
  (not load); `interrupt-buffer.js` clears it with a compare-and-swap instead.
- [x] **README screenshots.** `make screenshots` runs `scripts/screenshots.mjs`
  (a fixed session, scenes in light and dark) into `docs/screenshots/`.
- [ ] **Publish to the Chrome Web Store.** Today users must install `uv`, build,
  and load the extension unpacked. The package (with `THIRD_PARTY_NOTICES.txt`),
  store assets (`make store-assets`), listing text, privacy answers and
  `PRIVACY.md` are ready; see [`docs/store-listing.md`](docs/store-listing.md).
  Remaining manual steps: register a developer account (US$5) and verify its
  email; merge `PRIVACY.md` to `main` so the policy URL resolves; upload the
  zip and assets and submit for review; once live, add the install link to the
  README.
- [x] Autocomplete UX for long candidate lists (e.g. `math.<tab><tab>`):
  replaced the transcript listing with a transient, filter-as-you-type menu
  above the input line.
