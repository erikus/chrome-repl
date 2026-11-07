// Pure helpers for the popup terminal UI. No DOM or chrome.* access, so this
// module can be exercised directly under Node (tests/popup-lib.test.mjs).

// Characters that end a completion token, matching rlcompleter/readline's
// default delimiters as used by pyodide's Console.complete. "." is not a
// delimiter, so "math.sq" completes as one token.
export const COMPLETER_DELIMS = " \t\n`~!@#$%^&*()-=+[{]}\\|;:'\",<>/?";

// One character of a Python identifier (approximation: letters, digits, "_").
const IDENTIFIER_CHAR = /^[\p{L}\p{N}_]$/u;
// Trailing non-identifier characters rlcompleter appends ("(", " ", ":").
const TRAILING_NON_IDENTIFIER = /[^\p{L}\p{N}_]+$/u;

// Menu update actions returned by planMenuUpdate().
export const MENU_CLOSE = "close";
export const MENU_FILTER = "filter";
export const MENU_REFETCH = "refetch";

/** Longest common prefix of all strings ("" for an empty list). */
export function commonPrefix(strings) {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    let i = 0;
    const max = Math.min(prefix.length, s.length);
    while (i < max && prefix.charCodeAt(i) === s.charCodeAt(i)) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") break;
  }
  return prefix;
}

/** True if the string is empty or only whitespace. */
export function isBlank(s) {
  return s.trim() === "";
}

/**
 * Index in `source` where the text replaced by the completion matches starts.
 * If every match extends the whole source, the whole source is replaced;
 * otherwise the token after the last completer delimiter is replaced.
 */
export function completionStart(source, matches) {
  if (matches.length > 0 && matches.every((m) => m.startsWith(source))) return 0;
  let start = source.length;
  while (start > 0 && !COMPLETER_DELIMS.includes(source[start - 1])) start--;
  return start;
}

/**
 * Matches as full replacements of `source` (the line up to the cursor).
 * The offscreen document already sends full replacements; this also accepts
 * token-only matches by prefixing the text before the completed token.
 */
export function fullReplacements(source, matches) {
  const start = completionStart(source, matches);
  const head = source.slice(0, start);
  return matches.map((m) => head + m);
}

/** True if `ch` is a single identifier character. */
export function isIdentifierChar(ch) {
  return IDENTIFIER_CHAR.test(ch);
}

/** Index where the trailing run of identifier characters in `text` starts. */
export function tokenStart(text) {
  const chars = Array.from(text);
  let i = chars.length;
  while (i > 0 && isIdentifierChar(chars[i - 1])) i--;
  return chars.slice(0, i).join("").length; // UTF-16 index
}

/** The text before the identifier being typed at the end of `before`. */
export function tokenBase(before) {
  return before.slice(0, tokenStart(before));
}

/**
 * Short menu label for a full-replacement match: its last token including
 * any suffix rlcompleter added, e.g. "x = math.sqrt(" -> "sqrt(".
 */
export function completionLabel(match) {
  const core = match.replace(TRAILING_NON_IDENTIFIER, "");
  const label = match.slice(tokenStart(core));
  return label === "" ? match : label;
}

/** Matches that extend `before` (prefix filtering against the current token). */
export function filterMatches(matches, before) {
  return matches.filter((m) => m.startsWith(before));
}

/** `index + delta`, wrapped into [0, count). Returns 0 for an empty list. */
export function wrapIndex(index, delta, count) {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * First visible row of a list window of `rows` rows, moved as little as
 * possible from `first` so that `selected` is visible.
 */
export function scrollFirstRow(first, selected, rows, total) {
  const maxFirst = Math.max(0, total - rows);
  let next = Math.min(Math.max(first, 0), maxFirst);
  if (selected < next) next = selected;
  if (selected >= next + rows) next = selected - rows + 1;
  return Math.min(Math.max(next, 0), maxFirst);
}

/**
 * Decide how an open completion menu reacts to the line changing to
 * `before` + `after` (split at the cursor).
 *
 * `menu` is {source, base, after, matches, truncated}: the text the cached
 * `matches` (full replacements) were fetched for, its tokenBase(), and the
 * text after the cursor at that time.
 *
 * Returns {action: MENU_CLOSE} when the cursor left the token or the line
 * changed some other way, {action: MENU_REFETCH} when the cache cannot answer
 * (cursor moved before `source`, or the cached list was truncated), else
 * {action: MENU_FILTER, items} with the non-empty filtered list.
 */
export function planMenuUpdate(menu, before, after) {
  if (after !== menu.after || tokenBase(before) !== menu.base) return { action: MENU_CLOSE };
  if (!before.startsWith(menu.source) || (menu.truncated && before !== menu.source)) {
    return { action: MENU_REFETCH };
  }
  const items = filterMatches(menu.matches, before);
  if (items.length === 0) return { action: MENU_CLOSE };
  return { action: MENU_FILTER, items };
}
