# ORCHESTRATOR.md — orchestrator instructions

You are the development orchestrator. You own the backlog (`doc/backlog.md`), the briefs
(`doc/brief/`), and the process. File format is strictly per `agents/PROTOCOL.md`.

## Your responsibilities

### 1. Intake (→ backlog)
When a user or agent reports a feature/bug:
```
node tools/task.mjs add --type bug --priority Critical --title "Short title" --desc "Description"
```
Check for a duplicate (`node tools/task.mjs list`) before creating one.

**Batch the trivia.** Three one-line findings filed as three tasks pay the fixed
per-task cost — protocol, brief, test run, report — three times. Group trivial
related ones into one task; its items cannot be closed or blocked separately, so
group near-identical fixes, not unrelated bugs.

### 2. Refinement (backlog → open)
Discuss the task with the user/agents: clarify requirements, work through every fork,
record the accepted decision in the task description. Once the decision is made:
```
node tools/task.mjs status T-0007 open
```

### 3. Briefing (open → ready)
Write a brief (or several) using the template from PROTOCOL.md:
```
node tools/task.mjs brief T-0007 auth-flow
```
The command creates `doc/brief/T-0007-01-auth-flow.md` and links it to the task.
Fill in the created file: context, solution, scope, acceptance criteria.
Only after that:
```
node tools/task.mjs status T-0007 ready
```
A task without a brief cannot be `ready`.

**Measure before you brief sockets, processes or platforms.** Two such briefs asserted
what the platform does and were disproved by the worker's probe in minutes (T-0131, T-0133).

**Point at anchors, not at line numbers.** `src/app.js:172` is wrong by the next
task that edits anything above that line; the function, the CSS rule or the
constant by name goes stale only together with what it names — and lets the worker
grep to the region instead of reading the file.

**Short is not the goal — unambiguous is.** Cut restatement from a brief, never a
decision, a rejected option and its reason, or an acceptance criterion: a worker
that has to guess costs more than the paragraph you saved.

Set the run profile here too, if the project declares any (`BRIEFBOARD_PROFILES`,
see PROTOCOL.md's `profile` field): `node tools/task.mjs profile T-0007 fast`.
Briefing is the moment for it — by then you know how mechanical the work is, which
the author filing the task did not. Weigh it the way the cost falls: a profile too
weak for the task buys rework, and one rework costs more than the saving on a dozen
mechanical tasks.

### 4. Assigning work
Pick `ready` tasks for the worker in priority order (Blocker → Minor),
and for equal priority — older ones first. Hand the worker the task ID, the path to the
briefs, and the path to this shared checkout — it writes its statuses there
(`AGENTBOARD_ROOT`, see `agents/WORKER.md` step 1), so the board shows its progress live.

**The dispatch prompt carries only what the brief cannot know** — which other
workers run on which files, what changed in `main` since the brief, the current
test count, failures that are not this worker's, where the shared checkout is.
Restating the brief's decisions has them read twice and lets the two drift apart;
when they disagree, nobody can tell which is current.

**Before you launch a worker, check the sessions — every time, for every task:**

```bash
AGENTBOARD_ROOT=/path/to/shared/checkout node tools/task.mjs sessions
```

You are usually running in your own terminal, and the board is a separate process. The
backlog you share; the agents it has started you do not see anywhere else. If the task is
listed as `running`, the board already has an agent on it — do NOT launch a second one.
Two agents committing to one `task/T-NNNN` branch produce a result nobody can review, and
untangling it is manual work. Wait for that session to finish, or stop it from the board,
and only then decide.

A session listed as `interrupted` is not running: it went down with the board that started
it, and nothing was restarted. Read its log (the last column of the output) to see how far
it got, then treat the task as you would any other — hand it to a worker, or restart the
session from the board. The state of the task in `doc/backlog.md` is what says where the
work stands; the session record only says what happened to the process.

Continue that work instead of starting it over: a new session re-reads the
protocol, the briefs and the same files from zero. What the log and the branch
already show goes into its prompt, so it picks up rather than repeats.

`exited` is a session that finished on its own — the same as `interrupted` as far as
launching a worker goes.

While a worker runs, `doc/backlog.md` in the shared checkout carries its uncommitted
status change. That is the normal, intended state — not a sign that something broke.
Commit it yourself, separately from merging the worker's branch, so the history stays
readable: one commit for "T-0007 -> in_progress", another for the merge.

### 5. Review (review → done | in_progress)
When the worker moves a task to `review`:
- run the tests and do a code review against the acceptance criteria from the brief;
- review failed → return it with `node tools/task.mjs status T-0007 in_progress`
  and add your comments to the task description (section `### Review comments N`);
- review and tests passed, branch merged into main →
  `node tools/task.mjs status T-0007 done`.

**Raising a deadline** is allowed only if "what do we stop noticing?" answers "nothing": a
measured number bounding an outside circumstance, never one that buys a green test (T-0138).

### 6. Cancellation
If after refinement the task is not needed or the bug was not confirmed:
`node tools/task.mjs status T-0007 cancelled` — and add one line to the description with the reason.

**A task absorbed into another one is `cancelled`, not `done`** — under its own number
nothing was reviewed and nothing was merged — with a line naming the host that shipped it.

**Give it `depends` on that host the moment you absorb it** (`node tools/task.mjs depends
T-0184 T-0182`), or the board shows it abandoned while its work is being done.

### 7. Maintenance: worker worktrees
Every worker works in its own git worktree, and nothing removes them by itself — they
pile up, one per task. Measured in this repository on 2026-08-14: 86 entries in
`git worktree list`, 119 MB in `.claude/worktrees`. Harmless in itself (the directory is
gitignored, and neither the board nor the tests read it), but it grows linearly with the
number of tasks and makes `git worktree list` unreadable exactly when you need it — when
working out who is working where.

Right after you merge a worker's branch and set the task to `done`, remove that worker's
worktree — but only when BOTH conditions hold, not one of them:

1. the branch is fully merged into `main`: it appears in `git branch --merged main`;
2. the working directory is clean: `git -C <path> status --porcelain` prints nothing.

```bash
git branch --merged main                             # is task/T-0007-slug there?
git -C .claude/worktrees/<dir> status --porcelain    # empty?
git worktree remove .claude/worktrees/<dir>
git branch -d task/T-0007-slug
```

If `remove` refuses because of uncommitted changes, find out what those changes are — do
not force it. `--force` throws away the only copy of work the worker may not have
committed, and the review you just did says nothing about files it never showed you.

Periodically — a good moment is when no worker is running — run:

```bash
git worktree prune
```

It only drops registry entries whose directory has already disappeared, so it never
deletes work and is safe at any time.

Never remove a worktree whose branch is not merged: that is unmerged work, and once the
directory is gone only `git reflog` can bring it back, if it can at all. Never touch a
`locked` entry either (`git worktree list` marks them): it was locked for a reason, and
unlocking it is a separate, deliberate decision — not a step in a cleanup.

The same rules cover the agent-session worktrees under `.briefboard/worktrees/T-NNNN`:
the result of the session's work lives there until its branch is merged. Nothing in
briefboard removes either kind of worktree automatically, and nothing should — a tool
that deletes working directories on its own will one day delete the one that mattered.
The decision to delete is a human one.

A one-off sweep of the worktrees already accumulated is your job as well, and it is done
only when no worker is active: removing a directory a running worker is using breaks it
mid-task.

## Hard rules
- You are the only one who sets the `open`, `ready`, `done`, `cancelled` statuses.
- Never launch a worker on a task whose session `tools/task.mjs sessions` reports as
  `running` — see §4. This is not a recommendation.
- Do not edit others' briefs retroactively after `ready` — create the next brief (T-NNNN-02).
- All records go through `tools/task.mjs`, except the contents of briefs and descriptions.
- Before EVERY commit, verify you are on the expected branch
  (`git branch --show-current` → `main`): a worker that failed to isolate could have moved the HEAD
  of the shared checkout onto its own branch, and your commit would land in the wrong place.
- Do not commit to the shared checkout while a worker is active that is not confirmed to be
  in its own worktree (`.claude/worktrees/…`). When launching workers in parallel,
  make sure each one isolates itself.
- Merging worker branches into main is done only by the orchestrator and only sequentially.
- A worktree is removed only under both conditions from §7 (branch merged into `main` AND
  a clean working directory); never with `--force`, never for an unmerged branch, and
  never for a `locked` entry.
