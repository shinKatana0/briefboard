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
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { removeTree } = require('./helpers/rm.js');

const REAL_SCRIPT = path.join(__dirname, '..', 'tools', 'release-export.mjs');

const dirs = [];

after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-release-export-')));
  dirs.push(root);

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
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-public-'))) + path.sep + 'tree';
  dirs.push(path.dirname(outDir));
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
  it('leaves the maintainer\'s task data behind', () => {
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

  it('seeds a .gitignore that keeps a public user\'s own tasks out of git', () => {
    const root = makeRepo();
    const { outDir, status, out } = exportFrom(root);
    assert.strictEqual(status, 0, out);

    const gi = fs.readFileSync(path.join(outDir, '.gitignore'), 'utf8').split(/\r?\n/);
    for (const rule of ['doc/backlog.md', 'doc/backlog-archive.md', 'doc/brief/*', '!doc/brief/.gitkeep']) {
      assert.ok(gi.includes(rule), `.gitignore is missing the rule ${rule}`);
    }
    assert.ok(gi.includes('node_modules/'), 'the exported .gitignore lost its own rules');
  });

  it('refuses to write into a non-empty dir', () => {
    const root = makeRepo();
    const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-public-')));
    dirs.push(outDir);
    fs.writeFileSync(path.join(outDir, 'already-here.txt'), 'x\n');

    const res = spawnSync(process.execPath, [path.join(root, 'tools', 'release-export.mjs'), '--out', outDir], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /refusing to write into a non-empty dir/);
  });
});
