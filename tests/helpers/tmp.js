'use strict';

// Every temporary directory the suite creates, removed when the file that made
// it is done (T-0261).
//
// Measured on this machine on 2026-08-17 (Windows 11, node v24.18.0) before the
// helper existed: 118766 `briefboard-*` directories in %TEMP%, 56 mkdtempSync
// call sites across 42 test files, and eight of those files removing nothing at
// all — between them 114k of the 118k. The suite already measures teardown and
// process-spawn latency in that same %TEMP% and moves its budgets on those
// numbers (T-0238, T-0258), so the debris was distorting the stand the next
// measurement is taken on.
//
// WHY THE REMOVAL IS A HOOK AND NOT THE LAST LINE OF A TEST. That is the T-0258
// lesson: a removal written at the end of a test body is skipped exactly when it
// is needed — the test failed, or was cut off at `--test-timeout`. A root
// `after()` runs in both cases, and tests/temp-dirs.test.js holds it to that by
// running fixture suites that fail and hang on purpose.
//
// WHY `after()` AND NOT `afterEach()`. The hook is registered when this module is
// required, which is above every hook the test file registers itself, and node
// runs hooks of the same kind in registration order. As an `afterEach` it would
// therefore remove the directory BEFORE the file's own `afterEach` had shut down
// the board running inside it. `after()` runs once everything nested has already
// finished, so it cannot get in front of anything.
//
// WHAT THE EXIT HANDLER ADDS, measured on node v24.18.0 over the ways a test file
// can end early — `after()` first, then `process.on('exit')`:
//   test fails / cut off at --test-timeout   after: yes   exit: yes
//   uncaught exception in a stray timer      after: yes   exit: yes
//   unhandled rejection                      after: yes   exit: yes
//   process.exit() from inside a test        after: NO    exit: yes
//   the file throws while it is LOADING      after: NO    exit: NO
// So it is worth its four lines for one case and cannot rescue the last one:
// once `it()` has registered a test, a throw during load takes the process out
// through node's internal fatal handler (exit code 7 in a plain run) and no
// listener of ours is called. Nothing in this suite can clean up after that.
// The handler is also sync, so it cannot wait out the Windows codes `removeTree`
// waits out. It is a last resort, not the cleanup.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');

const { removeTree } = require('./rm.js');

const created = new Set();

/**
 * `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`, with the directory written
 * down so that the end of this test file removes it. The path is handed back
 * exactly as mkdtemp made it — a caller that needs the resolved one wraps this
 * call in `fs.realpathSync`, and the directory is the same either way.
 */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.add(dir);
  return dir;
}

after(async () => {
  const held = [];
  for (const dir of [...created]) {
    created.delete(dir);
    // Collected rather than thrown on the spot: one directory something still
    // holds must not leave the rest of them behind, which is how
    // tests/leftovers.test.js used to lose the tail of its own list.
    try {
      await removeTree(dir);
    } catch (e) {
      held.push(`  ${dir}: ${e.message}`);
    }
  }
  if (held.length) {
    throw new Error(`temporary directories this file could not remove:\n${held.join('\n')}`);
  }
});

process.on('exit', () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the process is on its way out; there is nobody left to tell */
    }
  }
});

module.exports = { tempDir };
