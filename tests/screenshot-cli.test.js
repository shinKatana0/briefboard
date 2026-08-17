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
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { fetch } = require('./helpers/bounded.js');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'screenshot.mjs');

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

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A project with one real task in it, made by the CLI that owns the format.
function makeProject() {
  const root = tmpDir('briefboard-shot-project-');
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
    const dir = tmpDir('briefboard-shot-path-');
    const exe = path.join(dir, 'chromium');
    fs.writeFileSync(exe, '');
    const found = shot.findBrowser([{ file: path.join(dir, 'nothing-here') }, { name: 'chromium' }], {
      PATH: dir,
    });
    assert.strictEqual(found, exe);
  });

  it('nothing installed is a refusal that names where it looked', () => {
    const candidates = [{ file: path.join(tmpDir('briefboard-shot-none-'), 'chrome') }, { name: 'msedge' }];
    assert.strictEqual(shot.findBrowser(candidates, { PATH: '' }), null);
    const message = shot.noBrowserMessage(candidates);
    assert.match(message, /Chrome or Edge/);
    assert.match(message, new RegExp(candidates[0].file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    assert.match(message, /msedge \(on PATH\)/, 'a PATH candidate says so, or the list reads as a lie');
    assert.match(message, /--browser/, 'the way out has to be in the message');
  });

  it('a --browser that is not there fails clearly, with no stack and no board started', () => {
    const missing = path.join(tmpDir('briefboard-shot-missing-'), 'chrome.exe');
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
    const out = path.join(tmpDir('briefboard-shot-out-'), 'board.png');
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
    const out = path.join(tmpDir('briefboard-shot-empty-'), 'board.png');
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
