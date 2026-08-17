'use strict';

// The exit button and the "board is stopped" final screen in ui/index.html
// (T-0082). Same harness as the other UI tests: the inline <script> is executed
// in a Node vm over a fake DOM (tests/helpers/ui-harness.js).
//
// What matters here is the difference the screen has to preserve: "I stopped
// this board" ends in a final screen with no reconnection, while an ordinary
// dropped connection still says "reconnecting…" and keeps trying.

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadUiScript, createSandbox, runInSandbox } = require('./helpers/ui-harness.js');

const UI_SRC = loadUiScript();

function run(extraCode, overrides) {
  const sandbox = createSandbox(overrides);
  const raw = runInSandbox(UI_SRC, sandbox, extraCode);
  const result = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : raw;
  return { result, sandbox };
}

// Lets the awaited fetch inside the click handler settle before the assertions.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Snapshot of everything the final state is supposed to touch.
const PROBE = `
  function probe() {
    return {
      stopped: boardStopped,
      screen: stoppedScreen === null ? null : {
        className: stoppedScreen.className,
        inBody: document.body.children.indexOf(stoppedScreen) >= 0,
        role: stoppedScreen.getAttribute('role'),
        title: stoppedScreen.querySelector('.stopped-title').textContent,
        hint: stoppedScreen.querySelector('.stopped-hint').textContent,
      },
      liveOff: document.getElementById('live').classList.contains('off'),
      liveText: document.getElementById('live-text').textContent,
      sseClosed: eventSources[0].closed,
      sseCount: eventSources.length,
    };
  }
`;

const CLICK = `
  fetchCalls.length = 0; confirmCalls.length = 0; alertCalls.length = 0;
  document.getElementById('exit-board').dispatch('click', { type: 'click' });
`;

describe('the exit button', () => {
  it('carries an i18n name and title that follow the language', () => {
    const { result } = run(`(function () {
      var btn = document.getElementById('exit-board');
      function snap() { return { title: btn.title, aria: btn.getAttribute('aria-label') }; }
      var out = { en: snap() };
      setLang('ru'); out.ru = snap();
      setLang('ja'); out.ja = snap();
      return out;
    })()`);
    assert.deepStrictEqual(result.en, { title: 'Stop the board', aria: 'Stop the board' });
    assert.deepStrictEqual(result.ru, { title: 'Остановить доску', aria: 'Остановить доску' });
    assert.deepStrictEqual(result.ja, { title: 'ボードを停止', aria: 'ボードを停止' });
  });

  it('asks for confirmation before anything is sent', async () => {
    const { sandbox } = run(`(function () { lang = 'en'; ${CLICK} })()`);
    await flush();
    assert.strictEqual(sandbox.confirmCalls.length, 1);
    assert.match(sandbox.confirmCalls[0], /^Stop the board\?/);
    assert.deepStrictEqual(
      sandbox.fetchCalls.map((c) => c.url),
      ['/api/shutdown']
    );
  });

  it('declining the confirmation sends nothing and leaves the board running', async () => {
    const { result, sandbox } = run(`(function () {
      ${PROBE}
      confirmReturn = false;
      ${CLICK}
      return probe();
    })()`);
    await flush();
    assert.strictEqual(sandbox.confirmCalls.length, 1);
    assert.deepStrictEqual(sandbox.fetchCalls, []);
    assert.strictEqual(result.stopped, false);
    assert.strictEqual(result.screen, null);
    assert.strictEqual(result.sseClosed, false);
  });

  it('POSTs /api/shutdown and then shows the final screen', async () => {
    const after = await stateAfterClick('en');
    assert.deepStrictEqual(after.fetches, ['/api/shutdown']);
    assert.strictEqual(after.stopped, true);
    assert.strictEqual(after.screen.className, 'stopped-screen');
    assert.strictEqual(after.screen.inBody, true);
    assert.strictEqual(after.screen.role, 'alert');
    assert.strictEqual(after.screen.title, 'The board is stopped');
    assert.match(after.screen.hint, /node server\/server\.js/);
    assert.strictEqual(after.liveOff, true);
    assert.strictEqual(after.liveText, 'stopped');
    assert.strictEqual(after.sseClosed, true, 'the SSE stream is closed, so nothing reconnects');
  });

  it('shows the final screen even when the answer never arrives (the process left mid-response)', async () => {
    const state = await stateAfterClick('en', `
      fetch = function () { return Promise.reject(new Error('connection reset')); };
    `);
    assert.strictEqual(state.stopped, true);
    assert.strictEqual(state.screen.title, 'The board is stopped');
    assert.strictEqual(state.alerts.length, 0, 'a torn-off response is not an error here');
  });

  it('a refusal (403) is reported and the board stays live', async () => {
    const state = await stateAfterClick('en', `
      fetchResponse = { ok: false, status: 403, json: function () { return Promise.resolve({ error: 'nope' }); } };
    `);
    assert.deepStrictEqual(state.alerts, ['Failed to stop the board']);
    assert.strictEqual(state.stopped, false);
    assert.strictEqual(state.screen, null);
    assert.strictEqual(state.sseClosed, false);
  });

  it('a second click after the stop does nothing', async () => {
    const state = await stateAfterClick('en', '', `
      fetchCalls.length = 0; confirmCalls.length = 0;
      document.getElementById('exit-board').dispatch('click', { type: 'click' });
    `);
    assert.deepStrictEqual(state.confirms, []);
    assert.deepStrictEqual(state.fetches, []);
  });

  it('the final screen follows a language switch made after the stop', async () => {
    const state = await stateAfterClick('en', '', `setLang('ru');`);
    assert.strictEqual(state.screen.title, 'Доска остановлена');
    assert.strictEqual(state.liveText, 'остановлена');
  });
});

describe('the shutdown SSE event', () => {
  it('takes a neighbouring tab to the final screen too', async () => {
    const { result } = run(`(function () {
      ${PROBE}
      lang = 'en';
      fetchCalls.length = 0;
      eventSources[0].onmessage({ data: 'shutdown' });
      return { after: probe(), fetched: fetchCalls.map(function (c) { return c.url; }) };
    })()`);
    assert.strictEqual(result.after.stopped, true);
    assert.strictEqual(result.after.screen.title, 'The board is stopped');
    assert.strictEqual(result.after.sseClosed, true);
    assert.strictEqual(result.after.liveText, 'stopped');
    // Not confused with 'changed' / 'sessions': nothing is reloaded.
    assert.deepStrictEqual(result.fetched, []);
  });

  it('is a third event: "changed" and "sessions" still reload, and neither stops the board', async () => {
    const { result } = run(`(function () {
      ${PROBE}
      fetchCalls.length = 0;
      eventSources[0].onmessage({ data: 'changed' });
      eventSources[0].onmessage({ data: 'sessions' });
      return { urls: fetchCalls.map(function (c) { return c.url; }), stopped: boardStopped };
    })()`);
    assert.deepStrictEqual(result.urls, ['/api/board', '/api/sessions']);
    assert.strictEqual(result.stopped, false);
  });
});

describe('reconnection behaviour', () => {
  it('an ordinary drop still says "reconnecting…" and keeps the board live', () => {
    const { result } = run(`(function () {
      ${PROBE}
      lang = 'en';
      eventSources[0].onerror({});
      return probe();
    })()`);
    assert.strictEqual(result.stopped, false);
    assert.strictEqual(result.liveOff, true);
    assert.strictEqual(result.liveText, 'reconnecting…');
    assert.strictEqual(result.sseClosed, false);
  });

  it('after a stop, an error event no longer flips the indicator back to "reconnecting…"', () => {
    const { result } = run(`(function () {
      ${PROBE}
      lang = 'en';
      showStopped();
      eventSources[0].onerror({});
      return probe();
    })()`);
    assert.strictEqual(result.liveText, 'stopped');
  });

  it('connect() opens no new stream once the board is stopped', () => {
    const { result } = run(`(function () {
      showStopped();
      var before = eventSources.length;
      connect();
      return { before: before, after: eventSources.length };
    })()`);
    assert.strictEqual(result.before, 1);
    assert.strictEqual(result.after, 1);
  });
});

describe('exit strings', () => {
  it('every new key is present and distinct in en/ru/ja', () => {
    const { result } = run(`(function () {
      var keys = ['exit_button', 'exit_confirm', 'exit_failed', 'live_stopped', 'stopped_title', 'stopped_hint'];
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = keys.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      for (const s of result[l]) {
        assert.strictEqual(typeof s, 'string');
        assert.ok(s.length > 0);
      }
    }
    // Nothing fell back to English.
    result.en.forEach((s, i) => {
      assert.notStrictEqual(result.ru[i], s);
      assert.notStrictEqual(result.ja[i], s);
    });
    // The confirmation says what is lost, in every language.
    assert.match(result.en[1], /doc\//);
    assert.match(result.ru[1], /doc\//);
    assert.match(result.ja[1], /doc\//);
  });
});

// Clicks the exit button in `language`, with `before` running first (to install
// a fetch mock, say) and `after` once the click has settled, and returns the
// state probe plus the recorded confirm/alert/fetch calls.
async function stateAfterClick(language, before, after) {
  const { sandbox } = run(`(function () {
    ${PROBE}
    lang = '${language}';
    ${before || ''}
    ${CLICK}
    probeAfter = probe;
  })()`);
  await flush();
  const { runInSandbox: runIn } = require('./helpers/ui-harness.js');
  const raw = runIn('', sandbox, `(function () {
    ${after || ''}
    return { state: probeAfter(), confirms: confirmCalls.slice(), alerts: alertCalls.slice(),
             fetches: fetchCalls.map(function (c) { return c.url; }) };
  })()`);
  const out = JSON.parse(JSON.stringify(raw));
  return { ...out.state, confirms: out.confirms, alerts: out.alerts, fetches: out.fetches };
}
