'use strict';

// T-0239: what npm publishes, asserted against a real build rather than against
// the `files` field. The two are not the same question — npm adds files of its
// own on top of the allowlist — and reading the field is how RELEASING.md came
// to promise a 16-file tarball while the build made 23.
//
// The stake is the same one T-0212 was filed on: this repository produces three
// different trees (the npm tarball, the public GitHub export, the tracked tree),
// and the maintainer's backlog had already reached one of them unnoticed.
// tests/release-export.test.js guards the export; this file guards the tarball.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Always in the tarball whatever `files` says, by npm's own rule. The READMEs are
// here on purpose: the translations ship because of this and not because the
// allowlist mentions them (T-0212). The `main` file is on the same list and is
// deliberately absent from this one — measured on npm 11: pointing `main` at
// tools/test-run.mjs packs it, allowlist or not, which is one real way a dev-only
// file can slip into a release and the first assertion below is what would say so.
const ALWAYS_PACKED = [/^package\.json$/, /^README/, /^LICEN[SC]E/];

let packed;

before(() => {
  // --dry-run writes no tarball: a test may not leave a file in the working copy
  // (CONTRIBUTING.md), and tools/test-run.mjs fails the run if one does.
  // One string and no argument array: npm is a shell script on every platform, so
  // it needs `shell: true`, and passing args alongside it warns (DEP0190). There
  // is nothing to escape here — the command is a constant.
  const res = spawnSync('npm pack --dry-run --json', {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    timeout: 120000,
  });
  assert.strictEqual(res.status, 0, `npm pack failed: ${res.stderr || res.error}`);
  const report = JSON.parse(res.stdout)[0];
  assert.ok(Array.isArray(report.files), 'npm pack --json must report the packed files');
  packed = report.files.map((f) => f.path);
});

/** Does an entry of the `files` allowlist cover this path? A bare name is a directory. */
function allowlisted(file) {
  return pkg.files.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

describe('the published tarball carries the allowlist and nothing else (T-0239)', () => {
  it('every packed file is allowlisted or one npm always adds', () => {
    const stray = packed.filter((f) => !allowlisted(f) && !ALWAYS_PACKED.some((re) => re.test(f)));
    assert.deepStrictEqual(stray, [], `these reached the tarball through neither rule: ${stray.join(', ')}`);
  });

  // Named one by one because this is the promise RELEASING.md makes to whoever
  // runs `npm pack --dry-run` before a publish, and because a leak here is a
  // release that cannot be taken back.
  it('the maintainer\'s data and this repository\'s own tooling stay out', () => {
    const forbidden = {
      'doc/': 'the backlog, its archive and the briefs',
      'tests/': 'the suite',
      '.claude/': 'the local agent configuration',
      '.github/': 'the CI workflows',
      'RELEASING.md': 'the release checklist for the private repo',
      'CONTRIBUTING.md': 'the instructions for working ON briefboard',
      'tools/release-export.mjs': 'the exporter for the public repo',
      'tools/test-run.mjs': 'the test runner',
      'tools/sync-worker-agent.mjs': 'a development tool',
    };
    for (const [prefix, what] of Object.entries(forbidden)) {
      const hits = packed.filter((f) => f === prefix || f.startsWith(prefix));
      assert.deepStrictEqual(hits, [], `${what} must not ship: ${hits.join(', ')}`);
    }
  });

  it('the translated READMEs ship although the allowlist omits them', () => {
    for (const readme of ['README.md', 'README.ru.md', 'README.ja.md']) {
      assert.ok(packed.includes(readme), `${readme} must be in the tarball`);
    }
    // If npm ever stops including README* the translations vanish silently, and
    // adding them to `files` would then be the fix — this is what would say so.
    assert.ok(!pkg.files.includes('README.ru.md'), 'they ship by npm\'s README rule, not by the allowlist');
  });

  it('everything `briefboard init` copies into a project is in there', () => {
    // bin/ too: without it the `briefboard` command the package declares is dead.
    for (const entry of ['server', 'tools', 'ui', 'agents', 'bin', 'AGENTS.md', 'CLAUDE.md']) {
      assert.ok(
        packed.some((f) => f === entry || f.startsWith(`${entry}/`)),
        `init copies ${entry}, so the package must contain it`
      );
    }
  });
});

// The published package.json carries this repo's dev scripts and cannot not carry
// them: measured on npm 11, `publishConfig` does not override `scripts`. They are
// inert — npm never runs a dependency's `test`, and a consumer's `npm test` reads
// their own package.json — and `npm test` inside an unpacked copy fails loudly on
// the missing tools/test-run.mjs, which is the honest outcome and why it is left
// alone (T-0239/T-0240). A LIFECYCLE script is the one kind npm would run by
// itself, inside a consumer's install, where none of these files exist.
describe('no script in the published package.json runs on a consumer\'s machine (T-0240)', () => {
  it('the package defines no install-time or prepare script', () => {
    const lifecycle = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'];
    const defined = lifecycle.filter((name) => pkg.scripts && pkg.scripts[name] !== undefined);
    assert.deepStrictEqual(
      defined,
      [],
      `npm runs these when someone installs briefboard, so they must not reference anything the ` +
        `allowlist leaves out — and briefboard needs no install step at all: ${defined.join(', ')}`
    );
  });
});
