'use strict';

/**
 * Session runner (T-0076) — starts one agent session per task dropped onto a
 * board column: the briefing session for Open, the worker session for In
 * Progress (T-0084), and the review session on a task already in Review
 * (T-0122). They differ only in their configured command template and in whether
 * the session is isolated in a worktree; everything else — the registry, the
 * concurrency cap, the logs — is shared, so the cap counts every agent the board
 * has running.
 *
 * This is the only place where an HTTP request can start a process, so the
 * guards are deliberate: the command comes only from the configuration (the
 * request contributes the task id and nothing else), the template is split into
 * argv here and spawned without a shell, {id} and {profile} are substituted after that
 * split, and the whole feature refuses to work off loopback — a
 * network-reachable endpoint that runs a configured command is remote code
 * execution.
 */

const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite, parseBacklog, hasSessionQuestions, countReviewVerdicts } = require('./parser');
// The worktree layout and the branch prefix come from server/git.js and are not
// restated here (T-0180): the runner writes that layout, the board reads it back
// to find a session's worktree, and two copies that drifted apart would send the
// reader into a directory the runner never created — the close-loop card would
// then report "nothing to clean up", which is what a healthy task looks like.
// The direction is the one T-0171 chose for runGit: git.js knows nothing of the
// session registry, so it can be required from here and never the other way round.
const { runGit, WORKTREE_DIR_PARTS, BRANCH_PREFIX } = require('./git');

const DEFAULT_MAX_SESSIONS = 4;
// How many finished sessions the registry keeps; the oldest leaves when the
// twenty-first arrives. Injectable per runner (`maxFinished`) for the same reason
// `setupTimeoutMs` is: proving the eviction ORDER needs sessions that finish one
// after another, and at 20 that is 25 real process starts for a piece of
// bookkeeping — 21 s idle, 83 s on a loaded machine, past the suite's own per-test
// backstop (measured 2026-08-16, T-0185). Nothing configures it outside a test.
const MAX_FINISHED = 20;
// Finished sessions kept for the per-task sum (T-0116). Ten times the record cap
// because an entry here is a tenth of a record — when it ran, how it ended, what
// it spent — and a sum that reaches back only twenty sessions answers "what did
// this task cost" for the last few tasks and no others. Past it entries are
// evicted, and the eviction is counted per task rather than hidden: a sum
// missing half its sessions must say so.
const MAX_HISTORY = MAX_FINISHED * 10;
// A session writes for as long as it runs, and the board only ever needs the
// end of that: shipping a multi-megabyte log into a browser to show its last
// screenful is the cost this cap avoids.
const LOG_TAIL_BYTES = 200 * 1024;
const TASK_ID_RE = /^T-\d{4}$/;
const PLACEHOLDER = '{id}';
const PROFILE_PLACEHOLDER = '{profile}';
// Outside doc/ on purpose: the server watches doc/ and broadcasts an SSE
// 'changed' on every event there, so a log inside it would turn every line an
// agent prints into a board repaint for every connected client.
const LOG_DIR_PARTS = ['.briefboard', 'sessions'];
// Runtime state, so it lives next to the logs rather than in doc/backlog.md:
// the backlog is a git-tracked document about tasks, and writing a session's
// every start and stop into it would fill the history with process noise and
// repaint the board for every client through the server's fs.watch (T-0102).
const BACKLOG_PARTS = ['doc', 'backlog.md'];
const REGISTRY_FILE = 'registry.json';
const REGISTRY_VERSION = 1;
// The documented name of the review session's variable (T-0305). The session
// KIND stays `orchestrator`: it is written into the registry, into log file
// names and into what `tools/task.mjs sessions` prints, so renaming it would
// change records that already exist on users' disks. Renaming a variable does
// not.
const REVIEW_ENV = 'BRIEFBOARD_REVIEW_CMD';
// The name that variable carried when the review session was added (T-0122),
// kept working and deliberately not deprecated: it is a supported alias, and
// nothing warns about it. What it got renamed for is that "orchestrator" reads
// as a claim about the agent above the worker, which collides with the
// orchestrator of any project that embeds briefboard underneath itself.
const LEGACY_REVIEW_ENV = 'BRIEFBOARD_ORCHESTRATOR_CMD';
const ENV_NAMES = {
  briefing: 'BRIEFBOARD_SESSION_CMD',
  worker: 'BRIEFBOARD_WORKER_CMD',
  orchestrator: REVIEW_ENV,
};

/**
 * Where the review session's command comes from, and the ONE place the
 * precedence between the two variables is decided (T-0305). Returns the command
 * together with the variable it actually came from: a hint naming the documented
 * variable to someone who configured the legacy one sends them searching their
 * setup for a name that is not in it.
 *
 * A blank value counts as unset, which is what every other BRIEFBOARD_*_CMD
 * already does — compileTemplate disables a kind on any blank template — so
 * clearing BRIEFBOARD_REVIEW_CMD falls back to the legacy variable instead of
 * turning the session off while the legacy one is still set.
 */
function resolveReviewCommand(env = process.env) {
  const configured = [REVIEW_ENV, LEGACY_REVIEW_ENV].find((name) => (env[name] || '').trim());
  // With neither set the documented name is the one to report: nothing is
  // configured, and that is the variable whoever reads it should be setting.
  return { command: configured ? env[configured] : '', envName: configured || REVIEW_ENV };
}
const PROFILES_ENV = 'BRIEFBOARD_PROFILES';
const TOKENS_ENV = 'BRIEFBOARD_TOKENS_RE';
const TOKENS_MODE_ENV = 'BRIEFBOARD_TOKENS_MODE';
const TOKENS_MODES = ['sum', 'last'];
const DEFAULT_TOKENS_MODE = 'sum';
const SETUP_ENV = 'BRIEFBOARD_SETUP_CMD';
// A worktree is a checkout, not an installation: it has no node_modules, no
// .dart_tool, no venv, so the tests a brief asks for fail there for reasons that
// have nothing to do with the task (T-0150). The command that fixes that is the
// user's, because briefboard does not know the stack and must not guess it.
//
// Ten minutes. The installs this is for take seconds to a few minutes (`npm ci`
// cold, `flutter pub get`, `bundle install`); the case the limit exists for is
// not a slow install but one that never ends — a network-less resolver retrying,
// or a tool waiting on a prompt nobody can answer, since the session is headless.
// Ten minutes is far above the honest work and still bounded, and a board hung
// on `pub get` with no network is worse than a refusal that says so.
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
// `git worktree add` gets its own limit instead of the read-sized default
// server/git.js applies (T-0171): it writes out a whole checkout, so unlike
// every other git call the board makes it scales with the size of the
// repository — measured 986ms for the 238 tracked files here, and a six-figure
// tree on a slow disk is minutes rather than seconds. Two minutes is far above
// that and still a bound, and the case a bound exists for is not a slow checkout
// but one that never ends: a post-checkout hook waiting on input nobody can
// give it, since the session is headless.
const WORKTREE_ADD_TIMEOUT_MS = 2 * 60 * 1000;
// Next to the worktree rather than inside it: anything written inside would show
// up in the user's `git status` on their task branch.
const SETUP_STAMP_SUFFIX = '.setup.json';
// The variable tools/task.mjs reads to find the project whose doc/ it edits.
const ROOT_ENV = 'AGENTBOARD_ROOT';
// POSIX only: a detached child leads its own process group, and that group is
// the only handle there is on the processes it starts (see killChild). On
// Windows it stays false so that the session's own process goes down with the
// board: libuv puts a non-detached child into a job object that dies with us.
//
// That job takes the LAUNCHER and nothing under it. libuv creates it with
// JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, so the launcher's own children are never
// in it. Measured here on Windows 11 with `cmd /c node worker.js`, the shape a
// session really has: a board killed with `taskkill /f` left the launcher dead
// and the worker alive, still appending five seconds later. The comment that
// used to stand here claimed the opposite, and two workers reasoned from it.
//
// So "no agent is left running" holds on the ORDERLY path only — shutdown() is
// what ends the tree (killChild). A board killed hard, crashed, or cut off with
// the machine still leaves its agent running.
const SPAWN_DETACHED = process.platform !== 'win32';
const TREE_KILLER = 'taskkill';
// The two bounds on shutdown() (T-0173). A session's log closes only when every
// process holding its stdout has let go, so a descendant that survived the kill
// — not the session — is what the wait is then waiting for: measured 20s, the
// orphan's own lifetime.
//
// The grace before the harder signal is what a tree that IS dying needs: on
// Windows the first kill is an external `taskkill /t /f` process, so a spawn, a
// tree walk and the reaping all have to fit in it — measured 608-991ms over five
// runs here, so twice the slowest of them. A loaded machine overruns that, and
// since T-0192 that costs one repeated tree kill instead of the tree: the bound
// the shutdown really keeps is SHUTDOWN_RELEASE_MS below.
const SHUTDOWN_KILL_MS = 2_000;
// And the bound on the whole wait, after which the board closes the logs itself.
// Larger than the 1s server.js gives open sockets to drain, because a process
// tree takes longer to die than a socket takes to close, and small enough that
// the caller this promise exists for — a test about to delete the project
// directory — fails fast instead of hanging (T-0124).
const SHUTDOWN_RELEASE_MS = 5_000;

/**
 * Reads the profile list the USER declared (BRIEFBOARD_PROFILES, a comma-separated
 * list) into { values, default }. The first entry is the default — the one a task
 * with no profile of its own runs with — so an empty `{profile}` can never leave a
 * dangling `--mode` in the command.
 *
 * briefboard does not know what a profile IS: not a model, not a reasoning level,
 * not another agent. It checks membership in this list and substitutes the string.
 * Every value with a meaning belongs to whoever wrote the command template.
 *
 * Line breaks disqualify a value: it is written back into a one-line
 * `- profile:` field of doc/backlog.md.
 */
function parseProfiles(raw) {
  const source = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(',');
  const values = [];
  for (const entry of source) {
    const value = String(entry == null ? '' : entry).trim();
    if (!value || /[\r\n]/.test(value) || values.includes(value)) continue;
    values.push(value);
  }
  return { values, default: values[0] || '' };
}

/**
 * Compiles the token extractor the USER declared (BRIEFBOARD_TOKENS_RE): a
 * regular expression whose first capturing group catches a number in the
 * session's own log.
 *
 * This is the whole of what briefboard knows about an agent's output, and it is
 * knowledge the user supplies, not knowledge the code has. Reading `usage` out
 * of some CLI's JSON would be the line we hold from T-0108 and T-0115: the board
 * does not know which agent is running and must not chase another project's
 * changes to its output format.
 *
 * Returns null when nothing is declared — the ordinary case, in which the board
 * reports time and says nothing about tokens — and also when the declaration is
 * unusable, which is reported and then left off rather than guessed at.
 */
function compileTokenPattern(raw, logger = console) {
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (!source) return null;
  let re;
  try {
    // Always global: both modes need every match — the sum to add them up, the
    // last one to know which is last.
    re = new RegExp(source, 'g');
  } catch (e) {
    logger.error(`${TOKENS_ENV} is not a regular expression (${e.message}) — token counting is off.`);
    return null;
  }
  // The whole match is not a fallback: it is usually a whole line, and a line is
  // not a number.
  if (new RegExp(source + '|').exec('').length - 1 < 1) {
    logger.error(
      `${TOKENS_ENV} has no capturing group, so there is no number to read — token ` +
        `counting is off. Put the number in a group, e.g. ${TOKENS_ENV}='tokens: (\\d+)'.`
    );
    return null;
  }
  return re;
}

/**
 * Reads the mode the USER declared (BRIEFBOARD_TOKENS_MODE): `sum` adds every
 * match up, `last` takes the number of the last one. Unset is `sum`, which is
 * what the board has always done.
 *
 * Both are right for someone, and the log cannot tell them apart: an agent
 * printing 36 and then 41 per turn means 77, one printing a running total means
 * 41, and the two logs look identical. So the user declares it, as with the
 * expression itself (T-0116) and with profiles (T-0108).
 *
 * A value that is neither returns null — the caller then counts nothing. Falling
 * back to `sum` would be the one outcome that must not happen silently: it is
 * the doubling this mode exists to end, and a wrong figure looks exactly like a
 * right one.
 */
function parseTokensMode(raw, logger = console) {
  const value = (typeof raw === 'string' ? raw : '').trim().toLowerCase();
  if (!value) return DEFAULT_TOKENS_MODE;
  if (TOKENS_MODES.includes(value)) return value;
  logger.error(
    `${TOKENS_MODE_ENV} is '${value}', which is neither ${TOKENS_MODES.join(' nor ')} — token ` +
      `counting is off. Declare ${TOKENS_MODE_ENV}=sum to add every match up, or ` +
      `${TOKENS_MODE_ENV}=last when the agent prints a running total.`
  );
  return null;
}

/**
 * Reads what the declared expression finds in one session's log, in the declared
 * mode: every match added up (`sum`), or the number of the last match (`last`).
 * Digit separators are dropped so "1,234" reads as a number; a group that is not
 * one is skipped, in `last` mode too — the last match that holds a number wins,
 * not the last match.
 *
 * No match gives null, never 0: zero tokens is a statement about the session,
 * and a log we could not read a number out of does not support it.
 */
function extractTokens(text, re, mode = DEFAULT_TOKENS_MODE) {
  if (!re || !mode) return null;
  let total = null;
  for (const match of String(text).matchAll(re)) {
    const value = Number(String(match[1] == null ? '' : match[1]).replace(/[\s,_]/g, ''));
    if (!Number.isFinite(value) || value < 0) continue;
    total = mode === 'last' ? value : (total || 0) + value;
  }
  return total;
}

// Measured on Windows 11 / Node 24: since the CVE-2024-27980 hardening a .cmd or
// .bat file cannot be spawned without a shell at all — `spawn('npm')` fails
// ENOENT, `spawn('npm.cmd')` throws EINVAL synchronously. Agent CLIs installed
// globally through npm are exactly such shims, so this is the likeliest way a
// template fails here, and the raw errno says nothing about what to do. Resolving
// the extension ourselves would restore precisely the behaviour the CVE closed;
// the way out belongs in the user's own template.
const SHIM_ERROR_CODES = new Set(['EINVAL', 'ENOENT']);

function spawnFailureHint(error, platform, envName) {
  if (platform !== 'win32' || !SHIM_ERROR_CODES.has(error && error.code)) return '';
  return (
    'on Windows a .cmd/.bat shim — how npm installs a global CLI — cannot be started ' +
    'without a shell, and briefboard deliberately never uses one. Point ' +
    `${envName} at the real executable (C:\\...\\claude.exe) or wrap the call ` +
    `yourself: ${envName}='cmd /c claude -p "..."'.`
  );
}

/**
 * Splits a command template into argv. Quotes only group characters: there are
 * no escapes and no expansion, so a Windows path keeps its backslashes.
 * Throws on an unterminated quote or an empty template.
 */
function parseCommandTemplate(template) {
  const argv = [];
  let current = '';
  let started = false; // tells "" (an empty argument) apart from no argument
  let quote = null;
  for (const ch of String(template)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        argv.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new Error('unterminated quote in the command template');
  if (started) argv.push(current);
  if (!argv.length) throw new Error('the command template is empty');
  return argv;
}

// Substituting into an ALREADY split argv is the point: done before the split, a
// value could introduce argument boundaries or quotes and rewrite the shape of
// the command. Here it can only change the contents of one existing argument —
// which is why every placeholder ({id}, {profile}) goes through this one function
// rather than getting a substitution pass of its own.
function substitutePlaceholders(argv, values) {
  const pairs = Object.entries(values).filter(([, value]) => typeof value === 'string');
  return argv.map((arg) => pairs.reduce((out, [token, value]) => out.replaceAll(token, value), arg));
}

function substituteId(argv, taskId) {
  return substitutePlaceholders(argv, { [PLACEHOLDER]: taskId });
}

/**
 * Prepares the working tree an isolated session runs in: branch `task/T-NNNN`
 * and worktree `.briefboard/worktrees/T-NNNN`, both created from the shared
 * checkout's current HEAD.
 *
 * `git worktree add` is the ONLY git command this module runs against the shared
 * checkout, and it is chosen because it does not move that checkout's HEAD. A
 * session that instead ran `git checkout -b` there would yank HEAD out from
 * under everyone else sharing the directory — T-0064, where a worker's checkout
 * sent the next commit to a foreign branch and left main behind.
 *
 * Resolves to { ok: true, path, created } or { ok: false, reason, detail }; it
 * never throws, and it never falls back to the shared checkout. `created` tells
 * a first run from a restart, which is what the preparation command keys on
 * (T-0150).
 */
async function prepareWorktree(gitBin, project, taskId) {
  const branch = BRANCH_PREFIX + taskId;
  const worktreePath = path.join(project, ...WORKTREE_DIR_PARTS, taskId);

  const inRepo = await runGit(gitBin, ['rev-parse', '--is-inside-work-tree'], project);
  if (!inRepo.ok) {
    if (inRepo.missing) return { ok: false, reason: 'no-git', detail: inRepo.stderr };
    return {
      ok: false,
      reason: 'not-a-repo',
      detail: inRepo.stderr || `${project} is not a git working tree`,
    };
  }

  // A worktree already attached here is the restart case, not an error: the
  // previous session's work lives in it.
  if (fs.existsSync(path.join(worktreePath, '.git'))) {
    return { ok: true, path: worktreePath, created: false };
  }

  const hasBranch = await runGit(
    gitBin,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    project
  );
  const args = hasBranch.ok
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'];

  const added = await runGit(gitBin, args, project, { timeoutMs: WORKTREE_ADD_TIMEOUT_MS });
  if (!added.ok) {
    if (added.missing) return { ok: false, reason: 'no-git', detail: added.stderr };
    return {
      ok: false,
      reason: 'worktree-failed',
      detail: added.stderr || `git ${args.join(' ')} exited with ${added.code}`,
    };
  }
  return { ok: true, path: worktreePath, created: true };
}

function setupStampPath(project, taskId) {
  return path.join(project, ...WORKTREE_DIR_PARTS, taskId + SETUP_STAMP_SUFFIX);
}

/**
 * Runs the declared preparation command in a worktree (T-0150). Its output goes
 * into the session's own log, which is where a human looks to see what the
 * install did before it stopped.
 *
 * Never throws: every ending — a command that cannot be spawned, a non-zero
 * exit, a run past the time limit — comes back as { ok: false, reason, detail },
 * because the caller turns it into a refusal to start the session at all.
 */
function runSetupCommand(argv, { cwd, log, env, timeoutMs, track }) {
  return new Promise((resolve) => {
    const [file, ...args] = argv;
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: SPAWN_DETACHED,
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, reason: 'setup-failed', detail: e.message, error: e });
      return;
    }
    if (track) track.add(child);
    log.absorb(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    const finish = (result) => {
      clearTimeout(timer);
      if (track) track.delete(child);
      resolve(result);
    };
    child.once('error', (e) =>
      finish({ ok: false, reason: 'setup-failed', detail: e.message, error: e })
    );
    // 'close' rather than 'exit': the command's output has to be in the log
    // before the caller ends the stream with its refusal.
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          reason: 'setup-timeout',
          detail: `${SETUP_ENV} was killed after ${timeoutMs} ms`,
        });
        return;
      }
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        reason: 'setup-failed',
        detail: signal
          ? `${SETUP_ENV} was killed by ${signal}`
          : `${SETUP_ENV} exited with ${code}`,
      });
    });
  });
}

/**
 * What a session is judged by (T-0109): the task as the SHARED checkout's
 * backlog has it — the file every session writes its result to, isolated in a
 * worktree or not. Returns null when there is nothing to compare (no backlog, no
 * such task, unreadable file); a null disables the check rather than guessing.
 */
function taskSnapshot(project, taskId) {
  let text;
  try {
    text = fs.readFileSync(path.join(project, ...BACKLOG_PARTS), 'utf8');
  } catch {
    return null;
  }
  const task = parseBacklog(text).find((t) => t.id === taskId);
  if (!task) return null;
  return {
    status: task.status,
    briefs: task.briefs.join(','),
    questions: hasSessionQuestions(task.description),
    verdicts: countReviewVerdicts(task.description),
  };
}

// The questions flag is the whole reason this is not just "status and briefs":
// a session that stops to ask (T-0083, T-0101) leaves both exactly as they were
// and changes only the description. Calling that legitimate ending empty would
// be a false alarm on an honest scenario — and a hint people learn to ignore is
// worth less than no hint at all.
//
// The verdict count is there for the same reason: a review session that did its
// whole job changes nothing but the description, and on purpose (T-0122).
function sessionChangedTask(before, after) {
  if (!before || !after) return true;
  return (
    before.status !== after.status ||
    before.briefs !== after.briefs ||
    before.questions !== after.questions ||
    before.verdicts !== after.verdicts
  );
}

// A session that wrote nothing still exits 0 and still looks finished on the
// board; this line is the only trace it leaves. Diagnosis only — nothing is
// restarted and no status is touched, and the reason is not guessed from the
// agent's own output: we do not know what agent ran there or what it prints.
function emptyRunHint(taskId, envName) {
  return (
    `[briefboard] this session ended without changing ${taskId}: same status, no new brief, ` +
    'no "### Session questions" section, no "### Review verdict" section.\n' +
    '[briefboard] the usual cause is a tool permission the agent was never granted — headless ' +
    'it cannot ask for one, so it gives up quietly. Check the permission list in ' +
    `${envName} (README: "Tool permissions: without them the session writes nothing").\n`
  );
}

function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function registryPathFor(project) {
  return path.join(project, ...LOG_DIR_PARTS, REGISTRY_FILE);
}

/**
 * Parses the registry file. Never throws: `error` is the reason there is nothing
 * to return, and the wording of the report belongs to the caller — the board and
 * the CLI say different things about the same broken file. A missing file is not
 * an error, it is a project where no session has ever run.
 */
function loadRegistryFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return emptyRegistry(e.code === 'ENOENT' ? '' : `${file} is unreadable (${e.message})`);
  }
  if (!parsed || parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.sessions)) {
    return emptyRegistry(`${file} is not version ${REGISTRY_VERSION}`);
  }
  return {
    sessions: parsed.sessions.filter(
      (r) => r && TASK_ID_RE.test(String(r.id)) && typeof r.logPath === 'string'
    ),
    // Written by a later version or by nobody yet: the per-task history and its
    // eviction counts are read leniently, because their absence means "no sums
    // to show", not "this file is broken".
    history: Array.isArray(parsed.history)
      ? parsed.history.filter((e) => e && TASK_ID_RE.test(String(e.id)) && e.startedAt)
      : [],
    dropped: parsed.dropped && typeof parsed.dropped === 'object' ? parsed.dropped : {},
    error: '',
  };
}

function emptyRegistry(error) {
  return { sessions: [], history: [], dropped: {}, error };
}

/**
 * Whether that pid is a process still doing something.
 *
 * `process.kill(pid, 0)` is the only check Node has on every platform, and EPERM
 * means the pid exists and belongs to someone else, which is still "alive". But
 * on POSIX it also succeeds for a ZOMBIE — a process that has died and whose
 * parent has not reaped it — so on its own it says "alive" about something that
 * will never run another instruction (T-0202). Every reader of a board's
 * bookkeeping believes this function: reconcileSession() decides from it whether
 * ANOTHER board is still running a session, and a dead board left as a zombie by
 * a parent that never wait()s would be read as live for as long as it sits there,
 * so the leftover sweep would never run and the task would stay locked to a
 * session that is over. Hence the second half — see isZombie().
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  return !isZombie(pid);
}

/**
 * Makes one stored record honest for whoever is reading it now. A `running`
 * record is only as true as the board that wrote it: sessions are not detached,
 * so they go down with their board, and the record then describes a session that
 * is over.
 *
 * What tells the two apart is `board`, the pid of the board process — not the
 * session's own pid: a board's previous run leaves records whose pid the OS may
 * since have handed to a stranger, and Node cannot read another process's start
 * time portably to catch that (T-0102). Hence `selfPid` too: a record claiming
 * the reader's own pid as its board cannot have been written by the reader, so
 * it is a reused pid, not a live board.
 */
function reconcileSession(record, { selfPid = process.pid, isAlive = isProcessAlive } = {}) {
  if (record.status !== 'running') return record;
  if (record.board !== selfPid && isAlive(record.board)) return record;
  return {
    ...record,
    status: 'interrupted',
    endedAt: record.endedAt || new Date().toISOString(),
    exitCode: null,
    signal: null,
  };
}

/**
 * Reads a project's session registry with no board running — this is how a
 * separate process (the orchestrator's `task.mjs sessions`, T-0103) learns that
 * the board already has an agent on a task, so it does not send a second one
 * onto the same `task/T-NNNN` branch. Returns { file, sessions, error }.
 */
function readSessionRegistry(project, options = {}) {
  const file = registryPathFor(project);
  const { sessions, error } = loadRegistryFile(file);
  return {
    file,
    error,
    sessions: sessions
      .map((r) => reconcileSession(r, options))
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))),
  };
}

/**
 * The end of a log file, capped. Shared by the log the board shows and the token
 * extractor: both want the tail, because an agent prints its summary last and a
 * multi-megabyte log read whole to find one number is a cost of its own.
 *
 * Returns { ok: true, text, totalBytes, truncated } or { ok: false, error }.
 */
function readTail(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
  try {
    const totalBytes = fs.fstatSync(fd).size;
    const from = Math.max(0, totalBytes - maxBytes);
    const buffer = Buffer.alloc(totalBytes - from);
    if (buffer.length) fs.readSync(fd, buffer, 0, buffer.length, from);
    let text = buffer.toString('utf8');
    // A cut at a byte offset lands mid-line and may split a UTF-8 sequence;
    // dropping everything before the first newline removes both at once.
    if (from > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return { ok: true, text, totalBytes, truncated: from > 0 };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- what a task cost (T-0116) ----------

// One finished run, kept after its record is gone: no pid, no paths, nothing a
// reader has to be trusted with — only when it ran, how it ended and what the
// declared extractor read out of its log.
function historyEntry(record) {
  return {
    id: record.id,
    kind: record.kind,
    startedAt: record.startedAt,
    endedAt: record.endedAt || null,
    status: record.status,
    exitCode: record.exitCode == null ? null : record.exitCode,
    signal: record.signal || null,
    tokens: typeof record.tokens === 'number' ? record.tokens : null,
  };
}

// A task has many runs, so the id alone does not identify one; the start does,
// because a session cannot start twice in the same millisecond on the same task.
function entryKey(entry) {
  return `${entry.id}|${entry.startedAt}`;
}

// The same five endings the board's session marker names (T-0102): a killed
// session reports a signal and no exit code, and "stopped on purpose" is not the
// same news as "crashed".
function sessionOutcome(entry) {
  if (entry.status === 'running') return 'running';
  if (entry.status === 'interrupted') return 'interrupted';
  if (entry.signal) return 'stopped';
  return entry.exitCode === 0 ? 'ended' : 'failed';
}

/**
 * What one task cost, over every run the board still has (T-0116): how many
 * sessions there were and of which kinds, how long they ran together and one by
 * one, how they ended. Measured, not configured — it needs no knowledge of which
 * agent ran.
 *
 * A session still running is counted up to `now` and marked, so the total is
 * honest about being a total so far.
 *
 * `dropped` is how many of the task's sessions the registry has already evicted.
 * It travels with the sum instead of being subtracted from it silently: an
 * understated number presented as exact is worse than a number that says which
 * part of itself is missing.
 *
 * `tokens` stays null unless a run actually yielded one. Nothing here invents a
 * zero for a task whose agent never reported anything.
 */
function summarizeSessions(id, entries, { dropped = 0, now = Date.now() } = {}) {
  const kinds = {};
  const outcomes = {};
  let durationMs = 0;
  let running = false;
  let tokens = null;
  let tokenSessions = 0;
  const list = [...entries]
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .map((entry) => {
      const outcome = sessionOutcome(entry);
      const startedMs = Date.parse(entry.startedAt);
      const endedMs = entry.endedAt ? Date.parse(entry.endedAt) : now;
      const span =
        Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0;
      kinds[entry.kind] = (kinds[entry.kind] || 0) + 1;
      outcomes[outcome] = (outcomes[outcome] || 0) + 1;
      durationMs += span;
      if (outcome === 'running') running = true;
      if (typeof entry.tokens === 'number') {
        tokens = (tokens || 0) + entry.tokens;
        tokenSessions++;
      }
      return {
        kind: entry.kind,
        outcome,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt || null,
        durationMs: span,
        running: outcome === 'running',
        exitCode: entry.exitCode == null ? null : entry.exitCode,
        tokens: typeof entry.tokens === 'number' ? entry.tokens : null,
      };
    });
  return {
    id,
    sessions: list.length,
    kinds,
    outcomes,
    durationMs,
    running,
    tokens,
    tokenSessions,
    dropped,
    complete: dropped === 0,
    entries: list,
  };
}

// The shape every caller outside this module sees. `logPath` is dropped: it is
// an absolute filesystem path, the board has no use for it, and the only reader
// that needs it is readLogTail() right here — so it never becomes something an
// HTTP response could carry by accident. `worktree` is a path too and stays: a
// human closing the task has to type it, and the board is where they read it
// (T-0117). `board` goes the same way: it exists so
// a reader of the file can tell a live session from a leftover one, and that
// question is already answered by `status` for anyone reading it from here.
// `descendants` is process bookkeeping for the next board run (T-0193) and
// answers nothing anyone reading a card is asking.
//
// `treeUnknown` and `treeReason` were stripped with it (T-0236) on the same
// reasoning, and that was the wrong half of the pair: the pids are bookkeeping,
// but the fact that there are none to write down is news — while it lasts, a
// board that dies leaves this session's agents running with nothing recorded to
// end them by. It was said only in the log, which is not where the person whose
// board just fell over is looking (T-0242). What the card does with it is the
// card's business; here the record simply stops hiding it.
function publicRecord(record) {
  const { logPath, board, descendants, ...rest } = record;
  return rest;
}

// The one way this module ends a child, shared by shutdown(), stopSession() and
// the setup timeout: a second copy is how they would drift apart.
//
// It ends the whole tree, because the command the board spawns is a launcher —
// `cmd /c claude ...`, `npm ci` — and the process that does the work (and writes
// into the worktree) is its child. Measured on Windows 11 with
// `cmd /c node worker.js`: two seconds after child.kill() the worker was alive
// and still appending to its file; after `taskkill /t` it was gone. The
// mechanism cannot be shared — Windows has no process group in the POSIX
// sense — so each platform gets its own, and both fall back to signalling the
// single process, which is all this function ever did before (T-0155).
function killChild(child, { platform = process.platform, killer = TREE_KILLER } = {}) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    killTreeWindows(child, killer);
    return;
  }
  try {
    // The negated pid is the child's process group, which it leads only because
    // it was spawned detached (SPAWN_DETACHED). Anything else — a child spawned
    // otherwise, a group already gone — throws, and is the fallback's case.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    killOne(child);
  }
}

function killTreeWindows(child, killer) {
  let proc;
  try {
    proc = spawn(killer, ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      // Out of the job object libuv puts our children in, so that shutdown(),
      // which exits the moment it has ordered the kills, does not take the
      // killer down with it.
      detached: true,
    });
    proc.unref();
  } catch {
    killOne(child);
    return;
  }
  // No taskkill on this machine, or it refused (access denied): the board must
  // not care, and the child still has to go.
  proc.once('error', () => killOne(child));
  proc.once('exit', (code) => {
    if (code !== 0) killOne(child);
  });
}

function killOne(child, signal) {
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

// The second attempt, when the first kill has had its grace and the tree is
// still there (T-0173). Only POSIX has anywhere harder to go: SIGTERM to the
// group can be caught and ignored, SIGKILL cannot, and the group outlives its
// leader either way. On Windows `taskkill /t /f` was already the hardest reach
// there is, so the escalation can only order it again — never terminate the
// launcher alone, which is what it did until T-0192: that killer finds the tree
// by parent pid whenever it gets to run, so taking the launcher out from under
// it leaves the worker with no parent to be found from, alive after the board is
// gone (measured idle: 23.8s, and only the probe's own clock ended it). A
// descendant taskkill itself is refused on cannot be reached at all — that case
// is what the bounded wait, not this, answers.
function killHard(child, { platform = process.platform, killer = TREE_KILLER } = {}) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    killTreeWindows(child, killer);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    killOne(child, 'SIGKILL');
  }
}

// ---------- what a board that died leaves behind (T-0193) ----------

/*
 * A board killed hard, crashed, or cut off with the machine never runs
 * shutdown(), and nothing in Node can make the tree die with it: the job object
 * is libuv's and lets the launcher's children break away (see SPAWN_DETACHED),
 * and a watchdog is one more process that can be killed the same way.
 *
 * What is left is to clean up at the NEXT start. The registry already survives a
 * restart and already marks the dead (reconcileSession, T-0102); this adds what
 * a dead record was missing — which processes the session had.
 *
 * A pid alone would not do. On Windows the launcher goes down with the board, so
 * by the next start the survivor's own pid is the only one there is, and the OS
 * is free to have handed it to a stranger meanwhile. So every process of the
 * tree is written down together with the moment it started, and at the next
 * start a recorded pid is killed only if the process sitting at it now started
 * at exactly that moment. That is the whole defence against a reused pid, and it
 * is why the start time is read but never used as a time: it is an identity
 * token, compared for equality.
 *
 * How fine that token is differs by platform (T-0199): 100ns on Windows, a whole
 * second from `ps -o lstart=` on POSIX. The coarser one still holds, because a
 * false match needs a stranger that started in the SAME second our process did —
 * and ours was alive through that second, so the pid must have wrapped all the
 * way round inside it. Measured on Linux: pid_max 4194304 at 1166 forks/s, an
 * hour per wrap. A kernel set to a small pid_max shrinks that margin.
 */

// The tree is written down while the session runs, because afterwards there is
// nobody left to ask. Every half minute and no oftener: reading the table costs
// a whole subprocess (measured 1.4s for PowerShell on Windows 11), and what it
// watches is an agent that lives for minutes to hours. The first look waits the
// same half minute as the rest — which is the honest limit of this cleanup, and
// the documentation says so: a board that dies in the first thirty seconds of a
// session leaves that session's tree unrecorded. What changed is that the record
// now says that of itself instead of looking like a session with no processes
// (treeUnknown, T-0236).
const SCAN_INTERVAL_MS = 30_000;
const SCAN_TIMEOUT_MS = 30_000;
// What the scan's read is given once that budget has already proved too small
// (T-0236). Half a minute was chosen because a scan that gives up is retried by
// the next tick — which holds only while the read FITS in it. Measured under
// four concurrent suites on 2026-08-17 (Windows 11, node v24.18.0, 24 cores,
// the suite at 1840 tests), one read of the table cost 39.5s, 41.2s, 45.5s and
// 47.1s: on a machine in that state every tick fails identically at 30s, the
// tree is never written down at all, and the retry that justified the small
// budget retries nothing. So the budget climbs — doubling with each failed read
// up to this ceiling, and back to SCAN_TIMEOUT_MS on the first read that works.
//
// The ceiling is the sweep's number (SWEEP_TIMEOUT_MS) for the sweep's reason:
// 2.5x the worst read seen here, where 30s is 0.64x it — below the measurement,
// which is what made the failure certain rather than likely. It is not the
// STARTING number because the budget is also how long the scan holds its
// one-read-at-a-time guard before asking again, and a machine that answers in
// 1.4s should not lose two minutes of bookkeeping to one lost subprocess. And
// the climb costs no extra process: reads stay one per SCAN_INTERVAL_MS at
// most, and a chronically failing scan now spends a subprocess LESS often than
// it used to — one per 150s at the ceiling against one per 60s at 30s.
const SCAN_MAX_TIMEOUT_MS = 120_000;
// The sweep's read is a different call from the scan's, and gets a budget of its
// own because the two can afford different things. What the read costs is the
// machine's time and not the query's — measured on Windows 11, 24 cores (T-0224):
//
//   idle                                     p50 1.3s, of which the shell alone is 0.56s
//   24 cpu-bound processes                   p50 4.2s, max 5.6s
//   the same, while processes are also
//   being created and torn down              p50 5.5s, max 26.5s   (n=15)
//   24 reads at once, machine otherwise idle p99 2.5s
//
// So concurrency is not what costs; a busy machine is. Against a worst case of
// 26.5s, SCAN_TIMEOUT_MS is 1.1x — and the scan can live with that, because a
// scan that gives up is retried by the next tick half a minute later. The sweep
// gets one read for the whole board run, nobody waits on it, and what it buys is
// a session's agents stopped instead of left running, so it is the one read here
// that can afford to wait.
const SWEEP_TIMEOUT_MS = 120_000;
// And when it still cannot be read, the retry waits before asking again. An
// immediate one is measurably worth nothing: of 14 reads that missed their
// budget on a machine kept busy, 1 came back on a second attempt taken at once —
// starvation is a state and not a spike. Over tens of seconds the same machine
// swings between 1.1s and 8.5s per read, which is the interval a retry has to
// span to be asking a different question (T-0224).
const SWEEP_RETRY_MS = 30_000;
// Each wait after the first doubles it, so the attempts fall at 0s, 30s, 1.5min,
// 3.5min, 7.5min and 15.5min from the board's start. Two numbers pick that shape
// (T-0230):
//
// - what has to be waited out. A read that missed a 120s budget is not the
//   1.1s→8.5s swing a single 30s retry answers; it is the sustained starvation
//   of the same measurement, and asking again at the same spacing asks the same
//   question. What ends it is whatever is loading the machine — a suite, a
//   build, another board's agents — and those last minutes, so the ladder has to
//   span minutes;
// - what it may cost. Six reads over 15.5 minutes, against the 31 the scan
//   already makes in that same window while one session runs. The doubling is
//   what keeps it there: a fixed 30s retry for the life of an 8-hour board would
//   be 960 reads, and a read is a whole subprocess that itself loads the machine.
//
// After the last one the sweep stops spending anything at all — it hands its
// leftovers to the scan, which reads the table anyway (see strandLeftovers).
const SWEEP_ATTEMPTS = 6;
// Some 400 processes at ~45 bytes on the machine this was written on; the
// default 1 MB would cut off a busy server, and a cut-off table silently loses
// exactly the row we came for.
const SCAN_MAX_BUFFER = 8 * 1024 * 1024;
// What Windows prints where POSIX prints a process state. It has none to print —
// there is no zombie there, and nothing else in the state column is read — and a
// placeholder is cheaper than a second row format: one line shape means one
// parser, and a parser that guesses which shape it is looking at would have to
// tell a state letter from the first word of a start time.
const NO_STATE = '-';
// Windows has no parent pid in `tasklist`, and no `wmic` at all since Windows 11
// 24H2 (absent on the machine this was written on), so the process table comes
// from PowerShell. The format string is deliberate: `-f` with a format spec
// prints an empty field for a process whose CreationDate the OS withholds,
// where a method call on it would throw a row away.
const PS_PROCESS_TABLE =
  `Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} ${NO_STATE} ` +
  "{2:yyyy-MM-dd HH:mm:ss.fffffff}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate }";

function processTableCommand(platform = process.platform) {
  if (platform === 'win32') {
    return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_PROCESS_TABLE]];
  }
  return ['ps', ['-eo', 'pid=,ppid=,state=,lstart=']];
}

// The same table and the same column, asked about one pid — the answer
// isProcessAlive() needs, which has no table to hand in and cannot wait for one.
function processStateCommand(pid) {
  return ['ps', ['-o', 'state=', '-p', String(pid)]];
}

// pid, parent pid, state, and the whole rest of the line as the start time: `ps
// -o lstart=` prints "Sat Aug 16 12:00:00 2026", spaces and all, so the start
// time has to be last and takes everything after the fields that cannot contain
// a space.
function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    const found = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    if (found) {
      rows.push({
        pid: Number(found[1]),
        ppid: Number(found[2]),
        state: found[3],
        since: found[4],
      });
    }
  }
  return rows;
}

// POSIX process states are single letters with optional flags after them (`Ss`,
// `R+`), and only one of them means "dead, waiting to be reaped".
function isZombieState(state) {
  return String(state == null ? '' : state).trim().charAt(0) === 'Z';
}

// One row out of a table the kernel already has, and the caller is synchronous:
// whatever this waits, the board's event loop waits with it. SCAN_TIMEOUT_MS is
// the budget for reading the WHOLE table asynchronously and would be half a
// minute of a board answering nothing.
const STATE_TIMEOUT_MS = 2_000;
// A pid that `ps` will not answer for at all. Remembered because a machine
// without `ps` stays without it, and isProcessAlive() would otherwise pay for a
// failed spawn on every call for the rest of the run. Only the two failures that
// are about the COMMAND count: a pid that is simply gone exits non-zero with
// nothing on stderr, and that says nothing about the next pid.
let stateQueryUnusable = false;

/**
 * Whether that pid is a zombie. False on Windows, which has no such state — a
 * handle keeps the exit code readable, not the process listed.
 *
 * When the answer cannot be had — no `ps` on this machine, a `ps` that does not
 * understand the column, a pid that has gone in the meantime — this returns
 * false, so the caller keeps the answer `kill(pid, 0)` gave: ALIVE. That is the
 * deliberate half of the trade, and the two mistakes are not the same size.
 * Reading a live board as dead makes the next board sweep away the processes of
 * a session that is still running — someone's agent killed mid-work, and nothing
 * brings it back. Reading a dead board as alive only postpones a cleanup that is
 * itself a backstop: the leftovers keep running until a start where the question
 * can be answered, and the board says plainly that it killed nothing. So the
 * unanswerable case is resolved the same way processTree() resolves an
 * unreadable start time — failing to clean up is the safe half.
 */
function isZombie(pid) {
  if (process.platform === 'win32' || stateQueryUnusable) return false;
  const [file, args] = processStateCommand(pid);
  try {
    return isZombieState(
      execFileSync(file, args, {
        encoding: 'utf8',
        timeout: STATE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        // `state` is a letter in every locale, but the command is built by the
        // same rule as the table's (see readProcessTable) and shares its reason.
        env: { ...process.env, LC_ALL: 'C' },
      })
    );
  } catch (e) {
    if (e.code === 'ENOENT' || String(e.stderr || '').trim()) stateQueryUnusable = true;
    return false;
  }
}

/**
 * The live process table, and — when this machine will not give it up — why not:
 * `{ rows, reason, code }`, where `rows` is null exactly when `reason` is set.
 *
 * The reason is the point. Every caller of this treats a missing table as "leave
 * everything alone" (see isZombie), which is the right trade and a silent one:
 * the whole leftover cleanup switching itself off looks, from outside, exactly
 * like a board with nothing to clean up. It had been switching itself off under
 * load for some time before anyone could say what the failure even was, because
 * the error was resolved away here and never reached the message that reports it
 * (T-0224). `code` is for the one decision that turns on which failure it was:
 * a machine with no PowerShell at all stays that way, and asking again is only
 * worth doing when the answer can change.
 */
function probeProcessTable(platform = process.platform, timeoutMs = SCAN_TIMEOUT_MS) {
  const [file, args] = processTableCommand(platform);
  const started = Date.now();
  return new Promise((resolve) => {
    const fail = (code, reason) => resolve({ rows: null, code, reason: `${file}: ${reason}` });
    try {
      execFile(
        file,
        args,
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: SCAN_MAX_BUFFER,
          // GNU ps prints lstart through ctime(3) and ignores the locale
          // (measured on procps-ng 4.0.2: C, de_DE, fr_FR and ja_JP give one
          // output). BSD ps formats it with strftime %c, which in those same
          // locales prints forms Date.parse rejects — and an unreadable start
          // time costs the whole tree, silently. Free here, insurance there.
          env: platform === 'win32' ? process.env : { ...process.env, LC_ALL: 'C' },
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ rows: parseProcessTable(stdout), reason: '', code: '' });
          const spent = Date.now() - started;
          // `killed` and not a signal name: that is what execFile sets when its
          // own timer fires, and a table killed at the budget is the failure the
          // budget exists to be argued about.
          if (error.killed) return fail('timeout', `no answer within ${timeoutMs}ms (killed after ${spent}ms)`);
          if (error.code === 'ENOENT') return fail('missing', 'not on this machine');
          const said = String(stderr || '').trim().split('\n')[0].trim();
          return fail(
            'failed',
            `exited with ${error.code ?? error.signal} after ${spent}ms${said ? `: ${said}` : ''}`
          );
        }
      );
    } catch (e) {
      fail('failed', `could not be started: ${e.message}`);
    }
  });
}

/** The same table, for the callers that have nothing to do with the reason. */
function readProcessTable(platform = process.platform, timeoutMs = SCAN_TIMEOUT_MS) {
  return probeProcessTable(platform, timeoutMs).then((out) => out.rows);
}

// Both formats above sort as they run, so the comparison needs no calendar; a
// value in neither shape is what NaN is for, and the caller drops that row.
function startTimeMs(since) {
  const text = String(since == null ? '' : since);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(text) ? text.replace(' ', 'T') : text);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * The process at `rootPid` and everything under it, each with the start time
 * that identifies it.
 *
 * A child is only taken if it started no earlier than its parent. That is not a
 * truism but the second guard: on Windows ParentProcessId goes on naming a pid
 * long after that parent is gone, so a stranger's orphan whose own parent once
 * held the pid our launcher holds now would look like our child — and it started
 * before our launcher did. A row whose start time cannot be read is left out
 * too: failing to clean something up is the safe half of this trade.
 */
function processTree(rows, rootPid) {
  const byParent = new Map();
  const byPid = new Map();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const root = byPid.get(rootPid);
  if (!root || !Number.isFinite(startTimeMs(root.since))) return [];
  const seen = new Set(); // also what keeps a table whose pid is its own parent from looping
  const queue = [root];
  const tree = [];
  while (queue.length) {
    const row = queue.shift();
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    tree.push({ pid: row.pid, since: row.since });
    const at = startTimeMs(row.since);
    for (const kid of byParent.get(row.pid) || []) {
      if (startTimeMs(kid.since) >= at) queue.push(kid);
    }
  }
  return tree;
}

// Which of the written-down processes are still the same processes, and still
// running. A pid whose start time no longer matches was handed on after our board
// died, and whoever holds it now is not ours to kill; a pid the table shows as a
// zombie is ours all right, and already dead — killing it does nothing and
// counting it would have the board announce that it ended a process which had
// ended itself (T-0202).
function survivingLeftovers(recorded, rows) {
  const live = new Map(rows.filter((row) => !isZombieState(row.state)).map((row) => [row.pid, row.since]));
  return recorded.filter(
    (entry) => entry && Number.isInteger(entry.pid) && entry.pid > 0 && live.get(entry.pid) === entry.since
  );
}

// The pids have been verified one by one, and taking their children too is still
// right: a leftover has had the whole of the board's absence to start children of
// its own, and those were never written down anywhere. Windows gets them from
// `/t`; POSIX gets them from the process group, which setsid gave the launcher
// (SPAWN_DETACHED) and which outlives its leader — both measured (T-0199).
function killPids(pids, { platform = process.platform, killer = TREE_KILLER } = {}) {
  if (!pids.length) return;
  if (platform === 'win32') {
    const args = [];
    for (const pid of pids) args.push('/pid', String(pid));
    try {
      const proc = spawn(killer, [...args, '/t', '/f'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
        detached: true,
      });
      proc.once('error', () => {});
      proc.unref();
    } catch {
      /* no taskkill on this machine: nothing else here can reach a stranger's tree */
    }
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    // Then its group. A pid leading no group answers ESRCH, and no stranger's
    // group can carry this number: while the pid is in use as a group id the
    // kernel will not hand it out again. pid 1 is excluded because kill(-1) is
    // every process on the machine.
    if (pid <= 1) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* leads no group */
    }
  }
}

// A cap is a positive whole number or it is not a cap: anything else — absent,
// empty, a typo in an env var — falls back to the shipped default rather than
// turning the limit off.
function normalizeCap(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Compiles one command template into argv, or into the reason it is unusable.
 * A broken template disables its kind of session: it must never take the server
 * down, and never fall back to a shell.
 */
function compileTemplate(template, envName, { loopback, logger, profiles }) {
  const text = typeof template === 'string' ? template.trim() : '';
  if (!text) return { argv: null, disabledReason: 'not configured', usesProfile: false };
  let argv;
  try {
    argv = parseCommandTemplate(text);
  } catch (e) {
    logger.error(`${envName} is not parseable (${e.message}) — agent sessions are disabled.`);
    return { argv: null, disabledReason: 'invalid command template', usesProfile: false };
  }
  // A property of this template alone: the chosen profile reaches the agent only
  // if THIS command has somewhere to put it (T-0121).
  const usesProfile = argv.some((arg) => arg.includes(PROFILE_PLACEHOLDER));
  // Refused rather than substituted with nothing: with no profiles declared
  // there is no default either, so `--mode {profile}` would spawn the agent
  // with a flag whose value is missing or is the literal placeholder. Saying so
  // at start-up is the only moment a human is still reading.
  if (!profiles.values.length && usesProfile) {
    logger.error(
      `${envName} uses ${PROFILE_PLACEHOLDER} but ${PROFILES_ENV} declares no profiles ` +
        `— those sessions are disabled. Declare them, e.g. ${PROFILES_ENV}='deep, fast' ` +
        '(the first one is the default).'
    );
    return { argv: null, disabledReason: 'no profiles configured', usesProfile };
  }
  if (!loopback) {
    logger.warn(
      `WARNING: ${envName} is set but the server is not bound to a ` +
        'loopback address — agent sessions are disabled. Starting processes on ' +
        'behalf of a network-reachable HTTP endpoint would be remote code execution.'
    );
    return { argv: null, disabledReason: 'non-loopback bind', usesProfile };
  }
  return { argv, disabledReason: '', usesProfile };
}

/**
 * Builds a session runner. Everything it needs is passed in (no direct env
 * reads) so the registry can be exercised without an HTTP server.
 *
 *   project       — cwd for sessions, root of .briefboard/sessions/, and the
 *                   AGENTBOARD_ROOT every session is given (T-0118)
 *   command       — the BRIEFBOARD_SESSION_CMD template (the briefing session);
 *                   empty/absent = that kind is disabled
 *   workerCommand — the BRIEFBOARD_WORKER_CMD template (the worker session)
 *   orchestratorCommand — the review session's template (T-0122), whichever of
 *                   the two variables supplied it; see resolveReviewCommand
 *   orchestratorEnvName — which variable that was, so a start-up warning or a
 *                   spawn hint names the one the user actually set (T-0305)
 *   setupCommand  — the BRIEFBOARD_SETUP_CMD template, run once in a new
 *                   worktree before the session that will work in it (T-0150);
 *                   empty/absent = nothing is run and nothing is said
 *   setupTimeoutMs — how long that command may take before it is killed and the
 *                   session refused; injectable so the limit can be tested
 *   maxSessions   — concurrency cap, over all kinds together
 *   maxFinished   — how many finished sessions the registry keeps (MAX_FINISHED);
 *                   injectable so the eviction can be tested at three spawns
 *                   instead of twenty-five (T-0185)
 *   profiles      — the BRIEFBOARD_PROFILES declaration (see parseProfiles);
 *                   empty = the feature is off and a task's profile is ignored
 *   tokensPattern — the BRIEFBOARD_TOKENS_RE declaration (see compileTokenPattern);
 *                   empty = the board reports time and never mentions tokens
 *   tokensMode    — the BRIEFBOARD_TOKENS_MODE declaration (see parseTokensMode):
 *                   'sum' (the default) or 'last'; an unusable one counts nothing
 *   loopback      — false disables the runner outright
 *   logger        — console-like sink for start-up warnings and spawn failures
 *   gitBin        — git executable used for isolated sessions; injectable so the
 *                   "git is missing" path can be tested without touching PATH
 *   platform      — process.platform; injectable so the Windows-only spawn hint
 *                   can be tested off Windows
 *   scanIntervalMs — how often a running session's process tree is written down
 *                   (SCAN_INTERVAL_MS, T-0193); 0 turns the whole leftover
 *                   mechanism off, including the sweep at start. Each read
 *                   starts on SCAN_TIMEOUT_MS and climbs to SCAN_MAX_TIMEOUT_MS
 *                   while the table will not answer (T-0236)
 *   sweepRetryMs  — how long the start-up sweep waits before asking for the
 *                   process table a second time (SWEEP_RETRY_MS, T-0224); every
 *                   wait after that doubles the one before (SWEEP_ATTEMPTS,
 *                   T-0230)
 *   listProcesses — where the process table comes from; injectable so the sweep
 *                   can be tested without a real one. Returns the rows, or
 *                   `{ rows: null, reason, code }` to stage a machine that will
 *                   not answer
 *   onChange      — called with the public record whenever a session starts or
 *                   ends. Nothing polls the registry, so this is how the server
 *                   learns that a session died (T-0077)
 */
function createSessionRunner({
  project,
  command,
  workerCommand,
  orchestratorCommand,
  orchestratorEnvName = ENV_NAMES.orchestrator,
  setupCommand,
  setupTimeoutMs = SETUP_TIMEOUT_MS,
  maxSessions,
  maxFinished,
  profiles: profilesRaw,
  tokensPattern,
  tokensMode: tokensModeRaw,
  loopback = true,
  logger = console,
  gitBin = 'git',
  platform = process.platform,
  scanIntervalMs = SCAN_INTERVAL_MS,
  sweepRetryMs = SWEEP_RETRY_MS,
  listProcesses = null,
  onChange = null,
} = {}) {
  const records = new Map(); // taskId -> record, logPath included (see publicRecord)
  const children = new Map(); // taskId -> ChildProcess, running sessions only
  const setupChildren = new Set(); // preparation commands still running (T-0150)
  const finishedOrder = []; // taskIds of finished sessions, oldest first
  const openLogs = new Set(); // one promise per log still holding a file handle
  // Every finished run, not just the last one per task: the record map is keyed
  // by task, so without this a task's second session would erase the first and
  // "what did this task cost" could only ever answer for one run (T-0116).
  const history = []; // history entries, oldest first
  // taskId -> sessions evicted from `history`. One small number per task the
  // project ever ran, and it is what keeps an incomplete sum from passing for a
  // complete one.
  const dropped = new Map();
  // startedAt of the newest run already evicted. Runs leave oldest first, so
  // anything up to this has been counted as lost once and must not come back:
  // the file still holds it until the next write, and re-reading it there would
  // evict it a second time and report twice the loss.
  let evictedBefore = '';
  const max = normalizeCap(maxSessions, DEFAULT_MAX_SESSIONS);
  // Only the record cap follows the option. MAX_HISTORY is the per-task cost
  // ledger's own limit (T-0116) and answers a different question, so a test that
  // shrinks the registry to three records must not silently shrink the ledger to
  // thirty entries underneath it.
  const finishedCap = normalizeCap(maxFinished, MAX_FINISHED);

  const profiles = parseProfiles(profilesRaw);
  const tokensMode = parseTokensMode(tokensModeRaw, logger);
  // Both declarations are reported at start-up even when the other one is
  // already broken, so one restart shows every mistake in the pair.
  const tokenRe = compileTokenPattern(tokensPattern, logger);

  // Per runner rather than the module-wide map, because the review session's
  // command may have come from either of its two variables and every message
  // about it has to name the one that is really set (T-0305).
  const envNames = { ...ENV_NAMES, orchestrator: orchestratorEnvName || ENV_NAMES.orchestrator };

  const templates = {
    briefing: compileTemplate(command, envNames.briefing, { loopback, logger, profiles }),
    worker: compileTemplate(workerCommand, envNames.worker, { loopback, logger, profiles }),
    orchestrator: compileTemplate(orchestratorCommand, envNames.orchestrator, {
      loopback,
      logger,
      profiles,
    }),
  };
  // Deliberately outside `templates`: that map is indexed by the kind a caller
  // asks for, and the preparation command is not a kind of session anyone can
  // start.
  const setupTemplate = compileTemplate(setupCommand, SETUP_ENV, { loopback, logger, profiles });

  function logDir() {
    return path.join(project, ...LOG_DIR_PARTS);
  }

  function registryPath() {
    return registryPathFor(project);
  }

  // Auxiliary data, never the truth about tasks: a failure to write it must not
  // reach the session it describes, and a failure to read it must not keep the
  // board from starting.
  //
  // The records of another LIVE board are re-read here and passed through rather
  // than kept in memory: only their own board learns when they end, so a
  // snapshot of them written back would resurrect sessions that have long
  // finished — and the guard below would then refuse to start a real one (T-0103).
  function persist() {
    try {
      const stored = loadRegistryFile(registryPath());
      const others = stored.sessions.filter(
        (r) => r.board !== process.pid && isProcessAlive(r.board)
      );
      const theirs = new Set(others.map((r) => r.id));
      const sessions = [...records.values()].filter((r) => !theirs.has(r.id)).concat(others);
      // The finished runs go the other way round: they are over, nobody will
      // update them again, and a second board's runs on the same project belong
      // in the same per-task sum. So they are merged in rather than overwritten.
      absorb(stored.history, stored.dropped);
      atomicWrite(
        registryPath(),
        JSON.stringify(
          {
            version: REGISTRY_VERSION,
            sessions,
            history,
            dropped: Object.fromEntries(dropped),
          },
          null,
          2
        ) + '\n'
      );
    } catch (e) {
      logger.error(`session registry: writing ${registryPath()} failed: ${e.message}`);
    }
  }

  function loadRegistry() {
    const stored = loadRegistryFile(registryPath());
    if (stored.error) {
      logger.error(`session registry: ${stored.error} — starting with an empty registry.`);
    }
    return stored;
  }

  // Takes a run into the history, replacing the entry for the same run if it is
  // already there (the file's copy of a session this board is finishing).
  function remember(entry) {
    if (evictedBefore && String(entry.startedAt) <= evictedBefore) return;
    const at = history.findIndex((e) => entryKey(e) === entryKey(entry));
    if (at === -1) history.push(entry);
    else history[at] = entry;
  }

  // Oldest first out, and every eviction counted against its task — that count
  // is the difference between a partial sum and a wrong one.
  function trimHistory() {
    history.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    while (history.length > MAX_HISTORY) {
      const gone = history.shift();
      dropped.set(gone.id, (dropped.get(gone.id) || 0) + 1);
      evictedBefore = String(gone.startedAt);
    }
  }

  // Merges what the file holds into memory. Eviction counts are taken at their
  // largest: two boards evict independently, and the larger count is the one
  // that has not forgotten anything.
  function absorb(entries, counts) {
    for (const entry of entries) remember(entry);
    for (const [id, count] of Object.entries(counts || {})) {
      const n = Number(count);
      if (Number.isFinite(n) && n > (dropped.get(id) || 0)) dropped.set(id, Math.floor(n));
    }
    trimHistory();
  }

  // What the declared extractor reads out of one finished session's log, or null
  // when nothing is declared, the log is gone, or it holds no such number.
  function tokensOf(logPath) {
    if (!tokenRe || !tokensMode) return null;
    const tail = readTail(logPath, LOG_TAIL_BYTES);
    return tail.ok ? extractTokens(tail.text, tokenRe, tokensMode) : null;
  }

  function archive(record) {
    remember(historyEntry(record));
    trimHistory();
  }

  /**
   * Reads the registry left by the previous board run and makes it honest.
   * Sessions die with the board on purpose, so a card that says nothing after a
   * restart is the board lying by silence — the record stays, in a state that
   * says the session was cut short and points at its log.
   *
   * Nothing is restarted: the agent may have done half the work, and a second
   * run on top of that is a new problem, not a recovery.
   *
   * A session another board is still running is left out entirely: this board
   * cannot stop it, will never hear it end, and showing a card it can never
   * update is the same lie by omission in the other direction. It keeps its
   * place in the file (see persist), which is where anyone can read it (T-0103).
   */
  function restore() {
    const saved = loadRegistry();
    absorb(saved.history, saved.dropped);
    const stored = saved.sessions
      .slice()
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    let cut = 0;
    // What the previous run may have left running (T-0193). Only sessions THIS
    // board has just declared dead qualify: one another board is still running
    // was skipped above, and its tree is that board's to end.
    const leftovers = [];
    // And what it may have left running without ever writing it down (T-0236).
    const unwritten = [];
    for (const entry of stored) {
      const record = reconcileSession(entry);
      if (record.status === 'running') continue; // survived reconciliation = another board's
      if (record.status !== entry.status) {
        cut++;
        // The one moment a cut-short session's log can still be read for what it
        // spent: it ended without this board ever hearing it end.
        const tokens = tokensOf(record.logPath);
        if (tokens !== null) record.tokens = tokens;
        const processes = Array.isArray(record.descendants) ? record.descendants : [];
        if (processes.length) leftovers.push({ id: record.id, processes });
        if (record.treeUnknown) {
          unwritten.push({ id: record.id, blind: !processes.length, reason: record.treeReason });
        }
      }
      // Cleared whether or not the sweep finds anything: these pids describe a
      // board run that is over, and carrying them into the next one would put
      // ever staler numbers in front of the check that guards them. The mark on
      // them goes the same way and for the same reason — it has been reported
      // just below, and this board's own scans answer for this board's sessions.
      record.descendants = [];
      delete record.treeUnknown;
      delete record.treeReason;
      records.set(record.id, record);
      rememberFinished(record.id);
      archive(record);
    }
    if (cut) {
      logger.warn(
        `session registry: ${cut} session(s) did not survive the previous board run ` +
          '— marked interrupted. Restart them yourself if that is what you want.'
      );
    }
    reportUnwritten(unwritten);
    if (cut || records.size !== stored.length) persist();
    return leftovers;
  }

  /**
   * The sessions the previous board could not write a tree for (T-0236). This is
   * the moment the whole mechanism exists for, and the moment it used to be
   * silent at: the sweep below reports what it checked and killed, and a session
   * with nothing recorded never reaches it — it is not a leftover, it is a hole
   * where the record of one should be, and it reads from outside exactly like a
   * board that left nothing behind.
   *
   * Said even when nothing can be done about it, because the person can: these
   * are agents of a board that is gone, and nothing on this machine is going to
   * end them.
   */
  function reportUnwritten(unwritten) {
    if (!unwritten.length) return;
    const blind = unwritten.filter((entry) => entry.blind);
    const reason = unwritten.map((entry) => entry.reason).find(Boolean);
    logger.error(
      `session registry: the process tree of ${unwritten.length} session(s) of the previous board ` +
        `run (${unwritten.map((entry) => entry.id).join(', ')}) was never fully written down` +
        // Absent when the board died inside the first scan interval, which is the
        // other way this happens and needs no reason beyond itself.
        (reason ? ` (${reason})` : ' (the board did not last until its first scan)') +
        '. ' +
        (blind.length
          ? `For ${blind.map((entry) => entry.id).join(', ')} there is nothing recorded at all, so ` +
            'nothing here could be checked or killed. '
          : 'What was recorded for them is older than the sessions themselves, so a process ' +
            'started after the last reading is not in it. ') +
        'Any agent they left running has to be found by hand: it goes on working and goes on ' +
        'costing until something ends it.'
    );
  }

  // ---------- the leftovers of a board that died (T-0193) ----------

  const scanEvery = Number(scanIntervalMs) > 0 ? Number(scanIntervalMs) : 0;
  const sweepRetryEvery = Number(sweepRetryMs) >= 0 ? Number(sweepRetryMs) : SWEEP_RETRY_MS;
  const processTable = listProcesses || ((budget) => probeProcessTable(platform, budget));
  let scanTimer = null;
  let scanning = false;
  // Reads in a row that produced no table, and what the next one is allowed to
  // cost. Both go back to where they started on the first read that works
  // (T-0236).
  let scanFailures = 0;
  let scanBudget = SCAN_TIMEOUT_MS;

  // Always `{ rows, reason, code }`, whichever of the three shapes the source
  // answers in: an injected one may hand back the rows alone, and it is worth
  // being able to inject a failure with a reason attached to it.
  async function readTable(budget) {
    let out;
    try {
      out = await processTable(budget);
    } catch (e) {
      return { rows: null, reason: `the process table could not be read: ${e.message}`, code: 'failed' };
    }
    if (Array.isArray(out)) return { rows: out, reason: '', code: '' };
    if (out && Array.isArray(out.rows)) return { rows: out.rows, reason: '', code: '' };
    if (out && out.reason) return { rows: null, reason: String(out.reason), code: String(out.code || 'failed') };
    return {
      rows: null,
      reason: `${processTableCommand(platform)[0]}: gave no table and no reason`,
      code: 'failed',
    };
  }

  /**
   * Writes down the tree of every running session, so that a board which never
   * gets to shut down still leaves the next one enough to find what it left
   * behind. Runs on a timer while sessions are running and nowhere else.
   */
  async function scan() {
    if (scanning || !children.size) return;
    scanning = true;
    try {
      const { rows, reason } = await readTable(scanBudget);
      if (!rows) {
        markTreeUnknown(reason);
        return;
      }
      if (scanFailures) sayReadableAgain();
      // The table is here and paid for, so the sweep's leftovers get their answer
      // out of it before anything else is done with it (T-0230).
      if (stranded) checkStranded(rows);
      let changed = false;
      for (const [taskId, child] of children) {
        const record = records.get(taskId);
        if (!record || !child.pid) continue;
        record.descendants = processTree(rows, child.pid);
        // What is written down is now the whole of this session's tree, so the
        // mark that says otherwise goes with the same write (T-0236).
        delete record.treeUnknown;
        delete record.treeReason;
        changed = true;
      }
      if (changed) persist();
    } finally {
      scanning = false;
      if (children.size) scheduleScan(scanEvery);
    }
  }

  /**
   * What a scan that got no table has to leave behind (T-0236).
   *
   * Nothing about this looks like a failure from outside, which is what makes it
   * worse than the sweep's: the registry is left holding a session with no
   * processes under it, and that is exactly what a session whose agents have all
   * gone looks like. The next board then sweeps nothing and says nothing,
   * because from its side there was nothing to sweep. So the record is marked
   * with what it does not know, and the failure is said here while it happens.
   *
   * The launcher's pid IS known without a table — `record.pid`, in the registry
   * since the session started — and it is deliberately not written down as
   * something to kill. A recorded process is killed at the next start only if
   * the pid still carries the start time it was written down with, and that
   * token is precisely what an unread table cannot give: an entry without it
   * could only be matched on the pid alone, which is the killing-a-stranger
   * mistake this whole mechanism is built to refuse (T-0193, T-0202). It would
   * also be the wrong pid on the platform where this failure happens. The read
   * that times out is PowerShell's, and on Windows the launcher goes down with
   * the board — so the one entry that could be synthesised is the one already
   * dead by the time the sweep looks, while the agent underneath it, the process
   * that survives and goes on costing, is what no table means no knowledge of.
   * What can be recorded honestly is that the tree is unknown, and that is what
   * the next board reads (see restore).
   */
  function markTreeUnknown(reason) {
    scanFailures++;
    const blind = [];
    const stale = [];
    for (const taskId of children.keys()) {
      const record = records.get(taskId);
      if (!record) continue;
      // A session scanned once before keeps what that scan wrote, and those pids
      // do not go stale — the start time written with each is what identifies it
      // (see survivingLeftovers), so what is lost is only the children born
      // since. A session never scanned has nothing at all, and that is the half
      // this exists for.
      (record.descendants && record.descendants.length ? stale : blind).push(taskId);
      record.treeUnknown = true;
      record.treeReason = reason;
    }
    persist();
    const next = Math.min(scanBudget * 2, SCAN_MAX_TIMEOUT_MS);
    scanBudget = next;
    // Said at the 1st failure, then the 2nd, 4th, 8th and so on. Every one of
    // them would teach the reader to skip the message — under load they arrive
    // every couple of minutes for as long as the machine is busy — and saying it
    // once, which is what this used to do, is how a board writes nothing down
    // for an hour without a word after the first line. Doubling the silence
    // keeps it audible for the life of the board at some eight lines in eight
    // hours, and it is the shape T-0230 already gave the sweep's own ladder.
    if (!isPowerOfTwo(scanFailures)) return;
    if (scanFailures === 1) {
      logger.error(
        `session registry: the running processes could not be listed (${reason}) — ` +
          `${treeState(blind, stale)}. A board that dies without shutting down leaves its agents ` +
          'running, and the next board ends only what was written down for it (T-0193). ' +
          `Asking again in ${scanEvery}ms, with ${next}ms to answer in.`
      );
      return;
    }
    logger.error(
      `session registry: ${scanFailures} reads of the process table in a row have failed ` +
        `(${reason}) — ${treeState(blind, stale)}. The next read is given ${next}ms; the board ` +
        `goes on asking every ${scanEvery}ms.`
    );
  }

  // The last word said about the table was that it could not be read, and a
  // person who read that line has no other way to learn that it stopped being
  // true.
  function sayReadableAgain() {
    logger.warn(
      `session registry: the process table could be read again after ${scanFailures} failed ` +
        'attempt(s) — the processes of every running session are being written down again.'
    );
    scanFailures = 0;
    scanBudget = SCAN_TIMEOUT_MS;
  }

  // What the two halves cost differs, so they are named apart: one session has
  // nothing to find it by, the other has something that is merely older than it
  // is.
  function treeState(blind, stale) {
    const parts = [];
    if (blind.length) parts.push(`${blind.join(', ')}: nothing written down at all`);
    if (stale.length) parts.push(`${stale.join(', ')}: only what the last read that worked saw`);
    return parts.join('; ') || 'nothing is written down for this board';
  }

  // 1, 2, 4, 8 ... — "say it again, and then wait twice as long".
  function isPowerOfTwo(n) {
    return n > 0 && (n & (n - 1)) === 0;
  }

  function scheduleScan(delay) {
    if (scanTimer || !scanEvery) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
    // Never a reason for the board to stay up.
    if (typeof scanTimer.unref === 'function') scanTimer.unref();
  }

  function stopScan() {
    if (!scanTimer) return;
    clearTimeout(scanTimer);
    scanTimer = null;
  }

  /**
   * Ends what the previous board run left running. Only processes it wrote down
   * itself, in this project's registry, and only those still sitting at the pid
   * they were written down with AND started at the moment they were written down
   * with — see the module comment: that pair is the whole defence against
   * killing a stranger who has since been given the pid.
   *
   * Never silent — and that holds hardest for the run where it does nothing.
   * A board that quietly kills processes at every start is a board nobody can
   * debug; a board that quietly fails to is worse, because the person it left
   * paying for a dead board's agents has no way to learn that it happened. So
   * every attempt that cannot read the table says so, with the reason and with
   * what happens next.
   *
   * And it does not give up for the whole board run (T-0230). Its own reads are
   * a ladder of SWEEP_ATTEMPTS with a doubling wait; when that is spent the
   * leftovers are handed to the scan, which reads the table anyway. What the
   * returned promise reports is the ladder, not the leftovers: a board still
   * carrying stranded ones has `swept` resolved and `stranded` set.
   */
  async function sweep(leftovers) {
    const recorded = leftovers.flatMap((entry) => entry.processes);
    if (!scanEvery || !recorded.length) return { killed: [], checked: recorded.length };
    const nothing = { killed: [], checked: recorded.length };
    const startedAt = Date.now();
    let wait = sweepRetryEvery;
    for (let attempt = 1; ; attempt++) {
      const { rows, code, reason } = await readTable(SWEEP_TIMEOUT_MS);
      if (rows) return killLeftovers(leftovers, recorded, rows);
      // A machine with no process-table command is not going to grow one in half
      // a minute, and a second failure of that kind would only say the same
      // thing twice — the same reason isZombie() remembers it (stateQueryUnusable).
      // It is also the one failure the scan cannot get past either, since it
      // runs the same command, so there is nothing to hand on.
      const gone = code === 'missing';
      const again = attempt < SWEEP_ATTEMPTS && !gone;
      // Said in full once at each end and one line in between. The first message
      // is the one a person reads; repeating that paragraph five more times
      // would teach them to skip it, and saying nothing at all is the bug this
      // whole mechanism exists against.
      if (attempt === 1) {
        logger.error(
          `session registry: ${recorded.length} process(es) of the previous board run ` +
            `(${leftovers.map((e) => e.id).join(', ')}) may still be running, and the process table ` +
            `could not be read here (${reason}) — nothing was killed. ` +
            (again ? `Trying again in ${wait}ms.` : lastWord(gone))
        );
      } else if (again) {
        logger.error(
          `session registry: the process table still could not be read (${reason}) — attempt ` +
            `${attempt} of ${SWEEP_ATTEMPTS}, asking again in ${wait}ms.`
        );
      } else {
        logger.error(
          `session registry: the process table could not be read on any of ${attempt} ` +
            `attempts over ${Date.now() - startedAt}ms (${reason}) — the ` +
            `${recorded.length} process(es) named above were never checked. ` +
            lastWord(gone)
        );
      }
      if (!again) {
        if (!gone) strandLeftovers(leftovers, recorded);
        return nothing;
      }
      if (!(await sweepPause(wait))) {
        // The line above promised another attempt, and this board is not going
        // to make it. A promise dropped in silence is the shape of the whole bug.
        logger.error(
          'session registry: the board was stopped before the process table could be asked ' +
            `again — the ${recorded.length} process(es) above were never checked and were ` +
            'never killed.'
        );
        return nothing;
      }
      // The next read costs a subprocess, and it is worth one only while there
      // is still something to kill. `kill(pid, 0)` costs nothing and answers in
      // the safe direction: a pid it cannot resolve counts as alive (T-0202), so
      // this only ever ends the ladder when every recorded process has provably
      // gone — which is the other way this stops being the board's problem.
      if (!recorded.some((entry) => isProcessAlive(entry.pid))) {
        logger.warn(
          `session registry: the ${recorded.length} process(es) of the previous board run are ` +
            'not running any more — nothing was left to clean up.'
        );
        return nothing;
      }
      wait *= 2;
    }
  }

  function lastWord(gone) {
    return (
      'Check for them yourself: they are agents of a board that is gone, and they go on working ' +
      'and go on costing until something ends them.' +
      (gone
        ? ''
        : ' This board will not ask for the table again on its own; it re-checks them against ' +
          'the one it reads while a session of its own is running.')
    );
  }

  function killLeftovers(leftovers, recorded, rows) {
    const alive = survivingLeftovers(recorded, rows);
    if (!alive.length) return { killed: [], checked: recorded.length };
    const pids = alive.map((entry) => entry.pid);
    killPids(pids, { platform });
    logger.warn(
      `session registry: ${pids.length} process(es) of the previous board run were still running ` +
        `and have been killed — ${leftovers
          .map(
            (entry) =>
              `${entry.id}: ${entry.processes
                .filter((p) => pids.includes(p.pid))
                .map((p) => p.pid)
                .join(', ') || 'none'}`
          )
          .join('; ')}. A board that dies without shutting down cannot take its agents with it, ` +
        'so they are ended here instead.'
    );
    return { killed: pids, checked: recorded.length };
  }

  /**
   * What the sweep's own reads never got to check (T-0230). The scan reads the
   * table every SCAN_INTERVAL_MS while a session of this board is running, so
   * re-asking the question there costs no process at all — which is what lets it
   * go on being asked for the rest of the board's life instead of ending with the
   * ladder.
   *
   * The recorded pids do not go stale with the waiting: what guards them is the
   * start time each was written down with, and a pid handed to a stranger since
   * fails that comparison however long ago it was written (see survivingLeftovers).
   * They are held here rather than in the registry because restore() clears the
   * stored ones on purpose — they describe a board run that is over.
   */
  let stranded = null;

  function strandLeftovers(leftovers, recorded) {
    stranded = { leftovers, recorded };
  }

  // One table answers the question for good: a leftover is either still the
  // process it was written down as, or it never will be again. So this is cleared
  // whatever the answer turns out to be.
  function checkStranded(rows) {
    const { leftovers, recorded } = stranded;
    stranded = null;
    if (killLeftovers(leftovers, recorded, rows).killed.length) return;
    logger.warn(
      `session registry: the ${recorded.length} process(es) of the previous board run that could ` +
        'not be checked at start-up have now been — none of them is still the process it was ' +
        'written down as, so nothing was killed.'
    );
  }

  // The wait between two attempts at the table, and the one thing it must not do
  // is outlive the board: a runner that has been shut down has no business
  // killing anything half a minute later, and a promise left unresolved here is
  // a `swept` that never settles.
  let sweepWake = null;
  let sweepAbandoned = false;
  function sweepPause(ms) {
    return new Promise((resolve) => {
      if (sweepAbandoned) return resolve(false);
      const done = (go) => {
        clearTimeout(timer);
        sweepWake = null;
        resolve(go);
      };
      // Not unref'd, unlike the scan's timer, and the difference is the point:
      // the scan repeats for as long as the board lives and must never be the
      // reason it lives, while this is a bounded wait to finish one piece of
      // work — bounded by the ladder, which is why the sweep goes on asking for
      // free through the scan afterwards instead of holding the loop for the
      // board's whole life. Unref'd it is dropped whenever nothing else holds
      // the loop, and the retry then silently does not happen — which is the
      // very failure T-0224 fixed and the one this ladder could reintroduce five
      // times over. `stopSweep()` is what keeps it from outliving the board, and
      // it resolves the wait rather than just clearing it, so `swept` still
      // settles.
      const timer = setTimeout(() => done(true), ms);
      sweepWake = () => done(false);
    });
  }

  function stopSweep() {
    sweepAbandoned = true;
    if (sweepWake) sweepWake();
  }

  // What keeps a session's directory undeletable on Windows is the open log
  // file, not the child itself, and the stream is closed only after the child's
  // 'close' has drained into it — so tracking the streams covers both.
  //
  // `sources` is every pipe currently writing into that stream. It is needed
  // only by shutdown(): a pipe an escaped descendant inherited is precisely what
  // keeps the file open after the session is gone (T-0173), and closing it is
  // the only handle the board has left on that.
  function trackLog(stream) {
    const entry = {
      stream,
      sources: [],
      absorb(child) {
        entry.sources.push(child.stdout, child.stderr);
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream, { end: false });
      },
    };
    entry.closed = new Promise((resolve) => stream.once('close', resolve));
    openLogs.add(entry);
    entry.closed.then(() => openLogs.delete(entry));
    return entry;
  }

  // Gives up on the logs still open and closes them: the pipes first, so nothing
  // writes into a file that is going, then the file itself, because "the handle
  // is released" is the whole of what shutdown()'s promise says. Returns how many
  // there were — a number worth reporting, since every one of them means a
  // process outlived the board.
  function releaseLogs() {
    const stuck = openLogs.size;
    for (const entry of [...openLogs]) {
      for (const source of entry.sources) source.destroy();
      entry.stream.destroy();
    }
    return stuck;
  }

  // A listener that throws must not take a session's own bookkeeping with it:
  // the notification is a side channel, the registry is the truth.
  function notify(record) {
    if (!onChange) return;
    try {
      onChange(publicRecord(record));
    } catch (e) {
      logger.error(`session ${record.id}: change listener failed: ${e.message}`);
    }
  }

  function rememberFinished(taskId) {
    const previous = finishedOrder.indexOf(taskId);
    if (previous !== -1) finishedOrder.splice(previous, 1);
    finishedOrder.push(taskId);
    while (finishedOrder.length > finishedCap) {
      const evicted = finishedOrder.shift();
      if (!children.has(evicted)) records.delete(evicted);
    }
  }

  // "One session per task" asked of the file rather than of memory, because a
  // second board instance (another port, the same project) writes to the same
  // registry and two agents on one task/T-NNNN branch is what the rule exists to
  // prevent (T-0103). Read fresh: the answer changes without this process doing
  // anything. Our own sessions cannot match — `children` answered for them, and
  // reconcileSession() discounts records whose board is us.
  function runningElsewhere(taskId) {
    return readSessionRegistry(project).sessions.some(
      (r) => r.id === taskId && r.status === 'running'
    );
  }

  /**
   * Brings a worktree to the state the session expects to work in: a checkout
   * has no installed dependencies, so a project whose tests need any is
   * unbuildable there until its own command has run (T-0150).
   *
   * At most once per worktree. What records that is a stamp file beside the
   * worktree, not the worktree's existence: a preparation that failed leaves the
   * directory behind too, and keying on the directory would hand every later
   * session the same broken tree. A run that failed is retried; one that
   * succeeded is never repeated, because paying for an install on every session
   * of a task is what makes the feature too expensive to keep.
   *
   * Returns { ok: true } when there is nothing to do as well — an undeclared
   * command is the ordinary case and says nothing at all.
   */
  async function setUpWorktree(taskId, { worktree, created, log, profileValue }) {
    if (setupTemplate.disabledReason === 'not configured') return { ok: true };
    // Declared but unusable: starting the session anyway would put the agent in
    // exactly the unprepared tree this command exists to prevent.
    if (!setupTemplate.argv) {
      return {
        ok: false,
        reason: 'setup-failed',
        detail: `${SETUP_ENV} is unusable (${setupTemplate.disabledReason})`,
      };
    }
    const stamp = setupStampPath(project, taskId);
    if (created) {
      // A worktree deleted by hand takes its preparation with it; the stamp of
      // the previous one must not vouch for this one.
      try {
        fs.rmSync(stamp, { force: true });
      } catch {
        /* a stale stamp only costs a repeated install */
      }
    } else if (fs.existsSync(stamp)) {
      return { ok: true };
    }

    const text = String(setupCommand).trim();
    log.stream.write(`[briefboard] preparing the worktree (${SETUP_ENV}): ${text}\n`);
    const argv = substitutePlaceholders(setupTemplate.argv, {
      [PLACEHOLDER]: taskId,
      [PROFILE_PLACEHOLDER]: profileValue,
    });
    const result = await runSetupCommand(argv, {
      cwd: worktree,
      log,
      env: { ...process.env, [ROOT_ENV]: project },
      timeoutMs: setupTimeoutMs,
      track: setupChildren,
    });
    if (!result.ok) return result;
    try {
      atomicWrite(stamp, JSON.stringify({ command: text, at: new Date().toISOString() }, null, 2) + '\n');
    } catch (e) {
      logger.error(
        `session ${taskId}: recording the worktree setup failed: ${e.message} ` +
          '— it will run again on the next session of this task.'
      );
    }
    return { ok: true };
  }

  /**
   * Starts a session for `taskId`. Never throws and never rejects: a failure is
   * reported as { started: false, reason: 'error' } so the caller can still
   * answer its HTTP request. Resolves only once the OS has spawned the process
   * or refused to, because Node reports a bad command asynchronously and
   * 'error' would otherwise be a race.
   *
   * With { isolate: true } the session runs inside its own git worktree instead
   * of the shared checkout (T-0091). If that worktree cannot be prepared the
   * session does not start at all — running it in the shared checkout anyway is
   * the very outcome the option exists to prevent.
   *
   * `kind` picks which configured template to run ('briefing' | 'worker' |
   * 'orchestrator'). The review session is deliberately never isolated: it reads
   * the diff of a branch the WORKER created and writes its verdict to the shared
   * backlog, so a worktree of its own would put it on a copy of the repository
   * where neither of those is where it looks (T-0122).
   *
   * `profile` is the task's own field (T-0108). A value outside the declared list
   * refuses the session ('unknown-profile') instead of reaching the agent: a typo
   * in a profile silently passed to a command line is exactly what the list is
   * for. With no profiles declared the field is ignored entirely.
   */
  async function startSession(taskId, { isolate = false, kind = 'briefing', profile = '' } = {}) {
    const compiled = templates[kind];
    if (!compiled) return { started: false, reason: 'error' };
    if (!compiled.argv) return { started: false, reason: 'disabled' };
    // The route matches the id too; this module still refuses to interpolate
    // anything that is not a task id.
    if (!TASK_ID_RE.test(String(taskId))) return { started: false, reason: 'error' };
    const wanted = String(profile == null ? '' : profile).trim();
    const useProfiles = profiles.values.length > 0;
    if (useProfiles && wanted && !profiles.values.includes(wanted)) {
      logger.error(
        `session ${taskId}: profile "${wanted}" is not in ${PROFILES_ENV} ` +
          `(${profiles.values.join(', ')}) — the session was not started.`
      );
      return { started: false, reason: 'unknown-profile' };
    }
    const profileValue = useProfiles ? wanted || profiles.default : '';
    if (children.has(taskId)) return { started: false, reason: 'already-running' };
    if (runningElsewhere(taskId)) return { started: false, reason: 'already-running' };
    if (children.size >= max) return { started: false, reason: 'limit' };

    const startedAt = new Date();
    const logPath = path.join(logDir(), `${taskId}-${fileStamp(startedAt)}.log`);
    let out = null;
    let log = null;
    let child = null;
    try {
      fs.mkdirSync(logDir(), { recursive: true });
      out = fs.createWriteStream(logPath, { flags: 'a' });
      log = trackLog(out);
      out.on('error',(e) => logger.error(`session ${taskId}: log write failed: ${e.message}`));
    } catch (e) {
      logger.error(`session ${taskId}: failed to start: ${e.message}`);
      if (out) out.end(`[briefboard] failed to start session: ${e.message}\n`);
      return { started: false, reason: 'error' };
    }

    const failedSpawn = (e) => {
      const hint = spawnFailureHint(e, platform, envNames[kind]);
      logger.error(`session ${taskId}: failed to start: ${e.message}`);
      if (hint) logger.error(`session ${taskId}: ${hint}`);
      out.end(
        `[briefboard] failed to start session: ${e.message}\n` +
          (hint ? `[briefboard] ${hint}\n` : '')
      );
      return { started: false, reason: 'error' };
    };

    let cwd = project;
    let worktree = null;
    if (isolate) {
      const prepared = await prepareWorktree(gitBin, project, taskId);
      if (!prepared.ok) {
        logger.error(`session ${taskId}: isolation failed (${prepared.reason}): ${prepared.detail}`);
        out.end(`[briefboard] isolation failed (${prepared.reason}): ${prepared.detail}\n`);
        return { started: false, reason: prepared.reason };
      }
      cwd = prepared.path;
      worktree = prepared.path;

      const ready = await setUpWorktree(taskId, {
        worktree,
        created: prepared.created,
        log,
        profileValue,
      });
      if (!ready.ok) {
        const hint = ready.error ? spawnFailureHint(ready.error, platform, SETUP_ENV) : '';
        logger.error(`session ${taskId}: setup failed (${ready.reason}): ${ready.detail}`);
        if (hint) logger.error(`session ${taskId}: ${hint}`);
        out.end(
          `[briefboard] setup failed (${ready.reason}): ${ready.detail}\n` +
            (hint ? `[briefboard] ${hint}\n` : '')
        );
        return { started: false, reason: ready.reason };
      }
    }

    const before = taskSnapshot(project, taskId);

    try {
      const [file, ...args] = substitutePlaceholders(compiled.argv, {
        [PLACEHOLDER]: taskId,
        [PROFILE_PLACEHOLDER]: profileValue,
      });
      child = spawn(file, args, {
        cwd,
        // AGENTBOARD_ROOT in the environment, not in the prompt (T-0118): the
        // session's task data then goes to the SHARED checkout wherever its cwd
        // is, so `node tools/task.mjs status {id} review` needs no env prefix —
        // and one permission rule covers it. Asking the agent to type the prefix
        // made the rule match a literal string the agent was free to write
        // differently, and it twice wrote it otherwise (T-0107, T-0112): the work
        // was done and only the status write was blocked.
        env: { ...process.env, [ROOT_ENV]: project },
        stdio: ['ignore', 'pipe', 'pipe'], // headless: there is no TTY to interact with
        shell: false,
        detached: SPAWN_DETACHED, // see the constant: what stopping the session can reach
        windowsHide: true,
      });
    } catch (e) {
      return failedSpawn(e);
    }

    // A late 'error' (a failed kill, say) must not become an unhandled event.
    child.on('error', (e) => logger.error(`session ${taskId}: ${e.message}`));

    const spawnError = await new Promise((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (e) => resolve(e));
    });
    if (spawnError) return failedSpawn(spawnError);

    log.absorb(child);

    const record = {
      id: taskId,
      kind,
      // Where the work of an isolated session ended up (T-0117). Recorded rather
      // than recomputed from the id: the board must show what this run actually
      // used, and a session that ran in the shared checkout has neither.
      branch: worktree ? BRANCH_PREFIX + taskId : null,
      worktree,
      pid: child.pid,
      board: process.pid, // whose session this is; see reconcileSession
      startedAt: startedAt.toISOString(),
      logPath,
      status: 'running',
      exitCode: null,
      signal: null,
      endedAt: null,
      // True until the first scan writes the tree down, half a minute from now
      // (SCAN_INTERVAL_MS) — and that window is the documented limit of this
      // cleanup, a board dying inside it leaving a session nothing can be found
      // by. Recorded from the start so the next board can tell that session from
      // one whose processes were looked for and were all gone (T-0236).
      treeUnknown: true,
    };
    records.set(taskId, record);
    children.set(taskId, child);
    const stale = finishedOrder.indexOf(taskId);
    if (stale !== -1) finishedOrder.splice(stale, 1);
    scheduleScan(scanEvery);

    child.on('exit', (code, signal) => {
      record.status = 'exited';
      record.exitCode = code;
      record.signal = signal;
      record.endedAt = new Date().toISOString();
      record.descendants = []; // this session's processes are the board's business no longer
      // And with them goes the mark that they were never written down: the board
      // saw this session end, so what it does not know about its tree is nothing
      // the next board has to be warned about (T-0236).
      delete record.treeUnknown;
      delete record.treeReason;
      children.delete(taskId);
      if (!children.size) stopScan();
      rememberFinished(taskId);
      persist();
      notify(record);
    });
    // 'close' rather than 'exit': it fires once stdout/stderr are drained, so
    // the log holds everything the session printed — and the hint below lands
    // after it, as the last word of the log. Written whatever the exit code is:
    // a clean exit that changed nothing is the case this exists for.
    child.on('close', () => {
      if (!sessionChangedTask(before, taskSnapshot(project, taskId))) {
        out.write(emptyRunHint(taskId, envNames[kind]));
      }
      out.end();
    });
    // Once the log is written and closed, and not a moment earlier: the number
    // an agent reports is the last thing it prints, and until the stream is shut
    // the tail may not hold it yet. The run joins the per-task history here, with
    // whatever the declared extractor found in its own log (T-0116).
    out.once('close', () => {
      const tokens = tokensOf(record.logPath);
      if (tokens !== null) record.tokens = tokens;
      archive(record);
      persist();
      notify(record);
    });

    persist();
    notify(record);
    return { started: true, pid: child.pid, logPath };
  }

  function list() {
    return [...records.values()].map(publicRecord);
  }

  function get(taskId) {
    const record = records.get(taskId);
    return record ? publicRecord(record) : null;
  }

  /**
   * The end of a session's log, by TASK ID: the path comes from the registry and
   * from nowhere else, so no part of it can be supplied by a caller.
   *
   * Returns { ok: true, text, totalBytes, truncated } or { ok: false, reason }
   * with reason 'no-session' (nothing in the registry) / 'no-log' (the file is
   * gone or unreadable) — a missing file is an ordinary outcome here, not a fault.
   */
  function readLogTail(taskId, maxBytes = LOG_TAIL_BYTES) {
    const record = records.get(taskId);
    if (!record) return { ok: false, reason: 'no-session' };
    const tail = readTail(record.logPath, maxBytes);
    if (tail.ok) return tail;
    // A log that is simply gone is an ordinary outcome; anything else is worth
    // saying out loud once.
    if (tail.code !== 'ENOENT') logger.error(`session ${taskId}: reading the log failed: ${tail.error}`);
    return { ok: false, reason: 'no-log' };
  }

  /**
   * What every task the registry still knows about cost, keyed by task id
   * (T-0116): the runs it has for that task, summed. Recomputed on every call
   * because a running session's total grows while nothing happens.
   *
   * Both sources are used and de-duplicated by run: `records` holds the current
   * session of each task, `history` every finished one — a session that has just
   * ended is in both, and it is one session.
   */
  function costs(now = Date.now()) {
    const runs = new Map();
    for (const record of records.values()) runs.set(entryKey(record), historyEntry(record));
    for (const entry of history) runs.set(entryKey(entry), entry);
    const byTask = new Map();
    for (const entry of runs.values()) {
      if (!byTask.has(entry.id)) byTask.set(entry.id, []);
      byTask.get(entry.id).push(entry);
    }
    const out = {};
    for (const [id, entries] of byTask) {
      out[id] = summarizeSessions(id, entries, { dropped: dropped.get(id) || 0, now });
    }
    return out;
  }

  /**
   * Stops one running session. The registry is updated by the child's own 'exit'
   * handler, exactly as for a session that ended by itself, so there is no second
   * bookkeeping path to keep in sync.
   *
   * Returns { stopped: true } or { stopped: false, reason: 'no-session' |
   * 'not-running' }.
   */
  function stopSession(taskId) {
    const child = children.get(taskId);
    if (!child) {
      return { stopped: false, reason: records.has(taskId) ? 'not-running' : 'no-session' };
    }
    killChild(child);
    return { stopped: true };
  }

  /**
   * An orphaned agent still writing to the repository after the board is gone is
   * worse than an interrupted session. The kills stay synchronous; the returned
   * promise resolves once every session log is closed, for callers that must
   * know the files are released (tests deleting the project directory). Signal
   * handlers ignore it and exit at once — it never rejects.
   *
   * That wait is bounded in two stages (T-0173), because a log closes only when
   * EVERY process holding the session's stdout has let go: a descendant that
   * survived the kill inherited it, so unbounded the promise waits out that
   * descendant's whole life — measured at 20s, and nothing here made it shorter.
   * So the kill is escalated once, and then the board stops waiting and closes
   * the files itself rather than hanging on a process it can no longer reach.
   *
   * What it therefore does NOT promise, spelled out because a test asserted it
   * and failed under load in 11 runs of 12 (T-0206): that every session has been
   * reaped when this resolves. The bound above is precisely the case where one
   * has not been — the log was closed by the board rather than by the session
   * ending, so the record can still say `running` while the process is still
   * being killed. The stronger promise is not available at any price: keeping it
   * would mean waiting out a descendant the board can no longer reach, which is
   * the wait the bound exists to refuse. What is guaranteed instead is that the
   * board never gives up quietly — releaseLogs()'s warning names how many logs
   * it closed and why.
   */
  function shutdown() {
    stopScan();
    stopSweep();
    // Snapshotted before the first kill: a child's own 'exit' takes it out of
    // `children`, and the escalation has to reach the same processes.
    const killed = [...children.values(), ...setupChildren];
    // An install left running after the board is gone writes into the user's
    // worktree with nobody watching it — the same reason the sessions go.
    for (const child of killed) killChild(child);
    const closed = Promise.all([...openLogs].map((entry) => entry.closed));
    if (!openLogs.size) return closed;
    const timers = [
      setTimeout(() => {
        for (const child of killed) killHard(child);
      }, SHUTDOWN_KILL_MS),
      setTimeout(() => {
        const stuck = releaseLogs();
        if (stuck) {
          logger.warn(
            `session shutdown: ${stuck} session log(s) were still open ${SHUTDOWN_RELEASE_MS}ms after ` +
              'the kill — closing them here. A process that survived the kill is still running and ' +
              'still holds the session stdout it inherited.'
          );
        }
      }, SHUTDOWN_RELEASE_MS),
    ];
    return closed.finally(() => {
      for (const timer of timers) clearTimeout(timer);
    });
  }

  // The sweep is deliberately not awaited here: reading the process table costs
  // a subprocess, and a board that blocked its own start on it would answer no
  // request for as long as that took. That is also what lets the sweep wait out
  // a busy machine and come back to it (SWEEP_TIMEOUT_MS, SWEEP_RETRY_MS) — the
  // waiting is nobody's. `swept` is for the caller that has to know it finished —
  // a test, and nobody else so far — and what it reports is the sweep's own
  // reads: leftovers no read of them could check outlive it in `stranded`.
  const swept = sweep(restore()).catch((e) => {
    logger.error(`session registry: cleaning up after the previous board run failed: ${e.message}`);
    return { killed: [], checked: 0 };
  });

  return {
    swept,
    get enabled() {
      return templates.briefing.argv !== null;
    },
    get disabledReason() {
      return templates.briefing.disabledReason;
    },
    get workerEnabled() {
      return templates.worker.argv !== null;
    },
    get workerDisabledReason() {
      return templates.worker.disabledReason;
    },
    get orchestratorEnabled() {
      return templates.orchestrator.argv !== null;
    },
    get orchestratorDisabledReason() {
      return templates.orchestrator.disabledReason;
    },
    maxSessions: max,
    maxFinished: finishedCap,
    profiles: profiles.values,
    // Per kind, never merged: a template may use {profile} while another one
    // does not, and "used somewhere" would promise the choice an effect it has
    // only on some of the sessions (T-0121).
    get profileUsedBy() {
      return {
        briefing: templates.briefing.usesProfile,
        worker: templates.worker.usesProfile,
        orchestrator: templates.orchestrator.usesProfile,
      };
    },
    defaultProfile: profiles.default,
    logDir: logDir(),
    startSession,
    list,
    costs,
    get,
    readLogTail,
    stopSession,
    shutdown,
  };
}

module.exports = {
  createSessionRunner,
  resolveReviewCommand,
  REVIEW_ENV,
  LEGACY_REVIEW_ENV,
  readSessionRegistry,
  isProcessAlive,
  killChild,
  killHard,
  parseCommandTemplate,
  substituteId,
  substitutePlaceholders,
  parseProcessTable,
  processTableCommand,
  processStateCommand,
  TREE_KILLER,
  isZombieState,
  processTree,
  survivingLeftovers,
  readProcessTable,
  probeProcessTable,
  parseProfiles,
  compileTokenPattern,
  parseTokensMode,
  extractTokens,
  summarizeSessions,
  spawnFailureHint,
  PROFILES_ENV,
  TOKENS_ENV,
  TOKENS_MODE_ENV,
  TOKENS_MODES,
  SETUP_ENV,
  SETUP_TIMEOUT_MS,
  WORKTREE_ADD_TIMEOUT_MS,
  SHUTDOWN_KILL_MS,
  SHUTDOWN_RELEASE_MS,
  SCAN_INTERVAL_MS,
  SCAN_TIMEOUT_MS,
  SCAN_MAX_TIMEOUT_MS,
  SWEEP_TIMEOUT_MS,
  SWEEP_RETRY_MS,
  SWEEP_ATTEMPTS,
  ROOT_ENV,
  DEFAULT_MAX_SESSIONS,
  MAX_FINISHED,
  MAX_HISTORY,
  LOG_TAIL_BYTES,
  REGISTRY_FILE,
  REGISTRY_VERSION,
};
