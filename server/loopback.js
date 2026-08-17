'use strict';

// Two questions that look alike and are not: isLoopbackHost() answers "what are
// we listening on" (a bind address taken from the environment), isLoopbackRemote()
// answers "who connected" (a peer address reported by the kernel). Only the
// second one can gate an endpoint against the network.

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// Node reports a peer that reached a dual-stack socket over IPv4 in the
// IPv4-mapped form ::ffff:127.0.0.1, and an IPv6 address may carry a zone
// index (::1%lo0); both are stripped before the address is judged. Everything
// that is not recognised is refused — this guards a process-killing endpoint,
// so an unparsed address must never pass.
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  let addr = address.trim().toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (addr === '::1') return true;
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127; // the whole 127.0.0.0/8 block, not just 127.0.0.1
}

function isLoopbackRemote(req) {
  return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
}

module.exports = { isLoopbackHost, isLoopbackAddress, isLoopbackRemote };
