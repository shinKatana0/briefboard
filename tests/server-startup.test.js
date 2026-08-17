'use strict';

// Start-up behaviour of server/server.js: which port it binds, what it prints,
// and the project name it reports (T-0078).
// Run with: npm test  (or: node --test tests/**/*.test.js)
//
// The port is the subject here, so this file is one of the few that still names
// one: an explicitly requested port has to be honoured, an occupied one
// refused. Every test that only needs a running board lets the server choose
// instead (T-0123).

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch, waitForExit, stopProcess } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { HOST, SERVER_PATH, freePort, occupyPort, waitForBanner } = require('./helpers/board.js');
const { AUTO_PORT_VALUE, DEFAULT_PORT, FALLBACK_ATTEMPTS } = require('../server/listen.js');

const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

// A project root named `name`, so path.basename(PROJECT) is under test control.
function makeProjectRoot(name) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-startup-test-'));
  cleanups.push(async () => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), '# Backlog\n');
  return root;
}

async function occupyFreePort() {
  const { port, close } = await occupyPort();
  cleanups.push(close);
  return port;
}

// Holds `port` on HOST until the caller closes it, or null when the bind fails
// — which is how a port somebody else already holds answers.
function occupyOn(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, HOST, () => resolve(() => new Promise((done) => server.close(done))));
  });
}

// Spawns the real server and collects its output. `waitForExit()` resolves with
// { code, stdout, stderr } once the process is gone; `ready()` waits for the
// start-up banner instead, for the runs that are expected to stay up. The
// helpers' startBoard() is no use here: half of these servers are meant to die
// on start-up, which is the one thing it turns into an error.
// The watchdog is off for the same reason startBoard() turns it off (T-0159):
// it runs git against the project on its own, and a git process holds that
// directory as its cwd — which on Windows is enough to make the rmSync above
// fail with EPERM. The port and the banner are what this file is about.
function spawnServer(root, env = {}) {
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      AGENTBOARD_ROOT: root,
      PORT: AUTO_PORT_VALUE,
      BRIEFBOARD_NAME: '',
      BRIEFBOARD_WATCHDOG_MS: 'off',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (c) => (stdout += c.toString()));
  proc.stderr.on('data', (c) => (stderr += c.toString()));
  cleanups.push(() => stopProcess(proc));

  return {
    proc,
    out: () => ({ stdout, stderr }),
    async waitForExit() {
      const code = await waitForExit(proc);
      return { code, stdout, stderr };
    },
    ready: (timeoutMs) => waitForBanner(proc, () => ({ stdout, stderr }), timeoutMs),
  };
}

// The errno a bind really produces, or null when the address is free.
function bindErrorCode(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen(port, host);
  });
}

async function boardJson(port) {
  const res = await fetch(`http://${HOST}:${port}/api/board`);
  assert.strictEqual(res.status, 200);
  return readJson(res);
}

// ---------- project name ----------

describe('project name in /api/board', () => {
  it('defaults to the project folder name', async () => {
    const root = makeProjectRoot('demo-project');
    const port = await spawnServer(root).ready();

    const board = await boardJson(port);
    assert.deepStrictEqual(board.project, { name: 'demo-project' });
  });

  it('is overridden by BRIEFBOARD_NAME', async () => {
    const root = makeProjectRoot('demo-project');
    const port = await spawnServer(root, {
      BRIEFBOARD_NAME: 'Payments API',
    }).ready();

    const board = await boardJson(port);
    assert.strictEqual(board.project.name, 'Payments API');
  });

  it('is capped at 60 characters and kept on one line (it becomes a tab title)', async () => {
    const root = makeProjectRoot('demo-project');
    const port = await spawnServer(root, {
      BRIEFBOARD_NAME: 'x'.repeat(80) + '\nsecond line',
    }).ready();

    const board = await boardJson(port);
    assert.strictEqual(board.project.name, 'x'.repeat(60));
  });

  it('cuts an over-long name by code point, never through a surrogate pair', async () => {
    const root = makeProjectRoot('demo-project');
    const port = await spawnServer(root, {
      // 70 emoji: over the cap, and every one of them two UTF-16 units wide.
      BRIEFBOARD_NAME: '🙂'.repeat(70),
    }).ready();

    const board = await boardJson(port);
    assert.strictEqual(board.project.name, '🙂'.repeat(60));
    assert.strictEqual([...board.project.name].length, 60, 'the cap counts code points');
  });

  it('passes a name containing HTML through as data (escaping is the UI\'s job, via textContent)', async () => {
    const root = makeProjectRoot('demo-project');
    const hostile = '<img src=x onerror=alert(1)>';
    const port = await spawnServer(root, {
      BRIEFBOARD_NAME: hostile,
    }).ready();

    const board = await boardJson(port);
    assert.strictEqual(board.project.name, hostile);
  });

  it('survives the board cache: the name is present on a re-read of an unchanged backlog', async () => {
    const root = makeProjectRoot('cached-project');
    const port = await spawnServer(root).ready();

    // The second request is served from the mtime-keyed cache built by the first.
    await boardJson(port);
    const board = await boardJson(port);
    assert.strictEqual(board.project.name, 'cached-project');
  });
});

// ---------- port selection ----------

describe('port selection', () => {
  it('prints the port it actually bound, and serves there', async () => {
    const root = makeProjectRoot('demo-project');
    const requested = await freePort();
    const server = spawnServer(root, { PORT: String(requested) });
    const printed = await server.ready();

    assert.strictEqual(printed, requested);
    const board = await boardJson(printed);
    assert.deepStrictEqual(board.tasks, []);
    assert.match(server.out().stdout, new RegExp(`bound: +${HOST}:${requested}`));
  });

  it('exits with an error when an explicitly requested port is taken, and binds nothing else', async () => {
    const root = makeProjectRoot('demo-project');
    const taken = await occupyFreePort();

    const server = spawnServer(root, { PORT: String(taken) });
    const { code, stdout, stderr } = await server.waitForExit();

    assert.notStrictEqual(code, 0);
    assert.match(stderr, new RegExp(`port ${taken} is already in use`));
    assert.match(stderr, /set explicitly/);
    // No start-up banner means it never bound a substitute port.
    assert.doesNotMatch(stdout, /briefboard: http:\/\//);
  });

  it('refuses a PORT that is not a port number instead of binding a random one', async () => {
    const root = makeProjectRoot('demo-project');
    for (const value of ['abc', '0']) {
      const server = spawnServer(root, { PORT: value });
      const { code, stdout, stderr } = await server.waitForExit();

      assert.notStrictEqual(code, 0, `PORT=${value} must not start a board`);
      assert.match(stderr, /invalid port/);
      assert.doesNotMatch(stdout, /briefboard: http:\/\//);
    }
  });

  // The suite's own way of starting a board (tests/helpers/board.js): it needs a
  // working port, not a memorable one, and asking for the human range is what
  // killed four boards when four suites ran at once (T-0139). Proved by taking
  // the whole range away — a board that still starts is a board that does not
  // depend on it.
  it('starts on a kernel-given port with PORT=auto, even with 4571-4590 all taken', async () => {
    const root = makeProjectRoot('demo-project');
    const range = [];
    for (let p = DEFAULT_PORT; p < DEFAULT_PORT + FALLBACK_ATTEMPTS; p++) range.push(p);
    // A port this machine already refuses (a developer's own board on 4571) is
    // as unavailable to the server as one held here, so a failed hold is fine.
    for (const port of range) {
      const held = await occupyOn(port);
      if (held) cleanups.push(held);
    }

    const server = spawnServer(root, { PORT: AUTO_PORT_VALUE });
    const printed = await server.ready();

    assert.ok(!range.includes(printed), `the board must not sit in the human range: got ${printed}`);
    assert.match(server.out().stdout, new RegExp(`bound: +${HOST}:${printed}`));
    const board = await boardJson(printed);
    assert.deepStrictEqual(board.tasks, [], 'and it is this board that answers there');
  });

  // A public bind serves localhost from sockets of its own (T-0133) — the one
  // assertion no unit test can make, because it is the wiring between
  // listenWithFallback and the running process that carries it.
  //
  // The port being free afterwards is asserted as the end state a user sees,
  // not as a check on the exit path: measured on Windows 11, a board whose
  // stopBoard() closes only the main socket leaves the port just as free,
  // because the kernel drops every listener when the process goes.
  it('holds localhost while it is up and leaves the port free when it exits', async () => {
    const root = makeProjectRoot('demo-project');
    const port = await freePort();
    const server = spawnServer(root, { HOST: '0.0.0.0', PORT: String(port) });
    await server.ready();

    assert.strictEqual(
      await bindErrorCode(port, HOST),
      'EADDRINUSE',
      'localhost must belong to the board, not to whoever asks for it next'
    );
    const board = await boardJson(port);
    assert.deepStrictEqual(board.tasks, [], 'and it is this board that answers there');

    const res = await fetch(`http://${HOST}:${port}/api/shutdown`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    await readJson(res);
    assert.strictEqual((await server.waitForExit()).code, 0);

    for (const host of [HOST, '0.0.0.0']) {
      assert.strictEqual(await bindErrorCode(port, host), null, `${host}:${port} must be free again`);
    }
  });

  it('names the project in the start-up output', async () => {
    const root = makeProjectRoot('demo-project');
    const server = spawnServer(root, { BRIEFBOARD_NAME: 'Payments API' });
    await server.ready();

    assert.match(server.out().stdout, /project: +Payments API/);
  });
});
