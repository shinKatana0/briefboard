'use strict';

// One budget for every wait on a process the suite spawned (T-0177, T-0138).
//
// What these waits are: a test starts a session — a `node -e` one-liner, never a
// real agent — and then waits for a condition, that its output reached the log,
// that the registry says it exited, that the SSE frame arrived. The condition is
// the assertion; the deadline exists only so a test FAILS instead of hanging.
// What the deadline actually bounds is when the operating system gets round to
// running the spawned process, which is nothing the board decides.
//
// Measured here on 2026-08-16, by timing every one of these waits on this
// machine:
//   idle, one suite:            n=173, p50 391 ms, p95 1.9 s, max 3.0 s
//   four concurrent suites:     n=690, p50 802 ms, p95 9.4 s, p99 11.3 s, max 13.9 s
//   and again after the change: n=716, p50 554 ms, p95 7.2 s, p99 11.5 s, max 15.7 s
// Against the 5 s each file used to hand-write, 147 of those 690 waits were over
// budget — which is why the session-spawning files failed 32-34 tests per loaded
// run and none at all idle. The old number bounded nothing; it was under the p95
// of the very thing it was waiting for.
//
// 30 s is a little over twice the measured worst case, and it is the number
// T-0138 had already arrived at for the SSE waits of tests/session-runner-api.
// Nothing stops being noticed at 30 s that was noticed at 5: none of these tests
// measures how fast the board is, and the backstop against a genuine hang is not
// this budget but --test-timeout, 120 s per test (tools/test-run.mjs).
//
// Raise it only against a fresh measurement, and never to make a red test green.
const SPAWN_WAIT_BUDGET_MS = 30000;

// How often the condition is re-read. The files this replaced polled at 20, 25
// and 50 ms; nothing measured chose those numbers, and the condition is a file
// read or a `process.kill(pid, 0)`, so the rate is a rounding error next to the
// budget above.
const POLL_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until `predicate()` is true, or fails when the budget is spent. The
 * predicate may be sync or async, and what it returned is handed back: a wait
 * for a pid to appear in a file is followed by a test that wants the pid, and
 * reading it a second time is a second chance for it to have changed.
 *
 * It lives here, once, because of what the ten copies of it got wrong. Written
 * as `if (predicate()) return;` the wait reads an ASYNC predicate's promise as
 * truthy and returns on its first turn: it bounds nothing, the assertion after
 * it is checked against a condition that never arrived, and the request the
 * predicate started is left running with nobody awaiting it. afterEach then
 * kills the board out from under that request, and its rejection reaches no
 * `catch` — the run reports `TypeError: fetch failed` / `read ECONNRESET`
 * against whichever test was current. Idle, the answer beat the teardown and
 * the test passed; under four concurrent suites it did not, in 7 of the 16 such
 * runs captured across T-0138, T-0139 and T-0180 — two of them AFTER T-0180
 * raised the wait budgets, which is how we know the budgets never touched it.
 * Three cards of investigation went to the board before T-0183 traced it to the
 * test. `await` over a non-promise just yields the value, so it costs a sync
 * predicate nothing.
 *
 * The deadline is checked AFTER the condition, not before: a condition that
 * arrives during the last sleep is still seen, and a wait always reads it at
 * least once.
 */
async function waitFor(predicate, timeoutMs = SPAWN_WAIT_BUDGET_MS, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

module.exports = { SPAWN_WAIT_BUDGET_MS, POLL_MS, waitFor };
