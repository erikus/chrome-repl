// Popup terminal UI. Holds no session state of its own: it renders the
// authoritative snapshots sent by the offscreen document and forwards keys.

import {
  PORT_NAME,
  MSG_ENSURE_OFFSCREEN,
  MAX_LINE_CHARS,
  READINESS_TIMEOUT_MS,
  MAX_CONNECT_RETRIES,
} from "./protocol.js";
import {
  MENU_CLOSE,
  MENU_REFETCH,
  commonPrefix,
  completionLabel,
  fullReplacements,
  isBlank,
  planMenuUpdate,
  scrollFirstRow,
  tokenBase,
  tokenStart,
  wrapIndex,
} from "./popup-lib.js";

const RUNNING_HINT_AFTER_MS = 10_000;
const RUNNING_HINT_CHECK_MS = 500;
const INDENT = "    ";
// Reconnects after an established connection drops (each with its own
// handshake retries); bounded so a crash-looping offscreen doc can't spin us.
const MAX_RECONNECTS_PER_OPEN = 3;
// Pixels from the bottom within which we keep following new output.
const STICK_TO_BOTTOM_PX = 8;
const MEASURE_SAMPLE_CHARS = 10;
// Completion menu: at most this many rows are visible at once.
const MAX_MENU_ROWS = 4;
// Menu border top + bottom (and left + right); keep in sync with popup.css.
const MENU_CHROME_PX = 2;
// Horizontal padding of a menu item, in characters (1ch each side, popup.css).
const MENU_ITEM_PADDING_CHARS = 2;
// Keys that move the cursor without editing; they close the menu.
const CURSOR_KEYS_CLOSING_MENU = new Set(["ArrowLeft", "Home", "End", "PageUp", "PageDown"]);
// Why a completion was requested: an explicit Tab, or the open menu needing
// candidates its cache cannot provide.
const COMPLETE_TAB = "tab";
const COMPLETE_REFRESH = "refresh";

// How long the "copied" confirmation stays in the notice line.
const COPY_NOTICE_MS = 1500;

const TEXT_STARTING = "starting Python…";
const TEXT_COPIED = "copied last output";
const TEXT_NOTHING_TO_COPY = "no output to copy";
const TEXT_COPY_FAILED = "copy failed";
const TEXT_RUNNING_HINT = "running… Ctrl-C to interrupt";
const TEXT_CONNECTING_AGAIN = "connection lost; reconnecting…";
const TEXT_LINE_TOO_LONG = `line too long (max ${MAX_LINE_CHARS} characters); not run`;
const TEXT_MULTILINE_PASTE = "multi-line paste not supported; enter one line at a time";
const TEXT_REOPEN = "Close and reopen the popup to retry.";

// #scroll class that keeps the input line on the bottom row (set once the
// completion menu needs room; cleared by Ctrl-L and session resets).
const ANCHORED_CLASS = "anchored-bottom";

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
  inputRow: document.getElementById("input-row"),
  menu: document.getElementById("menu"),
  menuList: document.getElementById("menu-list"),
  menuCount: document.getElementById("menu-count"),
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
let pendingComplete = null; // {requestId, value, cursor, reason}
// Open completion menu, or null. Transient UI, never part of the transcript.
//   source:    line text up to the cursor that `matches` were fetched for
//   base:      tokenBase(source), the text before the token being completed
//   after:     line text after the cursor when the menu was (re)filled
//   matches:   cached full replacements of `source`
//   truncated: the offscreen document capped `matches`
//   items:     `matches` filtered by the current token (never empty)
//   selected:  index into `items`
//   first:     index of the first visible row
let menu = null;

let localNotice = null; // transient message (rejections, local limits)
let lastAnswer = ""; // stdout of the most recent execution that printed any
let copyNoticeTimer = null;
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
  closeMenu();
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
  closeMenu();
  el.scroll.classList.remove(ANCHORED_CLASS);
}

function applySnapshot(msg) {
  const { state } = msg;
  adoptSession(msg.sessionId);
  const wasAtDraft = historyCursor >= history.length;
  history = Array.isArray(state.history) ? state.history : [];
  historyCursor = wasAtDraft ? history.length : Math.min(historyCursor, history.length);
  closeMenuOnStateChange(state.status, state.prompt);
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
  closeMenuOnStateChange(msg.status, msg.prompt);
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
    if (el.input.value === line) setLine("");
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
  const raw = Array.isArray(msg.matches) ? msg.matches.filter((m) => typeof m === "string") : [];
  const truncated = msg.truncated === true;
  if (req.reason === COMPLETE_REFRESH) {
    refillMenu(req.value, req.cursor, raw, truncated);
  } else {
    applyCompletion(req.value, req.cursor, raw, truncated);
  }
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
  lastAnswer = lastOutputBlock(entries);
}

/**
 * The stdout (results and prints) after the latest input line that produced
 * any, exactly as shown, minus the trailing newline. Blank Enter presses
 * after it don't hide it; stderr (tracebacks) and info lines are not answers.
 */
function lastOutputBlock(entries) {
  let latest = "";
  let current = "";
  for (const entry of entries) {
    if (entry.kind === "input") {
      if (current !== "") latest = current;
      current = "";
    } else if (entry.kind === "stdout") {
      current += entry.text;
    }
  }
  if (current !== "") latest = current;
  return latest.replace(/\n$/, "");
}

/** Cmd-C (macOS) / Ctrl-Shift-C (elsewhere) with nothing selected. */
function isCopyAnswerKey(e) {
  if (e.altKey || e.code !== "KeyC") return false;
  return IS_MAC
    ? e.metaKey && !e.ctrlKey && !e.shiftKey
    : e.ctrlKey && e.shiftKey && !e.metaKey;
}

async function copyLastAnswer() {
  let text;
  if (lastAnswer === "") {
    text = TEXT_NOTHING_TO_COPY;
  } else {
    try {
      await navigator.clipboard.writeText(lastAnswer);
      text = TEXT_COPIED;
    } catch (err) {
      console.warn("clipboard write failed", err);
      text = TEXT_COPY_FAILED;
    }
  }
  localNotice = text;
  render();
  if (copyNoticeTimer !== null) clearTimeout(copyNoticeTimer);
  copyNoticeTimer = setTimeout(() => {
    copyNoticeTimer = null;
    if (localNotice === text) {
      localNotice = null;
      render();
    }
  }, COPY_NOTICE_MS);
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
  renderMenu();
}

function scrollToBottom() {
  el.scroll.scrollTop = el.scroll.scrollHeight;
}

function charWidthPx() {
  return el.measure.getBoundingClientRect().width / MEASURE_SAMPLE_CHARS;
}

// ---- completion menu ------------------------------------------------------------

/**
 * Draw the menu next to the input line: above it when MAX_MENU_ROWS fit (or
 * when there is at least as much room above as below), else below. It covers
 * the transcript and never takes focus.
 */
function renderMenu() {
  if (menu === null) {
    el.menu.hidden = true;
    el.menuList.replaceChildren();
    el.menuCount.textContent = "";
    return;
  }
  const rowPx = el.inputRow.getBoundingClientRect().height;
  const rowRect = el.inputRow.getBoundingClientRect();
  const viewportPx = document.documentElement.clientHeight;
  const roomAbove = Math.floor((rowRect.top - MENU_CHROME_PX) / rowPx);
  const roomBelow = Math.floor((viewportPx - rowRect.bottom - MENU_CHROME_PX) / rowPx);
  const wanted = Math.min(MAX_MENU_ROWS, menu.items.length);
  // Short transcript: push the input line to the bottom row (like a terminal
  // that has scrolled) so the full menu fits above it, then lay out again.
  if (roomAbove < wanted && !el.scroll.classList.contains(ANCHORED_CLASS)) {
    el.scroll.classList.add(ANCHORED_CLASS);
    stickToBottom = true;
    scrollToBottom();
    renderMenu();
    return;
  }
  const above = roomAbove >= wanted || roomAbove >= roomBelow;
  const rows = Math.max(1, Math.min(wanted, above ? roomAbove : roomBelow));
  menu.first = scrollFirstRow(menu.first, menu.selected, rows, menu.items.length);

  const labels = menu.items.map(completionLabel);
  const frag = document.createDocumentFragment();
  for (let i = menu.first; i < Math.min(menu.first + rows, menu.items.length); i++) {
    const row = document.createElement("div");
    row.className = i === menu.selected ? "menu-item selected" : "menu-item";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === menu.selected));
    row.dataset.index = String(i);
    row.textContent = labels[i];
    frag.append(row);
  }
  el.menuList.replaceChildren(frag);
  // Width from every label, so the menu doesn't jitter while scrolling.
  const longest = Math.max(...labels.map((l) => l.length));
  el.menuList.style.width = `${longest + MENU_ITEM_PADDING_CHARS}ch`;
  el.menuCount.textContent = menu.items.length > rows
    ? `${menu.selected + 1}/${menu.items.length}`
    : "";
  el.menu.hidden = false;

  // Left edge under the start of the token being completed, kept on screen.
  const cursor = el.input.selectionStart ?? el.input.value.length;
  const tokenCol = tokenStart(el.input.value.slice(0, cursor));
  const inputLeft = el.input.getBoundingClientRect().left - el.input.scrollLeft;
  const menuWidth = el.menu.getBoundingClientRect().width;
  const maxLeft = document.documentElement.clientWidth - menuWidth;
  // Shift left by the item's left padding and border so the label text lines
  // up with the token, as in ptpython.
  const labelOffsetPx = (MENU_ITEM_PADDING_CHARS / 2) * charWidthPx() + MENU_CHROME_PX / 2;
  const tokenLeft = inputLeft + tokenCol * charWidthPx() - labelOffsetPx;
  const left = Math.max(0, Math.min(tokenLeft, maxLeft));
  const menuHeight = el.menu.getBoundingClientRect().height;
  const top = above ? rowRect.top - menuHeight : rowRect.bottom;
  el.menu.style.left = `${left}px`;
  el.menu.style.top = `${top}px`;
}

function closeMenu() {
  if (pendingComplete?.reason === COMPLETE_REFRESH) pendingComplete = null;
  if (menu === null) return;
  menu = null;
  renderMenu();
}

/** A snapshot/status that changes the prompt or leaves "ready" closes the menu. */
function closeMenuOnStateChange(nextStatus, nextPrompt) {
  if (nextStatus !== "ready" || nextPrompt !== promptText) closeMenu();
}

/** Open (or refill) the menu with `matches`, full replacements of `source`. */
function openMenu(source, after, matches, truncated, items) {
  const previous = menu === null ? null : menu.items[menu.selected];
  const kept = previous === null ? -1 : items.indexOf(previous);
  menu = {
    source,
    base: tokenBase(source),
    after,
    matches,
    truncated,
    items,
    selected: Math.max(0, kept),
    first: menu === null ? 0 : menu.first,
  };
  renderMenu();
}

/** Fresh candidates for an open menu (no common-prefix insertion). */
function refillMenu(value, cursor, raw, truncated) {
  if (menu === null) return;
  const source = value.slice(0, cursor);
  const matches = fullReplacements(source, raw);
  if (matches.length === 0) {
    closeMenu();
    return;
  }
  openMenu(source, value.slice(cursor), matches, truncated, matches);
}

/** Re-filter the open menu after the line changed. */
function updateMenu() {
  if (menu === null) return;
  const value = el.input.value;
  const cursor = el.input.selectionStart ?? value.length;
  if (el.input.selectionEnd !== cursor) {
    closeMenu();
    return;
  }
  const plan = planMenuUpdate(menu, value.slice(0, cursor), value.slice(cursor));
  if (plan.action === MENU_CLOSE) {
    closeMenu();
  } else if (plan.action === MENU_REFETCH) {
    requestCompletion(COMPLETE_REFRESH);
    renderMenu(); // keep showing the old items until the fresh ones arrive
  } else {
    openMenu(menu.source, menu.after, menu.matches, menu.truncated, plan.items);
  }
}

function moveMenuSelection(delta) {
  menu.selected = wrapIndex(menu.selected, delta, menu.items.length);
  renderMenu();
}

/** Insert the selected (or given) item in place of the text before the cursor. */
function acceptMenuItem(index = menu.selected) {
  const item = menu.items[index];
  const cursor = el.input.selectionStart ?? el.input.value.length;
  closeMenu();
  el.input.setRangeText(item, 0, cursor, "end");
}

function onMenuMouseDown(e) {
  e.preventDefault(); // keep focus (and the cursor) in the input
}

function onMenuClick(e) {
  const row = e.target instanceof Element ? e.target.closest(".menu-item") : null;
  if (menu === null || row === null) return;
  const index = Number(row.dataset.index);
  if (Number.isInteger(index) && index >= 0 && index < menu.items.length) acceptMenuItem(index);
}

/** Any mousedown outside the menu (input, transcript) closes it. */
function onDocumentMouseDown(e) {
  if (menu !== null && !(e.target instanceof Node && el.menu.contains(e.target))) closeMenu();
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
  closeMenu();
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
    return;
  }
  if (pendingComplete?.reason === COMPLETE_TAB) return;
  requestCompletion(COMPLETE_TAB);
}

/** Ask for completions of the line up to the cursor; the latest request wins. */
function requestCompletion(reason) {
  if (!connected || status !== "ready") return;
  const value = el.input.value;
  const cursor = el.input.selectionStart ?? value.length;
  const requestId = String(nextRequestId++);
  if (send({ type: "complete", requestId, source: value.slice(0, cursor) })) {
    pendingComplete = { requestId, value, cursor, reason };
  }
}

/** Tab result: insert one match, or the common prefix and open the menu. */
function applyCompletion(value, cursor, raw, truncated) {
  const source = value.slice(0, cursor);
  const matches = fullReplacements(source, raw);
  if (matches.length === 0) return;
  if (matches.length === 1 && !truncated) {
    el.input.setRangeText(matches[0], 0, cursor, "end");
    return;
  }
  let before = source;
  if (!truncated) {
    const prefix = commonPrefix(matches);
    if (prefix.length > source.length && prefix.startsWith(source)) {
      el.input.setRangeText(prefix, 0, cursor, "end");
      before = prefix;
    }
  }
  const items = matches.filter((m) => m.startsWith(before));
  if (items.length === 0) return;
  menu = null;
  openMenu(source, value.slice(cursor), matches, truncated, items);
}

function interrupt() {
  closeMenu();
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

  // Copy the last output, but only when nothing is selected: a selection
  // keeps the normal copy behavior.
  if (isCopyAnswerKey(e) && !hasTranscriptSelection() && !hasInputSelection()) {
    e.preventDefault();
    void copyLastAnswer();
    return;
  }

  if (isCtrl(e, "c")) {
    // Never hijack copy: Cmd-C on mac isn't matched by isCtrl; elsewhere,
    // Ctrl-C with selected text copies.
    if (!IS_MAC && (hasTranscriptSelection() || hasInputSelection())) return;
    e.preventDefault();
    el.input.focus();
    interrupt();
    return;
  }

  if (menu !== null && onMenuKeyDown(e)) {
    stickToBottom = true;
    scrollToBottom();
    renderMenu();
    return;
  }

  // Selection-preserving: let copy shortcuts etc. act on the transcript.
  if (document.activeElement !== el.input) {
    if (e.metaKey || (e.ctrlKey && !isCtrl(e, "l") && !isCtrl(e, "d"))) return;
    el.input.focus();
  }

  if (isCtrl(e, "l")) {
    e.preventDefault();
    closeMenu();
    localNotice = null;
    el.scroll.classList.remove(ANCHORED_CLASS); // back to a prompt on the top row
    send({ type: "clear" });
    return;
  }
  if (isCtrl(e, "d")) {
    closeMenu();
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
  renderMenu();
}

/**
 * Keys while the completion menu is open. Returns true if the key was
 * consumed by the menu; otherwise the normal handling continues (typing
 * filters the menu through onInput()).
 */
function onMenuKeyDown(e) {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (!plain) {
    // Ctrl-L/Ctrl-D/paste etc.: close first, then behave as usual.
    closeMenu();
    return false;
  }
  switch (e.key) {
    case "Tab":
      // Tab accepts (editor/DevTools style); Shift-Tab is swallowed so focus
      // stays in the input.
      e.preventDefault();
      if (!e.shiftKey) acceptMenuItem();
      return true;
    case "ArrowDown":
      e.preventDefault();
      moveMenuSelection(1);
      return true;
    case "ArrowUp":
      e.preventDefault();
      moveMenuSelection(-1);
      return true;
    case "Enter":
    case "ArrowRight":
      e.preventDefault();
      acceptMenuItem();
      return true;
    case "Escape":
      e.preventDefault();
      closeMenu();
      return true;
    default:
      if (CURSOR_KEYS_CLOSING_MENU.has(e.key)) closeMenu();
      return false;
  }
}

function onInput() {
  updateMenu();
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
  if (menu !== null) renderMenu(); // the input line moved; follow it
}

// ---- init -------------------------------------------------------------------------

function init() {
  document.addEventListener("keydown", onKeyDown);
  el.input.addEventListener("input", onInput);
  el.input.addEventListener("paste", onPaste);
  el.scroll.addEventListener("mouseup", onMouseUp);
  el.scroll.addEventListener("scroll", onScroll, { passive: true });
  el.menu.addEventListener("mousedown", onMenuMouseDown);
  el.menu.addEventListener("click", onMenuClick);
  document.addEventListener("mousedown", onDocumentMouseDown, true);
  setInterval(() => {
    if (status === "running") render();
  }, RUNNING_HINT_CHECK_MS);
  render();
  el.input.focus();
  void connect();
}

init();
