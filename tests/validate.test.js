'use strict';

// Tests for server/validate.js — structural validation of doc/backlog.md.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { validateBacklog } = require('../server/validate.js');
const { parseBacklog, archivePathFor } = require('../server/parser.js');

const REAL_BACKLOG_PATH = path.join(__dirname, '..', 'doc', 'backlog.md');
const REAL_ARCHIVE_PATH = archivePathFor(REAL_BACKLOG_PATH);
const REAL_BRIEF_DIR = path.join(__dirname, '..', 'doc', 'brief');

// Create an isolated, throwaway doc/brief/-like directory so synthetic fixtures never
// depend on (or risk colliding with) the real project's doc/brief/.
function makeTmpBriefDir(fileNames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-validate-test-'));
  for (const name of fileNames) fs.writeFileSync(path.join(dir, name), '# fixture brief\n');
  return dir;
}

describe('validateBacklog() — synthetic fixtures', () => {
  it('returns [] for a well-formed backlog referencing an existing brief', () => {
    const briefDir = makeTmpBriefDir(['T-0001-01-some-slug.md']);
    const text = [
      '## T-0001 · Major · Valid task',
      '- type: feature',
      '- status: open',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: T-0001-01',
      '',
      'Some description.',
      '',
    ].join('\n');

    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
  });

  it('returns [] for a backlog with no tasks at all (just a preamble)', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '# Backlog\n\n<!-- comment -->\n';
    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
  });

  it('flags duplicate task ids', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = [
      '## T-0001 · Major · First',
      '- type: feature',
      '- status: open',
      '',
      '## T-0001 · Minor · Second (duplicate id)',
      '- type: feature',
      '- status: open',
      '',
    ].join('\n');

    const errors = validateBacklog(text, briefDir, '');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('T-0001') && /duplicate/i.test(e)));
  });

  it('flags an invalid raw status: value even though parseBacklog would silently default it', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '## T-0002 · Major · Bad status\n- type: feature\n- status: not_a_real_status\n';

    const errors = validateBacklog(text, briefDir, '');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('T-0002') && e.includes('status')));
  });

  it('flags an invalid raw type: value even though parseBacklog would silently default it', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '## T-0002 · Major · Bad type\n- type: chore\n- status: open\n';

    const errors = validateBacklog(text, briefDir, '');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('T-0002') && e.includes('type')));
  });

  it('accepts every known raw type:, external included (T-0092)', () => {
    const briefDir = makeTmpBriefDir([]);
    for (const type of ['feature', 'bug', 'external']) {
      const text = `## T-0004 · Major · Typed task\n- type: ${type}\n- status: open\n`;
      assert.deepStrictEqual(validateBacklog(text, briefDir, ''), [], `type ${type} must validate`);
    }
  });

  it('accepts a field this version does not know (T-0095)', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = [
      '## T-0004 · Major · Field from another version',
      '- type: feature',
      '- status: open',
      '- owner: alice',
      '- sprint:',
      '',
      'Some description.',
      '',
    ].join('\n');

    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
  });

  it('accepts an unknown field whose name carries digits, "_" or "-" (T-0097)', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = [
      '## T-0004 · Major · Field from another version',
      '- type: feature',
      '- status: open',
      '- due_date: 2026-09-01',
      '- sprint-2: yes',
      '',
      'Some description.',
      '',
    ].join('\n');

    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
  });

  it('reads the fields section past such a field, still flagging a bad status after it (T-0097)', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '## T-0004 · Major · Bad status after due_date\n- due_date: 2026-09-01\n- status: nope\n';

    const errors = validateBacklog(text, briefDir, '');
    assert.ok(errors.some((e) => e.includes('T-0004') && e.includes('status')));
  });

  it('ends the fields section at a bullet whose name does not start with a letter (T-0097)', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = [
      '## T-0004 · Major · List item, then description text',
      '- type: feature',
      '- status: open',
      '',
      '- 2: list item',
      '- status: nope',
      '',
    ].join('\n');

    // The second "- status:" is description, exactly as parseBacklog sees it.
    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
    assert.strictEqual(parseBacklog(text)[0].status, 'open');
  });

  it('still flags an invalid known value that follows an unknown field (T-0095)', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '## T-0004 · Major · Bad status after unknown\n- owner: alice\n- status: nope\n';

    const errors = validateBacklog(text, briefDir, '');
    assert.ok(errors.some((e) => e.includes('T-0004') && e.includes('status')));
  });

  it('flags a malformed header (missing "·" separators) that parseBacklog silently swallows', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '## T-0003 Major Missing separators\n- type: feature\n- status: open\n';

    // Sanity check on the premise: parseBacklog does NOT see this as a task at all.
    const { parseBacklog } = require('../server/parser.js');
    assert.deepStrictEqual(parseBacklog(text), []);

    const errors = validateBacklog(text, briefDir, '');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => /malformed/i.test(e) && e.includes('T-0003')));
  });

  it('flags a brief reference that does not resolve to any file in briefDir', () => {
    const briefDir = makeTmpBriefDir([]); // deliberately empty
    const text = '## T-0004 · Major · Missing brief\n- type: feature\n- status: open\n- briefs: T-0004-01\n';

    const errors = validateBacklog(text, briefDir, '');
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('T-0004') && e.includes('T-0004-01')));
  });

  it('accepts a brief reference resolved via the "<id>-<slug>.md" pattern (not just "<id>.md")', () => {
    const briefDir = makeTmpBriefDir(['T-0005-01-some-descriptive-slug.md']);
    const text = '## T-0005 · Major · Has brief\n- type: feature\n- status: open\n- briefs: T-0005-01\n';

    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
  });

  it('still sees fields (and flags a bad raw status) when a blank line sits between the header and the fields (T-0055)', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = [
      '## T-0006 · Major · Blank line before fields',
      '',
      '- type: feature',
      '- status: not_a_real_status',
      '',
    ].join('\n');

    const errors = validateBacklog(text, briefDir, '');
    assert.ok(errors.some((e) => e.includes('T-0006') && e.includes('status')));
  });

  it('accepts a well-formed task that has a blank line between the header and its fields (T-0055)', () => {
    const briefDir = makeTmpBriefDir(['T-0007-01-slug.md']);
    const text = [
      '## T-0007 · Major · Blank line before fields, otherwise valid',
      '',
      '- type: feature',
      '- status: open',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: T-0007-01',
      '',
      'Description.',
      '',
    ].join('\n');

    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
  });

  // ---- dates (T-0170) ----
  // One task, only its date fields varying; no briefs, so the shared empty
  // briefDir is enough.
  const datedFixture = (fields) =>
    ['## T-0008 · Major · Dated task', '- type: feature', ...fields, ''].join('\n');

  it('flags a closed task that carries no closing date', () => {
    const briefDir = makeTmpBriefDir([]);
    for (const status of ['done', 'cancelled']) {
      const text = datedFixture([`- status: ${status}`, '- created: 2026-01-01 00:00:00', '- closed: —']);
      const errors = validateBacklog(text, briefDir, '');
      assert.strictEqual(errors.length, 1, errors.join(' | '));
      assert.match(errors[0], new RegExp(`^T-0008: status "${status}" but no closed date`));
    }
  });

  it('flags a task that is not closed but carries a closing date', () => {
    const briefDir = makeTmpBriefDir([]);
    for (const status of ['backlog', 'open', 'ready', 'in_progress', 'review']) {
      const text = datedFixture([
        `- status: ${status}`,
        '- created: 2026-01-01 00:00:00',
        '- closed: 2026-01-02 00:00:00',
      ]);
      const errors = validateBacklog(text, briefDir, '');
      assert.strictEqual(errors.length, 1, errors.join(' | '));
      assert.match(errors[0], new RegExp(`^T-0008: status "${status}" is not closed, but closed is set`));
      assert.ok(errors[0].includes('2026-01-02 00:00:00'), errors[0]);
    }
  });

  it('accepts the date-only stamps an older briefboard wrote', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = datedFixture(['- status: done', '- created: 2026-01-01', '- closed: 2026-01-02']);
    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
  });

  it('flags a date that does not have the PROTOCOL.md shape, naming the field', () => {
    const briefDir = makeTmpBriefDir([]);
    const cases = [
      ['created', ['- status: open', '- created: yesterday', '- closed: —']],
      ['closed', ['- status: done', '- created: 2026-01-01', '- closed: 2026-01-02T00:00:00Z']],
    ];
    for (const [field, fields] of cases) {
      const errors = validateBacklog(datedFixture(fields), briefDir, '');
      assert.strictEqual(errors.length, 1, errors.join(' | '));
      assert.match(errors[0], new RegExp(`^T-0008: malformed ${field} date`));
      assert.ok(errors[0].includes('YYYY-MM-DD HH:MM:SS'), errors[0]);
    }
  });

  it('names the archive when the date problem is in it', () => {
    const briefDir = makeTmpBriefDir([]);
    const archive = datedFixture(['- status: done', '- created: 2026-01-01 00:00:00', '- closed: —']);
    const errors = validateBacklog('# Backlog\n', briefDir, archive);
    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /^backlog-archive\.md: T-0008: status "done" but no closed date/);
  });

  // ---- dependencies (T-0087) ----
  // Fixtures below need no briefs, so the shared empty briefDir is enough.
  const dependsFixture = (entries) =>
    entries
      .map(([id, depends]) =>
        [
          `## ${id} · Major · Task ${id}`,
          '- type: feature',
          '- status: open',
          ...(depends ? [`- depends: ${depends}`] : []),
          '',
        ].join('\n')
      )
      .join('\n');

  it('accepts depends entries that all resolve to real tasks', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = dependsFixture([['T-0001', null], ['T-0002', 'T-0001']]);
    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
  });

  it('flags a dependency on a task that does not exist', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = dependsFixture([['T-0001', 'T-9999']]);
    const errors = validateBacklog(text, briefDir, '');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /T-0001.*T-9999.*does not exist/);
  });

  it('flags a task that depends on itself', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = dependsFixture([['T-0001', 'T-0001']]);
    const errors = validateBacklog(text, briefDir, '');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /T-0001: depends on itself/);
    // Reported once: the self-edge is deliberately not also called a cycle.
    assert.ok(!/cycle/i.test(errors[0]));
  });

  it('flags a two-task cycle and names its participants', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = dependsFixture([['T-0001', 'T-0002'], ['T-0002', 'T-0001']]);
    const errors = validateBacklog(text, briefDir, '');
    const cycle = errors.find((e) => /cycle/i.test(e));
    assert.ok(cycle, `expected a cycle error, got: ${errors.join(' | ')}`);
    assert.match(cycle, /T-0001 -> T-0002 -> T-0001/);
  });

  it('flags a cycle of any length, naming every task on the ring', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = dependsFixture([
      ['T-0001', 'T-0002'],
      ['T-0002', 'T-0003'],
      ['T-0003', 'T-0004'],
      ['T-0004', 'T-0001'],
    ]);
    const cycle = validateBacklog(text, briefDir, '').find((e) => /cycle/i.test(e));
    assert.ok(cycle);
    for (const id of ['T-0001', 'T-0002', 'T-0003', 'T-0004']) assert.ok(cycle.includes(id));
  });

  it('reports multiple independent problems at once', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = [
      '## T-0001 · Major · First',
      '- type: feature',
      '- status: not_a_real_status',
      '- briefs: T-0001-01',
      '',
      '## T-0001 · Minor · Duplicate of first',
      '- type: bogus',
      '- status: open',
      '',
    ].join('\n');

    const errors = validateBacklog(text, briefDir, '');
    // duplicate id + bad status + bad brief ref + bad type => at least 4 distinct problems
    assert.ok(errors.length >= 4, `expected >= 4 errors, got ${errors.length}: ${errors.join(' | ')}`);
  });
});

describe('validateBacklog() — real project files', () => {
  it('returns [] for the current doc/backlog.md + doc/brief/ (regression guard)', (t) => {
    // This is a regression guard for the real dev backlog. In a clean public
    // snapshot (release-export), doc/backlog.md is replaced by an empty starter
    // and doc/brief/ is empty, so there is nothing to guard. Skip the test when
    // the backlog is absent or parses to no tasks; otherwise run it as before.
    if (!fs.existsSync(REAL_BACKLOG_PATH)) {
      t.skip('doc/backlog.md is absent (clean public snapshot)');
      return;
    }
    const text = fs.readFileSync(REAL_BACKLOG_PATH, 'utf8');
    if (parseBacklog(text).length === 0) {
      t.skip('doc/backlog.md has no tasks (clean public snapshot)');
      return;
    }
    // Same shape as `node tools/task.mjs validate`: dependencies are resolved across
    // both files, so a live task may depend on an archived one. No archive is the
    // normal state of a project that has never archived, and of a clean snapshot.
    const archiveText = fs.existsSync(REAL_ARCHIVE_PATH)
      ? fs.readFileSync(REAL_ARCHIVE_PATH, 'utf8')
      : '';
    const errors = validateBacklog(text, REAL_BRIEF_DIR, archiveText);
    assert.deepStrictEqual(errors, []);
  });
});
