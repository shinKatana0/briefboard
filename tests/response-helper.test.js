'use strict';

// Tests for tests/helpers/response.js — the helper whose only job is the text of
// a failure (T-0134). Nothing else in the suite proves that text is any good: a
// green run never prints it, so the one place it is read is a rare failure
// nobody can reproduce on demand.
// Run with: npm test

require('./helpers/env.js');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { fetch } = require('./helpers/bounded.js');
const { BODY_LIMIT, readJson, answerOf } = require('./helpers/response.js');

let server;
let baseUrl;

// One throwaway server; each path answers the shape its tests need.
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, session: 'started' }));
    } else if (req.url === '/conflict') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'T-0011 is already open' }));
    } else if (req.url === '/html') {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h1>Internal Server Error</h1>');
    } else if (req.url === '/long') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`"${'x'.repeat(BODY_LIMIT * 2)}"`);
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe('readJson', () => {
  it('returns the parsed body', async () => {
    const data = await readJson(await fetch(baseUrl + '/json'));
    assert.deepStrictEqual(data, { ok: true, session: 'started' });
  });

  it('a body that is not JSON fails naming the url, the code and the text', async () => {
    const res = await fetch(baseUrl + '/html');
    await assert.rejects(() => readJson(res), (err) => {
      assert.match(err.message, /\/html/);
      assert.match(err.message, /answered 500/);
      assert.match(err.message, /Internal Server Error/);
      return true;
    });
  });

  it('an empty body says so instead of "Unexpected end of JSON input"', async () => {
    const res = await fetch(baseUrl + '/nothing');
    await assert.rejects(() => readJson(res), /answered 204[\s\S]*<empty>/);
  });
});

describe('answerOf', () => {
  it('carries the code and the body into the assertion that failed', async () => {
    const res = await fetch(baseUrl + '/conflict');
    const data = await readJson(res);

    try {
      assert.strictEqual(data.session, 'started', answerOf(res));
      assert.fail('the assertion above must fail');
    } catch (err) {
      assert.match(err.message, /answered 409/);
      assert.match(err.message, /T-0011 is already open/);
      // node:assert still reports its own two values alongside the message.
      assert.strictEqual(err.actual, undefined);
      assert.strictEqual(err.expected, 'started');
    }
  });

  it('a long body is clipped and its real size named', async () => {
    const res = await fetch(baseUrl + '/long');
    await readJson(res);
    const message = answerOf(res);
    assert.match(message, /… \(\d+ bytes\)/);
    assert.ok(message.length < BODY_LIMIT * 2, 'the whole body must not reach the message');
  });

  // The one-liner `await readJson(await fetch(url))` keeps no response variable,
  // and a test must not have to introduce one just to be able to report it.
  it('answers for the parsed body as well as for the response it came from', async () => {
    const res = await fetch(baseUrl + '/conflict');
    const data = await readJson(res);
    assert.strictEqual(answerOf(data), answerOf(res));
    assert.match(answerOf(data), /answered 409[\s\S]*T-0011 is already open/);
  });

  it('a response nobody parsed still names the url and the code, and says the body is missing', async () => {
    const res = await fetch(baseUrl + '/conflict');
    assert.match(answerOf(res), /answered 409[\s\S]*body not read/);
  });

  it('a value from somewhere else says the answer is unknown rather than inventing one', () => {
    assert.match(answerOf({ session: 'started' }), /did not come from readJson/);
  });
});
