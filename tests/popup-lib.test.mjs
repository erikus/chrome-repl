// Unit tests for the pure popup helpers (completion menu logic).
// Run: node --test tests/  (part of `make test`)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MENU_CLOSE,
  MENU_FILTER,
  MENU_REFETCH,
  commonPrefix,
  completionLabel,
  filterMatches,
  fullReplacements,
  planMenuUpdate,
  scrollFirstRow,
  tokenBase,
  tokenStart,
  wrapIndex,
} from "../popup-lib.js";

const MATH_MATCHES = ["math.pi", "math.sin(", "math.sinh(", "math.sqrt(", "math.tau"];

function mathMenu(overrides = {}) {
  return {
    source: "math.",
    base: "math.",
    after: "",
    matches: MATH_MATCHES,
    truncated: false,
    ...overrides,
  };
}

test("commonPrefix", () => {
  assert.equal(commonPrefix([]), "");
  assert.equal(commonPrefix(["math.acos(", "math.acosh("]), "math.acos");
  assert.equal(commonPrefix(["abc", "xyz"]), "");
});

test("tokenStart / tokenBase find the identifier before the cursor", () => {
  assert.equal(tokenStart("math.sq"), 5);
  assert.equal(tokenStart("math."), 5);
  assert.equal(tokenStart("x = abs"), 4);
  assert.equal(tokenStart("f(x"), 2);
  assert.equal(tokenStart(""), 0);
  assert.equal(tokenStart("π_2"), 0);
  assert.equal(tokenBase("y = math.sq"), "y = math.");
});

test("completionLabel shows the last token with its suffix", () => {
  assert.equal(completionLabel("math.sqrt("), "sqrt(");
  assert.equal(completionLabel("x = math.pi"), "pi");
  assert.equal(completionLabel("import "), "import ");
  assert.equal(completionLabel("try:"), "try:");
  assert.equal(completionLabel("("), "(");
});

test("fullReplacements keeps full matches and prefixes token-only ones", () => {
  assert.deepEqual(fullReplacements("math.s", ["math.sin(", "math.sqrt("]), ["math.sin(", "math.sqrt("]);
  assert.deepEqual(fullReplacements("x = ab", ["abs("]), ["x = abs("]);
});

test("filterMatches is a prefix filter on the line before the cursor", () => {
  assert.deepEqual(filterMatches(MATH_MATCHES, "math.s"), ["math.sin(", "math.sinh(", "math.sqrt("]);
  assert.deepEqual(filterMatches(MATH_MATCHES, "math.sq"), ["math.sqrt("]);
  assert.deepEqual(filterMatches(MATH_MATCHES, "math.z"), []);
});

test("wrapIndex wraps both ways", () => {
  assert.equal(wrapIndex(0, 1, 3), 1);
  assert.equal(wrapIndex(2, 1, 3), 0);
  assert.equal(wrapIndex(0, -1, 3), 2);
  assert.equal(wrapIndex(0, 1, 0), 0);
});

test("scrollFirstRow keeps the selection visible with minimal movement", () => {
  const ROWS = 4;
  const TOTAL = 10;
  assert.equal(scrollFirstRow(0, 3, ROWS, TOTAL), 0);
  assert.equal(scrollFirstRow(0, 4, ROWS, TOTAL), 1);
  assert.equal(scrollFirstRow(5, 2, ROWS, TOTAL), 2);
  assert.equal(scrollFirstRow(0, 9, ROWS, TOTAL), 6); // wrapped to the end
  assert.equal(scrollFirstRow(6, 0, ROWS, TOTAL), 0); // wrapped to the start
  assert.equal(scrollFirstRow(8, 1, ROWS, 2), 0); // list shrank
});

test("planMenuUpdate filters while typing the token", () => {
  assert.deepEqual(planMenuUpdate(mathMenu(), "math.sq", ""), { action: MENU_FILTER, items: ["math.sqrt("] });
  assert.deepEqual(planMenuUpdate(mathMenu(), "math.", ""), { action: MENU_FILTER, items: MATH_MATCHES });
});

test("planMenuUpdate closes when nothing matches or the cursor leaves the token", () => {
  assert.equal(planMenuUpdate(mathMenu(), "math.z", "").action, MENU_CLOSE);
  assert.equal(planMenuUpdate(mathMenu(), "math.sqrt(", "").action, MENU_CLOSE);
  assert.equal(planMenuUpdate(mathMenu(), "math.s ", "").action, MENU_CLOSE);
  assert.equal(planMenuUpdate(mathMenu(), "math.s+", "").action, MENU_CLOSE);
  assert.equal(planMenuUpdate(mathMenu(), "math", "").action, MENU_CLOSE);
  assert.equal(planMenuUpdate(mathMenu(), "math.s", ")").action, MENU_CLOSE);
});

test("planMenuUpdate refetches before the source or for a truncated list", () => {
  const menu = mathMenu({ source: "math.sq" });
  assert.equal(planMenuUpdate(menu, "math.s", "").action, MENU_REFETCH); // Backspace
  assert.equal(planMenuUpdate(menu, "math.sqr", "").action, MENU_FILTER);
  const truncated = mathMenu({ truncated: true });
  assert.equal(planMenuUpdate(truncated, "math.", "").action, MENU_FILTER);
  assert.equal(planMenuUpdate(truncated, "math.s", "").action, MENU_REFETCH);
});
