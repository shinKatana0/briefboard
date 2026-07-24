'use strict';

/**
 * agentboard server — zero dependencies (Node >= 18).
 *   /            → ui/index.html
 *   /api/board   → parsed tasks JSON
 *   /api/brief/T-0007-01 → brief file content
 *   /api/task/T-0007/cancel (POST) → narrow backlog|open -> cancelled transition
 *   /events      → SSE stream, pings "changed" when doc/ changes
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseBacklog, nowStamp, updateBacklog, findBriefFile } = require('./parser');

const ROOT = path.resolve(__dirname, '..');
// AGENTBOARD_ROOT lets a single installation serve any project:
//   AGENTBOARD_ROOT=/path/to/project node ~/tools/agentboard/server/server.js
const PROJECT = process.env.AGENTBOARD_ROOT ? path.resolve(process.env.AGENTBOARD_ROOT) : ROOT;
const DOC_DIR = path.join(PROJECT, 'doc');
const BRIEF_DIR = path.join(DOC_DIR, 'brief');
const BACKLOG = path.join(DOC_DIR, 'backlog.md');
const UI_HTML = path.join(ROOT, 'ui', 'index.html');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4571;
// Bind to loopback by default so the board and the writing cancel endpoint are
// not exposed to the LAN without authentication. A public bind is opt-in only,
// via HOST / AGENTBOARD_HOST.
const HOST = process.env.HOST || process.env.AGENTBOARD_HOST || '127.0.0.1';
// Cap on concurrent SSE connections; each open /events request holds a socket
// and a Set entry, so an unbounded Set is a trivial resource-exhaustion vector.
const MAX_SSE_CLIENTS = Number(process.env.MAX_SSE_CLIENTS) || 50;

const TASK_CANCEL_RE = /^\/api\/task\/(T-\d{4})\/cancel$/;

// Hosts we treat as loopback for the "you exposed this to the network" warning.
function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// ---------- SSE ----------
const clients = new Set();

function broadcast() {
  for (const res of clients) res.write('data: changed\n\n');
}

// fs.watch fires bursts of events; debounce a single broadcast across all
// watchers so DOC_DIR and BRIEF_DIR events collapse into one SSE 'changed'.
let timer = null;
function scheduleBroadcast() {
  clearTimeout(timer);
  timer = setTimeout(broadcast, 150);
}

function watchDir(dir, onChange) {
  try {
    return fs.watch(dir, { persistent: true }, onChange);
  } catch (e) {
    console.error(`watch failed for ${dir}: ${e.message}`);
    return null;
  }
}

// The brief directory may not exist when the server starts: a fresh project
// gets its very first brief created at runtime (briefboard init / task brief).
// fs.watch is not reliably recursive across platforms, so watching DOC_DIR
// alone does not catch changes inside doc/brief/. Instead we lazily attach a
// dedicated watcher to BRIEF_DIR the moment it appears, and re-attach if it is
// removed and later recreated. At most one live watcher is held at a time, so
// repeated events never spawn duplicates.
let briefWatcher = null;

function ensureBriefWatch() {
  const exists = fs.existsSync(BRIEF_DIR);
  if (briefWatcher && !exists) {
    // The directory was removed; drop the now-stale watcher so a later
    // recreation re-attaches a fresh one instead of firing on a dead handle.
    try {
      briefWatcher.close();
    } catch {
      /* already closed */
    }
    briefWatcher = null;
    return;
  }
  if (briefWatcher || !exists) return; // already watching, or nothing to watch yet
  briefWatcher = watchDir(BRIEF_DIR, scheduleBroadcast);
  if (briefWatcher) {
    briefWatcher.on('error', () => {
      // A watcher error (e.g. the underlying dir vanished) makes the handle
      // unusable; drop it so ensureBriefWatch() can re-attach it later.
      try {
        briefWatcher.close();
      } catch {
        /* already closed */
      }
      briefWatcher = null;
    });
  }
}

// A change anywhere under doc/ is a board change. It may also be the first
// appearance (or a recreation) of doc/brief/, so reconcile the brief watcher
// before broadcasting.
function onDocEvent() {
  ensureBriefWatch();
  scheduleBroadcast();
}

// ---------- helpers ----------
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ---------- UI HTML cache ----------
// ui/index.html is a static installation asset re-read on every GET / before
// this cache. Keep its bytes in memory and re-read from disk only when the
// file's mtime changes, so repeated page loads don't hit the disk. Correctness
// invariant: statSync(mtimeMs) is cheap and always reflects the current file,
// so an edit is picked up on the very next request (no stale content).
let uiCache = { mtimeMs: -1, body: null };
function readUiHtml() {
  const { mtimeMs } = fs.statSync(UI_HTML);
  if (uiCache.body === null || mtimeMs !== uiCache.mtimeMs) {
    uiCache = { mtimeMs, body: fs.readFileSync(UI_HTML) };
  }
  return uiCache;
}

// ---------- /api/board parse cache ----------
// The parsed board JSON is keyed on the backlog file's mtime+size. As long as
// the file is unchanged, the already-serialized JSON string is reused instead
// of re-reading and re-parsing the file. A change to mtime or size invalidates
// the entry, so the next request re-reads fresh content (no stale board).
let boardCache = { key: null, json: null };
function boardEtag(stat) {
  return `W/"${stat.mtimeMs}-${stat.size}"`;
}
function readBoardJson(stat) {
  const key = boardEtag(stat);
  if (boardCache.json === null || key !== boardCache.key) {
    const text = fs.readFileSync(BACKLOG, 'utf8');
    boardCache = { key, json: JSON.stringify({ tasks: parseBacklog(text), mtime: stat.mtimeMs }) };
  }
  return boardCache.json;
}

// CSRF guard for the only writing endpoint (POST /api/task/:id/cancel). A simple
// cross-site form POST does not trigger a preflight, so without this check any
// site open in the user's browser could cancel tasks. We compare the request's
// declared origin host against the Host header (both include the port, so we
// compare host:port). The scheme (http/https) is intentionally NOT compared: it
// can differ behind a reverse proxy, and for CSRF the host is what matters.
// Non-browser clients (curl, the CLI, the test suite) send neither Origin nor
// Referer and are allowed through; a cross-site browser POST always carries an
// Origin, so it is rejected.
function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false; // HTTP/1.1 mandates Host; be strict for writes
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false; // unparseable Origin → reject
    }
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false; // unparseable Referer → reject
    }
  }
  return true; // neither header → non-browser client, allow
}

// Narrow, single-purpose transition: backlog|open -> cancelled. NOT a generic
// "set status" endpoint - see doc/brief/T-0017-01-drag-cancel.md. The server
// is the source of truth for the precondition check, never the client.
//
// The read, the precondition check and the write all happen inside a single
// updateBacklog() lock, so a concurrent CLI/second-cancel write can't be lost
// (see doc/brief/T-0046-01-backlog-write-lock.md). Precondition failures throw
// out of the mutate callback with an httpStatus tag and leave the file
// untouched; we map that tag back to the same responses as before.
function handleCancelTask(req, res, id) {
  let result;
  try {
    result = updateBacklog(BACKLOG, (tasks) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) {
        const e = new Error(`${id} not found`);
        e.httpStatus = 404;
        throw e;
      }
      if (task.status !== 'backlog' && task.status !== 'open') {
        const e = new Error('task is not in backlog/open, it cannot be cancelled from the UI');
        e.httpStatus = 409;
        throw e;
      }
      task.status = 'cancelled';
      task.closed = nowStamp();
      return { ok: true, id, status: task.status, closed: task.closed };
    });
  } catch (e) {
    if (e.httpStatus) {
      json(res, e.httpStatus, { error: e.message });
      return;
    }
    throw e;
  }
  json(res, 200, result);
}

// ---------- server ----------
const server = http.createServer((req, res) => {
  // req.url comes straight from the client and is not guaranteed to be a
  // parseable URL (e.g. a request line of "GET // HTTP/1.1" yields
  // req.url === "//", which the WHATWG URL parser rejects with a TypeError).
  // That throw would otherwise happen uncaught inside this callback and take
  // down the whole process for every connected client — so it's guarded here.
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    json(res, 400, { error: 'malformed request URL' });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const ui = readUiHtml();
    // ETag over mtime+size lets a browser revalidate with a conditional GET and
    // get a bodyless 304 when the UI hasn't changed.
    const etag = `W/"${ui.mtimeMs}-${ui.body.length}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: etag });
    res.end(ui.body);
    return;
  }

  if (url.pathname === '/api/board') {
    let stat;
    try {
      stat = fs.statSync(BACKLOG);
    } catch {
      json(res, 200, { tasks: [], error: 'doc/backlog.md not found' });
      return;
    }
    // ETag is derived from the file's mtime+size alone, so a matching
    // If-None-Match short-circuits to 304 without reading or parsing the file.
    const etag = boardEtag(stat);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    let body;
    try {
      body = readBoardJson(stat);
    } catch {
      // File vanished between statSync and readFileSync (or became unreadable).
      json(res, 200, { tasks: [], error: 'doc/backlog.md not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag });
    res.end(body);
    return;
  }

  if (url.pathname.startsWith('/api/brief/')) {
    // decodeURIComponent throws URIError on malformed percent-encoding (e.g.
    // a lone "%", "%zz", or a truncated multi-byte UTF-8 escape). That's
    // attacker-controlled input reaching a throwing call inside the request
    // callback — left unguarded it's an unauthenticated one-request DoS that
    // crashes the whole server, not just this request.
    let id;
    try {
      id = decodeURIComponent(url.pathname.slice('/api/brief/'.length));
    } catch (e) {
      if (e instanceof URIError) {
        json(res, 400, { error: 'malformed id' });
        return;
      }
      throw e;
    }
    const file = findBriefFile(BRIEF_DIR, id);
    if (!file) {
      json(res, 404, { error: `Brief ${id} not found in doc/brief/` });
      return;
    }
    json(res, 200, { id, file: path.basename(file), markdown: fs.readFileSync(file, 'utf8') });
    return;
  }

  const cancelMatch = url.pathname.match(TASK_CANCEL_RE);
  if (cancelMatch) {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    // Reject cross-site writes before touching the file (drive-by CSRF).
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'cross-origin request rejected' });
      return;
    }
    handleCancelTask(req, res, cancelMatch[1]);
    return;
  }

  if (url.pathname === '/events') {
    // Bound the number of concurrent SSE clients so a flood of /events
    // connections cannot exhaust sockets/memory.
    if (clients.size >= MAX_SSE_CLIENTS) {
      json(res, 503, { error: 'too many SSE clients' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// Malformed request lines (bad HTTP framing, not just a bad URL/path) are
// rejected by Node's HTTP parser before our request handler ever runs. By
// default that just destroys the socket; log it instead so a flood of
// garbage requests is at least visible, while still not sending a response
// on a connection the parser has already given up on.
server.on('clientError', (err, socket) => {
  console.error(`clientError: ${err.message}`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// Defense-in-depth on top of the point fixes above: the request handler is
// synchronous, so any throw inside it that we failed to anticipate would
// otherwise be an uncaught exception that kills the whole Node process (and
// therefore every connected client) for a single bad request. Log it loudly
// instead of silently swallowing it, and keep the server listening — the
// process itself is otherwise fine, only that one request failed.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (request handler kept running):', err);
});

// Slowloris hardening: bound how long a client may take to send request
// headers / a full request. These apply to receiving the request only and do
// not affect an already-accepted long-lived SSE response.
server.headersTimeout = 10_000;
server.requestTimeout = 20_000;

watchDir(DOC_DIR, onDocEvent);
ensureBriefWatch(); // attach now if doc/brief/ already exists; otherwise lazily on first DOC_DIR event

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log(`agentboard: http://${HOST}:${PORT}`);
  console.log(`bound:      ${addr.address}:${addr.port}`);
  console.log(`watching:   ${BACKLOG}`);
  if (!isLoopbackHost(HOST)) {
    console.warn(
      `WARNING: bound to non-loopback host ${HOST} — the board and the writing ` +
        'cancel endpoint are exposed to the network with no authentication.'
    );
  }
});
