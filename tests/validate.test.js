'use strict';

// Tests for server/validate.js — structural validation of doc/backlog.md.
// Run with: npm test  (or: node --test tests/**/*.test.js)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { validateBacklog } = require('../server/validate.js');
const { parseBacklog } = require('../server/parser.js');

const REAL_BACKLOG_PATH = path.join(__dirname, '..', 'doc', 'backlog.md');
const REAL_BRIEF_DIR = path.join(__dirname, '..', 'doc', 'brief');

// Create an isolated, throwaway doc/brief/-like directory so synthetic fixtures never
// depend on (or risk colliding with) the real project's doc/brief/.
function makeTmpBriefDir(fileNames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-validate-test-'));
  for (const name of fileNames) fs.writeFileSync(path.join(dir, name), '# fixture brief\n');
  return dir;
}

describe('validateBacklog() — synthetic fixtures', () => {
  it('returns [] for a well-formed backlog referencing an existing brief', () => {
    const briefDir = makeTmpBriefDir(['T-0001-01-some-slug.md']);
    const text = [
      '## T-0001 · Major · Valid task',
      '- type: feature',
      '- status: open',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: T-0001-01',
      '',
      'Some description.',
      '',
    ].join('\n');

    assert.deepStrictEqual(validateBacklog(text, briefDir), []);
  });

  it('returns [] for a backlog with no tasks at all (just a preamble)', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '# Backlog\n\n<!-- comment -->\n';
    assert.deepStrictEqual(validateBacklog(text, briefDir), []);
  });

  it('flags duplicate task ids', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = [
      '## T-0001 · Major · First',
      '- type: feature',
      '- status: open',
      '',
      '## T-0001 · Minor · Second (duplicate id)',
      '- type: feature',
      '- status: open',
      '',
    ].join('\n');

    const errors = validateBacklog(text, briefDir);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('T-0001') && /duplicate/i.test(e)));
  });

  it('flags an invalid raw status: value even though parseBacklog would silently default it', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '## T-0002 · Major · Bad status\n- type: feature\n- status: not_a_real_status\n';

    const errors = validateBacklog(text, briefDir);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('T-0002') && e.includes('status')));
  });

  it('flags an invalid raw type: value even though parseBacklog would silently default it', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '## T-0002 · Major · Bad type\n- type: chore\n- status: open\n';

    const errors = validateBacklog(text, briefDir);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('T-0002') && e.includes('type')));
  });

  it('flags a malformed header (missing "·" separators) that parseBacklog silently swallows', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = '## T-0003 Major Missing separators\n- type: feature\n- status: open\n';

    // Sanity check on the premise: parseBacklog does NOT see this as a task at all.
    const { parseBacklog } = require('../server/parser.js');
    assert.deepStrictEqual(parseBacklog(text), []);

    const errors = validateBacklog(text, briefDir);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => /malformed/i.test(e) && e.includes('T-0003')));
  });

  it('flags a brief reference that does not resolve to any file in briefDir', () => {
    const briefDir = makeTmpBriefDir([]); // deliberately empty
    const text = '## T-0004 · Major · Missing brief\n- type: feature\n- status: open\n- briefs: T-0004-01\n';

    const errors = validateBacklog(text, briefDir);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('T-0004') && e.includes('T-0004-01')));
  });

  it('accepts a brief reference resolved via the "<id>-<slug>.md" pattern (not just "<id>.md")', () => {
    const briefDir = makeTmpBriefDir(['T-0005-01-some-descriptive-slug.md']);
    const text = '## T-0005 · Major · Has brief\n- type: feature\n- status: open\n- briefs: T-0005-01\n';

    assert.deepStrictEqual(validateBacklog(text, briefDir), []);
  });

  it('still sees fields (and flags a bad raw status) when a blank line sits between the header and the fields (T-0055)', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = [
      '## T-0006 · Major · Blank line before fields',
      '',
      '- type: feature',
      '- status: not_a_real_status',
      '',
    ].join('\n');

    const errors = validateBacklog(text, briefDir);
    assert.ok(errors.some((e) => e.includes('T-0006') && e.includes('status')));
  });

  it('accepts a well-formed task that has a blank line between the header and its fields (T-0055)', () => {
    const briefDir = makeTmpBriefDir(['T-0007-01-slug.md']);
    const text = [
      '## T-0007 · Major · Blank line before fields, otherwise valid',
      '',
      '- type: feature',
      '- status: open',
      '- created: 2026-01-01 00:00:00',
      '- closed: —',
      '- briefs: T-0007-01',
      '',
      'Description.',
      '',
    ].join('\n');

    assert.deepStrictEqual(validateBacklog(text, briefDir), []);
  });

  it('reports multiple independent problems at once', () => {
    const briefDir = makeTmpBriefDir([]);
    const text = [
      '## T-0001 · Major · First',
      '- type: feature',
      '- status: not_a_real_status',
      '- briefs: T-0001-01',
      '',
      '## T-0001 · Minor · Duplicate of first',
      '- type: bogus',
      '- status: open',
      '',
    ].join('\n');

    const errors = validateBacklog(text, briefDir);
    // duplicate id + bad status + bad brief ref + bad type => at least 4 distinct problems
    assert.ok(errors.length >= 4, `expected >= 4 errors, got ${errors.length}: ${errors.join(' | ')}`);
  });
});

describe('validateBacklog() — real project files', () => {
  it('returns [] for the current doc/backlog.md + doc/brief/ (regression guard)', (t) => {
    // This is a regression guard for the real dev backlog. In a clean public
    // snapshot (release-export), doc/backlog.md is replaced by an empty starter
    // and doc/brief/ is empty, so there is nothing to guard. Skip the test when
    // the backlog is absent or parses to no tasks; otherwise run it as before.
    if (!fs.existsSync(REAL_BACKLOG_PATH)) {
      t.skip('doc/backlog.md is absent (clean public snapshot)');
      return;
    }
    const text = fs.readFileSync(REAL_BACKLOG_PATH, 'utf8');
    if (parseBacklog(text).length === 0) {
      t.skip('doc/backlog.md has no tasks (clean public snapshot)');
      return;
    }
    const errors = validateBacklog(text, REAL_BRIEF_DIR);
    assert.deepStrictEqual(errors, []);
  });
});
