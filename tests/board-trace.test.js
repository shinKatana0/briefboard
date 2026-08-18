'use strict';

// The mark a running board leaves for other processes (T-0186), and the one
// thing it must never do: lie. A board killed hard cannot remove its own file,
// so the file is only ever a claim — every reader checks the pid is alive, the
// way reconcileSession() checks a session's board.
//
// Half of this runs against a real board process, because the write happens in
// server.js's listen callback and the removal on its exit path; the unit half
// injects the liveness check, which is the only way to describe a dead pid
// without waiting for one.
//
// Run with: npm test  (or: node --test tests/board-trace.test.js)

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { fetch, waitForExit } = require('./helpers/bounded.js');
const { readJson } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { REGISTRY_FILE, REGISTRY_VERSION } = require('../server/sessions.js');
const { tempDir } = require('./helpers/tmp.js');
const {
  TRACE_SINCE,
  traceDirFor,
  tracePathFor,
  writeBoardTrace,
  removeBoardTrace,
  readBoardTraces,
  sweepBoardTraces,
} = require('../server/trace.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');
const ROOT = path.join(__dirname, '..');

const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function closedTask(id) {
  return [
    `## ${id} · Major · A closed task`,
    '- type: feature',
    '- status: done',
    '- created: 2026-01-01 00:00:00',
    '- closed: 2026-01-02 00:00:00',
    '- briefs: ',
    '',
    'Description.',
    '',
    '',
  ].join('\n');
}

function makeProject(tasks = []) {
  const root = tempDir('briefboard-trace-test-');
  cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), '# Backlog\n\n' + tasks.join(''));
  return root;
}

async function board(root) {
  const server = await startBoard(root);
  cleanups.push(() => server.stop());
  return server;
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, AGENTBOARD_ROOT: root },
    encoding: 'utf8',
  });
}

// A pid that certainly belonged to a process and certainly does not now — the
// state a hard-killed board leaves its trace in.
function deadPid() {
  const done = spawnSync(process.execPath, ['-e', '']);
  return done.pid;
}

const traceFiles = (root) => {
  try {
    return fs.readdirSync(traceDirFor(root)).sort();
  } catch {
    return [];
  }
};

function writeRawTrace(root, pid, data) {
  const file = tracePathFor(root, pid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

describe('a running board leaves a trace (T-0186)', () => {
  it('writes it at listen, with the port it actually bound, and says so in the banner', async () => {
    const root = makeProject();
    const server = await board(root);

    const file = tracePathFor(root, server.proc.pid);
    assert.deepStrictEqual(traceFiles(root), [`${server.proc.pid}.json`]);
    const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(trace.pid, server.proc.pid);
    assert.strictEqual(trace.port, server.port, 'the port in the trace is the one serving');
    assert.strictEqual(trace.project, root);
    assert.strictEqual(trace.version, require('../package.json').version);
    assert.ok(Date.parse(trace.startedAt) > 0, `startedAt must be a timestamp: ${trace.startedAt}`);
    assert.match(server.getStdout(), new RegExp(`trace: +${file.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')}`));
  });

  it('removes it when the board is asked to stop', async () => {
    const root = makeProject();
    const server = await board(root);
    assert.strictEqual(traceFiles(root).length, 1);

    const res = await fetch(`${server.baseUrl}/api/shutdown`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    await readJson(res);
    assert.strictEqual(await waitForExit(server.proc), 0);

    assert.deepStrictEqual(traceFiles(root), [], 'a board that stopped leaves nothing claiming it runs');
  });

  // The criterion the whole design turns on. A board killed hard never runs its
  // exit path, so the file stays — and nobody reading it may conclude a board is
  // there.
  it('cannot make a reader claim a board is running after it was killed hard', async () => {
    const root = makeProject([closedTask('T-0001')]);
    const server = await board(root);
    const file = tracePathFor(root, server.proc.pid);

    server.proc.kill('SIGKILL');
    await waitForExit(server.proc);

    assert.ok(fs.existsSync(file), 'the file outlives the process — that is the whole problem');
    const { boards } = readBoardTraces(root);
    assert.strictEqual(boards.length, 1);
    assert.strictEqual(boards[0].pid, server.proc.pid);
    assert.strictEqual(boards[0].alive, false, 'the pid is dead, so the trace proves nothing');

    const archived = runCli(root, ['archive']);
    assert.strictEqual(archived.status, 0, archived.stderr);
    assert.match(archived.stderr, /no board is running for this project/);
    assert.doesNotMatch(archived.stderr, /WARNING: a board is running/);
  });

  it('is what `archive` names when a board really is up', async () => {
    const root = makeProject([closedTask('T-0001')]);
    const server = await board(root);

    const archived = runCli(root, ['archive']);

    assert.strictEqual(archived.status, 0, archived.stderr);
    assert.match(
      archived.stderr,
      new RegExp(`WARNING: a board is running for this project: pid ${server.proc.pid} on [^\\s]+:${server.port}`)
    );
    assert.match(archived.stderr, /briefboard \d+\.\d+\.\d+/, 'and which version it was started from');
    assert.doesNotMatch(archived.stderr, /no board is running/);
  });

  // Two boards on one project is why the trace is a file per pid: a single file
  // would let the second to start erase the first from the record.
  it('is one file per board, and a starting board sweeps only the dead ones', async () => {
    const root = makeProject();
    const first = await board(root);
    const gone = deadPid();
    const stale = writeRawTrace(root, gone, { trace: 1, pid: gone, port: 4571 });

    const second = await board(root);

    assert.strictEqual(fs.existsSync(stale), false, 'the dead board\'s file is swept');
    assert.deepStrictEqual(
      traceFiles(root).sort(),
      [`${first.proc.pid}.json`, `${second.proc.pid}.json`].sort(),
      'and both live boards are still on the record'
    );
  });
});

// T-0196: the trace existed for a year of commits and exactly one reader — the
// warning `archive` prints. This is the reader a human has: "where is my board",
// asked when the tab is lost or there are several, and unanswerable otherwise
// because PORT=auto makes the port unguessable.
describe('`board` says where the board is (T-0196)', () => {
  const strays = [];

  afterEach(() => {
    for (const child of strays.splice(0)) child.kill();
  });

  // A process that is alive and is not a board: what a session record pointing
  // at a pre-trace board looks like from outside.
  function liveStranger() {
    const child = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], {
      stdio: 'ignore',
    });
    strays.push(child);
    return child.pid;
  }

  function writeRegistry(root, sessions) {
    const dir = path.join(root, '.briefboard', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, REGISTRY_FILE),
      JSON.stringify({ version: REGISTRY_VERSION, sessions })
    );
  }

  const boardLine = (text) => (text.split(/\r?\n/).find((l) => /a board is running/.test(l)) || '');

  it('names the pid, the address it bound, the version and the file it read', async () => {
    const root = makeProject();
    const server = await board(root);

    const res = runCli(root, ['board']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(
      res.stdout,
      new RegExp(`a board is running for this project: pid ${server.proc.pid} on [^\\s]+:${server.port}`)
    );
    assert.match(res.stdout, /briefboard \d+\.\d+\.\d+/);
    assert.match(res.stdout, /started \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    assert.ok(
      res.stdout.includes(`${server.proc.pid}.json`),
      `the file the answer came from is part of the answer: ${res.stdout}`
    );
  });

  // The criterion the brief put first: one reading, not two. Two implementations
  // of one liveness check drift apart silently (T-0171), so the proof is that
  // both places print the very same sentence about the very same board.
  it('says exactly what the archive warning says, because it is the same reading', async () => {
    const root = makeProject([closedTask('T-0001')]);
    await board(root);

    const asked = runCli(root, ['board']);
    const archived = runCli(root, ['archive']);

    assert.strictEqual(archived.status, 0, archived.stderr);
    assert.strictEqual(
      boardLine(asked.stdout),
      boardLine(archived.stderr).replace(/^WARNING: /, '')
    );
  });

  it('does not present a board that was killed hard as running', async () => {
    const root = makeProject();
    const server = await board(root);
    server.proc.kill('SIGKILL');
    await waitForExit(server.proc);

    const res = runCli(root, ['board']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(tracePathFor(root, server.proc.pid)), 'the file is still there');
    assert.match(res.stdout, /no board is running for this project/);
    assert.doesNotMatch(res.stdout, new RegExp(`pid ${server.proc.pid}\\b`));
  });

  // "Ours" is defined by the directory the trace is filed in, and the command
  // says so rather than leaving it to be inferred.
  it('lists the boards of this project only, and says what makes a board this project\'s', async () => {
    const mine = makeProject();
    const other = makeProject();
    const server = await board(other);

    const res = runCli(mine, ['board']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, new RegExp(`pid ${server.proc.pid}\\b`));
    assert.match(res.stdout, /no board is running for this project/);
    assert.ok(res.stdout.includes(mine), 'the project the answer is about is named');
    assert.match(res.stdout, /files its trace under the project it serves/);
  });

  // Finding nothing is an answer, and a command that printed nothing would be
  // indistinguishable from one that failed to look — including about the one
  // board neither witness can see.
  it('explains an empty answer instead of printing nothing, and exits 0', () => {
    const res = runCli(makeProject(), ['board']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /no live entry in \.briefboard[/\\]boards/);
    assert.match(res.stdout, new RegExp(`older than briefboard ${TRACE_SINCE.replace(/\./g, '\\.')}`));
    assert.strictEqual(res.stderr, '');
  });

  // The second witness, for the board that left no trace at all: a session it
  // started is still running, which proves the process without giving an address.
  it('reports a board seen only through a session it started, and says the address is unknown', () => {
    const root = makeProject();
    const pid = liveStranger();
    writeRegistry(root, [
      {
        id: 'T-0011',
        kind: 'worker',
        pid: 4242,
        board: pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        logPath: path.join(root, '.briefboard', 'sessions', 'T-0011.log'),
        status: 'running',
        exitCode: null,
        signal: null,
        endedAt: null,
      },
    ]);

    const res = runCli(root, ['board']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`a board is running for this project: pid ${pid}, address unknown`));
    assert.match(res.stdout, /registry\.json has a session it started still running/);
    assert.doesNotMatch(res.stdout, /no board is running/);
  });
});

describe('reading a trace: the file is never the proof (T-0186)', () => {
  const alwaysAlive = { isAlive: () => true, selfPid: -1 };

  it('reports a trace whose process is alive', () => {
    const root = makeProject();
    writeBoardTrace(root, { port: 4571, host: '127.0.0.1', installRoot: ROOT, pid: 4242 });

    const { boards } = readBoardTraces(root, alwaysAlive);
    assert.strictEqual(boards.length, 1);
    assert.deepStrictEqual(
      { pid: boards[0].pid, port: boards[0].port, host: boards[0].host, alive: boards[0].alive },
      { pid: 4242, port: 4571, host: '127.0.0.1', alive: true }
    );
    assert.strictEqual(boards[0].version, require('../package.json').version);
  });

  it('reports one whose process is gone as not alive', () => {
    const root = makeProject();
    writeBoardTrace(root, { port: 4571, host: '127.0.0.1', installRoot: ROOT, pid: 4242 });

    const { boards } = readBoardTraces(root, { isAlive: () => false, selfPid: -1 });
    assert.strictEqual(boards[0].alive, false);
  });

  // The same argument reconcileSession() makes: the reader is not a board, so a
  // trace naming the reader's pid is a pid the OS handed on.
  it('treats a trace claiming the reader\'s own pid as a reused pid', () => {
    const root = makeProject();
    writeBoardTrace(root, { port: 4571, host: '127.0.0.1', installRoot: ROOT, pid: process.pid });

    const { boards } = readBoardTraces(root, { isAlive: () => true, selfPid: process.pid });
    assert.strictEqual(boards[0].alive, false);
  });

  it('does not trust a record that disagrees with the file it is in', () => {
    const root = makeProject();
    writeRawTrace(root, 4242, { trace: 1, pid: 9999, port: 4571 });

    const { boards } = readBoardTraces(root, alwaysAlive);
    assert.strictEqual(boards[0].pid, 4242, 'the pid checked is the one the file is named after');
    assert.strictEqual(boards[0].alive, false);
  });

  it('survives an unreadable trace instead of throwing on it', () => {
    const root = makeProject();
    writeRawTrace(root, 4242, '{ not json');

    const { boards } = readBoardTraces(root, alwaysAlive);
    assert.strictEqual(boards.length, 1);
    assert.strictEqual(boards[0].alive, false);
    assert.strictEqual(boards[0].port, null);
  });

  it('ignores files that are not a pid, and a project with no directory at all', () => {
    const root = makeProject();
    writeRawTrace(root, 4242, { trace: 1, pid: 4242, port: 4571 });
    fs.writeFileSync(path.join(traceDirFor(root), 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(traceDirFor(root), 'board.json'), '{}');

    assert.deepStrictEqual(readBoardTraces(root, alwaysAlive).boards.map((b) => b.pid), [4242]);
    assert.deepStrictEqual(readBoardTraces(makeProject()).boards, []);
  });

  it('removes only its own trace, and says nothing when there is none', () => {
    const root = makeProject();
    writeBoardTrace(root, { port: 4571, host: '127.0.0.1', installRoot: ROOT, pid: 4242 });
    writeBoardTrace(root, { port: 4572, host: '127.0.0.1', installRoot: ROOT, pid: 4243 });

    assert.strictEqual(removeBoardTrace(root, 4242), true);
    assert.deepStrictEqual(traceFiles(root), ['4243.json']);
    assert.strictEqual(removeBoardTrace(root, 4242), true, 'removing a trace that is gone is not an error');
  });

  it('sweeps the dead and keeps the living', () => {
    const root = makeProject();
    writeBoardTrace(root, { port: 4571, host: '127.0.0.1', installRoot: ROOT, pid: 4242 });
    writeBoardTrace(root, { port: 4572, host: '127.0.0.1', installRoot: ROOT, pid: 4243 });

    const removed = sweepBoardTraces(root, { selfPid: -1, isAlive: (pid) => pid === 4243 });

    assert.deepStrictEqual(removed, [4242]);
    assert.deepStrictEqual(traceFiles(root), ['4243.json']);
  });
});
