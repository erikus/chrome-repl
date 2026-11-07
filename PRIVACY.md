# Privacy Policy: Python REPL (Chrome extension)

Effective: 2026-11-07

Python REPL collects no data. In particular:

- **No data collection or transmission.** The extension does not collect,
  store, sell, or share any personal or non-personal information. It has no
  analytics, telemetry, crash reporting, ads, or accounts.
- **No network access.** The Python runtime (Pyodide, CPython compiled to
  WebAssembly) and its standard library ship inside the extension package.
  Nothing is downloaded at runtime, and the extension's Content Security Policy
  (`connect-src 'self'`) blocks network requests, including from Python code
  you type.
- **No access to web pages or browsing data.** The extension requests only the
  `offscreen` permission. It has no host permissions or content scripts, and
  cannot read tabs, history, cookies, or the pages you visit.
- **Nothing is saved.** The code you type, its output, and your variables
  live only in memory on your device. They are not written to `chrome.storage`
  or disk, and are discarded when you reset the session or restart the
  browser.

The source code is public at <https://github.com/erikus/chrome-repl>, so you
can verify these statements.

If this policy changes, the new version will be published at this URL and the
change will be noted in the repository history. Questions: open an issue at
<https://github.com/erikus/chrome-repl/issues>.
