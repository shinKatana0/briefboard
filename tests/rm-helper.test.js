'use strict';

// T-0195: tests/helpers/rm.js — the teardown that removes a directory has to
// outlast whatever still holds it, and has to give up rather than hang.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { removeTree, RM_POLL_MS } = require('./helpers/rm.js');
const { waitFor } = require('./helpers/wait.js');
const { stopProcess } = require('./helpers/bounded.js');

const WIN = process.platform === 'win32';

// An rm that fails `times` times with `code` and then lets the directory go,
// standing in for the OS on a platform where a cwd holds nothing.
function failing(times, code) {
  const calls = { n: 0 };
  const rm = () => {
    calls.n++;
    if (calls.n <= times) {
      const e = new Error(`${code}: fake`);
      e.code = code;
      throw e;
    }
  };
  return { rm, calls };
}

describe('removeTree waits out what still holds the directory (T-0195)', () => {
  it('retries a transient failure and returns as soon as it clears', async () => {
    const { rm, calls } = failing(3, 'EPERM');

    await removeTree('fake-dir', { rm, budgetMs: 5000 });

    assert.equal(calls.n, 4, 'gave up before the directory was free');
  });

  it('gives up on a budget rather than hanging, and says what it was waiting for', async () => {
    const { rm, calls } = failing(Infinity, 'EBUSY');
    const budgetMs = 200;

    const at = Date.now();
    await assert.rejects(() => removeTree('held-dir', { rm, budgetMs }), {
      message: /held-dir was still held 200ms after the test ended \(EBUSY\)/,
    });
    const waited = Date.now() - at;

    assert.ok(waited >= budgetMs, `gave up after ${waited}ms, before its ${budgetMs}ms budget`);
    assert.ok(waited < budgetMs + 5000, `took ${waited}ms to give up on a ${budgetMs}ms budget`);
    assert.ok(calls.n > 1, 'spent the budget without retrying');
  });

  it('keeps the original error as the cause, so the code is not lost', async () => {
    const { rm } = failing(Infinity, 'EPERM');

    const err = await removeTree('held-dir', { rm, budgetMs: RM_POLL_MS }).catch((e) => e);

    assert.equal(err.cause.code, 'EPERM');
  });

  it('does not wait out an error that is not transient', async () => {
    const { rm, calls } = failing(Infinity, 'ENOTDIR');

    await assert.rejects(() => removeTree('a-file', { rm, budgetMs: 5000 }), { code: 'ENOTDIR' });

    assert.equal(calls.n, 1, 'retried an error that will never clear');
  });
});

// The real thing, and the reason the helper exists. Elsewhere a directory can be
// removed while a live process sits in it, so there is nothing here to wait for.
const holders = [];

afterEach(async () => {
  for (const holder of holders.splice(0)) await stopProcess(holder);
});

describe('a process whose cwd is the directory holds it, on Windows (T-0195)', () => {
  it(
    'is waited out: the removal returns once the holder is gone',
    { skip: !WIN && 'a cwd holds no directory on this platform' },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-rm-test-'));
      const ready = path.join(dir, 'ready');
      const holder = spawn(
        process.execPath,
        ['-e', "require('fs').writeFileSync(process.argv[1], 'x'); setInterval(() => {}, 1000)", ready],
        { cwd: dir, stdio: 'ignore', windowsHide: true }
      );
      holders.push(holder);
      await waitFor(() => fs.existsSync(ready), undefined, 'the holder to start in the directory');

      // What the teardowns were doing, and what it is worth while the holder is
      // alive. The options are the ones tests/kill-tree.test.js used to pass:
      // measured, they retry for none of the 2 s they read as (T-0200).
      assert.throws(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20 }), {
        code: 'EPERM',
      });

      const removal = removeTree(dir);
      await stopProcess(holder);
      await removal;

      assert.equal(fs.existsSync(dir), false);
    }
  );
});
