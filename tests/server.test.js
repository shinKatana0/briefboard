'use strict';

// Integration tests for server/server.js — exercise the real HTTP endpoints
// against a live server process pointed at a throwaway AGENTBOARD_ROOT, so the
// real project's doc/backlog.md / doc/brief/ are never touched.
// Run with: npm test  (or: node --test tests/**/*.test.js)

const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const SERVER_PATH = path.join(__dirname, '..', 'server', 'server.js');

// ---------- fixture helpers ----------

// Creates a throwaway project root with its own doc/backlog.md + doc/brief/,
// so tests never read or write the real project's files.
// withBriefDir:false starts a project WITHOUT doc/brief/ — used to exercise the
// lazy watch that must attach when the first brief appears at runtime (T-0047).
function makeFixtureRoot({ backlog = '', briefFiles = {}, withBriefDir = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-server-test-'));
  const docDir = path.join(root, 'doc');
  const briefDir = path.join(docDir, 'brief');
  if (withBriefDir || Object.keys(briefFiles).length) {
    fs.mkdirSync(briefDir, { recursive: true });
  } else {
    fs.mkdirSync(docDir, { recursive: true });
  }
  fs.writeFileSync(path.join(docDir, 'backlog.md'), backlog);
  for (const [name, content] of Object.entries(briefFiles)) {
    fs.writeFileSync(path.join(briefDir, name), content);
  }
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
    '- briefs: T-0001-01',
    '',
    'Some description.',
    '',
    '## T-0002 · Major · Open task (cancellable)',
    '- type: feature',
    '- status: open',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
    '## T-0003 · Major · In-progress task (not cancellable)',
    '- type: feature',
    '- status: in_progress',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Opens an SSE connection and returns helpers to consume the stream:
//   readUntil(predicate, timeoutMs) — buffers until predicate(buffer) is true.
//   changedCount()                  — how many 'data: changed' frames arrived.
//   close()                         — cancels the reader.
async function openSse(baseUrl) {
  const res = await fetch(baseUrl + '/events');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function readUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(buffer)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for SSE event; buffer so far: ${JSON.stringify(buffer)}`);
      }
      const { value, done } = await Promise.race([
        reader.read(),
        sleep(remaining).then(() => ({ done: true, value: undefined })),
      ]);
      if (done) {
        if (predicate(buffer)) return;
        throw new Error(`SSE stream ended before condition met; buffer so far: ${JSON.stringify(buffer)}`);
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }
  return {
    res,
    readUntil,
    changedCount: () => (buffer.match(/data: changed/g) || []).length,
    close: () => reader.cancel().catch(() => {}),
  };
}

// Finds a free TCP port by binding to port 0 and reading it back off, then
// closing immediately so the spawned server process can bind it itself.
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
      await res.arrayBuffer(); // drain the body
      if (res.status === 200) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(50);
  }
  throw new Error(`server at ${baseUrl} did not become ready in time: ${lastErr && lastErr.message}`);
}

// Spawns a real `node server/server.js` child process against a throwaway
// AGENTBOARD_ROOT and a random free port, and waits until it answers HTTP.
async function startServer(root) {
  const port = await getFreePort();
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, AGENTBOARD_ROOT: root, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const exitedEarly = new Promise((resolve) => {
    proc.once('exit', (code) => resolve(code));
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  await Promise.race([
    waitUntilReady(baseUrl),
    exitedEarly.then((code) => {
      throw new Error(`server process exited early with code ${code}, stderr: ${stderr}`);
    }),
  ]);

  return {
    port,
    baseUrl,
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill();
      await new Promise((resolve) => proc.once('exit', resolve));
    },
  };
}

// Tracks every server+root started in a test so leftovers get cleaned up even
// if an assertion throws mid-test.
const activeServers = [];
const activeRoots = [];

async function setupServer(fixtureOpts) {
  const root = makeFixtureRoot(fixtureOpts);
  activeRoots.push(root);
  const server = await startServer(root);
  activeServers.push(server);
  return { root, server };
}

afterEach(async () => {
  while (activeServers.length) {
    const server = activeServers.pop();
    await server.stop();
  }
  while (activeRoots.length) {
    const root = activeRoots.pop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- GET / ----------

describe('GET /', () => {
  it('serves the UI HTML with a 200 and text/html content type', async () => {
    const { server } = await setupServer({ backlog: sampleBacklog() });
    const res = await fetch(server.baseUrl + '/');
    const body = await res.text();

    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(body, /<html/i);
  });
});

describe('GET / — in-memory UI cache with mtime invalidation (T-0050)', () => {
  // The UI HTML is cached in memory and re-read only when ui/index.html's mtime
  // changes. We can't reach the server's private cache, so we verify the
  // observable invariant instead: the same bytes come back on repeat requests
  // while the file is unchanged, and fresh bytes come back after it changes.
  // (ui/index.html is shared install state, not per-fixture, so this test
  // restores the original content in a finally block.)
  const UI_HTML = path.join(__dirname, '..', 'ui', 'index.html');

  it('serves identical bytes on repeat requests, and fresh content after the file changes (no stale)', async () => {
    const original = fs.readFileSync(UI_HTML);
    const { server } = await setupServer({ backlog: sampleBacklog() });
    try {
      const first = await (await fetch(server.baseUrl + '/')).text();
      const second = await (await fetch(server.baseUrl + '/')).text();
      assert.strictEqual(first, second, 'repeat GET / must return the same cached content');

      // Change the file with a guaranteed-newer mtime, then assert the next
      // request reflects the change (cache invalidated by mtime, not stale).
      const marker = '<!-- T-0050 cache-invalidation marker -->';
      const changed = original.toString('utf8') + '\n' + marker + '\n';
      const future = new Date(Date.now() + 2000);
      fs.writeFileSync(UI_HTML, changed);
      fs.utimesSync(UI_HTML, future, future);

      const third = await (await fetch(server.baseUrl + '/')).text();
      assert.ok(third.includes(marker), 'GET / after edit must return fresh (non-stale) content');
    } finally {
      fs.writeFileSync(UI_HTML, original);
    }
  });

  it('revalidates with ETag: a matching If-None-Match gets a 304 with no body', async () => {
    const { server } = await setupServer({ backlog: sampleBacklog() });
    const first = await fetch(server.baseUrl + '/');
    await first.arrayBuffer();
    const etag = first.headers.get('etag');
    assert.ok(etag, 'GET / must expose an ETag header');

    const res = await fetch(server.baseUrl + '/', { headers: { 'If-None-Match': etag } });
    const body = await res.text();
    assert.strictEqual(res.status, 304);
    assert.strictEqual(body, '');
  });
});

// ---------- GET /api/board ----------

describe('GET /api/board', () => {
  it('returns 200 JSON with tasks parsed from the fixture backlog.md', async () => {
    const { server } = await setupServer({ backlog: sampleBacklog() });
    const res = await fetch(server.baseUrl + '/api/board');
    const data = await res.json();

    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.ok(Array.isArray(data.tasks));
    assert.deepStrictEqual(
      data.tasks.map((t) => t.id),
      ['T-0001', 'T-0002', 'T-0003']
    );
    assert.strictEqual(data.tasks[0].status, 'backlog');
    assert.strictEqual(data.tasks[1].status, 'open');
    assert.strictEqual(data.tasks[2].status, 'in_progress');
  });

  // T-0050: conditional GET support for /api/board.
  it('exposes an ETag and returns 304 (no body) for a matching If-None-Match', async () => {
    const { server } = await setupServer({ backlog: sampleBacklog() });

    const first = await fetch(server.baseUrl + '/api/board');
    await first.arrayBuffer();
    const etag = first.headers.get('etag');
    assert.ok(etag, '/api/board must expose an ETag header on 200');

    const res = await fetch(server.baseUrl + '/api/board', {
      headers: { 'If-None-Match': etag },
    });
    const body = await res.text();
    assert.strictEqual(res.status, 304);
    assert.strictEqual(body, '', '304 must have an empty body');
    assert.strictEqual(res.headers.get('etag'), etag);
  });

  it('changes its ETag after backlog.md is modified and serves fresh 200 data (no stale)', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });
    const backlogPath = path.join(root, 'doc', 'backlog.md');

    const first = await fetch(server.baseUrl + '/api/board');
    const firstData = await first.json();
    const firstEtag = first.headers.get('etag');
    assert.strictEqual(firstData.tasks.length, 3);

    // Append a new task with a guaranteed-newer mtime so the ETag must change.
    const added = [
      '',
      '## T-0004 · Major · Added at runtime',
      '- type: feature',
      '- status: backlog',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: ',
      '',
    ].join('\n');
    fs.writeFileSync(backlogPath, sampleBacklog() + added);
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(backlogPath, future, future);

    // Revalidating with the OLD ETag must NOT yield 304 — the file changed.
    const revalidate = await fetch(server.baseUrl + '/api/board', {
      headers: { 'If-None-Match': firstEtag },
    });
    const data = await revalidate.json();
    assert.strictEqual(revalidate.status, 200, 'stale ETag must not produce 304 after a change');
    assert.notStrictEqual(revalidate.headers.get('etag'), firstEtag, 'ETag must change after edit');
    assert.deepStrictEqual(
      data.tasks.map((t) => t.id),
      ['T-0001', 'T-0002', 'T-0003', 'T-0004'],
      'response must reflect the freshly added task (no stale cache)'
    );
  });
});

// ---------- GET /api/brief/:id ----------

describe('GET /api/brief/:id', () => {
  it('returns 200 with the markdown content for an existing brief', async () => {
    const { server } = await setupServer({
      backlog: sampleBacklog(),
      briefFiles: { 'T-0001-01-cancellable.md': '# T-0001-01 · Brief\n\nBody text.\n' },
    });

    const res = await fetch(server.baseUrl + '/api/brief/T-0001-01');
    const data = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.id, 'T-0001-01');
    assert.strictEqual(data.file, 'T-0001-01-cancellable.md');
    assert.match(data.markdown, /Body text\./);
  });

  it('returns 404 for a brief id that has no matching file', async () => {
    const { server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '/api/brief/T-9999-01');
    const data = await res.json();

    assert.strictEqual(res.status, 404);
    assert.ok(data.error);
  });

  // Regression tests for T-0039: decodeURIComponent throws a URIError on
  // malformed percent-encoding, and that used to be an unguarded throw
  // inside the http.createServer callback — an uncaught exception there
  // takes down the whole process (curl-equivalent of the crash confirmed
  // live: a single such request killed the server for every client).
  for (const badId of ['%', '%zz', '%E0%A4%A']) {
    it(`malformed percent-encoding in id (${badId}) returns 400, not a crash`, async () => {
      const { server } = await setupServer({ backlog: sampleBacklog() });

      const res = await fetch(server.baseUrl + '/api/brief/' + badId);

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);

      // The server process must still be alive and answering other
      // requests afterwards, not just this one connection.
      const board = await fetch(server.baseUrl + '/api/board');
      assert.strictEqual(board.status, 200);
    });
  }
});

// ---------- malformed request URL (any path) ----------

describe('malformed request URL', () => {
  // "GET // HTTP/1.1" yields req.url === "//", which `new URL(req.url,
  // 'http://localhost')` rejects with a TypeError ("Invalid URL") — found
  // during the T-0039 audit of other unguarded throw points fed by
  // attacker-controlled input, same crash class as the decodeURIComponent
  // bug above.
  it('a request path the WHATWG URL parser rejects (e.g. "//") returns 400, not a crash', async () => {
    const { server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '//');

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);

    const board = await fetch(server.baseUrl + '/api/board');
    assert.strictEqual(board.status, 200);
  });
});

// ---------- POST /api/task/:id/cancel ----------

describe('POST /api/task/:id/cancel', () => {
  it('200: cancels a task in status "backlog" and persists the change to disk', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0001/cancel', { method: 'POST' });
    const data = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.id, 'T-0001');
    assert.strictEqual(data.status, 'cancelled');
    assert.match(data.closed, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0001[\s\S]*?- status: cancelled/);
    assert.match(onDisk, /## T-0001[\s\S]*?- closed: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('200: cancels a task in status "open" and persists the change to disk', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0002/cancel', { method: 'POST' });
    const data = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'cancelled');

    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0002[\s\S]*?- status: cancelled/);
  });

  it('409: refuses to cancel a task in status "in_progress" and leaves the file untouched', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0003/cancel', { method: 'POST' });
    const data = await res.json();

    assert.strictEqual(res.status, 409);
    assert.ok(data.error);

    const after_ = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after_, before);
  });

  it('404: unknown task id, file untouched', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-9999/cancel', { method: 'POST' });
    const data = await res.json();

    assert.strictEqual(res.status, 404);
    assert.ok(data.error);

    const after_ = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after_, before);
  });

  it('405: non-POST methods (GET) are rejected', async () => {
    const { server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0001/cancel', { method: 'GET' });

    assert.strictEqual(res.status, 405);
  });

  it('malformed id (does not match T-dddd) does not 500 or crash the process', async () => {
    const { server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/foo/cancel', { method: 'POST' });

    assert.notStrictEqual(res.status, 500);
    // The process must still be alive and answering other requests afterwards.
    const board = await fetch(server.baseUrl + '/api/board');
    assert.strictEqual(board.status, 200);
  });
});

// ---------- GET /events (SSE) ----------

describe('GET /events', () => {
  it('sends an initial "connected" event, then "changed" after doc/ is modified', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '/events');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Reads from the SSE stream until `predicate(buffer)` is true or the
    // timeout elapses.
    async function readUntil(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(buffer)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`timed out waiting for SSE event; buffer so far: ${JSON.stringify(buffer)}`);
        }
        const { value, done } = await Promise.race([
          reader.read(),
          sleep(remaining).then(() => ({ done: true, value: undefined, timedOut: true })),
        ]);
        if (done) {
          if (predicate(buffer)) return;
          throw new Error(`SSE stream ended before condition met; buffer so far: ${JSON.stringify(buffer)}`);
        }
        buffer += decoder.decode(value, { stream: true });
      }
    }

    try {
      await readUntil((b) => b.includes('data: connected'), 3000);

      // Modify a file under the watched doc/ dir directly; the server's
      // fs.watch + 150ms debounce should broadcast "data: changed".
      fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), sampleBacklog() + '\n# touched\n');

      await readUntil((b) => b.includes('data: changed'), 3000);
    } finally {
      reader.cancel().catch(() => {});
    }
  });
});

// ---------- GET /events — lazy brief watch (T-0047) ----------

describe('GET /events — lazy doc/brief/ watch (T-0047)', () => {
  it('broadcasts "changed" when the FIRST brief is created after startup with no doc/brief/', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog(), withBriefDir: false });
    const briefDir = path.join(root, 'doc', 'brief');
    assert.ok(!fs.existsSync(briefDir), 'fixture must start without doc/brief/');

    const sse = await openSse(server.baseUrl);
    try {
      await sse.readUntil((b) => b.includes('data: connected'), 3000);

      // First brief in a fresh project: doc/brief/ and the file appear at
      // runtime. The DOC_DIR watcher must lazily attach a BRIEF_DIR watcher.
      fs.mkdirSync(briefDir, { recursive: true });
      fs.writeFileSync(path.join(briefDir, 'T-0001-01-first.md'), '# first brief\n');
      await sse.readUntil((b) => sse.changedCount() >= 1, 3000);

      // Editing a file INSIDE doc/brief/ does not touch doc/ itself, so only a
      // watcher attached to doc/brief/ can catch it — this is the real proof
      // that the lazy attach happened (a non-recursive doc/ watch would miss it).
      await sleep(300); // let the first debounce settle
      const before = sse.changedCount();
      fs.writeFileSync(path.join(briefDir, 'T-0001-01-first.md'), '# first brief edited\n');
      await sse.readUntil(() => sse.changedCount() >= before + 1, 3000);
    } finally {
      sse.close();
    }
  });

  it('re-attaches without duplicates or crashing when doc/brief/ is removed and recreated', async () => {
    const { root, server } = await setupServer({
      backlog: sampleBacklog(),
      briefFiles: { 'T-0001-01-first.md': '# first\n' },
    });
    const briefDir = path.join(root, 'doc', 'brief');

    const sse = await openSse(server.baseUrl);
    try {
      await sse.readUntil((b) => b.includes('data: connected'), 3000);

      // Remove the whole brief dir; the DOC_DIR event must reconcile the now
      // stale brief watcher (drop it) without taking the process down.
      fs.rmSync(briefDir, { recursive: true, force: true });
      await sse.readUntil(() => sse.changedCount() >= 1, 3000);
      await sleep(300);

      // Recreate it and add a brief. A fresh brief watcher must attach, proven
      // by an edit inside the recreated dir still broadcasting 'changed'.
      fs.mkdirSync(briefDir, { recursive: true });
      fs.writeFileSync(path.join(briefDir, 'T-0002-01-again.md'), '# again\n');
      await sse.readUntil(() => sse.changedCount() >= 2, 3000);

      await sleep(300);
      const before = sse.changedCount();
      fs.writeFileSync(path.join(briefDir, 'T-0002-01-again.md'), '# again edited\n');
      await sse.readUntil(() => sse.changedCount() >= before + 1, 3000);
    } finally {
      sse.close();
    }

    // Server must still be alive and serving after all the churn.
    const board = await fetch(server.baseUrl + '/api/board');
    assert.strictEqual(board.status, 200);
  });
});
