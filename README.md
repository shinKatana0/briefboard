# briefboard (agentboard)

English | [Русский](README.ru.md) | [日本語](README.ja.md)

[![npm version](https://img.shields.io/npm/v/briefboard.svg)](https://www.npmjs.com/package/briefboard)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=21](https://img.shields.io/badge/node-%3E%3D21-brightgreen.svg)](#requirements)

A lightweight kanban board + CLI that makes AI coding agents run their work
through a strict workflow — `backlog → open → ready → in_progress → review → done` —
with a mandatory brief before implementation starts and a review before merge.

> The package is published to npm as `briefboard` — `npx briefboard init`
> deploys it into any project (see [Quick start](#quick-start) below). Cloning
> the repository is an alternative path for contributors and local development.

## Why

Agents that work straight from a chat conversation lose structure quickly: it is
unclear what has already been decided, what is still in progress, and who made a
given decision and why. `agentboard`/`briefboard` puts a simple, formal process
on top of any agentic tool (Claude Code, Codex, and the like) — a task backlog, a
mandatory brief before implementation, and a review before merge — plus a live
board that shows all of it to a human in real time.

## Quick start

**Full user guide:** for a detailed, step-by-step walkthrough (installation,
first run, the task lifecycle end-to-end, CLI reference, the board UI, and
troubleshooting) see the
[user guide](https://github.com/shinKatana0/briefboard/blob/main/doc/guide/guide.en.md).

Deploy it into any project with `npx briefboard init`. It copies `server/`,
`tools/`, `ui/`, `agents/`, `AGENTS.md`, `CLAUDE.md` into the current directory
and creates an empty `doc/backlog.md` + `doc/brief/`:

```bash
npx briefboard init
node server/server.js
# → board at http://localhost:4571 (port configurable via the PORT env var)

node tools/task.mjs add --type feature --priority Major --title "..." --desc "..."
```

As an alternative — for contributors or local development — clone the repository
and work inside it directly:

```bash
git clone <url-of-this-repository>
cd agentboard

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

## The board UI

- Columns by status: Backlog → Open → Ready → In progress → Review; Done and
  Cancelled are collapsible strips below the board.
- Filter by task type (all / feature / bug).
- Full-text search over task title and description.
- Multi-select filter by priority (Blocker / Critical / Major / Medium / Minor).
- Theme toggle: light / dark.
- Interface language toggle: EN / RU / JA.
- Drag & drop a card from "Backlog"/"Open" onto the "Cancelled" strip to cancel a
  task straight from the UI.
- Export the current board to Excel (`.xlsx`) with one button.
- Live update: the board re-renders itself when `doc/backlog.md` changes on disk
  (SSE + `fs.watch`), without reloading the page.

## CLI reference

```bash
node tools/task.mjs add --type feature|bug --priority Blocker|Critical|Major|Medium|Minor --title "..." [--desc "..."]
                                  # create a new task in doc/backlog.md
node tools/task.mjs status T-0007 <backlog|open|ready|in_progress|review|done|cancelled>
                                  # change a task's status (validates the transition)
node tools/task.mjs brief T-0007 <slug>
                                  # create doc/brief/T-0007-01-slug.md and link it to the task
node tools/task.mjs show T-0007  # print the whole task (fields + description)
node tools/task.mjs list [--status ready]
                                  # list tasks, optionally filtered by status
node tools/task.mjs validate     # structural check of doc/backlog.md (duplicate IDs,
                                  # invalid status/type, broken brief links, etc.)
```

## Requirements

- Node.js >= 21 (verified empirically, see task T-0041: `node --test` only starts
  expanding the `tests/**/*.test.js` glob from `npm test` starting with Node
  21.0.0 — on Node 18.x and across the entire 20.x line, up to the latest 20.20.2
  release, the same pattern matches no files).
- Zero runtime dependencies — no `npm install`, no third-party libraries.

## Security & networking

By default the server binds to `127.0.0.1` (loopback), so the board is reachable
only from the local machine. A public bind is opt-in via the `HOST` /
`AGENTBOARD_HOST` environment variables. See [SECURITY.md](SECURITY.md) for the
network model and how to report vulnerabilities.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the task workflow, how to run the
tests, the pre-commit hook, and the zero-dependencies style.

## License

MIT — see [LICENSE](LICENSE).
