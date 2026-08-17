'use strict';

// What the board actually answered, kept for the moment an assertion fails
// (T-0134).
//
// The habit this replaces: `assert.strictEqual((await res.json()).session,
// 'started')`. Under parallel load that failed with `actual: undefined,
// expected: 'started'` — and nothing else. The board had answered something;
// which code, with which body, was gone by the time the message was printed, so
// a rare failure said only what was missing, never what happened.
//
// Two things go wrong with a JSON answer, so there are two functions:
//   readJson()  — a body that is not JSON at all (an empty 204, an HTML error
//                 page) fails as "Unexpected end of JSON input" with no url and
//                 no status; here it fails naming both, and the text;
//   answerOf()  — a body that parsed but does not carry what the test expected.
//                 Pass it as the assertion's message: the failure then carries
//                 the whole answer, while node:assert still reports its own
//                 actual/expected.
//
// answerOf() takes the parsed body as readily as the response it came from, so
// a test that parses an answer on the spot, keeping no response variable, still
// has something to report it with.

const BODY_LIMIT = 1000;

// Keyed by identity, so a test can ask either the response or the value parsed
// out of it. A WeakMap because a report must not keep a body alive.
const reports = new WeakMap();

function clip(text) {
  if (text === '') return '<empty>';
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}… (${text.length} bytes)` : text;
}

function place(res) {
  const status = res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
  return `${res.url || '<unknown url>'} answered ${status}`;
}

/** The parsed body. A body that is not JSON fails naming the url, the code and the text. */
async function readJson(res) {
  const text = await res.text();
  const report = `${place(res)}; body: ${clip(text)}`;
  reports.set(res, report);
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`${place(res)} with a body that is not JSON: ${clip(text)}`, { cause: err });
  }
  if (body !== null && typeof body === 'object') reports.set(body, report);
  return body;
}

/**
 * An assertion message carrying the whole answer, from either the parsed body or
 * the response: `assert.strictEqual(data.x, 'y', answerOf(data))`.
 */
function answerOf(value) {
  const report = reports.get(value);
  if (report) return report;
  if (value instanceof Response) return `${place(value)} (body not read through readJson)`;
  return 'this value did not come from readJson, so the answer behind it is unknown';
}

module.exports = { BODY_LIMIT, readJson, answerOf };
