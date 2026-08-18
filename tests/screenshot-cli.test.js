'use strict';

// T-0143: an agent session may not start a server, so a brief whose acceptance
// criterion is about how the board looks could be met by nobody in the loop —
// not the worker, not the reviewer, whose permissions are narrower still.
// tools/screenshot.mjs is the narrow door that fixes it, and these tests cover
// everything about it that does not need a browser: the refusal when there is
// none, and the whole board-up → capture → board-down cycle with the capture
// itself injected.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { fetch, waitForExit } = require('./helpers/bounded.js');
const { tempDir } = require('./helpers/tmp.js');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'screenshot.mjs');
const WIN = process.platform === 'win32';

let shot;
before(async () => {
  shot = await import(pathToFileURL(CLI).href);
});

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

// A project with one real task in it, made by the CLI that owns the format.
function makeProject() {
  const root = tempDir('briefboard-shot-project-');
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, 'tools', 'task.mjs'), 'add', '--type', 'feature', '--priority', 'Major', '--title', 'Look at me'],
    { env: { ...process.env, AGENTBOARD_ROOT: root }, encoding: 'utf8' }
  );
  assert.strictEqual(res.status, 0, `could not build the fixture project: ${res.stderr}`);
  return root;
}

describe('the browser is looked for, not assumed (T-0143)', () => {
  it('every platform we support has Chrome and Edge among its candidates', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      PATH: '',
    };
    for (const platform of ['win32', 'darwin', 'linux']) {
      const described = shot
        .browserCandidates(env, platform)
        .map((c) => (c.file || c.name).toLowerCase())
        .join(' ');
      assert.match(described, /chrom/, `${platform}: no Chrome or Chromium among the candidates`);
      assert.match(described, /edge/, `${platform}: no Edge among the candidates`);
    }
  });

  it('a candidate is taken from PATH as well as from the standard locations', () => {
    const dir = tempDir('briefboard-shot-path-');
    const exe = path.join(dir, 'chromium');
    fs.writeFileSync(exe, '');
    const found = shot.findBrowser([{ file: path.join(dir, 'nothing-here') }, { name: 'chromium' }], {
      PATH: dir,
    });
    assert.strictEqual(found, exe);
  });

  it('nothing installed is a refusal that names where it looked', () => {
    const candidates = [{ file: path.join(tempDir('briefboard-shot-none-'), 'chrome') }, { name: 'msedge' }];
    assert.strictEqual(shot.findBrowser(candidates, { PATH: '' }), null);
    const message = shot.noBrowserMessage(candidates);
    assert.match(message, /Chrome or Edge/);
    assert.match(message, new RegExp(candidates[0].file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    assert.match(message, /msedge \(on PATH\)/, 'a PATH candidate says so, or the list reads as a lie');
    assert.match(message, /--browser/, 'the way out has to be in the message');
  });

  it('a --browser that is not there fails clearly, with no stack and no board started', () => {
    const missing = path.join(tempDir('briefboard-shot-missing-'), 'chrome.exe');
    const res = runCli(['--browser', missing]);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /briefboard:/);
    assert.ok(res.stderr.includes(missing), 'the message names the path it was given');
    // A stack here would explain nothing about the machine's browser layout.
    assert.doesNotMatch(res.stderr, /^\s+at /m, `a refusal must not print a stack:\n${res.stderr}`);
  });
});

describe('the options are validated before anything is started (T-0143)', () => {
  it('an unknown language is refused and the supported ones are named', () => {
    const res = runCli(['--lang', 'de']);
    assert.strictEqual(res.status, 1);
    for (const lang of shot.LANGS) assert.ok(res.stderr.includes(lang), `${lang} must be offered`);
    assert.doesNotMatch(res.stderr, /^\s+at /m);
  });

  it('a nonsense viewport is refused', () => {
    const res = runCli(['--width', 'wide']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /--width/);
    assert.doesNotMatch(res.stderr, /^\s+at /m);
  });
});

describe('the page is prepared for a capture, not rewritten (T-0143)', () => {
  const PAGE = '<!doctype html>\n<html><head>\n<title>x</title>\n</head><body><div>b</div></body></html>';

  it('the language is set before the page can read it', () => {
    const html = shot.injectCapturePreamble(PAGE, 'ja');
    const script = html.indexOf("localStorage.setItem('lang',\"ja\")");
    assert.notStrictEqual(script, -1, 'the language has to be set at all');
    assert.ok(script < html.indexOf('<title>'), 'and before the page reads it');
  });

  it('a resource the load event must wait for is added at the end', () => {
    const html = shot.injectCapturePreamble(PAGE, 'en');
    const img = html.indexOf('<img src="/__briefboard-settle"');
    assert.notStrictEqual(img, -1);
    assert.ok(img < html.indexOf('</body>'), 'it has to be inside the body to be loaded');
    assert.ok(img > html.indexOf('<div>b</div>'), 'and last, so it is what the load event waits for');
  });

  it('nothing else about the page changes', () => {
    const html = shot.injectCapturePreamble(PAGE, 'en');
    for (const kept of ['<!doctype html>', '<title>x</title>', '<div>b</div>']) {
      assert.ok(html.includes(kept), `${kept} must survive`);
    }
  });
});

// The capture below is injected, so no browser is ever started — but `run()`
// resolves one before it starts the board (deliberately: a missing browser is
// the cheap failure to find out first), and on a machine that has none that
// refusal used to fail these two tests. It failed them on the truth about the
// machine rather than about the pipeline they test: measured in
// node:22-bookworm, the only two failures of this file (T-0244). So they name
// the executable instead of hunting for one — any existing file will do, and
// `process.execPath` is the one file guaranteed to be there wherever this suite
// runs. What the tests then assert is that the path they gave is what reaches
// the capture, which is the only thing `run()` does with it.
const BROWSER = process.execPath;

describe('a capture starts a board, serves it, and stops it again (T-0143)', () => {
  it('the board is up while the picture is taken and gone afterwards', async () => {
    const project = makeProject();
    const out = path.join(tempDir('briefboard-shot-out-'), 'board.png');
    const seen = { html: '', board: null };
    const lines = [];

    // Stands in for the browser: it does exactly what one does — asks the URL
    // it was given for the page — which is what makes this a test of the
    // pipeline rather than of a mock.
    const capture = async ({ browser, url, out: file, width, height }) => {
      seen.browser = browser;
      seen.width = width;
      seen.height = height;
      seen.html = await (await fetch(url)).text();
      seen.board = await (await fetch(new URL('/api/board', url))).json();
      fs.writeFileSync(file, 'png');
    };

    const result = await shot.run({
      argv: ['--lang', 'ru', '--width', '820', '--height', '640', '--out', out, '--browser', BROWSER],
      env: { ...process.env, AGENTBOARD_ROOT: project },
      capture,
      log: (line) => lines.push(String(line)),
    });

    assert.strictEqual(result.file, out);
    assert.strictEqual(seen.browser, BROWSER, 'the browser the run resolved is the one the capture is given');
    assert.strictEqual(seen.width, 820);
    assert.strictEqual(seen.height, 640);
    assert.ok(fs.existsSync(out), 'the picture is where the script says it is');
    assert.strictEqual(lines.at(-1), out, 'the last line printed is the path, so it can be picked up');

    // The board's own page, through the proxy, in the language that was asked for.
    assert.match(seen.html, /localStorage\.setItem\('lang',"ru"\)/);
    assert.match(seen.html, /<title>briefboard/);
    // And the API is forwarded untouched: without it the page is a blank board.
    assert.strictEqual(seen.board.tasks.length, 1);
    assert.strictEqual(seen.board.tasks[0].title, 'Look at me');

    await assert.rejects(
      () => fetch(`http://127.0.0.1:${result.port}/`, { timeoutMs: 2000 }),
      'the board has to be stopped when the capture is over'
    );
  });

  it('a browser that writes no image is a failure, not a silent success', async () => {
    const project = makeProject();
    const out = path.join(tempDir('briefboard-shot-empty-'), 'board.png');
    await assert.rejects(
      () =>
        shot.run({
          argv: ['--out', out, '--browser', BROWSER],
          env: { ...process.env, AGENTBOARD_ROOT: project },
          capture: async () => {
            throw new shot.CliError('chrome wrote no image');
          },
          log: () => {},
        }),
      /wrote no image/
    );
    assert.ok(!fs.existsSync(out));
  });
});

// T-0227, found by the security review in T-0213 and reproduced the same way:
// with a raw socket, because a request line is the only place these shapes can
// be written. `fetch` and `http.request` normalise them into an ordinary path
// long before the proxy sees them, so a test built on either would pass against
// the broken code — which is exactly the mistake this guards.
const RAW_ANSWER_MS = 10000;

function rawRequest(port, requestLine) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.setTimeout(RAW_ANSWER_MS, () => {
      socket.destroy();
      reject(new Error(`no answer to ${JSON.stringify(requestLine)} within ${RAW_ANSWER_MS}ms`));
    });
    let answer = '';
    socket.on('data', (chunk) => (answer += chunk));
    socket.on('close', () => resolve(answer));
    socket.on('error', reject);
  });
}

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  );
}

function closeServer({ server }) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('the capture proxy reaches its own board and nowhere else (T-0227)', () => {
  const reached = { elsewhere: [], board: [] };
  let elsewhere;
  let board;
  let proxy;
  let proxyPort;

  before(async () => {
    elsewhere = await listen(
      http.createServer((req, res) => {
        reached.elsewhere.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('SOMEWHERE ELSE');
      })
    );
    board = await listen(
      http.createServer((req, res) => {
        reached.board.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('THE BOARD');
      })
    );
    proxy = await shot.startCaptureProxy(`http://127.0.0.1:${board.port}/`, 'en');
    proxyPort = Number(new URL(proxy.url).port);
  });

  after(async () => {
    await proxy.close();
    await closeServer(elsewhere);
    await closeServer(board);
  });

  // Without this the three tests below would pass against a proxy that reaches
  // nothing at all, and against a second server that was never listening.
  it('the other server is up and answers, so refusing it is a result', async () => {
    const answer = await rawRequest(elsewhere.port, 'GET /control HTTP/1.1');
    assert.match(answer, /SOMEWHERE ELSE/);
    assert.deepStrictEqual(reached.elsewhere, ['GET /control']);
  });

  for (const [shape, line] of [
    ['an absolute-form request line', (port) => `GET http://127.0.0.1:${port}/evil HTTP/1.1`],
    ['a scheme-relative target', (port) => `GET //127.0.0.1:${port}/evil HTTP/1.1`],
    // WHATWG reads a backslash as a slash, so this is a second scheme-relative
    // target wearing a leading slash — and it defeats a "must begin with /" test.
    ['a backslash target', (port) => `GET /\\127.0.0.1:${port}/evil HTTP/1.1`],
  ]) {
    it(`${shape} does not leave the board`, async () => {
      const before = reached.elsewhere.length;
      const answer = await rawRequest(proxyPort, line(elsewhere.port));
      assert.doesNotMatch(answer, /SOMEWHERE ELSE/, `${shape} was forwarded off the board`);
      assert.strictEqual(
        reached.elsewhere.length,
        before,
        `${shape} reached the other server: ${reached.elsewhere.at(-1)}`
      );
    });
  }

  it('an ordinary path still reaches the board', async () => {
    const answer = await rawRequest(proxyPort, 'GET /api/board?x=1 HTTP/1.1');
    assert.match(answer, /THE BOARD/);
    assert.deepStrictEqual(reached.board.at(-1), 'GET /api/board?x=1');
  });
});

describe('the proxy target is built from the board, not from the request (T-0227)', () => {
  const BOARD = 'http://127.0.0.1:4711/';

  it('a path keeps its path and its query, on the board', () => {
    const target = shot.proxyTargetFor('/api/board?status=ready', BOARD);
    assert.strictEqual(target.href, 'http://127.0.0.1:4711/api/board?status=ready');
  });

  it('nothing in the request can move the host', () => {
    for (const url of ['//evil.example/x', '/\\evil.example/x', '/\\/evil.example/x', '/@evil.example']) {
      const target = shot.proxyTargetFor(url, BOARD);
      assert.strictEqual(target.host, '127.0.0.1:4711', `${url} moved the host`);
    }
  });

  it('a request line that is not a path is refused rather than resolved', () => {
    for (const url of ['http://evil.example/x', 'evil.example:443', '*', '\\\\evil.example/x']) {
      assert.strictEqual(shot.proxyTargetFor(url, BOARD), null, `${url} was accepted`);
    }
  });
});

// T-0222. `fs.rm`'s maxRetries reads as a retry budget and is not one: measured
// in T-0195, the call throws EPERM after 1 ms and spends none of it. T-0200
// swept the option out of the suite and guards tests/ against its return; this
// file is where the guard reaches the one place outside that scan.
describe('the tool does not wear a removal budget it never spends (T-0222)', () => {
  it('the profile cleanup passes fs.rm no maxRetries or retryDelay', () => {
    const source = fs.readFileSync(CLI, 'utf8');
    const inCode = source.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(
      inCode,
      /(?<![\w$])(?:maxRetries|retryDelay)\s*:/,
      'tools/screenshot.mjs passes fs.rm an option that promises seconds of waiting and spends none of them'
    );
  });
});

// T-0265. The profile used to be removed with a single attempt, on the grounds
// that a poll would make every capture wait for tidiness. Remeasured (Windows 11,
// node v24.18.0, Chrome 151.0.7922.138): a browser that finished by itself let go
// of its profile at once in all 22 captures, and a browser that had to be killed
// held it in 13 of 20 runs — every one of which a retry cleared in 104-518 ms.
// So the wait is real, it is short, and an ordinary capture never pays it.
//
// `rm` is injected here for the same reason tests/rm-helper.test.js injects one:
// the EPERM only happens on Windows, and the waiting has to be testable where it
// does not.
describe('the profile goes even before the browser has let go of it (T-0265)', () => {
  const held = () => Object.assign(new Error('held'), { code: 'EPERM' });

  it('a directory that goes at once costs one attempt and no waiting', async () => {
    let attempts = 0;
    const gone = await shot.removeProfile('unused', {
      rm: () => {
        attempts += 1;
      },
    });
    assert.strictEqual(gone, true);
    assert.strictEqual(attempts, 1, 'a capture whose profile is free must not wait for anything');
  });

  it('a directory still held is waited out and removed', async () => {
    let attempts = 0;
    const gone = await shot.removeProfile('unused', {
      rm: () => {
        attempts += 1;
        if (attempts < 3) throw held();
      },
    });
    assert.strictEqual(gone, true);
    assert.strictEqual(attempts, 3, 'the removal has to be retried, not attempted once');
  });

  it('and one that never goes ends on the budget instead of failing the capture', async () => {
    let attempts = 0;
    const started = Date.now();
    const gone = await shot.removeProfile('unused', {
      budgetMs: 150,
      rm: () => {
        attempts += 1;
        throw held();
      },
    });
    assert.strictEqual(gone, false, 'it reports the leftover; it does not throw over it');
    assert.ok(attempts > 1, `it waited at all: ${attempts} attempt(s)`);
    assert.ok(Date.now() - started < 30000, 'and the waiting is bounded');
  });
});

// T-0276. The polled removal above runs in capture()'s `finally`, so it covers
// every ending capture() can itself see — including a browser that had to be
// killed. Two endings never reach that `finally`: the script dying somewhere
// outside the try, and a signal. The wrapper next door lost the same class of
// leak by having no artifact at all; a screenshot cannot, because Chrome must be
// handed a real --user-data-dir, so what it gets is an exit hook and signal
// handlers — and one case that stays open on every platform, which the last test
// here asserts rather than merely describing.
//
// The CLI is run for real, with the browser spawn replaced through `--import`. A
// fake browser as a file would have to be something the platform can spawn
// without a shell, and on Windows there is no such thing to write from a test —
// a .cmd needs one and a .js is not executable. The shim tells the browser apart
// from the board, which is spawned with the same executable, by the flag only
// the browser is given.

const PROFILE_PREFIX = 'briefboard-shot-';

// node reads the temporary directory from TMPDIR on POSIX and from TEMP/TMP on
// Windows, so all three are set and the CLI cannot fall back to the real one.
function privateTemp() {
  const root = fs.realpathSync(tempDir('briefboard-shot-tmproot-'));
  return { root, env: { TMPDIR: root, TEMP: root, TMP: root } };
}

function profilesIn(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith(PROFILE_PREFIX));
}

// Patches child_process BEFORE screenshot.mjs's own `import { spawn }` binds to
// it: a builtin's ESM facade is built out of the CJS object the first time the
// builtin is imported, and that is after --import has run (measured, node
// v24.18.0; tests/test-run.test.js relies on the same timing).
const browserShim = (body) => `import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';

const cp = createRequire(import.meta.url)('node:child_process');
const real = cp.spawn;
const isBrowser = (args) =>
  Array.isArray(args) && args.some((arg) => String(arg).startsWith('--user-data-dir='));
cp.spawn = (file, args, options) => {
  if (!isBrowser(args)) return real(file, args, options);
${body}
};
`;

// Writes down what profiles existed at the moment it throws, then throws where
// capture() cannot catch it: before the `try` whose `finally` does the removal.
const THROW_BEFORE_BROWSER = browserShim(`  fs.writeFileSync(
    process.env.PROFILE_SNAPSHOT_OUT,
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('${PROFILE_PREFIX}')).join('\\n')
  );
  throw new Error('injected: the browser could not be started');`);

// How long the stand-in browser holds the capture open. Bounded rather than
// endless: the signal below is aimed at the CLI alone, so this process is
// orphaned by it, and something this test started must not outlive it.
const STANDIN_BROWSER_MS = 20000;

// A browser that does not finish while the test is looking, so the capture is
// still in progress when the signal lands — and far inside the script's own 90s
// bound, which nothing here waits for.
const HANGING_BROWSER = browserShim(
  `  return real(process.execPath, ['-e', 'setTimeout(() => {}, ${STANDIN_BROWSER_MS})'], options);`
);

// The measurement tools/screenshot.mjs rests its "still open" comment on, kept
// executable rather than only written down. Installs handlers for the signals
// the script installs them for and writes down which one reached it; on Windows
// nothing ever writes that file, which is why the profile a kill leaves there is
// beyond the reach of any handler this file could add.
const SIGNAL_PROBE = `const fs = require('node:fs');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { fs.writeFileSync(process.env.PROBE_CAUGHT, signal); process.exit(0); });
}
fs.writeFileSync(process.env.PROBE_READY, 'ready');
setInterval(() => {}, 50);
`;

function writeShim(source) {
  const file = path.join(tempDir('briefboard-shot-shim-'), 'shim.mjs');
  fs.writeFileSync(file, source);
  return pathToFileURL(file).href;
}

function cliArgs(shim, out) {
  return ['--import', shim, CLI, '--browser', BROWSER, '--out', out];
}

describe('the profile goes on the ways out capture() never reaches (T-0276)', () => {
  it('a crash before the browser starts still takes the profile with it', () => {
    const { root, env } = privateTemp();
    const snapshot = path.join(tempDir('briefboard-shot-snapshot-'), 'profiles');
    const res = spawnSync(
      process.execPath,
      cliArgs(writeShim(THROW_BEFORE_BROWSER), path.join(tempDir('briefboard-shot-crash-'), 'board.png')),
      {
        env: {
          ...process.env,
          ...env,
          AGENTBOARD_ROOT: makeProject(),
          PROFILE_SNAPSHOT_OUT: snapshot,
        },
        encoding: 'utf8',
      }
    );
    const out = `${res.stdout}${res.stderr}`;
    assert.notStrictEqual(res.status, 0, out);
    assert.match(out, /injected: the browser could not be started/, 'the crash has to be the injected one');
    // What the throw saw. Without it an empty root below is also what a run that
    // never made a profile leaves, and the test would pass against a script that
    // had stopped capturing anything at all (T-0182).
    const held = fs.readFileSync(snapshot, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(held.length, 1, `the profile had to exist at the throw; saw ${held.join()}`);
    assert.deepStrictEqual(profilesIn(root), [], out);
  });

  // The two halves are the two platforms, as in tests/test-run.test.js: a signal
  // is the one ending that has to be intercepted to be survivable, and on Windows
  // it cannot be intercepted at all. So POSIX gets the handler, and Windows gets
  // the fact that makes the handler impossible there — which is the same fact the
  // "still open" comment in tools/screenshot.mjs rests on.
  //
  // The signal goes to the CLI alone and not to its process group. Measured
  // under four concurrent runs of this file: `taskkill /pid <cli> /t /f` kills
  // the stand-in browser first often enough to be flaky — the script then sees
  // an ordinary browser exit, takes its ordinary path, and reports "wrote no
  // image", which is a different ending from the one under test. Signalling the
  // script by itself leaves nothing to race with.
  it('a capture stopped by a signal takes it too, where a signal reaches the process at all', async () => {
    if (WIN) {
      const dir = tempDir('briefboard-shot-signal-probe-');
      const caught = path.join(dir, 'caught');
      const ready = path.join(dir, 'ready');
      const probe = spawn(process.execPath, ['-e', SIGNAL_PROBE], {
        env: { ...process.env, PROBE_CAUGHT: caught, PROBE_READY: ready },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      await waitFor(() => fs.existsSync(ready), 30000, 'the probe to install its handlers');
      probe.kill('SIGTERM');
      await waitForExit(probe);
      assert.strictEqual(
        fs.existsSync(caught),
        false,
        'a signal handler ran on Windows: process.kill no longer terminates outright, so a capture ' +
          'killed from outside can now clean up after itself here too — which makes both this test ' +
          'and the hard-kill paragraph in tools/screenshot.mjs stale'
      );
      return;
    }

    const { root, env } = privateTemp();
    const childEnv = { ...process.env, ...env, AGENTBOARD_ROOT: makeProject() };
    delete childEnv.NODE_TEST_CONTEXT;
    // A process group of its own, so that whatever the signal leaves standing —
    // the board, the stand-in browser — can be taken in one call at the end.
    const child = spawn(
      process.execPath,
      cliArgs(writeShim(HANGING_BROWSER), path.join(tempDir('briefboard-shot-killed-'), 'board.png')),
      { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    );
    let out = '';
    const heard = (chunk) => {
      out += chunk;
    };
    child.stdout.on('data', heard);
    child.stderr.on('data', heard);

    try {
      await waitFor(() => profilesIn(root).length === 1, 30000, 'the capture to make its profile');
      child.kill('SIGTERM');
      const code = await waitForExit(child);
      // 128+SIGTERM: the script ended ITSELF on the signal, which is the only way
      // the exit hook can have been reached. Killed outright it reports no code.
      assert.strictEqual(code, 143, `the capture had to end itself on the signal; ${out}`);
      assert.deepStrictEqual(profilesIn(root), [], out);
    } finally {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* the group is already gone, which is the ordinary case */
      }
    }
  });
});

// resolveBrowser lets a --browser past on existsSync alone, so a path that is
// there and is not a program reaches the spawn — and a spawn that never happens
// is not a non-zero exit. Measured, node v24.18.0 on Windows 11 (the same two
// shapes the comment above spawnBrowser records): a directory and an
// extensionless file arrive as an 'error' event on the child, ENOENT here and
// EACCES on POSIX, while a .exe that is not a program throws out of spawn()
// itself, UNKNOWN here and EFTYPE for a .json. The first shape is what makes
// this a real spawn failure and not a stubbed one: with proc.on('error') gone,
// node throws the event as an uncaught exception, and the stack these tests
// assert is absent is exactly what appears.
describe('a browser that cannot be started refuses in one line (T-0288)', () => {
  // The board is started for real, so the run reaches capture() the way a user's
  // does. TMPDIR/TEMP/TMP point at a root of our own, so the profile the capture
  // makes is countable.
  function refusedBy(browser) {
    const { root, env } = privateTemp();
    const out = path.join(tempDir('briefboard-shot-unstartable-'), 'board.png');
    const res = runCli(['--browser', browser, '--out', out], {
      ...env,
      AGENTBOARD_ROOT: makeProject(),
    });
    return { res, root, said: `${res.stdout}${res.stderr}` };
  }

  function itRefuses(browser, { root, res, said }) {
    assert.strictEqual(res.status, 1, said);
    assert.match(res.stderr, /^briefboard: /m, said);
    assert.ok(res.stderr.includes(browser), `the message names the path it was given:\n${res.stderr}`);
    assert.match(res.stderr, /could not be started/, said);
    // The two endings stay apart: this browser never ran, so calling it one that
    // "did not finish" would name the wrong thing.
    assert.doesNotMatch(res.stderr, /did not finish/, said);
    // A stack here would explain nothing about the machine's browser layout, and
    // an unlistened 'error' event is precisely how one gets printed.
    assert.doesNotMatch(res.stderr, /^\s+at /m, `a refusal must not print a stack:\n${res.stderr}`);
    // Empty is also what a run that never made a profile leaves (T-0182) — but
    // the message asserted above is written only inside capture(), which is past
    // the mkdtempSync that makes one. So the profile existed, and is gone.
    assert.deepStrictEqual(profilesIn(root), [], said);
  }

  it('a --browser that is a directory is refused, not thrown (the error event)', () => {
    const browser = tempDir('briefboard-shot-notaprogram-');
    itRefuses(browser, refusedBy(browser));
  });

  it('a --browser that is a file and not a program is refused too', () => {
    // Windows takes this one through the synchronous throw out of spawn(); POSIX,
    // where a plain file without the exec bit is EACCES, takes it through the
    // event. Both have to end in the same one line.
    const browser = path.join(tempDir('briefboard-shot-notanexe-'), WIN ? 'chrome.exe' : 'chrome');
    fs.writeFileSync(browser, 'this is not a browser');
    itRefuses(browser, refusedBy(browser));
  });
});

// The script is useless in an installed project if the package leaves it out,
// and `files` lists tools per file rather than the directory (deliberately — it
// keeps tools/release-export.mjs out of the package). Verified for real with
// `npm pack`; this is the regression guard on top of that.
describe('the script ships with the package (T-0143)', () => {
  it('package.json lists it among the files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.files.includes('tools/screenshot.mjs'), 'tools/screenshot.mjs must be packed');
    assert.ok(pkg.files.includes('tools/task.mjs'), 'and it must not have replaced tools/task.mjs');
  });
});

// T-0281. --eval/--click exist so that a criterion about a dialog can be looked
// at rather than read off the markup. Every test below is about the one way the
// option could be worse than not existing: running the snippet against a board
// that has not drawn, or against a card that is not there, and writing a picture
// of an undisturbed board that is then read as evidence of what was asked for.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { waitFor } = require('./helpers/wait.js');

// Runs the page-side runner here, with the three globals it touches replaced: no
// browser, and the DOM changes it waits for are fired by the test. The snippet
// itself still goes through the real indirect eval, in this process's global
// scope — which is why the snippets below speak to globalThis, and why what they
// cannot do is mutate a DOM that is not there.
function runRunner(snippet, options = {}) {
  const reports = [];
  let observer = null;
  class Observer {
    constructor(cb) {
      this.cb = cb;
      this.live = false;
      observer = this;
    }
    observe() {
      this.live = true;
    }
    disconnect() {
      this.live = false;
    }
  }
  const source = shot.captureRunnerSource(snippet, {
    drawMs: 5000,
    quietMs: 500,
    effectMs: 1000,
    ...options,
  });
  new Function('fetch', 'MutationObserver', 'document', source)(
    (url) => {
      reports.push(String(url));
      return Promise.resolve();
    },
    Observer,
    { readyState: 'complete', documentElement: {}, addEventListener() {} }
  );
  return {
    reports,
    mutate: () => observer.cb(),
    async said(timeoutMs = 5000) {
      await waitFor(() => reports.length > 0, timeoutMs, 'the page to report back');
      const query = new URLSearchParams(reports[0].slice(reports[0].indexOf('?') + 1));
      return query.get('error') || 'ok';
    },
  };
}

describe('the snippet runs after the board has drawn, or the picture lies (T-0281)', () => {
  it('a board still changing is not one to run against', async () => {
    globalThis.__t281drawing = 0;
    const runner = runRunner('globalThis.__t281drawing++');
    // The board's first paint: a burst of mutations, each well inside the quiet
    // window the runner waits for.
    for (let i = 0; i < 6; i += 1) {
      runner.mutate();
      await wait(50);
    }
    assert.strictEqual(globalThis.__t281drawing, 0, 'the snippet ran while the board was still drawing');
    await waitFor(() => globalThis.__t281drawing === 1, 5000, 'the snippet to run once the board settled');
    runner.mutate(); // what the snippet opened
    assert.strictEqual(await runner.said(), 'ok');
  });

  it('a snippet that throws is reported, with what the browser said', async () => {
    const runner = runRunner("throw new Error('boom')", { quietMs: 60 });
    runner.mutate();
    assert.strictEqual(await runner.said(), 'the snippet threw: boom');
  });

  it('a snippet that changes nothing is a failure, not a picture', async () => {
    globalThis.__t281nothing = 0;
    const runner = runRunner('globalThis.__t281nothing++', { quietMs: 60, effectMs: 150 });
    runner.mutate();
    const said = await runner.said();
    assert.match(said, /changed nothing/, `the silent case has to be reported: ${said}`);
    assert.strictEqual(globalThis.__t281nothing, 1, 'and it is the effect that was missing, not the run');
  });

  it('a snippet whose effect reaches the DOM is reported as done, once', async () => {
    globalThis.__t281effect = 0;
    const runner = runRunner('globalThis.__t281effect++', { quietMs: 60 });
    runner.mutate();
    await waitFor(() => globalThis.__t281effect === 1, 5000, 'the snippet to run');
    runner.mutate();
    assert.strictEqual(await runner.said(), 'ok');
    await wait(120);
    assert.strictEqual(runner.reports.length, 1, 'the page speaks once, or the run has two answers');
  });
});

describe('--click is --eval with a selector, and says when it matched nothing (T-0281)', () => {
  const clickIn = (selector, doc) => new Function('document', shot.clickSnippet(selector))(doc);

  it('an element that is there is clicked', () => {
    const clicked = [];
    const doc = { querySelector: (sel) => (sel === '#there' ? { click: () => clicked.push(sel) } : null) };
    clickIn('#there', doc);
    assert.deepStrictEqual(clicked, ['#there']);
  });

  it('one that is not there throws rather than clicking nothing', () => {
    const doc = { querySelector: () => null };
    assert.throws(() => clickIn('#label-filter-btn', doc), /no element matches #label-filter-btn/);
  });
});

describe('the snippet reaches the page, and only when there is one (T-0281)', () => {
  const PAGE_281 = '<!doctype html>\n<html><head>\n<title>x</title>\n</head><body><div>b</div></body></html>';

  it('an ordinary capture is the page it always was', () => {
    const plain = shot.injectCapturePreamble(PAGE_281, 'en');
    assert.strictEqual(plain, shot.injectCapturePreamble(PAGE_281, 'en', null));
    assert.ok(!plain.includes(shot.RUN_PATH), 'nothing about a snippet may reach a capture without one');
    assert.strictEqual((plain.match(/<script>/g) || []).length, 1, 'only the language script belongs there');
  });

  it('the runner is in the body, before the resource the load event waits for', () => {
    const html = shot.injectCapturePreamble(PAGE_281, 'en', "openTask('T-0007')");
    const src = html.indexOf('"openTask(\'T-0007\')"');
    assert.notStrictEqual(src, -1, 'the snippet has to be in the page at all');
    assert.ok(src < html.indexOf(shot.SETTLE_PATH), 'it must run before the image that ends the load');
    assert.ok(src < html.indexOf('</body>'), 'and inside the body, or it never runs');
  });

  it("a </script> inside the snippet cannot end the page's script", () => {
    const html = shot.injectCapturePreamble(PAGE_281, 'en', "x('</script><b>spill</b>')");
    assert.strictEqual(
      (html.match(/<\/script>/g) || []).length,
      2,
      'the snippet closed the script tag: everything after it is document text, not code'
    );
    assert.ok(html.includes('<\\/script>'), 'the way out is escaping it, not dropping it');
  });
});

describe('the capture cannot happen before the snippet has (T-0281)', () => {
  const somewhere = () =>
    listen(
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('board');
      })
    );

  it('the settle image is held until the page reports back', async () => {
    const board = await somewhere();
    const proxy = await shot.startCaptureProxy(`http://127.0.0.1:${board.port}/`, 'en', {
      flag: '--eval',
      source: "openTask('T-0007')",
    });
    try {
      let answered = false;
      const image = fetch(new URL(shot.SETTLE_PATH, proxy.url)).then((res) => {
        answered = true;
        return res;
      });
      // Longer than the timer a capture without a snippet is answered on: at
      // 600ms this passed against a proxy that had gone on using that timer and
      // was waiting for nothing at all.
      await wait(shot.SETTLE_MS + 500);
      assert.strictEqual(answered, false, 'the picture would have been taken before the snippet ran');
      assert.strictEqual(proxy.snippetResult(), null, 'and nothing is known about the snippet yet');
      await fetch(new URL(`${shot.RUN_PATH}?ok=1`, proxy.url));
      assert.strictEqual((await image).status, 200);
      assert.deepStrictEqual(proxy.snippetResult(), { ok: true });
    } finally {
      await proxy.close();
      await closeServer(board);
    }
  });

  it('an error the page reports is what the run is told', async () => {
    const board = await somewhere();
    const proxy = await shot.startCaptureProxy(`http://127.0.0.1:${board.port}/`, 'en', {
      flag: '--click',
      source: 'x',
    });
    try {
      const said = 'the snippet threw: no element matches #gone';
      await fetch(new URL(`${shot.RUN_PATH}?error=${encodeURIComponent(said)}`, proxy.url));
      assert.deepStrictEqual(proxy.snippetResult(), { ok: false, error: said });
    } finally {
      await proxy.close();
      await closeServer(board);
    }
  });

  it('with no snippet the image is answered on its own, as it always was', async () => {
    const board = await somewhere();
    const proxy = await shot.startCaptureProxy(`http://127.0.0.1:${board.port}/`, 'en');
    try {
      assert.deepStrictEqual(
        proxy.snippetResult(),
        { ok: true },
        'a capture with nothing to wait for cannot fail on it'
      );
      assert.strictEqual((await fetch(new URL(shot.SETTLE_PATH, proxy.url))).status, 200);
    } finally {
      await proxy.close();
      await closeServer(board);
    }
  });
});

describe('a snippet that did not take effect keeps no picture (T-0281)', () => {
  // Stands in for the browser exactly as the capture above does, and adds the
  // one thing a page with a snippet in it also does: it says what happened.
  const browserThat = (report) => async ({ url, out: file }) => {
    const html = await (await fetch(url)).text();
    fs.writeFileSync(file, 'png');
    if (report) await fetch(new URL(report(html), url));
  };

  it('a page that says the snippet ran keeps the picture', async () => {
    const out = path.join(tempDir('briefboard-shot-ran-'), 'board.png');
    let served = '';
    const result = await shot.run({
      argv: ['--eval', "openTask('T-0007')", '--out', out, '--browser', BROWSER],
      env: { ...process.env, AGENTBOARD_ROOT: makeProject() },
      capture: browserThat((html) => {
        served = html;
        return `${shot.RUN_PATH}?ok=1`;
      }),
      log: () => {},
    });
    assert.strictEqual(result.file, out);
    assert.ok(fs.existsSync(out));
    assert.ok(served.includes('"openTask(\'T-0007\')"'), 'the snippet has to have been served with the page');
  });

  it('a page that reports a failure loses it, and says why in one line', async () => {
    const out = path.join(tempDir('briefboard-shot-threw-'), 'board.png');
    const said = 'the snippet threw: nope is not defined';
    await assert.rejects(
      () =>
        shot.run({
          argv: ['--eval', 'nope.boom()', '--out', out, '--browser', BROWSER],
          env: { ...process.env, AGENTBOARD_ROOT: makeProject() },
          capture: browserThat(() => `${shot.RUN_PATH}?error=${encodeURIComponent(said)}`),
          log: () => {},
        }),
      (err) => {
        assert.ok(err instanceof shot.CliError, 'a refusal, not a stack');
        assert.match(err.message, /--eval did not take effect/);
        assert.ok(err.message.includes(said), `the reason has to survive: ${err.message}`);
        assert.strictEqual(err.message.split('\n').length, 1, `one line: ${err.message}`);
        return true;
      }
    );
    assert.ok(!fs.existsSync(out), 'a picture of an undisturbed board must not be left behind');
  });

  it('a page that never reports at all is a failure too, not a picture', async () => {
    const out = path.join(tempDir('briefboard-shot-silent-'), 'board.png');
    await assert.rejects(
      () =>
        shot.run({
          argv: ['--click', '#label-filter-btn', '--out', out, '--browser', BROWSER],
          env: { ...process.env, AGENTBOARD_ROOT: makeProject() },
          capture: browserThat(null),
          log: () => {},
        }),
      /--click did not take effect.*never reported/
    );
    assert.ok(!fs.existsSync(out));
  });

  it('and a capture with no snippet is not asked to report anything', async () => {
    const out = path.join(tempDir('briefboard-shot-plain-'), 'board.png');
    const result = await shot.run({
      argv: ['--out', out, '--browser', BROWSER],
      env: { ...process.env, AGENTBOARD_ROOT: makeProject() },
      capture: browserThat(null),
      log: () => {},
    });
    assert.strictEqual(result.file, out);
    assert.ok(fs.existsSync(out), 'the option nobody used cannot fail the runs that never mention it');
  });
});

describe('the option is offered where the others are (T-0281)', () => {
  it('the usage names both spellings and stays one screen', () => {
    const res = runCli(['--help']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /--eval/);
    assert.match(res.stdout, /--click/);
    const lines = res.stdout.replace(/\s+$/, '').split('\n').length;
    assert.ok(lines <= 20, `the usage is ${lines} lines, which is no longer one screen:\n${res.stdout}`);
  });

  it('two ways to say one interaction, and an empty one, are refused', () => {
    for (const argv of [['--eval', 'x', '--click', '#y'], ['--eval', '  '], ['--click', '']]) {
      const res = runCli(argv);
      assert.strictEqual(res.status, 1, `${argv.join(' ')} was accepted`);
      assert.match(res.stderr, /briefboard:/);
      assert.doesNotMatch(res.stderr, /^\s+at /m);
    }
  });
});
