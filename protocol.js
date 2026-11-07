// Shared constants for background.js, offscreen.js and popup.js.
// See docs/protocol.md for the message shapes; this file is the single source
// of the names and limits used on both sides of the contract.

export const PORT_NAME = "repl";
export const MSG_ENSURE_OFFSCREEN = "ensure-offscreen"; // popup -> background
export const MSG_OFFSCREEN_PING = "offscreen-ping"; // background -> offscreen
export const OFFSCREEN_TARGET = "offscreen"; // `target` field on bg->offscreen messages
export const PROMPT_PRIMARY = ">>> ";
export const PROMPT_CONTINUATION = "... ";
export const MAX_LINE_CHARS = 2 * 1024;
export const MAX_BLOCK_CHARS = 8 * 1024;
export const MAX_COMPLETION_CANDIDATES = 100;
export const MAX_COMPLETION_CHARS = 8 * 1024;
export const READINESS_TIMEOUT_MS = 5000;
export const MAX_CONNECT_RETRIES = 2;
