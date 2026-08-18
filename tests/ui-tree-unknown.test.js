'use strict';

// What the board shows of a session whose process tree it could not write down
// (T-0242).
//
// T-0236 taught the board to record the fact and to say it in its log, twice: at
// the failure, and again at the next start for the sessions the previous run left
// unrecorded. The card said nothing, so the one screen the person whose board is
// about to fall over is actually looking at showed an ordinary running session —
// while what it means is that nothing is written down to clean up by, and the
// agents under it keep costing.
//
// Same mechanics as tests/ui-session.test.js: the real ui/index.html script runs
// in a Node `vm` against a fake DOM, driven through `extraCode`.
// Run with: npm test

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadUiScript, createSandbox, runInSandbox } = require('./helpers/ui-harness.js');

const UI_SRC = loadUiScript();

function run(extraCode, overrides) {
  const sandbox = createSandbox(overrides);
  const raw = runInSandbox(UI_SRC, sandbox, extraCode);
  return raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : raw;
}

const TASK = {
  id: 'T-0001',
  type: 'feature',
  status: 'in_progress',
  priority: 'Major',
  created: '2026-01-01',
  closed: '',
  briefs: [],
  depends: [],
  blockedBy: [],
  awaitingAnswer: false,
  title: 'Being worked on',
  description: 'x',
};

const REASON = 'powershell: no answer within 30000ms';

// A running session record as /api/sessions hands it over.
function session(extra) {
  return {
    id: 'T-0001',
    kind: 'worker',
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    branch: 'task/T-0001',
    worktree: null,
    ...extra,
  };
}

// The card the board draws for that record.
function card(record, lang = 'en') {
  return run(`(function () {
    tasks = [${JSON.stringify(TASK)}];
    sessionsById = new Map([['T-0001', ${JSON.stringify(record)}]]);
    typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false;
    lang = '${lang}';
    render();
    return scrollContainers['in_progress'].children[0].innerHTML;
  })()`);
}

// The card's dialog for the same record.
function dialog(record, lang = 'en') {
  return run(`(function () {
    tasks = [${JSON.stringify(TASK)}];
    sessionsById = new Map([['T-0001', ${JSON.stringify(record)}]]);
    lang = '${lang}';
    openTask('T-0001');
    return modals[modals.length - 1].innerHTML;
  })()`);
}

describe('the mark for a session with no process record', () => {
  it('appears on the card of a session whose tree the board failed to read', () => {
    const html = card(session({ treeUnknown: true, treeReason: REASON }));

    assert.ok(html.includes('tree-flag'), html);
    assert.ok(html.includes('no process record'), html);
    // The reason is the board's own diagnostic and is carried through verbatim,
    // so the reader is not left guessing which read failed.
    assert.ok(html.includes(REASON), html);
  });

  it('stays away from a session the board has written a tree for', () => {
    const html = card(session({ descendants: [] }));

    assert.ok(html.includes('session-flag'), 'the ordinary session marker went missing');
    assert.ok(!html.includes('tree-flag'), html);
  });

  // Every session is `treeUnknown` from the moment it starts until the first
  // scan half a minute later. That is how a session begins, not a failure, and a
  // mark on every fresh card for half a minute is the marker teaching itself to
  // be ignored. A reason is written only where a read really failed.
  it('says nothing in the half minute before the first scan, where there is nothing to say', () => {
    const html = card(session({ treeUnknown: true }));

    assert.ok(html.includes('session-flag'), 'the ordinary session marker went missing');
    assert.ok(!html.includes('tree-flag'), html);
  });

  it('writes the whole of it into the dialog, where there is room for what it costs', () => {
    const html = dialog(session({ treeUnknown: true, treeReason: REASON }));

    assert.ok(html.includes('Processes not recorded'), html);
    assert.ok(html.includes(REASON), html);
    // Below it sits the one action a reader may want, which this block is not.
    assert.ok(html.includes('data-stop-session'), html);
  });

  it('leaves the dialog of an ordinary running session alone', () => {
    const html = dialog(session({ descendants: [] }));

    assert.ok(!html.includes('Processes not recorded'), html);
    assert.ok(html.includes('data-stop-session'), 'the stop action went missing');
  });

  it('is translated like the rest of the interface', () => {
    const texts = ['en', 'ru', 'ja'].map((l) => dialog(session({ treeUnknown: true, treeReason: REASON }), l));

    assert.strictEqual(new Set(texts).size, 3);
    // The reason is the board's diagnostic, not interface wording: it is the
    // same string in all three, as a session's exit code is.
    for (const html of texts) assert.ok(html.includes(REASON), html);
  });

  // The mark appears and goes away between scans, half a minute apart, while
  // nothing in the task itself moves — so the card must be repainted for it, the
  // way it already is for the session state and the watchdog's finding.
  it('repaints the card when the mark appears', () => {
    const changed = run(`(function () {
      tasks = [${JSON.stringify(TASK)}];
      sessionsById = new Map([['T-0001', ${JSON.stringify(session({ descendants: [] }))}]]);
      var quiet = cardSig(tasks[0]);
      sessionsById = new Map([['T-0001', ${JSON.stringify(
        session({ treeUnknown: true, treeReason: REASON })
      )}]]);
      return { quiet: quiet, marked: cardSig(tasks[0]) };
    })()`);

    assert.notStrictEqual(changed.quiet, changed.marked);
  });
});
