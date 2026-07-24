'use strict';

const fs = require('fs');
const path = require('path');

const STATUSES = ['backlog', 'open', 'ready', 'in_progress', 'review', 'done', 'cancelled'];
const PRIORITIES = ['Blocker', 'Critical', 'Major', 'Medium', 'Minor'];

// Allowed lifecycle transitions, mirroring the state graph in agents/PROTOCOL.md:
//   backlog -> open -> ready -> in_progress -> review -> done
//   (any non-terminal) -> cancelled
//   review -> in_progress (when review is rejected)
// This is the single source of truth for what status change is permitted; the
// task CLI enforces it (see tools/task.mjs `status`). Terminal statuses
// (done/cancelled) have no outgoing transitions.
const TRANSITIONS = {
  backlog: ['open', 'cancelled'],
  open: ['ready', 'cancelled'],
  ready: ['in_progress', 'cancelled'],
  in_progress: ['review', 'cancelled'],
  review: ['done', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};

const HEADER_RE = /^## (T-\d{4})\s*·\s*(Blocker|Critical|Major|Medium|Minor)\s*·\s*(.+)$/;
const FIELD_RE = /^- ([a-z]+):\s*(.*)$/;
const BRIEF_ID_RE = /^T-\d{4}-\d{2}$/;

// Local date+time stamp "YYYY-MM-DD HH:MM:SS" (machine local time, not UTC).
// No Intl / date libraries - Date getters only, per project's zero-dependency
// style. Shared by tools/task.mjs (CLI) and server.js (POST /api/task/:id/cancel)
// so both use the exact same stamp format (introduced in T-0011).
const pad2 = (n) => String(n).padStart(2, '0');
function nowStamp() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${date} ${time}`;
}

/** Parse backlog.md text into an array of task objects. */
function parseBacklog(text) {
  const tasks = [];
  let cur = null;
  let desc = [];

  const flush = () => {
    if (cur) {
      cur.description = desc.join('\n').trim();
      tasks.push(cur);
    }
    cur = null;
    desc = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const h = line.match(HEADER_RE);
    if (h) {
      flush();
      cur = { id: h[1], priority: h[2], title: h[3].trim(), fields: {} };
      continue;
    }
    if (!cur) continue; // preamble before first task
    const f = line.match(FIELD_RE);
    if (f && desc.length === 0) {
      cur.fields[f[1]] = f[2].trim();
      continue;
    }
    // While still in the fields section (no description accumulated yet), skip
    // blank lines instead of treating them as the start of the description. A
    // human/agent may insert a blank line between the "## T-XXXX" header and
    // "- type:", or between field lines, for readability (PROTOCOL.md item 1
    // allows manual markdown edits). If such a blank line were pushed to desc,
    // desc.length would become 1 and every subsequent "- key: value" would stop
    // being recognized as a field and leak into the description, silently
    // defaulting the task's type/status/dates (T-0055). Blank lines INSIDE the
    // description (desc.length > 0) still fall through and are preserved.
    if (desc.length === 0 && line.trim() === '') {
      continue;
    }
    // Unescape a "## "-lookalike line that serializeBacklog() escaped with a
    // leading backslash (see the matching comment there). Known, accepted
    // trade-off: description text that literally started with "\## " in the
    // original (backslash followed by "## ") loses one leading backslash on
    // round-trip - considered acceptable, see serializeBacklog().
    if (line.startsWith('\\## ')) {
      desc.push(line.slice(1));
      continue;
    }
    desc.push(line);
  }
  flush();

  return tasks.map((t) => ({
    id: t.id,
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'Medium',
    title: t.title,
    type: t.fields.type === 'bug' ? 'bug' : 'feature',
    status: STATUSES.includes(t.fields.status) ? t.fields.status : 'backlog',
    created: t.fields.created || '',
    closed: t.fields.closed && t.fields.closed !== '—' ? t.fields.closed : '',
    briefs: (t.fields.briefs || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => BRIEF_ID_RE.test(s)),
    description: t.description,
  }));
}

// Resolve a brief id to its file in briefDir: a file named exactly "<id>.md",
// or any file starting with "<id>-" (e.g. "T-0052-01-slug.md"). Returns the
// absolute path or null. Shared by server.js (GET /api/brief/:id) and
// validate.js (dangling brief-reference check) so both use identical lookup
// rules. The BRIEF_ID_RE guard also blocks path traversal: an id must match the
// strict "T-XXXX-YY" shape before it is ever concatenated into a filename.
function findBriefFile(briefDir, briefId) {
  if (!BRIEF_ID_RE.test(briefId)) return null; // also guards against path traversal
  if (!briefDir || !fs.existsSync(briefDir)) return null;
  const match = fs
    .readdirSync(briefDir)
    .find((f) => f === briefId + '.md' || f.startsWith(briefId + '-'));
  return match ? path.join(briefDir, match) : null;
}

/** Serialize task objects back into backlog.md text (used by the CLI). */
function serializeBacklog(tasks, preamble) {
  const head =
    preamble ||
    '# Backlog\n\n<!-- Managed by agents. Format: agents/PROTOCOL.md. Prefer writing via tools/task.mjs -->\n';
  const body = tasks
    .map((t) => {
      const lines = [
        `## ${t.id} · ${t.priority} · ${t.title}`,
        `- type: ${t.type}`,
        `- status: ${t.status}`,
        `- created: ${t.created}`,
        `- closed: ${t.closed || '—'}`,
        `- briefs: ${t.briefs.join(', ')}`,
      ];
      if (t.description) {
        // Escape any description line that looks like a markdown H2 header
        // ("## ..."), so parseBacklog() can never mistake it for the start of
        // a new task (a bare-substring HEADER_RE match would otherwise split
        // the current task's description and leak its tail into a phantom
        // task - see T-0040). Deliberately broad ("starts with '## '"), not
        // limited to a full HEADER_RE match: cheaper to check and safer,
        // since any "## " line is escaped consistently regardless of whether
        // it happens to also match the full task-header pattern.
        // Known, accepted trade-off: description text that already starts
        // with a literal "\## " (backslash + "## ") will lose one leading
        // backslash on round-trip (see the matching unescape in
        // parseBacklog()). Considered rare enough to be acceptable.
        const escapedDescription = t.description
          .split('\n')
          .map((line) => (line.startsWith('## ') ? `\\${line}` : line))
          .join('\n');
        lines.push('', escapedDescription);
      }
      return lines.join('\n');
    })
    .join('\n\n');
  return head + '\n' + body + '\n';
}

// ---------- concurrency-safe writes ----------
// backlog.md is written by several *separate OS processes* at once (server.js's
// POST /api/task/:id/cancel and every `node tools/task.mjs` the worker and
// orchestrator run). A plain read-modify-write loses updates: a writer built on
// a stale snapshot silently overwrites another writer's changes. The helpers
// below make the whole read-modify-write mutually exclusive across processes via
// an O_EXCL lock file, and keep the atomic tmp+rename write in one shared place.

// A lock older than this is treated as abandoned (its holder crashed while
// holding it). Hold time for a real op is a few ms, so 10s only ever trips on a
// genuinely dead holder.
const LOCK_STALE_MS = 10000;
// Give up acquiring after this long and surface a clear error rather than hang.
const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
// Sleep between acquisition attempts while another process holds the lock.
const LOCK_BACKOFF_MS = 25;

// Synchronous sleep with zero dependencies. Both writers run straight-line
// synchronous code (readFileSync/writeFileSync), so a blocking wait is the
// simplest correct primitive; contention is rare and the lock is held only for
// the microscopic parse+serialize+rename of a small file.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows a rename over an existing target fails transiently while another
// handle is open on it (the server's fs.watch, an antivirus scanner, or a reader
// briefly holding backlog.md). The OS surfaces this as EPERM/EACCES/EBUSY.
// withFileLock serializes our own writers, but nothing else, so we retry the
// rename a few times, giving the foreign handle a moment to close. On POSIX these
// codes essentially never occur here, so the retry is harmless there.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_MAX_RETRIES = 10;
const RENAME_RETRY_MS = 40; // 10 * 40ms = up to ~0.4s total before giving up

// Atomic file replace: write a sibling .tmp then rename over the target (atomic
// on both POSIX and NTFS). Shared by server.js and tools/task.mjs.
function atomicWrite(filePath, text) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, text);
  // Retry only the rename, and only on the transient Windows codes above; any
  // other error (or exhausting the retries) rethrows the last error unchanged.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      if (!RENAME_RETRY_CODES.has(e.code) || attempt >= RENAME_MAX_RETRIES) throw e;
      sleepSync(RENAME_RETRY_MS);
    }
  }
}

// Cross-process mutex around fn(): exclusively create `<targetPath>.lock`
// (O_EXCL), run fn while holding it, always release it in finally. If the lock
// is already held, steal it when it looks abandoned (older than LOCK_STALE_MS),
// otherwise back off and retry until LOCK_ACQUIRE_TIMEOUT_MS elapses.
function withFileLock(targetPath, fn) {
  const lockPath = targetPath + '.lock';
  // The lock lives next to the target, whose directory may not exist yet (e.g. a
  // brand-new project's doc/). Create it first so openSync fails only on EEXIST
  // (lock already held), never on a missing parent dir.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx'); // O_CREAT | O_EXCL | O_WRONLY
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let ageMs;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // released between open and stat
        throw statErr;
      }
      if (ageMs > LOCK_STALE_MS) {
        // Steal an abandoned lock, then retry immediately.
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`could not acquire lock for ${targetPath} (held by another process)`);
      }
      sleepSync(LOCK_BACKOFF_MS);
    }
  }
  try {
    // pid + timestamp: diagnostics, and lets a future acquirer age the lock.
    fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // ENOENT: our lock had been stolen as stale
    }
  }
}

// Locked read-modify-write of backlog.md. Reads the file *inside* the lock so
// the mutation always applies to the freshest snapshot, then atomically writes
// the serialized result. mutate(tasks) edits the array in place; its return
// value is passed back to the caller. If mutate throws, the file is left
// untouched (used to abort a write when a precondition fails) and the lock is
// still released.
function updateBacklog(backlogPath, mutate) {
  return withFileLock(backlogPath, () => {
    let text = '';
    try {
      text = fs.readFileSync(backlogPath, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const tasks = parseBacklog(text);
    const result = mutate(tasks);
    atomicWrite(backlogPath, serializeBacklog(tasks));
    return result;
  });
}

module.exports = {
  parseBacklog,
  serializeBacklog,
  nowStamp,
  STATUSES,
  PRIORITIES,
  TRANSITIONS,
  HEADER_RE,
  FIELD_RE,
  BRIEF_ID_RE,
  findBriefFile,
  atomicWrite,
  withFileLock,
  updateBacklog,
};
