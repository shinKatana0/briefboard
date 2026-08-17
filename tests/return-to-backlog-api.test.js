'use strict';

// Integration tests for putting a task back down: POST /api/task/:id/backlog and
// the briefing session that /open no longer starts twice (T-0141).
//
// The path they exist for is the one that was walked on a real board: a card is
// pulled into Open by mistake, the only way back is `cancelled`, and shelving a
// task means burying it. So the test that matters here is the whole round trip —
// open it, change your mind, put it back, open it again later — and the price of
// that second opening.
//
// Each test spawns a real `node server/server.js` against a throwaway
// AGENTBOARD_ROOT, and no test runs a real agent: the command is always a short
// `node -e ...`.
// Run with: npm test

require('./helpers/env.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor } = require('./helpers/wait.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Bounded, so no request here can hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { parseBacklog, STATUSES } = require('../server/parser.js');
const { removeTree } = require('./helpers/rm.js');

const TASK_CLI = path.join(__dirname, '..', 'tools', 'task.mjs');

// One task per lifecycle status, so "only `open` is accepted" can be checked
// against every other status rather than a single representative one. T-0002 is
// the only one in `open`; T-0008 is in `open` too but carries a brief and the
// questions a briefing session left behind.
const FIXTURE_IDS = {
  backlog: 'T-0001',
  open: 'T-0002',
  ready: 'T-0003',
  in_progress: 'T-0004',
  review: 'T-0005',
  done: 'T-0006',
  cancelled: 'T-0007',
};

function backlog() {
  const lines = ['# Backlog\n'];
  for (const [status, id] of Object.entries(FIXTURE_IDS)) {
    const closed = status === 'done' || status === 'cancelled' ? '2026-01-02 00:00:00' : '—';
    const briefs = status === 'ready' || status === 'in_progress' || status === 'review' ? `${id}-01` : '';
    lines.push(
      `## ${id} · Major · Task in ${status}`,
      '- type: feature',
      `- status: ${status}`,
      '- created: 2026-01-01 00:00:00',
      `- closed: ${closed}`,
      `- briefs: ${briefs}`,
      ''
    );
  }
  lines.push(
    '## T-0008 · Major · Briefed and asked about',
    '- type: feature',
    '- status: open',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0008-01',
    '',
    'What the refinement decided.',
    '',
    '### Session questions',
    '',
    '- Which of the two shapes wins?',
    ''
  );
  return lines.join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const activeServers = [];
const activeRoots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-return-api-test-'));
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

// Double quotes so a node path containing spaces survives the argv split; the
// -e scripts below therefore use single quotes only.
function q(value) {
  return `"${value}"`;
}

function nodeCmd(script) {
  return `${q(process.execPath)} -e ${q(script)}`;
}

const QUIET = nodeCmd("console.log('briefing {id}')");
const LONG_RUNNING = nodeCmd("console.log('briefing {id}'); setTimeout(function () {}, 30000)");

async function startServer(root, extraEnv = {}) {
  const server = await startBoard(root, extraEnv);
  activeServers.push(server);
  return server;
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) await removeTree(activeRoots.pop());
});

const post = (server, id, action) =>
  fetch(server.baseUrl + `/api/task/${id}/${action}`, { method: 'POST' });

// For the calls whose body says nothing the test needs: drains it, so a response
// nobody read cannot hold a socket open past the end of the test.
async function statusOf(request) {
  const res = await request;
  await res.arrayBuffer();
  return res.status;
}

const toBacklog = (server, id = 'T-0002') => post(server, id, 'backlog');
const toOpen = (server, id) => post(server, id, 'open');
const brief = (server, id) => post(server, id, 'briefing');

async function boardTask(server, id) {
  const data = await readJson(await fetch(server.baseUrl + '/api/board'));
  return (data.tasks || []).find((t) => t.id === id) || null;
}

async function sessionFor(server, id) {
  const data = await readJson(await fetch(server.baseUrl + '/api/sessions'));
  return (data.sessions || []).find((s) => s.id === id) || null;
}

// ---------- the transition ----------

describe('POST /api/task/:id/backlog', () => {
  it('200: moves an open task back to backlog and persists it', async () => {
    const root = makeRoot();
    const server = await startServer(root);

    const res = await toBacklog(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 200, answerOf(data));
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(data.id, 'T-0002', answerOf(data));
    assert.strictEqual(data.status, 'backlog', answerOf(data));
    assert.match(backlogText(root), /## T-0002[\s\S]*?- status: backlog/);
  });

  it('200: leaves `closed` and `created` alone — neither end of the move closes anything', async () => {
    const root = makeRoot();
    const server = await startServer(root);

    const data = await readJson(await toBacklog(server));
    assert.strictEqual(data.closed, undefined, answerOf(data));

    assert.match(backlogText(root), /## T-0002[\s\S]*?- closed: —/);
    const task = await boardTask(server, 'T-0002');
    assert.strictEqual(task.closed, '');
    assert.strictEqual(task.created, '2026-01-01 00:00:00');
  });

  for (const [status, id] of Object.entries(FIXTURE_IDS)) {
    if (status === 'open') continue;
    it(`409: refuses a task in status "${status}" and leaves the file untouched`, async () => {
      const root = makeRoot();
      const server = await startServer(root);
      const before = backlogText(root);

      const res = await toBacklog(server, id);
      const data = await readJson(res);

      assert.strictEqual(res.status, 409, answerOf(data));
      assert.match(data.error, /not in open/, answerOf(data));
      assert.strictEqual(backlogText(root), before);
    });
  }

  it('409: a second call on the now-backlog task, so the route is no way to sit still', async () => {
    const server = await startServer(makeRoot());
    const first = await toBacklog(server);
    await first.arrayBuffer();
    assert.strictEqual(first.status, 200);

    const second = await toBacklog(server);
    await second.arrayBuffer();
    assert.strictEqual(second.status, 409);
  });

  it('404: an unknown id, file untouched', async () => {
    const root = makeRoot();
    const server = await startServer(root);
    const before = backlogText(root);

    const res = await toBacklog(server, 'T-9999');
    assert.strictEqual(res.status, 404, answerOf(await readJson(res)));
    assert.strictEqual(backlogText(root), before);
  });

  it('405 on GET, 403 cross-origin, and neither touches the file', async () => {
    const root = makeRoot();
    const server = await startServer(root);
    const before = backlogText(root);

    const get = await fetch(server.baseUrl + '/api/task/T-0002/backlog');
    await get.arrayBuffer();
    assert.strictEqual(get.status, 405);

    const crossOrigin = await fetch(server.baseUrl + '/api/task/T-0002/backlog', {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
    });
    await crossOrigin.arrayBuffer();
    assert.strictEqual(crossOrigin.status, 403);

    assert.strictEqual(backlogText(root), before);
  });

  it('the route sets exactly one status: `backlog`, whatever a body asks for', async () => {
    const root = makeRoot();
    const server = await startServer(root);

    const res = await fetch(server.baseUrl + '/api/task/T-0002/backlog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done', closed: '2026-01-01 00:00:00' }),
    });
    assert.strictEqual(res.status, 200, answerOf(await readJson(res)));
    const task = taskIn(root, 'T-0002');
    assert.strictEqual(task.status, 'backlog');
    assert.strictEqual(task.closed, '');
  });
});

// ---------- what the move must not take with it ----------

describe('putting a task back keeps everything already written', () => {
  it('the brief, the description and the questions all survive the move', async () => {
    const root = makeRoot();
    const server = await startServer(root);

    assert.strictEqual(await statusOf(toBacklog(server, 'T-0008')), 200);

    const task = taskIn(root, 'T-0008');
    assert.strictEqual(task.status, 'backlog');
    assert.deepStrictEqual(task.briefs, ['T-0008-01']);
    assert.ok(task.description.startsWith('What the refinement decided.'), task.description);
    assert.match(task.description, /### Session questions/);
    assert.match(task.description, /Which of the two shapes wins\?/);
  });

  it('the "needs answer" marker goes out on the card, because `backlog` cannot answer', async () => {
    const root = makeRoot();
    const server = await startServer(root);

    const before = await boardTask(server, 'T-0008');
    assert.strictEqual(before.awaitingAnswer, true, 'the fixture must start out asking');

    assert.strictEqual(await statusOf(toBacklog(server, 'T-0008')), 200);

    const after = await boardTask(server, 'T-0008');
    assert.strictEqual(after.awaitingAnswer, false, answerOf(after));
    // Out because of the status, not because anything was erased: the section is
    // still there and lights the card again the moment the task is reopened.
    assert.match(after.description, /### Session questions/);

    assert.strictEqual(await statusOf(toOpen(server, 'T-0008')), 200);
    assert.strictEqual((await boardTask(server, 'T-0008')).awaitingAnswer, true);
  });

  it('the answer endpoint refuses a task that has been put back down', async () => {
    const server = await startServer(makeRoot());
    assert.strictEqual(await statusOf(toBacklog(server, 'T-0008')), 200);

    const res = await fetch(server.baseUrl + '/api/task/T-0008/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'The first one.' }),
    });
    assert.strictEqual(res.status, 409, answerOf(await readJson(res)));
  });
});

// ---------- the running session ----------

describe('a briefing session running on the card is stopped', () => {
  it('the transition stops it through the existing stop path, and says so', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: LONG_RUNNING });

    assert.strictEqual((await readJson(await toOpen(server, 'T-0001'))).session, 'started');
    await waitFor(
      async () => (await sessionFor(server, 'T-0001')) !== null,
      SPAWN_WAIT_BUDGET_MS,
      'the session to appear in the registry'
    );
    assert.strictEqual((await sessionFor(server, 'T-0001')).status, 'running');

    const body = await readJson(await toBacklog(server, 'T-0001'));
    assert.strictEqual(body.status, 'backlog', answerOf(body));
    assert.strictEqual(body.session, 'stopped', answerOf(body));

    // The registry is updated by the child's own exit handler — the one stop path
    // (T-0077) — so a stopped session lands there exactly like one that ended.
    await waitFor(
      async () => {
        const record = await sessionFor(server, 'T-0001');
        return record && record.status !== 'running';
      },
      SPAWN_WAIT_BUDGET_MS,
      'the session to leave the running state'
    );
  });

  it('with nothing running the move still goes through, and reports what it found', async () => {
    const root = makeRoot();
    const server = await startServer(root);

    const body = await readJson(await toBacklog(server));
    assert.strictEqual(body.status, 'backlog', answerOf(body));
    assert.strictEqual(body.session, 'no-session', answerOf(body));
    assert.strictEqual(taskIn(root, 'T-0002').status, 'backlog');
  });

  it('a refused transition costs no session: the kill comes after the write', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: LONG_RUNNING });

    assert.strictEqual((await readJson(await toOpen(server, 'T-0001'))).session, 'started');
    await waitFor(
      async () => (await sessionFor(server, 'T-0001')) !== null,
      SPAWN_WAIT_BUDGET_MS,
      'the session to appear in the registry'
    );

    // T-0003 is in `ready`: the transition is refused, and nothing may happen to
    // the session of another task — or to this one, had the kill come first.
    const res = await toBacklog(server, 'T-0003');
    assert.strictEqual(res.status, 409, answerOf(await readJson(res)));
    assert.strictEqual((await sessionFor(server, 'T-0001')).status, 'running');
  });
});

// ---------- reopening does not pay for the brief twice ----------

describe('the drop into Open starts a briefing session only for a task with no brief', () => {
  it('a task with no briefs still gets one, exactly as before', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: QUIET });

    const body = await readJson(await toOpen(server, 'T-0001'));
    assert.strictEqual(body.session, 'started', answerOf(body));
    await waitFor(() => /briefing T-0001/.test(readLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the session output');
  });

  it('a task that already has one is moved and nothing is started', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: QUIET });
    assert.strictEqual(await statusOf(toBacklog(server, 'T-0008')), 200);

    const body = await readJson(await toOpen(server, 'T-0008'));
    assert.strictEqual(body.status, 'open', answerOf(body));
    assert.strictEqual(body.session, 'briefed', answerOf(body));

    // Not "started and then failed": nothing was spawned at all.
    await sleep(300);
    assert.deepStrictEqual(sessionLogs(root), []);
    assert.strictEqual(await sessionFor(server, 'T-0008'), null);
  });

  // The card's own history: pulled into Open, put back, brought up again later.
  it('the whole round trip costs one briefing, and the second opening costs none', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: QUIET });

    // 1. Opened by mistake — the task has no brief, so the briefing session runs.
    assert.strictEqual((await readJson(await toOpen(server, 'T-0001'))).session, 'started');
    await waitFor(() => /briefing T-0001/.test(readLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the first briefing');
    const afterFirst = sessionLogs(root).length;

    // 2. That is what the brief would have been written as; the fixture cannot
    //    run a real agent, so the brief is attached the way the CLI would.
    attachBrief(root, 'T-0001');

    // 3. Changed our mind.
    assert.strictEqual(await statusOf(toBacklog(server, 'T-0001')), 200);
    assert.strictEqual(taskIn(root, 'T-0001').status, 'backlog');

    // 4. Brought up again later: a status change and nothing more.
    const reopened = await readJson(await toOpen(server, 'T-0001'));
    assert.strictEqual(reopened.status, 'open', answerOf(reopened));
    assert.strictEqual(reopened.session, 'briefed', answerOf(reopened));
    await sleep(300);
    assert.strictEqual(sessionLogs(root).length, afterFirst, 'no second briefing was spawned');
    assert.deepStrictEqual(taskIn(root, 'T-0001').briefs, ['T-0001-01'], 'and the brief is still its own');
  });
});

// ---------- starting the briefing session by hand ----------

describe('POST /api/task/:id/briefing', () => {
  it('starts the briefing session on a task in open and writes nothing itself', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: QUIET });
    const before = backlogText(root);
    const beforeMtime = fs.statSync(path.join(root, 'doc', 'backlog.md')).mtimeMs;

    const body = await readJson(await brief(server, 'T-0008'));
    assert.strictEqual(body.session, 'started', answerOf(body));
    assert.strictEqual(body.status, 'open', answerOf(body));
    await waitFor(() => /briefing T-0008/.test(readLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the session output');

    assert.strictEqual(backlogText(root), before);
    assert.strictEqual(fs.statSync(path.join(root, 'doc', 'backlog.md')).mtimeMs, beforeMtime);
  });

  it('a brief that has gone stale can be revisited: the action outlives the first one', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: QUIET });

    // Put back and brought up again — the drop started nothing, and this is what
    // the human presses when the brief turns out to need a second look.
    assert.strictEqual(await statusOf(toBacklog(server, 'T-0008')), 200);
    assert.strictEqual((await readJson(await toOpen(server, 'T-0008'))).session, 'briefed');

    const body = await readJson(await brief(server, 'T-0008'));
    assert.strictEqual(body.session, 'started', answerOf(body));
    await waitFor(() => /briefing T-0008/.test(readLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the session output');
  });

  for (const status of STATUSES.filter((s) => s !== 'open')) {
    it(`409: a task in "${status}" has nothing to brief, and no session starts`, async () => {
      const root = makeRoot();
      const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: QUIET });

      const res = await brief(server, FIXTURE_IDS[status]);
      assert.strictEqual(res.status, 409, answerOf(await readJson(res)));
      await sleep(200);
      assert.deepStrictEqual(sessionLogs(root), []);
    });
  }

  it('with no BRIEFBOARD_SESSION_CMD the route answers and says the kind is disabled', async () => {
    const root = makeRoot();
    const server = await startServer(root);
    const before = backlogText(root);

    const body = await readJson(await brief(server, 'T-0008'));
    assert.strictEqual(body.session, 'disabled', answerOf(body));
    assert.strictEqual(backlogText(root), before);
  });

  it('404 on an unknown id, 405 on GET, 403 cross-origin', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: QUIET });

    const unknown = await brief(server, 'T-9999');
    assert.strictEqual(unknown.status, 404, answerOf(await readJson(unknown)));

    const get = await fetch(server.baseUrl + '/api/task/T-0008/briefing');
    await get.arrayBuffer();
    assert.strictEqual(get.status, 405);

    const crossOrigin = await fetch(server.baseUrl + '/api/task/T-0008/briefing', {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
    });
    await crossOrigin.arrayBuffer();
    assert.strictEqual(crossOrigin.status, 403);

    await sleep(200);
    assert.deepStrictEqual(sessionLogs(root), []);
  });

  it('the command is never taken from the request body', async () => {
    const root = makeRoot();
    const server = await startServer(root, { BRIEFBOARD_SESSION_CMD: QUIET });

    const res = await fetch(server.baseUrl + '/api/task/T-0008/briefing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `node -e "console.log('injected')"` }),
    });
    assert.strictEqual(res.status, 200, answerOf(await readJson(res)));
    await waitFor(() => /briefing T-0008/.test(readLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the configured command');
    assert.ok(!/injected/.test(readLogs(root)));
  });
});

function readLogs(root) {
  const dir = path.join(root, '.briefboard', 'sessions');
  return sessionLogs(root)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

// What the briefing session leaves behind, written the way it writes it: through
// the CLI, so the file lands under the same lock the board writes with. The
// fixture cannot run a real agent, and hand-editing the backlog underneath a
// running board would be a different thing from what the session does.
function attachBrief(root, id) {
  const res = spawnSync(process.execPath, [TASK_CLI, 'brief', id, 'the-brief'], {
    env: { ...process.env, AGENTBOARD_ROOT: root },
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0, `brief failed: ${res.stderr}`);
}
