'use strict';

// Tests for bin/briefboard-init.mjs — the `npx briefboard init` scaffolder.
// Run with: npm test  (or: node --test tests/**/*.test.js)
//
// Each test runs the real bin script as a child process against a throwaway
// working directory (cwd = a fresh mkdtemp dir), so the project's own files are
// never touched. We assert the two behaviours the release brief (T-0059) pins:
//   1. a first run scaffolds an EMPTY doc/backlog.md, byte-identical to
//      serializeBacklog([]) — never a copy of this dev backlog;
//   2. a rerun is idempotent — it prints "skip existing" and overwrites nothing.

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

// `fetch` shadows the global one on purpose: bounded, so no request here can
// hang the run (T-0124).
const { fetch, waitForExit, stopProcess } = require('./helpers/bounded.js');
// A failing assertion here says what the board answered — code and body (T-0134).
const { readJson, answerOf } = require('./helpers/response.js');
const { freePort, occupyPort, waitForBanner } = require('./helpers/board.js');
const { AUTO_PORT_VALUE } = require('../server/listen.js');
const { serializeBacklog, parseBacklog } = require('../server/parser.js');
const { tempDir } = require('./helpers/tmp.js');

const BIN_PATH = path.join(__dirname, '..', 'bin', 'briefboard-init.mjs');

function runInit(cwd) {
  return spawnSync(process.execPath, [BIN_PATH, 'init'], { cwd, encoding: 'utf8' });
}

function runUpdate(cwd, ...args) {
  return spawnSync(process.execPath, [BIN_PATH, 'update', ...args], { cwd, encoding: 'utf8' });
}

/** Writes a file plus any parent directories, and returns its absolute path. */
function writeFile(dir, rel, content) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function manifestFiles(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.briefboard', 'installed.json'), 'utf8')).files;
}

function makeTmpDir() {
  return tempDir('briefboard-init-test-');
}

function backlogPath(dir) {
  return path.join(dir, 'doc', 'backlog.md');
}

describe('briefboard init', () => {
  it('scaffolds an empty doc/backlog.md equal to serializeBacklog([]) on a first run', () => {
    const dir = makeTmpDir();
    const res = runInit(dir);

    assert.strictEqual(res.status, 0, `init failed: ${res.stderr}`);
    assert.match(res.stdout, /created: doc\/backlog\.md/);

    const p = backlogPath(dir);
    assert.ok(fs.existsSync(p), 'doc/backlog.md should exist after init');

    const content = fs.readFileSync(p, 'utf8');
    // Byte-identical to the empty-backlog template — not a copy of any dev backlog.
    assert.strictEqual(content, serializeBacklog([]));
    assert.deepStrictEqual(parseBacklog(content), []);
  });

  it('is idempotent: a rerun prints "skip existing" and overwrites nothing', () => {
    const dir = makeTmpDir();

    const first = runInit(dir);
    assert.strictEqual(first.status, 0, `first init failed: ${first.stderr}`);

    // Mutate the scaffolded backlog so any accidental overwrite is detectable.
    const p = backlogPath(dir);
    const sentinel = fs.readFileSync(p, 'utf8') + '\n<!-- sentinel: user edit -->\n';
    fs.writeFileSync(p, sentinel);

    const second = runInit(dir);
    assert.strictEqual(second.status, 0, `second init failed: ${second.stderr}`);

    // "skip existing" warnings go to stderr (console.warn); "created" to stdout.
    assert.match(second.stderr, /skip existing: doc\/backlog\.md/);
    assert.match(second.stderr, /skip existing: doc\/brief/);
    assert.match(second.stderr, /skip existing: server/);
    assert.doesNotMatch(second.stdout, /created:/);

    // The user's sentinel edit survived — the file was not overwritten.
    assert.strictEqual(fs.readFileSync(p, 'utf8'), sentinel);
  });

  it('points at `briefboard serve` in its next steps', () => {
    const res = runInit(makeTmpDir());
    assert.match(res.stdout, /briefboard serve/);
  });

  it('records what it created in .briefboard/installed.json', () => {
    const dir = makeTmpDir();
    const res = runInit(dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /created: \.briefboard\/installed\.json/);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.briefboard', 'installed.json'), 'utf8'));
    assert.ok(manifest.files['server/server.js'], 'the copied runtime files are what it records');
  });

  // T-0188: the file is the user's data. `update` and `--version` say so and
  // touch nothing; `init` used to replace it with a record of this run alone,
  // silently, so both the damaged file and the fact it existed were gone.
  it('names a manifest it could not read, and overwrites neither it nor the truth', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, '.briefboard', 'installed.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const damaged = '{ "files": broken\n';
    fs.writeFileSync(file, damaged);

    const res = runInit(dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stderr, /WARNING: \.briefboard\/installed\.json could not be read/);
    assert.match(res.stderr, /recorded nothing/, 'and says what that costs');
    assert.doesNotMatch(res.stdout, /created: \.briefboard\/installed\.json/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), damaged, 'the user\'s file is left exactly as it was');
    // The install itself still happened - the refusal is about the record only.
    assert.match(res.stdout, /created: server/);
  });
});

// T-0294. `copyEntry` used to test the top-level entry and return, so one file
// named `tools/build.mjs` - an ordinary name in any repository - cost the whole
// directory: `tools/task.mjs` was never installed, `agents/PROTOCOL.md` never
// installed, and every line of the output read as success.
describe('briefboard init into a project that already exists', () => {
  /** A project with its own tools/ and agents/, neither of them briefboard's. */
  function projectOfItsOwn() {
    const dir = makeTmpDir();
    writeFile(dir, 'tools/build.mjs', '// my build\n');
    writeFile(dir, 'agents/my.md', '# my agent\n');
    return dir;
  }

  it('fills a colliding directory in file by file instead of skipping it whole', () => {
    const dir = projectOfItsOwn();

    const res = runInit(dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'tools', 'task.mjs')), 'tools/task.mjs is installed');
    for (const name of ['PROTOCOL.md', 'ORCHESTRATOR.md', 'WORKER.md']) {
      assert.ok(fs.existsSync(path.join(dir, 'agents', name)), `agents/${name} is installed`);
    }
    // The user's own files in those directories are untouched, byte for byte.
    assert.strictEqual(fs.readFileSync(path.join(dir, 'tools', 'build.mjs'), 'utf8'), '// my build\n');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'agents', 'my.md'), 'utf8'), '# my agent\n');
    assert.doesNotMatch(res.stderr, /skip existing: tools/);
    assert.doesNotMatch(res.stderr, /skip existing: agents/);
  });

  it('does not record a file it did not write', () => {
    const dir = projectOfItsOwn();
    // A file of the user's that briefboard also ships: it must survive AND stay
    // out of the manifest, or the next `update --apply` reads it as its own.
    writeFile(dir, 'tools/task.mjs', '// my own task runner\n');

    assert.strictEqual(runInit(dir).status, 0);

    const files = manifestFiles(dir);
    assert.ok(files['agents/PROTOCOL.md'], 'what it did write is recorded');
    assert.ok(!('tools/build.mjs' in files), 'a file briefboard never ships is not recorded');
    assert.ok(!('tools/task.mjs' in files), 'the user\'s own copy of a briefboard file is not recorded');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'tools', 'task.mjs'), 'utf8'), '// my own task runner\n');
  });

  it('prints merged: with the counts and names every file it kept', () => {
    const dir = projectOfItsOwn();
    writeFile(dir, 'tools/task.mjs', '// my own task runner\n');
    writeFile(dir, 'agents/WORKER.md', '# my own worker doc\n');

    const { stdout } = runInit(dir);

    assert.match(stdout, /^merged: tools \(\d+ added, 1 kept\)$/m);
    assert.match(stdout, /^ {2}kept yours: tools\/task\.mjs$/m);
    assert.match(stdout, /^merged: agents \(2 added, 1 kept\)$/m);
    assert.match(stdout, /^ {2}kept yours: agents\/WORKER\.md$/m);
    // And the run says out loud that briefboard's versions are not installed.
    assert.match(stdout, /briefboard did NOT install its own versions[\s\S]*tools\/task\.mjs/);
    assert.match(stdout, /briefboard did NOT install its own versions[\s\S]*agents\/WORKER\.md/);
  });

  it('stops presenting tools/task.mjs as a command when that file is the user\'s', () => {
    const dir = projectOfItsOwn();
    writeFile(dir, 'tools/task.mjs', '// my own task runner\n');

    const { stdout } = runInit(dir);

    // The line would tell the user to run someone else's script.
    assert.doesNotMatch(stdout, /node tools\/task\.mjs add/);
    assert.doesNotMatch(stdout, /node tools\/task\.mjs list/);
    assert.match(stdout, /briefboard's task CLI is not installed/);
    // The commands that DO work are still offered.
    assert.match(stdout, /briefboard serve/);
  });

  it('leaves the next steps intact when only a non-briefboard file collided', () => {
    const { stdout } = runInit(projectOfItsOwn());

    assert.match(stdout, /node tools\/task\.mjs add --type feature/);
    assert.match(stdout, /node tools\/task\.mjs list/);
  });

  it('an install into an empty directory is unchanged: no merged, nothing kept', () => {
    const { stdout, stderr } = runInit(makeTmpDir());

    assert.doesNotMatch(stdout, /merged:/);
    assert.doesNotMatch(stdout, /kept yours:/);
    assert.doesNotMatch(stdout, /did NOT install/);
    assert.doesNotMatch(stderr, /skip existing/);
    for (const name of ['server', 'tools', 'ui', 'agents', 'AGENTS.md', 'CLAUDE.md']) {
      assert.match(stdout, new RegExp(`^created: ${name.replace('.', '\\.')}$`, 'm'));
    }
  });

  // The install used to leave the runtime half absent, which `update` then reported
  // as "new in package" - a repair the user had to know to ask for.
  // T-0299. `copyEntry` returned every collision in `kept`, and on a rerun every
  // file collides - with the copy briefboard wrote seconds earlier. So a second
  // `init` on a healthy install named all 22 runtime files under "briefboard did
  // NOT install its own versions of them", dropped the two `node tools/task.mjs`
  // next-steps lines and said the task CLI was not installed. Every word false.
  describe('a second init on a healthy install', () => {
    /** stdout with the one machine-specific line - the project path - folded away. */
    function withoutProjectLine(stdout) {
      return stdout.replace(/^briefboard init - installing into .*$/m, 'briefboard init - installing into DIR');
    }

    it('claims nothing about the files it installed itself', () => {
      const dir = makeTmpDir();
      assert.strictEqual(runInit(dir).status, 0);

      const res = runInit(dir);

      assert.strictEqual(res.status, 0, res.stderr);
      // The whole point of the card, asserted as absences.
      assert.doesNotMatch(res.stdout, /did NOT install its own versions/);
      assert.doesNotMatch(res.stdout, /kept yours:/);
      assert.doesNotMatch(res.stdout, /task CLI is not installed/);
      assert.doesNotMatch(res.stdout, /is your own file/);
      // ...and as the presences that went missing with it.
      assert.match(res.stdout, /^ {2}node tools\/task\.mjs add --type feature --priority Major --title "\.\.\."$/m);
      assert.match(res.stdout, /^ {2}node tools\/task\.mjs list$/m);
    });

    // Criterion of the brief: byte-identical to what a rerun printed before T-0294
    // (`git show 8475c69~7:bin/briefboard-init.mjs`), measured by running both.
    // Pinned whole rather than by pattern, because "and nothing else" is the claim.
    it('prints exactly what a rerun printed before init learned to merge', () => {
      const dir = makeTmpDir();
      assert.strictEqual(runInit(dir).status, 0);

      const res = runInit(dir);

      assert.strictEqual(withoutProjectLine(res.stdout), [
        'briefboard init - installing into DIR',
        '',
        'Done. Next steps:',
        '  briefboard serve              # start the board at http://localhost:4571',
        '  node server/server.js         # the same board, started directly',
        '  node tools/task.mjs add --type feature --priority Major --title "..."',
        '  node tools/task.mjs list',
        '  briefboard update             # later: bring this copy up to a newer package',
        '',
      ].join('\n'));
      // stderr is that same output with one deliberate T-0294 addition kept: the
      // two merge entries say WHY they were skipped. Strip the parenthetical and
      // the eight lines are the pre-T-0294 ones, in order.
      assert.strictEqual(res.stderr.replace(/ \(briefboard's own copy, already installed\)/g, ''), [
        'skip existing: server',
        'skip existing: tools',
        'skip existing: ui',
        'skip existing: agents',
        'skip existing: AGENTS.md',
        'skip existing: CLAUDE.md',
        'skip existing: doc/brief',
        'skip existing: doc/backlog.md',
        '',
      ].join('\n'));
    });

    it('does not report a file briefboard installed and the user then edited', () => {
      const dir = makeTmpDir();
      assert.strictEqual(runInit(dir).status, 0);
      // One copy entry and one merge entry, so both halves of the split are
      // proved to reach the same answer through the same predicate. Neither is
      // byte-identical to the package any more; only the manifest vouches for them.
      writeFile(dir, 'server/server.js', '// my edit on briefboard\'s own file\n');
      writeFile(dir, 'CLAUDE.md', '# CLAUDE.md\n\nmy edit\n');
      assert.ok(manifestFiles(dir)['server/server.js'], 'the manifest is what vouches for it');

      const res = runInit(dir);

      assert.doesNotMatch(res.stdout, /did NOT install its own versions/);
      assert.doesNotMatch(res.stdout, /kept yours:/);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# CLAUDE.md\n\nmy edit\n');
    });

    // With no record, an edited runtime file and somebody else's file look the
    // same from here, so the closing block - and the sentence about the task CLI,
    // which is the same claim - are not printed at all.
    it('claims nothing at all when the manifest is gone', () => {
      const dir = makeTmpDir();
      assert.strictEqual(runInit(dir).status, 0);
      writeFile(dir, 'server/server.js', '// edited, and now unvouchable\n');
      writeFile(dir, 'tools/task.mjs', '// edited, and now unvouchable\n');
      fs.rmSync(path.join(dir, '.briefboard'), { recursive: true });

      const res = runInit(dir);

      assert.strictEqual(res.status, 0, res.stderr);
      assert.doesNotMatch(res.stdout, /did NOT install its own versions/);
      assert.doesNotMatch(res.stdout, /kept yours:/);
      assert.doesNotMatch(res.stdout, /task CLI is not installed/);
      assert.match(res.stdout, /node tools\/task\.mjs list/);
    });
  });

  it('leaves nothing for update to install: every briefboard file is up to date', () => {
    const dir = projectOfItsOwn();
    assert.strictEqual(runInit(dir).status, 0);

    const { status, stdout } = runUpdate(dir);

    assert.strictEqual(status, 0, stdout);
    assert.doesNotMatch(stdout, /new in package/);
    assert.match(stdout, /up to date {2,}tools\/task\.mjs/);
    assert.match(stdout, /up to date {2,}agents\/PROTOCOL\.md/);
  });
});

// ---------- `briefboard serve` (T-0078) ----------
// A board is normally left to pick its own port and asked afterwards which one
// it took (T-0123). The exception below is the test of `--port` itself: there
// the requested number is the subject.

const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function occupyFreePort() {
  const { port, close } = await occupyPort();
  cleanups.push(close);
  return port;
}

function runServe(dir, args) {
  const proc = spawn(process.execPath, [BIN_PATH, 'serve', ...args], {
    cwd: dir,
    // PORT=auto so an inherited one cannot mask what --port does, and a run
    // without --port takes a kernel port instead of the human range (T-0139).
    env: { ...process.env, PORT: AUTO_PORT_VALUE, BRIEFBOARD_NAME: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (c) => (stdout += c.toString()));
  proc.stderr.on('data', (c) => (stderr += c.toString()));
  cleanups.push(() => stopProcess(proc));

  return {
    out: () => ({ stdout, stderr }),
    async waitForExit() {
      const code = await waitForExit(proc);
      return { code, stdout, stderr };
    },
    ready: (timeoutMs) => waitForBanner(proc, () => ({ stdout, stderr }), timeoutMs),
  };
}

describe('briefboard serve', () => {
  it('starts the board for the current directory, using the project\'s own server copy', async () => {
    const dir = makeTmpDir();
    // fs.realpathSync: on macOS os.tmpdir() is a symlink, and the server prints
    // the resolved path.
    const project = fs.realpathSync(dir);
    assert.strictEqual(runInit(project).status, 0);

    const port = await freePort();
    const serve = runServe(project, ['--port', String(port)]);
    const bound = await serve.ready();

    assert.strictEqual(bound, port);
    assert.match(serve.out().stdout, /server: .*[\\/]server[\\/]server\.js \(this project's copy\)/);

    const res = await fetch(`http://127.0.0.1:${port}/api/board`);
    const board = await readJson(res);
    // The board serves THIS directory: its freshly scaffolded (empty) backlog,
    // named after the folder.
    assert.deepStrictEqual(board.tasks, [], answerOf(board));
    assert.strictEqual(board.project.name, path.basename(project), answerOf(board));
  });

  // T-0295. `serve` picked the destination file whenever it existed, and since
  // T-0294 `init` keeps a colliding one - so `require(serverPath)` loaded somebody
  // else's script into briefboard's own process and called it "this project's copy".
  describe('when the project\'s server/server.js is not briefboard\'s', () => {
    const RAN_MARKER = 'RAN-USERS-SCRIPT';

    /** A project whose server/server.js is the user's script, kept by init. */
    function projectWithItsOwnServer() {
      const dir = fs.realpathSync(makeTmpDir());
      // It writes a file the moment it is loaded: the absence of that file is what
      // proves it did not run. A missing log line would only prove it was quiet.
      writeFile(dir, 'server/server.js',
        `require('fs').writeFileSync(require('path').join(__dirname, '..', '${RAN_MARKER}'), 'ran');\n`);
      assert.strictEqual(runInit(dir).status, 0);
      return dir;
    }

    it('does not run it, starts the packaged board, and says which file it declined', async () => {
      const dir = projectWithItsOwnServer();

      const serve = runServe(dir, []);
      await serve.ready();

      const { stdout } = serve.out();
      assert.ok(!fs.existsSync(path.join(dir, RAN_MARKER)), 'the user\'s script must not have been loaded');
      assert.match(stdout, /\(installed package\)/);
      assert.match(stdout, /server\/server\.js in this project is not briefboard's/);
      assert.match(stdout, /\.briefboard\/installed\.json does not list it/);
      assert.match(stdout, /was NOT run/);
      assert.match(stdout, /"briefboard init" again/, 'and the way out');
    });

    it('is the same condition init uses: the "node server/server.js" line goes', () => {
      const dir = projectWithItsOwnServer();

      // Second run, so the line is judged against a manifest that already exists.
      const { stdout } = runInit(dir);

      assert.doesNotMatch(stdout, /^ {2}node server\/server\.js {2}/m);
      assert.match(stdout, /server\/server\.js here is your own file/);
      // The command that still works is still offered.
      assert.match(stdout, /^ {2}briefboard serve {2}/m);
    });

    it('still prints that line for a project whose server briefboard installed', () => {
      const dir = makeTmpDir();
      assert.strictEqual(runInit(dir).status, 0);

      const { stdout } = runInit(dir);

      assert.match(stdout, /^ {2}node server\/server\.js {2}/m);
      assert.doesNotMatch(stdout, /here is your own file/);
    });
  });

  describe('a project copy briefboard can vouch for', () => {
    const RAN_MARKER = 'RAN-PROJECT-COPY';

    /**
     * A normally installed project whose server/server.js the user has then EDITED,
     * so it is no longer byte-identical to the package and only the manifest
     * vouches for it. The edit makes the file announce that it ran.
     */
    function installedThenEdited() {
      const dir = fs.realpathSync(makeTmpDir());
      assert.strictEqual(runInit(dir).status, 0);
      const file = path.join(dir, 'server', 'server.js');
      fs.appendFileSync(file,
        `\nrequire('fs').writeFileSync(require('path').join(__dirname, '..', '${RAN_MARKER}'), 'ran');\n`);
      assert.notStrictEqual(fs.readFileSync(file, 'utf8'), fs.readFileSync(
        path.join(__dirname, '..', 'server', 'server.js'), 'utf8'), 'the edit must make the hashes differ');
      return dir;
    }

    // T-0078's rule is not weakened: only a file briefboard never installed is declined.
    it('runs a copy briefboard installed and the user then edited', async () => {
      const dir = installedThenEdited();
      assert.ok(manifestFiles(dir)['server/server.js'], 'the manifest is the only thing vouching for it');

      const serve = runServe(dir, []);
      await serve.ready();

      assert.ok(fs.existsSync(path.join(dir, RAN_MARKER)), 'the project copy is what ran');
      assert.match(serve.out().stdout, /\(this project's copy\)/);
      assert.doesNotMatch(serve.out().stdout, /is not briefboard's/);
      assert.doesNotMatch(serve.out().stdout, /provenance is unrecorded/);
    });

    // With no record the predicate can neither vouch nor condemn. A pre-0.2.0
    // install has been running that copy all along, so it still runs - and says so.
    it('runs an unvouchable copy when there is no manifest, and says the provenance is unrecorded', async () => {
      const dir = installedThenEdited();
      fs.rmSync(path.join(dir, '.briefboard'), { recursive: true });

      const serve = runServe(dir, []);
      await serve.ready();

      assert.ok(fs.existsSync(path.join(dir, RAN_MARKER)), 'it still runs');
      assert.match(serve.out().stdout, /\(this project's copy\)/);
      assert.match(serve.out().stdout, /provenance is unrecorded/);
      assert.doesNotMatch(serve.out().stdout, /was NOT run/);
    });

    it('says nothing new about a project installed normally', async () => {
      const dir = fs.realpathSync(makeTmpDir());
      assert.strictEqual(runInit(dir).status, 0);

      const serve = runServe(dir, []);
      await serve.ready();

      const { stdout } = serve.out();
      assert.match(stdout, /\(this project's copy\)/);
      assert.doesNotMatch(stdout, /is not briefboard's/);
      assert.doesNotMatch(stdout, /provenance is unrecorded/);
      // A fresh install's manifest carries this package's version, so no drift line.
      assert.doesNotMatch(stdout, /run "briefboard update" to update it/);
    });
  });

  it('falls back to the installed package copy when the project has no server/', async () => {
    const dir = fs.realpathSync(makeTmpDir());
    // No --port: this test is about which server copy runs, so the board picks
    // its own port and says which one in the banner (T-0123).
    const serve = runServe(dir, []);
    await serve.ready();

    assert.match(serve.out().stdout, /\(installed package\)/);
  });

  it('treats --port as explicit: an occupied port is an error, not a move', async () => {
    const dir = fs.realpathSync(makeTmpDir());
    const taken = await occupyFreePort();

    const { code, stdout, stderr } = await runServe(dir, ['--port', String(taken)]).waitForExit();

    assert.notStrictEqual(code, 0);
    assert.match(stderr, new RegExp(`port ${taken} is already in use`));
    assert.doesNotMatch(stdout, /briefboard: http:\/\//);
  });

  it('rejects a --port that is not a port number, with the usage line', async () => {
    const dir = makeTmpDir();
    const { code, stderr } = await runServe(dir, ['--port', 'abc']).waitForExit();

    assert.notStrictEqual(code, 0);
    assert.match(stderr, /invalid port/);
    assert.match(stderr, /Usage: briefboard \[init\|update/);
  });

  it('rejects an unknown option', async () => {
    const dir = makeTmpDir();
    const { code, stderr } = await runServe(dir, ['--nope']).waitForExit();

    assert.notStrictEqual(code, 0);
    assert.match(stderr, /unknown option for serve: --nope/);
  });
});

describe('briefboard <unknown command>', () => {
  it('names serve in the usage line', () => {
    const res = spawnSync(process.execPath, [BIN_PATH, 'bogus'], { cwd: makeTmpDir(), encoding: 'utf8' });
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /Usage: briefboard \[init\|update \[--apply\] \[--force\]\|serve \[--port N\]\|--version\]/);
  });
});
