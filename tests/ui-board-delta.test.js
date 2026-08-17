'use strict';

// The client half of the delta protocol (T-0160): what the board does with a
// "changed {...}" event. The rule under test is convergence, not thrift — a
// delta is applied only when it starts exactly where the client stands, and
// every other case falls back to re-reading /api/board.
//
// The UI runs in the vm harness, so `fetch` and `EventSource` are the test's.

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createSandbox, loadUiScript, runInSandbox } = require('./helpers/ui-harness.js');

const UI_SRC = loadUiScript();

// Lets the promise chains started inside the vm settle. Several ticks: a load
// may issue another one.
async function flush(times = 4) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function task(id, status) {
  return {
    id,
    title: id,
    type: 'feature',
    priority: 'Major',
    status,
    created: '2026-01-01 00:00:00',
    closed: '',
    briefs: [],
    depends: [],
    description: '',
    blockedBy: [],
    awaitingAnswer: false,
  };
}

function boardAt(version, tasks) {
  return {
    version,
    tasks,
    sessions: { enabled: false, worker: false, orchestrator: false, profiles: [], profileUsedBy: {} },
    project: { name: 'test' },
  };
}

// A fetch whose /api/board answer the test moves forward, and can hold open to
// put a request in flight while an event arrives.
function boardFetch(initial) {
  const calls = [];
  let board = initial;
  let held = null;
  const answer = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const fn = function (url) {
    calls.push(url);
    if (url === '/api/sessions') return Promise.resolve(answer({ sessions: [], costs: {} }));
    const snapshot = board;
    if (held) return new Promise((resolve) => held.push(() => resolve(answer(snapshot))));
    return Promise.resolve(answer(snapshot));
  };
  fn.calls = calls;
  fn.boardCalls = () => calls.filter((url) => url === '/api/board').length;
  fn.serve = (next) => {
    board = next;
  };
  fn.pause = () => {
    held = [];
  };
  fn.resume = () => {
    const queue = held;
    held = null;
    for (const release of queue) release();
  };
  return fn;
}

const PROBE = `probe = function () {
  return { ids: tasks.map(function (t) { return t.id; }),
           statuses: tasks.map(function (t) { return t.status; }),
           version: boardVersion };
};`;

// Starts the board with `board` on the wire and lets its own start-up settle.
async function startBoard(board) {
  const fetch = boardFetch(board);
  const sandbox = createSandbox({ fetch });
  runInSandbox(UI_SRC, sandbox, `(function () { ${PROBE} })()`);
  await flush();
  const sse = sandbox.eventSources[0];
  const probe = () => JSON.parse(JSON.stringify(sandbox.probe()));
  return { fetch, sandbox, sse, probe };
}

const frame = (delta) => ({ data: 'changed ' + JSON.stringify(delta) });

// =====================================================================
describe('applying a board delta (T-0160)', () => {
  it('updates the changed task without asking for the list again', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready'), task('T-0002', 'ready')]));
    const before = board.fetch.boardCalls();

    board.sse.onmessage(frame({ base: 5, v: 6, tasks: [task('T-0002', 'in_progress')], removed: [] }));
    await flush();

    assert.deepStrictEqual(board.probe(), {
      ids: ['T-0001', 'T-0002'],
      statuses: ['ready', 'in_progress'],
      version: 6,
    });
    assert.strictEqual(board.fetch.boardCalls(), before, 'the board was not re-read');
  });

  it('adds a task that appeared and drops one that vanished', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready'), task('T-0002', 'ready')]));
    const before = board.fetch.boardCalls();

    board.sse.onmessage(frame({ base: 5, v: 6, tasks: [task('T-0003', 'backlog')], removed: ['T-0001'] }));
    await flush();

    assert.deepStrictEqual(board.probe().ids, ['T-0002', 'T-0003']);
    assert.strictEqual(board.fetch.boardCalls(), before);
  });

  it('ignores a frame for the version it already holds', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready')]));
    const before = board.fetch.boardCalls();

    board.sse.onmessage(frame({ base: 4, v: 5, tasks: [task('T-0001', 'done')], removed: [] }));
    await flush();

    assert.deepStrictEqual(board.probe().statuses, ['ready'], 'nothing was applied twice');
    assert.strictEqual(board.fetch.boardCalls(), before, 'and nothing was re-read either');
  });
});

// =====================================================================
// The criterion that matters: a board that misses an event must not stay wrong.
describe('recovering from a delta that cannot be applied (T-0160)', () => {
  it('re-reads everything when an event was missed', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready'), task('T-0002', 'ready')]));
    const before = board.fetch.boardCalls();

    // The server moved 5 -> 6 -> 7; the client never saw the frame for 6.
    board.fetch.serve(boardAt(7, [task('T-0001', 'done'), task('T-0002', 'in_progress')]));
    board.sse.onmessage(frame({ base: 6, v: 7, tasks: [task('T-0002', 'in_progress')], removed: [] }));
    await flush();

    assert.strictEqual(board.fetch.boardCalls(), before + 1, 'the gap forced a full read');
    assert.deepStrictEqual(board.probe(), {
      ids: ['T-0001', 'T-0002'],
      statuses: ['done', 'in_progress'],
      version: 7,
    });
  });

  it('re-reads everything when the server says the delta was too large to send', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready')]));
    const before = board.fetch.boardCalls();

    board.fetch.serve(boardAt(6, [task('T-0001', 'done')]));
    board.sse.onmessage(frame({ base: 5, v: 6, full: true }));
    await flush();

    assert.strictEqual(board.fetch.boardCalls(), before + 1);
    assert.deepStrictEqual(board.probe().statuses, ['done']);
  });

  it('re-reads everything on a frame with no version at all', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready')]));
    const before = board.fetch.boardCalls();

    board.fetch.serve(boardAt(5, [task('T-0001', 'ready')]));
    board.sse.onmessage(frame({ base: 5, full: true }));
    await flush();

    assert.strictEqual(board.fetch.boardCalls(), before + 1);
  });

  it('re-reads everything on the bare "changed" an older server sends', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready')]));
    const before = board.fetch.boardCalls();

    board.fetch.serve(boardAt(6, [task('T-0001', 'done')]));
    board.sse.onmessage({ data: 'changed' });
    await flush();

    assert.strictEqual(board.fetch.boardCalls(), before + 1);
    assert.deepStrictEqual(board.probe().statuses, ['done']);
  });

  it('re-reads everything on a frame it cannot parse', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready')]));
    const before = board.fetch.boardCalls();

    board.sse.onmessage({ data: 'changed {not json' });
    await flush();

    assert.strictEqual(board.fetch.boardCalls(), before + 1);
  });

  it('asks once more when the answer is older than the version announced, and then stops', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready')]));
    const before = board.fetch.boardCalls();

    // The answer to the reload is older than the frame that caused it.
    board.fetch.serve(boardAt(6, [task('T-0001', 'ready')]));
    board.sse.onmessage(frame({ base: 6, v: 7, tasks: [task('T-0001', 'done')], removed: [] }));
    await flush();
    assert.strictEqual(board.fetch.boardCalls(), before + 2, 'one retry, not a stream of them');

    // Being behind is temporary: the next event finds the client out of step
    // and puts it right.
    board.fetch.serve(boardAt(8, [task('T-0001', 'done')]));
    board.sse.onmessage(frame({ base: 7, v: 8, tasks: [task('T-0001', 'done')], removed: [] }));
    await flush();
    assert.deepStrictEqual(board.probe(), { ids: ['T-0001'], statuses: ['done'], version: 8 });
  });
});

// =====================================================================
describe('reconnecting and racing loads (T-0160)', () => {
  it('re-reads everything when the stream comes back', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready')]));
    const before = board.fetch.boardCalls();

    board.sse.onerror();
    board.fetch.serve(boardAt(9, [task('T-0001', 'done'), task('T-0002', 'ready')]));
    board.sse.onopen();
    await flush();

    assert.strictEqual(board.fetch.boardCalls(), before + 1);
    assert.deepStrictEqual(board.probe().ids, ['T-0001', 'T-0002']);
    assert.strictEqual(board.probe().version, 9);
  });

  it('takes the board of a restarted server, whose version counter starts over', async () => {
    const board = await startBoard(boardAt(9, [task('T-0001', 'ready')]));

    board.sse.onerror();
    board.fetch.serve(boardAt(0, [task('T-0001', 'done')]));
    board.sse.onopen();
    await flush();

    assert.deepStrictEqual(board.probe(), { ids: ['T-0001'], statuses: ['done'], version: 0 });

    // ...and the fresh counter is then followed as usual.
    board.sse.onmessage(frame({ base: 0, v: 1, tasks: [task('T-0001', 'review')], removed: [] }));
    await flush();
    assert.deepStrictEqual(board.probe(), { ids: ['T-0001'], statuses: ['review'], version: 1 });
  });

  it('does not lose an event that arrives while a full read is in flight', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready')]));
    const before = board.fetch.boardCalls();

    board.fetch.pause();
    board.fetch.serve(boardAt(6, [task('T-0001', 'open')]));
    board.sse.onmessage({ data: 'changed' }); // reload issued, now in flight
    await flush(1);

    board.fetch.serve(boardAt(7, [task('T-0001', 'done')]));
    board.sse.onmessage(frame({ base: 6, v: 7, tasks: [task('T-0001', 'done')], removed: [] }));
    await flush(1);

    board.fetch.resume();
    await flush();

    assert.strictEqual(board.fetch.boardCalls(), before + 2);
    assert.deepStrictEqual(board.probe(), { ids: ['T-0001'], statuses: ['done'], version: 7 });
  });

  it('never steps back to an older board than the one on screen', async () => {
    const board = await startBoard(boardAt(5, [task('T-0001', 'ready')]));

    board.fetch.pause();
    board.sse.onmessage({ data: 'changed' }); // answers with version 5, the state it was issued in
    await flush(1);

    board.sse.onmessage(frame({ base: 5, v: 6, tasks: [task('T-0001', 'done')], removed: [] }));
    await flush(1);
    assert.deepStrictEqual(board.probe(), { ids: ['T-0001'], statuses: ['done'], version: 6 });

    board.fetch.resume();
    await flush();
    assert.deepStrictEqual(board.probe(), { ids: ['T-0001'], statuses: ['done'], version: 6 });
  });
});
