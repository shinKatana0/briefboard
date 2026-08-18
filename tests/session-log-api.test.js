'use strict';

// Integration tests for what the board can learn about a running agent session
// (T-0077): GET /api/sessions, GET /api/session/:id/log, POST
// /api/session/:id/stop, and the SSE event that announces a state change.
//
// Each test spawns a real `node server/server.js` against a throwaway
// AGENTBOARD_ROOT, so the real project's doc/ files are never touched. No test
// ever runs a real agent: the session command is always a short `node -e ...`.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor } = require('./helpers/wait.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
// The board's own liveness check, not a hand-written kill(pid, 0): on POSIX that
// succeeds for a killed-but-unreaped process, so a test writing it itself reads
// a zombie as a live session (T-0202, T-0209).
const { isProcessAlive } = require('../server/sessions.js');
const { tempDir } = require('./helpers/tmp.js');

// ---------- fixture helpers ----------

function sampleBacklog() {
  return [
    '# Backlog\n',
    '## T-0011 · Major · Backlog task',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
    '## T-0012 · Major · Another backlog task',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionsDir(root) {
  return path.join(root, '.briefboard', 'sessions');
}

// Logs only: registry.json shares the directory with them (T-0102).
function sessionLogFiles(root) {
  const dir = sessionsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => path.join(dir, f));
}

// Double quotes so a node path containing spaces survives; the -e scripts below
// therefore use single quotes only.
function q(value) {
  return `"${value}"`;
}

function nodeCmd(script) {
  return `${q(process.execPath)} -e ${q(script)}`;
}

const activeServers = [];
const activeRoots = [];

async function setup(extraEnv) {
  const root = tempDir('briefboard-session-log-test-');
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), sampleBacklog());
  activeRoots.push(root);
  const server = await startBoard(root, extraEnv);
  activeServers.push(server);
  return { root, server };
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  await sleep(150); // let killed sessions release their log file handles
  while (activeRoots.length) {
    try {
      fs.rmSync(activeRoots.pop(), { recursive: true, force: true });
    } catch {
      /* a session log may still be held on Windows; the temp dir can wait */
    }
  }
});

function open(server, id = 'T-0011') {
  return fetch(server.baseUrl + `/api/task/${id}/open`, { method: 'POST' });
}

async function sessions(server) {
  const res = await fetch(server.baseUrl + '/api/sessions');
  return { res, body: await readJson(res) };
}

async function sessionFor(server, id) {
  const { body } = await sessions(server);
  return body.sessions.find((s) => s.id === id) || null;
}

// A session that stays alive until it is killed.
const LONG_SESSION = "console.log('working on {id}'); setInterval(function(){}, 1000)";

// ---------- GET /api/sessions ----------

describe('GET /api/sessions', () => {
  it('is empty before anything ran, and never 304s', async () => {
    const { server } = await setup();
    const { res, body } = await sessions(server);
    assert.strictEqual(res.status, 200);
    // The registry and the sums, not the whole body: the watchdog's findings
    // ride along on this response too (T-0159) and are tested in
    // tests/watchdog-api.test.js, so naming them here would only tie this test
    // to a shape it says nothing about.
    assert.deepStrictEqual({ sessions: body.sessions, costs: body.costs }, { sessions: [], costs: {} });
    assert.strictEqual(res.headers.get('etag'), null, 'no ETag: the state is not file-derived');
    assert.match(res.headers.get('cache-control') || '', /no-store/);
  });

  it('lists the running session with its state, and never its log path', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    await open(server);

    const record = await sessionFor(server, 'T-0011');
    assert.ok(record, 'the session is listed');
    assert.strictEqual(record.status, 'running');
    assert.ok(record.pid > 0);
    assert.ok(record.startedAt);
    assert.strictEqual(record.endedAt, null);
    assert.strictEqual(record.exitCode, null);
    assert.strictEqual('logPath' in record, false, 'no filesystem path leaves the server');
    assert.ok(!JSON.stringify(record).includes('.briefboard'));
  });

  it('the answer follows the session dying, even for a client sending If-None-Match', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    await open(server);
    assert.strictEqual((await sessionFor(server, 'T-0011')).status, 'running');

    // Whatever validator the client makes up, this endpoint has no cached
    // answer to hand back: the state it reports is not derived from any file.
    const res = await fetch(server.baseUrl + '/api/sessions', {
      headers: { 'If-None-Match': 'W/"anything"' },
    });
    assert.strictEqual(res.status, 200);

    await fetch(server.baseUrl + '/api/session/T-0011/stop', { method: 'POST' });
    await waitFor(
      async () => (await sessionFor(server, 'T-0011')).status === 'exited',
      SPAWN_WAIT_BUDGET_MS,
      'the state to follow the session'
    );
  });

  // T-0116: what a task cost is made of the same records and goes stale on the
  // same events, so it travels with them rather than in an endpoint of its own.
  it('carries what each task has taken so far, alongside the records', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    await open(server);

    const { body } = await sessions(server);
    const cost = body.costs['T-0011'];
    assert.ok(cost, 'the task that has a session has a sum');
    assert.strictEqual(cost.sessions, 1);
    assert.deepStrictEqual(cost.kinds, { briefing: 1 });
    assert.strictEqual(cost.running, true, 'a live session is counted as still going');
    assert.strictEqual(cost.complete, true);
    // Nothing was declared, so nothing is claimed about tokens.
    assert.strictEqual(cost.tokens, null);
    assert.ok(!JSON.stringify(cost).includes('.briefboard'), 'no filesystem path leaves the server');
  });

  it('reports the tokens the user’s own expression finds, and only then', async () => {
    const { server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('usage: in=1200 out=340')"),
      BRIEFBOARD_TOKENS_RE: 'out=(\\d+)',
    });
    await open(server);
    await waitFor(
      async () => ((await sessions(server)).body.costs['T-0011'] || {}).tokens === 340,
      SPAWN_WAIT_BUDGET_MS,
      'the declared extractor to read the session log'
    );

    const cost = (await sessions(server)).body.costs['T-0011'];
    assert.strictEqual(cost.tokenSessions, 1);
    assert.ok(cost.durationMs >= 0, 'the time is measured either way');
  });

  // T-0164: the mode reached the runner only from the server's environment, and
  // that line was missing — a documented variable that did nothing, so this log
  // (a running total, printed twice) was reported as 36 + 77 = 113.
  it('reads BRIEFBOARD_TOKENS_MODE from the environment, so a running total is not summed', async () => {
    const { server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('tokens: 36'); console.log('tokens: 77')"),
      BRIEFBOARD_TOKENS_RE: 'tokens: (\\d+)',
      BRIEFBOARD_TOKENS_MODE: 'last',
    });
    await open(server);
    await waitFor(
      async () => ((await sessions(server)).body.costs['T-0011'] || {}).tokens !== null,
      SPAWN_WAIT_BUDGET_MS,
      'the finished session to be counted'
    );

    assert.strictEqual((await sessions(server)).body.costs['T-0011'].tokens, 77);
  });

  it('says so at start-up when BRIEFBOARD_TOKENS_MODE is unusable, and then counts nothing', async () => {
    const { server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('tokens: 36')"),
      BRIEFBOARD_TOKENS_RE: 'tokens: (\\d+)',
      BRIEFBOARD_TOKENS_MODE: 'latest',
    });
    await waitFor(
      () => /BRIEFBOARD_TOKENS_MODE/.test(server.getStderr()),
      SPAWN_WAIT_BUDGET_MS,
      'the refusal to name the variable'
    );
    await open(server);
    await waitFor(
      async () => ((await sessionFor(server, 'T-0011')) || {}).status === 'exited',
      SPAWN_WAIT_BUDGET_MS,
      'the session to finish'
    );

    // A wrong figure looks exactly like a right one, so none is reported.
    assert.strictEqual((await sessions(server)).body.costs['T-0011'].tokens, null);
  });
});

// ---------- the cached board must not carry session state ----------

describe('/api/board stays cacheable', () => {
  it('carries no session records, and still 304s while a session starts and dies', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    await open(server);

    const first = await fetch(server.baseUrl + '/api/board');
    const board = await readJson(first);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'the board keeps its ETag');
    // Only the configuration, which is constant for the process.
    assert.deepStrictEqual(board.sessions, {
      enabled: true,
      worker: false,
      orchestrator: false,
      profiles: [],
      profileUsedBy: { briefing: false, worker: false, orchestrator: false },
    });
    assert.ok(!JSON.stringify(board).includes('running'), 'no session state in the board payload');

    await fetch(server.baseUrl + '/api/session/T-0011/stop', { method: 'POST' });
    await waitFor(
      async () => (await sessionFor(server, 'T-0011')).status === 'exited',
      SPAWN_WAIT_BUDGET_MS,
      'the session to die'
    );
    // The backlog did not change, so the board legitimately answers 304 — which
    // is exactly why the session state may not live in it.
    const second = await fetch(server.baseUrl + '/api/board', { headers: { 'If-None-Match': etag } });
    assert.strictEqual(second.status, 304);
  });
});

// ---------- GET /api/session/:id/log ----------

describe('GET /api/session/:id/log', () => {
  it('serves the session output as plain text, uncached', async () => {
    const { server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('briefing {id}'); console.error('to stderr')"),
    });
    await open(server);

    await waitFor(
      async () => (await (await fetch(server.baseUrl + '/api/session/T-0011/log')).text()).includes('to stderr'),
      SPAWN_WAIT_BUDGET_MS,
      'the session output in the log'
    );
    const res = await fetch(server.baseUrl + '/api/session/T-0011/log');
    const text = await res.text();
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/plain/);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.match(text, /briefing T-0011/);
    assert.strictEqual(res.headers.get('x-log-truncated'), '0');
    assert.strictEqual(Number(res.headers.get('x-log-total-bytes')), Buffer.byteLength(text));
  });

  it('serves log content that looks like markup verbatim, as text', async () => {
    const { server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('<script>alert(1)</' + 'script>')"),
    });
    await open(server);
    await waitFor(
      async () => (await (await fetch(server.baseUrl + '/api/session/T-0011/log')).text()).includes('alert(1)'),
      SPAWN_WAIT_BUDGET_MS,
      'the session output'
    );
    const res = await fetch(server.baseUrl + '/api/session/T-0011/log');
    const text = await res.text();
    assert.match(res.headers.get('content-type') || '', /^text\/plain/);
    assert.ok(text.includes('<script>alert(1)</script>'), 'the bytes are served unchanged');
  });

  it('is chosen by task id alone: a traversal attempt matches no route', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('x')") });
    await open(server);
    const attempts = [
      '/api/session/..%2f..%2fdoc%2fbacklog.md/log',
      '/api/session/../../doc/backlog.md/log',
      '/api/session/T-0011%2f..%2f..%2fdoc/log',
      '/api/session/T-00111/log',
      '/api/session/T-001/log',
    ];
    for (const pathname of attempts) {
      const res = await fetch(server.baseUrl + pathname);
      const body = await res.text();
      assert.strictEqual(res.status, 404, `${pathname} must not be served`);
      assert.ok(!body.includes('# Backlog'), `${pathname} must not reach a file`);
    }
  });

  it('404s (not 500) for an unknown task and for a log that vanished', async () => {
    const { root, server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('gone soon')") });

    const unknown = await fetch(server.baseUrl + '/api/session/T-9999/log');
    assert.strictEqual(unknown.status, 404);
    assert.match((await readJson(unknown)).error, /T-9999/, answerOf(unknown));

    await open(server);
    await waitFor(
      () => sessionLogFiles(root).length === 1,
      SPAWN_WAIT_BUDGET_MS,
      'the session log file'
    );
    await waitFor(
      async () => (await sessionFor(server, 'T-0011')).status === 'exited',
      SPAWN_WAIT_BUDGET_MS,
      'the session to exit'
    );
    fs.rmSync(sessionLogFiles(root)[0]);

    const missing = await fetch(server.baseUrl + '/api/session/T-0011/log');
    assert.strictEqual(missing.status, 404);
    assert.match((await readJson(missing)).error, /no longer on disk/, answerOf(missing));
    // The server is still serving after both refusals.
    assert.strictEqual((await fetch(server.baseUrl + '/api/sessions')).status, 200);
  });

  it('sends the tail of a large log and says how much there is in total', async () => {
    // ~700 KB, comfortably past the 200 KB tail cap.
    const noisy = "for (var i = 0; i < 10000; i++) console.log('line ' + i + ' ' + 'x'.repeat(60))";
    const { root, server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(noisy) });
    await open(server);
    await waitFor(
      async () => (await sessionFor(server, 'T-0011')).status === 'exited',
      SPAWN_WAIT_BUDGET_MS,
      'the session to finish writing'
    );
    // 'exited' is not the last write: a session that changed nothing gets the
    // empty-run hint appended after it, as the log's last word (T-0109). A
    // snapshot of the file is only comparable with what the API serves a moment
    // later once that write is in (T-0120).
    await waitFor(
      () => /\[briefboard\] this session ended without changing/.test(
        fs.readFileSync(sessionLogFiles(root)[0], 'utf8')
      ),
      SPAWN_WAIT_BUDGET_MS,
      'the log to be final'
    );
    const onDisk = fs.readFileSync(sessionLogFiles(root)[0], 'utf8');
    assert.ok(Buffer.byteLength(onDisk) > 400 * 1024, 'the fixture log is big enough to be cut');

    const res = await fetch(server.baseUrl + '/api/session/T-0011/log');
    const text = await res.text();
    assert.strictEqual(res.headers.get('x-log-truncated'), '1');
    assert.strictEqual(Number(res.headers.get('x-log-total-bytes')), Buffer.byteLength(onDisk));
    assert.ok(Buffer.byteLength(text) <= 200 * 1024, 'only the tail is sent');
    assert.ok(onDisk.endsWith(text), 'and it is the END of the log');
    assert.match(text, /line 9999/);
  });
});

// ---------- POST /api/session/:id/stop ----------

describe('POST /api/session/:id/stop', () => {
  it('stops a live session; a second attempt is a 409', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    await open(server);
    const running = await sessionFor(server, 'T-0011');
    assert.strictEqual(running.status, 'running');

    const stop = await fetch(server.baseUrl + '/api/session/T-0011/stop', { method: 'POST' });
    assert.strictEqual(stop.status, 200);
    assert.deepStrictEqual(await readJson(stop), { ok: true, id: 'T-0011' });

    await waitFor(
      async () => (await sessionFor(server, 'T-0011')).status === 'exited',
      SPAWN_WAIT_BUDGET_MS,
      'the session to die'
    );
    assert.strictEqual(isProcessAlive(running.pid), false, 'the agent process is gone');

    const again = await fetch(server.baseUrl + '/api/session/T-0011/stop', { method: 'POST' });
    assert.strictEqual(again.status, 409);
    assert.match((await readJson(again)).error, /not running/, answerOf(again));
  });

  it('404s for a task with no session at all', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    const res = await fetch(server.baseUrl + '/api/session/T-0012/stop', { method: 'POST' });
    assert.strictEqual(res.status, 404);
  });

  it('rejects a cross-origin POST and leaves the session running', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    await open(server);

    const res = await fetch(server.baseUrl + '/api/session/T-0011/stop', {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
    });
    assert.strictEqual(res.status, 403);
    await sleep(200);
    assert.strictEqual((await sessionFor(server, 'T-0011')).status, 'running');
  });

  it('is POST-only', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    await open(server);
    const res = await fetch(server.baseUrl + '/api/session/T-0011/stop');
    assert.strictEqual(res.status, 405);
    assert.strictEqual((await sessionFor(server, 'T-0011')).status, 'running');
  });
});

// ---------- SSE ----------

describe('the SSE stream announces session state', () => {
  it('sends "sessions" on start and on exit, distinct from "changed"', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });

    const res = await fetch(server.baseUrl + '/events');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
        }
      } catch {
        /* cancelled */
      }
    })();
    const count = (what) => (buffer.match(new RegExp('data: ' + what, 'g')) || []).length;

    await waitFor(() => buffer.includes('data: connected'), SPAWN_WAIT_BUDGET_MS, 'the SSE handshake');
    await open(server);
    await waitFor(() => count('sessions') >= 1, SPAWN_WAIT_BUDGET_MS, 'the session-start event');
    // The transition wrote the backlog, so exactly one board event is expected;
    // wait for it before counting, since that broadcast is debounced.
    await waitFor(() => count('changed') >= 1, SPAWN_WAIT_BUDGET_MS, 'the backlog "changed" event');
    const afterStart = count('sessions');

    await fetch(server.baseUrl + '/api/session/T-0011/stop', { method: 'POST' });
    await waitFor(() => count('sessions') > afterStart, SPAWN_WAIT_BUDGET_MS, 'the session-exit event');
    await sleep(300); // past the 150ms debounce, in case a stray board event follows

    // The board's own event still means what it always did: the backlog changed.
    // Starting and killing the session produced none of them.
    assert.strictEqual(count('changed'), 1);

    await reader.cancel().catch(() => {});
    await pump;
  });
});
