'use strict';

// Security-hardening integration tests for server/server.js (T-0060):
//   - loopback bind by default, opt-in public bind via HOST/AGENTBOARD_HOST
//   - CSRF guard (Origin/Referer vs Host) on POST /api/task/:id/{cancel,open,start}
//   - concurrent SSE connection limit (MAX_SSE_CLIENTS)
//   - headersTimeout / requestTimeout are set
// Each test spawns a real `node server/server.js` against a throwaway
// AGENTBOARD_ROOT so the real project's doc/ files are never touched.

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { tempDir } = require('./helpers/tmp.js');

// ---------- fixture helpers ----------

function makeFixtureRoot(backlog) {
  const root = tempDir('briefboard-sec-test-');
  const docDir = path.join(root, 'doc');
  fs.mkdirSync(path.join(docDir, 'brief'), { recursive: true });
  fs.writeFileSync(path.join(docDir, 'backlog.md'), backlog);
  return root;
}

function sampleBacklog() {
  return [
    '# Backlog\n',
    '## T-0001 · Major · Backlog task (cancellable)',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
    'Some description.',
    '',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const activeServers = [];
const activeRoots = [];

// The board captures stdout/stderr, so a test can assert on the startup log
// (bound address, network-exposure warning).
async function setupServer(backlog, extraEnv) {
  const root = makeFixtureRoot(backlog);
  activeRoots.push(root);
  const server = await startBoard(root, extraEnv);
  activeServers.push(server);
  return { root, server };
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) fs.rmSync(activeRoots.pop(), { recursive: true, force: true });
});

// ---------- default loopback bind ----------

describe('default bind is loopback', () => {
  it('binds to 127.0.0.1 (not 0.0.0.0/::) when no HOST env is set', async () => {
    const { server } = await setupServer(sampleBacklog());
    // The startup log echoes server.address().address on a `bound:` line.
    const boundLine = server.getStdout().split('\n').find((l) => l.startsWith('bound:'));
    assert.ok(boundLine, `expected a "bound:" line, got: ${JSON.stringify(server.getStdout())}`);
    const addr = boundLine.replace('bound:', '').trim().split(':')[0];
    assert.strictEqual(addr, '127.0.0.1');
    assert.notStrictEqual(addr, '0.0.0.0');
    // No network-exposure warning for a loopback bind.
    assert.doesNotMatch(server.getStderr(), /WARNING/);
  });
});

describe('opt-in public bind', () => {
  it('HOST=0.0.0.0 overrides the bind and logs a network-exposure warning', async () => {
    const { server } = await setupServer(sampleBacklog(), { HOST: '0.0.0.0' });
    const boundLine = server.getStdout().split('\n').find((l) => l.startsWith('bound:'));
    assert.ok(boundLine);
    const addr = boundLine.replace('bound:', '').trim().split(':')[0];
    assert.strictEqual(addr, '0.0.0.0');
    assert.match(server.getStderr(), /WARNING/);
    assert.match(server.getStderr(), /0\.0\.0\.0/);
  });

  it('AGENTBOARD_HOST=0.0.0.0 also overrides the bind and warns', async () => {
    const { server } = await setupServer(sampleBacklog(), { AGENTBOARD_HOST: '0.0.0.0' });
    const boundLine = server.getStdout().split('\n').find((l) => l.startsWith('bound:'));
    assert.ok(boundLine);
    assert.strictEqual(boundLine.replace('bound:', '').trim().split(':')[0], '0.0.0.0');
    assert.match(server.getStderr(), /WARNING/);
  });
});

// ---------- Host guard (T-0226) ----------

// `fetch` will not let a caller set Host, and that is exactly the header under
// test — so these go out over node:http, which does. A rebinding browser sends
// it by itself; here it is written by hand for the same effect.
function askWithHost(port, { method = 'GET', path: reqPath = '/api/board', host, origin } = {}) {
  const headers = {};
  if (host !== undefined) headers.Host = host;
  if (origin !== undefined) headers.Origin = origin;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers, timeout: 20000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`no response from ${reqPath} within 20000ms`)));
    req.on('error', reject);
    req.end();
  });
}

describe('the Host header is checked against the address the board bound (T-0226)', () => {
  // The reproduction: under DNS rebinding both headers name the attacker's
  // domain, so they agree and sameOrigin() passes. Before this guard the write
  // landed in doc/backlog.md.
  it('403: a forged Host with an agreeing Origin cannot write, file untouched', async () => {
    const { root, server } = await setupServer(sampleBacklog());
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await askWithHost(server.port, {
      method: 'POST',
      path: '/api/task/T-0001/cancel',
      host: 'evil.com',
      origin: 'http://evil.com',
    });

    assert.strictEqual(res.status, 403, res.body);
    assert.match(res.body, /is not this board/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8'), before);
  });

  // Reads leak the project as surely as writes change it, so the guard runs
  // before routing rather than beside the CSRF check on the writing endpoints.
  it('403: a forged Host cannot read the board, a brief or the event stream', async () => {
    const { root, server } = await setupServer(sampleBacklog());
    fs.writeFileSync(path.join(root, 'doc', 'brief', 'T-0001-01-probe.md'), 'secret-brief-content\n');

    for (const target of ['/api/board', '/api/brief/T-0001-01', '/events', '/']) {
      const res = await askWithHost(server.port, {
        path: target,
        host: 'evil.com',
        origin: 'http://evil.com',
      });
      assert.strictEqual(res.status, 403, `${target}: ${res.body}`);
      assert.doesNotMatch(res.body, /secret-brief-content/);
    }
  });

  it('403: the board is not stopped by a forged Host', async () => {
    const { server } = await setupServer(sampleBacklog());

    const res = await askWithHost(server.port, {
      method: 'POST',
      path: '/api/shutdown',
      host: 'attacker.example',
      origin: 'http://attacker.example',
    });

    assert.strictEqual(res.status, 403, res.body);
    assert.ok(server.alive(), 'the board must still be running');
    // Not merely alive: still answering.
    const honest = await askWithHost(server.port, { host: `127.0.0.1:${server.port}` });
    assert.strictEqual(honest.status, 200, honest.body);
  });

  it('200: every spelling of this board`s own address is accepted', async () => {
    const { server } = await setupServer(sampleBacklog());

    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `[::1]:${server.port}`]) {
      const res = await askWithHost(server.port, { host, origin: `http://${host}` });
      assert.strictEqual(res.status, 200, `${host}: ${res.body}`);
    }
  });

  it('403: a loopback name on a port this board did not bind', async () => {
    const { server } = await setupServer(sampleBacklog());

    const res = await askWithHost(server.port, { host: `127.0.0.1:${server.port + 1}` });
    assert.strictEqual(res.status, 403, res.body);
  });

  // A request with no Host is refused rather than waved through as "no name to
  // disagree with". Spelled HTTP/1.0 on a raw socket, which is the only way to
  // ask it: node:http supplies a Host of its own when the caller omits one, and
  // Node's own parser answers 400 to an HTTP/1.1 request without one.
  it('403: an HTTP/1.0 request with no Host header', async () => {
    const { server } = await setupServer(sampleBacklog());

    const answer = await new Promise((resolve, reject) => {
      const socket = net.connect(server.port, '127.0.0.1');
      let text = '';
      socket.setTimeout(20000, () => socket.destroy(new Error('no answer within 20000ms')));
      socket.on('connect', () => socket.write('GET /api/board HTTP/1.0\r\n\r\n'));
      socket.on('data', (c) => (text += c.toString()));
      socket.on('close', () => resolve(text));
      socket.on('error', reject);
    });

    assert.match(answer.split('\r\n')[0], / 403 /, answer);
    assert.match(answer, /is not this board/);
  });

  // A reverse proxy that forwards the browser's Host instead of rewriting it to
  // the upstream: the name has to be declared, and only the declared one passes.
  it('BRIEFBOARD_ALLOWED_HOSTS admits the declared name and nothing else', async () => {
    const { server } = await setupServer(sampleBacklog(), {
      BRIEFBOARD_ALLOWED_HOSTS: 'board.example.com, boards.internal',
    });

    for (const host of ['board.example.com', 'board.example.com:8443', 'boards.internal']) {
      const res = await askWithHost(server.port, { host, origin: `http://${host}` });
      assert.strictEqual(res.status, 200, `${host}: ${res.body}`);
    }
    const undeclared = await askWithHost(server.port, { host: 'evil.com' });
    assert.strictEqual(undeclared.status, 403, undeclared.body);
  });

  // The decision for a public bind, asserted rather than left to the prose: the
  // board is reachable by name from the network already and warns about it at
  // start-up, so there is no set of names to check against and none is invented.
  it('a public bind accepts any Host, and the start-up warning says so', async () => {
    const { server } = await setupServer(sampleBacklog(), { HOST: '0.0.0.0' });

    const res = await askWithHost(server.port, { host: 'anything.example', origin: 'http://anything.example' });
    assert.strictEqual(res.status, 200, res.body);
    assert.match(server.getStderr(), /WARNING/);
    assert.match(server.getStderr(), /Host/);
  });
});

// ---------- CSRF guard on POST /api/task/:id/cancel ----------

describe('POST /api/task/:id/cancel — CSRF (Origin/Referer) guard', () => {
  it('403: cross-origin Origin (host differs from Host) is rejected, file untouched', async () => {
    const { root, server } = await setupServer(sampleBacklog());
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0001/cancel', {
      method: 'POST',
      headers: { Origin: 'http://evil.example.com' },
    });
    const data = await readJson(res);

    assert.strictEqual(res.status, 403);
    assert.ok(data.error, answerOf(data));
    const after = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after, before);
  });

  it('200: same-origin Origin (equal to server origin) is accepted and cancels', async () => {
    const { root, server } = await setupServer(sampleBacklog());

    const res = await fetch(server.baseUrl + '/api/task/T-0001/cancel', {
      method: 'POST',
      headers: { Origin: server.baseUrl },
    });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'cancelled', answerOf(data));
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0001[\s\S]*?- status: cancelled/);
  });

  it('403: cross-origin Referer (no Origin) is rejected, file untouched', async () => {
    const { root, server } = await setupServer(sampleBacklog());
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0001/cancel', {
      method: 'POST',
      headers: { Referer: 'http://evil.example.com/page' },
    });

    assert.strictEqual(res.status, 403);
    const after = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after, before);
  });

  it('200: no Origin and no Referer (curl/CLI/test) still works as before', async () => {
    const { root, server } = await setupServer(sampleBacklog());

    const res = await fetch(server.baseUrl + '/api/task/T-0001/cancel', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'cancelled', answerOf(data));
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0001[\s\S]*?- status: cancelled/);
  });
});

// ---------- CSRF guard on POST /api/task/:id/open ----------

describe('POST /api/task/:id/open — CSRF (Origin/Referer) guard', () => {
  it('403: cross-origin Origin (host differs from Host) is rejected, file untouched', async () => {
    const { root, server } = await setupServer(sampleBacklog());
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0001/open', {
      method: 'POST',
      headers: { Origin: 'http://evil.example.com' },
    });
    const data = await readJson(res);

    assert.strictEqual(res.status, 403);
    assert.ok(data.error, answerOf(data));
    const after = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after, before);
  });

  it('403: cross-origin Referer (no Origin) is rejected, file untouched', async () => {
    const { root, server } = await setupServer(sampleBacklog());
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0001/open', {
      method: 'POST',
      headers: { Referer: 'http://evil.example.com/page' },
    });
    await res.arrayBuffer();

    assert.strictEqual(res.status, 403);
    const after = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after, before);
  });

  it('200: same-origin Origin (equal to server origin) is accepted and opens', async () => {
    const { root, server } = await setupServer(sampleBacklog());

    const res = await fetch(server.baseUrl + '/api/task/T-0001/open', {
      method: 'POST',
      headers: { Origin: server.baseUrl },
    });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'open', answerOf(data));
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0001[\s\S]*?- status: open/);
  });

  it('200: no Origin and no Referer (curl/CLI/test) is allowed through', async () => {
    const { root, server } = await setupServer(sampleBacklog());

    const res = await fetch(server.baseUrl + '/api/task/T-0001/open', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'open', answerOf(data));
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0001[\s\S]*?- status: open/);
  });
});

// ---------- CSRF guard on POST /api/task/:id/start ----------

// The board's fourth writing endpoint (T-0084) is behind the same guard, and it
// is the one that can also start a process — so a cross-site POST reaching it
// would be worse than a stray status change.
function readyBacklog() {
  return [
    '# Backlog\n',
    '## T-0002 · Major · Ready task (startable)',
    '- type: feature',
    '- status: ready',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
  ].join('\n');
}

describe('POST /api/task/:id/start — CSRF (Origin/Referer) guard', () => {
  it('403: cross-origin Origin (host differs from Host) is rejected, file untouched', async () => {
    const { root, server } = await setupServer(readyBacklog());
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0002/start', {
      method: 'POST',
      headers: { Origin: 'http://evil.example.com' },
    });
    const data = await readJson(res);

    assert.strictEqual(res.status, 403);
    assert.ok(data.error, answerOf(data));
    assert.strictEqual(fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8'), before);
  });

  it('403: cross-origin Referer (no Origin) is rejected, file untouched', async () => {
    const { root, server } = await setupServer(readyBacklog());
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0002/start', {
      method: 'POST',
      headers: { Referer: 'http://evil.example.com/page' },
    });
    await res.arrayBuffer();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8'), before);
  });

  it('200: same-origin Origin (equal to server origin) is accepted and starts', async () => {
    const { root, server } = await setupServer(readyBacklog());

    const res = await fetch(server.baseUrl + '/api/task/T-0002/start', {
      method: 'POST',
      headers: { Origin: server.baseUrl },
    });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0002[\s\S]*?- status: in_progress/);
  });
});

// ---------- SSE connection limit ----------

describe('GET /events — MAX_SSE_CLIENTS limit', () => {
  it('503 once clients.size reaches the limit; within the limit it connects', async () => {
    const { server } = await setupServer(sampleBacklog(), { MAX_SSE_CLIENTS: '2' });
    const controllers = [];

    // Open two SSE connections up to the limit; keep them open.
    for (let i = 0; i < 2; i++) {
      const ctrl = new AbortController();
      controllers.push(ctrl);
      const res = await fetch(server.baseUrl + '/events', { signal: ctrl.signal });
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
    }

    try {
      // The third connection exceeds the limit → 503, not added to clients.
      const res = await fetch(server.baseUrl + '/events');
      assert.strictEqual(res.status, 503);
      const data = await readJson(res);
      assert.ok(data.error, answerOf(data));

      // Free one slot; a new connection should now succeed again.
      controllers[0].abort();
      // Give the server a moment to observe req 'close' and drop the client.
      await sleep(200);
      const ctrl2 = new AbortController();
      controllers.push(ctrl2);
      const res2 = await fetch(server.baseUrl + '/events', { signal: ctrl2.signal });
      assert.strictEqual(res2.status, 200);
    } finally {
      for (const c of controllers) c.abort();
    }
  });
});
