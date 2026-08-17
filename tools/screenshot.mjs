#!/usr/bin/env node
/**
 * screenshot.mjs — look at the board with your own eyes, from a session that is
 * not allowed to start one (T-0143).
 *
 *   node tools/screenshot.mjs [--lang en|ru|ja] [--width 1400] [--height 900]
 *                             [--out FILE] [--browser PATH]
 *
 * Starts a throwaway board on PORT=auto, captures the page with an installed
 * Chrome or Edge, stops the board, and prints the path of the png — a file the
 * agent can then open and describe.
 *
 * It is the one part of briefboard that needs something installed. That
 * something is a browser, not an npm package: the zero-dependency promise is
 * intact, but a machine without Chrome or Edge cannot run this script, and it
 * says so instead of failing obscurely.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SERVER = path.join(ROOT, 'server', 'server.js');

// The three languages the UI ships, because a visual criterion is usually about
// the longest of them: German-length words in ru and ja are what make a header
// wrap (T-0137, the task this script exists for).
const LANGS = ['en', 'ru', 'ja'];
// A 14" laptop viewport. Every column of the board fits at this width, so a
// layout that breaks here breaks for a person too; narrower is what a wrapping
// criterion asks for, which is why it is an option.
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;

const BOARD_START_MS = 30000;
const BOARD_STOP_MS = 5000;
const BROWSER_MS = 90000;

const USAGE = `usage: node tools/screenshot.mjs [options]

  --lang en|ru|ja   interface language of the capture (default en)
  --width N         viewport width in px (default ${DEFAULT_WIDTH})
  --height N        viewport height in px (default ${DEFAULT_HEIGHT})
  --out FILE        where to write the png (default .briefboard/screenshot-<lang>.png)
  --browser PATH    the Chrome or Edge executable, if it is not where we look
`;

// A failure the user can act on: printed as one line, without a stack. A stack
// here would be noise — nothing about the machine's browser layout is explained
// by our call frames.
class CliError extends Error {}

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        lang: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        out: { type: 'string' },
        browser: { type: 'string' },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new CliError(`${err.message}\n\n${USAGE}`);
  }
  if (values.help) return { help: true };

  const lang = values.lang || 'en';
  if (!LANGS.includes(lang)) {
    throw new CliError(`unknown --lang ${JSON.stringify(lang)}; the UI ships ${LANGS.join(', ')}`);
  }
  const size = (name, fallback) => {
    if (values[name] === undefined) return fallback;
    const n = /^\d+$/.test(values[name]) ? Number(values[name]) : NaN;
    if (!Number.isInteger(n) || n < 200 || n > 10000) {
      throw new CliError(`--${name} must be an integer between 200 and 10000`);
    }
    return n;
  };
  return {
    lang,
    width: size('width', DEFAULT_WIDTH),
    height: size('height', DEFAULT_HEIGHT),
    browser: values.browser,
    out: values.out
      ? path.resolve(values.out)
      : path.join(ROOT, '.briefboard', `screenshot-${lang}.png`),
  };
}

// Where a Chromium-based browser lives, per platform. `{ file }` is an absolute
// path, `{ name }` is looked up on PATH — a browser installed by snap, nix or a
// distribution package is on PATH and nowhere predictable.
function browserCandidates(env = process.env, platform = process.platform) {
  const out = [];
  if (platform === 'win32') {
    for (const dir of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (!dir) continue;
      out.push({ file: path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe') });
      out.push({ file: path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
    }
    out.push({ name: 'chrome.exe' }, { name: 'msedge.exe' });
  } else if (platform === 'darwin') {
    out.push(
      { file: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { file: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { file: '/Applications/Chromium.app/Contents/MacOS/Chromium' }
    );
  } else {
    out.push(
      { name: 'google-chrome' },
      { name: 'google-chrome-stable' },
      { name: 'chromium' },
      { name: 'chromium-browser' },
      { name: 'microsoft-edge' },
      { file: '/snap/bin/chromium' }
    );
  }
  return out;
}

function onPath(name, env = process.env) {
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function findBrowser(candidates = browserCandidates(), env = process.env) {
  for (const candidate of candidates) {
    if (candidate.file && fs.existsSync(candidate.file)) return candidate.file;
    if (candidate.name) {
      const found = onPath(candidate.name, env);
      if (found) return found;
    }
  }
  return null;
}

function describeCandidate(candidate) {
  return candidate.file ? candidate.file : `${candidate.name} (on PATH)`;
}

function noBrowserMessage(candidates) {
  return [
    'no Chrome or Edge found, and the screenshot needs one — it is the only part of',
    'briefboard that requires something installed. Looked at:',
    ...candidates.map((c) => `  ${describeCandidate(c)}`),
    'Install Chrome or Edge, or point the script at it: --browser <path to the executable>',
  ].join('\n');
}

function resolveBrowser(explicit, candidates = browserCandidates()) {
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new CliError(`--browser ${explicit} is not there; give the path of the executable itself`);
    }
    return explicit;
  }
  const found = findBrowser(candidates);
  if (!found) throw new CliError(noBrowserMessage(candidates));
  return found;
}

// PORT=auto (T-0139) is what makes this safe to run while boards are already
// up: the kernel hands out a free port instead of competing for 4571-4590.
// HOST is forced rather than inherited — a screenshot is no reason to expose a
// board with no authentication on a public interface.
function startBoard(env = process.env) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...env, PORT: 'auto', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () => done(reject, new CliError(`the board did not start within ${BOARD_START_MS}ms\n${output}`)),
      BOARD_START_MS
    );
    // The banner prints the port that was actually bound, which with PORT=auto
    // is the only place it exists. The pipe is read here for a second reason
    // too: an unread one fills and blocks the board (T-0124).
    const read = (chunk) => {
      output += chunk;
      const bound = /^bound:\s+.*?:(\d+)\s*$/m.exec(output);
      if (bound) done(resolve, Number(bound[1]));
    };
    proc.stdout.on('data', read);
    proc.stderr.on('data', (chunk) => {
      output += chunk;
    });
    proc.once('exit', (code) =>
      done(reject, new CliError(`the board exited with code ${code} before it was serving\n${output}`))
    );
  });
  return { proc, port };
}

function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve, reject) => {
    const onExit = (code) => {
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      proc.removeListener('exit', onExit);
      reject(new Error(`process ${proc.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once('exit', onExit);
  });
}

async function stopBoard(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
  try {
    await waitForExit(proc, BOARD_STOP_MS);
  } catch {
    proc.kill('SIGKILL');
  }
}

// A headless capture is taken when the page finishes loading, and by then the
// board must be both in the right language and drawn. Two things are added to
// the HTML, and they are the whole difference between this picture and what the
// board serves:
//
//   - the language, because the UI keeps it in localStorage and Chrome's
//     --screenshot takes a URL and nothing else;
//   - an invisible image the proxy answers late, because the columns are filled
//     by a fetch that the load event does not wait for. A pending subresource
//     is the one thing it does wait for.
//
// Not --virtual-time-budget, which is the usual answer to "shoot later":
// measured here, it never fires at all. Virtual time stops while a fetch is
// pending and /events is a stream that stays pending for as long as the board
// is up, so the budget is never spent and the browser hangs (90s, every run).
const SETTLE_PATH = '/__briefboard-settle';
const SETTLE_MS = 1500;
// A 1x1 transparent GIF: the smallest thing an <img> accepts.
const SETTLE_IMAGE = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function injectCapturePreamble(html, lang) {
  const set =
    `<script>try{localStorage.setItem('lang',${JSON.stringify(lang)})}catch(e){}</script>`;
  const head = html.indexOf('<head>');
  if (head === -1) throw new CliError('the board served a page with no <head> to set the language in');
  const withLang = html.slice(0, head + '<head>'.length) + set + html.slice(head + '<head>'.length);
  const settle = `<img src="${SETTLE_PATH}" alt="" style="position:fixed;width:1px;height:1px;opacity:0">`;
  const bodyEnd = withLang.lastIndexOf('</body>');
  if (bodyEnd === -1) return withLang + settle;
  return withLang.slice(0, bodyEnd) + settle + withLang.slice(bodyEnd);
}

// The proxy is up for the seconds a capture takes and must reach the board it
// was started for and nothing else. `new URL(req.url, boardOrigin)` reads like
// that rule and is not it: a request line carries shapes that are not paths, and
// three of them take the base away. Measured against this proxy with a raw
// socket (T-0227, found by the review in T-0213), each of these reached a second
// local server instead of the board:
//
//   GET http://host/evil    absolute-form — the base is ignored outright
//   GET //host/evil         scheme-relative
//   GET /\host/evil         backslash, which WHATWG parses as a slash
//
// The last two begin with a slash, so "the target must start with /" is not the
// fix. The origin has to come from `boardOrigin` alone, with the request
// contributing a path and nothing else — which is what prefixing it with the
// board's own origin does: the authority is already parsed by then, and no shape
// of what follows can move it.
function proxyTargetFor(requestUrl, boardOrigin) {
  if (!requestUrl.startsWith('/')) return null;
  try {
    return new URL(new URL(boardOrigin).origin + requestUrl);
  } catch {
    return null;
  }
}

function startCaptureProxy(boardOrigin, lang) {
  const server = http.createServer((req, res) => {
    if (req.url === SETTLE_PATH) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': SETTLE_IMAGE.length });
        res.end(SETTLE_IMAGE);
      }, SETTLE_MS).unref();
      return;
    }
    const target = proxyTargetFor(req.url, boardOrigin);
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('the capture proxy serves the board it was started for, and only by path\n');
      return;
    }
    const upstream = http.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (from) => {
        if (!/^text\/html/.test(from.headers['content-type'] || '')) {
          res.writeHead(from.statusCode, from.headers);
          from.pipe(res);
          return;
        }
        const chunks = [];
        from.on('data', (chunk) => chunks.push(chunk));
        from.on('end', () => {
          const body = injectCapturePreamble(Buffer.concat(chunks).toString('utf8'), lang);
          const headers = { ...from.headers };
          // The body is no longer the one these describe, and it is re-framed
          // here as one buffer — a `transfer-encoding: chunked` left in place
          // beside the content-length below is a response no HTTP client
          // accepts (Chrome tolerated it; undici, correctly, does not).
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          delete headers.etag;
          res.writeHead(from.statusCode, { ...headers, 'content-length': Buffer.byteLength(body) });
          res.end(body);
        });
      }
    );
    // /api/events is a stream that only ends when one side goes away, and the
    // capture ends by taking both away — so an error here is the normal way a
    // proxied request finishes, not a reason to bring the script down.
    upstream.on('error', (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`board unreachable: ${err.message}`);
    });
    res.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        // /api/events is an open stream that never ends on its own, so the
        // close has to take the sockets with it.
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

async function capture({ browser, url, out, width, height }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-shot-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    url,
  ];
  // Chrome refuses to start as root without it, which is the ordinary case in a
  // container. The only page it opens is the board we just started on loopback.
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  const proc = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let noise = '';
  proc.stdout.on('data', (chunk) => {
    noise += chunk;
  });
  proc.stderr.on('data', (chunk) => {
    noise += chunk;
  });
  try {
    await waitForExit(proc, BROWSER_MS);
  } catch (err) {
    proc.kill('SIGKILL');
    throw new CliError(`${path.basename(browser)} did not finish: ${err.message}`);
  } finally {
    // Measured on Windows 11: a just-exited Chrome still holds handles inside
    // its profile and the removal fails with EPERM even with `force`. A
    // leftover directory in the system temp is not worth failing a capture for.
    //
    // One attempt, and no `maxRetries`: measured in T-0195, that option throws
    // EPERM after 1 ms and spends none of the budget it names. What would work
    // is polling until the directory is gone (tests/helpers/rm.js does it for
    // teardowns), and it is not worth it here — the capture is finished by this
    // point, so the only thing a poll could buy is tidiness in the system temp,
    // paid for by making every run on Windows wait for it.
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the OS will collect it */
    }
  }
  if (!fs.existsSync(out)) {
    throw new CliError(`${path.basename(browser)} wrote no image to ${out}\n${noise.trim().slice(-2000)}`);
  }
}

async function run({
  argv = process.argv.slice(2),
  env = process.env,
  capture: takeShot = capture,
  log = console.log,
} = {}) {
  const opts = parseOptions(argv);
  if (opts.help) {
    log(USAGE);
    return null;
  }
  // Before the board, not after: a missing browser is the one failure that
  // makes everything else pointless, and it costs nothing to find out first.
  const browser = resolveBrowser(opts.browser, browserCandidates(env));

  const board = startBoard(env);
  let result;
  try {
    const port = await board.port;
    const proxy = await startCaptureProxy(`http://127.0.0.1:${port}/`, opts.lang);
    try {
      await takeShot({
        browser,
        url: proxy.url,
        out: opts.out,
        width: opts.width,
        height: opts.height,
      });
    } finally {
      await proxy.close();
    }
    result = { file: opts.out, port, lang: opts.lang, width: opts.width, height: opts.height };
  } finally {
    await stopBoard(board.proc);
  }
  log(`briefboard: captured the board at ${opts.width}x${opts.height}, lang=${opts.lang}`);
  log(result.file);
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  run().catch((err) => {
    if (err instanceof CliError) {
      console.error(`briefboard: ${err.message}`);
    } else {
      console.error(`briefboard: ${err.stack || err.message}`);
    }
    process.exit(1);
  });
}

export {
  CliError,
  LANGS,
  browserCandidates,
  findBrowser,
  noBrowserMessage,
  injectCapturePreamble,
  proxyTargetFor,
  startCaptureProxy,
  run,
};
