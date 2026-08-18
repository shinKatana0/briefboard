'use strict';

// What the board's `clientError` handler says, and what it has learned to keep
// quiet about (T-0248).
//
// The handler exists so a flood of garbage requests is visible in the log. What
// it also caught was an ordinary browser dropping a socket it had opened and not
// used — Chrome's speculative preconnect — which arrives here as `read
// ECONNRESET` on an already-destroyed socket. Two such lines were the entire log
// of a healthy board someone had merely visited.
//
// Both cases are driven over a raw socket against a real board, because the
// difference lives in Node's parser and not in anything this project can fake.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { startBoard, HOST } = require('./helpers/board.js');
const { waitFor } = require('./helpers/wait.js');
const { tempDir } = require('./helpers/tmp.js');

const BACKLOG = [
  '# Backlog\n',
  '## T-0001 · Major · A task to serve',
  '- type: feature',
  '- status: backlog',
  '- created: 2026-01-01 00:00:00',
  '- closed: —',
  '- briefs: ',
  '',
  'Some description.',
  '',
].join('\n');

const boards = [];
const roots = [];

async function board() {
  const root = tempDir('briefboard-clienterr-');
  roots.push(root);
  fs.mkdirSync(path.join(root, 'doc', 'brief'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'backlog.md'), BACKLOG);
  const server = await startBoard(root);
  boards.push(server);
  return server;
}

afterEach(async () => {
  while (boards.length) await boards.pop().stop();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

/**
 * A socket opened, half a request written, and then reset — which is what a
 * browser's preconnect does when the page it was speculating about is closed.
 * Verified on Windows 11 / Node 22: the board sees `read ECONNRESET` with the
 * socket already destroyed, exactly as the by-hand check reported it.
 */
function dropSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, HOST, () => {
      socket.write('GET / HTTP/1.1\r\nHost: ' + HOST + '\r\n');
      setTimeout(() => {
        if (socket.resetAndDestroy) socket.resetAndDestroy();
        else socket.destroy();
        resolve();
      }, 50);
    });
    socket.setTimeout(20000, () => socket.destroy(new Error('no connection within 20000ms')));
    // The reset is the point of the exercise; its echo on this side is not.
    socket.on('error', () => {});
    socket.on('close', resolve);
    socket.on('timeout', reject);
  });
}

/** A request Node's own parser refuses: a header line with no colon. */
function sendBadFraming(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, HOST, () =>
      socket.write('GET / HTTP/1.1\r\nHost: ' + HOST + '\r\nBad Header Line\r\n\r\n')
    );
    let text = '';
    socket.setTimeout(20000, () => socket.destroy(new Error('no answer within 20000ms')));
    socket.on('data', (chunk) => (text += chunk.toString()));
    socket.on('close', () => resolve(text));
    socket.on('error', reject);
  });
}

const clientErrorLines = (server) =>
  server
    .getStderr()
    .split('\n')
    .filter((line) => line.includes('clientError:'));

describe('the board and a broken connection', () => {
  it('says nothing about a socket the peer opened and dropped', async () => {
    const server = await board();

    await dropSocket(server.port);
    // Bad framing after it, as the sync point: it travels the same handler, so
    // once its line is in the log the reset has had every chance to print one.
    await sendBadFraming(server.port);
    await waitFor(
      () => clientErrorLines(server).length > 0,
      undefined,
      'the board to report the malformed request'
    );

    const lines = clientErrorLines(server);
    assert.strictEqual(lines.length, 1, `expected only the framing error, got: ${JSON.stringify(lines)}`);
    assert.doesNotMatch(server.getStderr(), /ECONNRESET/);
  });

  it('still reports malformed HTTP framing, which is what the handler is for', async () => {
    const server = await board();

    const answer = await sendBadFraming(server.port);

    await waitFor(
      () => clientErrorLines(server).length > 0,
      undefined,
      'the board to report the malformed request'
    );
    assert.match(clientErrorLines(server)[0], /Parse Error/);
    // And the socket is still answered, as it was before the handler learned to
    // tell the two apart.
    assert.match(answer, /400 Bad Request/);
  });
});
