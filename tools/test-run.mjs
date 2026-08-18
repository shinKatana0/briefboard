// `npm test` and `npm run test:verbose`: runs the suite under a watchdog, fails
// a run that executed no tests (T-0250), then fails if the run left the working
// copy dirtier than it found it (T-0111). A test that writes into the repository
// instead of a temporary directory is a bug in the test, and one the run cannot
// clean up after itself: a killed process never reaches its restoring `finally`,
// and the next run then reads the polluted file as the "original".

import { spawn, spawnSync } from 'node:child_process';
import { COUNT_MESSAGE } from './test-count-reporter.mjs';

// An upper bound on a single test, so a wait nobody bounded ends the test
// instead of the run: without it the suite hung forever three times in ~30 runs
// (T-0124). Far above the slowest honest test here (16 s) so a slow machine
// never trips it; `BRIEFBOARD_TEST_TIMEOUT_MS` overrides it, which is how the
// mechanism itself is tested.
const TEST_TIMEOUT_MS = process.env.BRIEFBOARD_TEST_TIMEOUT_MS || '120000';
const TIMEOUT_ARG = `--test-timeout=${TEST_TIMEOUT_MS}`;

// The limit above ends the hanging TEST and stops there. It does not end the RUN
// when the hang holds the event loop open — a live timer, a server still
// listening, which is exactly what T-0124's incident was: measured on Windows 11
// / node v24.18.0, the test was reported failed at the limit and the process then
// stayed alive with no summary and no exit code, still running after 30s
// (T-0245). So the run gets a bound of its own, here, outside it.
//
// Not Node's own --test-force-exit, which does the same job and cannot be used:
// on Windows it aborts any test file that leaves keep-alive sockets behind —
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c` —
// reproduced 5 runs of 5 on tests/response-helper.test.js and 3 of 3 on a
// three-`fetch` fixture written to check whether that file was special. It is
// not, and most of this suite talks to a board over HTTP. It also does not exist
// before Node 22 (node:21-bookworm, v21.7.3: "bad option", exit 9) while
// briefboard supports Node 21.
//
// The budget is silence, not total time: a whole-run budget would have to clear
// the slowest honest run (265s here idle, 971s with another suite on the same
// machine) and would still be a guess, while every finished test prints a mark.
//
// Three times the per-test limit, because the longest a healthy run may say
// nothing is a `before` hook and then the first test under it — each bounded by
// that limit, so twice it is the theoretical maximum and the budget has to be
// above that, not equal to it. Measured, the real numbers are far lower: 17.5s
// for the slowest test and 71s for the slowest whole file. The budget below
// derives from the same reasoning, and it is the reason there are two of them:
// a hook and a first test with nothing printed is what a run does while it is
// STARTING, and that span used to be charged to this one (T-0266).
const SILENCE_LIMIT_MS = Number(process.env.BRIEFBOARD_SILENCE_MS || Number(TEST_TIMEOUT_MS) * 3);

// Silence begins when the run first speaks. Before that the run is not silent,
// it is starting — node booting, the runner finding the files, the first hook —
// and none of that is a cost this wrapper decides. Measured on Windows 11 /
// node v24.18.0 / 24 cores, spawn to first byte of a three-test fixture: 0.6s
// on an idle machine, 1.3-1.6s with it nearly quiet, and 6.5s to 29.1s over
// eight reads under four concurrent full suites. One budget over both spans is a
// budget on process start-up wearing the name of silence: at 2000ms it killed a
// healthy run before it had printed a line, in 2 of 4 concurrent suites, and
// what the kill relayed was a run that had reported nothing (T-0266).
const STARTUP_LIMIT_MS = Number(process.env.BRIEFBOARD_STARTUP_MS || Number(TEST_TIMEOUT_MS) * 3);

// Two spans, two messages, because they are two different diagnoses. A run
// killed once it had spoken has a last line to look at; a run killed before it
// ever spoke has none, and pointing at one would send the reader looking for a
// test that never ran.
const SILENCE_KILLED = [
  '',
  `briefboard: the test run printed nothing for ${SILENCE_LIMIT_MS}ms and was killed.`,
  `Every test is bounded (${TIMEOUT_ARG}), so silence this long is not a slow test:`,
  'it is a test that hung while holding the event loop open. The run had already',
  'ended that test and could not leave (T-0124, T-0245).',
  'The report of the run dies with it. `npm run test:verbose` names every test as it',
  'finishes, so its last line before the silence is where to look.',
].join('\n');

const STARTUP_KILLED = [
  '',
  `briefboard: the test run said nothing at all in the ${STARTUP_LIMIT_MS}ms it had to start, and was killed.`,
  'No test had reported yet, so there is no last line to look at: what spent the',
  'time was node starting, the runner finding the files, or the first hook.',
  'This budget bounds how fast this machine can get a process going and nothing',
  'the suite decides — BRIEFBOARD_STARTUP_MS is what moves it (T-0266).',
].join('\n');

const DEFAULT_TEST_ARGS = [
  '--test',
  TIMEOUT_ARG,
  '--test-reporter=./tools/test-reporter-compact.mjs',
  'tests/**/*.test.js',
];

const argv = process.argv.slice(2);
const testArgs = argv.length ? ['--test', TIMEOUT_ARG, ...argv] : DEFAULT_TEST_ARGS;

// A run that executed nothing is not a pass (T-0250). Measured on an unpacked
// tarball of 0.2.0: `tests/` is not in the published package, the glob matched
// no file, and node's runner printed "pass 0" and exited 0 — a green run that
// ran nothing, which is the failure mode this suite is otherwise built against.
// The count arrives on a reporter of our own, out of the way of whichever
// reporter is printing the run.
//
// It used to arrive in a file, inside a `briefboard-run-` directory this process
// made and removed. T-0265 got that directory removed on every path the process
// can act on, and there the shape ran out: a hard kill runs no handler at all,
// so a run an agent session or a CI runner timed out still left one behind. What
// this wrapper has instead is no artifact to leave (T-0276) — the reporter runs
// inside the runner process, the runner is spawned with an `ipc` slot below, and
// the number is a message. Nothing is created, so no kill can leave anything.
//
// Measured 2026-08-17 (Windows 11, node v24.18.0), with the runner spawned this
// way: `message` arrives before `disconnect`, `exit` and `close`, in that order,
// on a green run and on a run of zero tests alike; the per-file test children do
// not inherit the channel (fd 3 is EBADF in them), so nothing but the runner can
// hold `close` open. A run killed mid-flight — either watchdog — delivers no
// message, which is exactly what the file did too: the reporter only knows the
// total once the event stream has ended, so the file was there and empty. The
// count is read only where the run claims success, and a killed run does not.
const COUNT_REPORTER = new URL('./test-count-reporter.mjs', import.meta.url).href;

// Node zips --test-reporter with --test-reporter-destination positionally and
// refuses a run whose two counts differ, so attaching one of ours means
// spelling out a destination for every reporter already on the line. Ours goes
// first in both lists, which pairs it with its own destination whatever follows
// — stdout, like the rest, and it writes not a byte there.
//
// In front of everything, not appended: node stops reading its own options at
// the first positional argument, and the test patterns are positionals. Placed
// after them the counter is silently taken for another pattern — the run looks
// normal and the count never appears (measured, and the whole guard was dead).
function withCounter(args) {
  const given = (flag) => args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`)).length;
  const reporters = given('--test-reporter');
  const spelled = [];
  if (reporters === 0) {
    // Naming a reporter suppresses the default one, so where there was none the
    // default has to be named too — and it cannot simply be asked for. Which
    // one it is has changed: the documented rule is spec on a TTY and tap
    // otherwise, while node v24.18.0 measured here prints spec through a pipe.
    // Pinning it makes this wrapper's output the same on every version.
    spelled.push('--test-reporter=spec', '--test-reporter-destination=stdout');
  } else if (given('--test-reporter-destination') === 0) {
    for (let i = 0; i < reporters; i += 1) spelled.push('--test-reporter-destination=stdout');
  }
  return [
    `--test-reporter=${COUNT_REPORTER}`,
    '--test-reporter-destination=stdout',
    ...spelled,
    ...args,
  ];
}

// null when git is missing or this is not a repository — then there is nothing
// to compare and the check simply does not apply.
function workingCopy() {
  const res = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  return new Set(res.stdout.split('\n').filter((line) => line.trim() !== ''));
}

// The runner runs each test file in a child of its own, and the one that hangs
// is that grandchild — killing the runner alone would leave it running and
// costing (T-0193 is the same lesson about agent sessions). `taskkill /t` is the
// hardest reach Windows has; on POSIX the run leads its own process group, so
// one signal to the group ends all of it.
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function runSuite() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, withCounter(testArgs), {
      stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
    });

    // null until the counting reporter speaks, and still null if it never does:
    // a run that cannot account for a single test is no more green than one that
    // ran none. There is no second way to learn this number, deliberately.
    let executed = null;
    child.on('message', (message) => {
      if (message?.type === COUNT_MESSAGE && Number.isInteger(message.executed)) {
        executed = message.executed;
      }
    });

    let hung = false;
    let timer;
    // One timer, whichever span the run is in: the budget always REPLACES the
    // one before it. Arming a second without clearing the first would leave a
    // spent budget live to kill a run that had since started talking.
    const bound = (ms, message) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        hung = true;
        console.error(message);
        killTree(child.pid);
      }, ms);
    };

    const heard = (chunk, out) => {
      out.write(chunk);
      bound(SILENCE_LIMIT_MS, SILENCE_KILLED);
    };

    child.stdout.on('data', (chunk) => heard(chunk, process.stdout));
    child.stderr.on('data', (chunk) => heard(chunk, process.stderr));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 1, hung, error, executed });
    });
    // `close` and not `exit`: it is the one that waits for the channel the count
    // came over, along with the two pipes.
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, hung, executed });
    });
    bound(STARTUP_LIMIT_MS, STARTUP_KILLED);
  });
}

const before = workingCopy();
const run = await runSuite();
const after = workingCopy();
const executed = run.executed;

let dirty = false;
if (before && after) {
  const added = [...after].filter((entry) => !before.has(entry));
  if (added.length) {
    dirty = true;
    console.error(
      ['', 'The test run left the working copy dirty:', ...added.map((e) => `  ${e}`),
        'A test must write only inside a temporary directory (CONTRIBUTING.md).'].join('\n')
    );
  }
}

const failed = run.status !== 0 || run.hung || run.error !== undefined;

// Only where the run claims success: a run that already failed was ended from
// outside as often as not, and its count says nothing about anything.
let ranNothing = false;
if (!failed && !(executed > 0)) {
  ranNothing = true;
  console.error(
    ['',
      executed === null
        ? 'briefboard: the run left no count of what it executed — that is a failure, not a pass.'
        : 'briefboard: the run executed no tests — that is a failure, not a pass.',
      `Nothing matched: ${testArgs.filter((arg) => !arg.startsWith('--')).join(' ')}`,
      'In an installed copy of the package this is expected: tests/ is not published.',
      'The suite runs from a clone of the repository (CONTRIBUTING.md).'].join('\n')
  );
}

process.exit(failed || dirty || ranNothing ? run.status || 1 : 0);
