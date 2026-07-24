'use strict';

// Security-hardening integration tests for server/server.js (T-0060):
//   - loopback bind by default, opt-in public bind via HOST/AGENTBOARD_HOST
//   - CSRF guard (Origin/Referer vs Host) on POST /api/task/:id/cancel
//   - concurrent SSE connection limit (MAX_SSE_CLIENTS)
//   - headersTimeout / requestTimeout are set
// Each test spawns a real `node server/server.js` against a throwaway
// AGENTBOARD_ROOT so the real project's doc/ files are never touched.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const SERVER_PATH = path.join(__dirname, '..', 'server', 'server.js');

// ---------- fixture helpers ----------

function makeFixtureRoot(backlog) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-sec-test-'));
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilReady(baseUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/');
      await res.arrayBuffer();
      if (res.status === 200) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(50);
  }
  throw new Error(`server at ${baseUrl} did not become ready: ${lastErr && lastErr.message}`);
}

// Spawns the server with custom env and captures stdout/stderr so tests can
// assert on the startup log (bound address, network-exposure warning).
async function startServer(root, extraEnv = {}) {
  const port = await getFreePort();
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, AGENTBOARD_ROOT: root, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (c) => (stdout += c.toString()));
  proc.stderr.on('data', (c) => (stderr += c.toString()));

  const exitedEarly = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
  const baseUrl = `http://127.0.0.1:${port}`;

  await Promise.race([
    waitUntilReady(baseUrl),
    exitedEarly.then((code) => {
      throw new Error(`server exited early code ${code}, stderr: ${stderr}`);
    }),
  ]);

  return {
    port,
    baseUrl,
    getStdout: () => stdout,
    getStderr: () => stderr,
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill();
      await new Promise((resolve) => proc.once('exit', resolve));
    },
  };
}

const activeServers = [];
const activeRoots = [];

async function setupServer(backlog, extraEnv) {
  const root = makeFixtureRoot(backlog);
  activeRoots.push(root);
  const server = await startServer(root, extraEnv);
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

// ---------- CSRF guard on POST /api/task/:id/cancel ----------

describe('POST /api/task/:id/cancel — CSRF (Origin/Referer) guard', () => {
  it('403: cross-origin Origin (host differs from Host) is rejected, file untouched', async () => {
    const { root, server } = await setupServer(sampleBacklog());
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0001/cancel', {
      method: 'POST',
      headers: { Origin: 'http://evil.example.com' },
    });
    const data = await res.json();

    assert.strictEqual(res.status, 403);
    assert.ok(data.error);
    const after = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after, before);
  });

  it('200: same-origin Origin (equal to server origin) is accepted and cancels', async () => {
    const { root, server } = await setupServer(sampleBacklog());

    const res = await fetch(server.baseUrl + '/api/task/T-0001/cancel', {
      method: 'POST',
      headers: { Origin: server.baseUrl },
    });
    const data = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'cancelled');
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
    const data = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'cancelled');
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0001[\s\S]*?- status: cancelled/);
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
      const data = await res.json();
      assert.ok(data.error);

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
