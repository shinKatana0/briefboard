'use strict';

// Tests for tools/task.mjs -- the CLI agents use to edit doc/backlog.md / doc/brief/.
// summary: the counts an external supervisor acts on.
// Run with: npm test
//
// Each test runs the CLI as a real child process (node tools/task.mjs ...) against a
// throwaway AGENTBOARD_ROOT, so the project doc/backlog.md and doc/brief/ are never
// touched. Assertions check both what the CLI does (stdout, exit code) and the
// resulting doc/backlog.md (via parseBacklog).
//
// One of several files, because one file for the whole CLI reached 651.5s of a 706s
// run here while every test in this suite runs under a 120s bound -- which node 22
// applies to the FILE and node 24 does not, so CI cancelled it and nothing here said
// a word (T-0335). What these files share -- runCli, the throwaway root, the pacing
// hook -- is in tests/helpers/task-cli.js.

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { STATUSES } = require('../server/parser.js');
const {
  runCli,
  add,
  scopedBacklog,
} = require('./helpers/task-cli.js');

describe('task.mjs summary (T-0304)', () => {
  function doc(root, args = []) {
    const res = runCli(root, ['summary', '--json', ...args]);
    assert.strictEqual(res.status, 0, `summary failed: ${res.stderr}`);
    return JSON.parse(res.stdout);
  }

  it('counts every status, and they sum to total — cancelled included', () => {
    const root = scopedBacklog();
    const d = doc(root);
    assert.strictEqual(d.total, 8);
    const sum = STATUSES.reduce((n, s) => n + d[s], 0);
    assert.strictEqual(sum, d.total, `the status counts sum to ${sum}, not to ${d.total}`);
    assert.strictEqual(d.cancelled, 1, 'the cancelled task fell out of the counts');
    assert.strictEqual(d.done, 1);
    assert.strictEqual(d.ready, 4);
    assert.strictEqual(d.in_progress, 1);
  });

  // Taken from STATUSES rather than from seven literals, so a status added to
  // the lifecycle later cannot silently vanish from the document.
  it('carries one key per status in STATUSES, plus the cross-cutting fields', () => {
    const root = scopedBacklog();
    assert.deepStrictEqual(
      Object.keys(doc(root)),
      ['scope', 'total', ...STATUSES, 'blocked', 'runnable', 'complete']
    );
  });

  it('blocked is the same call runnable makes, and crosses the status counts', () => {
    const root = scopedBacklog();
    const d = doc(root);
    // T-0003 (open prerequisite) and T-0006 (an id nobody carries) — both also
    // counted under `ready`, which is not double-counting: the status counts
    // alone sum to total, and this is a fact about them.
    assert.strictEqual(d.blocked, 2);
    const blockedByList = JSON.parse(runCli(root, ['list', '--json']).stdout).tasks.filter(
      (t) => t.blockedBy.length > 0
    );
    assert.deepStrictEqual(blockedByList.map((t) => t.id), ['T-0003', 'T-0006']);
    assert.strictEqual(d.blocked, blockedByList.length, 'summary and list disagree about what is blocked');
  });

  it('runnable is the ids runnable prints, in the backlog order', () => {
    const root = scopedBacklog();
    const fromCommand = JSON.parse(runCli(root, ['runnable', '--json']).stdout).tasks.map((t) => t.id);
    assert.deepStrictEqual(doc(root).runnable, fromCommand);
    assert.deepStrictEqual(doc(root).runnable, ['T-0001', 'T-0004']);
  });

  // The shape changed in T-0310 (a flat list could not tell an AND query from an
  // OR one); what this test holds is T-0304's own claim, that the document says
  // what it was an answer to. The distinction itself is tested in that block.
  it('scope echoes the query the answer belongs to', () => {
    const root = scopedBacklog();
    assert.deepStrictEqual(doc(root).scope, { labels: [], labelQuery: 'every task' });
    assert.deepStrictEqual(doc(root, ['--label', 'p']).scope, { labels: [['p']], labelQuery: 'p' });
  });

  // The decision that looks like a bug until you have thought about a typo'd
  // label: vacuous truth would let `--label phase4` read as "phase 4 is done".
  it('an empty scope is total 0 and NOT complete', () => {
    const root = scopedBacklog();
    const d = doc(root, ['--label', 'nobody-carries-this']);
    assert.strictEqual(d.total, 0);
    assert.strictEqual(d.complete, false, 'an empty scope was reported as a finished one');
    assert.strictEqual(STATUSES.reduce((n, s) => n + d[s], 0), 0);
  });

  it('a scope whose tasks are all done or cancelled is complete', () => {
    const root = scopedBacklog();
    assert.strictEqual(runCli(root, ['labels', 'T-0007', 'closed-scope']).status, 0);
    assert.strictEqual(doc(root, ['--label', 'closed-scope']).complete, true);
    assert.strictEqual(runCli(root, ['labels', 'T-0005', 'closed-scope']).status, 0);
    const both = doc(root, ['--label', 'closed-scope']);
    assert.strictEqual(both.total, 2);
    assert.strictEqual(both.complete, true, 'a cancelled task is closed and does not hold a scope open');
    // One task that is not closed is enough to take it back.
    assert.strictEqual(runCli(root, ['labels', 'T-0001', 'closed-scope']).status, 0);
    assert.strictEqual(doc(root, ['--label', 'closed-scope']).complete, false);
  });

  it('refuses --status with the usage line and a non-zero exit', () => {
    const root = scopedBacklog();
    const res = runCli(root, ['summary', '--status', 'ready']);
    assert.strictEqual(res.status, 1, `summary accepted --status: ${res.stdout}`);
    assert.match(res.stderr, /ERROR: summary has no flag --status/);
    assert.match(res.stderr, /usage: node tools\/task\.mjs summary/);
    assert.strictEqual(res.stdout, '', 'a refused summary printed a document anyway');
  });

  // T-0304 had --all decide whether the archive was in scope here, and printed
  // the archived-tasks note when it was not. T-0310 took the flag away and made
  // the archive unconditional: a finished scope was printing the document a
  // mistyped label prints. The counting rules above are untouched by that; the
  // archive half lives in the T-0310 block below.
});
