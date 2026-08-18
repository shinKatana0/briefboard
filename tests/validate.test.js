'use strict';

// Tests for server/validate.js — structural validation of doc/backlog.md.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateBacklog } = require('../server/validate.js');
const { parseBacklog, archivePathFor, MAX_LABEL_LEN, MAX_LABELS } = require('../server/parser.js');
const { skipMaintainerData } = require('./helpers/public-tree.js');
const { tempDir } = require('./helpers/tmp.js');

const REAL_BACKLOG_PATH = path.join(__dirname, '..', 'doc', 'backlog.md');
const REAL_ARCHIVE_PATH = archivePathFor(REAL_BACKLOG_PATH);
const REAL_BRIEF_DIR = path.join(__dirname, '..', 'doc', 'brief');

// Create an isolated, throwaway doc/brief/-like directory so synthetic fixtures never
// depend on (or risk colliding with) the real project's doc/brief/.
function makeTmpBriefDir(fileNames) {
  const dir = tempDir('briefboard-validate-test-');
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

  it('flags a brief reference that only a non-.md neighbour answers to (T-0283)', () => {
    // Until findBriefFile required the extension this directory was SILENT: the
    // id resolved (to the backup), so rule 4 was satisfied, and the .bak claims
    // no brief id, so neither the orphan check (T-0268) nor the duplicate check
    // (T-0275) had an opinion. Now it is rule 4's existing dangling message —
    // one message, the one that names the file that is actually missing, and no
    // new complaint about backup files living in the directory.
    const briefDir = makeTmpBriefDir(['T-0004-01-old.md.bak']);
    const text = '## T-0004 · Major · Only a backup\n- type: feature\n- status: open\n- briefs: T-0004-01\n';

    const errors = validateBacklog(text, briefDir, '');
    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /T-0004: brief T-0004-01 does not resolve to a file/);
    assert.doesNotMatch(errors[0], /\.bak/);

    // And the real brief beside it is what makes the reference resolve again —
    // proof the fixture is not simply un-resolvable for some other reason.
    fs.writeFileSync(path.join(briefDir, 'T-0004-01-real.md'), '# fixture brief\n');
    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);
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

  // ---- brief files nothing links (T-0268) ----
  // The direction rule 4 does not check. A brief on disk that no task links is
  // the state in which two finished briefs were overwritten: invisible to the
  // numbering, and reported by nothing — not here, not by the board, not by the
  // pre-commit hook (T-0264).
  const taskFixture = (id, briefs) =>
    [
      `## ${id} · Major · Task ${id}`,
      '- type: feature',
      '- status: open',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      `- briefs: ${briefs}`,
      '',
    ].join('\n');

  it('flags a brief file its own task does not link, and names the command that links it', () => {
    const briefDir = makeTmpBriefDir(['T-0001-01-linked.md', 'T-0001-02-forgotten.md']);

    const errors = validateBacklog(taskFixture('T-0001', 'T-0001-01'), briefDir, '');

    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /^T-0001-02: T-0001-02-forgotten\.md/);
    assert.match(errors[0], /T-0001 does not link it/);
    assert.match(errors[0], /node tools\/task\.mjs link T-0001-02/, 'the fix is one command since T-0267');
  });

  it('recognises a brief file with no slug at all, the way findBriefFile does', () => {
    const briefDir = makeTmpBriefDir(['T-0001-01.md']);

    const errors = validateBacklog(taskFixture('T-0001', ''), briefDir, '');

    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /^T-0001-01: T-0001-01\.md/);
  });

  it('tells the two orphans apart: a file whose task exists nowhere gets its own message', () => {
    const briefDir = makeTmpBriefDir(['T-0404-01-ghost.md']);

    const errors = validateBacklog(taskFixture('T-0001', ''), briefDir, '');

    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /there is no task T-0404 in doc\/backlog\.md or doc\/backlog-archive\.md/);
    assert.doesNotMatch(errors[0], /task\.mjs link/, 'there is no card to link it to, so none is advised');
  });

  it('does not call the brief of an archived task an orphan — though the same file is one without it', () => {
    const briefDir = makeTmpBriefDir(['T-0140-01-closed-work.md']);
    const archive = [
      '## T-0140 · Major · Closed and moved out',
      '- type: feature',
      '- status: done',
      '- created: 2026-01-01 00:00:00',
      '- closed: 2026-01-02 00:00:00',
      '- briefs: T-0140-01',
      '',
    ].join('\n');

    assert.deepStrictEqual(validateBacklog('# Backlog\n', briefDir, archive), []);

    // The premise, checked rather than assumed: the pass above is the archive
    // being read, not the check being asleep. Tasks move to the archive and
    // their briefs stay where they are, so a check that read doc/backlog.md
    // alone would declare every brief of every closed task an orphan — 147 of
    // them in this repository.
    const withoutArchive = validateBacklog('# Backlog\n', briefDir, '');
    assert.strictEqual(withoutArchive.length, 1, withoutArchive.join(' | '));
    assert.match(withoutArchive[0], /no task T-0140/);
  });

  it('ignores everything in the directory that claims no brief id, .gitkeep included', () => {
    // .gitkeep is not incidental: tools/release-export.mjs stands one up in the
    // emptied brief directory and the suite recognises a public tree BY it
    // (tests/helpers/public-tree.js), so a check that complained here would
    // break the export.
    const briefDir = makeTmpBriefDir([
      '.gitkeep',
      'README.md',
      'draft.md',
      'T-0001-notes.md',
      'T-0001-01-old.md.bak',
      'T-0001-01-real.md',
    ]);
    const text = taskFixture('T-0001', 'T-0001-01');

    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);

    // And not because the check gave up on this directory: one real orphan
    // among the same files is still found, and it is the only thing reported.
    fs.writeFileSync(path.join(briefDir, 'T-0001-02-forgotten.md'), '# fixture brief\n');
    const errors = validateBacklog(text, briefDir, '');
    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /T-0001-02-forgotten\.md/);
  });

  it('has no opinion when there is no brief directory to read', () => {
    const text = taskFixture('T-0001', '');
    assert.deepStrictEqual(validateBacklog(text, null, ''), []);
    assert.deepStrictEqual(validateBacklog(text, path.join(tempDir('briefboard-validate-test-'), 'nope'), ''), []);
  });

  // ---- two files answering to one brief id (T-0275) ----
  // The shape neither rule 4 nor rule 5 sees: the id resolves to a file, and
  // every one of the files carries an id some task links — so nothing is
  // dangling and nothing is an orphan. findBriefFile() still serves exactly one
  // of them, and the reader can be editing the other.

  it('flags two files answering to one brief id, naming the id and BOTH files', () => {
    const briefDir = makeTmpBriefDir(['T-0001-01-first.md', 'T-0001-01-second.md']);

    const errors = validateBacklog(taskFixture('T-0001', 'T-0001-01'), briefDir, '');

    // Exactly one message: this is one ambiguity, not one problem per file — and
    // the file the tools ignore is not an orphan, so rule 5 must stay quiet.
    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /^T-0001-01: /);
    assert.match(errors[0], /T-0001-01-first\.md/);
    assert.match(errors[0], /T-0001-01-second\.md/);
    assert.doesNotMatch(errors[0], /orphan|does not link it/);
  });

  it('reports three files answering to one id once, naming all three — not as two pairs', () => {
    // Created back to front, so the message's order is the check's doing and not
    // the order the files happened to appear in.
    const briefDir = makeTmpBriefDir(['T-0001-01-third.md', 'T-0001-01-second.md', 'T-0001-01-first.md']);

    const errors = validateBacklog(taskFixture('T-0001', 'T-0001-01'), briefDir, '');

    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(
      errors[0],
      /T-0001-01-first\.md, T-0001-01-second\.md, T-0001-01-third\.md/,
      'all three, sorted, in one message'
    );
    assert.match(errors[0], /\b3 files\b/);
  });

  it('says nothing about ids that have exactly one file each', () => {
    // Two ids, two files, one apiece — including the no-slug spelling, which is
    // a different name for the same id and must not be mistaken for a duplicate.
    const briefDir = makeTmpBriefDir(['T-0001-01.md', 'T-0001-02-other.md']);

    assert.deepStrictEqual(validateBacklog(taskFixture('T-0001', 'T-0001-01, T-0001-02'), briefDir, ''), []);
  });

  it('counts only files that claim a brief id: a .gitkeep or a .bak beside a brief is not a duplicate', () => {
    // T-0001-01-old.md.bak starts with the id and is not a brief file, so it is
    // none of this check's business — the same rule that keeps the release
    // export's .gitkeep out of it (T-0268).
    const briefDir = makeTmpBriefDir(['.gitkeep', 'README.md', 'T-0001-01-old.md.bak', 'T-0001-01-real.md']);
    const text = taskFixture('T-0001', 'T-0001-01');

    assert.deepStrictEqual(validateBacklog(text, briefDir, ''), []);

    // And not because the check gave up on this directory: a real second file
    // for the same id, among the same neighbours, is still the one thing found.
    fs.writeFileSync(path.join(briefDir, 'T-0001-01-copy.md'), '# fixture brief\n');
    const errors = validateBacklog(text, briefDir, '');
    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /T-0001-01-copy\.md, T-0001-01-real\.md/);
    assert.doesNotMatch(errors[0], /\.bak|README|gitkeep/);
  });

  it('reports a duplicated brief id of an ARCHIVED task too — the files stay where they are', () => {
    const briefDir = makeTmpBriefDir(['T-0140-01-a.md', 'T-0140-01-b.md']);
    const archive = [
      '## T-0140 · Major · Closed and moved out',
      '- type: feature',
      '- status: done',
      '- created: 2026-01-01 00:00:00',
      '- closed: 2026-01-02 00:00:00',
      '- briefs: T-0140-01',
      '',
    ].join('\n');

    const errors = validateBacklog('# Backlog\n', briefDir, archive);

    assert.strictEqual(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /^T-0140-01: 2 files/);
    assert.match(errors[0], /T-0140-01-a\.md, T-0140-01-b\.md/);
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

  // T-0279. parseBacklog drops a label breaking the rules, so a hand-edited file
  // loses it on the next save without a word; this is what says so first. And
  // deliberately nothing else about labels — the set is implicit, so there is no
  // unknown label to report, and a similarity warning would fire on every
  // genuinely new one.
  describe('labels (T-0279)', () => {
    const withLabels = (value) =>
      [
        '## T-0001 · Major · Labelled task',
        '- type: feature',
        '- status: open',
        '- created: 2026-01-01 00:00:00',
        '- closed: —',
        '- briefs: ',
        `- labels: ${value}`,
        '',
        'Body.',
        '',
      ].join('\n');

    const errorsFor = (value) => validateBacklog(withLabels(value), makeTmpBriefDir([]), '');

    it('says nothing about an ordinary label line', () => {
      assert.deepStrictEqual(errorsFor('ui, docs, release-0.3'), []);
    });

    it('and nothing about a line with no labels on it at all', () => {
      assert.deepStrictEqual(errorsFor(''), []);
    });

    it('no similarity warning: a label close to another is still just a label', () => {
      assert.deepStrictEqual(errorsFor('ui, UI, u i'), []);
    });

    it('reports a stray comma, naming the task and the line', () => {
      const errors = errorsFor('ui,,docs');
      assert.strictEqual(errors.length, 1, errors.join(' | '));
      assert.match(errors[0], /^T-0001: empty label/);
    });

    it('reports a name over the length cap, naming the cap', () => {
      const long = 'y'.repeat(MAX_LABEL_LEN + 1);
      const errors = errorsFor(`ui, ${long}`);
      assert.strictEqual(errors.length, 1, errors.join(' | '));
      assert.match(errors[0], new RegExp(String(MAX_LABEL_LEN)));
      assert.match(errors[0], new RegExp(long));
    });

    it('reports more labels than a task may carry', () => {
      const many = Array.from({ length: MAX_LABELS + 1 }, (_, i) => 'l' + i);
      const errors = errorsFor(many.join(', '));
      assert.strictEqual(errors.length, 1, errors.join(' | '));
      assert.match(errors[0], new RegExp(String(MAX_LABELS)));
    });

    it('a repeat is not an error — it is collapsed, not lost', () => {
      assert.deepStrictEqual(errorsFor('ui, docs, ui'), []);
      // ...and it does not count towards the cap either.
      const atCap = Array.from({ length: MAX_LABELS }, (_, i) => 'l' + i);
      assert.deepStrictEqual(errorsFor(atCap.concat(atCap).join(', ')), []);
    });

    it('the archive is checked by the same rule, and named as the other file', () => {
      // Closed, so the archive's own "only done/cancelled belong here" rule is
      // not what answers — the label line is.
      const archived = withLabels('ui,,docs')
        .replace('- status: open', '- status: done')
        .replace('- closed: —', '- closed: 2026-01-02 00:00:00');
      const errors = validateBacklog('# Backlog\n', makeTmpBriefDir([]), archived);
      assert.strictEqual(errors.length, 1, errors.join(' | '));
      assert.match(errors[0], /^backlog-archive\.md: T-0001: empty label/);
    });
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
  // Skipped in the public tree, and skipped BECAUSE the tree is public (T-0253).
  // The old condition — "doc/backlog.md is absent", "it has no tasks" — was keyed
  // on absence, so an accidental deletion here would have retired this guard
  // quietly instead of failing it. See tests/helpers/public-tree.js for the
  // marker and why it is a positive one.
  it(
    'returns [] for the current doc/backlog.md + doc/brief/ (regression guard)',
    { skip: skipMaintainerData('doc/backlog.md') },
    () => {
      assert.ok(
        fs.existsSync(REAL_BACKLOG_PATH),
        'doc/backlog.md is gone from this checkout, so the guard over it cannot run — restore it, ' +
          'or, if this is a public tree, the marker in tests/helpers/public-tree.js should have skipped this'
      );
      const text = fs.readFileSync(REAL_BACKLOG_PATH, 'utf8');
      assert.ok(parseBacklog(text).length > 0, 'doc/backlog.md parses to no tasks, so this guard would assert nothing');
      // Same shape as `node tools/task.mjs validate`: dependencies are resolved
      // across both files, so a live task may depend on an archived one. This
      // project HAS an archive and it is tracked, so its absence is the same
      // accident as the backlog's and is failed the same way rather than read as
      // an empty string — which would leave every cross-file dependency
      // unresolved and this guard asserting a weaker thing without saying so.
      assert.ok(
        fs.existsSync(REAL_ARCHIVE_PATH),
        `${path.basename(REAL_ARCHIVE_PATH)} is gone: dependencies on archived tasks resolve across ` +
          'both files, so validating without it would silently check less'
      );
      const archiveText = fs.readFileSync(REAL_ARCHIVE_PATH, 'utf8');
      const errors = validateBacklog(text, REAL_BRIEF_DIR, archiveText);
      assert.deepStrictEqual(errors, []);
    }
  );
});
