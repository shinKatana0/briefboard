'use strict';

// Structural validator for doc/backlog.md - see doc/brief/T-0031-01-backlog-validation.md.
//
// Important: parseBacklog() (server/parser.js) is deliberately lenient - it silently
// defaults out-of-range priority/status/type values, and a header line that does not
// match HEADER_RE is not recognized as a header at all (it silently leaks into the
// previous task's description or the file preamble). That leniency is correct for a
// renderer, but it means parseBacklog() itself can never catch structural damage to the
// file. validateBacklog() below is a separate, stricter pass over the RAW text (not the
// already-defaulted objects) so opeators/CI actually see broken status/type/header lines
// and dangling brief references instead of them being silently swallowed.

const { parseBacklog, STATUSES, HEADER_RE, FIELD_RE, findBriefFile } = require('./parser.js');

// Loose match: "looks like a task header" (starts with "## T-XXXX"), used to find
// headers that are broken in some way (missing "·" separator, bad priority name, etc.)
// - i.e. lines HEADER_RE fails to recognize but that were clearly meant to be a header.
const HEADER_LOOSE_RE = /^## T-\d{4}/;

/**
 * Validate the raw text of doc/backlog.md.
 * Returns an array of human-readable error strings; an empty array means the file is valid.
 *
 * @param {string} text - full contents of doc/backlog.md
 * @param {string} briefDir - path to doc/brief/, used to resolve `briefs:` references
 */
function validateBacklog(text, briefDir) {
  const errors = [];
  const lines = text.split(/\r?\n/);

  // 1. Lines that look like a task header but do not match the strict HEADER_RE -
  // e.g. missing "·" separators, or a priority not in the fixed 5-value list. These are
  // exactly the lines parseBacklog() silently fails to recognize as headers at all.
  lines.forEach((line, idx) => {
    if (HEADER_LOOSE_RE.test(line) && !HEADER_RE.test(line)) {
      errors.push(
        `Line ${idx + 1}: malformed task header (does not match "## T-XXXX · Priority · Title"): ${JSON.stringify(line)}`
      );
    }
  });

  // 2. Duplicate task ids (checked on the already-parsed tasks - a duplicate id is a
  // duplicate regardless of what parseBacklog defaulted its other fields to).
  const tasks = parseBacklog(text);
  const idCounts = new Map();
  for (const t of tasks) idCounts.set(t.id, (idCounts.get(t.id) || 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push(`Duplicate task id ${id} (appears ${count} times)`);
  }

  // 3. Raw status:/type: field values, checked BEFORE parseBacklog's defaulting. A raw
  // value outside the allowed set is a sign of a typo/corruption even though
  // parseBacklog() would silently default it - that silent default is exactly what this
  // validator exists to surface.
  let curId = null;
  let inFields = false; // mirrors parseBacklog()'s "desc.length === 0" field-vs-description boundary
  for (const line of lines) {
    const h = line.match(HEADER_RE);
    if (h) {
      curId = h[1];
      inFields = true;
      continue;
    }
    if (curId === null) continue; // preamble before the first task
    // While still in the fields section, a blank line does not end it - mirror
    // parseBacklog(), which skips blank lines between the header and the first
    // field (and between fields) rather than switching to description mode
    // (T-0055). Without this the validator would see a different field boundary
    // than the parser and could miss an invalid status:/type: value placed after
    // such a blank line.
    if (inFields && line.trim() === '') continue;
    const f = inFields ? line.match(FIELD_RE) : null;
    if (f) {
      const [, key, rawValue] = f;
      const value = rawValue.trim();
      if (key === 'status' && !STATUSES.includes(value)) {
        errors.push(
          `${curId}: invalid raw status "${value}" (must be exactly one of: ${STATUSES.join(', ')})`
        );
      }
      if (key === 'type' && value !== 'feature' && value !== 'bug') {
        errors.push(`${curId}: invalid raw type "${value}" (must be exactly "feature" or "bug")`);
      }
      continue;
    }
    // First non-field line after a header ends the fields section for this task,
    // exactly like parseBacklog()'s desc.length === 0 guard.
    inFields = false;
  }

  // 4. Brief references must resolve to a real file in briefDir.
  for (const t of tasks) {
    for (const briefId of t.briefs) {
      if (!findBriefFile(briefDir, briefId)) {
        errors.push(`${t.id}: brief ${briefId} does not resolve to a file in ${briefDir}`);
      }
    }
  }

  return errors;
}

module.exports = { validateBacklog };
