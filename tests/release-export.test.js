'use strict';

// Tests for tools/release-export.mjs - the bridge that assembles the CLEAN public
// tree out of this private dev repo (T-0212). What it must NOT carry across is the
// point: the maintainer's dev tasks live in doc/backlog.md, doc/backlog-archive.md
// and doc/brief/, and a leak there is a leak of personal paths and private task
// history into a public GitHub repository.
//
// The script exports the repository it lives in (ROOT is derived from its own
// path), so each case copies the real script into a throwaway git repo and runs it
// there. Copying rather than re-implementing is deliberate: the fixture exercises
// the shipped file, not a paraphrase of it.

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isPublicTree, skipOutsideExport, SEEDED_IGNORE_RULES } = require('./helpers/public-tree.js');
const { tempDir } = require('./helpers/tmp.js');

const REAL_SCRIPT = path.join(__dirname, '..', 'tools', 'release-export.mjs');

// The script exports itself out of the public tree, so there is no script to copy
// there and every case that runs it is skipped (T-0252) — on a positive marker of
// the public tree; see tests/helpers/public-tree.js for why absence would be the
// wrong key.
const SKIP_NO_SCRIPT = skipOutsideExport('tools/release-export.mjs');

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

// A repo shaped like this one: shipped files plus the dev-only task data.
function makeRepo() {
  const root = fs.realpathSync(tempDir('briefboard-release-export-'));

  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, path.join(root, 'tools', 'release-export.mjs'));

  write(root, 'README.md', '# briefboard\n');
  write(root, 'RELEASING.md', '# private release notes\n');
  write(root, 'server/server.js', "'use strict';\n");
  write(root, 'doc/guide/guide.en.md', '# guide\n');
  write(root, 'doc/backlog.md', '# Backlog\n\n## T-0002 · Major · open task\n');
  write(root, 'doc/backlog-archive.md', '# Backlog archive\n\n## T-0001 · Major · closed task\n\nLogs: C:\\Users\\someone\\scratch\\\n');
  write(root, 'doc/brief/T-0001-01-thing.md', '# brief\n');
  write(root, '.gitignore', 'node_modules/\n');

  git(['init'], root);
  git(['config', 'user.email', 'test@briefboard.invalid'], root);
  git(['config', 'user.name', 'briefboard test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['add', '.'], root);
  git(['commit', '-m', 'init'], root);
  return root;
}

function exportFrom(root) {
  const outDir = fs.realpathSync(tempDir('briefboard-public-')) + path.sep + 'tree';
  const res = spawnSync(process.execPath, [path.join(root, 'tools', 'release-export.mjs'), '--out', outDir], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  return { outDir, status: res.status, out: `${res.stdout}${res.stderr}` };
}

const has = (dir, rel) => fs.existsSync(path.join(dir, rel));

describe('release-export: the public tree', () => {
  it('leaves the maintainer\'s task data behind', { skip: SKIP_NO_SCRIPT }, () => {
    const root = makeRepo();

    // Guard the fixture: the files below have to be IN the source repo and tracked,
    // or their absence downstream would prove nothing about the script.
    const tracked = git(['ls-files'], root).split('\n');
    for (const rel of ['doc/backlog.md', 'doc/backlog-archive.md', 'doc/brief/T-0001-01-thing.md', 'RELEASING.md', 'tools/release-export.mjs']) {
      assert.ok(tracked.includes(rel), `fixture is missing ${rel}`);
    }

    const { outDir, status, out } = exportFrom(root);
    assert.strictEqual(status, 0, out);

    assert.ok(!has(outDir, 'doc/backlog.md'), 'the dev backlog reached the public tree');
    assert.ok(!has(outDir, 'doc/backlog-archive.md'), 'the dev backlog archive reached the public tree');
    assert.ok(!has(outDir, 'doc/brief/T-0001-01-thing.md'), 'a dev brief reached the public tree');
    assert.ok(!has(outDir, 'RELEASING.md'), 'the private release notes reached the public tree');
    assert.ok(!has(outDir, 'tools/release-export.mjs'), 'the export script reached the public tree');

    // ...and still carries everything that is the tool itself.
    assert.ok(has(outDir, 'README.md'));
    assert.ok(has(outDir, 'server/server.js'));
    assert.ok(has(outDir, 'doc/guide/guide.en.md'));
    assert.ok(has(outDir, 'doc/brief/.gitkeep'), 'the empty brief dir is not preserved');
  });

  it('seeds a .gitignore that keeps a public user\'s own tasks out of git', { skip: SKIP_NO_SCRIPT }, () => {
    const root = makeRepo();
    const { outDir, status, out } = exportFrom(root);
    assert.strictEqual(status, 0, out);

    const gi = fs.readFileSync(path.join(outDir, '.gitignore'), 'utf8').split(/\r?\n/);
    for (const rule of ['doc/backlog.md', 'doc/backlog-archive.md', 'doc/brief/*', '!doc/brief/.gitkeep']) {
      assert.ok(gi.includes(rule), `.gitignore is missing the rule ${rule}`);
    }
    assert.ok(gi.includes('node_modules/'), 'the exported .gitignore lost its own rules');
  });

  it('refuses to write into a non-empty dir', { skip: SKIP_NO_SCRIPT }, () => {
    const root = makeRepo();
    const outDir = fs.realpathSync(tempDir('briefboard-public-'));
    fs.writeFileSync(path.join(outDir, 'already-here.txt'), 'x\n');

    const res = spawnSync(process.execPath, [path.join(root, 'tools', 'release-export.mjs'), '--out', outDir], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /refusing to write into a non-empty dir/);
  });
});

// The marker that decides whether the three cases above run at all (T-0252). It
// is what stands between "this check does not apply in the public repo" and "this
// check has quietly stopped running", so it gets tests of its own — and these run
// in BOTH trees, because a marker nobody checks is the dead guard one level up.
describe('the public-tree marker', () => {
  // The one assertion that holds on either side, so neither side can skip it: here
  // the export script is present and the tree is not public; in the exported tree
  // the script is gone and it is. Lose release-export.mjs by accident here and this
  // fails rather than flipping the whole file to skipped.
  it('agrees with whether this checkout still carries the export script', () => {
    const carriesScript = fs.existsSync(REAL_SCRIPT);
    assert.strictEqual(
      isPublicTree(),
      !carriesScript,
      carriesScript
        ? 'this checkout has tools/release-export.mjs, so it is the dev repo, but the marker says public'
        : 'tools/release-export.mjs is gone but the marker does not see a public tree — either the export changed what it writes, or a file was deleted here by accident'
    );
  });

  it('fires on a tree the real export has just produced', { skip: SKIP_NO_SCRIPT }, () => {
    const { outDir, status, out } = exportFrom(makeRepo());
    assert.strictEqual(status, 0, out);
    // Direct evidence rather than a restatement of the marker's own rule: the tree
    // under it came out of the shipped script.
    assert.strictEqual(isPublicTree(outDir), true, 'the export produced a tree the marker does not recognise');
  });

  // The trap this task exists for. A marker keyed on "RELEASING.md is missing" —
  // or on any other absence — turns a deletion in this repository into a silent
  // skip. This fixture is that accident: every file the naive key would look for is
  // gone, and nothing the export writes is there. The marker must stay false.
  it('stays false on a dev tree that lost the very files those tests read', () => {
    const root = fs.realpathSync(tempDir('briefboard-lost-files-'));
    write(root, 'README.md', '# briefboard\n');
    write(root, 'doc/brief/T-0001-01-thing.md', '# brief\n');
    // This repository's own .gitignore, which carries none of the seeded rules.
    fs.copyFileSync(path.join(__dirname, '..', '.gitignore'), path.join(root, '.gitignore'));
    // No RELEASING.md, no tools/release-export.mjs, no doc/backlog.md: the deletion.
    assert.ok(!has(root, 'RELEASING.md') && !has(root, 'tools/release-export.mjs') && !has(root, 'doc/backlog.md'));

    assert.strictEqual(isPublicTree(root), false, 'a missing file must not read as a public tree');
  });

  // Each mark alone is one plausible accident away from being true here, which is
  // why both are required; these fix that so it cannot be relaxed unnoticed.
  it('needs both marks, not either one', () => {
    const onlyGitkeep = fs.realpathSync(tempDir('briefboard-mark-keep-'));
    const onlyRules = fs.realpathSync(tempDir('briefboard-mark-rules-'));

    write(onlyGitkeep, 'doc/brief/.gitkeep', '');
    write(onlyGitkeep, '.gitignore', 'node_modules\n');
    assert.strictEqual(isPublicTree(onlyGitkeep), false, '.gitkeep alone must not read as a public tree');

    write(onlyRules, '.gitignore', `node_modules\n${SEEDED_IGNORE_RULES.join('\n')}\n`);
    assert.strictEqual(isPublicTree(onlyRules), false, 'the ignore rules alone must not read as a public tree');
  });
});
