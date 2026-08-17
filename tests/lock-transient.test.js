'use strict';

// Tests for withFileLock's handling of transient filesystem errors (T-0089): on
// Windows, taking or releasing the lock file can fail with EPERM/EACCES/EBUSY
// while another process is deleting that very file (or an antivirus holds it).
// Those are contention, not failure, and must never reach the caller as a raw
// error - the one caught in the wild aborted a write in 600ms, far inside the
// acquire budget. Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); // same singleton parser.js sees via require('fs')
const path = require('node:path');
const os = require('node:os');

// Set BEFORE requiring parser.js: it reads the budget once at load. Big enough
// that a retry test can never lose to a slow machine, small enough that the two
// "gives up" tests cost a second each.
process.env.BRIEFBOARD_LOCK_TIMEOUT_MS = '1000';

const { withFileLock, LOCK_TIMEOUT_CODE } = require('../server/parser.js');

const TRANSIENT_CODES = ['EPERM', 'EACCES', 'EBUSY'];

function makeTarget() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-transient-test-')), 'backlog.md');
}

function fsError(code) {
  const e = new Error(`${code}: simulated`);
  e.code = code;
  return e;
}

describe('withFileLock: transient errors while acquiring', () => {
  const realOpen = fs.openSync;
  const realStat = fs.statSync;
  // Always restore the real fs so a failed assertion cannot leak a mock into
  // another test.
  afterEach(() => {
    fs.openSync = realOpen;
    fs.statSync = realStat;
  });

  for (const code of TRANSIENT_CODES) {
    it(`waits out a transient ${code} and takes the lock`, () => {
      const target = makeTarget();
      let calls = 0;
      const failFor = 3;
      fs.openSync = (...args) => {
        calls++;
        if (calls <= failFor) throw fsError(code);
        return realOpen(...args);
      };
      let ran = false;
      const out = withFileLock(target, () => {
        ran = true;
        return 'value';
      });
      assert.ok(ran, 'fn ran');
      assert.strictEqual(out, 'value');
      assert.strictEqual(calls, failFor + 1, 'retried until the open succeeded');
      assert.ok(!fs.existsSync(target + '.lock'), 'lock released');
    });
  }

  it('reports a transient that outlives the budget as a lock timeout, not a raw code', () => {
    const target = makeTarget();
    fs.openSync = () => {
      throw fsError('EPERM');
    };
    assert.throws(
      () => withFileLock(target, () => {}),
      (e) => {
        // Callers turn this into a 503 (T-0081); a raw EPERM would be a 500.
        assert.strictEqual(e.code, LOCK_TIMEOUT_CODE);
        assert.match(e.message, /could not acquire lock/);
        return true;
      }
    );
  });

  it('rethrows a non-transient open error immediately', () => {
    const target = makeTarget();
    let calls = 0;
    fs.openSync = () => {
      calls++;
      throw fsError('EMFILE');
    };
    assert.throws(() => withFileLock(target, () => {}), /EMFILE/);
    assert.strictEqual(calls, 1, 'not retried');
  });

  it('gives up on a stale lock it is not allowed to delete instead of spinning', () => {
    const target = makeTarget();
    const lock = target + '.lock';
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '999999 0\n');
    const old = new Date(Date.now() - 60000); // well past the stale threshold
    fs.utimesSync(lock, old, old);
    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = () => {
      throw fsError('EPERM');
    };
    try {
      // A failed steal used to loop straight back to the open with no wait and
      // no deadline check, which never terminates.
      assert.throws(() => withFileLock(target, () => {}), (e) => e.code === LOCK_TIMEOUT_CODE);
    } finally {
      fs.unlinkSync = realUnlink;
    }
  });

  it('does not steal a fresh foreign lock whose age cannot be read', () => {
    const target = makeTarget();
    const lock = target + '.lock';
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `123456 ${Date.now()}\n`); // fresh: not stale, not ours
    const body = fs.readFileSync(lock, 'utf8');
    fs.statSync = () => {
      throw fsError('EPERM');
    };
    assert.throws(() => withFileLock(target, () => {}), (e) => e.code === LOCK_TIMEOUT_CODE);
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), body, 'the foreign lock is left untouched');
  });
});

describe('withFileLock: transient errors while releasing', () => {
  const realUnlink = fs.unlinkSync;
  afterEach(() => {
    fs.unlinkSync = realUnlink;
  });

  it('retries a transient unlink and removes the lock', () => {
    const target = makeTarget();
    let calls = 0;
    fs.unlinkSync = (...args) => {
      calls++;
      if (calls <= 2) throw fsError('EBUSY');
      return realUnlink(...args);
    };
    assert.strictEqual(withFileLock(target, () => 7), 7);
    assert.ok(calls > 1, `unlink retried (calls=${calls})`);
    assert.ok(!fs.existsSync(target + '.lock'), 'lock released');
  });

  it('returns fn\'s result even when the lock can never be unlinked', () => {
    const target = makeTarget();
    fs.unlinkSync = () => {
      throw fsError('EPERM');
    };
    assert.strictEqual(withFileLock(target, () => 'result'), 'result');
    // Left behind on purpose: the next acquirer steals it once it is stale,
    // which beats failing a write that already succeeded.
    assert.ok(fs.existsSync(target + '.lock'));
  });

  it('does not replace the error fn threw', () => {
    const target = makeTarget();
    fs.unlinkSync = () => {
      throw fsError('EPERM');
    };
    assert.throws(() => withFileLock(target, () => {
      throw new Error('boom');
    }), /boom/);
  });

  it('swallows a non-transient unlink error too (never throws from the finally)', () => {
    const target = makeTarget();
    let calls = 0;
    fs.unlinkSync = () => {
      calls++;
      throw fsError('EIO');
    };
    assert.strictEqual(withFileLock(target, () => 'ok'), 'ok');
    assert.strictEqual(calls, 1, 'a non-transient code is not retried');
  });
});
