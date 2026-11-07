# Manual test checklist

Run against the unpacked extension in regular Chrome (`chrome://extensions` →
Load unpacked) after `make vendor icons`. Items marked **(smoke)** are also
covered by `make smoke` in Chrome for Testing; still spot-check them through
the real toolbar popup, which the smoke test cannot click.

Useful consoles: `chrome://extensions` → Python REPL → "Inspect views:
offscreen.html" (session log with `[offscreen +N ms]` timings) and "service
worker" (`[bg]` log). Right-click inside the popup → Inspect for the popup.

Record Chrome version, OS and date at the top of each run.

## Startup and timing

- [ ] **Cold start, browser restart.** Quit Chrome fully, relaunch, and open
      the popup immediately. `starting Python…` shows; typing is accepted but
      Enter does nothing until ready; then the banner
      `Python 3.14.x (offline) · math, random, statistics imported` appears.
      Record the offscreen log line `Python ready N ms after spawn` (cold time).
- [ ] **Browser restart starts clean.** After the restart, no transcript, no
      up-arrow history, `x` → `NameError` (for a variable set before quitting).
- [ ] **Pre-warm.** Relaunch Chrome, wait ~3 s, open the popup: usable
      prompt with no visible `starting Python…`.
- [ ] **Warm open < 100 ms (click to usable prompt).** With the session
      already running, open the popup several times. It should appear with the
      prompt focused and the transcript scrolled to the bottom, with no
      perceptible delay. In the popup's DevTools, `performance.now()` after load
      approximates navigation→ready (smoke test measured ~12 ms) **(smoke)**.
- [ ] **Init failure is reported.** Temporarily rename
      `vendor/pyodide/python_stdlib.zip`, reload the extension, open the popup:
      a `Python failed to start: …` message, not a permanent spinner. Restore
      the file, reopen the popup: it retries and becomes ready.

## Keys (every row of the key table)

- [ ] `Enter` submits: `2**10` → `1024` **(smoke)**.
- [ ] `Enter` on incomplete input: `for i in range(3):` → `...` prompt;
      `    print(i)` then an empty line prints 0 1 2 and returns to `>>>`.
- [ ] `Tab` with one match inserts it: `statis` Tab → `statistics`.
- [ ] `Tab` with several matches inserts the common prefix: `math.ac` Tab →
      `math.acos` and opens a menu with `acos(` and `acosh(`.
- [ ] **Completion menu.** `math.` Tab opens a menu just above the input line
      (at most 4 rows, a dim `1/62` indicator), covering the transcript; the
      input keeps focus and nothing is added to the transcript. Typing `sq`
      filters to `sqrt(`; `Enter` inserts `math.sqrt(` and does not submit
      **(smoke)**.
- [ ] Menu keys: `↓`/`Tab` and `↑`/`Shift-Tab` move the highlight and wrap,
      scrolling the list so the highlight stays visible; `→` accepts; `Esc`
      closes without inserting; clicking a candidate accepts it.
- [ ] Menu filtering: `Backspace` widens the list (e.g. `math.sq` → `math.s`);
      typing `(`, a space or an operator inserts it and closes the menu; a
      prefix with no candidates closes it; `←`/`Home`/`End` or a click in the
      line closes it.
- [ ] With the menu open, `Ctrl-C` / `Ctrl-L` / `Ctrl-D` close it and then act
      as usual; `↑`/`↓` move in the menu, not the history.
- [ ] Right after opening (banner only), the menu still fits: it shows fewer
      rows above the line (or below it if there is more room there).
- [ ] `Tab` on a blank or continuation line indents by 4 spaces.
- [ ] `↑` / `↓` walk input history; `↓` past the newest restores the draft.
- [ ] `Ctrl-L` clears the screen; `x` still works; `↑` still has history
      **(smoke)**. Verify on macOS that Control-L does not focus an address bar
      or open anything.
- [ ] `Cmd-C` (macOS) / `Ctrl-Shift-C` with nothing selected copies the last output and shows "copied last output"; with text selected it copies the selection; after a traceback it still copies the last stdout
- [ ] `Ctrl-D` on an empty line resets (transcript, history and variables
      gone, new banner). `Ctrl-D` with text on the line does nothing harmful
      (no bookmark dialog on Windows/Linux).
- [ ] `exit()` and `quit()` each reset the same way **(smoke: exit())**.
- [ ] `Ctrl-C` while idle with text typed: line echoed with `^C`,
      `KeyboardInterrupt`, back to `>>>`. Also while at a `...` prompt: the
      pending block is discarded.
- [ ] `Ctrl-C` while running (see Interrupts).
- [ ] With transcript text selected on Windows/Linux, `Ctrl-C` copies instead
      of interrupting. On macOS, `Cmd-C` copies.

## Interrupts and running code

- [ ] **Infinite loop, popup open.** `x = 42`, then `while True: pass` +
      empty line; `Ctrl-C` → `KeyboardInterrupt` traceback within ~1 s; `x`
      → `42` **(smoke)**. The offscreen log says
      `interrupt via SharedArrayBuffer`, and in the offscreen console
      `crossOriginIsolated` is `true` **(smoke)**.
- [ ] **Running hint.** Leave a loop running 10 s: `running… Ctrl-C to
      interrupt` appears.
- [ ] **Uninterruptible C call.** `math.factorial(10**8)` then `Ctrl-C`:
      after ~1 s, the restart notice (`Python did not stop, so it was
      restarted…`) and a fresh session.
- [ ] **Infinite loop, popup closed.** Start `while True: pass`, close the
      popup, wait, reopen: still running (no prompt, hint after 10 s);
      `Ctrl-C` interrupts it with variables kept.
- [ ] **Close during execution, reopen after completion.** Run
      `sum(range(10**8))` (several seconds), close the popup immediately,
      reopen after it finishes: the result is in the transcript and the prompt
      is `>>>`.
- [ ] **Submission not replayed.** Close the popup right after pressing Enter;
      on reopen the line ran exactly once.

## Persistence and reconnection

- [ ] Close and reopen keeps variables and transcript **(smoke)**.
- [ ] **Reopen during multi-line input.** Type `def f(x):`, Enter, close the
      popup, reopen: the prompt is `...`; type `    return x * 2`, empty
      line, `f(21)` → `42`.
- [ ] **Concurrent startup.** Reload the extension and immediately click the
      toolbar button several times (and/or open `popup.html` in two tabs):
      exactly one offscreen document (check `chrome://extensions` inspect
      views), no errors in the service-worker console, all views converge on
      the same session.
- [ ] **Offscreen loss during connection.** In `chrome://extensions`, inspect
      offscreen.html and run `close()` in its console (or kill it via Chrome's
      Task Manager), then open the popup: it recreates the document and starts
      a clean session (no "restored" divider). With the popup open while the
      offscreen doc is killed: `connection lost; reconnecting…` then a fresh
      session, or after repeated failures a "reopen to retry" message.
- [ ] **Reset with output in flight.** Run
      `while True: print("old")`, then immediately `Ctrl-C` and `Ctrl-D`
      (or let the cap hit and press `Ctrl-D`): the new session shows no `old`
      lines arriving after the reset.

## Output and resource limits

- [ ] **Huge single-line result.** `"a" * 10**6`: about 16 Ki characters
      shown, then `[output truncated at 16 Ki characters; interrupting]`; popup
      stays responsive **(smoke)**.
- [ ] **Infinite printing loop.** `while True: print("spam")`: output stops at
      the truncation notice and the prompt returns; variables kept. Repeat with
      the popup closed and reopen **(smoke: closed)**.
- [ ] **Oversized line.** Paste a 3000-character single line (generate it
      in any DevTools console with `"1+".repeat(1500) + "1"`): rejected with
      `line too long (max 2048 characters); not run`, input kept for editing.
- [ ] **Oversized block.** Enter `if True:` followed by lines totalling more
      than 8 Ki characters: rejected with `block too long…; Ctrl-C to discard
      it`; `Ctrl-C` returns to `>>>`.
- [ ] **Multi-line paste** is rejected with
      `multi-line paste not supported; enter one line at a time`.
- [ ] **Transcript cap.** `for i in range(1000): print(i)`: only the most
      recent ~200 lines remain; scrolling up stops at the oldest kept line.
- [ ] **History cap.** Submit 60 distinct lines; `↑` reaches back at most 50.
      A few 2000-character lines evict older entries (16 Ki total).
- [ ] **Completion cap.** `__builtins__.` Tab (or `[].` Tab after defining a
      class with >100 attributes): the menu shows at most 100 candidates
      (indicator `1/100`); no common prefix is inserted from a truncated list;
      typing a further letter fetches fresh candidates (names past the first
      100 appear).

## Offline / CSP

- [ ] **Bundled loading only.** With DevTools Network open on the offscreen
      page (and its worker), startup loads only `chrome-extension://` URLs.
- [ ] **Blocked external fetch.** `from js import fetch` then
      `await fetch("https://example.com/")` → `JsException: TypeError: Failed
      to fetch`, with a CSP `connect-src 'self'` violation in the worker
      console **(smoke)**.
- [ ] **`import urllib.request`** → `ModuleNotFoundError` **(smoke)**.
- [ ] **Unavailable package.** `import numpy` → `ModuleNotFoundError` with no
      network request in DevTools **(smoke)**.
- [ ] **Isolation.** In the offscreen console, `crossOriginIsolated` is
      `true` **(smoke)**.

## Look and feel

- [ ] Popup is 400×100, monospace, title "Python REPL" on hover of the toolbar
      icon; icons render crisply at 16/48/128 (toolbar, `chrome://extensions`).
- [ ] Light and dark system themes both readable, including the completion
      menu and its highlighted row.
- [ ] Input is focused on open and the transcript is scrolled to the bottom.
