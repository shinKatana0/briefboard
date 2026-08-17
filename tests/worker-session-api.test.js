'use strict';

// Integration tests for the worker session behind POST /api/task/:id/start
// (T-0084): the board's own drop from Ready into In Progress starts an agent
// that writes code, so it runs its own command template and is isolated in a git
// worktree (T-0091) — while the briefing session behind /open keeps running in
// the shared checkout with its own template.
//
// Each test spawns a real `node server/server.js` against a throwaway
// AGENTBOARD_ROOT which is its own git repository, so the real project is never
// touched and no git command runs outside the temp directory. No test ever runs
// a real agent: the command is always a short `node -e ...`.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor } = require('./helpers/wait.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch, SESSION_START_TIMEOUT_MS } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { removeTree } = require('./helpers/rm.js');

// ---------- fixture helpers ----------

function backlogWithReadyTask() {
  return [
    '# Backlog\n',
    '## T-0011 · Major · Backlog task',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
    '## T-0013 · Major · Ready task',
    '- type: feature',
    '- status: ready',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0013-01',
    '',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const activeServers = [];
const activeRoots = [];

// A plain (non-git) project root, so the isolation refusal can be exercised too.
function makeRoot(backlog = backlogWithReadyTask()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-worker-api-test-'));
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), backlog);
  activeRoots.push(root);
  return root;
}

// The same root turned into a repository with one commit, `.briefboard/`
// ignored exactly as in a real project.
function makeRepoRoot(backlog) {
  const root = makeRoot(backlog);
  git(['init'], root);
  git(['config', 'user.email', 'test@briefboard.invalid'], root);
  git(['config', 'user.name', 'briefboard test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  fs.writeFileSync(path.join(root, '.gitignore'), '.briefboard/\n');
  git(['add', '.'], root);
  git(['commit', '-m', 'init'], root);
  return root;
}

// Logs only: registry.json shares the directory with them (T-0102).
function sessionLogs(root) {
  const dir = path.join(root, '.briefboard', 'sessions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')) : [];
}

function readSessionLogs(root) {
  const dir = path.join(root, '.briefboard', 'sessions');
  return sessionLogs(root)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

// A value the session printed is ONE complete line of the log, never the whole
// file, and what a wait waits for is that line rather than any bytes at all: the
// runner appends its own [briefboard] lines to the same log once the session
// exits (T-0109), so reading the file as a path was green only until they landed
// — a race, not a passing test (T-0120).
function firstSessionLine(root) {
  const text = readSessionLogs(root);
  const end = text.indexOf('\n');
  return end === -1 ? '' : text.slice(0, end).trim();
}

function hasSessionLine(root) {
  const line = firstSessionLine(root);
  return line !== '' && !line.startsWith('[briefboard]');
}

const EMPTY_RUN_HINT = /\[briefboard\] this session ended without changing/;

function worktreePath(root, taskId) {
  return path.join(root, '.briefboard', 'worktrees', taskId);
}

function backlogText(root) {
  return fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
}

// Double quotes so a node path containing spaces survives the argv split; the
// -e scripts below therefore use single quotes only.
function q(value) {
  return `"${value}"`;
}

function nodeCmd(script) {
  return `${q(process.execPath)} -e ${q(script)}`;
}

const PRINT_CWD = nodeCmd('console.log(process.cwd())');

async function startServer(root, extraEnv = {}) {
  const server = await startBoard(root, extraEnv);
  activeServers.push(server);
  return server;
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) await removeTree(activeRoots.pop());
});

// This request does not merely start a process: it runs `git worktree add`
// first, and only answers once a whole checkout has been written. The board
// gives that call two minutes of its own for exactly that reason (T-0171), so
// the 20 s default deadline of helpers/bounded.js is tighter than what the
// product considers healthy — under four concurrent suites the request came back
// after more than 20 s in 2 of 4 runs and the test failed on its own client's
// clock, with the board still working. Timed afterwards over 24 of these
// requests under the same load: 9.5 s median, 15.7 s worst, which is what the
// 30 s of SPAWN_WAIT_BUDGET_MS was chosen against.
//
// T-0223 measured it again on a machine loaded the same way but carrying a
// bigger suite, and the worst case had grown into the budget: of 9268 requests
// in four concurrent runs, the 21 slowest included this one at 29.0 s three
// times — one hiccup short of failing, and 20 of those 21 were this endpoint.
// So the budget is now named after what it bounds and is twice that worst case,
// while still ending well inside the two minutes the board itself allows: a
// board that has genuinely stopped answering fails the test, it does not hang it.
function start(server, id = 'T-0013') {
  return fetch(server.baseUrl + `/api/task/${id}/start`, {
    method: 'POST',
    timeoutMs: SESSION_START_TIMEOUT_MS,
  });
}

function open(server, id = 'T-0011') {
  return fetch(server.baseUrl + `/api/task/${id}/open`, { method: 'POST' });
}

// ---------- the worker session ----------

describe('POST /api/task/:id/start with BRIEFBOARD_WORKER_CMD', () => {
  it('starts the session inside its own git worktree, on branch task/T-NNNN', async () => {
    const root = makeRepoRoot();
    const beforeHead = git(['rev-parse', 'HEAD'], root);
    const beforeBranch = git(['branch', '--show-current'], root);
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

    const data = await readJson(await start(server));

    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    assert.strictEqual(data.session, 'started', answerOf(data));
    await waitFor(() => hasSessionLine(root), SPAWN_WAIT_BUDGET_MS, 'the session cwd line');

    const tree = worktreePath(root, 'T-0013');
    assert.strictEqual(fs.realpathSync(firstSessionLine(root)), fs.realpathSync(tree));
    assert.strictEqual(git(['branch', '--show-current'], tree), 'task/T-0013');
    // The shared checkout keeps its own HEAD and branch (T-0064).
    assert.strictEqual(git(['rev-parse', 'HEAD'], root), beforeHead);
    assert.strictEqual(git(['branch', '--show-current'], root), beforeBranch);
  });

  // The other order of the same two writes, forced instead of waited for: the
  // hint is already in the log when the cwd is read. Both orders are green only
  // if the assertion takes a line rather than the file (T-0120).
  it('the cwd is still readable once the empty-run hint has been appended', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

    assert.strictEqual((await readJson(await start(server))).session, 'started');
    await waitFor(() => EMPTY_RUN_HINT.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the empty-run hint');

    assert.strictEqual(
      fs.realpathSync(firstSessionLine(root)),
      fs.realpathSync(worktreePath(root, 'T-0013'))
    );
  });

  it('runs the worker template, never the briefing one', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('BRIEFING {id}')"),
      BRIEFBOARD_WORKER_CMD: nodeCmd("console.log('implementing {id}')"),
    });

    const data = await readJson(await start(server));

    assert.strictEqual(data.session, 'started', answerOf(data));
    await waitFor(() => /implementing T-0013/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the worker output');
    assert.doesNotMatch(readSessionLogs(root), /BRIEFING/);
  });

  it('/api/board reports the two commands apart', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

    const data = await readJson(await fetch(server.baseUrl + '/api/board'));

    assert.deepStrictEqual(data.sessions, {
      enabled: false,
      worker: true,
      orchestrator: false,
      profiles: [],
      // Neither template can take a profile — this one has no {profile} in it,
      // the other is not configured at all (T-0121).
      profileUsedBy: { briefing: false, worker: false, orchestrator: false },
    });
  });

  it('the command is never taken from the request body', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: nodeCmd("console.log('configured {id}')"),
    });

    const res = await fetch(server.baseUrl + '/api/task/T-0013/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: nodeCmd("console.log('INJECTED')"), cmd: 'whoami' }),
      timeoutMs: SESSION_START_TIMEOUT_MS, // a worktree is created inside it — see start()
    });
    const data = await readJson(res);

    assert.strictEqual(data.session, 'started', answerOf(data));
    await waitFor(() => /configured T-0013/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the configured command');
    assert.doesNotMatch(readSessionLogs(root), /INJECTED/);
  });
});

// ---------- the transition stands on its own ----------

describe('the ready -> in_progress transition does not depend on the session', () => {
  it('without BRIEFBOARD_WORKER_CMD the task still moves and nothing is spawned', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: PRINT_CWD });

    const data = await readJson(await start(server));

    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    assert.strictEqual(data.session, 'disabled', answerOf(data));
    assert.match(backlogText(root), /## T-0013[\s\S]*?- status: in_progress/);
    await sleep(200);
    // The sessions directory, not the whole of .briefboard: since T-0186 every
    // board writes its trace under boards/ whether a session runs or not.
    assert.strictEqual(fs.existsSync(path.join(root, '.briefboard', 'sessions')), false);
  });

  it('a session that cannot start leaves the task in_progress and the server serving', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: 'briefboard-no-such-binary-xyz --task {id}',
    });

    const res = await start(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    assert.strictEqual(data.session, 'error', answerOf(data));
    assert.match(backlogText(root), /## T-0013[\s\S]*?- status: in_progress/);
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.strictEqual(board.tasks.find((t) => t.id === 'T-0013').status, 'in_progress', answerOf(board));
  });

  it('a project that is not a git repository refuses the session, not the transition', async () => {
    const root = makeRoot(); // no git init
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

    const res = await start(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    assert.strictEqual(data.session, 'not-a-repo', answerOf(data));
    assert.match(backlogText(root), /## T-0013[\s\S]*?- status: in_progress/);
    await waitFor(
      () => /isolation failed \(not-a-repo\)/.test(readSessionLogs(root)),
      SPAWN_WAIT_BUDGET_MS,
      'the refusal in the session log'
    );
  });
});

// ---------- answering a worker's questions restarts the worker (T-0101) ----------

// A worker session that hits an unclear brief stops and asks in the task
// description, and the task stays in `in_progress`. Answering from the card then
// has to resume THAT session: restarting the briefing kind would re-brief a task
// already under implementation, and it would run in the shared checkout, which
// is the one place a worker must never write.
describe('POST /api/task/:id/answer with restart, on a task in in_progress', () => {
  function backlogWithAskingWorker() {
    return [
      '# Backlog\n',
      '## T-0013 · Major · Worker stopped to ask',
      '- type: feature',
      '- status: in_progress',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: T-0013-01',
      '',
      'Implementing.',
      '',
      '### Session questions',
      '',
      '- Which of the two schemas is the real one?',
      '',
    ].join('\n');
  }

  function answer(server, body, id = 'T-0013') {
    return fetch(server.baseUrl + `/api/task/${id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('runs the worker template in the task worktree, never the briefing one', async () => {
    const root = makeRepoRoot(backlogWithAskingWorker());
    const server = await startServer(root, {
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('BRIEFING {id}')"),
      BRIEFBOARD_WORKER_CMD: nodeCmd("console.log('resuming {id} in ' + process.cwd())"),
    });

    const res = await answer(server, { text: 'The second one.', restart: true });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    assert.strictEqual(data.session, 'started', answerOf(data));
    await waitFor(() => /resuming T-0013 in /.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the worker output');
    assert.doesNotMatch(readSessionLogs(root), /BRIEFING/);

    const cwd = /resuming T-0013 in (.*)/.exec(readSessionLogs(root))[1].trim();
    assert.strictEqual(fs.realpathSync(cwd), fs.realpathSync(worktreePath(root, 'T-0013')));
    assert.strictEqual(git(['branch', '--show-current'], worktreePath(root, 'T-0013')), 'task/T-0013');
  });

  it('the answer is written even when that session cannot be isolated', async () => {
    const root = makeRoot(backlogWithAskingWorker()); // no git init
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

    const data = await readJson(await answer(server, { text: 'Saved anyway.', restart: true }));

    assert.strictEqual(data.session, 'not-a-repo', answerOf(data));
    assert.match(backlogText(root), /### Answers\nSaved anyway\./);
  });
});

// ---------- the briefing session is unchanged (T-0076 regression) ----------

describe('the briefing session behind /open keeps its own command and no isolation', () => {
  it('runs in the shared checkout and creates no worktree, even with a worker command set', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_SESSION_CMD: PRINT_CWD,
      BRIEFBOARD_WORKER_CMD: nodeCmd("console.log('WORKER {id}')"),
    });

    const data = await readJson(await open(server));

    assert.strictEqual(data.status, 'open', answerOf(data));
    assert.strictEqual(data.session, 'started', answerOf(data));
    await waitFor(() => hasSessionLine(root), SPAWN_WAIT_BUDGET_MS, 'the session cwd line');

    assert.strictEqual(fs.realpathSync(firstSessionLine(root)), fs.realpathSync(root));
    assert.doesNotMatch(readSessionLogs(root), /WORKER/);
    assert.strictEqual(fs.existsSync(path.join(root, '.briefboard', 'worktrees')), false);
    assert.strictEqual(git(['branch', '--list', 'task/T-0011'], root), '');
  });
});
