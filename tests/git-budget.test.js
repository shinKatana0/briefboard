'use strict';

// T-0312: what GET /api/git/:id may spend answering, and why that is one number
// rather than `GIT_TIMEOUT_MS` however many times `inspect()` calls git.
//
// `inspectNow` asks git once and then, knowing the branch, up to three times
// more — a SEQUENTIAL pair — so a per-call bound of 10s let the endpoint spend
// 20s, which is exactly the fetch budget this suite gives a request. Two equal
// budgets mean the client gives up at the instant the board would have
// answered, and the answer that is lost is the useful one: it names which git
// call did not come back.
//
// The `git` here is node itself. git's first argument is its verb and node's
// first argument is the script it runs, so a file named `rev-parse` in the
// directory git would have run in IS this fixture's `git rev-parse`: an
// executable that answers, or one that never does. That is what lets these
// tests reach the deadline in a fraction of a second instead of spending the
// real budget they are about — a test that spends a budget is the family of
// problem this card belongs to (T-0311).
// Run with: npm test

require('./helpers/env.js');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createGitOps,
  GIT_TIMEOUT_MS,
  INSPECT_BUDGET_MS,
  REMOVE_WORKTREE_BUDGET_MS,
  WORKTREE_DIR_PARTS,
} = require('../server/git.js');
const { DEFAULT_FETCH_TIMEOUT_MS } = require('./helpers/bounded.js');
const { tempDir } = require('./helpers/tmp.js');

const TASK = 'T-0014';
const BRANCH = `task/${TASK}`;

// Never answers and never exits: the git call the board is waiting on when a
// person is looking at a board that will not fill in.
const HANGS = 'setInterval(() => {}, 1000);\n';
const answers = (line) => `console.log(${JSON.stringify(line)});\n`;
const exits = (code) => `process.exit(${code});\n`;

// As short as a deadline can be, for the one test where the very first git call
// is the one that never answers, so nothing has to finish inside it.
const TINY_BUDGET_MS = 50;

/**
 * The bound the CODE chose for the git call that never came back, read out of
 * `runGit`'s own message.
 *
 * This is the load-immune half of every deadline assertion in this file
 * (T-0318). A wall clock measures the machine as much as the code — under four
 * concurrent suites a node start-up grows x4.5 (T-0271) — while this number is
 * what the deadline arithmetic produced and is the same on a busy box as on an
 * idle one. A call bounded by what its operation has left can never exceed that
 * operation's budget; a call left on its own GIT_TIMEOUT_MS says 10000.
 */
const boundIn = (detail) => Number(String(detail).match(/did not answer in (\d+)ms/)[1]);

/** A project directory whose `git <verb>` is the node script named `<verb>`. */
function fakeGit(verbs) {
  const project = tempDir('briefboard-git-budget-');
  for (const [verb, body] of Object.entries(verbs)) {
    fs.writeFileSync(path.join(project, verb), body);
  }
  return project;
}

const ops = (project, inspectBudgetMs) =>
  createGitOps({ project, git: process.execPath, ...(inspectBudgetMs ? { inspectBudgetMs } : {}) });

/**
 * The same fixture with a worktree `removeWorktree()` will agree to remove: a
 * directory holding a `.git`, which is what `existingWorktree()` looks for, and
 * its own `status` — `git status --porcelain` is the one call this module makes
 * INSIDE the worktree, so its verb has to be a script there rather than in the
 * project.
 */
function fakeGitWithWorktree(verbs, worktreeVerbs) {
  const project = fakeGit(verbs);
  const worktree = path.join(project, ...WORKTREE_DIR_PARTS, TASK);
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere\n');
  for (const [verb, body] of Object.entries(worktreeVerbs)) {
    fs.writeFileSync(path.join(worktree, verb), body);
  }
  return { project, worktree };
}

// Everything `removeWorktree` checks before it removes anything, all answering:
// one branch, merged, and a clean tree.
const REMOVABLE = { 'for-each-ref': answers(BRANCH), 'rev-parse': answers('main'), 'merge-base': exits(0) };
const CLEAN = { status: answers('') };

describe('inspect() answers within a budget of its own (T-0312)', () => {
  // A budget the second test can only reach in its SECOND phase, sized from
  // what this machine costs rather than from a number picked here: the deadline
  // these tests reach has to be the deadline and never a machine that was busy.
  // A healthy inspect is two node start-ups in a row and only the first has to
  // finish inside the budget, so three times one start-up is the margin — and
  // start-up is measured here, in the same run and under the same load as the
  // test, which is what makes it hold when the machine is loaded (it grows
  // x4.5 there, measured 2026-08-23). Still two orders of magnitude under the
  // real INSPECT_BUDGET_MS, which no test here spends.
  let budgetMs = 0;
  let healthyMs = 0;
  let healthy;

  before(async () => {
    healthy = fakeGit({
      'for-each-ref': answers(BRANCH),
      'rev-parse': answers('main'),
      'merge-base': exits(0),
    });
    const at = Date.now();
    await ops(healthy).inspect(TASK);
    // Two node start-ups in a row, on this machine, in this run and under this
    // run's load. Everything below is stated in terms of it, because that is the
    // only cost these tests share with the thing they measure (T-0318).
    healthyMs = Date.now() - at;
    budgetMs = Math.max(400, Math.round((healthyMs / 2) * 3));
  });

  it('a git that never answers is refused, and the refusal names the call', async () => {
    const project = fakeGit({ 'for-each-ref': HANGS });
    // Nothing has to finish before this one: the very first call is the one
    // that never answers, so the budget may be as short as a deadline can be.
    const at = Date.now();
    const state = await ops(project, TINY_BUDGET_MS).inspect(TASK);
    const spent = Date.now() - at;

    assert.strictEqual(state.git, 'timeout', JSON.stringify(state));
    assert.match(state.detail, /git for-each-ref did not answer in \d+ms/);
    // What "reaching the budget must not cost 10s" really asserts, and the form
    // of it that a busy machine cannot break: the bound the code CHOSE for that
    // call. It is the endpoint's remaining deadline, so it can never exceed the
    // budget handed in; a call left on its own GIT_TIMEOUT_MS says 10000 here
    // whatever the machine is doing. The fixture is a script that never answers
    // and cannot produce this number (T-0182).
    assert.ok(
      boundIn(state.detail) <= TINY_BUDGET_MS,
      `the call was given ${boundIn(state.detail)}ms of a ${TINY_BUDGET_MS}ms budget`
    );
    // And the wall clock, against what this run costs rather than a constant.
    // `spent` is one node start-up plus the budget: judged against a fixed 5000ms
    // it failed on a loaded box in 3 of 12 iterations with nothing wrong in the
    // code, which is the whole of T-0318.
    assert.ok(
      spent < TINY_BUDGET_MS + healthyMs,
      `inspect spent ${spent}ms on a ${TINY_BUDGET_MS}ms budget, where two start-ups ` +
        `cost ${healthyMs}ms in this run`
    );
  });

  it('the budget covers the second phase too, which is where the pair adds up', async () => {
    // Phase 1 answers, so phase 2 runs — and it is the two together that used
    // to be able to reach 10s + 10s.
    const project = fakeGit({
      'for-each-ref': answers(BRANCH),
      'rev-parse': HANGS,
      'merge-base': HANGS,
    });
    const at = Date.now();
    const state = await ops(project, budgetMs).inspect(TASK);
    const spent = Date.now() - at;

    assert.strictEqual(state.git, 'timeout', JSON.stringify(state));
    assert.match(state.detail, /git rev-parse did not answer in \d+ms/);
    assert.match(state.detail, /git merge-base did not answer in \d+ms/);
    // What phase 1 did learn is still in the answer: the refusal reports a
    // branch it has, it does not throw away the half that worked.
    assert.deepStrictEqual(state.branches, [BRANCH]);
    // The pair adding up is what this test exists to catch, and the bound the
    // code chose for the SECOND phase is where that would show: on one deadline
    // over both phases it is what the first phase left, always under the budget,
    // while a phase given a fresh backstop of its own says 10000 (T-0318).
    assert.ok(
      boundIn(state.detail) <= budgetMs,
      `phase 2 was given ${boundIn(state.detail)}ms of a ${budgetMs}ms budget: a phase ` +
        `that starts a budget of its own is how inspect could spend 10s + 10s`
    );
    // The wall clock, sized from this run. `spent` is approximately `budgetMs`
    // by construction — the test exists to REACH that deadline — and `budgetMs`
    // is itself sized from what this machine costs, so the fixed 5000ms that
    // stood here reduced to `healthy_inspect < 3333ms` and failed on a loaded
    // box in 3 of 12 iterations with nothing wrong in the code. That is T-0318,
    // and it is T-0314's shape inside T-0312's own test.
    assert.ok(
      spent < budgetMs + healthyMs,
      `inspect spent ${spent}ms on a ${budgetMs}ms budget, where a healthy one ` +
        `costs ${healthyMs}ms in this run`
    );
  });

  it('a git that answers is unaffected: same shape, same values', async () => {
    const state = await ops(healthy).inspect(TASK);
    assert.deepStrictEqual(state, {
      git: 'ok',
      head: 'main',
      branch: BRANCH,
      branches: [BRANCH],
      merged: true,
      worktree: null,
      worktreeClean: null,
    });
  });
});

describe('the endpoint gives up before its client does (T-0312)', () => {
  // The relation, not the numbers: what this card exists to stop is the two
  // becoming equal again, whichever of them someone moves next.
  it('the whole of inspect() is bounded under the fetch budget of a request', () => {
    assert.ok(
      INSPECT_BUDGET_MS < DEFAULT_FETCH_TIMEOUT_MS,
      `the board answers in ${INSPECT_BUDGET_MS}ms and its client waits ` +
        `${DEFAULT_FETCH_TIMEOUT_MS}ms: equal budgets are how the useful message ` +
        `was lost, and a longer one is how it would be lost again`
    );
  });

  it('and not before one git call has had the backstop it always had', () => {
    assert.ok(
      INSPECT_BUDGET_MS > GIT_TIMEOUT_MS,
      `a total of ${INSPECT_BUDGET_MS}ms under the ${GIT_TIMEOUT_MS}ms a single ` +
        `call is given would refuse healthy work: it would cut short the very ` +
        `first call rather than bound the pair`
    );
  });
});

describe('removeWorktree() answers within a budget over BOTH its phases (T-0316)', () => {
  // Sized from what this machine costs, in this run and under this run's load,
  // as the suite above is: a healthy removal is three node start-ups in a row
  // and the first two — the inspect phase — have to finish inside the budget, so
  // a fifth again as long as all three leaves that phase almost double what it
  // needs. Two orders of magnitude under the real REMOVE_WORKTREE_BUDGET_MS,
  // which no test here spends.
  let healthyMs = 0;
  let budgetMs = 0;

  before(async () => {
    const { project } = fakeGitWithWorktree({ ...REMOVABLE, worktree: exits(0) }, CLEAN);
    const at = Date.now();
    await createGitOps({ project, git: process.execPath }).removeWorktree(TASK);
    healthyMs = Date.now() - at;
    budgetMs = Math.max(600, Math.round(healthyMs * 1.2));
  });

  it('a removal that never answers is refused, and the refusal names the call', async (t) => {
    // The test below tells "bounded by what the operation has left" from
    // "bounded by a fresh call of its own" by the NUMBER the code chose, and the
    // two are indistinguishable once the operation's own ceiling is the larger:
    // `remaining()` returns GIT_TIMEOUT_MS either way. On a machine slow enough
    // for that, this test cannot say anything, and saying nothing is what it
    // then does — a red run here would be a fact about the box, which is the
    // mistake this pair of cards exists to stop repeating (T-0314).
    if (budgetMs >= GIT_TIMEOUT_MS) {
      t.skip(`a healthy removal cost ${healthyMs}ms here, so a ${budgetMs}ms ceiling cannot be told from ${GIT_TIMEOUT_MS}ms`);
      return;
    }
    const { project } = fakeGitWithWorktree({ ...REMOVABLE, worktree: HANGS }, CLEAN);
    const at = Date.now();
    const result = await createGitOps({
      project,
      git: process.execPath,
      removeBudgetMs: budgetMs,
    }).removeWorktree(TASK);
    const spent = Date.now() - at;

    assert.strictEqual(result.ok, false, JSON.stringify(result));
    // The same ending `inspect` reports when a call of its own never comes back:
    // one reason for it wherever in the operation it happened, and not the
    // `remove-failed` that means git looked and said no.
    assert.strictEqual(result.reason, 'timeout', JSON.stringify(result));
    assert.match(result.detail, /git worktree did not answer in \d+ms/);
    // The heart of this card. The removal is bounded by what is LEFT of the
    // operation's deadline, not by a fresh GIT_TIMEOUT_MS of its own — which is
    // what let inspect's 14s and the removal's 10s add up to 24s. The number in
    // the message is the bound the code chose, so the fixture — a script that
    // simply never answers — cannot be what makes this true.
    const bound = boundIn(result.detail);
    assert.ok(
      bound <= budgetMs,
      `the removal was given ${bound}ms of a ${budgetMs}ms operation: a phase that ` +
        `starts a budget of its own is how the pair reached INSPECT_BUDGET_MS + GIT_TIMEOUT_MS`
    );
    // And the ceiling was the ending, so this test costs the ceiling and not the
    // real budget it is about. Against the operation's own measured cost rather
    // than a constant: an honest run of this grows x4.5 under load (T-0271), so
    // a fixed number here would fail on a busy machine instead of on the code.
    assert.ok(
      spent < budgetMs + healthyMs,
      `removeWorktree spent ${spent}ms on a ${budgetMs}ms ceiling, where a healthy one ` +
        `costs ${healthyMs}ms: a phase given a fresh ${GIT_TIMEOUT_MS}ms is what that looks like`
    );
  });

  // The two below run on the REAL REMOVE_WORKTREE_BUDGET_MS, and deliberately
  // not on the sized one above. What they assert is that a git which answers is
  // unaffected, so the ceiling they should be standing under is the shipped one;
  // and a tight ceiling is only ever needed by a test that means to REACH a
  // deadline. Handing it to these two makes their outcome depend on this run
  // being no slower than the run that sized it — which under load it is not, and
  // one of them failed that way before this was split (measured: 1 of 12 loaded
  // iterations). Neither spends the budget: git answers at once.
  it('a git that answers is unaffected: same result, no budget spent', async () => {
    const { project, worktree } = fakeGitWithWorktree({ ...REMOVABLE, worktree: exits(0) }, CLEAN);
    const result = await createGitOps({ project, git: process.execPath }).removeWorktree(TASK);

    // Also the timing assertion, and a stronger one than a clock reading: an
    // operation that had waited on its deadline would be `timeout`, not `ok`.
    // Nothing is asserted about how many milliseconds it took, which on a
    // machine under load says nothing about this code (T-0314).
    assert.deepStrictEqual(result, { ok: true, worktree });
  });

  it('a refusal git can answer still names its own reason, not the deadline', async () => {
    // The ceiling must not have turned the rules of T-0099 into timeouts: an
    // unmerged branch is refused as `not-merged`, as it always was.
    const { project } = fakeGitWithWorktree(
      { ...REMOVABLE, 'merge-base': exits(1), worktree: exits(0) },
      CLEAN
    );
    const result = await createGitOps({ project, git: process.execPath }).removeWorktree(TASK);

    assert.deepStrictEqual(result, { ok: false, reason: 'not-merged', detail: BRANCH });
  });
});

describe('the composed operation gives up before its client does (T-0316)', () => {
  // The relation, not the numbers — the same guard T-0312 wrote one level down,
  // and the reason this card could be found at all: what must never come back is
  // two budgets adding up past what a client waits.
  it('the whole of removeWorktree is bounded under the fetch budget of a request', () => {
    assert.ok(
      REMOVE_WORKTREE_BUDGET_MS < DEFAULT_FETCH_TIMEOUT_MS,
      `the board answers in ${REMOVE_WORKTREE_BUDGET_MS}ms and its client waits ` +
        `${DEFAULT_FETCH_TIMEOUT_MS}ms: this endpoint's refusal is the one naming which ` +
        `rule stopped the removal, and a client that has given up never reads it`
    );
  });

  it('and the two phases can no longer add up past that ceiling', () => {
    assert.ok(
      REMOVE_WORKTREE_BUDGET_MS < INSPECT_BUDGET_MS + GIT_TIMEOUT_MS,
      `a ceiling of ${REMOVE_WORKTREE_BUDGET_MS}ms over phases free to spend ` +
        `${INSPECT_BUDGET_MS}ms and ${GIT_TIMEOUT_MS}ms bounds nothing: that sum is the ` +
        `24s this card was filed for, and a ceiling at or above it composes nothing`
    );
  });

  it('while leaving inspect the whole budget it was derived for', () => {
    assert.ok(
      REMOVE_WORKTREE_BUDGET_MS > INSPECT_BUDGET_MS,
      `${REMOVE_WORKTREE_BUDGET_MS}ms for both phases would cut inspect short of the ` +
        `${INSPECT_BUDGET_MS}ms it was measured for, refusing healthy work here to bound ` +
        `a pair — which is the one fix this card ruled out`
    );
  });
});
