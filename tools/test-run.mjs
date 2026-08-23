// `npm test` and `npm run test:verbose`: runs the suite under a watchdog, fails
// a run that executed no tests (T-0250), then fails if the run left the working
// copy dirtier than it found it (T-0111). A test that writes into the repository
// instead of a temporary directory is a bug in the test, and one the run cannot
// clean up after itself: a killed process never reaches its restoring `finally`,
// and the next run then reads the polluted file as the "original".

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { COUNT_MESSAGE, RUNNING_MESSAGE } from './test-count-reporter.mjs';

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
// the slowest honest run (343s here quiet and 828s under four concurrent
// suites, measured 2026-08-23 at 2502 tests) and would still be a guess, while
// every finished test prints a mark.
//
// Three times the per-test limit. The reasoning that number was chosen by — a
// `before` hook and the first test under it, each bounded by the limit, so
// twice the limit is the theoretical worst and the budget must be above it —
// is arithmetically fine and describes the wrong thing, which T-0272 measured
// (`--timing-dir`, 2026-08-23, Windows 11 / node v24.18.0 / 24 cores):
//
//   longest stretch with no mark printed   quiet 168.3s   four concurrent suites 249-260s
//
// Against a budget of 360s that is 47% spent before any load, and 72% under the
// rig this suite is argued about on. The old note said "the real numbers are far
// lower: 17.5s for the slowest test and 71s for the slowest whole file", and
// both are still true — they are simply not what bounds the silence.
//
// What bounds it is a run of SYNCHRONOUS tests. node:test reports a file's
// results from that file's own process, so a test that blocks its event loop
// cannot report, and neither can the tests before it in the same uninterrupted
// stretch: measured on three 2s tests, three `await`ed ones print their marks at
// 2.3s / 4.3s / 6.3s and three blocking ones print all four at 6.4s. So
// tests/task-cli.test.js, whose tests drive the CLI with spawnSync, prints
// nothing for the length of a whole describe — 168.3s for `task.mjs list
// --json` alone, with no test in it anywhere near the per-test limit. No
// per-test limit can bound that, and this budget is the only thing that does.
//
// Two consequences, and neither is a reason to raise the number (T-0259, and
// what would stop being caught is in the message below):
//   * the pressure on it comes from the SUITE growing, not from the machine —
//     under four concurrent suites the stretch grew x1.53 while the suite grew
//     x2.41, so a file that gains synchronous tests spends this budget faster
//     than any load does;
//   * the margin is 1.39x, not the ~5x the "slowest test" reading suggests.
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

// What was still running when the trigger was pulled, longest first — and the
// first line is the answer, because anything healthy that started alongside it
// has since completed and left the set. The names come from the counting
// reporter over the same ipc channel as the count (see test-count-reporter.mjs
// for which node:test events carry a name in time to be of any use).
//
// Capped: a run of this suite has 24 files open at once, and a wall of them
// would bury the one line that matters. The cap is on what is PRINTED — the set
// itself is complete, and the count says how much of it was left out.
const RUNNING_SHOWN = 8;

function runningLines(inFlight, at) {
  const all = [...inFlight.values()];
  // The runner dequeues each FILE as a test of its own, named by its path, and
  // that entry is always older than anything inside it — so left in, it would
  // take the first line, which is the one line that has to carry the answer. It
  // is kept only for a file with nothing else open, where it is all there is to
  // say: the file is in a `before` hook, in its own top-level body, or finished
  // holding the event loop open.
  //
  // A file is named by the pattern the runner was given, so that name is its
  // path spelled either absolutely or relatively to the cwd; both are the file.
  const isFile = (e) =>
    e.nesting === 0 && (e.name === e.file || path.resolve(e.name) === path.resolve(e.file));
  const detailed = new Set(all.filter((e) => !isFile(e)).map((e) => e.file));
  const open = all
    .filter((entry) => !isFile(entry) || !detailed.has(entry.file))
    .sort((a, b) => a.since - b.since);
  if (open.length === 0) {
    return ['', 'Nothing was running when it was killed: every test that started had finished.'];
  }
  const name = (entry) => {
    const file = path.relative(process.cwd(), entry.file) || entry.file;
    // A file is dequeued as a test of its own, named by its path; printing that
    // path twice would say nothing.
    return isFile(entry) ? `${file} (the file itself)` : `${file} > ${entry.name}`;
  };
  const shown = open.slice(0, RUNNING_SHOWN);
  return [
    '',
    `Still running when it was killed (${open.length}), longest first:`,
    ...shown.map((entry) => `  ${((at - entry.since) / 1000).toFixed(1)}s  ${name(entry)}`),
    ...(open.length > shown.length ? [`  ... and ${open.length - shown.length} more, all younger`] : []),
    'The first line is where to look: the runner runs many files at once, and',
    'everything healthy that started alongside it has finished by now.',
  ];
}

const silenceKilled = (inFlight, at) => [
  '',
  `briefboard: the test run printed nothing for ${SILENCE_LIMIT_MS}ms and was killed.`,
  `Every test is bounded (${TIMEOUT_ARG}), so silence this long is not a slow test:`,
  'it is a test that hung while holding the event loop open. The run had already',
  'ended that test and could not leave (T-0124, T-0245).',
  ...runningLines(inFlight, at),
  'The report of the run dies with it. `npm run test:verbose` names every test as it',
  'finishes, so its last line before the silence is where to look.',
].join('\n');

// Two spans, two messages, because they are two different diagnoses. A run
// killed once it had spoken has a last line to look at, and now a list of what
// was open when it stopped speaking; a run killed before it ever spoke has
// neither, and pointing at one would send the reader looking for a test that
// never ran.
const STARTUP_KILLED = [
  '',
  `briefboard: the test run said nothing at all in the ${STARTUP_LIMIT_MS}ms it had to start, and was killed.`,
  'No test had reported yet, so there is no last line to look at: what spent the',
  'time was node starting, the runner finding the files, or the first hook.',
  'This budget bounds how fast this machine can get a process going and nothing',
  'the suite decides — BRIEFBOARD_STARTUP_MS is what moves it (T-0266).',
].join('\n');

// Measurement scaffolding: `--timing-dir=PATH` writes what the run cost into
// that directory, and does nothing at all without it. What it keeps is the
// run's silent stretches — the ten longest, each with what was running while
// nothing was printed — and how long every test took.
//
// This is how the two budgets above are re-derived rather than argued about.
// Both were set from a measurement (T-0177, T-0266) and the machine has moved
// since: on 2026-08-23 a QUIET run of this suite went 166.9s without printing a
// mark, against a budget of 360s whose own comment justifies it with "17.5s for
// the slowest test". A number nobody can re-measure goes stale in silence.
//
// A flag and not an environment variable, which is not a matter of taste:
// tests/hermetic-env.test.js collects every environment variable named in
// server/, tools/ and bin/ (prose included — it reads the bytes, so do not
// spell one in a comment) and requires it to be listed in
// tests/helpers/env.js — which DELETES it
// from every test process, so a variable declared there could never reach the
// suite's own half of the same measurement (tests/helpers/timing.js). The
// directory is handed down to the runner from here instead, spelled once.
const TIMING_FLAG = '--timing-dir=';
const timingArg = process.argv.slice(2).find((arg) => arg.startsWith(TIMING_FLAG));
const TIMING_DIR = timingArg ? timingArg.slice(TIMING_FLAG.length) : '';

const silence = (() => {
  const dir = TIMING_DIR;
  if (!dir) return { on: false, gap: () => {}, done: () => {}, write: () => {} };
  const worst = [];
  // The item that finished most recently. A gap is noticed only when output
  // arrives, i.e. just after something completed — so by then the thing that
  // spent the silence has usually left the in-flight set, and without this the
  // longest gaps would all be attributed to the enclosing suite.
  let lastDone = null;
  const tests = [];
  return {
    on: true,
    done(entry) {
      lastDone = { name: `${entry.file} > ${entry.name}`, at: Date.now() };
      tests.push({ file: entry.file, name: entry.name, ms: Date.now() - entry.since });
    },
    gap(ms, inFlight) {
      const startedAt = Date.now() - ms;
      worst.push({
        ms,
        finishedIt: lastDone && lastDone.at >= startedAt ? lastDone.name : null,
        running: [...inFlight.values()]
          .sort((a, b) => a.since - b.since)
          .slice(0, 4)
          .map((entry) => `${entry.file} > ${entry.name}`),
      });
      worst.sort((a, b) => b.ms - a.ms);
      worst.length = Math.min(worst.length, 10);
    },
    write(extra) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `run-${process.pid}.json`),
        JSON.stringify(
          { silenceBudgetMs: SILENCE_LIMIT_MS, worstSilenceMs: worst, ...extra, tests },
          null,
          1
        )
      );
    },
  };
})();

const DEFAULT_TEST_ARGS = [
  '--test',
  TIMEOUT_ARG,
  '--test-reporter=./tools/test-reporter-compact.mjs',
  'tests/**/*.test.js',
];

const argv = process.argv.slice(2).filter((arg) => arg !== timingArg);
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
      // Left alone without the flag, so an ordinary run spawns exactly as before.
      ...(TIMING_DIR ? { env: { ...process.env, BRIEFBOARD_TIMING_DIR: TIMING_DIR } } : {}),
    });

    // null until the counting reporter speaks, and still null if it never does:
    // a run that cannot account for a single test is no more green than one that
    // ran none. There is no second way to learn this number, deliberately.
    let executed = null;
    // What is running right now: key -> { file, name, nesting, since }, one entry
    // per test, suite and file the runner has dequeued and not yet completed.
    // Keyed by all three because a file and the tests directly inside it are all
    // at nesting 0 — the file's own entry is the one whose name is its path, and
    // it is what tells the reader which file to open.
    const inFlight = new Map();
    child.on('message', (message) => {
      if (message?.type === COUNT_MESSAGE && Number.isInteger(message.executed)) {
        executed = message.executed;
      } else if (message?.type === RUNNING_MESSAGE) {
        const key = `${message.file}\u0000${message.nesting}\u0000${message.name}`;
        if (message.open) {
          inFlight.set(key, {
            file: message.file,
            name: message.name,
            nesting: message.nesting,
            since: Date.now(),
          });
        } else {
          const entry = inFlight.get(key);
          if (entry && silence.on) silence.done(entry);
          inFlight.delete(key);
        }
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
        console.error(typeof message === 'function' ? message(inFlight, Date.now()) : message);
        killTree(child.pid);
      }, ms);
    };

    // The longest the run actually went without printing, against the budget
    // that bounds it. A budget is only worth what it is compared with, and this
    // one had never been compared with anything but itself (T-0272).
    let spokeAt = 0;
    const heard = (chunk, out) => {
      const at = Date.now();
      if (spokeAt !== 0) silence.gap(at - spokeAt, inFlight);
      spokeAt = at;
      out.write(chunk);
      bound(SILENCE_LIMIT_MS, silenceKilled);
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
const startedAt = Date.now();
const run = await runSuite();
const wallMs = Date.now() - startedAt;
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

silence.write({ wallMs, executed, status: run.status, hung: run.hung });

process.exit(failed || dirty || ranNothing ? run.status || 1 : 0);
