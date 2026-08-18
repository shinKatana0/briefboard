'use strict';

// T-0261: the suite left its temporary directories behind — 118766 `briefboard-*`
// in %TEMP% on the machine this was found on, growing by a few hundred every run,
// on a %TEMP% this repository measures teardown and spawn latency in.
//
// Every case below runs a THROWAWAY suite that really creates a directory through
// tests/helpers/tmp.js and then ends the way a test really ends: green, failed, or
// cut off at `--test-timeout`. The last two are the point (T-0258): a removal
// written as the last line of a test body is skipped exactly when it is needed.
//
// WHAT IS COUNTED, AND WHY IT IS NOT %TEMP%. Each fixture is given a temporary
// directory of its OWN as its %TEMP%, and what is asserted is what is left in
// that one. A count over the machine's %TEMP% cannot work here: under four
// concurrent suites it sees the directories of runs that have nothing to do with
// this one, and would fail — or pass — on their timing. What this run created is
// something only this run can know, so the fixture reports the path it made and
// the assertion is about that path.
// Run with: npm test

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tempDir } = require('./helpers/tmp.js');

const HELPER = path.join(__dirname, 'helpers', 'tmp.js');
const FIXTURE_TIMEOUT_MS = 2000;
// Above the fixture's own limit, so a fixture that hangs is ended by the runner
// under test and not by this spawn — otherwise the hook whose behaviour is the
// subject would never get to run.
const SPAWN_TIMEOUT_MS = 60000;

const q = (value) => JSON.stringify(value);

// Written in single-quoted pieces, which `stripProse` empties: the raw fixture
// below has to spell the very call tests/suite-hygiene.test.js bans, and a file
// that names a mine in order to stage it must not be caught by the rule (T-0138).
const PREAMBLE = [
  "'use strict';",
  "const { it } = require('node:test');",
  "const fs = require('node:fs');",
  '// The path this fixture made, handed back so the assertion is about the',
  '// directory this run created and not about a count of somebody else’s.',
  'const report = (dir) => fs.writeFileSync(process.env.MADE_DIR, dir);',
];

const viaHelper = (body) =>
  [...PREAMBLE, `const { tempDir } = require(${q(HELPER)});`, `const make = () => report(tempDir('briefboard-tmpguard-'));`, ...body].join('\n');

const viaRawMkdtemp = (body) =>
  [
    ...PREAMBLE,
    "const os = require('node:os');",
    "const path = require('node:path');",
    'const make = () => report(',
    "  fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-tmpguard-raw-'))",
    ');',
    ...body,
  ].join('\n');

const PASSES = ["it('passes', () => { make(); });"];
const FAILS = ["it('fails', () => { make(); throw new Error('the body of this test failed'); });"];
const HANGS = ["it('hangs', async () => { make(); await new Promise(() => {}); });"];

/**
 * Runs `source` as a suite of its own, with a %TEMP% of its own, and reports the
 * path the fixture made along with whatever is still in that %TEMP% afterwards.
 */
function runFixture(source) {
  const home = tempDir('briefboard-tmpguard-home-');
  const ownTemp = path.join(home, 'temp');
  fs.mkdirSync(ownTemp);
  const madeFile = path.join(home, 'made');
  const file = path.join(home, 'fixture.test.js');
  fs.writeFileSync(file, source);

  // node:test sets NODE_TEST_CONTEXT in this process; inherited, it makes the
  // nested runner serialize to its parent instead of reporting (tests/hermetic-env.test.js).
  const env = { ...process.env, MADE_DIR: madeFile, TMPDIR: ownTemp, TMP: ownTemp, TEMP: ownTemp };
  delete env.NODE_TEST_CONTEXT;

  const res = spawnSync(process.execPath, ['--test', `--test-timeout=${FIXTURE_TIMEOUT_MS}`, file], {
    cwd: home,
    encoding: 'utf8',
    env,
    timeout: SPAWN_TIMEOUT_MS,
  });

  return {
    status: res.status,
    out: `${res.stdout}${res.stderr}`,
    ownTemp,
    made: fs.existsSync(madeFile) ? fs.readFileSync(madeFile, 'utf8') : '',
    left: fs.readdirSync(ownTemp).filter((name) => name.startsWith('briefboard-')),
  };
}

// The fixture has to have really made a directory, in the %TEMP% it was given.
// Without this the assertions below would all hold for a fixture that created
// nothing at all — the check would be about the fixture and not about the
// teardown (T-0182).
function reallyMadeOne(run) {
  assert.notStrictEqual(run.made, '', `the fixture created no directory at all:\n${run.out}`);
  assert.ok(
    run.made.startsWith(run.ownTemp),
    `the fixture wrote to ${run.made} instead of the %TEMP% it was given (${run.ownTemp})`
  );
}

describe('a test file removes the temporary directories it made (T-0261)', () => {
  it('a test that passes leaves none behind', () => {
    const run = runFixture(viaHelper(PASSES));
    assert.strictEqual(run.status, 0, run.out);
    reallyMadeOne(run);
    assert.strictEqual(fs.existsSync(run.made), false, `${run.made} outlived the run that made it`);
    assert.deepStrictEqual(run.left, []);
  });

  // The two cases the last line of a test body never reaches (T-0258).
  it('a test that FAILS leaves none behind', () => {
    const run = runFixture(viaHelper(FAILS));
    assert.notStrictEqual(run.status, 0, 'the fixture was supposed to fail');
    assert.match(run.out, /the body of this test failed/, 'it failed for some other reason');
    reallyMadeOne(run);
    assert.strictEqual(
      fs.existsSync(run.made),
      false,
      `${run.made} outlived a test that failed — the cleanup is not in a teardown`
    );
    assert.deepStrictEqual(run.left, []);
  });

  it('a test cut off at --test-timeout leaves none behind', () => {
    const run = runFixture(viaHelper(HANGS));
    assert.notStrictEqual(run.status, 0, 'the fixture was supposed to be cut off');
    reallyMadeOne(run);
    assert.strictEqual(
      fs.existsSync(run.made),
      false,
      `${run.made} outlived a test the runner ended at its time limit`
    );
    assert.deepStrictEqual(run.left, []);
  });

  // What the three above are worth: the same three fixtures, with the directory
  // taken straight from mkdtemp instead of from the helper, leak every time. This
  // is the suite as it stood before this task, reproduced.
  it('and the same fixtures leak when the directory does not come from the helper', () => {
    for (const [name, body] of [['passes', PASSES], ['fails', FAILS], ['hangs', HANGS]]) {
      const run = runFixture(viaRawMkdtemp(body));
      reallyMadeOne(run);
      assert.strictEqual(
        fs.existsSync(run.made),
        true,
        `${name}: a raw mkdtempSync was cleaned up by something, so the checks above prove nothing`
      );
      assert.deepStrictEqual(run.left, [path.basename(run.made)], `${name}: unexpected leftovers`);
    }
  });
});
