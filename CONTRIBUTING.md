# Contributing

Thanks for your interest in improving briefboard (agentboard). This project runs
its own work through the same task workflow it ships, so contributions follow
that process.

## Task workflow

The source of truth is `doc/backlog.md`, with per-task briefs in `doc/brief/`.
Every task moves through fixed statuses:

```
backlog → open → ready → in_progress → review → done   (or → cancelled)
```

There are two roles:

- **Orchestrator** — owns the backlog, writes briefs, assigns work, reviews and
  merges. The only role that sets `backlog/open/ready/review/done/cancelled`.
- **Worker** — picks up a `ready` task, implements exactly what its brief
  describes, and moves it `ready → in_progress` then `in_progress → review`.

Key rules:

- **A brief is mandatory before implementation.** A task cannot reach `ready`
  without a linked brief in `doc/brief/`. Implement only what the brief scopes;
  do not expand it. If you find a new problem along the way, file a separate task
  instead of fixing it silently.
- Work on a dedicated branch named `task/T-NNNN-short-slug`.
- Never set `done` as a worker — only the orchestrator does that, after review
  and merge.

The full format and the allowed status transitions live in `agents/PROTOCOL.md`.
Role instructions are in `agents/ORCHESTRATOR.md` and `agents/WORKER.md`. See
also `AGENTS.md` for the project rules.

## Working with tasks (CLI)

```bash
node tools/task.mjs add --type feature|bug --priority Major --title "..." --desc "..."
node tools/task.mjs show T-0007
node tools/task.mjs status T-0007 in_progress
node tools/task.mjs list --status ready
node tools/task.mjs validate
```

## Running the tests

Tests use the built-in Node.js test runner — no test framework to install:

```bash
node --test          # run the full suite
npm test             # same, via the package script (needs Node >= 21, see below)
```

Cover your changes with tests that match the brief's acceptance criteria, and
make sure the whole suite is green before moving a task to `review`.

## Pre-commit hook

A pre-commit hook validates the structure of `doc/backlog.md` before every
commit. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

The hook runs `node tools/task.mjs validate` and blocks the commit if the
backlog is structurally broken. You can run the same check manually at any time.

## Style: zero dependencies

briefboard has **zero runtime dependencies** and aims to keep it that way. Do not
add npm packages (runtime or dev) without a task that explicitly calls for it.
Prefer the Node.js standard library. This keeps installs instant and the
supply-chain surface minimal.

## Requirements

- Node.js >= 21 (the `npm test` glob only expands correctly from Node 21.0.0; see
  task T-0041 in the backlog for the empirical detail).
- Comments and GitHub-facing documentation are written in English.
