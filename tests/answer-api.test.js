'use strict';

// Integration tests for POST /api/task/:id/answer — answering a session's
// questions from the card (T-0085). Each test spawns a real
// `node server/server.js` against a throwaway AGENTBOARD_ROOT, so the real
// project's doc/ files are never touched. No test runs a real agent:
// BRIEFBOARD_SESSION_CMD is always a short `node -e ...` command.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor } = require('./helpers/wait.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { removeTree } = require('./helpers/rm.js');
const { parseBacklog } = require('../server/parser.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

// ---------- fixtures ----------

// T-0011 is the task under test: open, with questions, and with text both above
// and below the questions section so a write that "only appends" can be checked
// against everything it must not touch.
const ASKED_DESCRIPTION = [
  'Refined on 2026-01-01.',
  '',
  '### Session questions',
  '',
  '- Which date format is canonical?',
  '- Should cancelled tasks be exported?',
].join('\n');

function sampleBacklog() {
  return [
    '# Backlog\n',
    '## T-0011 · Major · Waiting for an answer',
    '- type: feature',
    '- status: open',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
    ASKED_DESCRIPTION,
    '',
    '## T-0012 · Major · Open, nobody asked anything',
    '- type: feature',
    '- status: open',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
    'Refined, no questions.',
    '',
    '## T-0013 · Major · Already ready, questions long answered',
    '- type: feature',
    '- status: ready',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0013-01',
    '',
    '### Session questions',
    '',
    '- Answered back then.',
    '',
    // T-0101: the worker session's own stop - it asked and stayed where it was,
    // because the protocol gives it no transition back to `ready`.
    '## T-0014 · Major · Worker session stopped to ask',
    '- type: feature',
    '- status: in_progress',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0014-01',
    '',
    'Implementing.',
    '',
    '### Session questions',
    '',
    '- Which of the two schemas in the brief is the real one?',
    '',
    // T-0122: the review session's own stop. It sets no status at all, so it
    // asks from `review` and stays there.
    '## T-0015 · Major · Review session stopped to ask',
    '- type: feature',
    '- status: review',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0015-01',
    '',
    'Reviewing.',
    '',
    '### Session questions',
    '',
    '- The brief says two columns, the diff has three. Which is right?',
    '',
  ].join('\n');
}

function makeFixtureRoot(backlog = sampleBacklog()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-answer-test-'));
  const briefDir = path.join(root, 'doc', 'brief');
  fs.mkdirSync(briefDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), backlog);
  // T-0013 and T-0014 are past `open`, so their briefs have to exist for
  // `validate` to pass.
  fs.writeFileSync(path.join(briefDir, 'T-0013-01-answered.md'), '# T-0013-01 · Answered\n');
  fs.writeFileSync(path.join(briefDir, 'T-0014-01-unclear.md'), '# T-0014-01 · Unclear\n');
  fs.writeFileSync(path.join(briefDir, 'T-0015-01-reviewed.md'), '# T-0015-01 · Reviewed\n');
  return root;
}

function backlogPath(root) {
  return path.join(root, 'doc', 'backlog.md');
}

function backlogText(root) {
  return fs.readFileSync(backlogPath(root), 'utf8');
}

function readTask(root, id = 'T-0011') {
  return parseBacklog(backlogText(root)).find((t) => t.id === id);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionsDir(root) {
  return path.join(root, '.briefboard', 'sessions');
}

// Logs only: registry.json shares the directory with them (T-0102).
function sessionLogs(root) {
  const dir = sessionsDir(root);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')) : [];
}

function readSessionLogs(root) {
  return sessionLogs(root)
    .map((f) => fs.readFileSync(path.join(sessionsDir(root), f), 'utf8'))
    .join('\n');
}

// Double quotes so a node path containing spaces survives; the -e scripts
// therefore use single quotes only.
function nodeCmd(script) {
  return `"${process.execPath}" -e "${script}"`;
}

const LONG_SESSION = "console.log('pid=' + process.pid); setInterval(function(){}, 1000)";

const activeServers = [];
const activeRoots = [];

async function setup(extraEnv, backlog) {
  const root = makeFixtureRoot(backlog);
  activeRoots.push(root);
  const server = await startBoard(root, extraEnv);
  activeServers.push(server);
  return { root, server };
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) await removeTree(activeRoots.pop());
});

/** POST an answer. `body` is sent as JSON unless `raw` is given. */
function answer(server, body, { id = 'T-0011', raw, headers = {}, method = 'POST' } = {}) {
  return fetch(server.baseUrl + `/api/task/${id}/answer`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'POST' ? (raw === undefined ? JSON.stringify(body) : raw) : undefined,
  });
}

function runCli(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, AGENTBOARD_ROOT: root },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

// A restarted session with something new to ask, writing it the only way it
// can: `task.mjs note`, the same command the shipped prompt allows. The
// questions land below the answers it has just read, which is what makes the
// round a new one (T-0114).
async function askAgain(root, question, id = 'T-0011') {
  const res = await runCli(root, ['note', id, '--section', 'Session questions', '--text', question]);
  assert.strictEqual(res.code, 0, res.stderr);
}

// =====================================================================
// appending, and only appending
// =====================================================================
describe('POST /api/task/:id/answer — the answer is appended', () => {
  it('200 and the text lands under "### Answers" at the end of the description', async () => {
    const { root, server } = await setup();
    const res = await answer(server, { text: 'ISO-8601, and yes, include cancelled.' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(data.id, 'T-0011', answerOf(data));

    const task = readTask(root);
    assert.strictEqual(
      task.description,
      ASKED_DESCRIPTION + '\n\n### Answers\nISO-8601, and yes, include cancelled.'
    );
  });

  it('nothing already written changes: the description before is a prefix of the description after', async () => {
    const { root, server } = await setup();
    const before = readTask(root).description;
    await answer(server, { text: 'An answer.' });
    const after = readTask(root).description;

    // Character by character, the whole old text survives; only a tail is new.
    assert.strictEqual(after.slice(0, before.length), before);
    assert.ok(after.length > before.length);
    for (let i = 0; i < before.length; i++) {
      assert.strictEqual(after[i], before[i], `character ${i} of the old description changed`);
    }
    // And the fields around it are untouched, including the status: answering
    // is not a transition.
    const task = readTask(root);
    assert.strictEqual(task.status, 'open');
    assert.strictEqual(task.title, 'Waiting for an answer');
    assert.strictEqual(task.created, '2026-01-01 00:00:00');
    assert.strictEqual(task.closed, '');
  });

  it('the other tasks in the file are left alone', async () => {
    const { root, server } = await setup();
    const before = parseBacklog(backlogText(root)).filter((t) => t.id !== 'T-0011');
    await answer(server, { text: 'An answer.' });
    const after = parseBacklog(backlogText(root)).filter((t) => t.id !== 'T-0011');
    assert.deepStrictEqual(after, before);
  });

  // T-0114: answers are correspondence, so each one is its own section at the
  // end - a reply merged into an earlier one would lose the order the marker
  // reads. Nothing already written is touched either way.
  it('a later answer opens its own section at the end', async () => {
    const { root, server } = await setup();
    await answer(server, { text: 'First answer.' });
    await askAgain(root, '- And the timezone?');
    assert.strictEqual((await answer(server, { text: 'Second answer.' })).status, 200);

    const description = readTask(root).description;
    assert.strictEqual((description.match(/^### Answers$/gm) || []).length, 2);
    assert.ok(description.indexOf('First answer.') < description.indexOf('Second answer.'));
    assert.strictEqual(
      description,
      ASKED_DESCRIPTION +
        '\n\n### Answers\nFirst answer.' +
        '\n\n### Session questions\n- And the timezone?' +
        '\n\n### Answers\nSecond answer.'
    );
  });

  it('a task with no description at all still gets a well-formed section', async () => {
    // The questions section is the whole description here - the smallest input
    // that can reach this endpoint at all.
    const { root, server } = await setup(undefined, [
      '# Backlog\n',
      '## T-0011 · Major · Only questions',
      '- type: feature',
      '- status: open',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: ',
      '',
      '### Session questions',
      '',
      '- Anything?',
      '',
    ].join('\n'));
    await answer(server, { text: 'Yes.' });
    assert.strictEqual(
      readTask(root).description,
      '### Session questions\n\n- Anything?\n\n### Answers\nYes.'
    );
  });

  it('the marker clears with the answer, while the status stays put (T-0114)', async () => {
    // The questions section stays in the text - nothing is ever removed - but
    // the answer is now below it, and that is what the marker reads. The status
    // is still not a transition: only the restarted session moves the task on.
    const { root, server } = await setup();
    await answer(server, { text: 'Answered.' });
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.strictEqual(board.tasks.find((t) => t.id === 'T-0011').awaitingAnswer, false, answerOf(board));
    assert.strictEqual(readTask(root).status, 'open');
    assert.ok(readTask(root).description.includes('### Session questions'));
  });

  // The chain the board lives by, end to end through the two writers that exist:
  // the answer endpoint and `task.mjs note`. Two full rounds - one question left
  // unanswered would show as a card nobody looks at, one answer that fails to
  // clear the marker as a card asking for an answer nobody owes.
  it('two full rounds: asked -> lit, answered -> dark, asked again -> lit, answered -> dark', async () => {
    const { root, server } = await setup();
    const lit = async () => {
      const board = await readJson(await fetch(server.baseUrl + '/api/board'));
      return board.tasks.find((t) => t.id === 'T-0011').awaitingAnswer;
    };

    assert.strictEqual(await lit(), true, 'the fixture is a session that stopped to ask');
    assert.strictEqual((await answer(server, { text: 'ISO-8601.' })).status, 200);
    assert.strictEqual(await lit(), false, 'the answer closed the first round');

    await askAgain(root, '- And the timezone?');
    assert.strictEqual(await lit(), true, 'the second question opened a new round');
    assert.strictEqual((await answer(server, { text: 'UTC.' })).status, 200);
    assert.strictEqual(await lit(), false, 'the answer closed the second round');

    // The whole exchange is in the file, in the order it happened, and every
    // round of it is still readable.
    const description = readTask(root).description;
    assert.deepStrictEqual(
      description.split('\n').filter((line) => line.startsWith('### ')),
      ['### Session questions', '### Answers', '### Session questions', '### Answers']
    );
    for (const written of ['- Which date format is canonical?', 'ISO-8601.', '- And the timezone?', 'UTC.']) {
      assert.ok(description.includes(written), `${written} was lost`);
    }
    assert.strictEqual(readTask(root).status, 'open', 'answering is still not a transition');
  });

  // The live scenario behind T-0114: the task is in `in_progress` with a worker
  // session at work, and its questions were answered rounds ago. The old rule
  // read presence alone, so the card lit up again over a long-closed section and
  // offered a box for answering a question nobody had asked.
  it('an answered task being worked on in in_progress does not light up again', async () => {
    const { root, server } = await setup();
    assert.strictEqual((await answer(server, { text: 'The second one.' }, { id: 'T-0014' })).status, 200);

    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    const task = board.tasks.find((t) => t.id === 'T-0014');
    assert.strictEqual(task.status, 'in_progress');
    assert.strictEqual(task.awaitingAnswer, false);
    // Nothing was removed to get there - the questions are still in the text.
    assert.ok(readTask(root, 'T-0014').description.includes('### Session questions'));
  });
});

// =====================================================================
// preconditions
// =====================================================================
describe('POST /api/task/:id/answer — preconditions', () => {
  it('404 for a task that does not exist, and the file is not touched', async () => {
    const { root, server } = await setup();
    const before = backlogText(root);
    const res = await answer(server, { text: 'Hello?' }, { id: 'T-4242' });
    assert.strictEqual(res.status, 404);
    assert.match((await readJson(res)).error, /T-4242/, answerOf(res));
    assert.strictEqual(backlogText(root), before);
  });

  it('409 when the task is open but nobody asked anything', async () => {
    const { root, server } = await setup();
    const before = backlogText(root);
    const res = await answer(server, { text: 'Unsolicited.' }, { id: 'T-0012' });
    assert.strictEqual(res.status, 409);
    assert.match((await readJson(res)).error, /Session questions/, answerOf(res));
    assert.strictEqual(backlogText(root), before);
  });

  it('409 when the task has left the statuses a session asks from, however much text stayed behind in it', async () => {
    const { root, server } = await setup();
    const before = backlogText(root);
    const res = await answer(server, { text: 'Too late.' }, { id: 'T-0013' });
    assert.strictEqual(res.status, 409);
    assert.match((await readJson(res)).error, /open/, answerOf(res));
    assert.strictEqual(backlogText(root), before);
  });

  it('405 for anything but POST', async () => {
    const { server } = await setup();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await answer(server, null, { method });
      assert.strictEqual(res.status, 405, `${method} must not be accepted`);
    }
  });

  it('403 for a cross-origin browser request, before the file is read', async () => {
    const { root, server } = await setup();
    const before = backlogText(root);
    const res = await answer(server, { text: 'From evil.example' }, {
      headers: { Origin: 'http://evil.example' },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(backlogText(root), before);
  });

  it('415 when the client declares a Content-Type that is not JSON', async () => {
    const { server } = await setup();
    const res = await answer(server, { text: 'Form post.' }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.strictEqual(res.status, 415);
  });

  it('503 with Retry-After while another writer holds the backlog lock', async () => {
    const { root, server } = await setup({ BRIEFBOARD_LOCK_TIMEOUT_MS: '50' });
    // A lock file nobody will release, kept fresh so it is never taken for a
    // stale one (the server steals locks older than 10s).
    fs.writeFileSync(backlogPath(root) + '.lock', `999999 ${Date.now()}\n`);
    const before = backlogText(root);

    const res = await answer(server, { text: 'Contended.' });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers.get('retry-after'), '1');
    assert.match((await readJson(res)).error, /busy/, answerOf(res));
    assert.strictEqual(backlogText(root), before);
  });
});

// =====================================================================
// the worker session's questions (T-0101)
// =====================================================================
// The worker has exactly two transitions and none of them leads back, so a
// worker that has to ask stays in `in_progress`. The marker is what says the
// work is standing still; the endpoint must accept an answer wherever the
// marker can be lit, or the card would ask for something it cannot take.
describe('POST /api/task/:id/answer — a task asking from in_progress', () => {
  it('the board marks it, exactly as it marks an asking open task', async () => {
    const { server } = await setup();
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    const byId = Object.fromEntries(board.tasks.map((t) => [t.id, t]));

    assert.strictEqual(byId['T-0014'].awaitingAnswer, true);
    assert.strictEqual(byId['T-0014'].status, 'in_progress');
    assert.strictEqual(byId['T-0011'].awaitingAnswer, true);
    assert.strictEqual(byId['T-0013'].awaitingAnswer, false);
  });

  it('200: the answer is appended and the task stays in in_progress', async () => {
    const { root, server } = await setup();
    const before = readTask(root, 'T-0014').description;

    const res = await answer(server, { text: 'The second one.' }, { id: 'T-0014' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await readJson(res)).status, 'in_progress', answerOf(res));
    const task = readTask(root, 'T-0014');
    assert.strictEqual(task.status, 'in_progress');
    assert.strictEqual(task.description, before + '\n\n### Answers\nThe second one.');
  });

  it('there is never a lit marker with nothing to answer: every flagged task takes an answer', async () => {
    const { root, server } = await setup();
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    const flagged = board.tasks.filter((t) => t.awaitingAnswer).map((t) => t.id);
    assert.deepStrictEqual(flagged, ['T-0011', 'T-0014', 'T-0015']);

    for (const id of flagged) {
      const res = await answer(server, { text: 'Answered.' }, { id });
      assert.strictEqual(res.status, 200, `${id} carries the marker but refused the answer`);
      assert.ok(readTask(root, id).description.includes('### Answers'));
    }
  });

  it('409 for an in_progress task nobody asked anything about', async () => {
    // The section, not the status, is what makes an answer possible - the same
    // rule `open` has had since T-0085.
    const { root, server } = await setup(undefined, [
      '# Backlog\n',
      '## T-0011 · Major · Quietly being worked on',
      '- type: feature',
      '- status: in_progress',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: T-0013-01',
      '',
      'Implementing, no questions.',
      '',
    ].join('\n'));
    const before = backlogText(root);

    const res = await answer(server, { text: 'Unsolicited.' });

    assert.strictEqual(res.status, 409);
    assert.match((await readJson(res)).error, /Session questions/, answerOf(res));
    assert.strictEqual(backlogText(root), before);
  });
});

// =====================================================================
// the review session's questions (T-0122)
// =====================================================================
// The third session kind sets no status at all, so `review` is where it stops to
// ask and where it stays. `review` was deliberately out of ANSWER_STATUSES when
// the list was written (T-0101), because the marker then went by presence alone
// and one question asked in `in_progress` would have burned on the card all the
// way to `done`. The order rule of T-0114 retired that objection, and without
// `review` in the list the review session would have the protocol on paper only.
describe('POST /api/task/:id/answer — a task asking from review', () => {
  it('the board marks it, and answering leaves it in review', async () => {
    const { root, server } = await setup();
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    const task = board.tasks.find((t) => t.id === 'T-0015');
    assert.strictEqual(task.awaitingAnswer, true);
    assert.strictEqual(task.status, 'review');

    const res = await answer(server, { text: 'Three. The brief is stale.' }, { id: 'T-0015' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await readJson(res)).status, 'review', answerOf(res));
    assert.strictEqual(readTask(root, 'T-0015').status, 'review');
  });

  it('an answered review task does not light up again — the marker follows the order', async () => {
    const { root, server } = await setup();
    await answer(server, { text: 'Three.' }, { id: 'T-0015' });

    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.strictEqual(board.tasks.find((t) => t.id === 'T-0015').awaitingAnswer, false, answerOf(board));
    // Nothing was removed to get there.
    assert.ok(readTask(root, 'T-0015').description.includes('### Session questions'));
  });

  // A worker that asked and was answered arrives in review with both sections in
  // its description. That case is what T-0101 feared, and it is now decided by
  // the order rather than by the status.
  it('a task answered while in_progress arrives in review unflagged', async () => {
    const { root, server } = await setup(undefined, [
      '# Backlog\n',
      '## T-0011 · Major · Asked, answered, submitted',
      '- type: feature',
      '- status: review',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: T-0013-01',
      '',
      'Implemented.',
      '',
      '### Session questions',
      '',
      '- Which schema?',
      '',
      '### Answers',
      '',
      'The second one.',
      '',
    ].join('\n'));
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.strictEqual(board.tasks.find((t) => t.id === 'T-0011').awaitingAnswer, false, answerOf(board));
    assert.ok(readTask(root).description.includes('### Session questions'));
  });

  it('with restart it is the review session that runs again, in the project directory', async () => {
    const { root, server } = await setup({
      // Both configured, so "which kind" is a real choice and not the only one
      // available. The worker one would also have made a worktree.
      BRIEFBOARD_WORKER_CMD: nodeCmd("console.log('worker ran {id}')"),
      BRIEFBOARD_ORCHESTRATOR_CMD: nodeCmd("console.log('review ran {id} in ' + process.cwd())"),
    });
    const data = await readJson(await answer(server, { text: 'Three.', restart: true }, { id: 'T-0015' }));
    assert.strictEqual(data.session, 'started', answerOf(data));

    await waitFor(() => /review ran T-0015/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the review session');
    assert.ok(!/worker ran/.test(readSessionLogs(root)), 'the worker kind must not be restarted here');
    assert.ok(!fs.existsSync(path.join(root, '.briefboard', 'worktrees')), 'no worktree is made');
  });
});

// =====================================================================
// the text itself
// =====================================================================
describe('POST /api/task/:id/answer — validating the text', () => {
  it('400 for an empty, blank or missing text, and nothing is written', async () => {
    const { root, server } = await setup();
    const before = backlogText(root);
    for (const body of [{}, { text: '' }, { text: '   \n  ' }]) {
      const res = await answer(server, body);
      assert.strictEqual(res.status, 400, `${JSON.stringify(body)} must be refused`);
      assert.match((await readJson(res)).error, /text/, answerOf(res));
    }
    assert.strictEqual(backlogText(root), before);
  });

  it('400 when text is not a string, or restart is not a boolean', async () => {
    const { server } = await setup();
    for (const body of [{ text: 42 }, { text: ['a'] }, { text: { a: 1 } }]) {
      const res = await answer(server, body);
      assert.strictEqual(res.status, 400);
      assert.match((await readJson(res)).error, /text must be a string/, answerOf(res));
    }
    const res = await answer(server, { text: 'ok', restart: 'yes' });
    assert.strictEqual(res.status, 400);
    assert.match((await readJson(res)).error, /restart must be a boolean/, answerOf(res));
  });

  it('the length limit is the one description text has when a task is created', async () => {
    const { root, server } = await setup();
    const tooLong = await answer(server, { text: 'x'.repeat(4001) });
    assert.strictEqual(tooLong.status, 400);
    assert.match((await readJson(tooLong)).error, /at most 4000 characters/, answerOf(tooLong));

    // The same message the create endpoint gives, from the same rule — proof
    // there is no second copy of the limit.
    const created = await fetch(server.baseUrl + '/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Long one', description: 'x'.repeat(4001) }),
    });
    assert.strictEqual(created.status, 400);
    assert.match((await readJson(created)).error, /at most 4000 characters/, answerOf(created));

    const ok = await answer(server, { text: 'x'.repeat(4000) });
    assert.strictEqual(ok.status, 200);
    assert.ok(readTask(root).description.includes('x'.repeat(4000)));
  });

  it('413 for a body past the cap', async () => {
    const { root, server } = await setup();
    const before = backlogText(root);
    const res = await answer(server, null, { raw: JSON.stringify({ text: 'x'.repeat(64 * 1024) }) });
    assert.strictEqual(res.status, 413);
    assert.strictEqual(backlogText(root), before);
  });

  it('400 for a malformed JSON body', async () => {
    const { server } = await setup();
    const res = await answer(server, null, { raw: '{"text": ' });
    assert.strictEqual(res.status, 400);
    assert.match((await readJson(res)).error, /JSON/, answerOf(res));
  });

  it('markdown headings and field-shaped lines are accepted, escaped on write and read back verbatim', async () => {
    // Not rejected on purpose: serializeBacklog() escapes what would read back
    // as structure (T-0080), so a rule refusing such text here would contradict
    // the escaping and make ordinary markdown unanswerable.
    const { root, server } = await setup();
    const text = [
      '## Not a task header',
      '',
      '- status: done',
      '- Which is fine as a bullet.',
      '',
      '### A heading of my own',
    ].join('\n');
    const res = await answer(server, { text });
    assert.strictEqual(res.status, 200);

    const task = readTask(root);
    assert.ok(task.description.endsWith('### Answers\n' + text));
    // The lookalikes did not become structure: no phantom task, no rewritten
    // status, and the file still validates.
    assert.strictEqual(task.status, 'open');
    assert.strictEqual(parseBacklog(backlogText(root)).length, 5);
    const validate = await runCli(root, ['validate']);
    assert.strictEqual(validate.code, 0, validate.stderr);
    assert.match(validate.stdout, /OK/);
  });

  it('CRLF from a browser textarea is normalised, like it is for a description', async () => {
    const { root, server } = await setup();
    await answer(server, { text: 'line one\r\nline two' });
    assert.ok(readTask(root).description.endsWith('### Answers\nline one\nline two'));
    assert.ok(!backlogText(root).includes('\r'));
  });
});

// =====================================================================
// restarting the session
// =====================================================================
describe('POST /api/task/:id/answer — restarting the session', () => {
  it('without restart nothing is spawned at all', async () => {
    const { root, server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('ran {id}')") });
    const data = await readJson(await answer(server, { text: 'Answered, but not yet.' }));
    assert.strictEqual(data.session, undefined, answerOf(data));
    await sleep(300);
    // The sessions directory, not the whole of .briefboard: since T-0186 every
    // board writes its trace under boards/ whether a session runs or not.
    assert.strictEqual(fs.existsSync(sessionsDir(root)), false);
    assert.ok(readTask(root).description.includes('Answered, but not yet.'));
  });

  it('with restart the briefing session runs again, and can read the answer in the file', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd(
        "var fs = require('fs');" +
          "console.log('rebriefing {id}: ' + /### Answers\\n(.*)/.exec(fs.readFileSync('doc/backlog.md', 'utf8'))[1]);"
      ),
    });
    const data = await readJson(await answer(server, { text: 'ISO-8601 it is.', restart: true }));
    assert.strictEqual(data.session, 'started', answerOf(data));

    await waitFor(
      () => /rebriefing T-0011: ISO-8601 it is\./.test(readSessionLogs(root)),
      SPAWN_WAIT_BUDGET_MS,
      'the session to read the answer back'
    );
    assert.strictEqual(sessionLogs(root).length, 1);
  });

  it('a session that cannot start is reported, not rolled back', async () => {
    // No command configured: the restart answers "disabled" and the answer -
    // the thing the user actually typed - stays written.
    const { root, server } = await setup();
    const res = await answer(server, { text: 'Saved anyway.', restart: true });
    const data = await readJson(res);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.session, 'disabled', answerOf(data));
    assert.ok(readTask(root).description.includes('Saved anyway.'));
  });

  it('a session already running on the task is not doubled', async () => {
    const { root, server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    const first = await readJson(await answer(server, { text: 'First.', restart: true }));
    assert.strictEqual(first.session, 'started', answerOf(first));
    await waitFor(() => /pid=/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the first session to start');

    // That session is still running when it asks its next question, so the
    // second answer is legitimate and reaches the guard (T-0114).
    await askAgain(root, '- And the timezone?');
    const second = await readJson(await answer(server, { text: 'Second.', restart: true }));
    assert.strictEqual(second.session, 'already-running', answerOf(second));
    await sleep(300);
    assert.strictEqual(sessionLogs(root).length, 1, 'no second process was spawned');
    // Both answers are in the file regardless: the write does not depend on the
    // session, and each round kept its own section (T-0114).
    const description = readTask(root).description;
    assert.ok(description.includes('First.'));
    assert.ok(description.includes('Second.'));
    assert.strictEqual((description.match(/^### Answers$/gm) || []).length, 2);
  });

  it('a rejected answer starts no session', async () => {
    const { root, server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('ran {id}')") });
    const res = await answer(server, { text: 'Unsolicited.', restart: true }, { id: 'T-0012' });
    assert.strictEqual(res.status, 409);
    await sleep(300);
    // The sessions directory, not the whole of .briefboard: since T-0186 every
    // board writes its trace under boards/ whether a session runs or not.
    assert.strictEqual(fs.existsSync(sessionsDir(root)), false);
  });
});
