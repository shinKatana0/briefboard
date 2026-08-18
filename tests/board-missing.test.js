'use strict';

// A board started in a project that has no doc/backlog.md (T-0247).
//
// That is not an exotic state: doc/backlog.md is gitignored on purpose, so it is
// what the documented clone path gives you before the first task is added. The
// server has always known — /api/board answers with an `error` — and the page
// drew five empty columns and said nothing, which reads as "no tasks yet".
//
// Two halves, checked where each lives: the answer (server/server.js) and what
// the page does with it (ui/index.html, through the vm harness).
// Run with: npm test

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fetch } = require('./helpers/bounded.js');
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { loadUiScript, createSandbox, runInSandbox } = require('./helpers/ui-harness.js');
const { tempDir } = require('./helpers/tmp.js');

const MISSING = 'doc/backlog.md not found';

// ---------- the server's answer ----------

const boards = [];
const roots = [];

afterEach(async () => {
  while (boards.length) await boards.pop().stop();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

/** A project on the clone path: doc/brief/ is there, the backlog is not. */
async function boardWithoutBacklog(env) {
  const root = tempDir('briefboard-nobacklog-');
  roots.push(root);
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  const server = await startBoard(root, env);
  boards.push(server);
  return server;
}

describe('/api/board with no backlog file', () => {
  it('says what is wrong and still names the project', async () => {
    const server = await boardWithoutBacklog({ BRIEFBOARD_NAME: 'payments-api' });

    const res = await fetch(`${server.baseUrl}/api/board`);
    const body = await readJson(res);

    assert.strictEqual(res.status, 200, answerOf(body));
    assert.strictEqual(body.error, MISSING, answerOf(body));
    assert.deepStrictEqual(body.tasks, [], answerOf(body));
    // The header reads the name from here, and losing it left a board that could
    // not say which project it was showing (T-0247).
    assert.strictEqual(body.project.name, 'payments-api', answerOf(body));
    // Session configuration comes from the environment, not from the backlog, so
    // it is answered here exactly as on a healthy board.
    assert.strictEqual(typeof body.sessions, 'object', answerOf(body));
  });

  it('drops the error again once the backlog exists', async () => {
    const server = await boardWithoutBacklog();
    const root = roots[roots.length - 1];

    fs.writeFileSync(
      path.join(root, 'doc', 'backlog.md'),
      ['# Backlog\n', '## T-0001 · Major · First task', '- type: feature', '- status: backlog',
        '- created: 2026-01-01 00:00:00', '- closed: —', '- briefs: ', '', 'Body.', ''].join('\n')
    );

    const body = await readJson(await fetch(`${server.baseUrl}/api/board`));
    assert.strictEqual(body.error, undefined, answerOf(body));
    assert.strictEqual(body.tasks.length, 1, answerOf(body));
  });
});

// ---------- what the page does with it ----------

const UI_SRC = loadUiScript();

function run(extraCode, overrides) {
  const sandbox = createSandbox(overrides);
  const value = runInSandbox(UI_SRC, sandbox, extraCode);
  return { sandbox, value };
}

// Renders the board with `error` in hand and reports the note element.
function note(error, lang = 'en') {
  return run(`(function () {
    tasks = [];
    boardError = ${JSON.stringify(error)};
    typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false;
    lang = '${lang}';
    render();
    var el = document.getElementById('board-note');
    return { html: el.innerHTML, hidden: el.hidden };
  })()`).value;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the board note', () => {
  it('says the file is missing and names the command that creates it', () => {
    const shown = note(MISSING);

    assert.strictEqual(shown.hidden, false);
    assert.ok(shown.html.includes('doc/backlog.md'), shown.html);
    assert.ok(shown.html.includes('node tools/task.mjs add'), shown.html);
  });

  it('stays out of the way when the board has nothing wrong with it', () => {
    const quiet = note(null);

    assert.strictEqual(quiet.hidden, true);
    assert.strictEqual(quiet.html, '');
  });

  it('shows an error it has no wording for in the server’s own words', () => {
    const shown = note('the backlog is held by another process');

    assert.strictEqual(shown.hidden, false);
    assert.ok(shown.html.includes('the backlog is held by another process'), shown.html);
  });

  it('is translated like the rest of the interface', () => {
    const texts = ['en', 'ru', 'ja'].map((l) => note(MISSING, l).html);

    assert.strictEqual(new Set(texts).size, 3, texts.join('\n---\n'));
    // The command is not interface wording and is the same in all three.
    for (const html of texts) assert.ok(html.includes('node tools/task.mjs add'), html);
  });

  it('reaches the note from a real /api/board answer, name and all', async () => {
    const { sandbox } = run('true', {
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ tasks: [], error: MISSING, project: { name: 'payments-api' } }),
        }),
    });
    await settle();

    const el = sandbox.document.getElementById('board-note');
    assert.strictEqual(el.hidden, false);
    assert.ok(el.innerHTML.includes('doc/backlog.md'), el.innerHTML);
    assert.ok(sandbox.document.getElementById('project-name').textContent.includes('payments-api'));
  });

  it('takes the note away when the next answer carries no error', async () => {
    let answer = { tasks: [], error: MISSING, project: { name: 'payments-api' } };
    const { sandbox } = run('reload = function () { return load(); };', {
      fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => answer }),
    });
    await settle();
    assert.strictEqual(sandbox.document.getElementById('board-note').hidden, false);

    answer = { version: 1, tasks: [], project: { name: 'payments-api' } };
    await sandbox.reload();

    const el = sandbox.document.getElementById('board-note');
    assert.strictEqual(el.hidden, true);
    assert.strictEqual(el.innerHTML, '');
  });
});
