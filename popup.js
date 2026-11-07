// Popup terminal UI. Holds no session state of its own: it renders the
// authoritative snapshots sent by the offscreen document and forwards keys.

import {
  PORT_NAME,
  MSG_ENSURE_OFFSCREEN,
  MAX_LINE_CHARS,
  MAX_COMPLETION_CANDIDATES,
  READINESS_TIMEOUT_MS,
  MAX_CONNECT_RETRIES,
} from "./protocol.js";
import { commonPrefix, completionStart, formatColumns, isBlank } from "./popup-lib.js";

const RUNNING_HINT_AFTER_MS = 10_000;
const RUNNING_HINT_CHECK_MS = 500;
const INDENT = "    ";
// Reconnects after an established connection drops (each with its own
// handshake retries); bounded so a crash-looping offscreen doc can't spin us.
const MAX_RECONNECTS_PER_OPEN = 3;
// Pixels from the bottom within which we keep following new output.
const STICK_TO_BOTTOM_PX = 8;
// Fallback listing width when the character width can't be measured.
const FALLBACK_WIDTH_CHARS = 50;
const MEASURE_SAMPLE_CHARS = 10;

const TEXT_STARTING = "starting Python…";
const TEXT_RUNNING_HINT = "running… Ctrl-C to interrupt";
const TEXT_CONNECTING_AGAIN = "connection lost; reconnecting…";
const TEXT_LINE_TOO_LONG = `line too long (max ${MAX_LINE_CHARS} characters); not run`;
const TEXT_MULTILINE_PASTE = "multi-line paste not supported; enter one line at a time";
const TEXT_REOPEN = "Close and reopen the popup to retry.";

const IS_MAC =
  (navigator.userAgentData?.platform ?? navigator.platform ?? "").toLowerCase().includes("mac");

const el = {
  scroll: document.getElementById("scroll"),
  banner: document.getElementById("banner"),
  transcript: document.getElementById("transcript"),
  notice: document.getElementById("notice"),
  prompt: document.getElementById("prompt"),
  input: document.getElementById("input"),
  measure: document.getElementById("measure"),
};

// ---- view state (mirrors the last snapshot; never authoritative) ----------

/** @type {chrome.runtime.Port | null} */
let port = null;
let connected = false; // true once the first snapshot on `port` arrived
let reconnectsLeft = MAX_RECONNECTS_PER_OPEN;
let fatalError = null; // connection failure text; shown instead of status

let sessionId = null;
let status = "starting";
let promptText = ">>> ";
let runningSince = null;
let sessionError = null;
let history = [];

// History navigation: index into `history`; history.length means the draft.
let historyCursor = 0;
let historyDraft = "";

let nextRequestId = 1;
let pendingSubmit = null; // {requestId, line}
let pendingComplete = null; // {requestId, value, cursor}
// Result of the last Tab, so a second consecutive Tab can list it.
let lastTab = null; // {value, cursor, matches, truncated}

let localNotice = null; // transient message (rejections, local limits)
let stickToBottom = true;

// ---- connection -------------------------------------------------------------

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function ensureOffscreen() {
  // The background bounds its own readiness wait; add slack for messaging.
  const reply = await withTimeout(
    chrome.runtime.sendMessage({ type: MSG_ENSURE_OFFSCREEN }),
    READINESS_TIMEOUT_MS * 2,
    "startup",
  );
  if (!reply?.ok) throw new Error(reply?.error || "background did not respond");
}

/** One handshake attempt; resolves once the first snapshot has been applied. */
function openPort() {
  return new Promise((resolve, reject) => {
    const p = chrome.runtime.connect({ name: PORT_NAME });
    port = p;
    connected = false;
    const timer = setTimeout(() => {
      fail(new Error("no response from Python session"));
    }, READINESS_TIMEOUT_MS);

    function fail(err) {
      clearTimeout(timer);
      if (port === p) port = null;
      try { p.disconnect(); } catch { /* already gone */ }
      reject(err);
    }

    p.onMessage.addListener((msg) => {
      if (port !== p) return;
      // Mark connected before applying the first snapshot, otherwise its ack
      // is dropped by send() and offscreen never sends another snapshot.
      const first = !connected && msg?.type === "snapshot";
      if (first) {
        connected = true;
        clearTimeout(timer);
      }
      handleMessage(msg);
      if (first) resolve();
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // silence "unchecked lastError"
      if (port !== p) return;
      if (!connected) {
        fail(new Error("Python session went away during startup"));
        return;
      }
      port = null;
      connected = false;
      onConnectionLost();
    });
  });
}

async function connect() {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
    try {
      await ensureOffscreen();
      await openPort();
      fatalError = null;
      render();
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  fatalError = `could not start Python: ${lastErr?.message ?? "unknown error"}. ${TEXT_REOPEN}`;
  render();
}

function onConnectionLost() {
  pendingSubmit = null;
  pendingComplete = null;
  if (reconnectsLeft <= 0) {
    fatalError = `lost connection to Python. ${TEXT_REOPEN}`;
    render();
    return;
  }
  reconnectsLeft--;
  localNotice = TEXT_CONNECTING_AGAIN;
  render();
  void connect().then(() => {
    if (localNotice === TEXT_CONNECTING_AGAIN) localNotice = null;
    render();
  });
}

function send(msg) {
  if (!port || !connected) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

// ---- incoming messages --------------------------------------------------------

function handleMessage(msg) {
  switch (msg?.type) {
    case "snapshot": applySnapshot(msg); break;
    case "status": applyStatus(msg); break;
    case "submit-result": onSubmitResult(msg); break;
    case "complete-result": onCompleteResult(msg); break;
    default: break;
  }
}

function adoptSession(id) {
  if (id === sessionId) return;
  sessionId = id;
  history = [];
  historyCursor = 0;
  historyDraft = "";
  pendingComplete = null;
  lastTab = null;
}

function applySnapshot(msg) {
  const { state } = msg;
  adoptSession(msg.sessionId);
  const wasAtDraft = historyCursor >= history.length;
  history = Array.isArray(state.history) ? state.history : [];
  historyCursor = wasAtDraft ? history.length : Math.min(historyCursor, history.length);
  status = state.status;
  promptText = state.prompt;
  runningSince = state.runningSince ?? null;
  sessionError = state.error ?? null;
  renderTranscript(state.banner ?? "", state.transcript ?? []);
  render();
  send({ type: "ack", revision: msg.revision });
}

function applyStatus(msg) {
  adoptSession(msg.sessionId);
  status = msg.status;
  promptText = msg.prompt;
  runningSince = msg.runningSince ?? null;
  render();
}

function onSubmitResult(msg) {
  if (!pendingSubmit || msg.requestId !== pendingSubmit.requestId) return;
  const { line } = pendingSubmit;
  pendingSubmit = null;
  if (msg.accepted) {
    if (el.input.value === line) el.input.value = "";
    historyCursor = history.length;
    historyDraft = "";
    localNotice = null;
  } else {
    localNotice = msg.reason || "not run";
  }
  render();
}

function onCompleteResult(msg) {
  const req = pendingComplete;
  if (!req || msg.requestId !== req.requestId) return;
  pendingComplete = null;
  // Drop stale results if the line changed while we waited.
  if (el.input.value !== req.value || el.input.selectionStart !== req.cursor) return;
  const matches = Array.isArray(msg.matches) ? msg.matches : [];
  applyCompletion(req.value, req.cursor, matches, Boolean(msg.truncated));
}

// ---- rendering ----------------------------------------------------------------

function renderTranscript(banner, entries) {
  el.banner.textContent = banner;
  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    const span = document.createElement("span");
    span.className = entry.kind;
    span.textContent = entry.text;
    frag.append(span);
  }
  el.transcript.replaceChildren(frag);
}

function currentNotice() {
  if (fatalError) return fatalError;
  if (status === "error") return sessionError || "Python failed to start";
  if (localNotice) return localNotice;
  if (status === "starting" || !connected) return TEXT_STARTING;
  if (status === "running" && runningSince !== null &&
      Date.now() - runningSince >= RUNNING_HINT_AFTER_MS) {
    return TEXT_RUNNING_HINT;
  }
  return null;
}

function render() {
  el.prompt.textContent = status === "running" ? "" : promptText;
  const notice = currentNotice();
  el.notice.hidden = notice === null;
  el.notice.textContent = notice ?? "";
  if (stickToBottom) scrollToBottom();
}

function scrollToBottom() {
  el.scroll.scrollTop = el.scroll.scrollHeight;
}

function widthInChars() {
  const charWidth = el.measure.getBoundingClientRect().width / MEASURE_SAMPLE_CHARS;
  const style = getComputedStyle(el.scroll);
  const inner = el.scroll.clientWidth -
    parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  if (!(charWidth > 0) || !(inner > 0)) return FALLBACK_WIDTH_CHARS;
  return Math.max(1, Math.floor(inner / charWidth));
}

// ---- actions ------------------------------------------------------------------

function canSubmit() {
  return connected && status === "ready" && pendingSubmit === null;
}

function submit() {
  const line = el.input.value;
  if (line.length > MAX_LINE_CHARS) {
    localNotice = TEXT_LINE_TOO_LONG;
    render();
    return;
  }
  if (!canSubmit()) return; // never queue
  const requestId = String(nextRequestId++);
  if (send({ type: "submit", requestId, line })) {
    pendingSubmit = { requestId, line };
  }
}

function setLine(value) {
  el.input.value = value;
  el.input.setSelectionRange(value.length, value.length);
}

function historyUp() {
  if (historyCursor <= 0) return;
  if (historyCursor >= history.length) historyDraft = el.input.value;
  historyCursor--;
  setLine(history[historyCursor]);
}

function historyDown() {
  if (historyCursor >= history.length) return;
  historyCursor++;
  setLine(historyCursor >= history.length ? historyDraft : history[historyCursor]);
}

function tab() {
  const value = el.input.value;
  const cursor = el.input.selectionStart ?? value.length;
  const before = value.slice(0, cursor);
  if (isBlank(before)) {
    el.input.setRangeText(INDENT, cursor, el.input.selectionEnd ?? cursor, "end");
    lastTab = null;
    return;
  }
  if (lastTab && lastTab.value === value && lastTab.cursor === cursor &&
      lastTab.matches.length > 1) {
    listCompletions(lastTab);
    lastTab = null;
    return;
  }
  if (!connected || status !== "ready" || pendingComplete) return;
  const requestId = String(nextRequestId++);
  if (send({ type: "complete", requestId, source: before })) {
    pendingComplete = { requestId, value, cursor };
  }
}

function applyCompletion(value, cursor, matches, truncated) {
  const source = value.slice(0, cursor);
  const start = completionStart(source, matches);
  let insert = null;
  if (matches.length === 1 && !truncated) {
    insert = matches[0];
  } else if (matches.length > 1 && !truncated) {
    const prefix = commonPrefix(matches);
    if (prefix.length > source.length - start) insert = prefix;
  }
  let newCursor = cursor;
  if (insert !== null) {
    el.input.setRangeText(insert, start, cursor, "end");
    newCursor = start + insert.length;
  }
  lastTab = { value: el.input.value, cursor: newCursor, matches, truncated };
}

function listCompletions({ value, matches, truncated }) {
  let text = `${promptText}${value}\n${formatColumns(matches, widthInChars())}\n`;
  if (truncated) {
    text += `(list truncated; showing first ${Math.min(matches.length, MAX_COMPLETION_CANDIDATES)})\n`;
  }
  send({ type: "listing", text });
}

function interrupt() {
  const line = el.input.value;
  if (connected && (status === "ready" || status === "running")) {
    send({ type: "interrupt", line });
  }
  if (status !== "running") {
    setLine("");
    historyCursor = history.length;
    historyDraft = "";
  }
  localNotice = null;
  render();
}

function hasTranscriptSelection() {
  const sel = window.getSelection();
  return sel !== null && !sel.isCollapsed && sel.toString() !== "" &&
    !el.input.contains(sel.anchorNode);
}

function hasInputSelection() {
  return document.activeElement === el.input &&
    el.input.selectionStart !== el.input.selectionEnd;
}

// ---- keys -----------------------------------------------------------------------

/** Ctrl+<letter> with no other modifiers (on macOS this is Control, not Cmd). */
function isCtrl(e, letter) {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  return e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`;
}

function onKeyDown(e) {
  if (e.isComposing) return;

  if (isCtrl(e, "c")) {
    // Never hijack copy: Cmd-C on mac isn't matched by isCtrl; elsewhere,
    // Ctrl-C with selected text copies.
    if (!IS_MAC && (hasTranscriptSelection() || hasInputSelection())) return;
    e.preventDefault();
    el.input.focus();
    interrupt();
    return;
  }

  // Selection-preserving: let copy shortcuts etc. act on the transcript.
  if (document.activeElement !== el.input) {
    if (e.metaKey || (e.ctrlKey && !isCtrl(e, "l") && !isCtrl(e, "d"))) return;
    el.input.focus();
  }

  if (e.key !== "Tab") lastTab = null;

  if (isCtrl(e, "l")) {
    e.preventDefault();
    localNotice = null;
    send({ type: "clear" });
    return;
  }
  if (isCtrl(e, "d")) {
    if (el.input.value === "") {
      e.preventDefault();
      if (connected && (status === "ready" || status === "error")) {
        localNotice = null;
        send({ type: "reset" });
      }
    } else if (!IS_MAC) {
      e.preventDefault(); // no delete-forward binding off mac; avoid bookmarking
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case "Enter":
      e.preventDefault();
      submit();
      break;
    case "Tab":
      if (e.shiftKey) return;
      e.preventDefault();
      tab();
      break;
    case "ArrowUp":
      e.preventDefault();
      historyUp();
      break;
    case "ArrowDown":
      e.preventDefault();
      historyDown();
      break;
    default:
      break;
  }
  stickToBottom = true;
  scrollToBottom();
}

function onInput() {
  lastTab = null;
  if (localNotice && localNotice !== TEXT_CONNECTING_AGAIN) {
    localNotice = null;
    render();
  }
}

function onPaste(e) {
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (/[\r\n]/.test(text.replace(/[\r\n]+$/, ""))) {
    e.preventDefault();
    localNotice = TEXT_MULTILINE_PASTE;
    render();
  }
}

// Clicking the transcript focuses the input unless the user selected text.
function onMouseUp() {
  if (!hasTranscriptSelection()) el.input.focus();
}

function onScroll() {
  const s = el.scroll;
  stickToBottom = s.scrollHeight - s.scrollTop - s.clientHeight <= STICK_TO_BOTTOM_PX;
}

// ---- init -------------------------------------------------------------------------

function init() {
  document.addEventListener("keydown", onKeyDown);
  el.input.addEventListener("input", onInput);
  el.input.addEventListener("paste", onPaste);
  el.scroll.addEventListener("mouseup", onMouseUp);
  el.scroll.addEventListener("scroll", onScroll, { passive: true });
  setInterval(() => {
    if (status === "running") render();
  }, RUNNING_HINT_CHECK_MS);
  render();
  el.input.focus();
  void connect();
}

init();
