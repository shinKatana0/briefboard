'use strict';

// T-0175: `.claude/agents/worker.md` has to carry agents/WORKER.md verbatim, and
// until now nothing produced it — every worker that touched the protocol
// reassembled the copy by hand and learned from the test afterwards that it had
// got it wrong. tools/sync-worker-agent.mjs is the producer; these tests cover
// what it makes, that `--check` reports staleness without writing, and that the
// tool stays out of the package.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { tempDir } = require('./helpers/tmp.js');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'sync-worker-agent.mjs');

let sync;
before(async () => {
  sync = await import(pathToFileURL(CLI).href);
});

// A project tree with nothing in it but the two files the script cares about.
function makeFixture(workerDoc, copy) {
  const root = tempDir('briefboard-sync-');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'WORKER.md'), workerDoc);
  if (copy !== undefined) fs.writeFileSync(path.join(root, '.claude', 'agents', 'worker.md'), copy);
  return root;
}

const readCopy = (root) => fs.readFileSync(path.join(root, '.claude', 'agents', 'worker.md'), 'utf8');

describe('the subagent file is generated from the protocol (T-0175)', () => {
  it('carries the frontmatter, the whole body, and the subagent tail', () => {
    const body = '# WORKER.md — worker instructions\n\nRule one.\n';
    const out = sync.renderWorkerAgent(body);

    assert.match(out, /^---\nname: worker\ndescription: .+\n---\n/, 'the frontmatter Claude Code dispatches on');
    assert.ok(out.includes(body.trim()), 'the protocol body, verbatim');
    assert.match(out, /\n## Environment context\n/, 'the tail about being a subagent');
    assert.ok(out.indexOf('Rule one.') < out.indexOf('## Environment context'), 'the tail comes last');
  });

  it('keeps the line endings of the source', () => {
    const lf = sync.renderWorkerAgent('# WORKER.md\n\nRule one.\n');
    assert.ok(!lf.includes('\r'), 'an LF checkout stays LF');

    const crlf = sync.renderWorkerAgent('# WORKER.md\r\n\r\nRule one.\r\n');
    assert.ok(!/[^\r]\n/.test(crlf), 'a CRLF checkout stays CRLF, with no mixed line left behind');
  });

  it('writes the file when it is missing, and reports the change', () => {
    const root = makeFixture('# WORKER.md\n\nRule one.\n');
    assert.deepStrictEqual(sync.syncWorkerAgent(root), { changed: true });
    assert.match(readCopy(root), /Rule one\./);
  });

  it('rewrites a stale copy and then reports nothing to do', () => {
    const root = makeFixture('# WORKER.md\n\nRule two.\n', 'stale\n');
    assert.strictEqual(sync.syncWorkerAgent(root).changed, true);
    assert.match(readCopy(root), /Rule two\./);
    assert.strictEqual(sync.syncWorkerAgent(root).changed, false, 'a second run is a no-op');
  });

  it('--check leaves a stale copy exactly as it was', () => {
    const root = makeFixture('# WORKER.md\n\nRule three.\n', 'stale\n');
    assert.strictEqual(sync.syncWorkerAgent(root, { check: true }).changed, true);
    assert.strictEqual(readCopy(root), 'stale\n', 'checking must not write');
  });
});

describe('the repository copy is the generated one (T-0175)', () => {
  // The test above proves the generator; this one proves the committed file is
  // its output — the state a hand-edit of either side breaks.
  it('--check passes on this checkout', () => {
    const res = spawnSync(process.execPath, [CLI, '--check'], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
  });

  it('--check on a stale tree exits non-zero and names the command that fixes it', () => {
    // The script resolves its tree from its own location, so a copy of it inside
    // the fixture is what makes the failing path reachable from the CLI.
    const root = makeFixture('# WORKER.md\n\nRule four.\n', 'stale\n');
    fs.mkdirSync(path.join(root, 'tools'));
    const cli = path.join(root, 'tools', 'sync-worker-agent.mjs');
    fs.copyFileSync(CLI, cli);

    const res = spawnSync(process.execPath, [cli, '--check'], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /npm run sync:worker-agent/, 'a failure has to say how to fix itself');
    assert.strictEqual(readCopy(root), 'stale\n', 'and it must still write nothing');

    const fix = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(fix.status, 0);
    assert.match(readCopy(root), /Rule four\./);
  });
});

// A development tool for this repository, so the package must not carry it.
// `files` lists tools/ per file exactly so that stays true by construction.
// Verified for real with `npm pack`; this is the regression guard on top of that.
describe('the sync tool stays out of the package (T-0175)', () => {
  it('package.json packs tools per file, and not this one', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(!pkg.files.includes('tools'), 'packing the whole tools/ directory would ship every dev script');
    assert.ok(!pkg.files.includes('tools/sync-worker-agent.mjs'), 'the sync tool is not part of the product');
    assert.ok(pkg.files.includes('tools/task.mjs'), 'the CLI a user runs still ships');
  });

  it('npm run sync:worker-agent is the documented way to run it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts['sync:worker-agent'], 'node tools/sync-worker-agent.mjs');
  });
});
