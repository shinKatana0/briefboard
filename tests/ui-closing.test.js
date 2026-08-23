'use strict';

// What the card offers once the work is submitted (T-0148, after T-0117): the
// state git reports, the merge line to copy, and the two actions the board may
// perform — accept the task and remove the worktree.
//
// Same mechanics as tests/ui-session.test.js: the shared harness runs the real
// ui/index.html script in a Node `vm` against a fake DOM. That DOM answers
// querySelector with a memoised element rather than parsing markup, so the block
// painted into [data-closing] is read from that element, not from
// overlay.innerHTML.
// Run with: npm test

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadUiScript, createSandbox, runInSandbox } = require('./helpers/ui-harness.js');

const UI_SRC = loadUiScript();

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function taskSrc(status, id = 'T-0001') {
  return (
    `{ id: '${id}', type: 'feature', status: '${status}', priority: 'Major', created: '2026-01-01',` +
    " closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: false," +
    " title: 'Submitted', description: 'Done.' }"
  );
}

const MERGED = {
  git: 'ok',
  head: 'main',
  branch: 'task/T-0001',
  branches: ['task/T-0001'],
  merged: true,
  worktree: 'C:\\proj\\.briefboard\\worktrees\\T-0001',
  worktreeClean: true,
};
const UNMERGED = { ...MERGED, merged: false };

// Answers /api/git with `state` and the two writing endpoints with whatever the
// scenario asked for; records every request.
function boardFetch(cfg) {
  const c = cfg || {};
  const calls = [];
  const answer = (status, body) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  const fn = function (url, init) {
    calls.push({ url, init });
    if (/^\/api\/git\//.test(url)) return answer(200, c.state || { git: 'ok', branches: [] });
    // The board asks for these on start-up and rebuilds sessionsById from the
    // answer, so a record only assigned in the sandbox would be wiped by it.
    if (url === '/api/sessions') return answer(200, { sessions: c.sessions || [], costs: {} });
    if (/\/done$/.test(url)) return answer(c.doneStatus || 200, c.doneBody || { ok: true });
    if (/\/remove-worktree$/.test(url)) return answer(c.removeStatus || 200, c.removeBody || { ok: true });
    if (/\/rework$/.test(url)) {
      return answer(c.reworkStatus || 200, c.reworkBody || { ok: true, id: 'T-0001', status: 'in_progress', round: 2, session: 'started' });
    }
    return answer(200, { tasks: [], sessions: c.sessionsMeta });
  };
  fn.calls = calls;
  return fn;
}

/**
 * Opens the dialog of one task and returns a live view of the closing block:
 * `probe()` reads it after the /api/git answer has been applied, and `click()`
 * presses one of its buttons.
 */
function dialog({
  status = 'review',
  state = MERGED,
  session = null,
  clipboard = false,
  cfg = {},
  lang = 'en',
  sessionsConfigured = { enabled: true, worker: true },
} = {}) {
  const meta = {
    enabled: true,
    worker: true,
    orchestrator: false,
    profiles: [],
    profileUsedBy: {},
    ...sessionsConfigured,
  };
  const sandbox = createSandbox({
    fetch: boardFetch({ state, sessions: session ? [session] : [], sessionsMeta: meta, ...cfg }),
  });
  if (clipboard) {
    sandbox.clipboardWrites = [];
    sandbox.navigator = {
      clipboard: {
        writeText: (text) => {
          sandbox.clipboardWrites.push(text);
          return Promise.resolve();
        },
      },
    };
  }
  runInSandbox(
    UI_SRC,
    sandbox,
    `(function () {
      tasks = [${taskSrc(status)}];
      sessionsById = new Map(${session ? `[['T-0001', ${JSON.stringify(session)}]]` : '[]'});
      lang = '${lang}';
      sessionsConfigured = ${JSON.stringify(meta)};
      openTask('T-0001');
      var overlay = modals[modals.length - 1];
      var box = overlay.querySelector('[data-closing]');
      probe = function () {
        function slot(sel) { var el = box.querySelector(sel); return el ? el.textContent : null; }
        return {
          html: box.innerHTML,
          dialogHtml: overlay.innerHTML,
          branch: slot('[data-closing-branch]'),
          worktree: slot('[data-closing-worktree]'),
          command: slot('[data-closing-command]'),
        };
      };
      click = function (name) { return box.querySelector('[data-closing-' + name + ']').dispatch('click'); };
      setDisabled = function (name, value) { box.querySelector('[data-closing-' + name + ']').disabled = value; };
    })()`
  );
  return sandbox;
}

// ---------- what the block shows ----------

describe('the closing block asks git and shows what it answered', () => {
  it('asks /api/git for the task whose card was opened', async () => {
    const sandbox = dialog({});
    await flush();
    const asked = sandbox.fetch.calls.map((c) => c.url);
    assert.ok(asked.includes('/api/git/T-0001'), `asked: ${asked.join(', ')}`);
  });

  it('an unmerged branch: the state, the merge line, and both actions refused with a reason', async () => {
    const sandbox = dialog({ state: UNMERGED });
    await flush();
    const view = sandbox.probe();
    assert.ok(view.html.includes('not merged into main'), view.html);
    assert.strictEqual(view.command, 'git merge --no-ff task/T-0001');
    assert.ok(/data-closing-accept disabled/.test(view.html), view.html);
    assert.ok(/data-closing-remove disabled/.test(view.html), view.html);
    // Refused, and saying why — a disabled control that stays silent is the
    // thing T-0121 and T-0144 ruled out.
    assert.ok(view.html.includes('the branch is not merged'), view.html);
  });

  it('a merged branch: no merge line, and both actions offered', async () => {
    const sandbox = dialog({ state: MERGED });
    await flush();
    const view = sandbox.probe();
    assert.ok(view.html.includes('merged into main'), view.html);
    assert.ok(!view.html.includes('data-closing-command'), 'nothing left to merge, so no command');
    assert.ok(/data-closing-accept(?! disabled)/.test(view.html), view.html);
    assert.ok(/data-closing-remove(?! disabled)/.test(view.html), view.html);
  });

  it('names the branch and the worktree git reported', async () => {
    const sandbox = dialog({ state: UNMERGED });
    await flush();
    const view = sandbox.probe();
    assert.strictEqual(view.branch, 'task/T-0001');
    assert.strictEqual(view.worktree, 'C:\\proj\\.briefboard\\worktrees\\T-0001');
  });

  it('shows a path containing markup verbatim, and never as markup', async () => {
    const nasty = 'C:\\wt\\<img src=x onerror="alert(1)">&<b>T-0001</b>';
    const sandbox = dialog({ state: { ...MERGED, worktree: nasty } });
    await flush();
    const view = sandbox.probe();
    assert.strictEqual(view.worktree, nasty);
    assert.ok(!view.html.includes('<img'), view.html);
  });

  it('a task with no branch is accepted anyway: there is nothing to check', async () => {
    const sandbox = dialog({ state: { git: 'ok', branches: [], branch: null, merged: null, worktree: null } });
    await flush();
    const view = sandbox.probe();
    assert.ok(view.html.includes('no branch for this task'), view.html);
    assert.ok(/data-closing-accept(?! disabled)/.test(view.html), view.html);
    assert.ok(!view.html.includes('data-closing-remove'), 'nothing to remove');
  });

  it('two matching branches: the accept stands, the removal does not', async () => {
    const sandbox = dialog({
      state: { ...MERGED, branch: null, merged: null, branches: ['task/T-0001', 'task/T-0001-v2'] },
    });
    await flush();
    const view = sandbox.probe();
    assert.ok(view.html.includes('2 branches match'), view.html);
    assert.ok(/data-closing-accept(?! disabled)/.test(view.html), view.html);
    assert.ok(/data-closing-remove disabled/.test(view.html), view.html);
    assert.ok(view.html.includes('cannot tell which branch'), view.html);
  });

  it('uncommitted changes block the removal by name', async () => {
    const sandbox = dialog({ state: { ...MERGED, worktreeClean: false } });
    await flush();
    const view = sandbox.probe();
    assert.ok(/data-closing-remove disabled/.test(view.html), view.html);
    assert.ok(view.html.includes('uncommitted changes'), view.html);
  });

  it('a running session blocks the removal: it is working in that directory', async () => {
    const sandbox = dialog({
      state: MERGED,
      session: { id: 'T-0001', kind: 'worker', status: 'running' },
    });
    await flush();
    const view = sandbox.probe();
    assert.ok(/data-closing-remove disabled/.test(view.html), view.html);
    assert.ok(view.html.includes('session is running'), view.html);
  });

  it('git that cannot be read is said out loud, and no action is offered', async () => {
    const sandbox = dialog({ state: { git: 'no-git', branches: [] } });
    await flush();
    const view = sandbox.probe();
    assert.ok(view.html.includes('git is not available'), view.html);
    assert.ok(!view.html.includes('data-closing-remove'), view.html);
  });

  it('an accepted task keeps only the cleanup, and nothing at all once it is done', async () => {
    const accepted = dialog({ status: 'done', state: MERGED });
    await flush();
    const withWorktree = accepted.probe();
    assert.ok(withWorktree.html.includes('data-closing-remove'), withWorktree.html);
    assert.ok(!withWorktree.html.includes('data-closing-accept'), withWorktree.html);

    const cleaned = dialog({ status: 'done', state: { ...MERGED, worktree: null, worktreeClean: null } });
    await flush();
    assert.strictEqual(cleaned.probe().html, '', 'nothing left to say');
  });

  it('is not drawn at all before the work is submitted', async () => {
    const sandbox = dialog({ status: 'in_progress' });
    await flush();
    assert.ok(!sandbox.probe().dialogHtml.includes('data-closing'), 'no block, and no git call');
    assert.ok(!sandbox.fetch.calls.some((c) => /^\/api\/git\//.test(c.url)));
  });
});

// ---------- the actions ----------

describe('accepting and cleaning up from the card', () => {
  it('accepts only after the confirmation, then re-reads git', async () => {
    const sandbox = dialog({ state: MERGED });
    await flush();
    sandbox.confirmReturn = false;
    await sandbox.click('accept');
    assert.ok(!sandbox.fetch.calls.some((c) => /\/done$/.test(c.url)), 'refused confirmation posts nothing');

    sandbox.confirmReturn = true;
    await sandbox.click('accept');
    await flush();
    const done = sandbox.fetch.calls.filter((c) => /\/done$/.test(c.url));
    assert.strictEqual(done.length, 1, 'exactly one write');
    assert.strictEqual(done[0].init.method, 'POST');
    assert.ok(sandbox.confirmCalls[sandbox.confirmCalls.length - 1].includes('final'), sandbox.confirmCalls.join('|'));
  });

  it('after accepting, the card offers the cleanup and no longer offers the accept', async () => {
    const sandbox = dialog({ state: MERGED });
    await flush();
    await sandbox.click('accept');
    await flush();
    await flush();
    const view = sandbox.probe();
    assert.ok(view.html.includes('data-closing-remove'), view.html);
    assert.ok(!view.html.includes('data-closing-accept'), view.html);
  });

  it('a refused accept says which reason the server gave', async () => {
    const sandbox = dialog({
      state: MERGED,
      cfg: { doneStatus: 409, doneBody: { error: 'no', reason: 'not-merged' } },
    });
    await flush();
    await sandbox.click('accept');
    await flush();
    assert.ok(
      sandbox.alertCalls.some((m) => m.includes('the branch is not merged')),
      sandbox.alertCalls.join('|')
    );
  });

  it('removes the worktree after its own confirmation, and re-reads git afterwards', async () => {
    const sandbox = dialog({ state: MERGED });
    await flush();
    const before = sandbox.fetch.calls.filter((c) => /^\/api\/git\//.test(c.url)).length;
    await sandbox.click('remove');
    await flush();
    const posts = sandbox.fetch.calls.filter((c) => /\/remove-worktree$/.test(c.url));
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].init.method, 'POST');
    assert.ok(sandbox.confirmCalls.join('|').includes('branch and every commit on it stay'));
    const after = sandbox.fetch.calls.filter((c) => /^\/api\/git\//.test(c.url)).length;
    assert.strictEqual(after, before + 1, 'the block re-reads git after the removal');
  });

  it('a refused removal names the reason in the board\'s own words', async () => {
    const sandbox = dialog({
      state: MERGED,
      cfg: { removeStatus: 409, removeBody: { error: 'no', reason: 'dirty' } },
    });
    await flush();
    await sandbox.click('remove');
    await flush();
    assert.ok(
      sandbox.alertCalls.some((m) => m.includes('uncommitted changes')),
      sandbox.alertCalls.join('|')
    );
  });

  it('a disabled action does nothing when it is clicked anyway', async () => {
    const sandbox = dialog({ state: UNMERGED });
    await flush();
    sandbox.setDisabled('accept', true);
    await sandbox.click('accept');
    assert.ok(!sandbox.fetch.calls.some((c) => /\/done$/.test(c.url)));
  });

  it('"check again" is what sees the merge that happened in the terminal', async () => {
    const sandbox = dialog({ state: UNMERGED });
    await flush();
    assert.ok(sandbox.probe().html.includes('not merged'));
    await sandbox.click('recheck');
    await flush();
    const asked = sandbox.fetch.calls.filter((c) => /^\/api\/git\//.test(c.url));
    assert.strictEqual(asked.length, 2, 'git is read again, and only when asked');
  });

  it('the merge line can be copied where the browser allows it', async () => {
    const sandbox = dialog({ state: UNMERGED, clipboard: true });
    await flush();
    assert.ok(sandbox.probe().html.includes('data-closing-copy'));
    await sandbox.click('copy');
    await flush();
    assert.deepStrictEqual(sandbox.clipboardWrites, ['git merge --no-ff task/T-0001']);
  });

  it('offers no copy button where there is no clipboard to copy to', async () => {
    const sandbox = dialog({ state: UNMERGED });
    await flush();
    assert.ok(!sandbox.probe().html.includes('data-closing-copy'), 'no control that would do nothing');
  });
});

// ---------- the promise the board must not make ----------

describe('the board never names the user\'s test command', () => {
  it('no interface string in any language contains one', () => {
    const sandbox = createSandbox({});
    const raw = runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        var out = [];
        Object.keys(I18N).forEach(function (l) {
          Object.keys(I18N[l]).forEach(function (k) { out.push(I18N[l][k]); });
        });
        return out;
      })()`
    );
    const strings = JSON.parse(JSON.stringify(raw));
    // The board runs on Node; the project it serves may be anything, so any of
    // these in a hint would be an invention (the correction on T-0148).
    const invented = /\bnpm (test|run)\b|\byarn\b|\bpytest\b|\bcargo test\b|\bgo test\b|\bmvn\b/;
    for (const value of strings) {
      assert.ok(!invented.test(value), `an interface string names a test command: ${value}`);
    }
  });

  it('the closing strings are translated into all three languages', () => {
    const sandbox = createSandbox({});
    const raw = runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        var keys = ['closing_title', 'closing_state_unmerged', 'closing_accept', 'closing_remove',
          'closing_accept_confirm', 'closing_remove_confirm', 'closing_why_dirty', 'closing_note',
          'closing_recheck', 'closing_merge_hint'];
        var out = {};
        ['en', 'ru', 'ja'].forEach(function (l) {
          lang = l;
          out[l] = keys.map(function (k) { return t(k); });
        });
        return out;
      })()`
    );
    const result = JSON.parse(JSON.stringify(raw));
    for (const value of [...result.en, ...result.ru, ...result.ja]) {
      assert.ok(value && value.trim(), 'every closing string is filled in');
    }
    for (let i = 0; i < result.en.length; i++) {
      assert.notStrictEqual(result.ru[i], result.en[i], `ru[${i}] is translated, not borrowed`);
      assert.notStrictEqual(result.ja[i], result.en[i], `ja[${i}] is translated, not borrowed`);
    }
  });
});

// ---------- the other ending: back for another round (T-0329) ----------
//
// The board's half of the dispatch a returned card never had. What the UI owns
// is the offer and what it says afterwards; the transition, the branch rule and
// the rollback are the server's, and tests/worker-session-api covers them there.

describe('the rework action on a card in review', () => {
  it('is offered beside the accept, and only while the task is in review', async () => {
    const inReview = dialog({ state: MERGED });
    await flush();
    assert.ok(/data-closing-rework(?! disabled)/.test(inReview.probe().html), inReview.probe().html);

    const accepted = dialog({ status: 'done', state: MERGED });
    await flush();
    assert.ok(!accepted.probe().html.includes('data-closing-rework'), 'a finished task is not sent back');
  });

  it('is refused with its reason when the branch of the previous round is gone', async () => {
    const sandbox = dialog({
      state: { git: 'ok', branches: [], branch: null, merged: null, worktree: null },
    });
    await flush();
    const view = sandbox.probe();
    assert.ok(/data-closing-rework disabled/.test(view.html), view.html);
    assert.ok(view.html.includes('lose the previous round'), view.html);
    // The accept is untouched by that: a task nobody branched for is accepted as
    // it always was, and only the rework has something to lose.
    assert.ok(/data-closing-accept(?! disabled)/.test(view.html), view.html);
  });

  // The branch the runner uses is `task/T-NNNN` exactly. A worker's own
  // `task/T-NNNN-slug` beside it is not the branch a rework would check out, so
  // offering the action on it would offer exactly the loss it exists to prevent.
  it('a branch with a slug is not the branch the rework would reuse', async () => {
    const sandbox = dialog({
      state: { ...MERGED, branch: 'task/T-0001-slug', branches: ['task/T-0001-slug'] },
    });
    await flush();
    assert.ok(/data-closing-rework disabled/.test(sandbox.probe().html), sandbox.probe().html);
  });

  it('a session already running on the task blocks it', async () => {
    const sandbox = dialog({
      state: MERGED,
      session: { id: 'T-0001', kind: 'orchestrator', status: 'running' },
    });
    await flush();
    const view = sandbox.probe();
    assert.ok(/data-closing-rework disabled/.test(view.html), view.html);
    assert.ok(view.html.includes('already running'), view.html);
  });

  it('posts only after the confirmation, which says an agent will be started', async () => {
    const sandbox = dialog({ state: MERGED });
    await flush();
    sandbox.confirmReturn = false;
    await sandbox.click('rework');
    assert.ok(!sandbox.fetch.calls.some((c) => /\/rework$/.test(c.url)), 'refused confirmation posts nothing');

    sandbox.confirmReturn = true;
    await sandbox.click('rework');
    await flush();
    const posts = sandbox.fetch.calls.filter((c) => /\/rework$/.test(c.url));
    assert.strictEqual(posts.length, 1, 'exactly one write');
    assert.strictEqual(posts[0].url, '/api/task/T-0001/rework', 'the same endpoint the CLI posts to');
    assert.strictEqual(posts[0].init.method, 'POST');
    assert.ok(
      sandbox.confirmCalls[sandbox.confirmCalls.length - 1].includes('agent session'),
      sandbox.confirmCalls.join('|')
    );
  });

  // The board that starts no worker session still performs the transition, so
  // the question must not promise one — the rule the drop into In Progress
  // follows, for the same reason.
  it('with no worker command the question promises no session', async () => {
    const sandbox = dialog({ state: MERGED, sessionsConfigured: { enabled: true, worker: false } });
    await flush();
    sandbox.confirmReturn = false;
    await sandbox.click('rework');
    assert.ok(
      sandbox.confirmCalls[sandbox.confirmCalls.length - 1].includes('BRIEFBOARD_WORKER_CMD'),
      sandbox.confirmCalls.join('|')
    );
  });

  it('a card that was sent back stops offering the actions of a card in review', async () => {
    const sandbox = dialog({ state: MERGED });
    await flush();
    await sandbox.click('rework');
    await flush();
    await flush();
    assert.strictEqual(sandbox.probe().html, '', 'the block belongs to review and done, and this card is in neither');
  });

  it('a refusal names the reason the server gave, in the board\'s own words', async () => {
    const sandbox = dialog({
      state: MERGED,
      cfg: { reworkStatus: 409, reworkBody: { error: 'no', reason: 'no-branch' } },
    });
    await flush();
    await sandbox.click('rework');
    await flush();
    assert.ok(
      sandbox.alertCalls.some((m) => m.includes('lose the previous round')),
      sandbox.alertCalls.join('|')
    );
  });

  // T-0327's rule, on the action that inherits it: a 200 no longer means the card
  // stayed, and the reason is in a body the user never sees. The one thing that
  // differs is where it came back TO — `review`, not `ready` — so the message is
  // its own and not a reuse of the drop's.
  it('a dispatch that rolled back says so, and names Review as where the card is', async () => {
    for (const [language, expected] of [
      ['en', /^The session for T-0001 did not start: setup-failed\./],
      ['ru', /^Сессия по задаче T-0001 не запустилась: setup-failed\./],
      ['ja', /^タスク T-0001 のセッションは開始されませんでした: setup-failed。/],
    ]) {
      const sandbox = dialog({
        lang: language,
        state: MERGED,
        cfg: { reworkBody: { ok: true, id: 'T-0001', status: 'review', session: 'setup-failed', rolledBack: true } },
      });
      await flush();
      await sandbox.click('rework');
      await flush();
      assert.strictEqual(sandbox.alertCalls.length, 1, language);
      assert.match(sandbox.alertCalls[0], expected);
      assert.match(sandbox.alertCalls[0], /Review/, `${language}: where the card is now`);
      assert.match(sandbox.alertCalls[0], /(session log|логе сессии|セッションログ)/, language);
    }
  });

  it('a dispatch that reached a session says nothing', async () => {
    const sandbox = dialog({
      state: MERGED,
      cfg: { reworkBody: { ok: true, id: 'T-0001', status: 'in_progress', round: 2, session: 'started' } },
    });
    await flush();
    await sandbox.click('rework');
    await flush();
    assert.deepStrictEqual(sandbox.alertCalls, []);
  });

  it('the rework strings are translated into all three languages', () => {
    const sandbox = createSandbox({});
    const raw = runInSandbox(
      UI_SRC,
      sandbox,
      `(function () {
        var keys = ['closing_rework', 'closing_rework_confirm', 'closing_rework_confirm_no_session',
          'closing_rework_failed', 'closing_rework_refused', 'rework_rolled_back',
          'closing_why_no_branch', 'closing_why_running'];
        var out = {};
        ['en', 'ru', 'ja'].forEach(function (l) {
          lang = l;
          out[l] = keys.map(function (k) { return t(k); });
        });
        return out;
      })()`
    );
    const result = JSON.parse(JSON.stringify(raw));
    for (const value of [...result.en, ...result.ru, ...result.ja]) {
      assert.ok(value && value.trim(), 'every rework string is filled in');
    }
    for (let i = 0; i < result.en.length; i++) {
      assert.notStrictEqual(result.ru[i], result.en[i], `ru[${i}] is translated, not borrowed`);
      assert.notStrictEqual(result.ja[i], result.en[i], `ja[${i}] is translated, not borrowed`);
    }
  });
});

