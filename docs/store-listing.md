# Chrome Web Store listing

Copy-paste-ready text for the Chrome Web Store Developer Dashboard, plus a
submission checklist. Assets are generated with `make store-assets` into
[`store/`](store/); the package is `make zip`.

## Submission checklist

1. **Register a developer account** at
   <https://chrome.google.com/webstore/devconsole> with the Google account that
   should own the listing. Pay the one-time registration fee (US$5), and
   verify the contact email under **Account** (publishing is blocked until it
   is verified).
2. **Build the package:** `make vendor icons test zip`. Upload
   `dist/python-repl-<version>.zip` under **Items > New item**. The zip
   contains `THIRD_PARTY_NOTICES.txt` (Pyodide, CPython and compiled-in
   library licenses) and `LICENSE` at its root. Run `make smoke` first if the
   runtime changed.
3. **Store listing tab:** paste the text from [Store listing](#store-listing-tab)
   below, and upload:
   - Screenshots (1280x800, real Chrome window captures with the popup
     open; regenerating them needs macOS, see `make demo-gif` in the README):
     [`store/screenshot-1-session.png`](store/screenshot-1-session.png),
     [`store/screenshot-2-completion.png`](store/screenshot-2-completion.png)
     (dark theme),
     [`store/screenshot-3-copy.png`](store/screenshot-3-copy.png)
   - Small promo tile (440x280):
     [`store/promo-tile-440x280.png`](store/promo-tile-440x280.png)
   - Store icon (128x128): [`../icons/icon128.png`](../icons/icon128.png)
   - Optional YouTube video: upload `dist/demo.mp4` (`make demo-gif`, then
     `make demo-video`; same content as the README GIF, 1920x1080) and paste
     its URL.
4. **Privacy practices tab:** paste the answers from
   [Privacy practices](#privacy-practices-tab) below. Privacy policy URL:
   <https://github.com/erikus/chrome-repl/blob/main/PRIVACY.md> (merge
   `PRIVACY.md` to `main` before submitting so the URL resolves).
5. **Distribution tab:** Free; Public; all regions.
6. **Submit for review.** Reviews typically take a few days; the dashboard
   emails the account on approval or rejection.
7. **Once live:** add the store install link to the README (done: the
   listing is live at
   <https://chromewebstore.google.com/detail/python-repl/ginmafgfgfjmplggiohjenfmfipopcae>).

For later updates: bump `version` in `manifest.json`, `make zip`, and upload
the new zip under **Package**. Regenerate assets with `make store-assets` if
the popup's look changes.

## Store listing tab

**Name** (from `manifest.json`): `Python REPL`

**Summary / short description** (from `manifest.json` `description`, max 132
characters; currently 97):

```
A plain offline Python REPL (CPython via Pyodide) in a popup. math, random, statistics preloaded.
```

**Category:** Developer Tools

**Language:** English

**Detailed description:**

```
A Python console in your toolbar for quick calculations, without switching tabs or windows.

Click the toolbar icon (or press Alt+Shift+P) and type Python. It is CPython 3.14 compiled to WebAssembly (Pyodide), running entirely on your device, with math, random and statistics already imported.

FEATURES
• The real CPython console: >>> and ... prompts, multi-line blocks, standard tracebacks.
• Tab completion with a filter-as-you-type menu.
• Input history (Up/Down), Ctrl-L to clear, Ctrl-C to interrupt long-running code.
• Copy the last result with one shortcut (Cmd-C on macOS, Ctrl-Shift-C elsewhere) when nothing is selected.
• Your variables and scrollback survive closing and reopening the popup until you restart the browser.
• Follows your system light or dark theme.

PRIVATE AND OFFLINE
• No network access: the Python runtime and standard library are bundled in the extension, nothing is downloaded, and the extension's security policy blocks network requests.
• No data collected, no analytics, no accounts.
• No access to your tabs or the pages you visit: the only permission is "offscreen", which keeps the interpreter running while the popup is closed.
• Nothing is saved to disk; the session lives in memory only.

LIMITS
• Standard library only, trimmed to what the console and the pre-imported modules need. No third-party packages and no pip/micropip.

Open source (MIT): https://github.com/erikus/chrome-repl
```

**Official URL / homepage:** <https://github.com/erikus/chrome-repl>

**Support URL:** <https://github.com/erikus/chrome-repl/issues>

## Privacy practices tab

**Single purpose description:**

```
Provides an offline Python interpreter (REPL) in the toolbar popup for quick calculations and experiments. The user types Python code and sees its output; nothing else.
```

**Permission justification, `offscreen`:**

```
The Python interpreter (Pyodide, WebAssembly) runs in a Web Worker hosted by an offscreen document (reason: WORKERS). A popup's page is destroyed every time it closes, so without the offscreen document the user's variables and history would be lost and the interpreter would have to start from scratch on every click. The offscreen document has no UI, loads only files bundled in the extension, and makes no network requests.
```

**Host permissions:** none requested (no justification needed).

**Are you using remote code?** No.

```
No remote code. All JavaScript and WebAssembly is included in the extension package. The CSP's 'wasm-unsafe-eval' is required only to compile the bundled Pyodide WebAssembly module (vendor/pyodide/pyodide.asm.wasm); it does not allow JavaScript eval. connect-src is limited to 'self', so nothing can be fetched from the network, and Pyodide's package loading (loadPackage/micropip) is disabled. Python code typed by the user runs inside the bundled interpreter, which is not remote code.
```

**Data usage:** check none of the data categories (personally identifiable
information, health, financial and payment, authentication, personal
communications, location, web history, user activity, website content). The
extension collects nothing.

**Certifications** (check all three):

- I do not sell or transfer user data to third parties, outside of the
  approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

**Privacy policy URL:** <https://github.com/erikus/chrome-repl/blob/main/PRIVACY.md>
