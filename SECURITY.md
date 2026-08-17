# Security Policy

## Supported versions

The project is pre-1.0. Only the latest released version (currently the `0.1.x`
line) receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1.0 | No        |

## Network model

By default the server binds to `127.0.0.1` (loopback) and is reachable only from
the local machine. A public bind is **opt-in** via the `HOST` / `AGENTBOARD_HOST`
environment variables; when a non-loopback host is used the server prints a
warning, because the board can read the backlog and also write to it (create a
task, cancel it, move it to open) without any authentication. Only
expose it on a trusted network, and prefer a reverse proxy with authentication if
you must reach it remotely.

Binding to loopback is not by itself enough, because the browser on your machine
is inside that boundary. A site you visit can re-point its own domain at
`127.0.0.1` (DNS rebinding) and then talk to the board with a `Host` and an
`Origin` that agree — both naming the attacker's domain — so a check that only
compares those two headers with each other passes. So on a loopback bind the
server compares `Host` with the address it actually bound and refuses anything
else with `403`, on reads as well as writes. Behind a reverse proxy that forwards
the browser's `Host` instead of rewriting it to the upstream, name it in
`BRIEFBOARD_ALLOWED_HOSTS` (comma-separated); the `403` names the variable.

Under a public bind that check is off. It would be a guard in name only: the
board is already reachable by name from the network without authentication, and
the names the machine answers to cannot be known here. The start-up `WARNING`
says so along with the rest.

## Stopping the board from the UI

`POST /api/shutdown` ends the server process — that is what the `⏻` button in the
header calls. It is guarded twice: by the same CSRF check as the other writing
endpoints (so a page open in your browser cannot stop your board), and by the
address of the caller — the connection has to come from loopback (`127.0.0.0/8`
or `::1`). Under a public bind that second check is what keeps anyone on the
network from stopping your board with a single request. The endpoint writes
nothing: it answers `200`, tells the open tabs, kills the agent sessions and
exits.

## Agent sessions

The board can start an agent session when a task is dragged into Open. That
means an unauthenticated local HTTP endpoint is allowed to run a command, so the
feature is **off unless you turn it on**: nothing is spawned until you set
`BRIEFBOARD_SESSION_CMD`, and there is no default command.

When it is on:

- the command comes only from that environment variable — a request can never
  supply, extend or override it, and contributes nothing but the task id;
- the template is split into argv by the server and run without a shell, with
  `{id}` substituted after the split, so the id cannot add arguments;
- sessions are refused entirely when the server is not bound to loopback (the
  server warns about it at start-up), because a network-reachable endpoint that
  runs a configured command is remote code execution;
- sessions run with the served project as their working directory, inherit the
  server's environment, and act with your permissions — enable this only with a
  command you would run yourself, and only on a project you trust.

An **isolated** session runs in its own git worktree (`.briefboard/worktrees/`)
on its own `task/T-NNNN` branch instead of the served project directory. The
shared checkout is left as it was: `git worktree add` is the only git command the
server ever runs there, and it moves neither HEAD nor the current branch. If that
worktree cannot be prepared the session is refused with a reason and does not
start — it is never run in the shared checkout instead. The worktree is not
removed afterwards; deleting it is a manual step.

## What the board trusts on its own machine

Besides the session command you configure, the board runs a few programs of its
own: `powershell` (or `ps`) to read the process table, `taskkill` to end a
session's tree on Windows, and `git` to prepare an isolated session's worktree.
All of them are spawned **by name**, without a shell, and are found through the
`PATH` the board inherits — the board does not pin them to system directories.

That is a deliberate boundary, not an oversight. Putting an executable of your
own earlier in the `PATH` of the account the board runs under already means
running code as that account, before briefboard is involved at all: `node`, `npm`
and the agent command itself are found exactly the same way, and the board is
started by them. A pin would also be partial by nature — `taskkill` and
`powershell` live in predictable places on Windows, while `git` and `ps` are
installed wherever the user put them — so it would protect the two commands that
matter least and imply a protection that does not exist for the rest.

So the rule is the same one that governs sessions: **the board trusts its own
machine and the account it runs as.** On a machine where that is not true,
nothing here is the first thing to worry about.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's **Security** tab). Do not open a
public issue for a security problem before it has been addressed.

Please include steps to reproduce, the affected version, and the impact you
observed. We aim to acknowledge reports promptly and will coordinate a fix and
disclosure timeline with you.
