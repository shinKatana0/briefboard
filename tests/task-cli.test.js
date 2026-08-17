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
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const { parseBacklog } = require('../server/parser.js');
const { REGISTRY_FILE, REGISTRY_VERSION } = require('../server/sessions.js');

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

  it('forces type to feature when the flag value is not a known type', () => {
    const root = makeTmpRoot();
    add(root, ['--title', 'Bogus type', '--type', 'chore']);
    const [t] = readTasks(root);
    assert.strictEqual(t.type, 'feature');
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
    assert.strictEqual(readTasks(root)[0].profile, '', 'nothing was written');
  });

  it('with nothing declared it refuses to set one and names the variable', () => {
    const { root, id, run } = taskWithProfiles('');
    const res = run(['profile', id, 'fast']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /BRIEFBOARD_PROFILES/);
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
    depends: ['depends', '{id}', '{other}', '{other}'],
    profile: ['profile', '{id}', 'deep', 'now'],
    brief: ['brief', '{id}', 'my', 'slug'],
    note: ['note', '{id}', '--section', 'S', '--text', 'hello', 'again'],
    show: ['show', '{id}', '{other}'],
    list: ['list', 'ready'],
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
