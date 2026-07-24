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
10. [pre-commit hook](#10-pre-commit-hook)
11. [FAQ & Troubleshooting](#11-faq--troubleshooting)

## 1. Introduction — what is briefboard

briefboard (the repository is also called `agentboard`) is a lightweight kanban
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
- **OS-agnostic.** briefboard runs anywhere Node 21+ runs — Linux, macOS, and
  Windows. All state is plain markdown on disk, and the atomic write pattern
  (write a `.tmp` file, then rename) is atomic on both POSIX and NTFS.

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
directory for that project. It is idempotent: existing files and directories at
the destination are never overwritten, so a rerun only fills in whatever is
still missing (it prints `skip existing: ...` for anything already there).

### (b) `git clone` and work inside the repository

```bash
git clone <url-of-this-repository>
cd agentboard
```

That is all — there is nothing to install. The code is identical to what `init`
would copy, and you run everything from inside the cloned repository. This is
the recommended path for contributors and local development.

## 4. First run

Start the board server:

```bash
node server/server.js
```

By default the board is served at `http://127.0.0.1:4571`. Open that URL in a
browser and you will see the kanban board.

- **`PORT`** — change the port. Example: `PORT=8080 node server/server.js`
  serves the board at `http://127.0.0.1:8080`. The default is `4571`.
- **Loopback by default.** The server binds to `127.0.0.1` (loopback), so the
  board — and the one writing endpoint, `POST /api/task/:id/cancel` — is
  reachable only from the local machine. This is deliberate: there is no
  authentication.
- **Public bind is opt-in.** To expose the board on the network, set the host
  explicitly via `HOST` or `AGENTBOARD_HOST` (for example
  `HOST=0.0.0.0 node server/server.js`). When the bind host is not loopback the
  server prints a `WARNING` that the board and the writing endpoint are exposed
  with no authentication. See [SECURITY.md](../../SECURITY.md) for the full
  network model.
- **`AGENTBOARD_ROOT`** — point the server (and the CLI) at another project's
  `doc/` so you can run one installation for many projects. Example:
  `AGENTBOARD_ROOT=/path/to/project node server/server.js`.
- **`MAX_SSE_CLIENTS`** — cap on concurrent live-update (SSE) connections. The
  default is `50`.

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
```

Step by step:

1. **Create the task** (orchestrator). It lands in `backlog`:

   ```bash
   node tools/task.mjs add --type feature --priority Major \
     --title "Add CSV export" --desc "Export the board to CSV as well as xlsx"
   ```

   This prints the new ID, e.g. `T-0007`.

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

6. **Submit for review** (worker): once the acceptance criteria are met and the
   tests are green, `in_progress → review`:

   ```bash
   node tools/task.mjs status T-0007 review
   ```

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

## 7. CLI reference

All task changes go through `node tools/task.mjs`. It guarantees the file
format, sequential IDs, and atomic writes. The subcommands are `add`, `status`,
`brief`, `show`, `list`, and `validate` — and only those.

### `add` — create a new task

```bash
node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

Creates a new task in `doc/backlog.md` (in status `backlog`) and prints its ID.
Flags:

- `--type` — `feature` or `bug` (anything other than `bug` is treated as
  `feature`).
- `--priority` — one of `Blocker`, `Critical`, `Major`, `Medium`, `Minor`
  (anything else falls back to `Medium`).
- `--title` — the task title. **Required.**
- `--desc` — the free-form description (optional).

### `status` — change a task's status

```bash
node tools/task.mjs status T-0007 ready
```

Sets the status, validating both the value and the transition. The target must
be one of `backlog`, `open`, `ready`, `in_progress`, `review`, `done`,
`cancelled`. The transition must follow the lifecycle graph:
`backlog → open → ready → in_progress → review → done`, any non-terminal status
→ `cancelled`, plus `review → in_progress` to send work back. An illegal
transition (for example `ready → done`) is refused with an error that lists the
moves allowed from the current status; `done` and `cancelled` are terminal.
Setting the status to its current value is an idempotent no-op.

Add `--force` to bypass the graph for manual correction — it allows any move
between valid statuses and prints a `WARNING` to stderr. `--force` does **not**
bypass format invariants: moving to `ready` is still refused if the task has no
briefs. Moving to `done` or `cancelled` (forced or not) stamps the `closed`
timestamp.

### `brief` — scaffold and link a brief

```bash
node tools/task.mjs brief T-0007 csv-export
```

Creates `doc/brief/T-0007-NN-slug.md` (where `NN` is the next brief number for
that task) with the standard section skeleton, and adds the brief ID to the
task's `briefs` field.

### `show` — print a whole task

```bash
node tools/task.mjs show T-0007
```

Prints the full task (all fields plus the description) as JSON.

### `list` — list tasks

```bash
node tools/task.mjs list
node tools/task.mjs list --status ready
```

Lists tasks, optionally filtered by status via `--status`.

### `validate` — structural check

```bash
node tools/task.mjs validate
```

Runs a structural check of `doc/backlog.md`. It catches duplicate IDs, invalid
`status`/`type` values, broken headers, and links to briefs that do not exist.
It prints `OK` and exits `0` when the file is valid, or prints the errors and
exits `1` otherwise.

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

Open `http://127.0.0.1:4571` in a browser. The board shows your tasks and gives
you these controls:

- **Columns by status.** Backlog → Open → Ready → In progress → Review are
  columns across the board. Done and Cancelled are collapsible strips below the
  board, so closed work does not crowd the active columns.
- **Filter by type.** Show all tasks, only `feature`, or only `bug`.
- **Full-text search.** Search over task title and description.
- **Multi-select priority filter.** Filter by any combination of `Blocker`,
  `Critical`, `Major`, `Medium`, `Minor`.
- **Theme toggle.** Switch between light and dark themes.
- **Language toggle.** Switch the interface language between EN, RU, and JA via
  the `<select>` control.
- **Drag & drop to cancel.** Drag a card from the Backlog or Open column onto
  the Cancelled strip to cancel it straight from the UI. It asks for
  confirmation first, then performs the `backlog`/`open` → `cancelled`
  transition through the narrow `POST /api/task/:id/cancel` endpoint.
- **Export to Excel.** The "Export Excel" button downloads the current board as
  a real `.xlsx` file.
- **Live update.** The board re-renders itself whenever `doc/backlog.md` changes
  on disk — it uses Server-Sent Events (SSE) plus `fs.watch`, so you do not need
  to reload the page.

## 10. pre-commit hook

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

## 11. FAQ & Troubleshooting

**The port is already in use.** Another process is holding `4571`. Start the
server on a different port:

```bash
PORT=8080 node server/server.js
```

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
