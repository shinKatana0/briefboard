#!/usr/bin/env node
'use strict';

/**
 * briefboard-init.mjs - `npx briefboard` / `briefboard init`.
 *
 * Copies the board's runtime files (server/, tools/, ui/, agents/, AGENTS.md,
 * CLAUDE.md) from the installed package into the current project directory,
 * and scaffolds an empty doc/backlog.md + doc/brief/ for that project.
 *
 * Idempotent: existing files/directories in the target project are never
 * overwritten - a rerun only fills in whatever is still missing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CWD = process.cwd();

// Top-level entries copied verbatim from the package into the target project.
// Each entry is skipped as a whole (with a warning) if it already exists at
// the destination, so a rerun never clobbers local edits.
const COPY_ENTRIES = ['server', 'tools', 'ui', 'agents', 'AGENTS.md', 'CLAUDE.md'];

function copyEntry(name) {
  const src = path.join(PKG_ROOT, name);
  const dest = path.join(CWD, name);
  if (!fs.existsSync(src)) {
    // AGENTS.md is optional depending on the package build - nothing to copy.
    return;
  }
  if (fs.existsSync(dest)) {
    console.warn(`skip existing: ${name}`);
    return;
  }
  fs.cpSync(src, dest, { recursive: true });
  console.log(`created: ${name}`);
}

function ensureBriefDir() {
  const briefDir = path.join(CWD, 'doc', 'brief');
  if (fs.existsSync(briefDir)) {
    console.warn('skip existing: doc/brief');
    return;
  }
  fs.mkdirSync(briefDir, { recursive: true });
  // Git does not track empty directories - keep it present with a placeholder.
  fs.writeFileSync(path.join(briefDir, '.gitkeep'), '');
  console.log('created: doc/brief');
}

function ensureBacklog() {
  const backlogPath = path.join(CWD, 'doc', 'backlog.md');
  if (fs.existsSync(backlogPath)) {
    console.warn('skip existing: doc/backlog.md');
    return;
  }
  // Use the package's own parser.js as the single source of truth for the
  // default preamble, instead of duplicating the string here.
  const { serializeBacklog } = require(path.join(PKG_ROOT, 'server', 'parser.js'));
  fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
  fs.writeFileSync(backlogPath, serializeBacklog([]));
  console.log('created: doc/backlog.md');
}

function init() {
  console.log(`briefboard init - installing into ${CWD}`);
  for (const name of COPY_ENTRIES) copyEntry(name);
  ensureBriefDir();
  ensureBacklog();
  console.log('');
  console.log('Done. Next steps:');
  console.log('  node server/server.js         # start the board at http://localhost:4571');
  console.log('  node tools/task.mjs add --type feature --priority Major --title "..."');
  console.log('  node tools/task.mjs list');
}

const cmd = process.argv[2];
if (cmd === undefined || cmd === 'init') {
  init();
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error('Usage: briefboard [init]');
  process.exit(1);
}
