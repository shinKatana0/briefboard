# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-17

The board stops being read-only: a task can now be created, opened, handed to an
agent, watched while the agent works, read back when it is done, accepted and
tidied up after — without leaving the board. Tasks can declare what they wait for,
a backlog full of closed work can be archived, and an installed project finally has
a way to receive a new version.

### Added

- Create a task from the board: the **+** button in the header opens a form for
  title, description, type and priority, and the card appears in Backlog (T-0074).
- Drag a card from **Backlog** into **Open** to start refining it (T-0075).
- Drag a **Ready** card into **In progress** to hand it to a worker (T-0084).
  A blocked card cannot be dragged there, and the attempt is refused with the
  list of what it is waiting for.
- Optional agent sessions behind those two drops. A drop can launch the command
  you configure — `BRIEFBOARD_SESSION_CMD` for refinement, `BRIEFBOARD_WORKER_CMD`
  for implementation — with the task id substituted, a log per session under
  `.briefboard/sessions/`, and a cap on how many run at once. Nothing is launched
  unless you set those variables: without them the drops stay plain status
  changes, exactly as before (T-0076, T-0084). Sessions are refused outright when
  the server is not bound to loopback, and the command never comes from the
  request. Every command we hand you comes with an explicit list of the tools the
  agent may use: a headless agent has nobody to ask for permission, so without
  such a list it politely writes nothing and exits — and the list is where you
  decide what the agent is allowed to touch in your repository (T-0107). The
  session receives the project path in its environment, so it reads the task and
  its briefs from your checkout, including a brief you have not committed yet
  (T-0113, T-0118). A session that ends without changing its task at all says so
  in its own log, with the likely cause, instead of looking like it worked
  (T-0109).
- A worker session runs in its own git worktree on its own branch, so the code it
  writes never moves `HEAD` in your checkout. The worktree is kept after the
  session ends — your work is inside it — and a project that is not a git
  repository gets a clear refusal instead of a session in the shared tree (T-0091).
  A fresh worktree is a checkout, not an installation: no `node_modules`, no
  `.venv`, no `vendor/`, so the tests you ask the agent to run fail there for a
  reason that has nothing to do with the task. Declare `BRIEFBOARD_SETUP_CMD` and
  the board runs it inside the worktree before the agent starts — once per
  worktree, recorded so a restarted session does not install again, retried if it
  failed. A setup that exits non-zero or runs past ten minutes refuses the session
  and says which of the two it was in the session log, instead of handing the agent
  a half-prepared tree. The command is yours: briefboard does not guess a stack,
  and declaring nothing keeps today's behaviour exactly (T-0150).
- A session that still has questions asks them instead of guessing: it writes them
  into the task under a `### Session questions` heading and leaves the task where
  it was — a refinement session in Open, a worker session in In progress — and the
  card shows a "waiting for an answer" marker until you reply (T-0083, T-0101).
  You reply from the card itself: the answer is appended to the description under
  `### Answers` — nothing already written is ever rewritten — and the session can
  be restarted in the same step (T-0085). Questions and answers are a
  correspondence: each round opens its own section in the order it was written and
  the marker follows whichever came last, so a second question lights it again and
  the answer puts it out (T-0114).
- Watch a session from the board: a live marker on the card while it runs and its
  exit state afterwards, the session log readable from the task view, and a button
  to stop a session that has gone on too long (T-0077). A log that is still empty
  while the session runs explains itself rather than showing you nothing — some
  agents print only when they finish — and the guide shows how to make the agent
  stream its output if you would rather watch it fill (T-0115).
- Sessions survive a restart of the board. They are recorded in
  `.briefboard/sessions/registry.json`, so a session that died together with the
  board comes back on the card as "interrupted" instead of leaving a card that
  says nothing (T-0102). `task.mjs sessions` lists them from the command line with
  no board running, and a session started from the board is visible to an
  orchestrator running elsewhere — which is what stops two agents from being sent
  to the same task (T-0103).
- What a task cost: the card totals the sessions it took — how many, of which
  kind, how each ended and how long it ran, with a running one counted as it goes.
  Exact token usage is opt-in and stays agent-agnostic: set `BRIEFBOARD_TOKENS_RE`
  to the pattern that finds the number in your agent's output and the totals
  include it; without it the board says nothing about tokens (T-0116). An agent
  that prints a running total, or prints the same figure twice, used to be counted
  twice over — the very expression the README suggested made a 36-token session
  show as 72. `BRIEFBOARD_TOKENS_MODE=last` takes the last match instead of adding
  them all up (`sum` stays the default), and a value the board does not understand
  counts nothing and names the variable at start-up rather than quietly reporting a
  believable wrong number (T-0163, T-0164).
- A run profile per task, for choosing how much agent a task deserves. Declare
  your own set with `BRIEFBOARD_PROFILES` (the first one is the default), put
  `{profile}` in your session command, and pick a value on the card or with
  `task.mjs profile T-0007 fast`. briefboard never interprets the value — it does
  not know what "fast" means — it only substitutes it, so what a profile selects
  stays entirely yours to define. The picker says plainly when the command you
  configured has no `{profile}` in it, instead of offering a choice that reaches
  nothing (T-0108, T-0121).
- A third kind of session, for the step after review: `BRIEFBOARD_ORCHESTRATOR_CMD`
  and a button on a task in Review start an agent that reads the branch diff and
  the briefs, runs the tests, and writes a verdict into the task under
  `### Review verdict`. It sets no status and merges nothing — that endpoint does
  not write to the backlog at all — so it prepares your decision instead of making
  it (T-0122).
- After review the card tells you what to do with the work: the branch name and the
  worktree path of the session that produced it, and the short sequence — read the
  diff, run the tests, merge, set done, remove the worktree. The guide walks
  through the same closing ritual, including when a worktree is safe to delete
  (branch merged, tree clean) and when it is not. There is deliberately no merge
  button: merging is a judgement, and a button that merges will one day merge the
  wrong thing (T-0117, T-0099).
- A stop button in the header shuts the board down: it asks first, stops any
  running sessions with it, and the page says so plainly instead of retrying
  forever. Only a request from this machine is accepted (T-0082).
- Dependencies between tasks: the optional `- depends:` field, `task.mjs depends`
  to edit it, clickable prerequisites in the task view with their current status,
  and a refusal to start a task whose prerequisite is not closed yet
  (`--force` still overrides, loudly). `validate` now also reports dependencies on
  missing tasks, self-dependencies, and cycles (T-0087).
- A blocked card says what it is waiting for by title, not just by id; the new
  `external` task type describes work that depends on someone outside the project;
  and a "Blocked" filter in the header shows only the tasks that are stuck (T-0092).
- Several boards side by side, one per project: the default port 4571 is no longer
  fatal when taken — the next free port is used and the real URL is printed — the
  project name is shown in the header and the browser tab (override with
  `BRIEFBOARD_NAME`), and `briefboard serve` starts the board for the current
  folder without setting `AGENTBOARD_ROOT` by hand. An explicitly requested
  `PORT` still fails loudly instead of moving silently (T-0078). `PORT=auto` asks
  the kernel for any free port at all, for a board you reach by the URL it prints
  rather than by a port you have to remember or defend (T-0139).
- `briefboard update` brings an installed project up to the version of the
  installed package. It prints a plan by default and writes nothing until
  `--apply`, backs up every replaced file under `.briefboard/backup/<timestamp>/`,
  marks files you have edited locally as `MODIFIED LOCALLY` and keeps them unless
  you pass `--force`, and never touches `doc/` — your backlog and briefs are
  yours. `briefboard --version` now prints both the package version and the
  version installed in the project (T-0094). It also stopped calling everything
  unknown: a project installed before 0.2.0 has no install manifest at all, and its
  files are labelled `no manifest` with the cause named above the list, so
  `unknown provenance` again means only what it should — there is a manifest and it
  does not mention this file (T-0154, T-0157). A manifest that exists but cannot be
  read is now said out loud by `update`, `--version` and `serve` instead of passing
  for an absent one, and `init` refuses to overwrite it: the file is yours, and
  briefboard neither repairs nor deletes it (T-0158, T-0188).
- `task.mjs note <ID> --section "..." --text "..."` appends a section to a task
  description (`--text -` reads it from stdin), so an agent can file its report
  without hand-editing the backlog (T-0098). `add --desc -` reads a description
  from stdin the same way, and both now refuse empty input naming the flag —
  before, an empty pipe filed a task whose entire description was a dash, and the
  finding it was meant to carry was gone (T-0198).
- The end of the loop is on the card. A task in review shows the branch and the
  worktree that produced it, asks git whether that branch is already in your
  `HEAD`, and gives you the merge command itself with a copy button — a step to
  paste rather than to compose. **Accept** then sets `done`, and **Remove
  worktree** does the tidying up, each refusing with the reason when the branch is
  not merged or the worktree is not clean. There is still deliberately no merge
  button: merging is a judgement (T-0148).
- A card can go back. Drag it from **Open** into **Backlog** and nothing written is
  erased — the brief, the questions and the answers stay — so opening it again does
  not pay for a second briefing: the briefing session is started once, not once per
  drop. A card in Open that already has a brief gets a **Start the briefing
  session** button for when you do want another round. The move asks for
  confirmation only when a briefing session is running on the card, because that is
  the one thing it destroys (T-0141).
- `node tools/task.mjs archive` moves every `done` and `cancelled` task out of
  `doc/backlog.md` into `doc/backlog-archive.md`, so the file an agent reads stops
  growing forever — measured here at 660 KB, 88% of it closed work, around 165k
  tokens to read once. Nothing changes for you: the board reads both files, and its
  Done and Cancelled strips look exactly as they did. The frugality is on the CLI
  side, where the agents are — `list` hides closed tasks unless you ask for
  `--all`, `show` finds a task in either file — and the next task id is taken from
  both files, so archiving cannot restart the numbering and hand a second task an
  id your history already used (T-0156). A run that moved something warns you when
  a board is open for the project: a board started before the archive existed reads
  `doc/backlog.md` alone, and its Done column looks emptied until it is restarted
  (T-0174). The start-up banner now names what the board really follows — `doc/`,
  with both backlog files and `brief/` — instead of naming one file and leaving you
  to conclude, right after archiving, that the archive is not watched (T-0187).
- `node tools/task.mjs board` says where the board is: pid, the address it really
  bound, the version it runs and when it started. A running board now leaves a
  trace under `.briefboard/boards/` and takes it away when it stops, which is what
  makes the question answerable at all — with `PORT=auto` there is no port to
  guess. Nothing is taken on trust: a trace whose process is gone is not reported
  as a running board, and when nothing is found the command says where it looked
  and what it cannot know (T-0186, T-0196).
- The board checks what a card claims against what git and the running sessions
  show, and marks the ones that disagree: work in progress whose session is over,
  with commits on the branch or with none at all; a task in review with no branch,
  or with a branch that carries nothing of its own; a task marked done whose branch
  was never merged. The whole observation is on the card, in your language. It
  writes nothing, ever, and says nothing about a card it agrees with — the
  combinations that would flag honest work (an agent you dispatched from a
  terminal, a session still running, a branch deleted after the merge) are
  deliberately not shown (T-0159).
- `node tools/screenshot.mjs --lang en|ru|ja [--width N]` photographs the board: it
  starts one on a free port, captures the page with an installed Chrome or Edge,
  stops the board again and prints the path of the png. It is there so an agent
  working under a permission list can check a criterion about how something *looks*
  — until now no one in the automated loop could, and "the header must not wrap"
  came down to taking somebody's word for it. The permission line is in the
  ready-to-copy commands for both the worker and the review session. A machine with
  neither browser is told so plainly (T-0143).
- `task.mjs show` now leaves the worker reports out and says so in an `omitted`
  field naming how many sections and how many bytes are missing; `show <ID> --full`
  prints the task exactly as stored. The reports were 63% of this backlog and were
  read by everyone who only needed the statement of work: measured over 165 tasks,
  the default output is 2x smaller, and the median card 2.5x (T-0161).
- Stopping the board ends the sessions it started, and now ends their whole process
  tree with them. The command you configure is usually a launcher — `cmd /c claude
  ...`, `npm ci`, `flutter pub get` — so the process that does the work, and writes
  into your worktree, is a grandchild; killing the launcher alone left it running.
  It is `taskkill /t /f` on Windows and a signal to the process group everywhere
  else, and on Windows the escalation that follows the first kill no longer defeats
  it: it used to take the launcher out from under its own tree kill and orphan the
  agent for good (T-0155, T-0192).
- What that promise does **not** cover, spelled out because it is the half you have
  to plan around. It holds for an *orderly* stop only. A board killed hard, crashed
  with the machine or gone with its terminal kills nothing at all — on Windows the
  job object does not take the grandchild, and on Linux the board's death takes not
  even the launcher. Those leftovers are killed at the **next** board start for the
  same project and announced when they are; a board matches them by pid *and*
  recorded start time, so a pid the system has since given to a stranger is left
  alone, and a machine whose process table it cannot read kills nothing and says so
  (T-0193). Even in an orderly stop the wait *after* the kill is bounded: when the
  bound is what ends it, the board closes the session logs itself, warns that it
  did, and leaves the record saying `running` — a descendant that broke out of the
  tree can still be alive once the board is gone. The bound gives up on the
  waiting, never on the killing (T-0208). Measured on Windows 11 and, for the POSIX
  half, on Linux; **macOS has never been run** (T-0199). One more gap closed in the
  same story: a process that has died but not been reaped no longer counts as
  alive, which in a container with no init to reap it (`docker run` without
  `--init`) made a dead board look alive forever and the whole cleanup silently do
  nothing (T-0202).

### Changed

- When the backlog is locked by another writer, the API now answers **503** with a
  `Retry-After` header instead of 500: a client can tell "try again in a moment"
  from "something is broken" (T-0081).
- Dragging a card is easier to aim: while a drag is in progress the drop zones grow
  to the full height of their column — the Cancelled strip with them — the places
  you may drop on are outlined, and the one under the cursor is filled. The board
  looks exactly as before when you are not dragging (T-0112).
- The **+** button carries its word beside the glyph and stands apart from the
  filters, instead of being one small identical chip among seven. Found by watching
  someone look for how to create a task and not find it (T-0137).
- A card says plainly what it can and cannot start. The session a card offers is a
  captioned block with the action on a line of its own rather than a chip among
  chips; a card in Review with no `BRIEFBOARD_ORCHESTRATOR_CMD` — and one in Open
  with no `BRIEFBOARD_SESSION_CMD` — now says so where the button would be, instead
  of showing nothing and looking like a board that forgot; and the review block
  says up front that the session appends a verdict and sets no status, so a card
  still sitting in Review when the session ends reads as a finished review rather
  than as something stuck (T-0144, T-0145, T-0146).
- The header wraps instead of running off the edge of a narrow window. Below
  roughly 1000px the search box used to be cut mid-word and everything after it —
  export, language, theme, the exit button — was off screen with no way to scroll
  to it, because the columns scroll sideways and the header does not (T-0178).
- The board sends only what changed. Every open tab used to re-fetch the whole task
  list on every update: measured on a backlog of 978 tasks, 4.3 MB per status
  change, multiplied by the number of tabs. It is now 1.6 KB, and the first paint
  of the page went from 165 ms to 56 ms. A tab that misses a frame, or one whose
  update would be bigger than the board itself, falls back to reading everything,
  so the picture cannot quietly drift out of date (T-0160).
- The Russian and Japanese README and guide are level with the English ones again:
  everything 0.2.0 added is described in all three languages, section for section.
  The English pass that preceded them filled the gaps anyone outside the Node world
  runs into — that a worker's worktree arrives without your dependencies, what
  briefboard requires of an agent to be usable at all, and how to make an agent
  actually print the numbers the token counter reads (T-0152, T-0153, T-0204).

### Fixed

- A task description can no longer overwrite the task's own status or type: lines
  in the description that look like backlog fields are escaped on write and read
  back verbatim (T-0080).
- Writes on Windows survive transient filesystem errors: a lock briefly held by a
  file watcher or an antivirus is retried instead of failing the whole write
  (T-0089).
- A task title containing `$&` or `$1` no longer garbles the cancel confirmation
  text (T-0096).
- On Windows, a session command that points at an npm `.cmd` shim now fails with
  an explanation and two ways out (name the real `.exe`, or wrap the call in
  `cmd /c`) instead of a bare `EINVAL` in the log (T-0086).
- A port reserved by the system (Windows keeps such ranges for Hyper-V and WSL) is
  skipped while searching for a free port instead of stopping the board — a port
  you asked for explicitly still fails loudly rather than moving somewhere else
  (T-0100).
- A board bound to a public address no longer prints a `localhost` URL that opens
  somebody else's board. On Windows a wildcard bind happily shares a port with
  another process holding `127.0.0.1` or `::1`, so the address the board printed
  as its own could answer with a different board — or with anything else listening
  there. A public bind now takes both loopback addresses itself, which also keeps
  them from being taken away afterwards, and skips a candidate port it cannot own
  while searching. When it cannot own one — a port you pinned explicitly, for
  instance — it warns and names the address that is taken and the one it does
  hold, rather than pointing at a fixed `127.0.0.1` (T-0127, T-0130, T-0132,
  T-0133, T-0135).

### Backlog format

`doc/backlog.md` gained the optional `- depends:` field (T-0087) and the optional
`- profile:` field that carries the run profile (T-0108); field names may
now contain digits, underscores and hyphens after the first letter (T-0097); the
leading-backslash escaping convention for description lines that look like fields
is documented in `agents/PROTOCOL.md` (T-0088); and the parser now preserves
fields it does not know instead of dropping them on the next write, so future
format extensions stop being destructive (T-0095).

Closed tasks may now live in a second file, `doc/backlog-archive.md`, written in
exactly the same format and read alongside `doc/backlog.md` by the board, by `show`
and by `validate` (T-0156). Whatever stands above the first task in either file — a
note to readers, a link, a heading of your own — is now given back verbatim on
every write; until now every write of every version replaced it with briefboard's
own default text and said nothing, and the guarantee is written down in
`agents/PROTOCOL.md` (T-0167, T-0176). `validate` gained checks you can lean on: a
`closed` date on every closed task and on no other, the accepted shapes of
`created` and `closed`, and an id that appears in both files at once (T-0170,
T-0156).

Compatibility, plainly: **upgrading is safe** — every file written by 0.1.x is
read by 0.2.0 unchanged. **Going back is not**, once a task has dependencies or a
run profile: 0.1.x reads such a file without complaining, but silently drops the
`- depends:` and `- profile:` lines the first time it writes, losing the
dependency graph with them. Do not run a 0.1.x copy against a backlog that 0.2.0
has been using. Once you have archived, that rule has teeth of its own: a 0.1.x
`add` counts only `doc/backlog.md` and will hand out an id the archive already
holds. `validate` reports such a duplicate on the next run, but nothing 0.2.0 does
can stop an older copy from creating it.

### Upgrading an existing project

Installing the new package is not enough: `briefboard init` copied `server/`,
`tools/`, `ui/` and `agents/` into your project, and the board runs that copy. Run
`briefboard update` to see what would change and `briefboard update --apply` to
receive it.

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
[0.2.0]: https://github.com/shinKatana0/briefboard/releases/tag/v0.2.0
[0.1.2]: https://github.com/shinKatana0/briefboard/releases/tag/v0.1.2
[0.1.1]: https://github.com/shinKatana0/briefboard/releases/tag/v0.1.1
[0.1.0]: https://keepachangelog.com/en/1.1.0/
