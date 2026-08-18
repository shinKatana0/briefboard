#!/usr/bin/env node
/**
 * task.mjs — CLI for agents. Guarantees PROTOCOL.md format and atomic writes.
 *
 * Every subcommand refuses what it has no place for — an extra positional
 * argument, an unknown flag, an unknown command — instead of ignoring it (see
 * SPECS below, T-0220). The shapes are declared there, not in the case blocks.
 *
 *   node tools/task.mjs add --type feature|bug|external --priority Blocker|Critical|Major|Medium|Minor --title "..." [--desc "..."] [--labels ui,docs]
 *       # `external` = something a third party owes us (access, keys, an answer);
 *       # other tasks wait on it through `depends` (see agents/PROTOCOL.md).
 *       # --desc - reads the description from stdin (as note --text - does), and
 *       # refuses an empty one rather than filing a task with a dash (T-0198).
 *       # --labels takes the same ONE comma-separated argument the `labels`
 *       # subcommand does, and follows the same rules: it is there so a project
 *       # whose every task must carry a label can file one in a single command
 *       # (T-0282), instead of a second call that gets dropped.
 *   node tools/task.mjs status T-0007 <backlog|open|ready|in_progress|review|done|cancelled> [--force]
 *       # transition must follow the lifecycle graph (server/parser.js TRANSITIONS);
 *       # ready -> in_progress additionally requires every task in `depends` to be
 *       # done/cancelled; --force allows any transition between valid statuses and
 *       # overrides that dependency gate (prints a WARNING for both), but never
 *       # bypasses the "ready requires a brief" invariant.
 *   node tools/task.mjs depends T-0007 T-0001,T-0002  # set the prerequisite list (replaces it)
 *   node tools/task.mjs depends T-0007 --clear        # drop the prerequisite list
 *   node tools/task.mjs labels T-0007 ui,docs         # set the whole label list (replaces it)
 *   node tools/task.mjs labels T-0007 --clear         # drop the labels
 *       # the set of labels is the user's and implicit: a label exists while
 *       # some task carries it, so there is nothing to declare and nothing to
 *       # register. Names are compared as written (`ui` and `UI` are two), and
 *       # the rules they follow are in agents/PROTOCOL.md.
 *   node tools/task.mjs profile T-0007 fast          # run profile for this task's sessions
 *   node tools/task.mjs profile T-0007 --clear       # back to the default profile
 *       # the legal values are declared by the user in BRIEFBOARD_PROFILES
 *       # (comma-separated, first one is the default); briefboard never
 *       # interprets them, it only checks membership and substitutes {profile}
 *       # into the session command template.
 *   node tools/task.mjs brief T-0007 <slug>          # creates doc/brief/T-0007-NN-slug.md and links it
 *       # NN is one past the highest the TASK already links, so a brief file the
 *       # task does not link is invisible to it. A file already holding the
 *       # computed brief id is never overwritten: the command refuses and writes
 *       # nothing at all (T-0264).
 *   node tools/task.mjs link T-0007-01               # links a brief file that already exists
 *       # the other half of the same accident: `brief` refuses to write over a
 *       # file written by hand, and this is how that file gets onto the task's
 *       # `briefs:` line without anyone editing doc/backlog.md (T-0267).
 *   node tools/task.mjs note T-0007 --section "Worker report" --text "..."
 *   node tools/task.mjs note T-0007 --section "Worker report" --text -   # text from stdin
 *       # appends to the task description under "### <section>"; never rewrites
 *       # what is already there. This is how a worker isolated in a worktree
 *       # writes its report into the SHARED backlog (AGENTBOARD_ROOT, T-0079).
 *   node tools/task.mjs show T-0007 [--full]
 *       # the task as JSON. Worker reports are left out by default (T-0161) and
 *       # the JSON says so in its `omitted` field; --full prints the description
 *       # exactly as it is stored.
 *   node tools/task.mjs list [--status ready] [--all]
 *       # the live backlog only; --all adds the archived (closed) tasks.
 *   node tools/task.mjs archive [--dry-run]
 *       # moves every done/cancelled task to doc/backlog-archive.md, same format.
 *       # The archive is read-only afterwards; the board keeps showing those
 *       # tasks, and `show` still finds them (T-0156). A board that was started
 *       # before the archive existed does not, so the command says so (T-0174).
 *   node tools/task.mjs board                        # is a board running for this project, and where
 *       # reads .briefboard/boards/<pid>.json of AGENTBOARD_ROOT the same way the
 *       # archive warning does: a trace counts only when its pid is alive. Prints
 *       # the pid, the bound address and port, the version and the start time.
 *   node tools/task.mjs sessions                     # agent sessions the board has running (or has run)
 *       # reads .briefboard/sessions/registry.json of AGENTBOARD_ROOT; needs no
 *       # board of its own. Check it before sending a worker at a task: two
 *       # agents on one task/T-NNNN branch is the accident it exists to stop.
 *   node tools/task.mjs validate                     # structural check of doc/backlog.md (see server/validate.js)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseBacklog,
  nowStamp,
  STATUSES,
  TRANSITIONS,
  TASK_ID_RE,
  BRIEF_ID_RE,
  blockingDependencies,
  checkLabels,
  dependencyCycles,
  appendDescriptionSection,
  stripWorkerReports,
  updateBacklog,
  addTask,
  localStamp,
  archiveClosedTasks,
  readArchivedTasks,
  archivePathFor,
  findBriefFile,
} = require('../server/parser.js');

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// AGENTBOARD_ROOT points to the project whose doc/ we edit (defaults to the installation itself)
const ROOT = process.env.AGENTBOARD_ROOT ? path.resolve(process.env.AGENTBOARD_ROOT) : TOOL_ROOT;
const BACKLOG = path.join(ROOT, 'doc', 'backlog.md');
const ARCHIVE = archivePathFor(BACKLOG);
const BRIEF_DIR = path.join(ROOT, 'doc', 'brief');
// Path as the reader would type it, for messages: the absolute one is noise in
// a line whose point is "there is a second file".
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// Local date+time stamp "YYYY-MM-DD HH:MM:SS" - shared implementation lives in
// server/parser.js (nowStamp), used identically by the CLI and by server.js.
const today = nowStamp;
const die = (msg) => { console.error('ERROR: ' + msg); process.exit(1); };

// Abort a locked mutation without writing. We must NOT call die()/process.exit()
// inside updateBacklog(): process.exit skips finally blocks, so the lock file
// would leak. Throw instead (finally runs on throw, releasing the lock), then
// convert to die() outside the lock. See doc/brief/T-0046-01-backlog-write-lock.md.
class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };

// Same abort, for a refusal about how the command was CALLED rather than about
// the state of the repository - it comes out of the lock as dieUsage() instead
// of die(), so it carries the subcommand's usage line like every other
// call-shaped refusal since T-0220 (T-0284).
class CliUsageError extends CliError {}
const failUsage = (msg) => { throw new CliUsageError(msg); };

// Read-only load (list/show); mutating commands read inside updateBacklog's lock.
function readTasks() {
  if (!fs.existsSync(BACKLOG)) return [];
  return parseBacklog(fs.readFileSync(BACKLOG, 'utf8'));
}

// Live tasks plus archived ones. A `depends` entry may point across that border
// - the prerequisite was done and then archived - and resolving it against the
// backlog alone would report it as "not found", i.e. as forever unsatisfied.
// Only the dependency rules need this; everything the CLI writes stays live.
function withArchived(tasks) {
  return tasks.concat(readArchivedTasks(BACKLOG));
}

// Abort a mutation aimed at a task that is not in the live backlog. An archived
// id gets its own message: `show` finds that task, so "not found" would be a
// lie, and the reader would go looking for a file the task is no longer in.
// Every writing command refuses an archived task, `note` included - the archive
// is read-only, and appending to a closed task there would mean writing a second
// file that nothing else ever writes (T-0156).
function failMissing(id) {
  const archived = readArchivedTasks(BACKLOG).some((t) => t.id === id);
  fail(
    archived
      ? `${id} is archived (${rel(ARCHIVE)}) and cannot be changed: done and cancelled are terminal. ` +
          `To read it: node tools/task.mjs show ${id}`
      : `task ${id} not found`
  );
}

// Abort `brief` rather than write the template over a file that already answers
// to this brief id. Two finished briefs were destroyed that way, and the call
// that did it printed the path exactly as a successful one does (T-0264).
function failBriefTaken(briefId, file) {
  const taskId = briefId.slice(0, briefId.lastIndexOf('-'));
  fail(
    `${briefId} already has a file: ${rel(file)}\n` +
      '  Nothing was written - the template would have replaced its content.\n' +
      "  NN is one past the highest the task already links, so a file it does not link is invisible to it.\n" +
      `  If that file is this brief, link it: node tools/task.mjs link ${briefId}\n` +
      `  (that is the whole fix - ${taskId} then knows the file, and the next brief gets the next number);\n` +
      '  if it is stale, move it aside and run the command again.'
  );
}

// The next free brief number for a task: one past the highest NN it already
// links, NOT briefs.length + 1. `link` (T-0267) can attach a file whose number
// is not the next one - T-0007-03 to a task linking nothing - and counting the
// list would then hand out 02, and on the call after that 03 again: a number the
// task already holds. That collision is refused by failBriefTaken() above, on a
// message telling the reader to link a file that is already linked, i.e. a dead
// end with no way out through the CLI (measured before this changed). A hole in
// the numbering is harmless - the order of `briefs:` means nothing and NN is a
// label, not an index - and repeating a number is not.
//
// Only this task's own ids count: `briefs:` is hand-editable and may carry an id
// belonging to another task.
function nextBriefNumber(task) {
  let highest = 0;
  for (const briefId of task.briefs) {
    if (!briefId.startsWith(task.id + '-')) continue;
    highest = Math.max(highest, Number(briefId.slice(task.id.length + 1)));
  }
  return highest + 1;
}

// What the CLI may honestly say about a board that is open while we archive.
// Since T-0186 a board writes .briefboard/boards/<pid>.json while it runs, so
// this is a direct answer where T-0174 could only infer one — and the file is
// never taken at face value: a board killed hard leaves it behind, so a trace
// counts only when its pid is alive (server/trace.js).
//
// The session registry stays as the second witness for the one board a trace
// cannot cover: one started by a briefboard older than TRACE_SINCE, which wrote
// none. A record that survives reconciliation as `running` proves the board
// process that started it is alive (server/sessions.js).
function openBoards() {
  const { readBoardTraces, TRACE_SINCE } = require('../server/trace.js');
  const { readSessionRegistry } = require('../server/sessions.js');
  const { dir, boards } = readBoardTraces(ROOT);
  const traced = boards.filter((b) => b.alive);
  const { sessions, file: registry, error: registryError } = readSessionRegistry(ROOT);
  const untraced = [];
  for (const s of sessions) {
    if (s.status !== 'running' || !Number.isInteger(s.board)) continue;
    if (traced.some((b) => b.pid === s.board) || untraced.includes(s.board)) continue;
    untraced.push(s.board);
  }
  return { traced, untraced, dir, registry, registryError, since: TRACE_SINCE };
}

// One sentence about a live board for both places that print one - the archive
// warning and the `board` command (T-0196). They differ in framing, not in what
// they know, and a second wording drifts from the first the way a second
// implementation does.
function describeBoard(board) {
  const where = board.port ? ` on ${board.host}:${board.port}` : ' at an address its trace does not record';
  const version = board.version ? `, briefboard ${board.version}` : '';
  const started = new Date(board.startedAt);
  const when = board.startedAt
    ? `, started ${Number.isNaN(started.getTime()) ? board.startedAt : localStamp(started)}`
    : '';
  return `a board is running for this project: pid ${board.pid}${where}${version}${when}`;
}

function warnOpenBoard() {
  const { traced, untraced, dir, registry, since } = openBoards();
  for (const board of traced) {
    console.error(`WARNING: ${describeBoard(board)}`);
    console.error(`  (${rel(board.file)}).`);
  }
  for (const pid of untraced) {
    console.error(`WARNING: a board is running for this project: pid ${pid}`);
    console.error(`  (${rel(registry)} has a session it started still running;`);
    console.error(`  it left no ${rel(dir)} entry, so it predates briefboard ${since}).`);
  }
  if (!traced.length && !untraced.length) {
    console.error(`NOTE: no board is running for this project: no live entry in ${rel(dir)}, and no`);
    console.error(`  session running either. Only a board older than briefboard ${since} could be open`);
    console.error('  unseen — those left no entry.');
  }
  console.error(`  An open board that predates ${rel(ARCHIVE)} reads ${rel(BACKLOG)} alone, and the closed`);
  console.error('  tasks are not in it any more: its Done and Cancelled columns look emptied until it is');
  console.error('  restarted. A board that knows the archive follows both files and needs nothing.');
}

// "-" as a flag's value means the value is on standard input - the form anything
// multi-line is passed in, because a shell argument is where such a text gets
// mangled. Empty input under an explicit "-" is a caller who piped nothing, and
// accepting it is silent data loss: T-0193 was filed exactly that way, with a
// dash where the finding it existed to carry should have been, and the finding
// had to be restored by hand from a worker's report (T-0198).
//
// `name` is the subcommand, and it is required rather than defaulted: this is
// shared by `add` and `note`, and a refusal here is about how the command was
// called, so it owes the caller that command's usage line (T-0284). An optional
// parameter is how the third call site would silently get the usage-less form
// back.
function readStdinValue(name, flag) {
  let text = '';
  try {
    text = fs.readFileSync(0, 'utf8');
  } catch {
    dieUsage(name, `${flag} - expects the text on standard input (pipe it in)`);
  }
  if (!text.trim())
    dieUsage(name, `${flag} - got nothing on standard input: pipe the text in, or pass it as ${flag} "..."`);
  return text;
}

// Every subcommand's shape, declared in one table (T-0220). Until this existed
// each case block destructured `rest` and took the first tokens it wanted, so
// anything past them fell on the floor without a word or a non-zero exit:
// `depends T-0218 T-0208 T-0214 T-0215 T-0216` recorded ONE prerequisite, and the
// board then showed a task as unblocked while three of them were still open. The
// same mistake was made twice in one hour by someone who already knew about the
// first one — a call that is wrong has to be unable to look like a call that is
// right, and only a declared shape can tell them apart.
//
//   args  - the positional arguments, named as they appear in the usage line.
//           Anything beyond them is a refusal.
//   flags - 'value' consumes the next token, 'bool' consumes nothing. An unknown
//           flag is a refusal as well: `archive --dryrun` is not a dry run, it is
//           an archive run, and nothing in the output used to say so. The sibling
//           CLI (bin/briefboard-init.mjs) has refused unknown options all along.
//   usage - printed under every refusal, so the message that stops a wrong call
//           also carries the right one.
//   hint  - an extra line for the specific wrong call the refusal exists for.
const SPECS = {
  add: {
    args: [],
    flags: { type: 'value', priority: 'value', title: 'value', desc: 'value', labels: 'value' },
    usage:
      'node tools/task.mjs add --type feature|bug|external --priority Blocker|Critical|Major|Medium|Minor --title "..." [--desc "..."] [--labels ui,docs]',
    hint: (positional) => `the title is a flag, not a position: --title ${quote(positional[0])}`,
  },
  status: {
    args: ['T-0007', `<${STATUSES.join('|')}>`],
    flags: { force: 'bool' },
    usage: `node tools/task.mjs status T-0007 <${STATUSES.join('|')}> [--force]`,
  },
  depends: {
    args: ['T-0007', 'T-0001,T-0002'],
    flags: { clear: 'bool' },
    usage: 'node tools/task.mjs depends T-0007 T-0001,T-0002 | --clear',
    // The exact call that produced this task, answered with the one that was
    // meant: separating ids by spaces is how a person types a list, and the tool
    // used to take the first and drop the rest.
    hint: (positional) =>
      positional.length > 1 && positional.slice(1).every((a) => TASK_ID_RE.test(a))
        ? 'the whole prerequisite list is ONE comma-separated argument:\n' +
          `  node tools/task.mjs depends ${positional[0]} ${positional.slice(1).join(',')}`
        : '',
  },
  labels: {
    args: ['T-0007', 'ui,docs'],
    flags: { clear: 'bool' },
    usage: 'node tools/task.mjs labels T-0007 ui,docs | --clear',
    // Same shape and same accident as `depends` above: a list typed the way a
    // person types one - separated by spaces - would record the first name and
    // drop the rest.
    hint: (positional) =>
      positional.length > 1
        ? 'the whole label list is ONE comma-separated argument:\n' +
          `  node tools/task.mjs labels ${positional[0]} ${positional.slice(1).join(',')}`
        : '',
  },
  profile: {
    args: ['T-0007', '<profile>'],
    flags: { clear: 'bool' },
    usage: 'node tools/task.mjs profile T-0007 <profile> | --clear',
  },
  brief: {
    args: ['T-0007', '<slug>'],
    flags: {},
    usage: 'node tools/task.mjs brief T-0007 <slug>',
    hint: (positional) =>
      `the slug is one argument: node tools/task.mjs brief ${positional[0]} ${positional
        .slice(1)
        .join('-')
        .toLowerCase()}`,
  },
  // A verb of its own rather than `brief --link` (T-0267). The two commands have
  // opposite preconditions - `brief` refuses when the file exists, `link`
  // requires it to - and a flag that inverts the precondition of the command it
  // is attached to reads as "create" while creating nothing. It also has to be
  // nameable in the refusal `brief` prints: pointing that reader back at `brief`
  // is what the message is trying to lead them out of. The cost is a thirteenth
  // subcommand in a set T-0220 keeps narrow, paid once.
  link: {
    args: ['T-0007-01'],
    flags: {},
    usage: 'node tools/task.mjs link T-0007-01',
    // `link T-0007 T-0007-01` is the call to expect: every other command that
    // touches a task takes the task id first, and here it is already inside the
    // brief id.
    hint: (positional) => {
      const briefId = positional.find((a) => BRIEF_ID_RE.test(a));
      return briefId
        ? `the brief id names its own task: node tools/task.mjs link ${briefId}`
        : '';
    },
  },
  note: {
    args: ['T-0007'],
    flags: { section: 'value', text: 'value' },
    usage:
      'node tools/task.mjs note T-0007 --section "Worker report" --text "..."   (--text - reads stdin)',
    hint: () =>
      'a multi-line report is not a positional argument: pass it as --text "..." , or pipe it in with --text -',
  },
  show: {
    args: ['T-0007'],
    flags: { full: 'bool' },
    usage: 'node tools/task.mjs show T-0007 [--full]',
    hint: () => 'one task per call: show prints the task whose id is given, and there is no second slot',
  },
  list: {
    args: [],
    flags: { status: 'value', all: 'bool' },
    usage: 'node tools/task.mjs list [--status ready] [--all]',
    hint: (positional) => `the status is a flag, not a position: --status ${positional[0]}`,
  },
  archive: { args: [], flags: { 'dry-run': 'bool' }, usage: 'node tools/task.mjs archive [--dry-run]' },
  board: { args: [], flags: {}, usage: 'node tools/task.mjs board' },
  sessions: { args: [], flags: {}, usage: 'node tools/task.mjs sessions' },
  validate: { args: [], flags: {}, usage: 'node tools/task.mjs validate' },
};

const quote = (s) => JSON.stringify(s);

function dieUsage(name, message, hint) {
  console.error('ERROR: ' + message);
  if (hint) console.error('  ' + hint);
  console.error('usage: ' + SPECS[name].usage);
  process.exit(1);
}

// Split a subcommand's argv into positionals and flags, refusing anything the
// command has no place for. Value-flags consume the next token ONLY if it exists
// and is not itself a flag, so `add --title --priority Major` still leaves
// --title empty for its own `if (!f.title)` check instead of taking "--priority"
// as the title (T-0054); a 'bool' flag never consumes anything, so `status
// --force T-0007 review` reads the same as `status T-0007 review --force`.
function parseArgs(name, argv) {
  const spec = SPECS[name];
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const flag = token.slice(2);
    // hasOwn, not `in`: `--constructor` and `--toString` are inherited from
    // Object.prototype and would otherwise pass for flags the command declares.
    if (!Object.hasOwn(spec.flags, flag)) {
      const known = Object.entries(spec.flags)
        .map(([f, kind]) => (kind === 'value' ? `--${f} <value>` : `--${f}`))
        .join(', ');
      dieUsage(
        name,
        `${name} has no flag ${token}`,
        known ? `flags of ${name}: ${known}` : `${name} takes no flags`
      );
    }
    const next = argv[i + 1];
    if (spec.flags[flag] === 'value' && next !== undefined && !next.startsWith('--')) {
      flags[flag] = next;
      i++;
    } else {
      flags[flag] = '';
    }
  }
  if (positional.length > spec.args.length) {
    const takes = spec.args.length
      ? `takes ${spec.args.length} argument${spec.args.length === 1 ? '' : 's'} (${spec.args.join(' ')})`
      : 'takes no positional arguments';
    const extra = positional.slice(spec.args.length).map(quote).join(' ');
    dieUsage(
      name,
      `${name} ${takes} and got ${positional.length}; nothing here reads ${extra}`,
      spec.hint ? spec.hint(positional) : ''
    );
  }
  return { flags, positional };
}

const [cmd, ...rest] = process.argv.slice(2);

// Mutating commands (add/status/brief) run their read-modify-write inside
// updateBacklog(), which holds a cross-process lock and reads the freshest
// snapshot before writing - so a concurrent server/CLI write is never lost
// (T-0046). Wrap the call so a CliError thrown to abort the mutation becomes a
// normal die() with exit code 1, after the lock has been released.
function withUpdate(mutate) {
  try {
    return updateBacklog(BACKLOG, mutate);
  } catch (e) {
    // The narrower class first: it is a CliError too, and the order is what
    // decides whether the usage line is printed.
    if (e instanceof CliUsageError) dieUsage(cmd, e.message);
    if (e instanceof CliError) die(e.message);
    throw e;
  }
}

switch (cmd) {
  case 'add': {
    const { flags: f } = parseArgs(cmd, rest);
    // Flag-level check first, so a missing --title names the flag the user
    // forgot. The shared helper re-checks the title itself (see addTask) and is
    // what catches a whitespace-only value.
    if (!f.title) dieUsage(cmd, '--title is required');
    const desc = f.desc === '-' ? readStdinValue(cmd, '--desc') : f.desc;
    // The same rules the `labels` subcommand applies, from the same helper in
    // server/parser.js - down to the empty-value refusal, so a name this file
    // cannot carry is refused BEFORE anything is written and `--labels` typed
    // with nothing after it is not silently an unlabelled task (T-0282).
    let labels = [];
    if ('labels' in f) {
      try {
        labels = checkLabels(f.labels);
      } catch (e) {
        // The message comes from the shared helper, which does not know which
        // subcommand asked - so the usage line is added here, where that is
        // known. A name this file cannot carry is a wrong call like any other
        // (T-0284).
        dieUsage(cmd, e.message);
      }
      if (labels.length === 0)
        dieUsage(cmd, '--labels needs a comma-separated list of labels (leave it out for none)');
    }
    // Id allocation, defaults and the write itself live in server/parser.js
    // (addTask), shared with the server's POST /api/task - the CLI must not keep
    // its own copy of that logic. addTask does its own locked read-modify-write,
    // so no withUpdate() wrapper here; a thrown error means nothing was written.
    let id;
    try {
      id = addTask(BACKLOG, {
        title: f.title,
        type: f.type,
        priority: f.priority,
        description: desc,
        labels,
      });
    } catch (e) {
      dieUsage(cmd, e.message);
    }
    console.log(id);
    break;
  }

  case 'status': {
    const { flags: f, positional } = parseArgs(cmd, rest);
    const [id, status] = positional;
    const force = 'force' in f;
    // The id is checked first and refused in its own words: without this a bare
    // `status` answers about the value of an argument the reader never reached,
    // so "no arguments at all" and "a task with no status" were one message, and
    // neither carried the usage line (T-0273).
    if (!id) dieUsage(cmd, 'status needs the task whose status is being set');
    if (!STATUSES.includes(status)) dieUsage(cmd, `status must be one of: ${STATUSES.join(', ')}`);
    withUpdate((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) failMissing(id);
      // Lifecycle guard: the transition t.status -> status must be allowed by the
      // state graph (server/parser.js TRANSITIONS). Same-status is an idempotent
      // no-op. --force bypasses the graph (for manual correction) but shouts about it.
      if (status !== t.status) {
        const allowed = TRANSITIONS[t.status] || [];
        if (force) {
          console.error(`WARNING: forced transition ${t.status} -> ${status} (bypasses lifecycle graph)`);
        } else if (!allowed.includes(status)) {
          fail(`invalid transition ${t.status} -> ${status} for ${id}; allowed from ${t.status}: ${allowed.length ? allowed.join(', ') : '(none — terminal status)'} (for manual correction: --force)`);
        }
      }
      // The "ready requires a brief" rule is a format invariant, not a transition,
      // so it holds even under --force.
      if (status === 'ready' && t.briefs.length === 0)
        fail(`cannot move ${id} to ready: it has no briefs (first run tools/task.mjs brief ${id} <slug>)`);
      // Dependency gate (T-0087). Exactly ready -> in_progress, i.e. starting the
      // implementation: refining and briefing a task whose prerequisite is still
      // open is normal and often how the dependency is discovered, and
      // review -> in_progress is rework of something already started. The rule
      // itself lives in server/parser.js so the server can apply the same one.
      if (status === 'in_progress' && t.status === 'ready') {
        const known = withArchived(tasks);
        const blocking = blockingDependencies(t, known);
        if (blocking.length) {
          const listed = blocking
            .map((depId) => {
              const dep = known.find((x) => x.id === depId);
              return `${depId} (${dep ? dep.status : 'not found'})`;
            })
            .join(', ');
          if (force) {
            console.error(`WARNING: forced start of ${id} with unfinished dependencies: ${listed}`);
          } else {
            fail(`cannot start ${id}: unfinished dependencies: ${listed} (for manual override: --force)`);
          }
        }
      }
      t.status = status;
      t.closed = status === 'done' || status === 'cancelled' ? today() : '';
    });
    console.log(`${id} -> ${status}`);
    break;
  }

  case 'depends': {
    const { flags: f, positional } = parseArgs(cmd, rest);
    const [id, listRaw] = positional;
    const clear = 'clear' in f;
    if (!id) dieUsage(cmd, 'depends needs the task whose prerequisites are being set');
    // The whole list is replaced, never appended to: a prerequisite list is
    // short, and "here is what it is now" is easier to predict than add/remove.
    // The word "set" in the docs states that, but only to someone reading them at
    // the moment they add a second prerequisite in a second call - so the command
    // says out loud what it dropped instead (see below).
    const wanted = clear || !listRaw ? [] : listRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!clear && wanted.length === 0)
      dieUsage(cmd, 'depends needs either a comma-separated list of task ids or --clear');
    const { before, deps } = withUpdate((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) failMissing(id);
      const known = withArchived(tasks);
      const unique = [];
      for (const depId of wanted) {
        // A token that is not a task id at all is a wrong call, not a state the
        // repository is in - exactly like `link`'s malformed brief id, which has
        // printed the usage line since T-0267 (T-0284). Its two neighbours below
        // stay state refusals: a well-formed id that names nothing, and a list
        // that would close a cycle, are both facts about the backlog.
        if (!TASK_ID_RE.test(depId)) failUsage(`"${depId}" is not a task id (expected T-NNNN)`);
        if (depId === id) fail(`${id} cannot depend on itself`);
        if (!known.some((x) => x.id === depId)) fail(`task ${depId} not found`);
        if (!unique.includes(depId)) unique.push(depId);
      }
      const previous = t.depends.slice();
      t.depends = unique;
      // Refuse here rather than let `validate` fail later on a file we wrote.
      // Only a cycle running through this task is ours to report; a pre-existing
      // one elsewhere is validate's business, not a reason to block this edit.
      const cycle = dependencyCycles(known).find((c) => c.includes(id));
      if (cycle) fail(`that would create a dependency cycle: ${cycle.join(' -> ')}`);
      return { before: previous, deps: unique };
    });
    console.log(`${id} depends: ${deps.length ? deps.join(', ') : '(none)'}`);
    // Naming what was thrown away is the only moment the replacement is visible:
    // someone adding a second prerequisite in a separate call gets exactly the
    // output of someone who set the list on purpose, and loses the first one
    // without a trace. Printed only when something was actually lost - a list
    // rewritten to itself, or set on a task that had none, replaced nothing.
    const lost = before.filter((d) => !deps.includes(d));
    if (lost.length && deps.length) {
      const union = before.concat(deps.filter((d) => !before.includes(d)));
      console.log(`  (dropped: ${lost.join(', ')} — depends SETS the whole list, it never adds to it)`);
      console.log(`  (to keep them, name them too: node tools/task.mjs depends ${id} ${union.join(',')})`);
    } else if (lost.length) {
      console.log(`  (dropped: ${lost.join(', ')})`);
    }
    break;
  }

  case 'labels': {
    const { flags: f, positional } = parseArgs(cmd, rest);
    const [id, listRaw] = positional;
    const clear = 'clear' in f;
    if (!id) dieUsage(cmd, 'labels needs the task whose labels are being set');
    // Replaced, never appended to, exactly like `depends` - and said out loud
    // below, because a second call meaning "add one more" otherwise succeeds
    // silently and takes the first labels with it.
    let wanted = [];
    try {
      // The rules live in server/parser.js, shared with the parser and with
      // POST /api/task/:id/labels: a second reading of them here is how the
      // three would come to disagree about "UI ".
      wanted = clear ? [] : checkLabels(listRaw);
    } catch (e) {
      // Same as in `add`: the helper's message plus the usage line of the
      // command that was actually typed (T-0284).
      dieUsage(cmd, e.message);
    }
    if (!clear && wanted.length === 0)
      dieUsage(cmd, 'labels needs either a comma-separated list of labels or --clear');
    const { before, labels } = withUpdate((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) failMissing(id);
      const previous = t.labels.slice();
      t.labels = wanted;
      return { before: previous, labels: wanted };
    });
    console.log(`${id} labels: ${labels.length ? labels.join(', ') : '(none)'}`);
    const lost = before.filter((l) => !labels.includes(l));
    if (lost.length && labels.length) {
      const union = before.concat(labels.filter((l) => !before.includes(l)));
      console.log(`  (dropped: ${lost.join(', ')} — labels SETS the whole list, it never adds to it)`);
      console.log(`  (to keep them, name them too: node tools/task.mjs labels ${id} ${union.join(',')})`);
    } else if (lost.length) {
      console.log(`  (dropped: ${lost.join(', ')})`);
    }
    break;
  }

  case 'profile': {
    const { flags: f, positional } = parseArgs(cmd, rest);
    const [id, valueRaw] = positional;
    const clear = 'clear' in f;
    if (!id) dieUsage(cmd, 'profile needs the task whose run profile is being set');
    const wanted = clear || !valueRaw ? '' : valueRaw.trim();
    if (!clear && !wanted) dieUsage(cmd, 'profile needs either a profile name or --clear');
    // The list lives in the environment, exactly as the board reads it, and is
    // parsed by the board's own code — a second reading of BRIEFBOARD_PROFILES
    // here would be a second opinion about which values are legal.
    const { parseProfiles, PROFILES_ENV } = require('../server/sessions.js');
    const profiles = parseProfiles(process.env[PROFILES_ENV]);
    if (wanted) {
      if (!profiles.values.length)
        die(`no run profiles are declared: set ${PROFILES_ENV}, e.g. ${PROFILES_ENV}='deep, fast' (the first is the default)`);
      // A wrong value carries the usage line; the refusal above does not, and
      // that is the difference between them: nothing about the call is wrong
      // there, the environment declares no profiles at all (T-0273).
      if (!profiles.values.includes(wanted))
        dieUsage(cmd, `"${wanted}" is not in ${PROFILES_ENV} (${profiles.values.join(', ')})`);
    }
    withUpdate((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) failMissing(id);
      t.profile = wanted;
    });
    console.log(`${id} profile: ${wanted || `(default${profiles.default ? ': ' + profiles.default : ''})`}`);
    break;
  }

  case 'brief': {
    const { positional } = parseArgs(cmd, rest);
    const [id, slugRaw] = positional;
    // Without this the lookup below runs on `undefined` and reports "task
    // undefined not found" - a refusal that names the wrong problem and sends
    // the reader looking for a task instead of adding the argument (T-0269).
    // The slug needs no such guard: it deliberately defaults to "brief".
    if (!id) dieUsage(cmd, 'brief needs the task the brief belongs to');
    const slug = (slugRaw || 'brief').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const file = withUpdate((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) failMissing(id);
      const nn = String(nextBriefNumber(t)).padStart(2, '0');
      const briefId = `${id}-${nn}`;
      const outFile = path.join(BRIEF_DIR, `${briefId}-${slug}.md`);
      // The disk decides, not the counter: nn comes from the task's briefs list,
      // so a brief written by hand and not yet linked is invisible to it and the
      // very next call lands on top of it (T-0264). By brief id and not by file
      // name, because findBriefFile() resolves an id by prefix - a second
      // T-0007-01-*.md is a second answer to one id, and readdir order decides
      // which the board shows.
      //
      // Refusing rather than taking the next free NN: renumbering would link the
      // task to a fresh empty template and leave the real brief orphaned, and
      // nothing reports that - validate checks link -> file, never file -> link.
      // A legitimate second brief is untouched: with the first linked, nn is 02
      // and no file holds that id.
      const taken = findBriefFile(BRIEF_DIR, briefId);
      if (taken) failBriefTaken(briefId, taken);
      fs.mkdirSync(BRIEF_DIR, { recursive: true });
      try {
        // 'wx' is O_CREAT|O_EXCL: check and create in one operation, so there is
        // no window after the lookup above. Nothing else closes it - the lock
        // updateBacklog holds is on backlog.md and orders briefboard's own
        // writers, not the editor or the agent writing a brief by hand, which is
        // exactly who wrote the file that was lost.
        fs.writeFileSync(
          outFile,
          `# ${briefId} · ${t.title}\n\n## Context\n\n## Solution\n\n## Scope\n\n## Acceptance criteria\n- [ ] \n`,
          { flag: 'wx' }
        );
      } catch (e) {
        if (e.code === 'EEXIST') failBriefTaken(briefId, outFile);
        throw e;
      }
      t.briefs.push(briefId);
      return outFile;
    });
    console.log(file);
    break;
  }

  // The way out of the state that destroyed two finished briefs: the file is on
  // disk, the task does not know it, and before this the only remaining move was
  // to hand-edit the `briefs:` line of doc/backlog.md - which is the file
  // tools/task.mjs exists to keep hands off, and the one a worker isolated in a
  // worktree may not edit at all (T-0079). It reaches the shared backlog through
  // AGENTBOARD_ROOT like every other command here (T-0267).
  case 'link': {
    const { positional } = parseArgs(cmd, rest);
    const [briefId] = positional;
    if (!briefId) dieUsage(cmd, 'link needs the brief id of the file being linked');
    if (!BRIEF_ID_RE.test(briefId))
      dieUsage(
        cmd,
        `${quote(briefId)} is not a brief id (expected T-NNNN-MM)`,
        'the id is the file name without its slug: doc/brief/T-0007-01-some-slug.md is T-0007-01'
      );
    const id = briefId.slice(0, briefId.lastIndexOf('-'));
    // Existence is checked BEFORE the write, not reported after it: a `briefs:`
    // entry that resolves to nothing is exactly what validate's rule 4 reports,
    // and this command must not be a way to create one.
    const file = findBriefFile(BRIEF_DIR, briefId);
    if (!file)
      die(
        `no file in ${rel(BRIEF_DIR)} answers to ${briefId} (expected ${briefId}.md or ${briefId}-<slug>.md)\n` +
          `  link records a file that already exists; to create one: node tools/task.mjs brief ${id} <slug>`
      );
    const already = withUpdate((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) failMissing(id);
      // One brief id answers to one task. A `briefs:` line is hand-editable, so
      // an id can end up under a task its own prefix does not name; linking it
      // here as well would make two tasks claim one file.
      const other = tasks.find((x) => x.id !== id && x.briefs.includes(briefId));
      if (other)
        fail(
          `${briefId} is already linked by ${other.id}, which is not the task its id names; ` +
            `remove it from ${other.id} first (a brief belongs to one task)`
        );
      if (t.briefs.includes(briefId)) return true;
      t.briefs.push(briefId);
      return false;
    });
    // Said, not silently repeated: a second run leaves the state the caller
    // wanted, and a line identical to the first run's would claim it did the
    // work twice - `briefs:` never gets a duplicate either way.
    console.log(
      already
        ? `${id} already links ${briefId} (${rel(file)})`
        : `${id} += ${briefId} (${rel(file)})`
    );
    break;
  }

  case 'note': {
    const { flags: f, positional } = parseArgs(cmd, rest);
    const [id] = positional;
    if (!id) dieUsage(cmd, 'note needs the task the section is appended to');
    const section = (f.section || '').trim();
    if (!section) dieUsage(cmd, '--section is required, e.g. --section "Worker report"');
    // The only rule the text itself cannot be given: a heading must stay one
    // line. Structure-lookalike lines in the text need no rejection - they are
    // escaped on write like any description (see escapeDescription).
    if (/[\r\n]/.test(section)) dieUsage(cmd, '--section must not contain line breaks');
    if (f.text === undefined) dieUsage(cmd, '--text is required, e.g. --text "..." or --text - for stdin');
    // Multi-line reports are the normal case here, and quoting them through a
    // shell argument is where they get mangled; "-" takes them from stdin whole.
    const text = f.text === '-' ? readStdinValue(cmd, '--text') : f.text;
    if (!text.trim()) dieUsage(cmd, 'nothing to append: the text is empty');
    withUpdate((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) failMissing(id);
      t.description = appendDescriptionSection(t.description, section, text);
    });
    console.log(`${id} += ### ${section}`);
    break;
  }

  case 'show': {
    // The id is the one bare word, so `show --full T-0007` reads the same as
    // `show T-0007 --full`; --full consumes nothing, so nothing else can be one.
    const { flags: f, positional } = parseArgs(cmd, rest);
    const id = positional[0];
    if (!id) dieUsage(cmd, 'show needs the task to print');
    // Both files, always: a task nobody can find is worse than a task found in
    // the archive, and after an `archive` run most ids live there.
    let t = readTasks().find((x) => x.id === id);
    const fromArchive = t ? null : readArchivedTasks(BACKLOG).find((x) => x.id === id);
    t = t || fromArchive || die(`task ${id} not found (looked in ${rel(BACKLOG)} and ${rel(ARCHIVE)})`);
    const out = { ...t };
    // Where the task was found is part of the answer, in the same way T-0161's
    // `omitted` is: an archived task is closed and is NOT in doc/backlog.md, so
    // nothing can be written to it and its id will never be reused.
    if (fromArchive) {
      out.archived = {
        file: rel(ARCHIVE),
        note:
          `this task is CLOSED and lives in ${rel(ARCHIVE)}, not in ${rel(BACKLOG)}; ` +
          'the archive is read-only - status, note and the board never write there',
      };
    }
    // Worker reports are what a task's description mostly IS (63% of this
    // backlog), and none of the readers of `show` - a worker on rework, a review
    // session, the next briefing - opened the task for them. So they are left
    // out, and the leaving out is part of the answer: a `show` that silently
    // returned less would look exactly like a `show` that returned everything.
    const lean = 'full' in f ? null : stripWorkerReports(t.description);
    if (lean && lean.sections > 0) {
      const plural = lean.sections === 1 ? '' : 's';
      out.description = lean.description;
      out.omitted = {
        sections: lean.sections,
        headings: lean.headings,
        bytes: lean.bytes,
        note:
          `the description above is INCOMPLETE: ${lean.sections} worker-report section${plural} ` +
          `left out. For it as stored: node tools/task.mjs show ${t.id} --full`,
      };
    }
    console.log(JSON.stringify(out, null, 2));
    break;
  }

  case 'list': {
    const { flags: f } = parseArgs(cmd, rest);
    // The archive is out by default because `list` is read by an agent and
    // everything in it is closed: no one plans work from a done task. The
    // board, which is read by a human, keeps showing all of them (server.js).
    const all = 'all' in f;
    const archived = fs.existsSync(ARCHIVE) ? readArchivedTasks(BACKLOG) : [];
    const tasks = (all ? archived : []).concat(readTasks());
    const filtered = f.status ? tasks.filter((t) => t.status === f.status) : tasks;
    for (const t of filtered)
      console.log(`${t.id}  ${t.priority}  ${t.status.padEnd(11)}  ${t.title}`);
    // Said out loud, not silently omitted (T-0161's rule): with the closed tasks
    // moved out, `list --status done` prints nothing at all, and a reader who is
    // not told why would conclude the tasks are gone.
    if (!all && archived.length) {
      const s = archived.length === 1 ? '' : 's';
      console.error(`(${archived.length} closed task${s} in ${rel(ARCHIVE)}; --all includes them)`);
    }
    break;
  }

  case 'archive': {
    const { flags: f } = parseArgs(cmd, rest);
    const dryRun = 'dry-run' in f;
    let result;
    try {
      result = archiveClosedTasks(BACKLOG, { dryRun });
    } catch (e) {
      die(e.message);
    }
    if (result.moved.length === 0) {
      console.log('nothing to archive: no done/cancelled tasks in ' + rel(BACKLOG));
      break;
    }
    const kb = (n) => (n / 1024).toFixed(1) + ' KB';
    console.log(
      `${dryRun ? 'would move' : 'moved'} ${result.moved.length} closed tasks -> ${rel(result.file)}`
    );
    if (result.moved.length <= 20) console.log('  ' + result.moved.join(', '));
    console.log(
      `${rel(BACKLOG)}: ${kb(result.bytesBefore)} -> ${kb(result.bytesAfter)}, ${result.kept} tasks left`
    );
    // Only a run that moved something: a dry run leaves every board reading the
    // same file it read before, so there is nothing to warn about yet.
    if (!dryRun) warnOpenBoard();
    break;
  }

  case 'board': {
    parseArgs(cmd, rest);
    // Where the board is (T-0196) - a question with no answer before this: the
    // port comes from a scan, from PORT, or from the kernel with PORT=auto.
    // It reads the trace through openBoards(), the same call the archive warning
    // makes, rather than a reading of its own: two implementations of one
    // liveness check drift apart silently (T-0171, runGit).
    const { traced, untraced, dir, registry, registryError, since } = openBoards();
    // An unreadable registry costs the second witness, so an empty answer below
    // would be narrower than it looks.
    if (registryError) console.error(`WARNING: session registry: ${registryError}`);
    for (const board of traced) {
      console.log(describeBoard(board));
      console.log(`  (${rel(board.file)}).`);
    }
    for (const pid of untraced) {
      console.log(`a board is running for this project: pid ${pid}, address unknown`);
      console.log(`  (${rel(registry)} has a session it started still running;`);
      console.log(`  it left no ${rel(dir)} entry, so it predates briefboard ${since} —`);
      console.log('  such a board cannot say where it listens).');
    }
    // Printing nothing would be indistinguishable from a command that failed to
    // look, and the one board neither witness can see has to be named.
    if (!traced.length && !untraced.length) {
      console.log(`no board is running for this project: no live entry in ${rel(dir)}, and no`);
      console.log(`  session running either. Only a board older than briefboard ${since} could be open`);
      console.log('  unseen — those left no entry.');
    }
    // What "this project" means, said rather than left to be inferred: the trace
    // directory is what makes a board ours, and it is per project.
    console.log(`  (this project is ${ROOT};`);
    console.log(`  a board files its trace under the project it serves, so another project's`);
    console.log(`  boards are in that project's ${rel(dir)} and are never listed here.)`);
    break;
  }

  case 'sessions': {
    parseArgs(cmd, rest);
    // The parsing and the "is it still running" check live in server/sessions.js,
    // the same code the board itself runs — a second reading of that file here
    // would be a second opinion about who is working on what (T-0103).
    const { readSessionRegistry } = require('../server/sessions.js');
    const { sessions, error, file } = readSessionRegistry(ROOT);
    if (error) console.error(`WARNING: session registry: ${error}`);
    if (sessions.length === 0) {
      // No registry means no session has ever run here — an answer, not a failure.
      console.log(`no agent sessions (${file})`);
      break;
    }
    for (const s of sessions) {
      const started = localStamp(new Date(s.startedAt));
      console.log(
        `${s.id}  ${String(s.status).padEnd(11)}  ${String(s.kind).padEnd(8)}  ${started}  ${s.logPath}`
      );
    }
    break;
  }

  case 'validate': {
    parseArgs(cmd, rest);
    const { validateBacklog } = require('../server/validate.js');
    const text = fs.existsSync(BACKLOG) ? fs.readFileSync(BACKLOG, 'utf8') : '';
    const archiveText = fs.existsSync(ARCHIVE) ? fs.readFileSync(ARCHIVE, 'utf8') : '';
    const errors = validateBacklog(text, BRIEF_DIR, archiveText);
    if (errors.length === 0) {
      console.log('OK');
      process.exit(0);
    }
    for (const e of errors) console.error(e);
    process.exit(1);
    break;
  }

  default: {
    // No command at all is someone asking what there is: an answer, on stdout,
    // exit 0. A command that does not exist is a call that did nothing, and it
    // used to be told apart from a call that worked by neither the exit code nor
    // a single word — `task.mjs stauts T-0007 review` printed this same list and
    // exited 0, which in a script reads as the status having been set (T-0220).
    const help =
      'commands: add | status | depends | labels | profile | brief | link | note | show | list | archive | board | sessions | validate  (see the file header)';
    // `help` and its flag spellings are the same question as no command at all,
    // and refusing the one word every CLI answers would be a refusal of the kind
    // this task exists to remove. It is deliberately not in the list it prints:
    // it is a way of asking, not a subcommand — it writes nothing, appears in no
    // workflow, and the list is its own documentation.
    if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      console.log(help);
      break;
    }
    console.error(`ERROR: unknown command ${quote(cmd)}`);
    console.error(help);
    process.exit(1);
  }
}
