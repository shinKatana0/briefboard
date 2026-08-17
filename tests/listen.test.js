'use strict';

// Tests for server/listen.js — the port selection behind several boards running
// side by side (T-0078).
// Run with: npm test  (or: node --test tests/**/*.test.js)
//
// The port is the subject of this file, so unlike the rest of the suite it does
// name ports (T-0123): free and occupied ones, ephemeral and obtained from the
// OS, never 4571 — the developer's own board is usually sitting on that one.
// Everything here binds in this process, so a port is used the moment it is
// handed out.

require('./helpers/env.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const { fetch } = require('./helpers/bounded.js');
const { HOST, freePort, occupyPort } = require('./helpers/board.js');
const {
  AUTO_PORT,
  AUTO_PORT_VALUE,
  DEFAULT_PORT,
  accessDeniedMessage,
  canLoopbackBeTakenFrom,
  loopbackShadowMessage,
  ownLoopbackAddresses,
  parsePort,
  portCandidates,
  listenWithFallback,
} = require('../server/listen.js');

// A public bind is the only one that has to hold localhost separately (T-0133);
// nothing here actually binds it — the bind host is scripted.
const PUBLIC_HOST = '0.0.0.0';

// RFC 5737 documentation space: no machine carries it on an interface, so a
// bind to it fails the way a bind of ::1 fails where there is no IPv6. That is
// how "this machine has no IPv6" is staged — the real thing cannot be.
const ABSENT_HOST = '192.0.2.1';

// Whether loopback can be taken from a wildcard socket is a property of the
// platform, so the tests state it instead of measuring it: forced on, the whole
// ownership path runs on POSIX too, where it is switched off in production.
const SHADOWABLE = async () => true;

// Servers opened by a test, closed by the afterEach below even if it threw.
const open = [];
const occupied = [];

function track(server) {
  open.push(server);
  return server;
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    // close() waits for open connections, and a keep-alive socket left by fetch
    // never closes on its own — the cleanup would hang the whole file.
    server.close(resolve);
    if (server.closeAllConnections) server.closeAllConnections();
  });
}

afterEach(async () => {
  while (open.length) await closeServer(open.pop());
  while (occupied.length) await occupied.pop()();
});

// Binds a plain TCP server to a free port and keeps it there, so the port under
// test is genuinely occupied by a socket, not simulated.
async function occupyFreePort() {
  const { port, close } = await occupyPort();
  occupied.push(close);
  return port;
}

// Holds `port` (0 = any) on `host` for the rest of the test, or null when the
// bind fails — which is how a machine without IPv6 answers for '::1'.
function occupyOn(host, port = 0) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, host, () => {
      occupied.push(() => new Promise((done) => server.close(done)));
      resolve(server.address().port);
    });
  });
}

// The errno a bind really produces, asserted rather than assumed where a
// fixture rests on it.
function bindErrorCode(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen(port, host);
  });
}

// A stand-in for http.Server whose listen() answers from a table of
// port -> errno (anything else binds). The reserved ranges that produce EACCES
// differ from machine to machine, so they are scripted here instead of hunted
// for at run time.
// `boundPort` is what address() reports once it is listening, when that differs
// from the number passed to listen() — which is what a bind of port 0 does: the
// kernel answers with a port of its own choosing (T-0139).
function scriptedServer(outcomes, boundPort = null) {
  const server = new EventEmitter();
  server.listening = false;
  server.tried = [];
  server.closed = 0;
  // A candidate is now bound before its localhost can be found to belong to
  // somebody else, so abandoning one means closing this server again.
  server.close = (done) => {
    server.listening = false;
    server.closed++;
    if (done) setImmediate(done);
  };
  server.listen = (port) => {
    server.tried.push(port);
    const code = outcomes[port];
    setImmediate(() => {
      if (code) {
        const err = new Error(`listen ${code} ${HOST}:${port}`);
        err.code = code;
        server.emit('error', err);
        return;
      }
      server.listening = true;
      server.address = () => ({ address: HOST, port: boundPort === null ? port : boundPort });
      server.emit('listening');
    });
  };
  return server;
}

// The factory listenWithFallback is given for the sockets that hold localhost.
// Real sockets, so "held" means held: `made` is every one it produced, which is
// how a test sees the ones abandoned along the way were closed.
function socketFactory(make = () => net.createServer()) {
  const factory = () => {
    const server = track(make());
    factory.made.push(server);
    return server;
  };
  factory.made = [];
  return factory;
}

describe('parsePort', () => {
  it('accepts an integer in range, trimming surrounding whitespace', () => {
    assert.strictEqual(parsePort('8080'), 8080);
    assert.strictEqual(parsePort(' 8080 '), 8080);
    assert.strictEqual(parsePort(1), 1);
    assert.strictEqual(parsePort(65535), 65535);
  });

  it('rejects anything Number() would silently turn into NaN or a non-port', () => {
    // A NaN port makes listen() pick a random one — exactly the silent move
    // that an explicit PORT must never do.
    for (const bad of ['abc', '', '  ', '80.5', '-1', '0', '65536', '8080abc', null, undefined]) {
      assert.throws(() => parsePort(bad), /invalid port/, `should reject ${JSON.stringify(bad)}`);
    }
  });

  // "any free port" has to be asked for by name: 0 stays invalid, because an
  // explicitly set PORT is honoured or refused and nothing can be bound on 0.
  it('reads the word auto as "let the kernel choose", while 0 stays invalid', () => {
    assert.strictEqual(parsePort(AUTO_PORT_VALUE), AUTO_PORT);
    assert.strictEqual(parsePort('  AUTO '), AUTO_PORT);
    assert.throws(() => parsePort('0'), /invalid port/);
    assert.throws(() => parsePort('auto0'), /invalid port/);
  });

  it('names auto in the message it refuses a typo with', () => {
    assert.throws(() => parsePort('atuo'), /expected an integer 1-65535 or "auto"/);
  });
});

describe('portCandidates', () => {
  it('gives an explicit port exactly one attempt', () => {
    assert.deepStrictEqual(portCandidates(8080, true), [8080]);
  });

  it('gives the default port a contiguous fallback range', () => {
    const ports = portCandidates(DEFAULT_PORT, false);
    assert.strictEqual(ports[0], DEFAULT_PORT);
    assert.strictEqual(ports.length, 20);
    assert.deepStrictEqual(
      ports,
      Array.from({ length: 20 }, (_, i) => DEFAULT_PORT + i)
    );
  });

  // Whichever way the caller labels it: there is no next candidate after the
  // kernel's own refusal, so the scan must not start walking 1, 2, 3.
  it('gives "any free port" one attempt and never turns it into a scan', () => {
    assert.deepStrictEqual(portCandidates(AUTO_PORT, true), [AUTO_PORT]);
    assert.deepStrictEqual(portCandidates(AUTO_PORT, false), [AUTO_PORT]);
  });

  it('never proposes a port above 65535', () => {
    const ports = portCandidates(65530, false);
    assert.deepStrictEqual(ports, [65530, 65531, 65532, 65533, 65534, 65535]);
  });
});

describe('accessDeniedMessage', () => {
  it('points at the reserved ranges on Windows and at privileged ports elsewhere', () => {
    const windows = accessDeniedMessage(50010, 'win32');
    assert.match(windows, /port 50010 is not available to this process \(EACCES\)/);
    assert.match(windows, /netsh interface ipv4 show excludedportrange protocol=tcp/);

    for (const platform of ['linux', 'darwin']) {
      const posix = accessDeniedMessage(80, platform);
      assert.match(posix, /ports below 1024 require elevated privileges/);
      assert.doesNotMatch(posix, /netsh/, `no Windows-only hint on ${platform}`);
    }
  });
});

describe('ownLoopbackAddresses', () => {
  // The expensive mistake is in this direction: reading "no such address here"
  // as "occupied" makes the scan reject every candidate, and the board stops
  // starting at all on a machine without IPv6 — worse than the bug fixed here.
  it('reads an address this machine does not have as absent, not as occupied', async () => {
    const port = await freePort();
    assert.strictEqual(
      await bindErrorCode(port, ABSENT_HOST),
      'EADDRNOTAVAIL',
      'the fixture must produce the errno a machine without IPv6 gives'
    );

    const { held, takenByOthers } = await ownLoopbackAddresses(port, socketFactory(), [
      HOST,
      ABSENT_HOST,
    ]);

    assert.deepStrictEqual(takenByOthers, []);
    assert.strictEqual(held.length, 1, 'the address that exists is still held');
  });

  it('holds the port on loopback, so nothing else can take it afterwards', async () => {
    const port = await freePort();
    const { held, takenByOthers } = await ownLoopbackAddresses(port, socketFactory());

    assert.deepStrictEqual(takenByOthers, []);
    assert.strictEqual(await bindErrorCode(port, HOST), 'EADDRINUSE');
    // ::1 is held only where the machine has it; that it was held at all is
    // what makes the assertion below meaningful.
    if (held.length === 2) assert.strictEqual(await bindErrorCode(port, '::1'), 'EADDRINUSE');
  });

  it('names the address another process holds and closes the socket it could not use', async () => {
    const taken = await occupyFreePort();
    const factory = socketFactory();

    const { held, takenByOthers } = await ownLoopbackAddresses(taken, factory);

    assert.deepStrictEqual(takenByOthers, [HOST]);
    for (const socket of factory.made) {
      if (!held.includes(socket)) {
        assert.strictEqual(socket.listening, false, 'a socket that failed to bind is not left open');
      }
    }
  });

  it('names ::1 for a port held there only', async (t) => {
    const taken = await occupyOn('::1');
    if (taken === null) {
      t.skip('no IPv6 on this machine');
      return;
    }
    const ipv4Only = await ownLoopbackAddresses(taken, socketFactory(), [HOST]);
    assert.deepStrictEqual(
      ipv4Only.takenByOthers,
      [],
      'nothing holds it on IPv4 — the answer below has to come from ::1'
    );
    for (const socket of ipv4Only.held) await closeServer(socket);

    const both = await ownLoopbackAddresses(taken, socketFactory());
    assert.deepStrictEqual(both.takenByOthers, ['::1']);
  });

  // The dual-stack neighbour: both addresses answer, and the warning may not
  // pick one of them at random.
  it('names both addresses when both are held elsewhere', async (t) => {
    const taken = await occupyOn('::1');
    if (taken === null) {
      t.skip('no IPv6 on this machine');
      return;
    }
    if ((await occupyOn(HOST, taken)) === null) {
      t.skip('this machine will not hold the same port on both addresses');
      return;
    }
    const { takenByOthers } = await ownLoopbackAddresses(taken, socketFactory());
    assert.deepStrictEqual(takenByOthers, [HOST, '::1']);
  });
});

describe('canLoopbackBeTakenFrom', () => {
  // The one place that opens a wildcard socket, for the milliseconds the
  // measurement takes — the detector cannot answer any other way, and neither
  // can this test. Platform semantics are not read off process.platform on
  // either side, so the two have to agree by measurement.
  it('agrees with what a loopback bind over our own wildcard really does', async () => {
    const wildcard = track(net.createServer());
    await new Promise((resolve, reject) => {
      wildcard.once('error', reject);
      wildcard.listen(0, PUBLIC_HOST, resolve);
    });
    const taken = (await bindErrorCode(wildcard.address().port, HOST)) === null;

    assert.strictEqual(await canLoopbackBeTakenFrom(PUBLIC_HOST), taken);
  });
});

describe('loopbackShadowMessage', () => {
  it('says which URL opens the other board', () => {
    const msg = loopbackShadowMessage(4571, [HOST]);
    assert.match(msg, /port 4571 is already served on 127\.0\.0\.1 by another process/);
    assert.match(msg, /http:\/\/localhost:4571 opens that one, not this board/);
  });

  // Naming the wrong address sends the reader hunting for the process at an
  // address nothing holds, and an unfindable process reads as a false warning.
  it('names the address that is actually held, not a fixed one', () => {
    assert.match(
      loopbackShadowMessage(4571, ['::1']),
      /port 4571 is already served on ::1 by another process/
    );
    assert.doesNotMatch(loopbackShadowMessage(4571, ['::1']), /127\.0\.0\.1/);
    assert.match(
      loopbackShadowMessage(4571, [HOST, '::1']),
      /already served on 127\.0\.0\.1 and ::1 by another process/
    );
  });

  // The bug (T-0135): with one of the two addresses ours, localhost still
  // reaches this board for part of the callers, and "opens that one, not this
  // board" sends the reader hunting for a problem that may not exist.
  it('says the board is still on localhost when it holds one of the addresses', () => {
    const msg = loopbackShadowMessage(4571, ['::1'], [HOST]);
    assert.match(msg, /port 4571 is also served on ::1 by another process/);
    assert.match(msg, /this board holds 127\.0\.0\.1:4571/);
    assert.doesNotMatch(msg, /opens that one, not this board/);
  });

  // Whichever address a client ends up at is the resolver's answer, and the
  // whole point of this warning is to stop guessing it.
  it('never claims what localhost resolves to on the reader machine', () => {
    for (const msg of [
      loopbackShadowMessage(4571, [HOST]),
      loopbackShadowMessage(4571, [HOST, '::1']),
      loopbackShadowMessage(4571, ['::1'], [HOST]),
      loopbackShadowMessage(4571, [HOST], ['::1']),
    ]) {
      assert.doesNotMatch(msg, /Windows|Linux|macOS|first|prefer/i);
      assert.doesNotMatch(msg, /localhost resolves to \S/);
    }
  });
});

describe('listenWithFallback', () => {
  it('binds the first port when it is free', async () => {
    const port = await freePort();
    const server = track(http.createServer());
    const addr = await listenWithFallback(server, HOST, portCandidates(port, false));
    assert.strictEqual(addr.port, port);
  });

  // The next candidate is a port the OS just handed back as free, not the
  // occupied one + 1: a neighbour of an arbitrary ephemeral port may fall into
  // a system-reserved range, which used to make this test fail at random.
  it('moves to the next free port when the first is taken', async () => {
    const taken = await occupyFreePort();
    const free = await freePort();
    const server = track(http.createServer());
    const addr = await listenWithFallback(server, HOST, [taken, free]);

    assert.strictEqual(addr.port, free);
    assert.strictEqual(server.listening, true);
  });

  it('binds a port of the kernel\'s choosing for AUTO_PORT, and serves there', async () => {
    const server = track(http.createServer((req, res) => res.end('ok')));
    const addr = await listenWithFallback(server, HOST, portCandidates(AUTO_PORT, true));

    assert.notStrictEqual(addr.port, AUTO_PORT, 'the reported port must be the bound one');
    assert.strictEqual(addr.port, server.address().port);
    const res = await fetch(`http://${HOST}:${addr.port}/`);
    assert.strictEqual(res.status, 200);
  });

  it('rejects instead of moving when a single (explicit) port is taken', async () => {
    const taken = await occupyFreePort();
    const server = track(http.createServer());

    await assert.rejects(
      () => listenWithFallback(server, HOST, portCandidates(taken, true)),
      (err) => {
        assert.strictEqual(err.code, 'EADDRINUSE');
        assert.match(err.message, new RegExp(`port ${taken} is already in use`));
        return true;
      }
    );
    assert.strictEqual(server.listening, false, 'nothing may be bound after an explicit-port failure');
  });

  it('reports the exhausted range instead of throwing an unhandled EADDRINUSE', async () => {
    const taken = await occupyFreePort();
    const server = track(http.createServer());

    await assert.rejects(
      () => listenWithFallback(server, HOST, [taken, taken]),
      (err) => {
        assert.strictEqual(err.code, 'EADDRINUSE');
        assert.match(err.message, new RegExp(`no free port in ${taken}-${taken}`));
        return true;
      }
    );
  });

  it('does not walk past a listen error that is not about the port', async () => {
    const server = scriptedServer({ 4571: 'EPERM' });
    await assert.rejects(
      () => listenWithFallback(server, HOST, [4571, 4572, 4573]),
      (err) => {
        assert.strictEqual(err.code, 'EPERM');
        assert.strictEqual(err.port, 4571);
        return true;
      }
    );
    assert.deepStrictEqual(server.tried, [4571], 'a misconfiguration must not be papered over');
  });

  it('skips a port the system reserves (EACCES) while scanning', async () => {
    const server = scriptedServer({ 4571: 'EACCES' });
    const addr = await listenWithFallback(server, HOST, [4571, 4572, 4573]);

    assert.strictEqual(addr.port, 4572);
    assert.deepStrictEqual(server.tried, [4571, 4572]);
  });

  it('skips an unavailable port (EADDRNOTAVAIL) while scanning', async () => {
    const server = scriptedServer({ 4571: 'EADDRNOTAVAIL', 4572: 'EADDRINUSE' });
    const addr = await listenWithFallback(server, HOST, [4571, 4572, 4573]);

    assert.strictEqual(addr.port, 4573);
    assert.deepStrictEqual(server.tried, [4571, 4572, 4573]);
  });

  it('refuses an explicit port the system reserves instead of moving', async () => {
    const server = scriptedServer({ 8080: 'EACCES' });

    await assert.rejects(
      () => listenWithFallback(server, HOST, portCandidates(8080, true)),
      (err) => {
        assert.strictEqual(err.code, 'EACCES');
        assert.strictEqual(err.message, accessDeniedMessage(8080));
        assert.match(err.message, /port 8080 is not available to this process/);
        return true;
      }
    );
    assert.strictEqual(server.listening, false, 'nothing may be bound after an explicit-port failure');
  });

  it('tells an exhausted scan of unusable ports apart from one of busy ports', async () => {
    const reserved = scriptedServer({ 4571: 'EADDRINUSE', 4572: 'EACCES' });
    await assert.rejects(
      () => listenWithFallback(reserved, HOST, [4571, 4572]),
      (err) => {
        assert.strictEqual(err.code, 'EACCES');
        assert.match(err.message, /no usable port in 4571-4572 \(in use, or reserved by the system\)/);
        return true;
      }
    );

    const busy = scriptedServer({ 4571: 'EADDRINUSE', 4572: 'EADDRINUSE' });
    await assert.rejects(
      () => listenWithFallback(busy, HOST, [4571, 4572]),
      (err) => {
        assert.strictEqual(err.code, 'EADDRINUSE');
        assert.match(err.message, /no free port in 4571-4572 \(all in use\)/);
        return true;
      }
    );
  });

  // A machine without IPv6 is staged the same way here as it is one describe
  // above: the board has to start on it, and an implementation that reads every
  // failed loopback bind as "occupied" rejects all twenty candidates instead.
  it('starts on a machine where ::1 does not exist (public bind)', async () => {
    const port = await freePort();
    const factory = socketFactory();

    // A scan, because that is where the stake is: an implementation that reads
    // the absent address as occupied walks the whole range and the board never
    // starts at all.
    const addr = await listenWithFallback(scriptedServer({}), PUBLIC_HOST, [port, port + 1], {
      createServer: factory,
      canShadow: SHADOWABLE,
      loopbackHosts: [HOST, ABSENT_HOST],
    });

    assert.strictEqual(addr.port, port, 'the first candidate is usable and must be taken');
    assert.deepStrictEqual(addr.loopbackShadowedBy, []);
    assert.strictEqual(addr.loopbackServers.length, 1, 'the address that exists is still held');
  });

  // The bug itself (T-0133): the board no longer asks whether localhost is
  // free, it takes it — so the process that arrives a second later is refused.
  it('holds localhost, so a process arriving later cannot take it', async () => {
    const port = await freePort();

    const addr = await listenWithFallback(scriptedServer({}), PUBLIC_HOST, [port], {
      createServer: socketFactory(),
      canShadow: SHADOWABLE,
    });

    assert.strictEqual(addr.port, port);
    assert.ok(addr.loopbackServers.length >= 1);
    assert.strictEqual(await bindErrorCode(port, HOST), 'EADDRINUSE');
  });

  it('holds it with a socket that serves this board', async () => {
    const port = await freePort();
    const factory = socketFactory(() => http.createServer((req, res) => res.end('this board')));

    await listenWithFallback(scriptedServer({}), PUBLIC_HOST, [port], {
      createServer: factory,
      canShadow: SHADOWABLE,
    });

    assert.strictEqual(await (await fetch(`http://${HOST}:${port}/`)).text(), 'this board');
  });

  it('skips a scanned candidate another process serves on loopback (public bind)', async () => {
    const taken = await occupyFreePort();
    const free = await freePort();
    const server = scriptedServer({});
    const factory = socketFactory();

    const addr = await listenWithFallback(server, PUBLIC_HOST, [taken, free], {
      createServer: factory,
      canShadow: SHADOWABLE,
    });

    assert.strictEqual(addr.port, free);
    assert.deepStrictEqual(server.tried, [taken, free], 'a candidate is bound before it is judged');
    assert.strictEqual(server.closed, 1, 'and released again when its localhost belongs elsewhere');
    assert.deepStrictEqual(addr.loopbackShadowedBy, []);
    // Whatever it opened for the abandoned candidate is gone; only the sockets
    // it hands back stay listening, or the port it left behind reads as a fresh
    // "already in use" bug.
    for (const socket of factory.made) {
      if (!addr.loopbackServers.includes(socket)) assert.strictEqual(socket.listening, false);
    }
  });

  it('binds an explicitly requested shadowed port, flagging it instead of refusing', async () => {
    const taken = await occupyFreePort();
    const server = scriptedServer({});

    const addr = await listenWithFallback(server, PUBLIC_HOST, [taken], {
      createServer: socketFactory(),
      canShadow: SHADOWABLE,
    });

    assert.strictEqual(addr.port, taken);
    assert.deepStrictEqual(addr.loopbackShadowedBy, [HOST], 'the caller has a warning to print');
    assert.deepStrictEqual(server.tried, [taken]);
    assert.strictEqual(server.closed, 0);
  });

  // What the caller does with the answer: the warning it prints has to name the
  // address that is really held, whichever one that is.
  it('hands the caller the addresses the warning has to name', async () => {
    const taken = await occupyFreePort();

    const addr = await listenWithFallback(scriptedServer({}), PUBLIC_HOST, [taken], {
      createServer: socketFactory(),
      canShadow: SHADOWABLE,
    });

    const msg = loopbackShadowMessage(addr.port, addr.loopbackShadowedBy, addr.loopbackHeldOn);
    assert.match(msg, new RegExp(`served on ${addr.loopbackShadowedBy.join(' and ')} by another process`));
    assert.match(msg, /127\.0\.0\.1/);
  });

  // The situation T-0135 is about, staged end to end: the neighbour holds
  // 127.0.0.1 only, we take ::1, and the caller must be able to tell that from
  // the answer alone.
  it('reports the address it took when a neighbour holds only the other one', async (t) => {
    const taken = await occupyFreePort();
    if ((await bindErrorCode(taken, '::1')) !== null) {
      t.skip('no free ::1 on this machine');
      return;
    }

    const addr = await listenWithFallback(scriptedServer({}), PUBLIC_HOST, [taken], {
      createServer: socketFactory(),
      canShadow: SHADOWABLE,
    });

    assert.deepStrictEqual(addr.loopbackShadowedBy, [HOST]);
    assert.deepStrictEqual(addr.loopbackHeldOn, ['::1']);
    const msg = loopbackShadowMessage(addr.port, addr.loopbackShadowedBy, addr.loopbackHeldOn);
    assert.match(msg, new RegExp(`this board holds ::1:${addr.port}`));
  });

  it('reports an exhausted scan when every candidate is shadowed', async () => {
    const first = await occupyFreePort();
    const second = await occupyFreePort();
    const server = scriptedServer({});

    await assert.rejects(
      () =>
        listenWithFallback(server, PUBLIC_HOST, [first, second], {
          createServer: socketFactory(),
          canShadow: SHADOWABLE,
        }),
      (err) => {
        assert.strictEqual(err.code, 'EADDRINUSE');
        assert.match(err.message, new RegExp(`no free port in ${first}-${second} \\(all in use\\)`));
        return true;
      }
    );
    assert.strictEqual(server.closed, 2, 'nothing stays bound after an exhausted scan');
  });

  // What this adds over the tests above: ::1 is answered for the same way as
  // 127.0.0.1. The bind host is scripted, so no test opens a public socket.
  it('treats a port held on ::1 like one held on 127.0.0.1', async (t) => {
    const taken = await occupyOn('::1');
    if (taken === null) {
      t.skip('no IPv6 on this machine');
      return;
    }
    const free = await freePort();
    const options = { createServer: socketFactory(), canShadow: SHADOWABLE };

    const scanned = await listenWithFallback(scriptedServer({}), PUBLIC_HOST, [taken, free], options);
    assert.strictEqual(scanned.port, free, 'a scan must step over it');
    for (const socket of scanned.loopbackServers) await closeServer(socket);

    const explicit = await listenWithFallback(scriptedServer({}), PUBLIC_HOST, [taken], options);
    assert.strictEqual(explicit.port, taken);
    assert.deepStrictEqual(explicit.loopbackShadowedBy, ['::1'], 'the warning must name ::1');
  });

  // AUTO_PORT is the one case where the requested port is not the bound one, and
  // localhost has to be held on the port this board answers on — holding it on
  // the requested 0 would take two more random ports and leave the board's own
  // localhost to the next comer (T-0139).
  it('holds localhost on the port the kernel gave, not on the requested 0', async () => {
    const kernelPort = await freePort();
    const factory = socketFactory();
    const server = scriptedServer({}, kernelPort);

    const addr = await listenWithFallback(server, PUBLIC_HOST, [AUTO_PORT], {
      createServer: factory,
      canShadow: SHADOWABLE,
    });

    assert.deepStrictEqual(server.tried, [AUTO_PORT], 'the kernel is asked with port 0');
    assert.strictEqual(addr.port, kernelPort);
    assert.ok(addr.loopbackServers.length > 0, 'a public bind must hold localhost itself');
    for (const socket of addr.loopbackServers) {
      assert.strictEqual(socket.address().port, kernelPort);
    }
  });

  it('opens no extra socket where loopback cannot be taken from a wildcard bind', async () => {
    const factory = socketFactory();
    const server = scriptedServer({});

    const addr = await listenWithFallback(server, PUBLIC_HOST, [4571, 4572], {
      createServer: factory,
      canShadow: async () => false,
    });

    assert.strictEqual(addr.port, 4571);
    assert.deepStrictEqual(addr.loopbackServers, [], 'a POSIX wildcard socket already owns loopback');
    assert.deepStrictEqual(addr.loopbackShadowedBy, []);
    assert.strictEqual(factory.made.length, 0);
  });

  it('does not ask about localhost at all when the bind host is loopback', async () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const factory = socketFactory();
      const asked = [];
      const canShadow = async (h) => {
        asked.push(h);
        return true;
      };

      const addr = await listenWithFallback(scriptedServer({}), host, [4571, 4572], {
        createServer: factory,
        canShadow,
      });

      assert.strictEqual(addr.port, 4571, `${host} must bind the first candidate`);
      assert.deepStrictEqual(addr.loopbackShadowedBy, []);
      assert.deepStrictEqual(asked, [], `${host} already is localhost and cannot lose it`);
      assert.strictEqual(factory.made.length, 0);
    }
  });

  // A public bind with no way to serve the extra addresses would print a
  // localhost URL it does not own — the bug this whole path exists for.
  it('refuses a public bind that cannot serve localhost', async () => {
    await assert.rejects(
      () => listenWithFallback(scriptedServer({}), PUBLIC_HOST, [4571]),
      /needs createServer/
    );
  });

  it('rejects an empty candidate list rather than binding a random port', async () => {
    const server = track(http.createServer());
    await assert.rejects(() => listenWithFallback(server, HOST, []), /no port to listen on/);
    assert.strictEqual(server.listening, false);
  });
});
