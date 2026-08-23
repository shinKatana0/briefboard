# Contributing

Thanks for your interest in improving briefboard (formerly named `agentboard`).
This project runs its own work through the same task workflow it ships, so
contributions follow that process.

## Repository layout

`server/` (Node with no dependencies), `ui/index.html` (vanilla JS),
`tools/task.mjs` (CLI).

`AGENTS.md` and `CLAUDE.md` are shipped in the npm package and copied into a
user's project by `briefboard init`; this file is not. So anything true only of
this repository — the commands below, the dependency policy, the comment style —
belongs here, not there.

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
node tools/task.mjs add --type feature|bug|external --priority Major --title "..." --desc "..."
node tools/task.mjs show T-0007
node tools/task.mjs status T-0007 in_progress
node tools/task.mjs list --status ready
node tools/task.mjs validate
```

## Running the tests

Tests use the built-in Node.js test runner — no test framework to install:

```bash
npm test             # the full suite, compact output (needs Node >= 21, see below)
npm run test:verbose # the same suite with a line per test (spec reporter)
```

`npm test` reports progress as dots and prints the `tests/pass/fail` totals; a
failure still gets its file, test path, message, diff, stack and the file's own
stderr. A test that passed costs one character in the compact run and a line in
the verbose one, so a green run leaves about two orders of magnitude less to
read — which matters because coding agents pay for every line they read.

Measured 2026-08-17, one green run each, 2024 tests: 48 lines / ~600 tokens
compact against 2644 lines / ~49k tokens verbose, counting a token as four
characters. The absolute figures are dated because the suite grows and they grow
with it — the previous pair was taken at 759 tests and had gone stale by a
factor of two and a half (T-0257). The ratio is what they are quoted for, and
that one does not shrink.

### Measure a budget before you argue about it

Every deadline in `tests/helpers/` and `tools/test-run.mjs` was set from a
measurement, and measurements go stale because the machine and the suite both
move. `--timing-dir` takes them again:

```bash
node tools/test-run.mjs --timing-dir=/some/directory/outside/the/repository
```

It changes nothing about the run and does nothing without the flag. Each test
process writes what every bounded wait cost to `<dir>/<pid>.jsonl` — `fetch`,
`waitFor`, `waitForExit`, `waitUntilReady`, spawn to a board answering — and the
wrapper writes `<dir>/run-<pid>.json` with the run's wall time, the ten longest
stretches with no mark printed, and how long every test took. Keep the directory
outside the working copy, or the run's own dirty check will fail it, and rightly.

What settles an argument is a RATIO, never a threshold: run it once quiet and
once under load — four concurrent suites is the rig this repository argues about
— and compare how much the disputed operation grew against how much an operation
nobody disputes grew (starting a process; running one `git`). An operation
growing in step with those is the machine and there is nothing to fix; one
growing faster is a finding. Wall-clock on one machine is not comparable with
wall-clock on another, and not reliably with itself an hour later.

When something fails, re-run just the file it names:

```bash
node --test --test-reporter=spec tests/parser.test.js
```

Re-run only the file it names, never the whole suite verbosely.

Cover your changes with tests that match the brief's acceptance criteria, and
make sure the whole suite is green before moving a task to `review`.

Give the run a command of its own and keep its output in a file: chained with a
status change, the status lands before the result can be read (twice in one day).

### A test never writes into the repository

Everything a test writes lives in a directory it created under `os.tmpdir()`,
and that directory comes from `tempDir` in `tests/helpers/tmp.js` — never from
`fs.mkdtempSync` directly. The helper writes the path down and removes it in a
root `after()`, so the removal survives a test that failed or was cut off at
`--test-timeout`, which the last line of a test body does not (T-0258). Without
it the suite left its directories in `%TEMP%` for good: 118766 of them on one
machine, 114k from the eight files that removed nothing at all, in the same
`%TEMP%` this repository measures teardown and spawn latency in.
`tests/suite-hygiene.test.js` bans the raw call and `tests/temp-dirs.test.js`
holds the helper to the promise.

What lives in such a directory: project fixtures, and — when a test has to
change what the server serves — a throwaway copy of the install tree
(`makeInstallCopy` in `tests/server.test.js`).
Editing a repository file and restoring it in a `finally` is not good enough: a
run that dies never reaches the `finally`, the change stays in the working copy,
and the next run reads the polluted file as the "original" and restores *that* —
so the pollution sticks and rides into an unrelated commit (T-0111).

Both scripts enforce this, because both go through `tools/test-run.mjs`: it takes
`git status --porcelain` before and after the run and fails if the run added an
entry, naming it.

### A test may fail, but it may never hang

The suite hung forever three times in some thirty runs before this was written:
a worker at 0% CPU, its spawned server alive, and no test ever failing — a run
that in CI eats the whole job budget instead of reporting anything (T-0124). Two
habits caused it, and five rules keep it impossible:

- **Every test runs under a time limit.** `tools/test-run.mjs` passes
  `--test-timeout`, and both scripts go through it — the limit is defined in one
  place and no npm script calls `node --test` itself. It is far above the
  slowest honest test — measure before lowering it — and it is the backstop:
  whatever else is missed, a stuck test is failed at the limit.
- **A run that goes silent is killed.** Failing the test is not the same as
  ending the run. A test that hangs while holding the event loop open — a live
  timer, a server still listening — was reported failed at the limit and then
  left the process sitting there with no summary and no exit code (measured on
  Windows 11, T-0245). So the wrapper bounds the run from outside, and the
  budget it spends is silence rather than total time: every finished test prints
  a mark, while an honest whole run here takes anywhere from 285s idle to 1024s
  with three other suites on the same machine (measured 2026-08-17, 24 cores).
  Three times the per-test limit with
  nothing printed and it kills the process **tree** — killing the runner alone
  would leave the child it handed the test file to still running. The report of
  a killed run dies with it, so the message points at `npm run test:verbose`,
  whose last line before the silence is the test to look at.

  What that silence really bounds is not a slow test: node:test reports a file's
  results from that file's own process, so an uninterrupted run of SYNCHRONOUS
  tests prints nothing until it ends. Measured on three two-second tests, three
  `await`ed ones print their marks at 2.3s / 4.3s / 6.3s while three blocking
  ones print all four at 6.4s. Raising the budget is not the answer to a stretch
  that grows: it is the only guard against a test that holds the event loop open
  after its own end, which no per-test limit can catch.

  **A file whose tests block yields between them.** One `await` of a macrotask
  in a root `beforeEach` is the whole of it, and it lets each mark out as it
  happens instead of at the end of the stretch. `tests/task-cli.test.js` drives
  the CLI with `spawnSync` and was the whole of this suite's silence: measured
  quiet on 2514 tests (2026-08-23, Windows 11, node v24.18.0, 24 cores), the
  longest stretch with no mark printed was **176.6s before that hook and 8.1s
  after it** — 47% of the 360s budget against 2.3%, and 249-260s of it under
  four concurrent suites in the round before — with the run itself taking
  383s and 387s, the same time either way (T-0311). What is left is bounded by
  the slowest single test rather than by a whole `describe`, which is the bound
  such a file can have; the ten longest stretches after it sit within 7.0-8.1s
  of each other and no one file owns them. If you add a file of blocking tests,
  add the hook with it.

  Silence is counted from the run's first output, not from its spawn, and the
  span before that has a budget of its own (`BRIEFBOARD_STARTUP_MS`, against
  `BRIEFBOARD_SILENCE_MS` after it). What one budget over both spans really
  bounds is how fast this machine can start a process: measured 2026-08-17,
  spawn to first output cost 0.6s idle and up to 29.1s under four concurrent
  suites, and at 2000ms the wrapper killed healthy runs before `node --test` had
  printed a line (T-0266). A run killed before it spoke has no last line, so
  that kill says so instead of pointing at `test:verbose`.
- **A spawned server's stdout is read, or never piped.** An unread pipe fills,
  and a server blocked on writing to it stops answering every request. Spawn
  with `stdio: ['ignore', 'ignore', 'pipe']` when the output is not needed, or
  attach a `proc.stdout.on('data', ...)`.
- **No network call and no wait for a process is unbounded.** Take `fetch`,
  `waitUntilReady`, `waitForExit` and `stopProcess` from
  `tests/helpers/bounded.js` rather than the global `fetch` or a bare
  `proc.once('exit')`. A readiness loop must bound the *whole* loop: checking a
  deadline only between attempts means one stalled request disables the deadline
  and the race against an early exit at once.

- **A wait awaits the condition it was handed.** Take the wait itself from
  `tests/helpers/wait.js`; if a helper of your own has to decide whether to keep
  waiting by calling a function it was given, write `await` — `if (predicate())`
  reads an async predicate's promise as truthy and ends the wait on its first
  turn. Pouring the call into a variable first changes nothing and is checked
  the same way: `const value = predicate(); if (value)` is the same mine, and is
  how one copy stayed invisible to the guard for a day (T-0223). Nothing fails
  when that happens: the assertion after the wait runs
  against a condition that never arrived, and the request the predicate started
  is left for the teardown to reset, which surfaces as `read ECONNRESET` blamed
  on the board (T-0183 — three cards of investigation).

`tests/suite-hygiene.test.js` asserts the last three by reading the test sources,
and `tests/test-run.test.js` asserts the first two by running a deliberately
hanging test under the real entry point.

A guard that needs a list of exemptions is a dead guard: assert the *shape* of
the mistake, which needs no exemption and holds for next year's copy (T-0189).

### A run that executed nothing is not a pass

Measured on an unpacked tarball of 0.2.0: `tests/` is not published with the
package, so the glob matched no file, node's own runner printed `pass 0` and
exited 0 — a green run that ran nothing, which is the failure this suite is
otherwise built against (T-0250). So the wrapper counts what the run executed
and fails when that is zero, or when no count came back at all.

The count arrives out of band, on a second reporter of ours writing to a file,
because the wrapper has to work with whichever reporter it was handed and each
formats its totals its own way. A clone always has `tests/`, so meeting this
failure here means the patterns you passed matched nothing — the message
names them.

### A test brings its own environment

The board spawns a worker session with the environment inherited, so a board
configured with `BRIEFBOARD_SESSION_CMD` hands it to every session it starts.
Ten tests that assert the shipped defaults — sessions are off until configured —
failed inside such a session while the same tree was green outside it, and the
worker reported the tree as broken (T-0119). Nothing about the tree was.

So the suite defines its own environment. `tests/helpers/env.js` deletes every
variable the product reads (`AGENTBOARD_ROOT`, `PORT`, `HOST` and the whole
`BRIEFBOARD_*` set), and every test file requires it **first**:

```js
require('./helpers/env.js');
const { describe, it } = require('node:test');
```

First, not merely near the top: `server/parser.js` reads
`BRIEFBOARD_LOCK_TIMEOUT_MS` once at load, so a neutralisation that lands after
that require neutralises nothing. A test needing a value sets it itself, below
that line, and the children it spawns inherit the cleaned environment along with
everything else.

`tests/suite-hygiene.test.js` asserts the line is present and first in every test
file. `tests/hermetic-env.test.js` runs throwaway fixture suites under a
deliberately polluted environment and asserts both that they see none of it and
that the very same fixture fails when the order is wrong. It also compares
`PRODUCT_ENV_VARS` against what `server/`, `tools/` and `bin/` really read — a
new variable in the product has to be added to that list.

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

## Briefs and dispatch prompts

The rules themselves hold for any project, so they live in the shipped protocol,
not here: `agents/ORCHESTRATOR.md` — what a dispatch prompt carries and what it
must not restate (§4), anchors instead of line numbers and what a brief may never
lose (§3), batching trivial findings into one task (§1).

Two things about them are ours. The anchors those briefs point at are our code —
the `.col.drag-available` rule, the `attachOpenDropZone` function, the
`SESSION_QUESTIONS_HEADING` constant — and pointing at `ui/index.html:172`
instead went stale several times in a single day here, which is where the rule
comes from. And the test count a prompt quotes is read from `npm test` on `main`
(the `# pass N` line of its summary) right before the dispatch: a worker given a
stale number spends its run debugging a failure it did not cause.

## Comments

Few, and only where they carry what the code cannot show — a non-obvious
decision and its reason, or a measured fact (benchmark, observed platform
behaviour, the incident that shaped the code). Never restate in prose what the
next line already says. Comments and GitHub-facing docs are English. This
applies to existing code too: when a task takes you into a file, strip the
narration already there. Keep that cleanup in its own commit, separate from the
task's own change, so a reviewer can still read the real diff. Files the task
does not touch are left alone — no repo-wide sweeps.

## Documentation: English in the task, translations at release

A task updates **only the English documents** — `README.md` and
`doc/guide/guide.en.md`. `README.ru.md`, `README.ja.md`, `doc/guide/guide.ru.md`
and `doc/guide/guide.ja.md` are not touched in tasks; they are brought in line
with English in a single pass per release, as a mandatory step of the
maintainer's release checklist (`RELEASING.md`, kept in the development repo).

Writing the same meaning three times in every task is most of what separates a
documentation task (150–274k tokens) from a purely code one (53–98k, measured
2026-08-14), and it drifts the terminology: each worker retranslates the same
concepts its own way. One pass over everything accumulated is cheaper and comes
out consistent.

**Interface strings (i18n) are not covered by this rule.** They are part of the
product, not of the documentation, and are translated in the same task as the
feature they belong to. Nobody should have to wait for a release to stop seeing
an English button in a Russian interface.

The cost accepted knowingly: between a task and a release the translated docs
lag behind English. Each of them says so in its header, so a reader learns it
from the document rather than from the discrepancy, and the release checklist is
what guarantees the lag ends.

## Requirements

- Node.js >= 21 (the `npm test` glob only expands correctly from Node 21.0.0; see
  task T-0041 in the backlog for the empirical detail).
