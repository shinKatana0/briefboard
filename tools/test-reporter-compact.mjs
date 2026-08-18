// Default reporter for `npm test` (T-0105). A test that passed costs one
// character here and a whole line under the spec reporter, so what an agent
// re-reads three to six times per task shrinks by about two orders of
// magnitude — that ratio is the reason this file exists and it does not go
// stale. The absolute figures do, because they grow with the suite: measured
// 2026-08-17 at 2024 tests, one green run each, 48 lines / 2478 chars (~620
// tokens) compact against 2644 lines / 194853 chars (~48.7k) verbose, a token
// counted as four characters.
// Only that green noise is dropped: a failure still carries the file, the full
// test path, the message, the diff, the stack and the file's own stdout/stderr,
// and the tests/pass/fail totals are printed in both modes.
// A skipped test is not green noise either — it is a test that verified nothing
// — so each one is listed with the reason it gave (T-0244).
// Full spec output: npm run test:verbose

import { inspect } from 'node:util';
import path from 'node:path';

const DOTS_PER_LINE = 60;
const OUTPUT_CAP = 16 * 1024; // per file, kept only to be printed if it fails

function rel(file) {
  return file ? path.relative(process.cwd(), file) || file : '(unknown file)';
}

function formatError(error) {
  const err = error?.code === 'ERR_TEST_FAILURE' ? error.cause : error;
  if (err === undefined) return 'failed without an error';
  return inspect(err, { breakLength: Infinity });
}

function indent(text) {
  return text.split('\n').map((line) => (line ? `  ${line}` : line)).join('\n');
}

export default async function* compact(source) {
  const names = new Map(); // file -> enclosing test names, indexed by nesting
  const output = new Map(); // file -> its stdout/stderr, printed only if it fails
  const failures = [];
  const skipped = [];
  const diagnostics = [];
  let dots = 0;

  for await (const { type, data } of source) {
    const file = data.file ? path.resolve(data.file) : '';

    switch (type) {
      case 'test:start': {
        const stack = names.get(file) ?? [];
        stack.length = data.nesting;
        stack[data.nesting] = data.name;
        names.set(file, stack);
        break;
      }

      case 'test:stdout':
      case 'test:stderr': {
        const seen = output.get(file) ?? '';
        if (seen.length < OUTPUT_CAP) output.set(file, seen + data.message);
        break;
      }

      case 'test:pass':
      case 'test:fail': {
        // A skipped test is counted as a pass by node:test and looks like one
        // here — which is how a test that verifies nothing hides in a green run
        // (T-0244). It gets its own mark in the dots and its own list below.
        const skip = type === 'test:pass' && data.skip !== undefined && data.skip !== false;
        yield type === 'test:fail' ? 'X' : skip ? 's' : '.';
        if (++dots % DOTS_PER_LINE === 0) yield '\n';
        if (skip) {
          const stack = names.get(file) ?? [];
          skipped.push({
            file,
            name: [...stack.slice(0, data.nesting), data.name].filter(Boolean).join(' > '),
            // `skip: true` — skipped with no reason given. Saying so is the
            // point: an unexplained skip is what has to be noticed.
            reason: typeof data.skip === 'string' && data.skip.trim() !== '' ? data.skip : null,
          });
        }
        // A suite fails only because a test inside it did, and that test already
        // reported itself with the real error; reporting the suite too would
        // print the same failure a second time, nested.
        if (type === 'test:fail' && data.details?.error?.failureType !== 'subtestsFailed') {
          const stack = names.get(file) ?? [];
          failures.push({
            file,
            name: [...stack.slice(0, data.nesting), data.name].filter(Boolean).join(' > '),
            error: data.details?.error,
          });
        }
        break;
      }

      case 'test:diagnostic':
        if (data.nesting === 0) diagnostics.push(data.message);
        break;
    }
  }

  if (dots % DOTS_PER_LINE !== 0) yield '\n';

  if (failures.length > 0) {
    yield `\nfailures (${failures.length}):\n`;
    for (const failure of failures) {
      yield `\n✖ ${rel(failure.file)} > ${failure.name}\n`;
      yield `${indent(formatError(failure.error))}\n`;
    }

    const failedFiles = [...new Set(failures.map((f) => f.file))].filter(Boolean);
    for (const file of failedFiles) {
      const captured = output.get(file);
      if (captured) yield `\noutput of ${rel(file)}:\n${indent(captured.trimEnd())}\n`;
    }
    if (failedFiles.length > 0) {
      yield `\nre-run in full: node --test --test-reporter=spec ${failedFiles.map(rel).join(' ')}\n`;
    }
  }

  if (skipped.length > 0) {
    yield `\nskipped (${skipped.length}):\n`;
    for (const test of skipped) {
      yield `○ ${rel(test.file)} > ${test.name} — ${test.reason ?? 'no reason given'}\n`;
    }
  }

  yield '\n';
  for (const message of diagnostics) yield `ℹ ${message}\n`;
}
