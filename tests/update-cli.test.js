'use strict';

// Tests for `briefboard update` and the install manifest (T-0094).
// Run with: npm test  (or: node --test tests/**/*.test.js)
//
// Every test builds a THROWAWAY copy of the package in os.tmpdir() and installs
// it into another throwaway directory, so the real project is never read as a
// target and never written to. Two package copies are used: "old" installs the
// project, "new" is what update compares against - that is the only way to get
// a genuine version difference without publishing anything.

require('./helpers/env.js');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const PACKAGE_PARTS = ['server', 'tools', 'ui', 'agents', 'AGENTS.md', 'CLAUDE.md', 'bin', 'package.json'];

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTmpDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

/** A self-contained copy of this package, optionally at a different version. */
function makePackage(version, mutate) {
  const dir = makeTmpDir('briefboard-pkg-');
  for (const name of PACKAGE_PARTS) {
    fs.cpSync(path.join(REPO_ROOT, name), path.join(dir, name), { recursive: true });
  }
  const pkgFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  if (mutate) mutate(dir);
  return dir;
}

function run(pkgDir, cwd, args) {
  return spawnSync(process.execPath, [path.join(pkgDir, 'bin', 'briefboard-init.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function install(pkgDir) {
  const dir = makeTmpDir('briefboard-proj-');
  const res = run(pkgDir, dir, ['init']);
  assert.strictEqual(res.status, 0, `init failed: ${res.stderr}`);
  return dir;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** rel path -> content hash for every file in a tree, so writes are detectable. */
function snapshot(dir, rel = '', out = {}) {
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    const next = rel ? `${rel}/${name}` : name;
    const abs = path.join(dir, next);
    if (fs.statSync(abs).isDirectory()) snapshot(dir, next, out);
    else out[next] = hash(abs);
  }
  return out;
}

function manifestOf(project) {
  return JSON.parse(fs.readFileSync(path.join(project, '.briefboard', 'installed.json'), 'utf8'));
}

function appendTo(file, text) {
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n${text}\n`);
}

/** Makes one file unlisted while the manifest itself stays in place. */
function dropFromManifest(project, rel) {
  const file = path.join(project, '.briefboard', 'installed.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete manifest.files[rel];
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

// The fixture used by most tests: a project installed from 0.0.1-test, then a
// 0.0.2-test package that changes one file and adds another, plus one file the
// user edited afterwards.
function fixture() {
  const oldPkg = makePackage('0.0.1-test');
  const project = install(oldPkg);
  const newPkg = makePackage('0.0.2-test', (dir) => {
    appendTo(path.join(dir, 'ui', 'index.html'), '<!-- shipped in 0.0.2-test -->');
    fs.writeFileSync(path.join(dir, 'server', 'newthing.js'), '// added in 0.0.2-test\n');
  });
  appendTo(path.join(project, 'agents', 'WORKER.md'), 'My own house rule.');
  return { oldPkg, newPkg, project };
}

describe('install manifest', () => {
  it('init records the package version and a hash per copied file', () => {
    const pkg = makePackage('0.0.1-test');
    const project = install(pkg);

    const manifest = manifestOf(project);
    assert.strictEqual(manifest.version, '0.0.1-test');
    for (const rel of ['server/server.js', 'tools/task.mjs', 'ui/index.html', 'agents/WORKER.md', 'AGENTS.md']) {
      assert.strictEqual(manifest.files[rel], hash(path.join(project, rel)), `manifest hash for ${rel}`);
    }
    // doc/ is the user's data and never belongs to the manifest.
    assert.ok(!Object.keys(manifest.files).some((rel) => rel.startsWith('doc/')));
  });

  it('a rerun of init on a ready project still overwrites nothing', () => {
    const pkg = makePackage('0.0.1-test');
    const project = install(pkg);
    appendTo(path.join(project, 'AGENTS.md'), 'sentinel');
    const before = snapshot(project);

    const res = run(pkg, project, ['init']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /skip existing: server/);
    assert.deepStrictEqual(snapshot(project), before);
  });
});

describe('briefboard update (plan only)', () => {
  it('changes nothing on disk and prints a category per file', () => {
    const { newPkg, project } = fixture();
    const before = snapshot(project);

    const res = run(newPkg, project, ['update']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(snapshot(project), before, 'a plain update must not write anything');
    assert.match(res.stdout, /Nothing has been changed/);
    assert.match(res.stdout, /--apply/);
  });

  it('tells outdated, locally modified and up-to-date files apart', () => {
    const { newPkg, project } = fixture();

    const { stdout } = run(newPkg, project, ['update']);

    assert.match(stdout, /outdated .*ui\/index\.html/);
    assert.match(stdout, /MODIFIED LOCALLY .*agents\/WORKER\.md/);
    assert.match(stdout, /up to date .*server\/server\.js/);
    assert.match(stdout, /new in package .*server\/newthing\.js/);
    assert.match(stdout, /Locally modified, NOT replaced/);
  });

  it('reports the package version and the project copy version', () => {
    const { newPkg, project } = fixture();

    const { stdout } = run(newPkg, project, ['update']);

    assert.match(stdout, /package 0\.0\.2-test, this project's copy 0\.0\.1-test/);
  });
});

describe('briefboard update without a manifest (installs predating it)', () => {
  it('succeeds and calls every differing file no manifest', () => {
    const { newPkg, project } = fixture();
    fs.rmSync(path.join(project, '.briefboard'), { recursive: true, force: true });

    const res = run(newPkg, project, ['update']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /this project's copy unknown/);
    assert.match(res.stdout, /no manifest .*ui\/index\.html/);
    // The file the user edited is indistinguishable from an outdated one here -
    // nothing was recorded to compare either of them against.
    assert.match(res.stdout, /no manifest .*agents\/WORKER\.md/);
    assert.doesNotMatch(res.stdout, /MODIFIED LOCALLY/);
    assert.doesNotMatch(res.stdout, /unknown provenance/);
  });

  // The whole point of T-0154: an untouched pre-0.2.0 install used to open with
  // 13 files marked "unknown provenance" and no word on why.
  it('names the cause before the list of files', () => {
    const { newPkg, project } = fixture();
    fs.rmSync(path.join(project, '.briefboard'), { recursive: true, force: true });

    const { stdout } = run(newPkg, project, ['update']);

    assert.match(stdout, /installed by a briefboard before 0\.2\.0/);
    assert.ok(
      stdout.indexOf('before 0.2.0') < stdout.indexOf('ui/index.html'),
      `the cause must come before the file list:\n${stdout}`,
    );
    // It explains why provenance is unknown; it never claims the files are intact.
    assert.doesNotMatch(stdout, /unmodified|unchanged|not been (modified|changed)/i);
  });

  it('--apply backs everything replaceable up and writes a manifest', () => {
    const { newPkg, project } = fixture();
    fs.rmSync(path.join(project, '.briefboard'), { recursive: true, force: true });
    const oldUi = fs.readFileSync(path.join(project, 'ui', 'index.html'), 'utf8');

    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(res.status, 0, res.stderr);
    const backupDir = res.stdout.match(/backup of the replaced files: (.+)/)[1].trim();
    assert.strictEqual(fs.readFileSync(path.join(backupDir, 'ui', 'index.html'), 'utf8'), oldUi);
    assert.strictEqual(manifestOf(project).version, '0.0.2-test');
  });
});

// The error T-0154 must not create: "installed by an old version" is a claim
// about the whole project, and a file the manifest never listed is not covered
// by it - it was brought in by hand, lost in a merge, or something else nobody
// recorded. There the suspicion is warranted and the old label stays.
describe('briefboard update with a manifest that does not list a file', () => {
  it('keeps unknown provenance for that file and explains nothing away', () => {
    const { newPkg, project } = fixture();
    dropFromManifest(project, 'ui/index.html');

    const { stdout } = run(newPkg, project, ['update']);

    assert.match(stdout, /unknown provenance .*ui\/index\.html/);
    assert.doesNotMatch(stdout, /no manifest/);
    assert.doesNotMatch(stdout, /before 0\.2\.0/);
    // The rest of the project is still judged against the manifest it has.
    assert.match(stdout, /MODIFIED LOCALLY .*agents\/WORKER\.md/);
  });
});

describe('briefboard update --apply', () => {
  it('replaces outdated files, keeps a backup with the original paths, and updates the manifest', () => {
    const { newPkg, project } = fixture();
    const uiBefore = fs.readFileSync(path.join(project, 'ui', 'index.html'), 'utf8');

    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(res.status, 0, res.stderr);
    const ui = path.join(project, 'ui', 'index.html');
    assert.strictEqual(fs.readFileSync(ui, 'utf8'), fs.readFileSync(path.join(newPkg, 'ui', 'index.html'), 'utf8'));
    assert.ok(fs.existsSync(path.join(project, 'server', 'newthing.js')), 'a file new in the package is added');

    const backupDir = res.stdout.match(/backup of the replaced files: (.+)/)[1].trim();
    assert.ok(backupDir.includes(path.join('.briefboard', 'backup')), `backup under .briefboard: ${backupDir}`);
    assert.strictEqual(fs.readFileSync(path.join(backupDir, 'ui', 'index.html'), 'utf8'), uiBefore);
    // Nothing was replaced for these, so nothing is backed up for them either.
    assert.ok(!fs.existsSync(path.join(backupDir, 'server', 'newthing.js')));
    assert.ok(!fs.existsSync(path.join(backupDir, 'agents', 'WORKER.md')));

    const manifest = manifestOf(project);
    assert.strictEqual(manifest.version, '0.0.2-test');
    assert.strictEqual(manifest.files['ui/index.html'], hash(ui));
  });

  it('leaves locally modified files alone and lists them as skipped', () => {
    const { newPkg, project } = fixture();
    const worker = path.join(project, 'agents', 'WORKER.md');
    const mine = fs.readFileSync(worker, 'utf8');

    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(fs.readFileSync(worker, 'utf8'), mine);
    assert.match(res.stdout, /Locally modified, NOT replaced[\s\S]*agents\/WORKER\.md/);
    // The skipped file keeps its pre-update manifest entry, so the next update
    // still sees it as modified rather than as safe to overwrite.
    const second = run(newPkg, project, ['update']);
    assert.match(second.stdout, /MODIFIED LOCALLY .*agents\/WORKER\.md/);
  });

  it('--force replaces locally modified files but still backs them up', () => {
    const { newPkg, project } = fixture();
    const worker = path.join(project, 'agents', 'WORKER.md');
    const mine = fs.readFileSync(worker, 'utf8');

    const res = run(newPkg, project, ['update', '--apply', '--force']);

    assert.strictEqual(
      fs.readFileSync(worker, 'utf8'),
      fs.readFileSync(path.join(newPkg, 'agents', 'WORKER.md'), 'utf8'),
    );
    const backupDir = res.stdout.match(/backup of the replaced files: (.+)/)[1].trim();
    assert.strictEqual(fs.readFileSync(path.join(backupDir, 'agents', 'WORKER.md'), 'utf8'), mine);
  });

  it('never touches doc/, with or without --force', () => {
    const { newPkg, project } = fixture();
    const backlog = path.join(project, 'doc', 'backlog.md');
    appendTo(backlog, '## T-0001 · Blocker · my own task');
    const docBefore = snapshot(path.join(project, 'doc'));

    assert.strictEqual(run(newPkg, project, ['update', '--apply']).status, 0);
    assert.deepStrictEqual(snapshot(path.join(project, 'doc')), docBefore);

    assert.strictEqual(run(newPkg, project, ['update', '--apply', '--force']).status, 0);
    assert.deepStrictEqual(snapshot(path.join(project, 'doc')), docBefore);
  });

  it('reports an already current project as up to date and writes nothing', () => {
    const pkg = makePackage('0.0.1-test');
    const project = install(pkg);
    const before = snapshot(project);

    const res = run(pkg, project, ['update', '--apply']);

    assert.match(res.stdout, /Everything is up to date/);
    assert.deepStrictEqual(snapshot(project), before);
  });

  it('rejects an unknown option', () => {
    const { newPkg, project } = fixture();
    const res = run(newPkg, project, ['update', '--nope']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /unknown option for update: --nope/);
  });
});

// T-0158. A null manifest used to mean two different things at once - there is
// no file, and there is one that could not be read - and only the first was ever
// explained. The second is the suspicious one, and the only one where a person
// has something to repair, so it gets said out loud without being touched.
describe('briefboard with a manifest that exists but cannot be read', () => {
  const damage = (project, text) =>
    fs.writeFileSync(path.join(project, '.briefboard', 'installed.json'), text);

  it('update names the file and the reason, and changes nothing', () => {
    const { newPkg, project } = fixture();
    damage(project, '{"version": "0.0.1-test", "files": {');
    const before = snapshot(project);

    const res = run(newPkg, project, ['update']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /WARNING: \.briefboard\/installed\.json could not be read: \S/);
    assert.match(res.stderr, /repair the JSON/);
    assert.deepStrictEqual(snapshot(project), before);
  });

  it('is not confused with a project that has no manifest', () => {
    const { newPkg, project } = fixture();
    damage(project, '{"version": "0.0.1-test", "files": {');

    const res = run(newPkg, project, ['update']);

    // The pre-0.2.0 explanation is a claim about a version that never wrote a
    // manifest; this project's did, and the file is right there.
    assert.doesNotMatch(res.stdout, /no manifest/);
    assert.doesNotMatch(res.stdout, /installed by a briefboard before/);
    assert.match(res.stdout, /this project's copy unknown/);
    assert.match(res.stdout, /unknown provenance .*ui\/index\.html/);
  });

  it('says so too when the JSON parses but is not a manifest', () => {
    const { newPkg, project } = fixture();
    damage(project, '{"version": "0.0.1-test"}');

    const res = run(newPkg, project, ['update']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /is not an install manifest/);
    assert.doesNotMatch(res.stdout, /no manifest/);
  });

  it('--version stops reporting the file as absent', () => {
    const { newPkg, project } = fixture();
    damage(project, 'not json at all');

    const { stdout, stderr } = run(newPkg, project, ['--version']);

    assert.match(stderr, /WARNING: \.briefboard\/installed\.json could not be read/);
    assert.match(stdout, /this project's copy: unknown \(\.briefboard\/installed\.json could not be read\)/);
    assert.doesNotMatch(stdout, /no \.briefboard\/installed\.json/);
  });

  it('an absent manifest keeps its own explanation and raises no warning', () => {
    const { newPkg, project } = fixture();
    fs.rmSync(path.join(project, '.briefboard'), { recursive: true, force: true });

    const res = run(newPkg, project, ['update']);

    assert.doesNotMatch(res.stderr, /WARNING/);
    assert.match(res.stdout, /installed by a briefboard before 0\.2\.0/);
  });

  it('--apply is the way out: it reinstalls and writes a manifest that reads', () => {
    const { newPkg, project } = fixture();
    damage(project, '{"version": "0.0.1-test", "files": {');

    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /could not be read/);
    assert.strictEqual(manifestOf(project).version, '0.0.2-test');
  });
});

describe('briefboard --version', () => {
  it('prints both versions and hints at update when they differ', () => {
    const { newPkg, project } = fixture();

    const { stdout } = run(newPkg, project, ['--version']);

    assert.match(stdout, /briefboard 0\.0\.2-test/);
    assert.match(stdout, /this project's copy: 0\.0\.1-test/);
    assert.match(stdout, /versions differ/);
  });

  it('says the project copy is unknown when there is no manifest', () => {
    const { newPkg, project } = fixture();
    fs.rmSync(path.join(project, '.briefboard'), { recursive: true, force: true });

    const { stdout } = run(newPkg, project, ['--version']);

    assert.match(stdout, /this project's copy: unknown/);
  });

  it('does not hint at update when the versions match', () => {
    const pkg = makePackage('0.0.1-test');
    const project = install(pkg);

    const { stdout } = run(pkg, project, ['--version']);

    assert.match(stdout, /this project's copy: 0\.0\.1-test/);
    assert.doesNotMatch(stdout, /versions differ/);
  });
});
