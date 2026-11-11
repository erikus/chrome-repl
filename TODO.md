# TODO

- [x] **Ctrl-C sometimes misses the 1 s interrupt deadline.** Fixed: Pyodide's
  non-atomic read-then-clear of the interrupt byte dropped ~1 in 10 Ctrl-Cs
  (not load); `interrupt-buffer.js` clears it with a compare-and-swap instead.
- [x] **README screenshots.** `make screenshots` runs `scripts/screenshots.mjs`
  (a fixed session, scenes in light and dark) into `docs/screenshots/`.
- [x] **Publish to the Chrome Web Store.** Version 0.1.0 (tag `v0.1.0`),
  submitted on 2026-11-08, was accepted and is live on the store (recorded
  2026-11-11). Listing material is in
  [`docs/store-listing.md`](docs/store-listing.md). Keep `PRIVACY.md` at its
  path on `main`: the listing links to it.
- [x] **Add the store install link to the README**: the "Install" section
  above "Install (Unpacked)" links to the listing.
- [ ] **Ship the three-colour icon.** `icons/` now has the purple tile with
  blue and yellow stripes, but 0.1.0 on the store still carries the old icon.
  Bump the version, upload a new zip, and replace the store icon, promo tile
  and screenshots in the dashboard from `docs/store/`; add the YouTube demo
  link (`make demo-video`) to the listing.
- [x] Autocomplete UX for long candidate lists (e.g. `math.<tab><tab>`):
  replaced the transcript listing with a transient, filter-as-you-type menu
  above the input line.
