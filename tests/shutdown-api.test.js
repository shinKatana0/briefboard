'use strict';

// POST /api/shutdown — the board's exit button (T-0082).
//
// Every test spawns a real `node server/server.js` against a throwaway
// AGENTBOARD_ROOT and asserts on what the process itself does: the 200 has to
// arrive in one piece BEFORE the exit, open SSE streams have to be told, and a
// board that was asked to stop has to be gone even with a socket held open.

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { HOST, startBoard } = require('./helpers/board.js');
const { removeTree } = require('./helpers/rm.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor } = require('./helpers/wait.js');
// The board's own liveness check, not a hand-written kill(pid, 0): on POSIX that
// succeeds for a killed-but-unreaped process, so a test writing it itself reads
// a zombie as a live session (T-0202, T-0209).
const { isProcessAlive } = require('../server/sessions.js');
const SSE_CONNECT_TIMEOUT_MS = 10000;

const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-shutdown-test-'));
  cleanups.push(() => removeTree(root));
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), '# Backlog\n');
  return root;
}

async function startServer(env = {}) {
  const root = makeRoot();
  const server = await startBoard(root, { BRIEFBOARD_NAME: '', ...env });
  cleanups.push(() => server.stop());
  return { ...server, root, base: server.baseUrl };
}

// Opens /events with the raw http client and resolves once `data: connected`
// has arrived, so the server really holds this SSE client. `text()` is
// everything received so far; `ended` resolves when the server closes the
// stream.
function openSse(base) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + '/events', (res) => {
      let text = '';
      let onConnected;
      const connected = new Promise((r) => (onConnected = r));
      let endResolve;
      const ended = new Promise((r) => (endResolve = r));
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        if (text.includes('data: connected')) onConnected();
      });
      res.on('end', () => endResolve('end'));
      res.on('close', () => endResolve('close'));
      connected.then(() => {
        req.setTimeout(0); // an open stream is allowed to stay idle from here on
        resolve({ text: () => text, ended, destroy: () => req.destroy() });
      });
    });
    // A stream that never says "connected" must fail the test, not hold it.
    req.setTimeout(SSE_CONNECT_TIMEOUT_MS, () => {
      req.destroy(new Error(`no SSE greeting from ${base} within ${SSE_CONNECT_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

async function post(base, pathname, headers = {}) {
  return fetch(base + pathname, { method: 'POST', headers });
}

describe('POST /api/shutdown', () => {
  it('answers 200 {ok:true} in full and then exits with code 0', async () => {
    const server = await startServer();

    const res = await post(server.base, '/api/shutdown');
    assert.strictEqual(res.status, 200);
    // The whole body is read here on purpose: the acceptance criterion is that
    // the answer reaches the client before the process leaves, and a truncated
    // response would fail right here.
    assert.deepStrictEqual(await readJson(res), { ok: true });

    assert.strictEqual(await server.exited(), 0);
  });

  it('stops the process even while a socket is stuck mid-request', async () => {
    const server = await startServer();

    // An idle keep-alive socket would not prove anything — Node's server.close()
    // hangs up on those by itself. This one is stuck in the middle of a request
    // (announced body, none sent), which close() does wait for: without the
    // timeout guard the board would linger until requestTimeout, 20 s away.
    const stuck = net.connect(server.port, HOST);
    cleanups.push(async () => stuck.destroy());
    await new Promise((resolve, reject) => {
      stuck.on('connect', () => {
        stuck.write(
          // The port belongs in the Host header: without it the board answers
          // 403 before the body ever matters (T-0226) and the socket is no
          // longer stuck mid-request, which is the whole fixture.
          `POST /api/task HTTP/1.1\r\nHost: ${HOST}:${server.port}\r\n` +
            'Content-Type: application/json\r\nContent-Length: 200\r\n\r\n'
        );
        resolve();
      });
      stuck.on('error', reject);
    });

    const res = await post(server.base, '/api/shutdown');
    assert.strictEqual(res.status, 200);
    await readJson(res);

    const started = Date.now();
    const code = await server.exited(8000).catch(() => 'timeout');
    assert.strictEqual(code, 0, 'the board must exit despite the stuck connection');
    assert.ok(Date.now() - started < 5000, 'the exit must not wait for requestTimeout');
  });

  it('sends "shutdown" to every open SSE client and closes their streams', async () => {
    const server = await startServer();
    const a = await openSse(server.base);
    const b = await openSse(server.base);

    const res = await post(server.base, '/api/shutdown');
    assert.strictEqual(res.status, 200);

    await Promise.all([a.ended, b.ended]);
    // Both tabs, not only the one that pressed the button.
    assert.match(a.text(), /data: shutdown/);
    assert.match(b.text(), /data: shutdown/);
    assert.strictEqual(await server.exited(), 0);
  });

  it('refuses a non-POST with 405 and keeps running', async () => {
    const server = await startServer();

    const res = await fetch(server.base + '/api/shutdown');
    assert.strictEqual(res.status, 405);
    await readJson(res);

    await sleep(200);
    assert.strictEqual(server.alive(), true);
    // Still serving, so the refusal really did not touch the exit path.
    assert.strictEqual((await fetch(server.base + '/api/board')).status, 200);
  });

  it('refuses a cross-origin POST with 403 and keeps running', async () => {
    const server = await startServer();

    const res = await post(server.base, '/api/shutdown', { Origin: 'http://evil.example' });
    assert.strictEqual(res.status, 403);
    await readJson(res);

    await sleep(200);
    assert.strictEqual(server.alive(), true);
    assert.strictEqual((await fetch(server.base + '/api/board')).status, 200);
  });

  it('refuses a request that did not come from a loopback address, with the board still up', async (t) => {
    // The only way to produce a non-loopback peer address is to reach the board
    // over a real interface, so this needs a public bind and a LAN address of
    // this machine. Where there is none (CI container with loopback only), the
    // unit tests in tests/loopback.test.js still cover the guard itself.
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!lan) {
      t.skip('no non-loopback IPv4 interface on this machine');
      return;
    }
    const server = await startServer({ HOST: '0.0.0.0' });

    const res = await fetch(`http://${lan.address}:${server.port}/api/shutdown`, { method: 'POST' });
    assert.strictEqual(res.status, 403);
    assert.match((await readJson(res)).error, /loopback/, answerOf(res));

    await sleep(200);
    assert.strictEqual(server.alive(), true, 'a request from the network must not stop the board');
    assert.strictEqual((await fetch(server.base + '/api/board')).status, 200);
  });

  it('kills the agent sessions on the way out, exactly as a signal does', async () => {
    // The session command outlives its parent on POSIX unless it is killed
    // explicitly, so the exit button has to run the same session shutdown the
    // SIGINT/SIGTERM handler runs (T-0076/T-0091).
    const server = await startServer({
      BRIEFBOARD_SESSION_CMD: `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`,
    });
    fs.writeFileSync(
      path.join(server.root, 'doc', 'backlog.md'),
      [
        '# Backlog\n',
        '## T-0001 · Major · A task to open',
        '- type: feature',
        '- status: backlog',
        '- created: 2026-01-01 00:00:00',
        '- closed: —',
        '- briefs: ',
        '',
        'Description.',
        '',
      ].join('\n')
    );

    const opened = await post(server.base, '/api/task/T-0001/open');
    assert.strictEqual(opened.status, 200);
    assert.strictEqual((await readJson(opened)).session, 'started', answerOf(opened));

    const listed = await readJson(await fetch(server.base + '/api/sessions'));
    const pid = listed.sessions[0].pid;
    assert.ok(pid > 0, 'the session must report a real pid');

    const res = await post(server.base, '/api/shutdown');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await server.exited(), 0);

    await waitFor(
      () => !isProcessAlive(pid),
      SPAWN_WAIT_BUDGET_MS,
      'the agent session to go with the board that started it'
    );
  });
});
