# Message protocol (contract between phases)

This is the fixed interface between `background.js`, `offscreen.js` and
`popup.js`. `plan.md` is the overall spec; this file pins down names and shapes
so the popup and the offscreen/background code can be built independently.
The offscreen ↔ worker protocol is private to `offscreen.js`/`worker.js`.

## Shared constants (`protocol.js`, ES module, imported by all three)

```js
export const PORT_NAME = "repl";
export const MSG_ENSURE_OFFSCREEN = "ensure-offscreen"; // popup -> background
export const MSG_OFFSCREEN_PING = "offscreen-ping";      // background -> offscreen
export const OFFSCREEN_TARGET = "offscreen";             // `target` field on bg->offscreen messages
export const PROMPT_PRIMARY = ">>> ";
export const PROMPT_CONTINUATION = "... ";
export const MAX_LINE_CHARS = 2 * 1024;
export const MAX_BLOCK_CHARS = 8 * 1024;
export const MAX_COMPLETION_CANDIDATES = 100;
export const MAX_COMPLETION_CHARS = 8 * 1024;
export const READINESS_TIMEOUT_MS = 5000;
export const MAX_CONNECT_RETRIES = 2;
```

`protocol.js` is owned by the background/offscreen phase; the popup phase may
assume exactly the exports above exist.

## Popup → background (`chrome.runtime.sendMessage`)

- Request `{type: "ensure-offscreen"}`.
- Reply `{ok: true}` once the offscreen document exists and has answered a
  `{target: "offscreen", type: "offscreen-ping"}` probe with `{ok: true}`
  (bounded by `READINESS_TIMEOUT_MS`), or `{ok: false, error: string}`.
- Does not wait for Pyodide.

## Popup ↔ offscreen (`chrome.runtime.connect({name: "repl"})`)

### Offscreen → popup

- `{type: "snapshot", sessionId, revision, state}` — full authoritative view.
  Sent immediately on connect and then coalesced (≤ 1 per 50 ms, at most one
  unacknowledged per port, latest replaces pending). The popup replaces its
  whole view and replies `{type: "ack", revision}`.
  `state`:
  ```js
  {
    status: "starting" | "ready" | "running" | "error",
    prompt: ">>> " | "... ",   // prompt for the next input line
    banner: string,            // dim one-liner, "" until Python is ready
    transcript: [{kind: "input"|"stdout"|"stderr"|"info", text: string}],
                               // already capped (200 lines / 32 Ki chars);
                               // text includes its own newlines
    history: string[],         // up-arrow history, oldest first
    error: string | null,      // init/session failure message for status "error"
    runningSince: number|null  // Date.now() when current execution began
  }
  ```
- `{type: "status", sessionId, status, prompt, runningSince}` — sent
  immediately (not coalesced, not ack-gated) when execution status changes,
  so the popup can enable/disable submission without waiting for a snapshot.
- `{type: "submit-result", requestId, accepted: boolean, reason?: string}`.
  A rejection (not ready, busy, line > 2 Ki, block > 8 Ki) leaves the input
  line in the popup so the user can edit it; `reason` is shown as a short
  dim/info line in the popup only (not added to the transcript).
- `{type: "complete-result", requestId, matches: string[], truncated: boolean}`
  — full replacement strings for the text being completed (the `rlcompleter`
  results for the line up to the cursor, e.g. `"math.sqrt("`), capped at 100
  candidates / 8 Ki chars. If `truncated`, the popup must not insert a common
  prefix.

### Popup → offscreen

- `{type: "ack", revision}`.
- `{type: "submit", requestId, line}` — offscreen echoes `prompt + line` into
  the transcript as `input`, appends non-empty lines to history, and runs it.
  Accepted submissions run even if the popup disconnects.
- `{type: "complete", requestId, source}` — `source` is the input line text
  up to the cursor.
- `{type: "listing", text}` — the popup's column-formatted completion listing
  (second Tab), already including the echoed `prompt + line` before it.
  Offscreen appends it to the transcript as `info`, applying transcript caps.
- `{type: "interrupt", line}` — Ctrl-C. If running: interrupt execution
  (SharedArrayBuffer interrupt, else terminate-and-restart fallback). If idle:
  echo `prompt + line + "^C"`, discard pending multi-line source, print
  `KeyboardInterrupt`, prompt returns to `>>> `.
- `{type: "clear"}` — Ctrl-L: clear transcript; keep variables and history.
- `{type: "reset"}` — Ctrl-D on empty line: new session (also triggered from
  Python by `exit()`/`quit()`).

`sessionId` changes on every reset/worker replacement; the popup discards any
local state (history cursor, pending completion) when it changes.
