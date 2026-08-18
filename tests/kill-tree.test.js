'use strict';

// T-0155: stopping a session has to stop the work, not the launcher that started
// it. The command a board really spawns is `cmd /c claude ...` or `npm ci`, so
// the process that writes into the worktree is a child of the process we hold —
// and a signal to one pid never reaches it.
//
// T-0173 is the other half of the same fact: whatever the board fails to kill
// still holds the session's stdout, so the log — and the promise shutdown()
// returns — stays open for as long as THAT process lives.
//
// Every test here therefore runs a REAL two-level tree: a shell that starts a
// node "worker" which keeps appending to a file. Nothing here runs an agent, and
// the worker exits by itself in the end whatever the test does with it, because
// a spawned process that outlives its test is how a suite hangs forever.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  killChild,
  killHard,
  isProcessAlive,
  createSessionRunner,
  SHUTDOWN_RELEASE_MS,
} = require('../server/sessions.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor: waitForCondition } = require('./helpers/wait.js');
const { removeTree } = require('./helpers/rm.js');
const { tempDir } = require('./helpers/tmp.js');

const WIN = process.platform === 'win32';
// What the product does on this platform, mirrored so the trees these tests kill
// are shaped exactly like a session's.
const DETACHED = !WIN;
// T-0182. These two numbers are the whole honesty of this file, and they used to
// be 20s and 15s — one starved run away from being swapped, and one config
// change away from a tautology: with a death deadline ABOVE the worker's own
// lifetime, "the worker is gone" is true whether the kill worked or not, and the
// file stops testing anything. So:
//   - the deadline is the suite's one measured budget for waiting on a spawned
//     process (tests/helpers/wait.js), not a number of this file's own;
//   - the lifetime is far above the per-test backstop, so a test can be killed
//     by the runner long before the fixture can die of old age inside it (the
//     assertion below ties the two together);
//   - and the worker announces its own old-age exit in the work file, so even if
//     both numbers were wrong, a natural death cannot be counted as a kill
//     (waitForKilled).
const WORKER_LIFETIME_MS = 300000;
const DEATH_TIMEOUT_MS = SPAWN_WAIT_BUDGET_MS;
// Appended by the worker just before it exits of its own accord. Nothing else
// writes it, and a killed process never reaches it.
const SELF_EXIT_MARK = 'self-exit';
// Long enough for a surviving worker to have appended several times: the "it is
// still alive" assertions are only worth as much as the time they gave it to
// die.
const SETTLE_MS = 1500;

// The per-test backstop of `npm test`, read from the script that passes it so
// the two cannot drift apart silently (tools/test-run.mjs).
function perTestBackstopMs() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'test-run.mjs'), 'utf8');
  const found = /BRIEFBOARD_TEST_TIMEOUT_MS\s*\|\|\s*'(\d+)'/.exec(src);
  assert.ok(found, 'tools/test-run.mjs no longer states a default --test-timeout');
  return Number(found[1]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The suite's one wait (tests/helpers/wait.js), in this file's argument order.
function waitFor(predicate, what, timeoutMs = DEATH_TIMEOUT_MS) {
  return waitForCondition(predicate, timeoutMs, what);
}

let fixtures;
let workerScript;
let escapeScript;
let seq = 0;

before(() => {
  fixtures = tempDir('briefboard-kill-tree-');
  workerScript = path.join(fixtures, 'worker.js');
  fs.writeFileSync(
    workerScript,
    [
      "'use strict';",
      "const fs = require('fs');",
      'const [, , pidFile, workFile] = process.argv;',
      "fs.writeFileSync(workFile, 'start\\n');",
      'fs.writeFileSync(pidFile + \'.tmp\', String(process.pid));',
      "fs.renameSync(pidFile + '.tmp', pidFile);",
      "setInterval(() => fs.appendFileSync(workFile, 'tick\\n'), 100);",
      'setTimeout(() => {',
      `  fs.appendFileSync(workFile, '${SELF_EXIT_MARK}\\n');`,
      '  process.exit(0);',
      `}, ${WORKER_LIFETIME_MS});`,
      '',
    ].join('\n')
  );
  // Starts the worker so that it OUTLIVES the whole launcher and cannot be found
  // from it: detached, unreferenced, and — the part that matters — inheriting the
  // stdout it was given, which is the session's log pipe. That is the shape
  // T-0173 describes, and the shape a kill the OS refuses leaves behind.
  escapeScript = path.join(fixtures, 'escape.js');
  fs.writeFileSync(
    escapeScript,
    [
      "'use strict';",
      "const { spawn } = require('child_process');",
      'const [, , worker, pidFile, workFile] = process.argv;',
      'spawn(process.execPath, [worker, pidFile, workFile], {',
      "  stdio: 'inherit',",
      '  detached: true,',
      '  windowsHide: true,',
      '}).unref();',
      '',
    ].join('\n')
  );
});

// Every directory here is removed through the shared bounded remover: this file
// leaves processes whose cwd is a directory it is about to delete, and Windows
// hands that cwd back a measurable moment after the process is gone
// (tests/helpers/rm.js has the measurement and what it cost — T-0195).
after(() => removeTree(fixtures));

// The launcher: a shell, because that is what a session command is. A node
// launcher would hide the bug — libuv puts every non-detached child of a node
// process into a job object that dies with it, so on Windows its children would
// go down with it and nothing would need fixing.
function launcher(pidFile, workFile) {
  if (WIN) return ['cmd', ['/c', process.execPath, workerScript, pidFile, workFile]];
  return [
    '/bin/sh',
    ['-c', `'${process.execPath}' '${workerScript}' '${pidFile}' '${workFile}' & wait`],
  ];
}

// The same launcher, except that it does not wait: it starts the escapee and
// exits, so the session's own process is gone while the work it started is not.
function escapingLauncher(pidFile, workFile) {
  const argv = [process.execPath, escapeScript, workerScript, pidFile, workFile];
  if (WIN) return ['cmd', ['/c', ...argv]];
  return ['/bin/sh', ['-c', argv.map((arg) => `'${arg}'`).join(' ')]];
}

// The same template, for the runner: quotes group, so a path with a space
// survives the argv split.
function asTemplate([file, args]) {
  return [file, ...args].map((arg) => `"${arg}"`).join(' ');
}

const trees = [];

// Every tree this file starts, written down when its paths are made rather than
// when its pid has been read (T-0258).
//
// Measured, reproducing the escaping-launcher test's shape and stopping where a
// timed-out test stops: the escaped worker's cwd IS the project directory, and
// while it lives the directory answers EPERM to every attempt — 321 of them over
// 10s — while the same directory with the worker killed first went in 2ms at the
// first attempt. Killing it then made the very next attempt succeed, 32ms later.
// So no teardown budget is the answer: the worker lives 300s, and until it dies
// the removal cannot succeed at any budget.
//
// It is reaped from here because the test body cannot be trusted to reach its
// own cleanup. Under four concurrent suites that wait timed out in every suite,
// and the escaped worker is by construction the one thing nothing else can find:
// it is detached and unreferenced, its launcher is already gone, so
// `runner.shutdown()` has no tree to walk and its `taskkill /t` reaches nothing.
const spawned = [];

function treePaths() {
  const id = `tree-${++seq}`;
  const paths = {
    pidFile: path.join(fixtures, id + '.pid'),
    workFile: path.join(fixtures, id + '.work'),
  };
  spawned.push(paths);
  return paths;
}

// The pid file is the only channel that survives a test which never got to read
// it: the worker writes it as its first act, and a test that timed out waiting
// for it usually finds it there a moment later. Missing, it is waited for on the
// suite's one measured allowance for a spawned process (tests/helpers/wait.js) —
// a worker that starts after the teardown holds the directory just the same, and
// one that never starts holds nothing, which is what the timeout here means.
async function reapSpawned() {
  for (const { pidFile } of spawned.splice(0)) {
    let pid = readWorkerPid(pidFile);
    if (!pid) {
      try {
        pid = await waitFor(() => readWorkerPid(pidFile), 'a started worker to report its pid');
      } catch {
        continue;
      }
    }
    hardKill(pid);
    await waitGone(pid);
  }
}

function readWorkerPid(pidFile) {
  const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : NaN);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function ticks(workFile) {
  return fs.existsSync(workFile) ? fs.readFileSync(workFile, 'utf8').split('\n').length : 0;
}

function selfExited(workFile) {
  return fs.existsSync(workFile) && fs.readFileSync(workFile, 'utf8').includes(SELF_EXIT_MARK);
}

// "The worker died" is only evidence about the kill if the worker did not die of
// its own accord, and the worker says which it was. Every wait for a killed
// worker goes through here (T-0182).
async function waitForKilled({ workerPid, workFile }, what) {
  await waitFor(() => !isProcessAlive(workerPid), what);
  assert.equal(
    selfExited(workFile),
    false,
    `${what}: the worker exited of old age, so its death says nothing about the kill`
  );
}

// Starts the tree and waits until the worker — the grandchild — has announced
// itself, so every assertion below is about a process that certainly ran.
async function startTree({ detached = DETACHED } = {}) {
  const { pidFile, workFile } = treePaths();
  const [file, args] = launcher(pidFile, workFile);
  const child = spawn(file, args, { stdio: 'ignore', shell: false, detached, windowsHide: true });
  const tree = { child, pidFile, workFile, workerPid: 0 };
  trees.push(tree);
  await waitFor(() => readWorkerPid(pidFile) > 0, 'the worker to report its pid');
  tree.workerPid = readWorkerPid(pidFile);
  return tree;
}

function hardKill(pid) {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    if (WIN) spawn('taskkill', ['/pid', String(pid), '/f'], { stdio: 'ignore' }).unref();
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

// Awaited, not fired and forgotten: the fixture worker now outlives any test, so
// nothing but this kill ends it, and on Windows a process still running keeps
// the work file it appends to undeletable — which is how after() below used to
// die with ENOTEMPTY. A pid that will not go is left to the OS rather than
// failing a test that already passed.
async function waitGone(pid) {
  if (!pid) return;
  const deadline = Date.now() + DEATH_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(pid)) await sleep(50);
}

afterEach(async () => {
  const pids = [];
  for (const tree of trees.splice(0)) {
    hardKill(tree.workerPid);
    hardKill(tree.child.pid);
    pids.push(tree.workerPid, tree.child.pid);
  }
  await Promise.all(pids.map(waitGone));
  // After the trees the tests registered, and before the projects afterEach
  // below removes the directories those workers are standing in.
  await reapSpawned();
});

describe('killChild ends the whole process tree (T-0155)', () => {
  // The one assertion here that is not about the product: it is about whether the
  // rest of this file can fail at all. A fixture that can die of old age inside a
  // test makes every "the worker is gone" below true for free (T-0182).
  it('the fixture cannot die of old age inside a test, so a death here means a kill', () => {
    const backstop = perTestBackstopMs();
    assert.ok(
      WORKER_LIFETIME_MS > backstop,
      `the worker lives ${WORKER_LIFETIME_MS}ms and a test is killed at ${backstop}ms: ` +
        'a self-exit could happen while a test is still waiting for it'
    );
    assert.ok(
      DEATH_TIMEOUT_MS < WORKER_LIFETIME_MS,
      `waiting ${DEATH_TIMEOUT_MS}ms for a worker that lives ${WORKER_LIFETIME_MS}ms`
    );
    assert.match(fs.readFileSync(workerScript, 'utf8'), new RegExp(SELF_EXIT_MARK));
  });

  it('the launcher is not the process doing the work: killing it alone leaves the worker running', async () => {
    const tree = await startTree({ detached: false });
    const before = ticks(tree.workFile);

    tree.child.kill(); // exactly what killChild did before T-0155

    await waitFor(() => !isProcessAlive(tree.child.pid), 'the launcher to exit');
    await sleep(SETTLE_MS);
    assert.equal(isProcessAlive(tree.workerPid), true, 'the worker outlived its launcher');
    assert.ok(ticks(tree.workFile) > before, 'and went on writing after the launcher was killed');
  });

  it('killChild takes the worker with the launcher', async () => {
    const tree = await startTree();

    killChild(tree.child);

    await waitForKilled(tree, 'the worker to die with its launcher');
    await waitFor(() => !isProcessAlive(tree.child.pid), 'the launcher to die');
    const settled = ticks(tree.workFile);
    await sleep(SETTLE_MS);
    assert.equal(ticks(tree.workFile), settled, 'the worker stopped writing');
  });

  it('is silent when the process is already gone, and repeating it changes nothing', async () => {
    const tree = await startTree();

    killChild(tree.child);
    killChild(tree.child);
    await waitForKilled(tree, 'the worker to die');
    await waitFor(() => tree.child.exitCode !== null || tree.child.signalCode !== null, 'exit');
    killChild(tree.child);
    killChild(null);
    killChild({});

    assert.equal(isProcessAlive(tree.workerPid), false);
  });

  it('falls back to the single process when the tree killer is not on the machine', async () => {
    const tree = await startTree({ detached: false });

    killChild(tree.child, { platform: 'win32', killer: 'briefboard-no-such-tree-killer' });

    await waitFor(() => !isProcessAlive(tree.child.pid), 'the launcher to be killed anyway');
  });

  it('falls back to the single process when there is no process group to signal', async () => {
    const tree = await startTree({ detached: false });

    killChild(tree.child, { platform: 'linux' });

    await waitFor(() => !isProcessAlive(tree.child.pid), 'the launcher to be killed anyway');
  });
});

describe('killHard is the escalation when the first kill did not take (T-0173)', () => {
  it('ends the tree', async () => {
    const tree = await startTree();

    killHard(tree.child);

    await waitFor(() => !isProcessAlive(tree.child.pid), 'the launcher to be killed');
  });

  // T-0192: the escalation must not destroy the path the first kill walks. On
  // Windows killChild orders a DETACHED `taskkill /t /f` that finds the tree by
  // parent pid whenever it gets to run, so an escalation that terminates the
  // launcher before that walk leaves the worker with no parent to be found from
  // — measured idle: it outlived the pair by 23.8s, and only the probe's own
  // clock ended it. No pause between the two calls, because that is the case: on
  // a loaded machine the grace runs out before the killer has started.
  it('does not orphan the tree by arriving before the first kill has walked it', async () => {
    const tree = await startTree();

    killChild(tree.child);
    killHard(tree.child);

    await waitForKilled(tree, 'the worker to die despite the escalation');
  });

  it('falls back to the single process when there is no process group to signal', async () => {
    const tree = await startTree({ detached: false });

    killHard(tree.child, { platform: 'linux' });

    await waitFor(() => !isProcessAlive(tree.child.pid), 'the launcher to be killed anyway');
  });

  it('is silent when the process is already gone', async () => {
    const tree = await startTree();

    killChild(tree.child);
    await waitFor(() => tree.child.exitCode !== null || tree.child.signalCode !== null, 'exit');
    killHard(tree.child);
    killHard(null);
    killHard({});
  });
});

const projects = [];
const runners = [];

function makeRunner(command) {
  const project = tempDir('briefboard-kill-tree-project-');
  projects.push(project);
  const runner = createSessionRunner({
    project,
    command,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  runners.push(runner);
  return runner;
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()));
  while (projects.length) await removeTree(projects.pop());
});

describe('a stopped session stops the work it started (T-0155)', () => {
  it('stopSession kills the agent the session command launched', async () => {
    const { pidFile, workFile } = treePaths();
    const runner = makeRunner(asTemplate(launcher(pidFile, workFile)));
    const started = await runner.startSession('T-0001');
    assert.equal(started.started, true);
    await waitFor(() => readWorkerPid(pidFile) > 0, 'the worker to report its pid');
    const workerPid = readWorkerPid(pidFile);
    trees.push({ child: { pid: started.pid }, workerPid });

    assert.deepStrictEqual(runner.stopSession('T-0001'), { stopped: true });

    await waitForKilled({ workerPid, workFile }, 'the worker to die with its session');
    await waitFor(() => runner.get('T-0001').status === 'exited', 'the session record to close');
    const settled = ticks(workFile);
    await sleep(SETTLE_MS);
    assert.equal(ticks(workFile), settled, 'the worker stopped writing into the worktree');
  });

  it('shutdown kills it too — no agent outlives the board', async () => {
    const { pidFile, workFile } = treePaths();
    const runner = makeRunner(asTemplate(launcher(pidFile, workFile)));
    const started = await runner.startSession('T-0002');
    assert.equal(started.started, true);
    await waitFor(() => readWorkerPid(pidFile) > 0, 'the worker to report its pid');
    const workerPid = readWorkerPid(pidFile);
    trees.push({ child: { pid: started.pid }, workerPid });

    // Not awaited before the check on purpose: the orphan inherits the session's
    // stdout, so the log — and with it shutdown()'s promise — stays open until it
    // dies of its own accord, and awaiting first would let a board that killed
    // only the launcher pass.
    const closed = runner.shutdown();
    await waitForKilled({ workerPid, workFile }, 'the worker to die with the board');
    await closed;
  });
});

// The measurement T-0173 was filed on: `await runner.shutdown()` returned only
// when the escaped worker reached its own self-exit, because the worker had
// inherited the session's stdout and the log could not close while it held it.
//
// This is the one assertion in the suite that CANNOT be turned into a condition
// the way T-0138, T-0180 and T-0182 turned theirs: the property under test is a
// deadline, and there is no state to wait for instead. So the threshold has to
// carry the machine as well as the board, and it is built from both:
//
//   the board's part — SHUTDOWN_RELEASE_MS, what the product promises to wait;
//     measured under four concurrent suites, that is the whole of it: 8 replays
//     of this scenario waited 5008-5021 ms against a 5000 ms bound;
//   the machine's part — SPAWN_WAIT_BUDGET_MS, the suite's one measured
//     allowance for a loaded machine (tests/helpers/wait.js: p99 11.3 s, max
//     15.7 s under four concurrent suites).
//
// Twice the bound used to be the whole margin, which left 5 s for a stall a
// third that size — so the test failed under load with two other workers on this
// machine (T-0205: 5902 ms alone, over the bound loaded), and the failure said
// nothing about the board.
//
// Said out loud, because it narrows the test: this no longer separates a 5 s
// bound from a 20 s one. It separates a bounded wait from one that waits out the
// process it could not kill — 35 s against the worker's 300 s lifetime, which is
// the regression T-0173 was filed on. The line above it, that the worker is
// still alive when shutdown() returns, is the ordering half of the same claim
// and does not depend on the scheduler at all.
const SHUTDOWN_BOUND_MS = SHUTDOWN_RELEASE_MS + SPAWN_WAIT_BUDGET_MS;

describe('shutdown() does not wait out a process it could not kill (T-0173)', () => {
  it('resolves within its bound while the escaped worker is still running', async () => {
    const { pidFile, workFile } = treePaths();
    const runner = makeRunner(asTemplate(escapingLauncher(pidFile, workFile)));
    const started = await runner.startSession('T-0003');
    assert.equal(started.started, true);
    await waitFor(() => readWorkerPid(pidFile) > 0, 'the worker to report its pid');
    const workerPid = readWorkerPid(pidFile);
    trees.push({ child: { pid: started.pid }, workerPid });
    // The launcher is gone and the worker is not: nothing the board holds leads
    // to the worker any more, which is the situation the bound exists for.
    await waitFor(() => runner.get('T-0003').status === 'exited', 'the launcher to exit');

    const at = Date.now();
    await runner.shutdown();
    const waited = Date.now() - at;

    assert.equal(isProcessAlive(workerPid), true, 'the worker outlived the wait, as it must here');
    assert.ok(
      waited < SHUTDOWN_BOUND_MS,
      `shutdown() waited ${waited}ms; the bound is ${SHUTDOWN_RELEASE_MS}ms plus ` +
        `${SPAWN_WAIT_BUDGET_MS}ms for a loaded machine, and the escaped worker lives ` +
        `${WORKER_LIFETIME_MS}ms — an unbounded wait ends with the worker, not the board`
    );
    // What used to stand here was `fs.rmSync(started.logPath)`, offered as proof
    // that the board had let go of the log. It proved nothing twice over (T-0201).
    // Measured: libuv opens files with FILE_SHARE_DELETE, so unlink succeeds with
    // our own write stream or fd still open — the file merely goes to
    // pending-delete. The line therefore passed whether or not shutdown() had
    // released anything. And the property it was reaching for is already carried
    // by the `await` two lines above: shutdown()'s promise IS
    // Promise.all(openLogs → entry.closed), and each of those resolves on the
    // write stream's own 'close'. A resolved shutdown() cannot coexist with a log
    // this board still holds, so there was no assertion left to make.

    // The escaped worker is reaped by the shared teardown and not here (T-0258).
    // It used to be killed on these last two lines, which every assertion above
    // stands between: under load this test failed at the pid wait, the lines
    // never ran, and the project directory this worker stands in stayed EPERM
    // past 60s in four suites of four. What kills it now runs whether the body
    // got here or not.
  });

  // The same escapee, with the cleanup's own channel cut: nothing is registered
  // in `trees`, which is the state a test that timed out at the pid wait leaves
  // behind. Then the teardown is called here, in the open, so that the thing
  // which used to depend on reaching the end of a test body can be failed.
  it('is reaped by the teardown even when no test registered it (T-0258)', async () => {
    const { pidFile, workFile } = treePaths();
    const runner = makeRunner(asTemplate(escapingLauncher(pidFile, workFile)));
    const project = projects.at(-1);
    const started = await runner.startSession('T-0004');
    assert.equal(started.started, true);
    await waitFor(() => readWorkerPid(pidFile) > 0, 'the worker to report its pid');
    const workerPid = readWorkerPid(pidFile);
    await runner.shutdown();
    // The premise, and the reason a budget cannot be the answer: the board has
    // let go and the escapee is still there, with 300s of life left in it.
    assert.equal(isProcessAlive(workerPid), true, 'the escapee outlives the board, as it must here');

    await reapSpawned();

    assert.equal(isProcessAlive(workerPid), false, 'the teardown reaps it without being told the pid');
    assert.equal(selfExited(workFile), false, 'and that is the reaping, not old age (T-0182)');
    // What the reaping is for: the escapee's cwd is this directory, and measured
    // here, a live cwd is what no removal budget can outwait — EPERM at every
    // one of 321 attempts over 10s, then gone 32ms after the worker was killed.
    await removeTree(project, { budgetMs: 5000 });
  });
});
