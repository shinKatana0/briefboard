'use strict';

// Tests for tools/task.mjs -- the CLI agents use to edit doc/backlog.md / doc/brief/.
// Labels as a query: --label across the commands that take it.
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
const { MAX_LABEL_LEN, MAX_LABELS } = require('../server/parser.js');
const {
  runCli,
  makeTmpRoot,
  backlogPath,
  add,
} = require('./helpers/task-cli.js');

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
