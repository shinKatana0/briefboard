'use strict';

// Tests for the cross-process write lock (T-0046): withFileLock / updateBacklog /
// atomicWrite in server/parser.js, plus end-to-end concurrency tests that run
// several real `node tools/task.mjs` processes at once and assert that no update
// is lost. Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('./helpers/tmp.js');

// Set BEFORE requiring parser.js: it reads the budget once at load. Without it
// the in-process "foreign lock held past the timeout" test below would sit in
// sleepSync for the full 5s default. node --test runs each test file in its own
// process, so this affects nothing else.
process.env.BRIEFBOARD_LOCK_TIMEOUT_MS = '50';

const {
  withFileLock,
  updateBacklog,
  atomicWrite,
  parseBacklog,
  resolveLockTimeout,
  DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
  LOCK_TIMEOUT_CODE,
} = require('../server/parser.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

// Deliberately far above anything a real write needs: these tests assert that no
// update is lost under contention, not how fast the machine is. With the 5s
// default a full `npm test` — a dozen files in parallel, each spawning
// processes — pushed the unluckiest of 12 writers past the budget in roughly a
// third of the runs (T-0081).
const STRESS_LOCK_TIMEOUT_MS = '60000';

function makeTmpDir() {
  return tempDir('briefboard-lock-test-');
}

function mkTask(id) {
  return {
    id, priority: 'Medium', title: 'Task ' + id, type: 'feature',
    status: 'backlog', created: '2026-01-01 00:00:00', closed: '', briefs: [], description: '',
  };
}

/**
 * Run `node tools/task.mjs <args>` as a real async child process. Never rejects.
 * `lockTimeoutMs` is passed through explicitly (the parent's own tiny budget
 * would otherwise be inherited by every child).
 */
function runCliAsync(root, args, lockTimeoutMs = STRESS_LOCK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, AGENTBOARD_ROOT: root, BRIEFBOARD_LOCK_TIMEOUT_MS: lockTimeoutMs },
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

  it('throws a clear, machine-readable error when a fresh foreign lock is held past the acquire timeout', () => {
    const dir = makeTmpDir();
    const target = path.join(dir, 'backlog.md');
    const lock = target + '.lock';
    fs.writeFileSync(lock, `123456 ${Date.now()}\n`); // fresh: not stale, not ours
    assert.throws(
      () => withFileLock(target, () => {}),
      (e) => {
        assert.match(e.message, /could not acquire lock/);
        // The budget it gave up on, named: this file set 50ms above, and that is
        // the only way anything downstream can tell which budget was in force.
        assert.match(e.message, /after 50ms/);
        // Callers (server.js's 503) must not have to match on the message text.
        assert.strictEqual(e.code, LOCK_TIMEOUT_CODE);
        return true;
      }
    );
    assert.ok(fs.existsSync(lock), 'a foreign lock we never owned is left in place');
  });
});

describe('lock acquire budget (BRIEFBOARD_LOCK_TIMEOUT_MS)', () => {
  it('falls back to the 5000 ms default for a missing or unusable value', () => {
    for (const raw of [undefined, '', '   ', 'abc', '0', '-100', 'NaN', '1e', {}]) {
      assert.strictEqual(
        resolveLockTimeout(raw),
        DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
        `expected the default for ${JSON.stringify(raw)}`
      );
    }
    assert.strictEqual(DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS, 5000);
  });

  it('takes a usable value from the environment', () => {
    assert.strictEqual(resolveLockTimeout('250'), 250);
    assert.strictEqual(resolveLockTimeout('60000'), 60000);
    assert.strictEqual(resolveLockTimeout(75), 75);
  });

  it('a garbage value does not stop the CLI from writing (it just uses the default)', async () => {
    const root = makeTmpDir();
    const r = await runCliAsync(root, ['add', '--title', 'Still works'], 'not-a-number');
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout, 'T-0001');
  });

  it('the CLI gives up with a clear message naming the budget it was given', async () => {
    const root = makeTmpDir();
    const backlog = path.join(root, 'doc', 'backlog.md');
    fs.mkdirSync(path.dirname(backlog), { recursive: true });
    fs.writeFileSync(backlog + '.lock', `123456 ${Date.now()}\n`); // fresh foreign lock

    const budgetMs = 50;
    // The holder has to still look alive when the child finally gets to the
    // acquire. withFileLock steals a lock whose file is older than
    // LOCK_STALE_MS (10 s), and a spawned node reaches its first instruction up
    // to 15.7 s later under four concurrent suites (tests/helpers/wait.js) — so
    // under load the lock aged out, the child took it, and the add succeeded
    // where the test wanted it refused (T-0207). Touching the file keeps it as
    // fresh as a live holder's would be, whatever the machine is doing.
    const keepFresh = setInterval(() => {
      const now = new Date();
      try {
        fs.utimesSync(backlog + '.lock', now, now);
      } catch {
        /* released or stolen: the child's answer is already decided */
      }
    }, 1000);
    let r;
    try {
      r = await runCliAsync(root, ['add', '--title', 'Blocked'], String(budgetMs));
    } finally {
      clearInterval(keepFresh);
    }
    assert.strictEqual(r.code, 1, 'the add fails instead of writing');
    assert.match(r.stderr, /could not acquire lock/);
    assert.ok(!fs.existsSync(backlog), 'nothing was written');
    // The child says which budget it read, so the assertion is about the variable
    // reaching it and nothing else. It used to be `elapsed < 5000` — evidence that
    // stops being evidence on a loaded machine, where a 50ms budget and the 5s
    // default take indistinguishable wall-clock time to answer (T-0184).
    assert.match(
      r.stderr,
      new RegExp(`after ${budgetMs}ms`),
      `the child gave up on some other budget than the ${budgetMs}ms it was given ` +
        `(the fallback is ${DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS}ms)`
    );
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

  it('parallel `task.mjs note` calls all land in the description (T-0098)', async () => {
    const root = makeTmpDir();
    await runCliAsync(root, ['add', '--title', 'Reported on']); // T-0001
    const N = 6;
    const runs = [];
    for (let i = 0; i < N; i++)
      runs.push(runCliAsync(root, ['note', 'T-0001', '--section', 'Worker report', '--text', `pass ${i}`]));
    const results = await Promise.all(runs);
    for (const r of results) assert.strictEqual(r.code, 0, `note failed: ${r.stderr}`);

    const [task] = parseBacklog(fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8'));
    for (let i = 0; i < N; i++)
      assert.ok(task.description.includes(`pass ${i}`), `"pass ${i}" survived`);
    assert.strictEqual(task.description.match(/^### Worker report$/gm).length, 1, 'one section, not N');
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
