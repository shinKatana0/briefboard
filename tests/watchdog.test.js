'use strict';

// The watchdog (T-0159), in three parts and without a server:
//   - `survey()` in server/git.js, against throwaway git repositories;
//   - `findingsFor()`, the rules themselves — what is a discrepancy and, just as
//     importantly, what is not;
//   - `createWatchdog()`, the schedule: how rarely it may ask git and when it
//     tells anyone.
// Every git command here runs inside a directory this file made under the OS
// temp directory; the real repository is never touched.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { createGitOps } = require('../server/git.js');
const {
  createWatchdog,
  findingsFor,
  parseInterval,
  KINDS,
  MIN_INTERVAL_MS,
} = require('../server/watchdog.js');
const { removeTree } = require('./helpers/rm.js');
const { tempDir } = require('./helpers/tmp.js');

// ---------- fixtures ----------

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const roots = [];

// `track` is what the global afterEach cleans up; a fixture shared by a whole
// group has to outlive the first test in it and takes itself down instead.
function makeRepo({ init = true, track = true } = {}) {
  const root = fs.realpathSync(tempDir('briefboard-watchdog-'));
  if (track) roots.push(root);
  fs.writeFileSync(path.join(root, 'readme.txt'), 'x\n');
  if (!init) return root;
  git(['init'], root);
  git(['config', 'user.email', 'test@briefboard.invalid'], root);
  git(['config', 'user.name', 'briefboard test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['add', 'readme.txt'], root);
  git(['commit', '-m', 'init'], root);
  git(['branch', '-M', 'main'], root);
  return root;
}

// A branch with a commit of its own, made without leaving `main` checked out.
function branchWithWork(root, branch, file) {
  git(['branch', branch], root);
  const name = file || branch.replace(/[^\w]/g, '-') + '.txt';
  fs.writeFileSync(path.join(root, name), 'work\n');
  git(['add', name], root);
  git(['commit', '-m', 'work'], root);
  git(['branch', '-f', branch, 'HEAD'], root);
  git(['reset', '--hard', 'HEAD~1'], root);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  while (roots.length) await removeTree(roots.pop());
});

// ---------- what git is asked ----------

// One repository for the whole group, and one survey of it: a git process costs
// upwards of a second on a Windows machine with a live virus scanner (measured
// while writing this), so a fixture per assertion would be minutes of the
// suite's time to prove things one repository already shows at once.
describe('gitOps.survey', () => {
  let root = null;
  let state = null;

  before(async () => {
    root = makeRepo({ track: false });
    branchWithWork(root, 'task/T-0014'); // work of its own, not merged
    git(['branch', 'task/T-0015-short-slug'], root); // branched off HEAD, nothing on it
    git(['branch', 'task/T-0015-v2'], root); // a second branch for the same task
    branchWithWork(root, 'task/T-0016');
    git(['merge', '--no-ff', '-m', 'merge', 'task/T-0016'], root);
    git(['branch', 'feature/not-a-task'], root);
    state = await createGitOps({ project: root }).survey();
  });

  it('groups every task branch under its task, whatever the slug', () => {
    assert.strictEqual(state.git, 'ok');
    assert.strictEqual(state.head, 'main');
    assert.deepStrictEqual(Object.keys(state.byTask).sort(), ['T-0014', 'T-0015', 'T-0016']);
    assert.deepStrictEqual(state.byTask['T-0015'].branches.sort(), [
      'task/T-0015-short-slug',
      'task/T-0015-v2',
    ]);
  });

  it('separates the branches carrying commits HEAD does not have', () => {
    assert.ok(state.unmergedKnown);
    assert.deepStrictEqual(state.byTask['T-0014'].unmerged, ['task/T-0014']);
    assert.deepStrictEqual(state.byTask['T-0015'].unmerged, []);
  });

  it('counts a merged branch as carrying nothing of its own any more', () => {
    assert.deepStrictEqual(state.byTask['T-0016'].branches, ['task/T-0016']);
    assert.deepStrictEqual(state.byTask['T-0016'].unmerged, []);
  });

  // The number in the guide, held to by a test: three git processes for the
  // whole board, whatever it holds. Counted through GIT_TRACE, which every git
  // writes one "built-in: git <cmd>" line to per process — a shim binary would
  // have been a different program and could have proven nothing about the real
  // one.
  it('answers for the whole board in three git calls', async () => {
    const trace = path.join(root, 'git-trace.log');
    process.env.GIT_TRACE = trace;
    try {
      await createGitOps({ project: root }).survey();
    } finally {
      delete process.env.GIT_TRACE;
    }
    const text = fs.readFileSync(trace, 'utf8');
    assert.strictEqual((text.match(/built-in: git /g) || []).length, 3, text);
  });

  it('says a directory that is no repository is not one, instead of failing', async () => {
    const bare = await createGitOps({ project: makeRepo({ init: false }) }).survey();
    assert.strictEqual(bare.git, 'not-a-repo');
    assert.deepStrictEqual(bare.byTask, {});
  });

  after(async () => {
    if (root) await removeTree(root);
  });
});

// ---------- the rules ----------

const SURVEY = (byTask, extra) => ({ git: 'ok', head: 'main', unmergedKnown: true, byTask, ...extra });
const task = (id, status) => ({ id, status });
const ended = (id) => ({ id, status: 'exited', exitCode: 0 });
const withBranch = (id, commits) => ({
  [id]: { branches: [`task/${id}`], unmerged: commits ? [`task/${id}`] : [] },
});

describe('what the watchdog calls a discrepancy', () => {
  it('in_progress, the session is over and its branch has commits: the work is not recorded', () => {
    const found = findingsFor({
      tasks: [task('T-0007', 'in_progress')],
      sessions: [ended('T-0007')],
      survey: SURVEY(withBranch('T-0007', true)),
    });
    assert.deepStrictEqual(found['T-0007'], { kind: 'work-not-recorded', branches: ['task/T-0007'] });
  });

  it('in_progress, the session is over and nothing was committed', () => {
    const found = findingsFor({
      tasks: [task('T-0007', 'in_progress')],
      sessions: [ended('T-0007')],
      survey: SURVEY(withBranch('T-0007', false)),
    });
    assert.strictEqual(found['T-0007'].kind, 'session-left-nothing');
  });

  it('a session that never committed and never branched is the same news', () => {
    const found = findingsFor({
      tasks: [task('T-0007', 'in_progress')],
      sessions: [ended('T-0007')],
      survey: SURVEY({}),
    });
    assert.strictEqual(found['T-0007'].kind, 'session-left-nothing');
  });

  it('a session cut short with the board counts as over', () => {
    const found = findingsFor({
      tasks: [task('T-0007', 'in_progress')],
      sessions: [{ id: 'T-0007', status: 'interrupted', exitCode: null }],
      survey: SURVEY(withBranch('T-0007', true)),
    });
    assert.strictEqual(found['T-0007'].kind, 'work-not-recorded');
  });

  it('review with no branch: there is no diff to read', () => {
    const found = findingsFor({
      tasks: [task('T-0014', 'review')],
      sessions: [],
      survey: SURVEY({}),
    });
    assert.deepStrictEqual(found['T-0014'], { kind: 'review-without-branch', branches: [] });
  });

  it('review with a branch that carries no commits of its own', () => {
    const found = findingsFor({
      tasks: [task('T-0014', 'review')],
      sessions: [],
      survey: SURVEY(withBranch('T-0014', false)),
    });
    assert.strictEqual(found['T-0014'].kind, 'review-without-commits');
  });

  it('done while its branch is not merged', () => {
    const found = findingsFor({
      tasks: [task('T-0015', 'done')],
      sessions: [],
      survey: SURVEY(withBranch('T-0015', true)),
    });
    assert.strictEqual(found['T-0015'].kind, 'done-not-merged');
  });

  it('every kind it can report is one of the five it declares', () => {
    const found = findingsFor({
      tasks: [
        task('T-0007', 'in_progress'),
        task('T-0008', 'in_progress'),
        task('T-0014', 'review'),
        task('T-0016', 'review'),
        task('T-0015', 'done'),
      ],
      sessions: [ended('T-0007'), ended('T-0008')],
      survey: SURVEY({
        ...withBranch('T-0007', true),
        ...withBranch('T-0008', false),
        ...withBranch('T-0016', false),
        ...withBranch('T-0015', true),
      }),
    });
    const kinds = Object.values(found).map((f) => f.kind);
    assert.strictEqual(kinds.length, 5);
    for (const kind of kinds) assert.ok(KINDS.includes(kind), kind);
  });
});

describe('what the watchdog says nothing about', () => {
  const quiet = (args) => assert.deepStrictEqual(findingsFor(args), {});

  it('a task in progress with the session still running', () => {
    quiet({
      tasks: [task('T-0007', 'in_progress')],
      sessions: [{ id: 'T-0007', status: 'running' }],
      survey: SURVEY(withBranch('T-0007', true)),
    });
  });

  it('a task in progress the board never started a session for', () => {
    quiet({
      tasks: [task('T-0007', 'in_progress')],
      sessions: [],
      survey: SURVEY(withBranch('T-0007', true)),
    });
  });

  it('a review with a branch that has commits — the ordinary case', () => {
    quiet({ tasks: [task('T-0014', 'review')], sessions: [], survey: SURVEY(withBranch('T-0014', true)) });
  });

  it('a task that is done with its branch merged, or with no branch at all', () => {
    quiet({ tasks: [task('T-0015', 'done')], sessions: [], survey: SURVEY(withBranch('T-0015', false)) });
    quiet({ tasks: [task('T-0015', 'done')], sessions: [], survey: SURVEY({}) });
  });

  it('a branch left on a cancelled task, or on one still in the backlog', () => {
    for (const status of ['backlog', 'open', 'ready', 'cancelled']) {
      quiet({
        tasks: [task('T-0020', status)],
        sessions: [ended('T-0020')],
        survey: SURVEY(withBranch('T-0020', true)),
      });
    }
  });

  it('anything at all when git could not be read', () => {
    for (const state of ['no-git', 'not-a-repo']) {
      quiet({
        tasks: [task('T-0014', 'review'), task('T-0015', 'done')],
        sessions: [],
        survey: { git: state, byTask: {} },
      });
    }
  });

  it('the two questions it cannot answer when the merge check itself failed', () => {
    // An unknown answer must not become "there are no commits": both readings
    // would be inventions, and one of them accuses a finished task.
    quiet({
      tasks: [task('T-0007', 'in_progress'), task('T-0015', 'done')],
      sessions: [ended('T-0007')],
      survey: SURVEY({ ...withBranch('T-0007', false), ...withBranch('T-0015', false) }, {
        unmergedKnown: false,
      }),
    });
  });
});

// ---------- when it looks ----------

describe('the watchdog schedule', () => {
  function harness({ findings = {}, intervalMs } = {}) {
    let scans = 0;
    const changes = [];
    let current = findings;
    const watchdog = createWatchdog({
      survey: async () => {
        scans++;
        return { git: 'ok', head: 'main', unmergedKnown: true, byTask: current.byTask || {} };
      },
      snapshot: () => ({ tasks: current.tasks || [], sessions: current.sessions || [] }),
      onChange: (state) => changes.push(state),
      intervalMs,
    });
    return {
      watchdog,
      changes,
      scans: () => scans,
      set: (next) => {
        current = next;
      },
    };
  }

  it('scans at once the first time it is asked', async () => {
    const h = harness();
    h.watchdog.schedule();
    await sleep(20);
    assert.strictEqual(h.scans(), 1);
  });

  it('collapses a burst of events into one scan, and does not lose the last one', async () => {
    const h = harness({ intervalMs: 300 });
    h.watchdog.schedule();
    await sleep(30);
    assert.strictEqual(h.scans(), 1);
    // Six events inside the floor: one deferred scan, not six, and not none —
    // dropping them would leave a finding invisible until something unrelated
    // happened to come along.
    for (let i = 0; i < 6; i++) h.watchdog.schedule();
    await sleep(30);
    assert.strictEqual(h.scans(), 1, 'a scan ran inside the floor');
    await sleep(400);
    assert.strictEqual(h.scans(), 2, 'the deferred scan never ran');
    h.watchdog.stop();
  });

  it('tells its listener only when the findings actually changed', async () => {
    const h = harness({
      findings: {
        tasks: [task('T-0014', 'review')],
        sessions: [],
        byTask: {},
      },
    });
    await h.watchdog.scan();
    assert.strictEqual(h.changes.length, 1);
    assert.strictEqual(h.changes[0].findings['T-0014'].kind, 'review-without-branch');
    await h.watchdog.scan();
    await h.watchdog.scan();
    assert.strictEqual(h.changes.length, 1, 'a quiet board pushed a frame to its tabs');
    h.set({ tasks: [task('T-0014', 'review')], sessions: [], byTask: withBranch('T-0014', true) });
    await h.watchdog.scan();
    assert.strictEqual(h.changes.length, 2);
    assert.deepStrictEqual(h.changes[1].findings, {});
  });

  it('keeps its last answer and stays usable when git throws', async () => {
    const errors = [];
    const watchdog = createWatchdog({
      survey: async () => {
        throw new Error('git exploded');
      },
      snapshot: () => ({ tasks: [], sessions: [] }),
      logger: { error: (m) => errors.push(m) },
    });
    const state = await watchdog.scan();
    assert.deepStrictEqual(state.findings, {});
    assert.match(errors.join('\n'), /git exploded/);
  });

  it('off means off: nothing is scanned and nothing is claimed', async () => {
    const h = harness({ intervalMs: null });
    assert.strictEqual(h.watchdog.enabled, false);
    h.watchdog.schedule();
    await h.watchdog.scan();
    await sleep(20);
    assert.strictEqual(h.scans(), 0);
    assert.strictEqual(h.watchdog.state().git, 'off');
  });

  it('reads its floor from the environment, and falls back rather than refusing', () => {
    const errors = [];
    const logger = { error: (m) => errors.push(m) };
    assert.strictEqual(parseInterval(undefined), MIN_INTERVAL_MS);
    assert.strictEqual(parseInterval(''), MIN_INTERVAL_MS);
    assert.strictEqual(parseInterval('25000'), 25000);
    assert.strictEqual(parseInterval('OFF'), null);
    assert.strictEqual(parseInterval('later', logger), MIN_INTERVAL_MS);
    assert.strictEqual(parseInterval('-5', logger), MIN_INTERVAL_MS);
    assert.strictEqual(errors.length, 2);
  });

  // T-0228: the constant was documented as a floor and used as a default, so
  // every value below it went through untouched — `0` most of all, which turns
  // each backlog write and each session event into three git processes.
  it('is a floor and not a default: nothing the environment says goes under it', () => {
    const errors = [];
    const logger = { error: (m) => errors.push(m) };
    for (const raw of ['0', '5', '2500', String(MIN_INTERVAL_MS - 1)]) {
      assert.strictEqual(
        parseInterval(raw, logger),
        MIN_INTERVAL_MS,
        `${raw} was accepted below the floor`
      );
    }
    assert.strictEqual(errors.length, 4, 'a value raised to the floor is raised silently');
    // `0` is what someone writes meaning "off", and the answer has to tell them
    // the word that does it — otherwise the safe fallback is still a dead end.
    assert.match(errors[0], /below the floor/);
    assert.match(errors[0], /"off"/);
  });

  // The floor stops at the environment. The schedule takes a number its caller
  // has already resolved, which is what keeps this test 300ms long instead of
  // ten seconds, and it is the only channel that is not the floor's business.
  it('takes the interval already resolved, so `off` reaches it as null', () => {
    const h = harness({ intervalMs: null });
    assert.strictEqual(h.watchdog.enabled, false);
    assert.strictEqual(harness({ intervalMs: 300 }).watchdog.intervalMs, 300);
    assert.strictEqual(harness().watchdog.intervalMs, MIN_INTERVAL_MS);
  });
});
