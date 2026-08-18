'use strict';

// Tests for the compact reporter behind `npm test` (T-0105).
// Run with: npm test  (or: node --test tests/**/*.test.js)
//
// Every case runs the real reporter over a THROWAWAY fixture suite in
// os.tmpdir(), so nothing here depends on this project's own tests. The point of
// the reporter is that it drops only the green noise: what a failure needs, and
// the totals, must survive - that is what these assertions pin down.

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./helpers/tmp.js');

const REPO_ROOT = path.join(__dirname, '..');
const COMPACT = './tools/test-reporter-compact.mjs';

function fixture(source) {
  const dir = fs.realpathSync(tempDir('briefboard-reporter-'));
  const file = path.join(dir, 'fixture.test.js');
  fs.writeFileSync(file, source);
  return file;
}

function run(file, reporter) {
  // node:test sets NODE_TEST_CONTEXT in the process running this file. Inherited,
  // it makes the nested runner behave as a test child - it then serializes to its
  // parent instead of reporting, and stdout comes back empty.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
  return res.stdout;
}

const GREEN = `'use strict';
const { describe, it } = require('node:test');
describe('a green group', () => {
  for (let i = 0; i < 40; i++) it('green case number ' + i, () => {});
});
`;

const FAILING = `'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
describe('outer group', () => {
  describe('inner group', () => {
    it('passes', () => {});
    it('breaks on a diff', () => {
      console.error('the marker line on stderr');
      assert.deepEqual({ a: 1, b: 2 }, { a: 1, b: 3 });
    });
  });
});
`;

// node:test reports a skipped test as a pass, so in the dots and in the totals
// it is indistinguishable from a test that ran — which is how a test that
// verifies nothing survives a green run unnoticed (T-0244). Both ways of
// skipping are here, and one skip deliberately gives no reason.
const SKIPPING = `'use strict';
const { describe, it } = require('node:test');
describe('a group', () => {
  it('passes', () => {});
  it('is skipped at runtime', (t) => { t.skip('no IPv6 on this machine'); });
  it('is skipped by option', { skip: 'no PowerShell here' }, () => {});
  it('is skipped without saying why', { skip: true }, () => {});
});
`;

describe('the compact test reporter', () => {
  it('prints the totals and no per-test line on a green run', () => {
    const out = run(fixture(GREEN), COMPACT);
    assert.match(out, /^\.+$/m, 'progress is dots');
    assert.match(out, /ℹ tests 40/);
    assert.match(out, /ℹ pass 40/);
    assert.match(out, /ℹ fail 0/);
    assert.ok(!out.includes('green case number 7'), 'no line per passing test');
  });

  it('is an order of magnitude shorter than spec on the same green run', () => {
    const file = fixture(GREEN);
    const compact = run(file, COMPACT);
    const spec = run(file, 'spec');
    assert.ok(spec.length > compact.length * 10,
      `compact ${compact.length} chars vs spec ${spec.length} chars`);
  });

  it('keeps the file, the test path, the message, the diff and the stack of a failure', () => {
    const file = fixture(FAILING);
    const out = run(file, COMPACT);
    assert.ok(out.includes(path.basename(file)), 'the failing file is named');
    assert.match(out, /outer group > inner group > breaks on a diff/);
    assert.match(out, /Expected values to be strictly deep-equal/);
    assert.match(out, /\+ actual - expected/);
    assert.match(out, /\+ {3}b: 2/);
    assert.match(out, /- {3}b: 3/);
    assert.match(out, /fixture\.test\.js:9/, 'the stack points at the failing line');
    assert.match(out, /operator: 'deepStrictEqual'/);
  });

  it('shows the totals and the stderr of a file that failed', () => {
    const out = run(fixture(FAILING), COMPACT);
    assert.match(out, /ℹ tests 2/);
    assert.match(out, /ℹ pass 1/);
    assert.match(out, /ℹ fail 1/);
    assert.match(out, /the marker line on stderr/, 'the failing file keeps its output');
  });

  it('names the failing file in a re-run command, so the re-run is not the whole suite', () => {
    const file = fixture(FAILING);
    const out = run(file, COMPACT);
    const line = out.split('\n').find((l) => l.startsWith('re-run in full:'));
    assert.ok(line, 'a re-run command is printed');
    assert.ok(line.includes('--test-reporter=spec'), 'it re-runs verbose');
    assert.ok(line.includes(path.basename(file)), 'it names only the failed file');
  });

  it('reports a failure once, not again for each enclosing suite', () => {
    const out = run(fixture(FAILING), COMPACT);
    assert.match(out, /failures \(1\):/);
    assert.strictEqual(out.split('breaks on a diff').length - 1, 1, 'reported exactly once');
  });

  it('names every skipped test and why it was skipped', () => {
    const file = fixture(SKIPPING);
    const out = run(file, COMPACT);
    assert.match(out, /skipped \(3\):/);
    assert.match(out, /a group > is skipped at runtime — no IPv6 on this machine/);
    assert.match(out, /a group > is skipped by option — no PowerShell here/);
    assert.match(out, /a group > is skipped without saying why — no reason given/);
    assert.ok(out.includes(path.basename(file)), 'a skip names its file, like a failure does');
    assert.match(out, /ℹ skipped 3/, 'and the count the runner reports stays');
  });

  it('a skipped test is not a dot: the run shows it while it is running', () => {
    const out = run(fixture(SKIPPING), COMPACT);
    const dots = out.split('\n').find((line) => /^[.sX]+$/.test(line));
    assert.ok(dots, `the progress line is missing:\n${out}`);
    assert.strictEqual(
      dots.split('s').length - 1,
      3,
      `three of the four tests were skipped, and the progress said so ${dots.split('s').length - 1} times: ${dots}`
    );
  });

  it('says nothing about skips when there were none', () => {
    const out = run(fixture(GREEN), COMPACT);
    assert.ok(!out.includes('skipped ('), 'a run with no skip must not grow a section for it');
    assert.match(out, /^\.+$/m, 'and the dots stay dots');
  });

  it('drops the stderr of a file that passed', () => {
    const out = run(fixture(`'use strict';
const { it } = require('node:test');
it('passes but talks', () => { console.error('the marker line on stderr'); });
`), COMPACT);
    assert.ok(!out.includes('the marker line on stderr'), 'green output stays silent');
    assert.match(out, /ℹ fail 0/);
  });
});
