// README popup screenshots and the Chrome Web Store promo tile: loads the
// unpacked extension into Chrome for Testing via puppeteer (same local install
// as tests/chrome-smoke.mjs), runs a fixed session in popup.html, and captures
// each scene.
//
//   node scripts/screenshots.mjs readme  # `make screenshots`: docs/screenshots/<scene>-<scheme>.png
//   node scripts/screenshots.mjs promo   # `make store-assets`: docs/store/promo-tile-440x280.png
//
// Each popup state is a named entry in SCENES. The promo tile is a plain HTML
// page around the extension icon, rendered by the same browser, so the output
// is deterministic for a given Chrome build. The store screenshots are real
// browser-window captures instead (scripts/demo.mjs).
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
const MODES = ["readme", "promo"];
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

// ---- promo tile -------------------------------------------------------------------
// The Web Store's small promo tile is exactly 440x280. Rendered at device
// scale 1 so CSS px == image px.
const PROMO_TILE_SIZE = { width: 440, height: 280 };
// Palette from the icon (scripts/gen_icons.py BACKGROUND_RGB, GLYPH_RGB).
const BRAND = {
  // Solid on purpose: CSS gradients are dithered nondeterministically (+-1 LSB
  // run to run), which would churn the committed PNGs.
  backdrop: "#654ff0",
  text: "#ffffff",
  dim: "rgba(255, 255, 255, 0.85)",
};
// The icon is a purple tile too; a white plate keeps its notched outline
// visible on the purple backdrop.
const PROMO_ICON_PX = 104;
const PROMO_PLATE_PAD_PX = 10;
const SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif`;
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

function promoTileHtml(iconUrl) {
  const { width, height } = PROMO_TILE_SIZE;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    background: ${BRAND.backdrop};
    font-family: ${SANS}; color: ${BRAND.text};
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .plate { padding: ${PROMO_PLATE_PAD_PX}px; border-radius: 22px; background: #ffffff;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); }
  img { display: block; width: ${PROMO_ICON_PX}px; height: ${PROMO_ICON_PX}px; }
  h1 { margin: 20px 0 0; font-size: 36px; font-weight: 700; }
  p { margin: 6px 0 0; font-size: 17px; color: ${BRAND.dim}; }
</style></head><body>
  <div class="plate"><img src="${iconUrl}" alt=""></div>
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
// Capture one scene; returns the PNG.
async function captureScene(browser, extId, scene, colorScheme, scale) {
  const { page, size } = await openPopup(browser, extId, colorScheme, scale);
  await scene.prepare(page);
  const png = await page.screenshot({ clip: { x: 0, y: 0, ...size } });
  await page.close();
  return png;
}

async function writeReadme(browser, extId) {
  await mkdir(README_OUT_DIR, { recursive: true });
  for (const colorScheme of COLOR_SCHEMES) {
    for (const scene of SCENES) {
      const png = await captureScene(browser, extId, scene, colorScheme, README_SCALE);
      const file = path.join(README_OUT_DIR, `${scene.name}-${colorScheme}.png`);
      await writeFile(file, png);
      console.log(`wrote ${path.relative(PROJECT_ROOT, file)}`);
    }
  }
}

async function writePromo(browser) {
  await mkdir(STORE_OUT_DIR, { recursive: true });
  const iconUrl = pngDataUrl(await readFile(ICON_PATH));
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
    if (modes.includes("readme")) {
      const sw = await browser.waitForTarget(
        (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
        { timeout: EXTENSION_ID_TIMEOUT_MS },
      );
      const extId = new URL(sw.url()).host;
      // Session state lives in the offscreen document, so it is shared by
      // every popup tab opened below.
      const { page: setup } = await openPopup(browser, extId, COLOR_SCHEMES[0], README_SCALE);
      for (const line of SESSION_LINES) await submit(setup, line);
      await setup.close();
      await writeReadme(browser, extId);
    }
    if (modes.includes("promo")) await writePromo(browser);
  } finally {
    await browser.close();
  }
}

await main();
