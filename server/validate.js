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

const fs = require('node:fs');

const {
  parseBacklog,
  STATUSES,
  TASK_TYPES,
  CLOSED_STATUSES,
  HEADER_RE,
  FIELD_RE,
  MAX_LABEL_LEN,
  MAX_LABELS,
  findBriefFile,
  BRIEF_FILE_RE,
  dependencyCycles,
} = require('./parser.js');

// Loose match: "looks like a task header" (starts with "## T-XXXX"), used to find
// headers that are broken in some way (missing "·" separator, bad priority name, etc.)
// - i.e. lines HEADER_RE fails to recognize but that were clearly meant to be a header.
const HEADER_LOOSE_RE = /^## T-\d{4}/;

// PROTOCOL.md writes `created`/`closed` as "YYYY-MM-DD HH:MM:SS", but the time
// is optional here: earlier briefboard versions wrote the date alone (18 values
// in this repository's own two files still are), and a task written by an older
// version must not fail on a part that did not exist then.
const DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;
const DATE_SHAPE = 'YYYY-MM-DD or YYYY-MM-DD HH:MM:SS';

// What is wrong with a raw `- labels:` value, or nothing (T-0279). parseBacklog
// drops a name breaking the rules, so a hand-edited file loses it on the next
// save without a word - this is what says so first.
//
// One check and deliberately no more: the set of labels is implicit, so there is
// no such thing as an "unknown" label to report, and a "this one looks like that
// one" warning would fire on every genuinely new label. A validator that cries
// wolf on the normal path is worse than no check at all.
function labelProblems(rawValue) {
  const problems = [];
  // "- labels:" with nothing after it is an empty list, not an empty item.
  if (rawValue.trim() === '') return problems;
  const items = rawValue.split(',').map((s) => s.trim());
  if (items.some((name) => !name)) {
    problems.push(`empty label in "${rawValue}" (a stray comma - the empty string is not a label)`);
  }
  for (const name of items) {
    if (name.length > MAX_LABEL_LEN) {
      problems.push(`label "${name}" is longer than ${MAX_LABEL_LEN} characters`);
    }
  }
  const kept = [...new Set(items.filter(Boolean))];
  if (kept.length > MAX_LABELS) {
    problems.push(`${kept.length} labels, and a task carries at most ${MAX_LABELS}`);
  }
  return problems;
}

// The checks that are about ONE file's text: broken headers, ids repeated
// inside it, raw status/type values. `prefix` names the file when the text is
// not doc/backlog.md - an unlabelled "Line 12:" would send the reader to the
// wrong one (T-0156).
function validateFile(text, prefix) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  const at = (msg) => errors.push(prefix + msg);

  // 1. Lines that look like a task header but do not match the strict HEADER_RE -
  // e.g. missing "·" separators, or a priority not in the fixed 5-value list. These are
  // exactly the lines parseBacklog() silently fails to recognize as headers at all.
  lines.forEach((line, idx) => {
    if (HEADER_LOOSE_RE.test(line) && !HEADER_RE.test(line)) {
      at(
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
    if (count > 1) at(`Duplicate task id ${id} (appears ${count} times)`);
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
    // Keep in sync with escapeDescription() in parser.js: an escaped "\- key: value" is not
    // FIELD_RE-shaped, which is why this raw scan ends the fields section where the parser does.
    const f = inFields ? line.match(FIELD_RE) : null;
    if (f) {
      const [, key, rawValue] = f;
      const value = rawValue.trim();
      if (key === 'status' && !STATUSES.includes(value)) {
        at(`${curId}: invalid raw status "${value}" (must be exactly one of: ${STATUSES.join(', ')})`);
      }
      if (key === 'type' && !TASK_TYPES.includes(value)) {
        at(`${curId}: invalid raw type "${value}" (must be exactly one of: ${TASK_TYPES.join(', ')})`);
      }
      if (key === 'labels') {
        for (const problem of labelProblems(value)) at(`${curId}: ${problem}`);
      }
      continue;
    }
    // First non-field line after a header ends the fields section for this task,
    // exactly like parseBacklog()'s desc.length === 0 guard.
    inFields = false;
  }

  // 4. Dates (T-0170). PROTOCOL.md ties `closed` to the status - done/cancelled
  // carry a closing date, every other status carries the "—" placeholder - and
  // `tools/task.mjs status` maintains both directions itself. Hand-editing
  // doc/backlog.md is supported though, and this validator (which the pre-commit
  // hook runs) was the only rule of the format with no guard behind it.
  for (const t of tasks) {
    const isClosed = CLOSED_STATUSES.includes(t.status);
    if (isClosed && !t.closed) {
      at(`${t.id}: status "${t.status}" but no closed date (a closed task must carry the date it was closed)`);
    }
    if (!isClosed && t.closed) {
      at(
        `${t.id}: status "${t.status}" is not closed, but closed is set to "${t.closed}" ` +
          `(only ${CLOSED_STATUSES.join('/')} carry a closing date; otherwise write "—")`
      );
    }
    for (const [field, value] of [['created', t.created], ['closed', t.closed]]) {
      if (value && !DATE_RE.test(value)) {
        at(`${t.id}: malformed ${field} date "${value}" (expected ${DATE_SHAPE})`);
      }
    }
  }

  return errors;
}

// What the archive file is called in a message. The validator is handed text,
// not paths, and "the archive" would leave the reader hunting for the file.
const ARCHIVE_NAME = 'backlog-archive.md';

// A file this validator has an opinion about is exactly a file findBriefFile()
// would resolve: BRIEF_FILE_RE comes from parser.js, which owns the notion, so
// the two cannot drift apart again the way they did until T-0283.

// The names in briefDir, or none. Missing or unreadable is not an error here:
// callers pass null (no brief directory at all) and a project may simply have
// written no brief yet - rule 4 already reports a REFERENCE that does not
// resolve, which is what makes an unreadable directory visible.
function briefFileNames(briefDir) {
  if (!briefDir) return [];
  try {
    return fs.readdirSync(briefDir).sort();
  } catch {
    return [];
  }
}

/**
 * Validate the raw text of doc/backlog.md, and of doc/backlog-archive.md when the
 * project has one.
 * Returns an array of human-readable error strings; an empty array means the files are valid.
 *
 * @param {string} text - full contents of doc/backlog.md
 * @param {string} briefDir - path to doc/brief/, used to resolve `briefs:` references
 * @param {string} archiveText - full contents of doc/backlog-archive.md, '' when the
 *   project has none. Required: see the throw below.
 */
function validateBacklog(text, briefDir, archiveText) {
  // A forgotten third argument is `undefined`, and `undefined` used to mean
  // "no archive" - so the call site T-0156 left behind kept validating half the
  // data in silence for months, and only turned red when the backlog was finally
  // archived (T-0168). Arity is the thing being checked here: `undefined` is
  // indistinguishable from a missing argument and throws, while any other value
  // is a deliberate choice by the caller and is coerced as before.
  if (archiveText === undefined) {
    throw new TypeError(
      "validateBacklog(text, briefDir, archiveText): archiveText is required - pass '' when the project has no doc/backlog-archive.md"
    );
  }
  const archiveSource = String(archiveText == null ? '' : archiveText);
  const errors = validateFile(text, '').concat(validateFile(archiveSource, `${ARCHIVE_NAME}: `));

  const tasks = parseBacklog(text);
  const archived = parseBacklog(archiveSource);
  // The whole point of validating both files at once: an id in both names two
  // different tasks, and every reference to it - `depends`, doc/brief/T-NNNN-*,
  // a link in a report - then points at both. This is the error the archive can
  // introduce and nothing else would catch (T-0156).
  const liveIds = new Set(tasks.map((t) => t.id));
  for (const t of archived) {
    if (liveIds.has(t.id)) {
      errors.push(
        `${t.id} is in BOTH doc/backlog.md and doc/${ARCHIVE_NAME} - the same id names two tasks ` +
          `(an interrupted archive run leaves this; re-run: node tools/task.mjs archive)`
      );
    }
    // Only terminal statuses belong there: nothing writes to the archive, so a
    // task that still has a transition ahead of it would be frozen out of reach
    // of every command and of the board's own actions.
    if (!CLOSED_STATUSES.includes(t.status)) {
      errors.push(
        `${ARCHIVE_NAME}: ${t.id} has status "${t.status}" - only ${CLOSED_STATUSES.join('/')} belong in the archive`
      );
    }
  }

  // From here on the two files are one backlog: a brief belongs to the task
  // wherever the task now lives, and a `depends` may point across the border.
  const all = tasks.concat(archived);

  // 4. Brief references must resolve to a real file in briefDir.
  for (const t of all) {
    for (const briefId of t.briefs) {
      if (!findBriefFile(briefDir, briefId)) {
        errors.push(`${t.id}: brief ${briefId} does not resolve to a file in ${briefDir}`);
      }
    }
  }

  const knownIds = new Set(all.map((t) => t.id));

  // 5. The other direction: a brief FILE that no task links (T-0268). Rule 4
  // checks link -> file and nothing checked file -> link, so an unlinked brief
  // was reported by nothing at all - not here, not by the board, not by the
  // pre-commit hook. That is the exact state in which two finished briefs were
  // destroyed: the file was on disk, the card did not link it, and `brief`
  // therefore computed the very number the file already held (T-0264).
  //
  // Read across BOTH files, like every check below this line: tasks move to the
  // archive and their briefs stay where they are, so looking only at
  // doc/backlog.md would declare every brief of every closed task an orphan -
  // 147 of them in this repository, which is not a check, it is noise.
  //
  // An ERROR rather than a warning, decided on the count the brief asked for and
  // not on taste. Measured on this repository 2026-08-17: 206 brief files, 273
  // tasks across both files, and ZERO orphans. So a hard failure costs nothing
  // standing, while the state it names is the one that ate content - and since
  // T-0267 it is fixable with the single command the message prints, which is
  // what a check that can break a commit has to offer. A warning nobody has to
  // act on would leave this exactly as loud as it was before: unread.
  const linked = new Set();
  for (const t of all) for (const briefId of t.briefs) linked.add(briefId);
  // Filled by the same pass, spent by rule 5b below: one readdir answers both
  // questions, and the id -> files grouping is what 5b needs anyway.
  const filesByBriefId = new Map();
  for (const name of briefFileNames(briefDir)) {
    const m = BRIEF_FILE_RE.exec(name);
    if (!m) continue;
    const [, taskId, nn] = m;
    const briefId = `${taskId}-${nn}`;
    const sameId = filesByBriefId.get(briefId);
    if (sameId) sameId.push(name);
    else filesByBriefId.set(briefId, [name]);
    if (linked.has(briefId)) continue;
    // Two different accidents, told apart in the wording: a card that exists and
    // does not link its own brief is one command from being right, while a file
    // for a task nobody ever filed is a question about where the file came from.
    errors.push(
      knownIds.has(taskId)
        ? `${briefId}: ${name} is in ${briefDir}, but ${taskId} does not link it ` +
            `(link it: node tools/task.mjs link ${briefId})`
        : `${briefId}: ${name} is in ${briefDir}, but there is no task ${taskId} in ` +
            `doc/backlog.md or doc/${ARCHIVE_NAME}`
    );
  }

  // 5b. Two files answering to ONE brief id (T-0275). Built on rule 5's pass,
  // and numbered after it for the same reason: same readdir, same subject.
  // findBriefFile() resolves an id by prefix, so T-0007-01-first.md and
  // T-0007-01-second.md are both answers to T-0007-01 and only one of them is
  // ever served: the board shows that one, the reader may well be editing the
  // other, and nothing says a word. Rule 5 does not see it - both files carry a
  // linked id, so neither is an orphan -
  // and `brief`/`link` only refuse to CREATE the second file (T-0264), which
  // says nothing about a duplicate that arrived by a rename, a merge or a
  // recovered copy dropped in beside the original.
  //
  // An ERROR, on rule 5's precedent and for its reason. Measured on this
  // repository 2026-08-17: 206 brief files, 206 distinct ids, ZERO duplicates -
  // so a hard failure costs nothing standing, while the state it names is one
  // where the board and the CLI can disagree about what a brief says.
  //
  // The message names every file, because the reader's next act is to choose
  // which to keep and a message naming one of them cannot be acted on. It does
  // not guess which is stale: that is content, and this validator has no opinion
  // about content. The names are in the order briefFileNames() returns them,
  // which is sorted - the same message on every machine.
  for (const [briefId, names] of filesByBriefId) {
    if (names.length < 2) continue;
    errors.push(
      `${briefId}: ${names.length} files in ${briefDir} answer to this one brief id: ` +
        `${names.join(', ')} - only the first of them is ever read, by the board and by ` +
        `task.mjs alike; keep one and rename or delete the rest`
    );
  }

  // 6. Dependencies (T-0087). A dangling or self-referential `depends` entry can
  // never be satisfied, so the task it belongs to would stay blocked forever;
  // a cycle blocks every task in it. The cycle message names the participants -
  // "there is a cycle" alone is not something anyone can act on.
  //
  // Resolved across both files: a prerequisite that was done and then archived
  // is still a prerequisite, and reporting it as non-existent would turn every
  // archive run into a wall of false errors.
  for (const t of all) {
    for (const depId of t.depends) {
      if (depId === t.id) errors.push(`${t.id}: depends on itself`);
      else if (!knownIds.has(depId)) errors.push(`${t.id}: depends on ${depId}, which does not exist`);
    }
  }
  for (const cycle of dependencyCycles(all)) {
    errors.push(`Dependency cycle: ${cycle.join(' -> ')}`);
  }

  return errors;
}

module.exports = { validateBacklog };
