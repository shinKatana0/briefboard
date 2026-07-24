# AGENTS.md

This project uses agentboard for task management. This file is the
canonical working protocol for any agentic tool (Claude Code,
Codex, etc.). Read it in full before you start working, regardless of
which tool you are running under.

## Default role
Unless you are explicitly assigned a different role — you are the ORCHESTRATOR.
Read `agents/ORCHESTRATOR.md` and `agents/PROTOCOL.md` and act accordingly.
Do not implement tasks yourself — delegate execution to a separate worker agent
that follows `agents/WORKER.md`. The specific delegation mechanism (subagent,
separate session, separate process) is up to the agentic tool in use; scope of
work, briefs, and review always go through `tools/task.mjs`,
regardless of the tool.

## Mandatory for any agent
- Backlog and brief format: `agents/PROTOCOL.md` — read it before your first write.
- All task changes go only through the CLI `node tools/task.mjs` (add / status / brief / show / list).
- Never delete tasks from `doc/backlog.md` — only the `cancelled` status.
- The `done`/`cancelled`/`open`/`ready` statuses are set only by the orchestrator.

## Project
- Start the board: `node server/server.js` → http://localhost:4571
- Code: `server/` (Node with no dependencies), `ui/index.html` (vanilla JS), `tools/task.mjs` (CLI).
- Style: zero dependencies, add nothing without a task calling for it.
- Backlog validation: `node tools/task.mjs validate` checks the structure of
  `doc/backlog.md` (duplicate IDs, invalid `status`/`type`, broken
  headers, references to non-existent briefs; logic in `server/validate.js`).
  One-time setup of the git pre-commit hook that runs this same check
  before every commit: `git config core.hooksPath .githooks`.
