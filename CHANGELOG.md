# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-07-24

### Changed

- Renamed the in-app brand from "agentboard" to **briefboard** (board title,
  header, exported `.xlsx` filename, and the server startup banner). The
  `AGENTBOARD_ROOT` / `AGENTBOARD_HOST` environment variable names are unchanged.

### Added

- A demo GIF of the live board + CLI at the top of the README.

## [0.1.1] - 2026-07-24

### Changed

- The agent protocol docs (`AGENTS.md`, `CLAUDE.md`, `agents/*.md`) and the
  in-code strings (backlog preamble, API error messages, generated brief
  template) are now in English. Russian and Japanese remain first-class UI,
  README and guide languages.

### Fixed

- The theme-toggle button tooltip/aria-label is now localized (EN/RU/JA) and
  updates on interface-language switch, instead of being hardcoded in Russian.

## [0.1.0] - 2026-07-24

First public slice.

### Added

- Live kanban board served over HTTP with columns by status
  (Backlog → Open → Ready → In progress → Review) plus collapsible Done and
  Cancelled strips.
- `task.mjs` CLI: `add`, `status`, `brief`, `show`, `list`, `validate`.
- Task workflow with mandatory briefs (`doc/brief/`) and a review step before
  merge, driven by `doc/backlog.md` as the source of truth.
- Orchestrator and worker roles with documented protocol
  (`agents/PROTOCOL.md`, `agents/ORCHESTRATOR.md`, `agents/WORKER.md`).
- Export the current board to Excel (`.xlsx`).
- Full-text search over task title and description.
- Filter by task type (feature / bug) and multi-select filter by priority.
- Light / dark themes and EN / RU / JA interface languages.
- Drag & drop a card onto the Cancelled strip to cancel it from the UI.
- Live board updates via Server-Sent Events + `fs.watch`.
- Loopback-only bind by default (`127.0.0.1`), with opt-in public bind via
  `HOST` / `AGENTBOARD_HOST`.
- Zero runtime dependencies; requires Node.js >= 21.

[Unreleased]: https://keepachangelog.com/en/1.1.0/
[0.1.2]: https://github.com/shinKatana0/briefboard/releases/tag/v0.1.2
[0.1.1]: https://github.com/shinKatana0/briefboard/releases/tag/v0.1.1
[0.1.0]: https://keepachangelog.com/en/1.1.0/
