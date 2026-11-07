// Chrome smoke test: loads the unpacked extension into Chrome for Testing via
// puppeteer and drives popup.html as a regular tab.
//
// Run with `make smoke`. puppeteer and the browser are installed locally in
// .cache/chrome-test/ (gitignored); nothing is installed globally. Branded
// Google Chrome ignores --load-extension, hence Chrome for Testing.
//
// Env: SMOKE_HEADFUL=1 shows the browser window.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_DIR = path.join(PROJECT_ROOT, ".cache", "chrome-test");
const HEADLESS = process.env.SMOKE_HEADFUL !== "1";

const EXTENSION_ID_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 30_000; // cold start includes Pyodide init
const STEP_TIMEOUT_MS = 10_000;
const LOOP_RUN_BEFORE_INTERRUPT_MS = 500;
const WARM_OPEN_SAMPLES = 5;
const WARM_OPEN_TARGET_MS = 100;
const EXTERNAL_URL = "https://example.com/";
const BANNER_PREFIX = "Python 3.14";
const HUGE_RESULT_CHARS = 1_000_000;
const TRUNCATION_MARKER = "[output truncated"; // from worker.js TRUNCATION_NOTICE
const MAX_EXEC_OUTPUT_CHARS = 16 * 1024; // worker.js OUTPUT_BUDGET_CHARS
const MAX_ECHO_SLACK_CHARS = 100; // echoed input line around the output
const PRINT_LOOP_CLOSED_MS = 5000;
const PRINT_LOOP_BUSY_ITERS = 200_000;
const MENU_SUBMIT_GRACE_MS = 300;

const require = createRequire(path.join(SMOKE_DIR, "package.json"));
const puppeteer = require("puppeteer");

const results = []; // {name, ok, detail}
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail ?? "");
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err));
  }
}

// ---- popup helpers ------------------------------------------------------------

// Usable prompt: banner shown, no notice (starting/error), prompt visible.
function isReadyInPage(bannerPrefix) {
  const banner = document.getElementById("banner").textContent;
  const notice = document.getElementById("notice");
  const prompt = document.getElementById("prompt").textContent;
  return banner.startsWith(bannerPrefix) && notice.hidden && prompt === ">>> ";
}

async function waitReady(page, timeout = READY_TIMEOUT_MS) {
  try {
    await page.waitForFunction(isReadyInPage, { timeout, polling: "mutation" }, BANNER_PREFIX);
  } catch (err) {
    const state = await page.evaluate(() => ({
      banner: document.getElementById("banner").textContent,
      notice: document.getElementById("notice").textContent,
      prompt: document.getElementById("prompt").textContent,
    }));
    throw new Error(`${err.message}; popup state ${JSON.stringify(state)}`);
  }
}

async function openPopup(browser, extId) {
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warn") console.log(`  [popup ${m.type()}] ${m.text()}`);
  });
  const t0 = performance.now();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await waitReady(page);
  const nodeMs = performance.now() - t0;
  // Time from navigation start to the usable prompt, measured in the page.
  const pageMs = await page.evaluate(() => performance.now());
  return { page, nodeMs, pageMs };
}

const transcript = (page) => page.$eval("#transcript", (e) => e.textContent);
const inputValue = (page) => page.$eval("#input", (e) => e.value);
const menuState = (page) => page.$eval("#menu", (menu) => ({
  hidden: menu.hidden,
  rows: [...menu.querySelectorAll(".menu-item")].map((e) => e.textContent),
  count: document.getElementById("menu-count").textContent,
}));

async function waitTranscript(page, predicateSource, arg, timeout = STEP_TIMEOUT_MS) {
  await page.waitForFunction(
    new Function("arg", `const t = document.getElementById("transcript").textContent; return (${predicateSource})(t, arg);`),
    { timeout, polling: "mutation" },
    arg,
  );
}

// Submit one line and wait until it's echoed and Python is idle again. The
// transcript is capped (oldest content evicted), so compare content, not
// length, and return what follows the last echo of the line.
async function submit(page, line) {
  const before = await transcript(page);
  await page_type(page, line);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (prev) => {
      const t = document.getElementById("transcript").textContent;
      const prompt = document.getElementById("prompt").textContent;
      const input = document.getElementById("input").value;
      return t !== prev && prompt !== "" && input === "";
    },
    { timeout: STEP_TIMEOUT_MS, polling: "mutation" },
    before,
  );
  const t = await transcript(page);
  const echo = `>>> ${line}\n`;
  const at = t.lastIndexOf(echo);
  return at === -1 ? t : t.slice(at);
}

async function ctrl(page, key) {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
}

// ---- offscreen helpers -----------------------------------------------------------

async function offscreenEval(browser, extId, expression) {
  const url = `chrome-extension://${extId}/offscreen.html`;
  const target = await browser.waitForTarget((t) => t.url() === url, { timeout: STEP_TIMEOUT_MS });
  const session = await target.createCDPSession();
  try {
    const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  } finally {
    await session.detach();
  }
}

// ---- main ---------------------------------------------------------------------------

async function main() {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    pipe: true,
    enableExtensions: [PROJECT_ROOT],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const tLaunch = performance.now();
  const consoleLines = []; // CSP / network messages from extension contexts
  try {
    const sw = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
      { timeout: EXTENSION_ID_TIMEOUT_MS },
    );
    const extId = new URL(sw.url()).host;
    console.log(`extension id ${extId}; ${(await browser.version())}`);

    // Cold: open immediately, racing the onInstalled pre-warm.
    let popup = null;
    await check("cold open: snapshot ready with 3.14 banner", async () => {
      const r = await openPopup(browser, extId);
      popup = r.page;
      const banner = await popup.$eval("#banner", (e) => e.textContent);
      return `cold ${r.nodeMs.toFixed(0)} ms from tab open (${(performance.now() - tLaunch).toFixed(0)} ms since launch); banner "${banner}"`;
    });
    if (popup === null) throw new Error("popup never became ready; aborting");

    await check("offscreen crossOriginIsolated", async () => {
      const isolated = await offscreenEval(browser, extId, "globalThis.crossOriginIsolated");
      if (isolated !== true) throw new Error(`crossOriginIsolated=${isolated}`);
      return "true";
    });

    await check("2**10 -> 1024", async () => {
      const out = await submit(popup, "2**10");
      if (!out.includes(">>> 2**10\n1024\n")) throw new Error(JSON.stringify(out));
    });

    await check("copy-last-output shortcut puts the last result on the clipboard", async () => {
      await browser.defaultBrowserContext().overridePermissions(
        `chrome-extension://${extId}`, ["clipboard-read", "clipboard-sanitized-write"]);
      await submit(popup, "")
        .catch(() => {}); // a blank Enter must not hide the last answer
      const mods = process.platform === "darwin" ? ["Meta"] : ["Control", "Shift"];
      for (const m of mods) await popup.keyboard.down(m);
      await popup.keyboard.press("KeyC");
      for (const m of mods.reverse()) await popup.keyboard.up(m);
      await popup.waitForFunction(
        () => document.getElementById("notice").textContent === "copied last output",
        { timeout: STEP_TIMEOUT_MS, polling: "mutation" });
      const clip = await popup.evaluate(() => navigator.clipboard.readText());
      if (clip !== "1024") throw new Error(`clipboard ${JSON.stringify(clip)}`);
      return `clipboard "${clip}"`;
    });

    await check("math. Tab opens a menu; typing filters; Enter accepts", async () => {
      const transcriptBefore = await transcript(popup);
      await page_type(popup, "math.");
      await popup.keyboard.press("Tab");
      await popup.waitForFunction(() => {
        const menu = document.getElementById("menu");
        const labels = [...menu.querySelectorAll(".menu-item")].map((e) => e.textContent);
        return !menu.hidden && labels.length > 1;
      }, { timeout: STEP_TIMEOUT_MS, polling: "mutation" });
      const opened = await menuState(popup);
      if (!/^1\/\d+$/.test(opened.count)) throw new Error(`no position indicator: ${JSON.stringify(opened)}`);
      await popup.type("#input", "sq");
      await popup.waitForFunction(() => {
        const labels = [...document.querySelectorAll("#menu .menu-item")].map((e) => e.textContent);
        return labels.length === 1 && labels[0] === "sqrt(";
      }, { timeout: STEP_TIMEOUT_MS, polling: "mutation" });
      await popup.keyboard.press("Enter");
      const value = await inputValue(popup);
      const closed = await menuState(popup);
      // Give a wrongly sent submit time to show up before checking.
      await new Promise((r) => setTimeout(r, MENU_SUBMIT_GRACE_MS));
      const transcriptAfter = await transcript(popup);
      await popup.$eval("#input", (e) => { e.value = ""; });
      if (value !== "math.sqrt(") throw new Error(`input after Enter: ${JSON.stringify(value)}`);
      if (!closed.hidden) throw new Error("menu still open after Enter");
      if (transcriptAfter !== transcriptBefore) throw new Error("Enter submitted the line");
      return `menu ${opened.count} with ${opened.rows.join(" ")}; "sq" -> sqrt(; input "${value}"`;
    });

    await check("Tab with the menu open accepts the highlighted candidate", async () => {
      await page_type(popup, "math.ac");
      await popup.keyboard.press("Tab");
      await popup.waitForFunction(() => !document.getElementById("menu").hidden,
        { timeout: STEP_TIMEOUT_MS, polling: "mutation" });
      const opened = await menuState(popup);
      await popup.keyboard.press("ArrowDown");
      await popup.keyboard.press("Tab");
      const value = await inputValue(popup);
      const closed = await menuState(popup);
      await popup.$eval("#input", (e) => { e.value = ""; });
      if (value !== "math.acosh(") throw new Error(`input after ↓ Tab: ${JSON.stringify(value)}`);
      if (!closed.hidden) throw new Error("menu still open after Tab");
      return `menu ${opened.rows.join(" ")}; ↓ Tab -> "${value}"`;
    });

    await check("Ctrl-C interrupts while True: pass, keeps variables", async () => {
      await submit(popup, "x = 42");
      await page_type(popup, "while True: pass");
      await popup.keyboard.press("Enter");
      await popup.waitForFunction(() => document.getElementById("prompt").textContent === "... ", {
        timeout: STEP_TIMEOUT_MS,
      });
      await popup.keyboard.press("Enter");
      await popup.waitForFunction(() => document.getElementById("prompt").textContent === "", {
        timeout: STEP_TIMEOUT_MS,
      });
      await new Promise((r) => setTimeout(r, LOOP_RUN_BEFORE_INTERRUPT_MS));
      const tInt = performance.now();
      await ctrl(popup, "KeyC");
      await waitTranscript(popup, "(t) => t.includes('KeyboardInterrupt')");
      const intMs = performance.now() - tInt;
      const t = await transcript(popup);
      if (t.includes("was restarted")) throw new Error("fell back to worker restart (variables lost)");
      const out = await submit(popup, "x");
      if (!out.endsWith("42\n")) throw new Error(`x after interrupt: ${JSON.stringify(out)}`);
      return `KeyboardInterrupt after ${intMs.toFixed(0)} ms via SAB; x == 42`;
    });

    await check("close/reopen keeps variables and transcript", async () => {
      await popup.close();
      const r = await openPopup(browser, extId);
      popup = r.page;
      const t = await transcript(popup);
      if (!t.includes(">>> x = 42")) throw new Error("transcript lost");
      const out = await submit(popup, "x + 1");
      if (!out.endsWith("43\n")) throw new Error(JSON.stringify(out));
    });

    await check("warm open time to usable prompt", async () => {
      const samples = [];
      for (let i = 0; i < WARM_OPEN_SAMPLES; i += 1) {
        await popup.close();
        const r = await openPopup(browser, extId);
        popup = r.page;
        samples.push(r.pageMs);
      }
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)];
      const detail = `in-page ms from navigation: ${samples.map((s) => s.toFixed(0)).join(", ")}; median ${median.toFixed(0)} (target < ${WARM_OPEN_TARGET_MS})`;
      if (median >= WARM_OPEN_TARGET_MS) throw new Error(detail);
      return detail;
    });

    // Listen to every extension context's console for CSP violations.
    for (const t of browser.targets()) {
      if (!t.url().startsWith(`chrome-extension://${extId}/`)) continue;
      try {
        const s = await t.createCDPSession();
        await s.send("Runtime.enable");
        await s.send("Log.enable");
        s.on("Log.entryAdded", ({ entry }) => consoleLines.push(`[${t.type()} log] ${entry.text}`));
        s.on("Runtime.consoleAPICalled", (e) =>
          consoleLines.push(`[${t.type()} console] ${e.args.map((a) => a.value ?? a.description).join(" ")}`));
        await s.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        s.connection().on("sessionattached", async (child) => {
          try {
            await child.send("Runtime.enable");
            await child.send("Log.enable");
            child.on("Log.entryAdded", ({ entry }) => consoleLines.push(`[worker log] ${entry.text}`));
          } catch { /* detached */ }
        });
      } catch { /* not attachable */ }
    }

    await check("external fetch from Python blocked by CSP", async () => {
      await submit(popup, "from js import fetch");
      const out = await submit(popup, `r = await fetch(${JSON.stringify(EXTERNAL_URL)})`);
      if (!/Error|error/.test(out)) throw new Error(`fetch did not fail: ${JSON.stringify(out)}`);
      const csp = consoleLines.find((l) => /Content Security Policy|connect-src/.test(l));
      const firstLine = out.trim().split("\n").pop();
      return `${firstLine}${csp ? `; CSP log: ${csp.slice(0, 140)}` : "; (no CSP log captured)"}`;
    });

    await check("import urllib.request fails locally", async () => {
      const out = await submit(popup, "import urllib.request");
      const last = out.trim().split("\n").pop();
      if (!/Error/.test(last)) {
        // Importable: then it must not reach the network either.
        const out2 = await submit(popup, `urllib.request.urlopen(${JSON.stringify(EXTERNAL_URL)})`);
        const last2 = out2.trim().split("\n").pop();
        if (!/Error/.test(last2)) throw new Error(`urlopen succeeded: ${JSON.stringify(out2)}`);
        return `imported; urlopen -> ${last2}`;
      }
      return last;
    });

    await check("import numpy fails with no download", async () => {
      const before = consoleLines.length;
      const out = await submit(popup, "import numpy");
      const last = out.trim().split("\n").pop();
      if (!last.startsWith("ModuleNotFoundError")) throw new Error(JSON.stringify(out));
      const net = consoleLines.slice(before).filter((l) => /http|fetch|Loading/.test(l));
      if (net.length > 0) throw new Error(`network-ish logs: ${net.join(" | ")}`);
      return last;
    });

    await check("huge single-line result is truncated", async () => {
      const out = await submit(popup, `"a" * ${HUGE_RESULT_CHARS}`);
      if (!out.includes(TRUNCATION_MARKER)) throw new Error(`no truncation notice (${out.length} chars)`);
      if (out.length > MAX_EXEC_OUTPUT_CHARS + MAX_ECHO_SLACK_CHARS) throw new Error(`${out.length} chars shown`);
      return `${out.length} chars shown`;
    });

    await check("print loop stops at the output cap with the page closed", async () => {
      // Busy work per iteration so the loop outlives the page being closed.
      await page_type(popup, `while True: print('spam ' * 20); sum(range(${PRINT_LOOP_BUSY_ITERS}))`);
      await popup.keyboard.press("Enter");
      await popup.waitForFunction(() => document.getElementById("prompt").textContent === "... ", {
        timeout: STEP_TIMEOUT_MS,
      });
      await popup.keyboard.press("Enter");
      // Accepted once the transcript echoes the empty continuation line.
      await waitTranscript(popup, "(t) => t.includes('\\n... \\n')");
      await popup.close();
      await new Promise((r) => setTimeout(r, PRINT_LOOP_CLOSED_MS));
      const r = await openPopup(browser, extId);
      popup = r.page;
      const t = await transcript(popup);
      if (!t.includes(TRUNCATION_MARKER)) throw new Error("no truncation notice");
      // The KeyboardInterrupt traceback is post-overflow output, so it is
      // suppressed; openPopup() waiting for ">>> " proves the loop stopped.
      if (t.includes("was restarted")) throw new Error("fell back to worker restart");
      const out = await submit(popup, "x");
      if (!out.endsWith("42\n")) throw new Error(`x after loop: ${JSON.stringify(out)}`);
      return "truncated, stopped (prompt back), x kept";
    });

    await check("Ctrl-L clears the screen, keeps variables", async () => {
      await ctrl(popup, "KeyL");
      await popup.waitForFunction(() => document.getElementById("transcript").textContent === "", {
        timeout: STEP_TIMEOUT_MS,
      });
      const out = await submit(popup, "x");
      if (!out.endsWith("42\n")) throw new Error(JSON.stringify(out));
    });

    await check("exit() resets the session", async () => {
      await page_type(popup, "exit()");
      await popup.keyboard.press("Enter");
      await popup.waitForFunction(() => !document.getElementById("transcript").textContent.includes("x = 42"), {
        timeout: STEP_TIMEOUT_MS,
      });
      await waitReady(popup);
      const out = await submit(popup, "x");
      if (!out.includes("NameError")) throw new Error(JSON.stringify(out));
      return "transcript cleared; x -> NameError";
    });
  } finally {
    if (process.env.SMOKE_DEBUG === "1") for (const l of consoleLines) console.log(`  ${l}`);
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

async function page_type(page, text) {
  await page.focus("#input");
  await page.$eval("#input", (e) => { e.value = ""; });
  await page.type("#input", text);
}

await main();
