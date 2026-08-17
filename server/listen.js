'use strict';

/**
 * Port selection for the board's HTTP server (T-0078).
 *
 * briefboard is installed per project, so several boards run side by side and
 * every one of them defaults to 4571. An occupied default must therefore step
 * aside instead of killing the process — while an explicitly requested port
 * must not: serving a different port than the one a human asked for is worse
 * than refusing to start.
 */

const net = require('node:net');
const { isLoopbackHost } = require('./loopback');

const DEFAULT_PORT = 4571;
// 4571..4590 — enough for the boards a person runs at once, and a range small
// enough that "all taken" is reported in milliseconds rather than scanned for.
// It is not enough for machines: four test suites in parallel exhausted it
// (T-0139), and no larger number would have held either. Whoever needs a port
// rather than a memorable address asks for AUTO_PORT_VALUE instead.
const FALLBACK_ATTEMPTS = 20;
const MIN_PORT = 1;
const MAX_PORT = 65535;
// PORT=auto: bind port 0 and let the kernel hand out a free one. The scan above
// exists so a human finds the board where they expect it; a caller that only
// needs a working port takes this and reads the actual number off the banner,
// which prints server.address() (T-0078). Spelled as a word because PORT=0
// cannot mean it: an explicitly set PORT is honoured or refused, and 0 is not a
// port a bind can be honoured on.
const AUTO_PORT_VALUE = 'auto';
const AUTO_PORT = 0;
// localhost resolves to either address, so owning one of them leaves the other
// for whoever asks next (T-0130).
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

// Number('abc') is NaN, and listen(NaN) picks a random free port — an explicit
// PORT with a typo in it would silently behave like no PORT at all.
function parsePort(value) {
  const text = String(value == null ? '' : value).trim();
  if (text.toLowerCase() === AUTO_PORT_VALUE) return AUTO_PORT;
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `invalid port ${JSON.stringify(text)}: expected an integer ${MIN_PORT}-${MAX_PORT} ` +
        `or ${JSON.stringify(AUTO_PORT_VALUE)}`
    );
  }
  return port;
}

// Ports to try, in order. An explicit request gets exactly one attempt, and so
// does "any free port": there is nothing to fall back to when the kernel itself
// says no.
function portCandidates(port, explicit, attempts = FALLBACK_ATTEMPTS) {
  if (explicit || port === AUTO_PORT) return [port];
  const out = [];
  for (let p = port; p < port + attempts && p <= MAX_PORT; p++) out.push(p);
  return out;
}

// Windows keeps ranges of TCP ports for Hyper-V, WSL and services: on the
// machine where this surfaced `netsh interface ipv4 show excludedportrange
// protocol=tcp` reported 50000-50059, and the ranges differ per machine. A bind
// inside one fails with EACCES, not EADDRINUSE — but to someone who asked for
// "any free port" such a port is as unavailable as an occupied one (T-0100).
const SKIPPABLE_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);

function accessDeniedMessage(port, platform = process.platform) {
  const hint =
    platform === 'win32'
      ? 'on Windows this is usually a system-reserved range — check: ' +
        'netsh interface ipv4 show excludedportrange protocol=tcp'
      : 'ports below 1024 require elevated privileges';
  return `port ${port} is not available to this process (EACCES); ${hint}`;
}

function accessDeniedError(port, cause) {
  const e = new Error(accessDeniedMessage(port), { cause });
  e.code = 'EACCES';
  e.port = port;
  return e;
}

// Resolves with the errno of a failed listen(), or null once it is listening.
function tryListen(server, port, host) {
  return new Promise((resolve) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      resolve(err.code || 'UNKNOWN');
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

// Measured on Windows 11 / node 24: while this process holds 0.0.0.0:P (or
// :::P), a bind of 127.0.0.1:P succeeds — here and in any other process. So a
// board that started later took localhost from a public board already running,
// and the public one went on printing a port that answered somebody else
// (T-0133, 5 runs out of 5). On POSIX that bind gives EADDRINUSE: the wildcard
// socket owns loopback and cannot lose it, so there is nothing to hold there.
//
// Asked by binding rather than of process.platform, and asked about the very
// host the board binds — HOST=:: is as legal as HOST=0.0.0.0. The answer is a
// property of the platform, so it is measured once per host.
const shadowable = new Map();
function canLoopbackBeTakenFrom(host) {
  if (!shadowable.has(host)) {
    shadowable.set(
      host,
      (async () => {
        const wildcard = net.createServer();
        if (await tryListen(wildcard, 0, host)) return false;
        const rival = net.createServer();
        const code = await tryListen(rival, wildcard.address().port, LOOPBACK_HOSTS[0]);
        await closeServer(rival);
        await closeServer(wildcard);
        return code === null;
      })()
    );
  }
  return shadowable.get(host);
}

// Takes `port` on every loopback address with a socket that serves this board,
// so http://localhost:port answers it and whoever comes later is refused by the
// kernel. Answers with the sockets taken and the addresses that could not be
// taken because another process already answers there.
//
// This replaces asking whether the addresses are free (T-0127/T-0130). A
// question answers about the past — between it and the bind everything can
// change — while a held socket answers about the present and goes on answering
// everyone who arrives afterwards.
async function ownLoopbackAddresses(port, createServer, hosts = LOOPBACK_HOSTS) {
  const held = [];
  const heldHosts = [];
  const takenByOthers = [];
  for (const host of hosts) {
    const server = createServer();
    const code = await tryListen(server, port, host);
    if (code === null) {
      held.push(server);
      heldHosts.push(host);
      continue;
    }
    await closeServer(server);
    // Occupied means EADDRINUSE and nothing else. A machine without IPv6
    // answers the ::1 bind with EADDRNOTAVAIL (EAFNOSUPPORT on some
    // configurations) — "no such address here"; counting that as occupied would
    // reject all 20 candidates and leave the board unable to start at all.
    if (code === 'EADDRINUSE') takenByOthers.push(host);
  }
  return { held, heldHosts, takenByOthers };
}

// Two different situations, and the warning that fits one is false in the other
// (T-0135): either no loopback address is ours, or one of them is and the
// neighbour has the other. Said from the bind results alone — which address a
// client ends up at is the resolver's business, and a warning that predicted it
// per platform is exactly what turned out to be wrong.
function loopbackShadowMessage(port, hosts, heldHosts = []) {
  const theirs = hosts.join(' and ');
  if (!heldHosts.length) {
    return (
      `WARNING: port ${port} is already served on ${theirs} by another process — ` +
      `http://localhost:${port} opens that one, not this board. This board is reachable ` +
      'only at the address it is bound to; use a different port to own localhost too.'
    );
  }
  const ours = heldHosts.map((host) => `${host}:${port}`).join(' and ');
  return (
    `WARNING: port ${port} is also served on ${theirs} by another process; this board ` +
    `holds ${ours} — http://localhost:${port} reaches whichever address the client ` +
    'resolves localhost to, so some clients may open that process instead of this ' +
    'board. Use a different port to own localhost alone.'
  );
}

function inUseError(ports) {
  const e = new Error(
    ports.length === 1
      ? `port ${ports[0]} is already in use`
      : `no free port in ${ports[0]}-${ports[ports.length - 1]} (all in use)`
  );
  e.code = 'EADDRINUSE';
  return e;
}

// The scan tried everything: say whether the ports were merely busy or partly
// unusable, so nobody hunts for a neighbour holding twenty ports at once.
function exhaustedError(ports, codes) {
  const unusable = codes.find((code) => code !== 'EADDRINUSE');
  if (!unusable) return inUseError(ports);
  const e = new Error(
    `no usable port in ${ports[0]}-${ports[ports.length - 1]} ` +
      '(in use, or reserved by the system)'
  );
  e.code = unusable;
  return e;
}

// Binds `server` to the first usable port of `ports`, resolving with
// server.address() plus `loopbackServers` (the extra sockets holding localhost,
// which the caller must close together with `server`), `loopbackShadowedBy`
// (the loopback addresses another process already answers on) and
// `loopbackHeldOn` (the ones this board took). The caller must
// print the port from here, not the requested one. A single candidate is an
// explicitly requested port: it is honoured or refused, never swapped, so every
// failure reaches the caller. A longer list is a scan, where an unusable
// candidate only means "try the next one".
//
// `createServer` produces those extra sockets and must serve the same requests
// as `server` — a public bind without one would print a localhost URL it does
// not own, which is the bug this exists for. `canShadow` and `loopbackHosts`
// are injectable because neither platform semantics nor a machine without IPv6
// can be staged.
function listenWithFallback(
  server,
  host,
  ports,
  { createServer = null, canShadow = canLoopbackBeTakenFrom, loopbackHosts = LOOPBACK_HOSTS } = {}
) {
  const queue = ports.slice();
  if (!queue.length) return Promise.reject(new Error('no port to listen on'));
  // A loopback bind cannot lose localhost: the address it holds is localhost.
  const holdLoopback = !isLoopbackHost(host);
  if (holdLoopback && !createServer) {
    return Promise.reject(new Error(`a bind to ${host} needs createServer to hold localhost too`));
  }
  const explicit = ports.length === 1;
  const failures = [];
  return new Promise((resolve, reject) => {
    const step = () => {
      const port = queue.shift();
      // A failed listen() leaves the server unbound and reusable, so the next
      // attempt is another listen() on the same object; so does a close().
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (explicit) {
          if (err.code === 'EADDRINUSE') reject(inUseError(ports));
          else if (err.code === 'EACCES') reject(accessDeniedError(port, err));
          else {
            err.port = port;
            reject(err);
          }
          return;
        }
        if (!SKIPPABLE_CODES.has(err.code)) {
          err.port = port;
          reject(err);
          return;
        }
        failures.push(err.code);
        if (queue.length) {
          step();
          return;
        }
        reject(exhaustedError(ports, failures));
      };
      const adopt = async () => {
        server.removeListener('error', onError);
        if (!holdLoopback || !(await canShadow(host))) {
          resolve({
            ...server.address(),
            loopbackShadowedBy: [],
            loopbackHeldOn: [],
            loopbackServers: [],
          });
          return;
        }
        // The port that was bound, not the one asked for: with AUTO_PORT they
        // differ, and holding localhost on port 0 would hold two more random
        // ports instead of this board's own.
        const { held, heldHosts, takenByOthers } = await ownLoopbackAddresses(
          server.address().port,
          createServer,
          loopbackHosts
        );
        // A scan promised "the next free port", and a port whose localhost
        // belongs to somebody else is not free in the sense that was promised —
        // the same line T-0100 drew for a port the system reserves. An explicit
        // port is still bound: serving other interfaces while localhost belongs
        // elsewhere can be deliberate, so that case is warned about (T-0132).
        if (takenByOthers.length && !explicit) {
          await Promise.all([server, ...held].map(closeServer));
          failures.push('EADDRINUSE');
          if (queue.length) {
            step();
            return;
          }
          reject(exhaustedError(ports, failures));
          return;
        }
        resolve({
          ...server.address(),
          loopbackShadowedBy: takenByOthers,
          loopbackHeldOn: heldHosts,
          loopbackServers: held,
        });
      };
      const onListening = () => {
        adopt().catch(reject);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    step();
  });
}

module.exports = {
  AUTO_PORT,
  AUTO_PORT_VALUE,
  DEFAULT_PORT,
  FALLBACK_ATTEMPTS,
  MAX_PORT,
  accessDeniedMessage,
  canLoopbackBeTakenFrom,
  loopbackShadowMessage,
  ownLoopbackAddresses,
  parsePort,
  portCandidates,
  listenWithFallback,
};
