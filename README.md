# Python REPL (Chrome extension)

A toolbar button that opens a small popup running a plain, offline Python REPL:
real CPython 3.14 compiled to WebAssembly (Pyodide 314.0.7), with `math`,
`random` and `statistics` pre-imported. Meant for quick arithmetic, e.g. during
technical interviews.

- Looks like the standard `python` prompt: `>>>` / `...`, CPython tracebacks,
  Tab completion with a filter-as-you-type menu (as in ptpython/IPython).
- Variables and the visible transcript survive closing and reopening the popup
  (they live in a hidden offscreen document). They do not survive a browser
  restart.
- Only the standard library pieces needed for `math`, `random`, `statistics`
  and the console are bundled. No third-party packages, no `micropip`.

Message protocol: [`docs/protocol.md`](docs/protocol.md).

## Build

Requires [`uv`](https://docs.astral.sh/uv/) and Node.js (for `make test`).

```sh
make vendor   # download the pinned Pyodide release, verify its SHA-256, write a trimmed copy to vendor/pyodide/
make icons    # generate icons/icon{16,48,128}.png (scripts/gen_icons.py, stdlib only)
make test     # Node tests against the trimmed bundle
make zip      # dist/python-repl-<manifest version>.zip with only the runtime files
```

`vendor/`, `dist/` and `.cache/` are generated and gitignored.

## Install (load unpacked)

1. `make vendor icons`
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this directory (the one containing
   `manifest.json`).
4. Pin **Python REPL** from the puzzle-piece menu and click it.

After editing source files, click the reload icon on the extension's card.
Chrome 116 or later is required.

**Hotkey:** `Alt+Shift+P` (`Option+Shift+P` on macOS) opens the popup. Chrome
applies a suggested shortcut only on a fresh install, and skips it if it
conflicts with another one. Check or change it at
`chrome://extensions/shortcuts`.

## Keys

| Key | Behavior |
|---|---|
| `Enter` | Submit the line. Continues with `...` if the input is incomplete. |
| `Tab` | Complete. One match: insert it. Several: insert the common prefix and open a completion menu above the line. On a blank line, indents. |
| Typing with the menu open | Filters the menu by prefix; `Backspace` widens it again. A non-identifier character (`(`, space, an operator) is inserted and closes the menu. |
| `↓` / `Tab`, `↑` / `Shift-Tab` (menu open) | Select the next / previous candidate (wraps). |
| `Enter` / `→` (menu open) | Insert the selected candidate and close the menu. Does not submit the line. A mouse click on a candidate does the same. |
| `Esc` (menu open) | Close the menu without inserting. |
| `↑` / `↓` | Move through input history (when the menu is closed). |
| `Ctrl-L` | Clear the screen. Variables and history are kept. |
| `Cmd-C` (macOS) / `Ctrl-Shift-C` with nothing selected | Copy the last output (as shown, e.g. strings keep their quotes). With a selection, copies the selection as usual. |
| `Ctrl-D` on an empty line, `exit()`, `quit()` | Reset: restart the interpreter, clear the transcript and the history. |
| `Ctrl-C` while idle | Discard the current line and pending multi-line source (`KeyboardInterrupt`). |
| `Ctrl-C` while running | Interrupt the running code with `KeyboardInterrupt`; variables are kept. If Python does not stop within 1 s (e.g. inside a long C call) it is restarted and the session is lost. |

On macOS these are the Control key, not Command.

## Privacy

- **No network.** Pyodide and the trimmed standard library are bundled; nothing
  is fetched from a CDN, and package loading (`loadPackage`, `micropip`) is
  never used. The extension's Content Security Policy limits `connect-src` to
  the extension itself, so even Python code calling `js.fetch` cannot reach
  the internet (verified by the smoke test below).
- **No permissions beyond `offscreen`.** No host permissions, no content
  scripts, no tabs/history/cookies access: the extension never sees web pages.
- **No storage.** Nothing is written to `chrome.storage`, disk, or anywhere
  else. The session lives in memory and is gone after a reset or a browser
  restart.

## Chrome smoke test

```sh
make smoke
```

Loads the unpacked extension into Chrome for Testing via puppeteer and drives
`popup.html` as a tab: startup snapshot and banner, evaluation, the Tab
completion menu (filtering, Enter accepts without submitting), Ctrl-C interrupt (and `crossOriginIsolated` in the offscreen
document), persistence across close/reopen, warm-open time, CSP-blocked fetch,
unavailable imports, output caps, Ctrl-L and `exit()`.

puppeteer and its Chrome for Testing download (~600 MB) are installed locally
in `.cache/chrome-test/` from `tests/chrome-smoke.package.json`; nothing is
installed globally. Branded Google Chrome ignores `--load-extension`, which is
why Chrome for Testing is used. `SMOKE_HEADFUL=1 make smoke` shows the window.
It cannot press the real toolbar button or measure click-to-popup time; see
[`docs/manual-test-checklist.md`](docs/manual-test-checklist.md) for what
still needs a human.

## Bumping Pyodide

1. In `scripts/fetch_pyodide.py`, update `PYODIDE_VERSION` and
   `TARBALL_SHA256` (the SHA-256 of `pyodide-core-<version>.tar.bz2` from the
   GitHub release).
2. Fetch the **untrimmed** stdlib and record what the console actually loads:
   ```sh
   make clean-vendor
   uv run scripts/fetch_pyodide.py --untrimmed
   PYODIDE_TRACE_MODULES=1 node --test tests/
   ```
   This prints every stdlib file loaded while exercising the console,
   completion, tracebacks and the three modules.
3. Add anything new to `STDLIB_ALLOWLIST` in `scripts/fetch_pyodide.py`.
4. Rebuild trimmed and re-test:
   ```sh
   make clean-vendor vendor test smoke
   ```
5. If the Python minor version changed, update `BANNER_PREFIX` in
   `tests/chrome-smoke.mjs` and the version mentioned in this README, and
   re-read `docs/pyodide-notes.md` against the new release.

## License

MIT, see `LICENSE`. The built extension (`vendor/pyodide/`, and so
`make zip`) bundles Pyodide (MPL-2.0) and CPython and its stdlib (PSF
License) plus the libraries compiled into `pyodide.asm.wasm`. These are
downloaded at build time, not committed. If you distribute the zip, include
their license notices.
