'use strict';

// Tests for tools/task.mjs -- the CLI agents use to edit doc/backlog.md / doc/brief/.
// The four commands that start sessions: start, review-start, rework, resume.
// Run with: npm test
//
// Each test runs the CLI as a real child process (node tools/task.mjs ...) against a
// throwaway AGENTBOARD_ROOT, so the project doc/backlog.md and doc/brief/ are never
// touched. Assertions check both what the CLI does (stdout, exit code) and the
// resulting doc/backlog.md (via parseBacklog).
//
// One of several files, because one file for the whole CLI reached 651.5s of a 706s
// run here while every test in this suite runs under a 120s bound -- which node 22
// applies to the FILE and node 24 does not, so CI cancelled it and nothing here said
// a word (T-0335). What these files share -- runCli, the throwaway root, the pacing
// hook -- is in tests/helpers/task-cli.js.

require('./helpers/env.js');
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { fetch, SESSION_START_TIMEOUT_MS } = require('./helpers/bounded.js');
const { TRACE_VERSION } = require('../server/trace.js');
const { waitFor, SPAWN_WAIT_BUDGET_MS } = require('./helpers/wait.js');
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const {
  CLI_PATH,
  runCli,
  makeTmpRoot,
  backlogPath,
  readTasks,
  add,
  addBrief,
} = require('./helpers/task-cli.js');

// ---------- the clients of actions the board already performs (T-0319, T-0320) ----------
//
// What is under test here is the TRANSLATION, not the rules: the `ready` gate,
// the dependency gate and the worktree live in POST /api/task/:id/start, the
// `review` gate in POST /api/task/:id/review, and both are covered by
// tests/worker-session-api.test.js and tests/review-session-api.test.js. This
// file asks the questions a caller of the CLI asks — did it find the board, did
// it refuse before writing anything, and does the exit code say the same thing as
// `--json`'s `reason`.
//
// One suite for both commands because they are one client: the fixtures below
// were written for `start` and are used unchanged by `review-start` (T-0320), and
// a second copy of them is exactly what that card exists to avoid.
describe('task.mjs start and review-start (T-0319, T-0320)', () => {
  const boards = [];
  const strays = [];
  const closers = [];

  afterEach(async () => {
    while (boards.length) await boards.pop().stop();
    while (closers.length) await closers.pop()();
    for (const child of strays.splice(0)) child.kill();
  });

  // spawnSync has no deadline of its own, and `start` legitimately waits for the
  // board to finish a `git worktree add` and the project's setup command before
  // it answers. SESSION_START_TIMEOUT_MS is the number helpers/bounded.js
  // measured for exactly that request under this suite's own load (T-0223), so
  // the bound here is that one rather than a fresh guess at it.
  function runStart(root, args) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, AGENTBOARD_ROOT: root },
      encoding: 'utf8',
      timeout: SESSION_START_TIMEOUT_MS,
    });
  }

  // The same call, driven asynchronously. Needed by exactly one test: its board
  // is an http server inside THIS process, and spawnSync blocks this process's
  // event loop — so the request would never be answered and the CLI would sit
  // there until its own deadline. Every other test's board is a separate process
  // and does not care.
  function runStartAsync(root, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, ...args], {
        env: { ...process.env, AGENTBOARD_ROOT: root },
        timeout: SESSION_START_TIMEOUT_MS,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c.toString()));
      child.stderr.on('data', (c) => (stderr += c.toString()));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  // Double quotes so a node path with spaces survives the argv split; the -e
  // script therefore uses single quotes only (the worker-session suite's rule).
  const q = (value) => `"${value}"`;
  const nodeCmd = (script) => `${q(process.execPath)} -e ${q(script)}`;
  const PRINT_CWD = nodeCmd('console.log(process.cwd())');
  const LONG_SESSION = nodeCmd('setInterval(function () {}, 1000)');

  function git(args, cwd) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr || res.stdout}`);
    return res.stdout.trim();
  }

  function makeRepoRoot() {
    const root = makeTmpRoot();
    git(['init'], root);
    git(['config', 'user.email', 'test@briefboard.invalid'], root);
    git(['config', 'user.name', 'briefboard test'], root);
    git(['config', 'commit.gpgsign', 'false'], root);
    fs.writeFileSync(path.join(root, '.gitignore'), '.briefboard/\n');
    git(['add', '.'], root);
    git(['commit', '-m', 'init'], root);
    return root;
  }

  /** A task the lifecycle allows `start` to take: briefed, and in `ready`. */
  function readyTask(root, title = 'Ready task') {
    const id = add(root, ['--title', title]);
    addBrief(root, id, 'the-brief');
    assert.strictEqual(runCli(root, ['status', id, 'open']).status, 0);
    assert.strictEqual(runCli(root, ['status', id, 'ready']).status, 0);
    return id;
  }

  /** A task under work: briefed, taken, and its session gone (T-0333). */
  function inProgressTask(root, title = 'Taken, and the session died') {
    const id = readyTask(root, title);
    assert.strictEqual(runCli(root, ['status', id, 'in_progress']).status, 0);
    return id;
  }

  /** A task in `review`: briefed, taken, and handed back by its worker. */
  function reviewTask(root, title = 'Submitted for review') {
    const id = readyTask(root, title);
    assert.strictEqual(runCli(root, ['status', id, 'in_progress']).status, 0);
    assert.strictEqual(runCli(root, ['status', id, 'review']).status, 0);
    return id;
  }

  /** A process that is alive and is not a board, so a trace naming it counts. */
  function liveStranger() {
    const child = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], {
      stdio: 'ignore',
    });
    strays.push(child);
    return child.pid;
  }

  // A trace file exactly as server/trace.js writes one. Written by hand rather
  // than by a board, because the cases below are the ones a real board cannot be
  // asked for: two of them at once, one with no address, one answering what a
  // board never answers.
  function writeTrace(root, pid, over = {}) {
    const dir = path.join(root, '.briefboard', 'boards');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${pid}.json`),
      JSON.stringify({
        trace: TRACE_VERSION,
        pid,
        port: 4571,
        host: '127.0.0.1',
        project: root,
        version: '0.0.0-test',
        startedAt: '2026-01-01T00:00:00.000Z',
        ...over,
      })
    );
  }

  /** An HTTP server that is not a board, for the answers a board never gives. */
  function fakeBoard(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        closers.push(() => new Promise((done) => server.close(done)));
        resolve(server.address().port);
      });
    });
  }

  async function startBoardFor(root, env) {
    const board = await startBoard(root, env);
    boards.push(board);
    return board;
  }

  const bytes = (root) => fs.readFileSync(backlogPath(root), 'utf8');

  /** The one document --json promises, and the proof that stdout carries only it. */
  function onlyDocument(res) {
    try {
      return JSON.parse(res.stdout);
    } catch (e) {
      assert.fail(`--json did not print one parseable document: ${e.message}\nstdout: ${res.stdout}`);
    }
  }

  // Every refusal made without the board being asked anything, and the one
  // assertion they all owe: the backlog is byte-identical afterwards.
  describe('refusals the CLI makes on its own', () => {
    it('with no board running it refuses, names the requirement and writes nothing', () => {
      const root = makeTmpRoot();
      const id = readyTask(root);
      const before = bytes(root);

      const res = runStart(root, ['start', id]);

      assert.strictEqual(res.status, 2, `expected the no-board code: ${res.stderr}`);
      assert.match(res.stderr, /no board is running/);
      assert.match(res.stderr, /briefboard serve/, 'the message says what has to be running');
      assert.strictEqual(bytes(root), before, 'nothing was written');
      assert.strictEqual(readTasks(root)[0].status, 'ready');
    });

    it('--json says the same thing in the same run, and prints only the document', () => {
      const root = makeTmpRoot();
      const id = readyTask(root);

      const res = runStart(root, ['start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(doc.reason, 'no-board');
      assert.strictEqual(doc.exit, res.status, 'the exit code and the document must agree');
      assert.strictEqual(doc.ok, false);
      assert.strictEqual(doc.id, id);
    });

    it('two boards are named and neither is chosen', () => {
      const root = makeTmpRoot();
      const id = readyTask(root);
      const before = bytes(root);
      const first = liveStranger();
      const second = liveStranger();
      writeTrace(root, first, { port: 4571 });
      writeTrace(root, second, { port: 4572 });

      const res = runStart(root, ['start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 4, res.stdout);
      assert.strictEqual(doc.reason, 'ambiguous-board');
      assert.deepStrictEqual(
        doc.boards.map((b) => b.pid).sort(),
        [first, second].sort(),
        'a refusal that will not choose has to say what it found'
      );
      assert.strictEqual(bytes(root), before, 'nothing was written');
    });

    it('a board whose trace records no address is refused as unreachable', () => {
      const root = makeTmpRoot();
      const id = readyTask(root);
      const before = bytes(root);
      writeTrace(root, liveStranger(), { port: null });

      const res = runStart(root, ['start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 3, res.stdout);
      assert.strictEqual(doc.reason, 'board-unreachable');
      assert.strictEqual(bytes(root), before, 'nothing was written');
    });

    it('a board that answers something else is a class of its own, not a silent success', async () => {
      const root = makeTmpRoot();
      const id = readyTask(root);
      const before = bytes(root);
      const port = await fakeBoard((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"broken"}');
      });
      writeTrace(root, process.pid, { port });

      const res = await runStartAsync(root, ['start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 11, res.stdout);
      assert.strictEqual(doc.reason, 'board-error');
      assert.strictEqual(bytes(root), before, 'nothing was written');
    });

    // The ordering proof, and why it is worth a test of its own: the board's own
    // drag DOES move the card with no worker command configured, so an unmoved
    // card is the only thing that can show the CLI declined before posting rather
    // than after.
    it('with no worker command it declines before posting, and the card stays ready', async () => {
      const root = makeTmpRoot();
      const id = readyTask(root);
      const before = bytes(root);
      await startBoardFor(root, {});

      const res = runStart(root, ['start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 5, res.stdout);
      assert.strictEqual(doc.reason, 'not-configured');
      assert.match(doc.hint, /BRIEFBOARD_WORKER_CMD/, 'the refusal names the variable to set');
      assert.strictEqual(bytes(root), before, 'the drag would have moved it; the CLI did not post');
      assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'ready');
    });
  });

  // The board refuses; the CLI's job is to say which refusal it was, in a code
  // and in a `reason` that cannot disagree. One board for the three of them: each
  // gets its own task, and none of them writes anything.
  describe('refusals the board makes, translated', () => {
    let root;
    let board;

    before(async () => {
      root = makeTmpRoot();
      // The backlog file has to exist before the first `bytes()` reads it: the
      // CLI creates it on the first `add`, and one test here never adds at all.
      add(root, ['--title', 'So the backlog file exists']);
      board = await startBoard(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
    });

    after(async () => {
      if (board) await board.stop();
    });

    it('a task the board has never heard of exits 6 with reason no-task', () => {
      const before = bytes(root);
      const res = runStart(root, ['start', 'T-9999', '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 6, res.stdout);
      assert.strictEqual(doc.reason, 'no-task');
      assert.strictEqual(doc.exit, res.status);
      assert.ok(doc.error, 'the board says why in its own words, and the CLI passes them on');
      assert.strictEqual(bytes(root), before, 'a refused start writes nothing');
    });

    it('a task that is not ready exits 7 with reason bad-status', () => {
      const id = add(root, ['--title', 'Still in backlog']);
      const before = bytes(root);

      const res = runStart(root, ['start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 7, res.stdout);
      assert.strictEqual(doc.reason, 'bad-status');
      assert.strictEqual(doc.exit, res.status);
      assert.strictEqual(bytes(root), before, 'a refused start writes nothing');
    });

    // Its neighbour above is the same 409 from the same endpoint, and only the
    // message separates the two (T-0323) — so this asserts the class AND that the
    // blocker is named, which is the half a rewording would take away.
    it('a task whose prerequisite is unfinished exits 8 with reason blocked', () => {
      const blocker = add(root, ['--title', 'Not finished yet']);
      const id = readyTask(root, 'Waiting on it');
      assert.strictEqual(runCli(root, ['depends', id, blocker]).status, 0);
      const before = bytes(root);

      const res = runStart(root, ['start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 8, res.stdout);
      assert.strictEqual(doc.reason, 'blocked');
      assert.strictEqual(doc.exit, res.status);
      assert.match(doc.error, new RegExp(blocker), 'a blocked start names what is holding it');
      assert.strictEqual(bytes(root), before, 'a refused start writes nothing');
    });
  });

  // The two outcomes where the transition was written and the agent is still
  // missing. They are not refusals, and the command must not let them read as
  // ones — but they end in different places, and that difference is the point of
  // both tests.
  describe('the transition happened and the session did not', () => {
    // The CLI is a client of POST /api/task/:id/start and inherits whatever that
    // endpoint does (requirement 8 of T-0325): the rollback lives on the server,
    // so this asserts that the same dispatch through the command ends the same
    // way as through the board — and that the line the CLI prints says `ready`
    // rather than sending its reader after a card that has already moved back.
    it('a project that is not a git repository: no session, and the card is put back to ready', async () => {
      const root = makeTmpRoot();
      const id = readyTask(root);
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

      const res = runStart(root, ['start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 10, res.stdout);
      assert.strictEqual(doc.reason, 'session-failed');
      assert.notStrictEqual(doc.session, 'started');
      assert.strictEqual(doc.status, 'ready', 'the board put the transition back');
      assert.strictEqual(
        readTasks(root).find((t) => t.id === id).status,
        'ready',
        'and the document is not describing a file that says something else'
      );
    });

    it('a session already running for that task is its own code', async () => {
      const root = makeTmpRoot();
      // Both commands: without the worker one the CLI would decline before
      // posting and this test would pass for the wrong reason.
      const board = await startBoardFor(root, {
        BRIEFBOARD_SESSION_CMD: LONG_SESSION,
        BRIEFBOARD_WORKER_CMD: PRINT_CWD,
      });
      // The briefing session is the one that can already be running under a
      // `ready` task: it starts in `open` and outlives the refinement that
      // followed it. Started through the board's own endpoint, so it is the
      // board's child — which is what `start` then collides with.
      const id = add(root, ['--title', 'Being briefed']);
      const opened = await readJson(
        await fetch(`${board.baseUrl}/api/task/${id}/open`, { method: 'POST' })
      );
      assert.strictEqual(opened.session, 'started', answerOf(opened));
      addBrief(root, id, 'written-later');
      assert.strictEqual(runCli(root, ['status', id, 'ready']).status, 0);

      const res = runStart(root, ['start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 9, res.stdout);
      assert.strictEqual(doc.reason, 'already-running');
      assert.strictEqual(doc.session, 'already-running');
      // The one non-`started` answer that keeps the card: a session for this task
      // IS registered, and putting a task back to `ready` under a live agent is
      // the state T-0325's rollback exists to prevent, not one to create.
      assert.strictEqual(doc.status, 'in_progress');
      assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'in_progress');
    });
  });

  // The acceptance criterion the command exists for, asserted against the session
  // REGISTRY — what the board itself records — and not against the sentence the
  // command prints about its own work.
  it('starts the worker session the board would, and registers it as the drag does', async () => {
    const root = makeRepoRoot();
    const id = readyTask(root);
    const before = bytes(root);
    await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

    const res = runStart(root, ['start', id, '--json']);
    const doc = onlyDocument(res);

    assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.strictEqual(doc.ok, true);
    assert.strictEqual(doc.session, 'started');
    assert.strictEqual(doc.status, 'in_progress');
    assert.strictEqual(doc.exit, 0);
    assert.ok(doc.board && doc.board.pid, 'the document says which board did it');
    assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'in_progress');
    // The other side of every `bytes(root) === before` in this suite, asserted
    // once where the file genuinely DOES change: a comparison that could not fail
    // would be confirming the fixture and saying nothing about the code (T-0182).
    // It is what makes review-start's "byte-identical" mean something. It lives on
    // the successful start since T-0325: a failed dispatch now ends where it
    // began, and its file is byte-identical again — as this assertion's neighbour
    // one screen up would have proved by failing.
    assert.notStrictEqual(bytes(root), before, 'the byte comparison can tell a write apart');

    // The state is not pinned: PRINT_CWD is over in milliseconds, so `running`
    // and `finished` are both honest answers by the time this reads the file.
    // What the criterion is about is that the board RECORDED a worker session for
    // this task, exactly as it does for the drag.
    await waitFor(
      () => new RegExp(`^${id}\\s+\\S+\\s+worker\\s`, 'm').test(runCli(root, ['sessions']).stdout),
      SPAWN_WAIT_BUDGET_MS,
      `${id} in the session registry`
    );

    // And it really was the isolated session, not merely a record of one: the
    // branch is the product's own proof that `git worktree add` ran (T-0091).
    assert.strictEqual(
      git(['branch', '--show-current'], path.join(root, '.briefboard', 'worktrees', id)),
      `task/${id}`
    );
  });

  // ---------- review-start (T-0320) ----------
  //
  // The same client, a different action. What is worth testing here is therefore
  // NOT the exit table again — it is the same one, and the tests above hold it —
  // but the two things that are this command's own: that a successful call leaves
  // the task exactly where it was, and that the refusal for an unconfigured
  // review command still comes before anything is posted.
  describe('review-start', () => {
    describe('against a board that has a review command', () => {
      let root;
      let board;

      before(async () => {
        root = makeTmpRoot();
        add(root, ['--title', 'So the backlog file exists']);
        // The review session is NOT isolated — it runs in the project directory,
        // because the diff it reads belongs to the worker's branch — so this
        // needs no git repository, unlike `start`'s own success test.
        board = await startBoard(root, { BRIEFBOARD_REVIEW_CMD: LONG_SESSION });
      });

      after(async () => {
        if (board) await board.stop();
      });

      // The central promise of the whole request, and the one a reader will look
      // for: asserted on the FILE, byte for byte, not on what the command says
      // about itself. A status comparison alone would miss a write anywhere else
      // in the task.
      it('starts the session and leaves doc/backlog.md byte-identical', async () => {
        const id = reviewTask(root);
        const before = bytes(root);

        const res = runStart(root, ['review-start', id, '--json']);
        const doc = onlyDocument(res);

        assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
        assert.strictEqual(doc.ok, true);
        assert.strictEqual(doc.session, 'started');
        assert.strictEqual(doc.command, 'review-start');
        assert.strictEqual(
          bytes(root),
          before,
          'a successful review-start must write nothing at all: no status, no field, no section'
        );
        assert.strictEqual(
          readTasks(root).find((t) => t.id === id).status,
          'review',
          'and the task is exactly where the worker left it'
        );
        assert.strictEqual(doc.status, 'review', 'the document says the same as the file');

        // The registry, as with `start`: the board's own record, and the KIND is
        // `orchestrator` — T-0305 renamed the variable and left the kind alone,
        // and this is where that decision is visible to a user.
        await waitFor(
          () =>
            new RegExp(`^${id}\\s+running\\s+orchestrator\\s`, 'm').test(
              runCli(root, ['sessions']).stdout
            ),
          SPAWN_WAIT_BUDGET_MS,
          `${id} in the session registry as an orchestrator session`
        );
      });

      it('a task in any other status is refused with the wrong-status code', () => {
        const id = readyTask(root, 'Not submitted yet');
        const before = bytes(root);

        const res = runStart(root, ['review-start', id, '--json']);
        const doc = onlyDocument(res);

        assert.strictEqual(res.status, 7, res.stdout);
        assert.strictEqual(doc.reason, 'bad-status', 'the same class `start` uses, not a new one');
        assert.strictEqual(doc.exit, res.status);
        assert.strictEqual(bytes(root), before, 'nothing was written');
        assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'ready');
      });

      it('a task the board has never heard of is the same no-task code', () => {
        const res = runStart(root, ['review-start', 'T-9999', '--json']);
        const doc = onlyDocument(res);

        assert.strictEqual(res.status, 6, res.stdout);
        assert.strictEqual(doc.reason, 'no-task');
      });

      it('a session already running for that task does not start a second one', async () => {
        const id = reviewTask(root, 'Already under review');
        // Through the board's own endpoint, so the running session is the board's
        // child — which is what review-start then collides with.
        const started = await readJson(
          await fetch(`${board.baseUrl}/api/task/${id}/review`, { method: 'POST' })
        );
        assert.strictEqual(started.session, 'started', answerOf(started));
        const before = bytes(root);

        const res = runStart(root, ['review-start', id, '--json']);
        const doc = onlyDocument(res);

        assert.strictEqual(res.status, 9, res.stdout);
        assert.strictEqual(doc.reason, 'already-running');
        assert.strictEqual(bytes(root), before, 'and still nothing is written');

        // The same outcome as a human reads it. An arrow is the shape `start`
        // uses for a card that MOVED, and review-start must never draw one — this
        // is the sentence a reader takes the promise from, so it is asserted and
        // not left to the document alone.
        const plain = runStart(root, ['review-start', id]);
        assert.strictEqual(plain.status, 9);
        assert.match(plain.stderr, new RegExp(`${id} still review`));
        assert.doesNotMatch(plain.stderr, /->/, 'nothing moved, so nothing may read as having moved');
      });
    });

    // The ordering proof, and it is made the way it has to be made: the task is
    // deliberately NOT in `review`, so a command that posted would come back with
    // the wrong-status code. Getting the not-configured one instead is the only
    // evidence that the meta was read first.
    it('with no review command it declines before posting, and says which variable', async () => {
      const root = makeTmpRoot();
      const id = readyTask(root, 'Not in review, and no review command either');
      const before = bytes(root);
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

      const res = runStart(root, ['review-start', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(
        res.status,
        5,
        `a posted request would have answered bad-status (7): ${res.stdout}`
      );
      assert.strictEqual(doc.reason, 'not-configured');
      assert.match(doc.hint, /BRIEFBOARD_REVIEW_CMD/, 'the documented name (T-0305)');
      assert.match(doc.hint, /BRIEFBOARD_ORCHESTRATOR_CMD/, 'and the one that also configures it');
      assert.strictEqual(bytes(root), before, 'nothing was written');
    });

    // A worker command is configured and a review one is not, on the same board:
    // without the per-kind check, `sessions.enabled` or the worker's flag would
    // have let this through (T-0182 — the fixture must be able to fail).
    it('reads the review kind and not merely whether the board runs sessions at all', async () => {
      const root = makeTmpRoot();
      const id = readyTask(root, 'A card with a worker command available');
      const board = await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
      const meta = await readJson(await fetch(`${board.baseUrl}/api/board`));
      assert.strictEqual(meta.sessions.worker, true, answerOf(meta));
      assert.strictEqual(meta.sessions.orchestrator, false, answerOf(meta));

      assert.strictEqual(runStart(root, ['review-start', id]).status, 5);
      // The same board, the same task: `start` gets past the check that stopped
      // review-start, which is what makes the check per-kind rather than global.
      assert.notStrictEqual(runStart(root, ['start', id]).status, 5);
    });
  });

  // ---------- rework (T-0329) ----------
  //
  // The third command through the same client, and the exit table above is the
  // same one — what is this command's own is the round its document carries and
  // the refusal for a branch that is gone, which no other dispatch can make.
  // Everything the endpoint decides is covered in tests/worker-session-api.
  describe('rework', () => {
    /** The branch a rework needs: the one the previous round is on. */
    function branchFor(root, id) {
      git(['branch', `task/${id}`], root);
    }

    it('takes a card in review back into work, on the branch it already has', async () => {
      const root = makeRepoRoot();
      const id = reviewTask(root);
      branchFor(root, id);
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

      const res = runStart(root, ['rework', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
      assert.strictEqual(doc.exit, 0, 'the exit code and the document must agree');
      assert.strictEqual(doc.ok, true);
      assert.strictEqual(doc.session, 'started');
      assert.strictEqual(doc.status, 'in_progress');
      assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'in_progress');
      // The proof that it is a rework and not a start: the worktree is on the
      // branch that already existed, which `git worktree add -b` could not have
      // created a second time.
      assert.strictEqual(
        git(['branch', '--show-current'], path.join(root, '.briefboard', 'worktrees', id)),
        `task/${id}`
      );
    });

    it('the round in the document is the one the board derived, not a number this side counted', async () => {
      const root = makeRepoRoot();
      const id = reviewTask(root);
      branchFor(root, id);
      assert.strictEqual(
        runCli(root, ['note', id, '--section', 'Review verdict', '--text', 'REWORK: not yet.']).status,
        0
      );
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

      const doc = onlyDocument(runStart(root, ['rework', id, '--json']));

      assert.strictEqual(doc.round, 2, 'one verdict is written, so this is the second round');
    });

    // Its own code because it is fixed by finding the branch, not by retrying:
    // read as the generic `bad-status` a dispatcher would send the card back
    // round the same loop.
    it('a branch that is gone is exit 12 with reason no-branch, and nothing is written', async () => {
      const root = makeRepoRoot();
      const id = reviewTask(root); // no branch was ever made for it
      const before = bytes(root);
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

      const res = runStart(root, ['rework', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 12, res.stdout);
      assert.strictEqual(doc.reason, 'no-branch');
      assert.strictEqual(doc.exit, res.status);
      assert.match(doc.error, new RegExp(`task/${id}`), 'the refusal names the branch it looked for');
      assert.strictEqual(bytes(root), before, 'a refused rework writes nothing');
      assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'review');
    });

    it('a task that is not in review is the same bad-status the other commands give', async () => {
      const root = makeRepoRoot();
      const id = readyTask(root);
      branchFor(root, id);
      const before = bytes(root);
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

      const res = runStart(root, ['rework', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 7, res.stdout);
      assert.strictEqual(doc.reason, 'bad-status');
      assert.strictEqual(bytes(root), before);
    });

    it('with no worker command it declines before posting, and the card stays in review', async () => {
      const root = makeRepoRoot();
      const id = reviewTask(root);
      branchFor(root, id);
      const before = bytes(root);
      await startBoardFor(root, {});

      const res = runStart(root, ['rework', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 5, res.stdout);
      assert.strictEqual(doc.reason, 'not-configured');
      assert.match(doc.hint, /BRIEFBOARD_WORKER_CMD/, 'the refusal names the variable to set');
      assert.strictEqual(bytes(root), before, 'the board would have moved it; the CLI did not post');
      assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'review');
    });
  });

  // ---------- resume (T-0333) ----------
  //
  // The fourth command through the same client and the same exit table. What is
  // its own is that it moves NOTHING: the card is `in_progress` before and after,
  // so the line a human reads must not draw an arrow, and the file must come back
  // byte-identical from a success as well as from a refusal. Everything the
  // endpoint decides is covered in tests/worker-session-api.
  describe('resume', () => {
    /** The branch a resume needs: the one the dead session left its work on. */
    function branchFor(root, id) {
      git(['branch', `task/${id}`], root);
    }

    it('puts a worker back on a card under work, and writes nothing at all', async () => {
      const root = makeRepoRoot();
      const id = inProgressTask(root);
      branchFor(root, id);
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });
      const before = bytes(root);

      const res = runStart(root, ['resume', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
      assert.strictEqual(doc.exit, 0, 'the exit code and the document must agree');
      assert.strictEqual(doc.ok, true);
      assert.strictEqual(doc.session, 'started');
      assert.strictEqual(doc.status, 'in_progress');
      assert.strictEqual(bytes(root), before, 'a resume moves nothing, so it writes nothing');
      // On the branch that already existed, which `git worktree add -b` could not
      // have created a second time: the work is what is being resumed.
      assert.strictEqual(
        git(['branch', '--show-current'], path.join(root, '.briefboard', 'worktrees', id)),
        `task/${id}`
      );
    });

    // The same promise as `review-start`'s, for the same reason: an arrow is the
    // shape `start` and `rework` use for a card that MOVED, and this is the
    // sentence a reader takes the promise from.
    it('the line it prints says the card stayed where it was, with no arrow', async () => {
      const root = makeRepoRoot();
      const id = inProgressTask(root);
      branchFor(root, id);
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

      const res = runStart(root, ['resume', id]);

      assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
      assert.match(res.stdout, new RegExp(`${id} still in_progress`));
      assert.match(res.stdout, /worker session started/);
      assert.doesNotMatch(res.stdout, /->/, 'nothing moved, so nothing may read as having moved');
    });

    it('a card that is not under work is the same bad-status the other commands give', async () => {
      const root = makeRepoRoot();
      const id = readyTask(root);
      branchFor(root, id);
      const before = bytes(root);
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

      const res = runStart(root, ['resume', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 7, res.stdout);
      assert.strictEqual(doc.reason, 'bad-status');
      assert.strictEqual(doc.exit, res.status);
      assert.strictEqual(bytes(root), before);
      assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'ready');
    });

    it('a branch that is gone is the same exit 12 a rework gets, and nothing is written', async () => {
      const root = makeRepoRoot();
      const id = inProgressTask(root); // no branch was ever made for it
      const before = bytes(root);
      await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: PRINT_CWD });

      const res = runStart(root, ['resume', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 12, res.stdout);
      assert.strictEqual(doc.reason, 'no-branch');
      assert.strictEqual(doc.exit, res.status);
      assert.match(doc.error, new RegExp(`task/${id}`), 'the refusal names the branch it looked for');
      assert.strictEqual(bytes(root), before);
      assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'in_progress');
    });

    // The refusal this command exists to make: the card's status says an agent is
    // on it either way, and only the registry can say whether one really is.
    it('a session that is still running is exit 9, not a second worker on the branch', async () => {
      const root = makeRepoRoot();
      const id = readyTask(root);
      const board = await startBoardFor(root, { BRIEFBOARD_WORKER_CMD: LONG_SESSION });
      // Through the board's own drop, so the running session is its child.
      const started = await readJson(
        await fetch(`${board.baseUrl}/api/task/${id}/start`, {
          method: 'POST',
          timeoutMs: SESSION_START_TIMEOUT_MS,
        })
      );
      assert.strictEqual(started.session, 'started', answerOf(started));
      const before = bytes(root);

      const res = runStart(root, ['resume', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 9, res.stdout);
      assert.strictEqual(doc.reason, 'already-running');
      assert.strictEqual(doc.exit, res.status);
      assert.strictEqual(bytes(root), before);
    });

    it('with no worker command it declines before posting, and the card is untouched', async () => {
      const root = makeRepoRoot();
      const id = inProgressTask(root);
      branchFor(root, id);
      const before = bytes(root);
      await startBoardFor(root, {});

      const res = runStart(root, ['resume', id, '--json']);
      const doc = onlyDocument(res);

      assert.strictEqual(res.status, 5, res.stdout);
      assert.strictEqual(doc.reason, 'not-configured');
      assert.match(doc.hint, /BRIEFBOARD_WORKER_CMD/, 'the refusal names the variable to set');
      assert.strictEqual(bytes(root), before);
      assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'in_progress');
    });
  });
});
