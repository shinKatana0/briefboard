'use strict';

// Tests for tools/task.mjs -- the CLI agents use to edit doc/backlog.md / doc/brief/.
// Moving a task through the statuses, and what may not move.
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
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseBacklog, STATUSES } = require('../server/parser.js');
const {
  CLI_PATH,
  runCli,
  makeTmpRoot,
  backlogPath,
  readTasks,
  add,
  addBrief,
} = require('./helpers/task-cli.js');

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
