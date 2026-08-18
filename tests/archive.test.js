'use strict';

// Tests for the closed-task archive (T-0156): doc/backlog-archive.md, the
// `archive` CLI command, and — first of all — the identifier rule.
//
// The id test is the reason this file exists. `add` used to take the next id
// from the maximum in doc/backlog.md alone; moving the closed tasks out resets
// that maximum, so the next `add` hands out T-0001 a second time. Two tasks with
// one id is silent and unfixable after the fact: `depends: T-0042` points at
// both, and doc/brief/T-0042-*.md belongs to both.
//
// Everything is written under os.tmpdir() — no test ever creates a real
// doc/backlog-archive.md in this repository.

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { parseBacklog, serializeBacklog, addTask } = require('../server/parser.js');
const { validateBacklog } = require('../server/validate.js');
const { writeBoardTrace, TRACE_SINCE } = require('../server/trace.js');
const { tempDir } = require('./helpers/tmp.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

const roots = [];
function makeTmpRoot() {
  const root = tempDir('briefboard-archive-test-');
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, AGENTBOARD_ROOT: root },
    encoding: 'utf8',
  });
}

const backlogPath = (root) => path.join(root, 'doc', 'backlog.md');
const archivePath = (root) => path.join(root, 'doc', 'backlog-archive.md');

function task(id, over = {}) {
  return {
    id,
    priority: 'Major',
    title: `task ${id}`,
    type: 'feature',
    status: 'done',
    created: '2026-01-01 00:00:00',
    closed: '2026-01-02 00:00:00',
    briefs: [],
    labels: [],
    depends: [],
    profile: '',
    extra: {},
    description: '',
    ...over,
  };
}

function writeBacklog(root, tasks) {
  const file = backlogPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeBacklog(tasks));
  return file;
}

function writeArchive(root, tasks) {
  const file = archivePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeBacklog(tasks));
  return file;
}

const ids = (tasks) => tasks.map((t) => t.id);
const readBacklog = (root) => parseBacklog(fs.readFileSync(backlogPath(root), 'utf8'));
const readArchive = (root) => parseBacklog(fs.readFileSync(archivePath(root), 'utf8'));

describe('archive: identifiers survive it (T-0156)', () => {
  it('addTask() counts the archived tasks, not just the live ones', () => {
    const root = makeTmpRoot();
    // The state right after archiving everything: nothing left in the backlog,
    // the whole history in the archive. The naive maximum here is 0.
    writeBacklog(root, []);
    writeArchive(root, [task('T-0001'), task('T-0002'), task('T-0003')]);

    assert.strictEqual(addTask(backlogPath(root), { title: 'after the archive' }), 'T-0004');
  });

  it('the highest id wins wherever it sits', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0009', { status: 'ready' })]);
    writeArchive(root, [task('T-0041'), task('T-0007')]);

    assert.strictEqual(addTask(backlogPath(root), { title: 'next' }), 'T-0042');
  });

  it('`archive` then `add` never repeats an id', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001'), task('T-0002'), task('T-0003')]);

    const archived = runCli(root, ['archive']);
    assert.strictEqual(archived.status, 0, `archive failed: ${archived.stderr}`);
    assert.deepStrictEqual(ids(readBacklog(root)), []);
    assert.deepStrictEqual(ids(readArchive(root)), ['T-0001', 'T-0002', 'T-0003']);

    const added = runCli(root, ['add', '--title', 'after the archive']);
    assert.strictEqual(added.status, 0, `add failed: ${added.stderr}`);
    assert.strictEqual(added.stdout.trim(), 'T-0004');
  });
});

describe('archive: what moves', () => {
  it('moves the closed tasks and only those', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [
      task('T-0001', { status: 'done' }),
      task('T-0002', { status: 'ready', closed: '' }),
      task('T-0003', { status: 'cancelled' }),
      task('T-0004', { status: 'in_progress', closed: '' }),
    ]);

    const res = runCli(root, ['archive']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(ids(readBacklog(root)), ['T-0002', 'T-0004']);
    assert.deepStrictEqual(ids(readArchive(root)), ['T-0001', 'T-0003']);
  });

  it('carries the task across unchanged — fields, depends, briefs, description', () => {
    const root = makeTmpRoot();
    const original = task('T-0002', {
      priority: 'Blocker',
      type: 'bug',
      title: 'a title with · a separator in it',
      depends: ['T-0001'],
      briefs: ['T-0002-01'],
      labels: ['ui', 'docs'],
      profile: 'fast',
      extra: { 'due-date': '2026-09-01' },
      description: '## Not a header\n\nA body.\n\n### Worker report\nBranch: x\n',
    });
    writeBacklog(root, [task('T-0001'), original]);

    assert.strictEqual(runCli(root, ['archive']).status, 0);
    const [, archived] = readArchive(root);
    assert.deepStrictEqual(archived, { ...original, description: original.description.trim() });
  });

  it('--dry-run reports and writes nothing', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001'), task('T-0002', { status: 'ready', closed: '' })]);
    const before = fs.readFileSync(backlogPath(root), 'utf8');

    const res = runCli(root, ['archive', '--dry-run']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /would move 1 closed task/);
    assert.strictEqual(fs.existsSync(archivePath(root)), false);
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
  });

  it('appends to an archive that already exists', () => {
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0001')]);
    writeBacklog(root, [task('T-0002'), task('T-0003', { status: 'open', closed: '' })]);

    assert.strictEqual(runCli(root, ['archive']).status, 0);
    assert.deepStrictEqual(ids(readArchive(root)), ['T-0001', 'T-0002']);
    assert.deepStrictEqual(ids(readBacklog(root)), ['T-0003']);
  });

  it('repairs a task left in both files, instead of archiving it twice', () => {
    // What an interrupted run leaves behind: the archive was written, the
    // backlog was not. Running the command again must finish the job.
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0001')]);
    writeBacklog(root, [task('T-0001')]);

    assert.strictEqual(runCli(root, ['archive']).status, 0);
    assert.deepStrictEqual(ids(readArchive(root)), ['T-0001']);
    assert.deepStrictEqual(ids(readBacklog(root)), []);
  });

  it('says so and creates no file when nothing is closed', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001', { status: 'ready', closed: '' })]);

    const res = runCli(root, ['archive']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /nothing to archive/);
    assert.strictEqual(fs.existsSync(archivePath(root)), false);
  });
});

// T-0174. Found live: a board that had been open since before the archive
// existed went on reading doc/backlog.md alone, so archiving emptied its Done
// and Cancelled columns and nothing said why.
//
// The board could not be seen from here at all when this was written, so the
// message had a second form that said so. Since T-0186 a running board leaves
// .briefboard/boards/<pid>.json and the answer is direct — the registry stays
// as the witness for a board older than that, which left no trace. The trace
// side of it is tested in tests/board-trace.test.js, against a real board.
describe('archive: what it says about a board that may be open', () => {
  function writeRegistry(root, sessions) {
    const file = path.join(root, '.briefboard', 'sessions', 'registry.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions }, null, 2) + '\n');
    return file;
  }

  const session = (over = {}) => ({
    id: 'T-0009',
    kind: 'worker',
    pid: 424242,
    board: process.pid,
    startedAt: '2026-01-01T00:00:00.000Z',
    logPath: 'sessions/T-0009.log',
    status: 'running',
    ...over,
  });

  it('warns that an older board now shows Done and Cancelled as empty', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001'), task('T-0002', { status: 'ready', closed: '' })]);

    const res = runCli(root, ['archive']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /doc\/backlog-archive\.md reads doc\/backlog\.md alone/);
    assert.match(res.stderr, /Done and Cancelled columns look emptied until it is/);
    assert.match(res.stderr, /restarted/);
  });

  it('says no board is running when neither witness sees one', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001')]);

    const res = runCli(root, ['archive']);

    // No trace and no registry. That is now an answer rather than a shrug — with
    // the one gap it still has named, so the reader knows what it does not cover.
    assert.match(res.stderr, /NOTE: no board is running for this project/);
    assert.match(res.stderr, new RegExp(`older than briefboard ${TRACE_SINCE}`));
    assert.doesNotMatch(res.stderr, /WARNING: a board is running/);
  });

  it('names a board older than the trace, on the registry alone', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001')]);
    // This test process stands in for the board: its pid is alive and is not the
    // CLI's own, which is what makes the record's `running` survive reconciliation.
    // It writes no trace, which is exactly what a pre-T-0186 board looks like.
    writeRegistry(root, [session()]);

    const res = runCli(root, ['archive']);

    assert.match(res.stderr, new RegExp(`WARNING: a board is running for this project: pid ${process.pid}\\b`));
    assert.match(res.stderr, /\.briefboard\/sessions\/registry\.json/);
    assert.match(res.stderr, new RegExp(`predates briefboard ${TRACE_SINCE}`));
    assert.doesNotMatch(res.stderr, /no board is running/);
  });

  it('names a board once when both witnesses see the same one', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001')]);
    writeRegistry(root, [session()]);
    writeBoardTrace(root, {
      port: 4571,
      host: '127.0.0.1',
      installRoot: path.join(__dirname, '..'),
      pid: process.pid,
    });

    const res = runCli(root, ['archive']);

    const named = res.stderr.match(/WARNING: a board is running/g) || [];
    assert.strictEqual(named.length, 1, `the same board must be reported once:\n${res.stderr}`);
    assert.match(res.stderr, new RegExp(`pid ${process.pid} on 127\\.0\\.0\\.1:4571`));
    assert.doesNotMatch(res.stderr, /predates briefboard/, 'a board with a trace does not predate it');
  });

  it('says nothing about boards when the run ends without moving a task', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001', { status: 'ready', closed: '' })]);
    writeRegistry(root, [session()]);

    const res = runCli(root, ['archive']);

    assert.match(res.stdout, /nothing to archive/);
    assert.strictEqual(res.stderr.trim(), '');
  });

  it('says nothing about boards on a dry run, which changes no file', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001')]);
    writeRegistry(root, [session()]);

    const res = runCli(root, ['archive', '--dry-run']);

    assert.match(res.stdout, /would move 1 closed task/);
    assert.strictEqual(res.stderr.trim(), '');
  });
});

describe('archive: the CLI says where it looked', () => {
  it('`show` finds an archived task and reports that it is archived', () => {
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0007', { description: 'The statement of work.' })]);
    writeBacklog(root, []);

    const res = runCli(root, ['show', 'T-0007']);
    assert.strictEqual(res.status, 0, res.stderr);
    const shown = JSON.parse(res.stdout);
    assert.strictEqual(shown.id, 'T-0007');
    assert.strictEqual(shown.archived.file, 'doc/backlog-archive.md');
    assert.match(shown.archived.note, /CLOSED/);
  });

  it('`show` of a live task says nothing about an archive', () => {
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0001')]);
    writeBacklog(root, [task('T-0002', { status: 'ready', closed: '' })]);

    const shown = JSON.parse(runCli(root, ['show', 'T-0002']).stdout);
    assert.strictEqual(shown.archived, undefined);
  });

  it('`show` still leaves the worker reports out of an archived task (T-0161)', () => {
    const root = makeTmpRoot();
    writeArchive(root, [
      task('T-0007', { description: 'Statement.\n\n### Worker report\nBranch: task/T-0007-x' }),
    ]);
    writeBacklog(root, []);

    const shown = JSON.parse(runCli(root, ['show', 'T-0007']).stdout);
    assert.strictEqual(shown.description, 'Statement.');
    assert.strictEqual(shown.omitted.sections, 1);
    assert.ok(shown.archived, 'both notes are reported, not one instead of the other');
  });

  it('`show` of an unknown id names both files it looked in', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001')]);

    const res = runCli(root, ['show', 'T-0999']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /doc\/backlog\.md and doc\/backlog-archive\.md/);
  });

  it('`list` leaves the archive out by default, and says that it did', () => {
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0001')]);
    writeBacklog(root, [task('T-0002', { status: 'ready', closed: '' })]);

    const res = runCli(root, ['list']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /T-0002/);
    assert.doesNotMatch(res.stdout, /T-0001/);
    assert.match(res.stderr, /1 closed task in doc\/backlog-archive\.md/);
  });

  it('`list --all` includes the archived tasks and stops explaining itself', () => {
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0001')]);
    writeBacklog(root, [task('T-0002', { status: 'ready', closed: '' })]);

    const res = runCli(root, ['list', '--all']);
    assert.match(res.stdout, /T-0001/);
    assert.match(res.stdout, /T-0002/);
    assert.strictEqual(res.stderr.trim(), '');
  });

  it('`list` says nothing extra when the project has no archive', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0002', { status: 'ready', closed: '' })]);

    assert.strictEqual(runCli(root, ['list']).stderr.trim(), '');
  });
});

describe('archive: references across the border', () => {
  it('a task may depend on an archived one', () => {
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0001')]);
    writeBacklog(root, [task('T-0002', { status: 'ready', closed: '' })]);

    const res = runCli(root, ['depends', 'T-0002', 'T-0001']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(readBacklog(root)[0].depends, ['T-0001']);
  });

  it('an archived prerequisite is satisfied, so the dependent can start', () => {
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0001', { status: 'done' })]);
    writeBacklog(root, [
      task('T-0002', { status: 'ready', closed: '', depends: ['T-0001'], briefs: ['T-0002-01'] }),
    ]);

    const res = runCli(root, ['status', 'T-0002', 'in_progress']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(readBacklog(root)[0].status, 'in_progress');
  });

  it('a writing command refuses an archived task, and says why', () => {
    // Not "not found": `show` finds it. The archive is read-only, so `note` -
    // the one write a closed task used to accept - is refused there too.
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0001')]);
    writeBacklog(root, []);

    for (const args of [
      ['status', 'T-0001', 'in_progress'],
      ['note', 'T-0001', '--section', 'Worker report', '--text', 'late'],
      ['depends', 'T-0001', 'T-0002'],
      ['labels', 'T-0001', 'ui'],
      ['brief', 'T-0001', 'slug'],
    ]) {
      const res = runCli(root, args);
      assert.strictEqual(res.status, 1, `${args[0]} was allowed`);
      assert.match(res.stderr, /T-0001 is archived/, `${args[0]}: ${res.stderr}`);
    }
    assert.deepStrictEqual(readArchive(root)[0], task('T-0001'));
  });

  it('a prerequisite that is in neither file still blocks', () => {
    const root = makeTmpRoot();
    writeArchive(root, [task('T-0001')]);
    writeBacklog(root, [task('T-0002', { status: 'ready', closed: '', depends: ['T-0404'] })]);

    const res = runCli(root, ['status', 'T-0002', 'in_progress']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /T-0404 \(not found\)/);
  });
});

describe('validateBacklog(): both files', () => {
  const live = (tasks) => serializeBacklog(tasks);

  it('reports an id that is in both files', () => {
    const errors = validateBacklog(
      live([task('T-0001', { status: 'ready', closed: '' })]),
      null,
      live([task('T-0001')])
    );
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /T-0001 is in BOTH/);
  });

  it('reports a task in the archive that is not closed', () => {
    const errors = validateBacklog(live([]), null, live([task('T-0009', { status: 'ready', closed: '' })]));
    assert.deepStrictEqual(errors, [
      'backlog-archive.md: T-0009 has status "ready" - only done/cancelled belong in the archive',
    ]);
  });

  it('names the archive when the damage is in it', () => {
    const errors = validateBacklog(live([]), null, '## T-0001 - Major - broken header\n');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /^backlog-archive\.md: Line 1: malformed task header/);
  });

  it('accepts a dependency that points into the archive', () => {
    const errors = validateBacklog(
      live([task('T-0002', { status: 'ready', closed: '', depends: ['T-0001'] })]),
      null,
      live([task('T-0001')])
    );
    assert.deepStrictEqual(errors, []);
  });

  it('still reports a dependency that is in neither file', () => {
    const errors = validateBacklog(
      live([task('T-0002', { status: 'ready', closed: '', depends: ['T-0404'] })]),
      null,
      live([task('T-0001')])
    );
    assert.deepStrictEqual(errors, ['T-0002: depends on T-0404, which does not exist']);
  });

  // Until T-0169 this asserted the opposite - that omitting the argument was the
  // same as passing ''. That equivalence is what let the stale call site of
  // T-0168 validate the backlog without its archive and stay green for months.
  it("refuses a missing archive argument; '' is how a project without an archive says so", () => {
    const text = live([task('T-0001', { status: 'ready', closed: '' })]);
    assert.throws(() => validateBacklog(text, null), {
      name: 'TypeError',
      message: /archiveText is required/,
    });
    assert.deepStrictEqual(validateBacklog(text, null, ''), []);
  });

  it('the CLI checks the archive too', () => {
    const root = makeTmpRoot();
    writeBacklog(root, [task('T-0001', { status: 'ready', closed: '' })]);
    writeArchive(root, [task('T-0001')]);

    const res = runCli(root, ['validate']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /T-0001 is in BOTH/);
  });
});
