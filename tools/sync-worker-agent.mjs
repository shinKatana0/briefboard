#!/usr/bin/env node
'use strict';

/**
 * sync-worker-agent.mjs - rebuild .claude/agents/worker.md from agents/WORKER.md.
 *
 *   node tools/sync-worker-agent.mjs           # write the file
 *   node tools/sync-worker-agent.mjs --check   # fail if it is out of date, write nothing
 *
 * The Claude Code subagent definition is the same protocol with two things
 * around it that have no place in agents/WORKER.md: the frontmatter Claude Code
 * dispatches on, and a tail about being a subagent. They live here, so the
 * protocol itself has exactly one source (T-0113/T-0175) and nobody has to
 * reassemble the copy by hand.
 *
 * A development tool for this repository, not part of the product: `files` in
 * package.json lists tools/ entries by name, so this one is not packed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'agents/WORKER.md';
const TARGET = '.claude/agents/worker.md';

const FRONTMATTER = `---
name: worker
description: Implements tasks from doc/backlog.md per briefs. MUST BE USED for any code implementation of a T-NNNN task — writing code, bug fixes, tests. Not used for task refinement, briefs, or review.
---`;

const TAIL = `## Environment context
You are launched as a subagent, already inside your own git worktree — the
orchestrator passes \`isolation: "worktree"\` at launch. Do not call EnterWorktree;
confirm your location per step 0 and rename your branch if you need to.

The orchestrator passed you the task id in the task text, and the path to the
shared checkout it dispatched you from — that path is what every
\`AGENTBOARD_ROOT=...\` in step 1 refers to. If it is missing from your task text,
ask for it rather than guessing.

On completion, return a short report: branch, what was done, how to verify. If you
end on questions instead (step 4), write them into the backlog all the same — the
reply and the card are read by different people at different times — and name them
in the report too.`;

/** The subagent file as it must look, given the protocol body. */
export function renderWorkerAgent(workerDoc) {
  const body = workerDoc.replace(/\r\n/g, '\n').trimEnd();
  const text = `${FRONTMATTER}\n${body}\n\n${TAIL}\n`;
  // The checkout is CRLF on Windows (core.autocrlf) and LF elsewhere; following
  // the source keeps the rewrite byte-stable instead of touching every line.
  return workerDoc.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

export function syncWorkerAgent(root, { check = false } = {}) {
  const target = path.join(root, TARGET);
  const wanted = renderWorkerAgent(fs.readFileSync(path.join(root, SOURCE), 'utf8'));
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (current === wanted) return { changed: false };
  if (check) return { changed: true };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, wanted);
  return { changed: true };
}

function flag(name) {
  return process.argv.includes('--' + name);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const check = flag('check');
  const { changed } = syncWorkerAgent(root, { check });
  if (!changed) {
    console.log(`${TARGET} is up to date with ${SOURCE}`);
    return;
  }
  if (check) {
    console.error(`${TARGET} is out of date with ${SOURCE} — run: npm run sync:worker-agent`);
    process.exit(1);
  }
  console.log(`${TARGET} rebuilt from ${SOURCE}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
