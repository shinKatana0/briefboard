# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-23

briefboard can now be driven by something above it. A scope of work can be
asked about — `list --label` selects the tasks carrying labels of your own — and
the answer can be read by a program: `--json` prints one document on stdout and
nothing else. Two questions a supervisor used to guess at from listing output
have commands of their own: `runnable` says what may be started right now, and
`summary` says how much of a scope is left and whether it is finished. Nothing
outside briefboard has to parse `doc/backlog.md` to find out. Beside that, two
changes that serve people rather than machines: a task's priority can be
corrected after it was filed, and the review session's variable stops calling
itself the orchestrator.

**No call that was correct in 0.4.0 behaves differently in 0.5.0.** Everything
below is either a new subcommand or a new flag, and the refusals introduced —
`--all` on `runnable` and `summary`, `--status` on `summary`, a `--label` set
over the cap — are all on commands and flags that did not exist before this
release.

### Added

- **`list --label` — ask which tasks belong to a scope.** One occurrence is a
  comma-separated set the task must carry any name of, and `--label` is the one
  repeatable flag in this CLI: every occurrence has to match, so
  `--label a,b --label c` is `(a OR b) AND c`. It combines with `--status` and
  `--all` as AND. **The CLI is AND across repeated flags while the board's
  `Labels ▾` filter is OR** — both deliberate, and each form's own "either" is
  one comma away — so the difference is worth knowing before you meet it as a
  surprisingly short list. A label nothing carries is not an error: an empty
  result and exit `0`. What exits non-zero is a call naming no label at all
  (`--label ""`, `--label ,`, `--label` with nothing after it), so a script can
  tell "no such task" from "I typed it wrong" by the exit code alone (T-0303).
- **A `--label` set that would be truncated is refused rather than answered.**
  One occurrence holds at most 8 names — the same number a task's own label list
  may carry — and a ninth is refused with the usage line and a non-zero exit. A
  truncated set would answer with *fewer* tasks and exit `0`, which is the one
  shape of wrong answer a script cannot detect. The cap is per occurrence, so a
  longer query is still expressible by repeating the flag (T-0309).
- **`list --json` — the same answer, for a program.** One JSON document
  `{tasks, count}` on stdout and nothing else; everything `list` has to say goes
  to stderr, so stdout can be piped into a parser whole. The field names are the
  ones the product already uses — `show` prints a task under exactly these
  names, and `blockedBy` is what `GET /api/board` has called the unclosed
  prerequisites since dependencies existed. Descriptions are deliberately left
  out of a listing; read one task with `show` (T-0303).
- **`runnable` — what can be started right now.** `list` narrowed to status
  `ready` with every prerequisite closed, decided by the same rule the board's
  blocked marker, the drag from Ready into In Progress and the
  `status … in_progress` gate all apply — there is no second definition of
  "startable" to disagree with them. `--label` and `--json` mean what they mean
  for `list`, and `--json` prints `list --json`'s own document, task for task and
  field for field. `--status` can only narrow the set, so
  `runnable --status review` is empty with exit `0` rather than an error;
  `--all` is refused, because the archive holds closed tasks and nothing closed
  is `ready` (T-0304).
- **`summary` — how much of a scope is left.** One document: a count for every
  status briefboard has (so they sum to `total`), `blocked` as a cross-cutting
  count of the tasks waiting on a prerequisite, the `runnable` ids, `complete`,
  and a `scope` echoing the query — `labels` as one array per `--label`
  occurrence beside a `labelQuery` rendering it, so a stored answer says what it
  was an answer to. It counts `doc/backlog.md` and the archive together, always:
  a finished scope is precisely the one `archive` has emptied out of the live
  file, and reading the live file alone printed for it exactly what a mistyped
  label prints. An empty scope is deliberately **not** complete, so a dropped
  hyphen cannot read as a finished phase. `--status` and `--all` are both
  refused: a summary *is* the count per status, and the archive is already in
  scope (T-0304, T-0310).
- **What `--json` promises**, on all three of them: a field that exists keeps
  its name, its type and its meaning; new fields may appear in any release; a
  consumer ignores what it does not recognise. That is what makes adding a field
  a non-event rather than a breaking change, and it is the reason an integrator
  can build on this at all (T-0304).
- **`complete` is a statement about briefboard's own tasks and nothing else.**
  It is not acceptance of a phase, a release or a milestone: briefboard knows
  nothing about any external project's vocabulary and counts the cards in
  `doc/backlog.md` carrying the labels you named. What a finished scope entitles
  you to conclude is decided by whoever integrates this; the CLI does not decide
  it (T-0304, T-0310).
- **`priority` — re-triage a task after it was filed.** The same five values
  `add --priority` takes, with no graph and no `--force`: any priority may follow
  any other. A change appends one line under a `### Priority changes` heading
  naming the old value, the new one and when it moved, because a card that
  silently became `Critical` reads a week later as though it always was. Setting
  the value it already has writes nothing at all. Until now this was the one
  field that could be set only at creation, so correcting it meant editing
  `doc/backlog.md` by hand, on the line the parser is strictest about (T-0302).

### Changed

- **The review session's command template is `BRIEFBOARD_REVIEW_CMD`.**
  `BRIEFBOARD_ORCHESTRATOR_CMD` is the earlier name of the same setting, it is
  still read, nothing warns about it and it is **not** deprecated — a board
  configured with it goes on working untouched; with both set,
  `BRIEFBOARD_REVIEW_CMD` wins. The old name claimed something untrue: the
  session it starts reads a diff, runs the checks and writes a verdict, setting
  no status and merging nothing, while an *orchestrator* is whatever agent sits
  above briefboard in your own project — which briefboard neither knows nor needs
  to know about. Both READMEs and all three guides now name the four roles
  (the board, the worker, the review session, your own orchestrator) in one
  place (T-0305).

### Upgrading an existing project

Installing the new package is not enough: `briefboard init` copied `server/`,
`tools/`, `ui/` and `agents/` into your project, and the board runs that copy. Run
`briefboard update` to see what would change and `briefboard update --apply` to
receive it.

## [0.4.0] - 2026-08-22

Connecting the board to a project that **already exists** now works. `init` fills
a directory it collides with file by file instead of skipping it whole, so a
project with its own `tools/` finally gets `tools/task.mjs` instead of a success
message and no CLI. A `CLAUDE.md` or `AGENTS.md` that is already there is enriched
with a block between `<!-- briefboard:start -->` and `<!-- briefboard:end -->`
rather than skipped or replaced. And what was already yours stays yours: `update`
no longer replaces a file it cannot show it installed, and `serve` no longer runs
one of them as the board.

### Added

- **`init` merges into a directory it collides with, instead of skipping it
  whole.** A project with its own `tools/` or `agents/` used to get
  `skip existing: tools`, no `tools/task.mjs`, and a run that called that a
  success — the CLI the whole protocol is written around was never installed.
  Every file is now considered on its own: what is missing is created, what is
  already there is kept and named, and the summary says which of the two happened
  to each. When the file that got kept is genuinely yours, the next-steps block
  stops printing the command that would run it — `node tools/task.mjs ...`,
  `node server/server.js` — and says why (T-0294).
- **An existing `CLAUDE.md` / `AGENTS.md` is enriched, not skipped and not
  replaced.** briefboard appends its protocol between `<!-- briefboard:start -->`
  and `<!-- briefboard:end -->` — HTML comments, so nothing renders — and writes
  only between them — not with `--apply`, not with `--force`, not ever. Everything
  above and below stays byte for byte what you wrote, `init` inserts the block once
  and never rewrites it, and `update` refreshes the inside of it and nothing else
  (T-0294).
- `update` gained two categories for that block. `block removed` is a file whose
  block you deleted: it is **not** re-added unless you pass `--force`.
  `markers malformed` is a start with no end, or two starts — and that one is
  **never touched, `--force` included**, because where the block ends cannot be
  guessed without risking your own text (T-0294).

### Changed

- **`update --apply` no longer replaces a file the manifest does not list.** Such
  a file is reported as `unknown provenance` and now needs `--force`; until now
  `--apply` replaced it after a backup. That is how the only documented repair for
  a half-installed project could overwrite a `CLAUDE.md` briefboard had never
  written. Nothing else moved: a file the manifest does list behaves exactly as
  before, `MODIFIED LOCALLY` still needs `--force` as it always did, and a project
  with no manifest at all is still `no manifest` and still replaced after a backup
  (T-0294).
- **`briefboard serve` no longer runs a `server/server.js` it cannot vouch for.**
  It used to load the project's copy whenever the file merely existed, announce it
  as `(this project's copy)` and execute it — and now that `init` merges per file,
  that path can hold somebody else's script, run as the board without a word. It
  runs the project's file when the manifest lists it or it is byte-identical to the
  package; when a manifest is there and does not list it, the packaged board starts
  instead and the declined file is named with the reason. A project with no
  manifest at all is unaffected — with no record briefboard can neither vouch nor
  condemn, and a pre-0.2.0 install has been running that copy all along (T-0295,
  T-0299).

### Fixed

- A marker inside a fenced code block is not a marker. A `CLAUDE.md` that merely
  *showed* what the block looks like — the snippet this project's own guide prints,
  copied into your notes — was read as a file that already had one: `init` reported
  the briefboard block as already there, skipped the file, and the protocol text
  never arrived (T-0298).
- A second `init` on a healthy install no longer reports every briefboard file as
  yours. The rerun listed every runtime file under "briefboard did NOT install its
  own versions of them" and told you the task CLI was not installed, on a project
  where briefboard had installed all of it: a file briefboard itself wrote is not a
  collision (T-0299).
- `update --apply` no longer writes over a damaged `.briefboard/installed.json`.
  Installing any file that was new in the package rewrote the record as a side
  effect, destroying the very file the warning tells you to repair and replacing
  the install history with one written from a run that could read none of it. The
  new file is still installed; nothing is recorded, and the run says so (T-0297).

### Upgrading an existing project

Installing the new package is not enough: `briefboard init` copied `server/`,
`tools/`, `ui/` and `agents/` into your project, and the board runs that copy. Run
`briefboard update` to see what would change and `briefboard update --apply` to
receive it.

This release is the one that most needs it, and least reaches you without it: if
the old `init` left your project half-installed and you finished the job by hand,
read the plan before applying it. The files you placed yourself are not in the
manifest, so they now come up as `unknown provenance` and are left alone rather
than replaced.

## [0.3.0] - 2026-08-18

A task can now carry labels of your own, and the board can be read by them: chips
on the card, an editor in the task's dialog, a `Labels ▾` filter in the header,
the same search box that finds titles finding labels too, and a column of them in
the Excel export — with the label settable in the very command that files the
card. Around that, the CLI stops answering silently where it used to: a wrong
`--type` is refused instead of defaulted, a refusal about a wrong call prints the
usage line that fixes it, `validate` reports a brief file nobody links and two
files answering to one id, and a brief written by hand can be attached with `link`
instead of by editing the backlog.

### Added

- **Labels: your own classification of a task.** They appear as chips on the card
  under its title, are added and removed in the card's dialog, and a `Labels ▾`
  multi-select filter in the header keeps the tasks carrying any of them. The
  free-text search matches them alongside the title and the description, so typing
  `docs` finds the labelled tasks without opening the filter, and the Excel export
  gets a column of its own. From the command line it is
  `node tools/task.mjs labels T-0007 ui,docs` (the whole list in ONE
  comma-separated argument, replacing the previous one, like `depends`) and
  `--clear` to empty it; over HTTP it is `POST /api/task/:id/labels`. Nothing
  declares a label: it exists while some task carries it, creating one is typing a
  name nobody has used yet, and the last task dropping it is what makes it
  disappear. A name is trimmed, at most 32 characters, and may hold anything but a
  comma; a task carries at most 8, and names are compared as written, so `ui` and
  `UI` are two labels (T-0279).
- A task can be filed already carrying its labels, in one command instead of two:
  `add --labels "ui, docs"`, a `labels` key on `POST /api/task`, and a field in the
  board's **+** form beside the title and the priority. That is for the project
  whose convention is that every task carries a label — a rule kept by a second
  command is a rule that drifts (T-0282).
- `node tools/task.mjs link T-0007-01` puts a brief file that **already exists**
  onto its task's `briefs` field — one written by hand, recovered, or brought in
  from elsewhere. It refuses an id no file in `doc/brief/` answers to, so it cannot
  point at nothing, and a second run adds no duplicate. This is the way out of "the
  file is on disk and the task does not know it" without editing `doc/backlog.md`
  by hand — which is what the CLI exists to make unnecessary, and what an agent in
  an isolated worktree cannot do at all (T-0267).
- `tools/screenshot.mjs` can photograph what exists only after an interaction:
  `--eval "openTask('T-0007')"` runs a snippet in the page once the board has
  drawn, and `--click "#label-filter-btn"` does the same for the common case of one
  click, so a task dialog, the label popover or the new-task form can be captured
  too. A snippet that throws, matches nothing, or leaves the page unchanged fails
  the run and keeps no png — the picture you get back is never of an undisturbed
  board (T-0281).

### Changed

- **`add` refuses a `--type` or `--priority` outside its list instead of writing
  the default.** `add --title X --type nonsense` used to exit `0` and file a
  `feature`; it now exits `1` naming the legal values, and nothing is written — no
  id is allocated and the backlog is untouched. If a script of yours relied on a
  wrong value being quietly corrected, it will now fail where it used to succeed;
  omitting the flag altogether still defaults to `feature` / `Medium` and is not an
  error anywhere (T-0286).
- A refusal about a wrong call prints the usage line for that subcommand, so the
  message that stops you also carries the call that works (T-0273, T-0284).
- A brief file is resolved only under `.md`. `T-0001-01-old.md.bak` no longer
  shadows `T-0001-01-real.md`, which is how the board and the CLI could disagree
  about what a brief said (T-0283).

### Fixed

- **`brief` no longer overwrites an existing brief file.** When the name it
  computed landed on a file somebody had already written, the template silently
  replaced its content — no backup, no prompt, no message, and two written briefs
  were lost that way. It now refuses and writes nothing at all; `link` above is how
  that file gets onto its task (T-0264).
- `validate` reports a brief file that no task links, and two files answering to
  one brief id — the second is what used to leave the board showing whichever of
  them the directory listing happened to return first (T-0268, T-0275).
- `brief` with no arguments names the missing argument instead of reporting
  `task undefined not found` (T-0269).
- `tools/screenshot.mjs` refuses in one line when the browser cannot be started,
  instead of failing with an unhandled error and a stack (T-0288).
- A session whose process tree the board could not record now says so on its card.
  Until now that reached the session log only, so the card of a session whose
  leftovers nothing can clean up for you looked exactly like any other (T-0242).
- The tools stop leaving temporary directories in `%TEMP%`: `tools/test-run.mjs`
  creates none at all any more, so no kill can leave one behind, and
  `tools/screenshot.mjs` removes its Chrome profile on every exit path a process
  can act on — a hard kill remains the one case it cannot cover, and the code says
  so (T-0265, T-0276).

### Backlog format

A task may now carry a `- labels:` line, written only while its list is non-empty.
The line is a new field, and `agents/PROTOCOL.md` requires unknown fields to be
preserved, so a backlog written by 0.3.0 is still read by 0.2.0 — the labels are
simply not shown there. Going back further than that carries the warnings the
0.2.0 entry already gives about `- depends:` and `- profile:`.

### Upgrading an existing project

Installing the new package is not enough: `briefboard init` copied `server/`,
`tools/`, `ui/` and `agents/` into your project, and the board runs that copy. Run
`briefboard update` to see what would change and `briefboard update --apply` to
receive it.

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
