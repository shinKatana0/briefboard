#!/usr/bin/env node
/**
 * screenshot.mjs — look at the board with your own eyes, from a session that is
 * not allowed to start one (T-0143).
 *
 *   node tools/screenshot.mjs [--lang en|ru|ja] [--width 1400] [--height 900]
 *                             [--out FILE] [--browser PATH]
 *                             [--eval JS | --click SELECTOR]
 *
 * Starts a throwaway board on PORT=auto, captures the page with an installed
 * Chrome or Edge, stops the board, and prints the path of the png — a file the
 * agent can then open and describe.
 *
 * --eval/--click reach what only exists after an interaction — a card's dialog,
 * the label popover, the new-task form (T-0281). Everything about running them
 * safely is in the comment above captureRunnerSource.
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
  --eval JS         run JS in the page once the board has drawn, and capture
                    what it opened: --eval "openTask('T-0007')"
  --click SELECTOR  the same for one click: --click "#label-filter-btn"
                    Either fails the run, and keeps no picture, if it throws or
                    leaves the page unchanged.
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
        eval: { type: 'string' },
        click: { type: 'string' },
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
  // One interaction, not a script: the two options are two spellings of the
  // same slot, and passing both would leave the order between them to be
  // guessed. Driving a sequence is deliberately out of scope (T-0281).
  if (values.eval !== undefined && values.click !== undefined) {
    throw new CliError('--eval and --click are two ways to say the same thing; give one of them');
  }
  for (const name of ['eval', 'click']) {
    if (values[name] !== undefined && !values[name].trim()) {
      throw new CliError(`--${name} is empty; leave it out to capture the board as it loads`);
    }
  }
  const snippet =
    values.eval !== undefined
      ? { flag: '--eval', source: values.eval }
      : values.click !== undefined
        ? { flag: '--click', source: clickSnippet(values.click) }
        : null;

  return {
    lang,
    snippet,
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

// Where the page says the snippet is done. Only requested when there is one, so
// a plain capture is the same sequence of requests it always was.
const RUN_PATH = '/__briefboard-ran';
// The board draws from a fetch, so its first paint is a burst of DOM mutations
// after DOMContentLoaded; this much quiet after one means it has finished.
const DRAW_QUIET_MS = 250;
// If no mutation ever comes the snippet runs anyway rather than failing on a
// board that drew instantly — the "changed nothing" check below is what still
// catches a snippet that hit an empty board.
const DRAW_MS = 15000;
// How long the snippet's effect has to reach the DOM. Everything the board
// opens is built synchronously, so this is a ceiling, not a wait.
const EFFECT_MS = 1500;

// The whole risk of --eval is running too early: `openTask('T-0007')` finds
// nothing while the columns are still empty, and the picture that comes out is
// of an undisturbed board, which reads as "the dialog looks fine". So the page
// decides when to run it, and says so:
//
//   - it waits for the board's own render — mutations, then DRAW_QUIET_MS of
//     none — not merely for DOMContentLoaded, which is before the fetch;
//   - it reports back, and the settle image is held until it does, so the load
//     event (and with it Chrome's --screenshot) cannot fire early;
//   - a snippet that throws is a failure, and so is one that leaves the DOM
//     untouched. The second is what makes `openTask('T-9999')` fail: the board
//     answers an id it does not have by doing nothing at all, and a picture of
//     that is evidence of the wrong thing.
//
// The snippet runs through indirect eval, in the page's global scope, which is
// where the board's own `openTask` and `render` live (one classic script, no
// module). The board sends no CSP, so nothing blocks it.
function captureRunnerSource(snippet, { drawMs = DRAW_MS, quietMs = DRAW_QUIET_MS, effectMs = EFFECT_MS } = {}) {
  return `(function(){
  var src=${JSON.stringify(snippet)},seen=0,last=0,told=0;
  function tell(q){try{fetch(${JSON.stringify(RUN_PATH)}+'?'+q)}catch(e){}}
  function done(err){
    if(told)return;told=1;
    tell(err?'error='+encodeURIComponent(String(err).split('\\n')[0].slice(0,300)):'ok=1');
  }
  var obs=new MutationObserver(function(){seen++;last=Date.now()});
  function drawn(){
    obs.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    var deadline=Date.now()+${drawMs};
    var poll=setInterval(function(){
      var now=Date.now();
      if((seen&&now-last>=${quietMs})||now>=deadline){clearInterval(poll);fire()}
    },50);
  }
  function fire(){
    var before=seen;
    try{(0,eval)(src)}catch(e){obs.disconnect();done('the snippet threw: '+((e&&e.message)||e));return}
    var deadline=Date.now()+${effectMs};
    var poll=setInterval(function(){
      if(seen>before){clearInterval(poll);obs.disconnect();done(0);return}
      if(Date.now()>=deadline){
        clearInterval(poll);obs.disconnect();
        done('the snippet ran and changed nothing on the page: '+src);
      }
    },25);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',drawn);else drawn();
})()`;
}

// --click is sugar over --eval and nothing more, which is why it is a snippet
// rather than a second path through the runner. It refuses to be silent about a
// selector that matched nothing, where `querySelector(...)?.click()` would not.
function clickSnippet(selector) {
  return (
    `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
    `if(!el)throw new Error('no element matches ' + ${JSON.stringify(selector)});` +
    `el.click()})()`
  );
}

function injectCapturePreamble(html, lang, snippet = null) {
  const set =
    `<script>try{localStorage.setItem('lang',${JSON.stringify(lang)})}catch(e){}</script>`;
  const head = html.indexOf('<head>');
  if (head === -1) throw new CliError('the board served a page with no <head> to set the language in');
  const withLang = html.slice(0, head + '<head>'.length) + set + html.slice(head + '<head>'.length);
  // `</script>` inside a snippet would end this script tag and spill the rest
  // into the document as text; the parser looks for that byte sequence and does
  // not care that it is inside a JS string.
  const runner = snippet
    ? `<script>${captureRunnerSource(snippet).replace(/<\/script/gi, '<\\/script')}</script>`
    : '';
  const settle = `<img src="${SETTLE_PATH}" alt="" style="position:fixed;width:1px;height:1px;opacity:0">`;
  const bodyEnd = withLang.lastIndexOf('</body>');
  if (bodyEnd === -1) return withLang + runner + settle;
  return withLang.slice(0, bodyEnd) + runner + settle + withLang.slice(bodyEnd);
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

// A page that never reports back would hold the settle image, and with it the
// load event, until Chrome's own BROWSER_MS — 90 s of nothing. This is the same
// failure, found in a tenth of the time and with a message that says which part
// went quiet.
const RUN_REPORT_MS = 30000;

function startCaptureProxy(boardOrigin, lang, snippet = null) {
  // With no snippet there is nothing to wait for and nothing that can fail, so
  // the settle image is answered on its old timer and the run has its old
  // result before it starts.
  let outcome = snippet ? null : { ok: true };
  const waiting = [];
  let giveUp = null;

  const sendSettle = (res, delayMs) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': SETTLE_IMAGE.length });
      res.end(SETTLE_IMAGE);
    }, delayMs).unref();
  };
  // A failed snippet gets no settling time: the picture is thrown away anyway,
  // and the only thing left to do is let the browser finish and exit.
  const settleDelay = () => (outcome && outcome.ok ? SETTLE_MS : 0);
  const finish = (result) => {
    if (outcome) return;
    outcome = result;
    if (giveUp) clearTimeout(giveUp);
    while (waiting.length) sendSettle(waiting.pop(), settleDelay());
  };

  const server = http.createServer((req, res) => {
    if (req.url === SETTLE_PATH) {
      if (outcome) {
        sendSettle(res, settleDelay());
        return;
      }
      waiting.push(res);
      giveUp ||= setTimeout(
        () => finish({ ok: false, error: `the page never reported that the snippet had run (${RUN_REPORT_MS}ms)` }),
        RUN_REPORT_MS
      ).unref();
      return;
    }
    if (req.url === RUN_PATH || req.url.startsWith(`${RUN_PATH}?`)) {
      const query = new URLSearchParams(req.url.slice(RUN_PATH.length + 1));
      const error = query.get('error');
      finish(error ? { ok: false, error } : { ok: true });
      res.writeHead(204);
      res.end();
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
          const body = injectCapturePreamble(
            Buffer.concat(chunks).toString('utf8'),
            lang,
            snippet ? snippet.source : null
          );
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
        // null while the page has not spoken — which after a capture means it
        // never did, and is a failure of its own.
        snippetResult: () => outcome,
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

// A browser that has just gone can still hold handles inside its profile, and
// the removal then fails with EPERM even with `force`. One attempt was the old
// answer, on the grounds that a poll would make every capture wait for tidiness
// it does not need. Remeasured for T-0265 on 2026-08-17 (Windows 11, node
// v24.18.0, Chrome 151.0.7922.138), over the two ways a capture ends:
//
//   the browser finished by itself   22 captures, held 0 times, one attempt each
//                                    (10 idle, 12 under four concurrent captures)
//   the browser had to be killed     20 runs, held 13 times, EPERM every time,
//                                    and gone on a retry in all 13: 2-14
//                                    attempts, 104-518 ms
//
// So the poll costs an ordinary capture nothing — it never loops — and the case
// it recovers is the one that produced the whole leak: the three profiles found
// standing in %TEMP% had each lived 91 s, which is BROWSER_MS, so all three are
// the timeout path below removing a Chrome's profile a millisecond after
// SIGKILLing it.
//
// 2 s is about four times the longest wait measured, and it is spent after the
// picture is written, on a capture that has already failed. It is not
// tests/helpers/rm.js, which waits the same way for teardowns: this file is
// shipped to users in the npm package and a test helper is not.
const PROFILE_RM_BUDGET_MS = 2000;
const PROFILE_RM_POLL_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rmTree = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// Answers whether the directory is gone rather than throwing: a temporary
// directory that will not go is not worth failing a finished capture for. `rm`
// is injectable because the EPERM this waits out only happens on Windows, and
// the waiting has to be testable where it does not (tests/screenshot-cli.test.js).
async function removeProfile(profile, { budgetMs = PROFILE_RM_BUDGET_MS, rm = rmTree } = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      rm(profile);
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await sleep(PROFILE_RM_POLL_MS);
    }
  }
}

// Every profile this process has made and not yet got rid of. The removal in
// capture()'s `finally` below is the normal path and covers a capture that
// failed or threw; this set is for the endings that never reach a `finally` at
// all, and installProfileCleanup is where it is read.
const liveProfiles = new Set();

// A hard kill is not one of those endings and cannot be made into one. Measured
// 2026-08-17 (Windows 11, node v24.18.0): a process killed with
// `process.kill(pid,'SIGINT')`, with 'SIGTERM' or with `taskkill /t /f` ran none
// of its handlers in all three cases — the process is terminated outright, and
// on Windows that is every kill there is. So a capture killed that way leaves
// its `briefboard-shot-` profile standing, and nothing in this file can change
// it. The wrapper next door solved the same leak by having no artifact at all
// (T-0276); that is closed to a screenshot, because Chrome must be handed a real
// `--user-data-dir`. What is below narrows the leak; it does not close it.
function installProfileCleanup() {
  // `exit` covers every way this process can still act on its own end —
  // measured on node v24.18.0: the normal end, `process.exit`, a throw, a throw
  // out of a timer, an unhandled rejection. It must be synchronous, so it is a
  // bare rmSync and not removeProfile's poll: a hook cannot await, and by the
  // time one is reached the poll has already had whatever chance it was going
  // to get.
  process.on('exit', () => {
    for (const profile of liveProfiles) {
      try {
        rmTree(profile);
      } catch {
        /* the process is on its way out; there is nobody left to tell */
      }
    }
  });
  // A signal is not covered by that hook: unhandled it is fatal on the spot and
  // no handler of ours runs, and handled the process has to end itself for the
  // hook to be reached. 128+n is the shell's own code for "killed by this
  // signal", so a capture ended here still looks to its caller like one that
  // never listened. Unreachable on Windows, per the measurement above.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => process.exit(128 + (os.constants.signals[signal] || 0)));
  }
}

// One line naming the path and the reason, because a wrong --browser is fixable
// from the message alone and nothing about it is explained by our call frames.
function unstartableMessage(browser, err) {
  return `${browser} could not be started: ${err.code || err.message} — check that it is the browser executable itself`;
}

// A spawn that never happens reaches us in two shapes, and only one of them is
// an event. Measured on node v24.18.0 (Windows 11): a path that is not a program
// at all throws out of spawn() synchronously — EFTYPE for a .json, UNKNOWN for a
// .exe that is not one — while ENOENT, EACCES, EAGAIN, EMFILE and ENFILE arrive
// later as an 'error' event on the child. Neither shape ever produces an 'exit',
// so waiting for one would only spend BROWSER_MS. This is the synchronous half;
// capture() listens for the other.
function spawnBrowser(browser, args) {
  try {
    return spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new CliError(unstartableMessage(browser, err));
  }
}

async function capture({ browser, url, out, width, height }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'briefboard-shot-'));
  liveProfiles.add(profile);
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
  let noise = '';
  try {
    const proc = spawnBrowser(browser, args);
    proc.stdout.on('data', (chunk) => {
      noise += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      noise += chunk;
    });
    // The other half of the two shapes above, and the reason spawnBrowser covers
    // only one of them: an 'error' with no listener on a ChildProcess is thrown
    // by node itself, so without this the stack lands on the user (T-0288).
    const failedToStart = new Promise((_, reject) => {
      proc.once('error', (err) => reject(new CliError(unstartableMessage(browser, err))));
    });
    try {
      await Promise.race([waitForExit(proc, BROWSER_MS), failedToStart]);
    } catch (err) {
      // A browser that never started is a different ending from one that started
      // and would not stop: there is no process to kill, and "did not finish"
      // would name the wrong one. Its own message is already written.
      if (err instanceof CliError) throw err;
      proc.kill('SIGKILL');
      throw new CliError(`${path.basename(browser)} did not finish: ${err.message}`);
    }
  } finally {
    // Polled, not attempted once, and never `maxRetries`: measured in T-0195,
    // that option throws EPERM after 1 ms and spends none of the budget it
    // names. The measurement the poll rests on is above removeProfile.
    //
    // Dropped from the set only once it is really gone: a profile the budget ran
    // out on is still there, and the exit hook is the one attempt left.
    if (await removeProfile(profile)) liveProfiles.delete(profile);
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
    const proxy = await startCaptureProxy(`http://127.0.0.1:${port}/`, opts.lang, opts.snippet);
    let ran;
    try {
      await takeShot({
        browser,
        url: proxy.url,
        out: opts.out,
        width: opts.width,
        height: opts.height,
      });
    } finally {
      ran = proxy.snippetResult();
      await proxy.close();
    }
    // The picture is removed rather than kept with a warning: what it shows is
    // a board the instruction never reached, and a file like that is read later
    // as evidence of whatever it was asked for (T-0281).
    if (opts.snippet && !(ran && ran.ok)) {
      fs.rmSync(opts.out, { force: true });
      const why = (ran && ran.error) || 'the page never reported that the snippet had run';
      throw new CliError(`${opts.snippet.flag} did not take effect, so no picture was kept: ${why}`);
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
  // Only when this file IS the script. Imported, it is a guest in somebody
  // else's process, and a SIGINT handler installed there would swallow the
  // Ctrl-C that stops its owner — in the test suite, the one that stops the run.
  installProfileCleanup();
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
  captureRunnerSource,
  clickSnippet,
  findBrowser,
  noBrowserMessage,
  injectCapturePreamble,
  RUN_PATH,
  SETTLE_PATH,
  proxyTargetFor,
  removeProfile,
  startCaptureProxy,
  run,
};
