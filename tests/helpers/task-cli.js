'use strict';

// What every test file for tools/task.mjs shares: a way to run the CLI against
// a throwaway AGENTBOARD_ROOT, and the pacing hook such a file needs.
//
// There is more than one such file because there used to be one and it outgrew
// the bound every test in this suite runs under (T-0335). `--test-timeout`
// bounds a TEST, and node's runner makes each FILE a test of its own — so a
// file over the bound is cancelled on the Node that applies it to that entry
// (CI's 22) and sails through on the one that does not (v24.18.0 here). These
// helpers live here rather than in one of those files so that the split cannot
// turn one home into two that drift.

const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseBacklog } = require('../../server/parser.js');
const { tempDir } = require('./tmp.js');

const CLI_PATH = path.join(__dirname, '..', '..', 'tools', 'task.mjs');

/** Run `node tools/task.mjs <args>` against an isolated AGENTBOARD_ROOT. Never throws. */
function runCli(root, args, input) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, AGENTBOARD_ROOT: root },
    encoding: 'utf8',
    input,
  });
}

function makeTmpRoot() {
  return tempDir('briefboard-cli-test-');
}

function backlogPath(root) {
  return path.join(root, 'doc', 'backlog.md');
}

function briefDir(root) {
  return path.join(root, 'doc', 'brief');
}

function archivePath(root) {
  return path.join(root, 'doc', 'backlog-archive.md');
}

/** Read + parse doc/backlog.md for the given tmp root; [] if the file was never created. */
function readTasks(root) {
  const p = backlogPath(root);
  if (!fs.existsSync(p)) return [];
  return parseBacklog(fs.readFileSync(p, 'utf8'));
}

function add(root, args, input) {
  const res = runCli(root, ['add', ...args], input);
  assert.strictEqual(res.status, 0, `add failed: ${res.stderr}`);
  return res.stdout.trim(); // the printed id, e.g. "T-0001"
}

function addBrief(root, id, slug) {
  const res = runCli(root, ['brief', id, slug]);
  assert.strictEqual(res.status, 0, `brief failed: ${res.stderr}`);
  return res.stdout.trim(); // the printed file path
}

// One turn of the event loop before every test, and that is all it does
// (T-0311). Every test that drives the CLI with spawnSync leaves the loop
// unturned for the length of an uninterrupted stretch of them — and node:test
// reports a file's results from that file's own process, which cannot print a
// mark it cannot reach. What such a stretch spends is not the file's own time
// but the SILENCE budget shared with every other file in tools/test-run.mjs,
// and that budget is the only thing catching a test which holds the event loop
// open after its own end (T-0272-02), so it may not be raised to make room.
//
// Measured 2026-08-23 (Windows 11, node v24.18.0, 24 cores) on four blocking
// 2.2s tests: with no hook all four marks appear together at 9.1s, with this
// one at 2.5s / 4.7s / 6.9s / 9.2s, and the file costs the same 9.2s either
// way — the loop turn is not a delay, it is the file reporting as it goes.
// Across the whole suite, quiet, the longest stretch with nothing printed was
// 176.6s before this hook and 8.1s after it, while the run itself took 383s and
// 387s — the same run, reporting as it goes (CONTRIBUTING.md, `--timing-dir`).
// What is left is bounded by the slowest single test and no longer by a whole
// describe, which is the only bound a file of blocking tests can have.
//
// Registered here, when this module is required, rather than written out in
// every file that needs it — the same shape as helpers/tmp.js's `after()`. Two
// copies of a measured explanation drift, and the explanation is the whole
// value: without it the hook reads like a delay somebody could delete.
//
// Nothing here asserts a duration: a test that fails when the machine is busy
// is the class of test T-0270/T-0271/T-0272 spent a night removing.
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

// Read by task-cli-runnable, task-cli-summary and task-cli-query: the one
// fixture in these tests with more than one file behind it, and the reason it
// is here rather than in whichever file happened to keep it.
// T-0304. `runnable` and `summary` are queries an external supervisor acts on,
// so what they must not do is as important as what they do: never write, never
// answer differently on two identical runs, and never carry a second definition
// of "may this task be started" — that one lives in blockingDependencies() and
// serves the board, the drag of T-0084 and the CLI's own ready -> in_progress
// guard already.
//
// The fixture covers every branch of that function in one backlog, so a change
// to it lands in these tests rather than in a supervisor's report.
function scopedBacklog() {
  const root = makeTmpRoot();
  const titles = [
    'Ready with no prerequisite', // T-0001 runnable
    'An open prerequisite', // T-0002 open, blocks T-0003
    'Ready behind an open one', // T-0003 blocked
    'Ready behind a cancelled one', // T-0004 runnable: cancelled is closed
    'Cancelled prerequisite', // T-0005 cancelled
    'Ready behind an id nobody carries', // T-0006 blocked
    'Already finished', // T-0007 done
    'In flight', // T-0008 in_progress
  ];
  for (const title of titles) add(root, ['--type', 'feature', '--priority', 'Major', '--title', title, '--labels', 'p']);
  for (const id of ['T-0001', 'T-0003', 'T-0004', 'T-0006', 'T-0007', 'T-0008']) {
    assert.strictEqual(runCli(root, ['status', id, 'open']).status, 0);
    addBrief(root, id, 'slug');
    assert.strictEqual(runCli(root, ['status', id, 'ready']).status, 0);
  }
  assert.strictEqual(runCli(root, ['status', 'T-0002', 'open']).status, 0);
  assert.strictEqual(runCli(root, ['status', 'T-0005', 'cancelled']).status, 0);
  assert.strictEqual(runCli(root, ['depends', 'T-0003', 'T-0002']).status, 0);
  assert.strictEqual(runCli(root, ['depends', 'T-0004', 'T-0005']).status, 0);
  assert.strictEqual(runCli(root, ['depends', 'T-0006', 'T-0007']).status, 0);
  for (const to of ['in_progress', 'review', 'done']) {
    assert.strictEqual(runCli(root, ['status', 'T-0007', to]).status, 0);
  }
  assert.strictEqual(runCli(root, ['status', 'T-0008', 'in_progress']).status, 0);
  // `depends` refuses an id no task carries, so T-0006's ghost prerequisite is
  // written by hand — which is the only way one gets into a backlog, and exactly
  // the case blockingDependencies() calls blocking because an unresolvable
  // prerequisite cannot be shown to be finished.
  const file = backlogPath(root);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('- depends: T-0007'), 'the fixture no longer has the line it rewrites');
  fs.writeFileSync(file, text.replace('- depends: T-0007', '- depends: T-0099'));
  return root;
}

module.exports = {
  CLI_PATH,
  runCli,
  makeTmpRoot,
  backlogPath,
  briefDir,
  archivePath,
  readTasks,
  add,
  addBrief,
  scopedBacklog,
};
