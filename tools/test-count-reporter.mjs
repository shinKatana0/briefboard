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

export default async function* count(source) {
  let executed = 0;
  for await (const { type, data } of source) {
    if ((type === 'test:pass' || type === 'test:fail') && data.details?.type !== 'suite') executed += 1;
  }
  // No channel means this was not started by the wrapper, and there is nobody
  // to tell. Deliberately not a fallback to a file: two mechanisms for one
  // number is how a guard rots — one of them stops being exercised and nobody
  // notices which — and a wrapper that hears nothing already fails loudly.
  if (process.send) process.send({ type: COUNT_MESSAGE, executed });
}
