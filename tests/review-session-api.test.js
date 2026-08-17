'use strict';

// Integration tests for the review session behind POST /api/task/:id/review
// (T-0122): the third kind of session, started by hand on a task that is ALREADY
// in `review`. It differs from the other two in three ways that all have to hold
// at once — it changes no status, it runs in the project directory rather than a
// worktree of its own, and its whole output is a "### Review verdict" section in
// the task's description.
//
// Each test spawns a real `node server/server.js` against a throwaway
// AGENTBOARD_ROOT, and no test ever runs a real agent: the command is always a
// short `node -e ...`.
// Run with: npm test

require('./helpers/env.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor } = require('./helpers/wait.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Bounded, so no request here can hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { parseBacklog } = require('../server/parser.js');
const { removeTree } = require('./helpers/rm.js');

const TASK_CLI = path.join(__dirname, '..', 'tools', 'task.mjs');

function backlog() {
  return [
    '# Backlog\n',
    '## T-0013 · Major · Ready task',
    '- type: feature',
    '- status: ready',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0013-01',
    '',
    '## T-0014 · Major · Submitted for review',
    '- type: feature',
    '- status: review',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0014-01',
    '',
    'The worker is done with it.',
    '',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const activeServers = [];
const activeRoots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-review-api-test-'));
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), backlog());
  activeRoots.push(root);
  return root;
}

function backlogText(root) {
  return fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
}

function taskIn(root, id) {
  return parseBacklog(backlogText(root)).find((t) => t.id === id);
}

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

const EMPTY_RUN_HINT = /\[briefboard\] this session ended without changing/;

// Double quotes so a node path containing spaces survives the argv split; the
// -e scripts below therefore use single quotes only.
function q(value) {
  return `"${value}"`;
}

function nodeCmd(script) {
  return `${q(process.execPath)} -e ${q(script)}`;
}

const PRINT_CWD = nodeCmd('console.log(process.cwd())');

// A session that does what the review session is for: writes a verdict into the
// SHARED backlog through the same CLI the shipped prompt uses, and sets no
// status. AGENTBOARD_ROOT is in its environment already (T-0118).
function writeVerdictCmd(text) {
  return [
    q(process.execPath),
    q(TASK_CLI),
    'note',
    '{id}',
    '--section',
    q('Review verdict'),
    '--text',
    q(text),
  ].join(' ');
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

function review(server, id = 'T-0014') {
  return fetch(server.baseUrl + `/api/task/${id}/review`, { method: 'POST' });
}

async function sessionFor(server, id) {
  const data = await readJson(await fetch(server.baseUrl + '/api/sessions'));
  return (data.sessions || []).find((s) => s.id === id) || null;
}

// ---------- not configured ----------

describe('POST /api/task/:id/review without BRIEFBOARD_ORCHESTRATOR_CMD', () => {
  it('/api/board reports orchestrator === false, so the board offers no action', async () => {
    const server = await startServer(makeRoot());
    const data = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.strictEqual(data.sessions.orchestrator, false, answerOf(data));
  });

  it('the route still answers, and says the kind is disabled', async () => {
    const root = makeRoot();
    const server = await startServer(root);
    const before = backlogText(root);

    const res = await review(server);
    assert.strictEqual(res.status, 200);
    const body = await readJson(res);
    assert.strictEqual(body.session, 'disabled', answerOf(body));
    assert.strictEqual(body.status, 'review', answerOf(body));
    assert.strictEqual(backlogText(root), before, 'nothing is written either way');
  });
});

// ---------- configured ----------

describe('POST /api/task/:id/review with BRIEFBOARD_ORCHESTRATOR_CMD', () => {
  it('starts the session and reports the third kind apart from the other two', async () => {
    const root = makeRoot();
    const server = await startServer(root, {
      BRIEFBOARD_ORCHESTRATOR_CMD: nodeCmd("console.log('reviewing {id}')"),
    });

    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.deepStrictEqual(board.sessions, {
      enabled: false,
      worker: false,
      orchestrator: true,
      profiles: [],
      profileUsedBy: { briefing: false, worker: false, orchestrator: false },
    });

    const body = await readJson(await review(server));
    assert.strictEqual(body.session, 'started', answerOf(body));
    await waitFor(() => /reviewing T-0014/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'session stdout');
  });

  it('runs in the project directory, never in a worktree of its own', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_ORCHESTRATOR_CMD: PRINT_CWD });

    assert.strictEqual((await readJson(await review(server))).session, 'started');
    await waitFor(() => readSessionLogs(root).trim() !== '', SPAWN_WAIT_BUDGET_MS, 'the session log');

    // The diff it reads belongs to the branch the worker created, and the
    // verdict goes to the shared backlog: a worktree would put both elsewhere.
    assert.ok(
      readSessionLogs(root).includes(fs.realpathSync(root)),
      `expected the project directory in the log, got: ${readSessionLogs(root)}`
    );
    assert.ok(!fs.existsSync(path.join(root, '.briefboard', 'worktrees')), 'no worktree is made');

    const record = await sessionFor(server, 'T-0014');
    assert.strictEqual(record.kind, 'orchestrator');
    assert.strictEqual(record.branch, null);
    assert.strictEqual(record.worktree, null);
  });

  it('changes no status and writes nothing to the backlog itself', async () => {
    const root = makeRoot();
    const server = await startServer(root, {
      BRIEFBOARD_ORCHESTRATOR_CMD: nodeCmd("console.log('quiet')"),
    });
    const before = backlogText(root);
    const beforeMtime = fs.statSync(path.join(root, 'doc', 'backlog.md')).mtimeMs;

    assert.strictEqual((await readJson(await review(server))).session, 'started');
    await waitFor(() => /quiet/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the session to run');

    assert.strictEqual(backlogText(root), before);
    assert.strictEqual(fs.statSync(path.join(root, 'doc', 'backlog.md')).mtimeMs, beforeMtime);
    assert.strictEqual(taskIn(root, 'T-0014').status, 'review');
  });

  it('the verdict the session writes lands in the description, and the status stays', async () => {
    const root = makeRoot();
    const server = await startServer(root, {
      BRIEFBOARD_ORCHESTRATOR_CMD: writeVerdictCmd('Tests green. I would merge it.'),
    });

    assert.strictEqual((await readJson(await review(server))).session, 'started');
    await waitFor(
      () => /### Review verdict/.test(backlogText(root)),
      SPAWN_WAIT_BUDGET_MS,
      'the verdict in the description'
    );

    const task = taskIn(root, 'T-0014');
    assert.strictEqual(task.status, 'review', 'the session sets no status, done least of all');
    assert.match(task.description, /Tests green\. I would merge it\./);
    assert.ok(task.description.startsWith('The worker is done with it.'), 'nothing is overwritten');
  });

  it('a run that wrote a verdict is not reported as a run that did nothing', async () => {
    const root = makeRoot();
    const server = await startServer(root, {
      BRIEFBOARD_ORCHESTRATOR_CMD: writeVerdictCmd('Looks fine.'),
    });

    await review(server);
    await waitFor(() => /### Review verdict/.test(backlogText(root)), SPAWN_WAIT_BUDGET_MS, 'the verdict');
    await waitFor(
      async () => ((await sessionFor(server, 'T-0014')) || {}).status === 'exited',
      SPAWN_WAIT_BUDGET_MS,
      'the session to end'
    );
    // The hint is written once the log is closed, after the process is gone.
    await sleep(300);
    assert.ok(!EMPTY_RUN_HINT.test(readSessionLogs(root)), readSessionLogs(root));
  });

  it('a run that changed nothing at all still gets the hint', async () => {
    const root = makeRoot();
    const server = await startServer(root, {
      BRIEFBOARD_ORCHESTRATOR_CMD: nodeCmd("console.log('read it, said nothing')"),
    });

    await review(server);
    await waitFor(() => EMPTY_RUN_HINT.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the empty-run hint');
    assert.match(readSessionLogs(root), /Review verdict/, 'the hint names the section it looked for');
  });
});

// ---------- the preconditions ----------

describe('the review session runs only where there is something to review', () => {
  it('a task that is not in review is refused, and no session starts', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_ORCHESTRATOR_CMD: PRINT_CWD });

    const res = await review(server, 'T-0013'); // ready
    assert.strictEqual(res.status, 409);
    assert.match((await readJson(res)).error, /not in review/, answerOf(res));
    assert.deepStrictEqual(sessionLogs(root), []);
    assert.strictEqual(await sessionFor(server, 'T-0013'), null);
  });

  it('an unknown task is a 404', async () => {
    const server = await startServer(makeRoot(), { BRIEFBOARD_ORCHESTRATOR_CMD: PRINT_CWD });
    const res = await review(server, 'T-0099');
    assert.strictEqual(res.status, 404);
    assert.match((await readJson(res)).error, /T-0099 not found/, answerOf(res));
  });

  it('an id that is not a task id is not routed at all', async () => {
    const server = await startServer(makeRoot(), { BRIEFBOARD_ORCHESTRATOR_CMD: PRINT_CWD });
    const res = await fetch(server.baseUrl + '/api/task/T-99/review', { method: 'POST' });
    await res.arrayBuffer();
    assert.strictEqual(res.status, 404);
  });

  it('GET is not a way to start it', async () => {
    const server = await startServer(makeRoot(), { BRIEFBOARD_ORCHESTRATOR_CMD: PRINT_CWD });
    const res = await fetch(server.baseUrl + '/api/task/T-0014/review');
    await res.arrayBuffer();
    assert.strictEqual(res.status, 405);
  });

  it('a cross-origin POST is rejected before anything is started', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_ORCHESTRATOR_CMD: PRINT_CWD });
    const res = await fetch(server.baseUrl + '/api/task/T-0014/review', {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
    });
    await res.arrayBuffer();
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(sessionLogs(root), []);
  });

  it('the command is never taken from the request body', async () => {
    const root = makeRoot();
    const server = await startServer(root, {
      BRIEFBOARD_ORCHESTRATOR_CMD: nodeCmd("console.log('configured {id}')"),
    });
    const res = await fetch(server.baseUrl + '/api/task/T-0014/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'node -e "console.log(\'injected\')"' }),
    });
    assert.strictEqual(res.status, 200);
    await waitFor(() => /configured T-0014/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the configured command');
    assert.ok(!/injected/.test(readSessionLogs(root)));
  });

  it('a second review session on the same task is refused while the first runs', async () => {
    const root = makeRoot();
    // Far above the per-test backstop, so the first session cannot die of old
    // age between the two requests: at 4000 ms it did exactly that under four
    // concurrent suites and the second review had nothing left to refuse
    // (T-0207). The same rule tests/kill-tree.test.js reasons about at
    // WORKER_LIFETIME_MS — a fixture that can outlive the test proves nothing.
    const server = await startServer(root, {
      BRIEFBOARD_ORCHESTRATOR_CMD: nodeCmd('setTimeout(function () {}, 300000)'),
    });

    assert.strictEqual((await readJson(await review(server))).session, 'started');
    assert.strictEqual((await readJson(await review(server))).session, 'already-running');
  });
});
