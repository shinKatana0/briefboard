'use strict';

// Reading a JavaScript source for a pattern without reading its own prose as
// code (T-0138). `tests/suite-hygiene.test.js` matched `fetch(` over raw text,
// so a file that merely NAMED the idiom in a comment was required to import the
// bounded fetch — and a helper's comment had to be reworded to get the suite
// green.
//
// Deleting `//.*` with a regex is not the fix: `'http://host'` would lose its
// tail and take real code on that line with it. Telling a comment from a string
// from a regex literal needs a scanner, so here is a small one over exactly
// those four forms — enough for the sources in tests/, and no parser to install.
//
// Known limit: a template literal is taken whole, so a backtick nested inside
// its `${...}` would end it early. Its body is never emptied for the same
// reason — `${await fetch(url)}` is a call, not prose.

const QUOTES = new Set(["'", '"', '`']);
// After one of these a `/` is division; anywhere else it opens a regex literal.
// This is what keeps the apostrophes in /'[^']*'/ from being read as a string.
const AFTER_VALUE = /[\w$)\]]/;

function endOfString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === quote) return i + 1;
    else i++;
  }
  return text.length;
}

function endOfRegex(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') i += 2;
    else if (ch === '\n') return i;
    else if (inClass) {
      if (ch === ']') inClass = false;
      i++;
    } else if (ch === '[') {
      inClass = true;
      i++;
    } else if (ch === '/') {
      i++;
      while (i < text.length && /[a-z]/.test(text[i])) i++;
      return i;
    } else i++;
  }
  return text.length;
}

/**
 * The source with every comment removed. With `{ emptyStrings: true }` the body
 * of a '…' or "…" literal goes too, so a pattern quoted inside a message counts
 * as a mention rather than a use. Offsets are not preserved; line breaks are.
 */
function stripProse(text, { emptyStrings = false } = {}) {
  let out = '';
  let prev = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const two = text.slice(i, i + 2);
    if (two === '//') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      out += text.slice(i, end === -1 ? text.length : end + 2).replace(/[^\n]/g, ' ');
      i = end === -1 ? text.length : end + 2;
    } else if (QUOTES.has(ch)) {
      const end = endOfString(text, i);
      out += emptyStrings && ch !== '`' ? ch + ch : text.slice(i, end);
      i = end;
      prev = ')';
    } else if (ch === '/' && !AFTER_VALUE.test(prev)) {
      const end = endOfRegex(text, i);
      out += text.slice(i, end);
      i = end;
      prev = ')';
    } else {
      out += ch;
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return out;
}

module.exports = { stripProse };
