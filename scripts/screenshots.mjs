// README screenshots: loads the unpacked extension into Chrome for Testing via
// puppeteer (same local install as tests/chrome-smoke.mjs), runs a fixed
// session in popup.html, and writes one PNG per scene to docs/screenshots/.
//
// Run with `make screenshots`. Each scene is a named entry in SCENES; to add
// an image (e.g. a store-sized variant) add a scene rather than a new script.
//
// Env: SMOKE_HEADFUL=1 shows the browser window.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_DIR = path.join(PROJECT_ROOT, ".cache", "chrome-test");
const OUT_DIR = path.join(PROJECT_ROOT, "docs", "screenshots");
const HEADLESS = process.env.SMOKE_HEADFUL !== "1";

const EXTENSION_ID_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 30_000; // cold start includes Pyodide init
const STEP_TIMEOUT_MS = 10_000;
const BANNER_PREFIX = "Python 3.14";
const DEVICE_SCALE_FACTOR = 2;
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
async function openPopup(browser, extId, colorScheme) {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: colorScheme }]);
  await page.setViewport({ ...INITIAL_VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await waitReady(page);
  const size = await page.evaluate(() => {
    const r = document.body.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  });
  await page.setViewport({ ...size, deviceScaleFactor: DEVICE_SCALE_FACTOR });
  // The blinking caret would make the images differ run to run. (The
  // extension CSP blocks injected <style> tags; CSSOM writes are allowed.)
  await page.$eval("#input", (e) => { e.style.caretColor = "transparent"; });
  return { page, size };
}

// ---- main ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
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
    const { page: setup } = await openPopup(browser, extId, COLOR_SCHEMES[0]);
    for (const line of SESSION_LINES) await submit(setup, line);
    await setup.close();

    for (const colorScheme of COLOR_SCHEMES) {
      for (const scene of SCENES) {
        const { page, size } = await openPopup(browser, extId, colorScheme);
        await scene.prepare(page);
        const file = path.join(OUT_DIR, `${scene.name}-${colorScheme}.png`);
        await page.screenshot({ path: file, clip: { x: 0, y: 0, ...size } });
        console.log(`wrote ${path.relative(PROJECT_ROOT, file)}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}

await main();
