'use strict';

// T-0189: the suite's one wait, and the property no test of its own can show.
// A wait that stops waiting fails nothing by itself — every assertion after it
// still runs, against whatever the state happened to be — so the only place the
// mine can be caught is here, in tests written against the helper itself.
// Run with: npm test

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { waitFor, POLL_MS, SPAWN_WAIT_BUDGET_MS } = require('./helpers/wait.js');

// Small on purpose: these tests wait for real time, and every budget here is a
// deadline the test WANTS to reach.
const SHORT_MS = 200;

describe('waitFor awaits the condition it was given (T-0183, T-0189)', () => {
  it('an async predicate that is never true spends the whole budget', async () => {
    let polls = 0;
    const started = Date.now();
    await assert.rejects(
      () =>
        waitFor(
          async () => {
            polls++;
            return false;
          },
          SHORT_MS,
          'a condition that never arrives'
        ),
      /timed out after 200ms waiting for a condition that never arrives/
    );
    // The unfixed form returned on turn one, in ~1 ms: both numbers below are
    // the difference between waiting and only looking like it.
    assert.ok(polls > 1, `polled ${polls} time(s); an unawaited promise ends the wait on the first`);
    assert.ok(Date.now() - started >= SHORT_MS, 'gave up before its own deadline');
  });

  it('an async predicate is believed when it says false, and again when it says true', async () => {
    let polls = 0;
    await waitFor(async () => ++polls >= 3, SPAWN_WAIT_BUDGET_MS, 'the third poll');
    assert.strictEqual(polls, 3, 'returned on a promise rather than on what it resolved to');
  });

  it('a sync predicate still works, and returns as soon as it is true', async () => {
    let polls = 0;
    const started = Date.now();
    await waitFor(() => ++polls >= 2, SPAWN_WAIT_BUDGET_MS, 'the second poll');
    assert.strictEqual(polls, 2);
    assert.ok(Date.now() - started < SPAWN_WAIT_BUDGET_MS, 'a true condition ends the wait');
  });

  it('hands back what ended the wait, not just the fact that it ended', async () => {
    // The reason the ten copies could become one: tests/leftovers.test.js polled
    // for a pid and then used it. A wait that returns nothing sends the caller
    // back to the file for a second read (T-0223).
    assert.strictEqual(await waitFor(() => 4321, SHORT_MS, 'a pid'), 4321);
    assert.strictEqual(await waitFor(async () => 'ready', SHORT_MS, 'a state'), 'ready');
  });

  it('the condition is read at least once, whatever is left of the budget', async () => {
    let polls = 0;
    await waitFor(() => {
      polls++;
      return true;
    }, 0);
    assert.strictEqual(polls, 1, 'a spent budget must still let the condition be read once');
  });

  it('a condition that arrives during the last sleep is still seen', async () => {
    // One poll's worth of budget: the old shape checked the deadline before the
    // condition, so what became true in that gap was reported as a timeout.
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, POLL_MS);
    await waitFor(() => ready, POLL_MS, 'the late condition');
  });

  it('the failure names the budget it gave up on and the thing it waited for', async () => {
    await assert.rejects(
      () => waitFor(() => false, 30, 'the session to exit'),
      (err) => {
        assert.match(err.message, /after 30ms/);
        assert.match(err.message, /the session to exit/);
        return true;
      }
    );
  });
});
