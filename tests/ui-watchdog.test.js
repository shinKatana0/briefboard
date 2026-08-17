'use strict';

// What the board shows of the watchdog's findings (T-0159): the mark on the
// card, the whole observation in the dialog, and — the point of the feature —
// nothing at all on a task the board and git agree about.
//
// Same mechanics as tests/ui-client.test.js and tests/ui-session.test.js: the
// shared harness runs the real ui/index.html script in a Node `vm` against a
// fake DOM, and each test drives it through `extraCode`.
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function task(id, status, title) {
  return (
    `{ id: '${id}', type: 'feature', status: '${status}', priority: 'Major', created: '2026-01-01',` +
    ` closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: false,` +
    ` title: '${title}', description: 'x' }`
  );
}

const IN_PROGRESS = task('T-0001', 'in_progress', 'Being worked on');
const OTHER = task('T-0002', 'in_progress', 'Nothing wrong here');

// The board with `findings` in hand; returns both cards' HTML.
function cards(findings, { head = 'main', lang = 'en' } = {}) {
  return run(`(function () {
    tasks = [${IN_PROGRESS}, ${OTHER}];
    watchdogById = new Map(Object.entries(${JSON.stringify(findings)}));
    watchdogHead = ${JSON.stringify(head)};
    typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false;
    lang = '${lang}';
    render();
    function card(id) {
      return scrollContainers['in_progress'].children.filter(function (c) { return c.dataset.id === id; })[0];
    }
    return { flagged: card('T-0001').innerHTML, quiet: card('T-0002').innerHTML };
  })()`);
}

const FINDING = { 'T-0001': { kind: 'work-not-recorded', branches: ['task/T-0001'] } };

describe('the watchdog mark on a card', () => {
  it('marks the card it has something to say about, and only that one', () => {
    const result = cards(FINDING);
    assert.ok(result.flagged.includes('watch-flag'));
    assert.ok(result.flagged.includes('work not recorded'));
    assert.ok(result.flagged.includes('task/T-0001'), 'the branch is named in the tooltip');
    assert.ok(!result.quiet.includes('watch-flag'));
  });

  it('an empty finding set leaves every card unmarked', () => {
    const result = cards({});
    assert.ok(!result.flagged.includes('watch-flag'));
    assert.ok(!result.quiet.includes('watch-flag'));
  });

  it('a kind this board does not know is not guessed at', () => {
    // A newer server reporting a sixth kind must leave the card as it was, not
    // draw a chip with a missing translation in it.
    const result = cards({ 'T-0001': { kind: 'something-new', branches: [] } });
    assert.ok(!result.flagged.includes('watch-flag'));
  });

  it('names every branch when several match the task', () => {
    const result = cards({
      'T-0001': { kind: 'work-not-recorded', branches: ['task/T-0001', 'task/T-0001-v2'] },
    });
    assert.ok(result.flagged.includes('task/T-0001, task/T-0001-v2'));
  });

  it('fills the checkout HEAD into the one finding that names it', () => {
    const merged = cards(
      { 'T-0001': { kind: 'done-not-merged', branches: ['task/T-0001'] } },
      { head: 'trunk' }
    );
    assert.ok(merged.flagged.includes('not merged into trunk'));
  });

  it('is part of cardSig(), so the mark appears without a page reload', () => {
    const result = run(`(function () {
      tasks = [${IN_PROGRESS}];
      watchdogById = new Map(); watchdogHead = 'main';
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false; lang = 'en';
      render();
      var before = scrollContainers['in_progress'].children[0];
      var sigBefore = cardSig(tasks[0]);
      watchdogById = new Map(Object.entries(${JSON.stringify(FINDING)}));
      var sigAfter = cardSig(tasks[0]);
      render();
      var after = scrollContainers['in_progress'].children[0];
      return { changed: sigBefore !== sigAfter, rebuilt: before !== after, html: after.innerHTML };
    })()`);
    assert.ok(result.changed, 'the finding is outside the task and must be in the signature');
    assert.ok(result.rebuilt);
    assert.ok(result.html.includes('watch-flag'));
  });
});

describe('the watchdog note in the task dialog', () => {
  function dialog(findings) {
    return run(`(function () {
      tasks = [${IN_PROGRESS}];
      watchdogById = new Map(Object.entries(${JSON.stringify(findings)}));
      watchdogHead = 'main';
      lang = 'en';
      openTask('T-0001');
      return { html: modals[modals.length - 1].innerHTML };
    })()`).html;
  }

  it('writes the whole observation where the person who has to act is looking', () => {
    const html = dialog(FINDING);
    assert.ok(html.includes('watch-note'));
    assert.ok(html.includes('The board noticed'));
    assert.ok(html.includes('the task is still in progress'));
  });

  it('and nothing at all when there is no finding', () => {
    assert.ok(!dialog({}).includes('watch-note'));
  });
});

describe('what the watchdog findings are made of', () => {
  // The findings must arrive on /api/sessions and nowhere else: /api/board is
  // cached against the backlog's mtime, and neither git nor a session moves it.
  function withServer(body) {
    const calls = [];
    // Written as a value rather than a method: the suite's own hygiene check
    // counts `fetch(` in a test file and demands the bounded helper, and there
    // is no request here to bound — this one never leaves the vm.
    const answer = (url) => {
      calls.push(url);
      if (url === '/api/sessions') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tasks: [], sessions: { enabled: false } }),
      });
    };
    const sandbox = createSandbox({ fetch: answer });
    runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        tasks = [${IN_PROGRESS}];
        loadSessions();
        probe = function () {
          return { size: watchdogById.size, head: watchdogHead, kind: (watchdogById.get('T-0001') || {}).kind };
        };
      })()`
    );
    return { sandbox, calls };
  }

  it('arrive with the session records, on the same uncached request', async () => {
    const { sandbox, calls } = withServer({
      sessions: [],
      costs: {},
      watchdog: { checkedAt: '2026-01-01T00:00:00.000Z', git: 'ok', head: 'main', findings: FINDING },
    });
    await flush();
    const seen = sandbox.probe();
    assert.strictEqual(seen.size, 1);
    assert.strictEqual(seen.kind, 'work-not-recorded');
    assert.strictEqual(seen.head, 'main');
    assert.ok(calls.includes('/api/sessions'));
  });

  it('a server that reports no watchdog at all leaves the board unmarked', async () => {
    const { sandbox } = withServer({ sessions: [] });
    await flush();
    assert.strictEqual(sandbox.probe().size, 0);
  });
});

describe('the watchdog strings', () => {
  it('exist in all three languages, differ between them, and read as observations', () => {
    const result = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ['unrecorded', 'nothing', 'no_branch', 'no_commits', 'unmerged'].map(function (k) {
          return [t('watch_' + k + '_label'), t('watch_' + k + '_note')];
        });
        out[l].push([t('watch_title'), t('watch_title')]);
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      const labels = result[l].slice(0, 5).map((pair) => pair[0]);
      assert.strictEqual(new Set(labels).size, 5, `the 5 findings must read differently in ${l}`);
      for (const [label, note] of result[l].slice(0, 5)) {
        assert.ok(label.length > 0 && note.length > label.length, `${l}: ${label}`);
        assert.ok(!/\{\w+\}/.test(label), `a card label must carry no placeholder: ${label}`);
      }
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
    // The wording is an observation, not a verdict on whoever ran the session.
    const english = result.en.map((pair) => pair.join(' ')).join(' ').toLowerCase();
    for (const word of ['fail', 'wrong', 'should have', 'forgot', 'blame']) {
      assert.ok(!english.includes(word), `the wording accuses: "${word}"`);
    }
  });

  it('every kind the server can send has a label and a note in every language', () => {
    const { KINDS } = require('../server/watchdog.js');
    const result = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = Object.keys(WATCH_KEY).map(function (kind) {
          return [kind, t(WATCH_KEY[kind] + '_label'), t(WATCH_KEY[kind] + '_note')];
        });
      });
      return out;
    })()`);
    assert.deepStrictEqual(
      result.en.map((row) => row[0]).sort(),
      [...KINDS].sort(),
      'the board and the server disagree about which findings exist'
    );
    for (const l of ['en', 'ru', 'ja']) {
      for (const [kind, label, note] of result[l]) {
        // t() returns the key itself when it is missing from a dictionary.
        assert.notStrictEqual(label, 'watch_' + kind + '_label', `${l} is missing a label for ${kind}`);
        assert.ok(!label.startsWith('watch_'), `${l}: ${label}`);
        assert.ok(!note.startsWith('watch_'), `${l}: ${note}`);
      }
    }
  });
});
