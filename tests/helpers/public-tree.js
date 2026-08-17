'use strict';

// Is this checkout the PUBLIC tree that tools/release-export.mjs assembles, or the
// maintainer's dev repository? (T-0252.)
//
// The export deliberately drops RELEASING.md and tools/release-export.mjs — they
// are this repository's release tooling and have no business on GitHub — but it
// carries the whole suite across, tests for those two files included. So the
// public CI could not pass by construction: v0.2.0 shipped with a red `tests`
// badge. The fix is to skip those checks THERE, with a reason the compact
// reporter prints (T-0244), rather than to drop the tests from the export: a
// public suite that quietly covers less is the same dead guard, only distributed.
//
// The marker below is deliberately a POSITIVE one — two things the public tree
// HAS — and never "the file we test is missing". Keyed on absence, the skip would
// fire in this repository the moment someone deleted RELEASING.md by accident:
// the test would fall silent exactly when it is needed, which is the failure this
// project has now found five times in three days. Keyed on presence, that same
// accident leaves both markers absent, so the test runs and fails loudly.
//
// The two markers are the two things release-export.mjs WRITES, in two separate
// steps of its own: the .gitkeep it stands up in the emptied brief directory, and
// the user-task rules it seeds into .gitignore. Both are required. Either alone
// is one plausible accident away from being true here — someone could add a
// .gitkeep to hold the directory in git, or paste the ignore rules in — while the
// two together are not something this repository drifts into. And requiring both
// errs the safe way: if the export ever stops writing one of them, the public tree
// stops being recognised, the skips stop firing, and the public run goes red
// again. That is a visible failure, not a silent hole.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Written by release-export.mjs step 3, verbatim.
const SEEDED_IGNORE_RULES = ['doc/backlog.md', 'doc/backlog-archive.md', 'doc/brief/*', '!doc/brief/.gitkeep'];

/** Does `root` look like a tree produced by tools/release-export.mjs? */
function isPublicTree(root = ROOT) {
  if (!fs.existsSync(path.join(root, 'doc', 'brief', '.gitkeep'))) return false;
  let gitignore;
  try {
    gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return false;
  }
  const lines = gitignore.split(/\r?\n/).map((line) => line.trim());
  return SEEDED_IGNORE_RULES.every((rule) => lines.includes(rule));
}

const PUBLIC_TREE = isPublicTree();

/**
 * A `skip` option for a test that reads a file the export drops: `false` here, so
 * the test runs, and a reason string in the public tree, so the reporter names it.
 * Shaped like the `{ skip: !WIN && '...' }` idiom already used in the suite.
 */
function skipOutsideExport(what) {
  return PUBLIC_TREE && `${what} is not in the public tree: the export drops it (T-0252)`;
}

module.exports = { PUBLIC_TREE, isPublicTree, skipOutsideExport, SEEDED_IGNORE_RULES };
