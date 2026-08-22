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
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./helpers/tmp.js');

const REPO_ROOT = path.join(__dirname, '..');
const PACKAGE_PARTS = ['server', 'tools', 'ui', 'agents', 'AGENTS.md', 'CLAUDE.md', 'bin', 'package.json'];

// fs.realpathSync: on macOS os.tmpdir() is a symlink, and a path this file
// compares against what a child process reports has to be the resolved one.
function makeTmpDir(prefix) {
  return fs.realpathSync(tempDir(prefix));
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

function install(pkgDir, seed) {
  const dir = makeTmpDir('briefboard-proj-');
  if (seed) seed(dir);
  const res = run(pkgDir, dir, ['init']);
  assert.strictEqual(res.status, 0, `init failed: ${res.stderr}`);
  return dir;
}

// ---------- the merge block (T-0294) ----------

const MARKER_START = '<!-- briefboard:start -->';
const MARKER_END = '<!-- briefboard:end -->';
const BLOCK_PREFIX = 'block:';

/** A merge entry's manifest value: the hash of the block's INNER text, prefixed. */
function blockValue(inner) {
  return BLOCK_PREFIX + crypto.createHash('sha256').update(Buffer.from(inner, 'utf8')).digest('hex');
}

/** Points the manifest at a value, so a hand-built block can be vouched for. */
function setManifestValue(project, rel, value) {
  const file = path.join(project, '.briefboard', 'installed.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.files[rel] = value;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

// A project that had its own instructions before briefboard ever ran here.
const MY_CLAUDE = '# My project\n\nMy own rules, which nobody may touch.\n';
const MY_AGENTS = '# My agents\n\nMy own agent rules.\n';

function ownDocs(dir) {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), MY_CLAUDE);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), MY_AGENTS);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/** Splits a document at the markers, so the two sides can be compared as bytes. */
function around(text) {
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END);
  assert.notStrictEqual(start, -1, `no start marker in:\n${text}`);
  assert.notStrictEqual(end, -1, `no end marker in:\n${text}`);
  return {
    before: text.slice(0, start),
    inner: text.slice(start + MARKER_START.length, end),
    after: text.slice(end + MARKER_END.length),
  };
}

/** A project with its own docs, plus a newer package that changes the block text. */
function mergedFixture(mutateNew) {
  const oldPkg = makePackage('0.0.1-test');
  const project = install(oldPkg, ownDocs);
  const newPkg = makePackage('0.0.2-test', mutateNew);
  return { oldPkg, newPkg, project };
}

function changeBlockText(dir) {
  appendTo(path.join(dir, 'CLAUDE.md'), 'A rule that arrived in 0.0.2-test.');
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

// T-0294. A project that already has a CLAUDE.md has one because somebody wrote
// it, and both whole-file answers are wrong: skipping leaves the agent reading
// instructions that never mention the board, replacing destroys the reason the
// file existed. briefboard appends a block it alone owns, and writes nothing
// outside it - ever, under any flag. That is the invariant of this whole suite.
describe('the briefboard block in CLAUDE.md / AGENTS.md', () => {
  it('the markers the tests use are the ones the code writes', () => {
    const bin = read(path.join(REPO_ROOT, 'bin', 'briefboard-init.mjs'));
    assert.ok(bin.includes(`const MARKER_START = '${MARKER_START}';`), 'MARKER_START');
    assert.ok(bin.includes(`const MARKER_END = '${MARKER_END}';`), 'MARKER_END');
    // blockValue() below rebuilds a manifest value by hand, so the prefix it uses
    // has to be the code's own or the fixtures would vouch for nothing.
    assert.ok(bin.includes(`const BLOCK_PREFIX = '${BLOCK_PREFIX}';`), 'BLOCK_PREFIX');
  });

  it('init appends the block and keeps every original line byte-identical', () => {
    const pkg = makePackage('0.0.1-test');
    const project = install(pkg, ownDocs);

    const text = read(path.join(project, 'CLAUDE.md'));
    const parts = around(text);
    assert.strictEqual(parts.before, `${MY_CLAUDE}\n`, 'the user\'s text, plus the blank separator line');
    assert.strictEqual(parts.after, '\n');
    // The package's protocol text arrived...
    assert.match(parts.inner, /## briefboard task protocol/);
    assert.match(parts.inner, /agents\/WORKER\.md/);
    // ...without its leading H1, which would be an `# CLAUDE.md` inside a document.
    assert.doesNotMatch(parts.inner, /^# CLAUDE\.md$/m);
    assert.doesNotMatch(parts.inner, /^# /m);
  });

  it('writes both documents whole into an empty directory, with no markers at all', () => {
    const pkg = makePackage('0.0.1-test');
    const project = install(pkg);

    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const text = read(path.join(project, name));
      assert.strictEqual(text, read(path.join(pkg, name)), `${name} is the package file, whole`);
      assert.ok(!text.includes(MARKER_START), `no markers in a ${name} briefboard wrote itself`);
    }
  });

  it('a second init changes neither document and appends no second block', () => {
    const pkg = makePackage('0.0.1-test');
    const project = install(pkg, ownDocs);
    const before = snapshot(project);

    const res = run(pkg, project, ['init']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(snapshot(project), before, 'a rerun writes nothing at all');
    const text = read(path.join(project, 'CLAUDE.md'));
    assert.strictEqual(text.split(MARKER_START).length - 1, 1, 'exactly one block');
  });

  // The card's original reproduction: `update --apply` replaced a CLAUDE.md
  // briefboard never installed, because the manifest did not list it.
  it('update --apply replaces neither document when briefboard never installed them', () => {
    const oldPkg = makePackage('0.0.1-test');
    const project = makeTmpDir('briefboard-proj-');
    ownDocs(project);
    // Everything else installed, but the two documents untouched and unlisted -
    // exactly what a 0.3.0 install into an existing project left behind.
    assert.strictEqual(run(oldPkg, project, ['init']).status, 0);
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), MY_CLAUDE);
    fs.writeFileSync(path.join(project, 'AGENTS.md'), MY_AGENTS);
    dropFromManifest(project, 'CLAUDE.md');
    dropFromManifest(project, 'AGENTS.md');
    const newPkg = makePackage('0.0.2-test', changeBlockText);

    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(read(path.join(project, 'CLAUDE.md')), MY_CLAUDE, 'every byte kept');
    assert.strictEqual(read(path.join(project, 'AGENTS.md')), MY_AGENTS, 'every byte kept');
    assert.match(res.stdout, /unknown provenance {2,}CLAUDE\.md/);
    assert.match(res.stdout, /Not installed by briefboard[\s\S]*CLAUDE\.md/);
  });
});

describe('briefboard update on a merged document', () => {
  it('calls it outdated and rewrites only the text between the markers', () => {
    const { newPkg, project } = mergedFixture(changeBlockText);
    const file = path.join(project, 'CLAUDE.md');
    const before = around(read(file));

    const plan = run(newPkg, project, ['update']);
    assert.match(plan.stdout, /outdated {2,}CLAUDE\.md/);

    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(res.status, 0, res.stderr);
    const after = around(read(file));
    // The invariant: every byte on either side of the block is the byte that was there.
    assert.strictEqual(after.before, before.before, 'nothing written before the block');
    assert.strictEqual(after.after, before.after, 'nothing written after the block');
    assert.notStrictEqual(after.inner, before.inner, 'the block itself was refreshed');
    assert.match(after.inner, /A rule that arrived in 0\.0\.2-test\./);
    assert.match(res.stdout, /updated: CLAUDE\.md \(briefboard block only\)/);
  });

  it('an edit INSIDE the block is MODIFIED LOCALLY and --apply leaves it alone', () => {
    const { newPkg, project } = mergedFixture(changeBlockText);
    const file = path.join(project, 'CLAUDE.md');
    // Edit within the markers, where briefboard's own text lives.
    const edited = read(file).replace(MARKER_END, 'And a house rule of my own.\n' + MARKER_END);
    fs.writeFileSync(file, edited);

    const plan = run(newPkg, project, ['update']);
    assert.match(plan.stdout, /MODIFIED LOCALLY {2,}CLAUDE\.md/);

    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(read(file), edited, 'not one byte written without --force');
    assert.match(res.stdout, /Locally modified, NOT replaced[\s\S]*CLAUDE\.md/);
  });

  it('does not reinstate a block the user deleted, and says why; --force re-adds it', () => {
    const { newPkg, project } = mergedFixture(changeBlockText);
    const file = path.join(project, 'CLAUDE.md');
    fs.writeFileSync(file, MY_CLAUDE);

    const kept = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(read(file), MY_CLAUDE, 'the block stays gone');
    assert.match(kept.stdout, /block removed {2,}CLAUDE\.md/);
    assert.match(kept.stdout, /block was removed[\s\S]*CLAUDE\.md/);

    const forced = run(newPkg, project, ['update', '--apply', '--force']);

    assert.strictEqual(forced.status, 0, forced.stderr);
    const parts = around(read(file));
    assert.strictEqual(parts.before, `${MY_CLAUDE}\n`, 'the user\'s text is still every byte of it');
    assert.match(parts.inner, /## briefboard task protocol/);
  });

  for (const [what, damage] of [
    ['a start marker with no end', (text) => text.replace(MARKER_END, '')],
    ['two start markers', (text) => text.replace(MARKER_START, `${MARKER_START}\nstray\n${MARKER_START}`)],
  ]) {
    it(`refuses to touch ${what}, with --force too`, () => {
      const { newPkg, project } = mergedFixture(changeBlockText);
      const file = path.join(project, 'CLAUDE.md');
      const broken = damage(read(file));
      fs.writeFileSync(file, broken);

      const plan = run(newPkg, project, ['update']);
      assert.match(plan.stdout, /markers malformed {2,}CLAUDE\.md/);
      assert.match(plan.stdout, /Broken briefboard markers[\s\S]*CLAUDE\.md/);

      assert.strictEqual(run(newPkg, project, ['update', '--apply']).status, 0);
      assert.strictEqual(read(file), broken, '--apply wrote nothing');
      assert.strictEqual(run(newPkg, project, ['update', '--apply', '--force']).status, 0);
      assert.strictEqual(read(file), broken, '--force wrote nothing either');
    });
  }

  it('the plan\'s count is what --apply actually replaces', () => {
    const { newPkg, project } = mergedFixture((dir) => {
      changeBlockText(dir);
      appendTo(path.join(dir, 'ui', 'index.html'), '<!-- shipped in 0.0.2-test -->');
    });
    // One held back for each reason, so the count has something to get wrong.
    appendTo(path.join(project, 'agents', 'WORKER.md'), 'My own house rule.');
    dropFromManifest(project, 'server/server.js');

    const planned = Number(run(newPkg, project, ['update']).stdout.match(/(\d+) file\(s\) would be replaced/)[1]);
    const out = run(newPkg, project, ['update', '--apply']).stdout;
    const applied = Number(out.match(/(\d+) file\(s\) updated/)[1]);

    assert.strictEqual(applied, planned, out);
    assert.strictEqual(out.split(/^updated: /m).length - 1, planned, `one "updated:" line each:\n${out}`);
  });

  // The compatibility property the block hash is designed for: an older briefboard
  // compares a manifest value against the WHOLE file, so a value that is not a bare
  // sha256 can never match, and it lands in MODIFIED LOCALLY - which it does not
  // replace without --force.
  it('records the block hash in a shape no whole-file comparison can match', () => {
    const pkg = makePackage('0.0.1-test');
    const project = install(pkg, ownDocs);

    const files = manifestOf(project).files;
    assert.match(files['CLAUDE.md'], /^block:[0-9a-f]{64}$/);
    assert.notStrictEqual(files['CLAUDE.md'], hash(path.join(project, 'CLAUDE.md')));
    // A file briefboard wrote whole keeps a bare hash, exactly as before.
    assert.match(files['server/server.js'], /^[0-9a-f]{64}$/);
  });
});

// T-0298 brief 01. `findBlock` matched any trimmed line equal to a marker anywhere
// in the file, fences included - so a CLAUDE.md whose only mention of briefboard was
// a fenced EXAMPLE of the block was read as a file that already had one. Six of our
// own documents print exactly that snippet, so producing the fixture meant copying
// our example into your own notes.
describe('a marker inside a code fence is not a marker', () => {
  const HEAD = '# My project\n\nbriefboard appends a block that looks like this:\n\n';
  const TAIL = '\nAnd that is all I have to say about it.\n';

  /** A document whose ONLY markers are inside a fence: a picture of a block. */
  function quoting(open, close) {
    return `${HEAD}${open}\n${MARKER_START}\n## briefboard task protocol\n...the protocol text...\n${MARKER_END}\n${close}\n${TAIL}`;
  }

  const FENCES = [
    ['a ``` fence', quoting('```markdown', '```')],
    ['a ~~~ fence', quoting('~~~markdown', '~~~')],
    ['a fence indented by three spaces', quoting('   ```markdown', '   ```')],
    ['a fence closed by a longer run', quoting('````markdown', '`````')],
  ];

  for (const [what, document] of FENCES) {
    it(`appends a real block to a CLAUDE.md that only quotes the markers in ${what}`, () => {
      const pkg = makePackage('0.0.1-test');
      const project = install(pkg, (dir) => fs.writeFileSync(path.join(dir, 'CLAUDE.md'), document));
      const text = read(path.join(project, 'CLAUDE.md'));

      // The user's document is a byte-identical PREFIX, so everything after it is
      // what briefboard appended - no parsing needed to say which part is whose.
      assert.strictEqual(text.slice(0, document.length), document, 'the example is untouched');
      const appended = text.slice(document.length);
      assert.strictEqual(appended.slice(0, 1 + MARKER_START.length + 1), `\n${MARKER_START}\n`);
      assert.ok(appended.endsWith(`${MARKER_END}\n`));
      // ...and the protocol text really arrived, which was the whole failure.
      assert.match(appended, /## briefboard task protocol/);
      assert.match(appended, /agents\/WORKER\.md/);
    });
  }

  it('does not call a quoted example "the briefboard block is already there"', () => {
    const pkg = makePackage('0.0.1-test');
    const project = makeTmpDir('briefboard-proj-');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), quoting('```markdown', '```'));

    const res = run(pkg, project, ['init']);

    assert.doesNotMatch(res.stderr, /the briefboard block is already there/);
    assert.match(res.stdout, /merged: CLAUDE\.md \(briefboard block added/);
  });

  it('a real block plus a fenced example is up to date, not markers malformed', () => {
    const pkg = makePackage('0.0.1-test');
    const project = install(pkg, (dir) =>
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), quoting('```markdown', '```')));

    const plan = run(pkg, project, ['update']);

    assert.doesNotMatch(plan.stdout, /markers malformed {2,}CLAUDE\.md/);
    assert.match(plan.stdout, /up to date {2,}CLAUDE\.md/);
  });

  it('refreshes the real block and leaves the fenced example byte-identical', () => {
    const oldPkg = makePackage('0.0.1-test');
    const document = quoting('```markdown', '```');
    const project = install(oldPkg, (dir) => fs.writeFileSync(path.join(dir, 'CLAUDE.md'), document));
    const newPkg = makePackage('0.0.2-test', changeBlockText);
    const file = path.join(project, 'CLAUDE.md');

    assert.match(run(newPkg, project, ['update']).stdout, /outdated {2,}CLAUDE\.md/);
    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(res.status, 0, res.stderr);
    const text = read(file);
    assert.strictEqual(text.slice(0, document.length), document, 'the example is still every byte of it');
    assert.match(text.slice(document.length), /A rule that arrived in 0\.0\.2-test\./);
  });

  // The migration the refinement asked to be asserted rather than assumed: a file
  // that classified as `present` because of a quoted marker becomes `absent`.
  it('migrates a project the old code skipped: held back by update, then filled by init', () => {
    const oldPkg = makePackage('0.0.1-test');
    const project = install(oldPkg, ownDocs);
    // The state the old code left: the example alone in the file, and - because
    // `init` skipped it - no manifest entry for it.
    const document = quoting('```markdown', '```');
    const file = path.join(project, 'CLAUDE.md');
    fs.writeFileSync(file, document);
    dropFromManifest(project, 'CLAUDE.md');
    const newPkg = makePackage('0.0.2-test', changeBlockText);

    // 1. update holds it back and writes nothing.
    const held = run(newPkg, project, ['update', '--apply']);
    assert.strictEqual(held.status, 0, held.stderr);
    assert.match(held.stdout, /unknown provenance {2,}CLAUDE\.md/);
    assert.strictEqual(read(file), document, 'update wrote nothing at all');

    // 2. init then appends the real block, and the example survives.
    assert.strictEqual(run(newPkg, project, ['init']).status, 0);
    const text = read(file);
    assert.strictEqual(text.slice(0, document.length), document);
    assert.match(text.slice(document.length), /## briefboard task protocol/);

    // 3. and the file is ordinary again from here on.
    assert.match(run(newPkg, project, ['update']).stdout, /up to date {2,}CLAUDE\.md/);
  });
});

// T-0298 brief 02. Fence state decides only whether a line is a CANDIDATE marker.
// Carrying the tracker into the block would let one unclosed fence in the package's
// AGENTS.md hide briefboard's own end marker - `a start marker with no end`, which
// --force will not touch either, in every project that installed that version.
describe('the fence tracker stops at the start marker', () => {
  const USER = '# My project\n\nMy own rules.\n\n';
  const FENCE = '```text\n';
  const BODY = '## briefboard task protocol\n\nsomething briefboard wrote.\n';

  // The same three pieces, and the ONLY difference is which side of the start
  // marker the fence line falls on. Remove the reset and the second case becomes
  // the first: the end marker is read as fenced, and the file is malformed forever.
  const FENCE_OUTSIDE = `${USER}${FENCE}${MARKER_START}\n${BODY}${MARKER_END}\n`;
  const FENCE_INSIDE = `${USER}${MARKER_START}\n${FENCE}${BODY}${MARKER_END}\n`;

  it('a fence BEFORE the start marker hides it: there is no block', () => {
    const pkg = makePackage('0.0.1-test');
    const project = makeTmpDir('briefboard-proj-');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), FENCE_OUTSIDE);

    const res = run(pkg, project, ['init']);

    // No block was found, so one is appended.
    assert.match(res.stdout, /merged: CLAUDE\.md \(briefboard block added/);
    assert.doesNotMatch(res.stderr, /the briefboard block is already there/);
  });

  it('the same fence AFTER the start marker does not: the block is found', () => {
    const pkg = makePackage('0.0.1-test');
    const project = makeTmpDir('briefboard-proj-');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), FENCE_INSIDE);

    const res = run(pkg, project, ['init']);

    assert.match(res.stderr, /skip existing: CLAUDE\.md \(the briefboard block is already there\)/);
    assert.doesNotMatch(res.stdout, /briefboard block added/);
    assert.strictEqual(read(path.join(project, 'CLAUDE.md')), FENCE_INSIDE, 'and nothing was written');
  });

  // The failure the reset exists for, walked through `update` end to end. The
  // fixture is built by writing the block into the DESTINATION file: the package's
  // AGENTS.md and CLAUDE.md are never edited to produce it, because the point is
  // that the parser cannot be broken by their content, not that it is safe today.
  it('an unclosed fence in the block body leaves the entry outdated, never malformed', () => {
    const oldPkg = makePackage('0.0.1-test');
    const project = install(oldPkg, ownDocs);
    const file = path.join(project, 'CLAUDE.md');
    // A block whose body opens a fence and never closes it, preceded by a fenced
    // example, so both halves of the rule are exercised in one document.
    const outside = `${USER}\`\`\`markdown\n${MARKER_START}\n(a picture of a block)\n${MARKER_END}\n\`\`\`\n\n`;
    const inner = `## briefboard task protocol\n\n\`\`\`text\nan unclosed fence in briefboard's own body\n`;
    fs.writeFileSync(file, `${outside}${MARKER_START}\n${inner}${MARKER_END}\n`);
    // The manifest vouches for exactly that block, as an install of such a package
    // would have. Without this the entry would be MODIFIED LOCALLY for a different
    // reason and the test would prove nothing about the markers.
    setManifestValue(project, 'CLAUDE.md', blockValue(inner));
    const newPkg = makePackage('0.0.2-test', changeBlockText);

    const plan = run(newPkg, project, ['update']);

    assert.doesNotMatch(plan.stdout, /markers malformed {2,}CLAUDE\.md/, 'the end marker must not be read as fenced');
    assert.match(plan.stdout, /outdated {2,}CLAUDE\.md/);

    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(res.status, 0, res.stderr);
    const text = read(file);
    assert.strictEqual(text.slice(0, outside.length), outside, 'every byte outside the block, fences included');
    assert.ok(text.endsWith(`${MARKER_END}\n`));
    assert.match(text.slice(outside.length), /A rule that arrived in 0\.0\.2-test\./, 'the inner text was refreshed');
    assert.doesNotMatch(text.slice(outside.length), /an unclosed fence in briefboard's own body/);
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

  // T-0294 review. `--apply` recorded only what it replaced, so the manifest it
  // wrote listed a handful of files out of the whole runtime. Every unlisted file
  // is `up to date` today and becomes `unknown provenance` - held back, under a
  // heading saying briefboard did not install it - the moment a release changes it.
  // A manifest written from scratch is where the gap shows: with no previous record
  // to inherit, recording only `targets` listed the two or three files that run
  // happened to replace and nothing else. An install whose manifest already lists
  // everything hides this, which is why the fixture deletes it first.
  it('records the files it left as up to date, not only the ones it replaced', () => {
    const { newPkg, project } = fixture();
    fs.rmSync(path.join(project, '.briefboard'), { recursive: true, force: true });

    assert.strictEqual(run(newPkg, project, ['update', '--apply']).status, 0);

    const files = manifestOf(project).files;
    // server/parser.js matched the package all along: this run never touched it,
    // and there was no earlier entry for it to keep.
    assert.strictEqual(files['server/parser.js'], hash(path.join(project, 'server', 'parser.js')));
    assert.strictEqual(files['ui/index.html'], hash(path.join(project, 'ui', 'index.html')), 'replaced');
    // The whole runtime is vouched for, not a handful of it.
    assert.ok(Object.keys(files).length > 10, `expected the runtime, got ${Object.keys(files).length}`);
  });

  it('so a file this update did not touch is outdated in the next release, not unknown', () => {
    const { newPkg, project } = fixture();
    fs.rmSync(path.join(project, '.briefboard'), { recursive: true, force: true });
    assert.strictEqual(run(newPkg, project, ['update', '--apply']).status, 0);

    // A third release changes a file that was up to date during the second one.
    const thirdPkg = makePackage('0.0.3-test', (dir) => {
      appendTo(path.join(dir, 'ui', 'index.html'), '<!-- shipped in 0.0.2-test -->');
      fs.writeFileSync(path.join(dir, 'server', 'newthing.js'), '// added in 0.0.2-test\n');
      appendTo(path.join(dir, 'server', 'parser.js'), '// shipped in 0.0.3-test');
    });

    const { stdout } = run(thirdPkg, project, ['update']);

    assert.match(stdout, /outdated {2,}server\/parser\.js/);
    assert.doesNotMatch(stdout, /unknown provenance {2,}server\/parser\.js/);
    assert.doesNotMatch(stdout, /Not installed by briefboard/);
  });

  // The other half of the same loop: a file that is held back must NOT be vouched
  // for, or the next run reads a user-edited file as untouched since install.
  it('still does not record a file it held back', () => {
    const { newPkg, project } = fixture();
    const worker = path.join(project, 'agents', 'WORKER.md');

    assert.strictEqual(run(newPkg, project, ['update', '--apply']).status, 0);

    assert.notStrictEqual(manifestOf(project).files['agents/WORKER.md'], hash(worker));
    assert.match(run(newPkg, project, ['update']).stdout, /MODIFIED LOCALLY {2,}agents\/WORKER\.md/);
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

  // T-0294 changed what an unreadable manifest costs. It used to be the case that
  // `--apply` reinstalled everything and wrote a fresh record; now nothing can be
  // vouched for, so every existing file is `unknown provenance` and held back.
  // The texts that name a way out have to name one that works.
  it('--apply replaces nothing while the manifest cannot be read', () => {
    // A release that changes a file and adds none: then nothing at all is
    // replaceable, which is the case the decision was measured on.
    const oldPkg = makePackage('0.0.1-test');
    const project = install(oldPkg);
    const newPkg = makePackage('0.0.2-test', (dir) => {
      appendTo(path.join(dir, 'ui', 'index.html'), '<!-- shipped in 0.0.2-test -->');
    });
    const DAMAGED = '{"version": "0.0.1-test", "files": {';
    damage(project, DAMAGED);
    const before = snapshot(project);

    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /unknown provenance {2,}ui\/index\.html/);
    assert.match(res.stdout, /Nothing to update apart from the files held back above/);
    // Not one byte anywhere, the damaged record included: it is the user's data
    // and repairing it is what they were told to do (T-0188).
    assert.deepStrictEqual(snapshot(project), before);
    assert.strictEqual(read(path.join(project, '.briefboard', 'installed.json')), DAMAGED);
  });

  // T-0297. The case above measured a package that adds NO new file, so nothing was
  // replaceable, `writeManifest` was never reached and the damaged record survived
  // by luck rather than by rule. One `new in package` file makes `targets` non-empty
  // and the record the user was just told to repair was overwritten on the way past.
  describe('and a package that adds a new file', () => {
    const DAMAGED = '{"version": "0.0.1-test", "files": {';

    it('installs the new file and still leaves the record byte-identical', () => {
      const { newPkg, project } = fixture();
      damage(project, DAMAGED);
      const record = path.join(project, '.briefboard', 'installed.json');

      const res = run(newPkg, project, ['update', '--apply']);

      assert.strictEqual(res.status, 0, res.stderr);
      // The file work still happens - that is what makes the manifest write
      // reachable, and skipping it is not allowed to cost the install.
      assert.match(res.stdout, /updated: server\/newthing\.js/);
      assert.strictEqual(read(path.join(project, 'server', 'newthing.js')), '// added in 0.0.2-test\n');
      // Bytes, not the parse: a record rewritten from scratch is still valid JSON.
      assert.strictEqual(read(record), DAMAGED, 'the user\'s data is untouched');
    });

    it('says the record was left as it was, and names the two ways out', () => {
      const { newPkg, project } = fixture();
      damage(project, DAMAGED);

      const { stderr } = run(newPkg, project, ['update', '--apply']);

      assert.match(stderr, /was left exactly as it was/);
      assert.match(stderr, /NOT recorded in/);
      assert.match(stderr, /unknown provenance/, 'and what that costs on the next run');
      // The same two ways out, in the words reportManifestProblem() already uses.
      assert.match(stderr, /repair the JSON to get/, 'the first way out');
      assert.match(stderr, /delete it and run "briefboard update --apply"/, 'the second');
    });

    it('--force replaces runtime files and still does not touch the record', () => {
      const { newPkg, project } = fixture();
      damage(project, DAMAGED);
      const ui = path.join(project, 'ui', 'index.html');

      const res = run(newPkg, project, ['update', '--apply', '--force']);

      assert.strictEqual(res.status, 0, res.stderr);
      // --force did what --force is for...
      assert.strictEqual(read(ui), read(path.join(newPkg, 'ui', 'index.html')), 'held-back file replaced');
      // ...and the escape hatch is about runtime files, never about the record.
      assert.strictEqual(read(path.join(project, '.briefboard', 'installed.json')), DAMAGED);
    });

    // The other side of the same conditional, on the same fixture: the ONLY
    // difference is whether the manifest could be read.
    it('writes the manifest as it always did when the manifest is readable', () => {
      const { newPkg, project } = fixture();
      const record = path.join(project, '.briefboard', 'installed.json');
      const before = read(record);

      const res = run(newPkg, project, ['update', '--apply']);

      assert.strictEqual(res.status, 0, res.stderr);
      assert.notStrictEqual(read(record), before, 'the record moves forward');
      const files = manifestOf(project).files;
      assert.strictEqual(manifestOf(project).version, '0.0.2-test');
      assert.ok(files['server/newthing.js'], 'what this run replaced');
      assert.ok(files['tools/task.mjs'], 'and what it left as up to date');
      assert.doesNotMatch(res.stderr, /was left exactly as it was/);
    });
  });

  it('the way out is to delete the manifest and apply: that does reinstall and rewrite it', () => {
    const { newPkg, project } = fixture();
    damage(project, '{"version": "0.0.1-test", "files": {');
    const ui = path.join(project, 'ui', 'index.html');

    // Exactly what the warning and the guide now tell the user to do.
    fs.rmSync(path.join(project, '.briefboard', 'installed.json'));
    const res = run(newPkg, project, ['update', '--apply']);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /no manifest {2,}ui\/index\.html/);
    assert.strictEqual(read(ui), read(path.join(newPkg, 'ui', 'index.html')), 'reinstalled');
    assert.strictEqual(manifestOf(project).version, '0.0.2-test', 'and the record reads again');
    assert.match(res.stdout, /backup of the replaced files: /);
  });

  it('every text that names a recovery names one that works', () => {
    const { newPkg, project } = fixture();
    damage(project, '{"version": "0.0.1-test", "files": {');

    const stderr = run(newPkg, project, ['update']).stderr;

    // The old wording promised that `--apply` alone reinstalls and rewrites the
    // record. It does not any more, and the test above is what says so.
    assert.doesNotMatch(stderr, /let "briefboard update --apply" reinstall/);
    assert.match(stderr, /repair the JSON/, 'the first way out');
    assert.match(stderr, /delete it and run "briefboard update --apply"/, 'the second');
    assert.match(stderr, /replaces none of/, 'and it says what --apply does NOT do');
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
