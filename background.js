// Service worker: offscreen document lifecycle and pre-warm only.
// REPL port traffic goes directly between popup and offscreen; this file never
// sees it.

import {
  MSG_ENSURE_OFFSCREEN,
  MSG_OFFSCREEN_PING,
  OFFSCREEN_TARGET,
  READINESS_TIMEOUT_MS,
} from "./protocol.js";

const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_REASONS = ["WORKERS"];
const OFFSCREEN_JUSTIFICATION =
  "Hosts the Web Worker running the Python interpreter so its state survives the popup closing.";
const PING_RETRY_INTERVAL_MS = 25;

// One shared creation promise for onStartup, onInstalled and popup requests.
// Cleared once settled so later requests re-check (the document can be closed
// by Chrome or crash between requests).
let creationPromise = null;

function offscreenUrl() {
  return chrome.runtime.getURL(OFFSCREEN_PATH);
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl()],
  });
  return contexts.length > 0;
}

async function createOffscreenIfMissing() {
  if (await hasOffscreenDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION,
    });
  } catch (err) {
    // Another context (or an earlier service-worker instance) may have created
    // it concurrently. Only an error if it still doesn't exist.
    if (!(await hasOffscreenDocument())) throw err;
  }
}

function ensureOffscreenDocument() {
  if (creationPromise === null) {
    creationPromise = createOffscreenIfMissing().finally(() => {
      creationPromise = null;
    });
  }
  return creationPromise;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves once the offscreen document's handlers answer the probe. Retries
// while the document is still loading ("Receiving end does not exist").
async function pingOffscreen(deadline) {
  let lastError = "no reply";
  while (performance.now() < deadline) {
    try {
      const reply = await chrome.runtime.sendMessage({
        target: OFFSCREEN_TARGET,
        type: MSG_OFFSCREEN_PING,
      });
      if (reply && reply.ok === true) return;
      lastError = "unexpected ping reply";
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
    await delay(PING_RETRY_INTERVAL_MS);
  }
  throw new Error(`offscreen document not ready: ${lastError}`);
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function ensureOffscreenReady() {
  const start = performance.now();
  const deadline = start + READINESS_TIMEOUT_MS;
  await withTimeout(ensureOffscreenDocument(), READINESS_TIMEOUT_MS, "offscreen creation");
  await pingOffscreen(deadline);
  console.debug(`[bg] offscreen ready in ${(performance.now() - start).toFixed(1)} ms`);
}

function prewarm(trigger) {
  ensureOffscreenReady().catch((err) => {
    console.warn(`[bg] pre-warm on ${trigger} failed:`, err);
  });
}

chrome.runtime.onStartup.addListener(() => prewarm("startup"));
chrome.runtime.onInstalled.addListener(() => prewarm("installed"));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== MSG_ENSURE_OFFSCREEN || message.target !== undefined) {
    return false;
  }
  ensureOffscreenReady().then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }),
  );
  return true; // async response
});
