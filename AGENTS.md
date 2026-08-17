# AGENTS.md

This project uses briefboard for task management. This file is the
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
- All task changes go only through the CLI `node tools/task.mjs` (add / status /
  depends / profile / brief / note / show / list / archive / board / sessions /
  validate). Run it with no arguments and it prints the list it actually has.
- Never delete tasks from `doc/backlog.md` — only the `cancelled` status.
- The `done`/`cancelled`/`open`/`ready` statuses are set only by the orchestrator.

## The board
- Start the board: `node server/server.js` → http://localhost:4571, or the next
  free port when that one is taken (the start-up output prints the URL it bound).
- Backlog validation: `node tools/task.mjs validate` checks the structure of
  `doc/backlog.md` — and of `doc/backlog-archive.md` when the project has one
  (duplicate IDs, invalid `status`/`type`, broken headers, references to
  non-existent briefs, broken or circular `depends`; logic in
  `server/validate.js`).

## The rules of the project you are working in
This file describes the task protocol only. How that project is built and
tested — its test commands, dependency policy, code style — is its own
business, and this file makes no claim about it. Follow whatever the
repository states elsewhere.

If this repository is briefboard itself, its development rules are in
`CONTRIBUTING.md` — read that as well.
