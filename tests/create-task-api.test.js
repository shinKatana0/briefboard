'use strict';

// Integration tests for POST /api/task — creating a task from the board's "+"
// button (T-0074). Each test spawns a real `node server/server.js` against a
// throwaway AGENTBOARD_ROOT, so the real project's doc/ files are never touched.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
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
const { parseBacklog } = require('../server/parser.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

// ---------- fixture helpers ----------

function makeFixtureRoot(backlog = '# Backlog\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-create-test-'));
  const docDir = path.join(root, 'doc');
  fs.mkdirSync(path.join(docDir, 'brief'), { recursive: true });
  fs.writeFileSync(path.join(docDir, 'backlog.md'), backlog);
  return root;
}

function backlogPath(root) {
  return path.join(root, 'doc', 'backlog.md');
}

function readTasks(root) {
  const file = backlogPath(root);
  if (!fs.existsSync(file)) return [];
  return parseBacklog(fs.readFileSync(file, 'utf8'));
}

// Deliberately far above anything a real write needs. The concurrency tests
// below assert that nothing is lost under contention, not how fast the machine
// is: under a full `npm test` the 5s default let the unluckiest of 12 writers
// miss the lock and answer 503, failing the run about a third of the time
// (T-0081).
const STRESS_LOCK_TIMEOUT_MS = '60000';

function startServer(root, env = {}) {
  return startBoard(root, { BRIEFBOARD_LOCK_TIMEOUT_MS: STRESS_LOCK_TIMEOUT_MS, ...env });
}

const activeServers = [];
const activeRoots = [];

async function setup(backlog, env) {
  const root = makeFixtureRoot(backlog);
  activeRoots.push(root);
  const server = await startServer(root, env);
  activeServers.push(server);
  return { root, server };
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) fs.rmSync(activeRoots.pop(), { recursive: true, force: true });
});

/** POST a JSON body (or a raw string, when `raw` is true) to /api/task. */
function postTask(server, body, { raw = false, headers = {} } = {}) {
  return fetch(server.baseUrl + '/api/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw ? body : JSON.stringify(body),
  });
}

/** Run `node tools/task.mjs <args>` as a real child process. Never rejects. */
function runCliAsync(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, AGENTBOARD_ROOT: root, BRIEFBOARD_LOCK_TIMEOUT_MS: STRESS_LOCK_TIMEOUT_MS },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

// ---------- happy path ----------

describe('POST /api/task — creating a task', () => {
  it('201 + the new id; the task lands in status backlog with the given fields', async () => {
    const { root, server } = await setup();
    const res = await postTask(server, {
      title: 'Created from the board',
      type: 'bug',
      priority: 'Critical',
      description: 'Some details.',
    });
    const data = await readJson(res);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(data.id, 'T-0001', answerOf(data));

    const [task] = readTasks(root);
    assert.strictEqual(task.id, 'T-0001');
    assert.strictEqual(task.title, 'Created from the board');
    assert.strictEqual(task.type, 'bug');
    assert.strictEqual(task.priority, 'Critical');
    assert.strictEqual(task.status, 'backlog');
    assert.strictEqual(task.description, 'Some details.');
    assert.deepStrictEqual(task.briefs, []);
    assert.strictEqual(task.closed, '');
    assert.match(task.created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('defaults type to feature, priority to Medium and description to empty', async () => {
    const { root, server } = await setup();
    const res = await postTask(server, { title: 'Bare minimum' });
    assert.strictEqual(res.status, 201);
    const [task] = readTasks(root);
    assert.strictEqual(task.type, 'feature');
    assert.strictEqual(task.priority, 'Medium');
    assert.strictEqual(task.description, '');
  });

  it('continues the id sequence of an existing backlog and never reuses an id', async () => {
    const { root, server } = await setup(
      [
        '# Backlog\n',
        '## T-0007 · Major · Existing task',
        '- type: feature',
        '- status: done',
        '- created: 2026-01-01 00:00:00',
        '- closed: 2026-01-02 00:00:00',
        '- briefs: ',
        '',
      ].join('\n')
    );
    const first = await readJson(await postTask(server, { title: 'Next' }));
    const second = await readJson(await postTask(server, { title: 'And another' }));
    assert.strictEqual(first.id, 'T-0008', answerOf(first));
    assert.strictEqual(second.id, 'T-0009', answerOf(second));
    assert.deepStrictEqual(readTasks(root).map((t) => t.id), ['T-0007', 'T-0008', 'T-0009']);
  });

  it('leaves the rest of the file intact (existing tasks survive the write)', async () => {
    const { root, server } = await setup(
      [
        '# Backlog\n',
        '## T-0001 · Blocker · Keep me',
        '- type: bug',
        '- status: in_progress',
        '- created: 2026-01-01 00:00:00',
        '- closed: —',
        '- briefs: ',
        '',
        'Original description.',
        '',
      ].join('\n')
    );
    await postTask(server, { title: 'New one' });
    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].status, 'in_progress');
    assert.strictEqual(tasks[0].description, 'Original description.');
  });
});

// ---------- method / origin / body guards ----------

describe('POST /api/task — request guards', () => {
  it('405 on a non-POST method, nothing written', async () => {
    const { root, server } = await setup();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await fetch(server.baseUrl + '/api/task', { method });
      const data = await readJson(res);
      assert.strictEqual(res.status, 405, `expected 405 for ${method}`);
      assert.ok(data.error, answerOf(data));
    }
    assert.deepStrictEqual(readTasks(root), []);
  });

  it('403 on a cross-origin Origin, nothing written', async () => {
    const { root, server } = await setup();
    const res = await postTask(server, { title: 'CSRF attempt' }, { headers: { Origin: 'http://evil.example.com' } });
    assert.strictEqual(res.status, 403);
    assert.ok((await readJson(res)).error, answerOf(res));
    assert.deepStrictEqual(readTasks(root), []);
  });

  it('201 on a same-origin Origin (the browser case)', async () => {
    const { server } = await setup();
    const res = await postTask(server, { title: 'From the board' }, { headers: { Origin: server.baseUrl } });
    assert.strictEqual(res.status, 201);
  });

  it('415 when a Content-Type other than application/json is declared', async () => {
    const { root, server } = await setup();
    const res = await fetch(server.baseUrl + '/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'title=via+a+cross-site+form',
    });
    assert.strictEqual(res.status, 415);
    assert.deepStrictEqual(readTasks(root), []);
  });

  it('400 on a malformed JSON body', async () => {
    const { root, server } = await setup();
    const res = await postTask(server, '{ "title": "unterminated', { raw: true });
    const data = await readJson(res);
    assert.strictEqual(res.status, 400);
    assert.match(data.error, /malformed JSON body/, answerOf(data));
    assert.deepStrictEqual(readTasks(root), []);
  });

  it('400 on a JSON body that is not an object', async () => {
    const { server } = await setup();
    for (const body of ['[1,2,3]', '"just a string"', '42']) {
      const res = await postTask(server, body, { raw: true });
      assert.strictEqual(res.status, 400, `expected 400 for body ${body}`);
    }
  });

  it('413 on a body above the 16 KB limit, nothing written', async () => {
    const { root, server } = await setup();
    const huge = JSON.stringify({ title: 'Too big', description: 'x'.repeat(64 * 1024) });
    const res = await postTask(server, huge, { raw: true });
    const data = await readJson(res);
    assert.strictEqual(res.status, 413);
    assert.ok(data.error, answerOf(data));
    assert.deepStrictEqual(readTasks(root), []);
  });

  it('a body just under the limit is still accepted (the cap is on size, not on content)', async () => {
    const { server } = await setup();
    // 4000 chars is the description maximum; the whole body stays well under 16 KB.
    const res = await postTask(server, { title: 'Long but legal', description: 'x'.repeat(4000) });
    assert.strictEqual(res.status, 201);
  });
});

// ---------- field validation ----------

describe('POST /api/task — field validation', () => {
  it('400 on a missing, empty or whitespace-only title', async () => {
    const { root, server } = await setup();
    for (const body of [{}, { title: '' }, { title: '   ' }, { title: null }]) {
      const res = await postTask(server, body);
      const data = await readJson(res);
      assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.match(data.error, /title/, answerOf(data));
    }
    assert.deepStrictEqual(readTasks(root), []);
  });

  it('400 on a non-string title', async () => {
    const { server } = await setup();
    const res = await postTask(server, { title: 42 });
    assert.strictEqual(res.status, 400);
  });

  it('400 on a title longer than 200 characters, 201 at exactly 200', async () => {
    const { server } = await setup();
    const tooLong = await postTask(server, { title: 'x'.repeat(201) });
    assert.strictEqual(tooLong.status, 400);
    const atLimit = await postTask(server, { title: 'x'.repeat(200) });
    assert.strictEqual(atLimit.status, 201);
  });

  it('400 on a title containing a line break — it would split the backlog header line', async () => {
    const { root, server } = await setup();
    for (const title of ['Broken\ntitle', 'Broken\r\ntitle', 'Broken\rtitle']) {
      const res = await postTask(server, { title });
      const data = await readJson(res);
      assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(title)}`);
      assert.match(data.error, /line breaks/, answerOf(data));
    }
    assert.deepStrictEqual(readTasks(root), [], 'nothing written for a rejected title');
  });

  it('400 on an unknown type, and on a type that is not a string', async () => {
    const { root, server } = await setup();
    for (const type of ['chore', '', 'Bug', 7]) {
      const res = await postTask(server, { title: 'Typed', type });
      const data = await readJson(res);
      assert.strictEqual(res.status, 400, `expected 400 for type ${JSON.stringify(type)}`);
      assert.match(data.error, /type/, answerOf(data));
    }
    assert.deepStrictEqual(readTasks(root), []);
  });

  it('400 on an unknown priority', async () => {
    const { root, server } = await setup();
    for (const priority of ['Extreme', 'major', '', 3]) {
      const res = await postTask(server, { title: 'Prioritized', priority });
      const data = await readJson(res);
      assert.strictEqual(res.status, 400, `expected 400 for priority ${JSON.stringify(priority)}`);
      assert.match(data.error, /priority/, answerOf(data));
    }
    assert.deepStrictEqual(readTasks(root), []);
  });

  it('accepts every valid type/priority combination', async () => {
    const { root, server } = await setup();
    const priorities = ['Blocker', 'Critical', 'Major', 'Medium', 'Minor'];
    const types = ['feature', 'bug', 'external'];
    for (const type of types) {
      for (const priority of priorities) {
        const res = await postTask(server, { title: `${type}-${priority}`, type, priority });
        assert.strictEqual(res.status, 201, `expected 201 for ${type}/${priority}`);
      }
    }
    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, 15);
    assert.strictEqual(new Set(tasks.map((t) => t.id)).size, 15);
    assert.deepStrictEqual([...new Set(tasks.map((t) => t.type))].sort(), [...types].sort());
  });

  it('400 on a description longer than 4000 characters and on a non-string description', async () => {
    const { server } = await setup();
    const tooLong = await postTask(server, { title: 'Wordy', description: 'x'.repeat(4001) });
    assert.strictEqual(tooLong.status, 400);
    assert.match((await readJson(tooLong)).error, /description/, answerOf(tooLong));
    const notAString = await postTask(server, { title: 'Wordy', description: { text: 'nope' } });
    assert.strictEqual(notAString.status, 400);
  });
});

// ---------- backlog format safety ----------

describe('POST /api/task — the created task never corrupts doc/backlog.md', () => {
  const { validateBacklog } = require('../server/validate.js');

  function assertValid(root) {
    const text = fs.readFileSync(backlogPath(root), 'utf8');
    // '': the endpoint under test writes only doc/backlog.md, and these temp
    // roots never get an archive (T-0169 - the argument is required).
    assert.deepStrictEqual(validateBacklog(text, path.join(root, 'doc', 'brief'), ''), []);
  }

  it('a description whose line looks like a task header ("## T-0001 · ...") keeps validate clean', async () => {
    const { root, server } = await setup();
    const description = 'Context:\n## T-0001 · Blocker · Not a real task\nand more text';
    const res = await postTask(server, { title: 'Header lookalike', description });
    assert.strictEqual(res.status, 201);

    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, 1, 'the fake header did not spawn a phantom task');
    assert.strictEqual(tasks[0].description, description);
    assertValid(root);
  });

  it('markdown-heavy titles/descriptions (·, backticks, code fences) stay parseable and valid', async () => {
    const { root, server } = await setup();
    const description = 'Notes:\n- type: bug\n- status: done\n\n```\n## T-9999 · Major · nope\n```';
    const res = await postTask(server, {
      title: 'UI · export — `code` in the title',
      description,
    });
    assert.strictEqual(res.status, 201);
    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].title, 'UI · export — `code` in the title');
    // "- status: done" inside the body of the description is plain markdown,
    // not a field: the task keeps the status the endpoint gave it.
    assert.strictEqual(tasks[0].status, 'backlog');
    assert.strictEqual(tasks[0].description, description);
    assertValid(root);
  });

  it('a description STARTING with a "- key: value" line is accepted and never becomes a field (T-0080)', async () => {
    const { root, server } = await setup();
    const descriptions = ['- status: done', '\n\n- type: bug\nmore text', '- closed: 2026-01-01'];
    for (const description of descriptions) {
      const res = await postTask(server, { title: 'Field lookalike', description });
      assert.strictEqual(res.status, 201, `expected 201 for ${JSON.stringify(description)}`);
    }

    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, descriptions.length);
    for (const [i, task] of tasks.entries()) {
      assert.strictEqual(task.status, 'backlog', 'the description did not rewrite the status');
      assert.strictEqual(task.type, 'feature', 'nor the type');
      assert.strictEqual(task.closed, '');
      assert.strictEqual(task.description, descriptions[i].trim(), 'description kept verbatim');
    }
    assertValid(root);
  });

  it('a leading bullet that is not a field line ("- just a bullet") is accepted as-is', async () => {
    const { root, server } = await setup();
    const description = '- just a bullet\n- another one';
    const res = await postTask(server, { title: 'Bullets', description });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(readTasks(root)[0].description, description);
    assertValid(root);
  });

  it('CRLF in the description is normalized to LF', async () => {
    const { root, server } = await setup();
    await postTask(server, { title: 'Windows client', description: 'first\r\nsecond' });
    assert.strictEqual(readTasks(root)[0].description, 'first\nsecond');
  });
});

// ---------- lock contention vs. real failures (T-0081) ----------

describe('writing endpoints under a held backlog lock', () => {
  const ONE_TASK = [
    '# Backlog\n',
    '## T-0001 · Major · Draggable',
    '- type: feature',
    '- status: backlog',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: ',
    '',
  ].join('\n');

  // A lock file nobody will release, kept fresh so it is never taken for a stale
  // one (the server steals locks older than 10s).
  function holdLock(root) {
    fs.writeFileSync(backlogPath(root) + '.lock', `999999 ${Date.now()}\n`);
  }

  const WRITES = [
    ['create', (server) => postTask(server, { title: 'Contended' })],
    ['cancel', (server) => fetch(server.baseUrl + '/api/task/T-0001/cancel', { method: 'POST' })],
    ['open', (server) => fetch(server.baseUrl + '/api/task/T-0001/open', { method: 'POST' })],
  ];

  it('503 with Retry-After on every writing endpoint, and nothing is written', async () => {
    // A budget short enough that the request answers immediately: what is under
    // test is the answer to a lost race, not how long we are willing to wait.
    const { root, server } = await setup(ONE_TASK, { BRIEFBOARD_LOCK_TIMEOUT_MS: '50' });
    for (const [name, send] of WRITES) {
      holdLock(root);
      const res = await send(server);
      const data = await readJson(res);
      assert.strictEqual(res.status, 503, `${name} must answer 503, not a server error`);
      assert.strictEqual(res.headers.get('retry-after'), '1', `${name} must send Retry-After`);
      assert.match(data.error, /busy/, `${name} must say what is wrong`);
    }
    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, 1, 'no task created while the lock was held');
    assert.strictEqual(tasks[0].status, 'backlog', 'no transition applied either');
  });

  it('a failure that is not lock contention is still a 500', async () => {
    const { root, server } = await setup(ONE_TASK);
    // backlog.md as a directory: the locked read fails with EISDIR, i.e. a real
    // fault rather than contention, so 503 would be a lie.
    fs.rmSync(backlogPath(root));
    fs.mkdirSync(backlogPath(root));
    for (const [name, send] of WRITES) {
      const res = await send(server);
      const data = await readJson(res);
      assert.strictEqual(res.status, 500, `${name} must not turn a real failure into 503`);
      assert.strictEqual(res.headers.get('retry-after'), null, `${name} must not invite a retry`);
      assert.ok(data.error, `${name} must report something`);
    }
    assert.ok(!fs.existsSync(backlogPath(root) + '.lock'), 'the lock is released after the failure');
  });

  it('the lock timeout does not mask an ordinary 404/400', async () => {
    const { server } = await setup(ONE_TASK, { BRIEFBOARD_LOCK_TIMEOUT_MS: '50' });
    const missing = await fetch(server.baseUrl + '/api/task/T-4242/cancel', { method: 'POST' });
    assert.strictEqual(missing.status, 404);
    const invalid = await postTask(server, { title: '' });
    assert.strictEqual(invalid.status, 400);
  });
});

// ---------- concurrency ----------

describe('POST /api/task — concurrent writers (server + CLI)', () => {
  it('parallel HTTP creates lose no task and hand out no duplicate id', async () => {
    const { root, server } = await setup();
    const N = 10;
    const posts = [];
    for (let i = 0; i < N; i++) posts.push(postTask(server, { title: `HTTP task ${i}` }));
    const results = await Promise.all(posts);
    for (const res of results) assert.strictEqual(res.status, 201);
    const ids = await Promise.all(results.map(async (res) => (await readJson(res)).id));

    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, N, 'every create persisted (no lost update)');
    assert.strictEqual(new Set(tasks.map((t) => t.id)).size, N, 'ids unique on disk');
    assert.deepStrictEqual([...ids].sort(), tasks.map((t) => t.id).sort(), 'each response id exists on disk');
  });

  it('HTTP creates racing `task.mjs add` processes: all persist with unique ids', async () => {
    const { root, server } = await setup();
    const N = 6;
    const work = [];
    for (let i = 0; i < N; i++) {
      work.push(postTask(server, { title: `HTTP ${i}` }));
      work.push(runCliAsync(root, ['add', '--title', `CLI ${i}`]));
    }
    const results = await Promise.all(work);
    for (const r of results) {
      if (r && typeof r.status === 'number') assert.strictEqual(r.status, 201);
      else assert.strictEqual(r.code, 0, `CLI add failed: ${r.stderr}`);
    }

    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, 2 * N, 'no update lost between the server and the CLI');
    assert.strictEqual(new Set(tasks.map((t) => t.id)).size, 2 * N, 'no duplicate id from a stale read');
    assert.strictEqual(tasks.filter((t) => t.title.startsWith('HTTP ')).length, N);
    assert.strictEqual(tasks.filter((t) => t.title.startsWith('CLI ')).length, N);
  });
});
