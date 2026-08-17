'use strict';

// T-0124: the suite hung forever, three times in ~30 runs. Two habits caused it,
// and both are invisible in a green run — which is why they are asserted here
// instead of trusted to review:
//   1. a server spawned with a stdout pipe nobody reads: the pipe fills, the
//      server blocks on writing to it and stops answering;
//   2. a request on the global `fetch`, which has no timeout at all: one stalled
//      request and the test waits for it until the end of time.
// Run with: npm test

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripProse } = require('./helpers/js-source.js');

const TESTS_DIR = __dirname;
const HELPERS_DIR = path.join(TESTS_DIR, 'helpers');

function testFiles() {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(TESTS_DIR, name), 'utf8') }));
}

// `bounded.js` is left out by default: it IS the bounded fetch, so the rule
// below would have it import itself. A rule that applies to it too asks for it
// back with { withBounded: true }.
function sources({ withBounded = false } = {}) {
  const files = fs
    .readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join(TESTS_DIR, name));
  for (const name of fs.readdirSync(HELPERS_DIR)) {
    if (name.endsWith('.js') && (withBounded || name !== 'bounded.js')) {
      files.push(path.join(HELPERS_DIR, name));
    }
  }
  return files.map((file) => ({
    name: path.relative(path.join(TESTS_DIR, '..'), file).replace(/\\/g, '/'),
    text: fs.readFileSync(file, 'utf8'),
  }));
}

// Comments and quoted messages are prose, and a mention is not a call: a file
// that only NAMES the idiom must not be forced to import it (T-0138). The
// require the assertion then looks for is itself a quoted path, so that one
// still reads the raw source.
// `function fetch(` is a definition, not a call — tests/helpers/ui-harness.js
// builds a fake one for the browser sandbox.
function fetchCalls(text) {
  const code = stripProse(text, { emptyStrings: true }).replace(/function fetch\(/g, '');
  return code.match(/(?<![.\w])fetch\(/g) || [];
}

// T-0189. The mine this looks for: a helper is handed a function and decides
// whether to keep waiting by CALLING it in a condition — `if (predicate())`,
// `while (!predicate(buf))`. Hand that helper an async function and the
// condition sees a promise, which is always truthy, so the wait ends on its
// first turn: it bounds nothing, the assertion after it is checked against a
// condition that never arrived, and the request the predicate started is left
// with no owner for the teardown to reset (T-0183 — `read ECONNRESET`, blamed on
// the board through three cards). `await` costs a sync predicate nothing, so the
// rule is unconditional.
//
// Found by shape rather than by name, and that is what it was worth: the seven
// copies T-0189 was filed on were collected by grepping for `waitFor`, and this
// scan then turned up three more the grep could not see — one in
// `waitForBoard`, two in `readUntil`.
//
// A "function" here is `function f(args) {` or `(args) => {`; a method shorthand
// would be missed, and there is none in tests/. Nested functions are scanned
// once on their own and once inside their parent, which can only over-report —
// and the assertion is that there is nothing to report.
//
// T-0223 widened it by one hop. Written the other obvious way the mine is
// unchanged and the scan above saw nothing:
//
//     const value = predicate();      // tests/leftovers.test.js, until T-0223
//     if (value) return value;        // tests/helpers/board.js, `read()`
//
// so a call whose result is BOUND, and whose binding then decides a condition,
// counts exactly as much as the call written into the condition itself. One hop
// and no further, and that limit is measured rather than felt: a rule over every
// used result reports 19 places on this tree, 17 of them `new Promise((resolve)
// => resolve(x))`, which is not a wait and never was — ten files of exemptions,
// and an exempted guard is a dead guard (T-0189). At one hop it reports two, and
// both were the mine.
const TAKES_ARGS = String.raw`(?:^|[^\w$])(?:function\s*[\w$]*\s*|(?:async\s*)?)\(([^()]*)\)\s*(?:=>\s*)?\{`;

function balanced(code, open, openCh, closeCh) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === openCh) depth++;
    else if (code[i] === closeCh) {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

function paramNames(list) {
  return list
    .split(',')
    .map((param) => param.trim().split('=')[0].trim())
    .filter((param) => /^[A-Za-z_$][\w$]*$/.test(param));
}

const oneLine = (text) => text.trim().replace(/\s+/g, ' ');

// `const x = param(`, `let { a, b } = param(` — the binding a call was poured
// into. A destructuring pattern is taken whole because its defaults contain `=`.
const bindingOf = (param) =>
  new RegExp(
    `(?:const|let|var)\\s+(\\{[^}]*\\}|\\[[^\\]]*\\]|[A-Za-z_$][\\w$]*)\\s*=\\s*(?<!await\\s)(?<![.\\w$])${param}\\s*\\(`,
    'g'
  );

function unawaitedConditions(text) {
  const code = stripProse(text, { emptyStrings: true });
  const found = [];
  const functions = new RegExp(TAKES_ARGS, 'g');
  let fn;
  while ((fn = functions.exec(code))) {
    const params = paramNames(fn[1]);
    if (!params.length) continue;
    const body = balanced(code, code.indexOf('{', fn.index + fn[0].length - 1), '{', '}');
    // Only a CONDITION counts: the call decides whether the wait goes on.
    const heads = [];
    const conditions = /(?<![\w$])(if|while)\s*\(/g;
    let cond;
    while ((cond = conditions.exec(body))) {
      heads.push({ keyword: cond[1], head: balanced(body, cond.index + cond[0].length - 1, '(', ')') });
    }
    for (const param of params) {
      const calls = new RegExp(`(?<!await\\s)(?<![.\\w$])${param}\\s*\\(`);
      for (const { keyword, head } of heads) {
        if (calls.test(head)) found.push(`${keyword} (${oneLine(head)})`);
      }
      // …and the same call one binding away from the condition it decides.
      for (const bound of body.matchAll(bindingOf(param))) {
        for (const name of bound[1].match(/[A-Za-z_$][\w$]*/g) || []) {
          const reads = new RegExp(`(?<![.\\w$])${name}(?![\\w$])`);
          const at = heads.find(({ head }) => reads.test(head));
          if (at) found.push(`${name} = ${param}(…), then ${at.keyword} (${oneLine(at.head)})`);
        }
      }
    }
  }
  return found;
}

// An array literal says which slot is a pipe. The string form (`stdio: 'pipe'`)
// appears only on the synchronous calls, where Node reads the pipes for you and
// nothing can fill.
function pipedStdout(code) {
  return (code.match(/stdio:\s*\[[^\]]*\]/g) || []).filter((opt) => {
    const slots = opt.match(/'[^']*'/g) || [];
    return slots[1] === "'pipe'";
  });
}

// The scan itself, on sources written here rather than read from disk: what it
// must ignore is prose, and what it must still catch is a call (T-0138). Every
// fixture is a quoted string, which is also why this file needs no bounded
// fetch of its own.
describe('the scan reads code, not the prose around it (T-0138)', () => {
  it('a call in a comment is not a call', () => {
    assert.deepStrictEqual(fetchCalls('// the habit this replaces: fetch(url)\n'), []);
    assert.deepStrictEqual(fetchCalls('/*\n * await fetch(url) has no deadline\n */\n'), []);
  });

  it('a call quoted in a message is not a call either', () => {
    assert.deepStrictEqual(fetchCalls("throw new Error('use fetch(url) from bounded.js');"), []);
  });

  it('a real call is still found, whatever prose surrounds it', () => {
    assert.strictEqual(fetchCalls('const res = await fetch(url);').length, 1);
    assert.strictEqual(fetchCalls('// fetch(a) is banned\nawait fetch(b);').length, 1);
    assert.deepStrictEqual(fetchCalls('await res.fetch(url);'), []);
    assert.deepStrictEqual(fetchCalls('function fetch(input) {}'), []);
  });

  it('a // inside a string does not swallow the code after it', () => {
    assert.strictEqual(fetchCalls("await fetch('http://127.0.0.1/api'); await fetch(b);").length, 2);
  });

  it('a quote inside a regex literal does not open a string', () => {
    assert.strictEqual(fetchCalls("s.match(/'[^']*/); await fetch(b);").length, 1);
    assert.strictEqual(fetchCalls('s.split(/[/]/); await fetch(b);').length, 1);
  });

  it('the unread-pipe scan ignores a comment too', () => {
    // Spelled in pieces so this file does not match its own pattern.
    const opt = 'stdio' + ": ['ignore', 'pipe', 'pipe']";
    assert.deepStrictEqual(pipedStdout(stripProse(`// spawn with ${opt}\n`)), []);
    assert.strictEqual(pipedStdout(stripProse(`spawn(cmd, { ${opt} });`)).length, 1);
  });
});

describe('no test can wait forever (T-0124)', () => {
  for (const { name, text } of sources()) {
    const code = stripProse(text);
    const calls = fetchCalls(text);
    if (calls.length) {
      it(`${name} takes fetch from helpers/bounded.js, not the unbounded global`, () => {
        assert.match(
          text,
          /require\('\.\/helpers\/bounded\.js'\)/,
          `${name} calls fetch ${calls.length} time(s); import it from helpers/bounded.js so every ` +
            'request has a deadline'
        );
        assert.match(text, /\bfetch\b[^=]*\}\s*=\s*require\('\.\/helpers\/bounded\.js'\)/);
      });
    }

    if (pipedStdout(code).length) {
      it(`${name} reads the stdout it pipes`, () => {
        assert.match(
          code,
          /\.stdout\.on\(/,
          `${name} pipes a child's stdout and never reads it: the pipe fills and the child blocks. ` +
            "Read it, or spawn with stdio ['ignore', 'ignore', 'pipe']"
        );
      });
    }
  }
});

// Every fixture below is written in SINGLE-quoted pieces, which the scan empties
// (T-0138): a file that has to spell the mine in order to look for it must not
// be caught by its own rule.
const OLD_WAIT = [
  'async function waitFor(predicate, timeoutMs, what) {',
  '  const deadline = Date.now() + timeoutMs;',
  '  while (Date.now() < deadline) {',
  '    if (predicate()) return;',
  '    await sleep(25);',
  '  }',
  '  throw new Error(what);',
  '}',
].join('\n');

// The same mine, and the reason T-0223 exists: tests/leftovers.test.js wrote its
// copy this way, so the scan above walked past a file that had both the copy and
// the hole in the guard.
const BOUND_WAIT = [
  'async function waitFor(predicate, what, timeoutMs) {',
  '  const deadline = Date.now() + timeoutMs;',
  '  while (Date.now() < deadline) {',
  '    const value = predicate();',
  '    if (value) return value;',
  '    await sleep(50);',
  '  }',
  '  throw new Error(what);',
  '}',
].join('\n');

describe('a wait cannot end on its first turn (T-0183, T-0189)', () => {
  it('the shape that cost three cards is caught', () => {
    assert.deepStrictEqual(unawaitedConditions(OLD_WAIT), ['if (predicate())']);
  });

  it('and so is the same mine written as a loop head', () => {
    assert.deepStrictEqual(
      unawaitedConditions('async function readUntil(predicate) { while (!predicate(buffer)) { await read(); } }'),
      ['while (!predicate(buffer))']
    );
  });

  it('an arrow helper hides nothing', () => {
    assert.deepStrictEqual(
      unawaitedConditions('const waitFor = async (check) => { if (check()) return; };'),
      ['if (check())']
    );
  });

  it('the awaited form passes, which is the whole of the fix', () => {
    assert.deepStrictEqual(unawaitedConditions(OLD_WAIT.replace('if (predicate())', 'if (await predicate())')), []);
    assert.deepStrictEqual(
      unawaitedConditions('async function readUntil(predicate) { while (!(await predicate(buffer))) { } }'),
      []
    );
  });

  it('pouring the call into a variable first hides nothing either (T-0223)', () => {
    assert.deepStrictEqual(unawaitedConditions(BOUND_WAIT), ['value = predicate(…), then if (value)']);
  });

  it('and neither does destructuring what it handed back (T-0223)', () => {
    // tests/helpers/board.js reads its banner exactly so.
    assert.deepStrictEqual(
      unawaitedConditions('async function waitForBanner(proc, read) { const { out } = read(); if (out) return out; }'),
      ['out = read(…), then if (out)']
    );
  });

  it('awaiting the bound call is the fix there too', () => {
    assert.deepStrictEqual(unawaitedConditions(BOUND_WAIT.replace('= predicate()', '= await predicate()')), []);
  });

  it('a callback that is not what the condition asks about is left alone', () => {
    // `if (mutate)` tests the function, it does not call it; the call after it
    // decides nothing. tests/update-cli.test.js is written exactly so.
    assert.deepStrictEqual(
      unawaitedConditions('function makePackage(dir, mutate) { if (mutate) mutate(dir); return dir; }'),
      []
    );
    // And a binding no condition ever reads is not a wait: this is where the one
    // hop stops, on purpose (see TAKES_ARGS above).
    assert.deepStrictEqual(
      unawaitedConditions('function makeRunner(project, create) { const runner = create(project); return runner; }'),
      []
    );
  });

  it('the mine named in a comment or a message is not the mine', () => {
    assert.deepStrictEqual(unawaitedConditions('function f(predicate) {\n// if (predicate()) return;\n}'), []);
    assert.deepStrictEqual(unawaitedConditions("function f(predicate) { throw new Error('if (predicate())'); }"), []);
  });

  for (const { name, text } of sources({ withBounded: true })) {
    it(`${name} awaits the condition it was handed`, () => {
      assert.deepStrictEqual(
        unawaitedConditions(text),
        [],
        `${name} decides whether to keep waiting by calling a function it was given, without awaiting ` +
          'it. An async one hands back a promise, a promise is truthy, and the wait ends on its first ' +
          'turn against a condition that never arrived. Write await, or take the wait from ' +
          'tests/helpers/wait.js'
      );
    });
  }
});

// T-0119: whatever the machine holds in its environment, the suite must see the
// product's defaults. `tests/helpers/env.js` clears them, and it has to be the
// FIRST require: server/parser.js reads its lock budget at load, so a require
// landing after it neutralises nothing. Asserted rather than remembered, because
// a file added without the line still passes on a clean machine and fails only
// inside a configured board's session.
// An empty PORT starts the board's scan from 4571, and 4571-4590 is 20 ports
// for every board on the machine — a person's own boards included. One suite
// already holds several at a time (node --test runs the files in parallel), and
// four suites at once exhausted the range: four tests died with "no free port".
// Invisible in a single green run, which is why it is asserted here.
describe('no test board competes for the human port range (T-0139)', () => {
  const emptyPort = new RegExp("PORT:\\s*''");
  // Not itself: this file has to name the pattern in order to look for it.
  for (const { name, text } of sources().filter((f) => !f.name.endsWith('suite-hygiene.test.js'))) {
    it(`${name} does not start a board on the 4571 scan`, () => {
      assert.doesNotMatch(
        text,
        emptyPort,
        `${name} spawns a board with an empty PORT, which scans 4571-4590; pass PORT: AUTO_PORT_VALUE ` +
          "('auto') instead, and read the port it bound off the banner"
      );
    });
  }
});

// T-0200. `fs.rm`'s own maxRetries/retryDelay read as a retry budget and are not
// one: measured here (Windows 11, node v24.18.0), a directory held as a live
// process's cwd throws EPERM after 1 ms and spends none of the 2 s the options
// promise — indistinguishable from the same call with no options at all. Eleven
// test files believed in it, seven of them inside a hand-rolled retry loop of
// their own whose 0.4 s stood against a release lag measured at up to 1.0 s; one
// of those seven failed in four loaded runs out of four.
//
// Every one of those seven hand-rolled removers ALSO carried `maxRetries: 3`
// inside its loop, which is what makes this narrow rule enough: the imaginary
// budget is the tell of the copied idiom, so banning it catches the copy too.
//
// What is deliberately NOT banned is a plain `fs.rmSync(dir, { recursive: true,
// force: true })`. It claims no protection, and a rule that pushed every removal
// through tests/helpers/rm.js would need an exception for each teardown that has
// never had a process holding its directory — the guard-with-ten-exceptions
// T-0189 concluded is dead.
const IMAGINARY_BUDGET = /(?<![\w$])(?:maxRetries|retryDelay)\s*:/;
// The one file allowed to write it: tests/rm-helper.test.js IS the measurement
// this rule rests on, and asserts that the call throws with the budget unspent.
const OWNS_THE_RM_MEASUREMENT = 'tests/rm-helper.test.js';

// T-0209. `process.kill(pid, 0)` succeeds for a POSIX process that has been
// killed and not yet reaped, so a test that writes the check by hand reads a
// zombie as a live session. Measured in node:22-bookworm without `--init`, that
// cost two tests: one waited out its 30 s and one asserted true !== false; with
// the board's own isProcessAlive() the same two are green in 8 s.
const RAW_LIVENESS = /(?<![.\w$])process\.kill\(\s*[^,()]+,\s*0\s*\)/;
// tests/leftovers.test.js STAGES a zombie, and proves the staging with the very
// check the product stopped trusting — `kill(pid, 0)` still succeeding for it is
// how that test avoids passing vacuously. Everything else in the file goes
// through isProcessAlive().
const STAGES_A_ZOMBIE = 'tests/leftovers.test.js';

// Both patterns have to be spelled here in order to be looked for, and a regex
// literal is code to `stripProse` — hence this file's own exclusion, the same
// way the 4571 scan excludes itself.
const SCANNER = 'tests/suite-hygiene.test.js';

describe('a teardown does not wear a budget it never spends (T-0200)', () => {
  it('the option is caught wherever it is written', () => {
    assert.match(stripProse('fs.rmSync(d, { recursive: true, maxRetries: 20 });'), IMAGINARY_BUDGET);
    assert.match(stripProse('fs.rm(d, { retryDelay: 100 }, cb);'), IMAGINARY_BUDGET);
  });

  it('and named in prose it is not the option', () => {
    assert.doesNotMatch(stripProse('// maxRetries: 20 buys nothing here\n'), IMAGINARY_BUDGET);
    assert.doesNotMatch(
      stripProse("throw new Error('maxRetries: 20 is not a budget');", { emptyStrings: true }),
      IMAGINARY_BUDGET
    );
  });

  for (const { name, text } of sources().filter(
    (f) => f.name !== OWNS_THE_RM_MEASUREMENT && f.name !== SCANNER
  )) {
    it(`${name} does not hand fs.rm a budget it will not spend`, () => {
      assert.doesNotMatch(
        stripProse(text, { emptyStrings: true }),
        IMAGINARY_BUDGET,
        `${name} passes fs.rm maxRetries/retryDelay, which reads as seconds of waiting and spends ` +
          'none of them against the EPERM a teardown actually meets. Take removeTree from ' +
          'tests/helpers/rm.js, which waits for the directory itself and is bounded'
      );
    });
  }
});

describe('a test asks the product what is still alive (T-0202, T-0209)', () => {
  it('the hand-written check is caught', () => {
    assert.match(stripProse('if (process.kill(pid, 0)) return;'), RAW_LIVENESS);
    assert.match(stripProse('process.kill(running.pid, 0);'), RAW_LIVENESS);
  });

  it('and a real signal is not it', () => {
    assert.doesNotMatch(stripProse("process.kill(-proc.pid, 'SIGKILL');"), RAW_LIVENESS);
    assert.doesNotMatch(stripProse('process.kill(pid, 9);'), RAW_LIVENESS);
  });

  for (const { name, text } of sources().filter(
    (f) => f.name !== STAGES_A_ZOMBIE && f.name !== SCANNER
  )) {
    it(`${name} does not decide liveness with kill(pid, 0)`, () => {
      assert.doesNotMatch(
        stripProse(text, { emptyStrings: true }),
        RAW_LIVENESS,
        `${name} writes process.kill(pid, 0) itself. On POSIX that succeeds for a process that was ` +
          'killed and never reaped, so the test reads a zombie as alive; take isProcessAlive from ' +
          'server/sessions.js, which knows the difference'
      );
    });
  }
});

describe('the suite brings its own environment (T-0119)', () => {
  for (const { name, text } of testFiles()) {
    it(`tests/${name} clears the product environment before its first require`, () => {
      const first = text.search(/(?<![.\w])require\(/);
      assert.notStrictEqual(first, -1, `tests/${name} must require ./helpers/env.js`);
      assert.ok(
        text.slice(first).startsWith("require('./helpers/env.js');"),
        `tests/${name} must open with require('./helpers/env.js'); before any other require, so a ` +
          'variable inherited from the machine cannot reach a module that reads it at load'
      );
    });
  }
});
