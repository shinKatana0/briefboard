'use strict';

// Tests for what the board shows about an agent session (T-0077): the card
// marker, the session log dialog, and where that state comes from.
//
// Same mechanics as tests/ui-client.test.js — the shared harness
// (tests/helpers/ui-harness.js) runs the real ui/index.html script in a Node
// `vm` against a fake DOM, and each test drives it through `extraCode`. This
// lives in its own file only because the session view is a self-contained slice
// with its own fetch mock; the i18n key-parity check in ui-client.test.js still
// covers the strings added here.

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadUiScript, createSandbox, runInSandbox } = require('./helpers/ui-harness.js');

const UI_SRC = loadUiScript();

// Rehydrated through JSON so the value carries Node's realm prototypes — an
// object built inside the vm keeps that realm's Object.prototype and
// deepStrictEqual rejects it.
function run(extraCode, overrides) {
  const sandbox = createSandbox(overrides);
  const raw = runInSandbox(UI_SRC, sandbox, extraCode);
  const result = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : raw;
  return { result, sandbox };
}

// Lets the promises started inside the vm settle before the assertions look.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// A fetch that answers the session endpoints. `cfg` shapes the answers; the
// returned function records every request in `.calls`.
function sessionFetch(cfg) {
  const c = cfg || {};
  const calls = [];
  const fn = function (url, init) {
    calls.push({ url, opts: init });
    if (url === '/api/sessions') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sessions: c.sessions || [] }),
      });
    }
    if (/\/log$/.test(url)) {
      const status = c.logStatus || 200;
      return Promise.resolve({
        ok: status < 400,
        status,
        text: () => Promise.resolve(c.logText == null ? '' : c.logText),
        json: () => Promise.resolve({ error: 'gone' }),
        headers: {
          get(name) {
            if (name === 'X-Log-Total-Bytes') {
              return String(c.logTotal == null ? (c.logText || '').length : c.logTotal);
            }
            if (name === 'X-Log-Truncated') return c.truncated ? '1' : '0';
            return null;
          },
        },
      });
    }
    if (/\/stop$/.test(url)) {
      const status = c.stopStatus || 200;
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ tasks: [], sessions: { enabled: true, worker: true } }),
    });
  };
  fn.calls = calls;
  return fn;
}

function record(over) {
  return Object.assign(
    {
      id: 'T-0001',
      pid: 4242,
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      exitCode: null,
      signal: null,
      endedAt: null,
    },
    over || {}
  );
}

const RUNNING = record();
const EXITED = record({ status: 'exited', exitCode: 0, endedAt: '2026-01-01T00:01:00.000Z' });
// What the reconciliation in server/sessions.js leaves behind after a restart
// (T-0102): no exit code and no signal, because nobody was there to collect them.
const INTERRUPTED = record({ status: 'interrupted', endedAt: '2026-01-01T00:01:00.000Z' });

const TASK =
  "{ id: 'T-0001', type: 'feature', status: 'in_progress', priority: 'Major', created: '2026-01-01'," +
  " closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: false," +
  " title: 'Being worked on', description: 'Doing it.' }";
const OTHER_TASK =
  "{ id: 'T-0002', type: 'feature', status: 'in_progress', priority: 'Major', created: '2026-01-02'," +
  " closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: false," +
  " title: 'No session', description: '' }";

// =====================================================================
// the card marker
// =====================================================================
describe('the session marker on a card', () => {
  // Renders the board with `records` in the registry and returns both cards.
  function cards(records, extra) {
    return run(`(function () {
      tasks = [${TASK}, ${OTHER_TASK}];
      sessionsById = new Map(${JSON.stringify(records)}.map(function (s) { return [s.id, s]; }));
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false;
      lang = 'en';
      ${extra || ''}
      render();
      function card(id) {
        return scrollContainers['in_progress'].children.filter(function (c) { return c.dataset.id === id; })[0];
      }
      return { withSession: card('T-0001').innerHTML, without: card('T-0002').innerHTML };
    })()`).result;
  }

  it('the marker strings exist and differ in all three languages', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ['running', 'ended', 'stopped', 'failed', 'interrupted'].map(function (s) {
          return [t('session_' + s), t('session_' + s + '_hint')];
        });
      });
      return out;
    })()`);
    assert.strictEqual(result.en[0][0], 'session live');
    assert.strictEqual(result.ru[0][0], 'сессия идёт');
    assert.strictEqual(result.ja[0][0], 'セッション実行中');
    assert.strictEqual(result.en[4][0], 'session cut short');
    for (const l of ['en', 'ru', 'ja']) {
      const labels = result[l].map((pair) => pair[0]);
      assert.strictEqual(new Set(labels).size, 5, `the 5 states must read differently in ${l}`);
      for (const [label, hint] of result[l]) {
        assert.ok(hint.length > label.length, `the hint must explain the marker (${l})`);
      }
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
  });

  it('a live session marks its own card, and only its own', () => {
    const result = cards([RUNNING]);
    assert.ok(result.withSession.includes('session-flag running'));
    assert.ok(result.withSession.includes('session live'));
    assert.ok(result.withSession.includes('An agent session is running on this task'));
    assert.ok(!result.without.includes('session-flag'));
  });

  it('a finished session is told apart by how it ended', () => {
    const ok = cards([EXITED]);
    assert.ok(ok.withSession.includes('session-flag ended'));
    assert.ok(ok.withSession.includes('session done'));

    const failed = cards([record({ status: 'exited', exitCode: 1, endedAt: '2026-01-01T00:01:00.000Z' })]);
    assert.ok(failed.withSession.includes('session-flag failed'));
    assert.ok(failed.withSession.includes('session failed'));

    // Killed from the board: no exit code, a signal instead. "Stopped on
    // purpose" is not the same news as "crashed".
    const stopped = cards([
      record({ status: 'exited', exitCode: null, signal: 'SIGTERM', endedAt: '2026-01-01T00:01:00.000Z' }),
    ]);
    assert.ok(stopped.withSession.includes('session stopped'));
    assert.ok(!stopped.withSession.includes('session failed'));
  });

  // The whole point of T-0102: after a restart the card must say the session was
  // cut short instead of going silent, and it must say it without being opened.
  it('a session that went down with the board is marked on the card, not silently dropped', () => {
    const result = cards([INTERRUPTED]);
    assert.ok(result.withSession.includes('session-flag interrupted'));
    assert.ok(result.withSession.includes('session cut short'));
    assert.ok(result.withSession.includes('went down with the board'));
    // Not passed off as any of the endings the board actually witnessed.
    assert.ok(!result.withSession.includes('session done'));
    assert.ok(!result.withSession.includes('session failed'));
    assert.ok(!result.withSession.includes('session live'));
  });

  it('the interrupted marker is part of cardSig(), so the card repaints for it', () => {
    const { result } = run(`(function () {
      tasks = [${TASK}, ${OTHER_TASK}];
      sessionsById = new Map([['T-0001', ${JSON.stringify(RUNNING)}]]);
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false; lang = 'en';
      render();
      var sigBefore = cardSig(tasks[0]);
      sessionsById = new Map([['T-0001', ${JSON.stringify(INTERRUPTED)}]]);
      return { sigChanged: sigBefore !== cardSig(tasks[0]), state: sessionState('T-0001') };
    })()`);
    assert.strictEqual(result.sigChanged, true);
    assert.strictEqual(result.state, 'interrupted');
  });

  it('the marker label follows the UI language', () => {
    const result = cards([RUNNING], "lang = 'ru';");
    assert.ok(result.withSession.includes('сессия идёт'));
    assert.ok(!result.withSession.includes('session live'));
  });

  it('is a third, distinct marker: blocked + needs answer + session fit one card', () => {
    const result = cards(
      [RUNNING],
      "tasks[0].depends = ['T-9999']; tasks[0].blockedBy = ['T-9999']; tasks[0].awaitingAnswer = true;"
    );
    assert.ok(result.withSession.includes('blocked-flag'));
    assert.ok(result.withSession.includes('awaiting-flag'));
    assert.ok(result.withSession.includes('session-flag'));
    // Each marker keeps its own class, so none can borrow another's look, and
    // all three sit in the same wrapping .top row.
    for (const cls of ['blocked-flag', 'awaiting-flag', 'session-flag']) {
      assert.strictEqual((result.withSession.match(new RegExp(cls, 'g')) || []).length, 1);
    }
  });

  it('a task with no session renders exactly as before', () => {
    const result = cards([]);
    assert.ok(!result.withSession.includes('session-flag'));
    assert.ok(!result.without.includes('session-flag'));
  });

  it('the card repaints when the session dies, with nothing about the task changing', () => {
    const { result } = run(`(function () {
      tasks = [${TASK}, ${OTHER_TASK}];
      sessionsById = new Map([['T-0001', ${JSON.stringify(RUNNING)}]]);
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false; lang = 'en';
      render();
      function card() {
        return scrollContainers['in_progress'].children.filter(function (c) { return c.dataset.id === 'T-0001'; })[0];
      }
      var before = card();
      var sigBefore = cardSig(tasks[0]);
      // What the next /api/sessions delivers once the agent exits. \`tasks\` is
      // untouched: the backlog did not change, and that is the whole point.
      sessionsById = new Map([['T-0001', ${JSON.stringify(
        record({ status: 'exited', exitCode: 1, endedAt: '2026-01-01T00:01:00.000Z' })
      )}]]);
      render();
      var after = card();
      return {
        sigChanged: sigBefore !== cardSig(tasks[0]),
        nodeRebuilt: before !== after,
        liveBefore: before.innerHTML.indexOf('session-flag running') !== -1,
        failedAfter: after.innerHTML.indexOf('session-flag failed') !== -1,
      };
    })()`);
    assert.strictEqual(result.liveBefore, true);
    assert.strictEqual(result.sigChanged, true);
    assert.strictEqual(result.nodeRebuilt, true);
    assert.strictEqual(result.failedAfter, true);
  });
});

// =====================================================================
// where the state comes from
// =====================================================================
describe('reading session state', () => {
  it('loadSessions() reads its own endpoint, never the cached board', async () => {
    const fetchMock = sessionFetch({ sessions: [RUNNING] });
    const { sandbox } = run(
      `(function () {
        loadSessions();
        probe = function () {
          return { ids: [...sessionsById.keys()], status: sessionsById.get('T-0001').status };
        };
      })()`,
      { fetch: fetchMock }
    );
    await flush();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.probe())), {
      ids: ['T-0001'],
      status: 'running',
    });
    assert.ok(fetchMock.calls.some((call) => call.url === '/api/sessions'));
  });

  it('the "sessions" SSE event reloads sessions only; "changed" reloads the board', async () => {
    const created = [];
    const fetchMock = sessionFetch({ sessions: [RUNNING] });
    run('(function () {})()', {
      fetch: fetchMock,
      EventSource: function (url) {
        this.url = url;
        created.push(this);
      },
    });
    assert.strictEqual(created.length, 1, 'the board opened its SSE stream');
    const before = fetchMock.calls.length;

    created[0].onmessage({ data: 'sessions' });
    await flush();
    const afterSessions = fetchMock.calls.slice(before).map((call) => call.url);
    assert.deepStrictEqual(afterSessions, ['/api/sessions'], 'no board reload for a session event');

    created[0].onmessage({ data: 'changed' });
    await flush();
    const afterChanged = fetchMock.calls.slice(before + afterSessions.length).map((call) => call.url);
    assert.deepStrictEqual(afterChanged, ['/api/board']);
  });
});

// =====================================================================
// the session log dialog
// =====================================================================
describe('the session log dialog', () => {
  // Opens the log dialog for T-0001 with `session` in the registry, and returns
  // the sandbox carrying probes that report what the dialog put on screen.
  //
  // The dialog is opened in a second step, after the page's own start-up fetches
  // have settled, so `fetchMock.calls` counts only what the dialog itself did.
  async function openLog(session, fetchMock, extra) {
    const { sandbox } = run(
      `(function () {
        tasks = [${TASK}];
        lang = 'en';
        confirmCalls.length = 0; alertCalls.length = 0;
        ${extra || ''}
        // Seeded from the test, not from the page's own start-up read, so the
        // dialog opens against exactly the state under test.
        probeOpen = function () {
          sessionsById = new Map([['T-0001', ${JSON.stringify(session)}]]);
          return openSessionLog('T-0001');
        };
        function panel() { return modals[modals.length - 1].querySelector('.panel'); }
        probe = function () {
          var overlay = modals[modals.length - 1];
          var text = panel().querySelector('[data-log-text]');
          var stop = panel().querySelector('[data-log-stop]');
          return {
            logText: text.textContent,
            meta: panel().querySelector('[data-log-meta]').textContent,
            // Every place markup could have come from, so a log rendered as
            // HTML anywhere would show up here.
            markup: overlay.innerHTML + panel().innerHTML + text.innerHTML,
            logClass: text.className,
            stopDisplay: stop.style.display,
            stopDisabled: stop.disabled,
          };
        };
        probeStop = function () { panel().querySelector('[data-log-stop]').dispatch('click'); };
        probeRefresh = function () { panel().querySelector('[data-log-refresh]').dispatch('click'); };
      })()`,
      { fetch: fetchMock }
    );
    await flush();
    fetchMock.calls.length = 0;
    sandbox.probeOpen();
    await flush();
    return sandbox;
  }

  const logReads = (fetchMock) => fetchMock.calls.filter((call) => /\/log$/.test(call.url)).length;

  it('shows the log as text and never as markup', async () => {
    // The log is the output of a process briefboard only started: untrusted.
    const HOSTILE = 'starting\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>\ndone\n';
    const fetchMock = sessionFetch({ sessions: [RUNNING], logText: HOSTILE });
    const sandbox = await openLog(RUNNING, fetchMock);
    const shown = sandbox.probe();
    assert.strictEqual(shown.logText, HOSTILE, 'the log reaches the screen verbatim');
    assert.ok(!shown.markup.includes('<script>'), 'and never through innerHTML');
    assert.ok(!shown.markup.includes('onerror'));
    assert.deepStrictEqual(
      fetchMock.calls.map((call) => call.url),
      ['/api/session/T-0001/log']
    );
  });

  it('the dialog markup carries every hook the dialog code queries', async () => {
    // The fake DOM answers querySelector for any selector, so a hook renamed in
    // the markup but not in the code would pass every test above. In a browser
    // it would be a dialog that silently does nothing.
    const sandbox = await openLog(RUNNING, sessionFetch({ sessions: [RUNNING], logText: 'x\n' }));
    const markup = sandbox.probe().markup;
    for (const hook of ['data-log-text', 'data-log-meta', 'data-log-stop', 'data-log-refresh']) {
      assert.ok(markup.includes(hook), `the dialog must render ${hook}`);
    }
  });

  it('reports the size, and says so when only the tail was sent', async () => {
    const plain = await openLog(RUNNING, sessionFetch({ sessions: [RUNNING], logText: 'abc\n' }));
    assert.strictEqual(plain.probe().meta, 'session live · 4 bytes');

    const cut = await openLog(
      RUNNING,
      sessionFetch({ sessions: [RUNNING], logText: 'tail\n', logTotal: 900000, truncated: true })
    );
    assert.strictEqual(cut.probe().meta, 'session live · last 5 of 900000 bytes');
  });

  // T-0115: the pane was blank while an agent was working, and a person read
  // that as a broken board. The two empty logs are different situations and get
  // different words; neither of them is a guess about which agent is running.
  it('a live session with an empty log explains itself instead of showing nothing', async () => {
    const sandbox = await openLog(RUNNING, sessionFetch({ sessions: [RUNNING], logText: '' }));
    const shown = sandbox.probe();
    assert.match(shown.logText, /has not written anything yet/);
    assert.match(shown.logText, /only when they finish/);
    assert.ok(shown.logClass.includes('log-note'), 'the board\'s own words are marked as such');
  });

  it('a finished session with an empty log gets its own, different text', async () => {
    const live = await openLog(RUNNING, sessionFetch({ sessions: [RUNNING], logText: '' }));
    const done = await openLog(EXITED, sessionFetch({ sessions: [EXITED], logText: '' }));
    assert.strictEqual(done.probe().logText, '(the log is empty)');
    assert.notStrictEqual(done.probe().logText, live.probe().logText);
  });

  it('the explanation is translated, not English in every language', async () => {
    const ru = await openLog(RUNNING, sessionFetch({ sessions: [RUNNING], logText: '' }), "lang = 'ru';");
    const ja = await openLog(RUNNING, sessionFetch({ sessions: [RUNNING], logText: '' }), "lang = 'ja';");
    assert.match(ru.probe().logText, /пока ничего не написала/);
    assert.match(ja.probe().logText, /まだ何も出力していません/);
  });

  it('the first line of output replaces the explanation, over SSE', async () => {
    const cfg = { sessions: [RUNNING], logText: '' };
    const fetchMock = sessionFetch(cfg);
    const { sandbox } = run(
      `(function () {
        tasks = [${TASK}];
        lang = 'en';
        probeOpen = function () {
          sessionsById = new Map([['T-0001', ${JSON.stringify(RUNNING)}]]);
          return openSessionLog('T-0001');
        };
        probeText = function () {
          var el = modals[modals.length - 1].querySelector('.panel').querySelector('[data-log-text]');
          return { text: el.textContent, cls: el.className };
        };
        probeReload = function () { return loadSessions(); };
      })()`,
      { fetch: fetchMock }
    );
    await flush();
    sandbox.probeOpen();
    await flush();
    assert.match(sandbox.probeText().text, /has not written anything yet/);

    cfg.logText = 'first line\n';
    // What the 'sessions' SSE event does: reload the registry, repaint open logs.
    await sandbox.probeReload();
    await flush();
    const after = sandbox.probeText();
    assert.strictEqual(after.text, 'first line\n');
    assert.ok(!after.cls.includes('log-note'), 'the explanation is gone with its marker');
  });

  it('a log that is gone is reported, in the current language', async () => {
    const sandbox = await openLog(EXITED, sessionFetch({ sessions: [EXITED], logStatus: 404 }));
    assert.strictEqual(sandbox.probe().meta, 'The session log is no longer available');

    const ru = await openLog(EXITED, sessionFetch({ sessions: [EXITED], logStatus: 404 }), "lang = 'ru';");
    assert.strictEqual(ru.probe().meta, 'Лог сессии больше недоступен');
  });

  it('offers Stop only while there is a session to stop', async () => {
    const live = await openLog(RUNNING, sessionFetch({ sessions: [RUNNING], logText: 'x\n' }));
    assert.strictEqual(live.probe().stopDisabled, false);
    assert.strictEqual(live.probe().stopDisplay, '');

    const done = await openLog(EXITED, sessionFetch({ sessions: [EXITED], logText: 'x\n' }));
    assert.strictEqual(done.probe().stopDisabled, true);
    assert.strictEqual(done.probe().stopDisplay, 'none');

    // An interrupted session still has a log to read, but there is nothing left
    // to stop — and nothing offers to restart it either.
    const cut = await openLog(INTERRUPTED, sessionFetch({ sessions: [INTERRUPTED], logText: 'x\n' }));
    assert.strictEqual(cut.probe().stopDisabled, true);
    assert.strictEqual(cut.probe().stopDisplay, 'none');
    assert.strictEqual(cut.probe().logText, 'x\n');
    assert.ok(cut.probe().meta.startsWith('session cut short · '));
  });

  it('stopping asks for confirmation first, then POSTs the stop endpoint', async () => {
    const fetchMock = sessionFetch({ sessions: [RUNNING], logText: 'x\n' });
    const sandbox = await openLog(RUNNING, fetchMock);
    sandbox.probeStop();
    await flush();

    assert.deepStrictEqual(sandbox.confirmCalls, [
      'Stop the agent session for T-0001?\n\nThe agent is interrupted where it stands; ' +
        'whatever it has already written to disk stays.',
    ]);
    const stop = fetchMock.calls.filter((call) => /\/stop$/.test(call.url));
    assert.strictEqual(stop.length, 1);
    assert.strictEqual(stop[0].url, '/api/session/T-0001/stop');
    assert.strictEqual(stop[0].opts.method, 'POST');
    // No hand-made refresh: the kill produces an exit, and the exit produces the
    // 'sessions' event that repaints board and dialog alike.
    assert.strictEqual(sandbox.alertCalls.length, 0);
  });

  it('a declined confirmation sends nothing', async () => {
    const fetchMock = sessionFetch({ sessions: [RUNNING], logText: 'x\n' });
    const sandbox = await openLog(RUNNING, fetchMock, 'confirmReturn = false;');
    sandbox.probeStop();
    await flush();
    assert.strictEqual(fetchMock.calls.filter((call) => /\/stop$/.test(call.url)).length, 0);
  });

  it('a refused stop is reported to the user', async () => {
    const fetchMock = sessionFetch({ sessions: [RUNNING], logText: 'x\n', stopStatus: 409 });
    const sandbox = await openLog(RUNNING, fetchMock);
    sandbox.probeStop();
    await flush();
    assert.deepStrictEqual(sandbox.alertCalls, ['Failed to stop the session']);
  });

  it('a state change refreshes an open log; nothing polls it', async () => {
    const fetchMock = sessionFetch({ sessions: [EXITED], logText: 'final line\n' });
    const { sandbox } = run(
      `(function () {
        tasks = [${TASK}];
        lang = 'en';
        probeOpen = function () {
          sessionsById = new Map([['T-0001', ${JSON.stringify(RUNNING)}]]);
          return openSessionLog('T-0001');
        };
        probeMeta = function () {
          return modals[modals.length - 1].querySelector('.panel').querySelector('[data-log-meta]').textContent;
        };
        probeReload = function () { return loadSessions(); };
      })()`,
      { fetch: fetchMock }
    );
    await flush();
    fetchMock.calls.length = 0;
    sandbox.probeOpen();
    await flush();
    assert.strictEqual(logReads(fetchMock), 1, 'opening the dialog reads the log once');
    assert.strictEqual(sandbox.probeMeta(), 'session live · 11 bytes');

    // What the 'sessions' SSE event does once the agent exits.
    await sandbox.probeReload();
    await flush();
    assert.strictEqual(logReads(fetchMock), 2);
    assert.strictEqual(sandbox.probeMeta(), 'session done · 11 bytes');

    // And nothing keeps reading afterwards.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(logReads(fetchMock), 2);
  });

  it('the manual refresh re-reads the log without touching the session', async () => {
    const fetchMock = sessionFetch({ sessions: [RUNNING], logText: 'so far\n' });
    const sandbox = await openLog(RUNNING, fetchMock);
    sandbox.probeRefresh();
    await flush();
    assert.strictEqual(logReads(fetchMock), 2);
    assert.strictEqual(fetchMock.calls.filter((call) => /\/stop$/.test(call.url)).length, 0);
  });

  it('the task dialog offers the log only for a task that has a session', () => {
    const { result } = run(`(function () {
      tasks = [${TASK}, ${OTHER_TASK}];
      sessionsById = new Map([['T-0001', ${JSON.stringify(RUNNING)}]]);
      lang = 'en';
      openTask('T-0001');
      var withSession = modals[modals.length - 1].innerHTML;
      closeTop();
      openTask('T-0002');
      return { withSession: withSession, without: modals[modals.length - 1].innerHTML };
    })()`);
    assert.ok(result.withSession.includes('data-session-log="T-0001"'));
    assert.ok(result.withSession.includes('Session log'));
    assert.ok(!result.without.includes('data-session-log'));
  });

  it('the log opens on top of the task dialog, and Esc peels it back off', () => {
    const { result } = run(`(function () {
      tasks = [${TASK}];
      sessionsById = new Map([['T-0001', ${JSON.stringify(RUNNING)}]]);
      lang = 'en';
      openTask('T-0001');
      var afterTask = modals.length;
      openSessionLog('T-0001');
      var afterLog = modals.length;
      document.dispatch('keydown', { key: 'Escape' });
      return { afterTask: afterTask, afterLog: afterLog, afterEsc: modals.length };
    })()`);
    assert.strictEqual(result.afterTask, 1);
    assert.strictEqual(result.afterLog, 2);
    assert.strictEqual(result.afterEsc, 1);
  });
});

// =====================================================================
// starting the review session (T-0122)
// =====================================================================
// A button in the card's dialog rather than a drop: the task is already in
// `review`, so there is no column to move it into. It is confirmed, it starts a
// session and nothing else, and a board with no command configured does not
// offer it at all.
describe('the review action on a card in review', () => {
  const REVIEW_TASK =
    "{ id: 'T-0001', type: 'feature', status: 'review', priority: 'Major', created: '2026-01-01'," +
    " closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: false," +
    " title: 'Submitted', description: 'Done.' }";

  // Opens the dialog of `taskSrc` with the given session configuration, and
  // leaves a `probeClick()` on the sandbox that presses the review button.
  function dialog({ taskSrc = REVIEW_TASK, orchestrator = true, overrides = {} } = {}) {
    const sandbox = createSandbox(overrides);
    const raw = runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        tasks = [${taskSrc}];
        sessionsById = new Map();
        lang = 'en';
        sessionsConfigured = { enabled: true, worker: true, orchestrator: ${orchestrator},
          profiles: [], profileUsedBy: {} };
        openTask('T-0001');
        var overlay = modals[modals.length - 1];
        probeClick = function () {
          return overlay.querySelector('[data-review-session]').dispatch('click');
        };
        return { html: overlay.innerHTML };
      })()`
    );
    return { html: JSON.parse(JSON.stringify(raw)).html, sandbox };
  }

  // A fetch that records what it was asked and answers with `body`.
  function recordingFetch(body, calls) {
    return function (url, init) {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
  }

  it('offers the action on a task in review when a command is configured', () => {
    const { html } = dialog({});
    assert.ok(html.includes('data-review-session="T-0001"'));
    assert.ok(html.includes('Start the review session'));
  });

  // T-0145: the action is found by its caption and its own line, not by an
  // accent colour — colour on this board means status.
  it('the action is a captioned block of its own, and no colour is spent on it', () => {
    const { html } = dialog({});
    assert.ok(html.includes('<div class="card-action"><h3>Review session</h3>'));
    assert.ok(html.includes('<div class="card-action-row">'), 'the button sits on a line of its own');
    const block = html.slice(html.indexOf('card-action'), html.indexOf('</button>'));
    assert.ok(!/style="[^"]*(color|background)/.test(block), 'no inline colour on the action: ' + block);
    assert.ok(/class="tf-btn"/.test(block), 'the button keeps the neutral chip class');
  });

  // T-0146: a review session that leaves the status untouched is the normal
  // outcome, while a briefing or worker session doing the same means trouble.
  // Said in advance, as a property, not as an excuse once the card has not moved.
  it('says beforehand that the review session writes a verdict and sets no status', () => {
    const { html } = dialog({});
    assert.ok(html.includes('appends a verdict to this description'));
    assert.ok(html.includes('It sets no status and merges nothing'));
    // The block is before the description, so it is read before the verdict is
    // looked for and not after.
    assert.ok(html.indexOf('card-action') < html.indexOf('class="desc"'));
  });

  // T-0144: the button used to be simply absent, and it was searched for.
  // T-0305: the name it teaches is the documented one. The legacy variable goes
  // on configuring the session and is not deprecated, but a board telling a user
  // what to set names the one they should be setting — and names only it, or the
  // sentence stops being an instruction.
  it('names BRIEFBOARD_REVIEW_CMD instead of falling silent when nothing is configured', () => {
    const { html } = dialog({ orchestrator: false });
    assert.ok(!html.includes('data-review-session'), 'still no button: it could do nothing');
    assert.ok(html.includes('Review session'), 'the block stays, so the absence is explained');
    assert.ok(html.includes('Not configured on this board'));
    assert.ok(html.includes('BRIEFBOARD_REVIEW_CMD'));
    assert.ok(!html.includes('BRIEFBOARD_ORCHESTRATOR_CMD'));
  });

  it('offers nothing on a task that is not in review', () => {
    const { html } = dialog({ taskSrc: TASK });
    assert.ok(!html.includes('data-review-session'));
  });

  // "In review and only there": someone who never runs a review session must not
  // read about one on every card they open.
  it('says nothing at all about the review session outside review, configured or not', () => {
    for (const orchestrator of [true, false]) {
      const { html } = dialog({ taskSrc: TASK, orchestrator });
      assert.ok(!html.includes('Review session'), 'no caption outside review');
      assert.ok(!html.includes('BRIEFBOARD_REVIEW_CMD'), 'no variable name outside review');
    }
  });

  it('asks first, and says what the session will not do', async () => {
    const calls = [];
    const { sandbox } = dialog({
      overrides: { fetch: recordingFetch({ session: 'started' }, calls) },
    });
    await sandbox.probeClick();

    assert.strictEqual(sandbox.confirmCalls.length, 1, 'the click must ask first');
    assert.match(sandbox.confirmCalls[0], /T-0001/);
    // What it will NOT do is the part a reader would otherwise assume.
    assert.match(sandbox.confirmCalls[0], /sets no status/);
    assert.match(sandbox.confirmCalls[0], /merges nothing/);
    // The board's own start-up requests (/api/board, /api/sessions) share this
    // mock; only what the click sent is under test here.
    const sent = calls.filter((c) => /\/review$/.test(c.url));
    assert.deepStrictEqual(sent.map((c) => c.url), ['/api/task/T-0001/review']);
    assert.strictEqual(sent[0].init.method, 'POST');
  });

  it('a refused confirmation sends nothing at all', async () => {
    const calls = [];
    const { sandbox } = dialog({
      overrides: { confirm: () => false, fetch: recordingFetch({ session: 'started' }, calls) },
    });
    await sandbox.probeClick();
    assert.deepStrictEqual(calls.filter((c) => /\/review$/.test(c.url)), []);
  });

  it('a 200 that started nothing is reported — the click has no transition behind it', async () => {
    const alerts = [];
    const { sandbox } = dialog({
      overrides: {
        fetch: recordingFetch({ session: 'limit' }, []),
        alert: (msg) => alerts.push(msg),
      },
    });
    await sandbox.probeClick();
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0], /did not start: limit/);
  });

  it('a started session says nothing: the board repaints on its own event', async () => {
    const alerts = [];
    const { sandbox } = dialog({
      overrides: {
        fetch: recordingFetch({ ok: true, session: 'started' }, []),
        alert: (msg) => alerts.push(msg),
      },
    });
    await sandbox.probeClick();
    assert.deepStrictEqual(alerts, []);
  });

  it('a refusal from the server is reported in the board\'s own words', async () => {
    const alerts = [];
    const { sandbox } = dialog({
      overrides: {
        fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }),
        alert: (msg) => alerts.push(msg),
      },
    });
    await sandbox.probeClick();
    assert.deepStrictEqual(alerts, ['Failed to start the review session']);
  });

  it('the answer box on a review task offers to restart the review session', () => {
    const { result } = run(`(function () {
      tasks = [{ id: 'T-0001', type: 'feature', status: 'review', priority: 'Major',
        created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [],
        awaitingAnswer: true, title: 'Asked', description: '### Session questions\\n- Which?' }];
      sessionsById = new Map();
      lang = 'en';
      sessionsConfigured = { enabled: true, worker: true, orchestrator: true, profiles: [], profileUsedBy: {} };
      openTask('T-0001');
      return { html: modals[modals.length - 1].innerHTML };
    })()`);
    assert.ok(result.html.includes('Restart the review session'));
    assert.ok(!result.html.includes('Restart the worker session'));
  });

  it('the review strings exist and differ in all three languages', () => {
    const KEYS = [
      'review_session_button', 'review_session_confirm', 'review_session_failed',
      'review_session_refused', 'answer_restart_orchestrator', 'cost_kind_orchestrator',
      'review_session_title', 'review_session_what', 'review_session_unconfigured',
    ];
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ${JSON.stringify(KEYS)}.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      for (let i = 0; i < KEYS.length; i++) assert.ok(result[l][i], `${l}.${KEYS[i]} is missing`);
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
  });
});

// =====================================================================
// putting a worker back on a card whose session died (T-0333)
// =====================================================================
// The card is already `in_progress` and stays there: this action starts a
// session and writes no status, which is why it lives among the session blocks
// and not among the closing ones. Until it existed the only way to reach a
// worker from here was the answer form's restart box, which meant writing a
// question nobody asked into the description.
describe('the resume action on a card in progress', () => {
  const WORKING_TASK = TASK; // `in_progress`, with no session on it

  // Opens the dialog of `taskSrc` with the given session configuration and
  // registry, and leaves a `probeClick()` that presses the resume button.
  function dialog({ taskSrc = WORKING_TASK, worker = true, sessions = '[]', overrides = {} } = {}) {
    const sandbox = createSandbox(overrides);
    const raw = runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        tasks = [${taskSrc}];
        sessionsById = new Map(${sessions}.map(function (r) { return [r.id, r]; }));
        lang = 'en';
        sessionsConfigured = { enabled: true, worker: ${worker}, orchestrator: true,
          profiles: [], profileUsedBy: {} };
        openTask('T-0001');
        var overlay = modals[modals.length - 1];
        probeClick = function () {
          return overlay.querySelector('[data-resume-session]').dispatch('click');
        };
        return { html: overlay.innerHTML };
      })()`
    );
    return { html: JSON.parse(JSON.stringify(raw)).html, sandbox };
  }

  function recordingFetch(status, body, calls) {
    return function (url, init) {
      calls.push({ url, init });
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    };
  }

  it('offers the action on a card under work when a worker command is configured', () => {
    const { html } = dialog({});
    assert.ok(html.includes('data-resume-session="T-0001"'), html);
    assert.ok(html.includes('Resume the work'));
  });

  it('is a captioned block of its own, and says beforehand that no status is written', () => {
    const { html } = dialog({});
    assert.ok(html.includes('<div class="card-action"><h3>Worker session</h3>'), html);
    assert.ok(html.includes('<div class="card-action-row">'), 'the button sits on a line of its own');
    // The property a reader would otherwise have to guess at: this dispatch moves
    // nothing, so a card that has not moved is what success looks like.
    assert.ok(html.includes('The task stays In Progress; no status is written.'));
  });

  it('names BRIEFBOARD_WORKER_CMD instead of falling silent when nothing is configured', () => {
    const { html } = dialog({ worker: false });
    assert.ok(!html.includes('data-resume-session'), 'no button: it could do nothing');
    assert.ok(html.includes('Worker session'), 'the block stays, so the absence is explained');
    assert.ok(html.includes('BRIEFBOARD_WORKER_CMD'));
  });

  // The board's half of the rule the endpoint enforces: the status says an agent
  // is on the task either way, so what decides is the registry.
  it('offers no button while a session is genuinely running, and says why', () => {
    const { html } = dialog({ sessions: JSON.stringify([RUNNING]) });
    assert.ok(!html.includes('data-resume-session'), html);
    assert.ok(html.includes('Worker session'), 'the block explains itself rather than vanishing');
    assert.ok(html.includes('A session is already running on this task'), html);
  });

  it('says nothing at all about it outside in_progress, configured or not', () => {
    const REVIEWED = WORKING_TASK.replace("status: 'in_progress'", "status: 'review'");
    for (const worker of [true, false]) {
      const { html } = dialog({ taskSrc: REVIEWED, worker });
      assert.ok(!html.includes('data-resume-session'), 'no button outside in_progress');
      assert.ok(!html.includes('Worker session'), 'and no caption either');
    }
  });

  it('asks first, then posts the same endpoint the CLI does', async () => {
    const calls = [];
    const { sandbox } = dialog({
      overrides: { fetch: recordingFetch(200, { ok: true, status: 'in_progress', session: 'started' }, calls) },
    });
    await sandbox.probeClick();

    assert.strictEqual(sandbox.confirmCalls.length, 1, 'the click must ask first');
    assert.match(sandbox.confirmCalls[0], /T-0001/);
    assert.match(sandbox.confirmCalls[0], /stays In Progress/, 'the card does not move, and it says so');
    const sent = calls.filter((c) => /\/resume$/.test(c.url));
    assert.deepStrictEqual(sent.map((c) => c.url), ['/api/task/T-0001/resume']);
    assert.strictEqual(sent[0].init.method, 'POST');
  });

  it('a refused confirmation sends nothing at all', async () => {
    const calls = [];
    const { sandbox } = dialog({
      overrides: { confirm: () => false, fetch: recordingFetch(200, { session: 'started' }, calls) },
    });
    await sandbox.probeClick();
    assert.deepStrictEqual(calls.filter((c) => /\/resume$/.test(c.url)), []);
  });

  it('a started session says nothing: the board repaints on its own event', async () => {
    const alerts = [];
    const { sandbox } = dialog({
      overrides: {
        fetch: recordingFetch(200, { ok: true, status: 'in_progress', session: 'started' }, []),
        alert: (msg) => alerts.push(msg),
      },
    });
    await sandbox.probeClick();
    assert.deepStrictEqual(alerts, []);
  });

  // A 200 whose dispatch reached no session. There is no rollback to report here
  // — the card never moved — so the whole of what is said is that nothing started.
  it('a 200 that started nothing is reported, and says nothing about a card coming back', async () => {
    const alerts = [];
    const { sandbox } = dialog({
      overrides: {
        fetch: recordingFetch(200, { ok: true, status: 'in_progress', session: 'limit' }, []),
        alert: (msg) => alerts.push(msg),
      },
    });
    await sandbox.probeClick();
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0], /did not start: limit/);
    assert.doesNotMatch(alerts[0], /put back|Ready|Review/, 'nothing was moved, so nothing came back');
  });

  it("a refusal names the reason in the board's own words", async () => {
    const alerts = [];
    const { sandbox } = dialog({
      overrides: {
        fetch: recordingFetch(409, { error: 'no', reason: 'no-branch' }, []),
        alert: (msg) => alerts.push(msg),
      },
    });
    await sandbox.probeClick();
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0], /this task has no branch/, alerts[0]);
  });

  // A refusal the board has no words for still says something: the fallback is
  // the one every other action uses.
  it('a refusal with no reason falls back to the plain failure line', async () => {
    const alerts = [];
    const { sandbox } = dialog({
      overrides: {
        fetch: recordingFetch(409, {}, []),
        alert: (msg) => alerts.push(msg),
      },
    });
    await sandbox.probeClick();
    assert.deepStrictEqual(alerts, ['Failed to resume the work']);
  });

  it('the resume strings exist and differ in all three languages', () => {
    const KEYS = [
      'resume_session_title', 'resume_session_what', 'resume_session_button',
      'resume_session_unconfigured', 'resume_session_confirm', 'resume_session_failed',
      'resume_session_refused', 'resume_why_no_branch',
    ];
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ${JSON.stringify(KEYS)}.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      for (let i = 0; i < KEYS.length; i++) assert.ok(result[l][i], `${l}.${KEYS[i]} is missing`);
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
  });
});

// =====================================================================
// starting the briefing session by hand (T-0141)
// =====================================================================
// The drop into Open starts one only for a task nobody has briefed yet, so this
// button is how a brief gets revisited. It is offered for any task in `open` —
// briefed or not — because only a human can say a brief has gone stale.
describe('the briefing action on a card in open', () => {
  const OPEN_TASK = (briefs) =>
    "{ id: 'T-0001', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-01'," +
    ` closed: '', briefs: ${briefs}, depends: [], blockedBy: [], awaitingAnswer: false,` +
    " title: 'Being refined', description: 'Notes.' }";

  function dialog({ taskSrc = OPEN_TASK("['T-0001-01']"), enabled = true, overrides = {} } = {}) {
    const sandbox = createSandbox(overrides);
    const raw = runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        tasks = [${taskSrc}];
        sessionsById = new Map();
        lang = 'en';
        sessionsConfigured = { enabled: ${enabled}, worker: true, orchestrator: true,
          profiles: [], profileUsedBy: {} };
        openTask('T-0001');
        var overlay = modals[modals.length - 1];
        probeClick = function () {
          return overlay.querySelector('[data-briefing-session]').dispatch('click');
        };
        return { html: overlay.innerHTML };
      })()`
    );
    return { html: JSON.parse(JSON.stringify(raw)).html, sandbox };
  }

  function recordingFetch(body, calls) {
    return function (url, init) {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
  }

  it('is offered on a briefed task in open — a brief can go stale, and the action must not vanish', () => {
    const { html } = dialog({});
    assert.ok(html.includes('data-briefing-session="T-0001"'));
    assert.ok(html.includes('Start the briefing session'));
  });

  it('is offered on an unbriefed task in open too: a session may have died before writing one', () => {
    const { html } = dialog({ taskSrc: OPEN_TASK('[]') });
    assert.ok(html.includes('data-briefing-session="T-0001"'));
  });

  it('names BRIEFBOARD_SESSION_CMD instead of falling silent when nothing is configured', () => {
    const { html } = dialog({ enabled: false });
    assert.ok(!html.includes('data-briefing-session'), 'still no button: it could do nothing');
    assert.ok(html.includes('Briefing session'), 'the block stays, so the absence is explained');
    assert.ok(html.includes('Not configured on this board'));
    assert.ok(html.includes('BRIEFBOARD_SESSION_CMD'));
  });

  it('is a captioned block of its own, saying what the session does', () => {
    const { html } = dialog({});
    assert.ok(html.includes('<div class="card-action"><h3>Briefing session</h3>'));
    assert.ok(html.includes('A brief that is already there is kept, never replaced.'));
  });

  it('offers nothing on a task that is not in open', () => {
    const { html } = dialog({ taskSrc: TASK });
    assert.ok(!html.includes('data-briefing-session'));
  });

  it('says nothing at all about the briefing session outside open, configured or not', () => {
    for (const enabled of [true, false]) {
      const { html } = dialog({ taskSrc: TASK, enabled });
      assert.ok(!html.includes('Briefing session'), 'no caption outside open');
      assert.ok(!html.includes('BRIEFBOARD_SESSION_CMD'), 'no variable name outside open');
    }
  });

  it('asks first, says no brief is replaced, and POSTs the briefing endpoint', async () => {
    const calls = [];
    const { sandbox } = dialog({ overrides: { fetch: recordingFetch({ session: 'started' }, calls) } });
    await sandbox.probeClick();

    assert.strictEqual(sandbox.confirmCalls.length, 1, 'the click must ask first');
    assert.match(sandbox.confirmCalls[0], /T-0001/);
    // The part a reader would otherwise assume: a task coming back up keeps what
    // it already has.
    assert.match(sandbox.confirmCalls[0], /Nothing already written is replaced/);

    const sent = calls.filter((c) => /\/briefing$/.test(c.url));
    assert.deepStrictEqual(sent.map((c) => c.url), ['/api/task/T-0001/briefing']);
    assert.strictEqual(sent[0].init.method, 'POST');
  });

  it('a refused confirmation sends nothing at all', async () => {
    const calls = [];
    const { sandbox } = dialog({
      overrides: { confirm: () => false, fetch: recordingFetch({ session: 'started' }, calls) },
    });
    await sandbox.probeClick();
    assert.deepStrictEqual(calls.filter((c) => /\/briefing$/.test(c.url)), []);
  });

  it('a 200 that started nothing is reported — the click has no transition behind it', async () => {
    const alerts = [];
    const { sandbox } = dialog({
      overrides: {
        fetch: recordingFetch({ session: 'already-running' }, []),
        alert: (msg) => alerts.push(msg),
      },
    });
    await sandbox.probeClick();
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0], /did not start: already-running/);
  });

  it('a started session says nothing, and a refusal is reported in the board\'s own words', async () => {
    const quiet = [];
    const started = dialog({
      overrides: {
        fetch: recordingFetch({ ok: true, session: 'started' }, []),
        alert: (msg) => quiet.push(msg),
      },
    });
    await started.sandbox.probeClick();
    assert.deepStrictEqual(quiet, []);

    const alerts = [];
    const refused = dialog({
      overrides: {
        fetch: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) }),
        alert: (msg) => alerts.push(msg),
      },
    });
    await refused.sandbox.probeClick();
    assert.deepStrictEqual(alerts, ['Failed to start the briefing session']);
  });

  it('the briefing and return strings exist and differ in all three languages', () => {
    const KEYS = [
      'briefing_session_button', 'briefing_session_confirm', 'briefing_session_failed',
      'briefing_session_refused', 'return_failed', 'confirm_return_session',
      'briefing_session_title', 'briefing_session_what', 'briefing_session_unconfigured',
    ];
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ${JSON.stringify(KEYS)}.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      for (let i = 0; i < KEYS.length; i++) assert.ok(result[l][i], `${l}.${KEYS[i]} is missing`);
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
  });
});

// =====================================================================
// what the task took (T-0116)
// =====================================================================

// One run inside a summary, as server/sessions.js reports it.
function costRun(over) {
  return Object.assign(
    {
      kind: 'worker',
      outcome: 'ended',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:10:00.000Z',
      durationMs: 600000,
      running: false,
      exitCode: 0,
      tokens: null,
    },
    over || {}
  );
}

// A whole per-task summary. Its totals are kept consistent with its runs by the
// caller, exactly as the server keeps them.
function summary(over) {
  return Object.assign(
    {
      id: 'T-0001',
      sessions: 1,
      kinds: { worker: 1 },
      outcomes: { ended: 1 },
      durationMs: 600000,
      running: false,
      tokens: null,
      tokenSessions: 0,
      dropped: 0,
      complete: true,
      entries: [costRun()],
    },
    over || {}
  );
}

describe('what the card says a task took (T-0116)', () => {
  function dialog(cost, language) {
    return run(`(function () {
      tasks = [${TASK}, ${OTHER_TASK}];
      sessionsById = new Map();
      costsById = new Map(${cost ? `[['T-0001', ${JSON.stringify(cost)}]]` : '[]'});
      lang = '${language || 'en'}';
      openTask('T-0001');
      return { html: modals[modals.length - 1].innerHTML };
    })()`).result;
  }

  it('counts the sessions, their kinds, their time and how they ended', () => {
    const result = dialog(
      summary({
        sessions: 2,
        kinds: { briefing: 1, worker: 1 },
        outcomes: { ended: 1, failed: 1 },
        durationMs: 600000 + 3720000,
        entries: [
          costRun({ kind: 'briefing' }),
          costRun({
            kind: 'worker',
            outcome: 'failed',
            exitCode: 1,
            startedAt: '2026-01-01T01:00:00.000Z',
            durationMs: 3720000,
          }),
        ],
      })
    );
    assert.ok(result.html.includes('sessions: 2'), 'how many sessions the task took');
    assert.ok(result.html.includes('briefing') && result.html.includes('worker'), 'of which kinds');
    assert.ok(result.html.includes('10m 0s'), 'each run on its own');
    assert.ok(result.html.includes('1h 2m'), 'and the total');
    assert.ok(result.html.includes('session done') && result.html.includes('session failed'));
    assert.ok(result.html.includes('exit 1'), 'a failure names its exit code');
  });

  // Nothing has to be configured for any of the above: it is measured from the
  // registry the board already keeps, whatever agent ran.
  it('draws nothing for a task no session ever ran on', () => {
    assert.ok(!dialog(null).html.includes('cost-total'));
    assert.ok(!dialog(summary({ sessions: 0, entries: [] })).html.includes('cost-total'));
  });

  it('counts a running session up to now and says the total is not final', () => {
    const startedAt = new Date(Date.now() - 65000).toISOString();
    const result = dialog(
      summary({
        running: true,
        // Measured by the server a while ago; the page must not pass that off as
        // the time a session that is still going has taken.
        durationMs: 0,
        outcomes: { running: 1 },
        entries: [
          costRun({ outcome: 'running', running: true, startedAt, endedAt: null, exitCode: null, durationMs: 0 }),
        ],
      })
    );
    assert.match(result.html, /1m \d+s/, 'a live run is measured from its start');
    assert.ok(result.html.includes('session live'));
    assert.ok(result.html.includes('still running'), 'the total says it is only a total so far');
  });

  // The registry evicts old runs, so a sum can be missing part of itself. Saying
  // which part is missing is the difference between partial and wrong.
  it('names an incomplete sum instead of passing it off as exact', () => {
    assert.ok(!dialog(summary()).html.includes('Incomplete'), 'a complete sum says nothing');
    const partial = dialog(summary({ dropped: 3, complete: false }));
    assert.ok(partial.html.includes('Incomplete'));
    assert.ok(partial.html.includes('3'), 'and how many runs it no longer has');
  });

  // Level two is the user's declaration, not the board's knowledge: with nothing
  // declared no number arrives, and a zero drawn here would be a claim.
  it('says nothing about tokens when no number was ever read', () => {
    const result = dialog(summary());
    assert.ok(!result.html.includes('tokens'));
    assert.ok(!result.html.includes('cost-tokens'));
  });

  it('shows the tokens when there are some, and says how many runs they cover', () => {
    const all = dialog(summary({ tokens: 214500, tokenSessions: 1 }));
    assert.ok(all.html.includes('tokens: 214\u00a0500'), 'grouped, unbroken digits');
    assert.ok(!all.html.includes('of 1 sessions'), 'no note when every run reported one');
    const some = dialog(
      summary({
        sessions: 2,
        tokens: 900,
        tokenSessions: 1,
        entries: [costRun(), costRun({ startedAt: '2026-01-01T02:00:00.000Z', tokens: 900 })],
      })
    );
    assert.ok(some.html.includes('from 1 of 2 sessions'));
  });

  it('the cost strings exist and differ in all three languages', () => {
    const { result } = run(`(function () {
      var keys = ['cost_title', 'cost_sessions', 'cost_total', 'cost_so_far', 'cost_kind_briefing',
        'cost_kind_worker', 'cost_exit', 'cost_dur_h', 'cost_dur_m', 'cost_dur_s', 'cost_tokens',
        'cost_tokens_some', 'cost_partial'];
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = keys.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const value of [...result.en, ...result.ru, ...result.ja]) {
      assert.ok(value && typeof value === 'string' && value.trim(), 'every cost string is filled in');
    }
    // The sentence that carries the meaning — this sum is missing part of
    // itself — is translated in both other languages, not borrowed.
    assert.notStrictEqual(result.ru[12], result.en[12]);
    assert.notStrictEqual(result.ja[12], result.en[12]);
  });

  it('renders in another language without falling back to English', () => {
    const ru = dialog(summary({ dropped: 1, complete: false }), 'ru');
    assert.ok(ru.html.includes('сессий: 1'));
    assert.ok(ru.html.includes('Неполно'));
    assert.ok(!ru.html.includes('sessions: 1'));
  });
});

// =====================================================================
// stopping the running session from the card (T-0211)
// =====================================================================
// The kill endpoint is as old as the session log (T-0077) and worked all along;
// what did not exist was a way to reach it without opening the log. The same
// class as T-0144 and T-0145 — a control that exists and is not found — and
// dearer than either: while it is being looked for, the session goes on
// spending the user's tokens.
describe('the stop action on the card of a running session', () => {
  // Opens T-0001's dialog with `session` in the registry and leaves a
  // `probeClick()` on the sandbox that presses the stop button.
  function dialog({ session = RUNNING, taskSrc = TASK, uiLang = 'en', overrides = {} } = {}) {
    const sandbox = createSandbox(overrides);
    const raw = runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        tasks = [${taskSrc}];
        sessionsById = new Map(${session ? `[['T-0001', ${JSON.stringify(session)}]]` : '[]'});
        lang = '${uiLang}';
        confirmCalls.length = 0; alertCalls.length = 0;
        sessionsConfigured = { enabled: true, worker: true, orchestrator: true,
          profiles: [], profileUsedBy: {} };
        openTask('T-0001');
        var overlay = modals[modals.length - 1];
        probeClick = function () {
          return overlay.querySelector('[data-stop-session]').dispatch('click');
        };
        return { html: overlay.innerHTML };
      })()`
    );
    return { html: JSON.parse(JSON.stringify(raw)).html, sandbox };
  }

  it('is on the card itself, so the log never has to be opened to stop a session', () => {
    const { html } = dialog({});
    assert.ok(html.includes('data-stop-session="T-0001"'));
    assert.ok(html.includes('Stop the session'));
    // Above the description, like the other actions: read before the text of the
    // task rather than after it.
    assert.ok(html.indexOf('data-stop-session') < html.indexOf('class="desc"'));
  });

  // T-0145: found by its caption and its own line, never by an accent colour —
  // colour on this board means status. The log window's copy of this button is
  // `danger`-tinted; this one deliberately is not.
  it('is a captioned block of its own, and no colour is spent on it', () => {
    const { html } = dialog({});
    assert.ok(html.includes('<div class="card-action"><h3>Running session</h3>'));
    assert.ok(html.includes('<div class="card-action-row">'), 'the button sits on a line of its own');
    const block = html.slice(html.indexOf('Running session'), html.indexOf('data-stop-session'));
    assert.ok(!/style="[^"]*(color|background)/.test(block), 'no inline colour on the action: ' + block);
    assert.ok(html.includes('<button type="button" class="tf-btn" data-stop-session'), 'neutral chip');
    assert.ok(!/tf-btn danger" data-stop-session/.test(html));
  });

  it('says what stopping does before it is pressed', () => {
    const { html } = dialog({});
    assert.ok(html.includes('An agent session is running on this task right now'));
    assert.ok(html.includes('whatever it has already written to disk stays'));
  });

  // The registry keys a session by TASK, so the kind never enters the condition —
  // and the card must stop a briefing or a review session as readily as a worker
  // one, because any of the three can be the one that is running.
  it('is offered for every kind of session', () => {
    for (const kind of ['worker', 'briefing', 'orchestrator']) {
      const { html } = dialog({ session: record({ kind }) });
      assert.ok(html.includes('data-stop-session="T-0001"'), `no stop action for a ${kind} session`);
    }
  });

  it('is absent when there is nothing to stop, rather than present and dead', () => {
    for (const session of [null, EXITED, INTERRUPTED]) {
      const { html } = dialog({ session });
      assert.ok(!html.includes('data-stop-session'), 'no button for: ' + JSON.stringify(session));
      assert.ok(!html.includes('Running session'), 'and no caption either');
    }
  });

  it('asks first, keeps the sentence about what survives, and POSTs the stop endpoint', async () => {
    const calls = [];
    const { sandbox } = dialog({
      overrides: {
        fetch: function (url, init) {
          calls.push({ url, init });
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        },
      },
    });
    await sandbox.probeClick();

    assert.strictEqual(sandbox.confirmCalls.length, 1, 'the click must ask first');
    assert.match(sandbox.confirmCalls[0], /T-0001/);
    // The part that makes the decision possible: what is already on disk is not
    // what is being thrown away.
    assert.match(sandbox.confirmCalls[0], /interrupted where it stands/);
    assert.match(sandbox.confirmCalls[0], /already written to disk stays/);

    const sent = calls.filter((c) => /\/stop$/.test(c.url));
    assert.deepStrictEqual(sent.map((c) => c.url), ['/api/session/T-0001/stop']);
    assert.strictEqual(sent[0].init.method, 'POST');
  });

  it('a refused confirmation kills nothing', async () => {
    const calls = [];
    const { sandbox } = dialog({
      overrides: {
        confirm: () => false,
        fetch: function (url) {
          calls.push(url);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        },
      },
    });
    await sandbox.probeClick();
    assert.deepStrictEqual(calls.filter((url) => /\/stop$/.test(url)), []);
  });

  it('says so when the stop failed — a click that did nothing must not look done', async () => {
    const { sandbox } = dialog({
      overrides: {
        fetch: function (url) {
          if (/\/stop$/.test(url)) return Promise.resolve({ ok: false, status: 500 });
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tasks: [] }) });
        },
      },
    });
    await sandbox.probeClick();
    await flush();
    assert.deepStrictEqual(sandbox.alertCalls, ['Failed to stop the session']);
  });

  // The commonest way to end up wanting the stop button is to press "start" one
  // block above it. Without this, the action would appear only on a card opened
  // AFTER the session had started — which is the same bug one step along.
  it('appears on a card that was already open when the session started', async () => {
    const cfg = { sessions: [] };
    const { sandbox } = run(
      `(function () {
        tasks = [${TASK}];
        lang = 'en';
        openTask('T-0001');
        var overlay = modals[modals.length - 1];
        probeArea = function () { return overlay.querySelector('[data-session-area]').innerHTML; };
        probeSessions = function () { return loadSessions(); };
      })()`,
      { fetch: sessionFetch(cfg) }
    );
    await flush();
    assert.ok(!sandbox.probeArea().includes('data-stop-session'), 'nothing was running yet');

    cfg.sessions = [RUNNING];
    await sandbox.probeSessions();
    await flush();
    const area = sandbox.probeArea();
    assert.ok(area.includes('data-stop-session="T-0001"'), 'the open card caught up: ' + area);
    assert.ok(area.includes('data-session-log="T-0001"'), 'and so did the log button');
  });

  it('goes away again on the same card once the session has ended', async () => {
    const cfg = { sessions: [RUNNING] };
    const { sandbox } = run(
      `(function () {
        tasks = [${TASK}];
        lang = 'en';
        openTask('T-0001');
        var overlay = modals[modals.length - 1];
        probeArea = function () { return overlay.querySelector('[data-session-area]').innerHTML; };
        probeSessions = function () { return loadSessions(); };
      })()`,
      { fetch: sessionFetch(cfg) }
    );
    await flush();
    assert.ok(sandbox.probeArea().includes('data-stop-session'), 'it was running');

    cfg.sessions = [EXITED];
    await sandbox.probeSessions();
    await flush();
    const area = sandbox.probeArea();
    assert.ok(!area.includes('data-stop-session'), 'nothing left to stop: ' + area);
    assert.ok(area.includes('data-session-log="T-0001"'), 'the finished log is still readable');
  });

  it('the stop strings exist and differ in all three languages', () => {
    const KEYS = ['session_stop_title', 'session_stop_what', 'session_stop_button', 'session_stop_confirm'];
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ${JSON.stringify(KEYS)}.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      for (let i = 0; i < KEYS.length; i++) {
        assert.ok(result[l][i] && result[l][i].trim(), `${l}.${KEYS[i]} is missing`);
      }
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
  });

  it('renders in another language without falling back to English', () => {
    const ru = dialog({ uiLang: 'ru' });
    assert.ok(ru.html.includes('Работающая сессия'));
    assert.ok(ru.html.includes('Остановить сессию'));
    assert.ok(!ru.html.includes('Running session'));
  });
});

// =====================================================================
// the start blocks while a session is already running (T-0221, in T-0220)
// =====================================================================
// Visible only once T-0211 put the stop action next to them: a card in `open`
// with a briefing session running showed "Running session — Stop the session"
// and "Briefing session — Start the briefing session" one under the other. The
// server refuses the second honestly (`already-running`), but the card was
// offering an action it could see would fail — the opposite of the rule these
// blocks exist for.
describe('a card does not offer a session that is already running', () => {
  const OPEN_TASK =
    "{ id: 'T-0001', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-01'," +
    " closed: '', briefs: ['T-0001-01'], depends: [], blockedBy: [], awaitingAnswer: false," +
    " title: 'Being refined', description: 'Notes.' }";
  const REVIEW_TASK =
    "{ id: 'T-0001', type: 'feature', status: 'review', priority: 'Major', created: '2026-01-01'," +
    " closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: false," +
    " title: 'Submitted', description: 'Done.' }";

  function dialog({ taskSrc = OPEN_TASK, session = RUNNING, configured = true, uiLang = 'en' } = {}) {
    const sandbox = createSandbox({});
    const raw = runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        tasks = [${taskSrc}];
        sessionsById = new Map(${session ? `[['T-0001', ${JSON.stringify(session)}]]` : '[]'});
        lang = '${uiLang}';
        sessionsConfigured = { enabled: ${configured}, worker: true, orchestrator: ${configured},
          profiles: [], profileUsedBy: {} };
        openTask('T-0001');
        return { html: modals[modals.length - 1].innerHTML };
      })()`
    );
    return JSON.parse(JSON.stringify(raw)).html;
  }

  // The pair of screenshots this task was filed from, one assertion each way.
  for (const [what, taskSrc, attr, caption] of [
    ['briefing', OPEN_TASK, 'data-briefing-session', 'Briefing session'],
    ['review', REVIEW_TASK, 'data-review-session', 'Review session'],
  ]) {
    it(`the ${what} block offers no button while a session runs on the task`, () => {
      const html = dialog({ taskSrc });
      assert.ok(!html.includes(attr), `the ${what} button is still offered: ` + html);
      assert.ok(html.includes(caption), 'the block itself stays, so the absence is explained');
      assert.ok(html.includes('A session is already running on this task'));
      assert.ok(html.includes('stop the running session above'), 'and says what to do about it');
    });

    it(`the ${what} button is back the moment nothing is running`, () => {
      for (const session of [null, EXITED, INTERRUPTED]) {
        const html = dialog({ taskSrc, session });
        assert.ok(html.includes(attr), 'no button for: ' + JSON.stringify(session));
        assert.ok(!html.includes('already running'), 'and no talk of a running session');
      }
    });
  }

  // The situation from the screenshots, in one card: the stop block and the
  // start block are both on it, and only one of them carries a button.
  it('the block above offers the stop, the block below offers nothing to press', () => {
    const html = dialog({});
    assert.ok(html.includes('data-stop-session="T-0001"'));
    assert.ok(!html.includes('data-briefing-session'));
    assert.ok(
      html.indexOf('Running session') < html.indexOf('Briefing session'),
      'the session to stop is named before the one that cannot start'
    );
  });

  // An unset command is the durable fact and keeps its message: a session
  // running right now says nothing about a command that was never configured.
  it('an unconfigured board still names its variable rather than the running session', () => {
    const html = dialog({ configured: false });
    assert.ok(html.includes('BRIEFBOARD_SESSION_CMD'));
    assert.ok(!html.includes('already running'));
    assert.ok(!html.includes('data-briefing-session'));
  });

  // The commonest way to reach the contradiction is with the card already open:
  // a briefing session is started FROM this block, and until now the block was
  // painted once and never looked again.
  it('the offer withdraws itself on a card that was open when the session started', async () => {
    const cfg = { sessions: [] };
    const { sandbox } = run(
      `(function () {
        tasks = [${OPEN_TASK}];
        lang = 'en';
        openTask('T-0001');
        var overlay = modals[modals.length - 1];
        probeArea = function () { return overlay.querySelector('[data-session-area]').innerHTML; };
        probeSessions = function () { return loadSessions(); };
      })()`,
      { fetch: sessionFetch(cfg) }
    );
    await flush();
    assert.ok(sandbox.probeArea().includes('data-briefing-session'), 'nothing was running yet');

    cfg.sessions = [RUNNING];
    await sandbox.probeSessions();
    await flush();
    const busy = sandbox.probeArea();
    assert.ok(!busy.includes('data-briefing-session'), 'the offer stayed up: ' + busy);
    assert.ok(busy.includes('already running'));

    cfg.sessions = [EXITED];
    await sandbox.probeSessions();
    await flush();
    assert.ok(sandbox.probeArea().includes('data-briefing-session'), 'and comes back when it ends');
  });

  it('the button still works when it is offered — the wiring moved with the block', async () => {
    const calls = [];
    const sandbox = createSandbox({
      fetch: function (url, init) {
        calls.push(url);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ session: 'started' }) });
      },
    });
    runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        tasks = [${OPEN_TASK}];
        sessionsById = new Map();
        lang = 'en';
        sessionsConfigured = { enabled: true, worker: true, orchestrator: true, profiles: [], profileUsedBy: {} };
        openTask('T-0001');
        var overlay = modals[modals.length - 1];
        probeClick = function () {
          return overlay.querySelector('[data-briefing-session]').dispatch('click');
        };
      })()`
    );
    await sandbox.probeClick();
    assert.deepStrictEqual(calls.filter((u) => /\/briefing$/.test(u)), ['/api/task/T-0001/briefing']);
  });

  it('the sentence exists and differs in all three languages', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) { lang = l; out[l] = t('session_start_running'); });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) assert.ok(result[l] && result[l].trim(), `${l} is missing`);
    assert.notStrictEqual(result.ru, result.en);
    assert.notStrictEqual(result.ja, result.en);
  });

  it('renders in another language without falling back to English', () => {
    const html = dialog({ uiLang: 'ru' });
    assert.ok(html.includes('По этой задаче уже идёт сессия'));
    assert.ok(!html.includes('already running'));
  });
});
