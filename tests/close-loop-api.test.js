'use strict';

// Integration tests for closing a task from the board (T-0148): GET /api/git/:id,
// POST /api/task/:id/done and POST /api/task/:id/remove-worktree.
//
// Every git scenario runs on a throwaway repository this file creates under the
// OS temp directory — no git command here touches the real repository — and each
// test spawns a real `node server/server.js` against it.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Bounded, so no request here can hang the run (T-0124).
const { fetch } = require('./helpers/bounded.js');
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const { parseBacklog } = require('../server/parser.js');
const { removeTree } = require('./helpers/rm.js');
const { tempDir } = require('./helpers/tmp.js');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function backlog() {
  return [
    '# Backlog\n',
    '## T-0013 · Major · A task still being worked on',
    '- type: feature',
    '- status: in_progress',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0013-01',
    '',
    '## T-0014 · Major · Submitted for review',
    '- type: feature',
    '- status: review',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0014-01',
    '',
    'The worker is done with it.',
    '',
    '## T-0015 · Major · Accepted already',
    '- type: feature',
    '- status: done',
    '- created: 2026-01-01 00:00:00',
    '- closed: 2026-01-02 00:00:00',
    '- briefs: T-0015-01',
    '',
  ].join('\n');
}

const activeServers = [];
const activeRoots = [];

// A project that is also a git repository with one commit on `main`, and
// .briefboard/ ignored exactly as in a real project.
function makeProject() {
  const root = fs.realpathSync(tempDir('briefboard-close-loop-'));
  activeRoots.push(root);
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), backlog());
  fs.writeFileSync(path.join(root, '.gitignore'), '.briefboard/\n');
  git(['init'], root);
  git(['config', 'user.email', 'test@briefboard.invalid'], root);
  git(['config', 'user.name', 'briefboard test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['add', '.gitignore', 'doc/backlog.md'], root);
  git(['commit', '-m', 'init'], root);
  // Not `git init -b main`: that flag is younger than some of the git versions
  // this suite may meet, and the branch name is asserted below.
  git(['branch', '-M', 'main'], root);
  return root;
}

function worktreePath(root, id) {
  return path.join(root, '.briefboard', 'worktrees', id);
}

// What the board's own runner leaves behind: a branch `task/T-NNNN` with work on
// it, checked out in .briefboard/worktrees/T-NNNN.
function makeWorkerBranch(root, id, branch = `task/${id}`) {
  const wt = worktreePath(root, id);
  git(['worktree', 'add', '-b', branch, wt, 'HEAD'], root);
  fs.writeFileSync(path.join(wt, 'feature.txt'), 'the work\n');
  git(['add', 'feature.txt'], wt);
  git(['commit', '-m', `${id}: the work`], wt);
  return wt;
}

function mergeBranch(root, branch) {
  git(['merge', '--no-ff', '-m', `merge ${branch}`, branch], root);
}

function branches(root) {
  return git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], root).split('\n');
}

function taskIn(root, id) {
  const text = fs.readFileSync(path.join(root, 'doc', 'backlog.md'), 'utf8');
  return parseBacklog(text).find((t) => t.id === id);
}

async function startServer(root, extraEnv = {}) {
  const server = await startBoard(root, extraEnv);
  activeServers.push(server);
  return server;
}

afterEach(async () => {
  while (activeServers.length) await activeServers.pop().stop();
  while (activeRoots.length) await removeTree(activeRoots.pop());
});

function gitState(server, id) {
  return fetch(server.baseUrl + `/api/git/${id}`);
}

function post(server, id, action) {
  return fetch(server.baseUrl + `/api/task/${id}/${action}`, { method: 'POST' });
}

// ---------- reading the state ----------

describe('GET /api/git/:id', () => {
  it('reports no branch for a task nobody branched for', async () => {
    const server = await startServer(makeProject());
    const data = await readJson(await gitState(server, 'T-0014'));
    assert.strictEqual(data.git, 'ok', answerOf(data));
    assert.strictEqual(data.branch, null, answerOf(data));
    assert.deepStrictEqual(data.branches, [], answerOf(data));
    assert.strictEqual(data.merged, null, answerOf(data));
    assert.strictEqual(data.worktree, null, answerOf(data));
  });

  it('sees an unmerged branch and names the branch HEAD is on', async () => {
    const root = makeProject();
    makeWorkerBranch(root, 'T-0014');
    const server = await startServer(root);
    const data = await readJson(await gitState(server, 'T-0014'));
    assert.strictEqual(data.branch, 'task/T-0014', answerOf(data));
    assert.strictEqual(data.merged, false, answerOf(data));
    assert.strictEqual(data.head, 'main', answerOf(data));
    assert.strictEqual(data.worktreeClean, true, answerOf(data));
  });

  it('sees the merge as soon as it happens, with no restart and no board write', async () => {
    const root = makeProject();
    makeWorkerBranch(root, 'T-0014');
    const server = await startServer(root);
    const before = await readJson(await gitState(server, 'T-0014'));
    assert.strictEqual(before.merged, false, answerOf(before));
    mergeBranch(root, 'task/T-0014');
    const after = await readJson(await gitState(server, 'T-0014'));
    assert.strictEqual(after.merged, true, answerOf(after));
  });

  it('finds a branch named task/T-NNNN-slug, the spelling a hand-run worker uses', async () => {
    const root = makeProject();
    makeWorkerBranch(root, 'T-0014', 'task/T-0014-close-the-loop');
    const server = await startServer(root);
    const data = await readJson(await gitState(server, 'T-0014'));
    assert.strictEqual(data.branch, 'task/T-0014-close-the-loop', answerOf(data));
  });

  it('refuses to pick between two branches of the same task', async () => {
    const root = makeProject();
    makeWorkerBranch(root, 'T-0014', 'task/T-0014');
    git(['branch', 'task/T-0014-v2', 'task/T-0014'], root);
    const server = await startServer(root);
    const data = await readJson(await gitState(server, 'T-0014'));
    assert.strictEqual(data.branch, null, answerOf(data));
    assert.strictEqual(data.merged, null, answerOf(data));
    assert.deepStrictEqual(data.branches.sort(), ['task/T-0014', 'task/T-0014-v2'], answerOf(data));
  });

  it('calls uncommitted changes in the worktree what they are', async () => {
    const root = makeProject();
    const wt = makeWorkerBranch(root, 'T-0014');
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'not committed\n');
    const server = await startServer(root);
    const data = await readJson(await gitState(server, 'T-0014'));
    assert.strictEqual(data.worktreeClean, false, answerOf(data));
  });

  it('says the project is not a git working tree instead of failing', async () => {
    const root = fs.realpathSync(tempDir('briefboard-close-loop-bare-'));
    activeRoots.push(root);
    fs.mkdirSync(path.join(root, 'doc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), backlog());
    const server = await startServer(root);
    const data = await readJson(await gitState(server, 'T-0014'));
    assert.strictEqual(data.git, 'not-a-repo', answerOf(data));
  });

  it('is a read: POST is refused', async () => {
    const server = await startServer(makeProject());
    const res = await fetch(server.baseUrl + '/api/git/T-0014', { method: 'POST' });
    assert.strictEqual(res.status, 405);
  });
});

// ---------- accepting ----------

describe('POST /api/task/:id/done', () => {
  it('refuses while the branch is not merged, and leaves the backlog alone', async () => {
    const root = makeProject();
    makeWorkerBranch(root, 'T-0014');
    const server = await startServer(root);
    const res = await post(server, 'T-0014', 'done');
    const data = await readJson(res);
    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'not-merged', answerOf(data));
    assert.match(data.error, /task\/T-0014/, answerOf(data));
    assert.strictEqual(taskIn(root, 'T-0014').status, 'review');
  });

  it('accepts once the branch is merged and stamps closed', async () => {
    const root = makeProject();
    makeWorkerBranch(root, 'T-0014');
    mergeBranch(root, 'task/T-0014');
    const server = await startServer(root);
    const data = await readJson(await post(server, 'T-0014', 'done'));
    assert.strictEqual(data.status, 'done', answerOf(data));
    const task = taskIn(root, 'T-0014');
    assert.strictEqual(task.status, 'done');
    assert.match(task.closed, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('accepts a task nobody branched for: there is nothing to check', async () => {
    const root = makeProject();
    const server = await startServer(root);
    const data = await readJson(await post(server, 'T-0014', 'done'));
    assert.strictEqual(data.status, 'done', answerOf(data));
  });

  it('accepts when two branches match: the ambiguity is the board\'s, not the human\'s', async () => {
    const root = makeProject();
    makeWorkerBranch(root, 'T-0014');
    git(['branch', 'task/T-0014-v2', 'task/T-0014'], root);
    const server = await startServer(root);
    const data = await readJson(await post(server, 'T-0014', 'done'));
    assert.strictEqual(data.status, 'done', answerOf(data));
  });

  it('refuses a task that is not in review', async () => {
    const root = makeProject();
    const server = await startServer(root);
    const res = await post(server, 'T-0013', 'done');
    const data = await readJson(res);
    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(taskIn(root, 'T-0013').status, 'in_progress');
  });

  it('answers 404 for an id the backlog does not have', async () => {
    const server = await startServer(makeProject());
    const res = await post(server, 'T-0099', 'done');
    assert.strictEqual(res.status, 404);
  });

  it('is a write: GET is refused and a cross-origin POST is rejected', async () => {
    const root = makeProject();
    const server = await startServer(root);
    assert.strictEqual((await fetch(server.baseUrl + '/api/task/T-0014/done')).status, 405);
    const cross = await fetch(server.baseUrl + '/api/task/T-0014/done', {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
    });
    assert.strictEqual(cross.status, 403);
    assert.strictEqual(taskIn(root, 'T-0014').status, 'review');
  });
});

// ---------- cleaning up ----------

describe('POST /api/task/:id/remove-worktree', () => {
  it('removes the worktree once the branch is merged and the tree is clean', async () => {
    const root = makeProject();
    const wt = makeWorkerBranch(root, 'T-0014');
    mergeBranch(root, 'task/T-0014');
    const server = await startServer(root);
    const data = await readJson(await post(server, 'T-0014', 'remove-worktree'));
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(fs.existsSync(wt), false, 'the directory is gone');
    // The branch and its commits are not the board's to delete.
    assert.ok(branches(root).includes('task/T-0014'), 'the branch is still there');
  });

  it('cleans up after an accepted task too, which is when it is usually wanted', async () => {
    const root = makeProject();
    const wt = makeWorkerBranch(root, 'T-0015');
    mergeBranch(root, 'task/T-0015');
    const server = await startServer(root);
    const data = await readJson(await post(server, 'T-0015', 'remove-worktree'));
    assert.strictEqual(data.ok, true, answerOf(data));
    assert.strictEqual(fs.existsSync(wt), false);
  });

  it('refuses an unmerged branch with the reason, and keeps the directory', async () => {
    const root = makeProject();
    const wt = makeWorkerBranch(root, 'T-0014');
    const server = await startServer(root);
    const res = await post(server, 'T-0014', 'remove-worktree');
    const data = await readJson(res);
    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'not-merged', answerOf(data));
    assert.strictEqual(fs.existsSync(wt), true, 'nothing was deleted');
  });

  it('refuses uncommitted changes rather than forcing them away', async () => {
    const root = makeProject();
    const wt = makeWorkerBranch(root, 'T-0014');
    mergeBranch(root, 'task/T-0014');
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'never committed\n');
    const server = await startServer(root);
    const res = await post(server, 'T-0014', 'remove-worktree');
    const data = await readJson(res);
    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'dirty', answerOf(data));
    assert.strictEqual(fs.readFileSync(path.join(wt, 'scratch.txt'), 'utf8'), 'never committed\n');
  });

  it('will not guess between two branches when it is about to delete', async () => {
    const root = makeProject();
    const wt = makeWorkerBranch(root, 'T-0014');
    mergeBranch(root, 'task/T-0014');
    git(['branch', 'task/T-0014-v2', 'task/T-0014'], root);
    const server = await startServer(root);
    const res = await post(server, 'T-0014', 'remove-worktree');
    const data = await readJson(res);
    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'ambiguous-branch', answerOf(data));
    assert.strictEqual(fs.existsSync(wt), true);
  });

  it('refuses while the task is still in progress: that directory is the work', async () => {
    const root = makeProject();
    const wt = makeWorkerBranch(root, 'T-0013');
    mergeBranch(root, 'task/T-0013');
    const server = await startServer(root);
    const res = await post(server, 'T-0013', 'remove-worktree');
    const data = await readJson(res);
    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'bad-status', answerOf(data));
    assert.strictEqual(fs.existsSync(wt), true);
  });

  it('answers 404 when there is no worktree left to remove', async () => {
    const root = makeProject();
    const server = await startServer(root);
    const res = await post(server, 'T-0014', 'remove-worktree');
    const data = await readJson(res);
    assert.strictEqual(res.status, 404, answerOf(data));
    assert.strictEqual(data.reason, 'no-worktree', answerOf(data));
  });

  it('refuses while a session is running: the review session reads that tree', async () => {
    const root = makeProject();
    const wt = makeWorkerBranch(root, 'T-0014');
    mergeBranch(root, 'task/T-0014');
    const server = await startServer(root, {
      BRIEFBOARD_ORCHESTRATOR_CMD: `"${process.execPath}" -e "setTimeout(()=>{}, 30000)"`,
    });
    const started = await readJson(await post(server, 'T-0014', 'review'));
    assert.strictEqual(started.session, 'started', answerOf(started));
    const res = await post(server, 'T-0014', 'remove-worktree');
    const data = await readJson(res);
    assert.strictEqual(res.status, 409, answerOf(data));
    assert.strictEqual(data.reason, 'session-running', answerOf(data));
    assert.strictEqual(fs.existsSync(wt), true);
  });
});
