'use strict';

// T-0119: the board spawns a worker session with the environment inherited, so
// its own BRIEFBOARD_* settings are visible inside the session. Ten tests that
// assert the shipped defaults failed there while the same tree was green for the
// orchestrator, and the worker reported the tree as broken.
//
// Every case here runs a THROWAWAY fixture test file under a deliberately
// polluted environment — the situation that broke, reproduced — so what is
// asserted is the neutraliser's real effect and not this process's own luck.
// Run with: npm test

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { PRODUCT_ENV_VARS } = require('./helpers/env.js');
const { tempDir } = require('./helpers/tmp.js');

const REPO_ROOT = path.join(__dirname, '..');
const NEUTRALISER = path.join(__dirname, 'helpers', 'env.js');
const PARSER = path.join(REPO_ROOT, 'server', 'parser.js');

// A value for every variable the product reads, all of them wrong on purpose.
const POLLUTED = {
  AGENTBOARD_HOST: '10.0.0.1',
  AGENTBOARD_ROOT: os.tmpdir(),
  BRIEFBOARD_ALLOWED_HOSTS: 'a-board-that-is-not-this-one.example',
  BRIEFBOARD_LOCK_TIMEOUT_MS: '2500',
  BRIEFBOARD_NAME: 'a board that is not this one',
  BRIEFBOARD_ORCHESTRATOR_CMD: 'node -e "0"',
  BRIEFBOARD_PROFILES: 'inherited=--from-the-machine',
  BRIEFBOARD_SESSION_CMD: 'node -e "0"',
  BRIEFBOARD_SESSION_MAX: '9',
  BRIEFBOARD_SETUP_CMD: 'node -e "0"',
  BRIEFBOARD_SILENCE_MS: '7',
  BRIEFBOARD_TEST_TIMEOUT_MS: '1234',
  BRIEFBOARD_TOKENS_MODE: 'last',
  BRIEFBOARD_TOKENS_RE: 'inherited',
  BRIEFBOARD_WORKER_CMD: 'node -e "0"',
  HOST: '10.0.0.1',
  MAX_SSE_CLIENTS: '3',
  PORT: '4321',
};

// fs.realpathSync: on macOS os.tmpdir() is a symlink, and the fixture below is
// spawned with this path as its cwd.
function tmpDir(prefix) {
  return fs.realpathSync(tempDir(prefix));
}

function runFixture(source, extraEnv = {}) {
  const dir = tmpDir('briefboard-hermetic-');
  const file = path.join(dir, 'fixture.test.js');
  fs.writeFileSync(file, source);
  // node:test sets NODE_TEST_CONTEXT in this process; inherited, it makes the
  // nested runner serialize to its parent instead of reporting.
  const env = { ...process.env, ...POLLUTED, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ['--test', '--test-timeout=60000', file], {
    cwd: dir,
    encoding: 'utf8',
    env,
    timeout: 60000,
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const q = (value) => JSON.stringify(value);

// Reports which product variables are still visible — in this process and in a
// child it spawns, since a test's children inherit whatever it did not clean.
function leakFixture({ neutralise }) {
  return `'use strict';
${neutralise ? `require(${q(NEUTRALISER)});\n` : ''}const { it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const NAMES = ${q(PRODUCT_ENV_VARS)};

it('this process sees no product variable', () => {
  assert.deepStrictEqual(NAMES.filter((n) => process.env[n] !== undefined), []);
});

it('a child process sees no product variable either', () => {
  const res = spawnSync(process.execPath, ['-p', 'JSON.stringify(process.env)'], { encoding: 'utf8' });
  const childEnv = JSON.parse(res.stdout);
  assert.deepStrictEqual(NAMES.filter((n) => childEnv[n] !== undefined), []);
});
`;
}

// server/parser.js reads BRIEFBOARD_LOCK_TIMEOUT_MS once at load (T-0081), which
// is why the neutraliser has to run before the first require of product code.
// The fixture sets its own tiny budget the way a real test does and then reads
// the budget the module actually used back out of the timeout message, which
// names it (T-0182). With the require in the wrong order the module still holds
// the inherited 2500ms and says so in the failure.
//
// It used to time the call instead — `elapsed < 1200` — which is the mine T-0184
// took out of lock.test.js: elapsed time is evidence about the machine, and it
// stands in for the fact only as long as no scheduler disagrees (T-0191).
function loadOrderFixture({ neutraliseFirst }) {
  const neutralise = `require(${q(NEUTRALISER)});\nprocess.env.BRIEFBOARD_LOCK_TIMEOUT_MS = '60';`;
  const load = `const { withFileLock, LOCK_TIMEOUT_CODE } = require(${q(PARSER)});`;
  return `'use strict';
${neutraliseFirst ? `${neutralise}\n${load}` : `${load}\n${neutralise}`}
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

it('parser.js uses the budget this file set, not the inherited one', () => {
  const target = process.env.LOCK_TARGET;
  fs.writeFileSync(target, '');
  fs.writeFileSync(target + '.lock', '123456 ' + Date.now() + '\\n');
  assert.throws(() => withFileLock(target, () => {}), (e) => {
    assert.strictEqual(e.code, LOCK_TIMEOUT_CODE);
    assert.match(e.message, /after 60ms/, 'the budget came from the environment: ' + e.message);
    return true;
  });
});
`;
}

describe('the suite brings its own environment (T-0119)', () => {
  it('a test file run under the board\'s environment sees none of it', () => {
    const { status, out } = runFixture(leakFixture({ neutralise: true }));
    assert.strictEqual(status, 0, out);
  });

  it('without the neutraliser the very same fixture fails', () => {
    const { status, out } = runFixture(leakFixture({ neutralise: false }));
    assert.notStrictEqual(status, 0, 'the check has no teeth: a polluted environment passed it');
    assert.match(out, /BRIEFBOARD_SESSION_CMD/);
  });

  it('neutralises before a module under test reads the environment at load', () => {
    const target = path.join(tmpDir('briefboard-hermetic-lock-'), 'backlog.md');
    const { status, out } = runFixture(loadOrderFixture({ neutraliseFirst: true }), {
      LOCK_TARGET: target,
    });
    assert.strictEqual(status, 0, out);
  });

  it('and the same fixture fails when the neutraliser runs after that require', () => {
    const target = path.join(tmpDir('briefboard-hermetic-lock-'), 'backlog.md');
    const { status, out } = runFixture(loadOrderFixture({ neutraliseFirst: false }), {
      LOCK_TARGET: target,
    });
    assert.notStrictEqual(status, 0, 'a late neutralisation has to be detectable');
    assert.match(out, /the budget came from the environment/);
  });

  it('knows every variable the product reads', () => {
    const files = [];
    for (const dir of ['server', 'tools', 'bin']) {
      for (const name of fs.readdirSync(path.join(REPO_ROOT, dir))) {
        if (/\.(js|mjs)$/.test(name)) files.push(path.join(REPO_ROOT, dir, name));
      }
    }
    const used = new Set();
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      // Direct reads, plus the constants sessions.js indirects through.
      for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) used.add(m[1]);
      for (const m of text.matchAll(/_ENV\s*=\s*'([A-Z_][A-Z0-9_]*)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((name) => !PRODUCT_ENV_VARS.includes(name)).sort();
    assert.deepStrictEqual(
      missing,
      [],
      `add these to PRODUCT_ENV_VARS in tests/helpers/env.js: ${missing.join(', ')}`
    );
  });
});
