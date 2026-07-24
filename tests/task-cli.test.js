'use strict';

// Tests for tools/task.mjs — the CLI agents use to edit doc/backlog.md / doc/brief/.
// Run with: npm test  (or: node --test tests/**/*.test.js)
//
// Each test runs the CLI as a real child process (node tools/task.mjs ...) against a
// throwaway AGENTBOARD_ROOT, so the real project's doc/backlog.md and doc/brief/ are
// never touched. Assertions check both the CLI's observable behavior (stdout, exit
// code) and the resulting doc/backlog.md content (via parseBacklog), matching the
// brief's "do not duplicate validateBacklog()" scope for the `validate` command.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { parseBacklog } = require('../server/parser.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

/** Run `node tools/task.mjs <args>` against an isolated AGENTBOARD_ROOT. Never throws. */
function runCli(root, args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, AGENTBOARD_ROOT: root },
    encoding: 'utf8',
  });
}

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-cli-test-'));
}

function backlogPath(root) {
  return path.join(root, 'doc', 'backlog.md');
}

function briefDir(root) {
  return path.join(root, 'doc', 'brief');
}

/** Read + parse doc/backlog.md for the given tmp root; [] if the file was never created. */
function readTasks(root) {
  const p = backlogPath(root);
  if (!fs.existsSync(p)) return [];
  return parseBacklog(fs.readFileSync(p, 'utf8'));
}

function add(root, args) {
  const res = runCli(root, ['add', ...args]);
  assert.strictEqual(res.status, 0, `add failed: ${res.stderr}`);
  return res.stdout.trim(); // the printed id, e.g. "T-0001"
}

function addBrief(root, id, slug) {
  const res = runCli(root, ['brief', id, slug]);
  assert.strictEqual(res.status, 0, `brief failed: ${res.stderr}`);
  return res.stdout.trim(); // the printed file path
}

describe('task.mjs add', () => {
  it('creates a task with the given title/type/priority and status: backlog, created stamp, no briefs', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--type', 'bug', '--priority', 'Critical', '--title', 'Fix the thing', '--desc', 'Some details.']);
    assert.strictEqual(id, 'T-0001');

    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, 1);
    const t = tasks[0];
    assert.strictEqual(t.id, 'T-0001');
    assert.strictEqual(t.title, 'Fix the thing');
    assert.strictEqual(t.type, 'bug');
    assert.strictEqual(t.priority, 'Critical');
    assert.strictEqual(t.status, 'backlog');
    assert.strictEqual(t.closed, '');
    assert.deepStrictEqual(t.briefs, []);
    assert.strictEqual(t.description, 'Some details.');
    assert.match(t.created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('defaults type to feature and priority to Medium when omitted', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Bare minimum task']);
    const [t] = readTasks(root);
    assert.strictEqual(t.type, 'feature');
    assert.strictEqual(t.priority, 'Medium');
  });

  it('defaults priority to Medium when the flag value is not one of PRIORITIES', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Bogus priority', '--priority', 'Extreme']);
    const [t] = readTasks(root);
    assert.strictEqual(t.priority, 'Medium');
  });

  it('forces type to feature when the flag value is not "bug"', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Bogus type', '--type', 'chore']);
    const [t] = readTasks(root);
    assert.strictEqual(t.type, 'feature');
  });

  it('increments the id from the current max, regardless of insertion order', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'First']);
    add(root, ['--title', 'Second']);
    const ids = readTasks(root).map((t) => t.id);
    assert.deepStrictEqual(ids, ['T-0001', 'T-0002']);
  });

  it('trims the title', () => {
    const root = makeTmpRoot();
    add(root, ['--title', '  Spacey title  ']);
    const [t] = readTasks(root);
    assert.strictEqual(t.title, 'Spacey title');
  });

  it('fails with a non-zero exit code and an error message when --title is missing', () => {
    const root = makeTmpRoot();
    const res = runCli(root, ['add', '--type', 'feature']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR/);
    assert.deepStrictEqual(readTasks(root), []); // nothing written
  });

  it('does not swallow the next flag as a missing value: `--title --priority Major` fails on empty --title and keeps Major', () => {
    const root = makeTmpRoot();
    // Before the parseFlags guard this made title="--priority" and dropped Major.
    const res = runCli(root, ['add', '--title', '--priority', 'Major']);
    assert.notStrictEqual(res.status, 0); // empty required --title is caught
    assert.match(res.stderr, /ERROR/);
    assert.deepStrictEqual(readTasks(root), []); // nothing written

    // With a real title, --priority Major is still parsed correctly (not eaten).
    add(root, ['--title', 'Real title', '--priority', 'Major']);
    const [t] = readTasks(root);
    assert.strictEqual(t.title, 'Real title');
    assert.strictEqual(t.priority, 'Major');
  });
});

describe('task.mjs status', () => {
  // Walk a task through the full lifecycle graph (server/parser.js TRANSITIONS) and
  // assert each legal step lands and sets `closed` correctly. The old test iterated
  // STATUSES in array order, which is no longer a legal path (done -> cancelled is
  // not a transition); this follows the actual graph instead.
  it('supports the full legal lifecycle path and sets closed accordingly', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Lifecycle task']);
    addBrief(root, id, 'some-brief'); // needed before it can ever go to ready

    const path = ['open', 'ready', 'in_progress', 'review', 'done'];
    for (const status of path) {
      const res = runCli(root, ['status', id, status]);
      assert.strictEqual(res.status, 0, `transition to ${status} failed: ${res.stderr}`);
      assert.match(res.stdout, new RegExp(`${id} -> ${status}`));

      const [t] = readTasks(root);
      assert.strictEqual(t.status, status);
      if (status === 'done') {
        assert.match(t.closed, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      } else {
        assert.strictEqual(t.closed, '');
      }
    }
  });

  it('sets closed when a task is cancelled from a non-terminal status', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'To be cancelled']);
    const res = runCli(root, ['status', id, 'cancelled']); // backlog -> cancelled is legal
    assert.strictEqual(res.status, 0, res.stderr);
    const [t] = readTasks(root);
    assert.strictEqual(t.status, 'cancelled');
    assert.match(t.closed, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('clears closed again after force-reopening a done task', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Reopen me']);
    addBrief(root, id, 'brief');
    for (const s of ['open', 'ready', 'in_progress', 'review', 'done']) runCli(root, ['status', id, s]);
    assert.notStrictEqual(readTasks(root)[0].closed, '');

    // done is terminal in the graph, so reopening requires --force.
    const res = runCli(root, ['status', id, 'in_progress', '--force']);
    assert.strictEqual(res.status, 0, res.stderr);
    const [t] = readTasks(root);
    assert.strictEqual(t.status, 'in_progress');
    assert.strictEqual(t.closed, '');
  });

  it('rejects an illegal transition, exits non-zero, and leaves backlog.md unchanged', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'No skipping']);
    const before = fs.readFileSync(backlogPath(root), 'utf8');
    // backlog -> ready is not a legal transition (must go through open first).
    const res = runCli(root, ['status', id, 'ready']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR/);
    assert.match(res.stderr, /backlog -> ready/);
    assert.strictEqual(readTasks(root)[0].status, 'backlog'); // unchanged
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before); // file untouched
  });

  it('allows a same-status no-op transition (X -> X)', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Idempotent']);
    const res = runCli(root, ['status', id, 'backlog']); // already backlog
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`${id} -> backlog`));
    assert.strictEqual(readTasks(root)[0].status, 'backlog');
  });

  it('--force allows an illegal transition and prints a WARNING to stderr', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Force me']);
    // backlog -> review is illegal; --force permits it but shouts.
    const res = runCli(root, ['status', id, 'review', '--force']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /WARNING: forced transition backlog -> review \(bypasses lifecycle graph\)/);
    assert.strictEqual(readTasks(root)[0].status, 'review');
  });

  it('refuses to move a task to ready when it has no briefs (via a legal open -> ready path)', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'No briefs yet']);
    runCli(root, ['status', id, 'open']); // legal, so the ready check is what fires next
    const res = runCli(root, ['status', id, 'ready']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR/);
    assert.match(res.stderr, /brief/);
    assert.strictEqual(readTasks(root)[0].status, 'open'); // unchanged
  });

  it('refuses to move a task to ready without a brief even with --force', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'No brief, forced']);
    // --force bypasses the transition graph but NOT the "ready requires a brief" invariant.
    const res = runCli(root, ['status', id, 'ready', '--force']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR/);
    assert.match(res.stderr, /brief/);
    assert.strictEqual(readTasks(root)[0].status, 'backlog'); // unchanged
  });

  it('allows moving to ready once a brief is attached (via open)', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Has a brief']);
    addBrief(root, id, 'the-brief');
    runCli(root, ['status', id, 'open']);
    const res = runCli(root, ['status', id, 'ready']);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(readTasks(root)[0].status, 'ready');
  });

  it('fails with a non-zero exit code for a non-existent task id', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Only task']); // creates T-0001, so T-0099 does not exist
    const res = runCli(root, ['status', 'T-0099', 'open']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR/);
  });

  it('fails with a non-zero exit code for a status not in STATUSES', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Task']);
    const res = runCli(root, ['status', id, 'not_a_real_status']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR/);
    assert.strictEqual(readTasks(root)[0].status, 'backlog'); // unchanged
  });
});

describe('task.mjs brief', () => {
  it('creates doc/brief/<id>-<nn>-<slug>.md with the expected template and links it on the task', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Needs a brief']);
    const file = addBrief(root, id, 'my-first-brief');

    const expectedPath = path.join(briefDir(root), `${id}-01-my-first-brief.md`);
    assert.strictEqual(file, expectedPath);
    assert.ok(fs.existsSync(expectedPath));

    const content = fs.readFileSync(expectedPath, 'utf8');
    assert.strictEqual(
      content,
      `# ${id}-01 · Needs a brief\n\n## Context\n\n## Solution\n\n## Scope\n\n## Acceptance criteria\n- [ ] \n`
    );

    const [t] = readTasks(root);
    assert.deepStrictEqual(t.briefs, [`${id}-01`]);
  });

  it('numbers subsequent briefs on the same task 01, 02, ... and appends to briefs', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Multi-brief task']);
    addBrief(root, id, 'first');
    addBrief(root, id, 'second');

    const [t] = readTasks(root);
    assert.deepStrictEqual(t.briefs, [`${id}-01`, `${id}-02`]);
    assert.ok(fs.existsSync(path.join(briefDir(root), `${id}-01-first.md`)));
    assert.ok(fs.existsSync(path.join(briefDir(root), `${id}-02-second.md`)));
  });

  it('normalizes the slug: lowercases, replaces unsafe runs with a single dash, trims edge dashes', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Slug normalization']);
    const file = addBrief(root, id, '  My Weird Slug!! ');
    assert.strictEqual(path.basename(file), `${id}-01-my-weird-slug.md`);
  });

  it('fails with a non-zero exit code for a non-existent task id', () => {
    const root = makeTmpRoot();
    const res = runCli(root, ['brief', 'T-0099', 'slug']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR/);
    assert.deepStrictEqual(fs.existsSync(briefDir(root)) ? fs.readdirSync(briefDir(root)) : [], []);
  });
});

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
