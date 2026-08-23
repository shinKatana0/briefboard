'use strict';

// Tests for tools/task.mjs — the CLI agents use to edit doc/backlog.md / doc/brief/.
// Run with: npm test  (or: node --test tests/**/*.test.js)
//
// Each test runs the CLI as a real child process (node tools/task.mjs ...) against a
// throwaway AGENTBOARD_ROOT, so the real project's doc/backlog.md and doc/brief/ are
// never touched. Assertions check both the CLI's observable behavior (stdout, exit
// code) and the resulting doc/backlog.md content (via parseBacklog), matching the
// brief's "do not duplicate validateBacklog()" scope for the `validate` command.

require('./helpers/env.js');
const { describe, it, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const { parseBacklog, MAX_LABEL_LEN, MAX_LABELS, STATUSES } = require('../server/parser.js');
const { REGISTRY_FILE, REGISTRY_VERSION } = require('../server/sessions.js');
const { tempDir } = require('./helpers/tmp.js');
// One test below asks GET /api/board what it calls a field, so it needs a real
// board: the only spawn in this file that is not the CLI itself. `fetch` comes
// from helpers/bounded.js, bounded, like every fetch in the suite (T-0124).
const { fetch, SESSION_START_TIMEOUT_MS } = require('./helpers/bounded.js');
const { TRACE_VERSION } = require('../server/trace.js');
const { waitFor, SPAWN_WAIT_BUDGET_MS } = require('./helpers/wait.js');
const { readJson, answerOf } = require('./helpers/response.js');
const { startBoard } = require('./helpers/board.js');

const CLI_PATH = path.join(__dirname, '..', 'tools', 'task.mjs');

/** Run `node tools/task.mjs <args>` against an isolated AGENTBOARD_ROOT. Never throws. */
function runCli(root, args, input) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, AGENTBOARD_ROOT: root },
    encoding: 'utf8',
    input,
  });
}

function makeTmpRoot() {
  return tempDir('briefboard-cli-test-');
}

function backlogPath(root) {
  return path.join(root, 'doc', 'backlog.md');
}

function briefDir(root) {
  return path.join(root, 'doc', 'brief');
}

function archivePath(root) {
  return path.join(root, 'doc', 'backlog-archive.md');
}

/** Read + parse doc/backlog.md for the given tmp root; [] if the file was never created. */
function readTasks(root) {
  const p = backlogPath(root);
  if (!fs.existsSync(p)) return [];
  return parseBacklog(fs.readFileSync(p, 'utf8'));
}

function add(root, args, input) {
  const res = runCli(root, ['add', ...args], input);
  assert.strictEqual(res.status, 0, `add failed: ${res.stderr}`);
  return res.stdout.trim(); // the printed id, e.g. "T-0001"
}

function addBrief(root, id, slug) {
  const res = runCli(root, ['brief', id, slug]);
  assert.strictEqual(res.status, 0, `brief failed: ${res.stderr}`);
  return res.stdout.trim(); // the printed file path
}

// One turn of the event loop before every test, and that is all it does
// (T-0311). Every test in this file drives the CLI with spawnSync, so across an
// uninterrupted stretch of them the loop never turns — and node:test reports a
// file's results from that file's own process, which cannot print a mark it
// cannot reach. What such a stretch spends is not this file's own time but the
// SILENCE budget shared with every other file in tools/test-run.mjs, and that
// budget is the only thing catching a test which holds the event loop open
// after its own end (T-0272-02), so it may not be raised to make room.
//
// Measured 2026-08-23 (Windows 11, node v24.18.0, 24 cores) on four blocking
// 2.2s tests: with no hook all four marks appear together at 9.1s, with this
// one at 2.5s / 4.7s / 6.9s / 9.2s, and the file costs the same 9.2s either
// way — the loop turn is not a delay, it is the file reporting as it goes.
// Across the whole suite, quiet, the longest stretch with nothing printed was
// 176.6s before this hook and 8.1s after it, while the run itself took 383s and
// 387s — the same run, reporting as it goes (CONTRIBUTING.md, `--timing-dir`).
// What is left is bounded by the slowest single test and no longer by a whole
// describe, which is the only bound a file of blocking tests can have.
//
// Nothing here asserts a duration: a test that fails when the machine is busy
// is the class of test T-0270/T-0271/T-0272 spent a night removing.
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

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

  // T-0286. Both used to be replaced by the default: `--type chore` filed a
  // feature, exit 0, and the only sign was `show` printing a value nobody typed.
  // Absent still defaults (the test above); typed-and-wrong is now refused.
  it('refuses a --type outside the list, names the legal values, and files nothing', () => {
    const root = makeTmpRoot();
    const res = runCli(root, ['add', '--title', 'Bogus type', '--type', 'chore']);
    assert.notStrictEqual(res.status, 0, `accepted: ${res.stdout}`);
    assert.match(res.stderr, /ERROR: type must be one of: feature, bug, external/);
    assert.deepStrictEqual(readTasks(root), []);
  });

  it('refuses a --priority outside the list, names the legal values, and files nothing', () => {
    const root = makeTmpRoot();
    const res = runCli(root, ['add', '--title', 'Bogus priority', '--priority', 'Extreme']);
    assert.notStrictEqual(res.status, 0, `accepted: ${res.stdout}`);
    assert.match(res.stderr, /ERROR: priority must be one of: Blocker, Critical, Major, Medium, Minor/);
    assert.deepStrictEqual(readTasks(root), []);
  });

  // A flag typed with nothing after it becomes '' in parseArgs, and an empty
  // string is a value the caller supplied - not the omission that defaults.
  it('refuses --type/--priority given empty or with nothing after them', () => {
    const root = makeTmpRoot();
    const calls = [
      ['add', '--title', 'A', '--type', ''],
      ['add', '--title', 'A', '--priority', ''],
      ['add', '--title', 'A', '--type'],
      ['add', '--title', 'A', '--priority'],
    ];
    for (const args of calls) {
      const res = runCli(root, args);
      assert.notStrictEqual(res.status, 0, `accepted ${args.join(' ')}: ${res.stdout}`);
      assert.match(res.stderr, /ERROR: (type|priority) must be one of/);
    }
    assert.deepStrictEqual(readTasks(root), [], 'none of the four filed anything');

    // And the same command without the flag at all still works.
    add(root, ['--title', 'A']);
    const [t] = readTasks(root);
    assert.strictEqual(t.type, 'feature');
    assert.strictEqual(t.priority, 'Medium');
  });

  it('accepts every legal --type and --priority verbatim', () => {
    const root = makeTmpRoot();
    for (const type of ['feature', 'bug', 'external']) {
      const id = add(root, ['--title', `Typed ${type}`, '--type', type]);
      assert.strictEqual(readTasks(root).find((t) => t.id === id).type, type);
    }
    for (const priority of ['Blocker', 'Critical', 'Major', 'Medium', 'Minor']) {
      const id = add(root, ['--title', `Prioritized ${priority}`, '--priority', priority]);
      assert.strictEqual(readTasks(root).find((t) => t.id === id).priority, priority);
    }
    assert.strictEqual(runCli(root, ['validate']).status, 0);
  });

  it('accepts --type external and the result passes validate (T-0092)', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Get the API keys from the client', '--type', 'external']);
    const [t] = readTasks(root);
    assert.strictEqual(t.type, 'external');
    assert.strictEqual(runCli(root, ['validate']).status, 0);
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

  it('a --desc starting with "- status: done" makes a normal backlog task, not a field (T-0080)', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Field lookalike', '--desc', '- status: done\n- type: bug']);
    const [t] = readTasks(root);
    assert.strictEqual(t.status, 'backlog');
    assert.strictEqual(t.type, 'feature');
    assert.strictEqual(t.description, '- status: done\n- type: bug');
    assert.strictEqual(runCli(root, ['validate']).status, 0);
  });

  // T-0198. A worker filed T-0193 with `--desc -` and nothing on standard
  // input: the task was created with a dash for a description, and the finding
  // it existed to carry had to be restored by hand from that worker's report.
  // Silent, and what is lost is the whole reason the card exists.
  it('takes the description from stdin with --desc -, and refuses an empty one instead of filing a dash', () => {
    const root = makeTmpRoot();
    const desc = 'Found while working on T-0007.\n\n- one line\n- "quoted", $var, 100% verbatim';
    add(root, ['--title', 'Piped in', '--desc', '-'], desc + '\n');
    assert.strictEqual(readTasks(root)[0].description, desc);

    for (const input of ['', '   \n']) {
      const res = runCli(root, ['add', '--title', 'Nothing piped', '--desc', '-'], input);
      assert.notStrictEqual(res.status, 0, `empty stdin was accepted: ${res.stdout}`);
      assert.match(res.stderr, /--desc - got nothing on standard input/);
    }
    assert.strictEqual(readTasks(root).length, 1, 'and no task was filed for either attempt');
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

  // T-0141. The path a person actually walks: a card is pulled into Open, the
  // answer turns out to be "not now", it goes back down, and later comes up
  // again — none of which may cost anything already written.
  it('open -> backlog puts a card back, and the trip loses neither brief nor description', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Pulled in by mistake', '--desc', 'What was decided so far.']);
    addBrief(root, id, 'the-brief');
    assert.strictEqual(runCli(root, ['status', id, 'open']).status, 0);

    const back = runCli(root, ['status', id, 'backlog']);
    assert.strictEqual(back.status, 0, back.stderr);
    assert.match(back.stdout, new RegExp(`${id} -> backlog`));

    let [t] = readTasks(root);
    assert.strictEqual(t.status, 'backlog');
    assert.strictEqual(t.closed, '', 'backlog is not a closing status');
    assert.deepStrictEqual(t.briefs, [`${id}-01`]);
    assert.strictEqual(t.description, 'What was decided so far.');

    // ...and it is a card in the backlog again, not a special one: the ordinary
    // way out still works.
    assert.strictEqual(runCli(root, ['status', id, 'open']).status, 0);
    [t] = readTasks(root);
    assert.strictEqual(t.status, 'open');
  });

  it('there is no way back out of ready — that step was deliberately left alone', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Already briefed']);
    addBrief(root, id, 'brief');
    for (const s of ['open', 'ready']) assert.strictEqual(runCli(root, ['status', id, s]).status, 0);
    const before = fs.readFileSync(backlogPath(root), 'utf8');

    for (const target of ['backlog', 'open']) {
      const res = runCli(root, ['status', id, target]);
      assert.notStrictEqual(res.status, 0, `ready -> ${target} must stay illegal`);
      assert.match(res.stderr, new RegExp(`ready -> ${target}`));
    }
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
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

// T-0302. Priority used to be settable only on `add` — the moment the least is
// known about a task — so re-triaging one meant hand-editing the task header,
// the line parseBacklog is strictest about.
describe('task.mjs priority (T-0302)', () => {
  const STAMP = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`;

  /** The task as the CLI itself reads it back — i.e. through parseBacklog, not through a grep. */
  function showTask(root, id) {
    const res = runCli(root, ['show', id, '--full']);
    assert.strictEqual(res.status, 0, `show failed: ${res.stderr}`);
    return JSON.parse(res.stdout);
  }

  it('changes the priority, and the new value survives the round-trip through the file', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Filed in a hurry', '--priority', 'Minor']);

    const res = runCli(root, ['priority', id, 'Critical']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`${id} priority: Minor -> Critical`));
    assert.strictEqual(showTask(root, id).priority, 'Critical');
  });

  it('accepts every one of the five, in both directions', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Up and down', '--priority', 'Medium']);
    for (const p of ['Blocker', 'Critical', 'Major', 'Medium', 'Minor']) {
      const res = runCli(root, ['priority', id, p]);
      assert.strictEqual(res.status, 0, `${p} refused: ${res.stderr}`);
      assert.strictEqual(showTask(root, id).priority, p);
    }
  });

  // The trace is the half of this task that was actually argued about: a card
  // that silently becomes Critical reads, a week later, as though it always was.
  it('records the change in the description, naming both values and the date', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Re-triaged', '--priority', 'Minor', '--desc', 'What the card says.']);

    assert.strictEqual(runCli(root, ['priority', id, 'Major']).status, 0);

    const { description } = showTask(root, id);
    assert.match(description, /^### Priority changes$/m);
    assert.match(description, new RegExp(String.raw`^Minor -> Major \(${STAMP}\)$`, 'm'));
    // The fixture must not be able to prove this on its own: the text the task
    // was filed with is still there, so what the assertion above found was
    // appended rather than written over the description (T-0098).
    assert.match(description, /^What the card says\.$/m);
  });

  it('appends a second change under the same heading instead of replacing the first', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Twice re-triaged', '--priority', 'Minor']);

    assert.strictEqual(runCli(root, ['priority', id, 'Major']).status, 0);
    assert.strictEqual(runCli(root, ['priority', id, 'Blocker']).status, 0);

    const { description } = showTask(root, id);
    const headings = description.split('\n').filter((l) => l.trim() === '### Priority changes');
    assert.strictEqual(headings.length, 1, 'one section, as `note` keeps one Worker report');
    assert.match(description, new RegExp(String.raw`^Minor -> Major \(${STAMP}\)$`, 'm'));
    assert.match(description, new RegExp(String.raw`^Major -> Blocker \(${STAMP}\)$`, 'm'));
  });

  // Setting what is already set changed nothing, so it records nothing: a line
  // reading `Major -> Major` is noise in the one place that has to stay readable.
  it('setting the value it already has is not an error and writes nothing at all', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Already there', '--priority', 'Major']);
    const before = fs.readFileSync(backlogPath(root), 'utf8');

    const res = runCli(root, ['priority', id, 'Major']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`${id} priority: Major \\(unchanged\\)`));
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, 'the file is untouched');
    assert.doesNotMatch(showTask(root, id).description, /Priority changes/);
  });

  it('refuses a value outside the five, names them, and leaves the file byte-identical', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Untouched', '--priority', 'Minor']);
    const before = fs.readFileSync(backlogPath(root), 'utf8');

    const res = runCli(root, ['priority', id, 'Extreme']);

    assert.strictEqual(res.status, 1, `accepted: ${res.stdout}`);
    assert.match(res.stderr, /ERROR: priority must be one of: Blocker, Critical, Major, Medium, Minor/);
    assert.match(res.stderr, /usage: node tools\/task\.mjs priority T-0007 </);
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
  });

  // A bare `priority` and a `priority T-0001` are two different mistakes, and
  // used to be one message about a value the reader never reached (T-0273).
  it('a missing value and a missing task are answered separately', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Untouched']);

    const noArgs = runCli(root, ['priority']);
    const noValue = runCli(root, ['priority', id]);

    assert.strictEqual(noArgs.status, 1, noArgs.stdout);
    assert.strictEqual(noValue.status, 1, noValue.stdout);
    assert.match(noArgs.stderr, /ERROR: priority needs the task/);
    assert.match(noValue.stderr, /ERROR: priority must be one of/);
    assert.notStrictEqual(noArgs.stderr, noValue.stderr);
  });

  // There is no transition graph here, so there is nothing to force — and a
  // flag that silently does nothing is worse than one that is refused (T-0220).
  it('takes no flags: --force is refused rather than quietly ignored', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'No forcing', '--priority', 'Minor']);
    const before = fs.readFileSync(backlogPath(root), 'utf8');

    const res = runCli(root, ['priority', id, 'Blocker', '--force']);

    assert.strictEqual(res.status, 1, `accepted: ${res.stdout}`);
    assert.match(res.stderr, /priority has no flag --force/);
    assert.match(res.stderr, /priority takes no flags/);
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
  });

  it('refuses a task id that does not exist, the way status refuses one', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Only task']); // T-0001, so T-0099 does not exist
    const res = runCli(root, ['priority', 'T-0099', 'Major']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /ERROR: task T-0099 not found/);
  });

  it('is listed in the CLI header usage block, where the others are documented', () => {
    const header = fs.readFileSync(CLI_PATH, 'utf8').split('*/')[0];
    assert.match(header, /node tools\/task\.mjs priority T-0007 </);
  });
});

describe('task.mjs depends (T-0087)', () => {
  // Two plain tasks plus the one under test, so there is something to point at.
  function threeTasks(root) {
    return [add(root, ['--title', 'First']), add(root, ['--title', 'Second']), add(root, ['--title', 'Third'])];
  }

  it('sets the prerequisite list and writes it to the file', () => {
    const root = makeTmpRoot();
    const [a, b, c] = threeTasks(root);
    const res = runCli(root, ['depends', c, `${a},${b}`]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`${c} depends: ${a}, ${b}`));
    assert.deepStrictEqual(readTasks(root)[2].depends, [a, b]);
    assert.match(fs.readFileSync(backlogPath(root), 'utf8'), new RegExp(`- depends: ${a}, ${b}`));
  });

  it('replaces the whole list rather than appending to it', () => {
    const root = makeTmpRoot();
    const [a, b, c] = threeTasks(root);
    runCli(root, ['depends', c, `${a},${b}`]);
    assert.strictEqual(runCli(root, ['depends', c, b]).status, 0);
    assert.deepStrictEqual(readTasks(root)[2].depends, [b]);
  });

  it('tolerates spaces and duplicates in the list', () => {
    const root = makeTmpRoot();
    const [a, b, c] = threeTasks(root);
    assert.strictEqual(runCli(root, ['depends', c, ` ${a} , ${b},${a} `]).status, 0);
    assert.deepStrictEqual(readTasks(root)[2].depends, [a, b]);
  });

  it('--clear empties the list and removes the field from the file', () => {
    const root = makeTmpRoot();
    const [a, , c] = threeTasks(root);
    runCli(root, ['depends', c, a]);
    const res = runCli(root, ['depends', c, '--clear']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /\(none\)/);
    assert.deepStrictEqual(readTasks(root)[2].depends, []);
    assert.ok(!fs.readFileSync(backlogPath(root), 'utf8').includes('- depends:'));
  });

  it('refuses an unknown task id and writes nothing', () => {
    const root = makeTmpRoot();
    const [, , c] = threeTasks(root);
    const before = fs.readFileSync(backlogPath(root), 'utf8');
    const res = runCli(root, ['depends', c, 'T-9999']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR.*T-9999 not found/);
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
  });

  it('refuses a value that is not a task id at all', () => {
    const root = makeTmpRoot();
    const [, , c] = threeTasks(root);
    const res = runCli(root, ['depends', c, 'T-0001-01']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /not a task id/);
  });

  it('refuses a self-dependency', () => {
    const root = makeTmpRoot();
    const [, , c] = threeTasks(root);
    const res = runCli(root, ['depends', c, c]);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /cannot depend on itself/);
    assert.deepStrictEqual(readTasks(root)[2].depends, []);
  });

  it('refuses an edit that would close a cycle, naming the ring, and writes nothing', () => {
    const root = makeTmpRoot();
    const [a, b] = threeTasks(root);
    runCli(root, ['depends', b, a]); // b -> a
    const before = fs.readFileSync(backlogPath(root), 'utf8');
    const res = runCli(root, ['depends', a, b]); // a -> b would close the ring
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /dependency cycle/);
    assert.match(res.stderr, new RegExp(`${a}.*${b}.*${a}`));
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
  });

  it('refuses a longer cycle too (A -> B -> C -> A)', () => {
    const root = makeTmpRoot();
    const [a, b, c] = threeTasks(root);
    runCli(root, ['depends', b, a]);
    runCli(root, ['depends', c, b]);
    const res = runCli(root, ['depends', a, c]);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /dependency cycle/);
  });

  it('a project whose dependencies were set via the CLI still validates', () => {
    const root = makeTmpRoot();
    const [a, b, c] = threeTasks(root);
    runCli(root, ['depends', c, `${a},${b}`]);
    const res = runCli(root, ['validate']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /^OK\s*$/);
  });

  it('fails on a missing id or an empty list', () => {
    const root = makeTmpRoot();
    const [, , c] = threeTasks(root);
    assert.notStrictEqual(runCli(root, ['depends']).status, 0);
    assert.notStrictEqual(runCli(root, ['depends', c]).status, 0);
    assert.notStrictEqual(runCli(root, ['depends', 'T-9999', 'T-0001']).status, 0);
  });
});

describe('task.mjs status — dependency gate (T-0087)', () => {
  // Walks a task to `ready` (brief attached, open first) so the only thing left
  // in the way of in_progress is its dependency list.
  function readyTask(root, title) {
    const id = add(root, ['--title', title]);
    addBrief(root, id, 'brief');
    runCli(root, ['status', id, 'open']);
    runCli(root, ['status', id, 'ready']);
    return id;
  }

  it('refuses ready -> in_progress while a prerequisite is unfinished, listing it with its status', () => {
    const root = makeTmpRoot();
    const dep = add(root, ['--title', 'Prerequisite']);
    const id = readyTask(root, 'Dependent');
    runCli(root, ['depends', id, dep]);
    const before = fs.readFileSync(backlogPath(root), 'utf8');

    const res = runCli(root, ['status', id, 'in_progress']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR/);
    assert.match(res.stderr, new RegExp(`${dep} \\(backlog\\)`));
    assert.match(res.stderr, /--force/);
    assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'ready');
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before); // file untouched
  });

  it('lists every unfinished prerequisite, each with its own status', () => {
    const root = makeTmpRoot();
    const depA = add(root, ['--title', 'Prereq A']);
    const depB = add(root, ['--title', 'Prereq B']);
    runCli(root, ['status', depB, 'open']);
    const id = readyTask(root, 'Dependent');
    runCli(root, ['depends', id, `${depA},${depB}`]);

    const res = runCli(root, ['status', id, 'in_progress']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, new RegExp(`${depA} \\(backlog\\)`));
    assert.match(res.stderr, new RegExp(`${depB} \\(open\\)`));
  });

  it('lets the transition through once the prerequisite is done', () => {
    const root = makeTmpRoot();
    const dep = readyTask(root, 'Prerequisite');
    for (const s of ['in_progress', 'review', 'done']) runCli(root, ['status', dep, s]);
    const id = readyTask(root, 'Dependent');
    runCli(root, ['depends', id, dep]);

    const res = runCli(root, ['status', id, 'in_progress']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'in_progress');
  });

  it('a cancelled prerequisite does not block either', () => {
    const root = makeTmpRoot();
    const dep = add(root, ['--title', 'Prerequisite']);
    runCli(root, ['status', dep, 'cancelled']);
    const id = readyTask(root, 'Dependent');
    runCli(root, ['depends', id, dep]);

    const res = runCli(root, ['status', id, 'in_progress']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'in_progress');
  });

  it('--force performs the transition but shouts about the unfinished dependencies', () => {
    const root = makeTmpRoot();
    const dep = add(root, ['--title', 'Prerequisite']);
    const id = readyTask(root, 'Dependent');
    runCli(root, ['depends', id, dep]);

    const res = runCli(root, ['status', id, 'in_progress', '--force']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, new RegExp(`WARNING: forced start of ${id} with unfinished dependencies: ${dep} \\(backlog\\)`));
    assert.strictEqual(readTasks(root).find((t) => t.id === id).status, 'in_progress');
  });

  it('does not gate anything but ready -> in_progress: briefing and rework stay open', () => {
    const root = makeTmpRoot();
    const dep = add(root, ['--title', 'Prerequisite']);
    // ready itself is reachable with the prerequisite still open - understanding
    // the dependency is what refinement is for.
    const id = add(root, ['--title', 'Dependent']);
    addBrief(root, id, 'brief');
    runCli(root, ['depends', id, dep]);
    runCli(root, ['status', id, 'open']);
    assert.strictEqual(runCli(root, ['status', id, 'ready']).status, 0);

    // review -> in_progress is rework of a task already started, not a start.
    runCli(root, ['status', id, 'in_progress', '--force']);
    runCli(root, ['status', id, 'review']);
    const res = runCli(root, ['status', id, 'in_progress']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(!/unfinished dependencies/.test(res.stderr));
  });

  it('a task with no dependencies starts exactly as before', () => {
    const root = makeTmpRoot();
    const id = readyTask(root, 'Independent');
    assert.strictEqual(runCli(root, ['status', id, 'in_progress']).status, 0);
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

  // T-0264. The brief was written first and `brief` run afterwards to link it —
  // the backwards order, and the template replaced two finished briefs with no
  // word about it. `nn` comes from the TASK's own `briefs:` line, so a file the
  // task does not link is invisible to the numbering and lands under the very
  // next call.
  const HANDWRITTEN = '# T-0001-01 · Written by hand\n\nEverything that had to survive.\n';

  it('refuses to write over a file that already holds the computed brief id, and keeps its content', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Brief written by hand']);
    fs.mkdirSync(briefDir(root), { recursive: true });
    const existing = path.join(briefDir(root), `${id}-01-temp-leak.md`);
    fs.writeFileSync(existing, HANDWRITTEN);

    const res = runCli(root, ['brief', id, 'temp-leak']);

    assert.notStrictEqual(res.status, 0, 'the call must be refused, not answered with a path');
    assert.match(res.stderr, new RegExp(`${id}-01`));
    assert.match(res.stderr, /temp-leak\.md/);
    assert.strictEqual(fs.readFileSync(existing, 'utf8'), HANDWRITTEN);
    // A refused call writes nothing at all: linking the brief would leave the
    // task claiming a file the command declined to produce.
    const [t] = readTasks(root);
    assert.deepStrictEqual(t.briefs, []);
  });

  it('refuses on the brief id rather than the file name: another slug is still brief 01', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Same id, other slug']);
    fs.mkdirSync(briefDir(root), { recursive: true });
    const existing = path.join(briefDir(root), `${id}-01-temp-leak.md`);
    fs.writeFileSync(existing, HANDWRITTEN);

    const res = runCli(root, ['brief', id, 'something-else']);

    assert.notStrictEqual(res.status, 0);
    assert.strictEqual(fs.readFileSync(existing, 'utf8'), HANDWRITTEN);
    // findBriefFile() resolves an id by prefix, so a second T-NNNN-01-*.md file
    // is a second answer to the same id and the board shows whichever readdir
    // returns first. Nothing may create that state.
    assert.deepStrictEqual(fs.readdirSync(briefDir(root)), [`${id}-01-temp-leak.md`]);
    const [t] = readTasks(root);
    assert.deepStrictEqual(t.briefs, []);
  });

  it('still creates the next brief when the existing one is linked to the task', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Two briefs, both linked']);
    addBrief(root, id, 'first');
    const first = path.join(briefDir(root), `${id}-01-first.md`);
    const before = fs.readFileSync(first, 'utf8');

    const second = addBrief(root, id, 'second');

    assert.strictEqual(second, path.join(briefDir(root), `${id}-02-second.md`));
    assert.strictEqual(fs.readFileSync(first, 'utf8'), before);
    const [t] = readTasks(root);
    assert.deepStrictEqual(t.briefs, [`${id}-01`, `${id}-02`]);
  });

  // The refusal also explains WHY the id was taken, and that sentence has to
  // describe the rule that produced it: `nn` is one past the highest NN the task
  // links, and stopped being briefs.length + 1 in T-0267. Set up so the two
  // rules disagree — the task links 02 and nothing else, so counting says 02 and
  // the command says 03 (T-0273).
  it('explains the numbering it actually uses, not the count that left with T-0267', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Linked out of order']);
    fs.mkdirSync(briefDir(root), { recursive: true });
    fs.writeFileSync(path.join(briefDir(root), `${id}-02-second.md`), HANDWRITTEN);
    assert.strictEqual(runCli(root, ['link', `${id}-02`]).status, 0, 'the task links 02 and nothing else');
    fs.writeFileSync(path.join(briefDir(root), `${id}-03-third.md`), HANDWRITTEN);

    const res = runCli(root, ['brief', id, 'third']);

    assert.strictEqual(res.status, 1, res.stdout);
    assert.match(res.stderr, new RegExp(`${id}-03 already has a file`));
    assert.match(res.stderr, /one past the highest/);
    assert.doesNotMatch(res.stderr, /counts/, 'the count is the algorithm the command no longer uses');
  });
});

// The other half of T-0264. Its refusal keeps the content safe, but the state it
// refuses in — file on disk, task does not link it — had no way out through the
// CLI: the message could only say "add the id to the `briefs:` line", i.e. edit
// doc/backlog.md by hand, which is the file this tool exists to keep hands off
// and the one a worker isolated in a worktree may not touch at all (T-0079).
describe('task.mjs link (T-0267)', () => {
  const HANDWRITTEN = '# T-0001-01 · Written by hand\n\nEverything that had to survive.\n';

  function handwritten(root, name, text = HANDWRITTEN) {
    fs.mkdirSync(briefDir(root), { recursive: true });
    const file = path.join(briefDir(root), name);
    fs.writeFileSync(file, text);
    return file;
  }

  // The whole way out of the accident, in the order it happens.
  it('takes a task from "the file exists and I cannot say so" to a linked brief and a valid backlog', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Brief written by hand first']);
    const file = handwritten(root, `${id}-01-temp-leak.md`);

    const refused = runCli(root, ['brief', id, 'temp-leak']);
    assert.strictEqual(refused.status, 1, 'brief must still refuse to write over it');
    assert.match(refused.stderr, new RegExp(`node tools/task\\.mjs link ${id}-01`), 'the refusal names the way out');

    const res = runCli(root, ['link', `${id}-01`]);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`${id}-01`));
    assert.deepStrictEqual(readTasks(root)[0].briefs, [`${id}-01`]);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), HANDWRITTEN, 'link never touches the file');
    const validated = runCli(root, ['validate']);
    assert.strictEqual(validated.status, 0, validated.stderr);
  });

  it('refuses a brief id no file answers to, writing nothing', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Nothing on disk']);

    const res = runCli(root, ['link', `${id}-01`]);

    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, new RegExp(`${id}-01`));
    assert.match(res.stderr, /doc[/\\]brief/, 'the message names where it looked');
    // A `briefs:` entry pointing at nothing is precisely what validate reports;
    // this command may not be a way to create one.
    assert.deepStrictEqual(readTasks(root)[0].briefs, []);
  });

  it('resolves the file the way the board does: "<id>.md" with no slug counts', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Slugless brief']);
    handwritten(root, `${id}-01.md`);

    assert.strictEqual(runCli(root, ['link', `${id}-01`]).status, 0);
    assert.deepStrictEqual(readTasks(root)[0].briefs, [`${id}-01`]);
  });

  it('a second link of the same id adds no duplicate and says it did nothing', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Linked twice']);
    handwritten(root, `${id}-01-once.md`);
    const first = runCli(root, ['link', `${id}-01`]);

    const second = runCli(root, ['link', `${id}-01`]);

    assert.strictEqual(second.status, 0, second.stderr);
    assert.notStrictEqual(second.stdout, first.stdout, 'a repeat must not print what the first run printed');
    assert.match(second.stdout, /already links/);
    assert.deepStrictEqual(readTasks(root)[0].briefs, [`${id}-01`]);
    assert.match(
      fs.readFileSync(backlogPath(root), 'utf8'),
      new RegExp(`- briefs: ${id}-01\\s*$`, 'm'),
      'the briefs: line itself carries the id once'
    );
  });

  it('names the argument it was not given when called bare', () => {
    const res = runCli(makeTmpRoot(), ['link']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /ERROR: link needs the brief id/);
    assert.match(res.stderr, /usage: node tools\/task\.mjs link/);
  });

  // `link T-0007 T-0007-01` is the shape to expect, because every other command
  // that touches a task takes the task id first.
  it('answers the task-id-in-front call with the one that was meant', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Two ids given']);
    const res = runCli(root, ['link', id, `${id}-01`]);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, new RegExp(`node tools/task\\.mjs link ${id}-01`));
  });

  it('refuses an id that is not a brief id, and names the shape it wanted', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Bad id']);
    for (const bad of [id, `${id}-1`, 'doc/brief/T-0001-01-slug.md']) {
      const res = runCli(root, ['link', bad]);
      assert.strictEqual(res.status, 1, `${bad} was accepted`);
      assert.match(res.stderr, /is not a brief id/);
      assert.match(res.stderr, /usage: node tools\/task\.mjs link/);
    }
    assert.deepStrictEqual(readTasks(root)[0].briefs, []);
  });

  it('refuses a brief whose task does not exist, without creating one', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'The only task there is']);
    handwritten(root, 'T-0099-01-ghost.md');

    const res = runCli(root, ['link', 'T-0099-01']);

    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /T-0099 not found/);
    assert.strictEqual(readTasks(root).length, 1);
  });

  it('refuses an id another task already claims, rather than letting two tasks answer for one file', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Owns the id by name']);
    const other = add(root, ['--title', 'Claims it in its briefs: line']);
    handwritten(root, `${id}-01-disputed.md`);
    // Only reachable by hand-editing the field, which PROTOCOL.md allows.
    fs.writeFileSync(
      backlogPath(root),
      fs
        .readFileSync(backlogPath(root), 'utf8')
        .replace(new RegExp(`(## ${other}[^]*?)- briefs:\\s*$`, 'm'), `$1- briefs: ${id}-01`)
    );
    assert.deepStrictEqual(readTasks(root)[1].briefs, [`${id}-01`], 'fixture: the other task claims it');

    const res = runCli(root, ['link', `${id}-01`]);

    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, new RegExp(`already linked by ${other}`));
    assert.deepStrictEqual(readTasks(root)[0].briefs, []);
  });

  // The trap the brief names: NN comes from the task, so linking a file whose
  // number is not the next one leaves a hole. Counting the list (briefs.length +
  // 1) then hands out a number BELOW the linked one and, one call later, the
  // linked one itself — which `brief` refuses, on a message telling the reader to
  // link a file that is already linked. That was a dead end with no CLI way out.
  it('numbers past a hole: brief never hands out a number the task already links', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Hole in the numbering']);
    handwritten(root, `${id}-03-third.md`);
    assert.strictEqual(runCli(root, ['link', `${id}-03`]).status, 0);

    const next = addBrief(root, id, 'after-the-hole');
    const afterThat = addBrief(root, id, 'and-another');

    assert.strictEqual(path.basename(next), `${id}-04-after-the-hole.md`);
    assert.strictEqual(path.basename(afterThat), `${id}-05-and-another.md`);
    assert.deepStrictEqual(readTasks(root)[0].briefs, [`${id}-03`, `${id}-04`, `${id}-05`]);
    // The hole itself stays a hole and harms nothing.
    assert.ok(!fs.existsSync(path.join(briefDir(root), `${id}-01.md`)));
    assert.strictEqual(runCli(root, ['validate']).status, 0);
  });

  // A worker's only route to the shared backlog (T-0079): the CLI runs from
  // somewhere else entirely and is pointed at the project by AGENTBOARD_ROOT.
  // Every test here already spawns it that way; this one moves the working
  // directory too, so the brief file can only be found under that root.
  it('links into a backlog in another checkout, from a working directory that is not it', () => {
    const root = makeTmpRoot();
    const elsewhere = makeTmpRoot();
    const id = add(root, ['--title', 'Reached through AGENTBOARD_ROOT']);
    handwritten(root, `${id}-01-remote.md`);

    const res = spawnSync(process.execPath, [CLI_PATH, 'link', `${id}-01`], {
      cwd: elsewhere,
      env: { ...process.env, AGENTBOARD_ROOT: root },
      encoding: 'utf8',
    });

    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(readTasks(root)[0].briefs, [`${id}-01`]);
    assert.ok(!fs.existsSync(path.join(elsewhere, 'doc', 'brief')), 'nothing was written next to the cwd');
  });

  it('refuses an archived task by name, as every other writing command does', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Closed and moved out']);
    assert.strictEqual(runCli(root, ['status', id, 'cancelled']).status, 0);
    handwritten(root, `${id}-01-late.md`);
    assert.strictEqual(runCli(root, ['archive']).status, 0);

    const res = runCli(root, ['link', `${id}-01`]);

    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /is archived/);
  });
});

describe('task.mjs note (T-0098)', () => {
  const DESC = 'Original description.\n\n### Refinement\nThe decision that must survive.';

  function taskWithDescription(root) {
    return add(root, ['--title', 'Has a description', '--desc', DESC]);
  }

  it('appends "### <section>" plus the text at the end, leaving the existing description intact', () => {
    const root = makeTmpRoot();
    const id = taskWithDescription(root);
    const res = runCli(root, ['note', id, '--section', 'Worker report', '--text', 'branch: task/T-0007']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /### Worker report/);

    const [t] = readTasks(root);
    assert.strictEqual(t.description, `${DESC}\n\n### Worker report\nbranch: task/T-0007`);
    assert.ok(t.description.startsWith(DESC), 'nothing before the appended tail changed');
  });

  it('appends into the existing section on a repeat call instead of creating a second one', () => {
    const root = makeTmpRoot();
    const id = taskWithDescription(root);
    runCli(root, ['note', id, '--section', 'Worker report', '--text', 'first pass']);
    runCli(root, ['note', id, '--section', 'Review', '--text', 'one comment']);
    assert.strictEqual(runCli(root, ['note', id, '--section', 'Worker report', '--text', 'after rework']).status, 0);

    const [t] = readTasks(root);
    assert.strictEqual(t.description.match(/^### Worker report$/gm).length, 1, 'exactly one report section');
    assert.strictEqual(
      t.description,
      `${DESC}\n\n### Worker report\nfirst pass\n\nafter rework\n\n### Review\none comment`
    );
  });

  it('reads the text from stdin with --text - and keeps a multi-line report verbatim', () => {
    const root = makeTmpRoot();
    const id = taskWithDescription(root);
    const report = 'Branch: `task/T-0098-report-command`\n\n- what: added the command\n- verify: npm test\n\n"quotes", $vars, 100% fine';
    const res = runCli(root, ['note', id, '--section', 'Worker report', '--text', '-'], report + '\n');
    assert.strictEqual(res.status, 0, res.stderr);

    const [t] = readTasks(root);
    assert.strictEqual(t.description, `${DESC}\n\n### Worker report\n${report}`);
  });

  it('keeps text that looks like backlog structure as text, and the file still validates', () => {
    const root = makeTmpRoot();
    const id = taskWithDescription(root);
    const hostile = '## T-9999 · Major · phantom\n- status: done\n- type: bug';
    assert.strictEqual(runCli(root, ['note', id, '--section', 'Worker report', '--text', '-'], hostile).status, 0);

    const tasks = readTasks(root);
    assert.strictEqual(tasks.length, 1, 'no phantom task appeared');
    assert.strictEqual(tasks[0].status, 'backlog', 'the fake field did not rewrite the status');
    assert.strictEqual(tasks[0].description, `${DESC}\n\n### Worker report\n${hostile}`);
    assert.strictEqual(runCli(root, ['validate']).status, 0);
  });

  // The same refusal as `add --desc -` (T-0198): an explicit "-" with nothing
  // piped in is a caller who lost the text, and the report says which flag it
  // was rather than only that something was empty.
  it('refuses --text - on an empty standard input, naming the flag', () => {
    const root = makeTmpRoot();
    const id = taskWithDescription(root);
    const before = fs.readFileSync(backlogPath(root), 'utf8');

    for (const input of ['', '\n \n']) {
      const res = runCli(root, ['note', id, '--section', 'Worker report', '--text', '-'], input);
      assert.notStrictEqual(res.status, 0, `empty stdin was accepted: ${res.stdout}`);
      assert.match(res.stderr, /--text - got nothing on standard input/);
    }
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
  });

  it('refuses an unknown task id and leaves the file untouched', () => {
    const root = makeTmpRoot();
    taskWithDescription(root);
    const before = fs.readFileSync(backlogPath(root), 'utf8');
    const res = runCli(root, ['note', 'T-9999', '--section', 'Worker report', '--text', 'nope']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERROR.*T-9999 not found/);
    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
  });

  it('refuses a missing --section, an empty text and a section with a line break', () => {
    const root = makeTmpRoot();
    const id = taskWithDescription(root);
    const before = fs.readFileSync(backlogPath(root), 'utf8');

    const noSection = runCli(root, ['note', id, '--text', 'orphan text']);
    assert.notStrictEqual(noSection.status, 0);
    assert.match(noSection.stderr, /--section is required/);

    const noText = runCli(root, ['note', id, '--section', 'Worker report', '--text', '   ']);
    assert.notStrictEqual(noText.status, 0);
    assert.match(noText.stderr, /empty/);

    const brokenSection = runCli(root, ['note', id, '--section', 'Worker\nreport', '--text', 'x']);
    assert.notStrictEqual(brokenSection.status, 0);
    assert.match(brokenSection.stderr, /line breaks/);

    assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
  });

  it('adds the section to a task whose description is still empty', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'No description yet']);
    assert.strictEqual(runCli(root, ['note', id, '--section', 'Worker report', '--text', 'done']).status, 0);
    assert.strictEqual(readTasks(root)[0].description, '### Worker report\ndone');
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


// A backlog written by hand rather than by `add`, so the bytes `list` prints are
// pinned to fixed ids, priorities, statuses and titles instead of to whatever
// today's stamps and defaults produce (T-0303).
const FIXTURE_BACKLOG = [
  '# Backlog',
  '',
  '## T-0011 · Major · Labelled task',
  '- type: feature',
  '- status: backlog',
  '- created: 2026-01-01 00:00:00',
  '- closed: —',
  '- briefs:',
  '- labels: a, b',
  '',
  'Text.',
  '',
  '## T-0012 · Critical · In flight',
  '- type: bug',
  '- status: in_progress',
  '- created: 2026-01-01 00:00:00',
  '- closed: —',
  '- briefs: T-0012-01',
  '- depends: T-0011',
  '',
  'Text.',
  '',
  '## T-0013 · Minor · Finished',
  '- type: feature',
  '- status: done',
  '- created: 2026-01-01 00:00:00',
  '- closed: 2026-01-02 00:00:00',
  '- briefs:',
  '',
  'Text.',
  '',
].join('\n');

// T-0303. `--label` is the first repeatable flag in this CLI, and the rule it
// carries is the one a reader has to hold: each occurrence is a comma-separated
// SET the task must carry ANY name of, and EVERY occurrence must match. The
// board's own Labels filter is OR (T-0279) — deliberately, and the guide names
// both side by side.
describe('task.mjs list --label (T-0303)', () => {
  // Five tasks whose label sets differ in every way the rule can tell apart,
  // plus one carrying none at all — the task no --label may ever select.
  function labelled() {
    const root = makeTmpRoot();
    add(root, ['--title', 'Only a', '--labels', 'a']); // T-0001
    add(root, ['--title', 'Only b', '--labels', 'b']); // T-0002
    add(root, ['--title', 'Both a and b', '--labels', 'a,b']); // T-0003
    add(root, ['--title', 'Both a and c', '--labels', 'a,c']); // T-0004
    add(root, ['--title', 'No labels at all']); // T-0005
    return root;
  }

  /** The ids `list` printed, in the order it printed them. */
  function listed(res) {
    assert.strictEqual(res.status, 0, `list failed: ${res.stderr}`);
    const text = res.stdout.trim();
    return text === '' ? [] : text.split(/\r?\n/).map((line) => line.slice(0, 6));
  }

  it('all five are there without the flag, so what follows is a filter and not an empty backlog', () => {
    const root = labelled();
    assert.deepStrictEqual(listed(runCli(root, ['list'])), [
      'T-0001',
      'T-0002',
      'T-0003',
      'T-0004',
      'T-0005',
    ]);
  });

  it('--label a selects every task carrying a, and never the task carrying none', () => {
    const root = labelled();
    assert.deepStrictEqual(listed(runCli(root, ['list', '--label', 'a'])), [
      'T-0001',
      'T-0003',
      'T-0004',
    ]);
  });

  it('--label a --label b selects only the task carrying BOTH', () => {
    const root = labelled();
    assert.deepStrictEqual(listed(runCli(root, ['list', '--label', 'a', '--label', 'b'])), ['T-0003']);
  });

  it('--label a,b selects every task carrying EITHER', () => {
    const root = labelled();
    assert.deepStrictEqual(listed(runCli(root, ['list', '--label', 'a,b'])), [
      'T-0001',
      'T-0002',
      'T-0003',
      'T-0004',
    ]);
  });

  it('--label a,b --label c is (a OR b) AND c', () => {
    const root = labelled();
    assert.deepStrictEqual(listed(runCli(root, ['list', '--label', 'a,b', '--label', 'c'])), ['T-0004']);
  });

  // The set is read by normalizeLabels, the same function the field, the
  // `labels` subcommand and the endpoint use. A splitter of its own here would
  // pass ' a ' to the comparison and match nothing.
  it('reads the set the way the field does: spaces around a name, and a repeat, change nothing', () => {
    const root = labelled();
    assert.deepStrictEqual(listed(runCli(root, ['list', '--label', ' a , a '])), [
      'T-0001',
      'T-0003',
      'T-0004',
    ]);
  });

  // Compared as written (T-0279): folding case here would make the CLI answer a
  // question the board answers differently.
  it('compares as written, so --label A selects nothing where the tasks carry a', () => {
    const root = labelled();
    assert.deepStrictEqual(listed(runCli(root, ['list', '--label', 'A'])), []);
  });

  it('a task with no labels is never selected, whatever is asked for', () => {
    const root = labelled();
    for (const args of [['--label', 'a'], ['--label', 'a,b'], ['--label', 'a', '--label', 'b']]) {
      assert.ok(
        !listed(runCli(root, ['list', ...args])).includes('T-0005'),
        `T-0005 carries no labels and was selected by ${args.join(' ')}`
      );
    }
  });

  // An empty answer is an answer: a script that greps for ids must not have to
  // tell "no such label" from "the call was wrong" by reading stderr.
  it('a label nothing carries prints nothing and exits 0', () => {
    const root = labelled();
    const res = runCli(root, ['list', '--label', 'nobody-carries-this']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stdout.trim(), '');
  });

  it('combines with --status as AND', () => {
    const root = labelled();
    assert.strictEqual(runCli(root, ['status', 'T-0003', 'open']).status, 0);
    assert.deepStrictEqual(listed(runCli(root, ['list', '--label', 'a', '--status', 'open'])), ['T-0003']);
    assert.deepStrictEqual(listed(runCli(root, ['list', '--label', 'a', '--status', 'backlog'])), [
      'T-0001',
      'T-0004',
    ]);
  });

  it('combines with --all: an archived task is out without it and in with it', () => {
    const root = labelled();
    assert.strictEqual(runCli(root, ['status', 'T-0004', 'cancelled']).status, 0);
    assert.strictEqual(runCli(root, ['archive']).status, 0);
    assert.deepStrictEqual(listed(runCli(root, ['list', '--label', 'c'])), []);
    assert.deepStrictEqual(listed(runCli(root, ['list', '--all', '--label', 'c'])), ['T-0004']);
  });

  // The other half of "an empty result is fine": a --label carrying no name is a
  // malformed call, and the exit code has to say so (T-0220, T-0273).
  for (const [name, value] of [['an empty value', ''], ['a lone comma', ',']]) {
    it(`refuses ${name} with the usage line, and writes nothing`, () => {
      const root = labelled();
      const before = fs.readFileSync(backlogPath(root), 'utf8');
      const res = runCli(root, ['list', '--label', value]);
      assert.strictEqual(res.status, 1, `accepted --label ${JSON.stringify(value)}: ${res.stdout}`);
      assert.match(res.stderr, /ERROR: --label needs at least one label name/);
      assert.match(res.stderr, /usage: node tools\/task\.mjs list .*--label/);
      assert.strictEqual(res.stdout, '', 'a refused query printed a result anyway');
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, 'the backlog was written');
    });
  }

  it('refuses --label with nothing after it rather than reading it as "no filter"', () => {
    const root = labelled();
    const res = runCli(root, ['list', '--label']);
    assert.strictEqual(res.status, 1, `accepted a valueless --label: ${res.stdout}`);
    assert.match(res.stderr, /ERROR: --label needs at least one label name/);
  });

  // The backward-compatibility criterion, against a fixture rather than by eye:
  // these are the exact bytes `list` printed before --label and --json existed,
  // padding included (verified against main's tools/task.mjs at ffb1c5a).
  it('list with no new flag prints exactly what it printed before them', () => {
    const root = makeTmpRoot();
    fs.mkdirSync(path.join(root, 'doc'), { recursive: true });
    fs.writeFileSync(backlogPath(root), FIXTURE_BACKLOG);
    const res = runCli(root, ['list']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(
      res.stdout,
      'T-0011  Major  backlog      Labelled task\n' +
        'T-0012  Critical  in_progress  In flight\n' +
        'T-0013  Minor  done         Finished\n'
    );
    assert.strictEqual(res.stderr, '', 'nothing new may appear on stderr either');
  });

  // Requirement 6 of the refinement decisions, asserted on the bytes and not on
  // the parse: a rewrite that reorders fields or restamps a date parses the same
  // and is still a write.
  it('no query writes: the backlog is byte-identical after all of them', () => {
    const root = labelled();
    const before = fs.readFileSync(backlogPath(root), 'utf8');
    for (const args of [
      ['list'],
      ['list', '--label', 'a'],
      ['list', '--label', 'a', '--label', 'b'],
      ['list', '--label', 'a,b', '--status', 'backlog'],
      ['list', '--json'],
      ['list', '--json', '--all', '--label', 'a'],
      ['list', '--label', 'nobody-carries-this'],
    ]) {
      assert.strictEqual(runCli(root, args).status, 0, args.join(' '));
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, `${args.join(' ')} wrote`);
    }
  });
});

// T-0309. `--label` reads each occurrence with normalizeLabels, which also
// enforces MAX_LABELS — a rule about what a TASK may carry. A QUERY asking "any
// of these nine" is meaningful, and truncating it to eight returns FEWER tasks
// with exit 0 and nothing said, which is the one shape of wrong answer a machine
// consumer cannot detect. The invariant these tests hold: no alternative that
// could have matched a task may be dropped without saying so.
//
// The array is the point of the last two cases: the check lives in one helper
// (labelSetsOf), so `runnable` and `summary` inherit it rather than each
// carrying a copy (T-0304).
const LABEL_QUERY_COMMANDS = ['list', 'runnable', 'summary'];

describe('task.mjs --label refuses a set it would have to truncate (T-0309)', () => {
  const NINE_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const EIGHT = NINE_NAMES.slice(0, MAX_LABELS).join(',');
  const NINE = NINE_NAMES.join(',');
  const TOO_LONG = 'x'.repeat(MAX_LABEL_LEN + 1);

  // Nine tasks, each carrying exactly one of nine distinct names, so a set of
  // eight and a set of nine select measurably different tasks. Nine names cannot
  // be put on ONE task — MAX_LABELS is exactly the cap under test.
  function nineLabels() {
    const root = makeTmpRoot();
    for (const name of NINE_NAMES) add(root, ['--title', `Carries ${name}`, '--labels', name]);
    return root;
  }

  function listed(res) {
    assert.strictEqual(res.status, 0, `list failed: ${res.stderr}`);
    const text = res.stdout.trim();
    return text === '' ? [] : text.split(/\r?\n/).map((line) => line.slice(0, 6));
  }

  for (const cmd of LABEL_QUERY_COMMANDS) {
    it(`${cmd}: a set of ${MAX_LABELS + 1} usable names is refused, naming the cap and the count`, () => {
      const root = nineLabels();
      const before = fs.readFileSync(backlogPath(root), 'utf8');
      const res = runCli(root, [cmd, '--label', NINE]);
      assert.strictEqual(res.status, 1, `answered a truncated set instead of refusing: ${res.stdout}`);
      assert.match(res.stderr, new RegExp(`--label takes at most ${MAX_LABELS} names in one set, got 9`));
      assert.match(res.stderr, new RegExp(`usage: node tools/task\\.mjs ${cmd}`));
      assert.strictEqual(res.stdout, '', 'a refused query printed a result anyway');
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, 'the backlog was written');
    });

    it(`${cmd}: exactly ${MAX_LABELS} names is not the refusal, so the boundary is the cap itself`, () => {
      const root = nineLabels();
      const res = runCli(root, [cmd, '--label', EIGHT]);
      assert.strictEqual(res.status, 0, `refused a set of exactly the cap: ${res.stderr}`);
      assert.doesNotMatch(res.stderr, /takes at most/);
    });
  }

  it(`a set of exactly ${MAX_LABELS} filters normally: the eight carriers, never the ninth`, () => {
    const root = nineLabels();
    assert.deepStrictEqual(
      listed(runCli(root, ['list', '--label', EIGHT])),
      ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005', 'T-0006', 'T-0007', 'T-0008']
    );
  });

  // The refusal counts alternatives, not names typed: `ui,ui,ui` was always one
  // alternative, and duplicates collapsing is not a dropped alternative.
  it('a name repeated past the cap is one alternative and is answered, not refused', () => {
    const root = nineLabels();
    const repeated = new Array(MAX_LABELS + 4).fill('a').join(',');
    const res = runCli(root, ['list', '--label', repeated]);
    assert.strictEqual(res.status, 0, `refused ${repeated}: ${res.stderr}`);
    assert.deepStrictEqual(listed(res), ['T-0001']);
  });

  // The other half of the decision: a name longer than MAX_LABEL_LEN cannot be
  // on any task, so dropping it from a set changes no result and must stay
  // silent. Eight usable names plus one over-long one is NINE names typed and
  // eight alternatives that could match — accepted, and answering exactly as the
  // eight alone do.
  it('an over-long name mixed with a full set is dropped silently, not counted toward the cap', () => {
    const root = nineLabels();
    const withLong = runCli(root, ['list', '--label', `${EIGHT},${TOO_LONG}`]);
    assert.strictEqual(withLong.status, 0, `refused a set of eight plus an unmatchable name: ${withLong.stderr}`);
    assert.deepStrictEqual(listed(withLong), listed(runCli(root, ['list', '--label', EIGHT])));
    // Order must not decide it either: normalizeLabels stops at the cap, so the
    // over-long name in front and behind are different paths through it.
    const longFirst = runCli(root, ['list', '--label', `${TOO_LONG},${EIGHT}`]);
    assert.strictEqual(longFirst.status, 0, `refused it when the over-long name came first: ${longFirst.stderr}`);
    assert.deepStrictEqual(listed(longFirst), listed(withLong));
  });

  it('nine usable names plus an over-long one is still the cap refusal', () => {
    const root = nineLabels();
    const res = runCli(root, ['list', '--label', `${NINE},${TOO_LONG}`]);
    assert.strictEqual(res.status, 1, `answered ten names as nine: ${res.stdout}`);
    assert.match(res.stderr, new RegExp(`got 9`));
  });

  // T-0303's empty-set refusal is the one that fires here, unchanged: the new
  // check must not take over a case that already had an answer.
  it('an over-long name ALONE still produces the empty-set refusal, not the cap one', () => {
    const root = nineLabels();
    const res = runCli(root, ['list', '--label', TOO_LONG]);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /ERROR: --label needs at least one label name/);
    assert.doesNotMatch(res.stderr, /takes at most/);
  });

  // Blanks from a doubled or trailing comma are not alternatives either.
  it('trailing and doubled commas do not push a set over the cap', () => {
    const root = nineLabels();
    const res = runCli(root, ['list', '--label', `${EIGHT},,`]);
    assert.strictEqual(res.status, 0, `counted blanks as alternatives: ${res.stderr}`);
    assert.deepStrictEqual(listed(res), listed(runCli(root, ['list', '--label', EIGHT])));
  });

  // Each occurrence is its own set: the cap is per occurrence, and repeating the
  // flag is AND, so two full sets are a legal (and empty) query.
  it('the cap is per occurrence, so two sets of the cap are accepted', () => {
    const root = nineLabels();
    const res = runCli(root, ['list', '--label', EIGHT, '--label', EIGHT]);
    assert.strictEqual(res.status, 0, `refused two separate sets of the cap: ${res.stderr}`);
    assert.strictEqual(listed(res).length, 8);
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

// T-0304. `runnable` and `summary` are queries an external supervisor acts on,
// so what they must not do is as important as what they do: never write, never
// answer differently on two identical runs, and never carry a second definition
// of "may this task be started" — that one lives in blockingDependencies() and
// serves the board, the drag of T-0084 and the CLI's own ready -> in_progress
// guard already.
//
// The fixture covers every branch of that function in one backlog, so a change
// to it lands in these tests rather than in a supervisor's report.
function scopedBacklog() {
  const root = makeTmpRoot();
  const titles = [
    'Ready with no prerequisite', // T-0001 runnable
    'An open prerequisite', // T-0002 open, blocks T-0003
    'Ready behind an open one', // T-0003 blocked
    'Ready behind a cancelled one', // T-0004 runnable: cancelled is closed
    'Cancelled prerequisite', // T-0005 cancelled
    'Ready behind an id nobody carries', // T-0006 blocked
    'Already finished', // T-0007 done
    'In flight', // T-0008 in_progress
  ];
  for (const title of titles) add(root, ['--type', 'feature', '--priority', 'Major', '--title', title, '--labels', 'p']);
  for (const id of ['T-0001', 'T-0003', 'T-0004', 'T-0006', 'T-0007', 'T-0008']) {
    assert.strictEqual(runCli(root, ['status', id, 'open']).status, 0);
    addBrief(root, id, 'slug');
    assert.strictEqual(runCli(root, ['status', id, 'ready']).status, 0);
  }
  assert.strictEqual(runCli(root, ['status', 'T-0002', 'open']).status, 0);
  assert.strictEqual(runCli(root, ['status', 'T-0005', 'cancelled']).status, 0);
  assert.strictEqual(runCli(root, ['depends', 'T-0003', 'T-0002']).status, 0);
  assert.strictEqual(runCli(root, ['depends', 'T-0004', 'T-0005']).status, 0);
  assert.strictEqual(runCli(root, ['depends', 'T-0006', 'T-0007']).status, 0);
  for (const to of ['in_progress', 'review', 'done']) {
    assert.strictEqual(runCli(root, ['status', 'T-0007', to]).status, 0);
  }
  assert.strictEqual(runCli(root, ['status', 'T-0008', 'in_progress']).status, 0);
  // `depends` refuses an id no task carries, so T-0006's ghost prerequisite is
  // written by hand — which is the only way one gets into a backlog, and exactly
  // the case blockingDependencies() calls blocking because an unresolvable
  // prerequisite cannot be shown to be finished.
  const file = backlogPath(root);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('- depends: T-0007'), 'the fixture no longer has the line it rewrites');
  fs.writeFileSync(file, text.replace('- depends: T-0007', '- depends: T-0099'));
  return root;
}

describe('task.mjs runnable (T-0304)', () => {
  function ids(res) {
    assert.strictEqual(res.status, 0, `runnable failed: ${res.stderr}`);
    const text = res.stdout.trim();
    return text === '' ? [] : text.split(/\r?\n/).map((line) => line.slice(0, 6));
  }

  // The four cases of the acceptance criteria in one assertion, which is also
  // what makes it a test of blockingDependencies() and not of a list of ids: the
  // two that are IN are in for different reasons, and so are the two that are out.
  it('is the ready tasks with no unsatisfied prerequisite, and nothing else', () => {
    const root = scopedBacklog();
    assert.deepStrictEqual(ids(runCli(root, ['runnable'])), ['T-0001', 'T-0004']);
  });

  it('the backlog really does hold the tasks it leaves out, so the answer is a filter', () => {
    const root = scopedBacklog();
    const ready = JSON.parse(runCli(root, ['list', '--json', '--status', 'ready']).stdout);
    assert.deepStrictEqual(
      ready.tasks.map((t) => t.id),
      ['T-0001', 'T-0003', 'T-0004', 'T-0006'],
      'the fixture does not contain the blocked ready tasks the filter must remove'
    );
  });

  it('--json is list --json\'s own document, not a second task shape', () => {
    const root = scopedBacklog();
    const doc = JSON.parse(runCli(root, ['runnable', '--json']).stdout);
    assert.deepStrictEqual(Object.keys(doc).sort(), ['count', 'tasks']);
    assert.strictEqual(doc.count, 2);
    assert.deepStrictEqual(doc.tasks.map((t) => t.id), ['T-0001', 'T-0004']);
    const listed = JSON.parse(runCli(root, ['list', '--json', '--status', 'ready']).stdout);
    const same = listed.tasks.find((t) => t.id === 'T-0001');
    assert.deepStrictEqual(doc.tasks[0], same, 'runnable and list describe the same task differently');
  });

  // T-0004 is runnable only because a CANCELLED prerequisite counts as closed;
  // asserting blockedBy is empty is asserting that rule and not the status.
  it('a cancelled prerequisite is satisfied, and blockedBy says so', () => {
    const root = scopedBacklog();
    const doc = JSON.parse(runCli(root, ['runnable', '--json']).stdout);
    const t4 = doc.tasks.find((t) => t.id === 'T-0004');
    assert.deepStrictEqual(t4.depends, ['T-0005']);
    assert.deepStrictEqual(t4.blockedBy, []);
  });

  it('--status narrows and cannot widen: a non-ready status is an empty answer, not an error', () => {
    const root = scopedBacklog();
    const res = runCli(root, ['runnable', '--status', 'review']);
    assert.strictEqual(res.status, 0, `--status review was refused: ${res.stderr}`);
    assert.deepStrictEqual(ids(res), []);
    assert.deepStrictEqual(ids(runCli(root, ['runnable', '--status', 'ready'])), ['T-0001', 'T-0004']);
    // in_progress exists in this backlog (T-0008) and is still not runnable.
    assert.deepStrictEqual(ids(runCli(root, ['runnable', '--status', 'in_progress'])), []);
  });

  it('--label narrows the scope the same way it narrows list', () => {
    const root = scopedBacklog();
    assert.strictEqual(runCli(root, ['labels', 'T-0001', 'p,q']).status, 0);
    assert.deepStrictEqual(ids(runCli(root, ['runnable', '--label', 'q'])), ['T-0001']);
    assert.deepStrictEqual(ids(runCli(root, ['runnable', '--label', 'nobody-carries-this'])), []);
  });
});

describe('task.mjs summary (T-0304)', () => {
  function doc(root, args = []) {
    const res = runCli(root, ['summary', '--json', ...args]);
    assert.strictEqual(res.status, 0, `summary failed: ${res.stderr}`);
    return JSON.parse(res.stdout);
  }

  it('counts every status, and they sum to total — cancelled included', () => {
    const root = scopedBacklog();
    const d = doc(root);
    assert.strictEqual(d.total, 8);
    const sum = STATUSES.reduce((n, s) => n + d[s], 0);
    assert.strictEqual(sum, d.total, `the status counts sum to ${sum}, not to ${d.total}`);
    assert.strictEqual(d.cancelled, 1, 'the cancelled task fell out of the counts');
    assert.strictEqual(d.done, 1);
    assert.strictEqual(d.ready, 4);
    assert.strictEqual(d.in_progress, 1);
  });

  // Taken from STATUSES rather than from seven literals, so a status added to
  // the lifecycle later cannot silently vanish from the document.
  it('carries one key per status in STATUSES, plus the cross-cutting fields', () => {
    const root = scopedBacklog();
    assert.deepStrictEqual(
      Object.keys(doc(root)),
      ['scope', 'total', ...STATUSES, 'blocked', 'runnable', 'complete']
    );
  });

  it('blocked is the same call runnable makes, and crosses the status counts', () => {
    const root = scopedBacklog();
    const d = doc(root);
    // T-0003 (open prerequisite) and T-0006 (an id nobody carries) — both also
    // counted under `ready`, which is not double-counting: the status counts
    // alone sum to total, and this is a fact about them.
    assert.strictEqual(d.blocked, 2);
    const blockedByList = JSON.parse(runCli(root, ['list', '--json']).stdout).tasks.filter(
      (t) => t.blockedBy.length > 0
    );
    assert.deepStrictEqual(blockedByList.map((t) => t.id), ['T-0003', 'T-0006']);
    assert.strictEqual(d.blocked, blockedByList.length, 'summary and list disagree about what is blocked');
  });

  it('runnable is the ids runnable prints, in the backlog order', () => {
    const root = scopedBacklog();
    const fromCommand = JSON.parse(runCli(root, ['runnable', '--json']).stdout).tasks.map((t) => t.id);
    assert.deepStrictEqual(doc(root).runnable, fromCommand);
    assert.deepStrictEqual(doc(root).runnable, ['T-0001', 'T-0004']);
  });

  // The shape changed in T-0310 (a flat list could not tell an AND query from an
  // OR one); what this test holds is T-0304's own claim, that the document says
  // what it was an answer to. The distinction itself is tested in that block.
  it('scope echoes the query the answer belongs to', () => {
    const root = scopedBacklog();
    assert.deepStrictEqual(doc(root).scope, { labels: [], labelQuery: 'every task' });
    assert.deepStrictEqual(doc(root, ['--label', 'p']).scope, { labels: [['p']], labelQuery: 'p' });
  });

  // The decision that looks like a bug until you have thought about a typo'd
  // label: vacuous truth would let `--label phase4` read as "phase 4 is done".
  it('an empty scope is total 0 and NOT complete', () => {
    const root = scopedBacklog();
    const d = doc(root, ['--label', 'nobody-carries-this']);
    assert.strictEqual(d.total, 0);
    assert.strictEqual(d.complete, false, 'an empty scope was reported as a finished one');
    assert.strictEqual(STATUSES.reduce((n, s) => n + d[s], 0), 0);
  });

  it('a scope whose tasks are all done or cancelled is complete', () => {
    const root = scopedBacklog();
    assert.strictEqual(runCli(root, ['labels', 'T-0007', 'closed-scope']).status, 0);
    assert.strictEqual(doc(root, ['--label', 'closed-scope']).complete, true);
    assert.strictEqual(runCli(root, ['labels', 'T-0005', 'closed-scope']).status, 0);
    const both = doc(root, ['--label', 'closed-scope']);
    assert.strictEqual(both.total, 2);
    assert.strictEqual(both.complete, true, 'a cancelled task is closed and does not hold a scope open');
    // One task that is not closed is enough to take it back.
    assert.strictEqual(runCli(root, ['labels', 'T-0001', 'closed-scope']).status, 0);
    assert.strictEqual(doc(root, ['--label', 'closed-scope']).complete, false);
  });

  it('refuses --status with the usage line and a non-zero exit', () => {
    const root = scopedBacklog();
    const res = runCli(root, ['summary', '--status', 'ready']);
    assert.strictEqual(res.status, 1, `summary accepted --status: ${res.stdout}`);
    assert.match(res.stderr, /ERROR: summary has no flag --status/);
    assert.match(res.stderr, /usage: node tools\/task\.mjs summary/);
    assert.strictEqual(res.stdout, '', 'a refused summary printed a document anyway');
  });

  // T-0304 had --all decide whether the archive was in scope here, and printed
  // the archived-tasks note when it was not. T-0310 took the flag away and made
  // the archive unconditional: a finished scope was printing the document a
  // mistyped label prints. The counting rules above are untouched by that; the
  // archive half lives in the T-0310 block below.
});

describe('task.mjs runnable/summary are queries and nothing else (T-0304)', () => {
  const CALLS = [
    ['runnable'],
    ['runnable', '--json'],
    ['runnable', '--label', 'p'],
    ['runnable', '--status', 'ready'],
    ['summary'],
    ['summary', '--json'],
    ['summary', '--json', '--label', 'p'],
    // Was ['summary', '--all'] until T-0310 refused the flag; a repeated --label
    // keeps a two-set query in the determinism check, which is what the entry
    // was here for.
    ['summary', '--json', '--label', 'p', '--label', 'q'],
  ];

  it('leaves doc/backlog.md byte-identical', () => {
    const root = scopedBacklog();
    const before = fs.readFileSync(backlogPath(root), 'utf8');
    for (const args of CALLS) {
      assert.strictEqual(runCli(root, args).status, 0, `${args.join(' ')}: refused`);
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, `${args.join(' ')} wrote`);
    }
  });

  // Compared on the bytes, not on the parse: a document whose keys reorder
  // between runs parses the same and is not a stable contract.
  it('--json answers the same bytes on two runs over the same backlog', () => {
    const root = scopedBacklog();
    for (const args of CALLS.filter((a) => a.includes('--json'))) {
      const first = runCli(root, args);
      const second = runCli(root, args);
      assert.strictEqual(first.status, 0, first.stderr);
      assert.strictEqual(first.stdout, second.stdout, `${args.join(' ')} is not deterministic`);
      JSON.parse(first.stdout); // one document, nothing else on stdout
    }
  });

  it('both are listed among the commands', () => {
    const help = runCli(makeTmpRoot(), ['help']).stdout;
    assert.match(help, /\brunnable\b/);
    assert.match(help, /\bsummary\b/);
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

// T-0279. Shaped exactly like `depends`: the whole list is ONE comma-separated
// argument, it REPLACES what was there, and it says what it dropped — the same
// three properties, because the same accident (a second call meaning "add one
// more") costs the same here.
describe('task.mjs labels (T-0279)', () => {
  function labelledTask() {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Labelled task']);
    return { root, id };
  }

  it('sets the whole list and writes it into the task', () => {
    const { root, id } = labelledTask();
    const res = runCli(root, ['labels', id, 'ui,docs']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /ui, docs/);
    assert.deepStrictEqual(readTasks(root)[0].labels, ['ui', 'docs']);
    assert.match(fs.readFileSync(backlogPath(root), 'utf8'), /^- labels: ui, docs$/m);
  });

  it('--clear drops the field, and the line with it', () => {
    const { root, id } = labelledTask();
    runCli(root, ['labels', id, 'ui,docs']);
    const res = runCli(root, ['labels', id, '--clear']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(readTasks(root)[0].labels, []);
    assert.ok(!fs.readFileSync(backlogPath(root), 'utf8').includes('- labels:'));
  });

  it('a second call REPLACES the list and says what it dropped', () => {
    const { root, id } = labelledTask();
    runCli(root, ['labels', id, 'ui,docs']);
    const res = runCli(root, ['labels', id, 'api']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(readTasks(root)[0].labels, ['api']);
    assert.match(res.stdout, /dropped: ui, docs/);
    // The call that was meant, ready to be copied.
    assert.match(res.stdout, new RegExp(`node tools/task\\.mjs labels ${id} ui,docs,api`));
  });

  it('--clear names what it dropped too', () => {
    const { root, id } = labelledTask();
    runCli(root, ['labels', id, 'ui']);
    assert.match(runCli(root, ['labels', id, '--clear']).stdout, /dropped: ui/);
  });

  it('a list rewritten to itself dropped nothing and says nothing', () => {
    const { root, id } = labelledTask();
    runCli(root, ['labels', id, 'ui,docs']);
    assert.doesNotMatch(runCli(root, ['labels', id, 'docs,ui']).stdout, /dropped/);
  });

  it('trims, collapses a repeat and keeps the order written', () => {
    const { root, id } = labelledTask();
    assert.strictEqual(runCli(root, ['labels', id, ' ui , docs ,ui']).status, 0);
    assert.deepStrictEqual(readTasks(root)[0].labels, ['ui', 'docs']);
  });

  // The rules live in server/parser.js and the endpoint applies the same ones
  // (tests/labels-api.test.js): what is refused here is refused there.
  const REFUSED = {
    'a name over the length cap': ['y'.repeat(MAX_LABEL_LEN + 1), new RegExp(String(MAX_LABEL_LEN))],
    'more names than a task may carry': [
      Array.from({ length: MAX_LABELS + 1 }, (_, i) => 'l' + i).join(','),
      new RegExp(String(MAX_LABELS)),
    ],
  };

  for (const [name, [value, message]] of Object.entries(REFUSED)) {
    it(`refuses ${name}, and writes nothing`, () => {
      const { root, id } = labelledTask();
      const before = fs.readFileSync(backlogPath(root), 'utf8');
      const res = runCli(root, ['labels', id, value]);
      assert.strictEqual(res.status, 1, res.stdout);
      assert.match(res.stderr, message);
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before);
    });
  }

  // A comma cannot reach a name from here at all — it is the separator, and that
  // is the same list the endpoint's ["ui","docs"] means.
  it('a comma in the argument separates, it never lands inside a name', () => {
    const { root, id } = labelledTask();
    assert.strictEqual(runCli(root, ['labels', id, 'ui,docs']).status, 0);
    assert.deepStrictEqual(readTasks(root)[0].labels, ['ui', 'docs']);
  });

  it('is case-sensitive: ui and UI are two labels', () => {
    const { root, id } = labelledTask();
    runCli(root, ['labels', id, 'ui,UI']);
    assert.deepStrictEqual(readTasks(root)[0].labels, ['ui', 'UI']);
  });

  it('reports an unknown task and writes nothing', () => {
    const { root } = labelledTask();
    const res = runCli(root, ['labels', 'T-9999', 'ui']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /T-9999 not found/);
    assert.deepStrictEqual(readTasks(root)[0].labels, []);
  });

  it('shows usage when the list is missing', () => {
    const { root, id } = labelledTask();
    const res = runCli(root, ['labels', id]);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /comma-separated list of labels or --clear/);
    assert.match(res.stderr, /usage: node tools\/task\.mjs labels/);
  });

  it('answers a space-separated list with the comma-separated call that was meant', () => {
    const { root, id } = labelledTask();
    const res = runCli(root, ['labels', id, 'ui', 'docs']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, new RegExp(`node tools/task\\.mjs labels ${id} ui,docs`));
    assert.deepStrictEqual(readTasks(root)[0].labels, [], 'the first name must not be taken alone');
  });

  it('leaves the rest of the task alone, and show reports the field', () => {
    const { root, id } = labelledTask();
    runCli(root, ['labels', id, 'ui']);
    const [t] = readTasks(root);
    assert.strictEqual(t.title, 'Labelled task');
    assert.strictEqual(t.status, 'backlog');
    assert.deepStrictEqual(JSON.parse(runCli(root, ['show', id]).stdout).labels, ['ui']);
  });

  it('is listed among the commands', () => {
    assert.match(runCli(makeTmpRoot(), ['help']).stdout, /\blabels\b/);
  });
});

// A label at creation (T-0282). The point of the flag is that the rule "every
// task carries a label" survives being written down: a second command is the one
// that gets dropped when a session is cut short.
describe('task.mjs add --labels (T-0282)', () => {
  it('files a task already carrying them, and prints the id of that task', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Labelled at birth', '--labels', 'ui, docs']);
    const [task] = readTasks(root);
    assert.strictEqual(task.id, id, 'the printed id must be the labelled task');
    assert.deepStrictEqual(task.labels, ['ui', 'docs']);
    assert.match(fs.readFileSync(backlogPath(root), 'utf8'), /^- labels: ui, docs$/m);
    // One command, no second call: the whole reason the flag exists.
    assert.strictEqual(readTasks(root).length, 1);
  });

  it('with no --labels the task carries none and the file has no labels line at all', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Plain task']);
    assert.deepStrictEqual(readTasks(root)[0].labels, []);
    assert.ok(!fs.readFileSync(backlogPath(root), 'utf8').includes('- labels:'));
  });

  it('takes the rest of the flags with it, unchanged', () => {
    const root = makeTmpRoot();
    add(root, ['--type', 'bug', '--priority', 'Blocker', '--title', 'Both', '--desc', 'Why.', '--labels', 'ui']);
    const [task] = readTasks(root);
    assert.strictEqual(task.type, 'bug');
    assert.strictEqual(task.priority, 'Blocker');
    assert.strictEqual(task.description, 'Why.');
    assert.deepStrictEqual(task.labels, ['ui']);
  });

  it('trims, collapses a repeat and keeps the order written, exactly as `labels` does', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Messy list', '--labels', ' ui , docs ,ui']);
    assert.deepStrictEqual(readTasks(root)[0].labels, ['ui', 'docs']);
  });

  // The acceptance criterion, checked the only way that cannot drift: the two
  // commands are run on the same bad value and their refusals are compared with
  // each other, not with a string copied into this file.
  const REFUSED_AT_CREATION = {
    'a name over the length cap': 'y'.repeat(MAX_LABEL_LEN + 1),
    'more names than a task may carry': Array.from({ length: MAX_LABELS + 1 }, (_, i) => 'l' + i).join(','),
  };

  for (const [name, value] of Object.entries(REFUSED_AT_CREATION)) {
    it(`refuses ${name} in the same words the labels command does, and creates nothing`, () => {
      const root = makeTmpRoot();
      const id = add(root, ['--title', 'Something to relabel']);
      const viaSubcommand = runCli(root, ['labels', id, value]);
      assert.strictEqual(viaSubcommand.status, 1, viaSubcommand.stdout);

      const before = fs.readFileSync(backlogPath(root), 'utf8');
      const viaAdd = runCli(root, ['add', '--title', 'Never filed', '--labels', value]);
      assert.strictEqual(viaAdd.status, 1, viaAdd.stdout);
      assert.strictEqual(
        viaAdd.stderr.split('\n')[0],
        viaSubcommand.stderr.split('\n')[0],
        'the two commands must refuse the same value in the same words'
      );
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, 'the task was created anyway');
      assert.strictEqual(readTasks(root).length, 1);
    });
  }

  // A comma inside a name is unreachable from here as it is from `labels`: the
  // comma is the separator, so this is the third refusal in the shape it can
  // actually take - a name that is nothing but separators.
  it('a comma separates and never lands inside a name', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Comma list', '--labels', 'ui,docs']);
    assert.deepStrictEqual(readTasks(root)[0].labels, ['ui', 'docs']);
  });

  it('--labels with nothing after it is refused rather than read as "no labels"', () => {
    const root = makeTmpRoot();
    const res = runCli(root, ['add', '--title', 'Half a flag', '--labels']);
    assert.strictEqual(res.status, 1, res.stdout);
    assert.match(res.stderr, /--labels needs a comma-separated list/);
    assert.match(res.stderr, /usage: node tools\/task\.mjs add/);
    assert.deepStrictEqual(readTasks(root), [], 'nothing may be created by a refused call');
  });

  it('the usage line names the flag, and an unknown one is still refused', () => {
    const res = runCli(makeTmpRoot(), ['add', '--title', 'Typo ahead', '--lables', 'ui']);
    assert.strictEqual(res.status, 1, res.stdout);
    assert.match(res.stderr, /add has no flag --lables/);
    assert.match(res.stderr, /flags of add: .*--labels <value>/);
    assert.match(res.stderr, /usage: node tools\/task\.mjs add .*\[--labels ui,docs\]/);
  });

  // The non-goal of the brief: nothing here may make a label mandatory. A task
  // filed without one, and a whole project of them, stay valid.
  it('validate still passes on a task filed with no labels', () => {
    const root = makeTmpRoot();
    const plain = add(root, ['--title', 'No labels here']);
    const labelled = add(root, ['--title', 'Labelled', '--labels', 'product']);
    const res = runCli(root, ['validate']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /^OK\s*$/);
    assert.deepStrictEqual(readTasks(root).find((t) => t.id === plain).labels, []);
    assert.deepStrictEqual(readTasks(root).find((t) => t.id === labelled).labels, ['product']);
  });
});

describe('task.mjs profile (T-0108)', () => {
  // The declaration is an environment variable, so the CLI has to be given one:
  // the legal values are the user's, and the CLI reads them exactly where the
  // board does.
  function runWithProfiles(root, args, profiles) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, AGENTBOARD_ROOT: root, BRIEFBOARD_PROFILES: profiles },
      encoding: 'utf8',
    });
  }

  function taskWithProfiles(profiles) {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Profiled task']);
    return { root, id, run: (args) => runWithProfiles(root, args, profiles) };
  }

  it('sets a declared profile and writes it into the task', () => {
    const { root, id, run } = taskWithProfiles('deep, fast');
    const res = run(['profile', id, 'fast']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /fast/);
    assert.strictEqual(readTasks(root)[0].profile, 'fast');
    assert.match(fs.readFileSync(backlogPath(root), 'utf8'), /^- profile: fast$/m);
  });

  it('--clear drops the field, and the line with it', () => {
    const { root, id, run } = taskWithProfiles('deep, fast');
    run(['profile', id, 'fast']);
    const res = run(['profile', id, '--clear']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(readTasks(root)[0].profile, '');
    assert.ok(!fs.readFileSync(backlogPath(root), 'utf8').includes('profile'));
  });

  it('refuses a value the user did not declare, and names the ones they did', () => {
    const { root, id, run } = taskWithProfiles('deep, fast');
    const res = run(['profile', id, 'fst']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /fst/);
    assert.match(res.stderr, /deep, fast/);
    // A value outside the declared list is a wrong call, so the usage line
    // comes with the complaint (T-0273).
    assert.match(res.stderr, /usage: node tools\/task\.mjs profile/);
    assert.strictEqual(readTasks(root)[0].profile, '', 'nothing was written');
  });

  it('with nothing declared it refuses to set one and names the variable', () => {
    const { root, id, run } = taskWithProfiles('');
    const res = run(['profile', id, 'fast']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /BRIEFBOARD_PROFILES/);
    // And no usage line here: the call is well formed, there is simply nothing
    // declared to choose from, so repeating the syntax would answer nothing.
    assert.doesNotMatch(res.stderr, /usage:/);
    assert.strictEqual(readTasks(root)[0].profile, '');
  });

  it('--clear works with nothing declared: dropping a value needs no list', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Profiled task']);
    runWithProfiles(root, ['profile', id, 'fast'], 'fast');
    const res = runWithProfiles(root, ['profile', id, '--clear'], '');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(readTasks(root)[0].profile, '');
  });

  it('reports an unknown task and writes nothing', () => {
    const { root, run } = taskWithProfiles('fast');
    const res = run(['profile', 'T-9999', 'fast']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /T-9999 not found/);
    assert.strictEqual(readTasks(root).length, 1);
  });

  it('shows usage when the value is missing', () => {
    const { id, run } = taskWithProfiles('fast');
    const res = run(['profile', id]);
    assert.strictEqual(res.status, 1);
    // The usage line is the command as it is typed, `node` and path included
    // (T-0220): what a refusal prints is meant to be copied and run.
    assert.match(res.stderr, /usage: node tools\/task\.mjs profile/);
  });

  it('leaves the rest of the task alone, and show reports the field', () => {
    const { root, id, run } = taskWithProfiles('deep, fast');
    run(['profile', id, 'deep']);
    const [t] = readTasks(root);
    assert.strictEqual(t.title, 'Profiled task');
    assert.strictEqual(t.status, 'backlog');
    assert.strictEqual(JSON.parse(runCli(root, ['show', id]).stdout).profile, 'deep');
  });

  it('is listed among the commands', () => {
    assert.match(runCli(makeTmpRoot(), ['help']).stdout, /\bprofile\b/);
  });
});

// The CLI used to take the arguments it recognised and drop the rest without a
// word or a non-zero exit: `depends T-0218 T-0208 T-0214 T-0215 T-0216` recorded
// ONE prerequisite, and the board showed the task as unblocked while three of
// them were still open. The same call was made twice in one hour by someone who
// already knew about the first time — the wrong call has to stop being
// indistinguishable from the right one.
describe('task.mjs refuses what a subcommand has no place for (T-0220)', () => {
  // One call per subcommand, each with exactly one argument too many, so the
  // claim "checked all of them" is checked rather than asserted. `{id}` is
  // replaced by a real task id and `{other}` by a second one.
  const TOO_MANY = {
    add: ['add', 'Fix the thing', '--title', 'Fix the thing'],
    status: ['status', '{id}', 'open', 'now'],
    priority: ['priority', '{id}', 'Critical', 'now'],
    depends: ['depends', '{id}', '{other}', '{other}'],
    labels: ['labels', '{id}', 'ui', 'docs'],
    profile: ['profile', '{id}', 'deep', 'now'],
    brief: ['brief', '{id}', 'my', 'slug'],
    link: ['link', '{id}', '{other}'],
    note: ['note', '{id}', '--section', 'S', '--text', 'hello', 'again'],
    show: ['show', '{id}', '{other}'],
    list: ['list', 'ready'],
    runnable: ['runnable', 'ready'],
    summary: ['summary', 'phase-4'],
    start: ['start', '{id}', '{other}'],
    'review-start': ['review-start', '{id}', '{other}'],
    rework: ['rework', '{id}', '{other}'],
    resume: ['resume', '{id}', '{other}'],
    archive: ['archive', 'now'],
    board: ['board', 'now'],
    sessions: ['sessions', 'now'],
    validate: ['validate', 'now'],
  };

  function twoTasks() {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'First']);
    const other = add(root, ['--title', 'Second']);
    return { root, id, other };
  }

  const fill = (args, id, other) =>
    args.map((a) => a.replace('{id}', id).replace('{other}', other));

  // A list built from the CLI's own help line, not from this file: a thirteenth
  // subcommand must either be covered here or fail this test. That is how the
  // same list went stale twice before (T-0179, T-0215).
  it('the calls above cover every subcommand the CLI dispatches', () => {
    const help = runCli(makeTmpRoot(), []).stdout;
    const listed = /commands: (.+?)\s+\(see/.exec(help);
    assert.ok(listed, 'the CLI must keep printing the list of commands it has');
    assert.deepStrictEqual(
      listed[1].split('|').map((s) => s.trim()).sort(),
      Object.keys(TOO_MANY).sort()
    );
  });

  for (const [name, args] of Object.entries(TOO_MANY)) {
    it(`${name}: one argument too many is a refusal that names the expected form`, () => {
      const { root, id, other } = twoTasks();
      const before = fs.readFileSync(backlogPath(root), 'utf8');
      const res = runCli(root, fill(args, id, other));
      assert.strictEqual(res.status, 1, `${name} accepted the extra argument: ${res.stdout}`);
      assert.match(res.stderr, new RegExp(`ERROR: ${name} takes`));
      assert.match(res.stderr, new RegExp(`usage: node tools/task\\.mjs ${name}`));
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, 'nothing was written');
      assert.ok(!fs.existsSync(briefDir(root)), 'no brief file was created either');
    });
  }

  it('the call that produced this task writes no dependency at all', () => {
    const root = makeTmpRoot();
    const ids = [1, 2, 3, 4, 5].map((n) => add(root, ['--title', `Task ${n}`]));
    const res = runCli(root, ['depends', ids[0], ids[1], ids[2], ids[3], ids[4]]);
    assert.strictEqual(res.status, 1);
    assert.deepStrictEqual(readTasks(root)[0].depends, [], 'the first id must not be taken alone');
  });

  it('and answers it with the comma-separated call that was meant', () => {
    const root = makeTmpRoot();
    const ids = [1, 2, 3].map((n) => add(root, ['--title', `Task ${n}`]));
    const res = runCli(root, ['depends', ids[0], ids[1], ids[2]]);
    assert.match(
      res.stderr,
      new RegExp(`node tools/task\\.mjs depends ${ids[0]} ${ids[1]},${ids[2]}`)
    );
  });

  it('an unknown flag is a refusal too: --dryrun does not archive', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Closed thing']);
    assert.strictEqual(runCli(root, ['status', id, 'cancelled']).status, 0);
    const res = runCli(root, ['archive', '--dryrun']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /archive has no flag --dryrun/);
    assert.match(res.stderr, /--dry-run/, 'the flag it has is named');
    // The point of the refusal: a typo in --dry-run used to be a real archive run.
    assert.strictEqual(readTasks(root).length, 1, 'the closed task is still in the backlog');
    assert.ok(!fs.existsSync(path.join(root, 'doc', 'backlog-archive.md')), 'nothing was archived');
  });

  it('a misspelled --force is refused rather than quietly not forcing', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Guarded']);
    const res = runCli(root, ['status', id, 'done', '--forse']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /status has no flag --forse/);
    assert.strictEqual(readTasks(root)[0].status, 'backlog');
  });

  // A flag name is looked up on the declared shape and nowhere else: `--toString`
  // is inherited from Object.prototype, and `flag in spec.flags` would have taken
  // it for a flag the command has.
  it('a flag that only exists on Object.prototype is unknown like any other', () => {
    for (const flag of ['--toString', '--constructor', '--hasOwnProperty']) {
      const res = runCli(makeTmpRoot(), ['archive', flag]);
      assert.strictEqual(res.status, 1, `${flag} was accepted`);
      assert.match(res.stderr, new RegExp(`archive has no flag ${flag}`));
    }
  });

  it('an unknown command exits non-zero and names it', () => {
    const res = runCli(makeTmpRoot(), ['stauts', 'T-0001', 'review']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /unknown command "stauts"/);
    assert.match(res.stderr, /commands: add \| status/);
    assert.strictEqual(res.stdout, '', 'a failure does not answer on stdout');
  });

  it('but asking for the list is not an error: no command, and help', () => {
    for (const args of [[], ['help'], ['--help'], ['-h']]) {
      const res = runCli(makeTmpRoot(), args);
      assert.strictEqual(res.status, 0, `${JSON.stringify(args)} was refused`);
      assert.match(res.stdout, /commands: add \| status/);
    }
  });

  // The flags no longer have to come last, because a 'bool' flag consumes
  // nothing and a value one consumes exactly its value; before this the tokens
  // were counted off the front of argv and any flag in the way became an id.
  it('a flag before the positionals reads the same as one after them', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Forced']);
    const res = runCli(root, ['status', '--force', id, 'done']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(readTasks(root)[0].status, 'done');
    assert.strictEqual(JSON.parse(runCli(root, ['show', '--full', id]).stdout).id, id);
  });

  // T-0054's guard, restated against the new parser: a value-flag left without a
  // value must not swallow the next flag as its value.
  it('a value-flag with no value stays empty instead of eating the next flag', () => {
    const root = makeTmpRoot();
    const res = runCli(root, ['add', '--title', '--priority', 'Major']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /--title is required/);
    assert.strictEqual(readTasks(root).length, 0);
  });
});

// The mirror image of T-0220: there the call had one argument too many, here it
// has one too few. `brief` and `show` had no `if (!id)` guard, so a bare call
// fell through to the task lookup and came back as "task undefined not found" —
// a refusal about a task nobody named, and without the usage line every other
// refusal has printed since T-0220. The reader goes looking for a missing task
// instead of typing the missing argument (T-0269).
describe('task.mjs names the task argument it was not given (T-0269)', () => {
  // Every subcommand whose first positional is the task it acts on. `status`
  // joined them in T-0273: a bare call was refused there too, but by the check
  // on the SECOND argument, so the message was about a status value nobody had
  // reached and carried no usage line.
  // `start` and `review-start` joined them in T-0319/T-0320, and they owe the
  // list one thing the others do not: the refusal has to come from the ARGUMENT
  // check, before a board is looked for at all — otherwise a bare call in a
  // project with no board would exit with the no-board code and say nothing about
  // the missing task.
  const NEEDS_A_TASK = [
    'brief',
    'show',
    'note',
    'depends',
    'labels',
    'profile',
    'status',
    'priority',
    'start',
    'review-start',
    'rework',
    'resume',
  ];

  for (const name of NEEDS_A_TASK) {
    it(`${name}: a call with no task names the missing argument and prints the usage`, () => {
      const root = makeTmpRoot();
      add(root, ['--title', 'Untouched']);
      const before = fs.readFileSync(backlogPath(root), 'utf8');

      const res = runCli(root, [name]);

      assert.strictEqual(res.status, 1, `${name} did not refuse: ${res.stdout}`);
      assert.match(res.stderr, new RegExp(`ERROR: ${name} needs the task`));
      assert.doesNotMatch(res.stderr, /undefined/, 'nobody asked about a task named "undefined"');
      assert.match(res.stderr, new RegExp(`usage: node tools/task\\.mjs ${name}`));
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, 'nothing was written');
      assert.ok(!fs.existsSync(briefDir(root)), 'and no brief file was created either');
    });
  }
});

// The other half of T-0269, one shape over. `status` and `add` refused a wrong
// call with die(), so the message that stopped it did not carry the right one —
// the whole point of the usage line every other refusal has printed since
// T-0220. And a bare `status` was refused by the check on its SECOND argument,
// which made it indistinguishable from a call that did name the task (T-0273).
describe('task.mjs prints the usage line under a refused call (T-0273)', () => {
  it('status with no arguments and status with only a task are two different answers', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Untouched']);

    const noArgs = runCli(root, ['status']);
    const noValue = runCli(root, ['status', id]);

    assert.strictEqual(noArgs.status, 1, noArgs.stdout);
    assert.strictEqual(noValue.status, 1, noValue.stdout);
    assert.notStrictEqual(
      noArgs.stderr,
      noValue.stderr,
      'both wrong calls answered about the status value, so the output could not tell them apart'
    );
    assert.match(noArgs.stderr, /ERROR: status needs the task/);
    assert.match(noValue.stderr, /ERROR: status must be one of/);
  });

  it('the status-value refusal lists the legal values AND the usage line', () => {
    const root = makeTmpRoot();
    const id = add(root, ['--title', 'Untouched']);

    const res = runCli(root, ['status', id, 'nearly-done']);

    assert.strictEqual(res.status, 1, res.stdout);
    assert.match(res.stderr, /ERROR: status must be one of: backlog, open, ready, in_progress, review, done, cancelled/);
    assert.match(res.stderr, /usage: node tools\/task\.mjs status T-0007 </);
    assert.strictEqual(readTasks(root)[0].status, 'backlog', 'nothing was written');
  });

  it('add with no arguments prints the usage line under "--title is required"', () => {
    const root = makeTmpRoot();

    const res = runCli(root, ['add']);

    assert.strictEqual(res.status, 1, res.stdout);
    assert.match(res.stderr, /ERROR: --title is required/);
    assert.match(res.stderr, /usage: node tools\/task\.mjs add --type /);
    assert.strictEqual(readTasks(root).length, 0, 'nothing was written');
  });

  // The rest of the same list (T-0284). These were left out of the four above
  // because none is a one-line swap: three come from server/parser.js, which
  // does not know which subcommand asked; two sit beside `--section is required`
  // and `--text is required`, which did print the usage line; one is inside
  // readStdinValue(), shared by two commands; and one is thrown from inside the
  // write lock. The table is what they have in common - a refusal about the
  // CALL, so the message that stops it carries the one that would work.
  //
  // `usage` is the subcommand the line must name, and it is not always the one
  // whose code refuses: `--desc -` and `--text -` are refused by the same
  // function, and the two rows below are the whole proof that it names its
  // caller rather than a hardcoded default.
  const CALL_SHAPED = [
    {
      what: 'add: a label name the file cannot carry',
      args: ['add', '--title', 'Never filed', '--labels', 'y'.repeat(MAX_LABEL_LEN + 1)],
      message: new RegExp(`is longer than ${MAX_LABEL_LEN} characters`),
      usage: 'add',
    },
    {
      what: 'add: a title that is only whitespace',
      args: ['add', '--title', '   '],
      message: /ERROR: title is required/,
      usage: 'add',
    },
    {
      what: 'add: --desc - with nothing piped in',
      args: ['add', '--title', 'Never filed', '--desc', '-'],
      input: '',
      message: /ERROR: --desc - got nothing on standard input/,
      usage: 'add',
    },
    {
      // T-0286, and it needed no new call site: the refusal comes out of
      // addTask() through the same catch the two rows above go through.
      what: 'add: a --type that is not one of the three',
      args: ['add', '--title', 'Never filed', '--type', 'chore'],
      message: /ERROR: type must be one of: feature, bug, external/,
      usage: 'add',
    },
    {
      what: 'add: a --priority that is not one of the five',
      args: ['add', '--title', 'Never filed', '--priority', 'Extreme'],
      message: /ERROR: priority must be one of: Blocker, Critical, Major, Medium, Minor/,
      usage: 'add',
    },
    {
      what: 'labels: a label name the file cannot carry',
      args: ['labels', 'T-0001', 'y'.repeat(MAX_LABEL_LEN + 1)],
      message: new RegExp(`is longer than ${MAX_LABEL_LEN} characters`),
      usage: 'labels',
    },
    {
      what: 'note: a section heading with a line break in it',
      args: ['note', 'T-0001', '--section', 'Worker\nreport', '--text', 'anything'],
      message: /ERROR: --section must not contain line breaks/,
      usage: 'note',
    },
    {
      what: 'note: a text that is only whitespace',
      args: ['note', 'T-0001', '--section', 'Worker report', '--text', '   '],
      message: /ERROR: nothing to append: the text is empty/,
      usage: 'note',
    },
    {
      what: 'note: --text - with nothing piped in',
      args: ['note', 'T-0001', '--section', 'Worker report', '--text', '-'],
      input: '',
      message: /ERROR: --text - got nothing on standard input/,
      usage: 'note',
    },
    {
      // The seventh, found while walking the file for the six: `link` has
      // printed the usage line under exactly this refusal since T-0267, and
      // `depends` did not.
      what: 'depends: a token that is not a task id at all',
      args: ['depends', 'T-0001', 'garbage'],
      message: /ERROR: "garbage" is not a task id \(expected T-NNNN\)/,
      usage: 'depends',
    },
  ];

  for (const row of CALL_SHAPED) {
    it(`${row.what}: the message carries the usage line of ${row.usage}`, () => {
      const root = makeTmpRoot();
      assert.strictEqual(add(root, ['--title', 'Untouched']), 'T-0001');
      const before = fs.readFileSync(backlogPath(root), 'utf8');

      const res = runCli(root, row.args, row.input);

      assert.strictEqual(res.status, 1, `not refused: ${res.stdout}`);
      assert.match(res.stderr, row.message);
      assert.match(res.stderr, new RegExp(`^usage: node tools/task\\.mjs ${row.usage}\\b`, 'm'));
      assert.strictEqual(fs.readFileSync(backlogPath(root), 'utf8'), before, 'nothing was written');
    });
  }

  // The other side of the same split, at the three places the table above
  // touched: a refusal about the STATE of the repository still prints no usage
  // line, because nothing about the call is wrong and repeating the syntax
  // answers a question nobody asked. `depends` is the sharp one - two of its
  // three checks on the same list stayed die(), one line apart from the one that
  // did not.
  const STATE_SHAPED = [
    { what: 'depends: a well-formed id that names no task', args: ['depends', 'T-0001', 'T-9999'] },
    { what: 'show: a task that is in neither file', args: ['show', 'T-9999'] },
    { what: 'link: a brief id no file answers to', args: ['link', 'T-0001-01'] },
  ];

  for (const row of STATE_SHAPED) {
    it(`${row.what}: refused without a usage line`, () => {
      const root = makeTmpRoot();
      add(root, ['--title', 'Untouched']);

      const res = runCli(root, row.args);

      assert.strictEqual(res.status, 1, `not refused: ${res.stdout}`);
      assert.doesNotMatch(res.stderr, /^usage:/m, 'the call is well formed; the repository is not in that state');
    });
  }
});


// `depends` sets the whole list and never adds to it. The word "set" in the docs
// says so, but only to someone reading them at the moment they add a second
// prerequisite in a second call — and that person's call succeeds, prints the
// same line a deliberate one prints, and loses the first prerequisite. So the
// command says what it dropped (T-0220).
describe('task.mjs depends names what it replaced (T-0220)', () => {
  function threeTasks(root) {
    return [1, 2, 3].map((n) => add(root, ['--title', `Task ${n}`]));
  }

  it('a second call names the prerequisite it just dropped', () => {
    const root = makeTmpRoot();
    const [a, b, c] = threeTasks(root);
    runCli(root, ['depends', c, a]);
    const res = runCli(root, ['depends', c, b]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`dropped: ${a}`));
    assert.match(res.stdout, /never adds to it/);
    assert.deepStrictEqual(readTasks(root)[2].depends, [b]);
  });

  it('and shows the call that would have kept both', () => {
    const root = makeTmpRoot();
    const [a, b, c] = threeTasks(root);
    runCli(root, ['depends', c, a]);
    const res = runCli(root, ['depends', c, b]);
    assert.match(res.stdout, new RegExp(`node tools/task\\.mjs depends ${c} ${a},${b}`));
  });

  it('says nothing when nothing was lost: a first list, or the same one again', () => {
    const root = makeTmpRoot();
    const [a, , c] = threeTasks(root);
    assert.doesNotMatch(runCli(root, ['depends', c, a]).stdout, /dropped/);
    assert.doesNotMatch(runCli(root, ['depends', c, a]).stdout, /dropped/);
  });

  it('--clear names what it emptied, without advising how to keep it', () => {
    const root = makeTmpRoot();
    const [a, , c] = threeTasks(root);
    runCli(root, ['depends', c, a]);
    const res = runCli(root, ['depends', c, '--clear']);
    assert.match(res.stdout, new RegExp(`dropped: ${a}`));
    assert.doesNotMatch(res.stdout, /to keep them/, '--clear is the one call that meant to lose them');
  });
});

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

