'use strict';

// Tests for the cross-process write lock (T-0046): withFileLock / updateBacklog /
// atomicWrite in server/parser.js, plus end-to-end concurrency tests that run
// several real `node tools/task.mjs` processes at once and assert that no update
// is lost. Run with: npm test  (or: node --test tests/**/*.test.js)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { withFileLock, updateBacklog, atomicWrite, parseBacklog } = require('../server/parser.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-lock-test-'));
}

function mkTask(id) {
  return {
    id, priority: 'Medium', title: 'Task ' + id, type: 'feature',
    status: 'backlog', created: '2026-01-01 00:00:00', closed: '', briefs: [], description: '',
  };
}

/** Run `node tools/task.mjs <args>` as a real async child process. Never rejects. */
function runCliAsync(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, AGENTBOARD_ROOT: root },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

describe('atomicWrite', () => {
  it('writes the file (creating dirs) and leaves no .tmp behind', () => {
    const dir = makeTmpDir();
    const p = path.join(dir, 'nested', 'out.txt');
    atomicWrite(p, 'hello');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'hello');
    assert.ok(!fs.existsSync(p + '.tmp'));
  });
});

describe('withFileLock', () => {
  it('runs fn, returns its value, and releases the lock', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'backlog.md');
    const out = withFileLock(target, () => {
      assert.ok(fs.existsSync(target + '.lock'), 'lock is held during fn');
      return 42;
    });
    assert.strictEqual(out, 42);
    assert.ok(!fs.existsSync(target + '.lock'), 'lock released after fn');
  });

  it('releases the lock even when fn throws', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'backlog.md');
    assert.throws(() => withFileLock(target, () => { throw new Error('boom'); }), /boom/);
    assert.ok(!fs.existsSync(target + '.lock'), 'lock released after throw');
  });

  it('steals a stale lock (older than the stale threshold)', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'backlog.md');
    const lock = target + '.lock';
    fs.writeFileSync(lock, '999999 0\n');
    const old = new Date(Date.now() - 60000); // 60s > 10s stale threshold
    fs.utimesSync(lock, old, old);
    let ran = false;
    withFileLock(target, () => { ran = true; });
    assert.ok(ran, 'fn ran after stealing the stale lock');
    assert.ok(!fs.existsSync(lock), 'lock released');
  });

  it('throws a clear error when a fresh foreign lock is held past the acquire timeout', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'backlog.md');
    const lock = target + '.lock';
    fs.writeFileSync(lock, `123456 ${Date.now()}\n`); // fresh: not stale, not ours
    assert.throws(() => withFileLock(target, () => {}), /could not acquire lock/);
    assert.ok(fs.existsSync(lock), 'a foreign lock we never owned is left in place');
  });
});

describe('updateBacklog', () => {
  it('applies the mutation, persists it, and returns the mutate result', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'backlog.md');
    const ret = updateBacklog(target, (tasks) => {
      tasks.push(mkTask('T-0001'));
      return 'ok';
    });
    assert.strictEqual(ret, 'ok');
    const tasks = parseBacklog(fs.readFileSync(target, 'utf8'));
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].id, 'T-0001');
    assert.ok(!fs.existsSync(target + '.lock'));
    assert.ok(!fs.existsSync(target + '.tmp'));
  });

  it('leaves the file untouched and releases the lock when mutate throws', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'backlog.md');
    updateBacklog(target, (tasks) => tasks.push(mkTask('T-0001'))); // seed
    const before = fs.readFileSync(target, 'utf8');
    assert.throws(() => updateBacklog(target, (tasks) => {
      tasks.push(mkTask('T-0002'));
      throw new Error('abort');
    }), /abort/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), before, 'file unchanged after aborted mutate');
    assert.ok(!fs.existsSync(target + '.lock'));
  });
});

describe('concurrency (real separate processes)', () => {
  it('N parallel `task.mjs add` lose no update: all N persist with unique ids', async () => {
    const root = makeTmpDir();
    const N = 12;
    const runs = [];
    for (let i = 0; i < N; i++) runs.push(runCliAsync(root, ['add', '--title', `Task ${i}`]));
    const results = await Promise.all(runs);
    for (const r of results) assert.strictEqual(r.code, 0, `add failed: ${r.stderr}`);

    const tasks = parseBacklog(fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8'));
    assert.strictEqual(tasks.length, N, 'every add persisted (no lost update)');
    assert.strictEqual(new Set(tasks.map((t) => t.id)).size, N, 'ids unique (no duplicate from a stale read)');
  });

  it('parallel add + status transition all persist', async () => {
    const root = makeTmpDir();
    await runCliAsync(root, ['add', '--title', 'Seed']); // T-0001
    const results = await Promise.all([
      runCliAsync(root, ['status', 'T-0001', 'open']),
      runCliAsync(root, ['add', '--title', 'A']),
      runCliAsync(root, ['add', '--title', 'B']),
      runCliAsync(root, ['add', '--title', 'C']),
    ]);
    for (const r of results) assert.strictEqual(r.code, 0, r.stderr);

    const tasks = parseBacklog(fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8'));
    assert.strictEqual(tasks.length, 4, 'seed + 3 adds all present');
    assert.strictEqual(tasks.find((t) => t.id === 'T-0001').status, 'open', 'status change not lost');
  });
});
