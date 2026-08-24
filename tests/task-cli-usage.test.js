'use strict';

// Tests for tools/task.mjs -- the CLI agents use to edit doc/backlog.md / doc/brief/.
// What the CLI refuses, and the usage line it refuses with.
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
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MAX_LABEL_LEN } = require('../server/parser.js');
const {
  runCli,
  makeTmpRoot,
  backlogPath,
  briefDir,
  readTasks,
  add,
} = require('./helpers/task-cli.js');

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
