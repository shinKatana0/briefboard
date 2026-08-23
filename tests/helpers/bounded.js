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
//   stopProcess()    — killing a child cannot wait forever for its 'exit';
//   waitForExit()    — nor can waiting out a process the test spawned, which is
//                      a different wait with a different cost (T-0271, below).

const { SPAWN_WAIT_BUDGET_MS } = require('./wait.js');
const timing = require('./timing.js');

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
// Two waits wore one number, and they are not the same wait (T-0271). Timed
// across the whole suite, quiet and under four concurrent suites (2026-08-23,
// Windows 11, node v24.18.0, 24 cores; `--timing-dir`, 2 loaded rounds):
//
//   after a kill, in stopProcess()      n=373/2984  p50 26ms/33ms   max 150ms/940ms
//   the whole life of a spawned process n=34/272    p50 213ms/530ms max 1.47s/6.73s
//
// Twenty times apart at p50, and for a reason: the second is not an exit at all.
// `spawnServer()` in tests/server-startup.test.js and `runServe()` in
// tests/init-cli.test.js call waitForExit() on a process they have only just
// spawned, so what that wait pays for is node booting, the module graph loading
// and the argument being refused — process START-UP, which is the one thing that
// has become expensive: measured in the same rounds, spawn to a board answering
// costs p99 1.45s quiet and 6.52s loaded, x4.5, and a bare `git` process x4.8.
// Both failures on T-0271 are of that second kind.
//
// So the exit keeps the number meaning "a process told to die has had long
// enough", 16x the worst kill-exit seen; and the wait that is really a spawn
// wait gets the number this suite already measured for spawn waits, exactly as
// waitUntilReady() above does and for the same reason. What the budget still
// catches is unchanged and is all it was ever for: a process that never exits.
// Neither number was moved to make a red run green — no run in either loaded
// round reached either of them.
const DEFAULT_EXIT_TIMEOUT_MS = 15000;
const SPAWNED_LIFETIME_BUDGET_MS = SPAWN_WAIT_BUDGET_MS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTimeout(err) {
  return err && (err.name === 'TimeoutError' || (err.cause && err.cause.name === 'TimeoutError'));
}

function targetOf(input) {
  return typeof input === 'string' ? input : (input && input.url) || String(input);
}

// ---------- measurement only (T-0270): who closed the socket ----------
// `read ECONNRESET` is a connection the OTHER side dropped, and the three ways
// that happens are told apart by facts undici already publishes and nobody was
// listening to: whether this request opened a connection of its own or reused a
// pooled one, and how long that pool had been idle. A request that reuses a
// socket the board has since closed on its keep-alive timeout is the classic
// source of exactly this error; a request that opened its own connection and
// still got reset was dropped by a server that was there to answer it.
// Subscribed only while a measuring round is on, so the suite pays nothing.
let connects = 0;
let connectErrors = 0;
let lastSocket = null; // origin -> the local port the previous request went out on
if (timing.enabled) {
  const dc = require('node:diagnostics_channel');
  lastSocket = new Map();
  dc.subscribe('undici:client:connected', () => { connects += 1; });
  dc.subscribe('undici:client:connectError', () => { connectErrors += 1; });
  dc.subscribe('undici:client:sendHeaders', (message) => {
    const socket = message && message.socket;
    const origin = message && message.request && message.request.origin;
    if (socket && origin) lastSocket.set(origin, { port: socket.localPort, at: timing.now() });
  });
}

function originOf(target) {
  try {
    return new URL(target).origin;
  } catch {
    return null;
  }
}

const lastRequestAt = new Map(); // origin -> when the previous request to it finished

// Import this as `fetch` (`const { fetch } = require('./helpers/bounded.js')`):
// the module-scoped binding shadows the global one, so every call site in the
// file gets a deadline without being rewritten. `init.timeoutMs` overrides it
// for a single call; an `init.signal` of the caller's own still applies, the
// deadline is added to it.
async function fetch(input, init = {}) {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...rest } = init;
  const limit = AbortSignal.timeout(timeoutMs);
  const signal = rest.signal ? AbortSignal.any([rest.signal, limit]) : limit;
  if (!timing.enabled) {
    try {
      return await globalThis.fetch(input, { ...rest, signal });
    } catch (err) {
      if (isTimeout(err)) {
        throw new Error(`no response from ${targetOf(input)} within ${timeoutMs}ms`, { cause: err });
      }
      throw err;
    }
  }
  const target = targetOf(input);
  const origin = originOf(target);
  const before = { connects, connectErrors, socket: origin ? lastSocket.get(origin) : null };
  const started = timing.now();
  const idleMs = origin && lastRequestAt.has(origin) ? started - lastRequestAt.get(origin) : null;
  const done = (outcome, extra) => {
    const after = origin ? lastSocket.get(origin) : null;
    if (origin) lastRequestAt.set(origin, timing.now());
    timing.record('fetch', {
      target,
      method: (rest.method || 'GET').toUpperCase(),
      ms: timing.now() - started,
      budgetMs: timeoutMs,
      // How long this origin had gone unasked. A pooled socket the board has
      // already dropped can only be reused after such a gap.
      idleMs,
      // A connection opened for this very request, rather than taken from the pool.
      connected: connects - before.connects,
      connectFailed: connectErrors - before.connectErrors,
      reusedSocket: Boolean(after && before.socket && after.port === before.socket.port),
      outcome,
      ...extra,
    });
  };
  try {
    const res = await globalThis.fetch(input, { ...rest, signal });
    done('ok', { status: res.status });
    return res;
  } catch (err) {
    const code = (err && err.cause && err.cause.code) || (err && err.code) || null;
    done(isTimeout(err) ? 'budget' : 'error', { code, message: String(err && err.message) });
    if (isTimeout(err)) {
      throw new Error(`no response from ${target} within ${timeoutMs}ms`, { cause: err });
    }
    throw err;
  }
}

// Polls the server root until it answers 200. Each attempt is given only the
// time that is left, so a request that never returns costs the loop its
// deadline and nothing more.
async function waitUntilReady(baseUrl, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const started = timing.now();
  let attempts = 0;
  let lastErr;
  for (let left = timeoutMs; left > 0; left = deadline - Date.now()) {
    attempts += 1;
    try {
      const res = await fetch(baseUrl + '/', { timeoutMs: left });
      await res.arrayBuffer();
      if (res.status === 200) {
        timing.record('ready', { ms: timing.now() - started, budgetMs: timeoutMs, attempts, outcome: 'ok' });
        return;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(50);
  }
  timing.record('ready', { ms: timing.now() - started, budgetMs: timeoutMs, attempts, outcome: 'budget' });
  throw new Error(
    `server at ${baseUrl} did not become ready within ${timeoutMs}ms: ${lastErr && lastErr.message}`
  );
}

// Which file asked for the wait — measurement only. `waitForExit` bounds two
// populations that look identical from inside it (T-0271): a process the caller
// spawned moments ago and now waits out from end to end, and a process the
// caller has just killed. One is dominated by how long this machine takes to get
// a process going, the other is an exit and nothing else, and a single budget
// over both cannot be derived from either.
function callerOf() {
  const stack = String(new Error().stack).split('\n').slice(2);
  for (const line of stack) {
    if (line.includes('helpers\\bounded.js') || line.includes('helpers/bounded.js')) continue;
    const match = line.match(/([\w.-]+\.(?:js|mjs)):(\d+)/);
    if (match) return `${match[1]}:${match[2]}`;
  }
  return null;
}

// Resolves with the exit code, or rejects once the wait is over. The listener is
// removed on the way out so a later exit cannot resolve a settled promise.
//
// The default is the LIFETIME budget, because that is what an unqualified call
// is: a test spawns a process and waits it out from end to end. stopProcess()
// below has already sent the signal, so it passes the tighter exit number
// itself. `after` names which of the two a sample belongs to, and is read only
// while a measuring round is on.
function waitForExit(proc, timeoutMs = SPAWNED_LIFETIME_BUDGET_MS, after = 'spawn') {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    const gone = timing.enabled ? callerOf() : null;
    timing.record('exit', { ms: 0, budgetMs: timeoutMs, after, from: gone, outcome: 'already-gone' });
    return Promise.resolve(proc.exitCode);
  }
  const started = timing.now();
  const from = timing.enabled ? callerOf() : null;
  return new Promise((resolve, reject) => {
    const onExit = (code) => {
      clearTimeout(timer);
      timing.record('exit', { ms: timing.now() - started, budgetMs: timeoutMs, after, from, outcome: 'ok' });
      resolve(code);
    };
    const timer = setTimeout(() => {
      proc.removeListener('exit', onExit);
      timing.record('exit', { ms: timing.now() - started, budgetMs: timeoutMs, after, from, outcome: 'budget' });
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
    await waitForExit(proc, timeoutMs, 'kill');
    return;
  } catch {
    proc.kill('SIGKILL');
  }
  await waitForExit(proc, 5000, 'sigkill'); // rejects if the process is truly unkillable
}

module.exports = {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  SESSION_START_TIMEOUT_MS,
  DEFAULT_EXIT_TIMEOUT_MS,
  SPAWNED_LIFETIME_BUDGET_MS,
  fetch,
  waitUntilReady,
  waitForExit,
  stopProcess,
};
