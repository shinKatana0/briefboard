'use strict';

// Tests for server/parser.js — the backlog.md <-> task-object (de)serializer.
// Run with: npm test  (or: node --test tests/**/*.test.js)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const os = require('node:os');

const {
  parseBacklog,
  serializeBacklog,
  nowStamp,
  STATUSES,
  PRIORITIES,
  BRIEF_ID_RE,
  findBriefFile,
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

  it('defaults type to feature when field is missing or not "bug"', () => {
    const noType = parseBacklog('## T-0001 · Major · No type field\n- status: open\n')[0];
    assert.strictEqual(noType.type, 'feature');

    const otherType = parseBacklog('## T-0002 · Major · Weird type\n- type: chore\n')[0];
    assert.strictEqual(otherType.type, 'feature');
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
  // A non-empty sentinel preamble: passing '' would be falsy and fall back to
  // the built-in default preamble (see the `preamble || default` in the source).
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

describe('findBriefFile() — shared brief lookup (used by server.js + validate.js)', () => {
  // Build a throwaway brief directory so the lookup rules can be asserted in
  // isolation, independent of the real doc/brief/ contents.
  function makeBriefDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-brief-'));
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
    const dir = path.join(os.tmpdir(), 'agentboard-brief-does-not-exist-xyz');
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
});
