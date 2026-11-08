# TODO

- [x] **Ctrl-C sometimes misses the 1 s interrupt deadline.** Fixed: Pyodide's
  non-atomic read-then-clear of the interrupt byte dropped ~1 in 10 Ctrl-Cs
  (not load); `interrupt-buffer.js` clears it with a compare-and-swap instead.
- [x] **README screenshots.** `make screenshots` runs `scripts/screenshots.mjs`
  (a fixed session, scenes in light and dark) into `docs/screenshots/`.
- [ ] **Publish to the Chrome Web Store.** Version 0.1.0 (tag `v0.1.0`) was
  submitted for review on 2026-11-08 with the three screenshots and the small
  promo tile from `docs/store/`; see
  [`docs/store-listing.md`](docs/store-listing.md). While in review: keep
  `PRIVACY.md` at its path on `main` (the listing links to it), and hold code
  changes, since uploading a new zip cancels the review and needs a version
  bump. Once live, add the store install link to the README above
  "Install (Unpacked)".
- [x] Autocomplete UX for long candidate lists (e.g. `math.<tab><tab>`):
  replaced the transcript listing with a transient, filter-as-you-type menu
  above the input line.
