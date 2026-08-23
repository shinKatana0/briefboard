# briefboard

English | [Русский](README.ru.md) | [日本語](README.ja.md)

[![npm version](https://img.shields.io/npm/v/briefboard.svg)](https://www.npmjs.com/package/briefboard)
[![tests](https://github.com/shinKatana0/briefboard/actions/workflows/test.yml/badge.svg)](https://github.com/shinKatana0/briefboard/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=21](https://img.shields.io/badge/node-%3E%3D21-brightgreen.svg)](#requirements)

A lightweight kanban board + CLI that makes AI coding agents run their work
through a strict workflow — `backlog → open → ready → in_progress → review → done` —
with a mandatory brief before implementation starts and a review before merge.

> The package is published to npm as `briefboard` — `npx briefboard init`
> deploys it into any project (see [Quick start](#quick-start) below). Cloning
> the repository is an alternative path for contributors and local development.
> If you arrived looking for `agentboard`, that was this project's earlier name —
> the package and the repository are both `briefboard` now.

![briefboard — live board + CLI demo](doc/img/demo.gif)

## Why

Agents that work straight from a chat conversation lose structure quickly: it is
unclear what has already been decided, what is still in progress, and who made a
given decision and why. `briefboard` puts a simple, formal process on top
of any agentic tool (Claude Code, Codex, and the like) — a task backlog, a
mandatory brief before implementation, and a review before merge — plus a live
board that shows all of it to a human in real time.

## What it has been run on

briefboard is agent-agnostic and platform-agnostic by construction — it spawns the
command you configured and writes plain files. What has actually been exercised is
narrower than that, and you should know which is which before you adopt it:

- **The agent: Claude Code.** Every ready-to-copy command here was run on Claude
  Code 2.1.232. Any CLI that meets [the four
  requirements](#what-briefboard-needs-from-an-agent) should work, because that is
  the whole interface — but no second one has been tried here, so that is a
  property of the design and not a tested promise.
- **The platform: Windows 11**, where everything was measured. Linux is checked by
  the tests: the whole suite runs green in a Debian container (`node:22-bookworm`),
  with two tests skipping themselves there because what they check is Windows-only
  — and the run that first went through it found a real hole in the process
  cleanup that Windows did not have. What Linux has not had is the measuring: every
  number here was taken on Windows. **macOS has never been run at all** — its `ps`
  reports a process's start time in its own way and its pid range differs — so it
  is not supported until someone does.

Neither limit is enforced anywhere: nothing asks which agent or which operating
system you are on, and nothing refuses to start. They say what has been verified,
not what is blocked.

## Quick start

**Full user guide:** for a detailed, step-by-step walkthrough (installation,
first run, the task lifecycle end-to-end, CLI reference, the board UI, and
troubleshooting) see the
[user guide](https://github.com/shinKatana0/briefboard/blob/main/doc/guide/guide.en.md).

Deploy it into any project with `npx briefboard init`. It copies `server/`,
`tools/`, `ui/`, `agents/`, `AGENTS.md`, `CLAUDE.md` into the current directory
and creates an empty `doc/backlog.md` + `doc/brief/`. Into a project that already
exists it fills in what is missing file by file, keeps every file that is already
there, and adds its instructions to an existing `CLAUDE.md` / `AGENTS.md` as a
marked block instead of replacing them:

```bash
npx briefboard init
npx briefboard serve
# → board at http://localhost:4571, or the next free port if that one is taken

node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

As an alternative — for contributors or local development — clone the repository
and work inside it directly:

```bash
git clone <url-of-this-repository>
cd briefboard

node server/server.js
node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

## How it works

The source of truth is `doc/backlog.md` (plus briefs in `doc/brief/`), plain
markdown. Every task moves through a fixed set of statuses:

```
backlog ──▶ open ──▶ ready ──▶ in_progress ──▶ review ──▶ done
   │          │        │            │             │
   └──────────┴────────┴────────────┴─────────────┴──▶ cancelled
                                        review ──▶ in_progress (if review fails)
                                        open ──▶ backlog (put back down)
```

- **backlog** — the task is only recorded.
- **open** — discussed, a decision has been made.
- **ready** — a brief has been written (a task cannot move to `ready` without one).
- **in_progress** — a worker implements the task per the brief on a separate branch.
- **review** — the worker has submitted the task; the orchestrator checks it and runs tests.
- **done** / **cancelled** — the task is merged or cancelled.

Two roles:

- **Orchestrator** — owns the backlog, writes briefs, assigns tasks, runs reviews
  and merges. The only role that sets `backlog/open/ready/review/done/cancelled`.
- **Worker** — picks up a `ready` task, implements exactly what the brief
  describes, and moves `ready → in_progress` and `in_progress → review`.

The exact format of `doc/backlog.md` and `doc/brief/*.md`, the writing rules, and
the allowed status transitions live in `agents/PROTOCOL.md` (the single source of
truth for the format — this README only paraphrases it). Role instructions are in
`agents/ORCHESTRATOR.md` and `agents/WORKER.md`.

Closed tasks pile up, and they keep piling up after a sweep: in this repository
64 of the 78 tasks in `doc/backlog.md` are `done` or `cancelled` — 307 KB of a
335 KB file that agents read whole — with 147 more already in the archive from
the previous one. `node tools/task.mjs archive` moves them to
`doc/backlog-archive.md`, in the same format and still tracked by git. Nothing is
lost and nothing changes for you — the board reads both files and goes on showing
Done and Cancelled exactly as before; what shrinks is what an agent pays to read
the backlog (335 KB → 28 KB here, roughly 89k tokens → 7k).

## The board UI

- Columns by status: Backlog → Open → Ready → In progress → Review; Done and
  Cancelled are collapsible strips below the board.
- Filter by task type (all / feature / bug / external).
- Full-text search over task title, description, ID and labels.
- Multi-select filter by priority (Blocker / Critical / Major / Medium / Minor).
- Labels you define yourself: chips on the card, an editor in the card's dialog
  and a `Labels ▾` multi-select filter in the header. Nothing declares a label —
  it exists while some task carries it, and typing a new name in the editor is
  how one is created (`node tools/task.mjs labels T-0007 ui,docs` does the same
  from the terminal). A task can be filed already carrying them — `add --labels`
  and the field in the "+" form — so a project whose every task must be labelled
  does not depend on a second command being remembered.
- Theme toggle: light / dark.
- Interface language toggle: EN / RU / JA.
- The "+ New task" button, first in the header next to the title, creates a task
  (title, type, priority, labels, description) straight from the board — it
  always lands in `backlog`.
- Drag & drop a card from "Backlog"/"Open" onto the "Cancelled" strip to cancel a
  task straight from the UI.
- Drag & drop a card from "Backlog" into the "Open" column to open it — no
  confirmation, just the `backlog` → `open` transition (and, if you configured
  one, the agent session below).
- Drag & drop a card from "Open" back into "Backlog" to put it down again: the
  card you pulled in by mistake, or the one you have decided against for now. The
  move itself is not confirmed — it is reversible; what the board does ask about
  is a briefing session running on that card, because the move stops it. Nothing
  is erased: the briefs, the description and every question and answer stay where
  they are. There is no counterpart out of "Ready" — see the lifecycle in
  `agents/PROTOCOL.md`.
- A card in **Open** carries a **Start the briefing session** button (when a
  briefing command is configured). It is what the drop into Open no longer does
  for an already-briefed task: press it when the brief has gone stale, when a
  session died before writing one, or when a task that came back up out of the
  backlog needs its brief looked at again. It changes no status and replaces
  nothing already written.
- Drag & drop a card from "Ready" into the "In progress" column to take it into
  work: the `ready` → `in_progress` transition and, if you configured one, the
  worker session below. This one asks for confirmation — it starts an agent that
  writes and commits code. A card with unfinished prerequisites is not accepted
  at all, and the column does not even light up for it.
- A card in **Review** carries the end of the work: the board asks git whether the
  task's branch is merged, hands you the merge line to copy, and offers **Accept**
  (`review → done`, confirmed) and **Remove the worktree** — each refused with its
  reason while the branch is not merged or the tree is not clean. The merge itself
  is never the board's: it is a judgement and it stays yours.
- The same card carries the other ending: **Send back for rework** performs
  `review → in_progress` and starts a worker session on the branch the previous
  round is already on. It asks first — it starts an agent — and it is refused when
  there is no `task/T-NNNN` branch, because a rework would then begin from HEAD and
  lose the round it was meant to correct. A missing *worktree* is not a refusal: it
  is recreated from the branch. The transition itself was always legal; what this
  adds is that somebody is put on the task, which `status … in_progress` never did.
- A card in **In progress** carries **Resume the work**: a worker session again,
  on the branch the task is already on, for a session that ended without the task
  moving — an interrupted board, a crashed worker, a rebooted machine. It writes
  no status, because the card is already where it belongs, and it is refused while
  a session is genuinely running on the task (read from the session registry, not
  guessed from the status) or when there is no `task/T-NNNN` branch to carry on
  from. Before it existed the only way back to a worker from here was to write a
  question the session never asked into the description.
- Task dependencies: a card whose prerequisites are not finished is marked
  "blocked", the task dialog lists them with their current status as clickable
  links, and `ready → in_progress` is refused until they are closed.
- The blocked marker names the blocker ("waiting: get the API keys from the
  client"), not just its id; several blockers are counted, with the full
  "id — title" list in the tooltip. A "Blocked" toggle in the header shows only
  the tasks that are waiting on something.
- A watchdog compares what a card claims against what git and the session
  registry show, and marks the card with an amber chip where the two disagree —
  a task in progress whose session is over and whose branch carries commits, a
  task in review with no branch, a task in done whose branch never landed. It
  only reports: it writes no status and merges nothing, and cards it has nothing
  to say about carry nothing. `BRIEFBOARD_WATCHDOG_MS` sets how rarely it may ask
  git: `10000` ms is both the default and the floor, and a smaller value — `0`
  included — is raised to it, with a line on stderr that says `Write "off" to
  stop the board asking git at all.`
- The `external` task type is for work a third party owes you — access, keys, an
  answer from the client, someone else's release. Give it a card, let the real
  work `depend` on it, and the wait becomes visible and closable instead of
  hiding in prose or in a task parked in "in progress".
- The `⏻` button in the header stops the board: it asks for confirmation, then
  the `node server/server.js` process exits and the page says the board is
  stopped instead of trying to reconnect. Only the board process dies — the
  terminal it ran in simply gets its prompt back. Running agent sessions are
  killed with it, exactly as on Ctrl+C, with a bounded wait after the kill — see
  the sessions section below. The request is accepted from a loopback address
  only.
- Export the current board to Excel (`.xlsx`) with one button.
- Live update: the board re-renders itself when `doc/backlog.md` changes on disk
  (SSE + `fs.watch`), without reloading the page.

## Agent sessions (opt-in, off by default)

Two drops on the board can start an agent session, and each has its own command:
the **briefing** session when a card is dropped into Open, and the **worker**
session when a card is dropped into In progress. Buttons on a card start them too:
**Start the review session** on a card in Review starts the third kind, the
**review** session; **Send back for rework** on the same card starts the worker one
again, for a second round on the same branch; and **Resume the work** on a card in
In progress starts it for a session that died, without moving the card.

The names, once, because they are easy to confuse:

- **the board** — briefboard itself: the backlog, the briefs, the lifecycle. It
  starts sessions and never writes code;
- **the worker** — one task implemented in isolation, on its own branch in its
  own worktree;
- **the review session** — reads the diff, runs the checks, writes a verdict. It
  sets no status and merges nothing;
- **your own orchestrator** — whatever agent sits above all of this in your
  project, if you run one. briefboard neither knows nor needs to know about it,
  which is why the review session's variable is `BRIEFBOARD_REVIEW_CMD` and no
  longer says "orchestrator".

The briefing session does exactly one thing: refine the task, write a brief into
`doc/brief/`, set the task to `ready`, and stop — or come back with questions
instead (see below). You then read the brief and decide whether to hand it to a
worker — the refinement conversation is the one place where this workflow catches
misunderstood requirements, so it is never automated end to end.

**It is started once, not once per drop.** The drop into Open starts the briefing
session only for a task that has **no** brief yet. A task that already has one is
coming back up out of the backlog, and writing a second brief over the first is
not what dropping the card asked for — so the drop just moves it. When that brief
does need revisiting, the **Start the briefing session** button on the card is
how you say so.

### The route of a card, and where you stand in it

```
+ button ──▶ Backlog ──drop──▶ Open ──▶ Ready ──drop──▶ In progress ──▶ Review ──▶ Done
                        (briefing session)   (you read      (worker session)  (you review
                                              the brief)                       and merge)
```

Both drops are deliberate acts by a human who has seen what came before: you open
a task when you want it refined, and you start it only after reading the brief
the refinement produced. Nothing walks the card from `backlog` to `done` on its
own.

**The merge is yours and stays manual.** The board never merges a branch:
checking the work and deciding it is good is the point at which a human is
irreplaceable, so it is not automated at all. What the board does at that end is
what it can verify and undo nothing of — it reads whether your merge has happened
and, once it has, lets you accept the task and remove the worktree from the card.

The feature is **off by default**: nothing is spawned unless you configure a
command. There is no default command either — briefboard assumes nothing about
which agent you run.

### What briefboard needs from an agent

The board starts a command, gives it a directory, and reads what it printed.
Everything else is the agent's business — so any CLI that can do these four
things can sit behind a session, and it is worth checking yours against them
before you write a template:

- **run one prompt and exit.** The command is spawned, and the process ending is
  what the board calls the end of the session. A CLI that opens an interactive
  conversation and waits for you never finishes one.
- **work with no terminal.** stdin is closed and there is nothing to answer a
  prompt with, so a login, a confirmation or a permission question has to be
  settled *before* the session starts, not during it.
- **read and write files in its working directory.** The task, the briefs and the
  code are files; the board hands over a task id and a directory, and nothing
  else.
- **run `node tools/task.mjs`.** That is the only way a session reports back — a
  status, a brief link, a report, a verdict, a question. An agent that cannot run
  a command can read your repository but can never move a card.

Nothing else is required, and no output format is: a session that prints nothing
at all is still a valid session. The one feature that reads the output is the
token counter, and only because you tell it how (see
[what a task took](#what-a-task-took)).

**Which parts of the commands below are not briefboard's.** Everything after the
prompt: `-p`, `--allowedTools`, `--disallowedTools`, `--output-format`,
`--dangerously-skip-permissions`. That is the syntax of one agent CLI, checked by
running it on Claude Code 2.1.232. briefboard only splits your template into
arguments and runs it, so on another CLI those flags are spelled differently, sit
in a config file, or do not exist at all. What belongs to briefboard is the short
list above, the `{id}` and `{profile}` placeholders, and the `BRIEFBOARD_*`
variables.

**The default that does not transfer is the one about permissions.** Everything
written here about a missing permission describes an agent that refuses the tool
call and exits quietly — that is Claude Code's default, and what it costs you is
a session that did nothing. Another CLI may default the other way and simply run
whatever it is told to. Then the warnings here read as reassurance while the
failure is the mirror image: not a session that wrote nothing, but one that wrote
what nobody allowed. Find out which of the two defaults your agent has before you
point the board at it — the answer decides whether its permission list is a
safety net or the only thing between an agent and your repository.

### The two endings of a session

A session runs headless: its stdin is closed and there is no terminal, so it
cannot ask you anything while it works. That leaves exactly two honest endings,
and the prompt below spells both out:

1. **The requirements are clear** — it writes the brief and sets the task to
   `ready`.
2. **It has at least one real question** — it does **not** set `ready`. It
   appends a `### Session questions` section to the end of the task description,
   one question per bullet, leaves the task in `open`, and stops.

The second ending is a success, not a failure: an agent that guesses and sets
`ready` anyway produces an official-looking brief nobody checked, and code gets
written from it. The board marks such a card **needs answer**, so the tasks
waiting on you are visible at a glance.

```bash
# Claude Code — ready to copy:
BRIEFBOARD_SESSION_CMD='claude -p "Take task {id} from doc/backlog.md and act per agents/ORCHESTRATOR.md.
First read the task and its whole description.
If the requirements are clear: write the brief into doc/brief/ and set the task to ready.
If you have even one substantive question: do NOT set ready. Append a section titled
### Session questions
to the end of the task description, one concrete answerable question per bullet, leave the task in open, and stop.
Never invent an answer for the user, and never bury a doubt in the text of the brief.
If that section is already there and now carries answers: take them into account, write the brief, set ready."
--allowedTools "Read,Glob,Grep,Edit(doc/brief/**),Bash(node tools/task.mjs:*)"' \
  node server/server.js
```

The heading is matched as one exact string on a line of its own, so keep it
verbatim — that literal line is what the board looks for.

### Tool permissions: without them the session writes nothing

A headless session has no terminal, so a permission prompt has nobody to answer.
The agent blocks the tool call, says so politely into the log, and exits **0** —
the board shows a session that ran and finished, the task never moved, and not a
byte was written. That is why the command above ends with an explicit
`--allowedTools` list, and why the list is worth reading before you copy it: that
line is where you decide what an agent may do in your repository.

- **The flags go after the prompt.** `--allowedTools` takes a list, so
  `claude -p --allowedTools Read Edit "…the prompt…"` swallows the prompt as one
  more tool name and dies with `Input must be provided either through stdin or as
  a prompt argument`. Prompt first, flags after it.
- **The briefing list is the small one.** Read the repo, create and fill one file
  under `doc/brief/`, run `node tools/task.mjs` (brief, status, note). No git, no
  tests, no write anywhere else — that is the whole job of a briefing session.
- **The review list has no write in it at all.** A reviewer that can edit the
  branch stops being able to tell you what it found there, so
  [the review session](#the-review-session-a-task-already-in-review) below gets
  no `Edit`, no `Write`, and git only by read-only subcommand.
- **Path rules are spelled `Edit(...)`.** `Write(doc/brief/**)` matches nothing at
  all; `Edit(...)` covers every file-editing tool, `Write` included. A bare
  `Edit` without a path grants no writes either.
- **`--dangerously-skip-permissions` is not the shortcut here.** It turns every
  check off at once, in your working repository, with your files and your git
  history in reach. It is a choice you can make deliberately for a sandbox; it is
  not what we hand you as a default.

The syntax belongs to the agent CLI, not to briefboard: the lists here were
checked by running them on Claude Code 2.1.232, and are worth re-checking on
another CLI or a much later version.

**Answering the questions.** Open the card: a task marked *needs answer* carries
an answer box in its dialog. Type the answer, leave "Restart the briefing
session" checked, and send — the text is appended to the end of the description
under `### Answers`, and the session runs again with the answers in front of it.
That closes the circle on the board: question → answer → brief.

The endpoint behind that box only ever **appends**. Nothing already in the
description — refinement decisions, review comments, worker reports — is changed
or removed by any answer. Questions and answers are a correspondence, so each one
opens its own section in the order it was written: ask, answer, ask again, answer
again, four sections, and the card's marker follows whichever came last. It
changes no status either: the task stays in `open` and it is the session that
sets `ready` once it has what it needed.

You can still answer by hand — edit the description in `doc/backlog.md` or with
`node tools/task.mjs note <id> --section Answers --text -` — and restart the
session yourself. What does not work either way is re-dropping the card into
Open: the task left `backlog` when it was opened the first time.

- `BRIEFBOARD_SESSION_CMD` — the briefing command template (the drop into Open).
  `{id}` is replaced with the task id (`T-0007`). Empty or unset = that drop
  starts nothing.
- `BRIEFBOARD_WORKER_CMD` — the worker command template (the drop into In
  progress), configured and reported separately from the briefing one. See
  [the worker session](#the-worker-session-ready--in-progress) below.
- `BRIEFBOARD_REVIEW_CMD` — the review command template (the button on a
  card already in Review). Unset = the button is not there at all. See
  [the review session](#the-review-session-a-task-already-in-review) below.
  `BRIEFBOARD_ORCHESTRATOR_CMD` is the earlier name of the same setting and is
  still read, so an existing board keeps working untouched; with both set,
  `BRIEFBOARD_REVIEW_CMD` is the one used.
- `BRIEFBOARD_SETUP_CMD` — the command that makes a fresh worktree usable, e.g.
  `npm ci`, `flutter pub get`, `uv sync`. An isolated session gets a *checkout*,
  which has no `node_modules`, no packages and no venv, so a project with
  dependencies needs this before its tests can run at all. It is run once per
  worktree, with that worktree as its working directory, before the worker
  session starts; the briefing and review sessions run in the project root and
  never trigger it. A non-zero exit or a run longer than 10 minutes
  (`BRIEFBOARD_SETUP_TIMEOUT_MS` below) kills the command and refuses the session — an agent turned loose in an unprepared
  checkout reports failures that are not its task's. The reason and the command's
  own output go into the session log, as `[briefboard] setup failed (...)`. A
  successful run is recorded in `.briefboard/worktrees/T-0007.setup.json`, and
  only the presence of that file suppresses the next run: a preparation that
  failed is retried on the next session, and deleting the file forces a rerun.
  Unset = nothing is run and nothing is said about it. The price is one
  installation per task, paid on the first session of that task.
- `BRIEFBOARD_SETUP_TIMEOUT_MS` — how long that command may take, in
  milliseconds (default `600000`, ten minutes). The default is a ceiling, not a
  measurement: briefboard has never run your install command and cannot size it,
  so if you know yours can never legitimately take that long, say so here and a
  hung install refuses the session in seconds instead of holding the drop for ten
  minutes. Empty, or anything that is not a positive number, falls back to the
  default rather than turning the limit off — the same rule as
  `BRIEFBOARD_SESSION_MAX`.
- `BRIEFBOARD_SESSION_MAX` — how many sessions may run at once, over both kinds
  together (default `4`).
- `BRIEFBOARD_PROFILES` — the run profiles you declare, comma-separated. Their
  value replaces `{profile}` in either template — a placeholder you add yourself,
  since the ready-to-copy commands here carry none. See
  [the run profile](#the-run-profile-which-mode-an-agent-runs-in) below.
- `BRIEFBOARD_TOKENS_RE` — a regular expression whose first capturing group
  catches a token count in a session's log. Unset = the board reports how long a
  task took and says nothing about tokens. See
  [what a task took](#what-a-task-took) below.
- `BRIEFBOARD_TOKENS_MODE` — what the matches mean: `sum` (the default) adds
  every match up, `last` takes the number of the last match, for an agent that
  prints a running total. Any other value counts nothing and says so at start-up.
  See [what a task took](#what-a-task-took) below.
- Session output (stdout + stderr) is written to
  `.briefboard/sessions/T-0007-<timestamp>.log` in the project root. Add
  `.briefboard/` to your `.gitignore`. The logs deliberately live outside `doc/`:
  the server watches `doc/` and pushes a board refresh on every change there, so a
  log inside it would turn every line an agent prints into a repaint for every
  open board.
- The response to the drop reports what happened: `started`, `briefed` (the drop
  into Open found a task that already has a brief, so nothing was spawned),
  `disabled`, `already-running`, `limit`, `unknown-profile` or `error` — plus the
  refusals an isolated session can add (see below).

### Windows: an agent CLI installed as an npm shim

The command is run **without a shell** — a security property of the runner, and
one that will not change. On Windows that has a consequence: a global npm install
puts a `.cmd` shim on your PATH, and since Node's CVE-2024-27980 hardening a
`.cmd`/`.bat` file cannot be started without a shell at all (`npm` fails with
`ENOENT`, `npm.cmd` with `EINVAL`). If your agent is such a shim the session does
not start; the server log and the session log then carry a hint with the two ways
out, both of which live in your own template:

- point it at the real executable:
  `BRIEFBOARD_SESSION_CMD='C:\path\to\claude.exe -p "..."'`;
- or wrap the call yourself: `BRIEFBOARD_SESSION_CMD='cmd /c claude -p "..."'`.

The second one works because `cmd.exe` is a real executable, and `/c` and the rest
reach it as ordinary arguments — the shell is your explicit choice in your
template, not something the runner slips in behind you. The same holds for
`BRIEFBOARD_WORKER_CMD` and `BRIEFBOARD_REVIEW_CMD`.

### Isolated sessions (own branch, own worktree)

A session can be started **isolated**: instead of the project directory it gets
its own git worktree at `.briefboard/worktrees/T-0007`, on a branch `task/T-0007`
created from the shared checkout's current HEAD. That is what a session which
writes code needs — and the shared checkout keeps its own HEAD and its own
branch, because `git worktree add` is the only git command the board ever runs
there.

A worktree carries what is **committed**. Anything that only exists in the
working tree — an uncommitted brief above all — is not in it, which is why a
session reads the task and its briefs from the shared checkout instead (see the
worker session below).

**And a worktree is a checkout, not an installation.** `git worktree add` writes
the tracked files and nothing else: no `node_modules`, no `.dart_tool`, no venv,
no `vendor/`. So a brief that tells the worker to run the tests sends it into a
tree where the test command fails for a reason that has nothing to do with the
task — and the agent, having no way to know that, reports the failure as if it
were the task's.

`BRIEFBOARD_SETUP_CMD` (see the environment list above) is the answer to that,
and it is one you have to give: it runs your `npm ci`, `flutter pub get` or
`uv sync` once inside a new worktree, before the worker starts in it, and refuses
the session rather than handing over an unprepared tree if it fails. Declare
nothing and nothing runs — the worktree stays exactly as empty as before, which
is the right default for a project that needs no install and the wrong thing to
leave in place for a project that does. briefboard does not guess the command:
it does not know your stack, and a wrong install command is worse than none.

**The price is real and it is per task.** One installation on the first session
of every task; for a large toolchain that can be more than the task itself costs.
Worth weighing against the alternative, which is an agent debugging an absent
dependency at the same rate.

**If you would rather the agent installed things itself**, then that command has
to be in its own permission list. A worker whose prompt says "run the tests" and
whose `--allowedTools` carries no `Bash(npm ci)` gets `requires approval` in a
headless session with nobody to approve it, and the run ends having written
nothing (see [tool permissions](#tool-permissions-without-them-the-session-writes-nothing)).
The setup command has no such problem — the board runs it directly, not through
the agent — which is the second reason to prefer it.

If the worktree cannot be prepared the session does not start at all and the
answer says why: `not-a-repo`, `no-git` or `worktree-failed` (git's own message
goes into the session log), and `setup-failed` or `setup-timeout` when it is
`BRIEFBOARD_SETUP_CMD` that would not finish. It never quietly falls back to the
shared checkout.

The worktree is **not** removed when the session ends — the work is in it. Once
the branch is merged, the card's **Remove the worktree** button does it for you,
and only while the branch is merged and the tree is clean; the same two commands
by hand are:

```bash
git worktree remove .briefboard/worktrees/T-0007
git branch -d task/T-0007
```

The worker session below is the one that runs isolated. The briefing session
stays in the project directory: it only writes a brief, and it needs to see the
project as it is.

### The worker session (Ready → In progress)

Dropping a card from **Ready** into **In progress** takes the task into work, and
starts the worker session for it if `BRIEFBOARD_WORKER_CMD` is set. Unlike the
briefing drop this one asks for confirmation first — it starts an agent that
writes code and commits it — and the confirmation says plainly when no command is
configured, in which case the card just moves and the work is yours.

The session runs **isolated**: its own git worktree, its own branch `task/T-0007`
(see above). A task whose prerequisites are unfinished cannot be started from the
board at all: the server refuses it with the blockers named. There is no `--force`
here on purpose — overriding a dependency stays a deliberate CLI act
(`node tools/task.mjs status T-0007 in_progress --force`), which warns loudly.

```bash
# Claude Code — ready to copy:
BRIEFBOARD_WORKER_CMD='claude -p "Implement task {id} from doc/backlog.md per agents/WORKER.md.
You are ALREADY isolated: the board started you in your own git worktree on branch task/{id}. Do not create another worktree or switch branches.
Your worktree was made from the last commit, so a brief written minutes ago and not yet committed is NOT in it. Read the task and its briefs from the SHARED checkout, whose path the board puts in AGENTBOARD_ROOT — print it with: printenv AGENTBOARD_ROOT
node tools/task.mjs show {id}
Then read ALL the briefs it lists, at $AGENTBOARD_ROOT/doc/brief/{id}-*.md — those files, never the doc/brief inside your worktree; do not copy them into it and do not commit them.
Implement exactly what they describe — nothing beyond their scope. Cover the change with tests, and commit each finished piece on your branch as you go — a session cut off by a limit loses everything uncommitted.
Do NOT set the task to in_progress: the drop on the board already did that.
Write the status and your report with the CLI below — it already writes to the backlog of the SHARED checkout, never to the copy inside your worktree, so it needs no path and no environment prefix:
node tools/task.mjs status {id} review
Put the report there with the same CLI, using the note command shown in agents/WORKER.md step 3 — never by editing doc/backlog.md.
Your branch must contain no changes to doc/backlog.md at all.
Anything you find along the way that deserves a card of its own — a bug, a missing capability, scope left outside this task, an external blocker — is filed as a SEPARATE task with the same CLI, with the type that fits it. Do not fix it quietly, do not widen your task, and do not leave it only in the report; file it and carry on:
node tools/task.mjs add --type bug|feature|external --priority Major --title ... --desc Found while working on {id}
If the briefs are unclear or contradictory: do NOT guess and do NOT set review. Append a section titled
### Session questions
to the end of the task description with that same note command, one concrete answerable question per bullet, leave the task in in_progress, and stop.
If that section is already there and now carries answers: take them into account and carry the work on.
If a brief asks you to check how something looks, look: this takes a picture of the board and prints its path, and you read the png like any other file.
node tools/screenshot.mjs --lang en"
--allowedTools "Read,Glob,Grep,Edit(**),Bash(printenv:*),Bash(git:*),Bash(node tools/task.mjs:*),Bash(node tools/screenshot.mjs:*),Bash(npm test),Bash(npm run:*),Bash(node --test:*)"
--disallowedTools "Edit(doc/backlog.md)"' \
  node server/server.js
```

Those instructions are what make the run usable, and they come from the protocol
rather than from taste:

- **do not set `in_progress`** — the drop already did, and a worker that sets it
  again is a worker that has not noticed where it is in the lifecycle;
- **write statuses to the shared checkout** — the board reads the shared
  `doc/backlog.md`, so a status written inside the worktree stays invisible until
  the branch is merged, and the card sits in "Ready" for the whole time the work
  is happening. The board makes that a property of the session rather than
  something the agent has to remember: it starts every session with
  `AGENTBOARD_ROOT` pointing at the project, so `node tools/task.mjs` writes to the
  shared backlog from inside the worktree, with no prefix to forget.
- **read the briefs from the shared checkout too** — the worktree is created from
  the current HEAD, and a brief the briefing session wrote minutes ago is an
  untracked file, so it is simply not in there. A worker that opens its own
  `doc/brief/` finds nothing and starts guessing, while you look at the brief on
  your screen and wonder what it is doing. The same `AGENTBOARD_ROOT` that carries
  the status out points at the briefs to read in.
- **file what you find as its own task** — a worker that meets a bug, a missing
  capability or a piece of scope outside its brief has three tempting ways to lose
  it: fix it quietly (nobody reviewed the extra), swallow it into the task, or
  mention it in the report, which is read once. `tools/task.mjs add` is in the
  session's permission list already, and this line is what turns it into a card.
  A blocked status write at least leaves a stuck card on the board; a finding that
  never reaches the backlog leaves nothing at all.
- **commit as you go** — a session ends on a usage limit or a timeout without
  asking, and work that never left the working tree ends with it. Measured here:
  of three worker sessions killed that way in one day, two had changed files and
  no commits at all. `agents/WORKER.md` step 2 says the same, with the second
  reason as well; the prompt repeats it because the prompt is what a session
  reads first.

The board does not fix that by committing the brief for you: a commit in your
repository, on your branch, past your review, is not something a tool does behind
your back. Nor does it copy `doc/` into the worktree — a second copy of the
backlog becomes a second backlog the moment anyone edits it. There is one set of
task data, in the shared checkout, and every session reads and writes exactly
that one.

Its permission list is longer than the briefing one because the job is: it edits
code, runs the tests and commits. Four things in it are not decoration:

- **`Bash(printenv:*)`** is how the session learns where the shared checkout is.
  The variable is in its environment, but a tool call is what turns it into a
  path — without that one rule the brief stays unreadable for want of its
  directory.
- **`--disallowedTools "Edit(doc/backlog.md)"`** turns "your branch must contain
  no changes to `doc/backlog.md`" from a request into a fact. The status still
  reaches the board, because it goes through `tools/task.mjs`, not through an
  editor.
- **`Bash(node tools/screenshot.mjs:*)`** is the session's only way to see. A
  brief that says "the header must not wrap in Japanese" is unverifiable without
  it: starting a server is not in this list, and a headless session has nobody to
  approve it (T-0143 — the criterion that went unchecked by everyone in the loop).
  It is a narrow door on purpose. The session may photograph the board; it does
  not get the right to run arbitrary processes or a browser in your repository,
  which is the same line `Bash(node tools/task.mjs:*)` already draws.
- **The test rules are yours to adjust.** `Bash(npm test)` and `Bash(npm run:*)`
  fit this project; put your own runner there. `Bash(git:*)` is every git command
  — that is the price of an agent that commits, and the reason the session gets
  its own worktree and its own branch.

**A worker session has the same two endings as a briefing one.** Either it takes
the task to `review`, or it has a real question and says so — because the third
possibility, guessing at an unclear brief, produces committed code written from a
requirement nobody confirmed. When it asks, the task **stays in `in_progress`**:
the worker's protocol allows it exactly two transitions and neither leads back,
so the status keeps saying which phase the task is in while the **needs answer**
marker says the work has stopped. A card in In Progress with that marker is
waiting for you, not being worked on.

You answer it from the card exactly as you answer a briefing session, and the
restart box then restarts the **worker** session — in its worktree, on its
branch, with the answers in the description in front of it.

When the session is done, the branch is waiting for you: read the diff, run the
tests, merge it and set the task to `done` yourself. The session below can do the
reading and the running for you — the deciding it cannot.

### The review session (a task already in Review)

A card in **Review** carries a button: *Start the review session*. It reads the
diff of the branch and the briefs, runs the tests and appends a
`### Review verdict` section to the task's description — and that section is its
whole output.

**It sets no status and it merges nothing.** Not `done` least of all: `done`
means "I accepted this", and merging is a judgement. The session prepares your
decision; it does not make it. That is why this is a button and not a drop —
the task is already in Review, the worker's own transition put it there, so there
is no column to move it into and nothing about its status to change. And it is
why the permission list below has no way to write code: a reviewer that quietly
fixes what it found is no longer telling you what it found.

It runs **in the project directory**, not in a worktree of its own: the diff it
reads belongs to the branch the worker created, and the verdict goes to the
shared backlog. A worktree would put it on a copy where neither of those is what
it is looking at.

```bash
# Claude Code — ready to copy:
BRIEFBOARD_REVIEW_CMD='claude -p "Review task {id} of this project and write a verdict.
The board started you in the project directory — do not create a worktree and do not switch branches. Its path is in AGENTBOARD_ROOT: printenv AGENTBOARD_ROOT
The --full below is what prints the worker report, which you are reviewing; without it show leaves reports out:
node tools/task.mjs show {id} --full
Read ALL the briefs it lists, at $AGENTBOARD_ROOT/doc/brief/{id}-*.md
The work is on branch task/{id}. Read what it changed, without checking anything out:
git log --oneline HEAD..task/{id}
git diff HEAD...task/{id}
Run the tests on that branch in the worktree the worker left behind, which is that branch checked out:
cd .briefboard/worktrees/{id} && npm test
If that directory is not there, do not test something else — say so in the verdict.
Write your verdict with this CLI, and it is your ONLY output. The text comes from stdin, so use a heredoc as agents/WORKER.md step 3 shows:
node tools/task.mjs note {id} --section '\''Review verdict'\'' --text -
Say in it: which acceptance criteria of the briefs are met and which are not, what the tests did, what you would change, and plainly whether you would merge it.
Do NOT set any status, done least of all. Do NOT merge, do NOT rebase, do NOT delete the worktree. You have no permission to write code, and that is deliberate: report what you found, do not repair it.
If the briefs or the diff leave you unable to judge: append a section titled
### Session questions
with that same note command, one concrete answerable question per bullet, leave the task in review, and stop.
A criterion about how something looks is judged by looking, not by reading the diff — this photographs the board and prints the path of the png, which you read like any other file:
node tools/screenshot.mjs --lang en"
--allowedTools "Read,Glob,Grep,Bash(printenv:*),Bash(cd:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git status:*),Bash(git branch:*),Bash(node tools/task.mjs:*),Bash(node tools/screenshot.mjs:*),Bash(npm test),Bash(npm run:*),Bash(node --test:*)"
--disallowedTools "Edit,Write,NotebookEdit"' \
  node server/server.js
```

Four things in that list are the point:

- **no `Edit`, no `Write`** — and `--disallowedTools` says so a second time. The
  session reports; it does not fix. A verdict from an agent that has been editing
  the branch is a verdict on its own work.
- **git is read-only, by subcommand** — `log`, `diff`, `show`, `status`,
  `branch`. Not `Bash(git:*)`, which would carry `merge`, `checkout` and `reset`
  along with them; the boundary is only real if the permission list draws it.
- **`Bash(node tools/task.mjs:*)`** is how the verdict gets written at all. It
  needs no path and no environment prefix: the board puts `AGENTBOARD_ROOT` in
  the session's environment, so the CLI writes to the shared backlog wherever the
  session's cwd is.
- **`Bash(node tools/screenshot.mjs:*)`** is here for the same reason it is in
  the worker's list, and it does not soften the rule above it: a picture is
  something you read, not something you write. Without it a verdict on "the
  header must not wrap" is a verdict on the worker's word for it — and the
  reviewer cannot fall back on running the board either, since its permissions
  are narrower than the worker's, not wider (T-0143).

**A review session has the same endings as the other two.** Either it writes a
verdict, or it has a real question and writes a `### Session questions` section —
and the task **stays in `review`** while the card carries the **needs answer**
marker. You answer it from the card exactly as before, and the restart box then
restarts the **review** session.

The verdict sections never merge into one another: a task you return for rework
comes back with a different branch behind it, so the second review opens its own
section and the first stays where it is, above it.

### The run profile (which mode an agent runs in)

Not every task needs the same agent. Measured in this project: a documentation
task costs 46–72 thousand tokens, a narrow code task 53–98, a broad one 150–274.
Running a three-README edit in the mode you keep for the process-spawning
subsystem is simply wasteful.

So a task carries an optional field, `profile`, and its value is substituted into
the command template as `{profile}` — exactly the way `{id}` is, after the
template has been split into arguments, so a profile can never add an argument
boundary of its own.

**It takes two steps, and neither of them works alone:**

1. **declare the values** in `BRIEFBOARD_PROFILES`, comma-separated. They are
   **yours**, and the first one is the default — the profile a task with no
   profile of its own runs with;
2. **put `{profile}` into your command template** — `BRIEFBOARD_SESSION_CMD`,
   `BRIEFBOARD_WORKER_CMD`, `BRIEFBOARD_REVIEW_CMD`, or any of them.
   Declare the values and leave the templates alone, and there is nowhere to
   substitute them: the choice is stored on the task and reaches no command.

The ready-to-copy commands above carry no `{profile}` on purpose: a template that
uses it while nothing is declared refuses to start (see the refusals below), so
the default has to keep working for everyone who never declared a profile. Add
the placeholder yourself, in the same breath as the declaration:

```bash
BRIEFBOARD_PROFILES='deep, fast' \
BRIEFBOARD_WORKER_CMD='agent --mode {profile} -p "Implement task {id} ..."' \
  node server/server.js
```

That example replaces the ready-to-copy worker command above rather than joining
it — copy one or the other, never both.

**briefboard does not know what a profile is.** Not that it is a model, not which
models exist, not which came out this month. It checks that the task's value is
one you declared and substitutes the string; what `deep` and `fast` mean lives
entirely in your template and in your agent — a model, a reasoning level, a step
budget, a different agent altogether.

Set it on a task from the CLI or from the card:

```bash
node tools/task.mjs profile T-0007 fast     # one of the declared values
node tools/task.mjs profile T-0007 --clear  # back to the default
```

The card's dialog gets a **run profile** selector built from your declaration —
and no selector at all when you have declared nothing. When your templates carry
no `{profile}`, the selector is still there and says so under it: the choice is
stored, and until the placeholder is in the template it starts nothing different.
If only one of the two templates has it, the note names which kind of session the
choice reaches — a profile can work for worker sessions and mean nothing for
briefing ones. In the agent workflow it is the orchestrator that sets it, at
briefing time: by then it knows how mechanical the work is, which the person
filing the task did not.

Three refusals keep a mistake from reaching a command line:

- a task whose profile is not in your list does **not** start a session at all
  (`unknown-profile`, with the reason in the board's log) — a typo must not
  quietly travel into an agent's arguments;
- a template that uses `{profile}` while nothing is declared disables that kind of
  session at start-up, saying so, instead of running `--mode` with a hole after it;
- with nothing declared the field is ignored entirely: existing setups behave
  exactly as they did before this feature existed.

**The risk, plainly: a wrong choice costs more than the saving.** A mode too weak
for the task buys a rework, and the one rework measured here cost 200 thousand
tokens — the saving from a dozen documentation tasks, spent at once. Save on work
you know is mechanical; when in doubt, leave the default.

### Watching a session from the board

A card with a session on it carries a marker of its own: **session live** with a
pulsing dot while the agent runs, then **session done**, **session failed**,
**session stopped** or **session cut short** (it went down with the board and was
not restarted) once it ends — so a session that died is visible as such, instead
of looking like a card that quietly stopped moving. It is a third,
independent marker: a card can carry "blocked", "needs answer" and a session
marker at once.

Opening the card gives a **Session log** button. The log opens over the task
dialog, shows the tail of what the agent printed (the last 200 KB, with the full
size stated next to it) and offers **Stop the session**, after a confirmation —
stopping interrupts the agent where it stands, and whatever it already wrote to
disk stays.

#### An empty log while the session runs is normal

Many agents buffer their output and print all of it when they exit — `claude -p`
in its default text mode does. Until the first byte arrives the log view says so
instead of showing a blank pane: the session is running and has written nothing
yet. That is the honest reading of an empty file under a live session, and it is
the only one the board can give, since it does not know which agent you started.
A finished session with an empty log says something different, because it means
something different (see the hint the runner appends in that case).

**If you want the log to fill as the agent works**, that is a property of the
agent's CLI, not of the board — briefboard writes whatever the process prints and
the open log view follows it live. Claude Code has a streaming mode for exactly
this:

```bash
BRIEFBOARD_SESSION_CMD='claude -p "…the prompt…"
--output-format stream-json --include-partial-messages --verbose
--allowedTools "Read,Glob,Grep,Edit(doc/brief/**),Bash(node tools/task.mjs:*)"' \
  node server/server.js
```

This is a **variant, not the default**, for two reasons worth knowing before you
copy it:

- **The flag belongs to one CLI.** Another agent spells it differently or has no
  such mode at all; the default command stays plain because briefboard never
  assumes which agent is behind it. (`--verbose` is not optional here: with
  `-p`, Claude Code 2.1.232 refuses `--output-format stream-json` without it.)
- **The log then reads as JSON.** Every line becomes one JSON event, and the log
  view shows those lines exactly as they arrive — briefboard does not parse an
  agent's output format and does not render it into prose. You trade readability
  for liveness; which of the two you want is a per-session choice, so it lives in
  your template.

That state is deliberately **not** part of `/api/board`: that response is cached
against `doc/backlog.md`'s mtime and size, and a session starting or dying
changes neither — a board reading it there would be answered `304` and would
never learn that the session ended. It comes from its own uncached endpoints
instead, refreshed by their own SSE event (`sessions`, separate from the board's
`changed`, so a session's life never makes the board re-read the backlog):

- `GET /api/sessions` — the registry: `id`, `kind`, `status`, `startedAt`,
  `endedAt`, `exitCode`, `signal`, `pid`, and `branch`/`worktree` for a session
  that ran isolated. Never a log path — the file to read is chosen server-side
  from the task id, and no part of it comes from the client. The same answer
  carries `costs`, the per-task sum over every session the registry still has
  (see [what a task took](#what-a-task-took)), and the watchdog's findings, which
  are made of those same records and of git.
- `GET /api/session/T-0007/log` — the tail of that session's log as
  `text/plain`, with `X-Log-Total-Bytes` and `X-Log-Truncated`. The board renders
  it as text and never as HTML: an agent's output is not trusted markup.
- `POST /api/session/T-0007/stop` — kills a running session (`409` if it already
  ended, `404` if there is no session for that task), behind the same
  same-origin guard as every other writing endpoint.

Starting a session is the only place where the board starts a process, so it is
kept narrow:

- the command comes only from the environment, never from the HTTP request — the
  request contributes the task id and nothing else;
- the template is split into argv by the server and run **without a shell**;
  `{id}` is substituted after the split, so it can only change the contents of an
  argument, never add one;
- sessions are disabled outright when the server is not bound to loopback
  (otherwise a local "run this command" endpoint would be reachable from the
  network); the server says so at start-up;
- a session that fails to start does not undo the transition — the card stays
  where you dropped it and the failure is reported in the response; it never
  takes the server down. The drop into In Progress is the one exception, and it
  is about what a status means: a dispatch that never reached a session puts the
  task back to `ready`, because `in_progress` says an agent is on the task rather
  than that somebody tried. A task whose session is already running keeps its
  place, and so does one on a board with no worker command — there the drop is a
  person taking the task by hand;
- no session outlives the server when the board is stopped: stopping it kills the
  sessions it started — the whole process tree, not just the process the board
  can see. What is bounded is how long it then waits for the session logs to be
  released, because a descendant that broke out of that tree and survived the
  kill would otherwise be waited out for its whole life (measured once at 20
  seconds). Past the bound the board closes the logs itself and goes, saying so
  in its output and leaving that session's record still on `running`; whatever
  survived is cleaned up at the next start like any other leftover. A board that
  is killed hard, crashes, or goes down with the machine gets to kill nothing at
  all, and the operating system does not end an
  agent just because whatever started it is gone — so the board writes down the
  processes of a running session while it runs, and the next start ends what is
  left of them and says so. The gap it cannot close: a session whose processes
  were never written down — one less than half a minute old when the board died,
  or one that ran while the machine would not list its processes at all. Neither
  case is silent: the board says so while it is happening, and the next start
  names the sessions it has no record for. Measured on Windows and Linux; on
  macOS this half has never been run.

### What a task took

Open a task that has had sessions and the card tells you what it took: how many
there were and of which kind, how long each one ran, how it ended, and the total.
The board measures all of that from its own registry — you configure nothing, and
nothing about your agent has to be known for it to work. A session still running
is counted up to now and marked, so the total says plainly that it is a total so
far.

The registry keeps a bounded number of finished runs, so the older sessions of an
old task eventually fall out of it. When that has happened the card **says so**:
the sum is labelled incomplete and names how many runs it no longer has, instead
of passing a smaller number off as the whole.

**Tokens are the part only your agent knows.** They are in its output, in its
format, and briefboard does not parse that format — the same line it holds
everywhere else: it does not know which agent you started, and it will not chase
another project's changes to its output. So you declare how to read the number:

```bash
BRIEFBOARD_TOKENS_RE='"cache_read_input_tokens":\s*\d+,"output_tokens":\s*(\d+)' \
BRIEFBOARD_SESSION_CMD='claude -p "…the prompt…" --output-format json
--allowedTools "Read,Glob,Grep,Edit(doc/brief/**),Bash(node tools/task.mjs:*)"' \
  node server/server.js
```

**Both halves are the point.** The counter reads the session's log, so the number
has to be printed into it first — and the ready-to-copy commands elsewhere on
this page do not print one. `claude -p` in its default text mode writes prose and
no usage at all, so an expression declared next to *that* command matches nothing
and the card silently goes on showing only time. Getting a number into the log is
a change to your command, not to the board: on Claude Code 2.1.232 that is
`--output-format json` (one JSON object at the end, `usage` included) or
`--output-format stream-json --verbose` (one JSON event per line). Both flags
belong to that CLI; another agent prints its usage its own way, or not at all.

**What it costs to turn on:** the log stops being something you read. In `json`
mode the whole session comes out as one machine-readable object, in `stream-json`
as a stream of events (see
[an empty log while the session runs](#an-empty-log-while-the-session-runs-is-normal)).
The session log is where you look when something went wrong, so trade it
deliberately rather than by copying a line.

**Then check what your expression actually matches**, because by default *every*
match is summed. Measured on Claude Code 2.1.232 with a one-turn session: the obvious
`"output_tokens":\s*(\d+)` matches twice in a single `--output-format json`
result — once in `usage`, once inside `usage.iterations[]` — and four times in
the `stream-json` log of the same run, reporting 72 and 90 tokens for sessions
that produced 36 and 41. The expression above is anchored on the key that
precedes the total in the outer `usage` block and matched exactly once in both.
Run one session and count the matches in its log before you believe the figure.

**Then say what those matches mean**, if adding them up is not it:

```bash
BRIEFBOARD_TOKENS_MODE=last
```

`sum`, the default, adds every match up — right for an agent printing its usage
per turn. `last` takes the number of the last match — right for one printing a
running total, or printing the same total more than once. Both are legitimate,
and no log can tell them apart: 36 followed by 41 is 77 spent per turn or 41
spent in total, and the two logs look the same. So this is yours to declare, like
the expression itself. Any other value counts nothing and says so at start-up: a
quiet fallback to `sum` would be the doubled figure again, and a wrong number
looks exactly like a right one.

- the expression is applied to the tail of each session's **own** log (the last
  200 KB), and the first capturing group of every match is read as a number —
  added up, or, in `last` mode, taken from the last match that holds one;
- with nothing declared — or when a log holds no such number — the card shows the
  time and says nothing about tokens. It never shows a zero: "zero tokens" is a
  claim, and there is nothing here to support it;
- the numbers live with the session records under `.briefboard/`, never in
  `doc/backlog.md`: this is runtime data about processes, not part of a task;
- money is not counted. Rates and models are yours, and they are not the board's
  subject.

## Several boards side by side

Every project keeps its own copy of the board (`init` copies `server/` into it),
so you run one board per project:

```bash
cd ~/code/payments-api && briefboard serve
cd ~/code/mobile-app  && briefboard serve
```

- **Ports take care of themselves.** The board starts on `4571`; if that is taken
  it moves to the next free port (up to `4590`) and prints the URL it actually
  bound. A port you ask for by hand is never substituted:
  `briefboard serve --port 8080` (or `PORT=8080 node server/server.js`) fails
  with `port 8080 is already in use` instead of quietly serving elsewhere. When
  the address does not matter at all — a board started by a script or a test —
  `--port auto` (or `PORT=auto`) leaves the choice to the operating system and
  prints the port it got, without touching the `4571-4590` range.
- **Every tab says whose backlog it is.** The board's header and the browser tab
  title carry the project name — the folder name by default, or whatever
  `BRIEFBOARD_NAME` says: `BRIEFBOARD_NAME="Payments API" briefboard serve`.
- **`briefboard serve`** starts the board for the current directory, so there is
  no `AGENTBOARD_ROOT` to remember. It prefers that project's own
  `server/server.js` when that file is briefboard's own — the manifest lists it,
  or it is byte-identical to the package. A `server/server.js` that a readable
  manifest does not list is named and not run, and the installed package's copy
  starts instead; with no readable manifest at all the project's copy runs
  anyway, and `serve` says that its provenance is unrecorded. Either way it
  prints which of the two it ran.

## Updating an installed project

`init` copies the runtime files into your project, so a newer package on npm does
not reach that project by itself — the copy is what actually runs. `briefboard
update` is what brings it forward:

```bash
npm install -g briefboard@latest   # or npx briefboard@latest ...
briefboard update                  # prints what would change; changes nothing
briefboard update --apply          # actually replaces the files
```

- **The plan comes first.** A plain `briefboard update` never writes anything. It
  prints one line per file: `up to date`, `outdated` (unchanged since install —
  safe to replace), `MODIFIED LOCALLY` (you edited it), `new in package`,
  `no manifest` (the project was installed by a briefboard before 0.2.0, which
  wrote none, so there is nothing to compare this file against),
  `unknown provenance` (there is a manifest and it does not list this file, so
  briefboard did not install it), `block removed` or `markers malformed` (the
  briefboard block in your `CLAUDE.md` / `AGENTS.md` is gone, or its markers are
  damaged). `--apply` adds every `new in package` file and replaces every
  `outdated` one — that is what the update is. Of the five it cannot vouch for,
  only `no manifest` is still replaced, after a backup; `MODIFIED LOCALLY`,
  `unknown provenance` and `block removed` are kept unless you add `--force`, and
  `markers malformed` is not touched even then.
- **`doc/` is never touched** — not by `--apply`, not by `--force`. Your backlog
  and briefs are yours.
- **`CLAUDE.md` and `AGENTS.md` are added to, not replaced.** With no such file
  briefboard writes its own; with one already there it appends a block between
  `<!-- briefboard:start -->` and `<!-- briefboard:end -->` and writes nothing
  outside it, under any flag. `update` refreshes the inside of that block only.
- **Files are kept for two different reasons.** A file briefboard installed and
  you then edited is `MODIFIED LOCALLY`. A file that was yours from the start —
  the `CLAUDE.md` of a project that already had one — is `unknown provenance`,
  because the manifest does not list it and briefboard did not put it there. Both
  are left alone by `--apply`; `--force` replaces either, with a backup.
- **Everything replaced is backed up** into
  `.briefboard/backup/<timestamp>/`, keeping the original paths; the command
  prints that directory on its last line. Keeping the project under git is still
  the better safety net — then a rollback is just `git checkout`.
- **`briefboard --version`** prints the package version and the version of this
  project's copy, and says so when they differ.

`init` and `update` record what they installed in `.briefboard/installed.json`
(package version plus a hash per file) — that is how `update` distinguishes "this
file is old" from "you changed this file". `.briefboard/` is already gitignored.

## CLI reference

```bash
briefboard init                  # scaffold briefboard into the current directory
briefboard update [--apply] [--force]
                                  # update this project's copy to the installed package
briefboard --version             # package version + this project's copy version
briefboard serve [--port N]      # start the board for the current directory

node tools/task.mjs add --type feature|bug|external --priority Blocker|Critical|Major|Medium|Minor --title "..." [--desc "..."] [--labels ui,docs]
                                  # create a new task in doc/backlog.md; --desc - takes the
                                  # description from stdin, and refuses an empty one rather
                                  # than filing a task with a dash for a description
                                  # --labels files the task already carrying them, in the same
                                  # ONE comma-separated argument the `labels` command takes
node tools/task.mjs status T-0007 <backlog|open|ready|in_progress|review|done|cancelled>
                                  # change a task's status (validates the transition)
node tools/task.mjs priority T-0007 <Blocker|Critical|Major|Medium|Minor>
                                  # re-triage a task after it was filed. Any value may follow
                                  # any other — there is no graph here and no --force — and the
                                  # change is recorded in the description under
                                  # "### Priority changes", so a card that became Critical does
                                  # not read later as though it always was
node tools/task.mjs depends T-0007 T-0005,T-0006   # set the tasks T-0007 waits for
                                  # the whole list in ONE comma-separated argument, and it
                                  # REPLACES the previous one — a second call naming only
                                  # T-0008 leaves T-0008 alone as the prerequisite. The
                                  # command prints what it dropped when it dropped anything
node tools/task.mjs depends T-0007 --clear         # drop them again
node tools/task.mjs labels T-0007 ui,docs          # set this task's labels
                                  # the whole list in ONE comma-separated argument, and it
                                  # REPLACES the previous one, exactly like depends. The set
                                  # of labels is implicit: a label exists while some task
                                  # carries it, and nothing declares it anywhere
node tools/task.mjs labels T-0007 --clear          # drop them again
node tools/task.mjs profile T-0007 fast            # run profile for this task's sessions
node tools/task.mjs profile T-0007 --clear         # back to the default profile
                                  # only values declared in BRIEFBOARD_PROFILES are
                                  # accepted — see the run profile above
node tools/task.mjs brief T-0007 <slug>
                                  # create doc/brief/T-0007-01-slug.md and link it to the task;
                                  # NN is one past the highest the task already links, and a
                                  # file that already answers to it is never written over
node tools/task.mjs link T-0007-01
                                  # put a brief file that ALREADY exists on the task's briefs:
                                  # line — written by hand, recovered, brought in from
                                  # elsewhere. Refuses an id no file answers to, and a repeat
                                  # adds no duplicate. This is the way out of "the file is on
                                  # disk and the task does not know it" without editing
                                  # doc/backlog.md by hand
node tools/task.mjs note T-0007 --section "Worker report" --text "..."
node tools/task.mjs note T-0007 --section "Worker report" --text -
                                  # append a section to the task's description (text from
                                  # stdin with "-"); append-only — a repeat call adds to the
                                  # same section and never rewrites what is already there
node tools/task.mjs show T-0007  # print the task (fields + description) as JSON; looks in
                                  # the archive too and says so when it found it there
node tools/task.mjs show T-0007 --full
                                  # the same, with the worker reports the default leaves
                                  # out; without the flag the JSON carries an "omitted"
                                  # field saying how many were left out and how to get them
node tools/task.mjs list [--status ready] [--label ui,docs] [--all] [--json]
                                  # list the live tasks, optionally filtered by status;
                                  # --all adds the archived (closed) ones
                                  # --label is the one repeatable flag: each occurrence is a
                                  # comma-separated set the task must carry ANY name of, and
                                  # every occurrence must match — so `--label a,b --label c`
                                  # is (a OR b) AND c. The board's `Labels ▾` filter is OR;
                                  # the two are described side by side in the guide
                                  # one occurrence holds at most 8 names (what a task itself
                                  # may carry); a ninth is refused rather than dropped —
                                  # a truncated set answers with fewer tasks and exit 0
                                  # --json prints ONE document {tasks, count} on stdout and
                                  # nothing else, under the field names `show` and
                                  # GET /api/board already use — so a program can read the
                                  # backlog without parsing doc/backlog.md
node tools/task.mjs runnable [--label ui,docs] [--status ready] [--json]
                                  # the tasks that can be STARTED now: status `ready` and no
                                  # unsatisfied prerequisite, decided by the same rule the
                                  # board's blocked marker and the ready → in_progress guard
                                  # use. --status can only narrow that set, so
                                  # `runnable --status review` is empty rather than an error;
                                  # --json prints `list --json`'s own {tasks, count}
                                  # --all is REFUSED: the archive holds closed tasks only,
                                  # and nothing closed is `ready`
node tools/task.mjs summary [--label ui,docs] [--json]
                                  # how much of a scope is left, as one document: a count per
                                  # status (all of them, so they sum to `total`), `blocked`,
                                  # the `runnable` ids and `complete`. Counts BOTH files
                                  # always — a finished scope is exactly the one `archive`
                                  # has emptied out of doc/backlog.md, and counting the live
                                  # file alone made it print what a mistyped label prints
                                  # --status and --all are both REFUSED: a summary IS the
                                  # count per status, and the archive is already in scope
                                  # An EMPTY scope is deliberately NOT complete, so a
                                  # mistyped label cannot read as a finished phase
                                  # `scope` echoes the query: `labels` is one array per
                                  # --label occurrence (names in a set are alternatives, the
                                  # sets are ANDed) beside `labelQuery` rendering it
node tools/task.mjs start T-0007 [--json]
                                  # the command form of the drag from Ready into In Progress:
                                  # takes the task to in_progress and starts the worker
                                  # session in its own worktree. It is a CLIENT of the board's
                                  # POST /api/task/:id/start — the ready gate, the dependency
                                  # gate and the worktree are the server's, never a second
                                  # copy of those rules here
                                  # a board must be RUNNING (a session does not outlive one),
                                  # and without BRIEFBOARD_WORKER_CMD it refuses BEFORE
                                  # posting, so the task stays ready. No --force: overriding
                                  # the dependency gate stays with `status … --force`
                                  # every refusal class has its own exit code, and --json's
                                  # `reason` is that same table — see the guide
node tools/task.mjs review-start T-0007 [--json]
                                  # the command form of the card's "start the review session"
                                  # button: the same client, pointed at
                                  # POST /api/task/:id/review. The task must ALREADY be in
                                  # `review`, and this CHANGES NO STATUS and merges nothing —
                                  # the session reads the diff, runs the tests and appends a
                                  # "### Review verdict" section, which is all it has ever done
                                  # refuses before posting without BRIEFBOARD_REVIEW_CMD (the
                                  # older BRIEFBOARD_ORCHESTRATOR_CMD configures it too), and
                                  # shares `start`'s exit-code table rather than adding one
node tools/task.mjs rework T-0007 [--json]
                                  # the command form of the card's "Send back for rework"
                                  # button: `review` → `in_progress` AND the worker session,
                                  # on the branch the previous round is already on. The
                                  # transition was always legal and needed no --force; what
                                  # this adds is the dispatch, which `status … in_progress`
                                  # does not make
                                  # refuses when task/T-0007 is gone — a rework would start
                                  # from HEAD and lose that round — with its own exit code;
                                  # a missing WORKTREE is recreated instead
                                  # --json carries the `round` being started, derived from
                                  # the verdicts already written and stored nowhere
node tools/task.mjs resume T-0007 [--json]
                                  # the command form of the card's "Resume the work" button:
                                  # the worker session again, on the branch the task is
                                  # already on, for a card in `in_progress` whose session is
                                  # gone. It writes NO status — the card is already where it
                                  # belongs, so nothing moves and nothing is put back
                                  # refuses while a session is genuinely RUNNING on the task,
                                  # read from the board's registry and never guessed from the
                                  # status; and when task/T-0007 is gone, like `rework`
                                  # shares `start`'s exit-code table rather than adding one
node tools/task.mjs archive [--dry-run]
                                  # move every done/cancelled task to doc/backlog-archive.md
node tools/task.mjs board        # is a board running for this project, and on which port —
                                  # pid, bound address, version and start time, read from
                                  # .briefboard/boards/<pid>.json and only ever believed when
                                  # the process is alive
node tools/task.mjs sessions     # the agent sessions the board has running (or has run)
node tools/task.mjs validate     # structural check of doc/backlog.md and of the archive
                                  # (duplicate IDs — including one present in both files —
                                  # invalid status/type, broken brief links, etc.)
node tools/task.mjs             # no arguments: prints every subcommand it has, which is
                                  # the list that cannot go stale

node tools/screenshot.mjs [--lang en|ru|ja] [--width N] [--height N] [--out FILE]
                          [--browser PATH] [--eval JS | --click SELECTOR]
                                  # start a throwaway board on a free port, photograph it with
                                  # an installed Chrome or Edge, stop it, print the path of the
                                  # png. Needs a browser — the only thing in briefboard that
                                  # does (see Requirements)
                                  # --eval runs a snippet in the page once the board has drawn
                                  # and --click is the same for one click, so what exists only
                                  # after an interaction — a task dialog, the label popover, the
                                  # new-task form — can be photographed too. A snippet that
                                  # throws or leaves the page unchanged fails the run and keeps
                                  # no png, so the picture you get back is never of an
                                  # undisturbed board
```

## Requirements

- Node.js >= 21 (verified empirically, see task T-0041: `node --test` only starts
  expanding the `tests/**/*.test.js` glob from `npm test` starting with Node
  21.0.0 — on Node 18.x and across the entire 20.x line, up to the latest 20.20.2
  release, the same pattern matches no files).
- Zero runtime dependencies — no `npm install`, no third-party libraries.
- **`node tools/screenshot.mjs` alone needs an installed Chrome or Edge.** Nothing
  else in briefboard does, and the browser is not an npm dependency: the script
  calls the one already on the machine, and on a machine without one it says
  where it looked and exits non-zero instead of failing obscurely. The board
  itself, the CLI and the sessions run without it.

## Security & networking

By default the server binds to `127.0.0.1` (loopback), so the board is reachable
only from the local machine. A public bind is opt-in via the `HOST` /
`AGENTBOARD_HOST` environment variables. Agent sessions (above) are a second
opt-in: they let a local HTTP endpoint start the command you configured, so they
are refused entirely on a non-loopback bind. On a loopback bind the server also
answers only to its own address: a request whose `Host` names anything else is
refused, so a page in your browser cannot reach the board by re-pointing its own
domain at `127.0.0.1`. Behind a reverse proxy that forwards the browser's `Host`,
name it in `BRIEFBOARD_ALLOWED_HOSTS`. See [SECURITY.md](SECURITY.md) for the
network model and how to report vulnerabilities.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the task workflow, how to run the
tests, the pre-commit hook, and the zero-dependencies style.

## License

MIT — see [LICENSE](LICENSE).
