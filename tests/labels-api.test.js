'use strict';

// Integration tests for POST /api/task/:id/labels (T-0279): the one endpoint
// that writes the `labels` field, and nothing else. Each test spawns a real
// `node server/server.js` against a throwaway AGENTBOARD_ROOT, so the real
// project's doc/ files are never touched.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
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
const { removeTree } = require('./helpers/rm.js');
const { parseBacklog, MAX_LABEL_LEN, MAX_LABELS } = require('../server/parser.js');
const { tempDir } = require('./helpers/tmp.js');

// T-0011 carries labels already, T-0012 none, T-0013 is finished long ago —
// the status this endpoint accepts and /profile does not.
function sampleBacklog() {
  return [
    '# Backlog\n',
    '## T-0011 · Major · Labelled task',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '- labels: ui, docs',
    '',
    'Classified already.',
    '',
    '## T-0012 · Major · No labels of its own',
    '- type: feature',
    '- status: in_progress',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
    'Unclassified.',
    '',
    '## T-0013 · Major · Finished long ago',
    '- type: feature',
    '- status: done',
    '- created: 2026-01-01 00:00:00',
    '- closed: 2026-01-02 00:00:00',
    '- briefs: ',
    '',
    'Done.',
    '',
  ].join('\n');
}

// The archive is read-only, and this endpoint reads doc/backlog.md alone.
function sampleArchive() {
  return [
    '# Archive\n',
    '## T-0009 · Major · Archived task',
    '- type: feature',
    '- status: done',
    '- created: 2025-01-01 00:00:00',
    '- closed: 2025-01-02 00:00:00',
    '- briefs: ',
    '',
    'Gone to the archive.',
    '',
  ].join('\n');
}

function makeFixtureRoot() {
  const root = tempDir('briefboard-labels-test-');
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), sampleBacklog());
  fs.writeFileSync(path.join(root, 'doc', 'backlog-archive.md'), sampleArchive());
  return root;
}

function backlogText(root) {
  return fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
}

function readTask(root, id) {
  return parseBacklog(backlogText(root)).find((t) => t.id === id);
}

const activeServers = [];
const activeRoots = [];

async function setup(extraEnv = {}) {
  const root = makeFixtureRoot();
  activeRoots.push(root);
  const server = await startBoard(root, extraEnv);
  activeServers.push(server);
  return { root, server };
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) await removeTree(activeRoots.pop());
});

function setLabels(server, id, body, { raw, headers = {}, method = 'POST' } = {}) {
  return fetch(server.baseUrl + `/api/task/${id}/labels`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'POST' ? (raw === undefined ? JSON.stringify(body) : raw) : undefined,
  });
}

// =====================================================================
// writing the field
// =====================================================================
describe('POST /api/task/:id/labels — one field, nothing else', () => {
  it('200 and the whole list lands in the file, after the briefs line', async () => {
    const { root, server } = await setup();
    const res = await setLabels(server, 'T-0012', { labels: ['ui', 'docs'] });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200, answerOf(res));
    assert.deepStrictEqual(data, { ok: true, id: 'T-0012', labels: ['ui', 'docs'] });
    assert.deepStrictEqual(readTask(root, 'T-0012').labels, ['ui', 'docs']);
    assert.match(backlogText(root), /^- briefs: \s*\n- labels: ui, docs$/m, backlogText(root));
  });

  it('replaces the list rather than adding to it', async () => {
    const { root, server } = await setup();
    await setLabels(server, 'T-0011', { labels: ['api'] });
    assert.deepStrictEqual(readTask(root, 'T-0011').labels, ['api']);
  });

  it('the status, the closing date and the description are left exactly as they were', async () => {
    const { root, server } = await setup();
    await setLabels(server, 'T-0012', { labels: ['ui'] });
    const task = readTask(root, 'T-0012');
    assert.strictEqual(task.status, 'in_progress');
    assert.strictEqual(task.closed, '');
    assert.strictEqual(task.description, 'Unclassified.');
  });

  it('an empty list clears the field, and the line goes with it', async () => {
    const { root, server } = await setup();
    const res = await setLabels(server, 'T-0011', { labels: [] });
    assert.strictEqual(res.status, 200, answerOf(res));
    assert.deepStrictEqual(readTask(root, 'T-0011').labels, []);
    assert.ok(!backlogText(root).includes('- labels:'), backlogText(root));
  });

  it('an absent list means the empty one, as it does on /profile', async () => {
    const { root, server } = await setup();
    const res = await setLabels(server, 'T-0011', {});
    assert.strictEqual(res.status, 200, answerOf(res));
    assert.deepStrictEqual(readTask(root, 'T-0011').labels, []);
  });

  // The deliberate difference from /profile (PROFILE_STATUSES stops at review):
  // a closed task is exactly what someone filters by label in a report.
  it('a task in done is labelled all the same, and stays done', async () => {
    const { root, server } = await setup();
    const res = await setLabels(server, 'T-0013', { labels: ['release-0.3'] });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200, answerOf(res));
    assert.deepStrictEqual(data.labels, ['release-0.3']);
    const task = readTask(root, 'T-0013');
    assert.strictEqual(task.status, 'done');
    assert.strictEqual(task.closed, '2026-01-02 00:00:00');
  });

  it('no session is started by the write', async () => {
    const { root, server } = await setup();
    const res = await setLabels(server, 'T-0012', { labels: ['ui'] });
    const data = await readJson(res);
    assert.strictEqual(res.status, 200, answerOf(res));
    assert.ok(!('session' in data), `the answer speaks of a session: ${JSON.stringify(data)}`);
    assert.ok(
      !fs.existsSync(path.join(root, '.briefboard', 'sessions')),
      'a session directory was created'
    );
  });
});

// =====================================================================
// what it refuses
// =====================================================================
describe('POST /api/task/:id/labels — refusals leave the file untouched', () => {
  const REFUSED = {
    'a bare string instead of a list': { labels: 'ui,docs' },
    'a number in the list': { labels: ['ui', 7] },
    'a name carrying the list separator': { labels: ['ui,docs'] },
    'a name carrying a line break': { labels: ['ui\ndocs'] },
    'a name over the length cap': { labels: ['y'.repeat(MAX_LABEL_LEN + 1)] },
    'more names than a card can hold': {
      labels: Array.from({ length: MAX_LABELS + 1 }, (_, i) => 'l' + i),
    },
  };

  for (const [name, body] of Object.entries(REFUSED)) {
    it(`${name}: 400, and nothing is written`, async () => {
      const { root, server } = await setup();
      const before = backlogText(root);
      const res = await setLabels(server, 'T-0012', body);
      assert.strictEqual(res.status, 400, answerOf(res));
      assert.strictEqual(backlogText(root), before);
    });
  }

  it('the refusal names what is wrong, not just that something is', async () => {
    const { server } = await setup();
    const long = 'y'.repeat(MAX_LABEL_LEN + 1);
    const data = await readJson(await setLabels(server, 'T-0012', { labels: [long] }));
    assert.match(data.error, new RegExp(String(MAX_LABEL_LEN)));
  });

  it('a duplicate is collapsed rather than refused, keeping the first occurrence', async () => {
    const { root, server } = await setup();
    const res = await setLabels(server, 'T-0012', { labels: ['ui', 'docs', 'ui'] });
    const data = await readJson(res);
    assert.strictEqual(res.status, 200, answerOf(res));
    assert.deepStrictEqual(data.labels, ['ui', 'docs']);
    assert.deepStrictEqual(readTask(root, 'T-0012').labels, ['ui', 'docs']);
  });

  it('names are compared as written: ui and UI are two labels', async () => {
    const { root, server } = await setup();
    await setLabels(server, 'T-0012', { labels: ['ui', 'UI'] });
    assert.deepStrictEqual(readTask(root, 'T-0012').labels, ['ui', 'UI']);
  });

  it('a task that does not exist is a 404', async () => {
    const { server } = await setup();
    const res = await setLabels(server, 'T-9999', { labels: ['ui'] });
    assert.strictEqual(res.status, 404, answerOf(res));
  });

  it('an archived task is a 404 too — the endpoint reads doc/backlog.md alone', async () => {
    const { root, server } = await setup();
    const archive = path.join(root, 'doc', 'backlog-archive.md');
    const before = fs.readFileSync(archive, 'utf8');
    const res = await setLabels(server, 'T-0009', { labels: ['ui'] });
    assert.strictEqual(res.status, 404, answerOf(res));
    assert.strictEqual(fs.readFileSync(archive, 'utf8'), before, 'the archive was written to');
  });

  it('GET is not allowed, and a cross-origin POST is rejected before the write', async () => {
    const { root, server } = await setup();
    const before = backlogText(root);
    assert.strictEqual((await setLabels(server, 'T-0012', {}, { method: 'GET' })).status, 405);
    const cross = await setLabels(
      server,
      'T-0012',
      { labels: ['ui'] },
      { headers: { Origin: 'http://evil.example' } }
    );
    assert.strictEqual(cross.status, 403, answerOf(cross));
    assert.strictEqual(backlogText(root), before);
  });

  it('a form-encoded body is refused with 415 (the second CSRF barrier)', async () => {
    const { server } = await setup();
    const res = await setLabels(
      server,
      'T-0012',
      { labels: ['ui'] },
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    assert.strictEqual(res.status, 415, answerOf(res));
  });
});

// =====================================================================
// what the board is told
// =====================================================================
describe('/api/board carries the labels', () => {
  it('for a live task and for an archived one alike', async () => {
    const { server } = await setup();
    await setLabels(server, 'T-0012', { labels: ['ui'] });
    const data = await readJson(await fetch(server.baseUrl + '/api/board'));
    const byId = new Map(data.tasks.map((t) => [t.id, t]));
    assert.deepStrictEqual(byId.get('T-0012').labels, ['ui']);
    assert.deepStrictEqual(byId.get('T-0011').labels, ['ui', 'docs']);
    assert.deepStrictEqual(byId.get('T-0009').labels, [], 'the archived task is merged in too');
  });
});
