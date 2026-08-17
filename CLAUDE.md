# CLAUDE.md

Project rules are in `AGENTS.md`. Read it in full before you start working.

## Claude Code specifics
If you are the orchestrator in Claude Code — delegate task implementation to a
worker subagent that follows `agents/WORKER.md`. If this project defines one in
`.claude/agents/worker.md`, that is the subagent to use; if it has no such
definition yet, add one pointing at `agents/WORKER.md`.
