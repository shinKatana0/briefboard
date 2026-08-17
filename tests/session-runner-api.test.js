'use strict';

// Integration tests for the agent session runner behind POST /api/task/:id/open
// (T-0076). Each test spawns a real `node server/server.js` against a throwaway
// AGENTBOARD_ROOT, so the real project's doc/ files are never touched.
//
// No test ever runs a real agent: BRIEFBOARD_SESSION_CMD is always a short
// `node -e ...` command.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor } = require('./helpers/wait.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { removeTree } = require('./helpers/rm.js');
// The board's own liveness check, not a hand-written kill(pid, 0): on POSIX that
// succeeds for a killed-but-unreaped process, so a test writing it itself reads
// a zombie as a live session (T-0202, T-0209).
const { isProcessAlive } = require('../server/sessions.js');

// ---------- fixture helpers ----------

function sampleBacklog() {
  return [
    '# Backlog\n',
    '## T-0011 · Major · Backlog task',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
    '## T-0012 · Major · Another backlog task',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
  ].join('\n');
}

function makeFixtureRoot(backlog = sampleBacklog()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-session-api-test-'));
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), backlog);
  return root;
}

// server.js collapses a burst of fs.watch events into one broadcast this far
// apart; a test that has to tell two frames apart has to outlast it.
const BROADCAST_DEBOUNCE_MS = 150;

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

function backlogText(root) {
  return fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
}

// Double quotes so a node path containing spaces survives; the -e scripts below
// therefore use single quotes only.
function q(value) {
  return `"${value}"`;
}

function nodeCmd(script, extraArgs = '') {
  return `${q(process.execPath)} -e ${q(script)}${extraArgs ? ' ' + extraArgs : ''}`;
}

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

function open(server, id = 'T-0011') {
  return fetch(server.baseUrl + `/api/task/${id}/open`, { method: 'POST' });
}

// A session that stays alive until it is killed, announcing its pid first.
const LONG_SESSION = "console.log('pid=' + process.pid); setInterval(function(){}, 1000)";

// ---------- disabled by default ----------

describe('POST /api/task/:id/open without BRIEFBOARD_SESSION_CMD', () => {
  it('behaves exactly as before: the transition happens and session is "disabled"', async () => {
    const { root, server } = await setup();
    const res = await open(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(data.status, 'open', answerOf(data));
    assert.strictEqual(data.session, 'disabled', answerOf(data));
    assert.match(backlogText(root), /## T-0011[\s\S]*?- status: open/);
  });

  it('spawns nothing at all (no .briefboard/sessions directory is created)', async () => {
    const { root, server } = await setup();
    await open(server);
    await sleep(200);
    // The sessions directory, not the whole of .briefboard: since T-0186 every
    // board writes its trace under boards/ whether a session runs or not.
    assert.strictEqual(fs.existsSync(sessionsDir(root)), false);
  });

  it('/api/board reports sessions.enabled === false', async () => {
    const { server } = await setup();
    const data = await readJson(await fetch(server.baseUrl + '/api/board'));
    // `worker` is the second, independently configured command (T-0084);
    // `profileUsedBy` is which template contains {profile} (T-0121).
    assert.deepStrictEqual(data.sessions, {
      enabled: false,
      worker: false,
      orchestrator: false,
      profiles: [],
      profileUsedBy: { briefing: false, worker: false, orchestrator: false },
    });
  });
});

// ---------- enabled ----------

describe('POST /api/task/:id/open with a configured session command', () => {
  it('moves the task to open AND starts the session, logging its output', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('briefing {id}'); console.error('to stderr')"),
    });
    const data = await readJson(await open(server));

    assert.strictEqual(data.status, 'open', answerOf(data));
    assert.strictEqual(data.session, 'started', answerOf(data));
    assert.match(backlogText(root), /## T-0011[\s\S]*?- status: open/);

    await waitFor(() => /briefing T-0011/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'session stdout');
    await waitFor(() => /to stderr/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'session stderr');
    assert.match(sessionLogs(root)[0], /^T-0011-.*\.log$/);
  });

  it('writes session logs outside doc/, where the board watcher cannot see them', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('hello {id}')"),
    });
    await open(server);
    await waitFor(() => sessionLogs(root).length === 1, SPAWN_WAIT_BUDGET_MS, 'the session log');
    const docFiles = fs.readdirSync(path.join(root, 'doc'));
    assert.deepStrictEqual(docFiles.sort(), ['backlog.md', 'brief']);
  });

  it('/api/board reports sessions.enabled === true', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd('0') });
    const data = await readJson(await fetch(server.baseUrl + '/api/board'));
    // The briefing command alone leaves the worker one off.
    assert.deepStrictEqual(data.sessions, {
      enabled: true,
      worker: false,
      orchestrator: false,
      profiles: [],
      profileUsedBy: { briefing: false, worker: false, orchestrator: false },
    });
  });

  it('the command is never taken from the request body', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('configured {id}')"),
    });
    const res = await fetch(server.baseUrl + '/api/task/T-0011/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: nodeCmd("console.log('INJECTED')"),
        cmd: 'whoami',
        args: ['--yolo'],
      }),
    });
    const data = await readJson(res);
    assert.strictEqual(data.session, 'started', answerOf(data));
    await waitFor(() => /configured T-0011/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the configured command to run');
    assert.doesNotMatch(readSessionLogs(root), /INJECTED/);
  });

  it('honours BRIEFBOARD_SESSION_MAX: past the cap the answer is "limit"', async () => {
    const { server } = await setup({
      BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION),
      BRIEFBOARD_SESSION_MAX: '1',
    });
    const first = await readJson(await open(server, 'T-0011'));
    const second = await readJson(await open(server, 'T-0012'));

    assert.strictEqual(first.session, 'started', answerOf(first));
    assert.strictEqual(second.session, 'limit', answerOf(second));
    // The transition itself still happened for the second task.
    assert.strictEqual(second.status, 'open', answerOf(second));
  });
});

// ---------- questions instead of a brief (T-0083) ----------

describe('a session that ends with questions instead of ready', () => {
  const ASK_SESSION = [
    "var fs = require('fs');",
    "var p = 'doc/backlog.md';",
    "var h = '### Session questions';",
    "var text = fs.readFileSync(p, 'utf8');",
    "var at = text.indexOf('## T-0012');",
    "fs.writeFileSync(p, text.slice(0, at) + h + '\\n\\n- Which date format is canonical?\\n\\n' + text.slice(at));",
    "console.log('asked about {id}');",
  ].join(' ');

  it('is a normal ending: the task stays open and the board flags it as awaiting an answer', async () => {
    const { root, server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(ASK_SESSION) });
    const data = await readJson(await open(server));
    assert.strictEqual(data.session, 'started', answerOf(data));

    await waitFor(() => /asked about T-0011/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the session to finish');
    await waitFor(
      () => /### Session questions/.test(backlogText(root)),
      SPAWN_WAIT_BUDGET_MS,
      'the questions section in the backlog'
    );

    // Nothing rolled the transition back, and nothing re-ran the session.
    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    const task = board.tasks.find((t) => t.id === 'T-0011');
    assert.strictEqual(task.status, 'open');
    assert.strictEqual(task.awaitingAnswer, true);
    assert.strictEqual(board.tasks.find((t) => t.id === 'T-0012').awaitingAnswer, false, answerOf(board));
    assert.doesNotMatch(server.getStderr(), /session T-0011/);
    assert.strictEqual(sessionLogs(root).length, 1);
  });
});

// ---------- non-loopback bind ----------

describe('a non-loopback bind disables sessions', () => {
  it('warns at start-up and answers "disabled" even with a command configured', async () => {
    const { root, server } = await setup({
      HOST: '0.0.0.0',
      BRIEFBOARD_SESSION_CMD: nodeCmd("console.log('should not run {id}')"),
    });
    assert.match(server.getStderr(), /WARNING[\s\S]*loopback[\s\S]*sessions are disabled/i);

    const data = await readJson(await open(server));
    assert.strictEqual(data.status, 'open', answerOf(data));
    assert.strictEqual(data.session, 'disabled', answerOf(data));
    await sleep(300);
    // The sessions directory, not the whole of .briefboard: since T-0186 every
    // board writes its trace under boards/ whether a session runs or not.
    assert.strictEqual(fs.existsSync(sessionsDir(root)), false);
  });
});

// ---------- failures ----------

describe('a session that cannot start', () => {
  it('200 + session:"error", the task stays open and the server keeps serving', async () => {
    const { root, server } = await setup({
      BRIEFBOARD_SESSION_CMD: 'briefboard-no-such-binary-xyz --task {id}',
    });
    const res = await open(server);
    const data = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(data.status, 'open', answerOf(data));
    assert.strictEqual(data.session, 'error', answerOf(data));
    // The transition is NOT rolled back.
    assert.match(backlogText(root), /## T-0011[\s\S]*?- status: open/);

    const board = await readJson(await fetch(server.baseUrl + '/api/board'));
    assert.strictEqual(board.tasks.find((t) => t.id === 'T-0011').status, 'open', answerOf(board));
    const second = await readJson(await open(server, 'T-0012'));
    assert.strictEqual(second.status, 'open', answerOf(second));
  });

  it('an unparseable command template disables sessions instead of crashing the server', async () => {
    const { server } = await setup({ BRIEFBOARD_SESSION_CMD: 'agent -p "unterminated' });
    assert.match(server.getStderr(), /not parseable/);
    const data = await readJson(await open(server));
    assert.strictEqual(data.status, 'open', answerOf(data));
    assert.strictEqual(data.session, 'disabled', answerOf(data));
  });
});

// ---------- SSE ----------

describe('session logs do not trigger the board SSE', () => {
  it('output written to a session log produces no further "changed" events', async () => {
    const chatty =
      "var i=0; var t=setInterval(function(){ console.log('line ' + (++i)); if (i>40) { clearInterval(t); } }, 20)";
    const { root, server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(chatty) });

    const res = await fetch(server.baseUrl + '/events');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
        }
      } catch {
        /* cancelled */
      }
    })();
    const changed = () => (buffer.match(/data: changed/g) || []).length;
    const sessionEvents = () => (buffer.match(/data: sessions/g) || []).length;

    await waitFor(() => buffer.includes('data: connected'), SPAWN_WAIT_BUDGET_MS, 'the SSE handshake');
    await open(server);

    // The backlog write itself is a board change, so exactly one 'changed' is
    // expected; wait for it to settle.
    await waitFor(() => changed() >= 1, SPAWN_WAIT_BUDGET_MS, 'the backlog "changed" event');
    const afterOpen = changed();

    // The subject is the ABSENCE of events, which cannot be waited for. The
    // window used to be a 900 ms sleep guarded by "the log grew" — a guard on
    // how much CPU the child got, so a loaded machine failed it while the
    // property under test was intact (T-0140). Three observations close it
    // instead. The burst and the exit put every write that could raise an event
    // in the past; 'sessions' is not debounced, so it dates the stream past the
    // exit.
    await waitFor(() => /line 41\b/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the session log');
    await waitFor(() => sessionEvents() >= 2, SPAWN_WAIT_BUDGET_MS, 'the session start and exit events');

    // The one wait on a duration, and no condition replaces it: a 'changed' from
    // the last log write is still inside the 150 ms debounce, and the flush
    // below would reset that timer and collapse the two into one frame. Bounded
    // by the product's constant rather than by the machine, so a slow machine
    // can let a real event hide but never invent one.
    await sleep(3 * BROADCAST_DEBOUNCE_MS);

    // A real board change flushes the stream, recognised by the title it carries
    // and not by the count going up — the count going up is the symptom under
    // test. Frames arrive in order, so once this one is in the buffer, so is
    // every frame the session's writes could have raised.
    const marker = 'FLUSH-MARKER';
    fs.writeFileSync(
      path.join(root, 'doc', 'backlog.md'),
      backlogText(root).replace('Another backlog task', marker)
    );
    await waitFor(() => buffer.includes(marker), SPAWN_WAIT_BUDGET_MS, 'the frame of a real board change');
    assert.strictEqual(changed(), afterOpen + 1, 'log writes must not produce SSE events');

    await reader.cancel().catch(() => {});
    await pump;
  });
});

// ---------- lifetime ----------

describe('no session outlives the server', () => {
  it('stopping the server kills the running session', async () => {
    const { root, server } = await setup({ BRIEFBOARD_SESSION_CMD: nodeCmd(LONG_SESSION) });
    const data = await readJson(await open(server));
    assert.strictEqual(data.session, 'started', answerOf(data));

    await waitFor(() => /pid=\d+/.test(readSessionLogs(root)), SPAWN_WAIT_BUDGET_MS, 'the session pid');
    const pid = Number(readSessionLogs(root).match(/pid=(\d+)/)[1]);
    assert.ok(isProcessAlive(pid), 'the session should be running before the server stops');

    await server.stop();
    await waitFor(() => !isProcessAlive(pid), SPAWN_WAIT_BUDGET_MS, 'the session to die with the server');
    assert.strictEqual(isProcessAlive(pid), false);
  });
});
