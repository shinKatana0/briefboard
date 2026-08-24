'use strict';

// Tests for tools/task.mjs -- the CLI agents use to edit doc/backlog.md / doc/brief/.
// The commands that only read: show, list, validate, sessions, and what summary counts once an archive exists.
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
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseBacklog, STATUSES } = require('../server/parser.js');
const { REGISTRY_FILE, REGISTRY_VERSION } = require('../server/sessions.js');
const { fetch } = require('./helpers/bounded.js');
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');
const {
  runCli,
  makeTmpRoot,
  backlogPath,
  archivePath,
  readTasks,
  add,
  addBrief,
  scopedBacklog,
} = require('./helpers/task-cli.js');

describe('task.mjs show', () => {
  it('prints the task as JSON for an existing id', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--type', 'bug', '--priority', 'Minor', '--title', 'Show me', '--desc', 'Detail text.']);
    const res = runCli(root, ['show', id]);
    assert.strictEqual(res.status, 0);

    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.id, id);
    assert.strictEqual(parsed.title, 'Show me');
    assert.strictEqual(parsed.type, 'bug');
    assert.strictEqual(parsed.priority, 'Minor');
    assert.strictEqual(parsed.description, 'Detail text.');
    assert.deepStrictEqual(parsed, readTasks(root)[0]);
  });

  it('fails with a non-zero exit code for a non-existent id', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Only task']);
    const res = runCli(root, ['show', 'T-0099']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR/);
  });
});

// T-0161: worker reports are 63% of this backlog and are read by nobody who
// opened the task for its statement of work. `show` leaves them out - and says
// that it did, because a read that silently returns less is indistinguishable
// from one that returned everything.
describe('task.mjs show leaves worker reports out (T-0161)', () => {
  /** A task carrying a statement of work, a verdict, and reports in both spellings. */
  function taskWithReports(root) {
    const id = add(root, ['--title', 'Reported', '--desc', 'The statement of work.']);
    const note = (section, text) =>
      assert.strictEqual(runCli(root, ['note', id, '--section', section, '--text', '-'], text).status, 0);
    note('Worker report', 'Branch: task/T-0001-x\nWhat: the English report body.');
    note('Review verdict', 'Would merge.');
    note('Отчёт воркера', 'Тело устаревшего отчёта.');
    return id;
  }

  function shown(root, args) {
    const res = runCli(root, ['show', ...args]);
    assert.strictEqual(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  }

  it('omits both spellings of the report and keeps everything else', () => {
    const root = makeTmpRoot();
    const id = taskWithReports(root);
    const lean = shown(root, [id]);

    assert.match(lean.description, /The statement of work\./);
    assert.match(lean.description, /### Review verdict\nWould merge\./);
    assert.doesNotMatch(lean.description, /Worker report|the English report body/);
    assert.doesNotMatch(lean.description, /Отчёт воркера|Тело устаревшего отчёта/);
    // Fields other than the description are untouched by the omission.
    const rest = { ...lean };
    delete rest.description;
    delete rest.omitted;
    const storedRest = { ...readTasks(root)[0] };
    delete storedRest.description;
    assert.deepStrictEqual(rest, storedRest);
  });

  it('names the omission in the JSON: how many sections, which headings, and the flag', () => {
    const root = makeTmpRoot();
    const id = taskWithReports(root);
    const { omitted } = shown(root, [id]);

    assert.strictEqual(omitted.sections, 2);
    assert.deepStrictEqual(omitted.headings, ['Worker report', 'Отчёт воркера']);
    assert.ok(omitted.bytes > 0, 'the size of what was left out');
    assert.match(omitted.note, /INCOMPLETE/);
    assert.match(omitted.note, new RegExp(`task\\.mjs show ${id} --full`));
  });

  it('--full prints the description exactly as stored, and claims no omission', () => {
    const root = makeTmpRoot();
    const id = taskWithReports(root);
    const full = shown(root, [id, '--full']);

    assert.deepStrictEqual(full, readTasks(root)[0]);
    assert.ok(!('omitted' in full), '--full omits nothing, so it announces nothing');
  });

  it('reads the flag before the id as well', () => {
    const root = makeTmpRoot();
    const id = taskWithReports(root);
    assert.deepStrictEqual(shown(root, ['--full', id]), readTasks(root)[0]);
  });

  it('a task without reports is printed whole, with no omission field', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Nothing to hide', '--desc', 'Just a statement of work.']);
    const lean = shown(root, [id]);

    assert.deepStrictEqual(lean, readTasks(root)[0]);
    assert.ok(!('omitted' in lean));
  });

  it('a second report merged into the same section leaves one omitted section', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Reworked', '--desc', 'Statement.']);
    runCli(root, ['note', id, '--section', 'Worker report', '--text', '-'], 'First round.');
    runCli(root, ['note', id, '--section', 'Worker report', '--text', '-'], 'Rework round.');
    const lean = shown(root, [id]);

    assert.strictEqual(lean.description, 'Statement.');
    assert.strictEqual(lean.omitted.sections, 1);
  });
});

describe('task.mjs list', () => {
  it('lists every task when no --status filter is given', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Task one']);
    add(root, ['--title', 'Task two']);
    const res = runCli(root, ['list']);
    assert.strictEqual(res.status, 0);
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /^T-0001\s+Medium\s+backlog\s+Task one$/);
    assert.match(lines[1], /^T-0002\s+Medium\s+backlog\s+Task two$/);
  });

  it('filters by --status, excluding tasks in other statuses', () => {
    const root = makeTmpRoot();
    const idOpen = add(root, ['--title', 'Stays open']);
    const idOther = add(root, ['--title', 'Goes cancelled']);
    runCli(root, ['status', idOpen, 'open']);
    runCli(root, ['status', idOther, 'cancelled']); // backlog -> cancelled is a legal transition

    const res = runCli(root, ['list', '--status', 'open']);
    assert.strictEqual(res.status, 0);
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^T-0001\s+Medium\s+open\s+Stays open$/);
  });

  it('prints nothing (empty stdout) when the --status filter matches no task', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Only backlog task']);
    const res = runCli(root, ['list', '--status', 'cancelled']);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout.trim(), '');
  });
});

describe('task.mjs list --json (T-0303)', () => {
  function twoWithADependency() {
    const root = makeTmpRoot();
    add(root, ['--title', 'The prerequisite', '--labels', 'a']);
    add(root, ['--title', 'Waits for it', '--labels', 'a,b']);
    assert.strictEqual(runCli(root, ['depends', 'T-0002', 'T-0001']).status, 0);
    return root;
  }

  function parsed(res) {
    assert.strictEqual(res.status, 0, `list --json failed: ${res.stderr}`);
    // The whole of stdout, not a line of it: the point of the flag is that a
    // consumer may pipe stdout into a parser without filtering anything out.
    return JSON.parse(res.stdout);
  }

  it('prints one document with tasks and count, and nothing else on stdout', () => {
    const root = twoWithADependency();
    const doc = parsed(runCli(root, ['list', '--json']));
    assert.deepStrictEqual(Object.keys(doc).sort(), ['count', 'tasks']);
    assert.strictEqual(doc.count, 2);
    assert.strictEqual(doc.tasks.length, doc.count);
    assert.deepStrictEqual(doc.tasks.map((t) => t.id), ['T-0001', 'T-0002']);
  });

  it('composes with --label and --status', () => {
    const root = twoWithADependency();
    const byLabel = parsed(runCli(root, ['list', '--json', '--label', 'b']));
    assert.deepStrictEqual(byLabel.tasks.map((t) => t.id), ['T-0002']);
    assert.strictEqual(byLabel.count, 1);
    assert.strictEqual(runCli(root, ['status', 'T-0001', 'open']).status, 0);
    const both = parsed(runCli(root, ['list', '--json', '--label', 'a', '--status', 'open']));
    assert.deepStrictEqual(both.tasks.map((t) => t.id), ['T-0001']);
  });

  it('composes with --all, and an empty result is a document too', () => {
    const root = twoWithADependency();
    assert.strictEqual(runCli(root, ['status', 'T-0001', 'cancelled']).status, 0);
    assert.strictEqual(runCli(root, ['archive']).status, 0);
    const live = parsed(runCli(root, ['list', '--json']));
    assert.deepStrictEqual(live.tasks.map((t) => t.id), ['T-0002']);
    const all = parsed(runCli(root, ['list', '--json', '--all']));
    assert.deepStrictEqual(all.tasks.map((t) => t.id), ['T-0001', 'T-0002']);
    const none = parsed(runCli(root, ['list', '--json', '--label', 'nobody-carries-this']));
    assert.deepStrictEqual(none, { tasks: [], count: 0 });
  });

  // The archived-tasks note is the one thing `list` writes besides its rows, and
  // it has always gone to stderr. Under --json that stops being a nicety: a note
  // on stdout would make the document unparseable.
  it('the note about archived tasks stays on stderr, so stdout parses whole', () => {
    const root = twoWithADependency();
    assert.strictEqual(runCli(root, ['status', 'T-0001', 'cancelled']).status, 0);
    assert.strictEqual(runCli(root, ['archive']).status, 0);
    const res = runCli(root, ['list', '--json']);
    assert.match(res.stderr, /closed task .*--all includes them/);
    assert.deepStrictEqual(JSON.parse(res.stdout).count, 1);
  });

  // blockedBy is resolved against BOTH files, --all or not: a prerequisite that
  // was closed and then archived is satisfied, and reading the live backlog
  // alone would report it as blocking forever - the accident withArchived()
  // exists to prevent, here in a field a consumer acts on.
  it('an archived prerequisite is satisfied, not a dangling blocker', () => {
    const root = twoWithADependency();
    const stillBlocked = parsed(runCli(root, ['list', '--json'])).tasks.find((t) => t.id === 'T-0002');
    assert.deepStrictEqual(stillBlocked.blockedBy, ['T-0001'], 'the fixture must start out blocked');
    assert.strictEqual(runCli(root, ['status', 'T-0001', 'cancelled']).status, 0);
    assert.strictEqual(runCli(root, ['archive']).status, 0);
    const freed = parsed(runCli(root, ['list', '--json'])).tasks.find((t) => t.id === 'T-0002');
    assert.deepStrictEqual(freed.blockedBy, [], 'T-0001 is closed and archived, so it blocks nothing');
    assert.deepStrictEqual(freed.depends, ['T-0001'], 'and it is still the prerequisite it always was');
  });

  it('leaves the description out: this is a listing, not a read', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Has a description', '--desc', 'A long body nobody listing tasks asked for.']);
    const doc = parsed(runCli(root, ['list', '--json']));
    assert.ok(!('description' in doc.tasks[0]), 'the description is in the listing');
  });

  // Decision 3 of the card: one task shape, not a third one. Compared field by
  // field against `show`, which is the other JSON this CLI prints.
  it('every field of an entry is the field of the same name in `show`', () => {
    const root = twoWithADependency();
    const entry = parsed(runCli(root, ['list', '--json'])).tasks.find((t) => t.id === 'T-0002');
    const shown = JSON.parse(runCli(root, ['show', 'T-0002']).stdout);
    for (const [field, value] of Object.entries(entry)) {
      if (field === 'blockedBy') continue; // derived; the board API is what names it
      assert.ok(field in shown, `list --json invented the field "${field}": show has no such name`);
      assert.deepStrictEqual(value, shown[field], `list --json and show disagree about "${field}"`);
    }
    // The fixture is a task that actually carries each of them, so a shape that
    // dropped one would not pass by having nothing to compare.
    assert.deepStrictEqual(Object.keys(entry).sort(), [
      'blockedBy',
      'briefs',
      'closed',
      'created',
      'depends',
      'id',
      'labels',
      'priority',
      'status',
      'title',
      'type',
    ]);
    assert.deepStrictEqual(entry.labels, ['a', 'b']);
    assert.deepStrictEqual(entry.depends, ['T-0001']);
  });

  // The other half of the same decision, and the reason `blockedBy` is not
  // called something else: GET /api/board has been sending that name since
  // T-0087, and a second name for one notion is how the board and the CLI would
  // come to disagree about what "blocked" means.
  it('every field of an entry is the field of the same name in GET /api/board', async () => {
    const root = twoWithADependency();
    const entry = parsed(runCli(root, ['list', '--json'])).tasks.find((t) => t.id === 'T-0002');
    // Non-empty on purpose: two empty arrays would compare equal whatever the
    // server calls the field (T-0182).
    assert.deepStrictEqual(entry.blockedBy, ['T-0001'], 'the fixture must actually be blocked');
    const board = await startBoard(root);
    try {
      const res = await fetch(`${board.baseUrl}/api/board`);
      const body = await readJson(res);
      const fromBoard = body.tasks.find((t) => t.id === 'T-0002');
      assert.ok(fromBoard, answerOf(body));
      for (const [field, value] of Object.entries(entry)) {
        assert.ok(field in fromBoard, `list --json invented the field "${field}": /api/board has no such name`);
        assert.deepStrictEqual(value, fromBoard[field], `list --json and /api/board disagree about "${field}"`);
      }
    } finally {
      await board.stop();
    }
  });
});

describe('task.mjs validate', () => {
  it('exits 0 and prints OK for a project produced entirely via the CLI', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Valid task']);
    addBrief(root, id, 'valid-brief');
    runCli(root, ['status', id, 'open']);
    runCli(root, ['status', id, 'ready']);

    const res = runCli(root, ['validate']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /^OK\s*$/);
  });

  it('exits non-zero and prints error text for a corrupted doc/backlog.md', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Will be corrupted']);
    // Corrupt the raw field directly on disk - this is exactly the class of damage
    // validateBacklog() exists to catch (see tests/validate.test.js for the detailed
    // per-rule coverage; here we only check the CLI wiring/exit-code/output).
    const p = backlogPath(root);
    const corrupted = fs.readFileSync(p, 'utf8').replace('- status: backlog', '- status: not_a_real_status');
    fs.writeFileSync(p, corrupted);

    const res = runCli(root, ['validate']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, new RegExp(id));
  });
});

// `sessions` is read-only and answers about .briefboard/sessions/registry.json,
// not about doc/ — it is how an orchestrator running in its own terminal learns
// that the board already has an agent on a task (T-0103).
describe('task.mjs sessions', () => {
  const strays = [];

  function liveStranger() {
    const child = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], {
      stdio: 'ignore',
    });
    strays.push(child);
    return child.pid;
  }

  function writeRegistry(root, sessions) {
    const dir = path.join(root, '.briefboard', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, REGISTRY_FILE),
      typeof sessions === 'string'
        ? sessions
        : JSON.stringify({ version: REGISTRY_VERSION, sessions })
    );
  }

  function session(over) {
    return {
      id: 'T-0011',
      kind: 'worker',
      pid: 4242,
      startedAt: '2026-01-01T00:00:00.000Z',
      logPath: path.join('nowhere', 'T-0011.log'),
      status: 'running',
      exitCode: null,
      signal: null,
      endedAt: null,
      ...(over || {}),
    };
  }

  afterEach(() => {
    for (const child of strays.splice(0)) child.kill();
  });

  it('says there are no sessions, and exits 0, when the board never ran one here', () => {
    const res = runCli(makeTmpRoot(), ['sessions']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /no agent sessions/);
    assert.strictEqual(res.stderr, '');
  });

  it('prints the task, state, kind, local start time and log path of each session', () => {
    const root = makeTmpRoot();
    const logPath = path.join(root, '.briefboard', 'sessions', 'T-0011.log');
    writeRegistry(root, [session({ board: liveStranger(), logPath })]);

    const res = runCli(root, ['sessions']);
    assert.strictEqual(res.status, 0);
    const [line] = res.stdout.trim().split(/\r?\n/);
    assert.match(line, /^T-0011\s+running\s+worker\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s/);
    assert.ok(line.endsWith(logPath), `the log path is what a human is sent to: ${line}`);
  });

  it('shows a session whose board is gone as interrupted, not as running', () => {
    const root = makeTmpRoot();
    writeRegistry(root, [session()]);
    const res = runCli(root, ['sessions']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /^T-0011\s+interrupted\s/m);
  });

  it('reads the registry of AGENTBOARD_ROOT, not of the installation', () => {
    const shared = makeTmpRoot();
    writeRegistry(shared, [session({ id: 'T-0042', board: liveStranger() })]);

    assert.match(runCli(shared, ['sessions']).stdout, /^T-0042\s+running\s/m);
    assert.match(runCli(makeTmpRoot(), ['sessions']).stdout, /no agent sessions/);
  });

  it('warns about a registry it cannot read, and still exits 0', () => {
    const root = makeTmpRoot();
    writeRegistry(root, '{ not json');
    const res = runCli(root, ['sessions']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stderr, /WARNING: session registry: .*unreadable/);
    assert.match(res.stdout, /no agent sessions/);
  });

  it('is listed among the commands', () => {
    assert.match(runCli(makeTmpRoot(), ['help']).stdout, /\bsessions\b/);
  });
});

// T-0310. `summary` counted only doc/backlog.md, so a scope that was FINISHED —
// every task closed, and `archive` therefore having moved every one of them out —
// printed `total: 0, complete: false`: byte for byte the document a label nobody
// ever used prints. The rule that an empty scope is not complete exists to stop a
// mistyped label reading as a finished phase, and it had started failing safe in
// the other direction too, on the case that is the more common one wherever
// `archive` is used at all.
//
// Four decisions land together, all four changing the document's shape or meaning
// while it is still cheap: the archive is always counted, `--all` is refused on
// the two commands it can no longer move, `blocked` gains the lifecycle half, and
// `scope` grows enough structure to tell two queries apart.
describe('task.mjs summary counts the archive (T-0310)', () => {
  function doc(root, args = []) {
    const res = runCli(root, ['summary', '--json', ...args]);
    assert.strictEqual(res.status, 0, `summary failed: ${res.stderr}`);
    return JSON.parse(res.stdout);
  }

  function driveToDone(root, id) {
    assert.strictEqual(runCli(root, ['status', id, 'open']).status, 0);
    addBrief(root, id, 'slug');
    for (const to of ['ready', 'in_progress', 'review', 'done']) {
      assert.strictEqual(runCli(root, ['status', id, to]).status, 0, `${id} -> ${to} was refused`);
    }
  }

  // The card's own reproduction, built with the CLI so that the lifecycle and
  // `archive` are the things under test rather than a hand-written file.
  function finishedPhase() {
    const root = makeTmpRoot();
    const ids = ['First of phase 4', 'Second of phase 4'].map((title) =>
      add(root, ['--type', 'feature', '--priority', 'Major', '--title', title, '--labels', 'phase-4'])
    );
    for (const id of ids) driveToDone(root, id);
    assert.strictEqual(runCli(root, ['archive']).status, 0);
    // Without this the counts below could be coming from the live file, and the
    // test would say nothing at all about the archive.
    assert.deepStrictEqual(readTasks(root).map((t) => t.id), [], 'archive left the tasks in doc/backlog.md');
    return { root, ids };
  }

  it('a finished-and-archived scope is complete, and a mistyped label is still not', () => {
    const { root } = finishedPhase();
    const finished = doc(root, ['--label', 'phase-4']);
    assert.strictEqual(finished.total, 2, 'the archived tasks were not counted');
    assert.strictEqual(finished.done, 2);
    assert.strictEqual(finished.complete, true, 'a finished scope still reads as unfinished');

    const typo = doc(root, ['--label', 'phase4-typo']);
    assert.strictEqual(typo.total, 0);
    assert.strictEqual(typo.complete, false, 'a label nobody carries read as a finished phase');

    // The two must differ in more than the label they were asked about — that
    // identity is the bug, and comparing everything BUT the scope is what says so.
    const counts = (d) => {
      const c = { ...d };
      delete c.scope;
      return c;
    };
    assert.notDeepStrictEqual(
      counts(finished),
      counts(typo),
      'a finished scope and a typo still print the same document'
    );
  });

  it('the counts cover both files when a scope is split across them', () => {
    const root = makeTmpRoot();
    const closed = add(root, ['--title', 'Done half', '--labels', 'split']);
    const live = add(root, ['--title', 'Live half', '--labels', 'split']);
    driveToDone(root, closed);
    assert.strictEqual(runCli(root, ['status', live, 'open']).status, 0);
    assert.strictEqual(runCli(root, ['archive']).status, 0);
    // The split is real: one task on each side of the border.
    assert.deepStrictEqual(readTasks(root).map((t) => t.id), [live]);
    assert.deepStrictEqual(
      parseBacklog(fs.readFileSync(archivePath(root), 'utf8')).map((t) => t.id),
      [closed]
    );

    const d = doc(root, ['--label', 'split']);
    assert.strictEqual(d.total, 2, 'one side of the border was left out');
    assert.strictEqual(d.done, 1);
    assert.strictEqual(d.open, 1);
    assert.strictEqual(
      STATUSES.reduce((n, s) => n + d[s], 0),
      d.total,
      'the status counts stopped summing to total once the archive came into scope'
    );
    assert.strictEqual(d.complete, false, 'one unfinished task is enough to hold a scope open');
  });

  it('says nothing on stderr about an archive it has already counted', () => {
    const { root } = finishedPhase();
    const res = runCli(root, ['summary', '--json', '--label', 'phase-4']);
    assert.strictEqual(res.stderr, '', `summary still reports an omission it is not making: ${res.stderr}`);
    JSON.parse(res.stdout);
  });

  it('summary --all and runnable --all are refused with the usage line and a non-zero exit', () => {
    const { root } = finishedPhase();
    for (const cmd of ['summary', 'runnable']) {
      const res = runCli(root, [cmd, '--all']);
      assert.strictEqual(res.status, 1, `${cmd} accepted --all: ${res.stdout}`);
      assert.match(res.stderr, new RegExp(`ERROR: ${cmd} has no flag --all`));
      assert.match(res.stderr, new RegExp(`usage: node tools/task\\.mjs ${cmd}`));
      assert.strictEqual(res.stdout, '', 'a refused query printed an answer anyway');
      // The usage line must stop advertising the flag it refuses.
      assert.doesNotMatch(res.stderr, new RegExp(`usage:.*\\[--all\\]`));
    }
  });

  it('list --all is untouched: it still puts the archived tasks back in the listing', () => {
    const { root, ids } = finishedPhase();
    const all = runCli(root, ['list', '--all']);
    assert.strictEqual(all.status, 0, `list --all was refused: ${all.stderr}`);
    assert.deepStrictEqual(
      all.stdout.trim().split(/\r?\n/).map((line) => line.slice(0, 6)),
      ids
    );
    // And without it, the listing is empty and the note still names --all,
    // because there it is a flag that means something.
    const live = runCli(root, ['list']);
    assert.strictEqual(live.stdout, '');
    assert.match(live.stderr, /closed task.*--all includes them/);
  });

  it('runnable neither mentions --all nor changes its answer when the archive appears', () => {
    const root = scopedBacklog();
    const before = runCli(root, ['runnable']);
    assert.strictEqual(before.status, 0, before.stderr);
    assert.strictEqual(runCli(root, ['archive']).status, 0);
    const after = runCli(root, ['runnable']);
    assert.strictEqual(after.status, 0, after.stderr);
    assert.strictEqual(after.stdout, before.stdout, 'archiving changed what can be started');
    assert.doesNotMatch(after.stderr, /--all/, 'runnable pointed the reader at a flag it refuses');

    // Said rather than reasoned about: what `archive` moved is closed, and no
    // closed status is `ready`, so no archived task could ever be runnable.
    const archived = parseBacklog(fs.readFileSync(archivePath(root), 'utf8'));
    assert.ok(archived.length > 0, 'nothing was archived, so the claim above is vacuous');
    assert.deepStrictEqual(
      archived.filter((t) => t.status === 'ready').map((t) => t.id),
      [],
      'the archive holds a ready task, and runnable is right to be asked about it'
    );
  });

  // Decision 3. The dependency half is unchanged and still comes from
  // blockingDependencies(); this is the lifecycle half beside it.
  it('a closed task with an unsatisfied prerequisite is not blocked, and an open one with the same prerequisite is', () => {
    const root = makeTmpRoot();
    const prerequisite = add(root, ['--title', 'Never finished', '--labels', 'lc']);
    const waiting = add(root, ['--title', 'Waiting on it', '--labels', 'lc']);
    const finished = add(root, ['--title', 'Finished anyway', '--labels', 'lc']);
    assert.strictEqual(runCli(root, ['status', prerequisite, 'open']).status, 0);
    assert.strictEqual(runCli(root, ['status', waiting, 'open']).status, 0);
    addBrief(root, waiting, 'slug');
    assert.strictEqual(runCli(root, ['status', waiting, 'ready']).status, 0);
    driveToDone(root, finished);
    // After it is done, so the ready -> in_progress guard is not what decides
    // this test; both tasks then carry the SAME unsatisfied prerequisite.
    assert.strictEqual(runCli(root, ['depends', waiting, prerequisite]).status, 0);
    assert.strictEqual(runCli(root, ['depends', finished, prerequisite]).status, 0);

    // The fixture cannot make the assertion true by itself: the dependency half
    // holds for both tasks, and only the lifecycle half tells them apart.
    const listed = JSON.parse(runCli(root, ['list', '--json']).stdout).tasks;
    const blockedBy = Object.fromEntries(listed.map((t) => [t.id, t.blockedBy]));
    assert.deepStrictEqual(blockedBy[waiting], [prerequisite]);
    assert.deepStrictEqual(blockedBy[finished], [prerequisite], 'the closed task lost its prerequisite');

    assert.strictEqual(doc(root, ['--label', 'lc']).blocked, 1, 'finished work is being counted as waiting');
    // And it is the open one that is counted, not just any one of the two.
    assert.strictEqual(runCli(root, ['status', waiting, 'in_progress']).status, 1, 'the guard let a blocked task start');
    assert.strictEqual(doc(root, ['--label', 'lc']).ready, 1);
  });

  // Decision 4. Two different queries may not store the same answer.
  describe('scope round-trips the query it was an answer to', () => {
    function labelled() {
      const root = makeTmpRoot();
      add(root, ['--title', 'Carries a', '--labels', 'a']);
      add(root, ['--title', 'Carries b', '--labels', 'b']);
      add(root, ['--title', 'Carries both', '--labels', 'a,b']);
      add(root, ['--title', 'Carries a and c', '--labels', 'a,c']);
      return root;
    }

    it('a repeated --label and a comma-separated one are two documents, not one', () => {
      const root = labelled();
      const and = doc(root, ['--label', 'a', '--label', 'b']);
      const or = doc(root, ['--label', 'a,b']);
      assert.deepStrictEqual(and.scope, { labels: [['a'], ['b']], labelQuery: 'a AND b' });
      assert.deepStrictEqual(or.scope, { labels: [['a', 'b']], labelQuery: 'a OR b' });
      assert.notDeepStrictEqual(and.scope, or.scope, 'two different queries stored the same scope');
      // The distinction is not cosmetic: the two select different tasks, which is
      // exactly why a stored answer has to say which one it was.
      assert.strictEqual(and.total, 1, 'only the task carrying both labels matches a AND b');
      assert.strictEqual(or.total, 4, 'every task carrying either label matches a OR b');
    });

    it('a mixed query keeps both halves, and the rendering says where the OR ends', () => {
      const root = labelled();
      const mixed = doc(root, ['--label', 'a,b', '--label', 'c']);
      assert.deepStrictEqual(mixed.scope, { labels: [['a', 'b'], ['c']], labelQuery: '(a OR b) AND c' });
      assert.strictEqual(mixed.total, 1, '(a OR b) AND c selects the one task carrying a and c');
    });

    it('no --label at all is every task, and says so in words', () => {
      const root = labelled();
      assert.deepStrictEqual(doc(root).scope, { labels: [], labelQuery: 'every task' });
      assert.strictEqual(doc(root).total, 4);
    });

    it('the human-readable form is what the plain-text output prints', () => {
      const root = labelled();
      const line = (args) => runCli(root, ['summary', ...args]).stdout.split(/\r?\n/)[0];
      assert.strictEqual(line([]), 'scope: every task');
      assert.strictEqual(line(['--label', 'a,b']), 'scope: labels a OR b');
      assert.strictEqual(line(['--label', 'a', '--label', 'b']), 'scope: labels a AND b');
      assert.strictEqual(line(['--label', 'a,b', '--label', 'c']), 'scope: labels (a OR b) AND c');
    });
  });
});
