'use strict';

// Where a test gets a running board — and why it no longer picks the port
// itself (T-0123).
//
// The old habit, copied into a dozen files, was: bind port 0, read the number
// back, CLOSE the socket, and hand the number to a server that binds it
// milliseconds later, in another process. Between the close and that bind the
// port belongs to nobody, and `node --test` runs the files in parallel — a
// second file took the same number and the board died with "port 62508 is
// already in use. PORT was set explicitly, so the board does not move to
// another port".
//
// So the port is not chosen in advance any more. The server is started with
// PORT=auto, binds port 0 and lets the kernel hand out a free one (atomically,
// leaving no window), and the actual port is read from its start-up banner —
// which prints server.address(), not the requested port, for exactly this kind
// of reason (T-0078). PORT=0 is not the way to ask for that: an explicit PORT
// is honoured or refused, and 0 is not a valid port — hence the word.
//
// PORT=auto rather than no PORT at all (T-0139): an empty PORT starts the scan
// from 4571, and 20 ports are not enough for machines. Four suites at once
// exhausted the range and killed four boards with "no free port in 4571-4590".
// The range belongs to the human running boards by hand; a test needs any port,
// not a memorable one, so it must not compete for that range.
//
// A public bind (HOST=0.0.0.0) goes the same way. It used to be the exception,
// because on Windows another board could take 127.0.0.1 on the same port and
// answer in its place; since T-0133 a public bind holds the loopback addresses
// itself, so the port it prints is its own.
//
// freePort() and occupyPort() stay for the tests whose subject IS the port — an
// explicitly requested one, an occupied one. There the window is part of the
// scenario being checked.

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { waitUntilReady, waitForExit, stopProcess } = require('./bounded.js');
const { SPAWN_WAIT_BUDGET_MS } = require('./wait.js');
const { AUTO_PORT_VALUE } = require('../../server/listen.js');

const HOST = '127.0.0.1';
const SERVER_PATH = path.join(__dirname, '..', '..', 'server', 'server.js');
// Spawning a node process and waiting for its first line of output IS what
// SPAWN_WAIT_BUDGET_MS measures, so this is that number and not one of its own.
// The 15 s it used to be was already under the load the suite makes for itself:
// measured over 1308 boards under four concurrent suites (2026-08-17, the run
// described in helpers/bounded.js), the banner took p50 10.4 s, p99 14.7 s and
// max 18.3 s — past the budget, and the failure would have read "server did not
// start", which is the one thing that had not happened (T-0223).
const BANNER_TIMEOUT_MS = SPAWN_WAIT_BUDGET_MS;
// The banner's first line carries the bound port; `sessions:` is its last one.
const BANNER_URL_RE = /briefboard: http:\/\/[^\s:]+:(\d+)/;
const BANNER_END_RE = /\nsessions: /;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A free port number, released again before it is returned. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A port genuinely held by a socket, so "taken" is real and not simulated.
 * The caller closes it: `const { port, close } = await occupyPort()`.
 */
function occupyPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, HOST, () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      })
    );
  });
}

/**
 * Resolves with the port from the start-up banner — the one the process really
 * bound. `read()` returns the output collected so far, as { stdout, stderr }.
 * Also used by the tests that spawn the board through the CLI.
 */
async function waitForBanner(proc, read, timeoutMs = BANNER_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Awaited because this is a wait's condition: `read` is handed in, and an
    // async one would destructure to the defaults forever (T-0189, T-0223).
    const { stdout = '', stderr = '' } = await read();
    const m = stdout.match(BANNER_URL_RE);
    // Wait for the last banner line too, or a test may read stdout before the
    // rest of it has arrived.
    if (m && BANNER_END_RE.test(stdout)) return Number(m[1]);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`server exited early code ${proc.exitCode}, stderr: ${stderr}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`server did not start within ${timeoutMs}ms; stdout: ${stdout} stderr: ${stderr}`);
    }
    await sleep(50);
  }
}

/**
 * Spawns a real `node server/server.js` against a throwaway AGENTBOARD_ROOT and
 * waits until it answers HTTP. `env` is merged last, so a test that needs an
 * explicit PORT can still set one — most must not (see the note above).
 *
 * The watchdog is off unless a test asks for it (T-0159). It runs git against
 * the project on its own timer, and a git process holds that directory as its
 * cwd for as long as it runs — on Windows a directory that is some process's cwd
 * cannot be removed, so a test that stopped its board and deleted its temp
 * project failed with EPERM in the cleanup, having proved nothing about the
 * watchdog either way. The tests whose subject IS the watchdog turn it on
 * themselves, as with every other opt-in feature here.
 */
async function startBoard(root, env = {}, { serverPath = SERVER_PATH, timeoutMs } = {}) {
  const proc = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      AGENTBOARD_ROOT: root,
      PORT: AUTO_PORT_VALUE,
      BRIEFBOARD_WATCHDOG_MS: 'off',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  // Both pipes are read from the first tick: an unread one fills, and a server
  // blocked on writing to it stops answering (T-0124).
  proc.stdout.on('data', (c) => (stdout += c.toString()));
  proc.stderr.on('data', (c) => (stderr += c.toString()));
  const out = () => ({ stdout, stderr });

  let port;
  try {
    port = await waitForBanner(proc, out, timeoutMs);
    await waitUntilReady(`http://${HOST}:${port}`);
  } catch (err) {
    await stopProcess(proc); // a board nobody got hold of must not outlive the test
    throw err;
  }

  return {
    proc,
    port,
    baseUrl: `http://${HOST}:${port}`,
    out,
    getStdout: () => stdout,
    getStderr: () => stderr,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    // A function, not a promise: a server that is meant to stay up must not
    // leave a rejected timeout promise behind for nobody to catch.
    exited: (ms) => waitForExit(proc, ms),
    stop: () => stopProcess(proc),
  };
}

module.exports = {
  HOST,
  SERVER_PATH,
  BANNER_TIMEOUT_MS,
  freePort,
  occupyPort,
  waitForBanner,
  startBoard,
};
