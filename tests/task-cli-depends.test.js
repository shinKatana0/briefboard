'use strict';

// Tests for tools/task.mjs -- the CLI agents use to edit doc/backlog.md / doc/brief/.
// What links one task to another: prerequisites, briefs and notes.
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
const {
  CLI_PATH,
  runCli,
  makeTmpRoot,
  backlogPath,
  briefDir,
  readTasks,
  add,
  addBrief,
} = require('./helpers/task-cli.js');

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
