// README screenshots and Chrome Web Store assets: loads the unpacked extension
// into Chrome for Testing via puppeteer (same local install as
// tests/chrome-smoke.mjs), runs a fixed session in popup.html, and captures
// each scene.
//
//   node scripts/screenshots.mjs readme  # `make screenshots`: docs/screenshots/<scene>-<scheme>.png
//   node scripts/screenshots.mjs store   # `make store-assets`: docs/store/*.png
//
// Each popup state is a named entry in SCENES. Store screenshots (STORE_SHOTS)
// compose a scene capture onto a captioned 1280x800 page; the promo tile is
// rendered from the extension icon. Both are plain HTML pages rendered by the
// same browser, so the output is deterministic for a given Chrome build.
//
// Env: SMOKE_HEADFUL=1 shows the browser window.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_DIR = path.join(PROJECT_ROOT, ".cache", "chrome-test");
const README_OUT_DIR = path.join(PROJECT_ROOT, "docs", "screenshots");
const STORE_OUT_DIR = path.join(PROJECT_ROOT, "docs", "store");
const ICON_PATH = path.join(PROJECT_ROOT, "icons", "icon128.png");
const MODES = ["readme", "store"];
const HEADLESS = process.env.SMOKE_HEADFUL !== "1";

const EXTENSION_ID_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 30_000; // cold start includes Pyodide init
const STEP_TIMEOUT_MS = 10_000;
const BANNER_PREFIX = "Python 3.14";
const README_SCALE = 2;
// Before the first layout; replaced by the popup's own size (popup.css).
const INITIAL_VIEWPORT = { width: 800, height: 600 };
const COLOR_SCHEMES = ["light", "dark"];

// Submitted once, in order; every scene shows the resulting transcript.
const SESSION_LINES = [
  "r = 2.5",
  "math.pi * r**2",
  "statistics.mean([4, 8, 15, 16, 23, 42])",
];

// A scene puts the popup's input line into some state, then is captured once
// per color scheme as docs/screenshots/<name>-<scheme>.png.
const SCENES = [
  {
    name: "session",
    prepare: async (page) => {
      await typeInput(page, "2**100");
    },
  },
  {
    name: "completion",
    prepare: async (page) => {
      await typeInput(page, "math.");
      await page.keyboard.press("Tab");
      await page.waitForFunction(() => !document.getElementById("menu").hidden,
        { timeout: STEP_TIMEOUT_MS, polling: "mutation" });
      await page.type("#input", "s");
      await page.waitForFunction(() => {
        const labels = [...document.querySelectorAll("#menu .menu-item")].map((e) => e.textContent);
        return labels.length > 0 && labels.every((l) => l.startsWith("s"));
      }, { timeout: STEP_TIMEOUT_MS, polling: "mutation" });
    },
  },
];

// ---- store assets ---------------------------------------------------------------
// The Web Store wants exact sizes: screenshots 1280x800 (or 640x400), small
// promo tile 440x280. Rendered at device scale 1 so CSS px == image px.
const STORE_SCREENSHOT_SIZE = { width: 1280, height: 800 };
const PROMO_TILE_SIZE = { width: 440, height: 280 };
// The real popup is 400x100 CSS px; it is captured at this device scale and
// shown 1:1 in the composition, i.e. 2.5x the on-screen size, still crisp.
const STORE_POPUP_SCALE = 2.5;
// Palette shared with the icon (scripts/gen_icons.py).
const BRAND = {
  // Solid on purpose: CSS gradients are dithered nondeterministically (+-1 LSB
  // run to run), which would churn the committed PNGs.
  backdrop: "#1c2128",
  accent: "#ffd343",
  text: "#f0f3f6",
  dim: "#9da7b3",
};
const TOOLBAR_COLORS = {
  light: { toolbar: "#dee1e6", omnibox: "#ffffff" },
  dark: { toolbar: "#3c3c3c", omnibox: "#282828" },
};
const SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif`;

// One store screenshot per entry: a SCENES capture in one color scheme.
const STORE_SHOTS = [
  {
    file: "screenshot-1-session.png",
    scene: "session",
    colorScheme: "light",
    title: "Python, one click away",
    subtitle: "A real CPython 3.14 console in your toolbar, with math, random and statistics pre-imported.",
  },
  {
    file: "screenshot-2-completion.png",
    scene: "completion",
    colorScheme: "dark",
    title: "Tab completion as you type",
    subtitle: "Familiar >>> prompts, tracebacks and history. Follows your light or dark theme.",
  },
  {
    file: "screenshot-3-offline.png",
    scene: "session",
    colorScheme: "dark",
    title: "Offline and private",
    subtitle: "Runs entirely on your device. No network access, no data collected, no access to web pages.",
  },
];
const PROMO_TILE = {
  file: "promo-tile-440x280.png",
  name: "Python REPL",
  tagline: "Offline Python 3.14 in your toolbar",
};

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function pngDataUrl(buffer) {
  return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}

// A captioned page with a mock browser toolbar and the popup hanging from the
// extension's toolbar icon, as it appears in Chrome.
function storeScreenshotHtml(shot, popupPng, popupPixels, iconUrl) {
  const colors = TOOLBAR_COLORS[shot.colorScheme];
  const { width, height } = STORE_SCREENSHOT_SIZE;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    background: ${BRAND.backdrop};
    font-family: ${SANS}; color: ${BRAND.text};
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  h1 { margin: 0; font-size: 56px; font-weight: 700; letter-spacing: -0.5px; }
  h1::after { content: ""; display: block; width: 72px; height: 5px; margin: 22px auto 0;
    border-radius: 3px; background: ${BRAND.accent}; }
  p { margin: 24px 0 0; font-size: 24px; color: ${BRAND.dim}; max-width: 980px; text-align: center; }
  .window { margin-top: 60px; width: ${popupPixels.width + 80}px; }
  .toolbar { height: 56px; border-radius: 14px; background: ${colors.toolbar};
    display: flex; align-items: center; padding: 0 16px; gap: 14px; }
  .omnibox { flex: 1; height: 34px; border-radius: 17px; background: ${colors.omnibox}; }
  .icon { width: 32px; height: 32px; border-radius: 6px; outline: 3px solid ${BRAND.accent}; outline-offset: 3px; }
  .popup { display: block; margin: 10px 6px 0 auto; width: ${popupPixels.width}px; height: ${popupPixels.height}px;
    border-radius: 10px; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14), 0 18px 50px rgba(0, 0, 0, 0.45); }
</style></head><body>
  <h1>${escapeHtml(shot.title)}</h1>
  <p>${escapeHtml(shot.subtitle)}</p>
  <div class="window">
    <div class="toolbar"><div class="omnibox"></div><img class="icon" src="${iconUrl}" alt=""></div>
    <img class="popup" src="${pngDataUrl(popupPng)}" alt="">
  </div>
</body></html>`;
}

function promoTileHtml(iconUrl) {
  const { width, height } = PROMO_TILE_SIZE;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    background: ${BRAND.backdrop};
    font-family: ${SANS}; color: ${BRAND.text};
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  img { width: 112px; height: 112px; border-radius: 20px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14), 0 10px 30px rgba(0, 0, 0, 0.5); }
  h1 { margin: 22px 0 0; font-size: 36px; font-weight: 700; }
  p { margin: 8px 0 0; font-size: 17px; color: ${BRAND.accent}; }
</style></head><body>
  <img src="${iconUrl}" alt="">
  <h1>${escapeHtml(PROMO_TILE.name)}</h1>
  <p>${escapeHtml(PROMO_TILE.tagline)}</p>
</body></html>`;
}

async function renderHtml(browser, html, size, file) {
  const page = await browser.newPage();
  await page.setViewport({ ...size, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: file, clip: { x: 0, y: 0, ...size } });
  await page.close();
  console.log(`wrote ${path.relative(PROJECT_ROOT, file)}`);
}

const require = createRequire(path.join(SMOKE_DIR, "package.json"));
const puppeteer = require("puppeteer");

// ---- popup helpers ------------------------------------------------------------

function isReadyInPage(bannerPrefix) {
  const banner = document.getElementById("banner").textContent;
  const notice = document.getElementById("notice");
  const prompt = document.getElementById("prompt").textContent;
  return banner.startsWith(bannerPrefix) && notice.hidden && prompt === ">>> ";
}

async function waitReady(page) {
  await page.waitForFunction(isReadyInPage,
    { timeout: READY_TIMEOUT_MS, polling: "mutation" }, BANNER_PREFIX);
}

async function typeInput(page, text) {
  await page.focus("#input");
  await page.$eval("#input", (e) => { e.value = ""; });
  await page.type("#input", text);
}

// Submit one line and wait until Python is idle with an empty input again.
async function submit(page, line) {
  const before = await page.$eval("#transcript", (e) => e.textContent);
  await typeInput(page, line);
  await page.keyboard.press("Enter");
  await page.waitForFunction((prev) => {
    const t = document.getElementById("transcript").textContent;
    const prompt = document.getElementById("prompt").textContent;
    return t !== prev && prompt === ">>> " && document.getElementById("input").value === "";
  }, { timeout: STEP_TIMEOUT_MS, polling: "mutation" }, before);
}

// Fresh tab at the popup's natural size (the body is sized by popup.css).
async function openPopup(browser, extId, colorScheme, scale) {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: colorScheme }]);
  await page.setViewport({ ...INITIAL_VIEWPORT, deviceScaleFactor: scale });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await waitReady(page);
  const size = await page.evaluate(() => {
    const r = document.body.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  });
  await page.setViewport({ ...size, deviceScaleFactor: scale });
  // The blinking caret would make the images differ run to run. (The
  // extension CSP blocks injected <style> tags; CSSOM writes are allowed.)
  await page.$eval("#input", (e) => { e.style.caretColor = "transparent"; });
  return { page, size };
}

// ---- main ---------------------------------------------------------------------------
// Capture one scene; returns the PNG and its size in image pixels.
async function captureScene(browser, extId, scene, colorScheme, scale) {
  const { page, size } = await openPopup(browser, extId, colorScheme, scale);
  await scene.prepare(page);
  const png = await page.screenshot({ clip: { x: 0, y: 0, ...size } });
  await page.close();
  const pixels = { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
  return { png, pixels };
}

async function writeReadme(browser, extId) {
  await mkdir(README_OUT_DIR, { recursive: true });
  for (const colorScheme of COLOR_SCHEMES) {
    for (const scene of SCENES) {
      const { png } = await captureScene(browser, extId, scene, colorScheme, README_SCALE);
      const file = path.join(README_OUT_DIR, `${scene.name}-${colorScheme}.png`);
      await writeFile(file, png);
      console.log(`wrote ${path.relative(PROJECT_ROOT, file)}`);
    }
  }
}

async function writeStore(browser, extId) {
  await mkdir(STORE_OUT_DIR, { recursive: true });
  const iconUrl = pngDataUrl(await readFile(ICON_PATH));
  for (const shot of STORE_SHOTS) {
    const scene = SCENES.find((s) => s.name === shot.scene);
    if (!scene) throw new Error(`STORE_SHOTS: unknown scene ${shot.scene}`);
    const { png, pixels } = await captureScene(browser, extId, scene, shot.colorScheme, STORE_POPUP_SCALE);
    await renderHtml(browser, storeScreenshotHtml(shot, png, pixels, iconUrl), STORE_SCREENSHOT_SIZE,
      path.join(STORE_OUT_DIR, shot.file));
  }
  await renderHtml(browser, promoTileHtml(iconUrl), PROMO_TILE_SIZE, path.join(STORE_OUT_DIR, PROMO_TILE.file));
}

async function main() {
  const modes = process.argv.slice(2);
  if (modes.length === 0 || modes.some((m) => !MODES.includes(m))) {
    throw new Error(`usage: node scripts/screenshots.mjs ${MODES.join("|")} [...]`);
  }
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    pipe: true,
    enableExtensions: [PROJECT_ROOT],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const sw = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
      { timeout: EXTENSION_ID_TIMEOUT_MS },
    );
    const extId = new URL(sw.url()).host;

    // Session state lives in the offscreen document, so it is shared by every
    // popup tab opened below.
    const { page: setup } = await openPopup(browser, extId, COLOR_SCHEMES[0], README_SCALE);
    for (const line of SESSION_LINES) await submit(setup, line);
    await setup.close();

    if (modes.includes("readme")) await writeReadme(browser, extId);
    if (modes.includes("store")) await writeStore(browser, extId);
  } finally {
    await browser.close();
  }
}

await main();
