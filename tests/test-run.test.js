'use strict';

// Tests for tools/test-run.mjs — the `npm test` wrapper that fails a run which
// left the working copy dirty (T-0111). Each case is a throwaway git repository
// with one fixture test file, so what is asserted is the guard's own behaviour.

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { tempDir } = require('./helpers/tmp.js');
const { waitFor } = require('./helpers/wait.js');
const { waitForExit } = require('./helpers/bounded.js');

const TEST_RUN = path.join(__dirname, '..', 'tools', 'test-run.mjs');
const WIN = process.platform === 'win32';

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

// A repository holding one tracked file and one fixture test.
//
// Three git processes and not six: the identity goes on the commit with `-c`
// rather than into three `git config` runs of its own. What a spawn costs is
// the machine's and not git's — measured under four concurrent full suites
// (Windows 11, node v24.18.0, 24 cores, 2026-08-17), building this repository
// cost 18.5-29.9s the old way against 7.5-13.8s this way, inside a test whose
// own limit is two minutes and which then spends most of the rest on the run.
// The commit stays: without it the fixture files are untracked before the run as
// well as after, and the guard, which compares the two, would have nothing to
// notice (T-0263).
function makeRepo(fixtureSource) {
  const root = fs.realpathSync(tempDir('briefboard-test-run-'));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  fs.writeFileSync(path.join(root, 'fixture.test.js'), fixtureSource);
  git(['init'], root);
  git(['add', '.'], root);
  git(
    ['-c', 'user.email=test@briefboard.invalid', '-c', 'user.name=briefboard test',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'init'],
    root
  );
  return root;
}

// The per-test limit the whole suite runs under, read off the wrapper that sets
// it so the two cannot drift apart.
const WRAPPER_SOURCE = fs.readFileSync(TEST_RUN, 'utf8');
const PER_TEST_LIMIT = WRAPPER_SOURCE.match(/TEST_TIMEOUT_MS = [^|]*\|\| '(\d+)'/);
if (!PER_TEST_LIMIT) throw new Error(`the per-test limit can no longer be read out of ${TEST_RUN}`);
const PER_TEST_LIMIT_MS = Number(PER_TEST_LIMIT[1]);

// The longest an honest, GREEN run of one trivial test has been measured to
// take here: four concurrent full suites, 2026-08-17. None of it was the guard
// working — 13.3s of node booting the wrapper, 30.3s of the inner `node --test`
// and 5.8s of `git status --porcelain` twice, which is the whole of what the
// wrapper spends on git and a tenth of the flat 60s that used to bound this
// call (T-0263).
const SLOWEST_LOADED_GUARD_MS = 49333;

// A bound between two things it must not cross: above what a loaded machine
// makes an honest run cost, and below the per-test limit, which otherwise ends
// the test first and leaves this one bounding nothing. It cannot simply be
// dropped in favour of that limit — spawnSync is synchronous, so --test-timeout
// cannot interrupt it, and that is why the bound is here at all.
const GUARD_TIMEOUT_MS = PER_TEST_LIMIT_MS * 0.75;

function runGuard(root, extraEnv = {}, extraArgs = [], target = 'fixture.test.js', nodeArgs = []) {
  // node:test sets NODE_TEST_CONTEXT in this process; inherited, it makes the
  // nested runner serialize to its parent instead of reporting.
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [...nodeArgs, TEST_RUN, ...extraArgs, target], {
    cwd: root,
    encoding: 'utf8',
    env,
    // The guard under test is what stops runs from hanging; if it ever fails to,
    // this test has to say so rather than join the hang.
    timeout: GUARD_TIMEOUT_MS,
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

// The same hang, except that the run is allowed to end once the limit has dealt
// with it: the timer is reachable from the test AFTER the hanging one, which
// Node runs only once the limit has ended that test (measured: `not ok 2 ...
// testTimeoutFailure` at 2053ms, `ok 3` at 2057ms, exit 1 at 2115ms).
//
// It cannot make its own assertion true (T-0182). While the hanging test runs
// the timer is live and unreachable, so the event loop cannot empty and Node
// cannot end that test any way but on the limit; if the limit never fires, the
// third test never runs, the release never happens, and the run hangs exactly as
// the fixture above does.
const RELEASING_HANG_TEST = `'use strict';
const { it } = require('node:test');
let held;
it('runs before the hanging one', () => {});
it('never finishes', () => new Promise(() => { held = setInterval(() => {}, 50); }));
it('runs after the hanging one', () => { clearInterval(held); });
`;

// Far out of the way of a per-test limit of 1500ms, and not a budget anything is
// expected to reach: in the run below it is the backstop for the limit failing
// to fire at all, and reaching it is a failure with its own message.
const SILENCE_OUT_OF_REACH_MS = '30000';

// How long the fixture below refuses to say anything. Synchronous and
// unconditional, so nothing but time passes and nothing about the machine
// decides whether it happens: on a quiet machine this run is slow to start
// because the fixture makes it slow, and the assertions do not depend on the
// machine ever being busy (T-0182).
const SLOW_START_MS = 5000;

// A loaded machine's start-up, staged: the run says nothing for SLOW_START_MS,
// then reports a passing test, then hangs. It is the situation the wrapper met
// in 2 of 4 concurrent suites — killed at a 2000ms budget before `node --test`
// had printed a line, so the message relayed a run that had reported nothing
// and the assertion on what it printed had nothing to match (T-0266).
//
// Measured, spawn to first byte of HANGING_TEST above: 0.6s idle, and 6.5s to
// 29.1s over eight reads under four concurrent full suites. Charged to the
// silence budget, that span is what spends it.
const SLOW_STARTING_HANG_TEST = `'use strict';
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SLOW_START_MS});
const { it } = require('node:test');
it('runs before the hanging one', () => {});
it('never finishes', () => new Promise(() => { setInterval(() => {}, 50); }));
`;

// Under the fixture's own delay, so a wrapper that charges start-up to it kills
// the run before a line is printed.
const SILENCE_UNDER_STARTUP_MS = String(SLOW_START_MS / 2);

// Over the delay AND over the worst start-up measured under four concurrent
// suites (29.1s), by the 2.5x this repository sizes such a margin at elsewhere
// (SCAN_MAX_TIMEOUT_MS, server/sessions.js). Reaching it is a failure about the
// machine and says so in its own message.
const STARTUP_OUT_OF_REACH_MS = '75000';

// The slowest honest test in this suite, measured across the whole run
// ("keeps at most 20 finished sessions", T-0124): the limit has to stay far
// above it, or a slow machine turns the backstop into a trap. A run under heavy
// load took 2.2x as long overall and still passed.
const SLOWEST_HONEST_TEST_MS = 17536;

describe('no test can run forever (T-0124)', () => {
  it('npm test gives every test file a per-test time limit, well above the slowest honest test', () => {
    const argsFile = path.join(tempDir('briefboard-args-'), 'args');
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

  // Two bounds, two runs, and in each one only the bound under test can fire.
  //
  // They used to share a run, and shared they raced (T-0259): the fixture that
  // never releases can only be ended by the watchdog, so the limit had to report
  // BEFORE the watchdog killed — 1500ms of limit plus the loaded machine's lag
  // against a 4500ms budget, i.e. 3s of margin. A loaded run spent it, the
  // watchdog killed first, and 'a test that hangs fails on the limit' asserted
  // against the watchdog's message. A raised budget would only have made that
  // margin bigger; what it needed was for the two not to be in the same run.

  // The per-test limit is far away (60s) and the silence budget is short, so
  // nothing inside `node --test` can end this run and what ends it is
  // unambiguous. Left equal, the runner's file-level timeout gets there first on
  // Node 22 and the test would be proving that instead (T-0245).
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
    // The run is not thrown away wholesale either: the wrapper relays what the
    // run printed before the kill, which is the only report a killed run leaves
    // and the reason the message points at `test:verbose` rather than nowhere.
    assert.match(out, /runs before the hanging one/, 'what the run printed before the kill');
  });

  // The same kill, on a run that was slow to START. A budget spent before the
  // run has spoken bounds how fast this machine can get a process going, which
  // is nothing the wrapper decides; what it is named for is a run that went
  // quiet after speaking, and only the second of those is a hang.
  it('a run slow to start is given its silence budget only once it has spoken', () => {
    const { status, out, killed } = runGuard(makeRepo(SLOW_STARTING_HANG_TEST), {
      BRIEFBOARD_TEST_TIMEOUT_MS: '60000',
      BRIEFBOARD_SILENCE_MS: SILENCE_UNDER_STARTUP_MS,
      BRIEFBOARD_STARTUP_MS: STARTUP_OUT_OF_REACH_MS,
    });
    assert.strictEqual(killed, false, 'the wrapper had to end it, not this test`s own timeout');
    assert.notStrictEqual(status, 0, 'the hang still has to fail the run');
    assert.match(out, new RegExp(`printed nothing for ${SILENCE_UNDER_STARTUP_MS}ms and was killed`));
    // The point of the whole change: the run got far enough to report a test,
    // and the kill relayed it. Charged the start-up, the budget was spent before
    // this line could exist.
    assert.match(out, /runs before the hanging one/, 'what the run printed before the kill');
  });

  // And the start-up span is bounded too, by the budget that says so. Without
  // this the test above would hold just as well for a wrapper that stopped
  // bounding start-up at all, and the fixture's delay could be no delay (T-0182).
  it('a run that never speaks at all is killed on the start-up budget, and says which it was', () => {
    const { status, out } = runGuard(makeRepo(SLOW_STARTING_HANG_TEST), {
      BRIEFBOARD_TEST_TIMEOUT_MS: '60000',
      BRIEFBOARD_SILENCE_MS: STARTUP_OUT_OF_REACH_MS,
      BRIEFBOARD_STARTUP_MS: SILENCE_UNDER_STARTUP_MS,
    });
    assert.notStrictEqual(status, 0, 'a run that had to be killed must fail');
    assert.match(out, new RegExp(`said nothing at all in the ${SILENCE_UNDER_STARTUP_MS}ms it had to start`));
    // A run killed before it spoke has no last line, so the message must not
    // send the reader looking for one.
    assert.doesNotMatch(out, /runs before the hanging one/);
    assert.doesNotMatch(out, /printed nothing for/, 'and it is not reported as silence');
  });

  it('a test that hangs fails on the limit, and the limit is what ends it', () => {
    // A small limit here on purpose: the real one is minutes away, and this is
    // about the mechanism, not the number.
    //
    // TAP, because a run ended over a hang is not one to trust with a summary:
    // it says WHY each test failed under the test, as it happens, rather than
    // keeping it for an end the run may not reach (T-0245).
    // BOTH of the wrapper's budgets are put out of reach, not just the silence
    // one. They derive from the per-test limit, and this test shrinks that limit
    // to 1500ms — which took the start-up budget down to 4500ms with it, under
    // the 6.5-29.1s this machine spends starting a run. Measured: the watchdog
    // killed the run before `node --test` had spoken, in 2 of 4 concurrent
    // suites, and the assertion below then failed on "the input did not match"
    // (T-0266, and the same trap T-0259 named).
    const { status, out, killed } = runGuard(
      makeRepo(RELEASING_HANG_TEST),
      {
        BRIEFBOARD_TEST_TIMEOUT_MS: '1500',
        BRIEFBOARD_SILENCE_MS: SILENCE_OUT_OF_REACH_MS,
        BRIEFBOARD_STARTUP_MS: STARTUP_OUT_OF_REACH_MS,
      },
      ['--test-reporter=tap']
    );
    assert.strictEqual(killed, false, 'the run had to end by itself, not by being killed');
    assert.notStrictEqual(status, 0, 'a run with a hanging test must fail');
    // Checked before the timeout itself, because it is the reason the timeout
    // would be missing: when the watchdog gets there first, /timed out/i fails
    // against a run that was killed for going quiet, and that is a diagnosis
    // nobody reads off "the input did not match" — it cost T-0259 a card.
    assert.doesNotMatch(
      out,
      /printed nothing for|said nothing at all in/,
      `a watchdog of the wrapper's fired inside the limit's own test; neither ` +
        `${SILENCE_OUT_OF_REACH_MS}ms of silence nor ${STARTUP_OUT_OF_REACH_MS}ms of start-up is ` +
        'out of reach of a 1500ms limit on this machine (T-0259, T-0266)'
    );
    // The limit is what ended the TEST. Anything else here — a cancellation, an
    // empty event loop — means the hang never reached the limit, and the guard
    // would then be reporting on a fixture that ends itself (T-0244).
    assert.match(out, /timed out/i);
    // The run is not thrown away wholesale: a test that finished before the hang
    // is still reported.
    assert.match(out, /^ok \d+ - runs before the hanging one$/m, out);
  });

  // The wrapper's budget is derived from the per-test limit rather than picked,
  // and the two live in different expressions — so what keeps them in step is
  // written down. A budget that drifted to twice the limit or below would start
  // killing honest runs: a `before` hook and the first test under it are each
  // bounded by the limit, so a healthy file can be quiet for two of them.
  // Both budgets, because both cover a span in which a healthy run may say
  // nothing: a `before` hook and the first test under it before the run has
  // spoken at all, and a hook between files after it has.
  for (const name of ['BRIEFBOARD_SILENCE_MS', 'BRIEFBOARD_STARTUP_MS']) {
    it(`the quiet the wrapper allows before ${name} fires is longer than a hook and a test together`, () => {
      const budget = WRAPPER_SOURCE.match(
        new RegExp(`${name} \\|\\| Number\\(TEST_TIMEOUT_MS\\) \\* (\\d+)`)
      );
      assert.ok(budget, `${name} must come from the per-test limit`);
      assert.ok(
        Number(budget[1]) > 2,
        `a hook and a test may each take the whole limit (${PER_TEST_LIMIT_MS}ms) with nothing to print`
      );
    });
  }

  // What bounds the calls above, written down: the number moved once already
  // because a loaded run did not fit in it, and the point of these two ends is
  // that the next such run is answered by a measurement rather than by another
  // raise (T-0259, T-0263).
  it('the timeout on the guard itself clears a loaded run and stays under the per-test limit', () => {
    assert.ok(
      GUARD_TIMEOUT_MS > SLOWEST_LOADED_GUARD_MS,
      `an honest green run has been measured at ${SLOWEST_LOADED_GUARD_MS}ms under four concurrent ` +
        `suites; a bound of ${GUARD_TIMEOUT_MS}ms kills it and reports only "status null"`
    );
    assert.ok(
      GUARD_TIMEOUT_MS < PER_TEST_LIMIT_MS,
      `at ${GUARD_TIMEOUT_MS}ms this bound never fires: the per-test limit (${PER_TEST_LIMIT_MS}ms) ` +
        'ends the test first, and a synchronous spawnSync is exactly what that limit cannot interrupt'
    );
  });
});

// T-0250: measured on an unpacked tarball of 0.2.0, `npm run test:verbose`
// printed "tests 0 / pass 0" and exited 0 — the package ships no tests/, the
// glob matched nothing, and node's runner calls a run of zero tests a success.
// A pattern that matched nothing is the way in here; what is asserted is the
// rule, which is that a run nothing came out of cannot end green.

const EMPTY_PATTERN = 'nothing-here/**/*.test.js';

function nodeTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

describe('a run that executed nothing is not a pass (T-0250)', () => {
  it('fails a run that executed no test, and names the pattern that found none', () => {
    const { status, out } = runGuard(makeRepo(CLEAN_TEST), {}, [], EMPTY_PATTERN);
    assert.notStrictEqual(status, 0, 'a run of zero tests must not exit 0');
    assert.match(out, /executed no tests/);
    assert.match(out, /nothing-here/, 'and must name what matched nothing');
    // The runner underneath reported success — the totals it printed are still
    // in the output, and they are what the wrapper had to overrule.
    assert.match(out, /pass 0/);
  });

  // The fixture cannot fail by itself (T-0182): the very same pattern, run the
  // way package.json ran `test:verbose` until now, exits 0 and says so.
  it('and node on its own calls that same run a success', () => {
    const root = makeRepo(CLEAN_TEST);
    const res = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=spec', EMPTY_PATTERN],
      { cwd: root, encoding: 'utf8', env: nodeTestEnv(), timeout: 60000 }
    );
    assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /pass 0/);
  });

  // The count is taken off the run's own events rather than off its printed
  // totals, which every reporter formats its own way — so the guard cannot be
  // one that only holds for the reporter it was written against.
  for (const reporter of ['spec', 'tap']) {
    it(`holds under --test-reporter=${reporter}`, () => {
      const { status, out } = runGuard(
        makeRepo(CLEAN_TEST),
        {},
        [`--test-reporter=${reporter}`],
        EMPTY_PATTERN
      );
      assert.notStrictEqual(status, 0);
      assert.match(out, /executed no tests/);
    });
  }

  // Counting means attaching a reporter of the wrapper's own, and naming any
  // reporter is what suppresses the rest: a guard that swallowed the output
  // asked for would have bought the count with the run's report.
  it('leaves the reporter it was asked for printing', () => {
    const { status, out } = runGuard(makeRepo(CLEAN_TEST), {}, ['--test-reporter=spec']);
    assert.strictEqual(status, 0, out);
    assert.match(out, /writes nothing/, 'the requested reporter must still reach stdout');
  });

  it('and prints a report when no reporter was asked for at all', () => {
    const { status, out } = runGuard(makeRepo(CLEAN_TEST));
    assert.strictEqual(status, 0, out);
    assert.match(out, /writes nothing/);
  });

  // What makes the rule reach `npm run test:verbose`, which is where it was
  // broken. It is also what keeps the per-test limit defined once: the verbose
  // script used to carry its own copy of the literal, and now inherits the one
  // the test above reads off a live run.
  it('every npm script that runs tests goes through the wrapper', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const direct = Object.entries(pkg.scripts).filter(([, command]) => /--test(\s|$)/.test(command));
    assert.deepStrictEqual(direct, [], 'node --test straight from a script gets none of these guards');
    assert.match(pkg.scripts.test, /tools\/test-run\.mjs/);
    assert.match(pkg.scripts['test:verbose'], /tools\/test-run\.mjs/);
  });
});

// T-0276. The wrapper used to be told the count through a file, in a
// `briefboard-run-` directory it made at load and removed on the way out.
// T-0265 got that removal onto every path the process can act on and that is
// where the shape ran out: a hard kill runs no handler at all — measured
// 2026-08-17 (Windows 11, node v24.18.0), a process killed with
// `process.kill(pid,'SIGINT')`, with 'SIGTERM' or with `taskkill /t /f` ran none
// of its handlers in all three cases — so an agent session or a CI runner that
// timed a run out still left one standing. The count comes over an IPC channel
// now and the directory is not made at all, which is what these cases assert.
//
// Every one of them hands the wrapper a temp root of its own, so what is checked
// is what THIS run made rather than what the machine has lying around.
//
// An empty root is a weak thing to assert on its own — a wrapper that made no
// directory AND lost the count would pass it (T-0182). Three things keep it an
// answer: the count still decides the exit code, which every case here pins;
// 'the count travels on the channel and nowhere else' shows the reporter writing
// nothing to a destination, so there is no file left for anything to read; and
// the cases below watch the root for the whole run rather than only after it, so
// a directory made and tidied away in time would still fail them.

const COUNT_DIR_PREFIX = 'briefboard-run-';
const COUNT_REPORTER = path.join(__dirname, '..', 'tools', 'test-count-reporter.mjs');

// node reads the temporary directory from TMPDIR on POSIX and from TEMP/TMP on
// Windows, so all three are set and the child cannot fall back to the real one.
function privateTemp() {
  const root = fs.realpathSync(tempDir('briefboard-tmproot-'));
  return { root, env: { TMPDIR: root, TEMP: root, TMP: root } };
}

function countDirsIn(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith(COUNT_DIR_PREFIX));
}

// Loaded with --import, so it patches child_process BEFORE the wrapper's own
// `import { spawnSync }` binds to it: a builtin's ESM facade is built out of the
// CJS object the first time the builtin is imported, and that is after --import
// has run (measured, node v24.18.0).
//
// The wrapper reads the working copy twice, before the run and after it, so
// throwing on the second read puts the exception exactly where it is wanted —
// after the run has finished, before the wrapper's own end, with the child
// already gone.
const THROW_AFTER_RUN_SHIM = `import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';

const cp = createRequire(import.meta.url)('node:child_process');
const real = cp.spawnSync;
let statusReads = 0;
cp.spawnSync = (file, args, options) => {
  if (file === 'git' && Array.isArray(args) && args[0] === 'status' && (statusReads += 1) === 2) {
    fs.writeFileSync(
      process.env.THROW_SNAPSHOT_OUT,
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('${COUNT_DIR_PREFIX}')).join('\\n')
    );
    throw new Error('injected: the wrapper threw with the run behind it');
  }
  return real(file, args, options);
};
`;

// How long the fixture below holds the run open after it has spoken. Bounded on
// purpose: on POSIX the wrapper spawns the runner into a process group of its
// own, so a kill aimed at the wrapper leaves the runner behind, and a run this
// test orphaned must not outlive the test that started it.
const HELD_RUN_MS = 10000;

// Reports a test at once, then keeps the run alive. The first half is what makes
// the kill below land at a meaningful moment: under the mechanism this card
// removed, the directory was made at module load, before the runner was ever
// spawned — so a run that has printed a line is a run well past the point where
// one used to exist.
const SPEAKS_THEN_WAITS_TEST = `'use strict';
const { it } = require('node:test');
it('says something at once', () => {});
it('then holds the run open', () => new Promise((resolve) => setTimeout(resolve, ${HELD_RUN_MS})));
`;

// Neither watchdog may fire while this test does its own waiting: the runs below
// are ended by the test, and a wrapper that killed them first would be answering
// a question nobody asked here.
const NO_WATCHDOG = {
  BRIEFBOARD_TEST_TIMEOUT_MS: '60000',
  BRIEFBOARD_SILENCE_MS: STARTUP_OUT_OF_REACH_MS,
  BRIEFBOARD_STARTUP_MS: STARTUP_OUT_OF_REACH_MS,
};

function startWrapper(repo, env) {
  const childEnv = { ...process.env, ...env, ...NO_WATCHDOG };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [TEST_RUN, 'fixture.test.js'], {
    cwd: repo,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, out: '' };
  const heard = (chunk) => {
    run.out += chunk;
  };
  child.stdout.on('data', heard);
  child.stderr.on('data', heard);
  return run;
}

// Every name of the forbidden shape that was ever visible in the root, not only
// the ones still there at the end. Checked after the fact only, the assertion
// would also pass against a wrapper that made a directory and got rid of it in
// time — which is the mechanism this card replaced, not the one it wants.
function watchRoot(root, seen) {
  const timer = setInterval(() => {
    for (const name of countDirsIn(root)) seen.add(name);
  }, 25);
  timer.unref();
  return () => clearInterval(timer);
}

// The hardest reach each platform has. `taskkill /t` takes the runner with the
// wrapper; on POSIX the runner leads a group of its own, so SIGKILL here reaches
// the wrapper alone and the fixture's own bound is what ends the rest.
function killOutright(child) {
  if (WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  child.kill('SIGKILL');
}

describe('the run has no temporary directory to leave behind (T-0276)', () => {
  // Watched throughout rather than read afterwards. Measured against the old
  // mechanism put back on purpose: the after-the-fact check passes, because that
  // wrapper removed its directory on a green run — which is the whole difference
  // between "cleaned up" and "never made", and this card is about the second.
  it('a green run makes none, at any moment while it runs', async () => {
    const { root, env } = privateTemp();
    const seen = new Set();
    const stopWatching = watchRoot(root, seen);
    let run;
    try {
      run = startWrapper(makeRepo(CLEAN_TEST), env);
      const code = await waitForExit(run.child, GUARD_TIMEOUT_MS);
      assert.strictEqual(code, 0, run.out);
    } finally {
      stopWatching();
    }
    assert.deepStrictEqual([...seen], [], 'the wrapper made a temporary directory of its own');
    assert.deepStrictEqual(countDirsIn(root), [], run.out);
  });

  // What replaced the file, shown to be the only thing that replaced it. Run
  // without a channel — spawnSync gives the child none — the reporter has
  // nowhere to send its number and writes not one byte to the destination it
  // was paired with. So there is no file to fall back to, which is the property
  // the brief asked for: two mechanisms for one number is how a guard rots.
  it('the count travels on the channel and nowhere else', () => {
    const destination = path.join(tempDir('briefboard-count-dest-'), 'executed');
    const res = spawnSync(
      process.execPath,
      [
        '--test',
        `--test-reporter=${pathToFileURL(COUNT_REPORTER).href}`,
        `--test-reporter-destination=${destination}`,
        'fixture.test.js',
      ],
      { cwd: makeRepo(CLEAN_TEST), encoding: 'utf8', env: nodeTestEnv(), timeout: GUARD_TIMEOUT_MS }
    );
    assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.strictEqual(
      fs.readFileSync(destination, 'utf8'),
      '',
      'the counting reporter wrote to a file: the mechanism T-0276 removed is back'
    );
  });

  // The wrapper kills the CHILD tree and then leaves by itself, so this path ends
  // in `process.exit`. The kill message is matched first: without it an empty
  // root could be a run that ended some other way entirely.
  it('a run killed by the silence watchdog leaves none behind', () => {
    const { root, env } = privateTemp();
    const { status, out } = runGuard(makeRepo(HANGING_TEST), {
      ...env,
      BRIEFBOARD_TEST_TIMEOUT_MS: '60000',
      BRIEFBOARD_SILENCE_MS: '2000',
      BRIEFBOARD_STARTUP_MS: STARTUP_OUT_OF_REACH_MS,
    });
    assert.match(out, /printed nothing for 2000ms and was killed/, 'the path under test');
    assert.notStrictEqual(status, 0);
    assert.deepStrictEqual(countDirsIn(root), [], out);
  });

  // The second watchdog. There are two of them since T-0266, and a directory
  // absent on one path is absent on neither by accident.
  it('a run killed by the start-up watchdog leaves none behind', () => {
    const { root, env } = privateTemp();
    const { status, out } = runGuard(makeRepo(SLOW_STARTING_HANG_TEST), {
      ...env,
      BRIEFBOARD_TEST_TIMEOUT_MS: '60000',
      BRIEFBOARD_SILENCE_MS: STARTUP_OUT_OF_REACH_MS,
      BRIEFBOARD_STARTUP_MS: SILENCE_UNDER_STARTUP_MS,
    });
    assert.match(
      out,
      new RegExp(`said nothing at all in the ${SILENCE_UNDER_STARTUP_MS}ms it had to start`),
      'the path under test'
    );
    assert.notStrictEqual(status, 0);
    assert.deepStrictEqual(countDirsIn(root), [], out);
  });

  // The path T-0265 built the `exit` hook for. There is no hook any more, and
  // the snapshot is what says why there does not need to be: at the moment the
  // wrapper crashes, with a whole run behind it, the shape does not exist.
  it('a wrapper that throws with the run behind it has nothing to leave', () => {
    const { root, env } = privateTemp();
    const shim = path.join(tempDir('briefboard-shim-'), 'throw-after-run.mjs');
    fs.writeFileSync(shim, THROW_AFTER_RUN_SHIM);
    const snapshot = path.join(tempDir('briefboard-snapshot-'), 'dirs');

    const { status, out } = runGuard(
      makeRepo(CLEAN_TEST),
      { ...env, THROW_SNAPSHOT_OUT: snapshot },
      [],
      'fixture.test.js',
      ['--import', pathToFileURL(shim).href]
    );
    assert.notStrictEqual(status, 0, 'a wrapper that crashed cannot report a pass');
    assert.match(out, /injected: the wrapper threw/, 'the crash has to be the injected one');
    const held = fs.readFileSync(snapshot, 'utf8').split('\n').filter(Boolean);
    assert.deepStrictEqual(held, [], 'the wrapper still makes a directory while it runs');
    assert.deepStrictEqual(countDirsIn(root), [], out);
  });

  // The ending no code inside the process can reach, and the reason this card
  // exists. Both halves of the kill are asserted where the platform has them:
  // `taskkill /t /f` and SIGKILL run no handler anywhere, and on POSIX a plain
  // SIGTERM is now fatal too, because the wrapper no longer intercepts one — it
  // used to only so that its own cleanup could still happen.
  it('a run killed outright leaves none behind, which is what no handler could ever manage', async () => {
    const { root, env } = privateTemp();
    const repo = makeRepo(SPEAKS_THEN_WAITS_TEST);
    const seen = new Set();
    const stopWatching = watchRoot(root, seen);
    try {
      const killed = startWrapper(repo, env);
      await waitFor(() => killed.out.length > 0, 30000, 'the run to print its first line');
      killOutright(killed.child);
      await waitForExit(killed.child);
      assert.deepStrictEqual([...seen], [], 'the wrapper made a temporary directory of its own');
      assert.deepStrictEqual(countDirsIn(root), [], killed.out);

      if (WIN) return;

      const signalled = startWrapper(repo, env);
      await waitFor(() => signalled.out.length > 0, 30000, 'the second run to print its first line');
      signalled.child.kill('SIGTERM');
      await waitForExit(signalled.child);
      assert.strictEqual(
        signalled.child.signalCode,
        'SIGTERM',
        'the wrapper intercepted the signal again; the handler existed only for a cleanup it no longer does'
      );
      assert.deepStrictEqual([...seen], [], 'the wrapper made a temporary directory of its own');
      assert.deepStrictEqual(countDirsIn(root), [], signalled.out);
    } finally {
      stopWatching();
    }
  });
});
