'use strict';

// T-0271: `waitForExit` bounded two different waits with one number, and the
// two are twenty times apart. Measured across the whole suite, quiet and under
// four concurrent suites (2026-08-23, Windows 11, node v24.18.0, 24 cores):
// an exit after a kill cost p50 26ms/33ms and at worst 150ms/940ms, while
// waiting out a process from spawn to exit cost p50 213ms/530ms and at worst
// 1.47s/6.73s — because the second is not an exit at all, it is a process
// start-up, the cost that grows x4.5 under load.
//
// What is asserted here is the part no timing round can show twice: that the
// budget still fails a process which never exits, and that the two numbers have
// not been collapsed back into one.
// Run with: npm test

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const {
  waitForExit,
  stopProcess,
  DEFAULT_EXIT_TIMEOUT_MS,
  SPAWNED_LIFETIME_BUDGET_MS,
} = require('./helpers/bounded.js');
const { SPAWN_WAIT_BUDGET_MS } = require('./helpers/wait.js');

// Short on purpose: this is a deadline the test WANTS to reach, so it may not
// be either of the real budgets.
const SHORT_MS = 300;

function neverExits() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

describe('waitForExit still fails a process that does not exit (T-0271)', () => {
  it('gives up at the budget it was handed and names the process and the number', async () => {
    const proc = neverExits();
    try {
      const started = Date.now();
      await assert.rejects(
        () => waitForExit(proc, SHORT_MS),
        new RegExp(`process ${proc.pid} did not exit within ${SHORT_MS}ms`)
      );
      // A budget that gave up early would bound nothing: the process is alive
      // and stays alive, so the only honest ending is the deadline itself.
      assert.ok(Date.now() - started >= SHORT_MS, 'gave up before its own deadline');
      assert.strictEqual(proc.exitCode, null, 'the wait must not have killed it');
    } finally {
      await stopProcess(proc);
    }
  });

  it('a process that has already gone is not waited for at all', async () => {
    const proc = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    // The two waits below carry different numbers on purpose, and tidying them
    // into one is what made this test fail on `main` (T-0314). The first is a
    // spawn-lifetime wait — node booting, running `-e`, exiting — which T-0271
    // measured at p50 213ms quiet and max 1.47s quiet, so SHORT_MS was under the
    // p50 of its own population as soon as the machine was busy. It gets the
    // budget this suite measured for that population.
    assert.strictEqual(await waitForExit(proc, SPAWNED_LIFETIME_BUDGET_MS), 7);
    // The second is the test's subject and keeps the short bound: the exit is
    // behind us, so it must answer from the process rather than arm a listener
    // nothing will ever fire, and only a tight number proves that.
    assert.strictEqual(await waitForExit(proc, SHORT_MS), 7);
  });
});

describe('the exit budget and the lifetime budget are two numbers (T-0271)', () => {
  // The decision this card made, and the one a later edit could quietly undo by
  // giving waitForExit the exit number back: an unqualified wait is a wait on a
  // process the test has just spawned, and what it pays for is start-up — the
  // same external circumstance SPAWN_WAIT_BUDGET_MS was measured for (T-0177)
  // and waitUntilReady() already uses.
  it('the lifetime budget is the suite\'s spawn-wait budget', () => {
    assert.strictEqual(SPAWNED_LIFETIME_BUDGET_MS, SPAWN_WAIT_BUDGET_MS);
  });

  it('the exit budget is tighter, because an exit after a kill is a cheap thing', () => {
    assert.ok(
      DEFAULT_EXIT_TIMEOUT_MS < SPAWNED_LIFETIME_BUDGET_MS,
      `an exit after a kill cost at most 940ms under four concurrent suites; ` +
        `${DEFAULT_EXIT_TIMEOUT_MS}ms must stay under the ${SPAWNED_LIFETIME_BUDGET_MS}ms a spawn is given`
    );
  });
});
