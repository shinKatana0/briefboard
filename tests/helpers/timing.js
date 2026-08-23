'use strict';

// Measurement scaffolding for the shared budgets (T-0270, T-0271, T-0272).
//
// Every budget this suite argues about is a number set on a quiet machine for
// an operation whose real cost nobody had timed under load. The way out of that
// argument is the one T-0177 used: time the population the budget bounds, on
// the machine and under the load in question, and derive the number from what
// was measured. This file is the recorder that makes such a round possible
// without a second wrapper — the waits themselves report what they cost.
//
// It is off unless BRIEFBOARD_TIMING_DIR names a directory OUTSIDE the working
// copy: a run that wrote samples into the repository would be failed by
// tools/test-run.mjs's dirty check, and rightly (T-0111). Off, `record()` is one
// comparison against a constant and nothing else, so the suite carries no cost
// for it between measurements.
//
// One file per process, named by pid, because a round is dozens of test
// processes across four concurrent suites and an interleaved append from that
// many writers is not a thing to trust on Windows. The fd is opened once and
// written with fs.writeSync: appendFileSync would open and close the file for
// every sample, which is itself an operation whose cost under load is what we
// came to measure.

const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.BRIEFBOARD_TIMING_DIR || '';
const enabled = DIR !== '';

let fd = null;
let broken = false;

function open() {
  if (fd !== null || broken) return fd;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fd = fs.openSync(path.join(DIR, `${process.pid}.jsonl`), 'a');
  } catch {
    // A recorder that throws would fail tests over the measurement rather than
    // over the thing measured, which is the one outcome that makes a round
    // worthless.
    broken = true;
  }
  return fd;
}

function record(kind, fields) {
  if (!enabled) return;
  const target = open();
  if (target === null) return;
  try {
    fs.writeSync(target, `${JSON.stringify({ t: Date.now(), pid: process.pid, kind, ...fields })}\n`);
  } catch {
    broken = true;
  }
}

// Milliseconds since an opaque start, monotonic — a wall clock that a laptop
// resynchronises mid-run would put negative durations in the samples.
function now() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

module.exports = { enabled, record, now };
