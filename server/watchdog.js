'use strict';

/**
 * The watchdog (T-0159): what an agent claimed, against what git and the process
 * table show.
 *
 * Every status on this board is written by the agent whose work it describes, so
 * until now nothing checked it. What that costs was observed, repeatedly: a
 * worker committed its work and died before writing the status (T-0118); a
 * session without the permission it needed ran, wrote nothing and exited 0
 * (T-0107); a worktree with no commits in it was cleaned up and took the work
 * with it. A human noticed — if they happened to be looking.
 *
 * This module collects no facts of its own. `server/git.js` already knows which
 * task branches exist and which carry commits HEAD does not have; the session
 * registry (`server/sessions.js`) already knows whether the process is alive.
 * The watchdog only puts the two next to the task's status and reports where
 * they disagree.
 *
 * Three rules it lives by:
 *
 * 1. **Only a discrepancy is news.** Agreement is the normal case and says
 *    nothing. A watchdog that decorates every card teaches people to skip its
 *    marks, and then it is silent on the day it matters.
 * 2. **It reports, it never repairs.** No status is written, no git command that
 *    changes anything is run. The board prepares a decision, a human takes it
 *    (T-0117, T-0122).
 * 3. **It says what it sees, not who is to blame.** "the branch has commits and
 *    the status did not change", never "the worker failed". Why it happened is
 *    not something the board can know.
 *
 * What it deliberately stays quiet about, and why:
 *
 * - **in_progress with no session record at all.** The board only has records
 *   for sessions it started itself. A worker dispatched by an orchestrator in
 *   its own terminal leaves none — which is most of the work done on this very
 *   repository — so a rule that fired here would flag every honestly running
 *   task and nothing else.
 * - **done with no branch.** Deleting the branch after a merge is the cleanup
 *   the guide recommends, and tasks finished without a branch at all are
 *   ordinary. This would light up the whole Done strip to say "normal".
 * - **A branch on a task that never left the backlog, or was cancelled.** An
 *   abandoned branch is what cancelling is supposed to leave behind, and a task
 *   put back into the backlog keeps the branch of its first attempt on purpose.
 * - **A running session on any status.** Work in flight is not a discrepancy; it
 *   is work in flight.
 */

// The lowest status the watchdog will speak about. Everything else on the board
// is either not started yet or deliberately abandoned.
const WATCHED_STATUSES = ['in_progress', 'review', 'done'];

// How rarely the scan may run. It costs three git processes each time whatever
// the size of the board (server/git.js `survey`), so the floor is not about the
// cost of one scan but about a burst: a rework session writing the backlog eight
// times a minute must not turn into eight scans. At this floor the ceiling is 6
// scans — 18 git processes a minute, and under a second of git each, measured —
// while a discrepancy is on screen within ten seconds of the event that made it.
const MIN_INTERVAL_MS = 10_000;

// The floor is the only thing about the watchdog worth configuring, because the
// only thing that varies is what git costs: three calls answer in ~130ms against
// this repository, and a checkout with a hundred thousand refs is a different
// conversation. `off` is there for the same reason — a project whose owner does
// not want the board running git at all should be able to say so once, rather
// than by setting a number so large it means the same thing.
const INTERVAL_ENV = 'BRIEFBOARD_WATCHDOG_MS';
const OFF = 'off';

/**
 * The environment's word turned into milliseconds, or null for off. This is the
 * only place a human's value enters, so the floor is applied here and the number
 * that comes out is never below it (T-0228).
 *
 * It used to be a default rather than a floor, and the two directions of that
 * mistake are not symmetric: nonsense (`abc`, `-1`) fell back to a safe 10000
 * while `0` silently removed the limit, turning every backlog write and every
 * session event into a scan — three git processes each (T-0159 measured one scan
 * at 190ms against this repository, 900ms with a virus scanner busy). `0` is
 * also what someone writes when they mean "off", so the setting that reads as
 * harmless was the one that cost the most.
 *
 * A value under the floor is therefore raised rather than refused, and the
 * message names `off`, which is the thing the writer of `0` was probably after.
 */
function parseInterval(raw, logger = console) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return MIN_INTERVAL_MS;
  if (value.toLowerCase() === OFF) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    logger.error(`${INTERVAL_ENV}: "${value}" is not a number of milliseconds or "${OFF}" — using ${MIN_INTERVAL_MS}ms.`);
    return MIN_INTERVAL_MS;
  }
  if (ms < MIN_INTERVAL_MS) {
    logger.error(
      `${INTERVAL_ENV}: ${ms}ms is below the floor of ${MIN_INTERVAL_MS}ms — using ${MIN_INTERVAL_MS}ms. ` +
        `Write "${OFF}" to stop the board asking git at all.`
    );
    return MIN_INTERVAL_MS;
  }
  return ms;
}

/**
 * The five discrepancies. Each is one line of the same sentence: what the board
 * says, what git and the registry show.
 *
 * `work-not-recorded` and `session-left-nothing` are the two endings of T-0118
 * and T-0107 respectively — the same status, told apart by whether commits
 * exist. `review-without-commits` is derived, not from the brief's table: a
 * branch whose commits are all in HEAD already offers a reviewer exactly as much
 * to read as no branch does, and a worker that made a worktree and never
 * committed in it lands here rather than in the row above.
 */
const KINDS = [
  'work-not-recorded',
  'session-left-nothing',
  'review-without-branch',
  'review-without-commits',
  'done-not-merged',
];

// The registry's own word for "this session is over": `exited` (it ended by
// itself, cleanly or not) and `interrupted` (it went down with the board).
function sessionOver(record) {
  return Boolean(record) && record.status !== 'running';
}

/**
 * The rules themselves, kept pure: tasks in, findings out, nothing spawned and
 * nothing read from disk. `survey` is what server/git.js returned.
 *
 * Returns { id: { kind, branches } } and nothing for a task that agrees with
 * what git shows.
 */
function findingsFor({ tasks = [], sessions = [], survey = {} } = {}) {
  const findings = {};
  if (survey.git !== 'ok') return findings;
  const byTask = survey.byTask || {};
  const bySession = new Map();
  for (const record of sessions) bySession.set(record.id, record);

  for (const task of tasks) {
    if (!WATCHED_STATUSES.includes(task.status)) continue;
    const state = byTask[task.id] || { branches: [], unmerged: [] };
    const branches = state.branches;
    // A branch whose tip HEAD does not already contain: commits of this task's
    // own. Unknowable when that one git call failed, and an unknown answer must
    // not become "there are none" — every rule below that needs it is skipped.
    const carriesCommits = survey.unmergedKnown ? state.unmerged.length > 0 : null;
    const finding = (kind) => {
      findings[task.id] = { kind, branches };
    };

    if (task.status === 'in_progress') {
      // Only the board's own sessions; see the header for why silence is right
      // when there is no record.
      if (!sessionOver(bySession.get(task.id)) || carriesCommits === null) continue;
      finding(carriesCommits ? 'work-not-recorded' : 'session-left-nothing');
      continue;
    }
    if (task.status === 'review') {
      if (!branches.length) finding('review-without-branch');
      else if (carriesCommits === false) finding('review-without-commits');
      continue;
    }
    if (task.status === 'done' && carriesCommits) finding('done-not-merged');
  }
  return findings;
}

/**
 * The scan and its schedule.
 *
 * When it looks is the whole design question (the brief's §4): a discrepancy has
 * to be visible WITHOUT opening the card, so "on demand, when a card is opened"
 * — T-0148's answer for `inspect()` — is exactly the answer that does not work
 * here. It cannot be per repaint either: the board repaints on every backlog
 * write and for every open tab.
 *
 * So it is event-driven and rate-limited. The two events that can create a
 * discrepancy are a session starting or ending and the backlog changing;
 * `schedule()` is called on both, and a call inside the floor is not dropped but
 * deferred to the end of it — dropping it would leave the finding invisible
 * until some unrelated event came along. One scan runs at a time.
 *
 * `onChange` fires only when the findings actually differ from the last ones, so
 * a quiet board pushes nothing to its tabs no matter how often it is scanned.
 *
 * `intervalMs` is already resolved: a number of milliseconds, or null for off.
 * The floor belongs to `parseInterval`, which is what the environment goes
 * through and the only value a user can set; keeping it out of here is what lets
 * the schedule be tested at 300ms without a knob that would let a configuration
 * under the floor as well.
 */
function createWatchdog({
  survey,
  snapshot,
  onChange,
  intervalMs = MIN_INTERVAL_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const disabled = intervalMs === null;
  let state = { checkedAt: null, git: disabled ? 'off' : 'unknown', head: null, findings: {} };
  let signature = JSON.stringify(state.findings);
  let lastScan = -Infinity;
  let timer = null;
  let running = null;
  let pending = false;

  async function scanNow() {
    lastScan = now();
    const result = await survey();
    const { tasks, sessions } = snapshot();
    const findings = findingsFor({ tasks, sessions, survey: result });
    state = {
      checkedAt: new Date().toISOString(),
      git: result.git,
      head: result.head || null,
      findings,
    };
    const next = JSON.stringify(findings);
    if (next === signature) return state;
    signature = next;
    if (onChange) onChange(state);
    return state;
  }

  // Never rejects: a watchdog that throws would take down the caller that only
  // asked it to have a look.
  function scan() {
    if (disabled) return Promise.resolve(state);
    if (running) return running;
    running = scanNow()
      .catch((e) => {
        logger.error(`watchdog: the check failed: ${e.message}`);
        return state;
      })
      .finally(() => {
        running = null;
        if (pending) {
          pending = false;
          schedule();
        }
      });
    return running;
  }

  function schedule() {
    if (disabled || timer) return;
    if (running) {
      pending = true;
      return;
    }
    const wait = Math.max(0, intervalMs - (now() - lastScan));
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, wait);
    // The board must be free to exit while a scan is merely due.
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { scan, schedule, stop, enabled: !disabled, intervalMs, state: () => state };
}

module.exports = {
  createWatchdog,
  findingsFor,
  parseInterval,
  KINDS,
  WATCHED_STATUSES,
  MIN_INTERVAL_MS,
  INTERVAL_ENV,
};
