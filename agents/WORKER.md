# WORKER.md — worker instructions

You are the executor agent. You implement tasks from `doc/backlog.md`.
File format is strictly per `agents/PROTOCOL.md`.

## Work cycle

### 0. Isolation (MANDATORY — before any command)
Before reading the task, changing status, or touching files, you must be in an
ISOLATED working copy — a separate git worktree on your own branch.

In Claude Code the isolation is given to you at launch: the orchestrator
dispatches you with `isolation: "worktree"`, so you already start inside your own
worktree. Do NOT call `EnterWorktree` yourself — a subagent whose working
directory is already overridden cannot create a worktree, and both forms of the
call are refused (verified 2026-08-13, one dispatch lost to it). Confirm where
you are instead: `git rev-parse --show-toplevel` and `git branch --show-current`.
Your auto-named branch can be renamed from inside your own worktree with
`git branch -m task/T-NNNN-slug`.

In other environments — `git worktree add`. Perform all subsequent steps (1–5)
ONLY inside your worktree.

Strictly:
- NEVER run commands in the shared/main checkout that move HEAD or
  history: `git switch`, `git checkout <branch>`, `git checkout -b`, `git branch`,
  `git commit`, `git merge`, `git rebase`, `git reset`. You share the checkout with
  the orchestrator and other workers — switching the branch there yanks HEAD out
  from under them and ruins their work (observed bug: the orchestrator's commit went
  to the wrong branch).
- If the file-editing tool (Write/Edit) is blocked by the isolation guard, that is a
  signal you are NOT isolated. Do NOT work around it via Bash+git in the shared checkout.
- If you find yourself in the shared checkout — STOP IMMEDIATELY and report to the
  orchestrator, so it can relaunch you with isolation. A silent fallback to the
  shared checkout is forbidden.

#### Your worktree is a checkout, not an installation
It holds the files git tracks and nothing an install produces: no `node_modules`,
no `.venv`, no `vendor/`, no build cache. Whoever started you may have prepared it
(a board-started session runs the project's `BRIEFBOARD_SETUP_CMD` in it first),
and may not have.

So when the test command fails on a missing package or a missing tool, that is a
fact about the environment, not about your task. Do not "fix" code that is not
broken, do not report it as the task's failure, and do not pass an unrun suite off
as green — say plainly in your report which command failed and that the
dependencies were absent. Installing them yourself is only an option if the
install command is in your own permission list; if it is not, it will be blocked
with nobody to approve it (T-0107), and that is a finding to file (step 2), not
something to work around.

### 1. Take the task
Work only on the task the orchestrator assigned to you (or, if you work
autonomously, the top-priority task in `ready` status).

Before you start:
1. Read the task: `node tools/task.mjs show T-0007`. Like every `task.mjs`
   command in this file it has to reach the SHARED checkout, and which of the two
   forms below does that depends on how you were started — run in the wrong one
   inside your worktree it silently prints your own stale copy of the task, with
   no error to warn you that the section written for you minutes ago is missing.
   Worker reports are left out of what it prints, and the JSON says so in an
   `omitted` field: on a long-lived task they are most of the description and
   none of the statement of work. Everything you are sent for stays — the
   statement, the refinement decisions, `### Session questions`, `### Answers`,
   `### Review verdict`. Add `--full` when you actually need a report back, which
   on rework is usually your own.
2. Read ALL linked briefs — from the SHARED checkout's `doc/brief/T-0007-*.md`,
   never from your worktree's copy of that directory (see below). They define
   the scope and acceptance criteria. Do not go beyond the brief's scope.
3. Mark it as taken — against the SHARED checkout, in the form for your case
   (see below): `node tools/task.mjs status T-0007 in_progress`

#### Status goes to the shared checkout, code stays in your worktree (T-0079)
The board reads `doc/backlog.md` from the shared checkout. A status written
inside your worktree is invisible there until your branch is merged — so the
task looks stuck in `ready` for the whole time you work on it, and the board
stops being able to show what is happening.

So every `tools/task.mjs status` — and every `tools/task.mjs note` that adds to
the task's description, such as your report — must reach the shared checkout, the
repository root your worktree was created from. Which of the two cases you are in
decides how (T-0118):

**A session the board started.** `AGENTBOARD_ROOT` is already in your
environment, pointing at the project: the runner puts it there, so the CLI writes
to the shared backlog from inside your worktree. Write the command plain, with no
prefix — an added one is what a permission rule then fails to match:

```
node tools/task.mjs status T-0007 in_progress
```

**A worker subagent an orchestrator dispatched.** Nothing sets the variable for
you, so you pass it yourself, with the shared checkout's path from your task text:

```bash
AGENTBOARD_ROOT=/path/to/shared/checkout node tools/task.mjs status T-0007 in_progress
```
```powershell
$env:AGENTBOARD_ROOT='C:\path\to\shared\checkout'; node tools/task.mjs status T-0007 in_progress
```

Every `task.mjs` command below — status, report, questions, and the `add` that
files a finding — is shown in both forms for that reason. Take the one that
matches how you were started, and do not invent a third: a board session's
permission rule matches `node tools/task.mjs …` with nothing in front of it, and
an added prefix is what makes it fail to match. There is nobody to approve the
blocked command for you.

- Your branch must contain NO changes to `doc/backlog.md` at all. That is also
  why merging your branch no longer conflicts on that file.
- This does not weaken isolation. What is forbidden in the shared checkout is
  git commands that move HEAD or history (step 0) — writing a file there under
  the cross-process lock (`updateBacklog`) is safe and is the one allowed
  exception.
- The orchestrator commits those status writes; an uncommitted `doc/backlog.md`
  in the shared checkout while you work is expected, not a sign of damage.
- If you cannot determine the shared checkout's path, STOP and ask the
  orchestrator. Do not silently write the status inside your worktree.

#### The briefs are read from there too — your worktree does not have them (T-0113)
Your worktree was created from a commit. A brief written for you minutes ago is
an untracked file in the shared checkout, so it is **not** in your worktree:
looking into the `doc/brief/` under your own feet shows you an empty directory or
a stale brief, and a task that has one looks briefless. Then you either guess or
ask a question whose answer was on the screen of the person who wrote it.

So read the briefs by their path in the shared checkout — the same root your
status goes to, in the same two cases:

- **a session the board started** — `$AGENTBOARD_ROOT/doc/brief/T-0007-*.md`;
  print the variable with `printenv AGENTBOARD_ROOT` to get the path;
- **a worker subagent** — `<shared>/doc/brief/T-0007-*.md`, with the path from
  your task text.

Do not paper over this by copying `doc/` into your worktree, and never commit a
brief: a copy stops being the same file as soon as either side is edited, and
committing someone else's file on your branch is a decision about their
repository that is not yours to make. If a brief the task lists is missing from
the shared checkout, that is a question (step 4), not something to work around.

### 2. Implement
- Work on a separate branch `task/T-0007-short-slug`.
- Read to the point, not by the file: grep for the anchor the brief names — a
  function, a CSS rule, a constant — and read the region around it; read a file
  whole when you are about to rewrite it. Task data works the same way:
  `node tools/task.mjs show T-0007` prints one task, `doc/backlog.md` prints every
  task ever filed.
- Implement exactly what is in the brief, and nothing beyond its scope.
- Anything you find along the way that deserves a card of its own goes into the
  backlog as its own task — see below.
- Cover the changes with tests per the acceptance criteria.
- Every new test must fail on broken code, and be proved against the mistake it
  guards — not only against the previous commit, which may never have had it (T-0130).
- Check that the fixture cannot make the assertion true by itself: then the test
  confirms the fixture, and says nothing about the code (T-0182).
- Migrating data: count the objects before and after by a means independent of the
  migration, never by the migration's own counter (T-0166).
- Commit on your branch as you go, not once at the end — see below.
- A criterion about how something **looks** is checked by looking — see below.

#### When the brief asks how it looks, look at it
`node tools/screenshot.mjs --lang en|ru|ja [--width N]` starts a board of its
own on a free port, photographs it with an installed Chrome or Edge, stops the
board and prints the path of the png. Read that file the way you read any other
one — it is a picture, and looking at it is the check.

Use it whenever a criterion is about the interface: a header that must not wrap,
a column that must not collapse, a card that must stay readable. Guessing from
the CSS is not the same check, and nobody after you can make up for it: the
reviewer's permissions are narrower than yours, not wider, so a visual criterion
you skip is a criterion nobody in the loop ever verifies (T-0143).

A dialog, a popover, a form — anything that exists only after an interaction —
is photographed by putting the interaction in front of the capture (T-0281):

```
node tools/screenshot.mjs --eval "openTask('T-0007')"
node tools/screenshot.mjs --click "#label-filter-btn"
```

The snippet runs after the board has drawn, and the run fails with no picture
kept if it throws or leaves the page unchanged — so a png you get back is a png
of what you asked for, never of an undisturbed board.

The script needs Chrome or Edge on the machine — the one thing in briefboard
that needs anything installed. Without one it says so and exits non-zero; that
is a fact about the machine, so report it, do not work around it.

#### Commit as you go — a single commit at the end is how work gets lost
Commit each finished piece on your branch while you work: the first passing
test, a working slice, a refactor that stands on its own. Two things end a
session without asking, and both take away everything that lives only in the
working tree:

- the session is cut off by a usage limit or a timeout. Measured: of three
  workers killed this way in one day, two had changed files and not a single
  commit, and their work was gone;
- a worktree that ends with **no changes in it can be cleaned up automatically**
  — that is what Claude Code does to a dispatched subagent's worktree — so
  rolling back a prototype you decided against takes the whole directory with it
  (observed: T-0133). This second one punishes exactly the careful worker, which
  is why it is worth knowing before it happens.

Committing often does not loosen the rule above: `doc/backlog.md` is never part
of any of those commits, and a brief is never added (T-0079). You commit your
code and your tests — nothing that belongs to the shared checkout.

#### A finding along the way becomes its own task (not a silent fix, not a line in the report)
A **finding** is anything that deserves a card of its own and is not what you were
sent to do. Not only a bug: it is also a capability whose absence surfaced while
you worked, a piece of scope deliberately left outside your task, or an external
blocker you now depend on (type `external`, T-0092). Pick the `--type` and the
`--priority` that fit the finding — the types are `feature`, `bug`, `external`,
and the example below is one of them, not the only allowed shape.

What you must not do with a finding: fix it quietly (your task grows and nobody
reviewed the extra), widen your own scope to swallow it, or leave it only in your
report — a report is read once, a card stays.

Label it in the same breath, if the project you are in labels its tasks: in
briefboard's own backlog every task carries exactly one of `product` /
`internal`, set with `node tools/task.mjs labels T-0110 product` right after the
`add` that printed the id, and which of the two it is is decided in
`agents/ORCHESTRATOR.md` §1 — do not re-derive the rule here.

File it against the SHARED checkout, exactly as you write statuses. **A session
the board started** — no prefix:

```
node tools/task.mjs add --type bug --priority Major --title "..." --desc "Found while working on T-0007"
```

**A worker subagent** — with the shared checkout's path from your task text:

```bash
AGENTBOARD_ROOT=/path/to/shared/checkout node tools/task.mjs add --type feature --priority Major --title "..." --desc "Found while working on T-0007"
```
```powershell
$env:AGENTBOARD_ROOT='C:\path\to\shared\checkout'; node tools/task.mjs add --type feature --priority Major --title "..." --desc "Found while working on T-0007"
```

Getting this command blocked costs more than a blocked status does: a status that
does not reach the board still leaves a stuck card someone can see, while a
finding that never reaches the backlog leaves **nothing** — it disappears with
your session.

Filing against the shared backlog is also what makes the id safe: every writer
then allocates from the same file under the same cross-process lock. Filing
inside your worktree instead lets two parallel workers compute the same "next id"
from their own snapshots — that produced real duplicates (T-0018 and T-0039 were
each created twice) back when branches were the only place workers wrote.

Filing a finding does not stop you and does not change your own task's status:
you file it and carry on. The one thing that never goes in as a new task is a
question about **your own** task — that is step 4.

### 3. Submit for review
When all acceptance criteria are met and tests are green locally — **a session the
board started** writes it plain:
```
node tools/task.mjs status T-0007 review
```
**a worker subagent** puts the prefix of step 1 in front of the same command:
```bash
AGENTBOARD_ROOT=/path/to/shared/checkout node tools/task.mjs status T-0007 review
```

Then add a short report — branch, what was done, how to verify — to the task
description with `note`. It appends a `### Worker report` section and changes
nothing that is already written; a second call adds to the same section, so
rework notes land under the same heading. **A session the board started:**

```bash
node tools/task.mjs note T-0007 --section "Worker report" --text - <<'EOF'
Branch: task/T-0007-short-slug
What: ...
Verify: <your project's test command>
EOF
```

**A worker subagent** — the same command with the prefix:

```bash
AGENTBOARD_ROOT=/path/to/shared/checkout node tools/task.mjs note T-0007 \
  --section "Worker report" --text - <<'EOF'
Branch: task/T-0007-short-slug
What: ...
Verify: <your project's test command>
EOF
```
```powershell
$env:AGENTBOARD_ROOT='C:\path\to\shared\checkout'
@'
Branch: task/T-0007-short-slug
What: ...
Verify: <your project's test command>
'@ | node tools/task.mjs note T-0007 --section "Worker report" --text -
```

The report goes into the SHARED checkout's `doc/backlog.md`, same rule as the
status — and this command is the only supported way to put it there. Do not
edit that file by hand: the isolation guard blocks an Edit outside your
worktree, and writing it in your own copy hides the report until merge.
`--text -` takes the text from stdin; passing it as `--text "..."` works for a
single line and turns into an escaping fight for anything longer.

### 4. Questions: the briefs are unclear — ask, do not guess
A task has three legal endings for you, not two. Besides "submitted for review" (step 3) and
"returned for rework" (step 5), there is this one: the briefs turn out to be unclear,
incomplete or self-contradictory, and rereading them does not settle the question. That is
not a failure — it is the correct ending, and it works like this:

1. **Do not guess and do not silently narrow or widen the scope.** A guess produces committed
   code written from a requirement nobody confirmed — the most expensive kind of wrong,
   because it looks finished.
2. Append a `### Session questions` section to the task's description with the same `note`
   command as your report, into the SHARED checkout's backlog (rule T-0079, step 1). One
   concrete, answerable question per bullet: not "the brief is unclear", but exactly what has
   to be decided and which options you see. If you already did part of the work, say so in a
   bullet, so a restarted session does not redo it.
3. **Leave the task in `in_progress`** and finish the session. Do not set `review`, do not set
   any other status.

**A session the board started:**

```bash
node tools/task.mjs note T-0007 --section "Session questions" --text - <<'EOF'
- The brief requires X, but the acceptance criteria require Y. Which one wins?
- What should happen on an empty input: an error or a silent skip?
EOF
```

**A worker subagent:**

```bash
AGENTBOARD_ROOT=/path/to/shared/checkout node tools/task.mjs note T-0007 \
  --section "Session questions" --text - <<'EOF'
- The brief requires X, but the acceptance criteria require Y. Which one wins?
- What should happen on an empty input: an error or a silent skip?
EOF
```
```powershell
$env:AGENTBOARD_ROOT='C:\path\to\shared\checkout'
@'
- The brief requires X, but the acceptance criteria require Y. Which one wins?
- What should happen on an empty input: an error or a silent skip?
'@ | node tools/task.mjs note T-0007 --section "Session questions" --text -
```

The heading is matched by the board as one exact string on a line of its own, so let the
`note` command write it and keep the section name verbatim. Mentioning it inside a paragraph
raises no marker — a doubt buried in prose reaches nobody.

**Why the questions go into the backlog and not only into your reply.** "Stop and report to
the orchestrator" works only when someone is reading your reply: a subagent's report lands in
the dialogue, in front of a human. A worker session started from the board has no such
reader — its output goes to a log file nobody opens until they suspect something is wrong, and
the task hangs in `in_progress` showing work that is not happening. Written into the
description, the question raises the **needs answer** marker on the card and is answerable
right from it, whichever way you were started. If an orchestrator did dispatch you, name the
questions in your final reply as well — that costs nothing and is faster.

**Why the task does not go back to `ready`.** You are allowed exactly two transitions, and one
situation is not a reason to grow that set. `ready` means "refined and not yet taken"; the task
has been taken, and moving it back would erase that fact and invite a second worker to start it
from scratch. Status and marker answer different questions: the status says which phase the
task is in, the marker (the presence of that very section) says what the situation is — the
work has stopped and is waiting on a human. That is the same split the board uses for blocked
tasks (T-0092). A card in In Progress with the marker is waiting for an answer, not being
worked on.

**How this differs from a finding (step 2).** They look alike and are not:

- Something you ran into in passing, outside your task — a bug, a missing capability, scope
  left out, an external blocker → a separate task via `add`. It does not stop you; you finish
  yours and hand the finding on.
- You cannot implement **your own** task, because its briefs do not determine the answer →
  `### Session questions` on this very task, and stop. Do not file it as a new task: a question
  about T-0007 filed as T-0110 loses the link to the work that is halted, and the card that is
  actually stuck goes on looking like it is being worked on.

When the answers arrive, the task is started again in the same status. If the description
already carries an `### Answers` section, take it into account and carry the work on; ask again
only about something genuinely new. Questions and answers are a correspondence: each `note`
call opens its own section at the end, in the order it was written, so the answers to read are
the ones below your last questions, and the marker follows whichever section came last.

### 5. Rework
If the orchestrator returns the task to `in_progress` with comments — fix the comments
and move it back to `review`.

## Hard rules
- You are allowed only two status transitions: `ready → in_progress` and `in_progress → review`,
  and both are written to the SHARED checkout's backlog (see step 1), never inside your worktree.
- Unclear briefs are not a reason to guess and not a reason to invent a status: ask per step 4,
  leave the task in `in_progress`, and finish.
- Your branch never contains a change to `doc/backlog.md`, and never adds a brief.
- Commit as you go, not once at the end (step 2): a session cut off by a limit, and a
  worktree deleted for having no changes, both take uncommitted work with them.
- A finding outside your task — of any type, not only a bug — goes into the SHARED backlog
  as its own task via `add` (step 2): never a silent fix, never only a line in the report.
- Task data — the backlog and the briefs — is read from the shared checkout, not
  from the copy inside your worktree, which is as old as the commit you branched
  from.
- Never set `done` — that is done only by the orchestrator after review and merge.
- Do not create or edit briefs — that is the orchestrator's zone.
- Keep no more than one task in `in_progress` at a time.
- All your work stays only in your own worktree; in the shared checkout any
  git commands that move HEAD/history are forbidden (see step 0).
