'use strict';

// Removing a directory the suite created, once the operating system lets go of
// it (T-0195, T-0197).
//
// Both cards were one-off EPERM failures in TEARDOWN — never in the subject of a
// test — on a directory a session had run in. What follows was measured here on
// 2026-08-16 (Windows 11, node v24.18.0), not assumed.
//
// WHO HOLDS IT. A live process whose CWD is the directory: `rm` then fails with
// EPERM on the directory itself. An open file handle INSIDE it holds nothing —
// libuv opens with share-delete, so the file goes to pending-delete and the
// directory still goes. The holder of a session's project directory is therefore
// the session's own process, through its cwd, and never the log it writes.
//
// FOR HOW LONG. The cwd outlives the process. Timing kill-then-remove cycles,
// with the clock started the moment `process.kill(pid, 0)` first answers ESRCH:
//   idle:                    n=60, held in 60 of 60, p50 16 ms, p95 28 ms, max 39 ms
//   four concurrent suites:  n=22, held in 21 of 22, p50  1 ms, p95 206 ms, max 1.0 s
// So "the process is gone" is never the moment the directory can be removed, and
// a teardown that removes it then is racing the OS every single time. The race is
// merely usually won.
//
// WHY THE OLD GUARD LOST IT. It was not a guard. `fs.rmSync(dir, { recursive:
// true, force: true, maxRetries: 20, retryDelay: 100 })` reads as two seconds of
// waiting; measured, it throws EPERM after 1 ms and spends none of it — the same
// for a child file locked without share-delete, and the same as the call with no
// options at all. A window of tens of milliseconds was lost because nothing was
// waiting out any part of it. T-0200 carries that measurement to the call sites
// that still believe in the option.
//
// Hence: the retrying is done here, where it is real, and what is waited for is
// what is actually needed — that the directory is gone — rather than a process
// dying or a log closing, neither of which implies it.

const fs = require('node:fs');

// Raised while something still holds the directory or an entry in it, and all
// transient on the way out of a process. ENOTEMPTY is what a fixture still
// writing inside the tree produces — that is how this file's own after() died in
// one of the runs T-0182 was filed on. ENOENT is absent because force:true
// already counts "already gone" as success.
const TRANSIENT_RM_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

// WHAT THIS BUDGET REALLY BOUNDS — remeasured 2026-08-17 (T-0238), and it is not
// the lag above.
//
// The 10 s here was ten times the 1.0 s worst case of the cwd lag. Four
// concurrent full suites of the grown suite then failed four teardowns a run on
// it, so every removeTree call was instrumented — its elapsed time, its first
// errno, and, at the moment of that first EPERM, whether a session process the
// product had started INSIDE that very directory was still alive. Windows 11,
// node v24.18.0, 24 cores, four concurrent full suites, 95 blocked removals:
//
//   a session process of that directory still ALIVE at the first EPERM
//                            n=32 of 44 probed, p50 13.3 s, p95 20.7 s, max 21.1 s
//   all of them already gone — the pure cwd lag measured above
//                            n=12 of 44,        p50 1.5 s,  p95 2.4 s,  max 2.4 s
//
// So the case that dominates is not a directory waiting on the operating system
// but a process tree still being killed, and against it 10 s was under the p50:
// it never had a chance. The pure lag, meanwhile, has grown 1.0 s → 2.4 s on the
// same machine, which alone would not have justified moving anything.
//
// WHY A PROCESS IS STILL ALIVE THERE, given that the teardowns await
// `runner.shutdown()` first: because that promise is bounded at
// SHUTDOWN_RELEASE_MS = 5 s on purpose (server/sessions.js) and stops waiting for
// a tree that has not finished dying — under this load a `taskkill /t /f` and its
// reaping do not fit in 5 s. The board is behaving as designed; the teardown is
// simply removing while the kill is still in flight.
//
// WHY THE WAIT IS STILL FOR THE DIRECTORY and not for those processes, which is
// the other fix T-0238 offered: the cwd outlives the process (the measurement at
// the top of this file), so "the process is gone" would be a wait that ends too
// early and would have to be followed by this one anyway. Waiting for what is
// actually needed costs no more and cannot be short.
//
// 45 s is a little over twice the 21.1 s worst case, and still leaves 75 s of the
// 120 s per-test backstop (tools/test-run.mjs) — a directory genuinely held by
// something that will never let go still fails the teardown with the message
// below rather than eating the run's timeout and reporting a hang. Nothing stops
// being noticed that was noticed at 10 s: the same failure, later.
// Raise it only against a fresh measurement.
const RM_BUDGET_MS = 45000;
const RM_POLL_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rmOnce = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/**
 * Removes `dir` and everything under it, waiting out the transient codes above
 * and no others. Bounded: a directory that will not go throws once the budget is
 * spent, so a teardown can fail but can never hang.
 *
 * `rm` is injectable because the failure this waits out only happens on Windows,
 * and the retrying has to be testable where it does not (tests/rm-helper.test.js).
 */
async function removeTree(dir, { budgetMs = RM_BUDGET_MS, rm = rmOnce } = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      rm(dir);
      return;
    } catch (e) {
      if (!TRANSIENT_RM_CODES.has(e.code)) throw e;
      if (Date.now() >= deadline) {
        throw new Error(
          `${dir} was still held ${budgetMs}ms after the test ended (${e.code}): ` +
            'something the test started is still running in it',
          { cause: e }
        );
      }
      await sleep(RM_POLL_MS);
    }
  }
}

module.exports = { removeTree, RM_BUDGET_MS, RM_POLL_MS, TRANSIENT_RM_CODES };
