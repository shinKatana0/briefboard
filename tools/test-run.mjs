// `npm test`: runs the suite under a watchdog, then fails if the run left the
// working copy dirtier than it found it (T-0111). A test that writes into the
// repository instead of a temporary directory is a bug in the test, and one the
// run cannot clean up after itself: a killed process never reaches its restoring
// `finally`, and the next run then reads the polluted file as the "original".

import { spawn, spawnSync } from 'node:child_process';

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
// for the slowest test and 71s for the slowest whole file.
const SILENCE_LIMIT_MS = Number(process.env.BRIEFBOARD_SILENCE_MS || Number(TEST_TIMEOUT_MS) * 3);

const DEFAULT_TEST_ARGS = [
  '--test',
  TIMEOUT_ARG,
  '--test-reporter=./tools/test-reporter-compact.mjs',
  'tests/**/*.test.js',
];

const argv = process.argv.slice(2);
const testArgs = argv.length ? ['--test', TIMEOUT_ARG, ...argv] : DEFAULT_TEST_ARGS;

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
    const child = spawn(process.execPath, testArgs, {
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let hung = false;
    let timer;
    const heard = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        hung = true;
        console.error(
          [
            '',
            `briefboard: the test run printed nothing for ${SILENCE_LIMIT_MS}ms and was killed.`,
            `Every test is bounded (${TIMEOUT_ARG}), so silence this long is not a slow test:`,
            'it is a test that hung while holding the event loop open. The run had already',
            'ended that test and could not leave (T-0124, T-0245).',
            'The report of the run dies with it. `npm run test:verbose` names every test as it',
            'finishes, so its last line before the silence is where to look.',
          ].join('\n')
        );
        killTree(child.pid);
      }, SILENCE_LIMIT_MS);
    };

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      heard();
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      heard();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 1, hung, error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, hung });
    });
    heard();
  });
}

const before = workingCopy();
const run = await runSuite();
const after = workingCopy();

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
process.exit(failed || dirty ? run.status || 1 : 0);
