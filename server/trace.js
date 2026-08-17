'use strict';

/**
 * The mark a running board leaves for other processes (T-0186).
 *
 * Nothing outside the board could see one before this: the port is not
 * guessable (a scan of 4571-4590, an arbitrary PORT, or a kernel-given number
 * with PORT=auto), and the only witness there was — a session record that
 * survives reconciliation as `running` — proves a board only while one of its
 * sessions is running, and says nothing at all otherwise.
 *
 * The trap this must not fall into: a board killed hard (SIGKILL, `taskkill /f`,
 * a reboot) never removes its file, so the file alone proves nothing. Every
 * reader checks the pid is alive — the same discipline reconcileSession()
 * applies to session records, and with the same limit: a pid the OS has since
 * handed to a stranger cannot be told apart from the original, because Node
 * cannot read another process's start time portably (T-0102).
 *
 * One file per pid rather than one per project: two boards may serve the same
 * project on different ports, and a single file would let the second to start
 * erase the first from the record and then delete the file for both. Per-pid
 * files also need no lock — each board writes only its own.
 */

const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./parser');
const { isProcessAlive } = require('./sessions');

// Next to the session logs and the worktrees: runtime state about this machine,
// not something to commit.
const TRACE_DIR_PARTS = ['.briefboard', 'boards'];
const TRACE_FILE_RE = /^(\d+)\.json$/;
const TRACE_VERSION = 1;
const MANIFEST_PARTS = ['.briefboard', 'installed.json'];
// The release that started writing a trace: a board from anything older leaves
// none, which is the one case a reader still cannot see (see tools/task.mjs).
const TRACE_SINCE = '0.2.0';

const traceDirFor = (project) => path.join(project, ...TRACE_DIR_PARTS);
const tracePathFor = (project, pid = process.pid) => path.join(traceDirFor(project), `${pid}.json`);

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Which briefboard is running — not whatever version the project's package.json
// carries. `init` copies server/ into a user's project and no package.json with
// it, so there the file next to the runtime is the USER's and its version would
// be a lie; the install manifest is the record of the copy that was installed.
function boardVersion(project, installRoot) {
  const pkg = readJsonFile(path.join(installRoot, 'package.json'));
  if (pkg && pkg.name === 'briefboard' && typeof pkg.version === 'string') return pkg.version;
  const manifest = readJsonFile(path.join(project, ...MANIFEST_PARTS));
  return manifest && typeof manifest.version === 'string' ? manifest.version : '';
}

function writeBoardTrace(project, { port, host, installRoot, pid = process.pid }) {
  const file = tracePathFor(project, pid);
  const trace = {
    trace: TRACE_VERSION,
    pid,
    port,
    host,
    project,
    version: boardVersion(project, installRoot),
    startedAt: new Date().toISOString(),
  };
  atomicWrite(file, `${JSON.stringify(trace, null, 2)}\n`);
  return { file, trace };
}

// Never throws: this runs on the way out, where an exception would replace the
// exit code the caller is leaving with.
function removeBoardTrace(project, pid = process.pid) {
  try {
    fs.rmSync(tracePathFor(project, pid), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every trace in the project, each already judged: `alive` is a liveness check
 * on the pid, never the presence of the file.
 *
 * `selfPid` is the caller's own pid — a trace claiming it was written by someone
 * who is not the caller, so the pid has been reused and the board it named is
 * gone (the same argument reconcileSession() makes about a session's board).
 */
function readBoardTraces(project, { selfPid = process.pid, isAlive = isProcessAlive } = {}) {
  const dir = traceDirFor(project);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { dir, boards: [] };
  }
  const boards = [];
  for (const name of names.sort()) {
    const match = TRACE_FILE_RE.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const data = readJsonFile(path.join(dir, name)) || {};
    boards.push({
      pid,
      file: path.join(dir, name),
      port: Number.isInteger(data.port) ? data.port : null,
      host: typeof data.host === 'string' ? data.host : '',
      version: typeof data.version === 'string' ? data.version : '',
      startedAt: typeof data.startedAt === 'string' ? data.startedAt : '',
      // A record that disagrees with the name it is filed under is not trusted
      // to name a process: the file name is what the reader checks liveness on.
      alive: data.pid === pid && pid !== selfPid && isAlive(pid),
    });
  }
  return { dir, boards };
}

// Called by a board as it starts — the one moment there is a writer here anyway.
// It clears out the boards that were killed before they could remove their own
// file, so a pid the OS later hands to a stranger has less chance of making a
// reader announce a board that is not there.
function sweepBoardTraces(project, options = {}) {
  const removed = [];
  for (const board of readBoardTraces(project, options).boards) {
    if (board.alive) continue;
    try {
      fs.rmSync(board.file, { force: true });
      removed.push(board.pid);
    } catch {
      /* a file we cannot remove is one the next reader still judges by its pid */
    }
  }
  return removed;
}

module.exports = {
  TRACE_SINCE,
  TRACE_VERSION,
  traceDirFor,
  tracePathFor,
  writeBoardTrace,
  removeBoardTrace,
  readBoardTraces,
  sweepBoardTraces,
};
