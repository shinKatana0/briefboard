'use strict';

// T-0106: translations are written once per release, not in every task. The rule
// only holds if the two things that carry it stay in place — the header notice
// that warns the reader about the lag, and the release step that ends it — so
// they are asserted here rather than trusted to memory.
// Run with: npm test

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { skipOutsideExport } = require('./helpers/public-tree.js');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

// Everything above the first `##` section: the title, the language switcher, the
// badges, and the notice under test.
const header = (text) => text.split('\n## ')[0];

describe('translated docs warn that they lag behind English (T-0106)', () => {
  const TRANSLATIONS = [
    ['README.ru.md', 'README.md'],
    ['README.ja.md', 'README.md'],
    ['doc/guide/guide.ru.md', 'guide.en.md'],
    ['doc/guide/guide.ja.md', 'guide.en.md'],
  ];

  for (const [file, english] of TRANSLATIONS) {
    it(`${file}: the header points at ${english} as the leading version`, () => {
      // An italic run in the header, naming the English document. The language
      // switcher links to it too, which is why the notice has to be the emphasised
      // one — that is what distinguishes it from a plain navigation line.
      const notices = header(read(file)).match(/\*[^*]+\*/g) || [];
      assert.ok(
        notices.some((notice) => notice.includes(english)),
        `${file} must open with a notice naming ${english} as the version that leads`
      );
    });
  }
});

// T-0113: `.claude/agents/worker.md` is the Claude Code entry point for the
// same protocol — frontmatter, the whole of agents/WORKER.md, then a tail about
// being a subagent. Kept as two files, they drift, and a rule fixed in one of
// them reaches only half the workers.
describe('the worker protocol is one document, in both of its copies', () => {
  const WORKER = 'agents/WORKER.md';
  const CLAUDE_WORKER = '.claude/agents/worker.md';

  it(`${CLAUDE_WORKER} carries the whole body of ${WORKER}`, () => {
    assert.ok(
      read(CLAUDE_WORKER).includes(read(WORKER).trim()),
      `${CLAUDE_WORKER} must contain ${WORKER} verbatim — regenerate it with \`npm run sync:worker-agent\` instead of editing one side`
    );
  });

  it('both send the worker to the shared checkout for the briefs', () => {
    for (const file of [WORKER, CLAUDE_WORKER]) {
      const text = read(file);
      assert.match(text, /\$AGENTBOARD_ROOT\/doc\/brief\//, `${file} must name the shared checkout's brief path`);
      assert.match(text, /T-0113/, `${file} must keep the reason with the rule`);
    }
  });
});

// T-0126: a worker session started from the board runs under a permission rule
// that matches `node tools/task.mjs …` and nothing in front of it — an env prefix
// makes the rule fail to match, and the command is blocked with nobody to approve
// it (measured twice: T-0107, T-0112). So every command the protocol shows has to
// exist in the prefix-free form as well. The `add` that files a finding was the
// one left prefix-only, and it is the worst one to lose: a blocked status still
// leaves a stuck card on the board, a finding that never reaches the backlog
// leaves nothing at all.
describe('every task.mjs command the worker protocol shows exists prefix-free (T-0126)', () => {
  const WORKER_DOCS = ['agents/WORKER.md', '.claude/agents/worker.md'];

  // `node tools/task.mjs <sub>` with no assignment in front of it, either as a
  // line of a code block or inline in backticks.
  const showsPlain = (text, sub) =>
    new RegExp(String.raw`(^|\n|\x60)node tools/task\.mjs ${sub}\b`).test(text);

  for (const file of WORKER_DOCS) {
    it(`${file}: status, note, add and show are each shown without a prefix`, () => {
      const text = read(file);
      for (const sub of ['status', 'note', 'add', 'show']) {
        assert.ok(showsPlain(text, sub), `${file} must show \`node tools/task.mjs ${sub}\` with no env prefix`);
      }
    });

    // The generalisation of the bug rather than the one instance of it: a
    // prefixed example is fine (a dispatched subagent has no variable in its
    // environment), but never as the only form of that subcommand.
    it(`${file}: no subcommand is documented only in its prefixed form`, () => {
      const text = read(file);
      const prefixed = text.matchAll(/AGENTBOARD_ROOT=[^\n]*?node tools\/task\.mjs (\w+)/g);
      const seen = new Set();
      for (const match of prefixed) seen.add(match[1]);
      assert.ok(seen.size > 0, `${file} must still show the subagent form somewhere`);
      for (const sub of seen) {
        assert.ok(
          showsPlain(text, sub),
          `${file} shows \`${sub}\` only with an env prefix — a board session cannot run that`
        );
      }
    });

    // T-0126, third part: workers already file findings that are not bugs
    // (T-0109 was a piece of scope carried out of T-0107 as a `feature`). The
    // rule said "a new problem" and the example hard-coded `--type bug`.
    it(`${file}: the finding rule covers more than bugs and names what not to do`, () => {
      const text = read(file);
      const start = text.indexOf('### 2. Implement');
      const end = text.indexOf('### 3. Submit for review');
      assert.ok(start !== -1 && end > start, `${file} must keep step 2 and step 3`);
      const step2 = text.slice(start, end);

      assert.match(step2, /finding/i, 'the rule is about findings, not only problems');
      for (const type of ['feature', 'bug', 'external']) {
        assert.match(step2, new RegExp(`\\b${type}\\b`), `step 2 must name the \`${type}\` type as a choice`);
      }
      assert.match(step2, /--type/, 'the type is chosen for the finding');
      // The three ways a finding is lost, all of which look like work at the time.
      assert.match(step2, /quietly|silent/i, 'not a quiet fix');
      assert.match(step2, /widen|scope/i, 'not a widened scope');
      assert.match(step2, /report/i, 'not only a line in the report');
    });
  }
});

// T-0126, second part: a rule left as a reference is followed worse than one
// written into the prompt. The shipped worker prompt spelled out the question
// protocol and said nothing about filing a finding, so a session that found one
// had to go looking for the rule in a file it was merely pointed at.
describe('the shipped worker prompt carries the finding rule (T-0126)', () => {
  // English docs only: the translations are written once per release (T-0106).
  for (const file of ['README.md', 'doc/guide/guide.en.md']) {
    it(`${file}: the worker prompt tells the session to file a finding as its own task`, () => {
      const text = read(file);
      const prompt = /BRIEFBOARD_WORKER_CMD='[\s\S]*?'\s*\\\n\s*node server\/server\.js/.exec(text);
      assert.ok(prompt, `${file} must ship a ready-to-copy BRIEFBOARD_WORKER_CMD`);
      const body = prompt[0];

      assert.match(body, /node tools\/task\.mjs add\b/, 'the command that files it');
      assert.match(body, /--type[^\n]*feature/, 'a finding is not only a bug');
      assert.match(body, /--type[^\n]*external/, 'an external blocker is a finding too');
      assert.match(body, /separate task/i, 'it becomes a card of its own');
      // The prompt has to close the three exits, not just mention the command.
      assert.match(body, /quietly|silently/i, 'not a quiet fix');
      assert.match(body, /widen/i, 'not a widened scope');
      assert.match(body, /only in the report/i, 'not only a line in the report');
      // And it must stay runnable by the session: no env prefix anywhere (T-0118).
      assert.ok(!body.includes('AGENTBOARD_ROOT='), 'the prompt must ask for no env prefix');
    });
  }
});

// T-0172: the protocol said nothing about intermediate commits while the shipped
// prompt asked to "commit on your branch" — one commit, at the end. The protocol
// won: of three worker sessions killed by a usage limit in one day, two had
// changed files and not a single commit. Both texts are asserted here, because a
// rule that lives in only one of them is exactly the state that failed.
describe('the worker is told to commit as it goes (T-0172)', () => {
  for (const file of ['agents/WORKER.md', '.claude/agents/worker.md']) {
    it(`${file}: step 2 asks for commits along the way, with both reasons`, () => {
      const text = read(file);
      const start = text.indexOf('### 2. Implement');
      const end = text.indexOf('### 3. Submit for review');
      assert.ok(start !== -1 && end > start, `${file} must keep step 2 and step 3`);
      const step2 = text.slice(start, end);

      assert.match(step2, /as you go/i, 'the cadence is named');
      assert.match(step2, /not once at the end|single commit at the end/i, 'against what it replaces');
      // The first reason: the session is taken away from you mid-task.
      assert.match(step2, /\b(limit|timeout)\b/i, 'a session ends without asking');
      // The second, less obvious one: the directory is taken away from you, and
      // only if you behaved well and rolled your prototype back (T-0133).
      assert.match(step2, /worktree[\s\S]{0,160}(clean|delet|remov)/i, 'an unchanged worktree can be cleaned up');
      assert.match(step2, /T-0133/, 'the observation stays with the rule');
      // And the new rule must not read as leave to commit the shared backlog.
      assert.match(step2, /doc\/backlog\.md/, 'committing often does not loosen T-0079');
    });
  }

  for (const file of ['README.md', 'doc/guide/guide.en.md']) {
    it(`${file}: the shipped prompt no longer implies one commit before review`, () => {
      const text = read(file);
      const prompt = /BRIEFBOARD_WORKER_CMD='[\s\S]*?'\s*\\\n\s*node server\/server\.js/.exec(text);
      assert.ok(prompt, `${file} must ship a ready-to-copy BRIEFBOARD_WORKER_CMD`);
      const body = prompt[0];

      assert.match(body, /commit/i, 'the prompt still asks for commits');
      assert.match(body, /as you go/i, 'and asks for them while the work happens');
      assert.match(body, /\b(lose|loses|lost)\b/i, 'with the reason on the same line');
      assert.ok(
        !/commit on your branch\./.test(body),
        'the sentence that read as a single commit before review is gone'
      );
    });
  }
});

// T-0121: a run profile takes two steps — declaring the values AND putting
// {profile} into your own command template — and the ready-to-copy commands
// deliberately have no placeholder. Told in two separate paragraphs, that reads
// as one step, and the reader ends up with a selector that reaches nothing. The
// pair has to stay in the same section, with an example.
describe('the run profile is documented as both of its steps (T-0121)', () => {
  // From the "run profile" heading to the next heading of any level.
  function profileSection(file) {
    const text = read(file);
    const start = text.search(/^#{2,4} .*run profile/im);
    assert.notStrictEqual(start, -1, `${file} must have a run profile section`);
    const rest = text.slice(start);
    const afterHeading = rest.indexOf('\n');
    const end = rest.slice(afterHeading).search(/\n#{2,4} /);
    return end === -1 ? rest : rest.slice(0, afterHeading + end);
  }

  for (const file of ['README.md', 'doc/guide/guide.en.md']) {
    it(`${file}: the declaration and the placeholder are named together`, () => {
      const section = profileSection(file);
      assert.match(section, /BRIEFBOARD_PROFILES/, 'the declaration step');
      assert.match(section, /BRIEFBOARD_SESSION_CMD/, 'the briefing template');
      assert.match(section, /BRIEFBOARD_WORKER_CMD/, 'the worker template');
      assert.match(section, /\{profile\}/, 'the placeholder the reader has to add');
    });

    it(`${file}: an example command with the placeholder is right there`, () => {
      const blocks = profileSection(file).match(/```bash\n[\s\S]*?```/g) || [];
      assert.ok(
        blocks.some((b) => b.includes('{profile}') && b.includes('BRIEFBOARD_PROFILES')),
        `${file} must show a runnable example carrying both halves`
      );
    });
  }
});

describe('the rule that produces the lag, and the step that ends it (T-0106)', () => {
  it('CONTRIBUTING.md keeps tasks to the English docs and exempts the UI strings', () => {
    const text = read('CONTRIBUTING.md');
    assert.match(text, /README\.ru\.md/);
    assert.match(text, /doc\/guide\/guide\.en\.md/);
    assert.match(text, /RELEASING\.md/);
    // Without this carve-out the rule would hold a translated button back until
    // the next release, which is a product bug, not a documentation lag.
    assert.match(text, /i18n/);
  });

  // RELEASING.md is the private repo's release checklist and the export drops it,
  // so in the public tree there is no file to read (T-0252). Skipped on a positive
  // marker of that tree, never on "the file is missing" — deleted here by accident,
  // RELEASING.md must make this fail, not fall silent.
  it('RELEASING.md translates before it bumps the version and publishes', { skip: skipOutsideExport('RELEASING.md') }, () => {
    const text = read('RELEASING.md');
    const translate = text.indexOf('README.ru.md');
    const bump = text.indexOf('Bump `package.json` version');
    const publish = text.indexOf('npm publish');

    assert.notStrictEqual(translate, -1, 'RELEASING.md must carry the translation step');
    assert.notStrictEqual(bump, -1);
    assert.notStrictEqual(publish, -1);
    // After the bump or the publish, the step would translate a release that has
    // already shipped.
    assert.ok(translate < bump, 'the translation step must come before the version bump');
    assert.ok(translate < publish, 'the translation step must come before the publish');
  });
});

// T-0115: streaming output is a property of one agent CLI, so it is documented
// as an alternative and the ready-to-copy commands stay plain. The two caveats
// are the whole reason to write it down: the flags belong to that CLI, and the
// log turns into JSON the board deliberately does not render.
describe('the streaming variant is documented as a variant (T-0115)', () => {
  // From the heading that introduces the empty log to the next heading.
  function streamingSection(file) {
    const text = read(file);
    const start = text.search(/^#{3,4} .*empty log/im);
    assert.notStrictEqual(start, -1, `${file} must explain an empty log under a live session`);
    const rest = text.slice(start);
    const afterHeading = rest.indexOf('\n');
    const end = rest.slice(afterHeading).search(/\n#{2,4} /);
    return end === -1 ? rest : rest.slice(0, afterHeading + end);
  }

  for (const file of ['README.md', 'doc/guide/guide.en.md']) {
    it(`${file}: shows the streaming flags with both caveats`, () => {
      const section = streamingSection(file);
      assert.match(section, /--output-format stream-json/, 'the flag itself');
      assert.match(section, /--include-partial-messages/);
      assert.match(section, /JSON/, 'the log becomes JSON in that mode');
      assert.match(section, /CLI/, 'the flags belong to one agent CLI');
      assert.match(section, /\b(variant|option)\b/i, 'presented as an alternative');
    });

    it(`${file}: the default ready-to-copy commands stay plain`, () => {
      const blocks = (read(file).match(/```bash\n[\s\S]*?```/g) || []).filter((b) =>
        /BRIEFBOARD_(SESSION|WORKER)_CMD/.test(b)
      );
      // `stream-json` and not `--output-format`: since T-0152 a second command
      // carries `--output-format json`, for the other reason to leave text mode
      // — printing a token count the board can read. Both are variants of the
      // plain default, and each is named once.
      const streaming = blocks.filter((b) => b.includes('stream-json'));
      const nonDefault = blocks.filter((b) => b.includes('--output-format'));
      assert.ok(blocks.length > nonDefault.length, `${file} must keep commands without the flag`);
      assert.strictEqual(streaming.length, 1, 'streaming appears once, as the variant');
    });
  }
});

// T-0152: three gaps found by walking the docs as a user with a Flutter project
// and an agent that is not Claude Code. Each of them reads as documentation
// prose, which is exactly why they are asserted: prose is what gets rewritten
// for tone in a later pass, and the fact inside it goes missing.
const ENGLISH_DOCS = ['README.md', 'doc/guide/guide.en.md'];

// A heading and everything under it, up to the next heading of the same level or
// higher — so subsections written under it stay in.
function section(file, heading) {
  const text = read(file);
  const start = text.search(heading);
  assert.notStrictEqual(start, -1, `${file} must have a section matching ${heading}`);
  const level = /^#+/.exec(text.slice(start))[0].length;
  const rest = text.slice(start);
  const afterHeading = rest.indexOf('\n');
  const end = rest.slice(afterHeading).search(new RegExp(`\\n#{2,${level}} `));
  return end === -1 ? rest : rest.slice(0, afterHeading + end);
}

describe('an isolated worktree is documented as empty, with the way out (T-0152)', () => {
  for (const file of ENGLISH_DOCS) {
    it(`${file}: the isolation section says a worktree has nothing installed`, () => {
      const text = section(file, /^#{3,4} .*isolated sessions/im);

      assert.match(text, /node_modules/, 'the emptiness is named concretely, not implied');
      assert.match(text, /BRIEFBOARD_SETUP_CMD/, 'the supported answer is named where the problem is');
      // T-0150 prepares a worktree; it does not know your stack and does not
      // install anything you did not declare. Promising more than that is the
      // failure this assertion exists against.
      assert.match(text, /\b(declare|declared)\b/i, 'the command is the user\'s to give');
      assert.match(text, /\b(price|cost|costs)\b/i, 'what it costs is named');
      assert.match(text, /per task/i, 'and the cost is per task, not per session');
      // The alternative — the agent installing for itself — is the one that hits
      // a permission list with nobody to approve it (T-0107).
      assert.match(text, /allowedTools/, 'the alternative goes through the permission list');
      assert.match(text, /approv/i, 'and a headless session has nobody to approve it');
    });
  }

  for (const file of ['agents/WORKER.md', '.claude/agents/worker.md']) {
    it(`${file}: the worker is told what an unprepared worktree looks like`, () => {
      const text = read(file);
      assert.match(text, /node_modules/, 'the worker meets this as a failing test command');
      assert.match(text, /BRIEFBOARD_SETUP_CMD/, 'and it may have been prepared for it already');
    });
  }
});

// T-0149: the example expression waits for JSON while the ready-to-copy commands
// print text, so the counter is configured, correct, and matches nothing. The
// section has to connect the two ends: the number is read from the log, so
// something has to put it there.
describe('the token counter says where the number comes from (T-0152)', () => {
  for (const file of ENGLISH_DOCS) {
    it(`${file}: the token section names the output format and its price`, () => {
      const text = section(file, /^#{3,4} What a task took/im);

      assert.match(text, /--output-format/, 'the number has to be printed before it can be read');
      assert.match(text, /text mode/, 'the handed-out command prints none');
      assert.match(text, /\b(price|cost|costs)\b/i, 'turning it on costs the readable log');
      // Measured, and pinned to the version it was measured on: every match is
      // summed, so an expression matching the same figure twice doubles it.
      assert.match(text, /2\.1\.232/, 'the measurement names the version it holds for');
      assert.match(text, /twice|2 matches/, 'the obvious expression double-counts');
    });

    it(`${file}: the example pairs the expression with a command that prints one`, () => {
      const blocks = (read(file).match(/```bash\n[\s\S]*?```/g) || []).filter((b) =>
        b.includes('BRIEFBOARD_TOKENS_RE')
      );
      assert.ok(
        blocks.some((b) => b.includes('--output-format')),
        `${file} must show the counter next to a command whose output carries a number`
      );
    });
  }
});

// T-0163: counting the matches (above) tells the reader the sum is wrong; this
// is the section that has to tell them what to do about it.
describe('the token counter says how to choose sum or last (T-0163)', () => {
  for (const file of ENGLISH_DOCS) {
    it(`${file}: both modes are named, with the default marked`, () => {
      const text = section(file, /^#{3,4} What a task took/im);

      assert.match(text, /BRIEFBOARD_TOKENS_MODE/, 'the declaration is named where it is needed');
      assert.match(text, /\blast\b/, 'the mode that ends the doubling');
      assert.match(text, /sum[^\n]*default|default[^\n]*sum/i, 'the old behaviour is still the default');
      assert.match(text, /running total/i, 'and the case last exists for');
      // The counting instruction is what makes the choice answerable; a mode
      // nobody knows they need is no better than no mode.
      assert.match(text, /count the matches/i, 'the reader still has to check the real log');
    });
  }
});

// T-0151, points 2-3: the requirements were readable only by inference from one
// example, so a reader with another CLI had nothing to check it against.
describe('what an agent must be able to do is a list (T-0152)', () => {
  for (const file of ENGLISH_DOCS) {
    it(`${file}: the four requirements are stated, not implied`, () => {
      const text = section(file, /^#{3,4} What briefboard (needs|requires)/im);

      assert.match(text, /\bexit(s|ing)?\b/i, 'one prompt, then the process ends');
      assert.match(text, /stdin|terminal/i, 'nothing can answer a prompt');
      assert.match(text, /files/i, 'files in the working directory are the only channel');
      assert.match(text, /node tools\/task\.mjs/, 'and the CLI is how a session reports back');
    });

    it(`${file}: the CLI's syntax is separated from briefboard's own`, () => {
      const text = section(file, /^#{3,4} What briefboard (needs|requires)/im);

      assert.match(text, /--allowedTools/, 'the flags that are not briefboard\'s');
      assert.match(text, /Claude Code/, 'named as one CLI\'s');
      assert.match(text, /BRIEFBOARD_/, 'against what briefboard does own');
      // The dangerous half: our warnings assume an agent that refuses and exits
      // 0. A CLI defaulting the other way turns the same paragraphs into
      // reassurance while it runs everything it is asked to.
      assert.match(text, /default/i, 'the permission default is named as a default');
      assert.match(text, /opposite|other way/i, 'and as one that can go the other way');
    });
  }
});

// T-0149, second half: a report template is copied as it stands, so `npm test`
// in it is an instruction to run npm in a project that may have no npm.
describe('the worker report template carries no stack of its own (T-0152)', () => {
  for (const file of ['agents/WORKER.md', '.claude/agents/worker.md']) {
    it(`${file}: every Verify line is a placeholder`, () => {
      const lines = read(file).match(/^Verify: .*$/gm) || [];
      assert.ok(lines.length >= 3, `${file} must still show the report template`);
      for (const line of lines) {
        assert.match(line, /^Verify: <[^>]+>$/, `"${line}" must be a placeholder, not one project's command`);
      }
    });
  }
});

// T-0148: the board now accepts a task and removes a worktree, and the limits on
// that power are the interesting part — a doc pass that drops them leaves a
// reader expecting a merge button, or not knowing why an action is refused.
describe('closing a task from the board is documented with its limits (T-0148)', () => {
  for (const file of ENGLISH_DOCS) {
    it(`${file}: both actions are named, and the merge is still the human's`, () => {
      const text = read(file);
      assert.match(text, /\*\*Accept\*\*/, 'the action that sets done is named');
      assert.match(text, /Remove the worktree/, 'and the one that cleans up');
      assert.match(text, /never merges/i, 'what the board still does not do');
      assert.match(text, /not merged/i, 'and the refusal a user will meet');
    });
  }

  // The correction on T-0148: briefboard runs on Node, the project it serves may
  // be anything, so a command it hands over to copy would be an invention.
  it("the section about closing a task invents no test command", () => {
    for (const file of ENGLISH_DOCS) {
      const text = section(file, /^#{2,4} .*(merging and cleaning up|isolated sessions)/im);
      assert.doesNotMatch(
        text,
        /\bnpm (test|run)\b|\bpytest\b|\bcargo test\b/,
        `${file} hands the reader a test command as briefboard's own`
      );
    }
  });
});

// T-0139: an undocumented port value is one nobody outside this repository can
// use. Both English documents name it — and the guide says that PORT=0 is not
// the spelling, because that is the first thing a reader tries.
describe('the way to ask for any free port is documented (T-0139)', () => {
  for (const file of ['README.md', 'doc/guide/guide.en.md']) {
    it(`${file}: names the auto port and the range it stays out of`, () => {
      const text = read(file);
      assert.match(text, /PORT=auto|--port auto/, 'the value itself');
      assert.match(text, /4571-4590|4571`-`4590/, 'and the range it exists to leave alone');
    });
  }

  it('doc/guide/guide.en.md: says PORT=0 is not that spelling', () => {
    assert.match(read('doc/guide/guide.en.md'), /`PORT=0` does not mean this/);
  });
});

// T-0141: the step back down is only usable if a reader knows it is there, and
// only trustworthy if the docs say what it does NOT take with it — the fear a
// user brings to any backwards move is that something written is lost. The
// lifecycle diagram is where a reader looks for the graph, so the new edge has to
// be in the picture and not only in the prose.
describe('the way back out of open is documented with its limits (T-0141)', () => {
  for (const file of ['agents/PROTOCOL.md', 'doc/guide/guide.en.md']) {
    it(`${file}: the lifecycle diagram carries the edge`, () => {
      const text = read(file);
      const diagram = (text.match(/```\n[\s\S]*?backlog ──▶ open[\s\S]*?```/) || [''])[0];
      assert.match(diagram, /open ──▶ backlog/, `${file} draws the graph without the step back`);
    });

    it(`${file}: says what the move keeps, and that ready has no way back`, () => {
      const text = read(file);
      assert.match(text, /open (→|-->|──▶) backlog|`\/backlog`|api\/task\/:id\/backlog/,
        'the transition is named');
      assert.match(text, /no way back out of `ready`|no counterpart out of `ready`/i,
        'and the step that deliberately has none');
      assert.match(text, /erases nothing|nothing is erased|stay exactly as they were/i,
        'what the move does not take with it');
    });
  }

  it('both English documents say the drop into Open does not brief a briefed task twice', () => {
    for (const file of ['agents/PROTOCOL.md', 'doc/guide/guide.en.md']) {
      const text = read(file);
      assert.match(text, /no\*{0,2} brief|has no brief|with no brief/i, `${file}: the condition`);
      assert.match(text, /\/briefing|briefing session\*{0,2} button|Start the\s+\*{0,2}briefing session/i,
        `${file}: and the action that starts one anyway`);
    }
  });
});

// T-0181: T-0141 could not touch README — another task was editing it — so the
// feature shipped documented everywhere except the file most readers start from.
// The board's action list is the inventory of what the UI can do; an action
// missing from it is an action nobody finds.
describe('README carries the way back out of Open (T-0181)', () => {
  const boardUi = () => section('README.md', /^## The board UI/m);

  it('the action list has the drag back into Backlog, with what it does not take', () => {
    const text = boardUi();
    assert.match(text, /"Open" back into "Backlog"/, 'the drag itself, in the direction it goes');
    // The fear a user brings to any backwards move, answered where the move is.
    assert.match(text, /erased/i, 'the move takes nothing with it');
    assert.match(text, /not confirmed|no confirmation/i, 'a reversible move does not ask');
    assert.match(text, /briefing session/i, 'except about the one thing it stops');
  });

  it('and the button that starts a briefing session by hand', () => {
    const text = boardUi();
    assert.match(text, /\*\*Start the briefing session\*\*/, 'the button is named as the UI names it');
    assert.match(text, /changes no status/i, 'what it does not do is what makes it safe to press');
  });

  it('the sessions section says a drop into Open briefs only a task with no brief', () => {
    const text = section('README.md', /^## Agent sessions/m);
    assert.match(text, /no\*{0,2} brief/i, 'the condition');
    assert.match(text, /\*\*Start the briefing session\*\*/, 'and the way to ask for one anyway');
  });
});

// T-0176: T-0167 made preserving whatever stands above the first task a
// guarantee of the format — a note to readers, a link, a project header now
// survives the CLI and the board. PROTOCOL.md is the single source of truth
// about the format and said nothing about that region, so the guarantee lived
// only in the parser, where the next rewrite is free to drop it.
describe('the backlog preamble is documented as preserved (T-0176)', () => {
  it('agents/PROTOCOL.md says where it is, what survives, and what is never added', () => {
    const text = section('agents/PROTOCOL.md', /^#{3} The preamble/im);

    assert.match(text, /above the first/i, 'the region is defined by where it ends');
    assert.match(text, /verbatim|unchanged/i, 'a write gives it back as it was');
    assert.match(text, /never normali[sz]ed/i, 'and does not tidy it up on the way');
    // '' and null are different states in the parser, and the difference is
    // visible to a user: an empty preamble is not an invitation to add one.
    assert.match(text, /preamble is empty|empty preamble/i, 'an empty preamble is a state of its own');
    assert.match(text, /no file yet/i, 'the built-in head has exactly one case');
  });
});

// T-0179: the sentence was true when it was written, and 'and only those' is
// exactly the phrasing an agent reads as a closed list — the kind of staleness
// that gets acted on. Counted from the CLI rather than from the prose, because
// counting from the prose is what produced the claim.
describe('the CLI reference does not close a list it does not own (T-0179)', () => {
  function subcommands() {
    const help = /commands: ([^'\n]+?)\s+\(see/.exec(read('tools/task.mjs'));
    assert.ok(help, 'tools/task.mjs must keep printing the list of commands it has');
    return help[1].split('|').map((s) => s.trim());
  }

  it('every subcommand tools/task.mjs dispatches is named in the guide', () => {
    const guide = read('doc/guide/guide.en.md');
    for (const sub of subcommands()) {
      assert.match(
        guide,
        new RegExp(String.raw`node tools/task\.mjs ${sub}\b`),
        `\`${sub}\` is a subcommand the guide never shows`
      );
    }
  });

  // T-0215: the same list went stale a second time in the README, where nothing
  // was watching it — `profile` had been a subcommand for weeks and the CLI
  // reference did not have it. Same source of truth as above: the tool's own
  // help line, never the prose next to it.
  it('every subcommand tools/task.mjs dispatches is in the README CLI reference', () => {
    const reference = section('README.md', /^## CLI reference/m);
    for (const sub of subcommands()) {
      assert.match(
        reference,
        new RegExp(String.raw`node tools/task\.mjs ${sub}\b`),
        `\`${sub}\` is a subcommand the README's CLI reference never shows`
      );
    }
  });

  it('section 7 does not present its own list as the whole of it', () => {
    const text = section('doc/guide/guide.en.md', /^## 7\. CLI reference/m);
    const intro = text.slice(0, text.indexOf('\n### '));

    assert.doesNotMatch(intro, /and only those/i, 'a closed list is what went stale');
    assert.match(intro, /with no\s+arguments/i, 'the tool itself is the list that cannot go stale');
  });
});

// T-0215: what has been verified is narrower than what the design allows, and a
// reader decides whether to adopt the tool from the first screen. Both halves are
// asserted — that the limits are stated, and that the older claim of running
// everywhere does not come back with the next editing pass, since it is the
// pleasant sentence and the one that reads as harmless.
describe('the docs say what briefboard has been run on (T-0215)', () => {
  const limits = (file) => section(file, /^#{2,3} What it has been run on/m).replace(/\s+/g, ' ');

  for (const file of ENGLISH_DOCS) {
    it(`${file}: the agent it was tested on, and what that does not promise`, () => {
      const text = limits(file);

      assert.match(text, /Claude Code 2\.1\.\d+/, 'the agent and the version it was run on');
      assert.match(text, /should work/, 'another CLI meeting the requirements is expected to');
      assert.match(text, /no second one has been tried/, 'and that nobody has checked one');
    });

    it(`${file}: the platform it was measured on, down to the one not supported`, () => {
      const text = limits(file);

      assert.match(text, /Windows 11/, 'where the measurements were taken');
      assert.match(text, /Linux/, 'the one checked by the tests');
      assert.match(text, /container/, 'and how far that check went');
      // T-0244: how far it goes is the part that changed. "Checked in part" was
      // the honest word while one area had been run there and three tests
      // failed; the whole suite runs there now, and two tests skip themselves
      // for a Windows-only reason. A reader choosing a platform needs which.
      assert.match(text, /whole suite/, 'what was run on Linux, not merely that something was');
      assert.match(text, /skip/, 'including the tests that do not run there');
      // The whole point of the card: macOS was never run, and saying so is the
      // difference between an honest limit and a guess presented as support.
      assert.match(text, /macOS has never been run/, 'stated, not implied');
      assert.match(text, /not supported/, 'with the conclusion drawn');
    });

    it(`${file}: neither limit is presented as something the code enforces`, () => {
      assert.match(limits(file), /nothing (checks|asks) which agent/, 'no gate, just a statement');
    });

    it(`${file}: does not claim to run on every OS again`, () => {
      assert.doesNotMatch(
        read(file),
        /OS-agnostic|runs anywhere Node/i,
        `${file} promises every platform, which macOS is not (T-0203)`
      );
    });
  }
});

// T-0208: the promise that stopping the board kills its sessions used to be
// unqualified on the orderly path, while the code deliberately refuses to wait
// forever for a descendant that broke out of the tree (T-0171, T-0173). An
// unqualified promise is the one a reader takes literally, so the bound has to
// stand next to it — and with it what the reader sees when the bound is what
// ends the wait, or the leftover `running` record reads as a broken board
// rather than as a case the board named in advance.
describe('the stop is documented as a kill with a bounded wait (T-0208)', () => {
  // The promise and the paragraphs qualifying it, not the whole document: what
  // the card is about is that these two stand together.
  const promise = (file) => {
    const text = read(file);
    const start = text.search(/stopping (it|the server) kills the\s+sessions it/);
    assert.notStrictEqual(start, -1, `${file} must still carry the promise about stopping`);
    return text.slice(start, start + 2500);
  };

  for (const file of ENGLISH_DOCS) {
    it(`${file}: the bound is stated where the promise is`, () => {
      const text = promise(file);
      assert.match(text, /\bbounded\b|\bbound\b/, 'that the wait has a limit at all');
      assert.match(text, /descendant/, 'what an unbounded wait would be waiting for');
      assert.match(text, /log/, 'and what the board is waiting to have released');
    });

    it(`${file}: and what a reader sees when the bound ends the wait`, () => {
      const text = promise(file);
      assert.match(text, /`running`/, 'the record left behind, which is what looks broken');
      assert.match(text, /next start|next board start/, 'and that it is cleaned up later');
    });
  }
});

// T-0217: rules paid for one incident at a time and living only in the cards that
// caught them. Asserted for the same reason as everything above — an editing pass
// keeps the sentence and drops the operative half of it, which here is always the
// same half: the question that decides the case, the command that answers it, or
// the thing that must NOT be accepted as proof.
describe('the rules established over two days are written down (T-0217)', () => {
  const ORCHESTRATOR = 'agents/ORCHESTRATOR.md';

  // These rules are one or two wrapped lines each, so every phrase below is a
  // line break away from being unfindable. The assertions read the prose with its
  // wrapping collapsed: rewrapping a paragraph must not fail a test, and moving a
  // rule out of the document must.
  const prose = (text) => text.replace(/\s+/g, ' ');

  // Step 2 of the worker protocol, in either of its two copies.
  function implementStep(file) {
    const text = read(file);
    const start = text.indexOf('### 2. Implement');
    const end = text.indexOf('### 3. Submit for review');
    assert.ok(start !== -1 && end > start, `${file} must keep step 2 and step 3`);
    return prose(text.slice(start, end));
  }

  it(`${ORCHESTRATOR}: an absorbed task is cancelled, and depends on its host at once`, () => {
    const text = prose(section(ORCHESTRATOR, /^### 6\. Cancellation/m));

    assert.match(text, /absorbed/i, 'the case is named as its own');
    assert.match(text, /`cancelled`, not `done`/, 'and settled, since it was done three ways in a day');
    assert.match(text, /reviewed|merged/, 'with the reason `done` would be a lie');
    assert.match(text, /naming the host/i, 'the description says which task shipped it');
    // The half a shortened version drops, and the one a user caught first: without
    // it the card reads as abandoned for as long as the host takes.
    assert.match(text, /node tools\/task\.mjs depends/, 'the command, not just the idea');
    assert.match(text, /abandoned/i, 'and what the board shows while it is missing');
  });

  it(`${ORCHESTRATOR}: platform behaviour is measured before it is briefed`, () => {
    const text = prose(section(ORCHESTRATOR, /^### 3\. Briefing/m));

    assert.match(text, /[Mm]easure before/, 'the order of the two steps is the rule');
    assert.match(text, /sockets/, 'the kinds of claim that keep being wrong');
    assert.match(text, /probe/, 'and how cheaply the brief could have checked itself');
    assert.match(text, /T-0131[\s\S]{0,40}T-0133/, 'both briefs stay named');
  });

  it(`${ORCHESTRATOR}: a raised deadline has to answer what we stop noticing`, () => {
    const text = prose(section(ORCHESTRATOR, /^### 5\. Review/m));

    assert.match(text, /deadline/i, 'the decision the reviewer actually faces');
    assert.match(text, /stop noticing/, 'the question that decides it');
    assert.match(text, /"nothing"/, 'and the only answer that lets it through');
    assert.match(text, /measured/, 'the number comes from a measurement');
    assert.match(text, /green test/, 'against the one thing it may never buy');
  });

  // T-0110: the protocol is copied into projects with no npm and no suite of ours,
  // so a rule about our tests is false there. Both new CONTRIBUTING rules are about
  // this suite; this is the assertion that they stayed there.
  it(`${ORCHESTRATOR} keeps this repository's test suite out of the shipped protocol`, () => {
    assert.doesNotMatch(
      read(ORCHESTRATOR),
      /\bnpm (test|run)\b|\bpytest\b|\bcargo test\b|suite-hygiene/,
      `${ORCHESTRATOR} states something that is false in a project without our tests`
    );
  });

  it('CONTRIBUTING.md: the run is its own command, never chained to a status change', () => {
    const text = prose(section('CONTRIBUTING.md', /^## Running the tests/m));

    assert.match(text, /output in a file/i, 'the output outlives the terminal');
    assert.match(text, /[Cc]hained/, 'the shape of the mistake');
    assert.match(text, /status/, 'chained with what');
    assert.match(text, /before the result can be read/, 'and what that costs');
  });

  it('CONTRIBUTING.md: a guard that needs exemptions is named as dead', () => {
    const text = prose(section('CONTRIBUTING.md', /^## Running the tests/m));

    assert.match(text, /exemptions/, 'the symptom to watch for');
    assert.match(text, /dead guard/, 'and the verdict on it');
    // The rule is only actionable with its other half: what to write instead.
    assert.match(text, /\*shape\*|shape of the mistake/, 'the guard asserts a shape');
    assert.match(text, /T-0189/, 'the pass that produced it');
  });

  for (const file of ['agents/WORKER.md', '.claude/agents/worker.md']) {
    it(`${file}: a test is proved against the mistake it guards, not against the old commit`, () => {
      const step2 = implementStep(file);

      assert.match(step2, /fail on broken code/, 'a green test is not evidence by itself');
      assert.match(step2, /previous commit/, 'and the cheap proof that is not enough');
      assert.match(step2, /T-0130/);
      // The other way a test proves nothing while passing and failing correctly.
      assert.match(step2, /fixture/, 'the fixture is the second suspect');
      assert.match(step2, /assertion true by itself|satisfy the assertion/, 'what it must not be able to do');
      assert.match(step2, /T-0182/);
    });

    it(`${file}: a data migration is counted by something other than itself`, () => {
      const step2 = implementStep(file);

      assert.match(step2, /[Mm]igrat/, 'the case is named');
      assert.match(step2, /before and after/, 'counted on both sides');
      assert.match(step2, /independent/, 'by a means that is not the migration');
      assert.match(step2, /own counter/, 'which is the number that cannot disagree with itself');
      assert.match(step2, /T-0166/);
    });
  }
});

// T-0229: the same defect as the CLI reference above, one file further in. The
// header comment of server/server.js enumerates the HTTP routes, and it had gone
// three task actions short — `backlog`, `briefing` and `profile` were dispatched
// for weeks with nothing in the header saying so, because the only thing that
// could notice was a human reading both lists at once.
//
// Counted from the map that dispatches them, never from the prose next to it,
// and it needs no exemptions: an action is in TASK_ACTIONS or it is not a route.
const SERVER = 'server/server.js';

// Read by both blocks below — the server's own header and agents/PROTOCOL.md
// have each gone stale against this map, so both are held against it here.
function taskActions() {
  const map = /const TASK_ACTIONS = \{([^}]*)\}/.exec(read(SERVER));
  assert.ok(map, `${SERVER} must keep TASK_ACTIONS as a literal map — it is what this reads`);
  // Whatever the key looks like, quoted or not: a pattern that only accepted
  // plain words would skip the odd one instead of failing on it, and the
  // assertion about metacharacters below could never fire.
  const keys = [...map[1].matchAll(/^\s*(?:'([^']*)'|([^\s':]+))\s*:/gm)].map((m) => m[1] ?? m[2]);
  assert.ok(keys.length > 1, `only ${keys.length} action(s) were read out of TASK_ACTIONS`);
  return keys;
}

describe('the server header lists every task action it dispatches (T-0229)', () => {
  // The file's opening block comment: everything above the first `*/`.
  function headerComment() {
    const text = read(SERVER);
    const end = text.indexOf('*/');
    assert.notStrictEqual(end, -1, `${SERVER} must open with the block comment that lists its routes`);
    return text.slice(0, end);
  }

  it('every action in TASK_ACTIONS is named in the header', () => {
    const header = headerComment();
    for (const action of taskActions()) {
      assert.match(
        header,
        new RegExp(String.raw`/api/task/T-\d{4}/${action}\b`),
        `\`${action}\` is a route the header comment never shows`
      );
    }
  });

  it('the header names no task action the server does not dispatch', () => {
    const dispatched = taskActions();
    const listed = [...headerComment().matchAll(/\/api\/task\/T-\d{4}\/([\w-]+)/g)].map((m) => m[1]);
    assert.ok(listed.length, 'the header must go on listing the task routes');
    for (const action of listed) {
      assert.ok(
        dispatched.includes(action),
        `the header offers \`${action}\`, which TASK_ACTIONS does not dispatch`
      );
    }
  });

  // TASK_ACTION_RE is built by joining these keys with `|`, so a key carrying a
  // regex metacharacter would not 404 — it would quietly change what the router
  // accepts on every task route.
  it('the actions are plain words, because the route pattern is built from them', () => {
    for (const action of taskActions()) {
      assert.match(action, /^[a-z][a-z-]*$/, `\`${action}\` is not safe to join into a pattern`);
    }
  });
});

// T-0331: the same defect one document further out, and this one is the format
// contract agents read before their first write. Writing rule 6 of
// agents/PROTOCOL.md enumerates the endpoints through which the UI may reach the
// backlog AND counts them in words. Both had gone stale: it said "twelve narrow
// server endpoints" while the router dispatched fourteen, described neither
// `/rework` (T-0329) nor `/resume` (T-0333), and called `GET /api/git/:id` "a
// thirteenth route". A missing endpoint there reads as an endpoint that does not
// exist, and a number written as prose is exactly what nobody rechecks — so it is
// counted here, from the map that dispatches, never from the sentence beside it.
describe('PROTOCOL.md writing rule 6 lists and counts the router (T-0331)', () => {
  const PROTOCOL = 'agents/PROTOCOL.md';

  // Writing rule 6 runs from its numbered heading to the next `## ` section, or
  // to the end of the file while it is the last rule there.
  function rule6() {
    const text = read(PROTOCOL);
    const start = text.indexOf('\n6. **The exceptions**');
    assert.notStrictEqual(start, -1, `${PROTOCOL} must keep writing rule 6, which is what this reads`);
    const rest = text.slice(start + 1);
    const end = rest.indexOf('\n## ');
    return end === -1 ? rest : rest.slice(0, end);
  }

  // The one board route that writes the backlog and is not a task action:
  // creation posts to `/api/task` itself. Asserted against the server rather
  // than assumed, because the two counts below are `actions + 1` and a rename
  // there would otherwise leave them quietly one short.
  function boardEndpoints() {
    assert.match(
      read(SERVER),
      /url\.pathname === '\/api\/task'/,
      `${SERVER} must still answer POST /api/task — the counts below are the task actions plus it`
    );
    return taskActions().length + 1;
  }

  // Spelled out, because that is how the document is written. A table rather
  // than a dependency, and one that fails with instructions rather than silently
  // if the router ever grows past its range.
  const CARDINAL = { 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen', 17: 'seventeen' };
  const ORDINAL = { 13: 'thirteenth', 14: 'fourteenth', 15: 'fifteenth', 16: 'sixteenth', 17: 'seventeenth', 18: 'eighteenth' };

  // assert.ok rather than assert.match throughout: rule 6 is four screens of
  // prose, and a failure that prints all of it buries its own message.
  it('every action in TASK_ACTIONS is described in rule 6', () => {
    const rule = rule6();
    for (const action of taskActions()) {
      assert.ok(
        new RegExp(String.raw`/api/task/:id/${action}\b`).test(rule),
        `\`${action}\` is a route agents/PROTOCOL.md never describes`
      );
    }
  });

  it('rule 6 describes no task action the server does not dispatch', () => {
    const dispatched = taskActions();
    const listed = [...rule6().matchAll(/\/api\/task\/:id\/([\w-]+)/g)].map((m) => m[1]);
    assert.ok(listed.length, 'rule 6 must go on describing the task routes');
    for (const action of listed) {
      assert.ok(
        dispatched.includes(action),
        `rule 6 offers \`${action}\`, which TASK_ACTIONS does not dispatch`
      );
    }
  });

  it('the count in words is the number of endpoints the router really has', () => {
    const count = boardEndpoints();
    const word = CARDINAL[count];
    assert.ok(word, `extend CARDINAL: the router now has ${count} board endpoints`);
    const said = /through these ([a-z-]+) narrow server endpoints/.exec(rule6());
    assert.ok(said, 'rule 6 must open by counting the narrow server endpoints it then lists');
    assert.strictEqual(
      said[1],
      word,
      `rule 6 counts ${said[1]} narrow server endpoints; the router has ${count} (${word})`
    );
  });

  it('the read route GET /api/git is numbered one past them', () => {
    const nth = boardEndpoints() + 1;
    const word = ORDINAL[nth];
    assert.ok(word, `extend ORDINAL: GET /api/git/:id is now route ${nth}`);
    const said = /a ([a-z-]+) route, `GET \/api\/git\/:id`/.exec(rule6());
    assert.ok(said, 'rule 6 must go on numbering GET /api/git/:id against the writing routes');
    assert.strictEqual(
      said[1],
      word,
      `rule 6 calls GET /api/git/:id the ${said[1]} route; it is route ${nth} (${word})`
    );
  });
});

// T-0233: since T-0228 `BRIEFBOARD_WATCHDOG_MS` can only raise the floor — a
// value under it is raised, `0` included, and `off` is the only way to stop the
// board asking git. Three documents still described a setting that moves the
// floor either way, which is the kind of claim a reader acts on: they write `0`,
// believe the watchdog is off, and it is not.
//
// The strings asserted are not copies of the documents' sentences but the
// message `parseInterval` really prints, taken from it here. A sentence reworded
// in server/watchdog.js and nowhere else fails this, which is what keeps the
// quote in six documents honest — a fixture of our own could only prove itself.
describe('the watchdog floor is documented as a floor (T-0233)', () => {
  const { parseInterval, MIN_INTERVAL_MS } = require('../server/watchdog.js');

  const READMES = ['README.md', 'README.ru.md', 'README.ja.md'];
  const GUIDES = ['doc/guide/guide.en.md', 'doc/guide/guide.ru.md', 'doc/guide/guide.ja.md'];
  const DOCS = [...READMES, ...GUIDES];

  // A quote wraps across lines in prose and does not inside a fenced block; the
  // sentence a reader sees is the same one either way.
  const flat = (text) => text.replace(/\s+/g, ' ');

  const said = [];
  const chosen = parseInterval('0', { error: (m) => said.push(m) });
  const message = said.join(' ');
  const wayOut = message.slice(message.indexOf('Write "off"'));

  it('`0` is still raised to the floor and answered, not read as "off"', () => {
    assert.equal(chosen, MIN_INTERVAL_MS, '`0` must be raised to the floor, not disable the watchdog');
    assert.equal(said.length, 1, 'the board must say so once, on stderr');
    assert.equal(wayOut, 'Write "off" to stop the board asking git at all.');
  });

  for (const file of DOCS) {
    it(`${file}: quotes the way out the board itself names`, () => {
      assert.ok(
        flat(read(file)).includes(wayOut),
        `${file} must quote "${wayOut}" — it is what the board prints, and the only way to stop it`
      );
    });
  }

  for (const file of GUIDES) {
    it(`${file}: quotes the whole answer a below-floor value gets`, () => {
      assert.ok(
        flat(read(file)).includes(message),
        `${file} must show the message verbatim:\n${message}`
      );
    });
  }

  // The three literals the fix is about, in whatever prose the language uses:
  // the floor's value, the word that turns the watchdog off, and the value that
  // does not. Tokens rather than wording, so a translation cannot drift out of
  // the guard and no language needs an exemption of its own.
  for (const file of DOCS) {
    it(`${file}: names the floor, \`off\` and \`0\` where it introduces the setting`, () => {
      const text = flat(read(file));
      const at = text.indexOf('BRIEFBOARD_WATCHDOG_MS');
      assert.notStrictEqual(at, -1, `${file} must go on documenting BRIEFBOARD_WATCHDOG_MS`);
      const passage = text.slice(at, at + 500);
      assert.ok(
        passage.includes(String(MIN_INTERVAL_MS)),
        `${file} introduces the setting without naming ${MIN_INTERVAL_MS} as the floor`
      );
      assert.match(passage, /(`off`|"off")/, `${file} introduces the setting without naming \`off\``);
      assert.match(passage, /`0`/, `${file} must say what happens to \`0\`, which is what people write for "off"`);
    });
  }
});

// T-0232/T-0233/T-0234: the ready-to-copy session prompts are English in every
// document, translated or not. They are made of protocol tokens
// (`### Session questions`), variable names, paths and commands that are never
// translated anyway; a model follows an instruction more reliably in the
// language of those tokens; and two documents of one language disagreeing about
// what to copy is worse than either variant of it.
//
// tests/sessions.test.js already reads these same blocks, but only for their
// shape — the prompt before the flags, what `--allowedTools` grants, where the
// briefs are read from. Every one of those assertions passed on the Russian
// translations for as long as they existed, which is why the decision needs a
// guard of its own here.
describe('the shipped session prompts are the same English text everywhere (T-0234)', () => {
  const READMES = ['README.md', 'README.ru.md', 'README.ja.md'];
  const GUIDES = ['doc/guide/guide.en.md', 'doc/guide/guide.ru.md', 'doc/guide/guide.ja.md'];

  // The guides carry no ready-to-copy review command; the READMEs do. Naming the
  // documents each block belongs to is what makes a block that quietly went
  // missing fail here instead of passing by absence.
  // A block may be identified under a legacy name in some documents — T-0305
  // renamed the review command's variable in the English README while the
  // translations kept the old one until the release's translation pass
  // (CONTRIBUTING.md, T-0106), which T-0306 carried out. What is compared stays
  // what it always was: the prompt body, which the variable's name is not part of.
  const BLOCKS = [
    { name: 'BRIEFBOARD_SESSION_CMD', files: [...READMES, ...GUIDES] },
    { name: 'BRIEFBOARD_WORKER_CMD', files: [...READMES, ...GUIDES] },
    { name: 'BRIEFBOARD_REVIEW_CMD', files: READMES },
  ];

  const TAIL = "' \\\n  node server/server.js";

  const nameIn = (block, file) =>
    (block.legacyFiles || []).includes(file) ? block.legacyName : block.name;

  const promptBody = (block, file) => {
    const name = nameIn(block, file);
    const text = read(file);
    const start = text.indexOf(`${name}='`);
    assert.notStrictEqual(start, -1, `${file} must ship a ready-to-copy ${name}`);
    const end = text.indexOf(TAIL, start);
    assert.notStrictEqual(end, -1, `${name} in ${file} must end in the documented shape`);
    return text.slice(start + name.length + 2, end);
  };

  for (const block of BLOCKS) {
    const { name, files } = block;
    const [reference, ...rest] = files;
    for (const file of rest) {
      it(`${file}: ${nameIn(block, file)} is character-for-character ${reference}'s`, () => {
        assert.equal(
          promptBody(block, file),
          promptBody(block, reference),
          `${name} in ${file} must be the English text of ${reference}, byte for byte — ` +
            'the prose around the block is what carries the document\'s language'
        );
      });
    }

    // The comparison above only says the six agree; a prompt translated in the
    // English source too would keep them agreeing. Scripts no English prompt can
    // contain are what says which language they agree in.
    for (const file of files) {
      it(`${file}: ${nameIn(block, file)} carries no Cyrillic and no Japanese`, () => {
        const offenders = promptBody(block, file).match(/[Ѐ-ӿ぀-ヿ一-鿿]+/g);
        assert.equal(
          offenders,
          null,
          `${name} in ${file} has translated text in it: ${JSON.stringify(offenders)}`
        );
      });
    }
  }
});

// T-0254: `agentboard` is this project's earlier name. Left in the docs as a bare
// alias it stopped reading as history and became a claim about the present — the
// guides told a reader "the repository is also called `agentboard`" while it
// clones as `briefboard`, which is a plain untruth in the first paragraph a
// visitor reads. The old name may still be written down, and should be, so that
// whoever knew it finds the project; what it may not do is appear unmarked. So
// the assertion is on that shape and not on a list of allowed lines: a rewrap or
// a new sentence goes on passing, an unmarked alias does not, in any of the three
// languages.
describe('the old name appears only as a former name (T-0254)', () => {
  // T-0255: CONTRIBUTING.md was outside T-0254's list and kept the same unmarked
  // alias through that sweep, with nothing left watching it. The export carries
  // the file to GitHub, so it lives under the same rule as the six above.
  const PUBLIC_DOCS = [
    'README.md',
    'README.ru.md',
    'README.ja.md',
    'doc/guide/guide.en.md',
    'doc/guide/guide.ru.md',
    'doc/guide/guide.ja.md',
    'CONTRIBUTING.md',
  ];

  // Enough of each language to say "this used to be its name". A translation pass
  // that reaches for a word missing from here fails loudly and adds it, which is
  // the right way round: the alternative is a guard that cannot see the Japanese.
  const FORMER_NAME_MARKERS = [
    /formerly|earlier name|previously|used to be/i,
    // `\w` is ASCII-only in a JavaScript regexp, so the Cyrillic ranges are spelled out.
    /прежн[а-яё]+ (название|имя)|называл[а-яё]+ раньше|раньше/i,
    /旧名|旧称|以前/,
  ];

  // Paragraphs, not lines: the marker and the name land in one sentence, and a
  // later rewrap moves the line break without moving the sentence.
  const paragraphs = (text) => text.split(/\n\s*\n/);

  for (const file of PUBLIC_DOCS) {
    it(`${file}: every \`agentboard\` is marked as the name that used to be`, () => {
      // Case-sensitive on purpose. `AGENTBOARD_ROOT` is the live variable name,
      // documented in these same files and not renamed by this task (T-0249).
      const unmarked = paragraphs(read(file))
        .filter((paragraph) => paragraph.includes('agentboard'))
        .filter((paragraph) => !FORMER_NAME_MARKERS.some((marker) => marker.test(paragraph)));

      assert.deepEqual(
        unmarked,
        [],
        `${file} carries \`agentboard\` without saying it is the former name — ` +
          'either mark it as the old name or write `briefboard`'
      );
    });
  }
});

// T-0256: CONTRIBUTING.md said `test:verbose` passed `--test-timeout` itself,
// and that stopped being true an hour after it was written — T-0250 routed both
// scripts through `tools/test-run.mjs`, so the limit is now defined there once.
// A document's claim about an npm script is checkable against package.json, so
// it is checked here rather than reread: which scripts get the wrapper's
// protection, that none of them carries a limit of its own, and what the wrapper
// protects them from.
describe('CONTRIBUTING.md describes the test wrapper that exists (T-0256)', () => {
  const WRAPPER = 'tools/test-run.mjs';
  const running = () => section('CONTRIBUTING.md', /^## Running the tests/m);

  const wrappedScripts = () => {
    const pkg = JSON.parse(read('package.json'));
    const scripts = Object.entries(pkg.scripts).filter(([, command]) => command.includes(WRAPPER));
    assert.ok(scripts.length > 1, `package.json must keep more than one script on ${WRAPPER}`);
    return scripts;
  };

  it('every script that runs the suite is named where the wrapper is described', () => {
    const text = running();
    assert.ok(text.includes(WRAPPER), `the section must name ${WRAPPER} as what the scripts run`);
    for (const [name] of wrappedScripts()) {
      assert.ok(text.includes(name), `\`${name}\` runs the suite and the section never shows it`);
    }
  });

  // The sentence the section now rests on is "the limit is defined in one place":
  // a script that grew a copy of the flag would make it false again, in exactly
  // the way it was false before, and the doc alone cannot notice.
  it('no npm script carries a per-test limit of its own', () => {
    for (const [name, command] of wrappedScripts()) {
      assert.doesNotMatch(
        command,
        /--test-timeout/,
        `\`${name}\` sets its own limit — CONTRIBUTING.md says ${WRAPPER} defines it once`
      );
    }
    assert.match(read(WRAPPER), /--test-timeout=/, `${WRAPPER} is where the limit is set`);
  });

  it('names all three runs the wrapper refuses', () => {
    const text = running();

    assert.match(text, /git status --porcelain/, 'the working copy a run has to give back (T-0111)');
    // The kill reaches the grandchild running the test file, not just the runner
    // — the half that makes the guard work on Windows (T-0244).
    assert.match(text, /process \*{0,2}tree/, 'the silent run, and how far the kill reaches');
    assert.match(text, /executed nothing|executed no tests/, 'and the run that ran nothing (T-0250)');
  });
});

// T-0254: this file is read once per release, by someone about to publish, and
// three of its facts had gone false. The npm token one cost a release attempt:
// RELEASING.md said a classic Automation token bypasses 2FA, and the registry
// answered `403 ... granular access token with bypass 2fa enabled is required`.
// A checklist is worth exactly what its statements are worth, so the corrections
// get a guard rather than a reader's memory.
describe('RELEASING.md tells the truth about publishing (T-0254)', () => {
  // Same reasoning as the translation-step check above: the export drops this
  // file, so the public tree has nothing to read (T-0252).
  const skip = skipOutsideExport('RELEASING.md');

  it('names the token type the registry actually accepts', { skip }, () => {
    const text = read('RELEASING.md');
    assert.match(text, /granular access token/i, 'the token type that publishes');
    assert.match(text, /bypass/i, 'and the option on it that has to be enabled explicitly');
    assert.match(text, /Read and write/i, 'and the permission it needs on the package');
  });

  it('leaves no Automation token standing as the way to publish', { skip }, () => {
    // The word itself may stay — a reader who set one up needs to be told it
    // stopped working — but only inside the paragraph that says so.
    const stale = read('RELEASING.md')
      .split(/\n\s*\n/)
      .filter((paragraph) => /Automation/.test(paragraph))
      .filter((paragraph) => !/no longer/i.test(paragraph));

    assert.deepEqual(stale, [], 'an Automation token is named without saying it no longer publishes');
  });

  it('warns that the token cannot be checked before the publish', { skip }, () => {
    const text = read('RELEASING.md');
    assert.match(text, /npm whoami/, 'the command that passes with a token that cannot publish');
    assert.match(text, /atomic/, 'and why a refusal at publish is survivable: the version stays free');
  });

  it('the Status section reads the version off the registry instead of naming it', { skip }, () => {
    const status = section('RELEASING.md', /^## Status/im);
    assert.match(status, /npm view briefboard versions?/, 'the command that cannot go stale');
    assert.doesNotMatch(
      status,
      /latest[^\n]*\d+\.\d+\.\d+/i,
      'a latest version written here is wrong one release later — this section named 0.1.1 while npm served 0.2.0'
    );
  });
});

// T-0296: `update`'s category table is written five times — `CATEGORIES` in
// bin/briefboard-init.mjs, a table in each of the three guides, and a prose list
// in README.md — and until now nothing counted them against each other. T-0294
// added two categories at once and changed a third's behaviour; the review that
// caught the stale rows was a person reading five lists side by side, which is
// exactly the check that should not be a human's job.
//
// The names are read out of the code, never carried here as an array of our own:
// a copy would go stale the way the documents did and would then assert that two
// stale lists agree, which is worse than no test at all. Same reasoning, and the
// same technique, as the route list of T-0229 above.
describe('the documented update categories are the ones the code produces (T-0296)', () => {
  const INIT = 'bin/briefboard-init.mjs';
  const GUIDES = ['doc/guide/guide.en.md', 'doc/guide/guide.ru.md', 'doc/guide/guide.ja.md'];
  const README = 'README.md';

  // Parsed rather than imported. bin/briefboard-init.mjs is ESM against a CJS
  // suite, so `require` is out — but `await import()` is out too, and for a worse
  // reason than the module system: the file dispatches on `process.argv` at the
  // top level, so importing it under the test runner reads the runner's own argv,
  // falls through to `usageError` and takes the process down.
  function categories() {
    const source = read(INIT);
    const list = /const CATEGORIES = \[([^\]]*)\]/.exec(source);
    assert.ok(list, `${INIT} must keep CATEGORIES as a literal array — it is what this test reads`);

    const names = list[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    assert.ok(names.length > 1, `only ${names.length} name(s) were read out of CATEGORIES in ${INIT}`);

    return names.map((name) => {
      // The name is spliced into a pattern below, so it has to be a plain
      // identifier — an entry this cannot resolve fails here rather than quietly
      // matching nothing.
      assert.match(name, /^[A-Za-z_$][\w$]*$/, `CATEGORIES holds \`${name}\`, which is not a constant this can resolve`);
      const assigned = new RegExp(String.raw`^const ${name} = '([^']*)';`, 'm').exec(source);
      assert.ok(assigned, `CATEGORIES names ${name}, and ${INIT} has no \`const ${name} = '...'\` to resolve it to`);
      return assigned[1];
    });
  }

  // The one table in a guide whose header row names `--apply`. That flag and the
  // category strings themselves are untranslated in all three files — which is
  // the only reason the Russian and Japanese tables can be counted at all.
  function tableRows(file) {
    const lines = read(file).split('\n');
    const headers = lines.map((line, i) => [line, i]).filter(([line]) => /^\|/.test(line) && /`--apply`/.test(line));
    assert.strictEqual(
      headers.length,
      1,
      `${file} must carry exactly one \`--apply\` category table, and ${headers.length} were found`
    );

    const rows = [];
    for (let i = headers[0][1] + 1; i < lines.length && lines[i].startsWith('|'); i++) {
      const first = lines[i].split('|')[1].trim();
      if (/^:?-+:?$/.test(first)) continue; // the header separator
      const name = /^`(.+)`$/.exec(first);
      assert.ok(
        name,
        `${file}: the category table row \`${lines[i].slice(0, 60)}\` has no backticked category in its first column`
      );
      rows.push(name[1]);
    }
    assert.ok(rows.length, `${file}: the \`--apply\` category table has no rows`);
    return rows;
  }

  // README's list is prose, not a table, so it is read as the backticked tokens
  // of the bullet that carries it, minus the three kinds of token that plainly
  // are not categories: a flag, a file name, and the command itself.
  function readmeNames() {
    const bullet = section(README, /^## Updating an installed project/im)
      .split(/\n- /)
      .find((item) => /The plan comes first/.test(item));
    assert.ok(bullet, `${README}: the update section must keep the bullet that lists the categories`);

    const tokens = [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    return tokens.filter((t) => !t.startsWith('-') && !t.endsWith('.md') && !t.startsWith('briefboard '));
  }

  for (const file of GUIDES) {
    it(`${file}: every category the code produces has a row`, () => {
      const rows = tableRows(file);
      for (const category of categories()) {
        assert.ok(
          rows.includes(category),
          `${file}: \`${category}\` is a category \`update\` prints and the table has no row for it`
        );
      }
    });

    it(`${file}: every row names a category the code produces`, () => {
      const produced = categories();
      for (const row of tableRows(file)) {
        assert.ok(
          produced.includes(row),
          `${file}: the table has a row for \`${row}\`, which \`update\` does not print`
        );
      }
    });
  }

  // Order, not only membership: the three tables are read side by side whenever a
  // translation is checked, and a row that moved is the same drift as a row that
  // went missing — one document explaining the categories in another sequence.
  for (const file of GUIDES.slice(1)) {
    it(`${file}: the table carries the same rows in the same order as guide.en.md`, () => {
      const english = tableRows(GUIDES[0]);
      const rows = tableRows(file);
      for (let i = 0; i < Math.max(english.length, rows.length); i++) {
        assert.strictEqual(
          rows[i],
          english[i],
          `${file}: row ${i + 1} is \`${rows[i] ?? '(missing)'}\` where guide.en.md has \`${english[i] ?? '(missing)'}\``
        );
      }
    });
  }

  it(`${README}: the prose list names every category the code produces`, () => {
    const named = readmeNames();
    for (const category of categories()) {
      assert.ok(
        named.includes(category),
        `${README}: \`${category}\` is a category \`update\` prints and the prose list never names it`
      );
    }
  });

  it(`${README}: the prose list names no category the code does not produce`, () => {
    const produced = categories();
    for (const name of readmeNames()) {
      assert.ok(
        produced.includes(name),
        `${README}: the prose list names \`${name}\`, which \`update\` does not print`
      );
    }
  });
});

// T-0325: `in_progress` means an agent is on the task, and a dispatch that never
// reached a session puts the task back. A guarantee a reader cannot find is one
// nobody relies on — and this one changes what a status MEANS, which is the
// guide's own subject. Asserted against the section rather than the file: a
// sentence somewhere in three thousand lines is not the same as the promise
// standing where a reader meets the drop.
describe('the guide states what in_progress guarantees (T-0325)', () => {
  const GUIDE = 'doc/guide/guide.en.md';
  const workerSession = () => section(GUIDE, /^#{2,4} The worker session/im);

  it(`${GUIDE}: the worker-session section says a failed dispatch puts the task back`, () => {
    const text = workerSession();
    assert.match(text, /puts the task back/i, 'the guarantee itself');
    assert.match(text, /restores `ready`/, 'in the words of the status it restores');
    assert.match(
      text,
      /`in_progress`\s*\n?means an agent is on the task|`in_progress` means an agent is on the task/i,
      'and what the guarantee is about'
    );
  });

  it(`${GUIDE}: it names the two answers that keep the card, and the condition on the repair`, () => {
    const text = workerSession();
    assert.match(text, /`already-running`/, 'a live session for the task keeps it');
    assert.match(text, /`disabled`/, 'and so does a board with no worker command');
    assert.match(
      text,
      /moved in the meantime/i,
      'a repair that could overrule somebody else\'s decision would be worse than the state it fixes'
    );
  });
});

// T-0333: three commands now put a worker on a card, and they differ only in the
// status each begins from. Documented apart, they are exactly where a reader
// picks the wrong one - so the guide has to show them together, and this is what
// keeps a later edit from splitting them up again. The claim is checked against
// the SECTION, not the file: three names scattered over three thousand lines are
// not the same as three names in one place.
describe('the guide shows the three dispatches side by side (T-0333)', () => {
  const GUIDE = 'doc/guide/guide.en.md';
  const resuming = () => section(GUIDE, /^#{2,4} When the session dies/im);

  it(`${GUIDE}: one passage names all three, with the status each begins from`, () => {
    const text = resuming();
    for (const [command, from] of [['start', 'ready'], ['rework', 'review'], ['resume', 'in_progress']]) {
      const row = new RegExp('`' + command + '`[^\\n|]*\\|[^\\n|]*`' + from + '`');
      assert.match(text, row, `${command} must be shown together with the status it begins from`);
    }
  });

  it(`${GUIDE}: it says what makes this one different - it moves nothing`, () => {
    const text = resuming();
    assert.match(text, /writes no status|does not move/i, 'the card stays where it is');
    assert.match(text, /registry/i, 'a live session is read from the registry, not from the status');
    assert.match(text, /### Session questions/, 'and what this replaces is named, not hinted at');
  });
});
