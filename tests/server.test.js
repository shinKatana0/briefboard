'use strict';

// Integration tests for server/server.js — exercise the real HTTP endpoints
// against a live server process pointed at a throwaway AGENTBOARD_ROOT, so the
// real project's doc/backlog.md / doc/brief/ are never touched.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { removeTree } = require('./helpers/rm.js');
const { tempDir } = require('./helpers/tmp.js');

// ---------- fixture helpers ----------

// Creates a throwaway project root with its own doc/backlog.md + doc/brief/,
// so tests never read or write the real project's files.
// withBriefDir:false starts a project WITHOUT doc/brief/ — used to exercise the
// lazy watch that must attach when the first brief appears at runtime (T-0047).
function makeFixtureRoot({ backlog = '', briefFiles = {}, withBriefDir = true } = {}) {
  const root = tempDir('briefboard-server-test-');
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
    // Awaited: an async predicate hands back a promise, `!promise` is false,
    // and this loop would end before reading a single frame (T-0189).
    while (!(await predicate(buffer))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for SSE event; buffer so far: ${JSON.stringify(buffer)}`);
      }
      const { value, done } = await Promise.race([
        reader.read(),
        sleep(remaining).then(() => ({ done: true, value: undefined })),
      ]);
      if (done) {
        if (await predicate(buffer)) return;
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

// Copies the install tree (server/ + ui/index.html) into a throwaway directory.
// The served UI is read from the install root, not from AGENTBOARD_ROOT, so a
// test that needs to edit it edits this copy: writing to the repository's own
// ui/index.html leaves the working copy dirty whenever the run dies before the
// restoring finally (T-0111).
function makeInstallCopy() {
  const dir = tempDir('briefboard-install-');
  fs.cpSync(path.join(__dirname, '..', 'server'), path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ui'));
  fs.copyFileSync(path.join(__dirname, '..', 'ui', 'index.html'), path.join(dir, 'ui', 'index.html'));
  activeRoots.push(dir);
  return dir;
}

// Tracks every server+root started in a test so leftovers get cleaned up even
// if an assertion throws mid-test.
const activeServers = [];
const activeRoots = [];

// `serverPath` lets a test run the copy of the install tree it just edited.
async function setupServer(fixtureOpts, { serverPath } = {}) {
  const root = makeFixtureRoot(fixtureOpts);
  activeRoots.push(root);
  const server = await startBoard(root, {}, { serverPath });
  activeServers.push(server);
  return { root, server };
}

afterEach(async () => {
  while (activeServers.length) {
    const server = activeServers.pop();
    await server.stop();
  }
  while (activeRoots.length) await removeTree(activeRoots.pop());
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
  it('serves identical bytes on repeat requests, and fresh content after the file changes (no stale)', async () => {
    const install = makeInstallCopy();
    const uiHtml = path.join(install, 'ui', 'index.html');
    const { server } = await setupServer(
      { backlog: sampleBacklog() },
      { serverPath: path.join(install, 'server', 'server.js') }
    );

    const first = await (await fetch(server.baseUrl + '/')).text();
    const second = await (await fetch(server.baseUrl + '/')).text();
    assert.strictEqual(first, second, 'repeat GET / must return the same cached content');

    // Change the file with a guaranteed-newer mtime, then assert the next
    // request reflects the change (cache invalidated by mtime, not stale).
    const marker = '<!-- T-0050 cache-invalidation marker -->';
    const changed = fs.readFileSync(uiHtml, 'utf8') + '\n' + marker + '\n';
    const future = new Date(Date.now() + 2000);
    fs.writeFileSync(uiHtml, changed);
    fs.utimesSync(uiHtml, future, future);

    const third = await (await fetch(server.baseUrl + '/')).text();
    assert.ok(third.includes(marker), 'GET / after edit must return fresh (non-stale) content');
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
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.ok(Array.isArray(data.tasks));
    assert.deepStrictEqual(
      data.tasks.map((t) => t.id),
      ['T-0001', 'T-0002', 'T-0003']
    );
    assert.strictEqual(data.tasks[0].status, 'backlog', answerOf(data));
    assert.strictEqual(data.tasks[1].status, 'open', answerOf(data));
    assert.strictEqual(data.tasks[2].status, 'in_progress', answerOf(data));
  });

  it('reports depends and the resolved blockedBy list per task (T-0087)', async () => {
    const backlog = [
      '# Backlog\n',
      '## T-0001 · Major · Finished prerequisite',
      '- type: feature',
      '- status: done',
      '- closed: 2026-01-02 00:00:00',
      '',
      '## T-0002 · Major · Unfinished prerequisite',
      '- type: feature',
      '- status: in_progress',
      '',
      '## T-0003 · Major · Dependent task',
      '- type: feature',
      '- status: ready',
      '- depends: T-0001, T-0002',
      '',
    ].join('\n');
    const { server } = await setupServer({ backlog });
    const data = await readJson(await fetch(server.baseUrl + '/api/board'));
    const byId = Object.fromEntries(data.tasks.map((t) => [t.id, t]));

    assert.deepStrictEqual(byId['T-0003'].depends, ['T-0001', 'T-0002']);
    // Only the prerequisite that is not closed yet blocks.
    assert.deepStrictEqual(byId['T-0003'].blockedBy, ['T-0002']);
    assert.deepStrictEqual(byId['T-0001'].depends, []);
    assert.deepStrictEqual(byId['T-0001'].blockedBy, []);
  });

  it('flags an open task whose session left questions in the description (T-0083)', async () => {
    const backlog = [
      '# Backlog\n',
      '## T-0001 · Major · Session asked something',
      '- type: feature',
      '- status: open',
      '',
      'Refined so far.',
      '',
      '### Session questions',
      '',
      '- Does the export include cancelled tasks?',
      '',
      '## T-0002 · Major · Session had nothing to ask',
      '- type: feature',
      '- status: open',
      '',
      'Refined so far.',
      '',
      '## T-0003 · Major · Answered and briefed',
      '- type: feature',
      '- status: ready',
      '',
      'Refined so far.',
      '',
      '### Session questions',
      '',
      '- Does the export include cancelled tasks? Yes.',
      '',
      '## T-0004 · Major · Merely talks about the protocol',
      '- type: feature',
      '- status: open',
      '',
      'A session writes a `### Session questions` section when it has to ask.',
      '',
      '## T-0005 · Major · Worker session stopped to ask (T-0101)',
      '- type: feature',
      '- status: in_progress',
      '',
      'Implementing.',
      '',
      '### Session questions',
      '',
      '- Which of the two schemas is the real one?',
      '',
    ].join('\n');
    const { server } = await setupServer({ backlog });
    const data = await readJson(await fetch(server.baseUrl + '/api/board'));
    const byId = Object.fromEntries(data.tasks.map((t) => [t.id, t]));

    assert.strictEqual(byId['T-0001'].awaitingAnswer, true);
    assert.strictEqual(byId['T-0002'].awaitingAnswer, false);
    // Left `open` behind, so it is answered whatever the text still says.
    assert.strictEqual(byId['T-0003'].awaitingAnswer, false);
    // The heading only counts on a line of its own.
    assert.strictEqual(byId['T-0004'].awaitingAnswer, false);
    // A worker session asks from `in_progress` and stays there: the status
    // still says which phase the task is in, the marker says the work stands.
    assert.strictEqual(byId['T-0005'].awaitingAnswer, true);
    assert.strictEqual(byId['T-0005'].status, 'in_progress');
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
    const firstData = await readJson(first);
    const firstEtag = first.headers.get('etag');
    assert.strictEqual(firstData.tasks.length, 3, answerOf(firstData));

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
    const data = await readJson(revalidate);
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
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.id, 'T-0001-01', answerOf(data));
    assert.strictEqual(data.file, 'T-0001-01-cancellable.md', answerOf(data));
    assert.match(data.markdown, /Body text\./, answerOf(data));
  });

  it('returns 404 for a brief id that has no matching file', async () => {
    const { server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '/api/brief/T-9999-01');
    const data = await readJson(res);

    assert.strictEqual(res.status, 404);
    assert.ok(data.error, answerOf(data));
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
      const data = await readJson(res);
      assert.ok(data.error, answerOf(data));

      // The server process must still be alive and answering other
      // requests afterwards, not just this one connection.
      const board = await fetch(server.baseUrl + '/api/board');
      assert.strictEqual(board.status, 200, answerOf(board));
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
    const data = await readJson(res);
    assert.ok(data.error, answerOf(data));

    const board = await fetch(server.baseUrl + '/api/board');
    assert.strictEqual(board.status, 200, answerOf(board));
  });
});

// ---------- POST /api/task/:id/cancel ----------

describe('POST /api/task/:id/cancel', () => {
  it('200: cancels a task in status "backlog" and persists the change to disk', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0001/cancel', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(data.id, 'T-0001', answerOf(data));
    assert.strictEqual(data.status, 'cancelled', answerOf(data));
    assert.match(data.closed, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, answerOf(data));

    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0001[\s\S]*?- status: cancelled/);
    assert.match(onDisk, /## T-0001[\s\S]*?- closed: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('200: cancels a task in status "open" and persists the change to disk', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0002/cancel', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'cancelled', answerOf(data));

    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0002[\s\S]*?- status: cancelled/);
  });

  it('409: refuses to cancel a task in status "in_progress" and leaves the file untouched', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0003/cancel', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 409);
    assert.ok(data.error, answerOf(data));

    const after_ = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after_, before);
  });

  it('404: unknown task id, file untouched', async () => {
    const { root, server } = await setupServer({ backlog: sampleBacklog() });
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-9999/cancel', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 404);
    assert.ok(data.error, answerOf(data));

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
    assert.strictEqual(board.status, 200, answerOf(board));
  });
});

// ---------- POST /api/task/:id/open ----------

// One task per lifecycle status, so the "only backlog is accepted" rule can be
// checked against every other status rather than a single representative one.
// T-0011 is the only task in status `backlog`.
const OPEN_FIXTURE_IDS = {
  backlog: 'T-0011',
  open: 'T-0012',
  ready: 'T-0013',
  in_progress: 'T-0014',
  review: 'T-0015',
  done: 'T-0016',
  cancelled: 'T-0017',
};

function statusBacklog() {
  const lines = ['# Backlog\n'];
  for (const [status, id] of Object.entries(OPEN_FIXTURE_IDS)) {
    const closed = status === 'done' || status === 'cancelled' ? '2026-01-02 00:00:00' : '—';
    lines.push(
      `## ${id} · Major · Task in ${status}`,
      '- type: feature',
      `- status: ${status}`,
      '- created: 2026-01-01 00:00:00',
      `- closed: ${closed}`,
      '- briefs: ',
      ''
    );
  }
  return lines.join('\n');
}

describe('POST /api/task/:id/open', () => {
  it('200: moves a task from "backlog" to "open" and persists the change to disk', async () => {
    const { root, server } = await setupServer({ backlog: statusBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0011/open', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(data.id, 'T-0011', answerOf(data));
    assert.strictEqual(data.status, 'open', answerOf(data));

    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0011[\s\S]*?- status: open/);
  });

  it('200: leaves `closed` empty — open is not a closing status', async () => {
    const { root, server } = await setupServer({ backlog: statusBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0011/open', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.closed, undefined, answerOf(data));

    // The file keeps the "not closed" placeholder, and /api/board reports it empty.
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0011[\s\S]*?- closed: —/);
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    const task = board.tasks.find((t) => t.id === 'T-0011');
    assert.strictEqual(task.status, 'open');
    assert.strictEqual(task.closed, '');
    assert.strictEqual(task.created, '2026-01-01 00:00:00'); // `created` untouched too
  });

  for (const [status, id] of Object.entries(OPEN_FIXTURE_IDS)) {
    if (status === 'backlog') continue;
    it(`409: refuses a task in status "${status}" and leaves the file untouched`, async () => {
      const { root, server } = await setupServer({ backlog: statusBacklog() });
      const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

      const res = await fetch(server.baseUrl + `/api/task/${id}/open`, { method: 'POST' });
      const data = await readJson(res);

      assert.strictEqual(res.status, 409);
      assert.ok(data.error, answerOf(data));

      const after_ = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
      assert.strictEqual(after_, before);
    });
  }

  it('404: unknown task id, file untouched', async () => {
    const { root, server } = await setupServer({ backlog: statusBacklog() });
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-9999/open', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 404);
    assert.ok(data.error, answerOf(data));

    const after_ = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after_, before);
  });

  it('405: non-POST methods (GET) are rejected', async () => {
    const { server } = await setupServer({ backlog: statusBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0011/open', { method: 'GET' });

    assert.strictEqual(res.status, 405);
  });

  it('malformed id (does not match T-dddd) does not 500 or crash the process', async () => {
    const { server } = await setupServer({ backlog: statusBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/foo/open', { method: 'POST' });

    assert.notStrictEqual(res.status, 500);
    const board = await fetch(server.baseUrl + '/api/board');
    assert.strictEqual(board.status, 200, answerOf(board));
  });

  it('is not a generic "set status" endpoint: no other transition has a route', async () => {
    const { root, server } = await setupServer({ backlog: statusBacklog() });
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    // A status with no action of its own must be unroutable — the backlog file
    // may not change through any of them.
    for (const action of ['ready', 'in_progress', 'status']) {
      const res = await fetch(server.baseUrl + `/api/task/T-0011/${action}`, { method: 'POST' });
      await res.arrayBuffer(); // drain
      assert.strictEqual(res.status, 404, `POST /api/task/T-0011/${action} must not be routed`);
    }

    // `/backlog` is routed (T-0141) and is narrow in the same way: it accepts a
    // task that is ALREADY in `open` and nothing else, so on this one — which is
    // in `backlog` — it refuses and writes nothing.
    const backRes = await fetch(server.baseUrl + '/api/task/T-0011/backlog', { method: 'POST' });
    await backRes.arrayBuffer();
    assert.strictEqual(backRes.status, 409);

    // `/briefing` (T-0141) sets no status at all: it starts the briefing session
    // on a task already in `open`, so here it refuses too.
    const briefingRes = await fetch(server.baseUrl + '/api/task/T-0011/briefing', { method: 'POST' });
    await briefingRes.arrayBuffer();
    assert.strictEqual(briefingRes.status, 409);

    // `/review` is routed (T-0122) and is still not a way to set a status: it
    // starts the review session on a task ALREADY in review and writes nothing
    // at all, so on a task that is not there it refuses without touching the file.
    const reviewRes = await fetch(server.baseUrl + '/api/task/T-0011/review', { method: 'POST' });
    await reviewRes.arrayBuffer();
    assert.strictEqual(reviewRes.status, 409);

    // `/done` is routed too (T-0148) and is just as narrow: it accepts a task
    // that is ALREADY in review and nothing else, so here it refuses and the
    // file below is still byte-for-byte what it was.
    const doneRes = await fetch(server.baseUrl + '/api/task/T-0011/done', { method: 'POST' });
    await doneRes.arrayBuffer();
    assert.strictEqual(doneRes.status, 409);

    const after_ = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after_, before);
  });

  it('a second open on the now-open task 409s (the transition is not idempotent-by-accident)', async () => {
    const { server } = await setupServer({ backlog: statusBacklog() });

    const first = await fetch(server.baseUrl + '/api/task/T-0011/open', { method: 'POST' });
    await first.arrayBuffer();
    assert.strictEqual(first.status, 200);

    const second = await fetch(server.baseUrl + '/api/task/T-0011/open', { method: 'POST' });
    await second.arrayBuffer();
    assert.strictEqual(second.status, 409);
  });

  it('cancel still works alongside open (T-0017 regression)', async () => {
    const { root, server } = await setupServer({ backlog: statusBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0012/cancel', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'cancelled', answerOf(data));
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0012[\s\S]*?- status: cancelled/);
  });
});

// ---------- POST /api/task/:id/start ----------

// One task per lifecycle status again, plus the dependency cases: T-0023 waits
// for an in_progress prerequisite and for a task that does not exist, T-0024
// waits only for prerequisites that are already closed (done + cancelled, both
// of which count as satisfied).
const START_FIXTURE_IDS = {
  backlog: 'T-0011',
  open: 'T-0012',
  ready: 'T-0013',
  in_progress: 'T-0014',
  review: 'T-0015',
  done: 'T-0016',
  cancelled: 'T-0017',
};

function startBacklog() {
  const lines = ['# Backlog\n'];
  for (const [status, id] of Object.entries(START_FIXTURE_IDS)) {
    const closed = status === 'done' || status === 'cancelled' ? '2026-01-02 00:00:00' : '—';
    lines.push(
      `## ${id} · Major · Task in ${status}`,
      '- type: feature',
      `- status: ${status}`,
      '- created: 2026-01-01 00:00:00',
      `- closed: ${closed}`,
      '- briefs: ',
      ''
    );
  }
  lines.push(
    '## T-0023 · Major · Ready but blocked',
    '- type: feature',
    '- status: ready',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '- depends: T-0014, T-9998',
    '',
    '## T-0024 · Major · Ready with satisfied prerequisites',
    '- type: feature',
    '- status: ready',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '- depends: T-0016, T-0017',
    ''
  );
  return lines.join('\n');
}

describe('POST /api/task/:id/start', () => {
  it('200: moves a task from "ready" to "in_progress" and persists the change to disk', async () => {
    const { root, server } = await setupServer({ backlog: startBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0013/start', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(data.id, 'T-0013', answerOf(data));
    assert.strictEqual(data.status, 'in_progress', answerOf(data));
    // No command is configured in this fixture, so the transition stands alone.
    assert.strictEqual(data.session, 'disabled', answerOf(data));

    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0013[\s\S]*?- status: in_progress/);
  });

  it('200: leaves `closed` empty — in_progress is not a closing status', async () => {
    const { root, server } = await setupServer({ backlog: startBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0013/start', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.closed, undefined, answerOf(data));
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0013[\s\S]*?- closed: —/);
  });

  it('200: starts a ready task whose prerequisites are all closed (done/cancelled)', async () => {
    const { server } = await setupServer({ backlog: startBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0024/start', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'in_progress', answerOf(data));
  });

  for (const [status, id] of Object.entries(START_FIXTURE_IDS)) {
    if (status === 'ready') continue;
    it(`409: refuses a task in status "${status}" and leaves the file untouched`, async () => {
      const { root, server } = await setupServer({ backlog: startBacklog() });
      const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

      const res = await fetch(server.baseUrl + `/api/task/${id}/start`, { method: 'POST' });
      const data = await readJson(res);

      assert.strictEqual(res.status, 409);
      assert.ok(data.error, answerOf(data));

      const after_ = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
      assert.strictEqual(after_, before);
    });
  }

  it('409: a blocked task is not started, and the error names every blocker with its status', async () => {
    const { root, server } = await setupServer({ backlog: startBacklog() });
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-0023/start', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 409);
    assert.match(data.error, /T-0014 \(in_progress\)/, answerOf(data));
    assert.match(data.error, /T-9998 \(not found\)/); // an id no task carries also blocks

    const after_ = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.strictEqual(after_, before);
  });

  it('there is no --force counterpart: the request body cannot unblock a task', async () => {
    const { root, server } = await setupServer({ backlog: startBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0023/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    await res.arrayBuffer();

    assert.strictEqual(res.status, 409);
    const onDisk = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    assert.match(onDisk, /## T-0023[\s\S]*?- status: ready/);
  });

  it('404: unknown task id, file untouched', async () => {
    const { root, server } = await setupServer({ backlog: startBacklog() });
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');

    const res = await fetch(server.baseUrl + '/api/task/T-9999/start', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 404);
    assert.ok(data.error, answerOf(data));
    assert.strictEqual(fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8'), before);
  });

  it('405: non-POST methods (GET) are rejected', async () => {
    const { server } = await setupServer({ backlog: startBacklog() });

    const res = await fetch(server.baseUrl + '/api/task/T-0013/start', { method: 'GET' });

    assert.strictEqual(res.status, 405);
  });

  it('a second start on the now in_progress task 409s', async () => {
    const { server } = await setupServer({ backlog: startBacklog() });

    const first = await fetch(server.baseUrl + '/api/task/T-0013/start', { method: 'POST' });
    await first.arrayBuffer();
    assert.strictEqual(first.status, 200);

    const second = await fetch(server.baseUrl + '/api/task/T-0013/start', { method: 'POST' });
    await second.arrayBuffer();
    assert.strictEqual(second.status, 409);
  });

  it('the board reports the started task as in_progress and open/cancel still work', async () => {
    const { server } = await setupServer({ backlog: startBacklog() });

    await (await fetch(server.baseUrl + '/api/task/T-0013/start', { method: 'POST' })).arrayBuffer();
    const opened = await fetch(server.baseUrl + '/api/task/T-0011/open', { method: 'POST' });
    await opened.arrayBuffer();
    const cancelled = await fetch(server.baseUrl + '/api/task/T-0012/cancel', { method: 'POST' });
    await cancelled.arrayBuffer();

    assert.strictEqual(opened.status, 200);
    assert.strictEqual(cancelled.status, 200);
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    const byId = Object.fromEntries(board.tasks.map((t) => [t.id, t]));
    assert.strictEqual(byId['T-0013'].status, 'in_progress');
    assert.strictEqual(byId['T-0011'].status, 'open');
    assert.strictEqual(byId['T-0012'].status, 'cancelled');
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
      // Awaited: an async predicate hands back a promise, `!promise` is false,
      // and this loop would end before reading a single frame (T-0189).
      while (!(await predicate(buffer))) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`timed out waiting for SSE event; buffer so far: ${JSON.stringify(buffer)}`);
        }
        const { value, done } = await Promise.race([
          reader.read(),
          sleep(remaining).then(() => ({ done: true, value: undefined, timedOut: true })),
        ]);
        if (done) {
          if (await predicate(buffer)) return;
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
    assert.strictEqual(board.status, 200, answerOf(board));
  });
});
