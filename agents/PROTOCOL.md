# PROTOCOL.md — file format contract

This document is the single source of truth about the format. Any agent (orchestrator, worker)
must follow it when writing to `doc/backlog.md` and `doc/brief/`.

## 1. The doc/backlog.md file

Each task is a section that starts with a level-two header of strictly this form:

```
## T-0007 · Critical · Short task title
- type: feature
- status: ready
- created: 2026-07-23
- closed: —
- briefs: T-0007-01, T-0007-02

Free-form task description in markdown. May be multi-line,
contain lists, code, etc. Ends at the next `## T-...`.
```

### Fields

| Field      | Values                                                                |
|------------|-----------------------------------------------------------------------|
| `T-NNNN`   | ID — a continuous sequence, 4 digits with leading zeros. Never reused. |
| `Blocker\|Critical\|Major\|Medium\|Minor` | Priority in decreasing order of urgency: Blocker blocks everything, Critical is critical, Major is important, Medium is normal medium urgency, Minor is low. |
| `type`     | `feature` \| `bug`                                                     |
| `status`   | `backlog` \| `open` \| `ready` \| `in_progress` \| `review` \| `done` \| `cancelled` |
| `created`  | Date and time of creation, `YYYY-MM-DD HH:MM:SS` (machine local time). |
| `closed`   | Date and time of completion/cancellation, `YYYY-MM-DD HH:MM:SS` (machine local time); while not closed — the `—` character. |
| `briefs`   | Comma-separated list of brief IDs; if there are no briefs — empty.     |

### Lifecycle (allowed transitions)

```
backlog ──▶ open ──▶ ready ──▶ in_progress ──▶ review ──▶ done
   │          │        │            │             │
   └──────────┴────────┴────────────┴─────────────┴──▶ cancelled
                                        review ──▶ in_progress (review failed)
```

- `backlog` — the task is only recorded.
- `open` — discussed, decision made, all forks worked through.
- `ready` — a brief is written (the `briefs` field is non-empty — mandatory).
- `in_progress` — the worker implements.
- `review` — the orchestrator reviews and runs the tests.
- `done` — review and tests passed, the task is merged into main. Set `closed`.
- `cancelled` — the task is cancelled or the bug was not confirmed. Set `closed`.

## 2. The doc/brief/ folder

- File name: `T-NNNN-MM-slug.md`, where `T-NNNN` is the task ID, `MM` is the sequential number
  of the brief within the task (01, 02, ...), and `slug` is a short Latin-letter name with dashes.
- One-to-many relationship: a task may have several briefs.
- The brief ID (`T-NNNN-MM`) must be added to the task's `briefs` field.
- The first line of the brief is the header `# T-NNNN-MM · Brief name`.

Brief template:

```
# T-0007-01 · Brief name

## Context
Why we do it, links to the discussion.

## Solution
What exactly we do, architecture, interfaces.

## Scope
What is in / what is out.

## Acceptance criteria
- [ ] item 1
- [ ] item 2
```

## 3. Writing rules

1. **Preferably** use the CLI: `node tools/task.mjs ...` — it guarantees the format,
   continuous IDs, and atomic writes. Editing the markdown directly is allowed, but then the
   agent is responsible for exactly following the format above.
2. Only one agent writes the file at a time. The orchestrator is the only one who changes
   the `backlog/open/ready/review/done/cancelled` statuses. The worker changes only
   `ready → in_progress` (took the task) and `in_progress → review` (submitted the task).
3. Never delete tasks from the file — only the `cancelled` status.
4. Completed (`done`) tasks stay in place in the file — sorting is done by the UI.
5. Dates are always the actual current date in `YYYY-MM-DD`.
6. **The single exception** (T-0017): `ui/index.html` may write to `doc/backlog.md`
   directly, bypassing the CLI/orchestrator — but only through the narrow server endpoint
   `POST /api/task/:id/cancel` (drag & drop a card onto the Cancelled row), and only for
   a single transition `backlog`/`open` → `cancelled`. The endpoint uses the same
   `server/parser.js` (`parseBacklog`/`serializeBacklog`) and the same atomic-write
   pattern (tmp file + rename) as `tools/task.mjs`, and itself verifies on the server that
   the task's current status is indeed `backlog`/`open` before changing the file. This does not
   override the rule in point 2: any other statuses and transitions are still changed only by the
   orchestrator through the CLI.
