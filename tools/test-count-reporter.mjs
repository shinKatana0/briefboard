// How a run tells `tools/test-run.mjs` whether anything actually ran (T-0250).
// node:test calls a run of zero tests a success, so the wrapper has to count
// them itself — and it cannot read the count off the output, because every
// reporter formats its totals differently and the wrapper must work with
// whichever one it was handed. So the number comes back out of band.
//
// Out of band used to mean a file, in a `briefboard-run-` directory the wrapper
// made and removed. T-0265 got that directory removed on every path the process
// can act on and no further: a hard kill runs no handler at all — measured
// 2026-08-17 (Windows 11, node v24.18.0), a process killed with
// `process.kill(pid,'SIGINT')`, with 'SIGTERM' or with `taskkill /t /f` ran none
// of its handlers in all three cases. So the artifact is gone instead of being
// cleaned up better (T-0276): a reporter runs INSIDE the runner process, and the
// wrapper spawns that process with an `ipc` slot, so the number is a message and
// there is no file, no directory, and nothing any kill can leave behind.
//
// Nothing is yielded. The destination this reporter is paired with is stdout,
// like every other reporter on the line, and it receives not one byte — the
// run's own report is untouched.
//
// Suites are left out, so the number counts what node's own summary calls
// tests: a suite emits `test:pass` of its own on top of every test inside it.

// Imported by the wrapper rather than spelled twice: the two ends of a private
// protocol that drift apart lose the count silently, and a lost count is the
// one thing this file exists to prevent.
export const COUNT_MESSAGE = 'briefboard:executed';

// The same channel carries which tests are running right now (T-0272).
//
// When the silence watchdog kills a run, all the wrapper knew was how many marks
// had been printed — "273 dots, then nothing", a count with no name — and the
// report of a killed run dies with it. The advice it prints instead points
// backwards: re-run under `test:verbose` and read its last line. That works only
// for a failure that reproduces on demand, and this one needs a loaded machine
// and turned up twice in a month.
//
// node:test does say which test is running, and it is NOT `test:start`.
// Measured (node v24.18.0, two fixtures, one four-second test and one that never
// finishes): `test:start` and `test:pass`/`test:fail` are REPORTING events and
// arrive together when the test is over — the start of a four-second test
// reached the reporter at 4319ms, the start of the suite around it at 8331ms,
// and a test that hung was never announced at all in six seconds of waiting.
// `test:dequeue` and `test:complete` are the live pair: the hanging test was
// dequeued at 62ms, while it was still running, and completed only when the
// per-test limit ended it at 2073ms. So those two are what is relayed, and the
// compact reporter's own name stack is left alone — it needs the names at the
// end, which is exactly what `test:start` gives it.
//
// Sent per event rather than as a snapshot because a hang produces no further
// event: whatever the wrapper is to know at the kill has to have been sent
// before the run went quiet. Measured, 10000 process.send() calls of this shape
// cost 80ms in the sending process — some 40ms over a run of this suite, which
// is why it is not gated behind a flag nobody would have turned on.
export const RUNNING_MESSAGE = 'briefboard:running';

export default async function* count(source) {
  let executed = 0;
  const send = process.send ? (message) => process.send(message) : () => {};
  for await (const { type, data } of source) {
    if (type === 'test:dequeue' || type === 'test:complete') {
      send({
        type: RUNNING_MESSAGE,
        file: data.file ?? '',
        nesting: data.nesting,
        name: data.name,
        open: type === 'test:dequeue',
      });
    } else if ((type === 'test:pass' || type === 'test:fail') && data.details?.type !== 'suite') {
      executed += 1;
    }
  }
  // No channel means this was not started by the wrapper, and there is nobody
  // to tell. Deliberately not a fallback to a file: two mechanisms for one
  // number is how a guard rots — one of them stops being exercised and nobody
  // notices which — and a wrapper that hears nothing already fails loudly.
  if (process.send) process.send({ type: COUNT_MESSAGE, executed });
}
