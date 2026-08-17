'use strict';

// Unit tests for server/loopback.js (T-0082).
//
// The two guards are tested apart on purpose: isLoopbackHost() judges the bind
// address the board was started with, isLoopbackRemote() judges the peer that
// opened the connection. Only the second one keeps the network away from
// POST /api/shutdown, and it is the one a mistake would be dangerous in.

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isLoopbackHost, isLoopbackAddress, isLoopbackRemote } = require('../server/loopback.js');

describe('isLoopbackHost (what we listen on)', () => {
  it('accepts the three forms a loopback bind is written in', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      assert.strictEqual(isLoopbackHost(host), true, host);
    }
  });

  it('rejects a public bind', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', '', undefined, null]) {
      assert.strictEqual(isLoopbackHost(host), false, String(host));
    }
  });
});

describe('isLoopbackAddress (who connected)', () => {
  it('accepts IPv4 loopback, including the whole 127.0.0.0/8 block', () => {
    for (const addr of ['127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.255']) {
      assert.strictEqual(isLoopbackAddress(addr), true, addr);
    }
  });

  it('accepts the IPv4-mapped form Node reports on a dual-stack socket', () => {
    // A browser on the same machine routinely arrives as ::ffff:127.0.0.1; the
    // exit button would be dead for it if the mapped prefix were not stripped.
    assert.strictEqual(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.strictEqual(isLoopbackAddress('::FFFF:127.0.0.1'), true);
  });

  it('accepts IPv6 loopback, with or without a zone index', () => {
    assert.strictEqual(isLoopbackAddress('::1'), true);
    assert.strictEqual(isLoopbackAddress('::1%lo0'), true);
  });

  it('rejects external addresses, mapped or not', () => {
    for (const addr of [
      '192.168.1.10',
      '10.0.0.5',
      '8.8.8.8',
      '128.0.0.1',
      '126.255.255.255',
      '::ffff:192.168.1.10',
      '2001:db8::1',
      'fe80::1',
    ]) {
      assert.strictEqual(isLoopbackAddress(addr), false, addr);
    }
  });

  it('rejects anything it cannot parse rather than guessing', () => {
    for (const addr of [
      'localhost', // a name, not an address: never what a socket reports
      '127.0.0.1.evil.com',
      '127.0.0.1:1234',
      '127.0.0',
      '127.0.0.300',
      '999.0.0.1',
      '',
      '   ',
      undefined,
      null,
      42,
      {},
    ]) {
      assert.strictEqual(isLoopbackAddress(addr), false, String(addr));
    }
  });
});

describe('isLoopbackRemote (the request-level guard)', () => {
  const req = (remoteAddress) => ({ socket: { remoteAddress } });

  it('reads the peer address off the request socket', () => {
    assert.strictEqual(isLoopbackRemote(req('127.0.0.1')), true);
    assert.strictEqual(isLoopbackRemote(req('::ffff:127.0.0.1')), true);
    assert.strictEqual(isLoopbackRemote(req('192.168.1.10')), false);
  });

  it('rejects a request with no usable socket instead of throwing', () => {
    // A destroyed socket leaves remoteAddress undefined; that must answer 403,
    // not take the process down inside the request handler.
    assert.strictEqual(isLoopbackRemote(req(undefined)), false);
    assert.strictEqual(isLoopbackRemote({}), false);
    assert.strictEqual(isLoopbackRemote(null), false);
    assert.strictEqual(isLoopbackRemote(undefined), false);
  });
});
