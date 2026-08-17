'use strict';

// Tests for tools/test-run.mjs — the `npm test` wrapper that fails a run which
// left the working copy dirty (T-0111). Each case is a throwaway git repository
// with one fixture test file, so what is asserted is the guard's own behaviour.

require('./helpers/env.js');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { removeTree } = require('./helpers/rm.js');

const TEST_RUN = path.join(__dirname, '..', 'tools', 'test-run.mjs');

const dirs = [];

after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

// A repository holding one tracked file and one fixture test.
function makeRepo(fixtureSource) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-test-run-')));
  dirs.push(root);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  fs.writeFileSync(path.join(root, 'fixture.test.js'), fixtureSource);
  git(['init'], root);
  git(['config', 'user.email', 'test@briefboard.invalid'], root);
  git(['config', 'user.name', 'briefboard test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['add', '.'], root);
  git(['commit', '-m', 'init'], root);
  return root;
}

function runGuard(root, extraEnv = {}, extraArgs = []) {
  // node:test sets NODE_TEST_CONTEXT in this process; inherited, it makes the
  // nested runner serialize to its parent instead of reporting.
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [TEST_RUN, ...extraArgs, 'fixture.test.js'], {
    cwd: root,
    encoding: 'utf8',
    env,
    // The guard under test is what stops runs from hanging; if it ever fails to,
    // this test has to say so rather than join the hang.
    timeout: 60000,
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, killed: res.signal !== null };
}

const CLEAN_TEST = `'use strict';
const { it } = require('node:test');
it('writes nothing', () => {});
`;

const DIRTYING_TEST = `'use strict';
const { it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
it('writes into a tracked repository file', () => {
  fs.writeFileSync(path.join(process.cwd(), 'tracked.txt'), 'polluted\\n');
});
`;

const UNTRACKED_TEST = `'use strict';
const { it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
it('leaves a new file behind in the repository', () => {
  fs.writeFileSync(path.join(process.cwd(), 'leftover.txt'), 'stray\\n');
});
`;

const FAILING_TEST = `'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
it('fails', () => assert.strictEqual(1, 2));
`;

describe('tools/test-run.mjs — the working copy must survive a run (T-0111)', () => {
  it('passes a green run that touched no repository file', () => {
    const { status, out } = runGuard(makeRepo(CLEAN_TEST));
    assert.strictEqual(status, 0, out);
    assert.ok(!/dirty/.test(out), out);
  });

  it('fails a green run that modified a tracked file, and names it', () => {
    const root = makeRepo(DIRTYING_TEST);
    const { status, out } = runGuard(root);
    assert.notStrictEqual(status, 0, 'a run that dirtied the working copy must not pass');
    assert.match(out, /left the working copy dirty/);
    assert.match(out, /tracked\.txt/);
    // The guard reports the pollution; it does not undo it.
    assert.strictEqual(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'polluted\n');
  });

  it('fails a run that left a new untracked file in the repository', () => {
    const { status, out } = runGuard(makeRepo(UNTRACKED_TEST));
    assert.notStrictEqual(status, 0);
    assert.match(out, /leftover\.txt/);
  });

  it('ignores changes that were already there before the run', () => {
    const root = makeRepo(CLEAN_TEST);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'edited by the developer\n');
    const { status, out } = runGuard(root);
    assert.strictEqual(status, 0, out);
  });

  it('still propagates a test failure', () => {
    const { status } = runGuard(makeRepo(FAILING_TEST));
    assert.notStrictEqual(status, 0);
  });
});

// T-0124: the suite hung forever three times in ~30 runs — a worker at 0% CPU,
// its server alive, no test ever failing. Whatever else is bounded, this is the
// backstop that makes "hangs forever" impossible: every test runs under a limit,
// and hitting it ends that test, fails the run, and lets the process leave.

// Reports the exec args the runner really started the test file with, so the
// limit is read off a live run rather than off the source that sets it. It goes
// to a file, not to stdout: the compact reporter prints a passing file's output
// nowhere, and writing inside the repository is what the guard above forbids.
const EXEC_ARGS_TEST = `'use strict';
const { it } = require('node:test');
const fs = require('node:fs');
it('reports how it was started', () => {
  fs.writeFileSync(process.env.EXEC_ARGS_OUT, process.execArgv.join(' '));
});
`;

// A hang is a wait that never comes WHILE something keeps the process alive —
// T-0124's own incident was a worker at 0% CPU with its server still listening.
// A bare `new Promise(() => {})` is not that: it holds no handle, so the event
// loop empties, and Node ends the test as `cancelledByParent` ("Promise
// resolution is still pending but the event loop has already resolved") without
// the limit ever being reached. That is what this fixture used to be, and it
// left the guard proving nothing on either platform (T-0244, T-0245): on Linux
// the limit was never reached, and on Windows, where it was, nothing ever ended
// the run. The timer is what makes this a hang, and nothing here helps the
// runner recover from it — that is the runner's job, and the point.
const HANGING_TEST = `'use strict';
const { it } = require('node:test');
it('runs before the hanging one', () => {});
it('never finishes', () => new Promise(() => { setInterval(() => {}, 50); }));
it('runs after the hanging one', () => {});
`;

// The slowest honest test in this suite, measured across the whole run
// ("keeps at most 20 finished sessions", T-0124): the limit has to stay far
// above it, or a slow machine turns the backstop into a trap. A run under heavy
// load took 2.2x as long overall and still passed.
const SLOWEST_HONEST_TEST_MS = 17536;

describe('no test can run forever (T-0124)', () => {
  it('npm test gives every test file a per-test time limit, well above the slowest honest test', () => {
    const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-args-')), 'args');
    dirs.push(path.dirname(argsFile));
    const { status, out } = runGuard(makeRepo(EXEC_ARGS_TEST), { EXEC_ARGS_OUT: argsFile });
    assert.strictEqual(status, 0, out);

    const execArgs = fs.readFileSync(argsFile, 'utf8');
    const limit = execArgs.match(/--test-timeout=(\d+)/);
    assert.ok(limit, `node --test must run with a per-test timeout; exec args: ${execArgs}`);
    assert.ok(
      Number(limit[1]) > SLOWEST_HONEST_TEST_MS * 3,
      `the limit (${limit[1]}ms) must leave room for the slowest honest test (${SLOWEST_HONEST_TEST_MS}ms)`
    );
  });

  // The wrapper's own bound, with the two budgets pulled apart so the case is
  // the same everywhere: the per-test limit is far away (60s) and the silence
  // budget is short, so nothing inside `node --test` can end this run and what
  // ends it is unambiguous. Left equal, the runner's file-level timeout gets
  // there first on Node 22 and the test would be proving that instead (T-0245).
  it('a run that goes silent is killed by the wrapper rather than left forever', () => {
    const { status, out, killed } = runGuard(makeRepo(HANGING_TEST), {
      BRIEFBOARD_TEST_TIMEOUT_MS: '60000',
      BRIEFBOARD_SILENCE_MS: '2000',
    });
    assert.strictEqual(killed, false, 'the wrapper had to end it, not this test`s own timeout');
    assert.notStrictEqual(status, 0, 'a run that had to be killed must fail');
    assert.match(out, /printed nothing for 2000ms and was killed/);
    // A message that only says "killed" turns a hang into a mystery: the report
    // of the run dies with the run, so what is left has to name the way to find
    // which test it was.
    assert.match(out, /test:verbose/, 'and where to look next');
  });

  it('a test that hangs fails on the limit, and the run still ends', () => {
    // A small limit here on purpose: the real one is minutes away, and this is
    // about the mechanism, not the number.
    //
    // TAP, because this run does not get to finish: a hang is ended from
    // outside, and every other reporter keeps WHY a test failed for a summary
    // printed at the end. TAP says it under the test, as it happens, which is
    // the only place this evidence can survive the kill (T-0245).
    const { status, out, killed } = runGuard(
      makeRepo(HANGING_TEST),
      { BRIEFBOARD_TEST_TIMEOUT_MS: '1500' },
      ['--test-reporter=tap']
    );
    // The third clause of the rule, and the one that was broken on Windows: the
    // hanging test's timer is still live and nothing in the fixture clears it,
    // so this run ends only because something outside it ended it (T-0245).
    // `killed` is this test's own 60s spawn timeout having to step in — the last
    // resort, and while it was the only thing working the guard proved nothing.
    assert.strictEqual(killed, false, 'the run had to end by itself, not by being killed');
    assert.notStrictEqual(status, 0, 'a run with a hanging test must fail');
    // The limit is what ended the TEST. Anything else here — a cancellation, an
    // empty event loop — means the hang never reached the limit, and the guard
    // would then be reporting on a fixture that ends itself (T-0244).
    assert.match(out, /timed out/i);
    // And the run is not thrown away wholesale: a test that finished before the
    // hang is still reported. Read off the per-test lines, not off the totals —
    // a run the wrapper had to kill never reaches its summary, which is the
    // price of the kill and is stated where the kill happens.
    assert.match(out, /^ok \d+ - runs before the hanging one$/m, out);
  });

  it('the verbose script carries the same limit as npm test', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const verbose = pkg.scripts['test:verbose'].match(/--test-timeout=(\d+)/);
    assert.ok(verbose, 'npm run test:verbose must also bound each test');

    const source = fs.readFileSync(TEST_RUN, 'utf8').match(/TEST_TIMEOUT_MS = [^|]*\|\| '(\d+)'/);
    assert.ok(source, 'tools/test-run.mjs must define the default limit');
    assert.strictEqual(verbose[1], source[1], 'both scripts must bound a test the same way');
  });

  // The wrapper's budget is derived from the per-test limit rather than picked,
  // and the two live in different expressions — so what keeps them in step is
  // written down. A budget that drifted to twice the limit or below would start
  // killing honest runs: a `before` hook and the first test under it are each
  // bounded by the limit, so a healthy file can be quiet for two of them.
  it('the silence the wrapper allows is longer than a hook and a test together', () => {
    const source = fs.readFileSync(TEST_RUN, 'utf8');
    const limit = Number(source.match(/TEST_TIMEOUT_MS = [^|]*\|\| '(\d+)'/)[1]);
    const silence = source.match(/BRIEFBOARD_SILENCE_MS \|\| Number\(TEST_TIMEOUT_MS\) \* (\d+)/);
    assert.ok(silence, 'the silence budget must come from the per-test limit');
    assert.ok(
      Number(silence[1]) > 2,
      `a hook and a test may each take the whole limit (${limit}ms) with nothing to print`
    );
  });
});
