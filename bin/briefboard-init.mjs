#!/usr/bin/env node
'use strict';

/**
 * briefboard-init.mjs - the `briefboard` CLI: `init`, `update` and `serve`.
 *
 * init   copies the board's runtime files (server/, tools/, ui/, agents/,
 *        AGENTS.md, CLAUDE.md) into the current project and scaffolds
 *        doc/backlog.md + doc/brief/. Existing files are never overwritten.
 * update brings an already installed project up to the package's version.
 * serve  starts the board for the current directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CWD = process.cwd();

// Top-level entries copied verbatim from the package into the target project.
// Each entry is skipped as a whole (with a warning) if it already exists at
// the destination, so a rerun never clobbers local edits.
const COPY_ENTRIES = ['server', 'tools', 'ui', 'agents', 'AGENTS.md', 'CLAUDE.md'];

const MANIFEST_REL = '.briefboard/installed.json';
// The release that started writing the manifest (T-0094): anything installed
// earlier has none, and that is a fact about the version, not about the files.
const MANIFEST_SINCE = '0.2.0';

// `doc/` is the user's own data (backlog, briefs). No command may write there,
// so every path the updater is about to touch is checked against this, not just
// assumed safe because COPY_ENTRIES happens not to list `doc`.
function assertRuntimePath(rel) {
  const first = rel.split('/')[0];
  if (!COPY_ENTRIES.includes(first)) throw new Error(`refusing to write outside the runtime files: ${rel}`);
}

function packageVersion() {
  return require(path.join(PKG_ROOT, 'package.json')).version;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function collectFiles(absolute, rel, out) {
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    out.push(rel);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const name of fs.readdirSync(absolute).sort()) {
    collectFiles(path.join(absolute, name), `${rel}/${name}`, out);
  }
  return out;
}

/** Every runtime file shipped in this package, as relative POSIX paths. */
function packageFiles() {
  const out = [];
  for (const name of COPY_ENTRIES) {
    const src = path.join(PKG_ROOT, name);
    if (!fs.existsSync(src)) continue;
    collectFiles(src, name, out);
  }
  return out;
}

function manifestPath() {
  return path.join(CWD, ...MANIFEST_REL.split('/'));
}

/**
 * The install manifest as { manifest, problem }: `manifest` is null when there is
 * none, and `problem` then says whether that is because the file is absent (null)
 * or because it is there and unreadable. Both used to come back as a bare null,
 * which made a damaged manifest look exactly like a pre-0.2.0 install (T-0158).
 */
function readManifest() {
  const file = manifestPath();
  if (!fs.existsSync(file)) return { manifest: null, problem: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { manifest: null, problem: `could not be read: ${e.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
    return { manifest: null, problem: 'is not an install manifest: it has no "files" object' };
  }
  return { manifest: parsed, problem: null };
}

// A damaged manifest is still conservative in its effect - provenance becomes
// unknown and every file is backed up before it is replaced - but it is said out
// loud, because on the outside it looked identical to having no manifest at all,
// and the two are fixed by different things.
function reportManifestProblem(problem) {
  if (!problem) return;
  console.warn(`WARNING: ${MANIFEST_REL} ${problem}`);
  console.warn(`  The file is there, so this is not an install predating ${MANIFEST_SINCE}: the record exists`);
  console.warn('  and cannot be read, so nothing about this project\'s copy can be vouched for. Nothing has');
  console.warn('  been repaired or removed - repair the JSON to get the exact categories back, or let');
  console.warn('  "briefboard update --apply" reinstall the runtime files and write the manifest anew.');
}

function writeManifest(files) {
  const file = manifestPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const manifest = { version: packageVersion(), updatedAt: new Date().toISOString(), files };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// ---------- init ----------

function copyEntry(name) {
  const src = path.join(PKG_ROOT, name);
  const dest = path.join(CWD, name);
  if (!fs.existsSync(src)) {
    // AGENTS.md is optional depending on the package build - nothing to copy.
    return false;
  }
  if (fs.existsSync(dest)) {
    console.warn(`skip existing: ${name}`);
    return false;
  }
  fs.cpSync(src, dest, { recursive: true });
  console.log(`created: ${name}`);
  return true;
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

// Only the entries this run actually copied are recorded. Hashing a file that
// was skipped as existing would claim briefboard put it there, and `update`
// would then read a user's own file as safe to overwrite.
function recordInstall(createdEntries) {
  if (createdEntries.size === 0) return;
  const { manifest: previous, problem } = readManifest();
  // A manifest we could not read is the user's data, and writing over it would
  // replace a record we never understood with one listing this run alone
  // (T-0188). `update` and `--version` already refuse to touch it silently.
  if (problem) {
    reportManifestProblem(problem);
    console.warn('  This run therefore recorded nothing: the files it just created stay unlisted, which');
    console.warn('  "briefboard update" reports as unknown provenance and backs up before replacing.');
    return;
  }
  const files = { ...(previous ? previous.files : {}) };
  for (const rel of packageFiles()) {
    if (!createdEntries.has(rel.split('/')[0])) continue;
    const dest = path.join(CWD, rel);
    if (fs.existsSync(dest)) files[rel] = hashFile(dest);
  }
  writeManifest(files);
  console.log(`created: ${MANIFEST_REL}`);
}

function init() {
  console.log(`briefboard init - installing into ${CWD}`);
  const created = new Set();
  for (const name of COPY_ENTRIES) {
    if (copyEntry(name)) created.add(name);
  }
  ensureBriefDir();
  ensureBacklog();
  recordInstall(created);
  console.log('');
  console.log('Done. Next steps:');
  console.log('  briefboard serve              # start the board at http://localhost:4571');
  console.log('  node server/server.js         # the same board, started directly');
  console.log('  node tools/task.mjs add --type feature --priority Major --title "..."');
  console.log('  node tools/task.mjs list');
  console.log('  briefboard update             # later: bring this copy up to a newer package');
}

// ---------- update ----------

const UP_TO_DATE = 'up to date';
const OUTDATED = 'outdated';
const MODIFIED = 'MODIFIED LOCALLY';
const UNKNOWN = 'unknown provenance';
const NO_MANIFEST = 'no manifest';
const MISSING = 'new in package';
const CATEGORIES = [UP_TO_DATE, OUTDATED, MODIFIED, UNKNOWN, NO_MANIFEST, MISSING];

// Two situations produce a file we cannot vouch for, and they read differently:
// with no manifest at all the cause is known and harmless (a pre-0.2.0 install),
// while a file missing from a manifest that exists really is of unknown origin.
function classify(manifest, preManifest) {
  const unvouched = preManifest ? NO_MANIFEST : UNKNOWN;
  const entries = [];
  for (const rel of packageFiles()) {
    const packageHash = hashFile(path.join(PKG_ROOT, rel));
    const dest = path.join(CWD, rel);
    if (!fs.existsSync(dest)) {
      entries.push({ rel, packageHash, category: MISSING });
      continue;
    }
    const current = hashFile(dest);
    if (current === packageHash) {
      entries.push({ rel, packageHash, category: UP_TO_DATE });
      continue;
    }
    const installed = manifest ? manifest.files[rel] : undefined;
    if (installed === undefined) entries.push({ rel, packageHash, category: unvouched });
    else if (installed === current) entries.push({ rel, packageHash, category: OUTDATED });
    else entries.push({ rel, packageHash, category: MODIFIED });
  }
  return entries;
}

function isReplaceable(entry, force) {
  if (entry.category === UP_TO_DATE) return false;
  if (entry.category === MODIFIED) return force;
  return true;
}

function backupAndReplace(targets) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(CWD, '.briefboard', 'backup', stamp);
  let backedUp = 0;
  for (const entry of targets) {
    assertRuntimePath(entry.rel);
    const dest = path.join(CWD, entry.rel);
    if (fs.existsSync(dest)) {
      const copy = path.join(backupDir, ...entry.rel.split('/'));
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.copyFileSync(dest, copy);
      backedUp++;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(PKG_ROOT, entry.rel), dest);
    console.log(`updated: ${entry.rel}`);
  }
  return { backupDir, backedUp };
}

function update({ apply, force }) {
  if (path.resolve(PKG_ROOT) === path.resolve(CWD)) {
    console.log('briefboard update - this directory IS the briefboard package; nothing to update');
    return;
  }
  const { manifest, problem } = readManifest();
  // A manifest that exists but cannot be read is not a pre-0.2.0 install, so its
  // files keep the label that says so.
  const preManifest = !manifest && !problem;
  const entries = classify(manifest, preManifest);
  const version = packageVersion();

  console.log(`briefboard update - project ${CWD}`);
  console.log(`package ${version}, this project's copy ${manifest ? manifest.version : 'unknown'}`);
  reportManifestProblem(problem);
  if (preManifest) {
    console.log(`no ${MANIFEST_REL}: this project was installed by a briefboard before ${MANIFEST_SINCE},`);
    console.log('which did not write one, so there is nothing to compare these files against. That is');
    console.log('all "no manifest" below reports; whether a file also carries your own edits cannot be');
    console.log('told from here. Everything replaced is backed up first.');
  }
  console.log('');

  const width = Math.max(...CATEGORIES.map((c) => c.length));
  for (const entry of entries) console.log(`  ${entry.category.padEnd(width)}  ${entry.rel}`);

  const modified = entries.filter((e) => e.category === MODIFIED);
  const targets = entries.filter((e) => isReplaceable(e, force));

  if (modified.length > 0) {
    console.log('');
    console.log(force
      ? 'Locally modified, replaced anyway because of --force (backed up first):'
      : 'Locally modified, NOT replaced (use --force to replace them too):');
    for (const entry of modified) console.log(`  ${entry.rel}`);
  }

  console.log('');
  if (targets.length === 0) {
    console.log(modified.length > 0
      ? 'Nothing to update apart from the locally modified files above.'
      : 'Everything is up to date.');
    return;
  }

  if (!apply) {
    console.log(`${targets.length} file(s) would be replaced. Nothing has been changed.`);
    console.log('Run "briefboard update --apply" to do it (replaced files are backed up first).');
    return;
  }

  const { backupDir, backedUp } = backupAndReplace(targets);
  const files = { ...(manifest ? manifest.files : {}) };
  // Skipped files keep whatever the manifest said before: recording their current
  // hash would make the next update read a user-edited file as untouched since
  // install, and replace it silently.
  for (const entry of targets) files[entry.rel] = entry.packageHash;
  writeManifest(files);

  console.log('');
  console.log(`${targets.length} file(s) updated to briefboard ${version}.`);
  if (backedUp > 0) console.log(`backup of the replaced files: ${backupDir}`);
  console.log('doc/ was not touched.');
}

function parseUpdateArgs(args) {
  const options = { apply: false, force: false };
  for (const arg of args) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
    else throw new Error(`unknown option for update: ${arg}`);
  }
  return options;
}

// ---------- version ----------

function printVersion() {
  const version = packageVersion();
  const { manifest, problem } = readManifest();
  console.log(`briefboard ${version}`);
  reportManifestProblem(problem);
  if (!manifest) {
    console.log(`this project's copy: unknown (${problem ? `${MANIFEST_REL} could not be read` : `no ${MANIFEST_REL}`})`);
    console.log('run "briefboard update" to compare this project\'s copy with the package');
    return;
  }
  console.log(`this project's copy: ${manifest.version}`);
  if (manifest.version !== version) {
    console.log('versions differ - run "briefboard update" to see what would change');
  }
}

// ---------- serve ----------

function parseServeArgs(args) {
  const { parsePort } = require(path.join(PKG_ROOT, 'server', 'listen.js'));
  let port;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const inline = arg.startsWith('--port=') ? arg.slice('--port='.length) : null;
    if (arg !== '--port' && inline === null) throw new Error(`unknown option for serve: ${arg}`);
    const value = inline === null ? args[++i] : inline;
    if (value === undefined) throw new Error('--port requires a value');
    // Validated here so a typo is a usage error rather than a dead server, but
    // passed on as text: `auto` parses to port 0, and PORT=0 is not how the
    // server is asked for any free port (T-0139).
    parsePort(value);
    port = value.trim();
  }
  return { port };
}

function serve({ port }) {
  const local = path.join(CWD, 'server', 'server.js');
  const packaged = path.join(PKG_ROOT, 'server', 'server.js');
  // A project keeps its own copy of server/ (init put it there) and that copy
  // may lag the installed package, so print which one is running instead of
  // leaving the version difference to be guessed.
  const serverPath = fs.existsSync(local) ? local : packaged;
  console.log(`briefboard serve - project ${CWD}`);
  console.log(`server: ${serverPath} (${serverPath === local ? "this project's copy" : 'installed package'})`);
  if (serverPath === local) {
    const { manifest, problem } = readManifest();
    reportManifestProblem(problem);
    const version = packageVersion();
    const projectVersion = manifest ? manifest.version : null;
    if (projectVersion !== version) {
      console.log(`version: package ${version}, this copy ${projectVersion ?? 'unknown'} - run "briefboard update" to update it`);
    }
  }
  process.env.AGENTBOARD_ROOT = CWD;
  // An explicit --port is passed on as an explicit PORT, which the server
  // refuses to substitute if it is taken (server/listen.js).
  if (port !== undefined) process.env.PORT = port;
  // Loaded into this process rather than spawned: the server installs its own
  // SIGINT/SIGTERM handlers, so Ctrl+C stops the board exactly as it does when
  // server.js is started directly, with no child's exit code to relay.
  require(serverPath);
}

function usageError(message) {
  console.error(`briefboard: ${message}`);
  console.error('Usage: briefboard [init|update [--apply] [--force]|serve [--port N]|--version]');
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === undefined || cmd === 'init') {
  init();
} else if (cmd === 'update') {
  let options;
  try {
    options = parseUpdateArgs(args);
  } catch (e) {
    usageError(e.message);
  }
  update(options);
} else if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  printVersion();
} else if (cmd === 'serve') {
  let options;
  try {
    options = parseServeArgs(args);
  } catch (e) {
    usageError(e.message);
  }
  serve(options);
} else {
  usageError(`unknown command: ${cmd}`);
}
