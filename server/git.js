'use strict';

/**
 * What the board knows about git, and the one thing it does to it (T-0148).
 *
 * Until now the board could not tell whether a branch had been merged, so after
 * the verdict it could neither help nor refuse with a reason. `inspect()` reads
 * that state; `removeWorktree()` is the board's FIRST write to git and stays
 * behind the rules of T-0099 — the branch merged AND the tree clean, never
 * `--force`, and a refusal always names its reason.
 *
 * Nothing here merges. That decision is a human's (T-0117) and a button that
 * merges would one day merge the wrong thing.
 *
 * The task id is a query, not a claim: a branch is reported only when git
 * really has it, so a task no worker ever ran on simply has none.
 *
 * `runGit` lives here and is exported because this module is the lowest one that
 * needs it: it knows nothing of the session registry, so server/sessions.js can
 * take it from here and not the other way round (T-0171).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WORKTREE_DIR_PARTS = ['.briefboard', 'worktrees'];
const BRANCH_PREFIX = 'task/';
const TASK_ID_RE = /^T-\d{4}$/;
// Both spellings again, read backwards: which task a branch name belongs to.
const BRANCH_TASK_RE = /^task\/(T-\d{4})(?:-.*)?$/;
// A human is waiting with a card open, so a git call that has not answered by
// now never will as far as this request is concerned. The reads this module
// makes cost ~40ms against this repository; a caller with a command that copies
// files passes its own limit (see the `timeoutMs` option).
const GIT_TIMEOUT_MS = 10_000;

/**
 * Runs git without a shell and never throws: every ending — including "there is
 * no git on this machine" and "git never answered" — comes back as a value,
 * because every caller turns it into a refusal reason rather than an exception.
 */
function runGit(gitBin, args, cwd, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(gitBin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, missing: true, stderr: e.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, missing: e.code === 'ENOENT', stderr: e.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout: stdout.trim(),
        stderr: timedOut ? `git ${args[0]} did not answer in ${timeoutMs}ms` : stderr.trim(),
      });
    });
  });
}

/**
 * The board's git surface for one project.
 *
 * `inspect(id)` costs one git call for a task with neither branch nor worktree
 * (the archived majority) and four for a card actually being closed — measured
 * at ~40ms and ~130ms on Windows. That is why it is asked on demand, when a
 * card is opened or rechecked, and never per SSE frame: the board repaints on
 * every backlog write, and git state does not change with the backlog.
 */
function createGitOps({ project, git = 'git' } = {}) {
  // Concurrent asks for the same task share one answer instead of multiplying
  // git processes; nothing is cached past that, so a recheck after a merge in
  // the terminal always reads git afresh.
  const inFlight = new Map();

  function worktreePathFor(taskId) {
    return path.join(project, ...WORKTREE_DIR_PARTS, taskId);
  }

  // A directory without .git is not a worktree: a stray leftover must not be
  // reported as one, and must not be offered for removal.
  function existingWorktree(taskId) {
    const dir = worktreePathFor(taskId);
    return fs.existsSync(path.join(dir, '.git')) ? dir : null;
  }

  // Both spellings the project uses: `task/T-0007` from the board's own runner,
  // `task/T-0007-short-slug` from a worker that made its branch by hand.
  async function branchesFor(taskId) {
    const refs = await runGit(
      git,
      [
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/heads/${BRANCH_PREFIX}${taskId}`,
        `refs/heads/${BRANCH_PREFIX}${taskId}-*`,
      ],
      project
    );
    if (!refs.ok) {
      return {
        error: refs.missing ? 'no-git' : 'not-a-repo',
        detail: refs.stderr || `${project} is not a git working tree`,
      };
    }
    return { branches: refs.stdout ? refs.stdout.split('\n').map((s) => s.trim()) : [] };
  }

  async function inspectNow(taskId) {
    const state = {
      git: 'ok',
      head: null,
      branch: null,
      branches: [],
      merged: null,
      worktree: null,
      worktreeClean: null,
    };
    const found = await branchesFor(taskId);
    if (found.error) return { ...state, git: found.error, detail: found.detail };
    state.branches = found.branches;
    // Several matches are not resolved by guessing: a stale `-v2` branch next to
    // the real one has happened here, and picking either would be an invention.
    if (found.branches.length === 1) state.branch = found.branches[0];
    state.worktree = existingWorktree(taskId);

    // In parallel: none of the three reads the others' answer, and a git process
    // costs ~230ms on Windows against this repository — sequentially that is the
    // difference between a card that fills in at once and one that visibly waits.
    const [head, ancestor, status] = await Promise.all([
      state.branch ? runGit(git, ['rev-parse', '--abbrev-ref', 'HEAD'], project) : null,
      // Merged into whatever the checkout is on, not into a hard-coded `main`:
      // the board must not invent the name of the user's integration branch.
      state.branch ? runGit(git, ['merge-base', '--is-ancestor', state.branch, 'HEAD'], project) : null,
      state.worktree ? runGit(git, ['status', '--porcelain'], state.worktree) : null,
    ]);
    if (head) state.head = head.ok ? head.stdout : null;
    if (ancestor) {
      if (ancestor.ok) state.merged = true;
      else if (ancestor.code === 1) state.merged = false;
      else state.detail = ancestor.stderr;
    }
    if (status) {
      if (status.ok) state.worktreeClean = status.stdout === '';
      else state.detail = status.stderr;
    }
    return state;
  }

  function inspect(taskId) {
    if (!TASK_ID_RE.test(taskId)) return Promise.reject(new Error(`bad task id: ${taskId}`));
    const running = inFlight.get(taskId);
    if (running) return running;
    const promise = inspectNow(taskId).finally(() => inFlight.delete(taskId));
    inFlight.set(taskId, promise);
    return promise;
  }

  /**
   * What git has for EVERY task at once (T-0159), in three calls that do not
   * grow with the board: the task branches that exist, which of them carry
   * commits HEAD does not have, and what HEAD is called.
   *
   * This is the shape the watchdog needs and `inspect()` is not: asking
   * `inspect()` for each suspicious card is four git processes per card, while
   * `git for-each-ref` answers for all of them in one. The three run in
   * parallel, so a survey costs about what ONE git invocation costs on the
   * machine — measured against this repository (130 task branches) at 190ms and,
   * on the same machine with a virus scanner in the way, at 900ms, against
   * 530-900ms for a single `for-each-ref` in that same state. What it does not
   * do is grow with the board: ten tasks and a thousand cost the same three
   * processes.
   *
   * The unmerged half is the same question `inspect()` asks with
   * `merge-base --is-ancestor`, so the two can never disagree about a branch.
   * When only that call fails, `unmergedKnown` says so and stays a null answer
   * rather than an invented "nothing is unmerged".
   *
   * Worktrees are deliberately not looked at: that is a stat() per task, and
   * every discrepancy the watchdog reports is about branches and commits.
   */
  async function survey() {
    const pattern = `refs/heads/${BRANCH_PREFIX}`;
    const at = (args) => runGit(git, args, project);
    const [all, unmerged, head] = await Promise.all([
      at(['for-each-ref', '--format=%(refname:short)', pattern]),
      at(['for-each-ref', '--no-merged', 'HEAD', '--format=%(refname:short)', pattern]),
      at(['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    if (!all.ok) {
      return {
        git: all.missing ? 'no-git' : 'not-a-repo',
        detail: all.stderr || `${project} is not a git working tree`,
        head: null,
        unmergedKnown: false,
        byTask: {},
      };
    }
    const byTask = {};
    const forTask = (name) => {
      const match = name.match(BRANCH_TASK_RE);
      if (!match) return null;
      if (!byTask[match[1]]) byTask[match[1]] = { branches: [], unmerged: [] };
      return byTask[match[1]];
    };
    const lines = (result) => (result.stdout ? result.stdout.split('\n').map((s) => s.trim()) : []);
    for (const name of lines(all)) {
      const entry = forTask(name);
      if (entry) entry.branches.push(name);
    }
    // An unborn HEAD (a repository whose first commit is not made yet) fails
    // both of the calls below and no branch can exist there anyway.
    if (unmerged.ok) {
      for (const name of lines(unmerged)) {
        const entry = forTask(name);
        if (entry) entry.unmerged.push(name);
      }
    }
    return {
      git: 'ok',
      head: head.ok && head.stdout ? head.stdout : null,
      unmergedKnown: unmerged.ok,
      byTask,
    };
  }

  /**
   * Removes the worktree of a task, and only under the rules of T-0099: the
   * branch exists, is merged, and its tree is clean. `--force` is not a fallback
   * here and never will be — it throws away the only copy of work an agent never
   * committed. Refusals come back as { ok: false, reason } for the caller to
   * translate; the branch and its commits are never touched.
   */
  async function removeWorktree(taskId) {
    const state = await inspect(taskId);
    if (state.git !== 'ok') return { ok: false, reason: state.git, detail: state.detail };
    if (!state.worktree) return { ok: false, reason: 'no-worktree' };
    if (!state.branch) {
      return {
        ok: false,
        reason: state.branches.length > 1 ? 'ambiguous-branch' : 'no-branch',
        detail: state.branches.join(', '),
      };
    }
    if (state.merged !== true) return { ok: false, reason: 'not-merged', detail: state.branch };
    if (state.worktreeClean !== true) return { ok: false, reason: 'dirty', detail: state.worktree };
    const removed = await runGit(git, ['worktree', 'remove', state.worktree], project);
    if (!removed.ok) {
      return {
        ok: false,
        reason: removed.missing ? 'no-git' : 'remove-failed',
        detail: removed.stderr,
      };
    }
    return { ok: true, worktree: state.worktree };
  }

  return { inspect, survey, removeWorktree, worktreePathFor };
}

module.exports = {
  createGitOps,
  runGit,
  GIT_TIMEOUT_MS,
  WORKTREE_DIR_PARTS,
  BRANCH_PREFIX,
  BRANCH_TASK_RE,
};
