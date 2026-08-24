'use strict';

// Tests for tools/task.mjs -- the CLI agents use to edit doc/backlog.md / doc/brief/.
// runnable, and the promise that it and summary only ever read.
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
const fs = require('node:fs');
const {
  runCli,
  makeTmpRoot,
  backlogPath,
  scopedBacklog,
} = require('./helpers/task-cli.js');

describe('task.mjs runnable (T-0304)', () => {
  function ids(res) {
    assert.strictEqual(res.status, 0, `runnable failed: ${res.stderr}`);
    const text = res.stdout.trim();
    return text === '' ? [] : text.split(/\r?\n/).map((line) => line.slice(0, 6));
  }

  // The four cases of the acceptance criteria in one assertion, which is also
  // what makes it a test of blockingDependencies() and not of a list of ids: the
  // two that are IN are in for different reasons, and so are the two that are out.
  it('is the ready tasks with no unsatisfied prerequisite, and nothing else', () => {
    const root = scopedBacklog();
    assert.deepStrictEqual(ids(runCli(root, ['runnable'])), ['T-0001', 'T-0004']);
  });

  it('the backlog really does hold the tasks it leaves out, so the answer is a filter', () => {
    const root = scopedBacklog();
    const ready = JSON.parse(runCli(root, ['list', '--json', '--status', 'ready']).stdout);
    assert.deepStrictEqual(
      ready.tasks.map((t) => t.id),
      ['T-0001', 'T-0003', 'T-0004', 'T-0006'],
      'the fixture does not contain the blocked ready tasks the filter must remove'
    );
  });

  it('--json is list --json\'s own document, not a second task shape', () => {
    const root = scopedBacklog();
    const doc = JSON.parse(runCli(root, ['runnable', '--json']).stdout);
    assert.deepStrictEqual(Object.keys(doc).sort(), ['count', 'tasks']);
    assert.strictEqual(doc.count, 2);
    assert.deepStrictEqual(doc.tasks.map((t) => t.id), ['T-0001', 'T-0004']);
    const listed = JSON.parse(runCli(root, ['list', '--json', '--status', 'ready']).stdout);
    const same = listed.tasks.find((t) => t.id === 'T-0001');
    assert.deepStrictEqual(doc.tasks[0], same, 'runnable and list describe the same task differently');
  });

  // T-0004 is runnable only because a CANCELLED prerequisite counts as closed;
  // asserting blockedBy is empty is asserting that rule and not the status.
  it('a cancelled prerequisite is satisfied, and blockedBy says so', () => {
    const root = scopedBacklog();
    const doc = JSON.parse(runCli(root, ['runnable', '--json']).stdout);
    const t4 = doc.tasks.find((t) => t.id === 'T-0004');
    assert.deepStrictEqual(t4.depends, ['T-0005']);
    assert.deepStrictEqual(t4.blockedBy, []);
  });

  it('--status narrows and cannot widen: a non-ready status is an empty answer, not an error', () => {
    const root = scopedBacklog();
    const res = runCli(root, ['runnable', '--status', 'review']);
    assert.strictEqual(res.status, 0, `--status review was refused: ${res.stderr}`);
    assert.deepStrictEqual(ids(res), []);
    assert.deepStrictEqual(ids(runCli(root, ['runnable', '--status', 'ready'])), ['T-0001', 'T-0004']);
    // in_progress exists in this backlog (T-0008) and is still not runnable.
    assert.deepStrictEqual(ids(runCli(root, ['runnable', '--status', 'in_progress'])), []);
  });

  it('--label narrows the scope the same way it narrows list', () => {
    const root = scopedBacklog();
    assert.strictEqual(runCli(root, ['labels', 'T-0001', 'p,q']).status, 0);
    assert.deepStrictEqual(ids(runCli(root, ['runnable', '--label', 'q'])), ['T-0001']);
    assert.deepStrictEqual(ids(runCli(root, ['runnable', '--label', 'nobody-carries-this'])), []);
  });
});

describe('task.mjs runnable/summary are queries and nothing else (T-0304)', () => {
  const CALLS = [
    ['runnable'],
    ['runnable', '--json'],
    ['runnable', '--label', 'p'],
    ['runnable', '--status', 'ready'],
    ['summary'],
    ['summary', '--json'],
    ['summary', '--json', '--label', 'p'],
    // Was ['summary', '--all'] until T-0310 refused the flag; a repeated --label
    // keeps a two-set query in the determinism check, which is what the entry
    // was here for.
    ['summary', '--json', '--label', 'p', '--label', 'q'],
  ];

  it('leaves doc/backlog.md byte-identical', () => {
    const root = scopedBacklog();
    const before = fs.readFileSync(backlogPath(root), 'utf8');
    for (const args of CALLS) {
      assert.strictEqual(runCli(root, args).status, 0, `${args.join(' ')}: refused`);
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, `${args.join(' ')} wrote`);
    }
  });

  // Compared on the bytes, not on the parse: a document whose keys reorder
  // between runs parses the same and is not a stable contract.
  it('--json answers the same bytes on two runs over the same backlog', () => {
    const root = scopedBacklog();
    for (const args of CALLS.filter((a) => a.includes('--json'))) {
      const first = runCli(root, args);
      const second = runCli(root, args);
      assert.strictEqual(first.status, 0, first.stderr);
      assert.strictEqual(first.stdout, second.stdout, `${args.join(' ')} is not deterministic`);
      JSON.parse(first.stdout); // one document, nothing else on stdout
    }
  });

  it('both are listed among the commands', () => {
    const help = runCli(makeTmpRoot(), ['help']).stdout;
    assert.match(help, /\brunnable\b/);
    assert.match(help, /\bsummary\b/);
  });
});
