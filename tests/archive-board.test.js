'use strict';

// The board half of the archive (T-0156). The rule it exists to prove: archiving
// takes nothing away from the human. Tokens are spent by what reaches an AGENT's
// context, and the board reads the files on the server — so `done` and
// `cancelled` go on being shown, from the archive, and the board never writes
// there.
//
// Runs against a real server process pointed at a throwaway AGENTBOARD_ROOT.

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { fetch } = require('./helpers/bounded.js');
const { startBoard } = require('./helpers/board.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

function task({ id, status = 'ready', title = 'A task', depends = '', closed = '—' }) {
  return [
    `## ${id} · Major · ${title}`,
    '- type: feature',
    `- status: ${status}`,
    '- created: 2026-01-01 00:00:00',
    `- closed: ${closed}`,
    '- briefs: ',
    ...(depends ? [`- depends: ${depends}`] : []),
    '',
    'Description.',
    '',
    '',
  ].join('\n');
}

const backlog = (tasks) => '# Backlog\n\n' + tasks.join('');

const activeServers = [];
const activeRoots = [];

async function setup(tasks, archived) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-archive-board-'));
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), backlog(tasks));
  if (archived) fs.writeFileSync(path.join(root, 'doc', 'backlog-archive.md'), backlog(archived));
  activeRoots.push(root);
  const server = await startBoard(root);
  activeServers.push(server);
  return {
    root,
    server,
    file: path.join(root, 'doc', 'backlog.md'),
    archiveFile: path.join(root, 'doc', 'backlog-archive.md'),
  };
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) fs.rmSync(activeRoots.pop(), { recursive: true, force: true });
});

async function boardOf(server) {
  const res = await fetch(server.baseUrl + '/api/board');
  return { body: await res.json(), etag: res.headers.get('etag') };
}

// The board's own JSON per task, keyed by id. Comparing this and not the array
// is the honest form of "nothing changed for the human": every column is sorted
// by the UI itself (sortTasks in ui/index.html), so the order /api/board happens
// to return is not what anyone sees.
const byId = (board) => Object.fromEntries(board.tasks.map((t) => [t.id, t]));

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, AGENTBOARD_ROOT: root },
    encoding: 'utf8',
  });
}

// The board reads the files on a change event; poll until it has caught up.
// Keyed on the ETag, not on the version: archiving changes both files without
// changing a single task, so the version is expected to stand still.
async function waitForBoard(server, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await boardOf(server);
    if (await predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`the board never caught up: ${JSON.stringify(last.body.tasks.map((t) => t.id))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('the board after archiving (T-0156)', () => {
  it('shows done and cancelled exactly as it did before', async () => {
    const { root, server } = await setup([
      task({ id: 'T-0001', status: 'done', closed: '2026-01-02 10:00:00' }),
      task({ id: 'T-0002', status: 'ready' }),
      task({ id: 'T-0003', status: 'cancelled', closed: '2026-01-03 10:00:00' }),
      task({ id: 'T-0004', status: 'done', closed: '2026-01-04 10:00:00', title: 'Another' }),
    ]);
    const before = await boardOf(server);

    const archived = runCli(root, ['archive']);
    assert.strictEqual(archived.status, 0, archived.stderr);

    const after = await waitForBoard(server, (b) => b.etag !== before.etag);
    assert.deepStrictEqual(byId(after.body), byId(before.body));
    assert.deepStrictEqual(
      after.body.tasks.filter((t) => t.status === 'done').map((t) => t.id),
      ['T-0001', 'T-0004']
    );
    // Not one task differs, so the delta protocol (T-0160) has nothing to send
    // and an open board does not even repaint. That is the criterion in its
    // sharpest form: for the human, archiving is a no-op.
    assert.strictEqual(after.body.version, before.body.version);
  });

  it('picks up a change to the archive file itself', async () => {
    const { server, archiveFile } = await setup(
      [task({ id: 'T-0002', status: 'ready' })],
      [task({ id: 'T-0001', status: 'done', closed: '2026-01-02 10:00:00' })]
    );
    const before = await boardOf(server);
    assert.deepStrictEqual(before.body.tasks.map((t) => t.id), ['T-0001', 'T-0002']);

    fs.appendFileSync(
      archiveFile,
      '\n' + task({ id: 'T-0009', status: 'cancelled', closed: '2026-01-05 10:00:00' })
    );

    const after = await waitForBoard(server, (b) => b.body.tasks.some((t) => t.id === 'T-0009'));
    assert.strictEqual(after.body.tasks.find((t) => t.id === 'T-0009').status, 'cancelled');
    assert.notStrictEqual(after.etag, before.etag, 'the ETag covers the archive as well');
  });

  it('serves a 304 while both files stand still', async () => {
    const { server } = await setup(
      [task({ id: 'T-0002', status: 'ready' })],
      [task({ id: 'T-0001', status: 'done' })]
    );
    const { etag } = await boardOf(server);

    const res = await fetch(server.baseUrl + '/api/board', { headers: { 'If-None-Match': etag } });
    assert.strictEqual(res.status, 304);
  });

  it('never writes to the archive', async () => {
    const { server, archiveFile } = await setup(
      [task({ id: 'T-0002', status: 'backlog' })],
      [task({ id: 'T-0001', status: 'done' })]
    );
    const before = fs.readFileSync(archiveFile, 'utf8');

    // An archived task is closed, so every narrow endpoint has to refuse it -
    // and refuse it as "not found", because the writable backlog is where they
    // look. This is the read-only guarantee, not a convention.
    for (const action of ['cancel', 'open', 'start', 'answer', 'profile', 'review']) {
      const res = await fetch(`${server.baseUrl}/api/task/T-0001/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'an answer', profile: '' }),
      });
      assert.strictEqual(res.status, 404, `${action} answered ${res.status}`);
    }

    // ...and a write that DOES succeed touches only the backlog.
    const opened = await fetch(`${server.baseUrl}/api/task/T-0002/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(opened.status, 200);
    assert.strictEqual(fs.readFileSync(archiveFile, 'utf8'), before);
  });

  it('treats an archived prerequisite as satisfied', async () => {
    const { server } = await setup(
      [task({ id: 'T-0002', status: 'ready', depends: 'T-0001' })],
      [task({ id: 'T-0001', status: 'done', closed: '2026-01-02 10:00:00' })]
    );

    const { body } = await boardOf(server);
    assert.deepStrictEqual(body.tasks.find((t) => t.id === 'T-0002').blockedBy, []);

    const started = await fetch(`${server.baseUrl}/api/task/T-0002/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(started.status, 200);
  });

  it('still blocks on a prerequisite that is in neither file', async () => {
    const { server } = await setup(
      [task({ id: 'T-0002', status: 'ready', depends: 'T-0404' })],
      [task({ id: 'T-0001', status: 'done' })]
    );

    const { body } = await boardOf(server);
    assert.deepStrictEqual(body.tasks.find((t) => t.id === 'T-0002').blockedBy, ['T-0404']);
  });
});
