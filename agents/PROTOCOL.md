# PROTOCOL.md — file format contract

This document is the single source of truth about the format. Any agent (orchestrator, worker)
must follow it when writing to `doc/backlog.md` and `doc/brief/`.

## 1. The doc/backlog.md file

Each task is a section that starts with a level-two header of strictly this form:

```
## T-0007 · Critical · Short task title
- type: feature
- status: ready
- created: 2026-07-23
- closed: —
- briefs: T-0007-01, T-0007-02
- depends: T-0005, T-0006

Free-form task description in markdown. May be multi-line,
contain lists, code, etc. Ends at the next `## T-...`.
```

### Fields

| Field      | Values                                                                |
|------------|-----------------------------------------------------------------------|
| `T-NNNN`   | ID — a continuous sequence, 4 digits with leading zeros. Never reused, and the sequence spans the archive as well (see §1a): the next ID is one past the highest in `doc/backlog.md` **and** `doc/backlog-archive.md`. |
| `Blocker\|Critical\|Major\|Medium\|Minor` | Priority in decreasing order of urgency: Blocker blocks everything, Critical is critical, Major is important, Medium is normal medium urgency, Minor is low. |
| `type`     | `feature` \| `bug` \| `external`. `external` is work owned by a third party — access, keys, an answer from the client, someone else's release: we cannot schedule it, we can only wait for it. Anything unknown or missing reads back as `feature`. |
| `status`   | `backlog` \| `open` \| `ready` \| `in_progress` \| `review` \| `done` \| `cancelled` |
| `created`  | Date and time of creation, `YYYY-MM-DD HH:MM:SS` (machine local time). Earlier versions wrote the date alone, so `YYYY-MM-DD` is accepted as well; anything else is an error. |
| `closed`   | Date and time of completion/cancellation, same two shapes as `created`; while not closed — the `—` character. Set in exactly the closing statuses: `done` and `cancelled` carry a date, every other status carries `—`. `tools/task.mjs validate` checks both directions (T-0170). |
| `briefs`   | Comma-separated list of brief IDs; if there are no briefs — empty.     |
| `depends`  | Comma-separated list of task IDs this task cannot start before. **Optional line: it is written only when the list is non-empty**, so a task with no prerequisites has no `depends` line at all. Set it with `tools/task.mjs depends`. |
| `profile`  | The run profile of this task's agent sessions — one value out of the list the USER declares in `BRIEFBOARD_PROFILES`. **Optional line: written only when non-empty**; empty means "as usual", i.e. the first declared profile. Set it with `tools/task.mjs profile`. briefboard never interprets the value: it checks that it is in the declared list and substitutes it into the command template as `{profile}`, exactly as it does `{id}`. What a profile *means* — a model, a reasoning level, another agent — belongs to whoever wrote that template. A value outside the list does not start a session at all. |

### The shape of a field line (T-0097)

A field is a line `- name: value` at the very start of the task, before the first non-blank
line that is not field-shaped. The name is lowercase: it starts with a Latin letter `a-z` and
continues with letters, digits, `_` and `-` (`due_date`, `sprint-2` are valid names; `Owner`,
`2`, `_owner` are not). The leading letter is what keeps an ordinary markdown bullet — `- 2:
list item` — out of the fields: it stays description text. The value is everything after the
colon, trimmed, and may be empty.

Anything not of that shape is description, and this boundary is the same for the parser, the
escaping rules below and `tools/task.mjs validate`.

### Unknown fields (T-0095)

The table above is the whole set of fields briefboard understands. A `- key: value` line
carrying any other key is kept, not dropped: it is read as it is written (trimmed, never
interpreted) and written back after the known fields, in the order it appeared. A repeated
key behaves like a known one — the last line wins, at the position of the first.

This exists for compatibility between versions, in both directions. briefboard versions read
each other's files: before this rule, a version that did not know a field silently deleted it
on the first save — measured on `- depends:`, which a downgrade from 0.2.0 to 0.1.x erased
from every task, taking the dependency graph with it. Preserving unknown lines makes each
future field addition non-destructive.

This is **not** an invitation to invent fields. The format contract is this document: a field
nobody here defines is invisible to the CLI, to the board and to `validate`, and no tooling
will ever act on it. Adding a real field means adding it here first.

### The preamble (T-0167)

Everything above the first `## T-NNNN` header is the **preamble** — the region the format
leaves to the file's owner. Anything markdown allows may stand there: a title, a note to
whoever opens the file, a link to the project's own conventions, a badge.

It is preserved verbatim by every write. briefboard reads it back as it stands and writes it
out unchanged — never normalized, never reordered, never added to — so a header a human typed
survives the CLI and the board, and a file whose preamble is empty stays that way. The one
part of that region the format owns is the blank line separating it from the first task: the
writer puts exactly one there, however many you left.

The built-in head — `# Backlog` and a comment naming this document — is written in exactly one
case: there is no file yet. Creating a backlog gives you that head; delete it later and
nothing puts it back.

Nothing in the preamble is interpreted, with one boundary that matters: the region ends at
the first line that is a task header, so a `## T-0007 · …` line written there is not prose in
the preamble but the first task. `doc/backlog-archive.md` (§1a) follows the same rule, with
its own default head.

## 1a. The doc/backlog-archive.md file

The same format, holding tasks that are `done` or `cancelled` and nothing else. Tasks get
there only through `tools/task.mjs archive`, which moves **every** closed task out of
`doc/backlog.md` in one go; nothing is ever moved back and nothing writes to the file
afterwards. That is safe because the two statuses are terminal: an archived task has no
transition left, so there is no second file to keep in sync.

It exists because the backlog is read whole by agents, and closed tasks are most of it: in
this project's own repository 64 of the 78 tasks in `doc/backlog.md` are closed, 307 KB of a
335 KB file — some 89k tokens of context to learn what 14 live tasks say. After archiving,
reading the backlog costs about 7k. It fills up again: 147 tasks are already in the archive
from the previous run.

What follows from it, and is not negotiable:

- **The board shows the archived tasks exactly as before.** It reads both files and merges
  them. Tokens are spent by what reaches an *agent*; the board runs on the server, where
  there is no agent — so archiving may cost the human nothing. Done and Cancelled go on
  being filled, and `/api/board` returns the identical JSON for those tasks.
- **IDs span both files.** The next ID is one past the highest in either, so archiving cannot
  reissue one. Without this, moving out T-0001…T-0140 would make the next `add` hand out
  T-0001 a second time, and two tasks would share `depends: T-0001` and
  `doc/brief/T-0001-*.md` — silent, and unfixable weeks later.
- **`depends` may cross the border**, and an archived prerequisite counts as satisfied like
  any other closed one.
- **Every writing command refuses an archived task by name** — `status`, `note`, `depends`,
  `profile`, `brief` — saying that it is archived, not that it does not exist. `note` on a
  closed task is accepted while the task is still in the backlog; once archived it is not.
- **`tools/task.mjs validate` checks both files** and reports an ID present in both, plus
  anything in the archive that is not `done`/`cancelled`.
- **A version that does not know about the archive is safe with it, but not with the IDs.**
  It never writes the file, so an archive cannot be damaged by an older briefboard — but its
  `add` counts only the backlog and will repeat an ID (measured). `validate` catches that on
  the next run; the fix is to run a current version.

### Dependencies

- A prerequisite counts as satisfied in `done` **and** in `cancelled`: a cancelled task
  will never arrive, and a dependent blocked forever is worse than a visible one built on
  a cancelled premise (the board marks such a dependency distinctly).
- An unsatisfied prerequisite blocks exactly one transition: `ready → in_progress`.
  Refining and briefing a task whose prerequisite is still open is normal — that is often
  where the dependency is discovered. `tools/task.mjs status ... --force` overrides the
  block with a loud warning; there is no silent bypass.
- A task must not depend on itself, on a task that does not exist, or in a cycle of any
  length. `tools/task.mjs validate` reports all three, and the `depends` subcommand refuses
  to write such a list in the first place.
- Waiting for something outside the project is modelled the same way: file the wait as a task
  of type `external` and depend on it. There is no `blocked` status and no free-text
  "blocked: reason" field — a status would drag the task out of the phase it is really in
  (a blocked task can sit in `ready`, `in_progress` or `review`), and prose is invisible to
  the dependency graph, cannot be closed, and goes stale silently. Do not move a task to
  `in_progress` to signal that it is waiting: the board would show active work where there
  is none (T-0092).

### Lifecycle (allowed transitions)

```
backlog ──▶ open ──▶ ready ──▶ in_progress ──▶ review ──▶ done
   │          │        │            │             │
   └──────────┴────────┴────────────┴─────────────┴──▶ cancelled
                                        review ──▶ in_progress (review failed)
                                        open ──▶ backlog (put back down)
```

- `backlog` — the task is only recorded.
- `open` — discussed, decision made, all forks worked through. This is the one step that can be
  taken back (T-0141): `open → backlog` puts a card pulled in by mistake — or one whose answer
  turned out to be "not now" — back where it came from, instead of forcing the choice between
  refining it and burying it in `cancelled`. It closes nothing and erases nothing: the briefs,
  the description and every question and answer stay as they are, so reopening the task later
  costs no second briefing. There is deliberately no way back out of `ready` — past a written
  brief the task has cost something, and undoing that is a different decision.
- `ready` — a brief is written (the `briefs` field is non-empty — mandatory).
- `in_progress` — the worker implements.
- `review` — the orchestrator reviews and runs the tests. A review session may be started on a
  task already here (T-0122): it reads the branch's diff and the briefs, runs the tests and
  appends a `### Review verdict` section to the description. It sets **no** status — `done`
  least of all — and it merges nothing: the verdict prepares a human's decision, it is not one.
  Unclear briefs or a diff it cannot judge are handled by the same questions protocol as
  everywhere else: a `### Session questions` section, and the task stays in `review`.
- `done` — review and tests passed, the task is merged into main. Set `closed`. The board's
  **Accept** button sets it too (T-0148), and only after checking that the task's branch is in
  the checkout's history: the merge itself is never the board's to make.
- `cancelled` — the task is cancelled or the bug was not confirmed. Set `closed`.

**A status is a claim, and the board checks it (T-0159).** Every status here is written by the
agent whose own work it describes, so a status and what actually happened can part ways — and
have: a worker that committed and died before writing `review` left a card reading `in_progress`
over a finished branch (T-0118), and a session with no permission to write wrote nothing at all
and exited cleanly (T-0107). The board's watchdog compares each status against what git has
(is there a branch, does it carry commits, is it merged) and against its own session registry
(is that process still alive), and **marks the card where the two disagree** — a task in
`in_progress` whose session is over and whose branch has commits, a task in `review` with no
branch, a task in `done` whose branch never landed. It reports and nothing more: it writes no
status, so nothing in the table above changes, and a discrepancy is for a human to resolve.
Agreement is never announced. What this means for you as an agent is only this: **write the
status the moment the work is done** — a status you never wrote is now visible as a status you
never wrote.

### Escaping in the description

The description is free-form markdown, but two kinds of line inside it would be read back as
backlog structure rather than as text. Those are stored with a leading backslash:

- `\## ...` — any line that starts with `## `. Unescaped, the parser takes it for the next
  task's header: this description is split in two and a phantom task appears (T-0040).
- `\- key: value` — a field-shaped line in the *leading* field zone of the description, i.e.
  before the first non-blank line that is not field-shaped. Unescaped, it becomes one of the
  task's own fields and silently rewrites its status, type or dates (T-0080). Past that zone
  a `- note: ...` bullet is ordinary text and is stored as it is written.

Both are applied on write and removed on read by `server/parser.js`
(`serializeBacklog`/`parseBacklog`), which the CLI and the server share — working through
`tools/task.mjs` or the board you never see the backslash and never have to think about it.

When editing `doc/backlog.md` by hand (writing rule 1 allows that), leave those backslashes
alone: removing one changes what the file means, and adding one the two rules above do not
call for leaves a literal backslash in the description text.

Known, accepted trade-off: description text that literally begins with `\## ` or with
`\- key: value` loses one leading backslash per write-read round-trip.

## 2. The doc/brief/ folder

- File name: `T-NNNN-MM-slug.md`, where `T-NNNN` is the task ID, `MM` is the sequential number
  of the brief within the task (01, 02, ...), and `slug` is a short Latin-letter name with dashes.
- One-to-many relationship: a task may have several briefs.
- The brief ID (`T-NNNN-MM`) must be added to the task's `briefs` field.
- The first line of the brief is the header `# T-NNNN-MM · Brief name`.

Brief template:

```
# T-0007-01 · Brief name

## Context
Why we do it, links to the discussion.

## Solution
What exactly we do, architecture, interfaces.

## Scope
What is in / what is out.

## Acceptance criteria
- [ ] item 1
- [ ] item 2
```

## 3. Writing rules

1. **Preferably** use the CLI: `node tools/task.mjs ...` — it guarantees the format,
   continuous IDs, and atomic writes. Editing the markdown directly is allowed, but then the
   agent is responsible for exactly following the format above.
2. Only one agent writes the file at a time. The orchestrator is the only one who changes
   the `backlog/open/ready/review/done/cancelled` statuses. The worker changes only
   `ready → in_progress` (took the task) and `in_progress → review` (submitted the task).
   A worker isolated in its own git worktree still writes those two transitions — and any
   task it files — to the backlog of the SHARED checkout (`AGENTBOARD_ROOT`), never to the
   copy inside its worktree: the board reads the shared file, and a status hidden in a
   branch until merge is a status nobody can see (T-0079). A worker's branch therefore
   contains no changes to `doc/backlog.md` at all. Its report goes to that same shared
   backlog through `tools/task.mjs note <id> --section "Worker report" --text -`, which
   appends a section to the description (and adds to it on a repeat call) without touching
   anything already written there — an isolated agent cannot edit that file any other way,
   and nothing in a description may be lost to a write meant to add to it (T-0098).
   Three headings are the exception and never merge: `Session questions` and `Answers` are
   correspondence — it is chronological, so each call opens a new section at the end and the
   order of the two says whose turn it is; `Review verdict` joins them because a task returned
   for rework comes back with a different branch behind it, so a second verdict merged into the
   first would present a judgement of the old code as the current one (T-0122). `Worker report`
   is one document that later calls add to (T-0114). The rule belongs to the heading, not to a
   flag the caller must remember.

   The report's heading is `Worker report` and nothing else — an older backlog may still carry
   the Russian `Отчёт воркера` from before the "English in code and GitHub docs" rule, which
   the tooling reads but never writes. `tools/task.mjs show` leaves both out of the description
   it prints (T-0161): a report is the bulk of a long-lived task and none of its statement of
   work. It never does so quietly — the JSON then carries an `omitted` field naming how many
   sections were dropped and the `--full` flag that prints them. Everything else — the
   statement, the refinement decisions, `Session questions`, `Answers`, `Review verdict` — is
   printed as before. The board is unaffected: it shows descriptions whole.
3. Never delete tasks from the file — only the `cancelled` status. Moving a closed task to
   `doc/backlog-archive.md` with `tools/task.mjs archive` is not deleting it: it stays in the
   same format, in a git-tracked file next door, and on the board.
4. Completed (`done`) tasks stay in place in the file — sorting is done by the UI. They leave
   it only when a human runs `tools/task.mjs archive` (§1a); closing a task never moves it by
   itself, because a card that vanishes from under your hands is a bad surprise.
5. Dates are always the actual current moment, written in the shape the field table gives —
   never a guessed or back-dated one.
6. **The exceptions** — `ui/index.html` may reach `doc/backlog.md` directly, bypassing the
   CLI/orchestrator, but only through these eleven narrow server endpoints (three of which
   write nothing to the backlog at all):
   - `POST /api/task/:id/cancel` (T-0017) — drag & drop a card onto the Cancelled row, and
     only for a single transition `backlog`/`open` → `cancelled`. The server itself verifies
     that the task's current status is indeed `backlog`/`open` before changing the file.
   - `POST /api/task/:id/open` (T-0075) — drag & drop a card from the Backlog column into the
     Open column, and only for a single transition `backlog` → `open`. The server itself
     verifies that the task's current status is indeed `backlog` before changing the file, and
     leaves `closed` untouched (`open` is not a closing status). The briefing session follows
     this transition only for a task with **no** briefs (T-0141): one that already has a brief
     is coming back up out of the backlog, and paying an agent to write a second brief over the
     first is not what the drop asked for — the answer is then `session: "briefed"` and nothing
     is spawned. Starting one anyway is the separate `/briefing` action below.
   - `POST /api/task/:id/backlog` (T-0141) — drag & drop a card from the Open column back into
     the Backlog column, and only for a single transition `open` → `backlog`. It exists because
     the only route out of `open` a board used to offer was `cancelled`, which is terminal, so
     shelving a task meant burying it. It writes one field: `closed` is untouched (neither end
     of the move is a closing status) and the description is not rewritten at all, so the briefs
     and every question and answer stay exactly as they were — the "needs answer" marker simply
     goes out, because `backlog` is not one of the statuses that can be answered from. A briefing
     session still running on the card is stopped, through the same stop path as
     `POST /api/session/:id/stop` and after the write, never before: a refused transition costs
     no session, and a kill that finds nothing to stop is reported in the answer rather than
     allowed to undo the transition.
   - `POST /api/task/:id/briefing` (T-0141) — the "start the briefing session" button in the
     card's dialog. It is **not** a transition and it writes nothing: the task must ALREADY be in
     `open` (anything else is 409, an unknown id 404), and all it does is start the briefing
     session. It is what the drop above no longer does by itself — for a brief that has gone
     stale, a session that died before writing one, or a task whose brief needs a second look
     after coming back up. With `BRIEFBOARD_SESSION_CMD` unset the answer is `session: "disabled"`
     and the board offers no button at all.
   - `POST /api/task/:id/start` (T-0084) — drag & drop a card from the Ready column into the
     In Progress column, and only for a single transition `ready` → `in_progress`. The server
     verifies the current status itself and applies the dependency gate of point "Dependencies"
     above through the very same `blockingDependencies()` the CLI uses: a task with unfinished
     prerequisites is refused with 409 naming each blocker and its status, and the file is not
     touched. There is deliberately no `--force` counterpart here — overriding the gate stays
     a CLI act. This is also the transition that may start the worker session, isolated in its
     own git worktree; a session that fails to start does not undo the transition.
   - `POST /api/task` (T-0074) — the "+" button on the board creates a task. The new task is
     **always** created in status `backlog` (this endpoint can set no other status) and with
     no briefs; the server validates every field (title, type, priority, description) and is
     the only side that assigns the ID.
   - `POST /api/task/:id/answer` (T-0085) — the answer form in the card's dialog, for a task
     whose description carries a `### Session questions` section and which is in one of the
     statuses a session can be stopped in: `open`, where the briefing session asks,
     `in_progress`, where the worker session does (T-0101), and `review`, where the review
     session does (T-0122). Anything else is refused with 409:
     there is nothing to answer. It **only appends**, under a `### Answers`
     heading at the end of the description, reusing the same `appendDescriptionSection()` as
     `tools/task.mjs note`: nothing already written is changed or removed by any input, and a
     later answer opens its own section at the end rather than joining an earlier one, so the
     order of questions and answers stays readable (T-0114). A description is the
     shared carrier of refinement decisions, review comments and worker reports, so a browser
     is not given a way to lose them to one bad request; editing what is already there is not
     offered at all. **It changes no status** — answering is not a transition, and it is the
     session that decides whether the task moves on. The optional `restart` flag starts that
     same session again — the briefing one from `open`, the worker one (isolated) from
     `in_progress`, the review one from `review` — with the same non-transactional rule: a
     session that will not start is
     reported in the response, never by undoing the answer. Structure-lookalike lines in the answer are **not** rejected — they are escaped on
     write like any description (see "Escaping in the description"), so a markdown heading in
     an answer is ordinary text.

   - `POST /api/task/:id/profile` (T-0108) — the run-profile selector in the card's dialog.
     It writes the `profile` field and nothing else: **no status changes and no session is
     started**. The value must be one the user declared in `BRIEFBOARD_PROFILES` (the empty
     string clears the field back to the default); anything else is refused with 400, so a
     value the board would later refuse to run never reaches the file. A `done`/`cancelled`
     task is refused with 409 — its sessions are behind it. The board offers exactly the
     declared list and shows no control at all when nothing is declared.

   - `POST /api/task/:id/review` (T-0122) — the "start the review session" button in the card's
     dialog. It is **not** a transition and it writes nothing: the task must ALREADY be in
     `review` (anything else is 409, an unknown id 404), and all the endpoint does is start the
     review session in the project directory — never in a worktree, because the diff it reads
     belongs to the branch the worker created and the verdict goes to the shared backlog. With
     `BRIEFBOARD_ORCHESTRATOR_CMD` unset the answer is `session: "disabled"` and the board
     offers no button at all. The session's own output is the `### Review verdict` section it
     appends through `tools/task.mjs note`; **no status change** comes from either side.

   - `POST /api/task/:id/done` (T-0148) — the **Accept** button in the card's dialog, and the
     only route that sets `done`. The task must ALREADY be in `review` (anything else is 409, an
     unknown id 404) and the endpoint stamps `closed`. Before writing it asks git whether the
     task's branch is merged into the checkout's HEAD, and refuses with 409 and
     `reason: "not-merged"` when exactly one branch matches the task and HEAD does not contain
     it: the board can verify that fact and cannot repair it. A task nobody branched for is
     accepted as it always was, and so is one with SEVERAL matching branches — that ambiguity is
     the board's own, and refusing a human's verdict over it would be worse than recording it.
     The endpoint does **not** merge, and there is still no route that does (T-0117).
   - `POST /api/task/:id/remove-worktree` (T-0148) — the **Remove the worktree** button, and the
     board's only write to git. It is not a transition and it touches no backlog: it removes
     `.briefboard/worktrees/T-NNNN` and nothing else, under the rules of T-0099 — one branch
     unambiguously belongs to the task, HEAD contains it, and its tree is clean — never with
     `--force`, never while an agent session is running in it, and only for a task in `review` or
     `done` (in `in_progress` that directory is where the work still is). Every refusal is a 409
     naming its `reason` (`not-merged`, `dirty`, `ambiguous-branch`, `session-running`,
     `bad-status`), and a worktree that is already gone a 404. The branch and its commits are
     never touched — deleting a branch stays a terminal act.

   Every one of them is narrow by design: the action is part of the route, so there is no
   generic "set any status" endpoint, and the client's own status check is UX only — the
   server re-checks it and is the source of truth. All of them use the same `server/parser.js`
   as `tools/task.mjs` — the same `parseBacklog`/`serializeBacklog`, the same shared
   `addTask()` for creation, the same `appendDescriptionSection()` for appending, and the same
   locked atomic-write pattern (tmp file + rename) — so the CLI and the UI can never produce
   different formats or duplicate IDs. This does not override the rule in point 2: apart from
   the transitions listed here, every status change is still made only by the
   orchestrator (and the worker's two transitions) through the CLI — `ready` and `review` have
   no route that sets them (`/review` and `/briefing` start a session and change nothing),
   `in_progress` has one only for the single step out of `ready`, and `done` only the one above,
   out of `review` and behind the merge check. `backlog` has one too, and it is the one step of
   the graph that runs in both directions (T-0141).
   What that check reads is a twelfth route, `GET /api/git/:id`: the
   task's branch, whether HEAD contains it, its worktree and whether that tree is clean. It is
   a read, it is asked for when a card is opened or rechecked rather than on every board
   update, and it changes nothing at all.
