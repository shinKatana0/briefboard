'use strict';

// T-0193: a board that dies without shutdown() cannot take its agents with it.
// The job object libuv puts a session in reaches the launcher and nothing under
// it, so a board killed hard leaves the process doing the work running — measured
// on Windows 11 with `cmd /c node worker.js`, the shape a session really has:
// the launcher was dead and the worker alive and still appending five seconds
// later.
//
// What the board can do is clean up at the NEXT start: write the tree down while
// the session runs, and end what is still there when it comes back. So the tests
// here run a REAL two-level tree and a REAL process table — an injected one would
// prove the bookkeeping and not the thing the bookkeeping is about. Nothing here
// runs an agent, and every worker is killed by the test that started it.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const {
  createSessionRunner,
  isProcessAlive,
  parseProcessTable,
  processTableCommand,
  processStateCommand,
  isZombieState,
  processTree,
  survivingLeftovers,
  readProcessTable,
  probeProcessTable,
  TREE_KILLER,
  SCAN_TIMEOUT_MS,
  SCAN_MAX_TIMEOUT_MS,
  SWEEP_TIMEOUT_MS,
  SWEEP_ATTEMPTS,
  REGISTRY_VERSION,
} = require('../server/sessions.js');
const { waitForExit } = require('./helpers/bounded.js');
const { removeTree } = require('./helpers/rm.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor: waitForCondition } = require('./helpers/wait.js');

const WIN = process.platform === 'win32';
// The same pair of numbers tests/kill-tree.test.js reasons about (T-0182): the
// worker must not be able to die of old age inside a test, or "it is gone" is
// true whether the sweep worked or not — and it announces its own exit anyway,
// so even then a natural death cannot be counted as a kill.
const WORKER_LIFETIME_MS = 300000;
const SELF_EXIT_MARK = 'self-exit';
// Long enough for a worker that was NOT killed to have appended several times:
// the "it is still running" assertions are worth as much as the time they gave
// it to die.
const SETTLE_MS = 1500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The argument order tests/kill-tree.test.js uses — the file this one grew from
// — over the suite's one wait. An adapter and not a loop: the loop lives once,
// in tests/helpers/wait.js, and the copy that used to be here read its condition
// into a variable before testing it, which is the mine T-0189 removed wearing a
// shape its guard could not see (T-0223).
function waitFor(predicate, what, timeoutMs = SPAWN_WAIT_BUDGET_MS) {
  return waitForCondition(predicate, timeoutMs, what);
}

let fixtures;
let workerScript;
let seq = 0;

before(() => {
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-leftovers-'));
  workerScript = path.join(fixtures, 'worker.js');
  fs.writeFileSync(
    workerScript,
    [
      "'use strict';",
      "const fs = require('fs');",
      'const [, , pidFile, workFile] = process.argv;',
      "fs.writeFileSync(workFile, 'start\\n');",
      "fs.writeFileSync(pidFile + '.tmp', String(process.pid));",
      "fs.renameSync(pidFile + '.tmp', pidFile);",
      "setInterval(() => fs.appendFileSync(workFile, 'tick\\n'), 100);",
      'setTimeout(() => {',
      `  fs.appendFileSync(workFile, '${SELF_EXIT_MARK}\\n');`,
      '  process.exit(0);',
      `}, ${WORKER_LIFETIME_MS});`,
      // A child of its own, started only when the test asks for one, so that the
      // tree can be written down BEFORE it exists — which is the situation the
      // sweep has to survive.
      'const grandFile = process.argv[4];',
      'if (grandFile) {',
      '  const timer = setInterval(() => {',
      "    if (!fs.existsSync(grandFile + '.go')) return;",
      '    clearInterval(timer);',
      `    const kid = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${WORKER_LIFETIME_MS})'], { stdio: 'ignore', windowsHide: true });`,
      "    fs.writeFileSync(grandFile + '.tmp', String(kid.pid));",
      "    fs.renameSync(grandFile + '.tmp', grandFile);",
      '  }, 50);',
      '}',
      '',
    ].join('\n')
  );
});

after(() => removeTree(fixtures));

// A shell, because that is what a session command is: `cmd /c claude ...`, `npm
// ci`. A node launcher would hide the whole class — libuv puts ITS children in a
// job object that dies with it, so the grandchild would go down by itself and
// there would be nothing to clean up.
function launcher(pidFile, workFile, grandFile) {
  const argv = [workerScript, pidFile, workFile, ...(grandFile ? [grandFile] : [])];
  if (WIN) return ['cmd', ['/c', process.execPath, ...argv]];
  const quoted = [process.execPath, ...argv].map((a) => `'${a}'`).join(' ');
  return ['/bin/sh', ['-c', `${quoted} & wait`]];
}

function asTemplate([file, args]) {
  return [file, ...args].map((arg) => `"${arg}"`).join(' ');
}

const started = []; // every process this file started, killed in afterEach

function treePaths() {
  const id = `tree-${++seq}`;
  return {
    pidFile: path.join(fixtures, id + '.pid'),
    workFile: path.join(fixtures, id + '.work'),
    grandFile: path.join(fixtures, id + '.grand'),
  };
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

// "The worker died" says something about the sweep only if the worker did not
// die of its own accord, and the worker says which it was (T-0182).
async function waitForKilled({ workerPid, workFile }, what) {
  await waitFor(() => !isProcessAlive(workerPid), what);
  assert.equal(
    selfExited(workFile),
    false,
    `${what}: the worker exited of old age, so its death says nothing about the sweep`
  );
}

// Starts the tree the way a board does — cwd outside the project, so a surviving
// worker cannot be what keeps the project directory undeletable — and waits until
// the grandchild has announced itself.
async function startTree({ grandchild = false } = {}) {
  const { pidFile, workFile, grandFile } = treePaths();
  const [file, args] = launcher(pidFile, workFile, grandchild ? grandFile : null);
  const child = spawn(file, args, {
    cwd: fixtures,
    stdio: 'ignore',
    shell: false,
    detached: !WIN,
    windowsHide: true,
  });
  const tree = { child, pidFile, workFile, grandFile, workerPid: 0, grandPid: 0 };
  started.push(tree);
  await waitFor(() => readWorkerPid(pidFile) > 0, 'the worker to report its pid');
  tree.workerPid = readWorkerPid(pidFile);
  return tree;
}

// The leftover starts a child of its own, now — after the tree has been written
// down, so this pid is in no registry anywhere.
async function startGrandchild(tree) {
  fs.writeFileSync(tree.grandFile + '.go', '');
  tree.grandPid = await waitFor(
    () => readWorkerPid(tree.grandFile),
    'the leftover to start a child of its own'
  );
  return tree.grandPid;
}

// The whole tree, for cleaning up after a test.
function hardKill(pid) {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    if (WIN) spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }).unref();
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

// That one process and nothing under it — `/t` here would kill the worker too,
// and the worker surviving its launcher is the whole situation being staged.
function killAlone(pid) {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    if (WIN) spawn('taskkill', ['/pid', String(pid), '/f'], { stdio: 'ignore' }).unref();
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

// A launcher that is still there when the staging goes on is a staging that did
// not happen, so this is a wait like any other and fails like one.
async function waitGone(pid) {
  if (!pid) return;
  await waitFor(() => !isProcessAlive(pid), `pid ${pid} to be gone`);
}

const projects = [];
const runners = [];

function makeProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-leftovers-project-'));
  projects.push(project);
  return project;
}

function makeLogger() {
  const warned = [];
  const errored = [];
  return {
    warned,
    errored,
    warn: (m) => warned.push(String(m)),
    error: (m) => errored.push(String(m)),
    log: () => {},
  };
}

function makeRunner(project, options = {}) {
  const runner = createSessionRunner({ project, logger: makeLogger(), ...options });
  runners.push(runner);
  return runner;
}

function registryPath(project) {
  return path.join(project, '.briefboard', 'sessions', 'registry.json');
}

function readRegistry(project) {
  const file = registryPath(project);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// The registry a board that never got to shut down leaves behind: a session
// still marked running, the processes it had written down, and a `board` pid
// nobody holds any more.
function writeRegistry(project, session) {
  const file = registryPath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: REGISTRY_VERSION,
        sessions: [
          {
            id: 'T-0001',
            kind: 'worker',
            branch: null,
            worktree: null,
            board: 0,
            startedAt: new Date().toISOString(),
            logPath: path.join(project, '.briefboard', 'sessions', 'gone.log'),
            status: 'running',
            exitCode: null,
            signal: null,
            endedAt: null,
            ...session,
          },
        ],
        history: [],
        dropped: {},
      },
      null,
      2
    ) + '\n'
  );
}

// A pid nobody holds: this one was real and has exited, so the board that wrote
// the record cannot be mistaken for alive.
async function deadPid() {
  const proc = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await waitForExit(proc, SPAWN_WAIT_BUDGET_MS);
  await waitGone(proc.pid);
  return proc.pid;
}

// A process that has stopped running, staged as far as each platform allows.
//
// Windows frees a pid the moment the process ends, so a process that has exited
// is the whole of the case there. POSIX holds the pid until the parent reaps the
// child, and a parent that never wait()s — PID 1 in a plain container, a daemon
// started from something that does not wait — leaves a ZOMBIE sitting at that
// pid indefinitely, with `kill(pid, 0)` going on succeeding for it. That is the
// case this staging exists for (T-0202).
//
// The parent that will not reap is a Node process with its event loop blocked:
// libuv reaps a child from the loop when SIGCHLD arrives, so a loop that never
// comes back never reaps. A shell will not do — measured in node:22-bookworm,
// dash reaps a background child of `sh -c 'kid & sleep 3'` on its own.
const ZOMBIE_MAKER = [
  'const kid = require("child_process").spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });',
  'require("fs").writeFileSync(process.argv[1] + ".tmp", String(kid.pid));',
  'require("fs").renameSync(process.argv[1] + ".tmp", process.argv[1]);',
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
].join('\n');

const zombieParents = [];
async function stoppedPid() {
  if (WIN) return deadPid();
  const pidFile = path.join(fixtures, `zombie-${++seq}.pid`);
  const parent = spawn(process.execPath, ['-e', ZOMBIE_MAKER, pidFile], {
    cwd: fixtures,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  zombieParents.push(parent);
  const pid = await waitFor(() => readWorkerPid(pidFile), 'the short-lived child to report its pid');
  // Asked of the machine directly, not through the code under test, so that this
  // staging is a fact about the container rather than a second reading of what
  // is being checked.
  await waitFor(() => {
    try {
      // No `stdio` of its own: execFileSync hands the output back as its return
      // value, and there is no pipe here for anything to block on.
      return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' })
        .trim()
        .startsWith('Z');
    } catch {
      return false;
    }
  }, 'the child to become a zombie its parent will not reap');
  // Vacuity guard, and the whole reason the case exists: the only liveness check
  // Node has on every platform still says this corpse is alive.
  assert.doesNotThrow(() => process.kill(pid, 0), 'the pid was freed, so nothing was staged');
  return pid;
}

// And a board that IS alive, so that "another board is still running this
// session" is a fact about a real process rather than a number.
const boards = [];
async function liveBoard() {
  const proc = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${WORKER_LIFETIME_MS})`], {
    stdio: 'ignore',
    windowsHide: true,
  });
  boards.push(proc);
  await waitFor(() => isProcessAlive(proc.pid), 'the stand-in board to start');
  return proc;
}

// The table a FIXTURE needs, as opposed to the one the product reads. Two things
// separate it, and both are T-0224: its budget is the test's own and generous,
// because under load this read costs seconds and a fixture that gives up turns
// five tests into failures about the machine; and when it does give up it says
// why, so the one reading the output can tell "the sweep found nothing" from
// "PowerShell did not answer in time" without re-running anything.
//
// 90 s, raised from the 60 s T-0224 set against a worst case of 26.5 s. Measured
// again under four concurrent suites on 2026-08-17 (Windows 11, node v24.18.0,
// 24 cores, the suite grown to 1840 tests and two other agent sessions on the
// machine), one read of this table cost 39.5 s, 41.2 s, 45.5 s and 47.1 s — so
// what T-0224 measured at p99 16.1 s is now past the product's own 30 s scan
// budget, and 60 s was 1.3x the worst case. This is 1.9x it. The number is about
// this machine under this load and nothing else: the same read costs 78 ms in a
// Linux container (T-0224).
const FIXTURE_TABLE_MS = 90000;
async function machineTable() {
  const { rows, reason } = await probeProcessTable(process.platform, FIXTURE_TABLE_MS);
  assert.ok(rows, `this machine would not list its processes — ${reason}`);
  return rows;
}

// What the live table says about one pid right now — the identity token the
// sweep compares against, taken from the same source it takes it from.
async function sinceOf(pid) {
  const rows = await machineTable();
  const row = rows.find((r) => r.pid === pid);
  assert.ok(row, `pid ${pid} is not in the process table`);
  return row.since;
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()));
  const pids = [];
  for (const tree of started.splice(0)) {
    for (const pid of [tree.grandPid, tree.workerPid, tree.child.pid]) {
      if (!pid) continue;
      hardKill(pid);
      pids.push(pid);
    }
  }
  for (const proc of boards.splice(0)) {
    hardKill(proc.pid);
    pids.push(proc.pid);
  }
  // The parents staged never to reap: their groups go, and the corpse in each
  // stays one until something reaps it, which in a container without an init is
  // nothing. Two pids for the whole file, and they hold no resources.
  for (const proc of zombieParents.splice(0)) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await Promise.all(pids.map(waitGone));
  while (projects.length) await removeTree(projects.pop());
});

describe('reading the process table (T-0193)', () => {
  it('asks PowerShell on Windows and ps everywhere else', () => {
    const [file, args] = processTableCommand('win32');
    assert.equal(file, 'powershell');
    assert.ok(args.includes('-NoProfile'), 'a profile can print anything into the output');
    assert.match(args.at(-1), /Win32_Process/);
    // The state column is what tells a zombie from a live process (T-0202), and
    // it comes from the table already being read rather than from a source of
    // its own.
    assert.deepStrictEqual(processTableCommand('linux'), [
      'ps',
      ['-eo', 'pid=,ppid=,state=,lstart='],
    ]);
    // Windows has no process state to print and prints a placeholder in its
    // place rather than a shorter line: one line shape means one parser.
    assert.match(args.at(-1), /'\{0\} \{1\} - \{2:/);
  });

  it('asks for one pid at a time out of the same table, for the check that cannot wait', () => {
    assert.deepStrictEqual(processStateCommand(431), ['ps', ['-o', 'state=', '-p', '431']]);
  });

  it('reads both shapes, and drops what is not a process line', () => {
    assert.deepStrictEqual(
      parseProcessTable(
        [
          '4 0 - 2026-08-16 15:46:59.9214590',
          '67260 3556 - 2026-08-16 15:47:00.1053330',
          '  431     1 Ss   Sat Aug 16 12:00:00 2026',
          '  432     1 Z    Sat Aug 16 12:00:01 2026',
          '',
          'Get-CimInstance : something went wrong',
        ].join('\n')
      ),
      [
        { pid: 4, ppid: 0, state: '-', since: '2026-08-16 15:46:59.9214590' },
        { pid: 67260, ppid: 3556, state: '-', since: '2026-08-16 15:47:00.1053330' },
        { pid: 431, ppid: 1, state: 'Ss', since: 'Sat Aug 16 12:00:00 2026' },
        { pid: 432, ppid: 1, state: 'Z', since: 'Sat Aug 16 12:00:01 2026' },
      ]
    );
  });

  it('knows which state letter means "dead, waiting to be reaped"', () => {
    assert.equal(isZombieState('Z'), true);
    assert.equal(isZombieState('Z+'), true, 'the flags after the letter are not part of it');
    for (const state of ['S', 'Ss', 'R+', 'D', 'I', 'T', '-', '', null, undefined]) {
      assert.equal(isZombieState(state), false, `${JSON.stringify(state)} is not a zombie`);
    }
  });

  it('drops a process whose start time the OS would not give up', () => {
    assert.deepStrictEqual(parseProcessTable('8 4 S\n9 4\n'), []);
  });

  it('lists this very process on this very machine', async () => {
    // The fixture's budget, not the product's: what is under test is what the
    // table SAYS, and the product's 30 s is under what the read costs while the
    // suite runs four times over (T-0223 — this read was measured at 39.5-47.1 s
    // then, and the same call on SCAN_TIMEOUT_MS failed 4 loaded runs of 4).
    const rows = await readProcessTable(process.platform, FIXTURE_TABLE_MS);
    assert.ok(rows, `${processTableCommand()[0]} would not list the processes on this machine`);
    const self = rows.find((row) => row.pid === process.pid);
    assert.ok(self, 'the table does not contain the process asking for it');
    assert.ok(self.since, 'and says nothing about when it started');
    assert.ok(self.state, 'and nothing about what state it is in');
    assert.equal(isZombieState(self.state), false, 'the process asking is not a zombie');
    // In a start time this machine's format cannot be read from, the whole tree
    // comes back empty and nothing is ever written down (T-0199).
    assert.ok(
      processTree(rows, process.pid).some((p) => p.pid === process.pid),
      `the start time this machine prints cannot be read: ${JSON.stringify(self.since)}`
    );
  });

  // The read is where the reason exists at all: every caller above it treats a
  // missing table as "leave everything alone", so an error dropped here is a
  // whole cleanup that switches itself off and can only report THAT it did
  // (T-0224).
  it('says why the table could not be read, instead of resolving to nothing', async () => {
    // No shell on any machine starts inside a millisecond — measured, this one
    // is killed at the budget 246ms in.
    const out = await probeProcessTable(process.platform, 1);
    const [command] = processTableCommand();

    assert.equal(out.rows, null);
    assert.equal(out.code, 'timeout', 'a read killed at its budget is not the same failure as a missing command');
    assert.match(out.reason, new RegExp(`^${command}: `), 'the reason does not say what would not answer');
    assert.match(out.reason, /within 1ms/, 'nor what budget it did not fit into');
    // The plain reader keeps the contract its other callers were written against.
    assert.equal(await readProcessTable(process.platform, 1), null);
  });

  it('carries no reason when the table was read', async () => {
    const out = await probeProcessTable(process.platform, FIXTURE_TABLE_MS);
    assert.ok(out.rows && out.rows.length, `${processTableCommand()[0]} would not list the processes here`);
    assert.equal(out.reason, '');
    assert.equal(out.code, '');
  });
});

describe('what "still running" means (T-0202)', () => {
  it('does not call a process that has stopped running alive', async () => {
    const pid = await stoppedPid();
    assert.equal(
      isProcessAlive(pid),
      false,
      'a process that will never run another instruction was read as a live one'
    );
  });

  it('goes on calling a process that is running alive', () => {
    // The other half of the same answer: the check was made stricter, and a
    // stricter check that says "dead" about a live board would have the next
    // board sweep away the agents of a session someone is still running.
    assert.equal(isProcessAlive(process.pid), true);
  });
});

describe('finding the tree in the table (T-0193)', () => {
  const at = (s) => `2026-08-16 10:00:0${s}.0000000`;
  const table = [
    { pid: 100, ppid: 1, since: at(0) }, // the launcher
    { pid: 200, ppid: 100, since: at(1) }, // the agent it started
    { pid: 300, ppid: 200, since: at(2) }, // and one of its own
    { pid: 400, ppid: 1, since: at(3) }, // a stranger
  ];

  it('takes the launcher and everything under it, and no one else', () => {
    assert.deepStrictEqual(processTree(table, 100), [
      { pid: 100, since: at(0) },
      { pid: 200, since: at(1) },
      { pid: 300, since: at(2) },
    ]);
  });

  it('leaves out a stranger whose dead parent once held the launcher pid', () => {
    // Windows keeps naming a parent pid long after that parent is gone, so an
    // orphan of an EARLIER holder of pid 100 hangs off it in the table. It
    // started before our launcher did, and that is what tells it apart.
    const stale = [...table, { pid: 500, ppid: 100, since: '2026-08-16 09:59:00.0000000' }];
    assert.deepStrictEqual(
      processTree(stale, 100).map((p) => p.pid),
      [100, 200, 300]
    );
  });

  it('leaves out a row whose start time cannot be read at all', () => {
    const unreadable = [...table, { pid: 600, ppid: 100, since: 'no idea' }];
    assert.deepStrictEqual(
      processTree(unreadable, 100).map((p) => p.pid),
      [100, 200, 300]
    );
  });

  it('has nothing to say about a root that is not in the table', () => {
    assert.deepStrictEqual(processTree(table, 999), []);
    assert.deepStrictEqual(processTree([{ pid: 100, ppid: 1, since: 'no idea' }], 100), []);
  });

  it('ends on a table where a process is its own parent', () => {
    assert.deepStrictEqual(processTree([{ pid: 100, ppid: 100, since: at(0) }], 100), [
      { pid: 100, since: at(0) },
    ]);
  });
});

describe('a written-down pid is only killed if it is still the same process (T-0193)', () => {
  const rows = [
    { pid: 200, ppid: 100, since: 'started then' },
    { pid: 300, ppid: 1, since: 'started later' },
  ];

  it('keeps the process that still reports the start time it was written down with', () => {
    assert.deepStrictEqual(survivingLeftovers([{ pid: 200, since: 'started then' }], rows), [
      { pid: 200, since: 'started then' },
    ]);
  });

  it('drops a pid the machine has since handed to someone else', () => {
    assert.deepStrictEqual(survivingLeftovers([{ pid: 300, since: 'started then' }], rows), []);
  });

  it('drops a pid nobody holds any more', () => {
    assert.deepStrictEqual(survivingLeftovers([{ pid: 999, since: 'started then' }], rows), []);
  });

  it('drops one of ours that has died and not been reaped', () => {
    // Still at its pid, still reporting the start time it was written down with,
    // and it is a corpse: killing it does nothing, and counting it would have the
    // board announce that it ended a process which had ended itself (T-0202).
    const zombie = [{ pid: 200, ppid: 100, state: 'Z', since: 'started then' }];
    assert.deepStrictEqual(survivingLeftovers([{ pid: 200, since: 'started then' }], zombie), []);
  });
});

describe('the board writes down the tree of a running session (T-0193)', () => {
  it('records the launcher and the agent under it, and shows neither on the card', async () => {
    const { pidFile, workFile } = treePaths();
    const project = makeProject();
    const runner = makeRunner(project, {
      command: asTemplate(launcher(pidFile, workFile)),
      scanIntervalMs: 500,
    });
    const session = await runner.startSession('T-0001');
    assert.equal(session.started, true);
    const tree = { child: { pid: session.pid }, workerPid: 0, workFile };
    started.push(tree);
    tree.workerPid = await waitFor(() => readWorkerPid(pidFile), 'the worker to report its pid');
    const workerPid = tree.workerPid;

    const recorded = await waitFor(() => {
      const stored = readRegistry(project);
      const found = stored && stored.sessions.find((s) => s.id === 'T-0001');
      const pids = found && found.descendants ? found.descendants.map((p) => p.pid) : [];
      return pids.includes(workerPid) ? found.descendants : null;
    }, 'the board to write down the session tree');

    assert.ok(
      recorded.some((p) => p.pid === session.pid),
      'the launcher itself is written down too: on POSIX it is what survives the board'
    );
    for (const entry of recorded) {
      assert.ok(entry.since, `pid ${entry.pid} was written down without a start time`);
    }
    // Process bookkeeping for the next board run, and nothing a card asks about.
    assert.equal('descendants' in runner.get('T-0001'), false);
  });
});

// The crash itself, as faithfully as a test can stage it: a real tree, and then
// only the launcher killed — which is exactly what a board dying takes with it
// on Windows, the job object reaching the launcher and nothing under it. The
// worker is then an orphan with a board that is never coming back.
async function orphan() {
  const tree = await startTree();
  const table = await machineTable();
  const recorded = processTree(table, tree.child.pid);
  assert.ok(
    recorded.some((p) => p.pid === tree.workerPid),
    'the worker is missing from the tree the board would have written down'
  );
  killAlone(tree.child.pid);
  await waitGone(tree.child.pid);
  assert.equal(isProcessAlive(tree.workerPid), true, 'the worker outlived its launcher, as it must');
  return { tree, recorded };
}

describe('the next board start ends what the dead board left running (T-0193)', () => {
  it('kills the agent that outlived its board, and says so', async () => {
    const { tree, recorded } = await orphan();
    const project = makeProject();
    // The board's pid is a process that has stopped running, staged as hard as
    // the platform allows: on POSIX that is a zombie nobody reaped, which
    // `kill(pid, 0)` still answers for. Read as a live board, its session would
    // be left alone as another board's and the sweep would never run (T-0202).
    writeRegistry(project, { pid: tree.child.pid, board: await stoppedPid(), descendants: recorded });

    const logger = makeLogger();
    const runner = makeRunner(project, { logger });
    const swept = await runner.swept;

    assert.ok(swept.killed.includes(tree.workerPid), 'the worker was not among the killed');
    await waitForKilled(tree, 'the leftover worker to be killed at the next board start');
    const said = logger.warned.join('\n');
    assert.match(said, /T-0001/, 'the cleanup named no task');
    assert.match(said, new RegExp(String(tree.workerPid)), 'the cleanup named no pid');
  });

  it('leaves a pid the machine has since handed to a stranger alone', async () => {
    const { tree, recorded } = await orphan();
    const project = makeProject();
    // The same live processes, written down with a start time none of them
    // reports: that is what a pid reused after the board died looks like from
    // here, and the stranger holding it now is not ours to kill.
    writeRegistry(project, {
      pid: tree.child.pid,
      board: await deadPid(),
      descendants: recorded.map((entry) => ({ ...entry, since: 'when a stranger started' })),
    });

    const logger = makeLogger();
    const runner = makeRunner(project, { logger });
    const swept = await runner.swept;

    assert.deepStrictEqual(swept.killed, []);
    const before = ticks(tree.workFile);
    await sleep(SETTLE_MS);
    assert.equal(isProcessAlive(tree.workerPid), true, 'a stranger was killed');
    assert.ok(ticks(tree.workFile) > before, 'and it went on working, untouched');
    assert.deepStrictEqual(
      logger.warned.filter((m) => /killed/.test(m)),
      [],
      'nothing was killed, so nothing is announced as killed'
    );
  });

  it('leaves the sessions of a board that is still running to that board', async () => {
    const { tree, recorded } = await orphan();
    const project = makeProject();
    // A second board on the same project, alive: its session is none of our
    // business, and neither are the processes it is holding.
    const other = await liveBoard();
    writeRegistry(project, { pid: tree.child.pid, board: other.pid, descendants: recorded });

    const runner = makeRunner(project);
    const swept = await runner.swept;

    assert.deepStrictEqual(swept.killed, []);
    await sleep(SETTLE_MS);
    assert.equal(isProcessAlive(tree.workerPid), true, "another board's agent was killed");
  });

  it('says so out loud when the machine will not list its processes', async () => {
    const { tree, recorded } = await orphan();
    const project = makeProject();
    writeRegistry(project, { pid: tree.child.pid, board: await deadPid(), descendants: recorded });

    const logger = makeLogger();
    // A source that answers with nothing and does not say why — the shape every
    // caller of the table used to see, and the one the message still has to be
    // written for.
    const runner = makeRunner(project, { logger, sweepRetryMs: 20, listProcesses: () => null });
    const swept = await runner.swept;

    assert.deepStrictEqual(swept.killed, []);
    assert.equal(swept.checked, recorded.length);
    assert.match(
      logger.errored.join('\n'),
      /may still be running/,
      'a cleanup that could not happen has to be said out loud'
    );
    assert.equal(isProcessAlive(tree.workerPid), true);
  });

  // T-0224. The three tests below are about the silence rather than the failure:
  // under load this cleanup switches itself off, and the person it leaves paying
  // for a dead board's agents is the one who has to hear about it.
  it('names why it could not read the table, and what leaving them costs', async () => {
    const { tree, recorded } = await orphan();
    const project = makeProject();
    writeRegistry(project, { pid: tree.child.pid, board: await deadPid(), descendants: recorded });

    const logger = makeLogger();
    const runner = makeRunner(project, {
      logger,
      sweepRetryMs: 20,
      listProcesses: () => ({
        rows: null,
        code: 'timeout',
        reason: 'powershell: no answer within 120000ms (killed after 120004ms)',
      }),
    });
    const swept = await runner.swept;

    assert.deepStrictEqual(swept.killed, []);
    const said = logger.errored.join('\n');
    assert.match(said, /no answer within 120000ms/, 'the reason the read failed reached nobody');
    assert.match(said, /T-0001/, 'and neither did the session whose processes are still out there');
    assert.match(said, /go on costing/, 'a leftover agent costs money for as long as it runs');
    // T-0202 stands: a table that cannot be read means the process is alive, and
    // the safe half of that trade is doing nothing.
    await sleep(SETTLE_MS);
    assert.equal(isProcessAlive(tree.workerPid), true, 'an unreadable table was read as a dead process');
  });

  it('asks a second time before giving up on the cleanup for the whole board run', async () => {
    const { tree, recorded } = await orphan();
    const project = makeProject();
    writeRegistry(project, { pid: tree.child.pid, board: await deadPid(), descendants: recorded });

    const logger = makeLogger();
    let asked = 0;
    const runner = makeRunner(project, {
      logger,
      sweepRetryMs: 20,
      // Busy for the first read and not for the second, which is what a loaded
      // machine measurably does: the same read swings between 1.1s and 8.5s over
      // tens of seconds, so a later attempt is a different question — while an
      // immediate one is not, and rescued 1 read of 14 (T-0224).
      listProcesses: (budget) =>
        ++asked === 1
          ? { rows: null, code: 'timeout', reason: `powershell: no answer within ${budget}ms` }
          : readProcessTable(process.platform, FIXTURE_TABLE_MS),
    });
    const swept = await runner.swept;

    assert.equal(asked, 2, 'one refusal ended the cleanup for the rest of the board run');
    assert.ok(swept.killed.includes(tree.workerPid), 'the second read answered and the worker was still not killed');
    await waitForKilled(tree, 'the leftover worker to be killed by the second attempt');
    assert.match(
      logger.errored.join('\n'),
      /Trying again in 20ms/,
      'a failure that will be retried has to say so, or it reads as the end of the matter'
    );
  });

  it('does not ask twice when the machine has no such command', async () => {
    const project = makeProject();
    writeRegistry(project, {
      pid: 1,
      board: await deadPid(),
      descendants: [{ pid: 999999, since: 'when nothing started' }],
    });

    const logger = makeLogger();
    let asked = 0;
    const runner = makeRunner(project, {
      logger,
      sweepRetryMs: 20,
      listProcesses: () => {
        asked++;
        return { rows: null, code: 'missing', reason: 'powershell: not on this machine' };
      },
    });
    const swept = await runner.swept;

    assert.deepStrictEqual(swept, { killed: [], checked: 1 });
    assert.equal(asked, 1, 'a machine without the command will not have grown one by the retry');
    const said = logger.errored.join('\n');
    assert.match(said, /not on this machine/);
    assert.doesNotMatch(said, /Trying again/, 'it promised a retry it was never going to make');
    // And it does not hand them to the scan either: the scan runs the same
    // command, so the one failure that cannot be got past this way is the one
    // there is nothing to hand on about (T-0230).
    assert.doesNotMatch(said, /re-checks them/, 'a machine without the command cannot re-check anything');
  });

  it('says the promised second attempt is not coming when the board is stopped first', async () => {
    const project = makeProject();
    writeRegistry(project, {
      pid: 1,
      board: await deadPid(),
      descendants: [{ pid: 999999, since: 'when nothing started' }],
    });

    const logger = makeLogger();
    const runner = makeRunner(project, {
      logger,
      // Longer than this test will ever wait: the point is that stopping the
      // board ends the wait rather than the wait ending the board.
      sweepRetryMs: 600000,
      listProcesses: () => ({ rows: null, code: 'timeout', reason: 'powershell: no answer within 120000ms' }),
    });
    await waitFor(() => logger.errored.length > 0, 'the first attempt to fail and say so');
    await runner.shutdown();

    // It resolves at all: a wait that is only cleared leaves `swept` pending
    // forever, and a board hanging on shutdown is not an improvement on a board
    // that cleans up nothing.
    const swept = await runner.swept;
    assert.deepStrictEqual(swept, { killed: [], checked: 1 });
    const said = logger.errored.join('\n');
    assert.match(said, /Trying again in 600000ms/, 'the retry was promised');
    assert.match(said, /never checked and were never killed/, 'and then quietly not made');
  });

  it('reads the table on a budget of its own, above the one the scan can retry out of', async () => {
    const project = makeProject();
    writeRegistry(project, {
      pid: 1,
      board: await deadPid(),
      descendants: [{ pid: 999999, since: 'when nothing started' }],
    });

    const budgets = [];
    const runner = makeRunner(project, {
      listProcesses: (budget) => {
        budgets.push(budget);
        return [];
      },
    });
    const swept = await runner.swept;

    assert.deepStrictEqual(swept, { killed: [], checked: 1 });
    assert.deepStrictEqual(budgets, [SWEEP_TIMEOUT_MS], 'the sweep read the table on the scan’s budget');
    // The scan gives up cheaply because its next tick asks again half a minute
    // later; the sweep has no next tick and nobody waiting on it, so it is the
    // read here that can afford to wait out a busy machine (T-0224).
    assert.ok(
      SWEEP_TIMEOUT_MS > SCAN_TIMEOUT_MS,
      `the once-only read is given no more time than the repeated one: ${SWEEP_TIMEOUT_MS} vs ${SCAN_TIMEOUT_MS}`
    );
  });

  // The board's death, as each platform really has it. On Windows the job object
  // takes the launcher and nothing under it. On POSIX it takes nothing at all —
  // measured in a node:22-bookworm container (T-0199): the launcher is
  // reparented to init and goes on running, so killing it here would stage a
  // crash Linux does not have and hide the process group the sweep works through.
  async function boardDies(tree) {
    if (!WIN) return;
    killAlone(tree.child.pid);
    await waitGone(tree.child.pid);
  }

  it('takes a child the leftover started after the tree was written down', async () => {
    const tree = await startTree({ grandchild: true });
    const table = await machineTable();
    const recorded = processTree(table, tree.child.pid); // the scan happens here
    const grandPid = await startGrandchild(tree); // and this one is born after it
    assert.equal(
      recorded.some((p) => p.pid === grandPid),
      false,
      'the child was started after the scan and must not be in what was written down'
    );
    await boardDies(tree);

    const project = makeProject();
    writeRegistry(project, { pid: tree.child.pid, board: await deadPid(), descendants: recorded });
    const runner = makeRunner(project);
    await runner.swept;

    await waitForKilled(tree, 'the leftover worker to be killed at the next board start');
    await waitFor(
      () => !isProcessAlive(grandPid),
      'the child the leftover started after the scan to be killed too'
    );
  });

  it('does nothing at all for a board that left nothing behind', async () => {
    const project = makeProject();
    writeRegistry(project, { pid: 1, board: await deadPid(), descendants: [] });

    const logger = makeLogger();
    let asked = 0;
    const runner = makeRunner(project, {
      logger,
      listProcesses: () => {
        asked++;
        return [];
      },
    });
    const swept = await runner.swept;

    assert.deepStrictEqual(swept, { killed: [], checked: 0 });
    assert.equal(asked, 0, 'the process table costs a subprocess and was read for nothing');
    assert.deepStrictEqual(logger.warned.filter((m) => /killed/.test(m)), []);
  });
});

// T-0230. Two refusals used to end the cleanup for the whole board run, and the
// agents of the dead board then ran on until some LATER board start. What the
// sweep may spend on that is the thing under test as much as what it achieves:
// a read is a whole subprocess, and one asked for every half minute of a long
// board run is a process stream, not a retry.
describe('the sweep does not give up on the leftovers for the rest of the board run (T-0230)', () => {
  // A recorded process that is genuinely running, so the ladder is not cut short
  // by the "nothing left to kill" check below. Its start time is one no process
  // reports, so even a table that did arrive could not match it — see
  // survivingLeftovers.
  async function leftoverThatLives() {
    return { pid: (await liveBoard()).pid, since: 'when nothing started' };
  }

  const refuses = (calls) => (budget) => {
    calls.push(Date.now());
    return { rows: null, code: 'timeout', reason: `powershell: no answer within ${budget}ms` };
  };

  it('keeps asking after the second refusal, and waits longer before each attempt', async () => {
    const project = makeProject();
    writeRegistry(project, { pid: 1, board: await deadPid(), descendants: [await leftoverThatLives()] });

    const logger = makeLogger();
    const asked = [];
    const runner = makeRunner(project, { logger, sweepRetryMs: 20, listProcesses: refuses(asked) });
    const swept = await runner.swept;

    assert.deepStrictEqual(swept, { killed: [], checked: 1 });
    assert.ok(SWEEP_ATTEMPTS > 2, 'two attempts is the count this task exists to raise');
    assert.equal(asked.length, SWEEP_ATTEMPTS, 'the sweep stopped asking on a count of its own');
    // Each wait at least doubles the one before it. Only the lower bound is
    // asserted, because a timer may fire late and never early: a ladder that had
    // stayed at 20ms would miss the last bound by an order of magnitude, which is
    // the mistake this guards — 960 reads over an 8-hour board run.
    for (let i = 1; i < asked.length; i++) {
      const nominal = 20 * 2 ** (i - 1);
      assert.ok(
        asked[i] - asked[i - 1] >= nominal - 4,
        `attempt ${i + 1} came ${asked[i] - asked[i - 1]}ms after the last one, not the ${nominal}ms it owed`
      );
    }
    const said = logger.errored.join('\n');
    assert.match(said, new RegExp(`attempt 3 of ${SWEEP_ATTEMPTS}`), 'the attempts in between say nothing');
    assert.match(
      said,
      /re-checks them against the one it reads/,
      'the last word promises nothing about what happens after it'
    );
  });

  it('makes the later attempts even when nothing else holds the event loop', async () => {
    const project = makeProject();
    writeRegistry(project, { pid: 1, board: await deadPid(), descendants: [await leftoverThatLives()] });

    // A board with no server under it: the only thing left in its event loop is
    // the wait between two attempts. Unref'd, that wait is dropped the moment the
    // loop empties and the retry silently does not happen — which is what T-0224
    // found in a container and Windows hid entirely. Nothing in-process can stage
    // it, because the test runner's own loop is never empty.
    const script = [
      "'use strict';",
      // `node -e` gives the script no argv slot of its own: argv[1] is the first
      // argument passed after it.
      'const { createSessionRunner } = require(process.argv[1]);',
      'let asked = 0;',
      'const runner = createSessionRunner({',
      '  project: process.argv[2],',
      '  logger: { warn() {}, error() {}, log() {} },',
      '  sweepRetryMs: 20,',
      '  listProcesses: () => {',
      '    asked++;',
      "    return { rows: null, code: 'timeout', reason: 'powershell: no answer' };",
      '  },',
      '});',
      "runner.swept.then(() => console.log('ASKED ' + asked));",
    ].join('\n');
    const board = spawn(process.execPath, ['-e', script, path.join(__dirname, '..', 'server', 'sessions.js'), project], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let failed = '';
    board.stdout.on('data', (chunk) => (out += chunk));
    board.stderr.on('data', (chunk) => (failed += chunk));
    const code = await waitForExit(board, SPAWN_WAIT_BUDGET_MS);

    assert.equal(code, 0, `the board exited badly: ${failed || out}`);
    assert.match(
      out,
      new RegExp(`ASKED ${SWEEP_ATTEMPTS}`),
      'a board with an empty event loop dropped the waits and never made the attempts it promised'
    );
  });

  it('re-checks them against the table the scan reads, for the rest of the board run', async () => {
    const { tree, recorded } = await orphan();
    const project = makeProject();
    writeRegistry(project, { pid: tree.child.pid, board: await deadPid(), descendants: recorded });

    const logger = makeLogger();
    const { pidFile, workFile } = treePaths();
    let answers = false;
    const runner = makeRunner(project, {
      logger,
      command: asTemplate(launcher(pidFile, workFile)),
      sweepRetryMs: 20,
      scanIntervalMs: 300,
      listProcesses: (budget) =>
        answers
          ? readProcessTable(process.platform, FIXTURE_TABLE_MS)
          : { rows: null, code: 'timeout', reason: `powershell: no answer within ${budget}ms` },
    });
    const swept = await runner.swept;

    assert.deepStrictEqual(swept.killed, [], 'no read of the sweep’s own ever got a table');
    assert.equal(isProcessAlive(tree.workerPid), true, 'so the leftover of the dead board is still running');

    // The scan reads the table only while a session of THIS board is running, and
    // that read is what the stranded leftovers now get for nothing.
    const session = await runner.startSession('T-0002');
    assert.equal(session.started, true);
    const mine = { child: { pid: session.pid }, workerPid: 0, workFile };
    started.push(mine);
    mine.workerPid = await waitFor(() => readWorkerPid(pidFile), 'this board’s own session to start');
    answers = true;

    await waitForKilled(tree, 'the leftover the sweep could not check to be killed off the scan’s table');
    assert.match(logger.warned.join('\n'), /have been killed/, 'the kill the scan made was announced by nobody');
  });

  it('stops asking once nothing it wrote down is running any more', async () => {
    const { tree, recorded } = await orphan();
    const project = makeProject();
    writeRegistry(project, { pid: tree.child.pid, board: await deadPid(), descendants: recorded });

    const logger = makeLogger();
    const asked = [];
    const runner = makeRunner(project, { logger, sweepRetryMs: 500, listProcesses: refuses(asked) });
    await waitFor(() => logger.errored.length > 0, 'the first attempt to fail and say so');
    for (const entry of recorded) hardKill(entry.pid);
    await Promise.all(recorded.map((entry) => waitGone(entry.pid)));

    const swept = await runner.swept;
    assert.deepStrictEqual(swept.killed, []);
    assert.ok(
      asked.length < SWEEP_ATTEMPTS,
      `the ladder ran to the end asking about ${recorded.length} process(es) that were already gone`
    );
    assert.match(
      logger.warned.join('\n'),
      /not running any more/,
      'the board went on paying for a subprocess to ask about processes it can see are gone'
    );
  });
});

// T-0236. The hole the three tasks above left: they are all about the SWEEP,
// which reads what the previous board wrote down. This is about the WRITING —
// the scan — and it is the one place in the chain where nothing appears to fail.
// A scan whose read misses its budget leaves the registry holding a session with
// no processes under it, which is indistinguishable from a session whose agents
// are all gone; the next board then sweeps nothing and reports nothing, and the
// agents of the dead board go on running with no record that they exist.
//
// Measured under four concurrent suites (T-0223, 2026-08-17, Windows 11, node
// v24.18.0, 24 cores): one read cost 39.5s, 41.2s, 45.5s and 47.1s against a
// 30s budget, so on such a machine every tick failed identically and forever.
// The table is injected here rather than starved for real: what these hold to is
// what the board does with a read that will not answer, and the cost of that
// read is PowerShell's — 78ms for the same read in a Linux container (T-0224).
describe('a session whose tree could not be written down is not a session with no tree (T-0236)', () => {
  // The session itself is beside the point here — no tree has to survive
  // anything, because no real table is ever read. All it has to do is stay
  // running, so that there is something for the scan to fail to write down.
  const sleeper = asTemplate([process.execPath, ['-e', `setTimeout(() => {}, ${WORKER_LIFETIME_MS})`]]);

  const refusing = (budgets) => (budget) => {
    budgets.push(budget);
    return { rows: null, code: 'timeout', reason: `powershell: no answer within ${budget}ms` };
  };

  function storedSession(project, id = 'T-0001') {
    const stored = readRegistry(project);
    return stored && stored.sessions.find((s) => s.id === id);
  }

  it('gives the next read more time when the budget it had has already proved too small', async () => {
    const project = makeProject();
    const budgets = [];
    const runner = makeRunner(project, {
      command: sleeper,
      scanIntervalMs: 5,
      listProcesses: refusing(budgets),
    });
    assert.equal((await runner.startSession('T-0001')).started, true);

    await waitFor(() => budgets.length >= 5, 'the scan to read the table five times');
    assert.deepStrictEqual(
      budgets.slice(0, 5),
      [
        SCAN_TIMEOUT_MS,
        SCAN_TIMEOUT_MS * 2,
        SCAN_MAX_TIMEOUT_MS,
        SCAN_MAX_TIMEOUT_MS,
        SCAN_MAX_TIMEOUT_MS,
      ],
      'the reads went on asking for a budget the machine had already refused'
    );
    // The measurement is the whole argument for the ceiling: against a read timed
    // at 47.1s under load, the scan's own budget is 0.64x — below the thing it
    // bounds, which is what made the failure certain rather than likely.
    assert.ok(
      SCAN_MAX_TIMEOUT_MS > 47100 && SCAN_TIMEOUT_MS < 47100,
      `the ceiling ${SCAN_MAX_TIMEOUT_MS}ms does not clear the 47.1s read that was measured`
    );
  });

  it('says which session it has written nothing down for, and never invents a pid to kill', async () => {
    const project = makeProject();
    const logger = makeLogger();
    const budgets = [];
    const runner = makeRunner(project, {
      command: sleeper,
      scanIntervalMs: 5,
      logger,
      listProcesses: refusing(budgets),
    });
    const session = await runner.startSession('T-0001');
    assert.equal(session.started, true);

    const said = await waitFor(
      () => (logger.errored.length ? logger.errored.join('\n') : ''),
      'the board to say that it wrote nothing down'
    );
    assert.match(said, /T-0001: nothing written down at all/, 'the message named no session');
    assert.match(said, /no answer within 30000ms/, 'the message gave no reason');
    assert.match(said, /leaves its agents running/, 'the message said nothing about what it costs');

    const stored = await waitFor(() => storedSession(project), 'the session to reach the registry');
    assert.equal(stored.treeUnknown, true, 'the registry cannot tell this from a session with no processes');
    // Whichever of the failed reads was the last one before this was read: the
    // budget in it climbs, and the message above is where the first one is held to.
    assert.match(stored.treeReason, /^powershell: no answer within \d+ms$/);
    // The launcher's pid is known without any table — it is right there in the
    // record — and writing it down as something to kill is what must NOT happen:
    // a recorded process is only killed when it still carries the start time it
    // was written down with, and an unread table gives no such token, so the
    // entry could only ever be matched on the pid alone (T-0193, T-0202).
    assert.equal(stored.pid, session.pid);
    assert.deepStrictEqual(
      stored.descendants || [],
      [],
      'a pid with no start time beside it was written down as something for the next board to kill'
    );
    // And none of it reaches the card: this is bookkeeping for the next board run.
    assert.equal('treeUnknown' in runner.get('T-0001'), false);
  });

  it('goes on saying it while the failure lasts, and not once per read', async () => {
    const project = makeProject();
    const logger = makeLogger();
    const budgets = [];
    const runner = makeRunner(project, {
      command: sleeper,
      scanIntervalMs: 5,
      logger,
      listProcesses: refusing(budgets),
    });
    assert.equal((await runner.startSession('T-0001')).started, true);

    // Both read in the one turn: at this rate the next scan lands inside a poll
    // interval, so a count taken after the wait would be a count of a later
    // moment.
    const saidTimes = await waitFor(
      () => (budgets.length >= 17 ? logger.errored.length : 0),
      'seventeen reads to fail'
    );
    // Failures 1, 2, 4, 8 and 16 — said once was how a board could write nothing
    // down for an hour after a single line, and said every time is how a reader
    // learns to skip the line.
    assert.equal(saidTimes, 5, `16 failed reads were reported ${saidTimes} times`);
    assert.match(logger.errored.at(-1), /16 reads of the process table in a row have failed/);
  });

  it('marks a session whose first scan has not come round yet', async () => {
    const project = makeProject();
    let asked = 0;
    const runner = makeRunner(project, {
      command: sleeper,
      // Longer than this test, so no scan ever runs: the board dying inside its
      // first scan interval is the other way a session ends up with no tree, and
      // it is the documented limit of this cleanup.
      scanIntervalMs: 600000,
      // A table that ANSWERS, and answers with nothing. A refusing one would mark
      // the record by the other path and this test would pass without the mark it
      // is about ever being written at session start (T-0182).
      listProcesses: () => {
        asked++;
        return [];
      },
    });
    assert.equal((await runner.startSession('T-0001')).started, true);

    const stored = await waitFor(() => storedSession(project), 'the session to reach the registry');
    assert.equal(asked, 0, 'a scan ran, so the mark says nothing about a session not yet scanned');
    assert.equal(stored.status, 'running');
    assert.equal(stored.treeUnknown, true, 'a session with no tree yet is stored as one with no tree');
  });

  it('tells the next board that the registry is incomplete rather than empty', async () => {
    const previous = makeProject();
    const budgets = [];
    const failing = makeRunner(previous, {
      command: sleeper,
      scanIntervalMs: 5,
      listProcesses: refusing(budgets),
    });
    assert.equal((await failing.startSession('T-0001')).started, true);
    const left = await waitFor(
      () => (budgets.length >= 2 ? storedSession(previous) : null),
      'the board to write down that it could write nothing down'
    );

    // The record that board really left, handed to a board that starts after it
    // — the two halves are the same field or this test does not pass.
    const project = makeProject();
    writeRegistry(project, { ...left, board: await deadPid() });
    const logger = makeLogger();
    const runner = makeRunner(project, { logger, listProcesses: () => [] });
    await runner.swept;

    const said = logger.errored.join('\n');
    assert.match(said, /never fully written down/, 'the next board said nothing about the hole');
    assert.match(said, /T-0001/, 'the next board named no session');
    assert.match(said, /no answer within/, 'the next board did not say why it was never written down');
    assert.match(said, /nothing recorded at all/, 'the next board did not say what it could not check');
    assert.match(said, /found by hand/, 'the next board left the person nothing to do');
    // Reported once and then dropped: it describes a board run that is over, and
    // this board answers for its own sessions.
    assert.equal(storedSession(project).treeUnknown, undefined);
  });

  it('says so and starts over when the table can be read again', async () => {
    const project = makeProject();
    const logger = makeLogger();
    const budgets = [];
    // The fifth read never answers until this test lets it, which is what makes
    // the registry readable at all: at this scan rate the recovered record would
    // otherwise be overwritten by the next failure inside a single poll.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const runner = makeRunner(project, {
      command: sleeper,
      scanIntervalMs: 5,
      logger,
      // Three refusals, then the machine answers for real, then it refuses again:
      // the last one is what shows the budget went back to where it started
      // instead of staying at the ceiling for the rest of the board's life.
      listProcesses: (budget) => {
        budgets.push(budget);
        if (budgets.length === 4) return machineTable();
        const refusal = { rows: null, code: 'timeout', reason: `powershell: no answer within ${budget}ms` };
        return budgets.length === 5 ? held.then(() => refusal) : refusal;
      },
    });
    const session = await runner.startSession('T-0001');
    assert.equal(session.started, true);

    await waitFor(() => budgets.length >= 5, 'the scan to read the table five times');
    assert.match(
      logger.warned.join('\n'),
      /could be read again after 3 failed attempt/,
      'the last word on the table was that it could not be read'
    );
    assert.equal(budgets[4], SCAN_TIMEOUT_MS, 'the budget stayed where the failure had put it');

    const stored = storedSession(project);
    assert.equal(stored.treeUnknown, undefined, 'the session is still marked as one with no tree');
    assert.equal(stored.treeReason, undefined);
    assert.ok(
      stored.descendants.some((entry) => entry.pid === session.pid),
      'the tree the board could finally read was not written down'
    );
    release();
  });
});

// T-0231, absorbed by T-0230. Every external command here is resolved through
// PATH, and the decision was to leave it that way and say so: an attacker who can
// put their own `taskkill` earlier in the PATH the board inherits already runs
// code as this user. What the test holds to is the honesty of that — a command
// this module runs that SECURITY.md does not name is a boundary nobody declared.
describe('the external commands are named in the policy that declines to pin them (T-0231)', () => {
  it('SECURITY.md names every command this module resolves through PATH', () => {
    const commands = [processTableCommand('win32')[0], processTableCommand('linux')[0], TREE_KILLER];
    assert.deepStrictEqual(commands, ['powershell', 'ps', 'taskkill'], 'the set of commands changed');
    const policy = fs.readFileSync(path.join(__dirname, '..', 'SECURITY.md'), 'utf8');
    for (const command of commands) {
      assert.ok(
        policy.includes(`\`${command}\``),
        `SECURITY.md does not name \`${command}\` — a command the board runs off PATH without saying so`
      );
    }
  });
});

