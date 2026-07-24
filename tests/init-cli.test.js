'use strict';

// Tests for bin/briefboard-init.mjs — the `npx briefboard init` scaffolder.
// Run with: npm test  (or: node --test tests/**/*.test.js)
//
// Each test runs the real bin script as a child process against a throwaway
// working directory (cwd = a fresh mkdtemp dir), so the project's own files are
// never touched. We assert the two behaviours the release brief (T-0059) pins:
//   1. a first run scaffolds an EMPTY doc/backlog.md, byte-identical to
//      serializeBacklog([]) — never a copy of this dev backlog;
//   2. a rerun is idempotent — it prints "skip existing" and overwrites nothing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { serializeBacklog, parseBacklog } = require('../server/parser.js');

const BIN_PATH = path.join(__dirname, '..', 'bin', 'briefboard-init.mjs');

/** Run `node bin/briefboard-init.mjs init` with cwd set to an isolated target dir. */
function runInit(cwd) {
  return spawnSync(process.execPath, [BIN_PATH, 'init'], { cwd, encoding: 'utf8' });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-init-test-'));
}

function backlogPath(dir) {
  return path.join(dir, 'doc', 'backlog.md');
}

describe('briefboard init', () => {
  it('scaffolds an empty doc/backlog.md equal to serializeBacklog([]) on a first run', () => {
    const dir = makeTmpDir();
    const res = runInit(dir);

    assert.strictEqual(res.status, 0, `init failed: ${res.stderr}`);
    assert.match(res.stdout, /created: doc\/backlog\.md/);

    const p = backlogPath(dir);
    assert.ok(fs.existsSync(p), 'doc/backlog.md should exist after init');

    const content = fs.readFileSync(p, 'utf8');
    // Byte-identical to the empty-backlog template — not a copy of any dev backlog.
    assert.strictEqual(content, serializeBacklog([]));
    // And it parses to zero tasks.
    assert.deepStrictEqual(parseBacklog(content), []);
  });

  it('is idempotent: a rerun prints "skip existing" and overwrites nothing', () => {
    const dir = makeTmpDir();

    const first = runInit(dir);
    assert.strictEqual(first.status, 0, `first init failed: ${first.stderr}`);

    // Mutate the scaffolded backlog so any accidental overwrite is detectable.
    const p = backlogPath(dir);
    const sentinel = fs.readFileSync(p, 'utf8') + '\n<!-- sentinel: user edit -->\n';
    fs.writeFileSync(p, sentinel);

    const second = runInit(dir);
    assert.strictEqual(second.status, 0, `second init failed: ${second.stderr}`);

    // "skip existing" warnings go to stderr (console.warn); "created" to stdout.
    assert.match(second.stderr, /skip existing: doc\/backlog\.md/);
    assert.match(second.stderr, /skip existing: doc\/brief/);
    assert.match(second.stderr, /skip existing: server/);
    assert.doesNotMatch(second.stdout, /created:/);

    // The user's sentinel edit survived — the file was not overwritten.
    assert.strictEqual(fs.readFileSync(p, 'utf8'), sentinel);
  });
});
