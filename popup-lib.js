// Pure helpers for the popup terminal UI. No DOM or chrome.* access, so this
// module can be exercised directly under Node.

// Characters that end a completion token, matching rlcompleter/readline's
// default delimiters as used by pyodide's Console.complete. "." is not a
// delimiter, so "math.sq" completes as one token.
export const COMPLETER_DELIMS = " \t\n`~!@#$%^&*()-=+[{]}\\|;:'\",<>/?";

// Gap between listing columns, like readline.
export const LISTING_COLUMN_GAP = 2;

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
 * Format items in readline-style columns, filled top-to-bottom then
 * left-to-right, fitting within `widthChars` columns. Returns lines joined by
 * "\n" with no trailing newline and no trailing spaces.
 */
export function formatColumns(items, widthChars) {
  if (items.length === 0) return "";
  const longest = Math.max(...items.map((s) => s.length));
  const colWidth = longest + LISTING_COLUMN_GAP;
  // The last column needs no trailing gap.
  const cols = Math.max(1, Math.floor((widthChars + LISTING_COLUMN_GAP) / colWidth));
  const rows = Math.ceil(items.length / cols);
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const i = c * rows + r;
      if (i >= items.length) break;
      const isLastInRow = c === cols - 1 || (c + 1) * rows + r >= items.length;
      line += isLastInRow ? items[i] : items[i].padEnd(colWidth);
    }
    lines.push(line);
  }
  return lines.join("\n");
}
