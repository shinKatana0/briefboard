'use strict';

const fs = require('fs');
const path = require('path');

const STATUSES = ['backlog', 'open', 'ready', 'in_progress', 'review', 'done', 'cancelled'];
const PRIORITIES = ['Blocker', 'Critical', 'Major', 'Medium', 'Minor'];
// `external` (T-0092) is work we wait on from a third party - access, keys, an
// answer from the client, someone else's release. It exists so that waiting can
// be modelled as an ordinary task another task `depends` on, instead of a status
// or a free-text note the dependency graph cannot see.
const TASK_TYPES = ['feature', 'bug', 'external'];
const DEFAULT_TASK_TYPE = 'feature';

// The state graph of agents/PROTOCOL.md, and the single source of truth for what
// status change is permitted; the CLI enforces it (tools/task.mjs `status`).
const TRANSITIONS = {
  backlog: ['open', 'cancelled'],
  // `open -> backlog` (T-0141) exists because the only way back used to be
  // `cancelled`, which is terminal: a card pulled into Open by mistake, or one
  // whose answer is "not now", could be shelved only by burying it. Deliberately
  // no counterpart out of `ready` — that step is guarded by a written brief, and
  // undoing it is a different decision from putting a card back down.
  open: ['ready', 'backlog', 'cancelled'],
  ready: ['in_progress', 'cancelled'],
  // No `in_progress -> ready` either, and this absence is decided rather than
  // overlooked (T-0334): `ready` states that nobody has started the task, and
  // while `task/T-NNNN` exists with commits on it that statement is false — the
  // same class of untrue status the board's watchdog exists to catch. Written
  // down because an unexplained absence gets forced: an orchestrator on another
  // project forced this very edge twice in one session. What to reach for
  // instead:
  //   - the session died and the work stands -> `resume` (T-0333). It puts a
  //     worker back on the card and moves nothing, because the card is already
  //     where it belongs;
  //   - the round is abandoned -> `cancelled` plus a new card. That is a
  //     decision about work rather than a status correction, and it should look
  //     like one in the record.
  // `--force` stays the escape for a genuine mistake, and its being remarkable
  // every single time is the feature rather than the friction.
  in_progress: ['review', 'cancelled'],
  review: ['done', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};

// The fields this version understands; everything else field-shaped is unknown.
const KNOWN_FIELDS = ['type', 'status', 'created', 'closed', 'briefs', 'labels', 'depends', 'profile'];

// An unknown "- key: value" line survives a read-write cycle verbatim (T-0095).
// briefboard versions read each other's files, and before this rule an older
// parser silently deleted a field a newer one had written - measured on
// `- depends:`, which a downgrade to 0.1.x erased from every task on the first
// save, taking the dependency graph with it. Keeping unknown lines makes each
// future field addition non-destructive in both directions. The value is stored
// exactly as read: we do not know what it means and must not pretend otherwise.
// A repeated key follows the same "last one wins" rule as a known field, keeping
// the position of its first line.
function extraFields(fields) {
  const extra = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!KNOWN_FIELDS.includes(key)) extra[key] = value;
  }
  return extra;
}

// ---------- labels (T-0279) ----------
// The set of labels is implicit: a label exists while some task carries it,
// there is no registry, and creating one is typing a new name. So these rules
// are the whole contract, and they live here once because the parser, the CLI
// and POST /api/task/:id/labels all apply them - three copies of "trim, cap,
// dedupe" is how the three would come to disagree about "UI ".
const MAX_LABEL_LEN = 32;
// Keeps a card's label row bounded: measured at the board's 220px column, eight
// short names take three lines and push nothing off the card, while an
// unbounded list is a card nobody can read - and a bad request could send one.
const MAX_LABELS = 8;
// The comma is the list separator; CR/LF would end the "- labels:" line itself,
// exactly as a newline in a title ends the header line.
const LABEL_FORBIDDEN_RE = /[,\r\n]/;

// A list arrives either as the field's / the CLI argument's comma-separated
// text or as the endpoint's JSON array; both mean the same list.
function labelItems(value) {
  if (Array.isArray(value)) return value;
  return String(value == null ? '' : value).split(',');
}

// Lenient, for reading a file nobody validated: anything breaking the rules is
// dropped rather than thrown, the way parseBacklog defaults an unknown status.
// `validate` is what reports such a line to a human (server/validate.js).
//
// Names are compared as written, case-sensitively - `ui` and `UI` are two
// labels. Folding case would need a canonical display spelling and a rule for
// which of two spellings wins; the editor offering the set already in use is
// what actually keeps them from diverging.
function normalizeLabels(value) {
  const out = [];
  for (const item of labelItems(value)) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || name.length > MAX_LABEL_LEN || LABEL_FORBIDDEN_RE.test(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length === MAX_LABELS) break;
  }
  return out;
}

// Strict, for a caller who is about to write: it says what is wrong instead of
// silently storing something else. Throws a plain Error on the first violation;
// the CLI turns it into a refusal and the endpoint into a 400.
//
// Whitespace-only items are dropped rather than refused: they are what a
// trailing comma produces, in the CLI argument and in the field alike, and the
// duplicate rule is a collapse for the same reason.
function checkLabels(value) {
  if (value !== undefined && value !== null && !Array.isArray(value) && typeof value !== 'string') {
    throw new Error('labels must be an array of strings');
  }
  const out = [];
  for (const item of labelItems(value)) {
    if (typeof item !== 'string') throw new Error('labels must be an array of strings');
    const name = item.trim();
    if (!name) continue;
    if (LABEL_FORBIDDEN_RE.test(name)) {
      throw new Error(
        `"${name}" is not a label: a label may not contain a comma or a line break ` +
          '(the comma separates the list)'
      );
    }
    if (name.length > MAX_LABEL_LEN) {
      throw new Error(`"${name}" is longer than ${MAX_LABEL_LEN} characters`);
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > MAX_LABELS) {
    throw new Error(`a task carries at most ${MAX_LABELS} labels, got ${out.length}`);
  }
  return out;
}

const HEADER_RE = /^## (T-\d{4})\s*·\s*(Blocker|Critical|Major|Medium|Minor)\s*·\s*(.+)$/;
// The single definition of "this line is a field": the parser, the escaping on
// write, the unescaping on read and validate.js's raw scan all take it from
// here, because a second copy would move the fields/description boundary in one
// place only. A name must start with a letter, so an ordinary list item ("- 2:
// item") stays description; digits, "_" and "-" are allowed after it so that a
// future field name is not limited to letters - with letters only, "- due_date:
// ..." was not a field at all and sank into the description, out of reach of the
// unknown-field rule above (T-0097).
const FIELD_RE = /^- ([a-z][a-z0-9_-]*):\s*(.*)$/;
const BRIEF_ID_RE = /^T-\d{4}-\d{2}$/;
const TASK_ID_RE = /^T-\d{4}$/;

// A prerequisite in one of these statuses stops blocking its dependents. `done`
// is obvious; `cancelled` unblocks too, because a cancelled task will never
// arrive and a forever-blocked dependent is worse than a visible one built on a
// cancelled premise (T-0087 refinement, which is also why the UI marks a
// cancelled dependency distinctly instead of showing it as satisfied).
const DEPENDS_SATISFIED = ['done', 'cancelled'];

// Local date+time stamp "YYYY-MM-DD HH:MM:SS" (machine local time, not UTC), with
// no Intl / date library, per the project's zero-dependency style. Shared by the
// CLI and server.js so both write the exact same stamp format (T-0011).
const pad2 = (n) => String(n).padStart(2, '0');
function localStamp(d) {
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${date} ${time}`;
}
function nowStamp() {
  return localStamp(new Date());
}

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
    // A hand-edited file may have blank lines between the header and "- type:",
    // or between field lines (PROTOCOL.md item 1 allows manual edits). Pushing
    // one to desc would end the fields section, so every later "- key: value"
    // would leak into the description and the task would silently fall back to
    // default type/status/dates (T-0055).
    if (desc.length === 0 && line.trim() === '') {
      continue;
    }
    // Unescape a structure-lookalike line that serializeBacklog() escaped with a
    // leading backslash (see the matching comment there). Known, accepted
    // trade-off: description text that literally started with "\## " or with
    // "\- key: value" loses one leading backslash on round-trip.
    if (line.startsWith('\\## ') || (line.startsWith('\\- ') && FIELD_RE.test(line.slice(1)))) {
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
    type: TASK_TYPES.includes(t.fields.type) ? t.fields.type : DEFAULT_TASK_TYPE,
    status: STATUSES.includes(t.fields.status) ? t.fields.status : 'backlog',
    created: t.fields.created || '',
    closed: t.fields.closed && t.fields.closed !== '—' ? t.fields.closed : '',
    briefs: (t.fields.briefs || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => BRIEF_ID_RE.test(s)),
    labels: normalizeLabels(t.fields.labels),
    depends: (t.fields.depends || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => TASK_ID_RE.test(s)),
    // Never interpreted here: the set of legal values is declared by the user
    // (BRIEFBOARD_PROFILES) and checked where a session is started (T-0108).
    profile: (t.fields.profile || '').trim(),
    extra: extraFields(t.fields),
    description: t.description,
  }));
}

// What a FILE in doc/brief/ has to be called to be a brief: "<id>.md" or
// "<id>-<slug>.md", capturing the task id and the two-digit number so that a
// name yields the brief id it claims. The one definition of that notion in the
// codebase - findBriefFile() below matches by it, validate.js imports it -
// because two definitions answered differently: this one requires the .md
// extension, the prefix match findBriefFile used until T-0283 did not, so a
// T-0001-01-old.md.bak beside T-0001-01-real.md was served as the brief while
// validate, correctly, had no opinion about it at all.
//
// Everything else in doc/brief/ is left alone deliberately:
// tools/release-export.mjs stands a .gitkeep up in the emptied brief directory
// and the suite recognises a public tree BY it (tests/helpers/public-tree.js),
// so treating a file that is not a brief as one would break the release export.
// Notes, drafts under a name of their own, a README, an editor backup: same
// answer, none of them claim a brief id.
const BRIEF_FILE_RE = /^(T-\d{4})-(\d{2})(?:-[^\\/]*)?\.md$/;

// Resolve a brief id to its file in briefDir ("<id>.md" or "<id>-<slug>.md"),
// or null. Shared by server.js (GET /api/brief/:id) and validate.js (dangling
// brief-reference check) so both use identical lookup rules. The BRIEF_ID_RE
// guard also blocks path traversal: an id must match the strict "T-XXXX-YY"
// shape before it is ever concatenated into a filename.
function findBriefFile(briefDir, briefId) {
  if (!BRIEF_ID_RE.test(briefId)) return null;
  if (!briefDir || !fs.existsSync(briefDir)) return null;
  // Sorted before the pick, so that when two files answer to one id the board's
  // GET /api/brief/:id, `task.mjs link` and `validate` all name the SAME file
  // instead of whichever readdir happened to return first - an order that can
  // differ between two machines, and on one machine after a rename. Sorting
  // PICKS a file; it does not resolve the ambiguity. Only a human can do that,
  // and `validate` is what tells them the ambiguity exists (T-0275).
  const match = fs
    .readdirSync(briefDir)
    .sort()
    .find((f) => {
      // A candidate is a brief FILE claiming this id, not merely a name that
      // starts with it. Without the extension test a backup or a reject file
      // shadows the brief it was made from (T-0283), and since T-0275's sort it
      // shadows it consistently rather than intermittently.
      const m = BRIEF_FILE_RE.exec(f);
      return m !== null && `${m[1]}-${m[2]}` === briefId;
    });
  return match ? path.join(briefDir, match) : null;
}

// ---------- open questions of an agent session (T-0083) ----------

// A refinement session runs headless (T-0076): stdin is closed and there is no
// TTY, so it cannot ask a human anything. Its only channel is this section,
// appended to the task's own description while the task stays in `open`. The
// heading is one exact string on both sides - the session prompt shipped in the
// README tells the agent to write it, this constant is what recognizes it. It is
// English like every other token of the format ("- status:", "## T-NNNN"): the
// prose of a backlog is written in whatever language its project speaks, the
// format contract is not, and this one travels in a published README.
const SESSION_QUESTIONS_SECTION = 'Session questions';
const SESSION_QUESTIONS_HEADING = `### ${SESSION_QUESTIONS_SECTION}`;

// The section the board's answer endpoint appends under, as the name
// appendDescriptionSection() takes (the heading it writes is "### Answers").
// English for the same reason as the questions heading above.
const ANSWERS_SECTION = 'Answers';
const ANSWERS_HEADING = `### ${ANSWERS_SECTION}`;

// What the review session writes instead of a status (T-0122): what it read in
// the diff, what the tests did, and whether it would merge. It never sets `done`
// and never merges - both are judgements that stay with a human - so this
// section IS its whole output. English like the two headings above, for the same
// reason: it is part of the format contract and travels in a published README.
const REVIEW_VERDICT_SECTION = 'Review verdict';
const REVIEW_VERDICT_HEADING = `### ${REVIEW_VERDICT_SECTION}`;

// These are correspondence, and correspondence is chronological: every call
// opens a new section at the end, so which of them was written last is what
// says whose turn it is (T-0114). Every other heading - "Worker report",
// "Review comments" - is one document that later calls add to (T-0098).
//
// A verdict joins them for a reason of its own: a task returned for rework comes
// back to review with a different branch behind it, and merging the second
// verdict into the first would present a judgement of the old code as the
// current one.
//
// The rule belongs to the heading, not to a flag on the call: a flag the agent
// has to remember is the class of mistake we have already been bitten by twice
// (T-0107, T-0118). The heading it writes anyway.
const CHRONOLOGICAL_SECTIONS = [SESSION_QUESTIONS_SECTION, ANSWERS_SECTION, REVIEW_VERDICT_SECTION];

// The worker's report - the one section `tools/task.mjs show` leaves out by
// default (T-0161): reports are 63% of this backlog (267 KB of 423), and nobody
// who opens a task for its statement of work needs them. Two spellings, because
// old files carry both: the English heading the protocol names, and the Russian
// one written before the "English in code and GitHub docs" rule. The legacy form
// is recognized for reading only - nothing writes it any more.
//
// This project's own 77 legacy headings were renamed to the English form by a
// one-off pass (T-0166), and the legacy constant deliberately stayed: what was
// renamed is our data, and a user's backlog is not ours to rewrite. Dropping the
// constant would make every such heading read as ordinary description text, so
// `show` would print reports it is supposed to leave out. Do not "tidy" it away.
const WORKER_REPORT_SECTION = 'Worker report';
const LEGACY_WORKER_REPORT_SECTION = 'Отчёт воркера';
const WORKER_REPORT_SECTIONS = [WORKER_REPORT_SECTION, LEGACY_WORKER_REPORT_SECTION];

// Where a question can still be open: `open` is where the briefing session stops
// to ask (T-0083), `in_progress` where the worker session does (T-0101), and
// `review` where the review session does (T-0122). Nowhere else - answering never
// changes the status, so the marker is cleared by the session moving the task on,
// and the statuses past review are set by a human who has read the description.
//
// `review` was deliberately left out when the list was written (T-0101): back
// then awaitsAnswer() went by presence alone, so one question asked in
// `in_progress` would have kept the marker lit through review until `done`. The
// order rule of T-0114 retired that objection - the marker is out as soon as an
// answer is written below the questions - and without `review` here the review
// session would have the protocol on paper only: no marker on its card and an
// answer endpoint that refuses it with 409.
const ANSWER_STATUSES = ['open', 'in_progress', 'review'];

// The heading only counts on a line of its own: quoting it inside a sentence is
// talking about the protocol, not invoking it. The LAST such line is the one
// that matters - either section can stand more than once - and -1 means absent.
function lastHeadingLine(description, heading) {
  const lines = String(description == null ? '' : description).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === heading) return i;
  }
  return -1;
}

function hasSessionQuestions(description) {
  return lastHeadingLine(description, SESSION_QUESTIONS_HEADING) !== -1;
}

// How many verdicts a description carries, by the same line rule. A count and
// not a boolean because a second review round adds a second section, and the
// session runner tells "this run wrote a verdict" from "this run wrote nothing"
// by that difference (T-0109).
function countReviewVerdicts(description) {
  return String(description == null ? '' : description)
    .split('\n')
    .filter((line) => line.trim() === REVIEW_VERDICT_HEADING).length;
}

// Order, not presence (T-0114). An answer written below the questions closes
// them, so the marker is lit only while the questions section is the last of the
// two - otherwise a long-answered section lights the card again the moment the
// task passes back through one of ANSWER_STATUSES.
function awaitsAnswer(task) {
  if (!task || !ANSWER_STATUSES.includes(task.status)) return false;
  const asked = lastHeadingLine(task.description, SESSION_QUESTIONS_HEADING);
  return asked !== -1 && asked > lastHeadingLine(task.description, ANSWERS_HEADING);
}

// The line index a "### " section ends at: the next heading of the same or a
// higher level, or the end of the text. A deeper "#### " heading is part of it.
// One rule, used both by the append below and by the omission of T-0161 - two
// copies of "where does a section end" would eventually disagree.
function sectionEnd(lines, at) {
  const end = lines.findIndex((line, i) => i > at && /^#{1,3} \S/.test(line));
  return end === -1 ? lines.length : end;
}

// ---------- leaving a section out of a read (T-0161) ----------

// Which of `names` this line is the "### " heading of, or null. A heading counts
// only on a line of its own (lastHeadingLine's rule), and a decorated one -
// "### Worker report - rework after review 1 (2026-08-14)" - counts too: what
// follows the name is a label, not a different section. A name merely continued
// by a letter or a digit is a different heading and is kept.
function sectionHeadingName(line, names) {
  const text = line.trim();
  if (!/^### \S/.test(text)) return null;
  const title = text.slice(4).trim();
  return (
    names.find(
      (name) => title === name || (title.startsWith(name) && !/[\p{L}\p{N}]/u.test(title[name.length]))
    ) || null
  );
}

// The description without its worker-report sections, plus what was taken out.
// Callers MUST surface that second half: a read that quietly returns less is the
// failure this exists to avoid, not a smaller version of it.
function stripWorkerReports(description) {
  const source = String(description == null ? '' : description);
  const lines = source.split('\n');
  const kept = [];
  const headings = [];
  let sections = 0;
  for (let i = 0; i < lines.length; ) {
    const name = sectionHeadingName(lines[i], WORKER_REPORT_SECTIONS);
    if (!name) {
      kept.push(lines[i]);
      i++;
      continue;
    }
    sections++;
    if (!headings.includes(name)) headings.push(name);
    i = sectionEnd(lines, i);
  }
  const text = kept.join('\n').replace(/\s+$/, '');
  return {
    description: text,
    sections,
    headings,
    bytes: Buffer.byteLength(source) - Buffer.byteLength(text),
  };
}

// ---------- appending to a description (T-0098) ----------

// Add `text` under the "### <heading>" section of a task description: the section
// is created at the end when absent and reused when already there, so calling
// twice does not leave two "### Worker report" sections. The exception is
// CHRONOLOGICAL_SECTIONS, which always open a new section at the end.
//
// Append-only on purpose. A description carries refinement decisions, review
// notes and worker reports written by different agents at different times; a
// command that could overwrite them would eventually lose one to a typo.
function appendDescriptionSection(description, heading, text) {
  const name = String(heading == null ? '' : heading).trim();
  const title = `### ${name}`;
  const body = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const lines = String(description == null ? '' : description).split('\n');
  // A chronological section is never reused: a reply merged into the section it
  // replies to would leave no way to tell a closed round from an open one.
  const at = CHRONOLOGICAL_SECTIONS.includes(name)
    ? -1
    : lines.findIndex((line) => line.trim() === title);

  if (at === -1) {
    const head = lines.join('\n').replace(/\s+$/, '');
    return (head ? head + '\n\n' : '') + title + '\n' + body;
  }
  // Trailing blank lines belong to the gap before the next heading, not to the
  // section, so the new text goes above them.
  let end = sectionEnd(lines, at);
  while (end > at + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(end, 0, '', body);
  return lines.join('\n');
}

// ---------- dependencies (T-0087) ----------

function taskIndex(tasks) {
  return tasks instanceof Map ? tasks : new Map(tasks.map((t) => [t.id, t]));
}

// The single rule for "may this task be started": the ids of its prerequisites
// that are not closed yet. An empty array means the way is clear. Every caller
// (the CLI's ready -> in_progress guard, the board's blocked marker, and the
// server-side drag of T-0084) goes through this one function - two copies of
// the rule would drift apart.
//
// An id no task carries counts as blocking: an unresolvable prerequisite cannot
// be shown to be finished. validateBacklog() reports it as a broken reference.
function blockingDependencies(task, tasks) {
  const byId = taskIndex(tasks);
  return (task.depends || []).filter((id) => {
    const dep = byId.get(id);
    return !dep || !DEPENDS_SATISFIED.includes(dep.status);
  });
}

// Dependency cycles found in `tasks`, each as the id path that closes back on
// itself: ["T-0001", "T-0002", "T-0001"]. A self-dependency (T-0001 -> T-0001)
// is skipped here and reported separately, so one mistake yields one message.
//
// Depth-first search that marks a node finished once explored, so a node shared
// by several cycles is walked once and only one of those cycles is reported.
// That is deliberate: a cycle has to be broken by hand anyway, and re-running
// the check after the fix surfaces whatever is left.
function dependencyCycles(tasks) {
  const list = tasks instanceof Map ? [...tasks.values()] : tasks;
  const byId = taskIndex(list);
  const state = new Map(); // id -> 'visiting' | 'finished'
  const path = [];
  const cycles = [];
  const seen = new Set();

  const visit = (id) => {
    const task = byId.get(id);
    if (!task) return;
    state.set(id, 'visiting');
    path.push(id);
    for (const dep of task.depends || []) {
      if (dep === id) continue;
      if (state.get(dep) === 'visiting') {
        const cycle = path.slice(path.indexOf(dep)).concat(dep);
        // Same cycle reached from a different entry point = same rotation of
        // the same ids; key on the rotation starting at its smallest id.
        const ring = cycle.slice(0, -1);
        const start = ring.indexOf([...ring].sort()[0]);
        const key = ring.slice(start).concat(ring.slice(0, start)).join(' ');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!state.has(dep)) {
        visit(dep);
      }
    }
    path.pop();
    state.set(id, 'finished');
  };

  for (const task of list) if (!state.has(task.id)) visit(task.id);
  return cycles;
}

// Escape the description lines that parseBacklog() would otherwise read back as
// backlog structure rather than text:
//   - any "## " line, which a bare-substring HEADER_RE match would turn into a
//     phantom task, splitting this description in two (T-0040);
//   - a "- key: value" line in the LEADING field zone, which would become one of
//     the task's own fields and silently rewrite its status/type/dates (T-0080).
// The field zone is exactly the one parseBacklog() honours: it runs to the first
// non-blank line that is not field-shaped. Past it, "- note: ..." is an ordinary
// markdown bullet and stays untouched - escaping every field-shaped line would
// litter the backlog people read on GitHub with backslashes for no gain.
// Known, accepted trade-off: text that literally starts with "\## " or with
// "\- key: value" loses one leading backslash per round-trip.
function escapeDescription(description) {
  let inFieldZone = true;
  return description
    .split('\n')
    .map((line) => {
      if (inFieldZone) {
        if (FIELD_RE.test(line)) return `\\${line}`;
        if (line.trim() !== '') inFieldZone = false;
      }
      return line.startsWith('## ') ? `\\${line}` : line;
    })
    .join('\n');
}

const DEFAULT_PREAMBLE =
  '# Backlog\n\n<!-- Managed by agents. Format: agents/PROTOCOL.md. Prefer writing via tools/task.mjs -->\n';

// Everything above the first task header, in the shape serializeBacklog() takes
// it: the lines themselves, ending in one newline, with the blank line that
// separates them from the first task left to the serializer. Read back verbatim
// - a preamble is what a human wrote by hand, so it is preserved, never
// normalized and never added to (T-0167).
//
// Two different absences, and the difference is the whole point of returning
// null: `''` is "this file has tasks and no preamble", which is preserved as
// such, while null is "there is no file yet" and lets serializeBacklog() fall
// back to the default head, so a brand-new backlog is still born with one.
function parsePreamble(text) {
  const source = String(text == null ? '' : text);
  if (source.trim() === '') return null;
  const lines = source.split(/\r?\n/);
  const first = lines.findIndex((line) => HEADER_RE.test(line));
  const head = first === -1 ? lines.slice() : lines.slice(0, first);
  while (head.length && head[head.length - 1].trim() === '') head.pop();
  return head.length ? head.join('\n') + '\n' : '';
}

// `preamble` is compared against null, not tested for truthiness: '' means "no
// preamble", which is a thing a file can legitimately be, and only an omitted
// argument asks for the default.
function serializeBacklog(tasks, preamble) {
  const head = preamble == null ? DEFAULT_PREAMBLE : preamble;
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
      // Optional for the same reason as `depends` below, and doubly so: most
      // tasks carry no label at all.
      if (t.labels && t.labels.length) lines.push(`- labels: ${t.labels.join(', ')}`);
      // Written only when there is something to write: an unconditional line
      // would add an empty "- depends:" to every task in a file people read by
      // eye, and would rewrite every existing backlog on the first save.
      if (t.depends && t.depends.length) lines.push(`- depends: ${t.depends.join(', ')}`);
      // Optional for the same reason as `depends`: most tasks run with the
      // default profile, and an empty line on every one of them would rewrite
      // every existing backlog on the first save.
      if (t.profile) lines.push(`- profile: ${t.profile}`);
      for (const [key, value] of Object.entries(t.extra || {})) {
        lines.push(value === '' ? `- ${key}:` : `- ${key}: ${value}`);
      }
      if (t.description) {
        lines.push('', escapeDescription(t.description));
      }
      return lines.join('\n');
    })
    .join('\n\n');
  return (head ? head + '\n' : '') + body + '\n';
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
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const LOCK_BACKOFF_MS = 25;
// Machine-readable mark of "gave up waiting for the lock", so callers can tell
// contention from a real failure without matching on the message text.
const LOCK_TIMEOUT_CODE = 'ELOCKTIMEOUT';

// Anything unusable falls back to the default instead of throwing: a typo in an
// env var must not stop the board or the CLI from writing at all.
function resolveLockTimeout(raw) {
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS;
}

// Read once at load. The budget is configurable through the environment rather
// than a function argument because the writers that need a different one are
// separate OS processes (the tests spawn real `tools/task.mjs` and server.js
// children), and the environment is the only channel that reaches them.
const LOCK_ACQUIRE_TIMEOUT_MS = resolveLockTimeout(process.env.BRIEFBOARD_LOCK_TIMEOUT_MS);

// Synchronous sleep with zero dependencies. Both writers run straight-line
// synchronous code (readFileSync/writeFileSync), so a blocking wait is the
// simplest correct primitive; contention is rare and the lock is held only for
// the microscopic parse+serialize+rename of a small file.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows answers EPERM/EACCES/EBUSY where POSIX would succeed or say
// EEXIST/ENOENT: renaming over a target another handle is open on (the server's
// fs.watch, an antivirus scanner, a reader), and - measured in T-0089 - opening
// the lock file while another process is deleting it, because NTFS keeps an
// unlinked-but-still-open file visible in a "pending delete" state no open() can
// enter. Both are ordinary contention and are waited out rather than thrown; on
// POSIX these codes essentially never occur here, so the retry costs nothing.
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_MAX_RETRIES = 10;
const RENAME_RETRY_MS = 40; // 10 * 40ms = up to ~0.4s total before giving up
const LOCK_RELEASE_MAX_RETRIES = 5;
const LOCK_RELEASE_RETRY_MS = 20;

// Shared by server.js and tools/task.mjs. The rename is what makes the replace
// atomic - on both POSIX and NTFS a reader sees either file, never a half-write.
function atomicWrite(filePath, text) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      if (!TRANSIENT_FS_CODES.has(e.code) || attempt >= RENAME_MAX_RETRIES) throw e;
      sleepSync(RENAME_RETRY_MS);
    }
  }
}

// Age of the lock file, or null when it cannot be told right now (it vanished,
// or the platform is being transient about it).
function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

// True once the lock file is gone. Never throws: one caller is a finally, where
// an exception would replace fn()'s real result or its real error, and the other
// must keep waiting rather than fail. A lock that resists deletion is left for a
// later acquirer to steal by age.
function releaseLock(lockPath) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch (e) {
      // ENOENT: our lock had already been stolen as stale.
      if (e.code === 'ENOENT') return true;
      if (!TRANSIENT_FS_CODES.has(e.code) || attempt >= LOCK_RELEASE_MAX_RETRIES) return false;
      sleepSync(LOCK_RELEASE_RETRY_MS);
    }
  }
}

// Cross-process mutex around fn(), held as an O_EXCL `<targetPath>.lock` file.
function withFileLock(targetPath, fn) {
  const lockPath = targetPath + '.lock';
  // The lock lives next to the target, whose directory may not exist yet (e.g. a
  // brand-new project's doc/), and a missing parent dir would surface as an
  // acquire failure rather than as itself.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx'); // O_CREAT | O_EXCL | O_WRONLY
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && !TRANSIENT_FS_CODES.has(e.code)) throw e;
      // A steal that fails falls through to the wait: retrying it in a tight
      // loop would spin forever on a stale lock we are not allowed to delete.
      const ageMs = lockAgeMs(lockPath);
      if (ageMs !== null && ageMs > LOCK_STALE_MS && releaseLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        // The budget is named because it is the one thing the reader of this
        // message cannot see: it comes from BRIEFBOARD_LOCK_TIMEOUT_MS, which
        // reaches a separate writer process through the environment and is
        // invisible everywhere else. Saying it turns "we waited long enough"
        // into a fact the message carries — for a user reading the failure, and
        // for a test asserting the variable arrived instead of timing the child
        // (T-0184).
        const timeout = new Error(
          `could not acquire lock for ${targetPath} after ${LOCK_ACQUIRE_TIMEOUT_MS}ms ` +
            '(held by another process)'
        );
        timeout.code = LOCK_TIMEOUT_CODE;
        throw timeout;
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
    releaseLock(lockPath);
  }
}

// Locked read-modify-write of backlog.md: mutate(tasks) edits the array in
// place and its return value is passed back. The file is read *inside* the lock
// so the mutation always applies to the freshest snapshot. A throw from mutate
// leaves the file untouched - that is how a caller aborts a write when a
// precondition fails.
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
    atomicWrite(backlogPath, serializeBacklog(tasks, parsePreamble(text)));
    return result;
  });
}

// ---------- the closed-task archive (T-0156) ----------

// This backlog reached 660 KB, 88% of it tasks that are done or cancelled, and
// an agent reading the file pays ~165k tokens for it. `tools/task.mjs archive`
// moves the closed ones into a sibling file in the very same format, which
// parseBacklog() reads unchanged.
//
// The archive is read-only by construction: done and cancelled are terminal
// (TRANSITIONS), so an archived task never changes again and no endpoint ever
// writes there. Only the archive command itself does.
function archivePathFor(backlogPath) {
  const dir = path.dirname(backlogPath);
  const base = path.basename(backlogPath).replace(/\.md$/i, '');
  return path.join(dir, `${base}-archive.md`);
}

const ARCHIVE_PREAMBLE =
  '# Backlog archive\n\n<!-- Closed tasks moved out of backlog.md by `tools/task.mjs archive`.\n     Same format (agents/PROTOCOL.md), and never written to by anything else:\n     done and cancelled are terminal statuses. -->\n';

const CLOSED_STATUSES = ['done', 'cancelled'];

// The archive file's text, or '' when the project has no archive. Only a
// missing file is silent: an archive that exists and cannot be read must never
// be mistaken for an empty one, because the next id is allocated from it.
function readArchiveText(backlogPath) {
  try {
    return fs.readFileSync(archivePathFor(backlogPath), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

// The archived tasks, or [] when the project has no archive.
function readArchivedTasks(backlogPath) {
  return parseBacklog(readArchiveText(backlogPath));
}

// Move every closed task out of the backlog. `dryRun` reports what would move
// and writes nothing.
//
// Under the backlog's own lock, which is also what serializes two archive runs
// against each other: every writer of either file passes through it.
function archiveClosedTasks(backlogPath, { dryRun = false } = {}) {
  return withFileLock(backlogPath, () => {
    let text = '';
    try {
      text = fs.readFileSync(backlogPath, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const tasks = parseBacklog(text);
    const moved = tasks.filter((t) => CLOSED_STATUSES.includes(t.status));
    const kept = tasks.filter((t) => !CLOSED_STATUSES.includes(t.status));
    const archiveText = readArchiveText(backlogPath);
    const archived = parseBacklog(archiveText);
    const keptText = serializeBacklog(kept, parsePreamble(text));
    const result = {
      file: archivePathFor(backlogPath),
      moved: moved.map((t) => t.id),
      kept: kept.length,
      archived: archived.length + moved.length,
      bytesBefore: Buffer.byteLength(text),
      bytesAfter: Buffer.byteLength(keptText),
      dryRun,
    };
    if (dryRun || moved.length === 0) return result;
    // An id already in the archive is not appended twice: that is the state a
    // crash between the two writes below leaves behind, and re-running the
    // command is how it gets repaired.
    const archivedIds = new Set(archived.map((t) => t.id));
    const append = moved.filter((t) => !archivedIds.has(t.id));
    // The archive is written FIRST, deliberately. A crash between the two
    // writes then leaves a task in both files - which `validate` reports as a
    // duplicate id and this command repairs - rather than in neither, which
    // nothing could recover.
    // An existing archive keeps its own head; only the first run writes ours.
    const archivePreamble = parsePreamble(archiveText);
    atomicWrite(
      result.file,
      serializeBacklog(archived.concat(append), archivePreamble === null ? ARCHIVE_PREAMBLE : archivePreamble)
    );
    atomicWrite(backlogPath, keptText);
    return result;
  });
}

// Create a new task in backlog.md and return its id (e.g. "T-0042"). This is the
// single implementation of "allocate the next id and append a task": both
// tools/task.mjs (`add`) and server.js (POST /api/task) call it, so the CLI and
// the board can never drift apart when the format in agents/PROTOCOL.md changes.
// Normalization is what the CLI has always done; a blank title throws (a task
// with no title would serialize into a header the parser cannot read).
//
// The id is computed inside updateBacklog()'s cross-process lock, on the freshest
// snapshot of the file, so two concurrent creators can never hand out the same id.
function addTask(backlogPath, { title, type, priority, description, labels } = {}) {
  const cleanTitle = String(title == null ? '' : title).trim();
  if (!cleanTitle) throw new Error('title is required');
  // Absent versus given, and only the second one is an error: no type at all is
  // the ordinary call and still files a `feature`, but a value the caller typed
  // and got wrong is refused instead of replaced - replacing it wrote a task
  // under a type nobody asked for, exit 0, with `show` as the only sign (T-0286).
  // An empty string is a typed value, hence `== null` and not a falsiness test:
  // `--type ""` and a dangling `--type` are mistakes, not omissions.
  //
  // This is the same strict-writer/lenient-reader split as checkLabels() versus
  // normalizeLabels(): parseBacklog() goes on defaulting an unknown `- type:` to
  // `feature`, because reading a file someone else (or an older briefboard)
  // wrote must not fail on one bad line.
  //
  // The wording is validateNewTask()'s, so the CLI and POST /api/task say the
  // same thing about the same mistake.
  const cleanType = type == null ? DEFAULT_TASK_TYPE : type;
  if (!TASK_TYPES.includes(cleanType)) {
    throw new Error(`type must be one of: ${TASK_TYPES.join(', ')}`);
  }
  const cleanPriority = priority == null ? 'Medium' : priority;
  if (!PRIORITIES.includes(cleanPriority)) {
    throw new Error(`priority must be one of: ${PRIORITIES.join(', ')}`);
  }
  const cleanDescription = String(description == null ? '' : description).trim();
  // Strict like the title, lenient like the rest is not an option here: an
  // unwritable name must stop the creation instead of being quietly dropped, and
  // both callers already refuse it earlier with a message of their own (T-0282).
  // Absent stays the ordinary case — checkLabels(undefined) is the empty list,
  // and a task with no labels is not a format error.
  const cleanLabels = checkLabels(labels);
  return updateBacklog(backlogPath, (tasks) => {
    // Both files, or archiving would hand out T-0001 a second time: the ids of
    // the closed tasks are exactly the ones that left the backlog, and a
    // repeated id is silent and unfixable afterwards - `depends: T-0042` and
    // doc/brief/T-0042-*.md would each belong to two different tasks.
    //
    // Read inside updateBacklog's lock, on the same snapshot the new task is
    // appended to, so two concurrent creators still cannot collide. The archive
    // is only ever written under that same lock (archiveClosedTasks).
    const maxId = tasks
      .concat(readArchivedTasks(backlogPath))
      .reduce((m, t) => Math.max(m, Number(t.id.slice(2))), 0);
    const newId = 'T-' + String(maxId + 1).padStart(4, '0');
    tasks.push({
      id: newId,
      priority: cleanPriority,
      title: cleanTitle,
      type: cleanType,
      status: 'backlog',
      created: nowStamp(),
      closed: '',
      briefs: [],
      labels: cleanLabels,
      depends: [],
      profile: '',
      extra: {},
      description: cleanDescription,
    });
    return newId;
  });
}

module.exports = {
  parseBacklog,
  parsePreamble,
  serializeBacklog,
  DEFAULT_PREAMBLE,
  ARCHIVE_PREAMBLE,
  nowStamp,
  localStamp,
  STATUSES,
  PRIORITIES,
  TASK_TYPES,
  DEFAULT_TASK_TYPE,
  KNOWN_FIELDS,
  MAX_LABEL_LEN,
  MAX_LABELS,
  normalizeLabels,
  checkLabels,
  TRANSITIONS,
  HEADER_RE,
  FIELD_RE,
  BRIEF_ID_RE,
  BRIEF_FILE_RE,
  TASK_ID_RE,
  DEPENDS_SATISFIED,
  SESSION_QUESTIONS_SECTION,
  SESSION_QUESTIONS_HEADING,
  ANSWERS_SECTION,
  ANSWERS_HEADING,
  REVIEW_VERDICT_SECTION,
  REVIEW_VERDICT_HEADING,
  CHRONOLOGICAL_SECTIONS,
  WORKER_REPORT_SECTION,
  LEGACY_WORKER_REPORT_SECTION,
  WORKER_REPORT_SECTIONS,
  stripWorkerReports,
  ANSWER_STATUSES,
  awaitsAnswer,
  hasSessionQuestions,
  countReviewVerdicts,
  appendDescriptionSection,
  blockingDependencies,
  dependencyCycles,
  findBriefFile,
  atomicWrite,
  withFileLock,
  TRANSIENT_FS_CODES,
  updateBacklog,
  addTask,
  CLOSED_STATUSES,
  archivePathFor,
  readArchivedTasks,
  archiveClosedTasks,
  LOCK_TIMEOUT_CODE,
  DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
  resolveLockTimeout,
};
