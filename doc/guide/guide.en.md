English | [Русский](guide.ru.md) | [日本語](guide.ja.md)

# briefboard — User Guide

This is the detailed, step-by-step guide: from installing briefboard to running
it every day. The [README](../../README.md) is the short "what/why + quick
start" overview; this document goes further and walks through the whole
workflow. Technical terms, file names, commands, and environment variables are
kept verbatim (in Latin script) throughout, because that is exactly what you
type.

## Table of contents

1. [Introduction — what is briefboard](#1-introduction--what-is-briefboard)
2. [Requirements](#2-requirements)
3. [Installation](#3-installation)
4. [First run](#4-first-run)
5. [Roles & AGENTS.md](#5-roles--agentsmd)
6. [Task lifecycle end-to-end](#6-task-lifecycle-end-to-end)
7. [CLI reference](#7-cli-reference)
8. [Writing a good brief](#8-writing-a-good-brief)
9. [Reading the board (UI)](#9-reading-the-board-ui)
10. [Agent sessions (opt-in)](#10-agent-sessions-opt-in)
11. [pre-commit hook](#11-pre-commit-hook)
12. [FAQ & Troubleshooting](#12-faq--troubleshooting)

## 1. Introduction — what is briefboard

briefboard (formerly named `agentboard`) is a lightweight kanban
board plus a command-line tool that makes AI coding agents run their work
through a strict, explicit workflow: `backlog → open → ready → in_progress →
review → done`. Two things are mandatory in that workflow — a written brief
before implementation starts, and a review before a task is merged.

The point is to give agentic work the structure a plain chat conversation
lacks. Instead of decisions living only in a scrollback buffer, every task is a
section in a plain-markdown file (`doc/backlog.md`), every unit of work has a
brief that defines its scope and acceptance criteria (`doc/brief/`), and a human
can watch all of it move across a live board in real time. For the short version
and the project rationale, see the [README](../../README.md).

## 2. Requirements

- **Node.js >= 21.** This is enforced by `engines.node` in `package.json`. The
  reason is empirical (see task T-0041): `node --test` only starts expanding the
  `tests/**/*.test.js` glob from `npm test` beginning with Node 21.0.0. On Node
  18.x and across the whole 20.x line — up to the latest 20.20.2 release — the
  same pattern matches no files, so the test suite silently runs nothing.
- **Zero runtime dependencies.** There is no `npm install` step and no
  third-party libraries at runtime. The server, the CLI, and the UI use only
  Node's standard library and vanilla JavaScript.
- **One exception, and it is opt-in: `node tools/screenshot.mjs` needs an
  installed Chrome or Edge** (§7). It is the only part of the product that
  requires anything beyond Node, and the browser is still not a dependency — the
  script calls the one already on the machine and refuses clearly when there is
  none. The board, the CLI and the sessions do not need it.

### What it has been run on

Nothing in briefboard is tied to one agent or one operating system: it spawns the
command you configured, and all its state is plain markdown on disk (the atomic
write — a `.tmp` file, then a rename — behaves the same on POSIX and on NTFS).
That is the design. What has actually been exercised is narrower, and the two are
worth telling apart before you adopt it:

- **The agent: Claude Code.** Every ready-to-copy command in this guide was run
  on Claude Code 2.1.232. The board's whole interface to an agent is the four
  requirements in §10, so any CLI that meets them should work — but no second one
  has been tried here, and that is a design property rather than a tested promise.
- **The platform: Windows 11**, where every measurement in this guide was taken.
  Linux is checked by the tests: the whole suite runs green in a Debian container
  (`node:22-bookworm`), and two tests skip themselves there, each saying why —
  what they check exists only on Windows. The cleanup of processes left behind by
  a board that died was run in that container too, and that run found a real hole
  Windows did not have. What Linux has not had is the measuring: every number in
  this guide is a Windows number. **macOS has never been run** — its `ps` prints a
  process's start time in its own way and its pid range differs — so it is not
  supported until someone does; the section "What it means for security" (§10)
  says which half of the code that leaves untested.

Neither limit is enforced anywhere: nothing checks which agent or which operating
system you are on, and nothing refuses to start. They are statements about what
has been verified, not about what is blocked.

## 3. Installation

There are two ways to get started. Pick (a) if you want to add briefboard to an
existing project; pick (b) if you want to work inside the briefboard repository
itself.

### (a) `npx briefboard init`

The package is published to npm as `briefboard`, so this is the standard way to
add it to a project:

```bash
npx briefboard init
```

The `init` command copies the board's runtime files — `server/`, `tools/`,
`ui/`, `agents/`, `AGENTS.md`, `CLAUDE.md` — from the package into the current
directory, and scaffolds an empty `doc/backlog.md` plus an empty `doc/brief/`
directory for that project.

**Nothing at the destination is ever overwritten, and that decision is made file
by file.** A project of your own very likely has a `tools/` or an `agents/`
directory already — those are ordinary names in any repository — and briefboard
fills such a directory in instead of stepping around it: every file it ships that
you do not have is copied, and every file you do have is left exactly as it is.
So a rerun is idempotent, and so is the first run into a project that was there
before briefboard.

Here is a real run in a project that had its own `tools/build.mjs`, its own
`agents/WORKER.md`, and its own `CLAUDE.md` and `AGENTS.md`:

```text
briefboard init - installing into /home/me/my-project
created: server
created: tools
created: ui
merged: agents (2 added, 1 kept)
  kept yours: agents/WORKER.md
merged: AGENTS.md (briefboard block added, your text untouched)
merged: CLAUDE.md (briefboard block added, your text untouched)
created: doc/brief
created: doc/backlog.md
created: .briefboard/installed.json

These files were already here, so briefboard did NOT install its own versions of
them - this project runs on yours:
  agents/WORKER.md
Nothing was overwritten. To take briefboard's version of one, move yours aside and
run "briefboard init" again; "briefboard update" shows how the two differ.
```

Line by line: `created: <entry>` means everything briefboard ships under that name
was installed — note `created: tools`, even though `tools/` already existed, because
the only file in it was yours and nothing collided. `merged: <entry> (N added, M
kept)` means part of the entry collided, and every collision is named on its own
`kept yours:` line. `skip existing: <entry>` (on stderr) means nothing was
installed there at all.

The closing block is the part to read, because every other line reads as success:
it names each file briefboard did **not** install, and those are the files your
project now runs on. If `tools/task.mjs` is one of them, briefboard's task CLI is
not installed — the `node tools/task.mjs ...` lines are then left out of the next
steps on purpose, since that path holds your script rather than briefboard's, and
the run says so in as many words.

#### Your `CLAUDE.md` and `AGENTS.md` are added to, never replaced

Those two are the instructions your agent reads, and a project that has them has
them because somebody wrote them. briefboard treats them differently from every
other file: with no such file it writes its own whole, as it always did; with one
already there it appends a block delimited by two HTML comments — so they do not
render — and touches nothing outside them:

```markdown
# My project

My own rules.

<!-- briefboard:start -->
## briefboard task protocol

Project rules are in `AGENTS.md`. Read it in full before you start working.
...
<!-- briefboard:end -->
```

Four things are true of that block, and they are what make it safe:

- **briefboard writes only between the markers.** Not with `--apply`, not with
  `--force`, not ever. Everything above `<!-- briefboard:start -->` and below
  `<!-- briefboard:end -->` stays byte for byte what you wrote.
- **`init` inserts it once and never rewrites it.** Refreshing is `update`'s job;
  an `init` that quietly rewrote the block would be the whole-file overwrite again
  in a smaller box. A second `init` changes the file not at all.
- **`update` refreshes the inside of it, and only the inside.** When a newer
  package ships different instructions the entry is `outdated`, and `--apply`
  rewrites the text between the markers.
- **A marker inside a code block is not a marker.** The example above is itself a
  fenced code block, and briefboard reads it as one — so a document that merely
  *shows* what the block looks like, whether this guide or your own notes with
  that snippet copied into them, is never mistaken for one that already has a
  block.

Edit something **inside** the block and it becomes `MODIFIED LOCALLY`: `--apply`
keeps your version, and `--force` replaces it after a backup, exactly as anywhere
else. Delete the block and `update` reports it as `block removed` and does not
reinstate it — `--force` re-appends it. Damage the markers — a start with no end,
or two starts — and briefboard reports the file as `markers malformed` and refuses
to touch it under every flag, `--force` included: where the block ends cannot be
guessed without risking your own text.

### (b) `git clone` and work inside the repository

```bash
git clone <url-of-this-repository>
cd briefboard
```

That is all — there is nothing to install. The code is identical to what `init`
would copy, and you run everything from inside the cloned repository. This is
the recommended path for contributors and local development.

### (c) Updating an installed project — `briefboard update`

Because `init` copies the runtime files into your project, and `briefboard serve`
deliberately prefers that copy, installing a newer `briefboard` from npm does not
change anything in a project that is already set up. The copy is what runs — as
long as it is briefboard's copy. `serve` runs the project's `server/server.js`
when the manifest lists it or it is byte-identical to the package. When a
readable manifest exists and does not list that file, the packaged one starts
instead, naming the file it declined and why. When there is no readable manifest
at all, the project's copy runs anyway — with no record briefboard can neither
vouch for it nor condemn it — and `serve` says out loud that its provenance is
unrecorded. That last case is the one to know about, because `init` keeps a
`server/server.js` that was already there, so that path can hold your own script,
and loading it is briefboard running somebody else's code as the board. The
command that moves the copy forward is `briefboard update`:

```bash
npm install -g briefboard@latest   # or use npx briefboard@latest below
briefboard update                  # print the plan — nothing is written
briefboard update --apply          # replace the files
briefboard update --apply --force  # replace locally modified files too
```

**The plan comes first, always.** A plain `briefboard update` is read-only: it
compares every runtime file in the package with the one in your project and
prints a category for each, then stops. Replacing files a person may have edited
is irreversible, so it never happens as a side effect of a command typed on a
hunch. The categories are:

| category | meaning | `--apply` |
| --- | --- | --- |
| `up to date` | identical to the package — for a `CLAUDE.md` / `AGENTS.md` that carries the block, the block matches the package's | left alone |
| `outdated` | differs from the package but matches the hash recorded at install, i.e. untouched since | replaced — for a block, its inner text is rewritten |
| `MODIFIED LOCALLY` | differs from both the package and the recorded hash — you edited it | **skipped** unless `--force` |
| `new in package` | the new version ships a file your project does not have | added |
| `no manifest` | the project has no install manifest at all (see below) — it was installed before 0.2.0, so there is nothing to compare against | replaced, after a backup |
| `unknown provenance` | there **is** a manifest and it does not list this file: briefboard is saying it did not install it, so the file is somebody else's | **skipped** unless `--force` |
| `block removed` | briefboard added its block to this `CLAUDE.md` / `AGENTS.md` and the block is no longer there | **not re-added** unless `--force` |
| `markers malformed` | the block's markers in this file are damaged — a start with no end, or two starts | **never touched**, `--force` included |

The last two rows only ever apply to `CLAUDE.md` and `AGENTS.md`, the two files
briefboard merges into rather than copies over.

The difference between `no manifest` and `unknown provenance` is worth reading
twice, because it decides whether a file is replaced. `no manifest` says only that
the install is old — nothing was recorded, about any file, so nothing can be
compared, and `--apply` goes ahead with a backup. `unknown provenance` says the
record exists and this file is not in it, which is briefboard stating that it did
not put the file there; replacing it would be replacing somebody else's work, so
it is left alone unless you insist with `--force`.

**`doc/` is never written to.** Not with `--apply`, not with `--force`. Your
backlog and your briefs are your data; the updater only ever touches `server/`,
`tools/`, `ui/`, `agents/`, `AGENTS.md` and `CLAUDE.md`.

**Files are kept for two different reasons, and the categories say which.**
`agents/*.md` — and an `AGENTS.md` or `CLAUDE.md` that briefboard installed
itself — are process documents, and tuning them to your own process is a normal
thing to do; once you have, they are `MODIFIED LOCALLY` and `--apply` leaves them
as they are. A document that was **yours from the start** is a different case
altogether: briefboard never installed it, the manifest does not list it, and it
is `unknown provenance` — also kept, but because it was never briefboard's to
replace rather than because you changed it. For `CLAUDE.md` and `AGENTS.md` the
usual case is neither of those, because briefboard owns only its own block there
and refreshes just that. If you do want the package's version of a kept file, add
`--force`; the backup is still made in that case.

**Everything replaced is backed up first**, into
`.briefboard/backup/<timestamp>/`, with the original relative paths
(`.briefboard/backup/2026-08-14T09-30-00-000Z/agents/WORKER.md`). The command
prints that directory as its last line, so a rollback is a copy back, not a
reconstruction.

**Keep the project under git anyway.** A backup directory is a safety net for the
update itself; git is the safety net for everything. With the project committed,
reviewing what an update changed is `git diff`, and undoing it is
`git checkout -- server tools ui agents AGENTS.md CLAUDE.md` — no backup
directory needed.

**How it knows: `.briefboard/installed.json`.** `init` and `update` record what
they installed — the package version plus a content hash per file. That manifest
is the only way to tell "this file is old" from "you changed this file", which is
exactly the difference between a safe update and a destructive one. The directory
is already in `.gitignore` (it also holds session logs and the backups).

Projects installed before 0.2.0 do not have one. That is not an error and not
something to fix by hand: `update` names the cause above the file list and marks
every differing file `no manifest` — a statement about the missing record, not
about the file, and no promise that the file is untouched either. Such files are
still updated by `--apply` — with a backup, which is what the backup is for. From
then on the project has a manifest and the categories become exact.

A manifest that **is** there and cannot be read is a different situation, and is
reported as one: `update`, `briefboard --version` and `briefboard serve` print a
warning naming the file and the reason it would not parse. Provenance ends up
unknown either way, but the cause is not a version that never wrote a manifest —
something damaged yours, which is worth a look.

The consequence is stricter than for a missing manifest, and deliberately so: with
the record unreadable every file lands in `unknown provenance`, so `--apply`
replaces **nothing** and the manifest is not rewritten either. A damaged record is
no evidence about any particular file, and the safe reading of "I cannot vouch for
this" is to touch none of them.

Nothing repairs or deletes that file for you, and no run writes over it either —
not even one that does install something. A file that is new in the package stays
replaceable, so `--apply` installs it, records nothing, and says as much. The copy
you set out to repair is the copy you will find. Two ways out, in this order:

1. **Repair the JSON.** The exact categories come back and the project carries on
   with the history it had.
2. **Delete `.briefboard/installed.json` and run `briefboard update --apply`.**
   Without a manifest the project is a `no manifest` install — every differing file
   is replaced, backed up first, and a fresh manifest is written. You lose the
   record of what you had edited, which is the price of the shortcut.

`briefboard update --apply --force` also replaces those files without deleting
anything, but it is the blunt instrument: `--force` overrides every category at
once, including the `AGENTS.md` and `CLAUDE.md` that are yours. Reach for it only
when you know none of them matter.

**Which version am I on?** `briefboard --version` prints the installed package's
version and the version of this project's copy, and adds a line pointing at
`briefboard update` when they differ. `briefboard serve` prints the same
comparison at start-up when the project's copy lags the package, so a stale copy
is visible at the moment you start the board.

## 4. First run

Start the board server:

```bash
briefboard serve          # for a project installed with `briefboard init`
node server/server.js     # the same board, started directly
```

By default the board is served at `http://127.0.0.1:4571`. Open that URL in a
browser and you will see the kanban board.

- **`briefboard serve`** — start the board for the current directory (no
  `AGENTBOARD_ROOT` to remember). It runs that project's own `server/server.js`
  when that file is briefboard's — the manifest lists it, or it is byte-identical
  to the package. A readable manifest that does not list it is briefboard saying
  it did not put the file there: the installed package's copy starts instead, and
  the declined file is named with the reason. With no readable manifest at all
  there is nothing to decline it on, so the project's copy runs and `serve`
  reports that its provenance is unrecorded. Either way it prints which of the
  two it started. `--port N` pins the port.
- **A taken default port is not fatal.** If `4571` is busy the board takes the
  next free port (up to `4590`) and prints the URL it actually bound — several
  projects' boards can run side by side without juggling ports by hand.
- **Auto-selection skips unusable ports.** During that search a port that is
  taken and one the system keeps for itself (Windows reserves ranges for
  Hyper-V, WSL and services) are treated the same way — skipped for the next
  candidate. A port you asked for explicitly is never skipped.
- **`PORT`** — change the port. Example: `PORT=8080 node server/server.js`
  serves the board at `http://127.0.0.1:8080`. The default is `4571`. A port
  requested this way (or with `briefboard serve --port 8080`) is never
  substituted: if it is busy the server says so and exits.
- **`PORT=auto`** — any free port, chosen by the operating system, printed in the
  start-up banner like every other port. For boards nobody has to find by hand:
  scripts, CI, test suites. Twenty ports (`4571-4590`) are plenty for the boards
  a person opens and not enough for machines — several test files starting a
  board each will exhaust the range, and `auto` keeps them out of it altogether.
  `PORT=0` does not mean this and is refused: an explicitly set port is honoured
  or refused, and nothing can be served on `0`.
- **`BRIEFBOARD_NAME`** — the project name shown in the board's header and in the
  browser tab title, so two projects' boards are told apart at a glance. The
  default is the project folder's name.
- **Loopback by default.** The server binds to `127.0.0.1` (loopback), so the
  board — and its writing endpoints, `POST /api/task` (create) and
  `POST /api/task/:id/` `cancel` / `open` / `backlog` / `start` / `answer` /
  `profile` / `labels` / `done`, plus the three that write no backlog at all,
  `briefing`, `review` and `remove-worktree` — is reachable
  only from the local machine. This is deliberate: there is no authentication.
- **Public bind is opt-in.** To expose the board on the network, set the host
  explicitly via `HOST` or `AGENTBOARD_HOST` (for example
  `HOST=0.0.0.0 node server/server.js`). When the bind host is not loopback the
  server prints a `WARNING` that the board and the writing endpoint are exposed
  with no authentication. See [SECURITY.md](../../SECURITY.md) for the full
  network model. On Windows a wildcard bind does not own `localhost`: another
  board can take `127.0.0.1:<port>` from under it at any time. So a public bind
  also listens on `127.0.0.1` and `::1` itself, and `http://localhost:<port>`
  answers this board. If another process already holds one of those addresses,
  auto-selection moves to the next port, while a port you pinned yourself is
  still bound and warned about. The warning names the address that belongs to
  the other process: if that is every loopback address, `http://localhost:<port>`
  opens the other board rather than this one; if the board took the remaining
  address, `http://localhost:<port>` reaches whichever of the two a client
  resolves it to, so some clients may still land on the other process.
- **The board answers only to its own address.** On a loopback bind the server
  compares the request's `Host` header with the address it actually bound, and
  refuses anything else with `403` — reads included. Without that check a page
  open in your browser could reach the board by re-pointing its own domain at
  `127.0.0.1` (DNS rebinding): the browser would then send `Host: evil.example`
  and `Origin: http://evil.example`, which agree, and the cross-origin check
  above would see nothing wrong. Under a **public** bind the check is off: the
  board is reachable by name from the network already, the names this machine
  answers to are not knowable, and the start-up `WARNING` says so.
- **`BRIEFBOARD_ALLOWED_HOSTS`** — extra names the board answers to, separated by
  commas. You need this only behind a reverse proxy that forwards the browser's
  `Host` rather than rewriting it to the upstream — nginx rewrites it by default,
  `proxy_set_header Host $host` does not. Example:
  `BRIEFBOARD_ALLOWED_HOSTS=board.example.com`. A declared name is accepted on
  any port; anything undeclared still gets the `403`, which names this variable.
- **`AGENTBOARD_ROOT`** — point the server (and the CLI) at another project's
  `doc/` so you can run one installation for many projects. Example:
  `AGENTBOARD_ROOT=/path/to/project node server/server.js`.
- **`MAX_SSE_CLIENTS`** — cap on concurrent live-update (SSE) connections. The
  default is `50`.
- **`BRIEFBOARD_WATCHDOG_MS`** — how often the watchdog may ask git what the
  branches look like, in milliseconds. `10000` is both the default and the floor:
  a value below it is raised to the floor — `0` included — and the board says so
  on stderr. `off` is the only way to stop the check asking git at all. What it
  does with the answer is "The watchdog: what was claimed against what happened"
  below.
- **`BRIEFBOARD_LOCK_TIMEOUT_MS`** — how long a writer waits for the
  `doc/backlog.md` write lock before giving up, in milliseconds. The default is
  `5000`; an unusable value falls back to it. A writing endpoint that runs out
  of budget answers `503` with `Retry-After` ("busy, retry"), not `500`. Raise
  it only if you run an unusual number of agents writing at once. It applies to
  `tools/task.mjs` as well, so set it for both if you change it.

## 5. Roles & AGENTS.md

briefboard defines two roles, and the whole process depends on keeping them
separate. The canonical rules live in `AGENTS.md` (read it first, whatever
agentic tool you use), with the format contract in `agents/PROTOCOL.md` and the
per-role instructions in `agents/ORCHESTRATOR.md` and `agents/WORKER.md`.

- **Orchestrator** — the default role. It owns the backlog: it records and
  grooms tasks, writes briefs, assigns work, runs reviews, and merges. It is the
  only role that sets the statuses `backlog`, `open`, `ready`, `review`, `done`,
  and `cancelled`. It does not implement tasks itself — it delegates
  implementation to a worker.
- **Worker** — picks up a task that is in `ready`, implements exactly what the
  brief describes (no more), and moves the task through the only two transitions
  it is allowed: `ready → in_progress` (taking the task) and `in_progress →
  review` (submitting it).

**Why the brief is mandatory:** a task cannot move to `ready` without at least
one brief — the CLI refuses the transition. The brief is the contract between
orchestrator and worker: it fixes the scope and the acceptance criteria before
any code is written, so the worker knows exactly when it is done and the
orchestrator knows exactly what to review against.

## 6. Task lifecycle end-to-end

Here is a full task, from creation to merge, with the real commands at each
step. The status diagram (the same one that appears in `agents/PROTOCOL.md`):

```
backlog ──▶ open ──▶ ready ──▶ in_progress ──▶ review ──▶ done
   │          │        │            │             │
   └──────────┴────────┴────────────┴─────────────┴──▶ cancelled
                                        review ──▶ in_progress (if review fails)
                                        open ──▶ backlog (put back down)
```

`open → backlog` is the one step that can be taken back. It is there for the card
you pulled into Open by mistake, and for the one whose answer turns out to be "not
now": before it, the only way out of `open` was `cancelled`, which is terminal, so
shelving a task meant burying it. Putting a card back closes nothing and
erases nothing — the brief, the description, the questions and the answers stay — so
bringing it up again later costs no second briefing. There is deliberately
no way back out of `ready`: past a written brief the task has cost something,
and undoing that is a different decision.

Step by step:

1. **Create the task** (orchestrator). It lands in `backlog`:

   ```bash
   node tools/task.mjs add --type feature --priority Major \
     --title "Add CSV export" --desc "Export the board to CSV as well as xlsx"
   ```

   This prints the new ID, e.g. `T-0007`.

   The same task can be created from the board itself: the "+ New task" button,
   first in the header, opens a form (title, type, priority, labels, description) and
   posts it to `POST /api/task`. The server assigns the ID and writes the task
   through the same shared helper the CLI uses, so the result is identical —
   and, exactly like the CLI, the task always lands in `backlog`.

2. **Groom and open it** (orchestrator). Once the task is discussed and a
   decision is made, move it to `open`:

   ```bash
   node tools/task.mjs status T-0007 open
   ```

3. **Write the brief** (orchestrator). Scaffold a brief file and link it to the
   task:

   ```bash
   node tools/task.mjs brief T-0007 csv-export
   ```

   This creates `doc/brief/T-0007-01-csv-export.md` and adds `T-0007-01` to the
   task's `briefs` field. Fill in the brief (see
   [Writing a good brief](#8-writing-a-good-brief)).

4. **Mark it ready** (orchestrator). With a brief in place, the task can move to
   `ready`:

   ```bash
   node tools/task.mjs status T-0007 ready
   ```

   (If you try this before writing a brief, the CLI refuses: a task with no
   briefs cannot become `ready`.)

5. **Take the task** (worker): `ready → in_progress`, then work on a separate
   branch:

   ```bash
   node tools/task.mjs status T-0007 in_progress
   ```

   This step also exists on the board: drag the card from Ready into In Progress
   and it performs the same transition through `POST /api/task/:id/start`, after
   asking for confirmation. If a worker session is configured, the same drop
   starts it in its own git worktree — see
   [Agent sessions](#10-agent-sessions-opt-in). Either way the dependency gate
   applies: a task with unfinished prerequisites is not started (the board has no
   `--force`; the CLI does, and warns).

6. **Submit for review** (worker): once the acceptance criteria are met and the
   tests are green, `in_progress → review`:

   ```bash
   node tools/task.mjs status T-0007 review
   node tools/task.mjs note T-0007 --section "Worker report" --text -
   ```

   The second command appends the report — branch, what was done, how to verify —
   to the task's description, taking the text from stdin (see
   [`note`](#note--append-a-section-to-a-tasks-description)).

   The route so far, as the board shows it: "+" → Backlog, drop into Open (the
   briefing session), you read the brief, drop into In Progress (the worker
   session). Both drops are deliberate human acts — nothing walks a card from
   `backlog` to `done` on its own.

7. **Review and close** (orchestrator). The orchestrator reviews the work and
   runs the tests. If something is wrong, it sends the task back
   (`review → in_progress`) with comments. If it passes and is merged, the
   orchestrator sets `done`:

   ```bash
   node tools/task.mjs status T-0007 done
   ```

   A task can be `cancelled` from any open state (`backlog`, `open`, `ready`,
   `in_progress`, `review`) if it turns out to be unnecessary. Setting `done` or
   `cancelled` stamps the `closed` date.

   **The merge stays with you.** The board never merges a branch: deciding that
   the work is good is the one step where a human is irreplaceable, so it is not
   automated at all. The step after it is on the card — once the branch is in
   your checkout's history, **Accept** performs this `review → done` transition
   for you, and refuses with the reason while it is not; see
   [After review](#after-review-merging-and-cleaning-up).

## 7. CLI reference

All task changes go through `node tools/task.mjs`. It guarantees the file
format, sequential IDs, and atomic writes. The subcommands documented below are
`add`, `status`, `priority`, `depends`, `labels`, `brief`, `link`, `note`, `show`, `list`,
`runnable`, `summary`, `archive`,
`board`, `sessions` and `validate`; `profile` is one too, and lives with the feature it
belongs to — [The run profile](#the-run-profile-which-mode-an-agent-runs-in).
For the list as the tool itself knows it, run `node tools/task.mjs` with no
arguments: it prints every subcommand it has.

**When a call is refused.** Every refusal exits `1` and writes to stderr, and
which of two kinds it is decides what you get with it. A refusal about **how the
command was called** — an unknown flag, a missing or extra positional argument, a
`--type`, `--priority`, `--status` or label value outside its list, a `--desc -`
or `--text -` with nothing on standard input — prints the subcommand's usage line
underneath, and sometimes a hint aimed at the exact mistake, so the message that
stops you also carries the call that works. A refusal about the **state of the
repository** — no such task, a transition the lifecycle does not allow, a
prerequisite still unfinished, no run profiles declared — prints the reason
alone: the call was well formed, and a usage line would answer nothing. Either
way nothing is written; the backlog is only ever touched by a call that got all
the way through.

### `add` — create a new task

```bash
node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

Creates a new task in `doc/backlog.md` (in status `backlog`) and prints its ID.
Flags:

- `--type` — `feature`, `bug` or `external`. `external` is work a third party
  owes you — see "Waiting for something outside the project" below.
- `--priority` — one of `Blocker`, `Critical`, `Major`, `Medium`, `Minor`.
- `--title` — the task title. **Required.**
- `--labels` — the labels the task is filed with (optional), as ONE
  comma-separated argument: `--labels "ui, docs"`. The names follow the same
  rules as the [`labels`](#labels--your-own-classification-of-a-task) command
  and are refused the same way, before anything is written. Leaving the flag out
  means no labels, which is not an error anywhere; the flag with nothing after
  it is refused rather than taken for that. It exists so a project whose every
  task must carry a label can file one in a single command — a second call is
  the one that gets dropped.
- `--desc` — the free-form description (optional). `--desc -` reads it from
  standard input, which is how anything multi-line is passed without a shell
  mangling it; an empty standard input under that explicit `-` is refused, and
  no task is created. It has to be: a task was once filed with a dash where its
  description belonged, and the finding it existed to carry was gone — the
  failure is silent, and what it loses is the whole reason the card exists.
  `note --text -` refuses the same way.

**A flag left out and a flag given wrong are not the same thing.** Leaving
`--type` or `--priority` out is the ordinary call and no error anywhere: the task
is filed as a `feature` of `Medium` priority. A value **outside** the list is
refused — the error names the legal values, nothing is written and no id is
allocated. That changed in 0.3.0: such a value used to be replaced by the
default, so `add --title X --type nonsense` exited `0` and filed a `feature`
nobody asked for, with `show` as the only sign of it. If a script of yours relied
on a wrong value being quietly corrected, it now fails where it used to succeed.

### `status` — change a task's status

```bash
node tools/task.mjs status T-0007 ready
```

Sets the status, validating both the value and the transition. The target must
be one of `backlog`, `open`, `ready`, `in_progress`, `review`, `done`,
`cancelled`. The transition must follow the lifecycle graph:
`backlog → open → ready → in_progress → review → done`, any non-terminal status
→ `cancelled`, plus `review → in_progress` to send work back and `open → backlog`
to put a card back down. An illegal
transition (for example `ready → done`) is refused with an error that lists the
moves allowed from the current status; `done` and `cancelled` are terminal.
Setting the status to its current value is an idempotent no-op.

Add `--force` to bypass the graph for manual correction — it allows any move
between valid statuses and prints a `WARNING` to stderr. `--force` does **not**
bypass format invariants: moving to `ready` is still refused if the task has no
briefs. Moving to `done` or `cancelled` (forced or not) stamps the `closed`
timestamp.

One more gate applies to `ready → in_progress`: a task whose `depends` list still
holds unfinished tasks cannot be started. The error names every blocking task
with its current status, so you can see what to wait for. `--force` performs the
transition anyway and prints a `WARNING` naming the same tasks.

### `priority` — re-triage a task after it was filed

```bash
node tools/task.mjs priority T-0007 Critical
```

Sets the priority to one of `Blocker`, `Critical`, `Major`, `Medium`, `Minor` —
the same five [`add --priority`](#add--create-a-new-task) takes, refused the same
way when the value is not one of them. Unlike `status` there is no graph and no
`--force`: any priority may follow any other, and there is nothing to bypass.

It exists because a priority is chosen when the least is known about a task —
often by whoever ran into it while doing something else — and understanding a
task is what changes the answer. Until this command existed it was the one field
that could be set only at creation, so correcting one meant editing
`doc/backlog.md` by hand, on the line the parser is strictest about.

**A change leaves a trace.** It appends one line to the task's description under
a `### Priority changes` heading, naming the old value, the new one and when it
moved:

```
### Priority changes
Minor -> Major (2026-08-22 21:57:03)
```

A later change adds to the same section rather than replacing it, exactly as
`note` adds to a report. The reason is that a card which silently became
`Critical` reads, a week later, as though it always was — and why it moved is
usually the more interesting half. There is deliberately no `--reason` flag: a
required reason gets answered with one word, an optional one gets skipped, and
the refinement notes next to the line are where the reasoning already lives.

Setting the priority to the value it already has is not an error and writes
nothing at all — no field, no trace line: nothing changed, and `Major -> Major`
would be noise in the one place that has to stay readable.

### `depends` — set what a task waits for

```bash
node tools/task.mjs depends T-0007 T-0005,T-0006
node tools/task.mjs depends T-0007 --clear
```

Sets the whole prerequisite list at once (it replaces the previous list rather
than adding to it) and prints the result; `--clear` empties it. The field is
written to `doc/backlog.md` only while the list is non-empty, so tasks without
prerequisites keep the file as short as it was.

A prerequisite counts as satisfied once it is `done` **or** `cancelled` — a
cancelled task will never arrive, and the board marks such a dependency
distinctly so the task standing on a cancelled premise stays visible. The command
refuses an id that no task carries, a task depending on itself, and any edit that
would close a dependency cycle; nothing is written in those cases.

The board shows the same information: a card whose prerequisites are unfinished
carries a "blocked" marker, and the task dialog lists them, each with its current
status and clickable straight through to that task.

### `labels` — your own classification of a task

```bash
node tools/task.mjs labels T-0007 ui,docs
node tools/task.mjs labels T-0007 --clear
```

Sets the whole label list at once — like `depends`, it replaces the previous list
rather than adding to it, and says what it dropped when a call loses anything;
`--clear` empties it. The field is written to `doc/backlog.md` only while the
list is non-empty.

Labels are yours, not briefboard's. `type` and priority are closed lists the
format owns; a label set is **implicit** — there is no registry file and nothing
to declare. A label exists while some task carries it, creating one is typing a
name that nobody has used yet, and the last task dropping a label is what makes
it disappear. The price of that, knowingly: a typo makes a new label silently,
and renaming one means touching every task that carries it.

A name is trimmed, at most 32 characters, and may hold anything except a comma
(the list separator) and a line break; one task carries at most 8. Names are
compared **as written** — `ui` and `UI` are two different labels — and what keeps
them from diverging is the card's editor offering the labels already in use.

On the board: the labels appear as chips on the card under its title, the card's
dialog adds and removes them, a `Labels ▾` button in the header filters by any of
them at once, and the search box matches them alongside the title and the
description. Typing `docs` there is how you find the labelled tasks without
opening the popover — which is why the board has no sorting control for labels.
They are in the Excel export too, as a column of their own.

A task can be filed already carrying them, in one command rather than two:
`add --labels` takes the same list (see [`add`](#add--create-a-new-task)), and
the board's "+" form has a field beside the title and the priority. That matters
for a project whose convention is that every task carries a label — a rule kept
by a second command is a rule that drifts.

### Waiting for something outside the project

Sooner or later a task is finished as far as you are concerned and still cannot
be done: it needs access, keys, an answer from the client, or someone else's
release. Model that wait as a task of its own:

```bash
node tools/task.mjs add --type external --priority Major --title "Client sends the API keys"
node tools/task.mjs depends T-0042 T-0041   # the real work waits for the external task
```

The waiting task stays honestly in `ready` — its brief is written, it will be
picked up the minute the blocker clears — `ready → in_progress` is refused while
the blocker is open, and its card carries a marker that names what it is waiting
for. The wait now has an owner, a card and a moment when it ends, and closing the
`external` task unblocks everything that depended on it.

**The anti-pattern: do not move a task to `in_progress` to signal that it is
waiting.** The board shows status, so a task parked there reads as active work
where there is none, while the actual reason lives in prose nobody sees. For the
same reason there is no `blocked` status (a task can be blocked in `ready`, in
`in_progress` and in `review` — a status would drag it out of the phase it is
really in) and no free-text "blocked: reason" field (the dependency graph cannot
see it, nothing closes it, and it goes stale silently).

### `brief` — scaffold and link a brief

```bash
node tools/task.mjs brief T-0007 csv-export
```

Creates `doc/brief/T-0007-NN-slug.md` (where `NN` is one past the highest brief
number that task already links) with the standard section skeleton, and adds the
brief ID to the task's `briefs` field.

It never writes over a file that already answers to the ID it computed: such a
file was written by someone, the template would replace it, and the command
refuses and writes nothing at all. `link` below is how that file gets onto the
task instead.

### `link` — put an existing brief file on its task

```bash
node tools/task.mjs link T-0007-01
```

Adds `T-0007-01` to task T-0007's `briefs` field, for a brief file that already
exists — written by hand, recovered, or brought in from elsewhere. It refuses an
ID no file in `doc/brief/` answers to, so it cannot create a reference into
nothing; a second run adds no duplicate and says it changed nothing.

This is the way out of the one state `brief` cannot resolve: the file is on
disk, the task does not know it, and the only remaining move used to be editing
`doc/backlog.md` by hand — which is what this CLI exists to make unnecessary,
and what an agent working in an isolated worktree cannot do at all.

The brief number comes from the file, not from the task, so linking
`T-0007-03` to a task that links nothing else leaves 01 and 02 unused. That gap
is harmless: the number is a label, and `brief` goes on from the highest one the
task links, never handing out a number it already holds.

### `note` — append a section to a task's description

```bash
node tools/task.mjs note T-0007 --section "Worker report" --text "Branch: task/T-0007-csv"
node tools/task.mjs note T-0007 --section "Worker report" --text - <<'EOF'
Branch: task/T-0007-csv
What: the export, plus tests
Verify: npm test
EOF
```

Adds `### <section>` and the text to the end of the task's description. If that
section is already there, the text joins it instead of starting a second one, so
a report written in two goes reads as one section. Three headings are the
exception and never join: `Session questions`, `Answers` and `Review verdict` are
correspondence rather than one document, so each call opens its own section at
the end and their order says who spoke last. `--text -` takes the text from
stdin, which is how a multi-line report gets in without an escaping fight.

The command only ever adds. Nothing already in the description — a refinement
decision, a review comment, an earlier report — is rewritten or removed, which
is what makes it safe to point an agent at a description several agents write
to. Text that looks like backlog structure (a `## ` line, a `- field: value`
line) stays text: the file escapes it on write, exactly as for any description.

This is also the supported way for a worker isolated in a git worktree to write
its report into the backlog of the shared checkout. A session the board started
needs nothing extra — the runner already put the shared checkout in its
`AGENTBOARD_ROOT`, so the command above is exactly what it runs, and a prefix
added to it is what a permission rule then fails to match. Only a worker an
orchestrator dispatched by hand, with no such variable in its environment, passes
the path itself:

```bash
AGENTBOARD_ROOT=/path/to/shared/checkout node tools/task.mjs note T-0007 \
  --section "Worker report" --text -
```

### `show` — print a whole task

```bash
node tools/task.mjs show T-0007
node tools/task.mjs show T-0007 --full
```

Prints the task — all fields plus the description — as JSON. Both files are
searched: a task that has been archived (see `archive` below) is found and
printed like any other, and the JSON then carries an `archived` field naming the
file it came from — that task is closed, and nothing can be written to it.

Worker reports are left out of the description by default. On a long-lived task
they are most of what is stored there, and whoever opens the card usually wants
the statement of work, the questions and the review verdict, all of which stay.
The omission is never silent: the JSON then carries an `omitted` field naming how
many report sections were dropped, under which headings, how many bytes, and the
command that prints them. `--full` is that command — it returns the description
exactly as it is stored, which is what a review at acceptance time wants.

### `list` — list tasks

```bash
node tools/task.mjs list
node tools/task.mjs list --status ready
node tools/task.mjs list --label phase-4
node tools/task.mjs list --label phase-4 --status ready
node tools/task.mjs list --all
node tools/task.mjs list --label phase-4 --json
```

Lists tasks, optionally filtered by status via `--status`.

Archived tasks (see below) are left out by default: everything in the archive is
closed, and this command is read by an agent planning work. `--all` includes
them. When a project has an archive, `list` says so on stderr with the number of
tasks in it — an omission the reader is not told about is worse than a long list.

#### `--label` — which tasks belong to a scope

`--label` is the one flag in this CLI that may be **repeated**, and the two ways
of writing several labels mean different things:

| call | selects |
|------|---------|
| `--label phase-4` | tasks carrying `phase-4` |
| `--label phase-4,macro` | tasks carrying **either** |
| `--label phase-4 --label macro` | tasks carrying **both** |
| `--label a,b --label c` | tasks matching `(a OR b) AND c` |

One occurrence is a comma-separated **set**, read exactly as
[`labels`](#labels--your-own-classification-of-a-task) reads its argument:
trimmed, empty names dropped, compared **as written** (`ui` and `UI` are two
labels). Repeated occurrences all have to match. A task carrying no labels is
never selected by any `--label`.

**The CLI is AND across repeated flags; the board's `Labels ▾` filter is OR.**
Both are deliberate, and they are here in one place so that nobody meets the
difference as a surprising short list. Clicking chips in a multi-select reads as
"any of these" — that is the board, and picking `phase-4` and `macro` there shows
every task carrying either. Typing a constraint twice on a command line reads as
"and also" — that is the CLI, and `--label phase-4 --label macro` shows only the
tasks carrying both. The interaction models genuinely differ, and each form's own
"either" is one comma away: `--label phase-4,macro` is the board's answer, and on
the board you get the CLI's by picking one label at a time.

`--status` takes a single value and combines with `--label` as AND, as does
`--all`.

A label nothing carries is **not** an error: the result is empty and the exit
code is `0`. What exits non-zero is a call that is malformed — `--label ""`,
`--label ,` or `--label` with nothing after it, all of which name no label at
all. A script can therefore tell "no such task" from "I typed it wrong" by the
exit code alone. No form of `list` ever writes to `doc/backlog.md`.

**One occurrence holds at most 8 names**, the same number a task's own label list
may carry — a set is read by exactly the rules the field is. A ninth name is
**refused**, with the usage line and a non-zero exit, rather than quietly
dropped: a truncated set answers with *fewer* tasks and exit `0`, which is the
one shape of wrong answer a script cannot detect. The cap is per occurrence, so
`--label a,…,h --label i,…,p` is a legal query (and, being AND, a narrow one).
Repeated names and a trailing comma are not extra alternatives — `--label ui,ui`
is one alternative and always was. A name longer than 32 characters is dropped
silently and on purpose: no task can carry such a name, so it could never have
matched, and dropping it changes no result — alone in a set it leaves no name at
all and is refused as one of the malformed calls above.

#### `--json` — the same answer, for a program

```bash
node tools/task.mjs list --label phase-4 --json
```

Prints **one** JSON document on stdout and nothing else — no header, no count
line, no warning. Anything `list` has to say (the archived-tasks note above)
goes to stderr, so stdout can be piped into a parser whole:

```json
{
  "tasks": [
    {
      "id": "T-0021",
      "title": "Label filter for the CLI",
      "type": "feature",
      "status": "ready",
      "priority": "Major",
      "labels": ["phase-4"],
      "depends": ["T-0020"],
      "briefs": ["T-0021-01"],
      "created": "2026-08-22 22:34:57",
      "closed": "",
      "blockedBy": []
    }
  ],
  "count": 1
}
```

The field names are the ones the product already uses:
[`show`](#show--print-a-whole-task) prints a task under exactly these names, and
`blockedBy` — the prerequisites that are not closed yet — is what `GET /api/board`
has called them since dependencies existed. `--json` composes with `--label`,
`--status` and `--all`, and the order is the backlog's own, unchanged.

The description is deliberately **not** in it. This is a listing, and
descriptions are most of a backlog's bulk — the same reason `archive` exists.
Read one task with `show`.

**What `--json` promises.** A field that exists keeps its name, its type and its
meaning. New fields may appear in any release. A consumer must ignore what it
does not recognise — that is what makes the addition of a field a non-event
rather than a breaking change.

### `runnable` — what can be started right now

```bash
node tools/task.mjs runnable
node tools/task.mjs runnable --label phase-4
node tools/task.mjs runnable --label phase-4 --json
```

`list` narrowed to the tasks that can actually be picked up: status `ready`
**and** every prerequisite in `depends` closed. Both halves are the product's
own — `ready` is the lifecycle's name for "briefed and waiting", and the
dependency half is the same rule the board's blocked marker, the drag from Ready
into In Progress and the `status … in_progress` gate all apply. There is no
second definition of "startable" to disagree with them, and an archived
prerequisite counts as satisfied like any other closed one.

`--label` and `--json` mean what they mean for
[`list`](#list--list-tasks), and `--json` prints `list --json`'s own
`{tasks, count}` document, task for task and field for field — the same task
described twice under two shapes is a thing to keep in step, and this avoids it.

`--all` is **refused**, with the usage line and a non-zero exit. The archive
holds closed tasks and nothing else, and `runnable` answers with `ready` ones —
so the flag could never have changed this answer, whatever it was given. A flag
that cannot change an answer, on a command written for a machine to act on, is a
flag claiming that it can. `list --all` is untouched: there the archive really
is a set of tasks the listing would otherwise leave out.

`--status` can only **narrow** a set the lifecycle has already defined, never
widen it: `runnable --status ready` is the same answer, and
`runnable --status review` is an empty one with exit `0`. That is a question with
no members, not a wrong question, and the exit code says which it was.

### `summary` — how much of a scope is left

```bash
node tools/task.mjs summary
node tools/task.mjs summary --label phase-4
node tools/task.mjs summary --label phase-4 --json
```

```json
{
  "scope": { "labels": [["phase-4"]], "labelQuery": "phase-4" },
  "total": 8,
  "backlog": 0,
  "open": 0,
  "ready": 1,
  "in_progress": 1,
  "review": 1,
  "done": 5,
  "cancelled": 0,
  "blocked": 0,
  "runnable": ["T-0021"],
  "complete": false
}
```

- **one key per status**, and every status briefboard has — so the counts sum to
  `total`, and a status added to the lifecycle later cannot quietly go missing.
- **`blocked`** counts the tasks that are **waiting**: not closed, and with at
  least one unsatisfied prerequisite — the dependency half by the same call
  `runnable` makes. It is a **cross-cutting** fact, not an eighth status: a task
  is counted here *and* under its own status. That is not double counting — the
  status counts alone are what sum to `total`. A closed task keeps its
  `depends`, and a prerequisite that was never closed stays unsatisfied for
  good; counting that as blocked would report finished work as waiting.
- **`runnable`** is the ids [`runnable`](#runnable--what-can-be-started-right-now)
  would print, in the backlog's own order.
- **`scope`** echoes the query, so a stored answer says what it was an answer
  to — and says it precisely enough that two different queries cannot store the
  same document. `labels` is one array per `--label` occurrence: the names
  inside a set are alternatives, and the sets are ANDed, exactly as the flag
  reads them. So `--label a --label b` echoes `[["a"],["b"]]` and
  `--label a,b` echoes `[["a","b"]]`. `labelQuery` is the same query written
  out — `a AND b`, `a OR b`, `(a OR b) AND c`, or `every task` when no
  `--label` was given — because nested arrays are not what a human reads in a
  report. It is the line the plain-text output prints after `scope:`.
- **`complete`** is `total > 0` **and** every task in scope `done` or
  `cancelled`. Both statuses close a task in briefboard, and a scope whose last
  card was cancelled is finished.

**An empty scope is deliberately not complete.** Set theory says a scope with no
unfinished tasks is finished; a supervisor acting on that reads `--label phase4`
as "phase 4 is done" because somebody dropped a hyphen. This document is built
for a machine to act on, so it takes the reading that fails safe — `total: 0`
sits right beside `complete: false` to say why.

**`complete` is a statement about briefboard's own tasks and nothing else.** It
is not acceptance of a phase, a release or a milestone, and briefboard knows
nothing about any external project's vocabulary — it counts the cards in
`doc/backlog.md` that carry the labels you named. Whoever integrates this decides
what a finished scope entitles them to conclude; the CLI does not.

**`summary` counts both files, always.** `doc/backlog.md` and the archive
together, whatever flags it is given. Counting is not planning work, and a scope
that is **finished** is precisely the one [`archive`](#archive--move-the-closed-tasks-out-of-the-backlog)
has emptied out of the live file. Read live-only, such a scope printed
`total: 0, complete: false` — byte for byte the document a label nobody ever
used prints, so the two cases the `total > 0` rule exists to keep apart became
one, and the wrong reading was "not finished" about work that was finished. With
the archive in scope, `total: 0` means one thing only: nothing carries that
label, ever.

`--status` and `--all` are both **refused**, with the usage line and a non-zero
exit. `--status`: a summary IS the count per status, so narrowing by one would
leave every other number in the document wrong, and a flag that quietly does
that is worse than no flag. `--all`: the archive is already counted, so the flag
has nothing left to add — see the same refusal on
[`runnable`](#runnable--what-can-be-started-right-now) for why a flag that
cannot change an answer is worse than no flag on a command a machine reads.
`list --all` keeps its meaning and its behaviour.

Neither command ever writes: not the backlog, not the archive, not a session
record. Both make the same promise `list --json` does — a field that exists keeps
its name, its type and its meaning; new fields may appear in any release; a
consumer ignores what it does not recognise.

### `archive` — move the closed tasks out of the backlog

```bash
node tools/task.mjs archive --dry-run
node tools/task.mjs archive
```

Moves every `done` and `cancelled` task from `doc/backlog.md` to
`doc/backlog-archive.md` — the same format, the same directory, still tracked by
git. `--dry-run` reports what would move and writes nothing.

The reason is the cost of the file, and it comes back after every sweep. Closed
tasks are most of a long-lived backlog: in briefboard's own repository 64 of the
78 tasks in `doc/backlog.md` are closed — 307 KB of a 335 KB file — while 147
more sit in the archive from the previous run. Every agent that reads the backlog
reads all of it and pays for all of it: roughly 89k tokens for those 335 KB,
about 7k for the 28 KB that would be left.

What does **not** change:

- **The board.** It reads both files and shows the archived tasks exactly as
  before, in the same Done and Cancelled strips. Archiving is invisible to the
  human — it takes context off an agent, not cards off a board. One exception,
  which `archive` warns about every time it moves something: a board that was
  *already running* keeps running the code it was started with, so a board older
  than the archive feature goes on reading `doc/backlog.md` alone and its Done
  and Cancelled strips really do look emptied. Restarting it brings them back.
  The warning tells you whether that applies to you: a running board leaves
  `.briefboard/boards/<pid>.json` (see below), so it is named with its pid, its
  port and the version it was started from. If no such board is alive, the
  warning says so — with the one case it cannot cover, a board started by a
  briefboard older than 0.2.0, which left no trace of itself.
- **Identifiers.** The next ID is one past the highest in either file, so an
  archived ID is never reissued.
- **`show`**, which finds an archived task and tells you where it found it, and
  **`validate`**, which checks both files.
- **`depends`.** A prerequisite that has been archived is closed, so it counts as
  satisfied; it can still be named in a `depends` list.

Nothing is ever written to the archive afterwards, and there is no command to
move a task back. That is the point of moving only `done` and `cancelled`: both
are terminal, so an archived task has no transition ahead of it. The writing
commands — `status`, `note`, `depends`, `profile`, `brief` — therefore refuse an
archived task, and say that it is archived rather than that it does not exist:
`note` on a closed task used to be accepted, and after archiving it is not.
Closing a task
never archives it by itself either — a card that disappears from under your hands
is a bad surprise, so the move is a decision you make, once in a while, by hand.

### `board` — is a board running for this project, and where

```bash
node tools/task.mjs board
```

```
a board is running for this project: pid 24680 on 127.0.0.1:4571, briefboard 0.2.0, started 2026-08-16 16:00:12
  (.briefboard/boards/24680.json).
  (this project is /home/me/project;
  a board files its trace under the project it serves, so another project's
  boards are in that project's .briefboard/boards and are never listed here.)
```

The question a lost tab leaves you with, and one you cannot answer by guessing:
the port may come from the scan of 4571–4590, from `PORT`, or from the kernel
itself with `PORT=auto`. The answer is read from `.briefboard/boards/<pid>.json`
— the file a board writes while it runs — through the very same code that prints
the warning after `archive`, so the two can never come to disagree.

That file is never proof on its own. A board killed hard (`kill -9`, `taskkill
/f`, a machine that went down) does not get to remove it, so the process is
checked alive before anything is reported, and the leftovers of a dead board are
not presented as a running one.

"This project" means the trace directory of `AGENTBOARD_ROOT`: a board files its
trace under the project it serves, so the boards of your other projects sit in
their own `.briefboard/boards` and are never listed here. The command says which
project it answered about, so a wrong `AGENTBOARD_ROOT` shows up as itself.

One board leaves no trace at all — one started by a briefboard older than 0.2.0 —
and there is a second witness for it: a session it started that is still running
in `.briefboard/sessions/registry.json`. Such a board is named by pid, with its
address given as unknown, because it never recorded one.

Finding nothing is an answer, not a failure: the command says that no board is
running, names both places it looked, and exits `0`.

### `sessions` — who the board has working right now

```bash
node tools/task.mjs sessions
```

```
T-0007  running      worker    2026-08-14 12:31:07  /project/.briefboard/sessions/T-0007-....log
T-0009  interrupted  briefing  2026-08-13 21:04:55  /project/.briefboard/sessions/T-0009-....log
```

Prints the agent sessions of the project `AGENTBOARD_ROOT` points at: the task, the
state, the kind of session, when it started, and the log to read. It reads
`.briefboard/sessions/registry.json` directly and needs no board of its own — which is
the point, since the board is usually a separate process (see §10).

`running` means an agent is working on that task at this moment. `interrupted` means the
board that started it went down and nothing restarted it — the record is history, not a
live process, and the state that matters is the task's own. A project where no session
has ever run prints `no agent sessions` and exits `0`; that is an answer, not a failure.

### `validate` — structural check

```bash
node tools/task.mjs validate
```

Runs a structural check of `doc/backlog.md` — and of `doc/backlog-archive.md`
when the project has one. It catches duplicate IDs, invalid `status`/`type`
values, broken headers, links to briefs that do not exist, and broken
dependencies — a `depends` entry pointing at a task that does not exist, a task
depending on itself, and dependency cycles of any length (the message names every
task on the ring).

Two more look at the brief files themselves rather than at the links to them: a
brief file in `doc/brief/` that no task links — the message either names the task
that should link it and prints the `link` command that does so, or says there is
no such task at all — and two files answering to **one** brief id (say
`T-0007-01-first.md` beside `T-0007-01-second.md`), where only the first is ever
read by the board and by `task.mjs` alike, so the file you are editing may not be
the one anybody sees. Both are errors; the second names every file, because
choosing which to keep is the reader's next act.

Two checks are about the archive in particular: an ID present in **both** files
(two different tasks would then answer to one name — this is what an interrupted
`archive` run, or an older briefboard's `add`, leaves behind), and a task in the
archive whose status is not `done` or `cancelled`. Errors found in the archive are
prefixed with its file name, and dependencies are resolved across both files, so
a prerequisite that has been archived is not reported as missing.
It prints `OK` and exits `0` when the file is valid, or prints the errors and
exits `1` otherwise.

### `tools/screenshot.mjs` — a picture of the board

```bash
node tools/screenshot.mjs [--lang en|ru|ja] [--width N] [--height N]
                          [--out FILE] [--browser PATH]
                          [--eval JS | --click SELECTOR]
```

Not a task command: it changes nothing and prints one path. It starts a board of
its own on a free port, photographs the page with an installed Chrome or Edge in
headless mode, stops the board again, and writes the png to
`.briefboard/screenshot-<lang>.png` — the same directory the session logs live
in, which is already gitignored. Nothing else in your repository is touched.

It exists for the agent sessions (§10). A brief whose acceptance criterion is
about how something looks — a header that must not wrap, a column that must not
collapse — cannot be checked by an agent that is not allowed to start a server,
and neither the worker nor the reviewer is. Both of their permission lists carry
`Bash(node tools/screenshot.mjs:*)` for that reason and nothing wider: the
session may take the picture, and reads it back like any other file.

The options are what a visual criterion actually turns on:

- `--lang` — the interface language of the capture. The UI keeps it in
  `localStorage`, which a headless capture has no way to set, so the script
  serves the page through a proxy of its own that sets it. Layout breaks in `ru`
  and `ja` long before it breaks in `en`.
- `--width` / `--height` — the viewport, `1400x900` by default. Narrow it to see
  what a small window does to the header and the columns.
- `--out` — where to write the png. Without it the picture goes to
  `.briefboard/screenshot-<lang>.png`, which is overwritten by the next capture
  in the same language; give a path of your own to keep several pictures side by
  side. Whatever you pass, the script prints the path it wrote.
- `--browser` — the executable, when it is not in the usual place. Without it the
  script looks in the standard install locations and on `PATH`, and if there is
  no browser it says where it looked and exits non-zero.
- `--eval` — a snippet of JS run in the page once the board has drawn, so that
  the capture is taken *after* an interaction: `--eval "openTask('T-0007')"`
  photographs that task's dialog. `--click` is the same thing for the common
  case of one click — `--click "#label-filter-btn"` opens the label popover —
  and the two are two ways of saying the same thing, so give one or the other.
  Whatever exists only after an interaction (a dialog, the label popover, the
  new-task form) is reachable this way.

A snippet that throws, matches no element, or leaves the page unchanged **fails
the run and keeps no png** — so a picture you get back is a picture of what you
asked for, never of an undisturbed board that quietly ignored your snippet.

This is the one command in briefboard that needs something installed (§2).

## 8. Writing a good brief

The brief is the contract for a task. A brief file lives at
`doc/brief/T-NNNN-MM-slug.md`, its first line is a `# T-NNNN-MM · Title` header,
and it has four sections. The `brief` subcommand generates this skeleton (the
section headers match the format contract in `agents/PROTOCOL.md`):

```
# T-0007-01 · Brief title

## Context
Why we are doing this; links to the discussion.

## Solution
What exactly we do — architecture, interfaces.

## Scope
What is in / what is out.

## Acceptance criteria
- [ ] item 1
- [ ] item 2
```

Practical advice:

- **Context** — state the problem, not the solution. Link back to where the
  decision was made.
- **Solution** — be concrete: which files, which functions, which commands. The
  worker should not have to guess the design.
- **Scope** — spell out what is explicitly *out* of scope. This is what stops a
  task from sprawling.
- **Acceptance criteria** — make each item checkable. "Tests are green" and
  "`validate` passes" are good criteria; "works well" is not.

The full format contract for briefs and the backlog is in
[`agents/PROTOCOL.md`](../../agents/PROTOCOL.md) — it is the single source of
truth for the format.

## 9. Reading the board (UI)

Open `http://127.0.0.1:4571` in a browser — or whatever URL the server printed
at start-up, if `4571` was taken. The header and the tab title name the project,
so a board opened from another project is recognisable at a glance. The board
shows your tasks and gives you these controls:

- **Columns by status.** Backlog → Open → Ready → In progress → Review are
  columns across the board. Done and Cancelled are collapsible strips below the
  board, so closed work does not crowd the active columns.
- **Filter by type.** Show all tasks, only `feature`, only `bug`, or only
  `external`.
- **Blocked only.** The "Blocked" toggle in the header keeps just the tasks that
  are waiting on an unfinished prerequisite. It combines with the other filters
  by AND, so "blocked bugs of Critical priority" is one click away.
- **Full-text search.** Search over task title, description, ID and labels.
- **Multi-select priority filter.** Filter by any combination of `Blocker`,
  `Critical`, `Major`, `Medium`, `Minor`.
- **Theme toggle.** Switch between light and dark themes.
- **Language toggle.** Switch the interface language between EN, RU, and JA via
  the `<select>` control.
- **Create a task with "+ New task".** That button, first in the header next to
  the title, opens a dialog with title, type, priority, labels and description.
  Submitting it posts to `POST /api/task`; the server validates the fields,
  assigns the ID and writes the task in status `backlog`. The card shows up on
  the board over SSE, with no page reload.
- **Drag & drop to cancel.** Drag a card from the Backlog or Open column onto
  the Cancelled strip to cancel it straight from the UI. It asks for
  confirmation first, then performs the `backlog`/`open` → `cancelled`
  transition through the narrow `POST /api/task/:id/cancel` endpoint.
- **Drag & drop into Open.** Drag a card from the Backlog column into the Open
  column to open it. While you drag a backlog card the Open column is
  highlighted as an available target; cards in any other status are refused by
  that column. There is no confirmation here — moving to Open is
  non-destructive — and the `backlog` → `open` transition goes through the
  equally narrow `POST /api/task/:id/open` endpoint, which re-checks the current
  status on the server. If a briefing session is configured, this drop starts it
  for a task that has **no** brief yet; a task that already has one is simply
  moved, and starting a session for it is the separate button below.
- **Drag & drop back into Backlog.** Drag a card from the Open column back into
  the Backlog column to put it down again: the card you pulled in by mistake, or
  the one you have decided against for now. The move itself is not confirmed — it
  is reversible, and the brief it keeps means reopening it later costs nothing.
  What the board does ask about is a briefing session running on that card,
  because the move stops it and the tokens it has spent do not come back. Nothing
  is erased: the briefs, the description and every question and answer stay where
  they are, and the *needs answer* marker simply goes out while the card is in the
  backlog and lights again if you reopen it. The `open` → `backlog` transition
  goes through `POST /api/task/:id/backlog`.
- **Start the briefing session by hand.** A card in Open carries a **Briefing
  session** block: what the session does, and a **Start the briefing session**
  button when `BRIEFBOARD_SESSION_CMD` is set. Without it the block stays and
  names the variable instead of the button, so the action is never simply missing
  from a card that could have it. There is a third state, and it is the one you
  will meet most often: while a session is already running on that task the
  button is gone too, and the block says so in its place — a task carries one
  session at a time, so to start this one you stop the running one in the
  **Running session** block above. The unset variable wins over it when both are
  true: a command that was never set is the durable fact, and a session running
  right now says nothing about it. It is
  what the drop into Open no longer does for an already-briefed task: press it
  when the brief has gone stale, when a session died before writing one, or when a
  task that came back up out of the backlog needs its brief looked at again. It
  asks first, starts the session through `POST /api/task/:id/briefing`, and
  changes no status — nothing already written is replaced.
- **Drag & drop into In Progress.** Drag a card from the Ready column into the In
  Progress column to take the task into work. This drop asks for confirmation —
  unlike opening a task, it can start an agent that writes and commits code — and
  the confirmation says plainly when no worker command is configured, in which
  case the card just moves. A card with unfinished prerequisites is not accepted
  and the column does not light up for it; the server applies the same check
  again and answers `409` with the blockers named, because the board's own check
  is only a hint. The transition goes through
  `POST /api/task/:id/start`.
- **Answer a session from the card.** A task marked *needs answer* has an answer
  box in its dialog, with the restart box checked by default. Sending it appends
  the text to the end of the description under `### Answers` through
  `POST /api/task/:id/answer` and starts the session again — the briefing one for
  a task in `open`, the worker one for a task in `in_progress`, the review one
  for a task in `review`. That endpoint
  only ever appends and changes no status; "When the session has questions"
  below has the details.
- **The end of the work, on the card.** A card in Review says whether the task's
  branch is merged — the board asks git — hands you the merge line to copy, and
  carries two actions: **Accept** (`review → done`) and **Remove the worktree**.
  Each of them names its reason while it is refused. There is no merge button:
  that one is a judgement and stays with you — "After review: merging and
  cleaning up" below has the commands and the reasoning.
- **Dependencies at a glance.** A card whose prerequisites are not finished
  carries a marker that names the blocker itself ("waiting: client sends the API
  keys"); with several blockers it counts them and lists every "id — title" in
  its tooltip. The marker clears itself
  the moment the last prerequisite closes — no reload. The task dialog lists the
  dependencies with their current status, each one clickable straight through to
  that task; a `cancelled` prerequisite is struck through, since it unblocks the
  task but means its premise is gone.
- **The watchdog's mark.** A filled amber chip on a card means the board has
  compared what the task claims against what git and the session registry show,
  and the two do not agree — "work not recorded", "not merged", "no branch". Its
  tooltip and the card's dialog carry the whole observation. Cards it has nothing
  to say about carry nothing; see "The watchdog: what was claimed against what
  happened" below for what it checks and what it deliberately keeps quiet about.
- **Export to Excel.** The "Export Excel" button downloads the current board as
  a real `.xlsx` file.
- **Live update.** The board re-renders itself whenever `doc/backlog.md` changes
  on disk — it uses Server-Sent Events (SSE) plus `fs.watch`, so you do not need
  to reload the page.
- **Stop the board (`⏻`).** The last button in the header stops the board
  instead of you finding the terminal it runs in and pressing Ctrl+C — handy
  once several projects' boards are up. It asks for confirmation, then
  `POST /api/shutdown` ends the `node server/server.js` process: running agent
  sessions are stopped with it, exactly as on Ctrl+C, and everything already
  written to `doc/` stays. That stop is a kill with a bounded wait after it — see
  "What it means for security" below for what the bound is for and what you see
  when it is what ends the wait. Only that process dies — the terminal it was started
  in simply gets its prompt back, and nothing else running in that window is
  touched. Every open tab then shows "the board is stopped" and stops
  reconnecting, so a deliberate stop never looks like a failure; an ordinary
  connection drop still says "reconnecting…" and keeps trying. To bring the
  board back, start it again from the terminal. The request is accepted only
  from a loopback address, so nobody on the network can stop your board even
  under a public bind.

## 10. Agent sessions (opt-in)

Normally, dropping a card only changes its status. If you want, two of those
drops can also start an agent session for the task — and two more are started by
a button on a card that is already in Open or in Review. Each has its own
command:

| action              | command                   | what it starts                       |
| ------------------- | ------------------------- | ------------------------------------ |
| drop into **Open** (a task with no brief) | `BRIEFBOARD_SESSION_CMD` | the briefing session, in the project |
| button on a card in **Open** | `BRIEFBOARD_SESSION_CMD` | the same briefing session, started by hand |
| drop into **In Progress**| `BRIEFBOARD_WORKER_CMD` | the worker session, in its own worktree |
| button on a card in **Review** | `BRIEFBOARD_REVIEW_CMD` | the review session, in the project |

`BRIEFBOARD_REVIEW_CMD` used to be called `BRIEFBOARD_ORCHESTRATOR_CMD`. That
name is still read and nothing warns about it, so a board configured with it goes
on working exactly as before; if both are set, `BRIEFBOARD_REVIEW_CMD` is the one
used. The rename is worth a paragraph because these four words are easy to
confuse:

- **the board** — briefboard itself: the backlog, the briefs, the lifecycle. It
  starts sessions and writes no code;
- **the worker** — one task implemented in isolation, on its own branch in its
  own worktree;
- **the review session** — reads the diff, runs the checks, writes a verdict, and
  sets no status and merges nothing;
- **your own orchestrator** — the agent that sits above all of this in your
  project, if you run one. briefboard neither knows nor needs to know about it,
  and the old variable name claimed otherwise.

**What the briefing session does.** Exactly one step of the workflow: it refines
the task, writes a brief into `doc/brief/`, sets the task to `ready`, and stops —
or leaves its questions in the task instead (see below). It does
not implement anything. You read the brief and decide whether to hand the task to
a worker — the refinement conversation is where misunderstood requirements get
caught, so it is not automated end to end.

**It is started once, not once per drop.** The drop into Open starts it only for
a task that has no brief yet. A task that already has one is coming back up out of
the backlog, and writing a second brief over the first is not what dropping the
card asked for — so the drop just moves it. When that brief does need revisiting,
the **Start the briefing session** button on the card is how you say so.

**It is off by default.** Nothing is ever spawned until you set a command, and
there is no default command: briefboard makes no assumption about which agent you
run.

### What briefboard requires of an agent

"Makes no assumption" is not quite "requires nothing". The board spawns a
command, gives it a working directory, and reads the file it printed into —
that interface is narrow, and everything in it is a requirement. Four things,
and a CLI that does all four can be the agent behind a session:

1. **One prompt, then exit.** The command is started once per session, and the
   board treats the process ending as the session ending. A CLI that opens an
   interactive conversation and waits for your next message never finishes, so
   the card keeps a live session marker until you stop it by hand.
2. **No terminal.** stdin is closed and there is nowhere to answer a question, so
   a login, a first-run confirmation or a permission prompt has to be settled
   before the session starts. Whatever the CLI would have asked, it will not get
   an answer.
3. **Reading and writing files in the working directory.** The board passes a
   task id and a directory; the task, the briefs, the code and the report are all
   files, and there is no other channel. An agent restricted to a sandbox of its
   own cannot do the job.
4. **Running `node tools/task.mjs`.** That single command is how a session reports
   back — the status, the link to a brief, the worker report, the review verdict,
   a question. An agent that cannot execute a command can read your repository
   perfectly well and will never move a card.

Nothing beyond that is assumed. No output format is required — a session that
prints nothing at all is a valid session, and the board says so honestly rather
than treating silence as failure. The single feature that reads what the agent
printed is the token counter, and only because you hand it an expression
yourself ("What a task took" below).

Take that as the checklist for a CLI other than the one in the examples: if it
answers yes four times, the rest is writing a template.

#### What in the examples belongs to Claude Code, not to briefboard

Every ready-to-copy command in this guide is one agent's, and it is worth being
explicit about where the line runs, because reading a `--allowedTools` list as
"briefboard configuration" leads to looking for the equivalent setting in the
board and not finding one.

- **briefboard's own**: the `BRIEFBOARD_*` variables, the `{id}` and `{profile}`
  placeholders inside your template, and the four requirements above.
- **Claude Code's own**: `-p`, `--allowedTools`, `--disallowedTools`,
  `--output-format`, `--include-partial-messages`, `--verbose`,
  `--dangerously-skip-permissions`. What is written about them here was checked
  by running it on Claude Code 2.1.232. On another CLI they are named
  differently, live in a configuration file, or have no counterpart — briefboard
  splits your template into arguments and runs it, and has no opinion on any flag
  in it.

**One assumption in particular does not travel: the permission default.**
Everything this guide says about a missing permission describes a CLI that
refuses the tool call, writes a line about it and exits **0** — so the damage of
getting the list wrong is a session that did nothing, which is annoying and
harmless. That is Claude Code's default, not a law of agents. A CLI whose default
is the opposite runs whatever the prompt asks for, and then the same paragraphs
read as reassurance while the failure mode is inverted: not a session that wrote
nothing, but one that wrote what you never allowed — in your working repository,
with your git history in reach. So before pointing the board at an unfamiliar
agent, establish which of the two defaults it has. The answer decides whether its
permission list is a safety net or the only thing standing between that agent and
your files.

### Turning it on

Set `BRIEFBOARD_SESSION_CMD` when you start the server. `{id}` in the template is
replaced with the task id:

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

Any command works the same way — Codex, your own script, anything that takes the
task id and does the refinement. Whatever agent you use, keep the question
protocol in its prompt: the next section explains why it is there.

#### The permission list is not optional, and it is not decoration

A headless session has no terminal, so a permission prompt has nobody to answer.
The agent blocks the tool call, writes a polite explanation into the log, and
exits **0**. Nothing else happens: the board shows a session that ran and
finished, the task stays where it was, no brief appears. It is the quietest kind
of failure there is, and the only thing standing between you and it is the
`--allowedTools` list above.

- **The flags go after the prompt.** `--allowedTools` takes a list of names, so
  `claude -p --allowedTools Read Edit "…the prompt…"` reads the prompt as one more
  tool name and dies with `Input must be provided either through stdin or as a
  prompt argument`. Prompt first, flags after it.
- **The briefing list matches the briefing job.** Read the repository, create and
  fill one file under `doc/brief/`, run `node tools/task.mjs`. It cannot touch
  code, cannot run git, cannot run your tests — not because it would misbehave,
  but because nothing in its job needs any of that.
- **Path rules are spelled `Edit(...)`.** `Write(doc/brief/**)` matches nothing;
  `Edit(...)` covers every file-editing tool, `Write` included, and a bare `Edit`
  with no path grants no writes at all.
- **`--dangerously-skip-permissions` turns all of it off.** It is a real option
  and a defensible one inside a throwaway container. In your working repository it
  means an agent with your files and your git history in reach, so it is a
  decision you make yourself, not a default we hand you.

That list is the place where you decide what an agent may do in your repository —
worth reading once, in full, before the first copy-paste. The syntax belongs to
the agent CLI rather than to briefboard: what is written here was checked by
running it on Claude Code 2.1.232.

A second variable, `BRIEFBOARD_SESSION_MAX`, caps how many sessions may run at
once (default `4`), counting both kinds together. Past the cap the drop still
moves the task, but no new process starts.

At start-up the server prints one line per kind, telling you which mode you are
in:

```
sessions:   on (max 4, logs in /path/to/project/.briefboard/sessions)
worker:     off (not configured)
```

### On Windows, if your agent is an npm shim

briefboard runs the command **without a shell**. That is a security property of
the runner and it will not change — with a shell, the contents of the template
would start being interpreted again. On Windows it has a consequence worth
knowing before you copy the line above: a global npm install puts a `.cmd` shim on
your PATH, and since Node's CVE-2024-27980 hardening a `.cmd`/`.bat` file cannot
be started without a shell at all — `spawn('npm')` fails with `ENOENT`,
`spawn('npm.cmd')` with `EINVAL`.

So if your agent's CLI is such a shim, the session refuses to start and the drop
answers `error`. The server log and the session log then say more than the errno:
they name the two ways out, both of which are yours to make in the template.

- Point it at the real executable:
  `BRIEFBOARD_SESSION_CMD='C:\path\to\claude.exe -p "..."'`.
- Or wrap the call yourself:
  `BRIEFBOARD_SESSION_CMD='cmd /c claude -p "..."'`.

The second works because `cmd.exe` is a real executable, and `/c` and everything
after it arrive as ordinary arguments. The difference from `shell: true` is not
cosmetic: the shell is there because you asked for it in your own template, not
because the runner quietly added one. For the same reason briefboard does not try
to resolve `claude` into `claude.cmd` through `PATHEXT` — that would bring back
exactly the behaviour the CVE closed, and do it invisibly.

The same applies to `BRIEFBOARD_WORKER_CMD` and `BRIEFBOARD_REVIEW_CMD`.

### When the session has questions

A session runs headless: stdin is closed and there is no terminal, so it cannot
ask you anything while it works. Without a rule for that, the only thing left for
it to do with unclear requirements is guess and set `ready` anyway — and the
result is an official-looking brief nobody checked, which code then gets written
from. So a session has exactly two endings:

1. **The requirements are clear** — it writes the brief and sets the task to
   `ready`.
2. **It has at least one real question** — it does not set `ready`. It appends a
   section to the end of the task description:

```markdown
### Session questions

- Should an export include cancelled tasks, or only the active board?
- Which of the two date formats in the sample file is the canonical one?
```

and leaves the task in `open`.

The board reads that section back: a task whose description contains this exact
heading, standing on a line of its own, gets a **needs answer** marker on its
card. Three statuses count — one per kind of session that can stop to ask:
`open` for the briefing session, `in_progress` for the worker one (see
[The worker session](#the-worker-session-ready--in-progress)) and `review` for
the review session (see
[The review session](#the-review-session-a-card-already-in-review)). Nowhere
else: `done` and `cancelled` are set by a human who has read the description, and
a marker there would have nobody left to unblock.

What clears the marker is your answer, not a status. A description can carry
several of each heading, so it is their order that decides: the marker is lit
only while the **last** of the `### Session questions` and `### Answers` headings
in it is a questions one. An `### Answers` section written below the questions
puts the marker out, and every text already there stays where it is.

The heading is a token of the format, like `- status:` or `## T-NNNN`, so it
stays in English whatever language the questions themselves are written in. The
marker is static — it is a property of the task text, so it stays after the
session process is long gone, and it is a different thing from "a session is
running right now".

**Answering.** Open the card. A task carrying the marker has an answer box at the
bottom of its dialog: a text field, a restart checkbox (on by default) and a send
button. What you write is appended to the end of the description under a new
`### Answers` heading, and — with the box left checked — the session starts
again, this time reading the answers along with the task. That is the whole
circle: the session asks, you answer from the board, the session comes back and
finishes what it was doing.

The checkbox names which session it will restart, and that follows from the
status: from `open` it is the briefing one, from `in_progress` the worker one, in
its own worktree on its own branch, and from `review` the review one, in the
project directory. Answering never starts the wrong kind of agent in the wrong
directory.

Three properties of that box are worth knowing, because they are deliberate:

- **It only appends.** No answer, however it is written, can change or delete a
  single character of what is already in the description. The description is the
  shared carrier of refinement decisions, review comments and worker reports, and
  giving the browser the right to rewrite it wholesale would be a way to lose all
  of that to one bad request. Full description editing from the board is not
  offered at all — it would need its own answer to versioning first.
- **Every reply opens its own section.** Questions and answers are a
  correspondence, so each one is written as a new section at the end of the
  description, in the order it was sent: ask, answer, ask again, answer again —
  four sections one below the other, and the card's marker follows
  whichever came last. Nothing is merged into an earlier round, so a round that
  is closed stays distinguishable from one that is still open.
- **It changes no status.** Answering is not a transition. The task stays where
  it was — `open`, `in_progress` or `review` — and it is the restarted session
  that decides, with the answers in hand, whether to move it on.

Nothing stops you from answering by hand instead: edit the description in
`doc/backlog.md`, or run
`node tools/task.mjs note <id> --section Answers --text -`, and start the session
yourself. What does not work either way is dropping the card into Open a second
time: the task left `backlog` when it was first opened, and the drop only handles
`backlog → open`.

Ending with questions is a normal, successful ending as far as briefboard is
concerned: nothing is rolled back, nothing is retried automatically, and the task
simply waits in `open`.

### Where to look when something happens

Each session writes its stdout and stderr to

```
.briefboard/sessions/T-0007-<timestamp>.log
```

in the project root. Add `.briefboard/` to your `.gitignore` — these are local
artifacts, not part of the project. The logs are deliberately kept out of `doc/`:
the server watches `doc/` and pushes a board refresh on every change there, so a
log file inside it would repaint the board for every connected client on every
line the agent printed.

Next to the logs sits `.briefboard/sessions/registry.json` — which sessions ran,
for which task, when, and how they ended. It is written on every start and every
ending, and it is what the board reads at start-up so a restart does not erase
what it knew. It is runtime state, not a document: none of it goes into
`doc/backlog.md`, which stays a git-tracked record of tasks rather than of
processes. If the file is missing or unreadable the board starts with an empty
registry and says so in its output — a lost registry costs you the session
history, never a task.

And one file per running board: `.briefboard/boards/<pid>.json`, written the
moment the board starts listening and removed when it stops. It carries the pid,
the address and port it actually bound, the project, the briefboard version and
the time it started; the start-up output prints its path on the `trace:` line.
This is how a separate process — `node tools/task.mjs archive`, a script of your
own — can tell that a board is running here and where to reach it, which is
otherwise unguessable: the port may come from a scan, from `PORT`, or from the
kernel with `PORT=auto`. You can ask the same question yourself with
[`node tools/task.mjs board`](#board--is-a-board-running-for-this-project-and-where),
which reads this file rather than making you open it.

A board that is killed hard — `kill -9`, `taskkill /f`, a machine that went down
— never gets to remove its file. So the file alone is never taken as proof:
whoever reads it checks that the process is still alive, and the next board to
start clears out what the dead ones left. Deleting the directory yourself costs
nothing but the ability to see a board that is already running.

The response to the drop reports what happened, and the board's behaviour follows
from it:

| `session`         | meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `started`         | the process is running; its log is in `.briefboard/sessions/` |
| `briefed`         | the drop into Open found a task that already has a brief, so nothing was spawned |
| `disabled`        | no command configured (or the server is not on loopback)   |
| `already-running` | this task already has a live session                        |
| `limit`           | `BRIEFBOARD_SESSION_MAX` sessions are already running       |
| `unknown-profile` | the task's `profile` is not in `BRIEFBOARD_PROFILES`        |
| `error`           | the command could not be started — see the server's output  |

A worker session (which is isolated) can also answer `not-a-repo`, `no-git`,
`worktree-failed`, `setup-failed` or `setup-timeout` — see the next section.

In every case the task still moves: the transition and the session are
independent, and a session that fails to start just leaves the task waiting for a
human.

### Following a session on the board

You do not have to go to the log file to see whether an agent is still alive. A
card whose task has a session carries a marker of its own:

| marker              | what it means                                       |
| ------------------- | --------------------------------------------------- |
| **session live**    | the agent is running right now (the dot pulses)      |
| **session done**    | it finished by itself, exit code 0                   |
| **session failed**  | it exited with an error                              |
| **session stopped** | you stopped it from the board                        |
| **session cut short** | it went down with the board and was never restarted |

This is a third, independent marker: "blocked", "needs answer" and a session
marker can all sit on one card, and each keeps its own look.

**session cut short** is what you see after restarting the board. Sessions die
with it by design — an orphaned agent writing into the repository of a board that
no longer exists is worse than an interrupted one — so a session that was running
when the board went down is marked cut short, with its log still there and the
task still in whatever status it had reached.

The board does not restart such a session for you. The agent may have done half
the work, and a second run on top of that is a new problem, not a recovery: read
the log, decide, and start it again yourself if that is what you want.

It is marked cut short even if some process with that pid is still alive. The
board has no way to prove that process is the session — operating systems reuse
pids, and there is no portable way to read a process's start time — and no way to
read or stop it either, since its output pipe died with the previous board.
Passing a stranger's process off as your session would be a worse lie than the
silence this replaced.

Open the card and it offers **Session log**. That opens over the task dialog and
shows the tail of the log — the last 200 KB, with the full size next to it, so a
long-running session does not drag megabytes into the browser.

While the session is alive, the card itself carries a **Running session** block
with **Stop the session** in it, and the log window keeps a copy of that button.
Either one asks for confirmation first, because stopping interrupts the agent
where it stands (everything it has already written to disk stays). It is on the
card because that is where you are when you decide: for a while the only way to
reach it was through the log, and a control you have to go looking for is one
your tokens are being spent looking for. Any kind of session can be stopped this
way — worker, briefing or review — and when nothing is running the block is
simply not there.

While that block is on the card, the start block below it offers no button. A
task carries one session at a time, and the board asks the same question the
server would answer with `already-running`, so instead of a button that cannot
work the block says a session is already running and points back up here. That is
the state you meet whenever you open a card that is busy, which is more often
than the unconfigured one; and if the command is unset as well, it is the unset
command the block names, because that is the fact that outlives the session.

The log is shown as **text**, never as HTML. It is written by a process
briefboard only started, so nothing in it is treated as markup.

#### An empty log under a live session, and how to make it fill

For a while after the session starts the log is often empty — zero bytes, for
minutes. That is not a broken board and not a stuck agent: many agent CLIs buffer
their output and print all of it at once when they exit, and `claude -p` in its
default text mode is one of them.

So the log view does not show you a blank pane. Under a session that is still
running it says the session has written nothing yet and that some agents print
only when they finish. It is worth being precise about what the board knows here:
it knows the session's state and the size of the file, nothing else. It does not
know which agent is running, and it never guesses from the output. That is also
why an empty log under a **finished** session gets different words — there the
emptiness is the whole story, and the runner has already written its own hint
into the log file about the usual cause (a missing tool permission).

If you would rather watch the work as it happens, the change goes into your
command template, not into the board. briefboard writes whatever the process
prints to stdout, and an open log view follows the file over SSE — so anything
that makes the agent print earlier shows up on the board immediately. Claude Code
has a mode for exactly that:

```bash
BRIEFBOARD_SESSION_CMD='claude -p "…the prompt…"
--output-format stream-json --include-partial-messages --verbose
--allowedTools "Read,Glob,Grep,Edit(doc/brief/**),Bash(node tools/task.mjs:*)"' \
  node server/server.js
```

Take this as **one option, not the recommended default**, and for two honest
reasons:

- **The flags are that CLI's, not briefboard's.** A different agent names them
  differently or has nothing of the kind, and the board must not assume which
  agent you started — that is the same line it holds everywhere else. On Claude
  Code 2.1.232, `--verbose` is required: with `-p`, `--output-format stream-json`
  is refused without it.
- **In this mode the log stops being prose.** Every line is one JSON event —
  `{"type":"assistant",…}` and friends — and the log view shows those lines as
  they arrive, unparsed. briefboard does not read an agent's output format and
  does not render it: the format belongs to the agent and changes with it, and a
  renderer built on a guess would misread the output the day the format moves.
  You get liveness and give up readability, which is a fair trade on a session
  you are actively watching and a poor one on a log you will read afterwards.

Under the hood this state is deliberately kept out of `/api/board`. That response
is cached against `doc/backlog.md`'s mtime and size — and a session starting or
dying changes neither, so the board would be told `304` and would never find out
that the agent died. Instead:

- `GET /api/sessions` — the registry, uncached: `id`, `kind`, `status`,
  `startedAt`, `endedAt`, `exitCode`, `signal`, `pid`, plus `branch` and
  `worktree` for a session that ran isolated. `status` is `running`,
  `exited` or `interrupted`. No log path ever leaves the server: the file to read
  is looked up from the task id, and no part of it comes from the browser. The
  same answer carries `costs` — see [What a task took](#what-a-task-took) below —
  and the watchdog's findings, which are made of these same records and of git.
- `GET /api/session/T-0007/log` — the tail as `text/plain`, plus
  `X-Log-Total-Bytes` and `X-Log-Truncated`.
- `POST /api/session/T-0007/stop` — stops a live session; `409` if it has already
  ended, `404` if there is no session for that task.
- the SSE stream sends `sessions` when a session starts or ends — a separate
  event from the board's `changed`, so the board never re-reads the backlog just
  because an agent came or went, and the marker updates with no polling at all.

### What a task took

Sooner or later you want to know what a task actually cost — the briefing, the
questions, the worker run, all of it together. Open the card and it says so.

The block sits next to the closing block and is built from two very different
kinds of knowledge, which is why it looks the way it does.

**The first kind the board measures itself**, from the session registry it keeps
anyway:

- how many sessions the task took, and of which kind (briefing, worker);
- how long each one ran, and how long they ran together;
- how each one ended — finished, failed with its exit code, stopped by you, or
  cut short with the board.

None of this needs configuring and none of it assumes anything about your agent:
it is the same for `claude`, for a shell script, for whatever you point the
command template at. A session that is still going is measured up to this moment
and marked, so the total reads as a total *so far* rather than as a final figure.

The registry holds a bounded number of finished runs, so a task worked on long
ago may have lost some of them. Then the block **says** that it is incomplete and
how many runs are missing. A partial sum that admits it is partial is useful; the
same number presented as exact is a lie the board would be telling you every time
you looked.

**The second kind only your agent knows**: the tokens. They are printed in its
own output, in its own format, and briefboard does not read that format — it does
not know which agent you started, and code here that parsed one CLI's output
would have to be chased every time that CLI changed. So the rule is the same as
for run profiles: **you declare it, the board applies it.**

```bash
BRIEFBOARD_TOKENS_RE='"cache_read_input_tokens":\s*\d+,"output_tokens":\s*(\d+)' \
BRIEFBOARD_SESSION_CMD='claude -p "…the prompt…" --output-format json
--allowedTools "Read,Glob,Grep,Edit(doc/brief/**),Bash(node tools/task.mjs:*)"' \
  node server/server.js
```

**Read those two lines as a pair, because a declaration alone does nothing.** The
board looks for the number in the session's log, so the agent has to have printed
it there — and the ready-to-copy commands earlier in this guide do not. `claude
-p` in its default text mode writes prose and no usage figures at all, so an
expression declared beside *that* command matches nothing, and the card goes on
showing time only, with no error anywhere to explain why. This is the whole
failure: the counter is not broken, there is simply nothing in the log to count.

Getting a number into the log is a change to **your command**, and the flag that
does it belongs to the CLI, not to briefboard. On Claude Code 2.1.232 there are
two:

| flag | what the log becomes |
| --- | --- |
| `--output-format json` | one JSON object at the very end, `usage` block included |
| `--output-format stream-json --verbose` | one JSON event per line, live |

Another agent prints its usage in its own shape, under its own flag, or not at
all — in which case there is no number to read and the honest configuration is
none.

**The price of switching either one on is the readability of the log.** A session
log in text mode is what you read when something went wrong; in `json` mode it is
one machine-readable object, and in `stream-json` a stream of events (the same
trade described under "An empty log under a live session" above, where the
purpose is liveness rather than counting). briefboard renders neither — it shows
what the process printed. So this is a deliberate choice between a log you can
read and a number on the card, and it is worth making on purpose rather than by
copying a line.

**Then verify the expression against a real log, because by default every match
is summed.** Measured on Claude Code 2.1.232, one turn, one trivial prompt:

| expression | on `--output-format json` | on `stream-json` |
| --- | --- | --- |
| `"output_tokens":\s*(\d+)` | 2 matches, sums 36 twice → **72** | 4 matches → **90** |
| `"cache_read_input_tokens":\s*\d+,"output_tokens":\s*(\d+)` | 1 match → **36** | 1 match → **41** |

The obvious expression is the wrong one: `output_tokens` appears both in the
outer `usage` block and again inside `usage.iterations[]`, and in streaming mode
once per assistant event as well, so the board dutifully adds the same figure to
itself. The anchored expression pins it to the key that precedes the total in the
outer block. Neither of these is a promise about a future version of that CLI —
which is exactly the point: run one session, open its log, count the matches, and
only then trust the number on the card.

**Counting the matches leaves you a second question: what do they mean?** An
anchored expression is one answer — pin it to a line the agent prints once — but
it only works when such a line exists. The general answer is a second
declaration:

```bash
BRIEFBOARD_TOKENS_MODE=last
```

| mode | the card shows | right when the agent |
| --- | --- | --- |
| `sum` (default) | every match added up | prints what each turn cost |
| `last` | the number of the last match | prints a running total, or repeats the same total |

**Why the board cannot work this out for itself.** A log of `36` then `41` is 77
tokens if those are per-turn figures and 41 if they are a running total, and the
two logs are byte for byte the same kind of thing. Nothing in them says which,
and an agent-agnostic board has nothing else to go on — so, as with the
expression and with run profiles, you declare it and the board applies it.

`sum` stays the default because it is what the board has always done and
somebody's configuration already depends on it. A value that is neither counts
**nothing**, with a line in the server's output naming both modes: falling back
to `sum` would hand you the doubled figure at the very moment you were trying to
correct it, and you would have no way of telling.

- the expression is applied to the tail of each session's own log — the same last
  200 KB the log view shows;
- every match contributes the number in its **first capturing group**. In `sum`
  they are added up; in `last` the figure comes from the last match that holds a
  number, so a trailing match with nothing numeric in it does not erase the
  count;
- if it finds nothing, the card shows the time and stays silent about tokens. It
  does not draw a zero — zero tokens would be a statement about the session, and
  a log we could not read a number out of does not support one;
- with nothing declared at all, that silence is simply the normal mode, not a
  degraded one. The first kind of knowledge is there either way.

The numbers are stored with the session records under `.briefboard/`, never in
`doc/backlog.md`: they are runtime facts about processes that ran, not part of
what a task *is*. And money is deliberately absent — rates, models and what they
cost you are yours to know, and not something the board should be guessing at.

### The watchdog: what was claimed against what happened

Every status on this board is written by the agent whose work it describes. That
is the whole model, and it has one hole in it: nothing checks. Three ways it has
failed here, all of them observed rather than imagined:

- a worker committed its work and its session died before it wrote the status —
  the card still says *in progress*, and the branch has been finished for hours;
- a session started without the tool permission it needed, could not ask for one
  headless, and exited 0 having written nothing at all;
- a worktree with no commits in it was cleaned up, and took the work with it.

Each of those was found by a human who happened to look. The watchdog is the
board looking instead — and it **only** looks. It writes no status, runs no git
command that changes anything, and merges nothing: the board prepares a decision,
you take it.

**It reports a disagreement and nothing else.** Five of them:

| the card says | git and the registry show                       | the mark            |
| ------------- | ----------------------------------------------- | ------------------- |
| in progress   | the board's session is over, the branch has commits | *work not recorded* |
| in progress   | the board's session is over, no commits         | *nothing committed* |
| review        | no branch for this task                         | *no branch*         |
| review        | a branch with no commits of its own             | *empty branch*      |
| done          | its branch is not merged into HEAD              | *not merged*        |

Everything else stays silent, on purpose. A mark on every card is a mark nobody
reads, and a watchdog people have learned to skip is worse than none — it would
be quiet on the day it mattered and nobody would be looking anyway. In
particular it says nothing about a task in progress that the **board** never
started a session for (an agent you dispatched yourself in a terminal leaves the
board no record, and flagging those would flag every honest run), nothing about a
finished task whose branch is gone (deleting it after the merge is the cleanup
this guide recommends), and nothing about a branch left behind on a cancelled
task or one put back into the backlog — an abandoned branch is what those
outcomes are supposed to leave.

The wording is an observation and not a verdict: "the session has ended, the
branch carries commits, and the task is still in progress". Why it happened is
not something the board can know, and *not merged* has an honest false positive
of its own — a branch squashed or rebased into your integration branch looks
exactly like one that never landed. The card's dialog says so where the finding
is written out in full.

**What it costs.** Three `git` calls for the **whole** board, not per card: one
lists the task branches, one lists those carrying commits `HEAD` does not have,
one names `HEAD`. They run in parallel, so a check costs about what a single
`git` invocation costs on your machine — measured against this repository at 130
task branches: 190 ms, and 900 ms on the same machine while a virus scanner was
busy. What it does not do is grow with the number of tasks; asking
git per card, the way the closing block does, would have been four calls
**each**. It runs
when the board starts, when a session starts or ends, and when the backlog
changes, at most once every 10 seconds; a burst of writes is one deferred check
rather than one each. So the ceiling is 6 checks a minute however busy the board
is, and a discrepancy is on screen within ten seconds of the event that made it —
without opening the card, which is the only way a watchdog is any use.

`BRIEFBOARD_WATCHDOG_MS` raises that floor; it cannot lower it. A value below
`10000` is raised to the floor, and the board says so on stderr rather than
quietly obeying — `0` included, which is what people write when they mean "off":

```
BRIEFBOARD_WATCHDOG_MS: 0ms is below the floor of 10000ms — using 10000ms. Write "off" to stop the board asking git at all.
```

`BRIEFBOARD_WATCHDOG_MS=off` is that way out: it turns the whole thing off for a
repository where you would rather the board never ran git at all. In a project
that is not a git repository the watchdog simply says nothing.

### Isolated sessions: their own branch and working tree

A session can be started **isolated**. Then it does not run in the project
directory at all: the runner adds a git worktree at

```
.briefboard/worktrees/T-0007
```

and puts it on a branch `task/T-0007`, created from the current HEAD of the
shared checkout. A session that writes code has to be on its own branch, and
`git checkout -b` in a checkout shared with other agents would pull HEAD out from
under them — this project has already lost a commit that way. `git worktree add`
does not move the shared checkout's HEAD, and it is the only git command the
board runs there.

Restarting the session for the same task reuses the branch and the worktree
instead of failing, so the previous run's work is still there.

#### A worktree is a checkout, not an installation

`git worktree add` writes the files git tracks, and that is all it does. It does
not install anything: no `node_modules`, no `.dart_tool`, no `.venv`, no
`vendor/`, no build cache. For a project with zero dependencies — briefboard's
own repository is one — that changes nothing. For every other project it is the
difference between a worker that can run the tests and one that cannot.

The failure is worse than it sounds, because of who sees it. The brief tells the
worker to cover its change with tests and run them; the worker runs the project's
test command; the command dies on a missing package. The agent has no way to tell
that from a genuine failure, so it does what it was asked to do with a failure —
it reports it, or it starts "fixing" code that was never broken. You read a
report about your project that is really a report about an empty directory.

**`BRIEFBOARD_SETUP_CMD` is the supported answer**, and it is one you have to
give:

```bash
BRIEFBOARD_SETUP_CMD='npm ci' \
  node server/server.js          # next to the worker command from "Turning it on"
```

- it runs **once per worktree**, with that worktree as its working directory,
  after the worktree is created and before the worker session starts in it;
- only the worker session triggers it. The briefing and review sessions run in
  the project directory, which is already installed, and never touch it;
- a non-zero exit, a command that cannot be started, or more than **10 minutes**
  kills it and **refuses the session**. Nothing is started in a tree that was not
  prepared — the log carries `[briefboard] setup failed (setup-failed)` or
  `(setup-timeout)` and the command's own output above it. The limit exists for
  the install that never ends (no network, or a tool waiting on a prompt a
  headless session cannot answer), not for the slow one;
- success is recorded in `.briefboard/worktrees/T-0007.setup.json`, and only that
  file suppresses the next run. So a restart on a prepared worktree does not
  reinstall, a preparation that failed is retried on the next session, and
  deleting the file forces a rerun;
- unset, nothing runs and nothing is said about it.

**What it does not do.** It does not make dependencies appear by themselves. The
command is yours because the stack is yours: `npm ci`, `flutter pub get`,
`uv sync`, `bundle install`, `go mod download`, several of them chained in a
script. briefboard has no way to know which is right and no business guessing —
a wrong install command is worse than no install command. Declare nothing and the
worktree is as empty as it was before this feature existed; that is the correct
default for a dependency-free project and the wrong thing to leave in place for
any other.

**And it is not free.** The price is one installation per task, paid on the first
session of that task. On a large toolchain that can cost more, in wall-clock
time, than the task it is preparing for — a fact worth knowing before you turn it
on, and worth weighing against the alternative, which is an agent burning tokens
on a dependency error. It is one install per task rather than per session
precisely because per session would have made the feature too expensive to keep.

**The alternative — letting the agent install — has a permission tax.** If your
worker prompt says "run `npm ci` first" instead, that command must be in the
agent's own `--allowedTools`. It will not be there by accident: a list built for
reading, editing and testing does not carry `Bash(npm ci)`, and a headless
session that hits `requires approval` has nobody to approve it. The session then
ends politely, with an exit code of 0 and nothing written — the quietest failure
in this document. The setup command avoids that entirely: the board runs it
directly, so it passes through no permission list at all.

If the worktree cannot be prepared the session is refused instead of started, and
the reason says which step failed: `not-a-repo` (the project is not a git
repository), `no-git` (no git executable), `worktree-failed` (git refused —
its own message is in the session log). None of them falls back to running in
the shared checkout; that silent fallback is exactly what isolation exists to
prevent.

The worktree is **not** removed when the session ends: the result of the work is
inside it. Removing it is a deliberate manual step, once the branch has been
merged or abandoned:

```bash
git worktree remove .briefboard/worktrees/T-0007
git branch -d task/T-0007
```

The session log stays in `.briefboard/sessions/` of the shared project, not
inside the worktree — logs should not end up in the tree the session commits, and
you always look for them in one place.

The isolated start is what the worker session below uses. The briefing session
stays in the project directory: it only writes a brief, and it needs to see the
project as it is.

### Cleaning up session worktrees

Worktrees accumulate: one per task that has ever run an isolated session, and
nothing removes them. In this project's own repository they had grown to 86
entries and 119 MB before anyone looked. They do no harm — the directory is
gitignored, and neither the board nor the tests read it — but `git worktree
list` becomes unreadable exactly when you need it, which is when you are working
out who is working where.

briefboard never cleans them up on its own, and that is deliberate. A tool that
removes working directories by itself will one day remove the one that mattered:
a worktree whose branch is not merged holds work that only `git reflog` can bring
back, if it can at all. So nothing is removed on a schedule, when a session ends,
or when the board starts.

What exists is one button, on the card of the task that owns the worktree —
**Remove the worktree**, described under [After
review](#after-review-merging-and-cleaning-up). It removes that task's directory
and only under the same two conditions you would check by hand, which the board
tests itself: the branch merged, the tree clean. It never passes `--force`, never
touches a branch or a commit, and never removes anything for a task still in
progress. Everything else about worktrees stays yours, and there is no
`briefboard worktrees` command that sweeps them: the board knows about git only
as much as starting a session and closing a task require.

The sweep is therefore still by hand, and two git commands do it, not equally
safely.

`git worktree prune` drops only those registry entries whose directory is
already gone. It never deletes anything you still have, so it is safe at any
moment — run it every so often to keep the list honest:

```bash
git worktree prune
```

`git worktree remove` deletes the working directory. Do that only when BOTH
conditions hold, not one of them:

1. the branch is fully merged — it appears in `git branch --merged main`;
2. the working directory is clean — `git -C .briefboard/worktrees/T-0007 status
   --porcelain` prints nothing.

```bash
git branch --merged main                                      # is task/T-0007 there?
git -C .briefboard/worktrees/T-0007 status --porcelain        # empty?
git worktree remove .briefboard/worktrees/T-0007
git branch -d task/T-0007
```

If `remove` refuses because of uncommitted changes, look at what those changes
are instead of forcing it: `--force` throws away the only copy of work the agent
never committed. And a worktree marked `locked` in `git worktree list` is left
alone — it was locked for a reason, and unlocking it is a separate decision, not
a step in a cleanup.

Never remove the worktree of a branch that is not merged. There is no undo.

### The worker session: Ready → In Progress

Dropping a card from Ready into In Progress takes the task into work, and starts
the worker session for it if `BRIEFBOARD_WORKER_CMD` is set. Two things are
different from the briefing drop:

- **it asks first.** The confirmation says that an agent session will be started;
  when no worker command is configured it says that too, so you never confirm a
  session that cannot happen.
- **it is isolated.** The session runs in its own worktree on its own branch (see
  above), because it commits code.

A task with unfinished prerequisites cannot be started from the board at all: the
server refuses with `409` and names each blocker with its status. That is the
same rule and the same code as the CLI's gate — but without the CLI's `--force`,
which stays where it warns loudly.

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

Lines in that prompt that are not decoration, and a worker prompt without them is
wrong:

- **do not set `in_progress`** — the drop already did it.
- **write statuses to the shared checkout.** The board reads the shared
  `doc/backlog.md`; a status written inside the worktree is invisible until the
  branch is merged, so the card would sit in Ready for the whole time the work is
  happening, and the board would stop showing what is going on.
- **read the task and the briefs from that same shared checkout.** A worktree is
  made from a commit, and the brief the briefing session wrote a minute ago is an
  untracked file — it is not in there. A worker that opens the `doc/brief/` under
  its own feet finds an empty directory and starts guessing, while you are looking
  at the brief on your screen.
- **file what you find as its own task.** A worker meets things outside its brief:
  a bug, a capability whose absence only shows up while you build, a piece of scope
  that has to be left out. All three are lost the same way — fixed quietly, swallowed
  into the task, or written into a report that is read once. The line makes it a card
  instead, of whichever type fits. A blocked status still leaves a stuck card you can
  see; a finding that never reaches the backlog leaves nothing behind at all.
- **commit as you go.** A session ends on a usage limit or a timeout without
  asking, and whatever lives only in the working tree ends with it: of three
  worker sessions killed that way here in one day, two had changed files and no
  commits at all. The protocol carries the rule too (`agents/WORKER.md` step 2,
  with the second reason — an unchanged worktree can be cleaned up automatically),
  and the prompt repeats it because the prompt is what a session reads first.
- **look, when the criterion is about looking.** `Bash(node tools/screenshot.mjs:*)`
  is the one way this session can see the board: starting a server is not in its
  permission list, and headless there is nobody to approve it. Without that line a
  brief saying "the header must not wrap in Japanese" cannot be met by the worker
  who owns the task — nor by the reviewer afterwards, whose permissions are
  narrower still (§7, T-0143).
- **ask instead of guessing** — the same protocol the briefing session has, for
  the same reason. See below.

Two ways out of that were considered and rejected, and knowing why saves you from
proposing them again. Committing the brief for you: the board would be making a
commit in your repository, on your branch, past your review, deciding for you what
is fit to record — a tool does not do that behind your back. Copying `doc/` into
the worktree at creation: it works until someone edits one of the two copies, and
from that moment you have two backlogs and no way to say which is the real one.
There is one set of task data — the shared checkout's — and every session reads
and writes exactly that.

One variable serves both directions. The board starts every session with
`AGENTBOARD_ROOT` set to the project, so `node tools/task.mjs` reaches the shared
backlog from inside the worktree with nothing prepended — the status out — and the
same path spells the briefs to read in, at `$AGENTBOARD_ROOT/doc/brief/`. Writing
is a property of the session rather than a discipline the agent has to keep, and
that is deliberate: the prefix used to be the agent's job, and it needed a
permission rule matching the exact text of a command the agent was free to write
differently. Twice it did, and both times the run was lost at its very last step:
everything implemented and committed, one blocked command, the card still in the
previous column.

Its permission list is wider than the briefing one because the job is wider: it
edits code, runs the tests and commits. Three entries earn a word each.

`Bash(printenv:*)` is the one that makes the variable usable. It sits in the
session's environment either way, but a tool call is what turns it into a path
the agent can read a file from — leave the rule out and the session knows a brief
exists and not where.

`--disallowedTools "Edit(doc/backlog.md)"` turns "your branch must contain no
changes to `doc/backlog.md`" from an instruction the agent is asked to remember
into something it cannot do. The status still reaches the board: it travels
through `tools/task.mjs`, not through a text editor.

`Bash(npm test)` and `Bash(npm run:*)` fit this project; put your own test
command there. `Bash(git:*)` is every git command there is — that is what an
agent that commits costs, and precisely why the session runs in its own worktree
on its own branch.

When the session finishes, the branch is waiting for you. Read the diff, run the
tests, merge it, and set `done` yourself — that step has no drop and no endpoint,
by design. The card tells you which branch and which directory it is talking
about; "After review: merging and cleaning up" below has the whole sequence.

### When the worker has questions

A worker session ends in one of two ways, and both are normal: it takes the task
to `review`, or it has a real question about the briefs and writes it down. The
ending it must not have is the third one — filling an unclear brief in with a
guess, which ends as committed code written from a requirement nobody confirmed.

When it asks, the task **stays in `in_progress`**. That is not an oversight: the
worker's protocol allows it exactly two transitions (`ready → in_progress` and
`in_progress → review`) and neither leads back, so there is nowhere for it to put
the task instead. The board tells the truth by splitting the two things:

- the **status** says which phase of the lifecycle the task is in — it is taken,
  it belongs to a worker, nobody else should start it;
- the **needs answer** marker says the work has stopped and is waiting for a
  human.

So a card sitting in In Progress with that marker is not being worked on, however
long it has been there — it is a question addressed to you. Without the marker
you would have to open the session log to find that out, and the board would be
showing work that is not happening. This is the same separation as with
"blocked": a state that is not a phase gets its own marker instead of a status of
its own.

Answering is identical to answering a briefing session — the box at the bottom of
the card — and with the restart box left checked the **worker** session runs
again, in its own worktree, with your answers now in the description. Its branch
and everything already committed on it are still there: restarting reuses the
worktree, it does not start over.

### After review: merging and cleaning up

A worker session ends by putting the task in `review`, and one step of what
follows is yours: the merge. The rest is on the card.

Open a task in Review and the block at the top of its dialog says what git knows
about it right now:

```
branch     task/T-0007
worktree   .briefboard/worktrees/T-0007
⟳ the branch is not merged into main

Read the diff of the branch and run your own tests on it.
Then merge it yourself, from your own checkout:
   git merge --no-ff task/T-0007          [copy]

[ Accept ]  the branch is not merged
[ Remove the worktree ]  the branch is not merged
[ Check again ]
```

Merge in your terminal, press **Check again**, and the same block reads:

```
✓ the branch is merged into main

[ Accept ]  [ Remove the worktree ]  [ Check again ]
```

**Accept** performs `review → done` and stamps `closed`. It asks first, because
`done` is terminal — the board has no way back from it. **Remove the worktree**
deletes `.briefboard/worktrees/T-0007` and nothing else: the branch and every
commit on it stay.

Three things about that block are deliberate:

- **The state is read from git, not remembered.** The board runs
  `git merge-base --is-ancestor` against the branch your checkout is actually on,
  so "merged into main" says main because that is where your HEAD is. It asks
  when you open the card and when you press **Check again** — never on its own
  timer and never on the board's own refresh, because the backlog changes for a
  dozen reasons a minute and git state changes for none of them.
- **The branch is found, never guessed.** Both spellings are looked for —
  `task/T-0007` from the board's own runner and `task/T-0007-short-slug` from a
  worker that made the branch by hand — and only a branch git really has is
  reported. A task nobody branched for says "no branch for this task" and can be
  accepted as it always could: there is nothing to check. If *two* branches match
  the task, the board says so and refuses to pick one: the accept still stands
  (the ambiguity is the board's, not your judgement's), the removal does not.
- **A refused action says why, next to itself**, instead of vanishing or sitting
  there silently.

Nothing here names your test command. briefboard runs on Node; your project may
be anything, and a copyable line has to be a promise — so the hint says "your own
tests" and leaves the command to the person who knows it.

Here is the same sequence by hand, ready to copy, for `T-0007`:

```bash
# 1. read what was written
git log --oneline main..task/T-0007
git diff main...task/T-0007

# 2. run the tests on the branch itself — your own command, in that worktree:
#    .briefboard/worktrees/T-0007

# 3. merge it, from your own checkout
git switch main
git merge --no-ff task/T-0007

# 4. close the task
node tools/task.mjs status T-0007 done

# 5. remove the worktree — only if BOTH of these hold
git branch --merged main                                   # is task/T-0007 there?
git -C .briefboard/worktrees/T-0007 status --porcelain     # empty?
git worktree remove .briefboard/worktrees/T-0007
git branch -d task/T-0007
```

Step 5 is the one to be careful with, and "Cleaning up session worktrees" above
has the reasoning: a worktree whose branch is not merged holds work that only
`git reflog` can bring back, if it can at all. `--force` throws away exactly
that, and a worktree marked `locked` in `git worktree list` is left alone.

**The board does not do step 3, and it is not going to.** Not because it is hard
to automate — a merge button is an afternoon's work — but because a merge is a
judgement: reading the diff, weighing the quality, resolving a conflict. A button
that merges will one day merge the wrong thing, and the person who trusted it is
the one who then has to work out what happened.

Steps 4 and 5 are the buttons above, and the difference is that both of them are
checkable. `done` is a record of your decision, and the board takes it only once
git shows the branch in your history — it cannot make that true, so it refuses
rather than pretending. The removal is bounded by the two conditions of step 5,
which the board tests itself instead of trusting that you did, and it never
passes `--force`.

**There is still no button that pushes a task into Review.** The one case that
would ask for one — a worker that died before writing its own status — is visible
on the card as a session that ended, and its honest repairs are restarting the
session or one CLI command. A button there would let a task be declared ready for
judgement by someone who has not read the branch, which is exactly what the
accept check above then has to catch.

### The review session: a card already in Review

Steps 1 and 2 above — reading the diff and running the tests — are work, and they
are work an agent can do. A card in **Review** therefore carries a **Review
session** block: what the session does, and a *Start the review session* button
if you set `BRIEFBOARD_REVIEW_CMD` (or its earlier name,
`BRIEFBOARD_ORCHESTRATOR_CMD`). With neither variable set the button is
not there — starting the session is the whole of what it does, so with no command
there is nothing left for it to be — but the block is, and it names the variable
that would bring the button back. The button is missing for a second reason as
well, and on a working board it is the usual one: a session is already running on
that task. One task carries one session at a time, so the line the button would
have occupied says to stop the running one first, in the **Running session**
block above. The block appears on a card in Review and nowhere else: nobody who
does not run review sessions should read about them on every card they open.

The block also says, before anything is started, that the session sets no status.
That is worth reading in advance, because from the outside "the session ended and
the card did not move" looks the same whether it is the design or a failure: for
the briefing and worker sessions a status that has not moved means something went
wrong, and for this one it is exactly what a finished review looks like.

The session reads the diff of `task/T-NNNN` and the task's briefs, runs the tests
in the worktree the worker left, and appends a `### Review verdict` section to
the task's description: which acceptance criteria are met, what the tests did,
what it would change, and whether it would merge. That section is its entire
output.

**It does not do steps 3, 4 and 5, and it cannot.** No status — `done` least of
all, because `done` means "I accepted this" — no merge, and no worktree removal.
The paragraph above about the board not merging applies to the session word for
word; it changes who reads the diff, not who decides. The permission list in the
ready-to-copy command in the README carries that: no `Edit`, no `Write`, and git
allowed by read-only subcommand rather than as `git:*`. It does carry
`Bash(node tools/screenshot.mjs:*)`, which is not a way to write anything: a
criterion about how something looks is judged by looking, and a reviewer that
takes it on the worker's word has not reviewed it (§7).

It is a **button and not a drop** for a plain reason: the task is already in
Review — the worker's own transition put it there — so there is no column to move
it into and nothing about its status to change. It asks for confirmation before
starting, like the drop into In Progress does, and for the same reason: it starts
a process that reads your code and writes into your backlog.

It runs **in the project directory**, not in a worktree of its own. The diff it
reads belongs to the branch the worker created, and the verdict goes to the
shared backlog; a worktree would put it on a copy where neither of those is what
it is looking at.

If it cannot judge — the briefs contradict the diff, say — it does what the other
two sessions do: writes a `### Session questions` section, leaves the task in
`review`, and stops. The card then carries the **needs answer** marker, and the
answer box in its dialog restarts the review session with your answer in front of
it.

Return a task for rework and review it again, and the second verdict opens its
own section below the first. It has to: the branch behind it is different, and a
verdict merged into an older one would read as a judgement of code nobody looked
at.

### The run profile: which mode an agent runs in

Not every task deserves the same agent. Measured in this project: a documentation
task costs 46–72 thousand tokens, a narrow code task 53–98, a broad one 150–274.
Editing three READMEs in the mode you keep for the process-spawning subsystem is
simply wasteful — and the difference is decided before the work starts, not
during it.

Hence one optional field on a task, `profile`, whose value is substituted into the
command template as `{profile}`. It follows the `{id}` rule exactly: the
substitution happens **after** the template has been split into arguments, so a
profile value can change the contents of one argument and never add another.

**Switching it on takes two steps, and one without the other does nothing:**

1. **declare the legal values** yourself, in one variable, comma-separated. The
   first one is the default — what a task with no profile of its own runs with,
   which is why an empty field can never leave a dangling flag in the command;
2. **put `{profile}` into the command template** you want the value to reach:
   `BRIEFBOARD_SESSION_CMD`, `BRIEFBOARD_WORKER_CMD`,
   `BRIEFBOARD_REVIEW_CMD`, or any of them. There is no
   implicit place for it — declare the values, leave the templates untouched, and
   the profile chosen on a card is written to the task and substituted into
   nothing.

The ready-to-copy commands earlier in this guide contain no `{profile}`, and that
is deliberate: a template that uses it while nothing is declared refuses to start
(the second refusal below), so the commands handed to everyone have to work
without a declaration. Adding the placeholder is your step, taken together with
the declaration:

```bash
BRIEFBOARD_PROFILES='deep, fast' \
BRIEFBOARD_WORKER_CMD='agent --mode {profile} -p "Implement task {id} ..."' \
  node server/server.js
```

This command replaces the ready-to-copy worker command, it does not accompany it:
copy one of the two, not both.

**briefboard never interprets the value.** It does not know that a profile is a
model, does not keep a list of models, does not follow which ones came out this
month. It checks that the task's value is one of yours and substitutes the string.
Everything a profile *means* stays where it belongs — in your template and in your
agent: a model, a reasoning level, a step budget, another agent entirely. That is
what keeps the board agent-agnostic while still letting you choose the mode.

Setting it, from the CLI or from the card:

```bash
node tools/task.mjs profile T-0007 fast     # one of the values you declared
node tools/task.mjs profile T-0007 --clear  # back to the default
```

The card's dialog shows a **run profile** selector built from your declaration —
and shows nothing at all if you declared nothing. If you declared values but your
templates carry no `{profile}`, the selector appears with a note saying exactly
that: no session command uses the placeholder, so the choice is stored and starts
nothing different. The board weighs the two templates apart, because they are
apart — with `{profile}` in the worker command only, the note says the choice
reaches worker sessions and is ignored by briefing ones. The selector is not
hidden in either case: a control that quietly disappears has already been read
once here as a feature that went missing, and "it does nothing yet, here is why"
is the shorter path back to a working setup. In the agent workflow the
orchestrator sets it at briefing time (`agents/ORCHESTRATOR.md` step 3): that is
the first moment anyone knows how mechanical the work really is.

Three refusals stand between a typo and an agent's command line:

- a task carrying a value you did not declare does **not** start a session —
  `unknown-profile`, with the value and your list named in the board's log;
- a template using `{profile}` while nothing is declared disables that kind of
  session at start-up, with a message saying so, rather than running `--mode` with
  nothing after it;
- with nothing declared at all the field is ignored entirely, and everything
  behaves exactly as it did before this feature existed.

**The risk is worth stating plainly: a wrong choice costs more than the saving.**
A mode too weak for the task buys a rework, and the single rework measured in this
project cost 200 thousand tokens — the entire saving from a dozen documentation
tasks, spent at once. Use it where the work is known to be mechanical; when in
doubt, leave the default.

### What it means for security

This is the only place where the board starts a process, so the limits are
deliberate:

- the command comes only from the environment variable — never from the HTTP
  request, which contributes the task id and nothing else;
- the template is split into arguments by the server itself and run without a
  shell; `{id}` and `{profile}` are substituted after that split, so they can
  change the contents of an argument but never add one;
- sessions are refused entirely when the server is bound to a non-loopback
  address (the server warns about it at start-up), because a network-reachable
  endpoint that runs a configured command is remote code execution;
- sessions run with the served project as their working directory and act with
  your permissions, so enable this only with a command you would run yourself;
- no session outlives the board: stopping the server kills the sessions it
  started, and a restarted board marks what it finds still running as cut short
  instead of restarting it.

**Stopping kills the sessions; it does not merely stop watching them.** The board
ends each session's whole process tree — `taskkill /t /f` on Windows, a signal to
the whole process group everywhere else — and then waits for the session logs to
be released before it goes. That wait is bounded, on purpose. A log is released
only once *every* process holding the session's stdout has let go, so a
descendant that broke out of the tree and survived the kill is what an unbounded
wait would be waiting for: measured once at 20 seconds, which is that
descendant's own lifetime and nothing the board chose. Instead the kill is
escalated once, and then the board stops waiting, closes the log files itself and
exits, rather than hanging on a process it can no longer reach.

The bound gives up on the waiting, never on the killing. When it is what ends the
wait you get two things: a warning in the board's output, naming how many logs it
closed and why, and a session record still saying `running` — the board is gone
before the process is, so nothing is left to write down how that session ended.
Whatever survived is then a leftover like any other, and the next board start
ends it and marks the record, exactly as after a crash.

All of that is a board that is *stopped*, which is the only case the promise
covers. A board that is killed hard, crashes, or goes down with the machine never
gets to kill anything at all, and neither Windows nor Linux ends an agent because
the process that started it is gone — on
Windows the job object a session sits in takes the launcher (`cmd /c ...`) and
not the agent underneath it, and on Linux nothing dies at all: the launcher
(`sh -c ...`) is handed to init and goes on running. So the board writes the
processes of each running session down every half minute, and the next board
start ends whatever of them is still running and says so in its output.

Two things it deliberately will not do. It never touches a process whose start
time no longer matches the one written down: that is a process id the machine
has since handed to a stranger, and the stranger is not the board's to kill. And
it cannot clean up after a session nothing was ever written down for: one less
than half a minute old when the board died, or one that ran while the machine
would not list its processes at all — reading that list costs a whole PowerShell
on Windows, and on a machine busy enough it does not answer in time. What it will
not do is pass that off as a board with nothing to clean up: it says so while it
is happening, and the next start names the sessions it has no record for and
tells you they have to be looked for by hand.

How closely the start time is read differs: a tenth of a microsecond on Windows,
a whole second on Linux, which is all `ps` will say. A second is enough, because
a stranger could only be mistaken for ours by starting in the very second ours
started — with ours still alive through it, so every process id on the machine
would have to have been handed out and come round again inside that second.

Both halves have been run where they belong: Windows 11, and Linux in a Debian
container. **macOS has not** — its `ps` prints the start time in its own way, and
until someone runs it there, the cleanup on macOS is code that has never
executed.

### The board and an orchestrator you started yourself

Most people run two things at once: the board in one window, and an orchestrator agent
in a terminal or an IDE in another. They share the project, and they must not both send
an agent at the same task.

The backlog takes care of itself: the board and `tools/task.mjs` write `doc/backlog.md`
through the same cross-process lock, so a status either of them sets is visible to the
other immediately. Sessions need one command, because they are not in that file:

```bash
node tools/task.mjs sessions
```

It reads the same `.briefboard/sessions/registry.json` the board writes, and it applies
the same check the board does — a record only counts as `running` while the board that
wrote it is alive, so a registry left behind by a board you have since closed shows as
`interrupted` rather than as work in progress.

Check it before starting an agent on a task. If the task is `running`, the board already
has one on it: a second agent on the same `task/T-NNNN` branch gives two sets of commits
nobody can review apart, and merging that is manual work. This is a hard rule for
orchestrator agents too — it is written into `agents/ORCHESTRATOR.md`, which they read
before assigning work.

The board applies the same rule to itself. A second board instance — another port, the
same project — refuses to start a session for a task the first one is already running,
and answers the drop with `already-running`.

## 11. pre-commit hook

The repository ships a pre-commit hook at `.githooks/pre-commit` that runs
`node tools/task.mjs validate` before every commit. If validation fails, the
commit is blocked and the errors are printed.

The hook lives under `.githooks/` (which is versioned in git) rather than
`.git/hooks/` (which is not). It is only active once you opt in with a one-time
command:

```bash
git config core.hooksPath .githooks
```

Without that setup, git will not run the hook at all — there is no way for a
repository to auto-enable a hook by itself. Enabling it is worth it: it stops a
malformed `doc/backlog.md` (duplicate IDs, broken headers, dangling brief links)
from ever being committed.

## 12. FAQ & Troubleshooting

**The port is already in use.** If nothing was pinned, the board handles this
itself: it takes the next free port after `4571` (up to `4590`) and prints the
URL it bound — read the start-up output rather than assuming `4571`. The error
appears only for a port you asked for explicitly (`PORT=8080` or
`briefboard serve --port 8080`), because a requested port is never silently
swapped for another one. Free that port, or ask for a different one:

```bash
PORT=8081 node server/server.js
```

If the number does not matter — a board started by a script, or several at once
— ask for any free port instead and read the banner:

```bash
PORT=auto node server/server.js
```

**The board shows the wrong project.** Several boards look alike; the header and
the tab title name the project (the folder name, or `BRIEFBOARD_NAME`). Check
the tab, and start each board from its own project directory with
`briefboard serve`.

**Nothing seems to run / the test suite matches no files.** You are probably on
Node < 21. The symptom is that `node --test` (via `npm test`) expands no files
from the `tests/**/*.test.js` glob and silently runs zero tests. Check your
version:

```bash
node -v
```

If it is below `21.0.0`, upgrade Node. See [Requirements](#2-requirements).

**`doc/backlog.md` looks broken.** Run the validator to find out exactly what is
wrong:

```bash
node tools/task.mjs validate
```

It catches duplicate IDs, broken headers, invalid `status`/`type` values, and
dangling links to briefs that do not exist. Fix the reported problems and run it
again until it prints `OK`.

**The board is not reachable from another machine.** That is by design. The
server binds to loopback (`127.0.0.1`) so the board and its writing endpoint are
not exposed without authentication. If you genuinely need a network bind, set
`HOST` or `AGENTBOARD_HOST` explicitly (for example
`HOST=0.0.0.0 node server/server.js`) — the server will print a `WARNING` — and
read [SECURITY.md](../../SECURITY.md) first.

**I dropped a card but no session started.** Check the server's start-up output
first: it prints `sessions: on ...` or `sessions: off (<reason>)` for the
briefing command, a `worker: ...` line for `BRIEFBOARD_WORKER_CMD` and a
`review: ...` line for `BRIEFBOARD_REVIEW_CMD` — a drop into In Progress
reads the second line, not the first, and the review button the third.
`not configured` means the command is unset or empty;
`non-loopback bind` means you started the board with `HOST`/`AGENTBOARD_HOST`
pointing off loopback, which disables sessions on purpose; `invalid command
template` means the template could not be parsed (usually an unclosed quote);
`no profiles configured` means that template uses `{profile}` while
`BRIEFBOARD_PROFILES` declares nothing (see
[The run profile](#the-run-profile-which-mode-an-agent-runs-in)).
If sessions are on and the drop still reports `error`, the command itself could
not be started — the reason is in the server's output and in the session log
under `.briefboard/sessions/`. See [Agent sessions](#10-agent-sessions-opt-in).

**The worker's tests fail on missing packages / modules / a missing command.**
Look at where it was running before you look at the code. An isolated session
gets a git worktree, and a worktree is a checkout with nothing installed in it —
the failure is the environment's, not the task's. Declare
`BRIEFBOARD_SETUP_CMD` (your `npm ci`, `flutter pub get`, `uv sync`) so the
worktree is prepared before the worker starts in it; the section
"A worktree is a checkout, not an installation" above has what it costs and what
it refuses to do. If it is already declared, the reason it gave is in the session
log, on a line beginning `[briefboard] setup failed`.

**The card shows no tokens although `BRIEFBOARD_TOKENS_RE` is set.** Almost
always there is no number in the log to find: an agent printing plain text prints
no usage figures, and the expression matches nothing. Open the session log and
look for the number yourself first — if it is not there, the fix is in the agent
command (an output format that prints usage), not in the expression. See
[What a task took](#what-a-task-took).

**The card shows twice (or four times) the tokens the session used.** The
expression matches more than once and every match is being added up. Count the
matches in the log: if they are separate figures the sum is right, and if they
are the same total repeated — or a total that grows — the log holds a running
total and `BRIEFBOARD_TOKENS_MODE=last` is what reads it. See
[What a task took](#what-a-task-took).
