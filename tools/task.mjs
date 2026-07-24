#!/usr/bin/env node
/**
 * task.mjs — CLI for agents. Guarantees PROTOCOL.md format and atomic writes.
 *
 *   node tools/task.mjs add --type feature|bug --priority Blocker|Critical|Major|Medium|Minor --title "..." [--desc "..."]
 *   node tools/task.mjs status T-0007 <backlog|open|ready|in_progress|review|done|cancelled> [--force]
 *       # transition must follow the lifecycle graph (server/parser.js TRANSITIONS);
 *       # --force allows any transition between valid statuses (prints a WARNING),
 *       # but never bypasses the "ready requires a brief" invariant.
 *   node tools/task.mjs brief T-0007 <slug>          # creates doc/brief/T-0007-NN-slug.md and links it
 *   node tools/task.mjs show T-0007
 *   node tools/task.mjs list [--status ready]
 *   node tools/task.mjs validate                     # structural check of doc/backlog.md (see server/validate.js)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseBacklog, nowStamp, STATUSES, PRIORITIES, TRANSITIONS, updateBacklog } = require('../server/parser.js');

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// AGENTBOARD_ROOT points to the project whose doc/ we edit (defaults to the installation itself)
const ROOT = process.env.AGENTBOARD_ROOT ? path.resolve(process.env.AGENTBOARD_ROOT) : TOOL_ROOT;
const BACKLOG = path.join(ROOT, 'doc', 'backlog.md');
const BRIEF_DIR = path.join(ROOT, 'doc', 'brief');

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

// Read-only load (list/show); mutating commands read inside updateBacklog's lock.
function readTasks() {
  if (!fs.existsSync(BACKLOG)) return [];
  return parseBacklog(fs.readFileSync(BACKLOG, 'utf8'));
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    // Take argv[i+1] as the value ONLY if it exists and is not itself a flag.
    // Otherwise the value is '' (boolean-style flag) and the next token is left
    // for its own iteration - so `add --title --priority Major` no longer makes
    // title="--priority" and silently drops Major. Required value-flags (e.g.
    // --title) then fall through to their explicit `if (!f.x) die(...)` checks.
    const next = argv[i + 1];
    flags[argv[i].slice(2)] = next !== undefined && !next.startsWith('--') ? next : '';
  }
  return flags;
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
    if (e instanceof CliError) die(e.message);
    throw e;
  }
}

switch (cmd) {
  case 'add': {
    const f = parseFlags(rest);
    if (!f.title) die('--title is required');
    const type = f.type === 'bug' ? 'bug' : 'feature';
    const priority = PRIORITIES.includes(f.priority) ? f.priority : 'Medium';
    const id = withUpdate((tasks) => {
      const maxId = tasks.reduce((m, t) => Math.max(m, Number(t.id.slice(2))), 0);
      const newId = 'T-' + String(maxId + 1).padStart(4, '0');
      tasks.push({
        id: newId, priority, title: f.title.trim(), type,
        status: 'backlog', created: today(), closed: '',
        briefs: [], description: (f.desc || '').trim(),
      });
      return newId;
    });
    console.log(id);
    break;
  }

  case 'status': {
    const [id, status] = rest;
    const f = parseFlags(rest);
    const force = 'force' in f;
    if (!STATUSES.includes(status)) die(`status must be one of: ${STATUSES.join(', ')}`);
    withUpdate((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) fail(`task ${id} not found`);
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
      t.status = status;
      t.closed = status === 'done' || status === 'cancelled' ? today() : '';
    });
    console.log(`${id} -> ${status}`);
    break;
  }

  case 'brief': {
    const [id, slugRaw] = rest;
    const slug = (slugRaw || 'brief').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const file = withUpdate((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) fail(`task ${id} not found`);
      const nn = String(t.briefs.length + 1).padStart(2, '0');
      const briefId = `${id}-${nn}`;
      const outFile = path.join(BRIEF_DIR, `${briefId}-${slug}.md`);
      fs.mkdirSync(BRIEF_DIR, { recursive: true });
      fs.writeFileSync(
        outFile,
        `# ${briefId} · ${t.title}\n\n## Context\n\n## Solution\n\n## Scope\n\n## Acceptance criteria\n- [ ] \n`
      );
      t.briefs.push(briefId);
      return outFile;
    });
    console.log(file);
    break;
  }

  case 'show': {
    const [id] = rest;
    const t = readTasks().find((x) => x.id === id) || die(`task ${id} not found`);
    console.log(JSON.stringify(t, null, 2));
    break;
  }

  case 'list': {
    const f = parseFlags(rest);
    const tasks = readTasks();
    const filtered = f.status ? tasks.filter((t) => t.status === f.status) : tasks;
    for (const t of filtered)
      console.log(`${t.id}  ${t.priority}  ${t.status.padEnd(11)}  ${t.title}`);
    break;
  }

  case 'validate': {
    const { validateBacklog } = require('../server/validate.js');
    const text = fs.existsSync(BACKLOG) ? fs.readFileSync(BACKLOG, 'utf8') : '';
    const errors = validateBacklog(text, BRIEF_DIR);
    if (errors.length === 0) {
      console.log('OK');
      process.exit(0);
    }
    for (const e of errors) console.error(e);
    process.exit(1);
    break;
  }

  default:
    console.log('commands: add | status | brief | show | list | validate  (see the file header)');
}
