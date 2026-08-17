'use strict';

// Tests for server/parser.js — the backlog.md <-> task-object (de)serializer.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const os = require('node:os');

const {
  parseBacklog,
  parsePreamble,
  serializeBacklog,
  DEFAULT_PREAMBLE,
  ARCHIVE_PREAMBLE,
  archiveClosedTasks,
  archivePathFor,
  nowStamp,
  STATUSES,
  PRIORITIES,
  TASK_TYPES,
  BRIEF_ID_RE,
  TASK_ID_RE,
  blockingDependencies,
  awaitsAnswer,
  hasSessionQuestions,
  appendDescriptionSection,
  SESSION_QUESTIONS_SECTION,
  SESSION_QUESTIONS_HEADING,
  ANSWERS_SECTION,
  ANSWERS_HEADING,
  REVIEW_VERDICT_SECTION,
  REVIEW_VERDICT_HEADING,
  CHRONOLOGICAL_SECTIONS,
  WORKER_REPORT_SECTION,
  LEGACY_WORKER_REPORT_SECTION,
  stripWorkerReports,
  ANSWER_STATUSES,
  countReviewVerdicts,
  dependencyCycles,
  findBriefFile,
  addTask,
  updateBacklog,
  KNOWN_FIELDS,
  FIELD_RE,
} = require('../server/parser.js');

const BACKLOG_PATH = path.join(__dirname, '..', 'doc', 'backlog.md');

describe('STATUSES / PRIORITIES constants', () => {
  it('STATUSES lists the 7 lifecycle statuses in order', () => {
    assert.deepStrictEqual(STATUSES, [
      'backlog',
      'open',
      'ready',
      'in_progress',
      'review',
      'done',
      'cancelled',
    ]);
  });

  it('PRIORITIES lists the 5 priorities in order', () => {
    assert.deepStrictEqual(PRIORITIES, ['Blocker', 'Critical', 'Major', 'Medium', 'Minor']);
  });

  it('TASK_TYPES lists the 3 task types, external among them (T-0092)', () => {
    assert.deepStrictEqual(TASK_TYPES, ['feature', 'bug', 'external']);
  });
});

describe('nowStamp()', () => {
  it('matches the "YYYY-MM-DD HH:MM:SS" format', () => {
    const stamp = nowStamp();
    assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('reflects the current local time (within a few seconds tolerance, no Date mocking)', () => {
    const before = new Date();
    const stamp = nowStamp();
    const after = new Date();

    // Parse "YYYY-MM-DD HH:MM:SS" as local time components (not via Date parsing
    // of the string, since that would be ambiguous re: timezone).
    const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    assert.ok(m, 'stamp must match expected format');
    const [, y, mo, d, h, mi, s] = m.map(Number);
    const stampMs = new Date(y, mo - 1, d, h, mi, s).getTime();

    const toleranceMs = 5000;
    assert.ok(
      stampMs >= before.getTime() - toleranceMs && stampMs <= after.getTime() + toleranceMs,
      `nowStamp() ${stamp} should be within tolerance of "before" (${before.toISOString()}) / "after" (${after.toISOString()})`
    );
  });
});

describe('parseBacklog()', () => {
  it('returns [] for empty text', () => {
    assert.deepStrictEqual(parseBacklog(''), []);
  });

  it('parses id/priority/title from the header line', () => {
    const text = '## T-0007 · Major · Export report to CSV\n- type: feature\n';
    const tasks = parseBacklog(text);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].id, 'T-0007');
    assert.strictEqual(tasks[0].priority, 'Major');
    assert.strictEqual(tasks[0].title, 'Export report to CSV');
  });

  it('parses type/status/created/closed/briefs fields', () => {
    const text = [
      '## T-0011 · Critical · Some task',
      '- type: bug',
      '- status: in_progress',
      '- created: 2026-01-02 03:04:05',
      '- closed: 2026-01-03 10:00:00',
      '- briefs: T-0011-01, T-0011-02',
      '',
    ].join('\n');
    const [t] = parseBacklog(text);
    assert.strictEqual(t.type, 'bug');
    assert.strictEqual(t.status, 'in_progress');
    assert.strictEqual(t.created, '2026-01-02 03:04:05');
    assert.strictEqual(t.closed, '2026-01-03 10:00:00');
    assert.deepStrictEqual(t.briefs, ['T-0011-01', 'T-0011-02']);
  });

  it('defaults unknown priority to Medium (HEADER_RE only recognizes the 5 named priorities as a ' +
    'header at all, so a truly out-of-range priority like "Extreme" is never captured as a header - ' +
    'it is not treated as a task line)', () => {
    const text = '## T-0001 · Extreme · Bad priority\n- type: feature\n';
    assert.deepStrictEqual(parseBacklog(text), []);

    // All 5 in-range priorities round-trip through the Medium default logic without being altered.
    for (const p of PRIORITIES) {
      const [t] = parseBacklog(`## T-0002 · ${p} · Valid priority\n- type: feature\n`);
      assert.strictEqual(t.priority, p);
    }
  });

  it('defaults unknown/missing status to backlog', () => {
    const text = '## T-0001 · Major · No status field\n- type: feature\n';
    const [t] = parseBacklog(text);
    assert.strictEqual(t.status, 'backlog');

    const text2 = '## T-0002 · Major · Bad status\n- type: feature\n- status: not_a_real_status\n';
    const [t2] = parseBacklog(text2);
    assert.strictEqual(t2.status, 'backlog');
  });

  it('defaults type to feature when the field is missing or not a known type', () => {
    const noType = parseBacklog('## T-0001 · Major · No type field\n- status: open\n')[0];
    assert.strictEqual(noType.type, 'feature');

    const otherType = parseBacklog('## T-0002 · Major · Weird type\n- type: chore\n')[0];
    assert.strictEqual(otherType.type, 'feature');
  });

  it('parses every known type verbatim, external included (T-0092)', () => {
    for (const type of TASK_TYPES) {
      const [t] = parseBacklog(`## T-0003 · Major · Typed task\n- type: ${type}\n`);
      assert.strictEqual(t.type, type);
    }
  });

  it('turns closed: — (em dash) into an empty string', () => {
    const text = '## T-0001 · Major · Closed dash\n- type: feature\n- closed: —\n';
    const [t] = parseBacklog(text);
    assert.strictEqual(t.closed, '');
  });

  it('turns an empty closed: field into an empty string', () => {
    const text = '## T-0001 · Major · Closed empty\n- type: feature\n- closed:\n';
    const [t] = parseBacklog(text);
    assert.strictEqual(t.closed, '');
  });

  it('parses briefs via BRIEF_ID_RE, filtering out non-matching entries', () => {
    const text =
      '## T-0007 · Major · Briefs\n- type: feature\n- briefs: T-0007-01, not-a-brief, T-0007-02, T-7-01, T-0007-1\n';
    const [t] = parseBacklog(text);
    assert.deepStrictEqual(t.briefs, ['T-0007-01', 'T-0007-02']);
  });

  it('returns [] for briefs when the field is empty', () => {
    const text = '## T-0007 · Major · No briefs\n- type: feature\n- briefs:\n';
    const [t] = parseBacklog(text);
    assert.deepStrictEqual(t.briefs, []);
  });

  it('parses depends via TASK_ID_RE, tolerating stray spaces and filtering non-ids (T-0087)', () => {
    const text =
      '## T-0007 · Major · Depends\n- type: feature\n- depends:  T-0012 ,T-0034,   nope, T-12, T-0034-01\n';
    const [t] = parseBacklog(text);
    assert.deepStrictEqual(t.depends, ['T-0012', 'T-0034']);
  });

  it('returns [] for depends when the field is empty or absent (T-0087)', () => {
    const empty = parseBacklog('## T-0007 · Major · Empty\n- type: feature\n- depends:\n')[0];
    assert.deepStrictEqual(empty.depends, []);
    const absent = parseBacklog('## T-0008 · Major · Absent\n- type: feature\n')[0];
    assert.deepStrictEqual(absent.depends, []);
  });

  it('TASK_ID_RE matches a bare task id only (not a brief id)', () => {
    assert.ok(TASK_ID_RE.test('T-0087'));
    assert.ok(!TASK_ID_RE.test('T-0087-01'));
    assert.ok(!TASK_ID_RE.test('T-87'));
  });

  it('keeps a multiline description as-is (blank lines, lists, code blocks), trimmed at the edges', () => {
    const text = [
      '## T-0007 · Major · Multiline description',
      '- type: feature',
      '- status: open',
      '',
      'First paragraph of the description.',
      '',
      '- list item one',
      '- list item two',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
    ].join('\n');
    const [t] = parseBacklog(text);
    assert.strictEqual(
      t.description,
      [
        'First paragraph of the description.',
        '',
        '- list item one',
        '- list item two',
        '',
        '```js',
        'const x = 1;',
        '```',
      ].join('\n')
    );
  });

  it('splits several consecutive tasks correctly by ## T-... headers', () => {
    const text = [
      '## T-0001 · Critical · First task',
      '- type: feature',
      '- status: done',
      '',
      'Description of first task.',
      '',
      '## T-0002 · Minor · Second task',
      '- type: bug',
      '- status: open',
      '',
      'Description of second task.',
      '',
      '## T-0003 · Major · Third task',
      '- type: feature',
      '- status: ready',
    ].join('\n');
    const tasks = parseBacklog(text);
    assert.strictEqual(tasks.length, 3);
    assert.deepStrictEqual(
      tasks.map((t) => t.id),
      ['T-0001', 'T-0002', 'T-0003']
    );
    assert.strictEqual(tasks[0].description, 'Description of first task.');
    assert.strictEqual(tasks[1].description, 'Description of second task.');
    assert.strictEqual(tasks[2].description, '');
  });

  it('ignores any preamble/comments before the first ## T-... header', () => {
    const text = [
      '# Backlog',
      '',
      '<!-- some comment about the file format -->',
      'Free-floating preamble text that must not leak into any task.',
      '',
      '## T-0001 · Major · Real task',
      '- type: feature',
      '',
      'Actual description.',
    ].join('\n');
    const tasks = parseBacklog(text);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].description, 'Actual description.');
    for (const t of tasks) {
      assert.ok(!t.description.includes('preamble'));
    }
  });

  it('reads fields even when a blank line sits between the header and the first field (T-0055)', () => {
    // A human/agent inserted a blank line after "## T-XXXX" for readability. The
    // fields below it must still be parsed as fields, not leak into the
    // description and leave the task on defaults.
    const text = [
      '## T-0055 · Major · Blank line before fields',
      '',
      '- type: bug',
      '- status: ready',
      '- created: 2026-01-02 03:04:05',
      '- closed: 2026-01-03 10:00:00',
      '- briefs: T-0055-01',
      '',
      'Real description here.',
    ].join('\n');
    const [t] = parseBacklog(text);
    assert.strictEqual(t.type, 'bug');
    assert.strictEqual(t.status, 'ready');
    assert.strictEqual(t.created, '2026-01-02 03:04:05');
    assert.strictEqual(t.closed, '2026-01-03 10:00:00');
    assert.deepStrictEqual(t.briefs, ['T-0055-01']);
    assert.strictEqual(t.description, 'Real description here.');
  });

  it('reads fields even when blank lines sit BETWEEN field lines (T-0055)', () => {
    const text = [
      '## T-0055 · Minor · Blank lines between fields',
      '- type: bug',
      '',
      '- status: ready',
      '',
      '',
      '- created: 2026-01-02 03:04:05',
      '',
      'Description body.',
    ].join('\n');
    const [t] = parseBacklog(text);
    assert.strictEqual(t.type, 'bug');
    assert.strictEqual(t.status, 'ready');
    assert.strictEqual(t.created, '2026-01-02 03:04:05');
    assert.strictEqual(t.description, 'Description body.');
  });

  it('the normal "fields, blank line, description" format is unchanged and blank lines inside the description survive (T-0055 regression)', () => {
    const text = [
      '## T-0055 · Major · Normal shape',
      '- type: feature',
      '- status: open',
      '',
      'First paragraph.',
      '',
      'Second paragraph.',
    ].join('\n');
    const [t] = parseBacklog(text);
    assert.strictEqual(t.type, 'feature');
    assert.strictEqual(t.status, 'open');
    assert.strictEqual(t.description, 'First paragraph.\n\nSecond paragraph.');
  });

  it('yields description: "" for a task with no description (immediately followed by next header or EOF)', () => {
    const followedByHeader = parseBacklog(
      '## T-0001 · Major · No desc\n- type: feature\n## T-0002 · Major · Next\n- type: feature\n'
    );
    assert.strictEqual(followedByHeader[0].description, '');

    const atEof = parseBacklog('## T-0001 · Major · No desc\n- type: feature\n');
    assert.strictEqual(atEof[0].description, '');
  });
});

describe('serializeBacklog()', () => {
  // A sentinel preamble distinct from the built-in default, which is what an
  // omitted argument asks for. Since T-0167 '' is not the same request: it means
  // "this file has no preamble" and is written back as none.
  const SENTINEL_PREAMBLE = 'PREAMBLE\n';

  const task = {
    id: 'T-0007',
    priority: 'Major',
    title: 'Export report to CSV',
    type: 'feature',
    status: 'ready',
    created: '2026-01-01 00:00:00',
    closed: '',
    briefs: ['T-0007-01'],
    description: 'Some description.',
  };

  it('serializes a single task in the expected text format', () => {
    const out = serializeBacklog([task], SENTINEL_PREAMBLE);
    const expectedBody = [
      '## T-0007 · Major · Export report to CSV',
      '- type: feature',
      '- status: ready',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: T-0007-01',
      '',
      'Some description.',
    ].join('\n');
    assert.strictEqual(out, SENTINEL_PREAMBLE + '\n' + expectedBody + '\n');
  });

  it('separates multiple tasks with a blank line between them', () => {
    const task2 = { ...task, id: 'T-0008', title: 'Second task', description: 'Second description.' };
    const out = serializeBacklog([task, task2], SENTINEL_PREAMBLE);
    const expectedBody =
      [
        '## T-0007 · Major · Export report to CSV',
        '- type: feature',
        '- status: ready',
        '- created: 2026-01-01 00:00:00',
        '- closed: —',
        '- briefs: T-0007-01',
        '',
        'Some description.',
      ].join('\n') +
      '\n\n' +
      [
        '## T-0008 · Major · Second task',
        '- type: feature',
        '- status: ready',
        '- created: 2026-01-01 00:00:00',
        '- closed: —',
        '- briefs: T-0007-01',
        '',
        'Second description.',
      ].join('\n');
    assert.strictEqual(out, SENTINEL_PREAMBLE + '\n' + expectedBody + '\n');
  });

  it('renders an empty closed field as —', () => {
    const out = serializeBacklog([{ ...task, closed: '' }], SENTINEL_PREAMBLE);
    assert.match(out, /- closed: —/);
    assert.ok(!out.includes('- closed: \n'));
  });

  it('renders briefs: [] as an empty string after "briefs:"', () => {
    const out = serializeBacklog([{ ...task, briefs: [] }], SENTINEL_PREAMBLE);
    // The field line is "- briefs: " (label + trailing space, no id) followed by a newline.
    assert.ok(out.includes('- briefs: \n'));
    assert.ok(!out.includes('T-0007-01'));
  });

  it('omits the depends line entirely when the list is empty (T-0087)', () => {
    const out = serializeBacklog([{ ...task, depends: [] }], SENTINEL_PREAMBLE);
    assert.ok(!out.includes('depends'));
    const legacy = serializeBacklog([task], SENTINEL_PREAMBLE); // no depends key at all
    assert.ok(!legacy.includes('depends'));
  });

  it('writes depends as a comma-separated list right after briefs (T-0087)', () => {
    const out = serializeBacklog([{ ...task, depends: ['T-0001', 'T-0002'] }], SENTINEL_PREAMBLE);
    assert.ok(out.includes('- briefs: T-0007-01\n- depends: T-0001, T-0002\n'));
    assert.deepStrictEqual(parseBacklog(out)[0].depends, ['T-0001', 'T-0002']);
  });

  it('omits the profile line entirely when there is no profile (T-0108)', () => {
    assert.ok(!serializeBacklog([{ ...task, profile: '' }], SENTINEL_PREAMBLE).includes('profile'));
    assert.ok(!serializeBacklog([task], SENTINEL_PREAMBLE).includes('profile')); // no key at all
  });

  it('writes profile after depends, and reads it back verbatim (T-0108)', () => {
    const out = serializeBacklog(
      [{ ...task, depends: ['T-0001'], profile: 'fast mode' }],
      SENTINEL_PREAMBLE
    );
    assert.ok(out.includes('- depends: T-0001\n- profile: fast mode\n'));
    assert.strictEqual(parseBacklog(out)[0].profile, 'fast mode');
  });

  it('never interprets the profile value: it is the user\'s string (T-0108)', () => {
    for (const value of ['fast', '--model', 'Opus 4.5', 'なんでも']) {
      const out = serializeBacklog([{ ...task, profile: value }], SENTINEL_PREAMBLE);
      assert.strictEqual(parseBacklog(out)[0].profile, value);
    }
  });

  it('uses a custom preamble when provided', () => {
    const custom = '# Custom Header\n\nCustom intro text.\n';
    const out = serializeBacklog([task], custom);
    assert.ok(out.startsWith(custom));
  });

  it('uses the default preamble (matching serializeBacklog([])) when none is provided', () => {
    const out = serializeBacklog([task]);
    const outFirstHeaderIdx = out.search(/^## T-\d{4}/m);
    assert.ok(outFirstHeaderIdx > 0);
    const outPreamble = out.slice(0, outFirstHeaderIdx);

    // Cross-check the default preamble deterministically against
    // serializeBacklog([]) instead of the real doc/backlog.md, so this test also
    // passes in a clean public snapshot whose backlog is an empty starter.
    // serializeBacklog([]) emits nothing but the default preamble: it is
    // `head + '\n' + '' + '\n'`, i.e. the preamble followed by a trailing blank
    // line for the (empty) body. Dropping that final newline yields exactly the
    // preamble region that precedes the first task header above.
    const emptyOut = serializeBacklog([]);
    assert.ok(emptyOut.endsWith('\n\n'));
    const defaultPreamble = emptyOut.slice(0, -1);

    assert.strictEqual(outPreamble, defaultPreamble);
  });

  it('writes no head at all for an empty preamble, and only omission asks for the default (T-0167)', () => {
    const out = serializeBacklog([task], '');
    assert.ok(out.startsWith('## T-0007 '));
    assert.ok(!out.includes('# Backlog'));
    assert.ok(serializeBacklog([task]).startsWith(DEFAULT_PREAMBLE));
  });
});

describe('parsePreamble() (T-0167)', () => {
  it('returns the text above the first task header, ending in a single newline', () => {
    const text = ['# Backlog', '', '<!-- note -->', '', '## T-0001 · Major · A', '- type: feature'].join('\n');
    assert.strictEqual(parsePreamble(text), '# Backlog\n\n<!-- note -->\n');
  });

  it('returns null for an empty or blank file, so a new backlog still gets the default head', () => {
    assert.strictEqual(parsePreamble(''), null);
    assert.strictEqual(parsePreamble('   \n\n'), null);
    assert.strictEqual(parsePreamble(undefined), null);
  });

  it('distinguishes "no preamble" from "no file": a file starting at a task yields ""', () => {
    assert.strictEqual(parsePreamble('## T-0001 · Major · A\n- type: feature\n'), '');
  });

  it('treats a file with no task header as all preamble', () => {
    assert.strictEqual(parsePreamble('# Backlog\n\nNothing here yet.\n'), '# Backlog\n\nNothing here yet.\n');
  });

  it('does not normalize what a human wrote: blank lines and indentation inside survive', () => {
    const head = '#   Backlog\n\n\n   indented note\n\n<!-- multi\n     line -->';
    assert.strictEqual(parsePreamble(head + '\n\n## T-0001 · Major · A\n'), head + '\n');
  });
});

describe('a write preserves the preamble (T-0167)', () => {
  const withBacklog = (text, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-preamble-'));
    const file = path.join(dir, 'backlog.md');
    if (text !== null) fs.writeFileSync(file, text);
    try {
      return fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const TASK = '## T-0001 · Major · A\n- type: feature\n- status: ready\n- created: 2026-01-01 00:00:00\n- closed: —\n- briefs: \n';

  it('keeps a hand-written head through updateBacklog()', () => {
    const head = '# Our board\n\nRead doc/README first. Do not delete this line.\n';
    withBacklog(head + '\n' + TASK, (file) => {
      updateBacklog(file, (tasks) => {
        tasks[0].status = 'in_progress';
      });
      const after = fs.readFileSync(file, 'utf8');
      assert.ok(after.startsWith(head + '\n## T-0001 '));
      assert.match(after, /- status: in_progress/);
    });
  });

  it('survives repeated writes rather than only the first', () => {
    const head = '# Our board\n\nA note.\n';
    withBacklog(head + '\n' + TASK, (file) => {
      for (const status of ['in_progress', 'review', 'done']) {
        updateBacklog(file, (tasks) => {
          tasks[0].status = status;
        });
      }
      assert.ok(fs.readFileSync(file, 'utf8').startsWith(head));
    });
  });

  it('adds nothing of its own to a file that has no preamble', () => {
    withBacklog(TASK, (file) => {
      updateBacklog(file, (tasks) => {
        tasks[0].status = 'in_progress';
      });
      assert.ok(fs.readFileSync(file, 'utf8').startsWith('## T-0001 '));
    });
  });

  it('still writes the default head when there was no file to preserve one from', () => {
    withBacklog(null, (file) => {
      updateBacklog(file, (tasks) => {
        tasks.push({
          id: 'T-0001',
          priority: 'Major',
          title: 'A',
          type: 'feature',
          status: 'backlog',
          created: '2026-01-01 00:00:00',
          closed: '',
          briefs: [],
          depends: [],
          profile: '',
          extra: {},
          description: '',
        });
      });
      assert.ok(fs.readFileSync(file, 'utf8').startsWith(DEFAULT_PREAMBLE));
    });
  });

  it('keeps both heads through archive: the backlog keeps its own, a new archive gets ours', () => {
    const head = '# Our board\n\nA note that must survive archiving.\n';
    const closed = TASK.replace('T-0001', 'T-0002').replace('status: ready', 'status: done');
    withBacklog(head + '\n' + TASK + '\n' + closed, (file) => {
      archiveClosedTasks(file);
      assert.ok(fs.readFileSync(file, 'utf8').startsWith(head + '\n## T-0001 '));
      assert.ok(fs.readFileSync(archivePathFor(file), 'utf8').startsWith(ARCHIVE_PREAMBLE));
    });
  });

  it('keeps an existing archive head instead of replacing it on the second run', () => {
    const archiveHead = '# Old archive\n\nHand-edited head.\n';
    const closed = (id) => TASK.replace('T-0001', id).replace('status: ready', 'status: done');
    withBacklog(DEFAULT_PREAMBLE + '\n' + closed('T-0002'), (file) => {
      fs.writeFileSync(archivePathFor(file), archiveHead + '\n' + closed('T-0009'));
      archiveClosedTasks(file);
      assert.ok(fs.readFileSync(archivePathFor(file), 'utf8').startsWith(archiveHead));
    });
  });
});

describe('escaping "## "-lookalike lines in description (T-0040)', () => {
  const baseTask = {
    id: 'T-0007',
    priority: 'Major',
    title: 'Host task',
    type: 'feature',
    status: 'ready',
    created: '2026-01-01 00:00:00',
    closed: '',
    briefs: [],
  };

  it('a description containing a full fake task header does not spawn a phantom task on round-trip', () => {
    const description = [
      'Before the fake header.',
      '## T-9999 · Blocker · Injected fake task',
      'After the fake header.',
    ].join('\n');
    const task = { ...baseTask, description };

    const serialized = serializeBacklog([task]);
    const parsed = parseBacklog(serialized);

    assert.strictEqual(parsed.length, 1, 'must not split into a phantom second task');
    assert.strictEqual(parsed[0].id, 'T-0007');
    assert.strictEqual(parsed[0].description, description);
  });

  it('a description containing an arbitrary "## " line (not a full HEADER_RE match) round-trips unchanged', () => {
    const description = ['Some text.', '## just a heading', 'More text.'].join('\n');
    const task = { ...baseTask, description };

    const serialized = serializeBacklog([task]);
    const parsed = parseBacklog(serialized);

    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].description, description);
  });

  it('escapes the "## " line in the serialized text with a leading backslash', () => {
    const task = { ...baseTask, description: '## T-9999 · Blocker · Injected fake task' };
    const serialized = serializeBacklog([task]);
    assert.ok(serialized.includes('\\## T-9999 · Blocker · Injected fake task'));
    // And the un-escaped form must not appear as its own line (only the escaped one).
    assert.ok(!/^## T-9999/m.test(serialized));
  });

  it('does not alter ordinary descriptions without any "## " line (no spurious escaping)', () => {
    const descriptions = [
      'Plain single-line description.',
      ['Multi-line description.', '', '- a list item', '- another item', '', '```js', 'const x = 1;', '```'].join(
        '\n'
      ),
      '# A single-hash heading is left alone.',
      '### A triple-hash heading is left alone too.',
      '',
    ];

    for (const description of descriptions) {
      const task = { ...baseTask, description };
      const serialized = serializeBacklog([task]);
      const parsed = parseBacklog(serialized);

      if (description) {
        // The description must appear byte-for-byte in the serialized output.
        assert.ok(serialized.includes(description));
      }
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0].description, description.trim());
    }
  });
});

describe('escaping field-lookalike lines at the start of a description (T-0080)', () => {
  const baseTask = {
    id: 'T-0007',
    priority: 'Major',
    title: 'Host task',
    type: 'feature',
    status: 'ready',
    created: '2026-01-01 00:00:00',
    closed: '',
    briefs: [],
    depends: [],
    profile: '',
    extra: {},
  };

  const roundTrip = (description) => parseBacklog(serializeBacklog([{ ...baseTask, description }]));

  it('a description starting with "- status: done" does not rewrite the task status', () => {
    const description = '- status: done\nand some text after it';
    const parsed = roundTrip(description);

    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].status, 'ready', 'the description must not become a field');
    assert.strictEqual(parsed[0].description, description, 'the line stays in the description verbatim');
  });

  it('the same holds after leading blank lines and for an all-field-lines description', () => {
    const afterBlanks = roundTrip('\n\n- type: bug\nmore text');
    assert.strictEqual(afterBlanks[0].type, 'feature');
    assert.strictEqual(afterBlanks[0].description, '- type: bug\nmore text');

    const allFields = roundTrip('- status: done\n- type: bug\n- closed: 2026-01-01 00:00:00');
    assert.strictEqual(allFields[0].status, 'ready');
    assert.strictEqual(allFields[0].type, 'feature');
    assert.strictEqual(allFields[0].closed, '');
    assert.strictEqual(
      allFields[0].description,
      '- status: done\n- type: bug\n- closed: 2026-01-01 00:00:00'
    );
  });

  it('escapes the leading field-lookalike lines on disk, and only those', () => {
    const serialized = serializeBacklog([
      { ...baseTask, description: '- status: done\n- type: bug\nplain text\n- note: after the text' },
    ]);
    assert.ok(serialized.includes('\\- status: done'));
    assert.ok(serialized.includes('\\- type: bug'));
    // Past the first ordinary line a bullet is plain markdown: no backslash, so
    // the backlog people read on GitHub stays clean.
    assert.ok(serialized.includes('\nplain text\n- note: after the text'));
    assert.ok(!serialized.includes('\\- note:'));
  });

  it('a field-lookalike line after ordinary text is written untouched', () => {
    const description = 'Notes:\n- status: done\n- type: bug';
    const serialized = serializeBacklog([{ ...baseTask, description }]);
    assert.ok(serialized.includes(description), 'byte-for-byte, no escaping at all');
    assert.strictEqual(parseBacklog(serialized)[0].description, description);
  });

  it('round-trips a set of awkward descriptions unchanged, task fields intact', () => {
    const descriptions = [
      '- status: done',
      '- status: done\n- type: bug\n- created: 2026-02-02 02:02:02',
      '- note: a bullet that only looks like a field',
      '- status: done\n\nreal text\n\n- status: done again',
      'Plain first line.\n- status: done',
      '- type: bug\n## T-9999 · Blocker · nope\n- status: done',
      '- briefs: T-9999-01\n```\n- status: done\n```',
      '- Status: Done',
      '-status: done',
      'no field lines at all',
      '',
    ];

    for (const description of descriptions) {
      const task = { ...baseTask, description };
      const parsed = parseBacklog(serializeBacklog([task]));
      assert.deepStrictEqual(parsed, [task], `round-trip failed for ${JSON.stringify(description)}`);
    }
  });

  it('a field-lookalike description does not leak into the NEXT task in the file', () => {
    const first = { ...baseTask, description: '- status: done' };
    const second = { ...baseTask, id: 'T-0008', status: 'backlog', description: 'Second.' };
    const parsed = parseBacklog(serializeBacklog([first, second]));
    assert.deepStrictEqual(parsed, [first, second]);
  });

  it('known trade-off: a literal "\\- key: value" line loses one backslash on round-trip', () => {
    const parsed = roundTrip('\\- status: done');
    assert.strictEqual(parsed[0].description, '- status: done');
    assert.strictEqual(parsed[0].status, 'ready', 'still never read back as a field');
  });
});

const PREAMBLE = 'PREAMBLE\n';

// A task in the exact shape serializeBacklog() writes, with `fieldLines`
// appended after the known fields — the canonical position for unknown ones.
const file = (fieldLines, description = 'Description.') =>
  PREAMBLE +
  '\n' +
  [
    '## T-0007 · Major · Host task',
    '- type: feature',
    '- status: ready',
    '- created: 2026-01-01 00:00:00',
    '- closed: —',
    '- briefs: T-0007-01',
    ...fieldLines,
    ...(description ? ['', description] : []),
  ].join('\n') +
  '\n';

describe('unknown fields survive a read-write cycle (T-0095)', () => {
  it('KNOWN_FIELDS names exactly the seven fields the format defines', () => {
    assert.deepStrictEqual(KNOWN_FIELDS, [
      'type',
      'status',
      'created',
      'closed',
      'briefs',
      'depends',
      'profile',
    ]);
  });

  it('collects fields this version does not know into extra, in file order', () => {
    const [t] = parseBacklog(file(['- owner: alice', '- sprint: 2026-Q1']));
    assert.deepStrictEqual(t.extra, { owner: 'alice', sprint: '2026-Q1' });
    assert.strictEqual(t.status, 'ready', 'known fields are unaffected');
    assert.strictEqual(t.description, 'Description.');
  });

  it('gives a task with only known fields an empty extra', () => {
    const [t] = parseBacklog(file([]));
    assert.deepStrictEqual(t.extra, {});
  });

  it('trims an unknown value and keeps an empty one as an empty string', () => {
    const [t] = parseBacklog(file(['- owner:   alice  ', '- sprint:']));
    assert.deepStrictEqual(t.extra, { owner: 'alice', sprint: '' });
  });

  it('writes unknown fields after the known ones, in the order they were read', () => {
    const out = serializeBacklog(
      [
        {
          id: 'T-0007',
          priority: 'Major',
          title: 'Host task',
          type: 'feature',
          status: 'ready',
          created: '2026-01-01 00:00:00',
          closed: '',
          briefs: ['T-0007-01'],
          depends: ['T-0001'],
          extra: { owner: 'alice', sprint: '' },
          description: '',
        },
      ],
      PREAMBLE
    );
    assert.strictEqual(
      out,
      PREAMBLE +
        '\n' +
        [
          '## T-0007 · Major · Host task',
          '- type: feature',
          '- status: ready',
          '- created: 2026-01-01 00:00:00',
          '- closed: —',
          '- briefs: T-0007-01',
          '- depends: T-0001',
          '- owner: alice',
          '- sprint:',
        ].join('\n') +
        '\n'
    );
  });

  it('serializes a task built without an extra key at all (every pre-T-0095 caller)', () => {
    const out = serializeBacklog(
      [
        {
          id: 'T-0007',
          priority: 'Major',
          title: 'Host task',
          type: 'feature',
          status: 'ready',
          created: '2026-01-01 00:00:00',
          closed: '',
          briefs: [],
          depends: [],
          description: 'Text.',
        },
      ],
      PREAMBLE
    );
    assert.ok(out.includes('- briefs: \n\nText.'));
  });

  it('moves an unknown field that sat among the known ones after them, value intact', () => {
    const text =
      PREAMBLE +
      '\n' +
      [
        '## T-0007 · Major · Host task',
        '- owner: alice',
        '- type: feature',
        '- status: ready',
        '- created: 2026-01-01 00:00:00',
        '- closed: —',
        '- briefs: T-0007-01',
      ].join('\n') +
      '\n';
    const out = serializeBacklog(parseBacklog(text), PREAMBLE);
    assert.strictEqual(out, file(['- owner: alice'], ''));
  });

  it('keeps the last value of a repeated unknown key, at the position of its first line', () => {
    const [t] = parseBacklog(file(['- owner: alice', '- sprint: 2026-Q1', '- owner: bob']));
    assert.deepStrictEqual(t.extra, { owner: 'bob', sprint: '2026-Q1' });
    assert.strictEqual(
      serializeBacklog([t], PREAMBLE),
      file(['- owner: bob', '- sprint: 2026-Q1'])
    );
  });

  it('does not read a field-shaped description line as an unknown field', () => {
    const [t] = parseBacklog(file([], 'Notes:\n- owner: alice'));
    assert.deepStrictEqual(t.extra, {});
    assert.strictEqual(t.description, 'Notes:\n- owner: alice');
  });

  it('holds the round-trip property over files with unknown fields of every shape', () => {
    const texts = [
      file(['- owner: alice']),
      file(['- owner: alice', '- sprint: 2026-Q1', '- points: 5']),
      file(['- sprint:']),
      file(['- depends: T-0001, T-0002', '- owner: alice']),
      file(['- owner: alice', '- sprint: 2026-Q1'], ''),
      file(['- owner: alice'], 'Multi\n\nline\n- status: done'),
      file(['- owner: value: with: colons']),
      file(['- owner: alice', '- owner: bob']),
      PREAMBLE +
        '\n## T-0007 · Major · Host task\n- owner: alice\n- type: feature\n- status: ready\n',
      PREAMBLE + '\n## T-0007 · Major · Host task\n- owner: alice\n',
    ];
    for (const text of texts) {
      const first = parseBacklog(text);
      assert.deepStrictEqual(
        parseBacklog(serializeBacklog(first)),
        first,
        `round-trip failed for ${JSON.stringify(text)}`
      );
    }
  });

  it('a write pass over a file already in canonical order leaves it byte for byte as it was', () => {
    const text = file(['- depends: T-0001', '- owner: alice', '- sprint:'], 'Description.');
    assert.strictEqual(serializeBacklog(parseBacklog(text), PREAMBLE), text);
  });

  it('an unrelated write (a status change) leaves the unknown line untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-extra-test-'));
    const backlog = path.join(dir, 'backlog.md');
    fs.writeFileSync(backlog, file(['- owner: alice']));

    updateBacklog(backlog, (tasks) => {
      tasks[0].status = 'in_progress';
    });

    const written = fs.readFileSync(backlog, 'utf8');
    assert.ok(written.includes('- status: in_progress'));
    assert.ok(written.includes('- owner: alice'));
    assert.deepStrictEqual(parseBacklog(written)[0].extra, { owner: 'alice' });
  });
});

describe('field names with digits, "_" and "-" (T-0097)', () => {
  const baseTask = {
    id: 'T-0007',
    priority: 'Major',
    title: 'Host task',
    type: 'feature',
    status: 'ready',
    created: '2026-01-01 00:00:00',
    closed: '',
    briefs: ['T-0007-01'],
    depends: [],
    profile: '',
    extra: {},
  };

  it('FIELD_RE names start with a lowercase letter and may then carry letters, digits, "_" and "-"', () => {
    for (const line of ['- due_date: x', '- sprint-2: x', '- a: x', '- a1_b-c2: x']) {
      assert.ok(FIELD_RE.test(line), `${JSON.stringify(line)} must be a field`);
    }
    for (const line of ['- 2: x', '- _owner: x', '- -owner: x', '- : x', '- Owner: x', '- own er: x']) {
      assert.ok(!FIELD_RE.test(line), `${JSON.stringify(line)} must not be a field`);
    }
  });

  it('reads "- due_date:" and "- sprint-2:" as unknown fields instead of description text', () => {
    const [t] = parseBacklog(file(['- due_date: 2026-09-01', '- sprint-2: yes']));
    assert.deepStrictEqual(t.extra, { due_date: '2026-09-01', 'sprint-2': 'yes' });
    assert.strictEqual(t.description, 'Description.');
  });

  it('such a field survives a write pass byte for byte, and an unrelated write too', () => {
    const text = file(['- due_date: 2026-09-01', '- sprint-2: yes']);
    assert.strictEqual(serializeBacklog(parseBacklog(text), PREAMBLE), text);

    const tasks = parseBacklog(text);
    tasks[0].status = 'in_progress';
    const written = serializeBacklog(tasks, PREAMBLE);
    assert.strictEqual(written, text.replace('- status: ready', '- status: in_progress'));
  });

  it('a bullet whose name does not start with a letter stays description', () => {
    const [t] = parseBacklog(file([], '- 2: list item\n- _x: y\n- Owner: alice'));
    assert.deepStrictEqual(t.extra, {});
    assert.strictEqual(t.description, '- 2: list item\n- _x: y\n- Owner: alice');
  });

  it('a description this version writes, starting with "- note-2: text", reads back as text', () => {
    const description = '- note-2: text\nand the rest';
    const serialized = serializeBacklog([{ ...baseTask, description }], PREAMBLE);
    assert.ok(serialized.includes('\\- note-2: text'));
    const [t] = parseBacklog(serialized);
    assert.deepStrictEqual(t.extra, {});
    assert.strictEqual(t.description, description);
  });

  // Fixing the one case the wider charset moves: a file written before T-0097
  // has no backslash on such a line, because the old FIELD_RE did not see it as
  // field-shaped. From now on it is read as an unknown field and the next write
  // lifts it out of the description into the fields block. Nothing is lost, but
  // it does move - and it stabilizes there, as the second round-trip shows.
  it('an unescaped "- note-2: text" opening a description in a pre-T-0097 file becomes a field', () => {
    const text = file([], '- note-2: text\nand the rest');
    const [t] = parseBacklog(text);
    assert.deepStrictEqual(t.extra, { 'note-2': 'text' });
    assert.strictEqual(t.description, 'and the rest');

    const written = serializeBacklog([t], PREAMBLE);
    assert.strictEqual(written, file(['- note-2: text'], 'and the rest'));
    assert.deepStrictEqual(parseBacklog(serializeBacklog(parseBacklog(written), PREAMBLE)), [t]);
  });
});

describe('findBriefFile() — shared brief lookup (used by server.js + validate.js)', () => {
  // Build a throwaway brief directory so the lookup rules can be asserted in
  // isolation, independent of the real doc/brief/ contents.
  function makeBriefDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-brief-'));
    for (const f of files) fs.writeFileSync(path.join(dir, f), '# brief\n');
    return dir;
  }

  it('resolves an exact "<id>.md" file', () => {
    const dir = makeBriefDir(['T-0007-01.md']);
    assert.strictEqual(findBriefFile(dir, 'T-0007-01'), path.join(dir, 'T-0007-01.md'));
  });

  it('resolves a "<id>-<slug>.md" file', () => {
    const dir = makeBriefDir(['T-0007-01-some-slug.md']);
    assert.strictEqual(findBriefFile(dir, 'T-0007-01'), path.join(dir, 'T-0007-01-some-slug.md'));
  });

  it('returns null when no file matches the id', () => {
    const dir = makeBriefDir(['T-0099-02.md']);
    assert.strictEqual(findBriefFile(dir, 'T-0007-01'), null);
  });

  it('returns null for a non-existent briefDir', () => {
    const dir = path.join(os.tmpdir(), 'briefboard-brief-does-not-exist-xyz');
    assert.strictEqual(findBriefFile(dir, 'T-0007-01'), null);
  });

  it('rejects an id that does not match BRIEF_ID_RE (path-traversal guard)', () => {
    const dir = makeBriefDir(['T-0007-01.md']);
    // A traversal attempt never matches BRIEF_ID_RE, so it is rejected before
    // any filename is built from it.
    assert.strictEqual(findBriefFile(dir, '../../etc/passwd'), null);
    assert.strictEqual(findBriefFile(dir, 'T-0007'), null);
    assert.strictEqual(findBriefFile(dir, 'not-a-brief'), null);
  });

  it('BRIEF_ID_RE matches the "T-XXXX-YY" shape and nothing looser', () => {
    assert.ok(BRIEF_ID_RE.test('T-0007-01'));
    assert.ok(!BRIEF_ID_RE.test('T-0007'));
    assert.ok(!BRIEF_ID_RE.test('T-0007-01-slug'));
  });
});

// The single "create a task" implementation shared by tools/task.mjs (`add`)
// and server.js (POST /api/task) — T-0074.
describe('addTask()', () => {
  function tmpBacklog() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-addtask-test-')), 'backlog.md');
  }
  function read(file) {
    return parseBacklog(fs.readFileSync(file, 'utf8'));
  }

  it('creates the first task as T-0001 in status backlog with a created stamp and no briefs', () => {
    const file = tmpBacklog();
    const id = addTask(file, { title: 'First task', type: 'bug', priority: 'Critical', description: 'Details.' });
    assert.strictEqual(id, 'T-0001');
    const [task] = read(file);
    assert.strictEqual(task.id, 'T-0001');
    assert.strictEqual(task.title, 'First task');
    assert.strictEqual(task.type, 'bug');
    assert.strictEqual(task.priority, 'Critical');
    assert.strictEqual(task.status, 'backlog');
    assert.strictEqual(task.closed, '');
    assert.deepStrictEqual(task.briefs, []);
    assert.strictEqual(task.description, 'Details.');
    assert.match(task.created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('allocates sequential ids, continuing from the highest existing one', () => {
    const file = tmpBacklog();
    assert.strictEqual(addTask(file, { title: 'A' }), 'T-0001');
    assert.strictEqual(addTask(file, { title: 'B' }), 'T-0002');
    assert.strictEqual(addTask(file, { title: 'C' }), 'T-0003');
    assert.deepStrictEqual(read(file).map((t) => t.id), ['T-0001', 'T-0002', 'T-0003']);
  });

  it('defaults type to feature and priority to Medium, and trims title/description', () => {
    const file = tmpBacklog();
    addTask(file, { title: '  Spacey  ', description: '  text  ' });
    const [task] = read(file);
    assert.strictEqual(task.type, 'feature');
    assert.strictEqual(task.priority, 'Medium');
    assert.strictEqual(task.title, 'Spacey');
    assert.strictEqual(task.description, 'text');
  });

  it('normalizes an unknown type/priority exactly as the CLI always has', () => {
    const file = tmpBacklog();
    addTask(file, { title: 'Bogus', type: 'chore', priority: 'Extreme' });
    const [task] = read(file);
    assert.strictEqual(task.type, 'feature');
    assert.strictEqual(task.priority, 'Medium');
  });

  it('keeps type external and round-trips it through the file (T-0092)', () => {
    const file = tmpBacklog();
    addTask(file, { title: 'Get the API keys from the client', type: 'external' });
    assert.match(fs.readFileSync(file, 'utf8'), /^- type: external$/m);
    assert.strictEqual(read(file)[0].type, 'external');
  });

  it('throws on a missing/blank title and writes nothing', () => {
    const file = tmpBacklog();
    assert.throws(() => addTask(file, {}), /title is required/);
    assert.throws(() => addTask(file, { title: '   ' }), /title is required/);
    assert.ok(!fs.existsSync(file), 'no backlog file is created for a rejected task');
  });

  it('releases the lock and leaves no tmp file behind', () => {
    const file = tmpBacklog();
    addTask(file, { title: 'Clean' });
    assert.ok(!fs.existsSync(file + '.lock'));
    assert.ok(!fs.existsSync(file + '.tmp'));
  });

  it('a description containing a "## T-0001 · ..." line does not spawn a phantom task', () => {
    const file = tmpBacklog();
    const description = 'Before\n## T-0001 · Blocker · Fake header\nAfter';
    addTask(file, { title: 'Real task', description });
    const tasks = read(file);
    assert.strictEqual(tasks.length, 1, 'exactly one task, the fake header stayed inside the description');
    assert.strictEqual(tasks[0].description, description);
    // The header-lookalike line is escaped on disk (serializeBacklog), so the
    // parser can never mistake it for a task of its own.
    assert.match(fs.readFileSync(file, 'utf8'), /\\## T-0001 · Blocker · Fake header/);
  });
});

describe('blockingDependencies() (T-0087)', () => {
  const mk = (id, status, depends) => ({
    id, priority: 'Major', title: id, type: 'feature', status,
    created: '2026-01-01 00:00:00', closed: '', briefs: [], depends: depends || [], description: '',
  });

  it('returns [] for a task with no dependencies', () => {
    const task = mk('T-0003', 'ready');
    assert.deepStrictEqual(blockingDependencies(task, [task]), []);
  });

  it('lists exactly the prerequisites that are neither done nor cancelled', () => {
    const tasks = [
      mk('T-0001', 'done'),
      mk('T-0002', 'cancelled'),
      mk('T-0003', 'review'),
      mk('T-0004', 'backlog'),
      mk('T-0005', 'ready', ['T-0001', 'T-0002', 'T-0003', 'T-0004']),
    ];
    assert.deepStrictEqual(blockingDependencies(tasks[4], tasks), ['T-0003', 'T-0004']);
  });

  it('treats a prerequisite that no task carries as blocking (it cannot be shown to be finished)', () => {
    const task = mk('T-0005', 'ready', ['T-9999']);
    assert.deepStrictEqual(blockingDependencies(task, [task]), ['T-9999']);
  });

  it('accepts a prebuilt Map as well as an array', () => {
    const dep = mk('T-0001', 'in_progress');
    const task = mk('T-0002', 'ready', ['T-0001']);
    const byId = new Map([[dep.id, dep], [task.id, task]]);
    assert.deepStrictEqual(blockingDependencies(task, byId), ['T-0001']);
  });

  it('tolerates a task object with no depends key (legacy/hand-built objects)', () => {
    const task = { id: 'T-0001', status: 'ready' };
    assert.deepStrictEqual(blockingDependencies(task, [task]), []);
  });
});

describe('awaitsAnswer() (T-0083)', () => {
  const mk = (status, description) => ({
    id: 'T-0007', priority: 'Major', title: 'Task', type: 'feature', status,
    created: '2026-01-01 00:00:00', closed: '', briefs: [], depends: [], description,
  });

  it('the heading constant is the one the README prompt tells the session to write', () => {
    assert.strictEqual(SESSION_QUESTIONS_HEADING, '### Session questions');
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    assert.ok(readme.includes(SESSION_QUESTIONS_HEADING));
  });

  // T-0101: the worker session's half of the protocol lives in the shipped
  // prompt, so the prompt is what has to carry it - in every README, since each
  // one is copied by someone who reads only that language.
  it('the worker prompt in all three READMEs tells the session to ask instead of guessing', () => {
    for (const file of ['README.md', 'README.ru.md', 'README.ja.md']) {
      const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
      const prompt = /BRIEFBOARD_WORKER_CMD='[\s\S]*?'\s*\\\n\s*node server\/server\.js/.exec(text);
      assert.ok(prompt, `${file} must ship a ready-to-copy BRIEFBOARD_WORKER_CMD`);
      assert.ok(
        prompt[0].split('\n').some((line) => line.trim() === SESSION_QUESTIONS_HEADING),
        `the worker prompt in ${file} must name the ${SESSION_QUESTIONS_HEADING} section on a line of its own`
      );
      assert.match(prompt[0], /in_progress/);
    }
  });

  it('an open task whose description carries the section is awaiting an answer', () => {
    const task = mk('open', ['Original wording.', '', SESSION_QUESTIONS_HEADING, '', '- Which format?'].join('\n'));
    assert.strictEqual(awaitsAnswer(task), true);
  });

  it('an open task without the section is not', () => {
    assert.strictEqual(awaitsAnswer(mk('open', 'Plain description with questions in it.')), false);
    assert.strictEqual(awaitsAnswer(mk('open', '')), false);
  });

  it('the heading counts only on a line of its own, never as a substring', () => {
    const inline = mk('open', 'The session appends a `### Session questions` section when it has to ask.');
    assert.strictEqual(awaitsAnswer(inline), false);
    const trailing = mk('open', '### Session questions about the export');
    assert.strictEqual(awaitsAnswer(trailing), false);
  });

  it('surrounding whitespace on the heading line does not hide the section', () => {
    assert.strictEqual(awaitsAnswer(mk('open', '  ' + SESSION_QUESTIONS_HEADING + '  ')), true);
  });

  // T-0101: the worker session asks from `in_progress` and stays there, so the
  // flag has to reach it — the protocol gives the worker no way back to `ready`.
  it('an in_progress task whose worker session left questions is awaiting an answer', () => {
    const task = mk('in_progress', ['Brief unclear.', '', SESSION_QUESTIONS_HEADING, '', '- Which schema?'].join('\n'));
    assert.strictEqual(awaitsAnswer(task), true);
    assert.strictEqual(awaitsAnswer(mk('in_progress', 'Working, nothing to ask.')), false);
  });

  it('no other status is ever flagged, even with the section still in the text', () => {
    const withSection = 'Description.\n\n' + SESSION_QUESTIONS_HEADING + '\n\n- Answered already.';
    for (const status of ['backlog', 'ready', 'done', 'cancelled']) {
      assert.strictEqual(awaitsAnswer(mk(status, withSection)), false, status);
    }
  });

  // One status per kind of session that can stop to ask: briefing from `open`,
  // worker from `in_progress`, review from `review` (T-0122). Nothing past
  // review: those statuses are set by a human who has read the description, and
  // a marker there would have nobody to unblock.
  it('ANSWER_STATUSES is exactly the statuses a session can be stopped in', () => {
    assert.deepStrictEqual(ANSWER_STATUSES, ['open', 'in_progress', 'review']);
    for (const status of STATUSES) {
      const flagged = awaitsAnswer(mk(status, SESSION_QUESTIONS_HEADING));
      assert.strictEqual(flagged, ANSWER_STATUSES.includes(status), status);
    }
  });

  it('tolerates a task with no description key, and a missing task', () => {
    assert.strictEqual(awaitsAnswer({ id: 'T-0001', status: 'open' }), false);
    assert.strictEqual(awaitsAnswer(null), false);
  });

  // The status-free half of the check, used by the session runner to tell a
  // session that stopped to ask from one that did nothing at all (T-0109).
  it('hasSessionQuestions() reads the description alone, with the same line rule', () => {
    assert.strictEqual(hasSessionQuestions('Text.\n\n' + SESSION_QUESTIONS_HEADING + '\n- Which?'), true);
    assert.strictEqual(hasSessionQuestions('  ' + SESSION_QUESTIONS_HEADING + '  '), true);
    assert.strictEqual(hasSessionQuestions('I would write ### Session questions here.'), false);
    assert.strictEqual(hasSessionQuestions(''), false);
    assert.strictEqual(hasSessionQuestions(undefined), false);
  });

  // T-0122. A count, not a boolean: the review session's whole output is this
  // section, so a second review round has to be visible as a second section —
  // that difference is how the runner tells a verdict from a silent run.
  it('countReviewVerdicts() counts the heading, by the same line rule', () => {
    assert.strictEqual(REVIEW_VERDICT_HEADING, '### Review verdict');
    assert.strictEqual(countReviewVerdicts(''), 0);
    assert.strictEqual(countReviewVerdicts(undefined), 0);
    assert.strictEqual(countReviewVerdicts('Text.\n\n' + REVIEW_VERDICT_HEADING + '\nMerge it.'), 1);
    assert.strictEqual(countReviewVerdicts('  ' + REVIEW_VERDICT_HEADING + '  '), 1);
    assert.strictEqual(countReviewVerdicts('The agent writes ### Review verdict there.'), 0);
    assert.strictEqual(
      countReviewVerdicts(REVIEW_VERDICT_HEADING + '\nno\n\n' + REVIEW_VERDICT_HEADING + '\nyes'),
      2
    );
  });

  it('reads back from a real backlog file through parseBacklog()', () => {
    const text = [
      '# Backlog\n',
      '## T-0001 · Major · Asked',
      '- type: feature',
      '- status: open',
      '',
      'Refined a bit.',
      '',
      SESSION_QUESTIONS_HEADING,
      '',
      '- Does the export include cancelled tasks?',
      '',
      '## T-0002 · Major · Silent',
      '- type: feature',
      '- status: open',
      '',
      'Refined a bit.',
      '',
    ].join('\n');
    const [asked, silent] = parseBacklog(text);
    assert.strictEqual(awaitsAnswer(asked), true);
    assert.strictEqual(awaitsAnswer(silent), false);
  });

  // The heading the board writes an answer under (T-0085). It is a token of the
  // format, like the questions heading it replies to, so it is pinned here.
  it('ANSWERS_SECTION spells the "### Answers" heading and does not collide with the questions one', () => {
    assert.strictEqual(ANSWERS_SECTION, 'Answers');
    const answered = appendDescriptionSection(
      'Refined.\n\n' + SESSION_QUESTIONS_HEADING + '\n\n- Which format?',
      ANSWERS_SECTION,
      'ISO-8601.'
    );
    assert.ok(answered.split('\n').includes('### Answers'));
    // Answering leaves the questions where they are: both sections stand, and
    // it is their order that says the question is closed (T-0114).
    assert.ok(answered.split('\n').includes(SESSION_QUESTIONS_HEADING));
    assert.strictEqual(awaitsAnswer({ status: 'open', description: answered }), false);
  });
});

// The flag is a claim about the present, not about what was ever written: a task
// whose questions were answered carries no marker, whatever status it later
// passes through. Found on a live run - a task answered in `open` lit the card
// again on the drop into `in_progress`, where a worker was already at work.
describe('awaitsAnswer() reads the order of the two sections (T-0114)', () => {
  const mk = (status, description) => ({
    id: 'T-0007', priority: 'Major', title: 'Task', type: 'feature', status,
    created: '2026-01-01 00:00:00', closed: '', briefs: [], depends: [], description,
  });

  it('answers below the questions clear the flag, in both asking statuses', () => {
    const answered = [
      'Refined.', '', SESSION_QUESTIONS_HEADING, '', '- Which format?', '',
      ANSWERS_HEADING, 'ISO-8601.',
    ].join('\n');
    assert.strictEqual(awaitsAnswer(mk('open', answered)), false);
    assert.strictEqual(awaitsAnswer(mk('in_progress', answered)), false);
  });

  it('a question below the answers lights it again', () => {
    const askedAgain = [
      'Refined.', '', SESSION_QUESTIONS_HEADING, '', '- Which format?', '',
      ANSWERS_HEADING, 'ISO-8601.', '',
      SESSION_QUESTIONS_HEADING, '', '- And the timezone?',
    ].join('\n');
    assert.strictEqual(awaitsAnswer(mk('open', askedAgain)), true);
    assert.strictEqual(awaitsAnswer(mk('in_progress', askedAgain)), true);
  });

  // The whole point of ordering over presence: every round works on its own,
  // without a new field in the format or a change to the protocol. Written the
  // only way an agent or the board can write it - through the same
  // appendDescriptionSection() - so the chain is checked against the text the
  // system really produces, not against a shape composed by hand.
  it('two full rounds of question -> answer -> question -> answer', () => {
    let description = 'Refined.';
    const flag = (status) => awaitsAnswer(mk(status, description));
    const write = (section, body) => {
      description = appendDescriptionSection(description, section, body);
    };

    assert.strictEqual(flag('open'), false);
    write(SESSION_QUESTIONS_SECTION, '- Which format?');
    assert.strictEqual(flag('open'), true);
    write(ANSWERS_SECTION, 'ISO-8601.');
    assert.strictEqual(flag('open'), false);
    // The briefing session moves on; the worker it hands the task to asks its own.
    assert.strictEqual(flag('in_progress'), false);
    write(SESSION_QUESTIONS_SECTION, '- Which of the two schemas?');
    assert.strictEqual(flag('in_progress'), true);
    write(ANSWERS_SECTION, 'The second one.');
    assert.strictEqual(flag('in_progress'), false);

    // Four sections, in the order they were written, and the first round is
    // still readable in full.
    assert.deepStrictEqual(
      description.split('\n').filter((line) => line.startsWith('### ')),
      [SESSION_QUESTIONS_HEADING, ANSWERS_HEADING, SESSION_QUESTIONS_HEADING, ANSWERS_HEADING]
    );
    assert.ok(description.includes('- Which format?'));
    assert.ok(description.includes('ISO-8601.'));
  });

  it('the last occurrence of each heading decides, not the first', () => {
    // Questions, answers, questions, answers: the first pair would say "asking".
    const closed = [
      SESSION_QUESTIONS_HEADING, '- One?', ANSWERS_HEADING, 'Yes.',
      SESSION_QUESTIONS_HEADING, '- Two?', ANSWERS_HEADING, 'Also yes.',
    ].join('\n');
    assert.strictEqual(awaitsAnswer(mk('open', closed)), false);
    // And the mirror image: the first pair would say "answered".
    const asking = [
      SESSION_QUESTIONS_HEADING, '- One?', ANSWERS_HEADING, 'Yes.',
      ANSWERS_HEADING, 'Still yes.', SESSION_QUESTIONS_HEADING, '- Two?',
    ].join('\n');
    assert.strictEqual(awaitsAnswer(mk('open', asking)), true);
  });

  it('an answers section on its own is not a question', () => {
    assert.strictEqual(awaitsAnswer(mk('open', ANSWERS_HEADING + '\nOut of the blue.')), false);
  });

  // T-0083 again, on the other side of the pair: neither heading counts inside a
  // sentence, so prose written after an answer cannot reopen the question.
  it('a heading quoted inside a line changes nothing either way', () => {
    const prose = [
      SESSION_QUESTIONS_HEADING, '- Which format?', ANSWERS_HEADING, 'ISO-8601.',
      'A worker writes a `' + SESSION_QUESTIONS_HEADING + '` section when it has to ask.',
    ].join('\n');
    assert.strictEqual(awaitsAnswer(mk('open', prose)), false);
    const quotedAnswer = [
      SESSION_QUESTIONS_HEADING, '- Which format?',
      'The board appends the reply under `' + ANSWERS_HEADING + '`.',
    ].join('\n');
    assert.strictEqual(awaitsAnswer(mk('open', quotedAnswer)), true);
  });

  it('no other status is flagged, however the two sections are ordered', () => {
    const asking = SESSION_QUESTIONS_HEADING + '\n- Open again?';
    for (const status of ['backlog', 'ready', 'done', 'cancelled']) {
      assert.strictEqual(awaitsAnswer(mk(status, asking)), false, status);
    }
  });

  // T-0122: the order rule is what lets `review` be in the list at all. A worker
  // that asked and was answered carries both sections into review, and the
  // marker has to be out there — otherwise every task that ever asked would
  // arrive in review flagged, which is exactly why `review` was excluded in
  // T-0101, before the order decided the matter.
  it('a review task is flagged by the same order rule, not by the section alone', () => {
    const answered = SESSION_QUESTIONS_HEADING + '\n- Which?\n\n' + ANSWERS_HEADING + '\nThis one.';
    assert.strictEqual(awaitsAnswer(mk('review', answered)), false);
    const asking = answered + '\n\n' + SESSION_QUESTIONS_HEADING + '\n- And the merge base?';
    assert.strictEqual(awaitsAnswer(mk('review', asking)), true);
  });

  it('hasSessionQuestions() still answers presence alone, ignoring the order', () => {
    const answered = SESSION_QUESTIONS_HEADING + '\n- Which?\n\n' + ANSWERS_HEADING + '\nThis one.';
    assert.strictEqual(hasSessionQuestions(answered), true);
    assert.strictEqual(awaitsAnswer(mk('open', answered)), false);
  });

  it('reads back the answered task from a real backlog file', () => {
    const text = [
      '# Backlog\n',
      '## T-0001 · Major · Answered, and being worked on',
      '- type: feature',
      '- status: in_progress',
      '',
      'Refined a bit.',
      '',
      SESSION_QUESTIONS_HEADING,
      '',
      '- Does the export include cancelled tasks?',
      '',
      ANSWERS_HEADING,
      'It does.',
      '',
    ].join('\n');
    const [task] = parseBacklog(text);
    assert.strictEqual(task.status, 'in_progress');
    assert.strictEqual(awaitsAnswer(task), false);
  });
});

describe('dependencyCycles() (T-0087)', () => {
  const mk = (id, depends) => ({ id, status: 'ready', depends: depends || [] });

  it('finds nothing in an acyclic graph', () => {
    const tasks = [mk('T-0001'), mk('T-0002', ['T-0001']), mk('T-0003', ['T-0001', 'T-0002'])];
    assert.deepStrictEqual(dependencyCycles(tasks), []);
  });

  it('reports a two-task cycle with both participants named', () => {
    const cycles = dependencyCycles([mk('T-0001', ['T-0002']), mk('T-0002', ['T-0001'])]);
    assert.strictEqual(cycles.length, 1);
    assert.deepStrictEqual(cycles[0], ['T-0001', 'T-0002', 'T-0001']);
  });

  it('reports a cycle of length three', () => {
    const cycles = dependencyCycles([
      mk('T-0001', ['T-0002']),
      mk('T-0002', ['T-0003']),
      mk('T-0003', ['T-0001']),
    ]);
    assert.strictEqual(cycles.length, 1);
    assert.deepStrictEqual(cycles[0], ['T-0001', 'T-0002', 'T-0003', 'T-0001']);
  });

  it('reports the same cycle once, whichever task the walk starts from', () => {
    // T-0009 sits outside the cycle and reaches it, so the DFS enters the ring
    // from two different places across the outer loop.
    const cycles = dependencyCycles([
      mk('T-0009', ['T-0002']),
      mk('T-0001', ['T-0002']),
      mk('T-0002', ['T-0001']),
    ]);
    assert.strictEqual(cycles.length, 1);
  });

  it('reports two independent cycles separately', () => {
    const cycles = dependencyCycles([
      mk('T-0001', ['T-0002']),
      mk('T-0002', ['T-0001']),
      mk('T-0003', ['T-0004']),
      mk('T-0004', ['T-0003']),
    ]);
    assert.strictEqual(cycles.length, 2);
  });

  it('leaves a self-dependency to the dedicated validator check', () => {
    assert.deepStrictEqual(dependencyCycles([mk('T-0001', ['T-0001'])]), []);
  });

  it('ignores an edge pointing at a task that does not exist', () => {
    assert.deepStrictEqual(dependencyCycles([mk('T-0001', ['T-9999'])]), []);
  });
});

describe('appendDescriptionSection() (T-0098)', () => {
  it('creates the section at the end, one blank line after the existing text', () => {
    assert.strictEqual(
      appendDescriptionSection('Context.', 'Worker report', 'branch: x'),
      'Context.\n\n### Worker report\nbranch: x'
    );
  });

  it('starts the description with the section when there was none', () => {
    assert.strictEqual(appendDescriptionSection('', 'Worker report', 'done'), '### Worker report\ndone');
  });

  it('appends inside the existing section, above the sections that follow it', () => {
    const before = 'Context.\n\n### Worker report\nfirst\n\n### Review\na comment';
    assert.strictEqual(
      appendDescriptionSection(before, 'Worker report', 'second'),
      'Context.\n\n### Worker report\nfirst\n\nsecond\n\n### Review\na comment'
    );
  });

  it('treats a deeper "#### " heading as part of the section, not as its end', () => {
    const before = '### Worker report\n#### How to verify\nnpm test';
    assert.strictEqual(
      appendDescriptionSection(before, 'Worker report', 'more'),
      '### Worker report\n#### How to verify\nnpm test\n\nmore'
    );
  });

  it('normalizes CRLF and drops trailing whitespace from the appended text', () => {
    assert.strictEqual(
      appendDescriptionSection('', 'Report', 'one\r\ntwo\n\n  '),
      '### Report\none\ntwo'
    );
  });

  it('never rewrites what was already in the description', () => {
    const before = 'Decision A.\n\n### Review\nkeep me\n\n### Worker report\nold';
    const after = appendDescriptionSection(before, 'Worker report', 'new');
    assert.ok(after.startsWith(before), 'the previous text is a prefix of the result');
  });

  // T-0114. Merging a reply into the section it replies to erases the one thing
  // the marker reads: which side spoke last.
  describe('the correspondence sections are never merged', () => {
    it('CHRONOLOGICAL_SECTIONS is the exchange plus the dated verdict', () => {
      assert.deepStrictEqual(CHRONOLOGICAL_SECTIONS, [
        'Session questions',
        'Answers',
        'Review verdict',
      ]);
      assert.ok(CHRONOLOGICAL_SECTIONS.includes(SESSION_QUESTIONS_SECTION));
      assert.ok(CHRONOLOGICAL_SECTIONS.includes(ANSWERS_SECTION));
      // T-0122: a task returned for rework comes back with a different branch
      // behind it, so a second verdict must not merge into the first — that
      // would present a judgement of the old code as the current one.
      assert.ok(CHRONOLOGICAL_SECTIONS.includes(REVIEW_VERDICT_SECTION));
    });

    for (const section of ['Session questions', 'Answers', 'Review verdict']) {
      it(`a second "${section}" opens its own section at the end`, () => {
        const before = 'Context.\n\n### ' + section + '\nfirst';
        assert.strictEqual(
          appendDescriptionSection(before, section, 'second'),
          before + '\n\n### ' + section + '\nsecond'
        );
      });
    }

    it('the new section goes below everything, not above the sections that follow', () => {
      const before = 'Context.\n\n### Session questions\n- one?\n\n### Answers\nthat one';
      assert.strictEqual(
        appendDescriptionSection(before, 'Session questions', '- and two?'),
        before + '\n\n### Session questions\n- and two?'
      );
    });

    it('every other heading still merges, exactly as T-0098 left it', () => {
      const before = 'Context.\n\n### Worker report\nfirst\n\n### Review comments\nlooks fine';
      assert.strictEqual(
        appendDescriptionSection(before, 'Worker report', 'after rework'),
        'Context.\n\n### Worker report\nfirst\n\nafter rework\n\n### Review comments\nlooks fine'
      );
    });

    it('the rule is the heading, not the caller: surrounding whitespace still selects it', () => {
      const before = '### Answers\nfirst';
      assert.strictEqual(
        appendDescriptionSection(before, '  Answers  ', 'second'),
        before + '\n\n### Answers\nsecond'
      );
    });
  });
});

// T-0161. What counts as a worker report is a line rule, and the edges of it are
// what decide whether a reader loses a statement of work or keeps a 9 KB report.
describe('stripWorkerReports() (T-0161)', () => {
  it('takes the section and its heading, and reports what it took', () => {
    const before = 'Context.\n\n### Worker report\nbranch: x\n\n### Review verdict\nfine';
    const lean = stripWorkerReports(before);
    assert.strictEqual(lean.description, 'Context.\n\n### Review verdict\nfine');
    assert.strictEqual(lean.sections, 1);
    assert.deepStrictEqual(lean.headings, ['Worker report']);
    assert.strictEqual(lean.bytes, Buffer.byteLength(before) - Buffer.byteLength(lean.description));
  });

  it('knows the legacy Russian heading, written before the English-only rule', () => {
    const lean = stripWorkerReports('Context.\n\n### Отчёт воркера\nсделано');
    assert.strictEqual(lean.description, 'Context.');
    assert.deepStrictEqual(lean.headings, [LEGACY_WORKER_REPORT_SECTION]);
  });

  it('takes a decorated heading too — the suffix is a label, not another section', () => {
    const lean = stripWorkerReports('### Worker report — rework after review 1 (2026-08-14)\nfixed');
    assert.strictEqual(lean.description, '');
    assert.strictEqual(lean.sections, 1);
    assert.deepStrictEqual(lean.headings, [WORKER_REPORT_SECTION]);
  });

  it('keeps a heading that merely continues the name into another word', () => {
    const before = '### Worker reporting policy\nwrite one';
    assert.strictEqual(stripWorkerReports(before).description, before);
    assert.strictEqual(stripWorkerReports(before).sections, 0);
  });

  it('takes a deeper "#### " heading with the report and stops at the next "### "', () => {
    const lean = stripWorkerReports(
      '### Worker report\n#### Verify\nnpm test\n\n### Session questions\n- which one?'
    );
    assert.strictEqual(lean.description, '### Session questions\n- which one?');
  });

  it('leaves the heading alone when it is quoted inside a line of prose', () => {
    const before = 'The section is called ### Worker report and nothing else.';
    assert.strictEqual(stripWorkerReports(before).description, before);
  });

  it('a description that is nothing but reports strips to an empty string', () => {
    const lean = stripWorkerReports('### Worker report\none\n\n### Отчёт воркера\nдва');
    assert.strictEqual(lean.description, '');
    assert.strictEqual(lean.sections, 2);
  });

  it('reports nothing omitted when there is no report', () => {
    const lean = stripWorkerReports('Context.\n\n### Answers\nyes');
    assert.strictEqual(lean.description, 'Context.\n\n### Answers\nyes');
    assert.strictEqual(lean.sections, 0);
    assert.strictEqual(lean.bytes, 0);
  });
});

describe('round-trip on the real doc/backlog.md', () => {
  it('parseBacklog -> serializeBacklog -> parseBacklog yields the same tasks', (t) => {
    // Regression guard for the real dev backlog. In a clean public snapshot
    // (release-export) doc/backlog.md is an empty starter with no tasks, so
    // there is nothing to round-trip. Skip when the file is absent or parses to
    // no tasks; otherwise run it as before.
    if (!fs.existsSync(BACKLOG_PATH)) {
      t.skip('doc/backlog.md is absent (clean public snapshot)');
      return;
    }
    const realText = fs.readFileSync(BACKLOG_PATH, 'utf8');
    const tasksFirst = parseBacklog(realText);
    if (tasksFirst.length === 0) {
      t.skip('doc/backlog.md has no tasks (clean public snapshot)');
      return;
    }

    const reserialized = serializeBacklog(tasksFirst);
    const tasksSecond = parseBacklog(reserialized);

    assert.deepStrictEqual(tasksSecond, tasksFirst);
  });

  it('a write pass leaves the file byte for byte as it was (T-0087: no stray depends lines)', (t) => {
    if (!fs.existsSync(BACKLOG_PATH)) {
      t.skip('doc/backlog.md is absent (clean public snapshot)');
      return;
    }
    // Line endings are the working copy's business (git may check the file out
    // as CRLF on Windows); everything else must match exactly, which is what
    // catches a field written unconditionally.
    const realText = fs.readFileSync(BACKLOG_PATH, 'utf8').replace(/\r\n/g, '\n');
    const tasks = parseBacklog(realText);
    if (tasks.length === 0) {
      t.skip('doc/backlog.md has no tasks (clean public snapshot)');
      return;
    }
    assert.strictEqual(serializeBacklog(tasks), realText);
  });

  // Both of this project's own files, head included: the byte-for-byte test
  // above passes the default preamble, so it would go on passing if a write
  // replaced a custom head with it (T-0167).
  for (const file of [BACKLOG_PATH, archivePathFor(BACKLOG_PATH)]) {
    it(`a write pass preserves the preamble of ${path.basename(file)}`, (t) => {
      if (!fs.existsSync(file)) {
        t.skip(`${path.basename(file)} is absent (clean public snapshot)`);
        return;
      }
      const realText = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const tasks = parseBacklog(realText);
      if (tasks.length === 0) {
        t.skip(`${path.basename(file)} has no tasks (clean public snapshot)`);
        return;
      }
      assert.strictEqual(serializeBacklog(tasks, parsePreamble(realText)), realText);
    });
  }
});
