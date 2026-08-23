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
const { spawnSync } = require('node:child_process');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch, SESSION_START_TIMEOUT_MS } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { removeTree } = require('./helpers/rm.js');
const { tempDir } = require('./helpers/tmp.js');

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
  const root = tempDir('briefboard-worker-api-test-');
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

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

/**
 * Runs the CLI against the shared backlog of `root`, as an agent would. The
 * budget is the caller's: a `show` is a file read, while `rework` waits for the
 * board to finish a `git worktree add` and is bounded by what that request was
 * measured at (SESSION_START_TIMEOUT_MS, T-0223).
 */
function cli(root, args, timeoutMs = SPAWN_WAIT_BUDGET_MS) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, AGENTBOARD_ROOT: root },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

/** The same call where a failure is the fixture breaking, not the assertion. */
function cliOk(root, args) {
  const res = cli(root, args);
  if (res.status !== 0) throw new Error(`task.mjs ${args.join(' ')}: ${res.stderr || res.stdout}`);
  return res;
}

/** The task's status as the CLI reads it out of the shared backlog. */
function statusOf(root, id = 'T-0013') {
  const res = cli(root, ['show', id]);
  if (res.status !== 0) throw new Error(`task.mjs show ${id}: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout).status;
}

function setStatus(root, id, status) {
  const res = cli(root, ['status', id, status]);
  if (res.status !== 0) throw new Error(`task.mjs status ${id} ${status}: ${res.stderr || res.stdout}`);
}

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

// ---------- the transition and the session are reported apart ----------

describe('the ready -> in_progress transition is answered separately from the session', () => {
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

  // The failure is still a 200 with its own `reason`, and the board is still
  // serving afterwards — what changed with T-0325 is only where the card ends up,
  // which the suite below owns.
  it('a session that cannot start is reported and does not take the board down', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: 'briefboard-no-such-binary-xyz --task {id}',
    });

    const res = await start(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.session, 'error', answerOf(data));
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.strictEqual(board.tasks.find((t) => t.id === 'T-0013').status, 'ready', answerOf(board));
  });

  it('a project that is not a git repository refuses the session with its own reason', async () => {
    const root = makeRoot(); // no git init
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

    const res = await start(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.session, 'not-a-repo', answerOf(data));
    await waitFor(
      () => /isolation failed \(not-a-repo\)/.test(readSessionLogs(root)),
      SPAWN_WAIT_BUDGET_MS,
      'the refusal in the session log'
    );
  });
});

// ---------- a dispatch that never reached a session puts the task back (T-0325) ----------
//
// `in_progress` must mean an agent is on the task, not that somebody tried: a
// setup that fails leaves a card nobody is working on and no session to see.
// Every status here is read back through `tools/task.mjs show`, not from the
// response — the response is the thing under test, and a payload agreeing with
// itself proves nothing about the file the board and the next `start` read.
//
// Which failures are exercised: a setup command that exits non-zero, a worktree
// that cannot be created, a worker command the OS refuses to spawn, a run
// profile the board declines, and a setup command that never returns. The last
// one could not be tested when T-0325 wrote these: the budget was a fixed ten
// minutes with nothing feeding it from outside, so the only reachable test was
// one that spent ten minutes proving a ten-minute bound. T-0328 made the budget
// a setting a project sets for its own install command, and the case now costs
// a quarter of a second.
describe('POST /api/task/:id/start rolls the transition back when no session starts', () => {
  const SETUP_FAILS = nodeCmd("console.log('SETUP RAN'); process.exit(3)");
  // Never exits: the install that never ends is what the budget exists for, and
  // it is the only fixture whose ending is the budget rather than the command.
  const SETUP_HANGS = nodeCmd("console.log('SETUP HANGING'); setInterval(function () {}, 1000)");
  // Fails the first time and succeeds the second, told apart by a file it leaves
  // in its own cwd — which is the worktree, so the state survives between the two
  // starts exactly as an interrupted `npm ci` would.
  const SETUP_FAILS_ONCE = nodeCmd(
    "const fs = require('fs');" +
      "if (fs.existsSync('attempted')) { console.log('SETUP OK'); }" +
      " else { fs.writeFileSync('attempted', '1'); console.log('SETUP FAILING'); process.exit(1); }"
  );
  // Hands the test the turn: it announces itself, then fails only once the test
  // says so. No sleep anywhere — the window in which the card is moved is opened
  // and closed by the test, not waited out.
  const SETUP_WAITS_THEN_FAILS = nodeCmd(
    "const fs = require('fs');" +
      "fs.writeFileSync('setup-started', '1');" +
      "const t = setInterval(function () {" +
      " if (fs.existsSync('go')) { clearInterval(t); process.exit(1); } }, 25);"
  );

  it('a setup command that exits non-zero: refused, and the task is ready again', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_FAILS,
    });

    const data = await readJson(await start(server));

    assert.strictEqual(data.session, 'setup-failed', answerOf(data));
    assert.strictEqual(data.rolledBack, true, answerOf(data));
    assert.strictEqual(data.status, 'ready', answerOf(data));
    assert.strictEqual(statusOf(root), 'ready');
    // Requirement 2 of the request, asserted where it is decided: the board
    // registered no session at all, so there is nothing for a human to act on and
    // nothing for `in_progress` to have meant.
    const sessions = await readJson(await fetch(server.baseUrl + '/api/sessions'));
    assert.deepStrictEqual(
      sessions.sessions.filter((s) => s.id === 'T-0013'),
      [],
      answerOf(sessions)
    );
  });

  // T-0325's fifth failure mode, reachable since T-0328 gave the budget a
  // setting. The fixture never exits, so nothing here finishes early and the
  // only thing that can end the request is the budget itself: with the wiring
  // gone the board falls back to ten minutes, and the bounded fetch then FAILS
  // this at SESSION_START_TIMEOUT_MS rather than let the run hang — measured by
  // removing the wiring, 61.3 s against the 2.7 s it costs green.
  it('a setup command that never returns: refused at the budget, and the task is ready again', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_HANGS,
      BRIEFBOARD_SETUP_TIMEOUT_MS: '250',
    });

    const data = await readJson(await start(server));

    assert.strictEqual(data.session, 'setup-timeout', answerOf(data));
    assert.strictEqual(data.rolledBack, true, answerOf(data));
    assert.strictEqual(data.status, 'ready', answerOf(data));
    assert.strictEqual(statusOf(root), 'ready');
    const sessions = await readJson(await fetch(server.baseUrl + '/api/sessions'));
    assert.deepStrictEqual(
      sessions.sessions.filter((s) => s.id === 'T-0013'),
      [],
      answerOf(sessions)
    );
    await waitFor(
      () => /killed after 250 ms/.test(readSessionLogs(root)),
      SPAWN_WAIT_BUDGET_MS,
      'the setup-timeout line naming the budget that was applied'
    );
  });

  it('a worktree that cannot be created: refused, and the task is ready again', async () => {
    const root = makeRoot(); // no git init, so `git worktree add` has nothing to add to
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

    const data = await readJson(await start(server));

    assert.strictEqual(data.session, 'not-a-repo', answerOf(data));
    assert.strictEqual(data.rolledBack, true, answerOf(data));
    assert.strictEqual(statusOf(root), 'ready');
  });

  it('a worker command that cannot be spawned: refused, and the task is ready again', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: 'briefboard-no-such-binary-xyz --task {id}',
    });

    const data = await readJson(await start(server));

    assert.strictEqual(data.session, 'error', answerOf(data));
    assert.strictEqual(data.rolledBack, true, answerOf(data));
    assert.strictEqual(statusOf(root), 'ready');
  });

  it('a profile the board does not know: refused before anything is prepared, and ready again', async () => {
    const root = makeRepoRoot(
      backlogWithReadyTask().replace('- briefs: T-0013-01', '- briefs: T-0013-01\n- profile: nope')
    );
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_PROFILES: 'fast, slow',
    });

    const data = await readJson(await start(server));

    assert.strictEqual(data.session, 'unknown-profile', answerOf(data));
    assert.strictEqual(data.rolledBack, true, answerOf(data));
    assert.strictEqual(statusOf(root), 'ready');
    assert.strictEqual(fs.existsSync(worktreePath(root, 'T-0013')), false, 'nothing was prepared');
  });

  // The other half, and not a formality: a rollback that also fired on the happy
  // path would pass every test above and undo every real dispatch.
  it('a start that DOES reach a session leaves the task in_progress, with the session registered', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

    const data = await readJson(await start(server));

    assert.strictEqual(data.session, 'started', answerOf(data));
    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    assert.strictEqual(data.rolledBack, undefined, 'the happy path attempts no rollback');
    assert.strictEqual(statusOf(root), 'in_progress');
    const sessions = await readJson(await fetch(server.baseUrl + '/api/sessions'));
    assert.ok(
      sessions.sessions.some((s) => s.id === 'T-0013' && s.kind === 'worker'),
      answerOf(sessions)
    );
  });

  it('the setup output is in the session log after the task has been put back', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_FAILS,
    });

    assert.strictEqual((await readJson(await start(server))).rolledBack, true);

    assert.strictEqual(statusOf(root), 'ready');
    await waitFor(() => /SETUP RAN/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the setup output');
    assert.match(readSessionLogs(root), /setup failed \(setup-failed\)/);
  });

  // Requirement 7 of the request: the stamp is written only on success, so a
  // failed setup suppresses nothing. The rollback is what makes the retry a
  // retry — from `ready`, through the same endpoint, with no hand-editing.
  it('a retry after a failed setup runs setup again and the task moves for real', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_FAILS_ONCE,
    });

    const first = await readJson(await start(server));
    assert.strictEqual(first.session, 'setup-failed', answerOf(first));
    assert.strictEqual(statusOf(root), 'ready');
    await waitFor(() => /SETUP FAILING/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the first setup');
    assert.strictEqual(
      fs.existsSync(path.join(root, '.briefboard', 'worktrees', 'T-0013.setup.json')),
      false,
      'a failed setup leaves no stamp to skip the retry'
    );

    const second = await readJson(await start(server));

    assert.strictEqual(second.session, 'started', answerOf(second));
    assert.strictEqual(second.status, 'in_progress', answerOf(second));
    assert.strictEqual(statusOf(root), 'in_progress');
    await waitFor(() => /SETUP OK/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the second setup');
  });

  // A slot held by a session that was never registered would only show on the
  // SECOND failure, and with the cap at one it shows as a different reason.
  it('a failed setup holds no session slot: the cap is never reached by failures', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_FAILS,
      BRIEFBOARD_SESSION_MAX: '1',
    });

    for (const attempt of [1, 2, 3]) {
      const data = await readJson(await start(server));
      assert.strictEqual(data.session, 'setup-failed', `attempt ${attempt}: ${answerOf(data)}`);
      assert.strictEqual(statusOf(root), 'ready', `attempt ${attempt}`);
    }
  });

  // The condition on the rollback, driven rather than reasoned about: the card is
  // moved WHILE the setup runs, in the window the two locked writes leave open,
  // and the repair must then keep its hands off.
  it('a task that moved on while setup ran is left exactly where it was moved to', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_WAITS_THEN_FAILS,
    });
    const tree = worktreePath(root, 'T-0013');

    const pending = start(server);
    await waitFor(
      () => fs.existsSync(path.join(tree, 'setup-started')),
      SPAWN_WAIT_BUDGET_MS,
      'the setup command to announce itself'
    );
    // Exactly what a worker session does when it reaches its briefs before the
    // board has finished answering: a legal transition, made by somebody else.
    setStatus(root, 'T-0013', 'review');
    fs.writeFileSync(path.join(tree, 'go'), '1');

    const data = await readJson(await pending);

    assert.strictEqual(data.session, 'setup-failed', answerOf(data));
    assert.strictEqual(data.rolledBack, false, answerOf(data));
    assert.strictEqual(data.status, 'review', answerOf(data));
    assert.strictEqual(statusOf(root), 'review', 'the later decision outranks the repair');
  });
});

// ---------- the setup budget a project sets for itself (T-0328) ----------

// The value comes straight out of the environment, so the interesting inputs are
// the ones a person types by mistake. `setTimeout` reads '' as 0 and a typo as
// NaN, and both mean "fire now": unnormalized, a mistyped budget would kill
// every setup command on its first tick and refuse every session the board was
// asked to start. So the fallback is not tidiness — it is the difference between
// a typo that is ignored and a typo that turns the feature off.
describe('BRIEFBOARD_SETUP_TIMEOUT_MS bounds the setup command', () => {
  const SETUP_OK = nodeCmd("console.log('SETUP OK')");

  it('a value that is not a positive number leaves the shipped default in place', async () => {
    for (const value of ['', 'ten minutes', '0', '-250']) {
      const root = makeRepoRoot();
      const server = await startServer(root, {
        BRIEFBOARD_WORKER_CMD: PRINT_CWD,
        BRIEFBOARD_SETUP_CMD: SETUP_OK,
        BRIEFBOARD_SETUP_TIMEOUT_MS: value,
      });

      const data = await readJson(await start(server));

      assert.strictEqual(data.session, 'started', `${JSON.stringify(value)}: ${answerOf(data)}`);
      assert.strictEqual(data.status, 'in_progress', answerOf(data));
      await waitFor(
        () => /SETUP OK/.test(readSessionLogs(root)),
        SPAWN_WAIT_BUDGET_MS,
        `the setup output for ${JSON.stringify(value)}`
      );
      assert.doesNotMatch(readSessionLogs(root), /setup-timeout/);
    }
  });

  it('a budget wide enough for the command does not interfere with it', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_OK,
      BRIEFBOARD_SETUP_TIMEOUT_MS: String(SPAWN_WAIT_BUDGET_MS),
    });

    const data = await readJson(await start(server));

    assert.strictEqual(data.session, 'started', answerOf(data));
    await waitFor(() => /SETUP OK/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the setup output');
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

// ---------- the dispatch a returned card never had (T-0329) ----------
//
// `review -> in_progress` was always a legal transition and never needed
// `--force`; what did not exist was an operation that puts a WORKER on a task
// past `ready`. So what is under test here is the dispatch — the same isolated
// session as /start, on the branch the previous round is already on — and the
// three refusals that are this endpoint's own rather than /start's.
//
// Every status is read back through `tools/task.mjs show`, never from the
// response: the response is the thing under test, and a payload agreeing with
// itself proves nothing about the file the board and the next dispatch read.
// ---------- fixtures the two dispatches past `ready` share ----------
// Written once for the rework suite (T-0329) and used unchanged by the resume one
// (T-0333): both put a worker on a task that already has a branch, so both need
// the same setup counter, the same long-running session and the same way of
// reading the registry. A second copy is how the two suites would start proving
// different things about one endpoint pair.

// Counted by a mark in the project, not by a line in the log: the runner
// echoes the setup command line into that log, so a command announcing itself
// is in there twice for one run and the count would confirm the fixture rather
// than the code (T-0182).
const SETUP_MARK = 'setup-runs.txt';
const SETUP_RUNS = nodeCmd(
  "const fs = require('fs');" +
    "const path = require('path');" +
    `fs.appendFileSync(path.join(process.env.AGENTBOARD_ROOT, '${SETUP_MARK}'), 'ran\\n')`
);

const setupRuns = (root) => {
  const file = path.join(root, SETUP_MARK);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('ran').length - 1 : 0;
};
// Fails only once the test says so, and it keys on a file in the PROJECT rather
// than in its own cwd: the cwd is the worktree, and the worktree of the run
// this has to fail is one that does not exist yet.
const SETUP_FAILS_ON_DEMAND = nodeCmd(
  "const fs = require('fs');" +
    "const path = require('path');" +
    "if (fs.existsSync(path.join(process.env.AGENTBOARD_ROOT, 'fail-setup'))) {" +
    " console.log('SETUP FAILING'); process.exit(1); }" +
    " console.log('SETUP RAN')"
);
const LONG_SESSION = nodeCmd('setInterval(function () {}, 1000)');

async function sessionOf(server, id = 'T-0013') {
  const data = await readJson(await fetch(server.baseUrl + '/api/sessions'));
  return data.sessions.find((s) => s.id === id) || null;
}

/**
 * Waits until the task's session is over, and answers with its record. A round
 * that is still running is a refusal of its own for both dispatches, so a test
 * wanting the NEXT one waits for this rather than racing it.
 */
function sessionEnded(server, id = 'T-0013') {
  return waitFor(
    async () => {
      const record = await sessionOf(server, id);
      return record && record.status !== 'running' ? record : null;
    },
    SPAWN_WAIT_BUDGET_MS,
    `the session of ${id} to end`
  );
}

/** A branch for a task nobody has run here yet, so a dispatch has one to reuse. */
function makeBranch(root, id = 'T-0013') {
  git(['branch', `task/${id}`], root);
}

describe('POST /api/task/:id/rework', () => {
  /** The same fixture, with the ready task already handed back for review. */
  function backlogWithReviewTask() {
    return backlogWithReadyTask().replace('- status: ready', '- status: review');
  }

  function rework(server, id = 'T-0013') {
    // A worktree is created inside this request exactly as /start's is, so it is
    // bounded by the number measured for that one (T-0223), not by the default.
    return fetch(server.baseUrl + `/api/task/${id}/rework`, {
      method: 'POST',
      timeoutMs: SESSION_START_TIMEOUT_MS,
    });
  }

  /**
   * Round one, as the board itself performs it: the drop into In Progress, a
   * commit the worker leaves on its branch, and the status it writes when it is
   * done. It returns with that session ENDED — a live one is a refusal of its
   * own, which is a test below rather than a race here.
   */
  async function firstRound(server, root, id = 'T-0013') {
    const started = await readJson(await start(server, id));
    assert.strictEqual(started.session, 'started', answerOf(started));
    const ended = await sessionEnded(server, id);
    const tree = worktreePath(root, id);
    fs.writeFileSync(path.join(tree, 'round-one.txt'), 'what the first round did\n');
    git(['add', '.'], tree);
    git(['commit', '-m', 'round one'], tree);
    setStatus(root, id, 'review');
    return { pid: ended.pid, commit: git(['rev-parse', 'HEAD'], tree), tree };
  }

  // The acceptance criterion the endpoint exists for, in one test: two rounds,
  // and the second one is a session that is genuinely new while the branch and
  // the worktree are genuinely the old ones.
  it('dispatches a second round: a new session, on the same branch and worktree', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    const first = await firstRound(server, root);
    cliOk(root, ['note', 'T-0013', '--section', 'Review verdict', '--text', 'REWORK: the second half is missing.']);

    const data = await readJson(await rework(server));

    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    assert.strictEqual(data.session, 'started', answerOf(data));
    assert.strictEqual(statusOf(root), 'in_progress');
    const second = await waitFor(
      async () => {
        const record = await sessionOf(server);
        return record && record.pid !== first.pid ? record : null;
      },
      SPAWN_WAIT_BUDGET_MS,
      'a session that is not the first one'
    );
    assert.strictEqual(second.kind, 'worker', answerOf(second));
    // Its own log, and not an append to the previous round's: a log per session
    // is what keeps the two rounds readable apart (T-0329, requirement 7).
    await waitFor(() => sessionLogs(root).length === 2, SPAWN_WAIT_BUDGET_MS, 'the second session log');
    // The branch and the worktree are the ones the first round left, which is
    // the whole difference between a rework and a start.
    assert.strictEqual(worktreePath(root, 'T-0013'), first.tree);
    assert.strictEqual(git(['branch', '--show-current'], first.tree), 'task/T-0013');
    assert.strictEqual(
      git(['rev-parse', 'HEAD'], first.tree),
      first.commit,
      'the correction begins on the round it is correcting, not on HEAD'
    );
  });

  it('the first round is still readable afterwards: the report, and a verdict that keeps its own section', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    await firstRound(server, root);
    cliOk(root, ['note', 'T-0013', '--section', 'Worker report', '--text', 'Branch: task/T-0013 (round one)']);
    cliOk(root, ['note', 'T-0013', '--section', 'Review verdict', '--text', 'REWORK: round one is not enough.']);

    assert.strictEqual((await readJson(await rework(server))).session, 'started');
    cliOk(root, ['note', 'T-0013', '--section', 'Review verdict', '--text', 'ACCEPT: round two is.']);

    const text = backlogText(root);
    assert.match(text, /Branch: task\/T-0013 \(round one\)/, "the first worker's report is still there");
    assert.match(text, /REWORK: round one is not enough\./, 'and so is the verdict that sent it back');
    assert.match(text, /ACCEPT: round two is\./);
    assert.strictEqual(
      text.split('\n').filter((line) => line.trim() === '### Review verdict').length,
      2,
      'the second verdict opens its own section: merged into the first it would judge the old code as current (T-0122)'
    );
  });

  // Derived from what is already written, and from nothing this card added
  // (decision 6). The registry was the other candidate and is not durable: it
  // belongs to one board process, which marks what it inherits as `interrupted`.
  it('the round it is beginning is one past the verdicts already written', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    await firstRound(server, root);

    // A card a human sent back without a review session: no verdict, first round.
    const bare = await readJson(await rework(server));
    assert.strictEqual(bare.round, 1, answerOf(bare));

    await sessionEnded(server);
    setStatus(root, 'T-0013', 'review');
    cliOk(root, ['note', 'T-0013', '--section', 'Review verdict', '--text', 'REWORK.']);
    const second = await readJson(await rework(server));
    assert.strictEqual(second.round, 2, answerOf(second));

    await sessionEnded(server);
    setStatus(root, 'T-0013', 'review');
    cliOk(root, ['note', 'T-0013', '--section', 'Review verdict', '--text', 'REWORK again.']);
    const third = await readJson(await rework(server));
    assert.strictEqual(third.round, 3, answerOf(third));
    // Derived means derived: nothing about a round reaches the file.
    assert.doesNotMatch(backlogText(root), /^- round:/m);
  });

  // ---------- the branch is the thing that must exist ----------

  it('a missing task/T-NNNN branch is refused, and the card stays in review', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    const first = await firstRound(server, root);
    // Deleted rather than reasoned about: git will not delete a branch that is
    // checked out, so the worktree goes first.
    git(['worktree', 'remove', '--force', first.tree], root);
    git(['branch', '-D', 'task/T-0013'], root);
    const before = backlogText(root);

    const res = await rework(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'no-branch', answerOf(data));
    assert.match(data.error, /task\/T-0013/, 'the refusal names the branch it looked for');
    assert.strictEqual(statusOf(root), 'review');
    assert.strictEqual(backlogText(root), before, 'a refused rework writes nothing');
  });

  it('a missing worktree over a live branch is NOT refused: it is recreated on that branch', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    const first = await firstRound(server, root);
    // Only the directory, the way the board's own cleanup removes one: the branch
    // and its commits stay, so nothing of the round is lost by recreating it.
    git(['worktree', 'remove', '--force', first.tree], root);
    assert.strictEqual(fs.existsSync(first.tree), false);

    const data = await readJson(await rework(server));

    assert.strictEqual(data.session, 'started', answerOf(data));
    assert.strictEqual(statusOf(root), 'in_progress');
    assert.strictEqual(fs.existsSync(path.join(first.tree, '.git')), true, 'the worktree is back');
    assert.strictEqual(git(['branch', '--show-current'], first.tree), 'task/T-0013');
    assert.strictEqual(
      git(['rev-parse', 'HEAD'], first.tree),
      first.commit,
      'and it is the previous round that came back with it'
    );
  });

  // The other half of the same rule, and the half that costs money: the worktree
  // the first round left is reused, so the project's install is not paid for a
  // second time. The stamp beside the worktree is what records that (T-0150).
  it('an existing worktree is reused, and its preparation is not run again', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_RUNS,
    });
    const first = { tree: worktreePath(root, 'T-0013') };
    await firstRound(server, root);
    // The dispatch answers only once its setup has finished, so this needs no
    // wait of its own — a run that had not happened by now never will.
    assert.strictEqual(setupRuns(root), 1, 'the first round paid for the install');

    const data = await readJson(await rework(server));

    assert.strictEqual(data.session, 'started', answerOf(data));
    assert.strictEqual(fs.existsSync(path.join(first.tree, '.git')), true, 'the same worktree');
    assert.strictEqual(
      setupRuns(root),
      1,
      'the stamp beside the worktree is what makes the second round skip the install'
    );
  });

  // ---------- refusals that leave the card exactly where it was ----------

  it('a task that is not in review is refused, and the backlog is untouched', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    makeBranch(root);
    const before = backlogText(root);

    const res = await rework(server); // T-0013 is `ready`
    const data = await readJson(res);

    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'bad-status', answerOf(data));
    assert.strictEqual(statusOf(root), 'ready');
    assert.strictEqual(backlogText(root), before);
  });

  it('a task the board has never heard of is a 404, not a missing branch', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    const before = backlogText(root);

    const res = await rework(server, 'T-9999');
    const data = await readJson(res);

    assert.strictEqual(res.status, 404, answerOf(data));
    assert.strictEqual(data.reason, undefined, 'an unknown id is not a branch that went missing');
    assert.strictEqual(backlogText(root), before);
  });

  // Refused BEFORE the transition, which is where this endpoint differs from
  // /start on purpose: a `review` card's running session is the review one, and
  // moving the card out from under it buys nothing.
  it('a session already running on the task is refused before anything is written', async () => {
    const root = makeRepoRoot(backlogWithReviewTask());
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_REVIEW_CMD: LONG_SESSION,
    });
    makeBranch(root);
    const review = await readJson(
      await fetch(server.baseUrl + '/api/task/T-0013/review', { method: 'POST' })
    );
    assert.strictEqual(review.session, 'started', answerOf(review));
    const before = backlogText(root);

    const res = await rework(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'already-running', answerOf(data));
    assert.strictEqual(statusOf(root), 'review');
    assert.strictEqual(backlogText(root), before, 'nothing was written under the running session');
    assert.strictEqual(fs.existsSync(worktreePath(root, 'T-0013')), false, 'and nothing was prepared');
  });

  it('the concurrency cap leaves the card in review, and the file byte-identical', async () => {
    const root = makeRepoRoot(backlogWithReviewTask());
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SESSION_CMD: LONG_SESSION,
      BRIEFBOARD_SESSION_MAX: '1',
    });
    makeBranch(root);
    // The one slot goes to another task's briefing session, so the cap is what
    // this rework meets and not a session of its own.
    const opened = await readJson(
      await fetch(server.baseUrl + '/api/task/T-0011/open', { method: 'POST' })
    );
    assert.strictEqual(opened.session, 'started', answerOf(opened));
    const before = backlogText(root);

    const data = await readJson(await rework(server));

    assert.strictEqual(data.session, 'limit', answerOf(data));
    assert.strictEqual(data.rolledBack, true, answerOf(data));
    assert.strictEqual(data.status, 'review', answerOf(data));
    assert.strictEqual(statusOf(root), 'review');
    assert.strictEqual(backlogText(root), before, 'the transition and its rollback leave the file as it was');
  });

  // ---------- the rollback restores the status this transition came from ----------

  it('a dispatch that fails after the transition puts the card back to review, not to ready', async () => {
    const root = makeRepoRoot(backlogWithReviewTask());
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_FAILS_ON_DEMAND,
    });
    makeBranch(root);
    fs.writeFileSync(path.join(root, 'fail-setup'), '1');

    const data = await readJson(await rework(server));

    assert.strictEqual(data.session, 'setup-failed', answerOf(data));
    assert.strictEqual(data.rolledBack, true, answerOf(data));
    assert.strictEqual(data.status, 'review', answerOf(data));
    assert.strictEqual(statusOf(root), 'review', 'a returned card goes back to review; `ready` would lose the round');
    await waitFor(() => /SETUP FAILING/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the setup output');
    const sessions = await readJson(await fetch(server.baseUrl + '/api/sessions'));
    assert.deepStrictEqual(
      sessions.sessions.filter((s) => s.id === 'T-0013'),
      [],
      'nothing was registered, which is what the rollback is for'
    );
  });

  // The other half, and not a formality: a rollback that also fired on the happy
  // path would pass the test above and undo every real dispatch.
  it('a rework that DOES reach a session attempts no rollback', async () => {
    const root = makeRepoRoot(backlogWithReviewTask());
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    makeBranch(root);

    const data = await readJson(await rework(server));

    assert.strictEqual(data.session, 'started', answerOf(data));
    assert.strictEqual(data.rolledBack, undefined, answerOf(data));
    assert.strictEqual(statusOf(root), 'in_progress');
  });

  // ---------- one endpoint, two callers ----------
  //
  // The board's own action and `tools/task.mjs rework` are the same POST, so
  // what is asserted is the STATE each of them leaves — a sentence saying they
  // agree would go on saying it after one of them stopped.
  it('the CLI and the board action leave a card in the same state', async () => {
    const root = makeRepoRoot(
      backlogWithReviewTask() +
        [
          '## T-0014 · Major · Second task in review',
          '- type: feature',
          '- status: review',
          '- created: 2026-01-01 00:00:00',
          '- closed: —',
          '- briefs: T-0014-01',
          '',
        ].join('\n')
    );
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    makeBranch(root, 'T-0013');
    makeBranch(root, 'T-0014');

    const byBoard = await readJson(await rework(server, 'T-0013'));
    const res = cli(root, ['rework', 'T-0014', '--json'], SESSION_START_TIMEOUT_MS);
    const byCli = JSON.parse(res.stdout);

    assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.strictEqual(byCli.exit, 0, res.stdout);
    for (const field of ['status', 'session', 'round']) {
      assert.strictEqual(byCli[field], byBoard[field], `${field}: ${res.stdout}`);
    }
    assert.strictEqual(statusOf(root, 'T-0013'), statusOf(root, 'T-0014'));
    assert.strictEqual(statusOf(root, 'T-0014'), 'in_progress');
    for (const id of ['T-0013', 'T-0014']) {
      assert.strictEqual(git(['branch', '--show-current'], worktreePath(root, id)), `task/${id}`);
    }
  });
});

// ---------- putting a worker back on a card whose session died (T-0333) ----------
//
// The third dispatch, and the one that moves nothing: the card is already
// `in_progress` and that is the right status for it, so what is under test is a
// SESSION appearing while the file stays exactly as it was. Its refusals are the
// two /rework makes plus the one that is the whole point — a session that is
// genuinely alive — and each of them has to leave doc/backlog.md byte-identical,
// which here is the same assertion as "the card did not move".
//
// Every status is read back through `tools/task.mjs show`, never from the
// response: the response is the thing under test.
describe('POST /api/task/:id/resume', () => {
  function resume(server, id = 'T-0013') {
    // A worktree may be recreated inside this request exactly as /start's is, so
    // it is bounded by the number measured for that one (T-0223).
    return fetch(server.baseUrl + `/api/task/${id}/resume`, {
      method: 'POST',
      timeoutMs: SESSION_START_TIMEOUT_MS,
    });
  }

  /**
   * The card this endpoint exists for, made the way it really happens: a worker
   * is dispatched into `in_progress`, commits something, and its session ends
   * without ever writing `review`. What is left is a card whose status says an
   * agent is on it and a registry that says none is.
   */
  async function deadSession(server, root, id = 'T-0013') {
    const started = await readJson(await start(server, id));
    assert.strictEqual(started.session, 'started', answerOf(started));
    const ended = await sessionEnded(server, id);
    const tree = worktreePath(root, id);
    fs.writeFileSync(path.join(tree, 'half-done.txt'), 'what the session got through\n');
    git(['add', '.'], tree);
    git(['commit', '-m', 'half done'], tree);
    assert.strictEqual(statusOf(root, id), 'in_progress', 'the dead session left the card taken');
    return { pid: ended.pid, commit: git(['rev-parse', 'HEAD'], tree), tree };
  }

  // The acceptance criterion the endpoint exists for, in one test: a session that
  // is genuinely new, on the branch and the worktree the dead one left, and a
  // backlog nobody wrote to — the file is compared byte for byte, because
  // "moves nothing" is the point and a status read alone would pass over a
  // rewrite that changed something else.
  it('starts a new session and moves nothing: the card is in_progress before and after', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    const dead = await deadSession(server, root);
    const before = backlogText(root);

    const data = await readJson(await resume(server));

    assert.strictEqual(data.session, 'started', answerOf(data));
    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    assert.strictEqual(statusOf(root), 'in_progress');
    assert.strictEqual(backlogText(root), before, 'a resume writes nothing at all');
    // Asserted against the REGISTRY and not against the answer above: the answer
    // is what is under test, and `started` says a session began, not which one.
    const second = await waitFor(
      async () => {
        const record = await sessionOf(server);
        return record && record.pid !== dead.pid ? record : null;
      },
      SPAWN_WAIT_BUDGET_MS,
      'a session that is not the one that died'
    );
    assert.strictEqual(second.kind, 'worker', answerOf(second));
    // Its own log, and not an append to the previous session's: a log per session
    // is what keeps the two readable apart. Its STATUS is deliberately not
    // asserted - this fixture's session prints one line and exits, so it may be
    // over before the registry is read, and a session that ran is what was asked
    // for.
    await waitFor(() => sessionLogs(root).length === 2, SPAWN_WAIT_BUDGET_MS, 'the second session log');
    // The work being resumed is what it resumes on.
    assert.strictEqual(git(['branch', '--show-current'], dead.tree), 'task/T-0013');
    assert.strictEqual(
      git(['rev-parse', 'HEAD'], dead.tree),
      dead.commit,
      'the new session begins on what the dead one committed, not on HEAD'
    );
  });

  // The distinction the whole card is about, and the two tests that make it are
  // this one and the one above: the STATUS is `in_progress` in both, and the
  // answers are opposite. So what decides is the registry, which is the only
  // thing that can tell a dead session from a live one.
  it('a session that is genuinely running is refused, and the backlog is untouched', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: LONG_SESSION });
    const started = await readJson(await start(server));
    assert.strictEqual(started.session, 'started', answerOf(started));
    // Not a fixture that merely says `running`: the record is the board's own,
    // for a process it spawned and has not reaped.
    const live = await sessionOf(server);
    assert.strictEqual(live.status, 'running', answerOf(live));
    assert.strictEqual(statusOf(root), 'in_progress');
    const before = backlogText(root);

    const res = await resume(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'already-running', answerOf(data));
    assert.strictEqual(statusOf(root), 'in_progress');
    assert.strictEqual(backlogText(root), before);
    assert.strictEqual((await sessionOf(server)).pid, live.pid, 'and the live session is still the one');
  });

  it('a card in ready, in review or closed is refused with the wrong-status code', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    makeBranch(root); // so the refusal cannot be the branch check answering instead

    // Each entry is what it takes to GET there from the previous one, so the
    // card walks its own lifecycle rather than being written into a state.
    const stepsTo = { ready: [], review: ['in_progress', 'review'], done: ['done'] };
    for (const status of ['ready', 'review', 'done']) {
      for (const step of stepsTo[status]) setStatus(root, 'T-0013', step);
      const before = backlogText(root);

      const res = await resume(server);
      const data = await readJson(res);

      assert.strictEqual(res.status, 409, `${status}: ${answerOf(data)}`);
      assert.strictEqual(data.reason, 'bad-status', `${status}: ${answerOf(data)}`);
      assert.strictEqual(statusOf(root), status);
      assert.strictEqual(backlogText(root), before, `${status}: a refused resume writes nothing`);
      assert.strictEqual(fs.existsSync(worktreePath(root, 'T-0013')), false, 'and prepares nothing');
    }
  });

  it('a task the board has never heard of is a 404, not a missing branch', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    const before = backlogText(root);

    const res = await resume(server, 'T-9999');
    const data = await readJson(res);

    assert.strictEqual(res.status, 404, answerOf(data));
    assert.strictEqual(data.reason, undefined, 'an unknown id is not a branch that went missing');
    assert.strictEqual(backlogText(root), before);
  });

  // ---------- the branch is the thing that must exist (T-0329's rule, unchanged) ----------

  it('a missing task/T-NNNN branch is refused: resuming would start from HEAD without the work', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    const dead = await deadSession(server, root);
    // git will not delete a branch that is checked out, so the worktree goes first.
    git(['worktree', 'remove', '--force', dead.tree], root);
    git(['branch', '-D', 'task/T-0013'], root);
    const before = backlogText(root);

    const res = await resume(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'no-branch', answerOf(data));
    assert.match(data.error, /task\/T-0013/, 'the refusal names the branch it looked for');
    assert.strictEqual(statusOf(root), 'in_progress');
    assert.strictEqual(backlogText(root), before);
    assert.strictEqual(fs.existsSync(dead.tree), false, 'and no worktree was made from HEAD');
  });

  // The opposite case, and the one the orchestrator's brief for T-0329 got wrong
  // before its worker corrected it: the worktree comes back AND its setup runs
  // again, because setUpWorktree() clears the stamp for a worktree it created —
  // the old stamp must not vouch for a tree whose node_modules went with it
  // (T-0150).
  it('a missing worktree over a live branch is recreated, and its preparation runs again', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_RUNS,
    });
    const dead = await deadSession(server, root);
    assert.strictEqual(setupRuns(root), 1, 'the session that died paid for the install');
    git(['worktree', 'remove', '--force', dead.tree], root);
    assert.strictEqual(fs.existsSync(dead.tree), false);

    const data = await readJson(await resume(server));

    assert.strictEqual(data.session, 'started', answerOf(data));
    assert.strictEqual(fs.existsSync(path.join(dead.tree, '.git')), true, 'the worktree is back');
    assert.strictEqual(git(['branch', '--show-current'], dead.tree), 'task/T-0013');
    assert.strictEqual(
      git(['rev-parse', 'HEAD'], dead.tree),
      dead.commit,
      'and the work came back with it'
    );
    assert.strictEqual(setupRuns(root), 2, 'a recreated worktree is not vouched for by the old stamp');
  });

  it('a worktree that is still there is reused, and its preparation is not run again', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SETUP_CMD: SETUP_RUNS,
    });
    const dead = await deadSession(server, root);
    assert.strictEqual(setupRuns(root), 1);

    const data = await readJson(await resume(server));

    assert.strictEqual(data.session, 'started', answerOf(data));
    assert.strictEqual(fs.existsSync(path.join(dead.tree, '.git')), true, 'the same worktree');
    assert.strictEqual(setupRuns(root), 1, 'the stamp beside it is what makes the resume skip the install');
  });

  // ---------- there is no rollback here, and that is the design ----------
  //
  // Its two siblings each undo their transition when the dispatch registers no
  // session (T-0325, T-0329). This one wrote no status, so there is nothing to
  // undo and no status to undo it TO: the card was `in_progress` with no session
  // before the call and is `in_progress` with no session after it. The test that
  // would catch a rollback being added "for symmetry" is this one.
  it('a dispatch that starts no session rolls nothing back, because nothing was written', async () => {
    const root = makeRepoRoot();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      BRIEFBOARD_SESSION_CMD: LONG_SESSION,
      BRIEFBOARD_SESSION_MAX: '1',
    });
    await deadSession(server, root);
    // The one slot goes to another task's briefing session, so what this resume
    // meets is the cap and not a session of its own.
    const opened = await readJson(await open(server, 'T-0011'));
    assert.strictEqual(opened.session, 'started', answerOf(opened));
    const before = backlogText(root);

    const data = await readJson(await resume(server));

    assert.strictEqual(data.session, 'limit', answerOf(data));
    assert.strictEqual(data.rolledBack, undefined, 'nothing was written, so nothing is rolled back');
    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    assert.strictEqual(statusOf(root), 'in_progress', 'the card stays where the dead session left it');
    assert.strictEqual(backlogText(root), before);
  });

  // ---------- one endpoint, two callers ----------
  //
  // What is asserted is the STATE each of them leaves, not that they agree: a
  // sentence saying they agree would go on saying it after one of them stopped.
  it('the CLI and the board action leave a card in the same state', async () => {
    const root = makeRepoRoot(
      backlogWithReadyTask().replace('- status: ready', '- status: in_progress') +
        [
          '## T-0014 · Major · Second task under work',
          '- type: feature',
          '- status: in_progress',
          '- created: 2026-01-01 00:00:00',
          '- closed: —',
          '- briefs: T-0014-01',
          '',
        ].join('\n')
    );
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    makeBranch(root, 'T-0013');
    makeBranch(root, 'T-0014');
    const before = backlogText(root);

    const byBoard = await readJson(await resume(server, 'T-0013'));
    const res = cli(root, ['resume', 'T-0014', '--json'], SESSION_START_TIMEOUT_MS);
    const byCli = JSON.parse(res.stdout);

    assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.strictEqual(byCli.exit, 0, res.stdout);
    for (const field of ['status', 'session']) {
      assert.strictEqual(byCli[field], byBoard[field], `${field}: ${res.stdout}`);
    }
    assert.strictEqual(statusOf(root, 'T-0013'), statusOf(root, 'T-0014'));
    assert.strictEqual(statusOf(root, 'T-0014'), 'in_progress');
    assert.strictEqual(backlogText(root), before, 'neither caller wrote to the backlog');
    for (const id of ['T-0013', 'T-0014']) {
      assert.strictEqual(git(['branch', '--show-current'], worktreePath(root, id)), `task/${id}`);
    }
  });
});
