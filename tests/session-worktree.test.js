'use strict';

// Tests for the isolated session of T-0091: the runner puts a session into its
// own git worktree instead of the shared checkout.
// Every git scenario here runs on a throwaway repository created by the test in
// the OS temp directory — the real repository is never touched, and no git
// command runs outside that temp directory.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor: waitForCondition } = require('./helpers/wait.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { createSessionRunner } = require('../server/sessions.js');
const gitOpsModule = require('../server/git.js');
const { createGitOps } = gitOpsModule;
const { parseBacklog } = require('../server/parser.js');
const { stripProse } = require('./helpers/js-source.js');
const { removeTree } = require('./helpers/rm.js');
const { tempDir } = require('./helpers/tmp.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

// ---------- helpers ----------

// The suite's one wait (tests/helpers/wait.js), in this file's argument order.
function waitFor(predicate, what = 'condition') {
  return waitForCondition(predicate, SPAWN_WAIT_BUDGET_MS, what);
}

function q(value) {
  return `"${value}"`;
}

function nodeCmd(script) {
  return `${q(process.execPath)} -e ${q(script)}`;
}

const PRINT_CWD = nodeCmd('console.log(process.cwd())');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const roots = [];
const runners = [];

function makeDir() {
  const root = tempDir('briefboard-worktree-test-');
  roots.push(root);
  return root;
}

// A repository with one commit, and .briefboard/ ignored exactly as in a real
// project, so the worktree the runner adds inside it does not show up in
// `git status`.
function makeRepo() {
  const root = makeDir();
  git(['init'], root);
  git(['config', 'user.email', 'test@briefboard.invalid'], root);
  git(['config', 'user.name', 'briefboard test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  fs.writeFileSync(path.join(root, '.gitignore'), '.briefboard/\n');
  git(['add', '.gitignore'], root);
  git(['commit', '-m', 'init'], root);
  return root;
}

function makeRunner(options = {}) {
  const logged = { warn: [], error: [] };
  const runner = createSessionRunner({
    logger: {
      warn: (m) => logged.warn.push(String(m)),
      error: (m) => logged.error.push(String(m)),
      log: () => {},
    },
    ...options,
  });
  runners.push(runner);
  runner.logged = logged;
  return runner;
}

function worktreePath(project, taskId) {
  return path.join(project, '.briefboard', 'worktrees', taskId);
}

function readLog(logPath) {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

// A value the session printed is ONE complete line of the log, never the whole
// file: the runner appends its own [briefboard] lines to the same log (T-0120).
function firstLogLine(logPath) {
  const text = readLog(logPath);
  const end = text.indexOf('\n');
  return end === -1 ? '' : text.slice(0, end).trim();
}

function onlyLogText(project) {
  const dir = path.join(project, '.briefboard', 'sessions');
  // Logs only: registry.json shares the directory with them (T-0102).
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')) : [];
  assert.strictEqual(files.length, 1, 'exactly one session log');
  return readLog(path.join(dir, files[0]));
}

// The refusal is written through a stream, so it reaches the file after
// startSession has already resolved.
async function awaitLogMatch(project, re) {
  await waitFor(() => re.test(onlyLogText(project)), `${re} in the session log`);
  return onlyLogText(project);
}

function headOf(cwd) {
  return { head: git(['rev-parse', 'HEAD'], cwd), branch: git(['branch', '--show-current'], cwd) };
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()));
  while (roots.length) await removeTree(roots.pop());
});

// ---------- the isolated session ----------

describe('startSession({ isolate: true }) runs inside its own git worktree', () => {
  it('spawns the process with a cwd inside .briefboard/worktrees/T-NNNN', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, command: PRINT_CWD });

    const result = await runner.startSession('T-0011', { isolate: true });

    assert.strictEqual(result.started, true);
    await waitFor(() => firstLogLine(result.logPath) !== '', 'the cwd line');
    assert.strictEqual(
      fs.realpathSync(firstLogLine(result.logPath)),
      fs.realpathSync(worktreePath(project, 'T-0011'))
    );
  });

  it('creates the branch task/T-NNNN at the shared checkout HEAD', async () => {
    const project = makeRepo();
    const before = headOf(project);
    const runner = makeRunner({ project, command: PRINT_CWD });

    assert.strictEqual((await runner.startSession('T-0011', { isolate: true })).started, true);

    const tree = worktreePath(project, 'T-0011');
    assert.strictEqual(git(['branch', '--show-current'], tree), 'task/T-0011');
    assert.strictEqual(git(['rev-parse', 'HEAD'], tree), before.head);
  });

  // T-0117: after review a human has to read that branch and merge it by hand,
  // and the registry is where the board reads both from. Recorded, not derived
  // from the id: a session that ran in the shared checkout has neither.
  it('records the branch and the worktree it created', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, command: PRINT_CWD });

    assert.strictEqual((await runner.startSession('T-0011', { isolate: true })).started, true);

    const record = runner.get('T-0011');
    assert.strictEqual(record.branch, 'task/T-0011');
    assert.strictEqual(
      fs.realpathSync(record.worktree),
      fs.realpathSync(worktreePath(project, 'T-0011'))
    );
  });

  it('records no branch and no worktree for a session that was not isolated', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, command: PRINT_CWD });

    assert.strictEqual((await runner.startSession('T-0011')).started, true);

    const record = runner.get('T-0011');
    assert.strictEqual(record.branch, null);
    assert.strictEqual(record.worktree, null);
  });

  it('leaves HEAD and the current branch of the SHARED checkout untouched', async () => {
    const project = makeRepo();
    const before = headOf(project);
    const runner = makeRunner({ project, command: PRINT_CWD });

    const result = await runner.startSession('T-0011', { isolate: true });
    assert.strictEqual(result.started, true);
    await waitFor(() => runner.get('T-0011').status === 'exited', 'the session to exit');

    assert.deepStrictEqual(headOf(project), before);
  });

  it('keeps the session log in the shared project, not inside the worktree', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, command: PRINT_CWD });

    const { logPath } = await runner.startSession('T-0011', { isolate: true });

    const relative = path.relative(project, logPath).split(path.sep);
    assert.deepStrictEqual(relative.slice(0, 2), ['.briefboard', 'sessions']);
    assert.strictEqual(fs.existsSync(path.join(worktreePath(project, 'T-0011'), '.briefboard')), false);
  });

  it('reuses the existing worktree and branch when the session is started again', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, command: PRINT_CWD });

    assert.strictEqual((await runner.startSession('T-0011', { isolate: true })).started, true);
    await waitFor(() => runner.get('T-0011').status === 'exited', 'the first session to exit');

    // Work left behind by the first session must survive the restart.
    const tree = worktreePath(project, 'T-0011');
    fs.writeFileSync(path.join(tree, 'work-in-progress.txt'), 'kept');

    assert.strictEqual((await runner.startSession('T-0011', { isolate: true })).started, true);

    assert.strictEqual(fs.readFileSync(path.join(tree, 'work-in-progress.txt'), 'utf8'), 'kept');
    assert.strictEqual(git(['branch', '--show-current'], tree), 'task/T-0011');
    const worktrees = git(['worktree', 'list', '--porcelain'], project)
      .split('\n')
      .filter((line) => line.startsWith('worktree '));
    assert.strictEqual(worktrees.length, 2, 'the shared checkout plus exactly one task worktree');
  });

  it('attaches a worktree to a task branch that already exists', async () => {
    const project = makeRepo();
    git(['branch', 'task/T-0011'], project);
    const before = headOf(project);
    const runner = makeRunner({ project, command: PRINT_CWD });

    assert.strictEqual((await runner.startSession('T-0011', { isolate: true })).started, true);

    const tree = worktreePath(project, 'T-0011');
    assert.strictEqual(git(['branch', '--show-current'], tree), 'task/T-0011');
    assert.deepStrictEqual(headOf(project), before);
  });

  it('is opt-in: without the option the session still runs in the shared checkout and no git is used', async () => {
    const project = makeRepo();
    const before = headOf(project);
    const runner = makeRunner({ project, command: PRINT_CWD });

    const result = await runner.startSession('T-0011');

    assert.strictEqual(result.started, true);
    await waitFor(() => firstLogLine(result.logPath) !== '', 'the cwd line');
    assert.strictEqual(fs.realpathSync(firstLogLine(result.logPath)), fs.realpathSync(project));
    assert.strictEqual(fs.existsSync(path.join(project, '.briefboard', 'worktrees')), false);
    assert.strictEqual(git(['branch', '--list', 'task/T-0011'], project), '');
    assert.deepStrictEqual(headOf(project), before);
  });
});

// ---------- one source for the layout (T-0180) ----------

// The runner writes `.briefboard/worktrees/T-NNNN` and the branch `task/T-NNNN`;
// server/git.js reads both back to tell the board what a finished task left
// behind. Until T-0180 each module carried its own copy of those two constants,
// and a disagreement between them fails silently in the worst possible way: the
// reader looks into a directory the runner never created, finds nothing, and the
// close-loop card of T-0148 reports "nothing to clean up" — which is exactly what
// a tidy, finished task looks like.
describe('the runner and the board read one layout (T-0180)', () => {
  const SESSIONS_SRC = stripProse(
    fs.readFileSync(path.join(__dirname, '..', 'server', 'sessions.js'), 'utf8')
  );

  // The behavioural half: what the runner made is what the board finds. This
  // passes on either side of T-0180 while the two copies still agree — it states
  // the contract the constants exist for, and is what would break first if the
  // shared constant were ever changed on only one of its two uses.
  it('the board finds the worktree and the branch the runner created', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, command: PRINT_CWD });

    assert.strictEqual((await runner.startSession('T-0011', { isolate: true })).started, true);

    const state = await createGitOps({ project }).inspect('T-0011');
    assert.strictEqual(state.git, 'ok');
    assert.strictEqual(state.branch, 'task/T-0011');
    assert.strictEqual(
      fs.realpathSync(state.worktree),
      fs.realpathSync(worktreePath(project, 'T-0011'))
    );
  });

  // The structural half, and the reason it is asserted rather than left to
  // review: two copies that agree are indistinguishable from one source in every
  // behavioural test there is, so only the source text can say which of the two
  // this is.
  for (const name of ['WORKTREE_DIR_PARTS', 'BRANCH_PREFIX']) {
    it(`server/sessions.js takes ${name} from server/git.js instead of declaring its own`, () => {
      assert.notStrictEqual(gitOpsModule[name], undefined, `server/git.js must export ${name}`);
      assert.doesNotMatch(
        SESSIONS_SRC,
        new RegExp(`(?:const|let|var)\\s+${name}\\s*=`),
        `server/sessions.js declares its own ${name}; server/git.js exports it, and a second copy ` +
          'is free to drift — take it from the require instead'
      );
      assert.match(
        SESSIONS_SRC,
        new RegExp(`\\b${name}\\b[^=]*\\}\\s*=\\s*require\\('\\./git'\\)`),
        `server/sessions.js must import ${name} from ./git`
      );
    });
  }

  // The dependency runs one way only: server/git.js knows nothing of the session
  // registry, which is why it is the module that holds the constants (T-0171 made
  // the same call for runGit). A require back the other way would be a cycle, and
  // Node answers a cycle with a half-built module rather than an error.
  it('server/git.js requires nothing from server/sessions.js', () => {
    const gitSrc = stripProse(
      fs.readFileSync(path.join(__dirname, '..', 'server', 'git.js'), 'utf8')
    );
    assert.doesNotMatch(gitSrc, /require\('\.\/sessions(\.js)?'\)/);
  });
});

// ---------- the task data of an isolated session ----------

// T-0118: the runner gives every session AGENTBOARD_ROOT = the project, so the
// CLI an isolated session runs writes to the SHARED backlog even though its cwd
// is the worktree — the rule of T-0079 as a property of the environment rather
// than of the agent's memory. The session here is the real tools/task.mjs.
describe('an isolated session writes task data to the shared checkout', () => {
  const cliCmd = (args) => `${q(process.execPath)} ${q(CLI_PATH)} ${args}`;

  // A repository whose committed doc/backlog.md holds one in_progress task, so
  // the worktree gets a copy of it that a wrong write would land in.
  function repoWithTask() {
    const project = makeRepo();
    const cli = (...args) => {
      const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
        env: { ...process.env, AGENTBOARD_ROOT: project },
        encoding: 'utf8',
      });
      assert.strictEqual(res.status, 0, `task.mjs ${args.join(' ')} failed: ${res.stderr}`);
      return res.stdout.trim();
    };
    const id = cli('add', '--type', 'bug', '--priority', 'Major', '--title', 'Fixture');
    cli('status', id, 'open');
    cli('brief', id, 'fixture'); // `ready` is refused for a task with no brief
    for (const status of ['ready', 'in_progress']) cli('status', id, status);
    git(['add', 'doc'], project);
    git(['commit', '-m', 'backlog'], project);
    return { project, id };
  }

  const statusOf = (root, id) =>
    parseBacklog(fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8')).find(
      (t) => t.id === id
    ).status;

  it('the status reaches the shared backlog, not the copy inside the worktree', async () => {
    const { project, id } = repoWithTask();
    const runner = makeRunner({ project, workerCommand: cliCmd('status {id} review') });

    const started = await runner.startSession(id, { isolate: true, kind: 'worker' });
    assert.strictEqual(started.started, true);
    await waitFor(() => runner.get(id).status === 'exited', 'the session to exit');
    assert.strictEqual(runner.get(id).exitCode, 0, readLog(started.logPath));

    assert.strictEqual(statusOf(project, id), 'review');
    const tree = worktreePath(project, id);
    assert.strictEqual(statusOf(tree, id), 'in_progress');
    assert.strictEqual(git(['status', '--porcelain'], tree), '', 'the branch stays free of it');
  });

  it('the session needs no env prefix of its own to get there', async () => {
    const { project, id } = repoWithTask();
    const runner = makeRunner({
      project,
      workerCommand: nodeCmd('console.log(process.env.AGENTBOARD_ROOT)'),
    });

    const { logPath } = await runner.startSession(id, { isolate: true, kind: 'worker' });
    await waitFor(() => firstLogLine(logPath) !== '', 'the env dump');

    assert.strictEqual(fs.realpathSync(firstLogLine(logPath)), fs.realpathSync(project));
    assert.notStrictEqual(fs.realpathSync(firstLogLine(logPath)), fs.realpathSync(worktreePath(project, id)));
  });

  // T-0113: the brief a briefing session has just written is an untracked file,
  // and `git worktree add ... HEAD` carries only what is committed — so the
  // worker's own doc/brief/ does not have it. Reading through AGENTBOARD_ROOT is
  // what makes the brief reach the session; the alternatives (committing it for
  // the user, copying doc/ into the worktree) were rejected, so both the absence
  // of the file in the worktree and the untouched state of the shared checkout
  // are asserted here as the behaviour we want, not as damage.
  describe('the brief that exists only in the shared checkout', () => {
    // The brief is written AFTER the commit, exactly as a briefing session
    // writes one into a project whose backlog is already committed.
    const NAME = 'untracked.md';

    function repoWithUncommittedBrief() {
      const { project, id } = repoWithTask();
      const brief = path.join(project, 'doc', 'brief', `${id}-02-${NAME}`);
      fs.writeFileSync(brief, `# ${id}-02\n\nThe only copy of this text.\n`);
      return { project, id, brief };
    }

    // Resolves the brief the way the shipped prompt tells the session to: from
    // the environment root, not from the directory the session stands in.
    const READ_BRIEF = nodeCmd(
      "const fs=require('fs'),path=require('path');" +
        "const dir=path.join(process.env.AGENTBOARD_ROOT,'doc','brief');" +
        "console.log(fs.readdirSync(dir).map((f)=>fs.readFileSync(path.join(dir,f),'utf8')).join(''))"
    );

    it('is not in the worktree, and the session still reads it through AGENTBOARD_ROOT', async () => {
      const { project, id } = repoWithUncommittedBrief();
      const runner = makeRunner({ project, workerCommand: READ_BRIEF });

      const { logPath } = await runner.startSession(id, { isolate: true, kind: 'worker' });
      await waitFor(() => runner.get(id).status === 'exited', 'the session to exit');

      const tree = worktreePath(project, id);
      assert.strictEqual(
        fs.existsSync(path.join(tree, 'doc', 'brief', `${id}-02-${NAME}`)),
        false,
        'the uncommitted brief is not in the worktree — that is the bug the prompt works around'
      );
      assert.match(readLog(logPath), /The only copy of this text\./);
    });

    it('is neither committed nor copied by the board', async () => {
      const { project, id, brief } = repoWithUncommittedBrief();
      const before = headOf(project);
      const runner = makeRunner({ project, workerCommand: READ_BRIEF });

      await runner.startSession(id, { isolate: true, kind: 'worker' });
      await waitFor(() => runner.get(id).status === 'exited', 'the session to exit');

      const status = git(['status', '--porcelain'], project);
      assert.match(status, /\?\? doc\/brief\//, 'the brief stays untracked: no commit is made for the user');
      assert.deepStrictEqual(headOf(project), before);
      assert.strictEqual(
        git(['rev-parse', 'HEAD'], worktreePath(project, id)),
        before.head,
        'the task branch starts at the shared HEAD and nothing was committed onto it'
      );
      assert.strictEqual(fs.existsSync(brief), true, 'the one copy of the brief is still where it was written');
    });
  });
});

// ---------- refusals ----------

describe('an isolation failure refuses the session instead of falling back to the shared checkout', () => {
  it('a project that is not a git repository → reason "not-a-repo"', async () => {
    const project = makeDir();
    const runner = makeRunner({ project, command: PRINT_CWD });

    assert.deepStrictEqual(await runner.startSession('T-0011', { isolate: true }), {
      started: false,
      reason: 'not-a-repo',
    });

    assert.strictEqual(runner.get('T-0011'), null);
    assert.strictEqual(runner.list().length, 0);
    await awaitLogMatch(project, /isolation failed \(not-a-repo\)/);
    assert.match(runner.logged.error.join('\n'), /isolation failed/);
  });

  it('no git executable → reason "no-git"', async () => {
    const project = makeRepo();
    const before = headOf(project);
    const runner = makeRunner({
      project,
      command: PRINT_CWD,
      gitBin: 'briefboard-no-such-git-xyz',
    });

    assert.deepStrictEqual(await runner.startSession('T-0011', { isolate: true }), {
      started: false,
      reason: 'no-git',
    });

    assert.strictEqual(runner.list().length, 0);
    await awaitLogMatch(project, /isolation failed \(no-git\)/);
    assert.deepStrictEqual(headOf(project), before);
  });

  it('a failing `git worktree add` → reason "worktree-failed", with git\'s stderr in the log', async () => {
    const project = makeRepo();
    const before = headOf(project);
    // The target path is taken by a plain file, so `git worktree add` refuses.
    fs.mkdirSync(path.join(project, '.briefboard', 'worktrees'), { recursive: true });
    fs.writeFileSync(worktreePath(project, 'T-0011'), 'in the way');
    const runner = makeRunner({ project, command: PRINT_CWD });

    assert.deepStrictEqual(await runner.startSession('T-0011', { isolate: true }), {
      started: false,
      reason: 'worktree-failed',
    });

    assert.strictEqual(runner.list().length, 0);
    const log = await awaitLogMatch(project, /isolation failed \(worktree-failed\)/);
    assert.match(log, /T-0011/, "git's own complaint about the path is in the log");
    assert.deepStrictEqual(headOf(project), before);
  });

  it('a refused isolation consumes no concurrency slot', async () => {
    const project = makeDir();
    const runner = makeRunner({ project, command: PRINT_CWD, maxSessions: 1 });

    await runner.startSession('T-0011', { isolate: true });

    assert.deepStrictEqual(await runner.startSession('T-0012', { isolate: true }), {
      started: false,
      reason: 'not-a-repo',
    });
  });
});

// ---------- preparing the worktree (T-0150) ----------

// A worktree is a checkout with no node_modules, no packages, no venv, so the
// tests a brief asks for cannot run in it. The command that fixes that is the
// user's own (BRIEFBOARD_SETUP_CMD); nothing here installs anything — the
// "install" is a node one-liner that writes a file, exactly as the session
// commands above print their cwd.
describe('a declared setup command prepares the worktree before the session', () => {
  const MARKER = 'setup-ran.txt';
  const SESSION_MARKER = 'session-ran.txt';
  // Appends, so a second run is visible as a second line.
  const SETUP_OK = nodeCmd(`require('fs').appendFileSync('${MARKER}', 'prepared\\n')`);
  const SETUP_FAILS = nodeCmd(
    "console.log('resolving briefboard-fixture');" +
      "console.error('no network');" +
      'process.exit(3)'
  );
  const SETUP_HANGS = nodeCmd('setTimeout(() => {}, 60000)');
  const READ_MARKER = nodeCmd(
    `console.log('session sees: ' + require('fs').readFileSync('${MARKER}', 'utf8').trim())`
  );
  const WRITE_SESSION_MARKER = nodeCmd(
    `require('fs').writeFileSync('${SESSION_MARKER}', 'ran')`
  );

  function stampPath(project, taskId) {
    return path.join(project, '.briefboard', 'worktrees', `${taskId}.setup.json`);
  }

  function linesOf(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  }

  it('runs it inside the worktree, and the session starts only after it', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, setupCommand: SETUP_OK, workerCommand: READ_MARKER });

    const started = await runner.startSession('T-0011', { isolate: true, kind: 'worker' });

    assert.strictEqual(started.started, true);
    await waitFor(() => runner.get('T-0011').status === 'exited', 'the session to exit');
    const tree = worktreePath(project, 'T-0011');
    assert.deepStrictEqual(linesOf(path.join(tree, MARKER)), ['prepared']);
    // The session read what the setup wrote: it ran second, and in the same tree.
    assert.match(readLog(started.logPath), /session sees: prepared/);
    assert.strictEqual(runner.get('T-0011').exitCode, 0);
    assert.strictEqual(fs.existsSync(stampPath(project, 'T-0011')), true);
  });

  it('does not run it again when the session is restarted on a prepared worktree', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, setupCommand: SETUP_OK, workerCommand: READ_MARKER });

    assert.strictEqual(
      (await runner.startSession('T-0011', { isolate: true, kind: 'worker' })).started,
      true
    );
    await waitFor(() => runner.get('T-0011').status === 'exited', 'the first session');

    const second = await runner.startSession('T-0011', { isolate: true, kind: 'worker' });
    assert.strictEqual(second.started, true);
    await waitFor(() => runner.get('T-0011').status === 'exited', 'the second session');

    const tree = worktreePath(project, 'T-0011');
    assert.deepStrictEqual(linesOf(path.join(tree, MARKER)), ['prepared'], 'installed once');
    assert.doesNotMatch(readLog(second.logPath), /preparing the worktree/);
  });

  it('runs it again after a preparation that failed, on the same worktree', async () => {
    const project = makeRepo();
    const failing = makeRunner({ project, setupCommand: SETUP_FAILS, workerCommand: READ_MARKER });

    assert.deepStrictEqual(await failing.startSession('T-0011', { isolate: true, kind: 'worker' }), {
      started: false,
      reason: 'setup-failed',
    });
    // The directory a failed preparation leaves behind is what makes "the
    // worktree exists" the wrong thing to key on.
    const tree = worktreePath(project, 'T-0011');
    assert.strictEqual(fs.existsSync(path.join(tree, '.git')), true);
    assert.strictEqual(fs.existsSync(stampPath(project, 'T-0011')), false);

    const fixed = makeRunner({ project, setupCommand: SETUP_OK, workerCommand: READ_MARKER });
    const started = await fixed.startSession('T-0011', { isolate: true, kind: 'worker' });

    assert.strictEqual(started.started, true);
    await waitFor(() => fixed.get('T-0011').status === 'exited', 'the session to exit');
    assert.deepStrictEqual(linesOf(path.join(tree, MARKER)), ['prepared']);
    assert.strictEqual(fs.existsSync(stampPath(project, 'T-0011')), true);
  });

  it('prepares a worktree that was deleted by hand all over again', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, setupCommand: SETUP_OK, workerCommand: READ_MARKER });

    assert.strictEqual(
      (await runner.startSession('T-0011', { isolate: true, kind: 'worker' })).started,
      true
    );
    await waitFor(() => runner.get('T-0011').status === 'exited', 'the first session');

    const tree = worktreePath(project, 'T-0011');
    await removeTree(tree);
    git(['worktree', 'prune'], project);

    assert.strictEqual(
      (await runner.startSession('T-0011', { isolate: true, kind: 'worker' })).started,
      true
    );

    assert.deepStrictEqual(linesOf(path.join(tree, MARKER)), ['prepared'], 'the new tree is prepared');
  });

  it('a non-zero exit refuses the session, with the command\'s own output in the log', async () => {
    const project = makeRepo();
    const runner = makeRunner({
      project,
      setupCommand: SETUP_FAILS,
      workerCommand: WRITE_SESSION_MARKER,
    });

    assert.deepStrictEqual(await runner.startSession('T-0011', { isolate: true, kind: 'worker' }), {
      started: false,
      reason: 'setup-failed',
    });

    const log = await awaitLogMatch(project, /setup failed \(setup-failed\)/);
    assert.match(log, /exited with 3/);
    assert.match(log, /resolving briefboard-fixture/, "the command's stdout");
    assert.match(log, /no network/, "the command's stderr");
    assert.strictEqual(runner.list().length, 0, 'no session was registered');
    assert.strictEqual(
      fs.existsSync(path.join(worktreePath(project, 'T-0011'), SESSION_MARKER)),
      false,
      'the agent never ran in the unprepared worktree'
    );
    assert.match(runner.logged.error.join('\n'), /setup failed/);
  });

  it('a command that never finishes is killed at the time limit and the session refused', async () => {
    const project = makeRepo();
    const runner = makeRunner({
      project,
      setupCommand: SETUP_HANGS,
      setupTimeoutMs: 300,
      workerCommand: WRITE_SESSION_MARKER,
    });

    assert.deepStrictEqual(await runner.startSession('T-0011', { isolate: true, kind: 'worker' }), {
      started: false,
      reason: 'setup-timeout',
    });

    const log = await awaitLogMatch(project, /setup failed \(setup-timeout\)/);
    assert.match(log, /killed after 300 ms/);
    assert.strictEqual(runner.list().length, 0);
    assert.strictEqual(fs.existsSync(stampPath(project, 'T-0011')), false);
  });

  // The likeliest Windows failure of all, because `npm` itself is such a shim:
  // the hint that already serves the session templates serves this one too.
  it('a command that cannot be spawned on Windows carries the .cmd-shim hint', async () => {
    const project = makeRepo();
    const runner = makeRunner({
      project,
      setupCommand: 'briefboard-no-such-setup-xyz install',
      workerCommand: WRITE_SESSION_MARKER,
      platform: 'win32',
    });

    assert.deepStrictEqual(await runner.startSession('T-0011', { isolate: true, kind: 'worker' }), {
      started: false,
      reason: 'setup-failed',
    });

    const log = await awaitLogMatch(project, /setup failed \(setup-failed\)/);
    assert.match(log, /\.cmd\/\.bat shim/);
    assert.match(log, /BRIEFBOARD_SETUP_CMD/);
  });

  it('a declared command that cannot be parsed refuses the session too', async () => {
    const project = makeRepo();
    const runner = makeRunner({
      project,
      setupCommand: "npm ci 'unterminated",
      workerCommand: WRITE_SESSION_MARKER,
    });

    assert.deepStrictEqual(await runner.startSession('T-0011', { isolate: true, kind: 'worker' }), {
      started: false,
      reason: 'setup-failed',
    });

    await awaitLogMatch(project, /BRIEFBOARD_SETUP_CMD is unusable \(invalid command template\)/);
    assert.strictEqual(
      fs.existsSync(path.join(worktreePath(project, 'T-0011'), SESSION_MARKER)),
      false
    );
  });

  it('with nothing declared it runs nothing and says nothing', async () => {
    const project = makeRepo();
    const runner = makeRunner({ project, workerCommand: PRINT_CWD });

    const started = await runner.startSession('T-0011', { isolate: true, kind: 'worker' });

    assert.strictEqual(started.started, true);
    await waitFor(() => runner.get('T-0011').status === 'exited', 'the session to exit');
    const log = readLog(started.logPath);
    assert.doesNotMatch(log, /preparing the worktree/);
    assert.doesNotMatch(log, /setup/i);
    assert.strictEqual(fs.existsSync(stampPath(project, 'T-0011')), false);
    assert.deepStrictEqual(runner.logged.error, []);
  });

  // Only the worker session gets a worktree of its own; the other two run in the
  // project root, where the dependencies are already installed.
  it('is not run for the briefing and the review session', async () => {
    const project = makeRepo();
    const runner = makeRunner({
      project,
      setupCommand: SETUP_OK,
      command: PRINT_CWD,
      orchestratorCommand: PRINT_CWD,
    });

    assert.strictEqual((await runner.startSession('T-0011')).started, true);
    assert.strictEqual((await runner.startSession('T-0012', { kind: 'orchestrator' })).started, true);
    await waitFor(() => runner.get('T-0012').status === 'exited', 'the review session');

    assert.strictEqual(fs.existsSync(path.join(project, MARKER)), false);
    assert.strictEqual(fs.existsSync(path.join(project, '.briefboard', 'worktrees')), false);
  });
});
