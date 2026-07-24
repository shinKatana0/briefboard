'use strict';

// Tests for atomicWrite()'s rename retry (T-0065): on Windows, renaming the
// sibling .tmp over the target transiently fails with EPERM/EACCES/EBUSY while
// another handle (fs.watch, antivirus, a reader) briefly holds the target.
// atomicWrite must retry those codes, succeed once the handle frees up, but
// rethrow any non-retryable error (and the last error after exhausting retries).
// Run with: npm test  (or: node --test tests/**/*.test.js)

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); // same singleton parser.js sees via require('fs')
const path = require('node:path');
const os = require('node:os');

const { atomicWrite } = require('../server/parser.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-atomic-test-'));
}

function fsError(code) {
  const e = new Error(`${code}: simulated`);
  e.code = code;
  return e;
}

describe('atomicWrite rename retry', () => {
  const realRename = fs.renameSync;
  // Always restore the real renameSync so a failed assertion can't leak the mock
  // into other test files.
  afterEach(() => {
    fs.renameSync = realRename;
  });

  it('writes the file on the happy path (no retry needed)', () => {
    const p = path.join(makeTmpDir(), 'nested', 'out.txt');
    atomicWrite(p, 'hello');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'hello');
    assert.ok(!fs.existsSync(p + '.tmp'), 'no .tmp left behind');
  });

  it('retries transient EPERM and eventually succeeds (attempts > 1)', () => {
    const p = path.join(makeTmpDir(), 'out.txt');
    let attempts = 0;
    const failFor = 3; // first 3 rename calls throw EPERM, then succeed
    fs.renameSync = (from, to) => {
      attempts++;
      if (attempts <= failFor) throw fsError('EPERM');
      return realRename(from, to);
    };
    atomicWrite(p, 'payload');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'payload', 'file written after retries');
    assert.ok(attempts > 1, `renameSync retried (attempts=${attempts})`);
    assert.strictEqual(attempts, failFor + 1, 'succeeded on the first attempt after the handle freed');
  });

  it('retries EACCES and EBUSY as well', () => {
    for (const code of ['EACCES', 'EBUSY']) {
      const p = path.join(makeTmpDir(), 'out.txt');
      let attempts = 0;
      fs.renameSync = (from, to) => {
        attempts++;
        if (attempts <= 2) throw fsError(code);
        return realRename(from, to);
      };
      atomicWrite(p, code);
      assert.strictEqual(fs.readFileSync(p, 'utf8'), code, `${code} retried to success`);
      assert.ok(attempts > 1, `${code} retried (attempts=${attempts})`);
    }
  });

  it('rethrows a non-retryable error immediately (single attempt)', () => {
    const p = path.join(makeTmpDir(), 'out.txt');
    let attempts = 0;
    fs.renameSync = () => {
      attempts++;
      throw fsError('ENOENT');
    };
    assert.throws(() => atomicWrite(p, 'x'), /ENOENT/);
    assert.strictEqual(attempts, 1, 'non-retryable code is not retried');
  });

  it('rethrows the last error after exhausting retries on a persistent code', () => {
    const p = path.join(makeTmpDir(), 'out.txt');
    let attempts = 0;
    fs.renameSync = () => {
      attempts++;
      throw fsError('EPERM');
    };
    assert.throws(() => atomicWrite(p, 'x'), /EPERM/);
    // 1 initial attempt + 10 retries = 11 total calls before giving up.
    assert.strictEqual(attempts, 11, 'bounded retries then throws');
  });
});
