'use strict';

/**
 * briefboard server — zero dependencies (Node >= 21).
 *
 * The task actions below are the keys of TASK_ACTIONS, all of them: this list
 * had gone three short (T-0229), so tests/docs.test.js now counts it against
 * that map rather than trusting the next reader to.
 *
 *   / (and /index.html) → ui/index.html
 *   /api/board   → parsed tasks JSON
 *   /api/brief/T-0007-01 → brief file content
 *   /api/task    (POST) → create a task in status backlog (the board's "+" button)
 *   /api/task/T-0007/cancel (POST) → narrow backlog|open -> cancelled transition
 *   /api/task/T-0007/open   (POST) → narrow backlog -> open transition,
 *                                    optionally starting a briefing session
 *   /api/task/T-0007/backlog (POST) → narrow open -> backlog transition, stopping
 *                                    a briefing session that is still running
 *   /api/task/T-0007/briefing (POST) → starts a briefing session on a task that
 *                                    is ALREADY in open; changes no status
 *   /api/task/T-0007/start  (POST) → narrow ready -> in_progress transition,
 *                                    optionally starting an isolated worker session
 *   /api/task/T-0007/rework (POST) → narrow review -> in_progress transition, the
 *                                    same isolated worker session on the round's
 *                                    own branch; refuses when it is gone (T-0329)
 *   /api/task/T-0007/resume (POST) → starts that same isolated worker session on a
 *                                    task ALREADY in in_progress whose session is
 *                                    gone; changes no status at all (T-0333)
 *   /api/task/T-0007/answer (POST) → appends an answer to the description of a
 *                                    task waiting on session questions
 *   /api/task/T-0007/profile (POST) → sets the task's run profile and nothing
 *                                    else; no status, no session (T-0108)
 *   /api/task/T-0007/labels (POST) → replaces the task's label list and nothing
 *                                    else; any status, no session (T-0279)
 *   /api/task/T-0007/review (POST) → starts the review session on a task that is
 *                                    ALREADY in review; changes no status
 *   /api/task/T-0007/done   (POST) → narrow review -> done transition, refused
 *                                    while the task's branch is not merged
 *   /api/task/T-0007/remove-worktree (POST) → removes that task's worktree under
 *                                    the rules of T-0099; writes no backlog
 *   /api/git/T-0007         → what git says about that task: branch, merged,
 *                             worktree, whether its tree is clean (T-0148)
 *   /api/sessions           → agent session registry, uncached, with what each
 *                             task cost and what the watchdog found (T-0159)
 *   /api/session/T-0007/log → the tail of that session's log, as text
 *   /api/session/T-0007/stop (POST) → kills that session
 *   /api/shutdown (POST) → stops the board process (loopback callers only)
 *   /events      → SSE stream: "changed {delta}" when doc/ changes (T-0160),
 *                  "sessions" when a session starts or ends, and "shutdown"
 *                  once when the board is stopping for good
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  parseBacklog,
  nowStamp,
  updateBacklog,
  findBriefFile,
  addTask,
  blockingDependencies,
  awaitsAnswer,
  countReviewVerdicts,
  appendDescriptionSection,
  archivePathFor,
  readArchivedTasks,
  ANSWERS_SECTION,
  ANSWER_STATUSES,
  SESSION_QUESTIONS_HEADING,
  PRIORITIES,
  STATUSES,
  TASK_TYPES,
  checkLabels,
  LOCK_TIMEOUT_CODE,
} = require('./parser');
const { createSessionRunner, resolveReviewCommand } = require('./sessions');
const { createGitOps, BRANCH_PREFIX } = require('./git');
const {
  createWatchdog,
  parseInterval: parseWatchdogInterval,
  INTERVAL_ENV: WATCHDOG_INTERVAL_ENV,
} = require('./watchdog');
const { writeBoardTrace, removeBoardTrace, sweepBoardTraces } = require('./trace');
const { isLoopbackAddress, isLoopbackHost, isLoopbackRemote } = require('./loopback');
const {
  DEFAULT_PORT,
  parsePort,
  portCandidates,
  listenWithFallback,
  loopbackShadowMessage,
} = require('./listen');

const ROOT = path.resolve(__dirname, '..');
// AGENTBOARD_ROOT lets a single installation serve any project:
//   AGENTBOARD_ROOT=/path/to/project node ~/tools/briefboard/server/server.js
const PROJECT = process.env.AGENTBOARD_ROOT ? path.resolve(process.env.AGENTBOARD_ROOT) : ROOT;
const DOC_DIR = path.join(PROJECT, 'doc');
const BRIEF_DIR = path.join(DOC_DIR, 'brief');
const BACKLOG = path.join(DOC_DIR, 'backlog.md');
// The closed tasks moved out by `tools/task.mjs archive` (T-0156). The board is
// read by a human, so it shows them exactly as before: archiving takes nothing
// off the board, it only takes tokens off an agent reading the backlog file.
// The server never writes this file - see boardTasks().
const ARCHIVE = archivePathFor(BACKLOG);
const UI_HTML = path.join(ROOT, 'ui', 'index.html');
// A port asked for by hand is honoured or refused, never quietly swapped; only
// the default may fall back to a neighbour (server/listen.js).
const PORT_EXPLICIT = Boolean(process.env.PORT && process.env.PORT.trim());
let PORTS;
try {
  PORTS = portCandidates(PORT_EXPLICIT ? parsePort(process.env.PORT) : DEFAULT_PORT, PORT_EXPLICIT);
} catch (e) {
  console.error(`briefboard: ${e.message}`);
  process.exit(1);
}
// Bind to loopback by default so the board and its writing endpoints (create a
// task, cancel it, move it to open, start it, answer its session) are not
// exposed to the LAN without authentication. A public bind is opt-in only, via
// HOST / AGENTBOARD_HOST.
const HOST = process.env.HOST || process.env.AGENTBOARD_HOST || '127.0.0.1';
// The names this board answers to on top of its own loopback address, for a
// reverse proxy that forwards the browser's Host instead of rewriting it to the
// upstream (nginx rewrites by default; `proxy_set_header Host $host` does not).
// Declared, like every other value the board cannot work out for itself
// (T-0108, T-0116) — see hostAllowed().
const ALLOWED_HOSTS = (process.env.BRIEFBOARD_ALLOWED_HOSTS || '')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);
// Names the board in the header and the tab title, so two projects' boards are
// told apart at a glance. Capped and single-line because it lands in a browser
// tab; the folder name is the default because briefboard is not a Node-only
// tool and package.json may not exist.
const PROJECT_NAME_MAX = 60;
// Cut by code point, not by UTF-16 unit: slicing a folder name mid-surrogate
// would put a lone half of an emoji into the JSON and the tab title.
const PROJECT_NAME = [
  ...((process.env.BRIEFBOARD_NAME || '').trim() || path.basename(PROJECT) || PROJECT).replace(/\s+/g, ' '),
]
  .slice(0, PROJECT_NAME_MAX)
  .join('');
// Cap on concurrent SSE connections; each open /events request holds a socket
// and a Set entry, so an unbounded Set is a trivial resource-exhaustion vector.
const MAX_SSE_CLIENTS = Number(process.env.MAX_SSE_CLIENTS) || 50;

// The task actions have no pattern of their own here: TASK_ACTION_RE is built
// from TASK_ACTIONS, next to the map itself, so the set of actions is written
// once (T-0229).
//
// The read half of closing a task (T-0148): a GET, because it changes nothing.
const GIT_STATE_RE = /^\/api\/git\/(T-\d{4})$/;
// The same strict id pattern guards the session routes: the log a request can
// reach is chosen by looking that id up in the registry, so an id that is not
// literally T-NNNN never gets as far as a filesystem path.
const SESSION_ACTION_RE = /^\/api\/session\/(T-\d{4})\/(log|stop)$/;

// ---------- limits for the endpoints that take a JSON body ----------
// The endpoints are anonymous, so an unbounded `body += chunk` would be a
// trivial memory-exhaustion DoS.
const MAX_BODY_BYTES = 16 * 1024;
// Enforced here because the client is never trusted: the board's form carries
// the same maxlength attributes, but a hand-made request does not.
const MAX_TITLE_LEN = 200;
const MAX_DESCRIPTION_LEN = 4000;

// ---------- agent sessions (T-0076, T-0084) ----------
// Opt-in per kind: with neither command set nothing is ever spawned. Both are
// read from the environment here and only here — no request can supply, extend
// or override them.
// Two variables configure the review session and the newer one wins; which is
// decided inside sessions.js and asked for here, so the board and the runner can
// never answer differently about whether that session exists (T-0305).
const review = resolveReviewCommand(process.env);
const sessionRunner = createSessionRunner({
  project: PROJECT,
  command: process.env.BRIEFBOARD_SESSION_CMD,
  workerCommand: process.env.BRIEFBOARD_WORKER_CMD,
  // The review session (T-0122). Unset = the board offers no such action at all,
  // exactly as an unset worker command starts nothing.
  orchestratorCommand: review.command,
  orchestratorEnvName: review.envName,
  // What turns a bare worktree into one the project's own tests can run in
  // (T-0150). Unset is the normal case for a project with no dependencies, and
  // then nothing is run and nothing is said about it.
  setupCommand: process.env.BRIEFBOARD_SETUP_CMD,
  // How long that command may take (T-0328). The default bounds somebody else's
  // install, which briefboard cannot measure, so a project that knows its own
  // install can never legitimately run that long says so here rather than
  // holding the drop for ten minutes. Passed raw and normalized in sessions.js,
  // exactly like the cap below.
  setupTimeoutMs: process.env.BRIEFBOARD_SETUP_TIMEOUT_MS,
  maxSessions: process.env.BRIEFBOARD_SESSION_MAX,
  // The run profiles the user declared (T-0108). briefboard reads them as
  // opaque strings; what they mean lives in the command templates above.
  profiles: process.env.BRIEFBOARD_PROFILES,
  // How to read a token count out of a session's log, in the user's own words
  // (T-0116). Unset is the normal case: the board then reports the time a task
  // took and claims nothing about tokens.
  tokensPattern: process.env.BRIEFBOARD_TOKENS_RE,
  // Whether those matches are added up or the last one is the total (T-0116):
  // the two logs are indistinguishable, so only the user can say which it is.
  tokensMode: process.env.BRIEFBOARD_TOKENS_MODE,
  loopback: isLoopbackHost(HOST),
  onChange: () => {
    broadcastSessions();
    // A session ending is half of what the watchdog compares, and the half that
    // creates the discrepancies worth catching (T-0159).
    watchdog.schedule();
  },
});

// Reading git state and removing a worktree (T-0148). Bound to the project once,
// like everything else here: no request supplies a path or a branch name.
const gitOps = createGitOps({ project: PROJECT });

// What an agent claimed against what git and the registry show (T-0159). It
// reads both through the objects above and writes nothing; its findings ride
// along with /api/sessions, because they are the same kind of state — true of
// the project right now, and untouched by the backlog's mtime that /api/board is
// cached against (T-0077).
const watchdog = createWatchdog({
  survey: () => gitOps.survey(),
  snapshot: watchdogSnapshot,
  onChange: () => broadcastSessions(),
  // How rarely it may ask git, or `off`. Read here and only here, like every
  // other setting the board takes from its environment; parsed here too, because
  // the floor is what the environment is allowed to move and the watchdog itself
  // takes a resolved number (T-0228).
  intervalMs: parseWatchdogInterval(process.env[WATCHDOG_INTERVAL_ENV]),
});

// The board as the watchdog needs it: a status per task, and the sessions this
// board has records for. The tasks come out of the cache /api/board is served
// from, so a scan re-reads the backlog only when it has actually changed; they
// are re-parsed rather than kept as a second copy, because a copy would be one
// more thing that can disagree with the board.
function watchdogSnapshot() {
  let tasks = [];
  try {
    refreshBoard(boardStats());
    tasks = [...board.byId.values()].map((json) => JSON.parse(json));
  } catch {
    /* the backlog is unreadable: there is nothing to compare git against */
  }
  return { tasks, sessions: sessionRunner.list() };
}

// 'started' | 'disabled' | 'already-running' | 'limit' | 'error' |
// 'unknown-profile' (T-0108), plus the refusals of an isolated session:
// 'no-git' | 'not-a-repo' | 'worktree-failed' (T-0091), 'setup-failed' |
// 'setup-timeout' (T-0150).
async function startSessionFor(id, options) {
  try {
    const result = await sessionRunner.startSession(id, options);
    return result.started ? 'started' : result.reason;
  } catch (e) {
    // Last net: a session failure must never turn a completed transition into a 500.
    console.error(`session ${id}: unexpected failure: ${e.message}`);
    return 'error';
  }
}

// ---------- SSE ----------
const clients = new Set();

// Carries what changed, so a board with a thousand tasks does not pull the whole
// list back for a single status edit (T-0160). Correctness comes first and is
// the client's rule, not the payload's: a delta says which version it applies
// to, and a client that is anywhere else reloads everything.
function broadcast() {
  let body;
  try {
    refreshBoard(boardStats());
    body = boardDeltaJson();
  } catch {
    // The backlog vanished or became unreadable. Say nothing about versions:
    // with no `v` to match, every client falls back to a full reload and learns
    // from /api/board what state the file is in.
    pendingIds.clear();
    body = `{"base":${sentVersion},"full":true}`;
  }
  const frame = `data: changed ${body}\n\n`;
  for (const res of clients) res.write(frame);
  // The other half of what the watchdog compares: a status was written, so what
  // it means may have changed even though git did not move (T-0159).
  watchdog.schedule();
}

// Its own event, not 'changed': a session starting or dying leaves the backlog
// untouched, so a board that answered this by re-reading /api/board would get a
// 304 off that response's ETag and learn nothing (T-0077).
function broadcastSessions() {
  for (const res of clients) res.write('data: sessions\n\n');
}

// A third event, and sent exactly once: every open tab has to tell "I stopped
// this board" from "the connection dropped" (T-0082). Only the deliberate exit
// sends it, so a Ctrl+C or a crash still leaves the board reconnecting.
function broadcastShutdown() {
  for (const res of clients) {
    try {
      res.write('data: shutdown\n\n');
      res.end();
    } catch {
      /* the client is already gone */
    }
  }
  clients.clear();
}

// fs.watch fires bursts of events; debounce a single broadcast across all
// watchers so DOC_DIR and BRIEF_DIR events collapse into one SSE 'changed'.
let timer = null;
function scheduleBroadcast() {
  clearTimeout(timer);
  timer = setTimeout(broadcast, 150);
}

function watchDir(dir, onChange) {
  try {
    return fs.watch(dir, { persistent: true }, onChange);
  } catch (e) {
    console.error(`watch failed for ${dir}: ${e.message}`);
    return null;
  }
}

// fs.watch is not reliably recursive across platforms, so watching DOC_DIR does
// not catch changes inside doc/brief/ — and that directory may not exist yet
// (a fresh project gets its first brief at runtime). Hence a second watcher,
// attached lazily and re-attached if the directory is removed and recreated.
let briefWatcher = null;

function ensureBriefWatch() {
  const exists = fs.existsSync(BRIEF_DIR);
  if (briefWatcher && !exists) {
    try {
      briefWatcher.close();
    } catch {
      /* already closed */
    }
    briefWatcher = null;
    return;
  }
  if (briefWatcher || !exists) return;
  briefWatcher = watchDir(BRIEF_DIR, scheduleBroadcast);
  if (briefWatcher) {
    briefWatcher.on('error', () => {
      // The handle is unusable after an error (the dir vanished, say); drop it
      // so ensureBriefWatch() can re-attach later.
      try {
        briefWatcher.close();
      } catch {
        /* already closed */
      }
      briefWatcher = null;
    });
  }
}

// A doc/ event may be the first appearance of doc/brief/, so reconcile that
// watcher before broadcasting.
function onDocEvent() {
  ensureBriefWatch();
  scheduleBroadcast();
}

// ---------- helpers ----------
function json(res, code, data, headers) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

// How much later a client is told to retry after losing the race for the backlog
// lock. A real write holds it for single-digit milliseconds, so one second is
// already generous; the header exists to say "this is contention", not to pace
// a queue.
const LOCK_RETRY_AFTER_S = '1';

// The one place that turns a thrown error into an HTTP answer, shared by every
// writing endpoint (a copy per handler is how the 503 below was missing from two
// of the three in the first place, T-0081).
//
// A lock-acquire timeout is "busy, retry", not "the server is broken": 500 makes
// the board and the user treat routine contention as a fault. Anything without
// its own httpStatus tag is still a genuine 500.
function failRequest(res, e) {
  if (e.httpStatus) {
    json(res, e.httpStatus, { error: e.message });
    return;
  }
  if (e.code === LOCK_TIMEOUT_CODE) {
    json(
      res,
      503,
      { error: 'doc/backlog.md is busy (another writer holds the lock); retry' },
      { 'Retry-After': LOCK_RETRY_AFTER_S }
    );
    return;
  }
  json(res, 500, { error: e.message });
}

// ---------- UI HTML cache ----------
// statSync is cheap and always reflects the current file, so keeping the bytes
// in memory keyed on mtime saves the read without ever serving stale content.
let uiCache = { mtimeMs: -1, body: null };
function readUiHtml() {
  const { mtimeMs } = fs.statSync(UI_HTML);
  if (uiCache.body === null || mtimeMs !== uiCache.mtimeMs) {
    uiCache = { mtimeMs, body: fs.readFileSync(UI_HTML) };
  }
  return uiCache;
}

// ---------- /api/board state, versions and deltas (T-0160) ----------
// Keyed on the backlog's mtime+size, so an unchanged file reuses the serialized
// JSON and any change invalidates the entry (no stale board).
//
// `byId` keeps each task's own serialized JSON. That is what makes a change
// diffable — the SSE frame then names the tasks that differ instead of telling
// every open board to pull the whole list back (4.3 MB per status change,
// measured on 978 tasks). The strings are reused for both answers, so the diff
// costs no extra serialization.
//
// One function computes both, so the version /api/board hands out and the
// version a delta is built against can never disagree.
let board = { key: null, version: 0, byId: new Map(), json: null };
// Ids that changed since the last frame went out. A frame may span several
// versions (a request can refresh the board before the watcher fires), which is
// why the payload carries `base` — the version it applies to.
let pendingIds = new Set();
let sentVersion = 0;
// Past this many changed tasks the frame is the size of the board it replaces,
// so it says "reload" instead — the path that is correct anyway.
const MAX_DELTA_TASKS = 50;

// Both files, because both are shown: an archive that changed (or appeared, or
// went away) has to invalidate the cached JSON and the ETag exactly like the
// backlog does. Throws when the backlog itself is unreadable - the archive
// merely being absent is the normal state of a project that never archived.
function boardStats() {
  let archive = null;
  try {
    archive = fs.statSync(ARCHIVE);
  } catch {
    /* no archive */
  }
  return { stat: fs.statSync(BACKLOG), archive };
}

function boardEtag({ stat, archive }) {
  return `W/"${stat.mtimeMs}-${stat.size}-${archive ? `${archive.mtimeMs}-${archive.size}` : 'none'}"`;
}

// `blockedBy` (unfinished prerequisites, T-0087) is resolved here, not in the
// browser: the board must not build the dependency graph itself, and the same
// value gates a server-side start. `awaitingAnswer` (T-0083) is derived here for
// the same reason - the file is read on this side, and the board should not have
// to parse markdown to learn one boolean.
//
// Both files (T-0156), archived first: those tasks are the older ones and stood
// first in the backlog before they were moved, so the Done and Cancelled columns
// read exactly as they did. An id that is in both files - what an interrupted
// archive run leaves behind - is shown once, taken from the live backlog, which
// is the copy every command still writes to; `validate` reports the duplicate.
function boardTasks(text) {
  const merged = new Map();
  for (const t of readArchivedTasks(BACKLOG)) merged.set(t.id, t);
  for (const t of parseBacklog(text)) merged.set(t.id, t);
  const tasks = [...merged.values()];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.map((t) => ({
    ...t,
    blockedBy: blockingDependencies(t, byId),
    awaitingAnswer: awaitsAnswer(t),
  }));
}
// Static for the process's lifetime (session commands, bind address and project
// name are read once at start-up), so it is serialized alongside the parsed
// board. The two session kinds are reported apart because the board's drop
// confirmation has to say whether an agent will actually be started (T-0084).
function boardMeta() {
  return {
    sessions: {
      enabled: sessionRunner.enabled,
      worker: sessionRunner.workerEnabled,
      // The review action exists on the board only when a command backs it: it
      // starts a session and nothing else, so with no template there is nothing
      // left for the button to do (T-0122).
      orchestrator: sessionRunner.orchestratorEnabled,
      // What the user declared, in declaration order (first = default), so the
      // board can offer exactly those and nothing else. Empty = the feature is
      // not configured and the UI shows no control at all.
      profiles: sessionRunner.profiles,
      // The other half of the same feature: which command templates contain
      // {profile} at all. Declared profiles alone give the board a control whose
      // choice has nowhere to go (T-0121).
      profileUsedBy: sessionRunner.profileUsedBy,
    },
    project: { name: PROJECT_NAME },
  };
}
function boardMetaJson() {
  return JSON.stringify(boardMeta());
}

// The answer for a board whose backlog cannot be read (T-0247). The meta rides
// along with it because none of it comes from that file: the project name in
// particular is read at start-up, and dropping it made the header of a board
// with no backlog lose the one word that says WHICH project is being looked at.
function missingBacklogBody() {
  return { tasks: [], error: 'doc/backlog.md not found', ...boardMeta() };
}

// Re-reads the backlog when its mtime+size changed and records which tasks now
// differ. The comparison is on the serialized task, so a change that only shows
// in a derived field is caught too: closing a prerequisite frees `blockedBy` on
// tasks the edit never touched.
//
// The very first read only establishes the baseline. A client cannot have
// missed what happened before the server knew anything — and one that read
// /api/board while the backlog was unreadable got no version at all, so no
// delta will apply to it.
function refreshBoard(stats) {
  const key = boardEtag(stats);
  if (board.json !== null && key === board.key) return board;
  const baseline = board.key === null;
  const byId = new Map();
  for (const task of boardTasks(fs.readFileSync(BACKLOG, 'utf8'))) {
    byId.set(task.id, JSON.stringify(task));
  }
  let changed = 0;
  if (!baseline) {
    for (const [id, taskJson] of byId) {
      if (board.byId.get(id) !== taskJson) {
        pendingIds.add(id);
        changed++;
      }
    }
    for (const id of board.byId.keys()) {
      if (!byId.has(id)) {
        pendingIds.add(id);
        changed++;
      }
    }
  }
  const version = changed ? board.version + 1 : board.version;
  // Hand-assembled so the per-task strings above are reused verbatim instead of
  // the whole board being serialized a second time.
  board = {
    key,
    version,
    byId,
    json: `{"version":${version},"tasks":[${[...byId.values()].join(',')}],${boardMetaJson().slice(1)}`,
  };
  return board;
}

// The frame body: what changed between the last one sent and now. `v` is absent
// only when the backlog could not be read — no client holds that version, so
// every one of them reloads.
function boardDeltaJson() {
  const base = sentVersion;
  sentVersion = board.version;
  const ids = [...pendingIds];
  pendingIds.clear();
  if (ids.length > MAX_DELTA_TASKS) return `{"base":${base},"v":${board.version},"full":true}`;
  const changed = [];
  const removed = [];
  for (const id of ids) {
    const taskJson = board.byId.get(id);
    if (taskJson === undefined) removed.push(id);
    else changed.push(taskJson);
  }
  return `{"base":${base},"v":${board.version},"tasks":[${changed.join(',')}],"removed":${JSON.stringify(removed)}}`;
}

// What sameOrigin() below compares against, and the reason it can be trusted.
//
// `Host` is chosen by whoever sends the request, so "Origin equals Host" proves
// nothing on its own: a page on evil.com with a short TTL re-points its own name
// at 127.0.0.1, the browser then sends Host: evil.com and Origin: http://evil.com
// — equal — and every endpoint was open, including the one that starts an agent
// session (T-0226, DNS rebinding). Binding to loopback does not help: the
// request comes from the victim's own machine.
//
// So the name is compared with what the board IS. The only trustworthy source
// for that is server.address(): after T-0139 the port may have been chosen by
// the kernel, so nothing may assume 4571.
const HOST_HEADER_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i;
const HTTP_DEFAULT_PORT = 80;

function hostAllowed(req) {
  // A public bind is reachable by name from the network already, and says so at
  // start-up: there is no set of names to check against, and pretending to one
  // would be a guard in name only. Sessions are refused under it for that same
  // reason (compileTemplate).
  if (!isLoopbackHost(HOST)) return true;
  const raw = req.headers.host;
  if (typeof raw !== 'string') return false; // HTTP/1.1 mandates Host
  const value = raw.trim().toLowerCase();
  const m = value.match(HOST_HEADER_RE);
  if (!m) return false;
  const name = m[1].startsWith('[') ? m[1].slice(1, -1) : m[1];
  // A declared name matches on the name alone: what a proxy puts in the port is
  // the proxy's business, and the name is the half a rebinding attacker cannot
  // produce.
  if (ALLOWED_HOSTS.includes(name) || ALLOWED_HOSTS.includes(value)) return true;
  if (name !== 'localhost' && !isLoopbackAddress(name)) return false;
  const addr = server.address();
  if (!addr) return false;
  return (m[2] ? Number(m[2]) : HTTP_DEFAULT_PORT) === addr.port;
}

// CSRF guard for every writing endpoint. A cross-site form POST triggers no
// preflight, so without this check any site open in the user's browser could
// rewrite the backlog. The scheme is intentionally not compared (it can differ
// behind a reverse proxy; for CSRF the host is what matters). Non-browser
// clients (curl, the CLI, the tests) send no Origin/Referer and are allowed
// through — a cross-site browser POST always carries an Origin.
function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false; // HTTP/1.1 mandates Host; be strict for writes
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false; // unparseable Origin → reject
    }
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false; // unparseable Referer → reject
    }
  }
  return true; // neither header → non-browser client, allow
}

// A cross-site HTML <form> cannot send application/json, so requiring that type
// (when the client declares one at all) is a cheap second CSRF barrier on top of
// sameOrigin(). Answers 415 and returns false when the check fails.
function jsonContentType(res, req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/json') {
    json(res, 415, { error: 'Content-Type must be application/json' });
    return false;
  }
  return true;
}

// Shared body of the narrow writing endpoints below. Callers pass the source
// statuses they accept and a `mutate(task, tasks)` doing their one hard-coded
// edit, so this stays "run one specific write safely" and never becomes "set
// whatever status the client asked for". `tasks` is the whole parsed backlog,
// for a precondition that has to look past the task itself (the dependency gate
// of /start). `mutate` need not change the status at all — /answer only appends
// to the description and leaves the task where it stands.
//
// The read, the precondition check and the write happen inside a single
// updateBacklog() lock, so a concurrent CLI/second-request write can't be lost
// (doc/brief/T-0046-01-backlog-write-lock.md). Precondition failures throw out
// of `mutate` with an httpStatus tag, leaving the file untouched.
//
// `after` runs once the transition is written and its result is merged into the
// 200 payload. It is deliberately NOT transactional with the write: the
// transition already happened and stands on its own, so a failure there is
// reported in the payload, never by undoing the write or answering with an error.
// /start is the one caller that compensates for its own write when the dispatch
// never reached a session (T-0325) — a second, conditional write it makes itself
// inside its `after`, never something this helper does for anybody.
function applyNarrowWrite(res, id, allowedFrom, conflictMessage, mutate, after) {
  let result;
  try {
    result = updateBacklog(BACKLOG, (tasks) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) {
        const e = new Error(`${id} not found`);
        e.httpStatus = 404;
        throw e;
      }
      if (!allowedFrom.includes(task.status)) {
        const e = new Error(conflictMessage);
        e.httpStatus = 409;
        throw e;
      }
      return mutate(task, tasks);
    });
  } catch (e) {
    failRequest(res, e);
    return;
  }
  if (!after) {
    json(res, 200, result);
    return;
  }
  Promise.resolve()
    .then(() => after(result))
    .then((extra) => json(res, 200, { ...result, ...extra }))
    .catch((e) => {
      console.error(`post-write step for ${id} failed: ${e.message}`);
      json(res, 200, result);
    });
}

// NOT a generic "set status" endpoint — see doc/brief/T-0017-01-drag-cancel.md.
// The client's own check is UX only; the precondition check here is the real one.
function handleCancelTask(req, res, id) {
  applyNarrowWrite(
    res,
    id,
    ['backlog', 'open'],
    'task is not in backlog/open, it cannot be cancelled from the UI',
    (task) => {
      task.status = 'cancelled';
      task.closed = nowStamp();
      return { ok: true, id, status: task.status, closed: task.closed };
    }
  );
}

// Driven by dragging a card from Backlog into Open (T-0075). As narrow as the
// cancel endpoint. `closed` is deliberately left untouched: it is only ever set
// for the closing statuses (done/cancelled), and `open` is not one of them.
//
// An agent session may follow the transition (T-0076), if one is configured. If
// it cannot start, the task simply stays in `open` waiting for a human: still a
// 200, with `session` saying what happened.
//
// It follows only a task that has no briefs (T-0141). A task that already has one
// has been briefed before — it was put back down and is coming up again — and
// paying an agent to write a second brief over the first is not what the drop
// asked for. The answer says `briefed` rather than pretending a session ran, and
// starting one anyway stays available as /briefing below, because a brief can go
// stale and only a human can say that it has.
function handleOpenTask(req, res, id) {
  let briefed = false;
  applyNarrowWrite(
    res,
    id,
    ['backlog'],
    'task is not in backlog, it cannot be moved to open from the UI',
    (task) => {
      task.status = 'open';
      briefed = task.briefs.length > 0;
      // The profile comes from the file the server just read, never from the
      // request: a session's command line stays out of a caller's reach.
      return { ok: true, id, status: task.status, profile: task.profile };
    },
    async (written) => ({
      session: briefed ? 'briefed' : await startSessionFor(id, { profile: written.profile }),
    })
  );
}

// The way back (T-0141): the card was pulled into Open by mistake, or the answer
// is "not now". Before this the only route out of `open` that a board offered was
// `cancelled`, which is terminal — so shelving a task meant burying it.
//
// It writes one field. `closed` is untouched for the same reason /open leaves it
// alone: it belongs to the closing statuses and neither end of this move is one.
// Nothing in the description is rewritten either, so the questions and answers
// already there stay in the order they were written (T-0114); the "needs answer"
// marker goes out by itself, because `backlog` is not one of ANSWER_STATUSES.
function handleReturnToBacklog(req, res, id) {
  applyNarrowWrite(
    res,
    id,
    ['open'],
    'task is not in open, it cannot be put back into the backlog from the UI',
    (task) => {
      task.status = 'backlog';
      return { ok: true, id, status: task.status };
    },
    // A briefing session still running is writing into a task that has just left
    // the status it was started for, so it is stopped — through the one stop path
    // there is (T-0077), whose bookkeeping is the child's own exit handler, and
    // never through a second one. After the write, not before: a refused
    // transition must not cost a running session, and a kill that finds nothing
    // is reported, never allowed to undo the transition.
    async () => {
      const stopped = sessionRunner.stopSession(id);
      return { session: stopped.stopped ? 'stopped' : stopped.reason };
    }
  );
}

// Driven by dragging a card from Ready into In Progress (T-0084).
//
// The dependency gate is the CLI's rule, applied by the CLI's own
// blockingDependencies(): a task whose prerequisites are unfinished cannot be
// started at all. There is deliberately no `--force` counterpart here — the
// override stays in the CLI, where it warns loudly, so the board can never
// silently begin blocked work.
//
// The session that follows is the worker one, isolated in its own git worktree
// (T-0091): it writes code and commits, and doing that in the shared checkout
// would move HEAD under everyone else (T-0064).
//
// A dispatch that never reached a session puts the task back (T-0325): the
// transition is written first and rolled back below, rather than deferred until
// the session exists. That order is not a compromise. The status is the only
// thing excluding a SECOND start while this one prepares — startSession() refuses
// a duplicate on its `children` map, which stays empty until a process is
// actually spawned, and the worktree setup in between can run for minutes. Move
// the transition after the setup and two concurrent starts run the project's
// setup command in the same worktree.
function handleStartTask(req, res, id) {
  applyNarrowWrite(
    res,
    id,
    ['ready'],
    'task is not ready, it cannot be started from the UI',
    (task, tasks) => {
      // Archived prerequisites count as satisfied, not as missing: a task is
      // archived only once it is done or cancelled, and resolving `depends`
      // against the live file alone would make every dependent unstartable the
      // moment its prerequisite was archived (T-0156).
      const known = tasks.concat(readArchivedTasks(BACKLOG));
      const blocking = blockingDependencies(task, known);
      if (blocking.length) {
        const byId = new Map(known.map((t) => [t.id, t]));
        const listed = blocking
          .map((depId) => `${depId} (${byId.has(depId) ? byId.get(depId).status : 'not found'})`)
          .join(', ');
        const e = new Error(`cannot start ${id}: unfinished dependencies: ${listed}`);
        e.httpStatus = 409;
        throw e;
      }
      task.status = 'in_progress';
      return { ok: true, id, status: task.status, profile: task.profile };
    },
    async (written) => {
      const session = await startSessionFor(id, {
        kind: 'worker',
        isolate: true,
        profile: written.profile,
      });
      if (KEEPS_THE_TASK_TAKEN.has(session)) return { session };
      return { session, ...rollBackDispatch(id, session, 'ready') };
    }
  );
}

// ---------- putting a worker on a task that is PAST `ready` ----------
// The two dispatches that are not /start: /rework, which carries `review ->
// in_progress` (T-0329), and /resume, which carries no transition at all
// (T-0333). What they refuse before doing anything is here, once, because they
// have to refuse alike — a second copy is where the two would quietly stop
// doing so.
//
// The order is the order of what the checks are about: the task, then the
// registry, then git. Asking git first would report an unknown id as a missing
// branch.
//
//   the status  — carries `reason: 'bad-status'`, which /start's own 409 does
//                 not: both of these are dispatched from the CLI as well, and
//                 there the reason is what the exit code is read from (T-0319).
//   the session — refused BEFORE anything is written or prepared, where /start
//                 lets the answer `already-running` keep the card it has just
//                 moved. /start's card was `ready`, and a session on it is a task
//                 legitimately taken; here a live session means the dispatch has
//                 nothing to do — the review session is running, or the worker
//                 still is. It is read from the REGISTRY and never inferred from
//                 the status, which cannot tell a dead session from a live one.
//                 Refusing first is also what keeps doc/backlog.md untouched by a
//                 refusal.
//   the branch  — `task/T-NNNN` is what carries the work already done. Gone, it
//                 is not an ambiguity: prepareWorktree() would create it afresh
//                 from HEAD, and the session would begin without the work it is
//                 there to continue — silently, and unrecoverably. A missing
//                 WORKTREE over a live branch is the opposite case and is NOT
//                 refused: it is recreated exactly as /start's would be, and its
//                 setup runs again, because setUpWorktree() clears the stamp for
//                 a worktree it created (T-0150).
//
// `branchLoss` is the half of that last refusal only the caller can word: what
// starting from HEAD would cost is a round for one of them and the work being
// resumed for the other.
function guardWorkerDispatch(res, id, { from, conflict, branchLoss }, then) {
  let task;
  try {
    task = parseBacklog(fs.readFileSync(BACKLOG, 'utf8')).find((t) => t.id === id);
  } catch (e) {
    failRequest(res, e);
    return;
  }
  if (!task) {
    json(res, 404, { error: `${id} not found` });
    return;
  }
  if (task.status !== from) {
    json(res, 409, { error: conflict, reason: 'bad-status' });
    return;
  }
  const running = sessionRunner.get(id);
  if (running && running.status === 'running') {
    json(res, 409, {
      error: 'an agent session is already running on this task',
      reason: 'already-running',
    });
    return;
  }
  gitOps.inspect(id).then((state) => {
    // Only on a fact git actually established. A git that is missing, a project
    // that is not a repository, a call that timed out — none of them say the
    // branch is gone, and the dispatch refuses them on its own with its own
    // reason a moment later (T-0091), which is a truer answer than this one.
    if (state.git === 'ok' && !(state.branches || []).includes(BRANCH_PREFIX + id)) {
      json(res, 409, {
        error: `there is no ${BRANCH_PREFIX + id} branch: ${branchLoss}`,
        reason: 'no-branch',
        branch: BRANCH_PREFIX + id,
      });
      return;
    }
    then(task);
  }, (e) => failRequest(res, e));
}

// The dispatch a card returned for review never had (T-0329).
//
// `review -> in_progress` has been a legal transition all along and has never
// needed `--force`: TRANSITIONS carries it and ORCHESTRATOR.md documents it. What
// did not exist is an operation that puts a WORKER on a task past `ready` —
// /start is bound to `ready` by the transition it performs, and `tools/task.mjs
// status ... in_progress` moves the card and starts nothing.
//
// So this is /start's sibling and not a second copy of it: the same isolated
// worker session, the same rollback, the same reading of the profile from the
// file. What it refuses before any of that is above, shared with /resume.
function handleReworkTask(req, res, id) {
  const conflict = 'task is not in review, it cannot be sent back for rework from the UI';
  guardWorkerDispatch(
    res,
    id,
    {
      from: 'review',
      conflict,
      branchLoss: 'the previous round is not here, and a rework would start from HEAD and lose it',
    },
    () => {
      applyNarrowWrite(
        res,
        id,
        ['review'],
        conflict,
        (t) => {
          // The round is derived and stored nowhere (decision 6): one more than the
          // verdicts already written. A backlog field would be a compatibility
          // question between parser versions, and this needs none.
          const round = countReviewVerdicts(t.description) + 1;
          t.status = 'in_progress';
          return { ok: true, id, status: t.status, round, profile: t.profile };
        },
        async (written) => {
          const session = await startSessionFor(id, {
            kind: 'worker',
            isolate: true,
            profile: written.profile,
          });
          if (KEEPS_THE_TASK_TAKEN.has(session)) return { session };
          // Back to `review`, which is where this transition came from — the whole
          // reason the helper takes a status instead of writing `ready` itself.
          return { session, ...rollBackDispatch(id, session, 'review') };
        }
      );
    }
  );
}

// Putting a worker back on a card that is already `in_progress` and whose session
// is gone (T-0333): an interrupted board, a crashed worker, a rebooted machine.
// Until this existed there was no re-dispatch for that card at all — /start
// requires `ready` and /rework requires `review` — and the only way back was to
// append a `### Session questions` section so that the answer-and-restart control
// appeared: a question nobody asked, written into the description this project
// keeps as its audit trail.
//
// IT WRITES NO STATUS, AND THEREFORE HAS NO ROLLBACK. That is the one place where
// this differs from both of its siblings, and it is a consequence rather than an
// omission: /start and /rework each carry a transition, so a dispatch that
// registers no session leaves a card claiming an agent is on it, and
// rollBackDispatch() puts it back (T-0325). Here the card is `in_progress` before
// the call and `in_progress` after it whatever the dispatch answers — there is
// nothing to undo, and a rollback would have to invent a status to undo it TO.
// Do not add one.
//
// A dispatch that started nothing is still said out loud, in `session`; the card
// it leaves behind — `in_progress` with no session on it — is the state it was
// called in, and the one the watchdog already marks (T-0159).
function handleResumeTask(req, res, id) {
  guardWorkerDispatch(
    res,
    id,
    {
      from: 'in_progress',
      conflict: 'task is not in progress, there is no work on it to resume',
      branchLoss:
        'the work to resume is not here, and a resume would start from HEAD without it',
    },
    // The profile is read from the file, never taken from the request — the same
    // rule as every other session start: a command line stays out of a caller's
    // reach. `status` is what the file said a moment ago, which is what this call
    // did not change.
    (task) => {
      Promise.resolve(
        startSessionFor(id, { kind: 'worker', isolate: true, profile: task.profile })
      ).then((session) => json(res, 200, { ok: true, id, status: task.status, session }));
    }
  );
}

// The answers of startSessionFor() that leave the task where the transition put
// it. Everything else — a worktree that could not be created, a setup that
// failed or timed out, a spawn the OS refused, a refusal for the profile or the
// concurrency cap — registered no session for this task, and `in_progress` would
// then claim an agent is on work nobody is doing (T-0325).
//
// The line is registration rather than success, which is why two non-'started'
// answers are here:
//   'disabled'        — no worker command is configured at all. Nothing was
//                       dispatched and nothing failed: the drop is a person
//                       taking the task by hand, which is the board's other
//                       supported way of working, and rolling it back would make
//                       that drop impossible to perform.
//   'already-running' — a session for this task exists (this board's or another
//                       process's). It was not started by this call, but it IS
//                       registered, and putting a task back to `ready` under a
//                       live agent is the state this card exists to prevent.
// Membership, not a list of failures: a reason added later rolls back by default,
// which is the safe side of that mistake.
const KEEPS_THE_TASK_TAKEN = new Set(['started', 'disabled', 'already-running']);

// Undoes a dispatch's transition after one that registered no session, and
// reports what it found: { rolledBack, status } merged into the 200 payload, so
// the answer says the status the card came from rather than the `in_progress`
// the write had set.
//
// `restoreTo` is that status, and it is a parameter rather than the `ready` this
// was born with (T-0329): /start undoes a move out of `ready` and /rework one out
// of `review`, and a helper that knew only the first would put a returned card
// into the column it was refined in — a second helper beside this one would be
// the same mistake made twice.
//
// The condition is load-bearing and is NOT redundant with the write above. The
// backlog lock is taken twice, not held across the session start — it cannot be:
// `git worktree add` and the project's setup command run in between and take
// minutes. In that window a person, a `tools/task.mjs status` call or another
// endpoint may move the card, and their decision outranks this repair: a
// rollback that overwrites it is worse than the state it fixes. So the previous
// status is restored only from exactly the state the transition left, and
// anything else is left alone and said out loud. Do not simplify this into an
// unconditional write.
function rollBackDispatch(id, session, restoreTo) {
  let outcome;
  try {
    outcome = updateBacklog(BACKLOG, (tasks) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) return { rolledBack: false };
      if (task.status !== 'in_progress') return { rolledBack: false, status: task.status };
      task.status = restoreTo;
      return { rolledBack: true, status: task.status };
    });
  } catch (e) {
    // The dispatch has already failed; failing the request on top of that would
    // hide the reason the caller actually needs. The card keeps `in_progress`,
    // which the watchdog reports as a status with no session behind it (T-0159).
    console.error(`${id}: could not put the task back after ${session}: ${e.message}`);
    return { rolledBack: false };
  }
  if (outcome.rolledBack) {
    console.error(`${id}: no session was started (${session}) — the task is back in ${restoreTo}`);
  } else {
    console.error(
      `${id}: no session was started (${session}), and the task is no longer in_progress` +
        `${outcome.status ? ` (${outcome.status})` : ''} — it was left as it is`
    );
  }
  return outcome;
}

// Statuses whose task can still be picked up by a session. Past them a run
// profile describes nothing that will ever run, so the board does not offer it.
const PROFILE_STATUSES = ['backlog', 'open', 'ready', 'in_progress', 'review'];

// Sets the task's run profile, and only that: it changes no status and starts
// nothing (T-0108). The value must be one the user declared in
// BRIEFBOARD_PROFILES — the board offers exactly that list, and the check here is
// the real one; the empty string clears the field back to the default.
function handleProfileTask(req, res, id) {
  readJsonBody(req, (err, body) => {
    try {
      if (err) {
        const status = err.httpStatus || 400;
        json(res, status, { error: err.message }, status === 413 ? { Connection: 'close' } : undefined);
        return;
      }
      if (body.profile !== undefined && body.profile !== null && typeof body.profile !== 'string') {
        throw badRequest('profile must be a string');
      }
      const profile = String(body.profile == null ? '' : body.profile).trim();
      if (profile && !sessionRunner.profiles.includes(profile)) {
        throw badRequest(
          sessionRunner.profiles.length
            ? `profile must be one of: ${sessionRunner.profiles.join(', ')}`
            : 'no run profiles are configured (BRIEFBOARD_PROFILES)'
        );
      }
      applyNarrowWrite(
        res,
        id,
        PROFILE_STATUSES,
        'task is closed, its run profile can no longer be changed',
        (task) => {
          task.profile = profile;
          return { ok: true, id, profile: task.profile };
        }
      );
    } catch (e) {
      failRequest(res, e);
    }
  });
}

// Replaces the task's whole label list, and only that: no status changes and
// nothing is started (T-0279).
//
// Every status is accepted, which is the deliberate difference from /profile
// above: a run profile past `review` describes nothing that will ever run, while
// a label is classification, and a closed task is exactly what someone filters
// by label in a report. An archived task is still refused — applyNarrowWrite
// reads and writes BACKLOG alone, so a task living in doc/backlog-archive.md is
// a 404, and the archive's read-only rule arrives by itself.
function handleLabelsTask(req, res, id) {
  readJsonBody(req, (err, body) => {
    try {
      if (err) {
        const status = err.httpStatus || 400;
        json(res, status, { error: err.message }, status === 413 ? { Connection: 'close' } : undefined);
        return;
      }
      // The list's shape is this endpoint's own: JSON has arrays, so the whole
      // list arrives as one, and a bare string is a caller who sent the CLI's
      // comma-separated argument to the wrong door. Absent means the empty list,
      // as it does on /profile.
      if (body.labels !== undefined && body.labels !== null && !Array.isArray(body.labels)) {
        throw badRequest('labels must be an array of strings');
      }
      // The name rules live in server/parser.js, shared with the parser and with
      // `tools/task.mjs labels`; here they only change shape into a 400.
      let labels;
      try {
        labels = checkLabels(body.labels);
      } catch (e) {
        throw badRequest(e.message);
      }
      applyNarrowWrite(
        res,
        id,
        STATUSES,
        // Unreachable while every status is accepted, and kept because
        // applyNarrowWrite's contract is a status list plus what to say about it.
        'task is in no status whose labels can be changed',
        (task) => {
          task.labels = labels;
          return { ok: true, id, labels: task.labels };
        }
      );
    } catch (e) {
      failRequest(res, e);
    }
  });
}

// ---------- starting a session on a task already in its own status ----------
// Two buttons in the card's dialog, not drops: the task is ALREADY in the status
// whose session this is, so there is no column to move it into and no status to
// set. These are the task endpoints that write nothing to doc/backlog.md at all —
// rewriting the file to change nothing would repaint every open board for nothing,
// and the session's own output is the whole of what either action produces.
//
// They differ only in the status they require and the kind they start, so the
// body lives here once: a second copy is how the two would drift apart on the
// parts that must not differ — reading the profile from the file rather than from
// the request, and refusing an unknown id or a status with nothing to run.
function startSessionOnTask(res, id, { from, kind, conflict }) {
  let task;
  try {
    task = parseBacklog(fs.readFileSync(BACKLOG, 'utf8')).find((t) => t.id === id);
  } catch (e) {
    failRequest(res, e);
    return;
  }
  if (!task) {
    json(res, 404, { error: `${id} not found` });
    return;
  }
  if (task.status !== from) {
    json(res, 409, { error: conflict });
    return;
  }
  // The profile is read from the file, never taken from the request — the same
  // rule as every other session start: a command line stays out of a caller's reach.
  Promise.resolve(startSessionFor(id, { kind, profile: task.profile })).then((session) =>
    json(res, 200, { ok: true, id, status: task.status, session })
  );
}

// The briefing session started by hand (T-0141). The drop into Open starts one
// only for a task nobody has briefed yet; every other case is this button — a
// brief that went stale, a session that died before writing one, a task that came
// back up out of the backlog and needs its brief revisited after all. Which of
// those it is only a human can say, so the action stays offered for any task in
// `open` on a board with BRIEFBOARD_SESSION_CMD configured.
function handleBriefingSession(req, res, id) {
  startSessionOnTask(res, id, {
    from: 'open',
    conflict: 'task is not in open, the briefing session has nothing to brief',
  });
}

// The review session (T-0122). It is not a transition — the worker's own
// `in_progress → review` already made that one. The session is bounded on the
// other side too: it reads the branch's diff and the briefs, runs the tests, and
// appends a "### Review verdict" section. It sets no status at all, `done` least
// of all, and it does not merge (T-0117) — a verdict prepares a human's decision,
// it is not one.
//
// It runs in the project directory, never in a worktree of its own: the diff it
// reads belongs to the branch the WORKER created, and the verdict goes to the
// shared backlog. Isolation would put it on a copy where neither is what it
// looks at.
function handleReviewSession(req, res, id) {
  startSessionOnTask(res, id, {
    from: 'review',
    kind: 'orchestrator',
    conflict: 'task is not in review, the review session has nothing to review',
  });
}

// ---------- closing the task from the board (T-0148) ----------
// The end of the path the board used to break off at. It does the two steps it
// can verify and undo nothing of the one it cannot: the merge stays a human's,
// as decided in T-0117 and not reopened here.
//
// The accept gate fires only on a definite "not merged" — exactly one branch
// matches the task and the checkout's HEAD does not contain it. A task nobody
// branched for (a documentation task, a fix made by hand) has nothing to check
// and is accepted as it always was. With SEVERAL matching branches the board
// says so and still accepts: refusing a human's judgement over an ambiguity the
// board itself could not resolve would be worse than recording it. Removing a
// worktree in that state is refused instead — that one deletes.
function handleDoneTask(req, res, id) {
  gitOps.inspect(id).then((state) => {
    if (state.branch && state.merged === false) {
      json(res, 409, {
        error: `${state.branch} is not merged into ${state.head || 'HEAD'}; merge it first`,
        reason: 'not-merged',
        branch: state.branch,
      });
      return;
    }
    applyNarrowWrite(
      res,
      id,
      ['review'],
      'task is not in review, it cannot be accepted from the UI',
      (task) => {
        task.status = 'done';
        task.closed = nowStamp();
        return { ok: true, id, status: task.status, closed: task.closed };
      }
    );
  }, (e) => failRequest(res, e));
}

// A closed task may live in the archive, and cleaning up after it must not stop
// working the day it is moved there (T-0156).
function findTask(id) {
  const live = parseBacklog(fs.readFileSync(BACKLOG, 'utf8')).find((t) => t.id === id);
  return live || readArchivedTasks(BACKLOG).find((t) => t.id === id) || null;
}

// Statuses whose worktree the board may remove: the work is being judged, or it
// is accepted. In `in_progress` that directory is where the work still IS, and a
// worker the board did not start leaves no registry record to notice — so the
// status is the guard that does not depend on one.
const WORKTREE_REMOVE_STATUSES = ['review', 'done'];

const REMOVE_REFUSAL = {
  'no-git': 'git is not available here',
  'not-a-repo': 'the project is not a git working tree',
  'no-worktree': 'there is no worktree for this task',
  'no-branch': 'no branch for this task, so nothing says the work is safe',
  'ambiguous-branch': 'several branches match this task; the board will not guess which one',
  'not-merged': 'the branch is not merged, and an unmerged worktree is the only copy of its work',
  dirty: 'the worktree has uncommitted changes',
  'remove-failed': 'git refused to remove the worktree',
};

// The board's only write to git, and it is deliberately the narrow one: remove
// this task's worktree, under the rules of T-0099 (server/git.js applies them).
// It never merges, never deletes a branch and never passes `--force`; the
// backlog is not touched at all, so there is no transition and no SSE frame.
function handleRemoveWorktree(req, res, id) {
  let task;
  try {
    task = findTask(id);
  } catch (e) {
    failRequest(res, e);
    return;
  }
  if (!task) {
    json(res, 404, { error: `${id} not found` });
    return;
  }
  if (!WORKTREE_REMOVE_STATUSES.includes(task.status)) {
    json(res, 409, {
      error: `task is in ${task.status}; the board removes a worktree only in ${WORKTREE_REMOVE_STATUSES.join(' or ')}`,
      reason: 'bad-status',
    });
    return;
  }
  const session = sessionRunner.get(id);
  if (session && session.status === 'running') {
    json(res, 409, { error: 'an agent session is running in that worktree', reason: 'session-running' });
    return;
  }
  gitOps.removeWorktree(id).then((result) => {
    if (result.ok) {
      json(res, 200, { ok: true, id, worktree: result.worktree });
      return;
    }
    json(res, result.reason === 'no-worktree' ? 404 : 409, {
      error: REMOVE_REFUSAL[result.reason] || 'the worktree was not removed',
      reason: result.reason,
      detail: result.detail || '',
    });
  }, (e) => failRequest(res, e));
}

// Adding a key here is the only way to add an action — literally, since the
// route below is built from these keys. It used to be a second list, and the
// header comment of this file a third; the header had gone three actions stale
// (T-0229) and nothing noticed for as long as it took a human to read it.
//
// `in_progress → review` by hand is deliberately NOT one of them (T-0148). The
// transition asserts "this work is finished and ready to be judged", and only
// whoever read the branch can assert it; a button would let a dead worker's task
// be pushed to review with nothing behind it, which is exactly the state the
// gate above then has to catch. The case it would serve — a worker that died
// before writing its status (T-0118) — is visible on the card as a session that
// ended, and its honest repairs are restarting the session or one CLI command.
const TASK_ACTIONS = {
  cancel: handleCancelTask,
  open: handleOpenTask,
  backlog: handleReturnToBacklog,
  briefing: handleBriefingSession,
  start: handleStartTask,
  rework: handleReworkTask,
  resume: handleResumeTask,
  answer: handleAnswerTask,
  profile: handleProfileTask,
  labels: handleLabelsTask,
  review: handleReviewSession,
  done: handleDoneTask,
  'remove-worktree': handleRemoveWorktree,
};

// The action is part of the path and each handler hard-codes the one edit it
// performs, so there is deliberately no generic "set any status" endpoint
// (agents/PROTOCOL.md §3.6). The id pattern is the strict one every task route
// uses; the actions are spelled out rather than left to `\w+` so an unknown one
// is a 404 from the router, before any handler lookup.
const TASK_ACTION_RE = new RegExp(
  `^/api/task/(T-\\d{4})/(${Object.keys(TASK_ACTIONS).join('|')})$`
);

// The actions that read a JSON body, and therefore have a Content-Type to check.
const BODY_ACTIONS = ['answer', 'profile', 'labels'];

function badRequest(message) {
  const e = new Error(message);
  e.httpStatus = 400;
  return e;
}

// Calls cb(err, value) exactly once; `err.httpStatus` carries the status to
// answer with. Past the cap nothing more is buffered and the rest of the stream
// is drained, so a client streaming gigabytes costs a constant amount of memory.
function readJsonBody(req, cb) {
  const chunks = [];
  let size = 0;
  let settled = false;
  const settle = (err, value) => {
    if (settled) return;
    settled = true;
    cb(err, value);
  };
  req.on('data', (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      chunks.length = 0;
      const e = new Error('request body too large');
      e.httpStatus = 413;
      settle(e);
      req.resume(); // drain the rest without buffering it
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', (err) => settle(err));
  req.on('end', () => {
    if (settled) return;
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) {
      settle(null, {}); // no fields; validation then reports what is missing
      return;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      settle(badRequest('malformed JSON body'));
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      settle(badRequest('body must be a JSON object'));
      return;
    }
    settle(null, value);
  });
}

// The single set of rules for a piece of description text, applied to whatever
// field carries it: `description` when a task is created, `text` when an answer
// is appended. Structure-lookalike lines are deliberately NOT rejected -
// serializeBacklog() escapes them (T-0080), and a second rule refusing them
// would contradict the first; a markdown heading in an answer is ordinary text.
// Throws an Error with httpStatus 400.
function validateDescriptionText(value, field) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw badRequest(`${field} must be a string`);
  }
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  if (text.length > MAX_DESCRIPTION_LEN) {
    throw badRequest(`${field} must be at most ${MAX_DESCRIPTION_LEN} characters`);
  }
  return text;
}

// Beyond type/length rules, one check guards the backlog file format itself: a
// newline in the title would split the "## T-NNNN · ..." header line and corrupt
// every task after it.
// Throws an Error with httpStatus 400 on the first violation.
function validateNewTask(body) {
  const bad = (message) => {
    throw badRequest(message);
  };
  if (body.title !== undefined && typeof body.title !== 'string') bad('title must be a string');
  const title = String(body.title == null ? '' : body.title).trim();
  if (!title) bad('title is required');
  if (title.length > MAX_TITLE_LEN) bad(`title must be at most ${MAX_TITLE_LEN} characters`);
  if (/[\r\n]/.test(title)) bad('title must not contain line breaks');

  const type = body.type === undefined || body.type === null ? 'feature' : body.type;
  if (!TASK_TYPES.includes(type)) bad(`type must be one of: ${TASK_TYPES.join(', ')}`);

  const priority = body.priority === undefined || body.priority === null ? 'Medium' : body.priority;
  if (!PRIORITIES.includes(priority)) bad(`priority must be one of: ${PRIORITIES.join(', ')}`);

  const description = validateDescriptionText(body.description, 'description');

  // The list's shape is the one POST /api/task/:id/labels already takes: JSON
  // has arrays, so the whole list arrives as one, and a bare string is a caller
  // who sent the CLI's comma-separated argument to the wrong door. Absent, null
  // and [] all mean "no labels" - a task without one is not an error anywhere
  // (T-0280), and this endpoint does not make it one (T-0282).
  if (body.labels !== undefined && body.labels !== null && !Array.isArray(body.labels)) {
    bad('labels must be an array of strings');
  }
  // The name rules live in server/parser.js, shared with the parser and with
  // `tools/task.mjs add --labels`; here they only change shape into a 400, and
  // they run before addTask() so a refused list writes nothing.
  let labels;
  try {
    labels = checkLabels(body.labels);
  } catch (e) {
    bad(e.message);
  }
  return { title, type, priority, description, labels };
}

// The task always lands in `backlog`; this endpoint can set no other status
// (agents/PROTOCOL.md §3.6). The write goes through the same addTask() helper
// `tools/task.mjs add` uses, so id allocation, file format and the
// cross-process lock are shared with the CLI.
function handleCreateTask(req, res) {
  readJsonBody(req, (err, body) => {
    try {
      if (err) {
        const status = err.httpStatus || 400;
        // A 413 is answered while the client may still be sending; close the
        // connection afterwards instead of trying to keep it alive mid-body.
        json(res, status, { error: err.message }, status === 413 ? { Connection: 'close' } : undefined);
        return;
      }
      const fields = validateNewTask(body);
      const id = addTask(BACKLOG, fields);
      json(res, 201, { ok: true, id });
    } catch (e) {
      failRequest(res, e);
    }
  });
}

// ---------- answering a session's questions (T-0085) ----------

// Restarting resumes the session that asked, and which one that is follows from
// the status: a question from `in_progress` is a worker's (T-0101), one from
// `review` is the review session's (T-0122), and running the briefing kind in
// either place would re-brief a task long past refinement — in the shared
// checkout, where a worker must never write.
function restartOptions(status, profile) {
  if (status === 'in_progress') return { kind: 'worker', isolate: true, profile };
  if (status === 'review') return { kind: 'orchestrator', profile };
  return { profile };
}

// The only endpoint that writes description *text*, and it only ever APPENDS,
// under the "### Answers" heading. A description is the shared carrier of
// refinement decisions, review comments and worker reports written by different
// agents at different times; letting a browser replace it wholesale would be a
// way to lose all of that to one bad request. Editing what is already written is
// not offered here at all - it would need its own answer to versioning.
//
// The status is not touched: answering is not a transition. The task stays where
// it is and it is the restarted session that moves it on. Which statuses accept
// an answer is ANSWER_STATUSES — the same list awaitsAnswer() raises the marker
// from, so there can be no card marked "needs answer" that has nothing to answer.
function handleAnswerTask(req, res, id) {
  readJsonBody(req, (err, body) => {
    try {
      if (err) {
        const status = err.httpStatus || 400;
        json(res, status, { error: err.message }, status === 413 ? { Connection: 'close' } : undefined);
        return;
      }
      const text = validateDescriptionText(body.text, 'text');
      if (!text.trim()) throw badRequest('text is required');
      if (body.restart !== undefined && typeof body.restart !== 'boolean') {
        throw badRequest('restart must be a boolean');
      }
      applyNarrowWrite(
        res,
        id,
        ANSWER_STATUSES,
        `task is not in ${ANSWER_STATUSES.join(' or ')}, it is not waiting for an answer`,
        (task) => {
          // The status alone is not enough: a task without the questions section
          // means nobody asked anything, and there is nothing to answer.
          if (!awaitsAnswer(task)) {
            const e = new Error(`${id} has no ${SESSION_QUESTIONS_HEADING} section to answer`);
            e.httpStatus = 409;
            throw e;
          }
          task.description = appendDescriptionSection(task.description, ANSWERS_SECTION, text);
          return { ok: true, id, status: task.status, profile: task.profile };
        },
        // Not transactional with the write, like every other `after`: the answer
        // is saved and valuable on its own, so a session that will not start is
        // reported in the payload rather than undoing it.
        body.restart === true
          ? async (written) => ({
              session: await startSessionFor(id, restartOptions(written.status, written.profile)),
            })
          : null
      );
    } catch (e) {
      failRequest(res, e);
    }
  });
}

// ---------- server ----------
const handleRequest = (req, res) => {
  // Before routing, and on reads as well as writes: a rebound page reading the
  // backlog, a brief or a session log leaks the project just as surely as a
  // write changes it (T-0226).
  if (!hostAllowed(req)) {
    // The rejected name is quoted back so a proxy is diagnosable, truncated
    // because a header this side has not accepted may be kilobytes long.
    const seen = String(req.headers.host || '').slice(0, 80) || '(absent)';
    json(res, 403, {
      error: `Host ${seen} is not this board; set BRIEFBOARD_ALLOWED_HOSTS to reach it through a proxy`,
    });
    return;
  }

  // req.url is not guaranteed to be a parseable URL: "GET // HTTP/1.1" yields
  // "//", which the WHATWG parser rejects with a TypeError. Uncaught inside
  // this callback that would take the process down for every connected client.
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    json(res, 400, { error: 'malformed request URL' });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const ui = readUiHtml();
    const etag = `W/"${ui.mtimeMs}-${ui.body.length}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: etag });
    res.end(ui.body);
    return;
  }

  if (url.pathname === '/api/board') {
    let stats;
    try {
      stats = boardStats();
    } catch {
      json(res, 200, missingBacklogBody());
      return;
    }
    // Derived from mtime+size alone, so a matching If-None-Match short-circuits
    // to 304 without reading or parsing the files.
    const etag = boardEtag(stats);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    let body;
    try {
      body = refreshBoard(stats).json;
    } catch {
      // File vanished between statSync and readFileSync (or became unreadable).
      json(res, 200, missingBacklogBody());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag });
    res.end(body);
    return;
  }

  // Deliberately uncached, and deliberately not part of /api/board: session
  // state changes while doc/backlog.md does not, so it must not sit behind that
  // response's mtime+size ETag.
  if (url.pathname === '/api/sessions') {
    json(
      res,
      200,
      // The per-task sums ride along with the records they are made of (T-0116):
      // they change on exactly the same events, and a second endpoint would only
      // give the board a second way to be out of date with itself. The
      // watchdog's findings travel here for that same reason (T-0159) — they are
      // made of these records and of git, and both move while doc/backlog.md
      // does not.
      { sessions: sessionRunner.list(), costs: sessionRunner.costs(), watchdog: watchdog.state() },
      { 'Cache-Control': 'no-store' }
    );
    return;
  }

  // Asked when a card that can still be closed is opened or rechecked, never on
  // the board's own repaint: git state does not change when the backlog does,
  // and a check per SSE frame would run git for every open tab (T-0148).
  const gitMatch = url.pathname.match(GIT_STATE_RE);
  if (gitMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    gitOps.inspect(gitMatch[1]).then(
      (state) => json(res, 200, { id: gitMatch[1], ...state }, { 'Cache-Control': 'no-store' }),
      (e) => failRequest(res, e)
    );
    return;
  }

  const sessionMatch = url.pathname.match(SESSION_ACTION_RE);
  if (sessionMatch) {
    const id = sessionMatch[1];
    if (sessionMatch[2] === 'log') {
      const tail = sessionRunner.readLogTail(id);
      if (!tail.ok) {
        const error =
          tail.reason === 'no-session'
            ? `no agent session is known for ${id}`
            : `the session log for ${id} is no longer on disk`;
        json(res, 404, { error }, { 'Cache-Control': 'no-store' });
        return;
      }
      // text/plain, never HTML: the bytes below were written by a process
      // briefboard does not control.
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Log-Total-Bytes': String(tail.totalBytes),
        'X-Log-Truncated': tail.truncated ? '1' : '0',
      });
      res.end(tail.text);
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'cross-origin request rejected' });
      return;
    }
    const stopped = sessionRunner.stopSession(id);
    if (stopped.stopped) {
      json(res, 200, { ok: true, id });
      return;
    }
    if (stopped.reason === 'no-session') {
      json(res, 404, { error: `no agent session is known for ${id}` });
      return;
    }
    json(res, 409, { error: `the agent session for ${id} is not running` });
    return;
  }

  if (url.pathname.startsWith('/api/brief/')) {
    // decodeURIComponent throws URIError on malformed percent-encoding (a lone
    // "%", "%zz", a truncated UTF-8 escape). Unguarded, that is an
    // unauthenticated one-request DoS: it crashes the whole server.
    let id;
    try {
      id = decodeURIComponent(url.pathname.slice('/api/brief/'.length));
    } catch (e) {
      if (e instanceof URIError) {
        json(res, 400, { error: 'malformed id' });
        return;
      }
      throw e;
    }
    const file = findBriefFile(BRIEF_DIR, id);
    if (!file) {
      json(res, 404, { error: `Brief ${id} not found in doc/brief/` });
      return;
    }
    json(res, 200, { id, file: path.basename(file), markdown: fs.readFileSync(file, 'utf8') });
    return;
  }

  if (url.pathname === '/api/task') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    // Before reading a single byte of the body.
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'cross-origin request rejected' });
      return;
    }
    if (!jsonContentType(res, req)) return;
    handleCreateTask(req, res);
    return;
  }

  const actionMatch = url.pathname.match(TASK_ACTION_RE);
  if (actionMatch) {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    // Before touching the file (drive-by CSRF).
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'cross-origin request rejected' });
      return;
    }
    // Only the BODY_ACTIONS carry a body; the others take none, and
    // demanding a Content-Type from a request that has nothing to declare would
    // break the callers they already have.
    if (BODY_ACTIONS.includes(actionMatch[2]) && !jsonContentType(res, req)) return;
    TASK_ACTIONS[actionMatch[2]](req, res, actionMatch[1]);
    return;
  }

  // The board's own exit button (T-0082). Two guards, not one: sameOrigin()
  // stops a page in the user's browser, and the loopback check stops the network
  // — under a public bind (HOST/AGENTBOARD_HOST) a curl from any machine would
  // otherwise kill someone else's board.
  if (url.pathname === '/api/shutdown') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'cross-origin request rejected' });
      return;
    }
    if (!isLoopbackRemote(req)) {
      json(res, 403, { error: 'shutdown is only accepted from a loopback address' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
    // Ordering matters: leaving before the answer is on the wire shows the
    // caller a dropped connection instead of its 200, and the open tabs would
    // then sit in "reconnecting…" rather than saying the board was stopped.
    res.end(JSON.stringify({ ok: true }), () => {
      broadcastShutdown();
      stopBoard(0, true);
    });
    return;
  }

  if (url.pathname === '/events') {
    if (clients.size >= MAX_SSE_CLIENTS) {
      json(res, 503, { error: 'too many SSE clients' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end('not found');
};

// A public bind holds localhost with extra sockets of its own (T-0133), and one
// of them answering differently from the main socket would be a worse bug than
// the one it prevents — so every listening socket is built here.
function createBoardServer() {
  const board = http.createServer(handleRequest);
  // Bad HTTP framing is rejected by Node's parser before the request handler
  // runs, and by default it just destroys the socket. Log it so a flood of
  // garbage requests is at least visible.
  //
  // The one thing that reaches this handler and is NOT garbage: a socket the
  // peer opened and dropped, which Node reports here as `read ECONNRESET` on an
  // already-destroyed socket (T-0248). Chrome's speculative preconnect does it
  // on an ordinary visit, so the healthy log of a board someone merely looked at
  // carried two of these and nothing else — alarming the reader and diluting the
  // very signal the line exists to raise. Both halves are checked, so an
  // ECONNRESET on a socket still worth answering would still be reported.
  board.on('clientError', (err, socket) => {
    const dropped = err.code === 'ECONNRESET' && !(socket && socket.writable);
    if (!dropped) console.error(`clientError: ${err.message}`);
    if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  // Slowloris hardening. These bound how long a request may take to ARRIVE, so
  // they never cut off an already-accepted long-lived SSE response.
  //
  // Neither is enforced the moment it expires: Node checks the open connections
  // on server.connectionsCheckingInterval (30s by default), so a client that
  // sends its headers and then stalls is held for 10-40s, not 10. Measured on a
  // raw socket that stalls forever (T-0190, twice): the board let go at 29873ms
  // and at 27697ms, a stock http.Server carrying the same two numbers at
  // 30014ms and 32319ms. The board is exactly stock here; neither is the 10s the
  // constant reads as.
  //
  // The interval is deliberately left alone. What these buy is that a stalled
  // connection cannot live forever, and that holds at 30s; sweeping a loopback
  // board's handful of sockets six times as often would tighten a number nothing
  // depends on.
  board.headersTimeout = 10_000;
  board.requestTimeout = 20_000;
  return board;
}

const server = createBoardServer();

// Defence in depth over the point fixes above: an unanticipated throw in the
// synchronous request handler would otherwise kill the process — and every
// connected client — over a single bad request.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (request handler kept running):', err);
});

// How long the exit-button path gives open sockets to go away. A board that was
// asked to stop and did not is a worse outcome than a socket closed under a
// client, so a keep-alive connection that never drains cannot hold the process.
const SHUTDOWN_CLOSE_MS = 1000;

// The single exit path — Ctrl+C, SIGTERM and POST /api/shutdown all end here, so
// no agent session outlives the board however it was stopped. Non-detached
// children are already killed with this process on Windows (libuv puts them in a
// job object — verified), but on POSIX a killed parent leaves them running, so
// kill them explicitly.
//
// `drain` waits for the listener to close, up to SHUTDOWN_CLOSE_MS; a signal
// does not wait at all, because the sessions are dead and Ctrl+C should end the
// process now.
//
// Every socket is closed, not just the main one: a public bind also holds
// localhost (T-0133), and a listener left open keeps the port taken after the
// process is gone — which reads as a fresh "port in use" bug.
let listeners = [server];
let shuttingDown = false;
function stopBoard(code, drain) {
  if (shuttingDown) return;
  shuttingDown = true;
  watchdog.stop();
  // Before anything that can take time: from here on this board is going, and a
  // trace outliving the decision is the one thing that would make a reader
  // announce a board nobody can reach (T-0186).
  removeBoardTrace(PROJECT);
  sessionRunner.shutdown();
  if (!drain) {
    for (const socket of listeners) socket.close();
    process.exit(code);
  }
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    process.exit(code);
  };
  setTimeout(leave, SHUTDOWN_CLOSE_MS).unref();
  let pending = listeners.length;
  for (const socket of listeners) {
    socket.close(() => {
      if (--pending === 0) leave();
    });
  }
}
process.on('SIGINT', () => stopBoard(130, false));
process.on('SIGTERM', () => stopBoard(0, false));

watchDir(DOC_DIR, onDocEvent);
ensureBriefWatch();

// Read the backlog once before serving, so the first change already has a
// previous state to be diffed against and the first page load hits a warm cache.
try {
  refreshBoard(boardStats());
} catch {
  /* no backlog yet; the first request or event establishes the baseline */
}

// The first look, before anyone opens a tab: the discrepancies worth catching
// were created while the board was NOT running (T-0159), so a board that only
// checked on the next event would stay quiet about exactly those.
watchdog.schedule();

listenWithFallback(server, HOST, PORTS, { createServer: createBoardServer }).then(
  (addr) => {
    listeners = [server, ...addr.loopbackServers];
    // The mark other processes read (T-0186), written before the first line of
    // the banner: from here the board is reachable, and until the file is there
    // nothing outside can tell. Swept first, so a board killed hard leaves at
    // most its own dead file behind.
    let trace = '';
    try {
      sweepBoardTraces(PROJECT);
      trace = writeBoardTrace(PROJECT, {
        port: addr.port,
        host: addr.address,
        installRoot: ROOT,
      }).file;
    } catch (e) {
      // Said out loud rather than swallowed: a board with no trace is invisible
      // to `task.mjs archive` and to anything else that asks.
      console.warn(`WARNING: could not write the board trace: ${e.message}`);
    }
    // Every port here is the one actually bound: with the fallback in play the
    // requested port is routinely not the one serving.
    console.log(`briefboard: http://${HOST}:${addr.port}`);
    console.log(`project:    ${PROJECT_NAME}`);
    console.log(`bound:      ${addr.address}:${addr.port}`);
    // The directory, not one file in it (T-0187): the watcher is on doc/ as a
    // whole, so the archive fires it exactly like the backlog does, and
    // doc/brief/ has a watcher of its own. Naming backlog.md alone told a reader
    // the archive was not followed — the wrong conclusion, and reached at
    // exactly the moment they had just archived something.
    console.log(`watching:   ${DOC_DIR} (backlog.md, backlog-archive.md, brief/)`);
    console.log(`trace:      ${trace || 'none (see the warning above)'}`);
    console.log(
      sessionRunner.enabled
        ? `sessions:   on (max ${sessionRunner.maxSessions}, logs in ${sessionRunner.logDir})`
        : `sessions:   off (${sessionRunner.disabledReason})`
    );
    console.log(
      sessionRunner.workerEnabled
        ? 'worker:     on (isolated in .briefboard/worktrees/T-NNNN)'
        : `worker:     off (${sessionRunner.workerDisabledReason})`
    );
    console.log(
      sessionRunner.orchestratorEnabled
        ? 'review:     on (in the project directory, writes a verdict, sets no status)'
        : `review:     off (${sessionRunner.orchestratorDisabledReason})`
    );
    console.log(
      watchdog.enabled
        ? `watchdog:   on (git asked at most every ${watchdog.intervalMs}ms, three calls)`
        : `watchdog:   off (${WATCHDOG_INTERVAL_ENV}=off)`
    );
    if (!isLoopbackHost(HOST)) {
      console.warn(
        `WARNING: bound to non-loopback host ${HOST} — the board and its writing ` +
          'endpoints (create a task, cancel it, move it to open, start it, answer its ' +
          'session) are exposed to the network with no authentication, and any Host ' +
          'header is accepted, because the names this machine answers to are not ' +
          'knowable here.'
      );
    }
    // Only an explicitly requested port gets here shadowed; a scan skips such a
    // candidate instead (server/listen.js).
    if (addr.loopbackShadowedBy.length) {
      console.warn(loopbackShadowMessage(addr.port, addr.loopbackShadowedBy, addr.loopbackHeldOn));
    }
  },
  (err) => {
    console.error(`briefboard: cannot listen on ${HOST}: ${err.message}`);
    if (err.code === 'EADDRINUSE' && PORT_EXPLICIT) {
      console.error('PORT was set explicitly, so the board does not move to another port.');
    }
    process.exit(1);
  }
);
