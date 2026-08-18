'use strict';

// The server half of the delta protocol (T-0160): /events carries what changed,
// so an open board no longer pulls the whole list back on every edit — 4.3 MB
// per status change, measured on a 978-task backlog.
//
// Runs against a real server process pointed at a throwaway AGENTBOARD_ROOT.

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fetch } = require('./helpers/bounded.js');
const { startBoard } = require('./helpers/board.js');
const { SPAWN_WAIT_BUDGET_MS } = require('./helpers/wait.js');
const { tempDir } = require('./helpers/tmp.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function task({ id, status = 'ready', title = 'A task', depends = '' }) {
  return [
    `## ${id} · Major · ${title}`,
    '- type: feature',
    `- status: ${status}`,
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    ...(depends ? [`- depends: ${depends}`] : []),
    '',
    'Description.',
    '',
  ].join('\n');
}

function backlog(tasks) {
  return '# Backlog\n\n' + tasks.join('');
}

const activeServers = [];
const activeRoots = [];

async function setup(text) {
  const root = tempDir('briefboard-delta-test-');
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), text);
  activeRoots.push(root);
  const server = await startBoard(root);
  activeServers.push(server);
  return { root, server, file: path.join(root, 'doc', 'backlog.md') };
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) fs.rmSync(activeRoots.pop(), { recursive: true, force: true });
});

// An SSE connection that keeps the parsed board frames, in arrival order.
async function openSse(baseUrl) {
  const res = await fetch(baseUrl + '/events');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  function harvest() {
    for (const m of buffer.matchAll(/^data: changed (\{.*)$/gm)) frames.push(JSON.parse(m[1]));
    buffer = '';
  }
  // Every caller here waits for a frame that must arrive, so this deadline only
  // decides whether a missing frame fails the test or hangs it. What it waits
  // out is an fs.watch event, the board's 150ms debounce and the machine getting
  // round to both — the same external circumstance as every other wait in the
  // suite, and measured at p50 1.1 s / max 2.9 s over 40 frames under four
  // concurrent suites. The 5 s it used to be was 1.7x that and it fired in 2 of
  // 4 loaded runs in T-0225's measurement; the shared budget is 10x (T-0223).
  async function next(timeoutMs = SPAWN_WAIT_BUDGET_MS) {
    const deadline = Date.now() + timeoutMs;
    const seen = frames.length;
    while (frames.length === seen) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for a board frame');
      const { value, done } = await Promise.race([
        reader.read(),
        sleep(remaining).then(() => ({ done: true, value: undefined })),
      ]);
      if (done && value === undefined) continue;
      buffer += decoder.decode(value, { stream: true });
      harvest();
    }
    return frames[frames.length - 1];
  }
  return { frames, next, close: () => reader.cancel().catch(() => {}) };
}

async function boardOf(server) {
  const res = await fetch(server.baseUrl + '/api/board');
  return { body: await res.json(), bytes: Number(res.headers.get('content-length') || 0) };
}

function setStatus(file, id, status) {
  const text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf(`## ${id} ·`);
  const from = text.indexOf('- status: ', at);
  const to = text.indexOf('\n', from);
  fs.writeFileSync(file, text.slice(0, from) + `- status: ${status}` + text.slice(to));
}

// =====================================================================
describe('/api/board versioning (T-0160)', () => {
  it('reports a version, and raises it only when the content really changed', async () => {
    const { server, file } = await setup(backlog([task({ id: 'T-0001' })]));
    const first = await boardOf(server);
    assert.strictEqual(typeof first.body.version, 'number');

    // Rewritten byte for byte: a new mtime, the same board.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n');
    const same = await boardOf(server);
    assert.strictEqual(same.body.version, first.body.version);

    setStatus(file, 'T-0001', 'in_progress');
    const changed = await boardOf(server);
    assert.strictEqual(changed.body.version, first.body.version + 1);
  });
});

// =====================================================================
describe('/events board deltas (T-0160)', () => {
  it('names the one task that changed instead of asking for the whole list', async () => {
    const { server, file } = await setup(
      backlog([task({ id: 'T-0001' }), task({ id: 'T-0002' }), task({ id: 'T-0003' })])
    );
    const before = await boardOf(server);
    const sse = await openSse(server.baseUrl);
    try {
      setStatus(file, 'T-0002', 'in_progress');
      const frame = await sse.next();
      assert.strictEqual(frame.base, before.body.version);
      assert.strictEqual(frame.v, before.body.version + 1);
      assert.deepStrictEqual(
        frame.tasks.map((t) => t.id),
        ['T-0002']
      );
      assert.strictEqual(frame.tasks[0].status, 'in_progress');
      assert.deepStrictEqual(frame.removed, []);
      // The point of the exercise: the frame is a fraction of the board it
      // spares the client from re-reading.
      assert.ok(
        JSON.stringify(frame).length * 3 < JSON.stringify(before.body).length,
        'the delta must be far smaller than the full board'
      );
    } finally {
      await sse.close();
    }
  });

  it('carries an added task, and names a vanished one as removed', async () => {
    const { server, file } = await setup(backlog([task({ id: 'T-0001' }), task({ id: 'T-0002' })]));
    await boardOf(server);
    const sse = await openSse(server.baseUrl);
    try {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + task({ id: 'T-0003', title: 'New' }));
      const added = await sse.next();
      assert.deepStrictEqual(
        added.tasks.map((t) => t.id),
        ['T-0003']
      );
      assert.deepStrictEqual(added.removed, []);

      fs.writeFileSync(file, backlog([task({ id: 'T-0001' })]));
      const gone = await sse.next();
      assert.deepStrictEqual(gone.removed.sort(), ['T-0002', 'T-0003']);
      assert.deepStrictEqual(gone.tasks, []);
      assert.strictEqual(gone.base, added.v);
    } finally {
      await sse.close();
    }
  });

  it('includes a task whose derived state changed although its own text did not', async () => {
    const { server, file } = await setup(
      backlog([task({ id: 'T-0001', depends: 'T-0002' }), task({ id: 'T-0002', status: 'ready' })])
    );
    const before = await boardOf(server);
    assert.deepStrictEqual(before.body.tasks.find((t) => t.id === 'T-0001').blockedBy, ['T-0002']);
    const sse = await openSse(server.baseUrl);
    try {
      setStatus(file, 'T-0002', 'done');
      const frame = await sse.next();
      const ids = frame.tasks.map((t) => t.id).sort();
      assert.deepStrictEqual(ids, ['T-0001', 'T-0002'], 'the freed dependant travels with the edit');
      assert.deepStrictEqual(frame.tasks.find((t) => t.id === 'T-0001').blockedBy, []);
    } finally {
      await sse.close();
    }
  });

  it('asks for a full reload instead of sending a delta the size of the board', async () => {
    const many = [];
    for (let i = 1; i <= 60; i++) many.push(task({ id: `T-${String(i).padStart(4, '0')}` }));
    const { server, file } = await setup(backlog(many));
    await boardOf(server);
    const sse = await openSse(server.baseUrl);
    try {
      fs.writeFileSync(file, backlog(many.map((t) => t.replace('- status: ready', '- status: open'))));
      const frame = await sse.next();
      assert.strictEqual(frame.full, true);
      assert.strictEqual(frame.tasks, undefined);
    } finally {
      await sse.close();
    }
  });

  it('sends a frame that applies to nothing when only a brief file changed', async () => {
    const { root, server } = await setup(backlog([task({ id: 'T-0001' })]));
    const version = (await boardOf(server)).body.version;
    const sse = await openSse(server.baseUrl);
    try {
      fs.writeFileSync(path.join(root, 'doc', 'brief', 'T-0001-01-x.md'), '# brief\n');
      const frame = await sse.next();
      assert.strictEqual(frame.base, version);
      assert.strictEqual(frame.v, version, 'the board did not change, so neither did its version');
      assert.deepStrictEqual(frame.tasks, []);
    } finally {
      await sse.close();
    }
  });

  it('forces a reload, with no version to match, when the backlog becomes unreadable', async () => {
    const { server, file } = await setup(backlog([task({ id: 'T-0001' })]));
    await boardOf(server);
    const sse = await openSse(server.baseUrl);
    try {
      fs.rmSync(file);
      const frame = await sse.next();
      assert.strictEqual(frame.full, true);
      assert.strictEqual(frame.v, undefined);
    } finally {
      await sse.close();
    }
  });

  it('chains: every frame starts where the previous one ended', async () => {
    const { server, file } = await setup(backlog([task({ id: 'T-0001' }), task({ id: 'T-0002' })]));
    await boardOf(server);
    const sse = await openSse(server.baseUrl);
    try {
      const statuses = ['open', 'ready', 'in_progress'];
      let previous = null;
      for (const status of statuses) {
        setStatus(file, 'T-0001', status);
        const frame = await sse.next();
        if (previous) assert.strictEqual(frame.base, previous.v, 'no gap between frames');
        assert.strictEqual(frame.tasks[0].status, status);
        previous = frame;
      }
    } finally {
      await sse.close();
    }
  });
});
