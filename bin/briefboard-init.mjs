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

// Top-level entries copied from the package into the target project. The copy is
// per FILE, not per entry: a project of its own that already has a `tools/` or an
// `agents/` directory - ordinary names in any repository - used to lose the whole
// entry to one colliding file, so `tools/task.mjs` was never installed while every
// line of the output read as success (T-0294). A file already at the destination is
// still never overwritten; only the granularity of that decision changed.
const COPY_ENTRIES = ['server', 'tools', 'ui', 'agents', 'AGENTS.md', 'CLAUDE.md'];

// The two entries briefboard MERGES into rather than copies over. A project that
// already has a CLAUDE.md has one because somebody wrote it, and both whole-file
// answers are wrong: skipping leaves the agent reading instructions that never
// mention the board, replacing destroys the reason the file existed (T-0294). So
// briefboard writes the file whole only when it is absent, and otherwise appends a
// delimited block that it alone owns.
const MERGE_ENTRIES = ['AGENTS.md', 'CLAUDE.md'];

const MARKER_START = '<!-- briefboard:start -->';
const MARKER_END = '<!-- briefboard:end -->';
// HTML comments so the markers do not render in the user's document.
const BLOCK_HEADING = '## briefboard task protocol';
// A merge entry's manifest value is the hash of the block's inner text, not of the
// file, and it carries this prefix to say so. Two things need to tell them apart:
// this version, which records a whole-file hash for a merge entry it wrote itself
// (an install into an empty directory has no block at all) and an inner hash for
// one it appended a block to; and an OLDER briefboard, which compares the value
// against the whole file, cannot match a prefixed string, and therefore lands in
// MODIFIED LOCALLY - the category it will not replace without --force.
const BLOCK_PREFIX = 'block:';

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

function hashText(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function blockValue(inner) {
  return BLOCK_PREFIX + hashText(inner);
}

// Inlining `# CLAUDE.md` into the middle of somebody's document is wrong, so the
// package file's leading H1 goes. The rule is deliberately mechanical: if the first
// non-empty line starts with "# ", that line and the blank lines under it are
// dropped, and nothing else about the content is transformed.
function stripLeadingH1(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !lines[i].startsWith('# ')) return text;
  i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i).join('\n');
}

/** The block's inner text for a merge entry, as briefboard writes it. */
function packageBlockInner(rel) {
  const raw = fs.readFileSync(path.join(PKG_ROOT, rel), 'utf8');
  const body = stripLeadingH1(raw);
  return `${BLOCK_HEADING}\n\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

// The two fence forms CommonMark calls a fenced code block, which are the ones our
// own documents use: at most three spaces of indentation, then three or more
// backticks or three or more tildes, closed by a fence of the same character and at
// least the same length. An indented (four-space) code block is deliberately not
// recognised - telling one from a paragraph continuation needs a real markdown
// parser, and this is not one.
function fenceOf(line) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return m ? { char: m[1][0], length: m[1].length } : null;
}

/**
 * Locates briefboard's block in a document: { state: 'absent' | 'present' |
 * 'malformed' }, with `inner` when present and `reason` when malformed.
 *
 * Malformed means an end before a start, a start with no end, or more than one of
 * either. Where a block ends is never guessed - that is the one case where a wrong
 * guess eats the user's text - so such a file is reported and left alone, --force
 * included.
 *
 * Fence state answers exactly ONE question: is this line a CANDIDATE marker? The
 * asymmetry in the loop follows from who wrote the text on each side of the markers.
 */
function findBlock(text) {
  const lines = text.split('\n');
  const starts = [];
  const ends = [];
  let fence = null;
  let inBlock = false;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (inBlock) {
      // Between the markers the text is briefboard's OWN, so there is nothing here
      // to protect from a misread and the end marker quotes nothing. Fences are
      // deliberately NOT tracked in this branch: the block's body is the package's
      // AGENTS.md, and one unclosed fence in it would otherwise hide the end marker,
      // turning every installed CLAUDE.md into `markers malformed` - which nothing
      // repairs, --force included (T-0298 brief 02). Do not "simplify" this by
      // carrying the tracker through the block: the package files happen to contain
      // no fence today, and that is the entire distance to the failure.
      if (trimmed === MARKER_START) starts.push(i);
      else if (trimmed === MARKER_END) {
        ends.push(i);
        inBlock = false;
        fence = null;
      }
      return;
    }
    // Outside the markers the document is the user's, and a marker there may be a
    // picture of the block rather than a block: six of our own documents print that
    // snippet in a fence, so copying one into your own notes was enough to make
    // `init` skip the file and report it as success (T-0298).
    const f = fenceOf(line);
    if (fence) {
      if (f && f.char === fence.char && f.length >= fence.length) fence = null;
      return;
    }
    if (f) {
      fence = f;
      return;
    }
    if (trimmed === MARKER_START) {
      starts.push(i);
      inBlock = true;
    } else if (trimmed === MARKER_END) ends.push(i);
  });
  if (starts.length === 0 && ends.length === 0) return { state: 'absent' };
  if (starts.length > 1) return { state: 'malformed', reason: `${starts.length} start markers` };
  if (ends.length > 1) return { state: 'malformed', reason: `${ends.length} end markers` };
  if (starts.length === 0) return { state: 'malformed', reason: 'an end marker with no start' };
  if (ends.length === 0) return { state: 'malformed', reason: 'a start marker with no end' };
  if (ends[0] < starts[0]) return { state: 'malformed', reason: 'the end marker comes before the start' };
  const innerLines = lines.slice(starts[0] + 1, ends[0]);
  const inner = innerLines.length === 0 ? '' : `${innerLines.join('\n')}\n`;
  return { state: 'present', inner, start: starts[0], end: ends[0] };
}

/** The document with the block appended, separated by one blank line. */
function withBlockAppended(text, inner) {
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}\n${MARKER_START}\n${inner}${MARKER_END}\n`;
}

/**
 * The document with ONLY the text between the markers replaced. Splitting and
 * rejoining on '\n' round-trips exactly, so every byte on either side of the block
 * is the byte that was there before - the invariant this whole mechanism exists for.
 */
function withBlockReplaced(text, block, inner) {
  const lines = text.split('\n');
  const body = inner === '' ? [] : inner.split('\n').slice(0, -1);
  return [...lines.slice(0, block.start + 1), ...body, ...lines.slice(block.end)].join('\n');
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
  console.warn('  and cannot be read, so nothing about this project\'s copy can be vouched for: every file');
  console.warn('  is held back as unknown provenance and "briefboard update --apply" replaces none of');
  console.warn('  them. Nothing has been repaired or removed - repair the JSON to get the exact');
  console.warn('  categories back, or delete it and run "briefboard update --apply", which reinstalls the');
  console.warn('  runtime files with a backup and writes the manifest anew. ("--force" replaces them');
  console.warn('  without deleting anything, but it overwrites your own AGENTS.md and CLAUDE.md too.)');
}

function writeManifest(files) {
  const file = manifestPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const manifest = { version: packageVersion(), updatedAt: new Date().toISOString(), files };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// The two kinds of evidence that a file at the destination is briefboard's own.
// The callers word them differently, which is why the answer is not a bare boolean:
// OWN_IDENTICAL is byte-for-byte the package copy, OWN_INSTALLED is a file the
// manifest lists - briefboard wrote it and the user may have edited it since.
const OWN_IDENTICAL = 'identical';
const OWN_INSTALLED = 'installed';

/**
 * Which evidence says the file at `rel` is briefboard's own, or null when nothing
 * does. `manifest` is the parsed manifest (or null), read ONCE per run by the
 * caller: this is asked about every runtime file, and re-reading the same JSON per
 * file answers the same question twenty-odd times.
 *
 * One definition, because there used to be two and they disagreed. `mergeEntry`
 * asked it and `copyEntry` did not, so `copyEntry` read every collision as evidence
 * that the file was somebody else's - and on a second `init` every file collides,
 * with briefboard's own copy (T-0299).
 */
function ownFile(rel, manifest) {
  const src = path.join(PKG_ROOT, rel);
  const dest = path.join(CWD, rel);
  if (fs.existsSync(src) && fs.existsSync(dest) && hashFile(dest) === hashFile(src)) return OWN_IDENTICAL;
  if (manifest && manifest.files[rel] !== undefined) return OWN_INSTALLED;
  return null;
}

// ---------- init ----------

/**
 * Copies one top-level entry file by file, returning { added, kept } as relative
 * POSIX paths. `collectFiles` is the same walk `packageFiles()` uses, so what
 * `init` copies and what `update` later classifies cannot drift apart.
 *
 * `kept` holds only the files that are somebody ELSE'S. A collision with a file
 * briefboard installed itself is what `skip existing` has always meant, and is not
 * reported: naming it would tell the user that their own copy of a file briefboard
 * wrote seconds ago is being respected (T-0299).
 */
function copyEntry(name, manifest) {
  const src = path.join(PKG_ROOT, name);
  const dest = path.join(CWD, name);
  const result = { added: [], kept: [] };
  if (!fs.existsSync(src)) {
    // AGENTS.md is optional depending on the package build - nothing to copy.
    return result;
  }
  const files = collectFiles(src, name, []);
  if (files.length === 0) {
    // An entry that ships no files at all: keep the directory itself, so an empty
    // one in the package still arrives.
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
      console.log(`created: ${name}`);
    } else {
      console.warn(`skip existing: ${name}`);
    }
    return result;
  }
  for (const rel of files) {
    const to = path.join(CWD, rel);
    if (fs.existsSync(to)) {
      if (!ownFile(rel, manifest)) result.kept.push(rel);
      continue;
    }
    assertRuntimePath(rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(PKG_ROOT, rel), to);
    result.added.push(rel);
  }
  // Nothing written means the entry was already there, whoever it belongs to -
  // which is the line a rerun printed before any of this existed.
  if (result.added.length === 0) console.warn(`skip existing: ${name}`);
  else if (result.kept.length === 0) console.log(`created: ${name}`);
  else {
    console.log(`merged: ${name} (${result.added.length} added, ${result.kept.length} kept)`);
    for (const rel of result.kept) console.log(`  kept yours: ${rel}`);
  }
  return result;
}

/**
 * Installs one merge entry, returning { installed, kept } - `installed` is the
 * manifest record to make (or null), `kept` the path to name in the closing block.
 *
 * `init` never rewrites a block it finds. Inserting is a first-install act and
 * refreshing belongs to `update`; an `init` that quietly rewrote the block would be
 * the whole-file overwrite again in a smaller box.
 */
function mergeEntry(name, manifest) {
  const src = path.join(PKG_ROOT, name);
  const dest = path.join(CWD, name);
  const none = { installed: null, kept: null };
  if (!fs.existsSync(src)) return none;
  if (!fs.existsSync(dest)) {
    // Nobody else's document to respect: briefboard owns the whole file, and the
    // manifest records it whole, with no markers anywhere in it.
    assertRuntimePath(name);
    fs.copyFileSync(src, dest);
    console.log(`created: ${name}`);
    return { installed: { rel: name, value: hashFile(dest) }, kept: null };
  }
  const text = fs.readFileSync(dest, 'utf8');
  const block = findBlock(text);
  if (block.state === 'malformed') {
    console.warn(`skip existing: ${name} (briefboard markers are malformed: ${block.reason})`);
    return { installed: null, kept: name };
  }
  if (block.state === 'present') {
    console.warn(`skip existing: ${name} (the briefboard block is already there)`);
    return none;
  }
  // No block, and the file may still be briefboard's own: an install into an empty
  // directory writes it whole and marks no part of it. Appending a block to that
  // file would duplicate its entire content on the next `init`, so a file this
  // project already got FROM briefboard is left alone.
  const own = ownFile(name, manifest);
  if (own === OWN_IDENTICAL) {
    console.warn(`skip existing: ${name} (briefboard's own copy, already installed)`);
    return none;
  }
  if (own === OWN_INSTALLED) {
    console.warn(`skip existing: ${name} (briefboard installed it; "briefboard update" refreshes it)`);
    return none;
  }
  const inner = packageBlockInner(name);
  assertRuntimePath(name);
  fs.writeFileSync(dest, withBlockAppended(text, inner));
  console.log(`merged: ${name} (briefboard block added, your text untouched)`);
  return { installed: { rel: name, value: blockValue(inner) }, kept: null };
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

// Only the files this run actually wrote are recorded. Hashing a file that was
// kept as existing would claim briefboard put it there, and `update` would then
// read a user's own file as safe to overwrite. Since the copy became per-file
// (T-0294) a merged entry holds both kinds, so the entry name no longer answers
// the question and the written paths themselves are what is passed in.
// A merge entry adds the second kind of value: `value` is already computed by the
// caller there, because what briefboard owns in that file is the block, not the file.
// Returns whether it left a manifest behind, which is what the closing block below
// needs: a record is the only thing that can back a claim about who a file belongs to.
function recordInstall(installed, previous, problem) {
  if (installed.length === 0) return false;
  // A manifest we could not read is the user's data, and writing over it would
  // replace a record we never understood with one listing this run alone
  // (T-0188). `update` and `--version` already refuse to touch it silently.
  if (problem) {
    reportManifestProblem(problem);
    console.warn('  This run therefore recorded nothing: the files it just created stay unlisted, which');
    console.warn('  "briefboard update" reports as unknown provenance and holds back instead of replacing.');
    return false;
  }
  const files = { ...(previous ? previous.files : {}) };
  for (const { rel, value } of installed) {
    const dest = path.join(CWD, rel);
    if (value !== undefined) files[rel] = value;
    else if (fs.existsSync(dest)) files[rel] = hashFile(dest);
  }
  writeManifest(files);
  console.log(`created: ${MANIFEST_REL}`);
  return true;
}

// A kept file is a consequence, not a note: briefboard's version of it is simply
// not installed, and the run said "created" about everything around it. Nothing
// else in the output would tell the user that.
function reportKept(kept) {
  console.log('');
  console.log('These files were already here, so briefboard did NOT install its own versions of');
  console.log('them - this project runs on yours:');
  for (const rel of kept) console.log(`  ${rel}`);
  console.log('Nothing was overwritten. To take briefboard\'s version of one, move yours aside and');
  console.log('run "briefboard init" again; "briefboard update" shows how the two differ.');
}

// The two runtime files the output names as COMMANDS. A command may only name a
// path that holds briefboard's own file, so both are tested with the same
// predicate on a different path - `serve` asks about SERVER_REL as well (T-0295).
const TASK_CLI = 'tools/task.mjs';
const SERVER_REL = 'server/server.js';

function init() {
  console.log(`briefboard init - installing into ${CWD}`);
  // One read for the whole run: `ownFile` is asked about every runtime file below.
  const { manifest, problem } = readManifest();
  const installed = [];
  const kept = [];
  for (const name of COPY_ENTRIES) {
    if (MERGE_ENTRIES.includes(name)) {
      const result = mergeEntry(name, manifest);
      if (result.installed) installed.push(result.installed);
      if (result.kept) kept.push(result.kept);
      continue;
    }
    const { added, kept: collisions } = copyEntry(name, manifest);
    for (const rel of added) installed.push({ rel });
    kept.push(...collisions);
  }
  ensureBriefDir();
  ensureBacklog();
  const recorded = recordInstall(installed, manifest, problem);
  // Both the closing block and the next-steps sentence below say a file is somebody
  // else's, and only a manifest can back that: without one, a file that differs from
  // the package copy may equally be briefboard's own from a pre-0.2.0 install, edited
  // since. Claim nothing rather than guess - a report that cries wolf is worse than
  // no report (T-0299).
  const foreign = manifest || recorded ? kept : [];
  if (foreign.length > 0) reportKept(foreign);

  // The next steps are commands, so they may only name paths that hold
  // briefboard's own files: printing `node tools/task.mjs add ...` when that path
  // is the user's file tells them to run someone else's script. One test, two
  // paths (T-0295). `briefboard serve` itself always stays: it starts the packaged
  // board when the project's copy is not briefboard's.
  const theirs = (rel) => foreign.includes(rel);
  console.log('');
  console.log('Done. Next steps:');
  console.log('  briefboard serve              # start the board at http://localhost:4571');
  if (!theirs(SERVER_REL)) console.log('  node server/server.js         # the same board, started directly');
  if (!theirs(TASK_CLI)) {
    console.log('  node tools/task.mjs add --type feature --priority Major --title "..."');
    console.log('  node tools/task.mjs list');
  }
  console.log('  briefboard update             # later: bring this copy up to a newer package');
  if (theirs(TASK_CLI)) {
    console.log('');
    console.log(`${TASK_CLI} here is your own file, so briefboard's task CLI is not installed and`);
    console.log('this project has no "node tools/task.mjs" commands. Add and edit tasks from the');
    console.log(`board itself, or move your ${TASK_CLI} aside and run "briefboard init" again.`);
  }
  if (theirs(SERVER_REL)) {
    console.log('');
    console.log(`${SERVER_REL} here is your own file, so "node ${SERVER_REL}" would start your`);
    console.log('script rather than the board. "briefboard serve" declines to run it and starts the');
    console.log(`packaged board instead; move your ${SERVER_REL} aside and run "briefboard init"`);
    console.log("again to install briefboard's own copy.");
  }
}

// ---------- update ----------

const UP_TO_DATE = 'up to date';
const OUTDATED = 'outdated';
const MODIFIED = 'MODIFIED LOCALLY';
const UNKNOWN = 'unknown provenance';
const NO_MANIFEST = 'no manifest';
const MISSING = 'new in package';
const BLOCK_REMOVED = 'block removed';
const MALFORMED = 'markers malformed';
const CATEGORIES = [UP_TO_DATE, OUTDATED, MODIFIED, UNKNOWN, NO_MANIFEST, MISSING, BLOCK_REMOVED, MALFORMED];

// How `--apply` would write an entry: the whole file, only the text between the
// markers, or the block appended to a document that lost it.
const WHOLE = 'whole';
const INNER = 'inner';
const APPEND = 'append';

/** An ordinary copy entry: the whole file is briefboard's, so hashes compare whole. */
function classifyWholeFile(rel, dest, packageHash, installed, unvouched) {
  const current = hashFile(dest);
  if (current === packageHash) return { rel, packageHash, category: UP_TO_DATE, mode: WHOLE };
  const base = { rel, packageHash, mode: WHOLE };
  if (installed === undefined) return { ...base, category: unvouched };
  if (installed === current) return { ...base, category: OUTDATED };
  return { ...base, category: MODIFIED };
}

/**
 * A merge entry. Two shapes are legitimate and both must keep working: briefboard
 * wrote the whole file (an install into an empty directory - no markers, whole-file
 * hash in the manifest), or the user owns the file and briefboard owns only the
 * block (an inner hash, carrying BLOCK_PREFIX). The manifest value says which,
 * which is what makes "the block was removed" distinguishable from "you edited the
 * file briefboard wrote you".
 */
function classifyMerge(rel, dest, packageHash, installed, unvouched) {
  const text = fs.readFileSync(dest, 'utf8');
  const block = findBlock(text);
  if (block.state === 'malformed') {
    return { rel, packageHash, category: MALFORMED, mode: null, reason: block.reason };
  }
  const inner = packageBlockInner(rel);
  if (block.state === 'present') {
    const base = { rel, packageHash, mode: INNER, inner, value: blockValue(inner) };
    if (block.inner === inner) return { ...base, category: UP_TO_DATE };
    if (installed === undefined) return { ...base, category: unvouched };
    if (installed === blockValue(block.inner)) return { ...base, category: OUTDATED };
    return { ...base, category: MODIFIED };
  }
  // No block. Either briefboard owns the file whole, or the block was deleted -
  // and the manifest value's shape is the only thing that tells those apart.
  if (typeof installed === 'string' && installed.startsWith(BLOCK_PREFIX)) {
    return { rel, packageHash, category: BLOCK_REMOVED, mode: APPEND, inner, value: blockValue(inner) };
  }
  return classifyWholeFile(rel, dest, packageHash, installed, unvouched);
}

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
      entries.push({ rel, packageHash, category: MISSING, mode: WHOLE });
      continue;
    }
    const installed = manifest ? manifest.files[rel] : undefined;
    entries.push(MERGE_ENTRIES.includes(rel)
      ? classifyMerge(rel, dest, packageHash, installed, unvouched)
      : classifyWholeFile(rel, dest, packageHash, installed, unvouched));
  }
  return entries;
}

function isReplaceable(entry, force) {
  if (entry.category === UP_TO_DATE) return false;
  // Where a block ends is never guessed, so a document with broken markers is left
  // alone under every flag - --force included.
  if (entry.category === MALFORMED) return false;
  if (entry.category === MODIFIED) return force;
  // A manifest that exists and does not list a file is briefboard saying it did not
  // put that file there, so it stops being replaceable by default (T-0294). Only
  // `no manifest` - which says the install is old and nothing more - is still
  // replaced, backed up first, as it always was.
  if (entry.category === UNKNOWN) return force;
  if (entry.category === BLOCK_REMOVED) return force;
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
    if (entry.mode === INNER) {
      // Only the text between the markers. Everything on either side is the byte
      // that was there before - that is the invariant the block exists for.
      const text = fs.readFileSync(dest, 'utf8');
      const block = findBlock(text);
      fs.writeFileSync(dest, withBlockReplaced(text, block, entry.inner));
      console.log(`updated: ${entry.rel} (briefboard block only)`);
    } else if (entry.mode === APPEND) {
      const text = fs.readFileSync(dest, 'utf8');
      fs.writeFileSync(dest, withBlockAppended(text, entry.inner));
      console.log(`updated: ${entry.rel} (briefboard block re-added)`);
    } else {
      fs.copyFileSync(path.join(PKG_ROOT, entry.rel), dest);
      console.log(`updated: ${entry.rel}`);
    }
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

  const targets = entries.filter((e) => isReplaceable(e, force));

  // Three different reasons a file is held back, each with its own heading: they
  // were not modified, they were never installed, and one heading claiming both
  // would be a worse report than two.
  const heldBack = [
    {
      category: MODIFIED,
      kept: 'Locally modified, NOT replaced (use --force to replace them too):',
      forced: 'Locally modified, replaced anyway because of --force (backed up first):',
    },
    {
      category: UNKNOWN,
      kept: `Not installed by briefboard - ${MANIFEST_REL} does not list them, so they are\nsomebody else's. NOT replaced (use --force to replace them too):`,
      forced: 'Not installed by briefboard, replaced anyway because of --force (backed up first):',
    },
    {
      category: BLOCK_REMOVED,
      kept: 'The briefboard block was removed from these. NOT re-added (use --force to re-add it):',
      forced: 'The briefboard block was removed from these and is re-added because of --force:',
    },
  ];
  for (const { category, kept, forced } of heldBack) {
    const listed = entries.filter((e) => e.category === category);
    if (listed.length === 0) continue;
    console.log('');
    console.log(force ? forced : kept);
    for (const entry of listed) console.log(`  ${entry.rel}`);
  }

  const malformed = entries.filter((e) => e.category === MALFORMED);
  if (malformed.length > 0) {
    console.log('');
    console.log('Broken briefboard markers - left untouched, and --force will not touch them either.');
    console.log('Where the block ends cannot be guessed without risking your own text; repair the');
    console.log('markers by hand and run this again:');
    for (const entry of malformed) console.log(`  ${entry.rel} (${entry.reason})`);
  }

  const anyHeldBack = entries.some((e) => !isReplaceable(e, force) && e.category !== UP_TO_DATE);
  console.log('');
  if (targets.length === 0) {
    console.log(anyHeldBack
      ? 'Nothing to update apart from the files held back above.'
      : 'Everything is up to date.');
    return;
  }

  if (!apply) {
    console.log(`${targets.length} file(s) would be replaced. Nothing has been changed.`);
    console.log('Run "briefboard update --apply" to do it (replaced files are backed up first).');
    return;
  }

  const { backupDir, backedUp } = backupAndReplace(targets);
  // A manifest briefboard could not read is never written over. T-0188 settled that
  // for `init` and `--version`; `update` was never brought under it, from back when
  // overwriting it WAS the documented recovery. It no longer is - the warning above
  // tells the user to repair that file - and the gap only shows when something is
  // replaceable at all, which with an unreadable manifest takes a `new in package`
  // file. Installing one unrelated new file would otherwise destroy the record the
  // user was just told to repair (T-0297).
  if (problem) {
    reportSkippedManifest();
  } else {
    writeUpdatedManifest(manifest, targets, entries);
  }

  console.log('');
  console.log(`${targets.length} file(s) updated to briefboard ${version}.`);
  if (backedUp > 0) console.log(`backup of the replaced files: ${backupDir}`);
  console.log('doc/ was not touched.');
}

// The recovery is worded exactly as `reportManifestProblem()` words it: the same
// two ways out in the same words, rather than a third phrasing of them.
function reportSkippedManifest() {
  console.warn(`${MANIFEST_REL} was left exactly as it was, so this run is NOT recorded in`);
  console.warn('it: the files replaced above stay unlisted, and the next "briefboard update"');
  console.warn('reports them as unknown provenance and holds them back. Repair the JSON to get');
  console.warn('the exact categories back, or delete it and run "briefboard update --apply",');
  console.warn('which reinstalls the runtime files with a backup and writes the manifest anew.');
}

function writeUpdatedManifest(manifest, targets, entries) {
  const files = { ...(manifest ? manifest.files : {}) };
  // Two kinds of entry can be vouched for once this run is over: what was just
  // replaced, and what already matched the package - an `up to date` file's hash IS
  // the package hash, so recording it claims exactly what is true. Recording only
  // the first kind left a manifest listing 2 files of ~15 whenever one was written
  // from scratch (measured), and since T-0294 made an unlisted file
  // `unknown provenance` and held back, every file that run did not touch would be
  // refused the moment a later release changed it. Everything else keeps whatever
  // the manifest said before: the current hash of a MODIFIED LOCALLY or held-back
  // file would read as untouched since install on the next run, and be replaced
  // silently.
  const vouched = [...targets, ...entries.filter((e) => e.category === UP_TO_DATE)];
  // A merge entry records what briefboard owns there - the block's inner text.
  for (const entry of vouched) files[entry.rel] = entry.value ?? entry.packageHash;
  writeManifest(files);
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
  const local = path.join(CWD, ...SERVER_REL.split('/'));
  const packaged = path.join(PKG_ROOT, ...SERVER_REL.split('/'));
  const { manifest, problem } = readManifest();
  const present = fs.existsSync(local);
  const own = present ? ownFile(SERVER_REL, manifest) : null;
  // `existsSync` used to be the whole test, and since `init` copies per file that
  // path can hold somebody else's script - which serve loaded into its OWN process
  // and announced as "this project's copy" (T-0295). It is declined only when a
  // readable record exists and does not list it: that is briefboard saying it did
  // not put the file there. With no record it can neither vouch nor condemn, so the
  // copy runs, as it always has - a pre-0.2.0 install has been running it all
  // along, and breaking a working board to punish a missing file is the worse trade.
  const declined = present && !own && manifest !== null;
  const serverPath = present && !declined ? local : packaged;
  console.log(`briefboard serve - project ${CWD}`);
  console.log(`server: ${serverPath} (${serverPath === local ? "this project's copy" : 'installed package'})`);
  if (declined) {
    console.log(`${SERVER_REL} in this project is not briefboard's - ${MANIFEST_REL} does not list it,`);
    console.log('so it was NOT run and the packaged board above was started instead. To run');
    console.log(`briefboard's own copy from this project, move your ${SERVER_REL} aside and run`);
    console.log('"briefboard init" again.');
  }
  if (serverPath === local) {
    reportManifestProblem(problem);
    // A project copy briefboard cannot vouch for still runs, but the fact that
    // nothing says where it came from is not left to be inferred from a version line.
    if (!own) {
      console.log(`${SERVER_REL} differs from the packaged copy and no readable ${MANIFEST_REL}`);
      console.log('says where it came from, so its provenance is unrecorded - it was run anyway.');
    }
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
