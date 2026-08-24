'use strict';

// Tests for tools/task.mjs -- the CLI agents use to edit doc/backlog.md / doc/brief/.
// What add writes, and the fields a task carries from the moment it exists.
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
const { spawn, spawnSync } = require('node:child_process');
const { MAX_LABEL_LEN, MAX_LABELS } = require('../server/parser.js');
const {
  CLI_PATH,
  runCli,
  makeTmpRoot,
  backlogPath,
  readTasks,
  add,
} = require('./helpers/task-cli.js');

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
