'use strict';

// T-0241: this repository's .gitignore, asserted by asking git rather than by
// reading the file. `.claude/` is a directory git already looks at — the worker
// subagent definition lives there and is tracked — so everything else Claude Code
// writes into it is one `git add -A` away from a commit, and from there
// tools/release-export.mjs carries the whole tracked tree to the public repo.
// `.claude/settings.local.json` is where its personal permission rules live, with
// absolute paths carrying the user's name: exactly what T-0212 was told to keep
// out of anything public.
//
// The fixture copies the real .gitignore into a throwaway repo and re-runs the
// same case under the rule this replaced, which named `.claude/worktrees/` alone.
// Without that second case the assertions would pass on a fixture that never had
// the problem.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { removeTree } = require('./helpers/rm.js');

const REAL_GITIGNORE = path.join(__dirname, '..', '.gitignore');
const PREVIOUS_RULE = '# Agent worktrees (isolated task branches created by tooling)\n.claude/worktrees/\n';

// What Claude Code leaves in .claude/ on a developer's machine. The last two are
// invented: a rule that only covers the files that exist today stops covering the
// directory the moment the tool adds one, which is how settings.json came to sit
// untracked here for days.
const LOCAL_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/worktrees/task-T-0001/README.md',
  '.claude/shell-snapshots/snapshot.sh',
  '.claude/whatever-comes-next.json',
];
const OURS = '.claude/agents/worker.md';

const dirs = [];

after(async () => {
  for (const dir of dirs) await removeTree(dir);
});

// Two fixtures answer three questions, and building one costs a `git init`.
const asked = new Map();

/** The paths `git add -A` would pick up, as git itself reports them. */
function untracked(gitignore) {
  if (!asked.has(gitignore)) asked.set(gitignore, build(gitignore));
  return asked.get(gitignore);
}

function build(gitignore) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-gitignore-')));
  dirs.push(root);

  fs.writeFileSync(path.join(root, '.gitignore'), gitignore);
  for (const rel of [...LOCAL_FILES, OURS]) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }

  // The fixture answers for this repository's .gitignore and nothing else, so the
  // developer's own git has to be kept out of it. Measured while writing this:
  // Claude Code had put `**/.claude/settings.local.json` into
  // ~/.config/git/ignore on this machine, which git reads by default with no
  // config entry to reveal it — so one of these files was already covered here
  // and would not be on anyone else's machine. That is the whole argument for
  // carrying the rule in the repository, and it would have been invisible to a
  // test that inherited it.
  const noExcludes = path.join(root, 'no-such-excludes');
  const run = (args) => {
    const res = spawnSync('git', ['-c', `core.excludesFile=${noExcludes}`, ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_CONFIG_GLOBAL: noExcludes, GIT_CONFIG_SYSTEM: noExcludes },
    });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    return res.stdout;
  };
  run(['init']);
  return run(['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''));
}

describe('a local Claude Code file cannot be committed by accident (T-0241)', () => {
  const real = fs.readFileSync(REAL_GITIGNORE, 'utf8');

  it('nothing under .claude/ is offered to git except what is ours', () => {
    const visible = untracked(real);
    const leaked = visible.filter((f) => f.startsWith('.claude/') && f !== OURS);
    assert.deepStrictEqual(leaked, [], `a "git add -A" would take these into the tracked tree: ${leaked.join(', ')}`);
  });

  it('.claude/agents/ stays trackable, so a second agent can still be committed', () => {
    assert.ok(untracked(real).includes(OURS), '.claude/agents/ must not be ignored along with the rest');
  });

  it('the rule it replaced let every one of them through', () => {
    const visible = untracked(PREVIOUS_RULE);
    for (const rel of LOCAL_FILES) {
      if (rel.startsWith('.claude/worktrees/')) continue;
      assert.ok(visible.includes(rel), `${rel} has to be visible under the old rule, or this fixture proves nothing`);
    }
  });
});
