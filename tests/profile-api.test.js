'use strict';

// Integration tests for the run profile of a task (T-0108): POST
// /api/task/:id/profile, what /api/board tells the board about the declared
// profiles, and the profile a started session actually runs with. Each test
// spawns a real `node server/server.js` against a throwaway AGENTBOARD_ROOT, so
// the real project's doc/ files are never touched, and no test runs a real
// agent: every session command is a short `node -e ...`.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor } = require('./helpers/wait.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { removeTree } = require('./helpers/rm.js');
const { parseBacklog } = require('../server/parser.js');
const { tempDir } = require('./helpers/tmp.js');

// T-0011 carries a declared profile, T-0012 one that is not declared (the typo
// case), T-0013 none at all, T-0014 is finished.
function sampleBacklog() {
  return [
    '# Backlog\n',
    '## T-0011 · Major · Profiled task',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '- profile: fast',
    '',
    'Mechanical work.',
    '',
    '## T-0012 · Major · Profile with a typo',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '- profile: fst',
    '',
    'Mistyped.',
    '',
    '## T-0013 · Major · No profile of its own',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
    'As usual.',
    '',
    '## T-0014 · Major · Finished long ago',
    '- type: feature',
    '- status: done',
    '- created: 2026-01-01 00:00:00',
    '- closed: 2026-01-02 00:00:00',
    '- briefs: ',
    '',
    'Done.',
    '',
  ].join('\n');
}

function makeFixtureRoot() {
  const root = tempDir('briefboard-profile-test-');
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), sampleBacklog());
  return root;
}

function backlogText(root) {
  return fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
}

function readTask(root, id) {
  return parseBacklog(backlogText(root)).find((t) => t.id === id);
}

function sessionsDir(root) {
  return path.join(root, '.briefboard', 'sessions');
}

function readSessionLogs(root) {
  const dir = sessionsDir(root);
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

// Double quotes so a node path containing spaces survives the argv split; the
// -e script therefore uses single quotes only.
function nodeCmd(script) {
  return `"${process.execPath}" -e "${script}"`;
}

const activeServers = [];
const activeRoots = [];

async function setup(extraEnv = {}) {
  const root = makeFixtureRoot();
  activeRoots.push(root);
  const server = await startBoard(root, extraEnv);
  activeServers.push(server);
  return { root, server };
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) await removeTree(activeRoots.pop());
});

function setProfile(server, id, body, { raw, headers = {}, method = 'POST' } = {}) {
  return fetch(server.baseUrl + `/api/task/${id}/profile`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'POST' ? (raw === undefined ? JSON.stringify(body) : raw) : undefined,
  });
}

// =====================================================================
// writing the field
// =====================================================================
describe('POST /api/task/:id/profile — one field, nothing else', () => {
  it('200 and the declared value lands in the file', async () => {
    const { root, server } = await setup({ BRIEFBOARD_PROFILES: 'deep, fast' });
    const res = await setProfile(server, 'T-0013', { profile: 'fast' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200, answerOf(res));
    assert.deepStrictEqual(data, { ok: true, id: 'T-0013', profile: 'fast' });
    assert.strictEqual(readTask(root, 'T-0013').profile, 'fast');
    assert.match(backlogText(root), /^- profile: fast$/m);
  });

  it('the status and the description are left exactly as they were', async () => {
    const { root, server } = await setup({ BRIEFBOARD_PROFILES: 'deep, fast' });
    await setProfile(server, 'T-0013', { profile: 'deep' });
    const task = readTask(root, 'T-0013');
    assert.strictEqual(task.status, 'backlog');
    assert.strictEqual(task.description, 'As usual.');
    assert.strictEqual(task.closed, '');
  });

  it('an empty value clears the field, and the line goes with it', async () => {
    const { root, server } = await setup({ BRIEFBOARD_PROFILES: 'deep, fast' });
    const res = await setProfile(server, 'T-0011', { profile: '' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(readTask(root, 'T-0011').profile, '');
    assert.ok(!backlogText(root).includes('- profile: fast'));
  });

  it('a value the user did not declare is refused, and the file is untouched', async () => {
    const { root, server } = await setup({ BRIEFBOARD_PROFILES: 'deep, fast' });
    const before = backlogText(root);
    const res = await setProfile(server, 'T-0013', { profile: 'fst' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 400, answerOf(res));
    assert.match(data.error, /deep, fast/, answerOf(res));
    assert.strictEqual(backlogText(root), before);
  });

  it('with nothing declared every value is refused, naming the variable', async () => {
    const { root, server } = await setup();
    const before = backlogText(root);
    const res = await setProfile(server, 'T-0013', { profile: 'fast' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 400, answerOf(res));
    assert.match(data.error, /BRIEFBOARD_PROFILES/, answerOf(res));
    assert.strictEqual(backlogText(root), before);
  });

  it('a non-string profile is refused', async () => {
    const { server } = await setup({ BRIEFBOARD_PROFILES: 'fast' });
    const res = await setProfile(server, 'T-0013', { profile: 42 });
    const data = await readJson(res);
    assert.strictEqual(res.status, 400, answerOf(res));
    assert.match(data.error, /must be a string/, answerOf(res));
  });

  it('a finished task is refused with 409 — its sessions are behind it', async () => {
    const { root, server } = await setup({ BRIEFBOARD_PROFILES: 'fast' });
    const before = backlogText(root);
    const res = await setProfile(server, 'T-0014', { profile: 'fast' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(backlogText(root), before);
  });

  it('a task that does not exist is a 404', async () => {
    const { server } = await setup({ BRIEFBOARD_PROFILES: 'fast' });
    const res = await setProfile(server, 'T-9999', { profile: 'fast' });
    assert.strictEqual(res.status, 404);
  });

  it('GET is not allowed, and a cross-origin POST is rejected before the write', async () => {
    const { root, server } = await setup({ BRIEFBOARD_PROFILES: 'fast' });
    const before = backlogText(root);
    assert.strictEqual((await setProfile(server, 'T-0013', {}, { method: 'GET' })).status, 405);
    const cross = await setProfile(
      server,
      'T-0013',
      { profile: 'fast' },
      { headers: { Origin: 'http://evil.example' } }
    );
    assert.strictEqual(cross.status, 403);
    assert.strictEqual(backlogText(root), before);
  });

  it('a form-encoded body is refused with 415 (the second CSRF barrier)', async () => {
    const { server } = await setup({ BRIEFBOARD_PROFILES: 'fast' });
    const res = await setProfile(
      server,
      'T-0013',
      { profile: 'fast' },
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    assert.strictEqual(res.status, 415);
  });
});

// =====================================================================
// what the board is told
// =====================================================================
describe('/api/board reports the declared profiles', () => {
  it('in declaration order, so the board can offer exactly those', async () => {
    const { server } = await setup({ BRIEFBOARD_PROFILES: ' deep , fast ' });
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.deepStrictEqual(board.sessions.profiles, ['deep', 'fast']);
  });

  it('an empty list when nothing is declared', async () => {
    const { server } = await setup();
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.deepStrictEqual(board.sessions.profiles, []);
  });

  // T-0121: the declaration is half the feature; the board is told which of the
  // two templates has somewhere to put the value, so it can stop offering a
  // choice that reaches nothing.
  it('and which template actually uses {profile}, per kind', async () => {
    const { server } = await setup({
      BRIEFBOARD_PROFILES: 'deep, fast',
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('briefing {id}')"),
      BRIEFBOARD_WORKER_CMD: nodeCmd("console.log('worker {id}')") + ' {profile}',
    });
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.deepStrictEqual(board.sessions.profileUsedBy, { briefing: false, worker: true, orchestrator: false });
  });

  it('both false when the declared profiles reach neither template', async () => {
    const { server } = await setup({
      BRIEFBOARD_PROFILES: 'deep, fast',
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('briefing {id}')"),
      BRIEFBOARD_WORKER_CMD: nodeCmd("console.log('worker {id}')"),
    });
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.deepStrictEqual(board.sessions.profileUsedBy, { briefing: false, worker: false, orchestrator: false });
  });

  it('the task carries its profile into the board payload', async () => {
    const { server } = await setup({ BRIEFBOARD_PROFILES: 'deep, fast' });
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    const byId = new Map(board.tasks.map((t) => [t.id, t]));
    assert.strictEqual(byId.get('T-0011').profile, 'fast');
    assert.strictEqual(byId.get('T-0013').profile, '');
  });
});

// =====================================================================
// the profile a session actually runs with
// =====================================================================
describe('the session runs with the task\'s profile', () => {
  const PRINT_PROFILE = nodeCmd("console.log('ran {id} as [' + process.argv[1] + ']')") + ' {profile}';

  it('the task\'s own profile reaches the command', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_PROFILES: 'deep, fast',
      BRIEFBOARD_SESSION_CMD: PRINT_PROFILE,
    });
    const res = await fetch(server.baseUrl + '/api/task/T-0011/open', { method: 'POST' });
    assert.strictEqual((await readJson(res)).session, 'started', answerOf(res));
    await waitFor(() => /ran T-0011 as \[fast\]/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the output');
  });

  it('a task with no profile runs with the first declared one — no empty argument', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_PROFILES: 'deep, fast',
      BRIEFBOARD_SESSION_CMD: PRINT_PROFILE,
    });
    await fetch(server.baseUrl + '/api/task/T-0013/open', { method: 'POST' });
    await waitFor(() => /ran T-0013 as \[deep\]/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the output');
  });

  it('a profile outside the list starts nothing, and the transition still stands', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_PROFILES: 'deep, fast',
      BRIEFBOARD_SESSION_CMD: PRINT_PROFILE,
    });
    const res = await fetch(server.baseUrl + '/api/task/T-0012/open', { method: 'POST' });
    const data = await readJson(res);

    assert.strictEqual(res.status, 200, answerOf(res));
    assert.strictEqual(data.session, 'unknown-profile', answerOf(res));
    assert.strictEqual(readTask(root, 'T-0012').status, 'open', 'the drag itself stands');
    assert.strictEqual(readSessionLogs(root), '', 'no session log was even opened');
    await waitFor(() => /fst/.test(server.getStderr()), SPAWN_WAIT_BUDGET_MS, 'the reason on the board log');
    assert.match(server.getStderr(), /BRIEFBOARD_PROFILES/);
  });

  it('with no profiles declared the field is ignored and the session runs as before', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('briefing {id}')"),
    });
    const res = await fetch(server.baseUrl + '/api/task/T-0012/open', { method: 'POST' });
    assert.strictEqual((await readJson(res)).session, 'started', answerOf(res));
    await waitFor(() => /briefing T-0012/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the output');
  });

  it('a command using {profile} with nothing declared is disabled, not run with a hole in it', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_SESSION_CMD: PRINT_PROFILE,
    });
    const res = await fetch(server.baseUrl + '/api/task/T-0013/open', { method: 'POST' });
    assert.strictEqual((await readJson(res)).session, 'disabled', answerOf(res));
    assert.strictEqual(readSessionLogs(root), '');
    assert.match(server.getStderr(), /BRIEFBOARD_PROFILES/);
  });
});
