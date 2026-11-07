// Real-window captures of the extension on macOS, for the README demo GIF and
// the Chrome Web Store screenshots.
//
//   node scripts/demo.mjs gif    # frames + frames.json in .cache/demo/gif/
//   node scripts/demo.mjs store  # shots + shots.json in .cache/demo/store/
//
// scripts/demo_assemble.py turns those into docs/demo.gif and docs/store/*.png
// (`make demo-gif`, `make store-assets`).
//
// Launches Chrome for Testing headful (same local puppeteer install as
// tests/chrome-smoke.mjs) at a fixed window position with a fresh profile in
// which the extension is pinned, shows a local fixture page, opens the real
// toolbar popup with chrome.action.openPopup() from the service worker, drives
// it with puppeteer key events, and grabs the window's screen region with
// `screencapture` after every step. One still per step (not a video), so the
// timing in the GIF is set by frames.json and is the same on every run.
//
// Needs macOS, the Screen Recording permission for the terminal, and the
// window's screen area unobstructed while it runs. Keystrokes go through
// puppeteer (CDP), so no Accessibility permission is needed; the shortcut each
// step stands for (Option+Shift+P, Tab, Return, Cmd-C) is recorded as a
// caption and drawn on by demo_assemble.py.
//
// Cmd-C writes to the real system clipboard; its text content is saved before
// the run and restored afterwards.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_DIR = path.join(PROJECT_ROOT, ".cache", "chrome-test");
const OUT_ROOT = path.join(PROJECT_ROOT, ".cache", "demo");
const PROFILE_PARENT = path.join(OUT_ROOT, "profiles");
const DEMO_PAGE_FILE = path.join(PROJECT_ROOT, "scripts", "demo-page.html");
const MODES = ["gif", "store"];
const MANIFEST_NAME = { gif: "frames.json", store: "shots.json" };

// The fixture is served under a reserved .example name via request
// interception, so the omnibox shows a short neutral URL and nothing is
// fetched from the network.
const DEMO_PAGE_URL = "https://recipes.example/banana-bread";
const CHROME_APP_NAME = "Google Chrome for Testing";

// Window geometry in screen points. On a 2x display this captures
// 1600x1000 px, which demo_assemble.py scales to 1280x800 for the store and
// to the GIF width.
const WINDOW_POSITION = { x: 120, y: 200 };
const WINDOW_SIZE = { width: 800, height: 500 };
// The tab strip is translucent (macOS vibrancy) and would show whatever is
// behind the window, e.g. a terminal. An opaque second window sits behind it.
// It reaches this far past the demo window on each side; the top margin is
// taller than the backdrop's own (equally translucent) tab strip + toolbar,
// so only its page content is behind the demo window.
const BACKDROP_MARGIN = { side: 40, top: 140, bottom: 40 };
const BACKDROP_COLOR = "#d6d6d6";
// Viewport point on blank page margin, clicked to unfocus the omnibox.
const PAGE_CLICK_POINT = { x: 20, y: 300 };

const EXTENSION_ID_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 30_000; // cold start includes Pyodide init
const STEP_TIMEOUT_MS = 10_000;
const POPUP_TIMEOUT_MS = 10_000;
// After the DOM settles: time for the compositor to put it on screen.
const PAINT_SETTLE_MS = 120;
// After window activation / popup close, before the next capture.
const WINDOW_SETTLE_MS = 600;
const FOCUS_ATTEMPTS = 20;
const SCROLLBAR_FADE_MS = 2000;
const FOCUS_RETRY_MS = 500;
const POPUP_PATH = "/popup.html";
// Chromium's unpacked-extension ID: first 32 hex digits of SHA-256(path),
// each mapped 0-f -> a-p.
const EXTENSION_ID_LENGTH = 32;
const EXTENSION_ID_ALPHABET_START = "a".charCodeAt(0);

// Run (and hidden by Ctrl-L) before anything is captured, so the GIF's
// random.choice result is the same every time.
const RANDOM_SEED = 4;

// ---- GIF script -------------------------------------------------------------------
// Hold times per frame, in milliseconds.
const HOLD_BROWSER_MS = 1200;
const HOLD_POPUP_OPEN_MS = 900;
const HOLD_TYPED_CHAR_MS = 110;
const HOLD_MENU_MS = 1400; // the brief asks for at least 1 s on the menu
const HOLD_ACCEPT_MS = 800;
const HOLD_RESULT_MS = 1200;
const HOLD_LAST_MS = 2400;
const GIF_PREFIX = "random.ch";
const GIF_ARGS = "(1,2,3))";
const GIF_EXPECTED_LINE = "random.choice((1,2,3))";
const CAPTION = { open: "⌥⇧P", tab: "Tab", enter: "⏎", copy: "⌘C" };

// ---- store shots ------------------------------------------------------------------
// Submitted in order before the session/completion shots.
const SESSION_LINES = [
  "r = 2.5",
  "math.pi * r**2",
  "statistics.mean([4, 8, 15, 16, 23, 42])",
];
// One browser launch per color scheme; files are written by demo_assemble.py.
const STORE_SHOTS = [
  { name: "screenshot-1-session", colorScheme: "light", scene: "session" },
  { name: "screenshot-2-completion", colorScheme: "dark", scene: "completion" },
  { name: "screenshot-3-copy", colorScheme: "light", scene: "copy" },
];

const require = createRequire(path.join(SMOKE_DIR, "package.json"));
const puppeteer = require("puppeteer");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unpackedExtensionId(dir) {
  const hex = createHash("sha256").update(dir).digest("hex").slice(0, EXTENSION_ID_LENGTH);
  return [...hex].map((c) => String.fromCharCode(EXTENSION_ID_ALPHABET_START + parseInt(c, 16))).join("");
}

// ---- browser ------------------------------------------------------------------------

async function launch(colorScheme) {
  if (process.platform !== "darwin") throw new Error("scripts/demo.mjs needs macOS (screencapture)");
  const extId = unpackedExtensionId(PROJECT_ROOT);
  await mkdir(PROFILE_PARENT, { recursive: true });
  const profile = await mkdtemp(path.join(PROFILE_PARENT, "profile-"));
  // Pin the action before first launch; Chrome reads this on startup.
  await mkdir(path.join(profile, "Default"), { recursive: true });
  await writeFile(path.join(profile, "Default", "Preferences"),
    JSON.stringify({ extensions: { pinned_extensions: [extId] } }));
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    `--window-position=${WINDOW_POSITION.x},${WINDOW_POSITION.y}`,
    `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
    // No DNS at all: the fixture is served by request interception, and the
    // stray "WhenScrolling" below must not turn into a lookup.
    "--host-resolver-rules=MAP * ~NOTFOUND",
    // Cocoa reads "-Key value" argv pairs as app-scoped user defaults: overlay
    // scrollbars (the macOS default) even if the system is set to "Always".
    // Chrome also sees the value as a URL to open in the first tab, which is
    // then navigated to the fixture.
    "-AppleShowScrollBars", "WhenScrolling",
  ];
  if (colorScheme === "dark") args.push("--force-dark-mode");
  const browser = await puppeteer.launch({
    headless: false,
    pipe: true,
    enableExtensions: [PROJECT_ROOT],
    userDataDir: profile,
    defaultViewport: null,
    // Without this Chrome shows the "controlled by automated test software" bar.
    ignoreDefaultArgs: ["--enable-automation"],
    args,
  });
  const close = async () => {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
  };
  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`),
      { timeout: EXTENSION_ID_TIMEOUT_MS },
    ).catch(() => {
      throw new Error(`extension service worker for computed ID ${extId} not found (pin would not apply)`);
    });
    const worker = await swTarget.worker();

    const pages = await browser.pages();
    if (pages.length !== 1) throw new Error(`expected one startup tab, got ${pages.map((p) => p.url())}`);
    const [page] = pages;
    const html = await readFile(DEMO_PAGE_FILE, "utf8");
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url() === DEMO_PAGE_URL) {
        req.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      } else {
        req.abort();
      }
    });
    await page.goto(DEMO_PAGE_URL, { waitUntil: "load" });
    // Move keyboard focus from the omnibox (selected URL) into the page.
    await page.mouse.click(PAGE_CLICK_POINT.x, PAGE_CLICK_POINT.y);

    const cdp = await page.createCDPSession();
    const { bounds } = await cdp.send("Browser.getWindowForTarget");
    await cdp.detach();
    if (bounds.width !== WINDOW_SIZE.width || bounds.height !== WINDOW_SIZE.height) {
      throw new Error(`window is ${bounds.width}x${bounds.height}, wanted ${WINDOW_SIZE.width}x${WINDOW_SIZE.height} (screen too small?)`);
    }
    if (bounds.left !== WINDOW_POSITION.x || bounds.top !== WINDOW_POSITION.y) {
      throw new Error(`window is at ${bounds.left},${bounds.top}, wanted ${WINDOW_POSITION.x},${WINDOW_POSITION.y}`);
    }

    const backdropBounds = {
      left: bounds.left - BACKDROP_MARGIN.side,
      top: bounds.top - BACKDROP_MARGIN.top,
      width: bounds.width + 2 * BACKDROP_MARGIN.side,
      height: bounds.height + BACKDROP_MARGIN.top + BACKDROP_MARGIN.bottom,
    };
    const backdrop = await browser.newPage({ type: "window", windowBounds: backdropBounds });
    await backdrop.setContent(`<!doctype html><style>html { background: ${BACKDROP_COLOR}; }</style>`);
    // The backdrop opened in front; focusChrome raises the demo window again.
    return { browser, extId, worker, page, bounds, close };
  } catch (err) {
    await close();
    throw err;
  }
}

function activateChrome() {
  // Plain `activate` needs no Accessibility permission (no System Events).
  execFileSync("osascript", ["-e", `tell application "${CHROME_APP_NAME}" to activate`]);
}

function capture(bounds, file) {
  const region = `${bounds.left},${bounds.top},${bounds.width},${bounds.height}`;
  try {
    execFileSync("screencapture", ["-x", "-t", "png", `-R${region}`, file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    throw new Error(`screencapture failed (grant Screen Recording to the terminal): ${err.stderr || err.message}`);
  }
}

// ---- popup --------------------------------------------------------------------------

// No banner check: Ctrl-L (prepareSession) clears it along with the transcript.
function isReadyInPage() {
  const notice = document.getElementById("notice");
  const prompt = document.getElementById("prompt").textContent;
  return notice.hidden && prompt === ">>> ";
}

async function waitReady(page) {
  await page.waitForFunction(isReadyInPage, { timeout: READY_TIMEOUT_MS, polling: "mutation" });
}

// Two animation frames in the popup, then a beat for the window server.
async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(PAINT_SETTLE_MS);
}

// Bring the Chrome window to the front. macOS lets the frontmost app refuse
// activation, so ask both ways (osascript activate, windows.update) and retry
// until Chrome reports the window focused.
async function focusChrome(env) {
  for (let attempt = 0; attempt < FOCUS_ATTEMPTS; attempt++) {
    activateChrome();
    // The demo window is the one at WINDOW_POSITION (the backdrop is not).
    const windowId = await env.worker.evaluate(async (pos) => {
      const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
      const win = all.find((w) => w.left === pos.x && w.top === pos.y);
      if (!win) return null;
      await chrome.windows.update(win.id, { focused: true });
      return (await chrome.windows.get(win.id)).focused ? win.id : null;
    }, WINDOW_POSITION);
    if (windowId !== null) {
      await sleep(WINDOW_SETTLE_MS);
      return windowId;
    }
    await sleep(FOCUS_RETRY_MS);
  }
  throw new Error(`could not focus the ${CHROME_APP_NAME} window; leave the screen alone while recording`);
}

// The real toolbar popup, opened by the extension's own action (openPopup
// refuses an unfocused window).
async function openToolbarPopup(env) {
  const windowId = await focusChrome(env);
  const popupUrl = `chrome-extension://${env.extId}${POPUP_PATH}`;
  const waiting = env.browser.waitForTarget((t) => t.url() === popupUrl, { timeout: POPUP_TIMEOUT_MS });
  await env.worker.evaluate((id) => chrome.action.openPopup({ windowId: id }), windowId);
  const target = await waiting;
  const popup = await target.asPage();
  await waitReady(popup);
  // Keeps document.hasFocus() true for navigator.clipboard while the OS focus
  // may be elsewhere (no real keystrokes are sent).
  const cdp = await popup.createCDPSession();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await popup.focus("#input");
  return popup;
}

async function closePopup(popup) {
  await popup.evaluate(() => window.close()).catch(() => {}); // the page goes away mid-call
  await sleep(WINDOW_SETTLE_MS);
}

async function pressWithModifier(popup, modifier, key) {
  await popup.keyboard.down(modifier);
  await popup.keyboard.press(key);
  await popup.keyboard.up(modifier);
}

async function waitIdleAfterSubmit(popup, before) {
  await popup.waitForFunction((prev) => {
    const t = document.getElementById("transcript").textContent;
    const prompt = document.getElementById("prompt").textContent;
    return t !== prev && prompt === ">>> " && document.getElementById("input").value === "";
  }, { timeout: STEP_TIMEOUT_MS, polling: "mutation" }, before);
}

async function submit(popup, line) {
  const before = await popup.$eval("#transcript", (e) => e.textContent);
  await popup.type("#input", line);
  await popup.keyboard.press("Enter");
  await waitIdleAfterSubmit(popup, before);
}

async function clearScreen(popup) {
  await pressWithModifier(popup, "Control", "l");
  await popup.waitForFunction(() => document.getElementById("transcript").textContent === "",
    { timeout: STEP_TIMEOUT_MS, polling: "mutation" });
}

async function waitMenu(popup, labels) {
  await popup.waitForFunction((want) => {
    const menu = document.getElementById("menu");
    const got = [...document.querySelectorAll("#menu .menu-item")].map((e) => e.textContent);
    return !menu.hidden && JSON.stringify(got) === JSON.stringify(want);
  }, { timeout: STEP_TIMEOUT_MS, polling: "mutation" }, labels);
}

async function waitMenuMatching(popup, prefix) {
  await popup.waitForFunction((p) => {
    const labels = [...document.querySelectorAll("#menu .menu-item")].map((e) => e.textContent);
    return !document.getElementById("menu").hidden && labels.length > 0 && labels.every((l) => l.startsWith(p));
  }, { timeout: STEP_TIMEOUT_MS, polling: "mutation" }, prefix);
}

async function waitInput(popup, value) {
  await popup.waitForFunction((v) => document.getElementById("input").value === v,
    { timeout: STEP_TIMEOUT_MS, polling: "mutation" }, value);
}

async function waitMenuClosed(popup) {
  await popup.waitForFunction(() => document.getElementById("menu").hidden,
    { timeout: STEP_TIMEOUT_MS, polling: "mutation" });
}

async function copyLastOutput(popup) {
  await pressWithModifier(popup, "Meta", "c");
  await popup.waitForFunction(() => {
    const n = document.getElementById("notice");
    return !n.hidden && n.textContent !== "";
  }, { timeout: STEP_TIMEOUT_MS, polling: "mutation" });
  const notice = await popup.$eval("#notice", (e) => e.textContent);
  if (notice !== "copied last output") throw new Error(`Cmd-C notice: ${JSON.stringify(notice)}`);
}

// Seed and clear in a first popup so the recorded one opens on an empty
// transcript with a warm interpreter (state lives in the offscreen document).
async function prepareSession(env, lines) {
  const popup = await openToolbarPopup(env);
  await submit(popup, `random.seed(${RANDOM_SEED})`);
  await clearScreen(popup);
  for (const line of lines) await submit(popup, line);
  await closePopup(popup);
}

// ---- modes --------------------------------------------------------------------------

async function recordGif(outDir) {
  const env = await launch("light");
  const frames = [];
  let frameIndex = 0;
  let popup = null;
  const shoot = async (holdMs, caption = null) => {
    if (popup) await settle(popup);
    const file = `frame-${String(frameIndex++).padStart(3, "0")}.png`;
    capture(env.bounds, path.join(outDir, file));
    frames.push({ file, holdMs, caption });
  };
  try {
    await prepareSession(env, []);
    await focusChrome(env);
    await shoot(HOLD_BROWSER_MS);

    popup = await openToolbarPopup(env);
    await shoot(HOLD_POPUP_OPEN_MS, CAPTION.open);

    for (const ch of GIF_PREFIX) {
      await popup.keyboard.type(ch);
      await shoot(HOLD_TYPED_CHAR_MS);
    }
    await popup.keyboard.press("Tab");
    await waitMenu(popup, ["choice(", "choices("]);
    await shoot(HOLD_MENU_MS, CAPTION.tab);

    await popup.keyboard.press("Tab");
    await waitMenuClosed(popup);
    await waitInput(popup, "random.choice(");
    await shoot(HOLD_ACCEPT_MS, CAPTION.tab);

    for (const ch of GIF_ARGS) {
      await popup.keyboard.type(ch);
      await shoot(HOLD_TYPED_CHAR_MS);
    }
    await waitInput(popup, GIF_EXPECTED_LINE);

    const before = await popup.$eval("#transcript", (e) => e.textContent);
    await popup.keyboard.press("Enter");
    await waitIdleAfterSubmit(popup, before);
    await shoot(HOLD_RESULT_MS, CAPTION.enter);

    await copyLastOutput(popup);
    await shoot(HOLD_LAST_MS, CAPTION.copy);
  } finally {
    await env.close();
  }
  return { bounds: env.bounds, frames };
}

const STORE_SCENES = {
  session: async (popup) => {
    await popup.type("#input", "2**100");
  },
  completion: async (popup) => {
    await popup.type("#input", "math.");
    await popup.keyboard.press("Tab");
    await waitMenuMatching(popup, "");
    await popup.type("#input", "s");
    await waitMenuMatching(popup, "s");
  },
  copy: async (popup) => {
    await clearScreen(popup);
    await submit(popup, "random.choice(['tea', 'coffee', 'cocoa'])");
    await copyLastOutput(popup);
  },
};

async function recordStore(outDir) {
  const shots = [];
  let bounds = null;
  for (const colorScheme of [...new Set(STORE_SHOTS.map((s) => s.colorScheme))]) {
    const env = await launch(colorScheme);
    bounds = env.bounds;
    try {
      await prepareSession(env, SESSION_LINES);
      for (const shot of STORE_SHOTS.filter((s) => s.colorScheme === colorScheme)) {
        const popup = await openToolbarPopup(env);
        // Opening scrolls the transcript to the bottom, which flashes the
        // overlay scrollbar.
        await sleep(SCROLLBAR_FADE_MS);
        await STORE_SCENES[shot.scene](popup);
        await settle(popup);
        const file = `${shot.name}.png`;
        capture(env.bounds, path.join(outDir, file));
        shots.push({ name: shot.name, file });
        // Leave the input empty for the next shot (history keeps the lines).
        await popup.$eval("#input", (e) => { e.value = ""; e.dispatchEvent(new Event("input")); });
        await closePopup(popup);
      }
    } finally {
      await env.close();
    }
  }
  shots.sort((a, b) => a.name.localeCompare(b.name));
  return { bounds, shots };
}

// ---- clipboard ----------------------------------------------------------------------

function readClipboardText() {
  return execFileSync("pbpaste", { encoding: "utf8" });
}

function writeClipboardText(text) {
  execFileSync("pbcopy", { input: text });
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (!MODES.includes(mode) || rest.length > 0) {
    throw new Error(`usage: node scripts/demo.mjs ${MODES.join("|")}`);
  }
  const outDir = path.join(OUT_ROOT, mode);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const savedClipboard = readClipboardText();
  let result;
  try {
    result = mode === "gif" ? await recordGif(outDir) : await recordStore(outDir);
  } finally {
    writeClipboardText(savedClipboard);
    await rm(PROFILE_PARENT, { recursive: true, force: true });
  }
  await writeFile(path.join(outDir, MANIFEST_NAME[mode]), JSON.stringify(result, null, 2) + "\n");
  console.log(`wrote ${path.relative(PROJECT_ROOT, outDir)}/ (${mode})`);
}

await main();
