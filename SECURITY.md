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
warning, because the board can both read the backlog and cancel tasks. Only
expose it on a trusted network, and prefer a reverse proxy with authentication if
you must reach it remotely.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's **Security** tab). Do not open a
public issue for a security problem before it has been addressed.

Please include steps to reproduce, the affected version, and the impact you
observed. We aim to acknowledge reports promptly and will coordinate a fix and
disclosure timeline with you.
