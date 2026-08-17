'use strict';

// The watchdog as the board actually serves it (T-0159): a real
// `node server/server.js` against a throwaway project that is its own git
// repository, with the findings read back from GET /api/sessions — the channel
// they travel on, and the same one the session records use.
//
// The two endings this feature exists for are played out for real here: a worker
// session that commits and dies without writing the status (T-0118), and one
// that runs, writes nothing at all and exits 0 (T-0107). No real agent is ever
// run: the worker command is always a short node script this file writes.
//
// The board is started at the watchdog's floor, 10000ms, unless the test is
// about the interval itself. It used to be started at 0, because the floor was
// only a default and 0 removed it; since T-0228 no environment value goes under
// the floor, so this is as fast as a real board can be told to look.
//
// That costs this file 20 seconds and no more, because the first scan after
// start-up is immediate: only the two tests that cause an event and then wait
// for the scan it triggers — the session that commits and the session that
// leaves nothing — wait the floor out. Measured on this file alone, 31s before
// and 52s after; the whole suite is not the place to measure it, since it runs
// its files in parallel and came out anywhere between 255s and 578s on the same
// machine depending on what else was running.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { fetch, SESSION_START_TIMEOUT_MS } = require('./helpers/bounded.js');
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { SPAWN_WAIT_BUDGET_MS } = require('./helpers/wait.js');
const { removeTree } = require('./helpers/rm.js');

// ---------- the project ----------

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function task(id, status, title) {
  return [
    `## ${id} · Major · ${title}`,
    '- type: feature',
    '- status: ' + status,
    '- created: 2026-01-01 00:00:00',
    '- closed: ' + (status === 'done' ? '2026-01-02 00:00:00' : '—'),
    '- briefs: ' + id + '-01',
    '',
  ].join('\n');
}

function backlog() {
  return [
    '# Backlog\n',
    task('T-0011', 'ready', 'Not started yet'),
    task('T-0013', 'in_progress', 'Taken by an agent the board never started'),
    task('T-0014', 'review', 'Submitted for review'),
    task('T-0015', 'done', 'Accepted'),
  ].join('\n');
}

const servers = [];
const roots = [];

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-watchdog-api-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), backlog());
  fs.writeFileSync(path.join(root, '.gitignore'), '.briefboard/\n');
  git(['init'], root);
  git(['config', 'user.email', 'test@briefboard.invalid'], root);
  git(['config', 'user.name', 'briefboard test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['add', '.gitignore', 'doc/backlog.md'], root);
  git(['commit', '-m', 'init'], root);
  git(['branch', '-M', 'main'], root);
  return root;
}

// A branch carrying a commit main does not have, made the way a worker's
// worktree makes one — without disturbing the checkout the board reads.
function branchWithWork(root, id) {
  const branch = `task/${id}`;
  const wt = path.join(root, '.briefboard', 'worktrees', id);
  git(['worktree', 'add', '-b', branch, wt, 'HEAD'], root);
  fs.writeFileSync(path.join(wt, `${id}.txt`), 'the work\n');
  git(['add', `${id}.txt`], wt);
  git(['commit', '-m', `${id}: the work`], wt);
  return branch;
}

// A worker that commits its work and exits without touching the status — the
// T-0118 ending, in six lines and no agent.
function committingWorker(root) {
  const file = path.join(root, 'fake-worker.js');
  fs.writeFileSync(
    file,
    [
      "'use strict';",
      "const { execFileSync } = require('child_process');",
      "const fs = require('fs');",
      "fs.writeFileSync('work.txt', 'done\\n');",
      "execFileSync('git', ['add', 'work.txt'], { cwd: process.cwd() });",
      "execFileSync('git', ['commit', '-m', 'the work'], { cwd: process.cwd() });",
      "console.log('committed in ' + process.cwd());",
    ].join('\n')
  );
  return `"${process.execPath}" "${file}"`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  while (servers.length) await servers.pop().stop();
  while (roots.length) await removeTree(roots.pop());
});

async function startServer(root, extraEnv = {}) {
  const server = await startBoard(root, { BRIEFBOARD_WATCHDOG_MS: '10000', ...extraEnv });
  servers.push(server);
  return server;
}

async function sessionsOf(server) {
  return readJson(await fetch(server.baseUrl + '/api/sessions'));
}

// The findings are produced by a scan that runs on its own, so a test waits for
// one rather than assuming it has already happened. The deadline is only there
// so a broken watchdog fails the test instead of hanging it.
async function waitForWatchdog(server, predicate, what) {
  const deadline = Date.now() + SPAWN_WAIT_BUDGET_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = (await sessionsOf(server)).watchdog;
    if (last && (await predicate(last))) return last;
    await sleep(100);
  }
  throw new Error(`${what} — the watchdog said ${JSON.stringify(last)}`);
}

const findingOn = (id) => (state) => Boolean(state.findings && state.findings[id]);
const quietOn = (id) => (state) => state.checkedAt && !(state.findings || {})[id];

// ---------- what it reports ----------

describe('the watchdog on GET /api/sessions', () => {
  it('reports a task in review that has no branch, and names the checkout HEAD', async () => {
    const server = await startServer(makeProject());
    const state = await waitForWatchdog(server, findingOn('T-0014'), 'no finding for T-0014');
    assert.strictEqual(state.git, 'ok');
    assert.strictEqual(state.head, 'main');
    assert.deepStrictEqual(state.findings['T-0014'], { kind: 'review-without-branch', branches: [] });
  });

  it('reports a task accepted while its branch is not merged', async () => {
    const root = makeProject();
    branchWithWork(root, 'T-0015');
    const server = await startServer(root);
    const state = await waitForWatchdog(server, findingOn('T-0015'), 'no finding for T-0015');
    assert.deepStrictEqual(state.findings['T-0015'], {
      kind: 'done-not-merged',
      branches: ['task/T-0015'],
    });
  });

  it('says nothing about a task in progress the board never started a session for', async () => {
    const root = makeProject();
    branchWithWork(root, 'T-0013');
    const server = await startServer(root);
    const state = await waitForWatchdog(server, quietOn('T-0013'), 'T-0013 was flagged');
    assert.ok(!state.findings['T-0013'], answerOf(state));
    // And the tasks it does have something to say about are still reported, so
    // this is silence about T-0013 and not a watchdog that never ran.
    assert.strictEqual(state.findings['T-0014'].kind, 'review-without-branch');
  });

  it('reports the work of a session that committed and never wrote the status', async () => {
    const root = makeProject();
    const server = await startServer(root, { BRIEFBOARD_WORKER_CMD: committingWorker(root) });
    // The reply comes after a whole `git worktree add`, which is why this call
    // and not the file's others carries its own budget (T-0223).
    const started = await readJson(
      await fetch(server.baseUrl + '/api/task/T-0011/start', {
        method: 'POST',
        timeoutMs: SESSION_START_TIMEOUT_MS,
      })
    );
    assert.strictEqual(started.session, 'started', answerOf(started));
    const state = await waitForWatchdog(server, findingOn('T-0011'), 'no finding for T-0011');
    assert.strictEqual(state.findings['T-0011'].kind, 'work-not-recorded');
    assert.deepStrictEqual(state.findings['T-0011'].branches, ['task/T-0011']);
  });

  it('reports a session that ended without leaving a single commit', async () => {
    const root = makeProject();
    const server = await startServer(root, {
      BRIEFBOARD_WORKER_CMD: `"${process.execPath}" -e "console.log('nothing to do')"`,
    });
    await fetch(server.baseUrl + '/api/task/T-0011/start', {
      method: 'POST',
      timeoutMs: SESSION_START_TIMEOUT_MS,
    });
    const state = await waitForWatchdog(server, findingOn('T-0011'), 'no finding for T-0011');
    assert.strictEqual(state.findings['T-0011'].kind, 'session-left-nothing');
  });

  it('changes no status and no branch while it reports', async () => {
    const root = makeProject();
    branchWithWork(root, 'T-0015');
    const before = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
    const server = await startServer(root);
    await waitForWatchdog(server, findingOn('T-0015'), 'no finding for T-0015');
    assert.strictEqual(fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8'), before);
    assert.match(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], root), /task\/T-0015/);
    assert.ok(fs.existsSync(path.join(root, '.briefboard', 'worktrees', 'T-0015')));
  });

  it('says nothing at all in a project that is not a git repository', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-watchdog-nogit-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'doc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), backlog());
    const server = await startServer(root);
    const state = await waitForWatchdog(
      server,
      (s) => s.git !== 'unknown',
      'the watchdog never looked'
    );
    assert.strictEqual(state.git, 'not-a-repo');
    assert.deepStrictEqual(state.findings, {});
  });

  it('off means off, and says so rather than pretending everything agrees', async () => {
    const server = await startServer(makeProject(), { BRIEFBOARD_WATCHDOG_MS: 'off' });
    await sleep(300);
    const state = (await sessionsOf(server)).watchdog;
    assert.strictEqual(state.git, 'off');
    assert.strictEqual(state.checkedAt, null);
    assert.deepStrictEqual(state.findings, {});
    assert.match(server.out().stdout, /watchdog: +off/);
  });

  it('names its own cost in the start-up banner', async () => {
    const server = await startServer(makeProject(), { BRIEFBOARD_WATCHDOG_MS: '30000' });
    assert.match(server.out().stdout, /watchdog: +on \(git asked at most every 30000ms, three calls\)/);
  });

  // T-0228, end to end: the floor is enforced on the value a real board reads
  // from a real environment, not only in the parser. `0` is the case that used
  // to reach the schedule intact and put a scan — three git processes — on every
  // backlog write and every session event.
  it('refuses to run below its floor whatever the environment says', async () => {
    const server = await startServer(makeProject(), { BRIEFBOARD_WATCHDOG_MS: '0' });
    assert.match(server.out().stdout, /watchdog: +on \(git asked at most every 10000ms, three calls\)/);
    assert.match(server.out().stderr, /BRIEFBOARD_WATCHDOG_MS: 0ms is below the floor of 10000ms/);
    assert.match(server.out().stderr, /"off"/, 'the message must name the word that turns it off');
  });
});

// ---------- what the board says it watches (T-0187) ----------

describe('the start-up banner', () => {
  it('names the directory the board really watches, not one file in it', async () => {
    const root = makeProject();
    const server = await startServer(root);
    const { stdout } = server.out();
    assert.match(stdout, /watching: +.*doc/);
    assert.match(stdout, /backlog-archive\.md/, 'the archive is watched and the banner hid it');
    assert.match(stdout, /brief\//);
    // The old line named exactly one file, and a reader concluded the archive
    // was not followed — right after archiving into it.
    assert.doesNotMatch(stdout, /watching: +\S+backlog\.md\s*$/m);
  });
});
