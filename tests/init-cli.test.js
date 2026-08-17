'use strict';

// Tests for bin/briefboard-init.mjs — the `npx briefboard init` scaffolder.
// Run with: npm test  (or: node --test tests/**/*.test.js)
//
// Each test runs the real bin script as a child process against a throwaway
// working directory (cwd = a fresh mkdtemp dir), so the project's own files are
// never touched. We assert the two behaviours the release brief (T-0059) pins:
//   1. a first run scaffolds an EMPTY doc/backlog.md, byte-identical to
//      serializeBacklog([]) — never a copy of this dev backlog;
//   2. a rerun is idempotent — it prints "skip existing" and overwrites nothing.

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch, waitForExit, stopProcess } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { freePort, occupyPort, waitForBanner } = require('./helpers/board.js');
const { AUTO_PORT_VALUE } = require('../server/listen.js');
const { serializeBacklog, parseBacklog } = require('../server/parser.js');

const BIN_PATH = path.join(__dirname, '..', 'bin', 'briefboard-init.mjs');

function runInit(cwd) {
  return spawnSync(process.execPath, [BIN_PATH, 'init'], { cwd, encoding: 'utf8' });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-init-test-'));
}

function backlogPath(dir) {
  return path.join(dir, 'doc', 'backlog.md');
}

describe('briefboard init', () => {
  it('scaffolds an empty doc/backlog.md equal to serializeBacklog([]) on a first run', () => {
    const dir = makeTmpDir();
    const res = runInit(dir);

    assert.strictEqual(res.status, 0, `init failed: ${res.stderr}`);
    assert.match(res.stdout, /created: doc\/backlog\.md/);

    const p = backlogPath(dir);
    assert.ok(fs.existsSync(p), 'doc/backlog.md should exist after init');

    const content = fs.readFileSync(p, 'utf8');
    // Byte-identical to the empty-backlog template — not a copy of any dev backlog.
    assert.strictEqual(content, serializeBacklog([]));
    assert.deepStrictEqual(parseBacklog(content), []);
  });

  it('is idempotent: a rerun prints "skip existing" and overwrites nothing', () => {
    const dir = makeTmpDir();

    const first = runInit(dir);
    assert.strictEqual(first.status, 0, `first init failed: ${first.stderr}`);

    // Mutate the scaffolded backlog so any accidental overwrite is detectable.
    const p = backlogPath(dir);
    const sentinel = fs.readFileSync(p, 'utf8') + '\n<!-- sentinel: user edit -->\n';
    fs.writeFileSync(p, sentinel);

    const second = runInit(dir);
    assert.strictEqual(second.status, 0, `second init failed: ${second.stderr}`);

    // "skip existing" warnings go to stderr (console.warn); "created" to stdout.
    assert.match(second.stderr, /skip existing: doc\/backlog\.md/);
    assert.match(second.stderr, /skip existing: doc\/brief/);
    assert.match(second.stderr, /skip existing: server/);
    assert.doesNotMatch(second.stdout, /created:/);

    // The user's sentinel edit survived — the file was not overwritten.
    assert.strictEqual(fs.readFileSync(p, 'utf8'), sentinel);
  });

  it('points at `briefboard serve` in its next steps', () => {
    const res = runInit(makeTmpDir());
    assert.match(res.stdout, /briefboard serve/);
  });

  it('records what it created in .briefboard/installed.json', () => {
    const dir = makeTmpDir();
    const res = runInit(dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /created: \.briefboard\/installed\.json/);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.briefboard', 'installed.json'), 'utf8'));
    assert.ok(manifest.files['server/server.js'], 'the copied runtime files are what it records');
  });

  // T-0188: the file is the user's data. `update` and `--version` say so and
  // touch nothing; `init` used to replace it with a record of this run alone,
  // silently, so both the damaged file and the fact it existed were gone.
  it('names a manifest it could not read, and overwrites neither it nor the truth', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, '.briefboard', 'installed.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const damaged = '{ "files": broken\n';
    fs.writeFileSync(file, damaged);

    const res = runInit(dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /WARNING: \.briefboard\/installed\.json could not be read/);
    assert.match(res.stderr, /recorded nothing/, 'and says what that costs');
    assert.doesNotMatch(res.stdout, /created: \.briefboard\/installed\.json/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), damaged, 'the user\'s file is left exactly as it was');
    // The install itself still happened - the refusal is about the record only.
    assert.match(res.stdout, /created: server/);
  });
});

// ---------- `briefboard serve` (T-0078) ----------
// A board is normally left to pick its own port and asked afterwards which one
// it took (T-0123). The exception below is the test of `--port` itself: there
// the requested number is the subject.

const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function occupyFreePort() {
  const { port, close } = await occupyPort();
  cleanups.push(close);
  return port;
}

function runServe(dir, args) {
  const proc = spawn(process.execPath, [BIN_PATH, 'serve', ...args], {
    cwd: dir,
    // PORT=auto so an inherited one cannot mask what --port does, and a run
    // without --port takes a kernel port instead of the human range (T-0139).
    env: { ...process.env, PORT: AUTO_PORT_VALUE, BRIEFBOARD_NAME: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (c) => (stdout += c.toString()));
  proc.stderr.on('data', (c) => (stderr += c.toString()));
  cleanups.push(() => stopProcess(proc));

  return {
    out: () => ({ stdout, stderr }),
    async waitForExit() {
      const code = await waitForExit(proc);
      return { code, stdout, stderr };
    },
    ready: (timeoutMs) => waitForBanner(proc, () => ({ stdout, stderr }), timeoutMs),
  };
}

describe('briefboard serve', () => {
  it('starts the board for the current directory, using the project\'s own server copy', async () => {
    const dir = makeTmpDir();
    // fs.realpathSync: on macOS os.tmpdir() is a symlink, and the server prints
    // the resolved path.
    const project = fs.realpathSync(dir);
    assert.strictEqual(runInit(project).status, 0);

    const port = await freePort();
    const serve = runServe(project, ['--port', String(port)]);
    const bound = await serve.ready();

    assert.strictEqual(bound, port);
    assert.match(serve.out().stdout, /server: .*[\\/]server[\\/]server\.js \(this project's copy\)/);

    const res = await fetch(`http://127.0.0.1:${port}/api/board`);
    const board = await readJson(res);
    // The board serves THIS directory: its freshly scaffolded (empty) backlog,
    // named after the folder.
    assert.deepStrictEqual(board.tasks, [], answerOf(board));
    assert.strictEqual(board.project.name, path.basename(project), answerOf(board));
  });

  it('falls back to the installed package copy when the project has no server/', async () => {
    const dir = fs.realpathSync(makeTmpDir());
    // No --port: this test is about which server copy runs, so the board picks
    // its own port and says which one in the banner (T-0123).
    const serve = runServe(dir, []);
    await serve.ready();

    assert.match(serve.out().stdout, /\(installed package\)/);
  });

  it('treats --port as explicit: an occupied port is an error, not a move', async () => {
    const dir = fs.realpathSync(makeTmpDir());
    const taken = await occupyFreePort();

    const { code, stdout, stderr } = await runServe(dir, ['--port', String(taken)]).waitForExit();

    assert.notStrictEqual(code, 0);
    assert.match(stderr, new RegExp(`port ${taken} is already in use`));
    assert.doesNotMatch(stdout, /briefboard: http:\/\//);
  });

  it('rejects a --port that is not a port number, with the usage line', async () => {
    const dir = makeTmpDir();
    const { code, stderr } = await runServe(dir, ['--port', 'abc']).waitForExit();

    assert.notStrictEqual(code, 0);
    assert.match(stderr, /invalid port/);
    assert.match(stderr, /Usage: briefboard \[init\|update/);
  });

  it('rejects an unknown option', async () => {
    const dir = makeTmpDir();
    const { code, stderr } = await runServe(dir, ['--nope']).waitForExit();

    assert.notStrictEqual(code, 0);
    assert.match(stderr, /unknown option for serve: --nope/);
  });
});

describe('briefboard <unknown command>', () => {
  it('names serve in the usage line', () => {
    const res = spawnSync(process.execPath, [BIN_PATH, 'bogus'], { cwd: makeTmpDir(), encoding: 'utf8' });
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /Usage: briefboard \[init\|update \[--apply\] \[--force\]\|serve \[--port N\]\|--version\]/);
  });
});
