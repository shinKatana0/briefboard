'use strict';

// Every wait a server test makes has an upper bound. Unbounded, a single one of
// them turns a server that stopped answering into a run that never ends: the
// worker sits at 0% CPU, the child process is alive, and nothing ever fails
// (T-0124 — observed three times in ~30 runs, one of them waited 25 minutes).
//
// Three waits, three bounds:
//   fetch()          — no request can outlive its deadline;
//   waitUntilReady() — the WHOLE readiness loop is bounded, not the gap between
//                      attempts: one stalled request used to disable the loop's
//                      own deadline and the race against an early exit at once;
//   stopProcess()    — killing a child cannot wait forever for its 'exit'.

const { SPAWN_WAIT_BUDGET_MS } = require('./wait.js');

const DEFAULT_FETCH_TIMEOUT_MS = 20000;

// One endpoint is not the board answering a request: POST /api/task/:id/start
// runs a whole `git worktree add` before it replies. Measured under four
// concurrent suites (2026-08-17, Windows 11, node v24.18.0, 24 cores, every
// deadline lifted so nothing was censored): of 9268 requests, 21 went over the
// 20 s default and 20 of those were this one — max 29.1 s, and above 25 s it was
// the only endpoint left. So the budget moves for the calls that do the work,
// and the other 9247 requests keep the 20 s that bounds a board that has stopped
// answering (T-0124). Twice the worst case seen (T-0223).
const SESSION_START_TIMEOUT_MS = 60000;

// What the readiness loop waits for is not the board's speed but the machine
// getting round to a process the suite has just spawned — the same external
// circumstance SPAWN_WAIT_BUDGET_MS was measured for, and no test here asserts
// how fast a board comes up. At 10 s it was under that measurement: readiness
// alone came to p99 7.9 s and max 10.5 s over 1260 boards in the runs above, so
// the budget fired on the machine rather than on anything briefboard did (2 to 3
// of every 4 loaded runs, T-0225 item 1). It is now the suite's one number for
// this, 2.9x the worst case seen.
const DEFAULT_READY_TIMEOUT_MS = SPAWN_WAIT_BUDGET_MS;
const DEFAULT_EXIT_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTimeout(err) {
  return err && (err.name === 'TimeoutError' || (err.cause && err.cause.name === 'TimeoutError'));
}

function targetOf(input) {
  return typeof input === 'string' ? input : (input && input.url) || String(input);
}

// Import this as `fetch` (`const { fetch } = require('./helpers/bounded.js')`):
// the module-scoped binding shadows the global one, so every call site in the
// file gets a deadline without being rewritten. `init.timeoutMs` overrides it
// for a single call; an `init.signal` of the caller's own still applies, the
// deadline is added to it.
async function fetch(input, init = {}) {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...rest } = init;
  const limit = AbortSignal.timeout(timeoutMs);
  const signal = rest.signal ? AbortSignal.any([rest.signal, limit]) : limit;
  try {
    return await globalThis.fetch(input, { ...rest, signal });
  } catch (err) {
    if (isTimeout(err)) {
      throw new Error(`no response from ${targetOf(input)} within ${timeoutMs}ms`, { cause: err });
    }
    throw err;
  }
}

// Polls the server root until it answers 200. Each attempt is given only the
// time that is left, so a request that never returns costs the loop its
// deadline and nothing more.
async function waitUntilReady(baseUrl, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (let left = timeoutMs; left > 0; left = deadline - Date.now()) {
    try {
      const res = await fetch(baseUrl + '/', { timeoutMs: left });
      await res.arrayBuffer();
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(50);
  }
  throw new Error(
    `server at ${baseUrl} did not become ready within ${timeoutMs}ms: ${lastErr && lastErr.message}`
  );
}

// Resolves with the exit code, or rejects once the wait is over. The listener is
// removed on the way out so a later exit cannot resolve a settled promise.
function waitForExit(proc, timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve, reject) => {
    const onExit = (code) => {
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      proc.removeListener('exit', onExit);
      reject(new Error(`process ${proc.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once('exit', onExit);
  });
}

// Kills a child and waits, bounded, for it to actually go. A child that ignores
// the first signal is escalated to SIGKILL rather than waited on; only a child
// that survives even that is worth failing a test over.
async function stopProcess(proc, timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
  try {
    await waitForExit(proc, timeoutMs);
    return;
  } catch {
    proc.kill('SIGKILL');
  }
  await waitForExit(proc, 5000); // rejects if the process is truly unkillable
}

module.exports = {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  SESSION_START_TIMEOUT_MS,
  DEFAULT_EXIT_TIMEOUT_MS,
  fetch,
  waitUntilReady,
  waitForExit,
  stopProcess,
};
