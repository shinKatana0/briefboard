'use strict';

// Unit tests for server/sessions.js — the agent session runner (T-0076).
// These exercise the registry directly, without an HTTP server, and NEVER run a
// real agent: every session here is a short `node -e ...` process.
// Run with: npm test  (or: node --test tests/**/*.test.js)

require('./helpers/env.js');
const { SPAWN_WAIT_BUDGET_MS, waitFor } = require('./helpers/wait.js');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  createSessionRunner,
  readSessionRegistry,
  isProcessAlive,
  parseCommandTemplate,
  substituteId,
  substitutePlaceholders,
  parseProfiles,
  compileTokenPattern,
  parseTokensMode,
  extractTokens,
  summarizeSessions,
  spawnFailureHint,
  MAX_FINISHED,
  MAX_HISTORY,
  REGISTRY_FILE,
  REGISTRY_VERSION,
} = require('../server/sessions.js');
const { stopProcess } = require('./helpers/bounded.js');
const { removeTree } = require('./helpers/rm.js');
const { tempDir } = require('./helpers/tmp.js');

// ---------- helpers ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Double quotes so a node path containing spaces survives the argv split; the
// -e scripts below therefore use single quotes only.
function q(value) {
  return `"${value}"`;
}

function nodeCmd(script, extraArgs = '') {
  return `${q(process.execPath)} -e ${q(script)}${extraArgs ? ' ' + extraArgs : ''}`;
}

const roots = [];
const runners = [];

function makeProject() {
  const root = tempDir('briefboard-sessions-test-');
  roots.push(root);
  return root;
}

function makeRunner(options = {}) {
  const logged = { warn: [], error: [] };
  const runner = createSessionRunner({
    project: options.project || makeProject(),
    logger: {
      warn: (m) => logged.warn.push(String(m)),
      error: (m) => logged.error.push(String(m)),
      log: () => {},
    },
    ...options,
  });
  runners.push(runner);
  runner.logged = logged;
  return runner;
}

function sessionsDir(project) {
  return path.join(project, '.briefboard', 'sessions');
}

function readLog(logPath) {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

// A value the session printed is ONE complete line of the log, never the whole
// file: the runner appends its own [briefboard] lines to the same log (T-0120).
function firstLogLine(logPath) {
  const text = readLog(logPath);
  const end = text.indexOf('\n');
  return end === -1 ? '' : text.slice(0, end).trim();
}

function registryFile(project) {
  return path.join(sessionsDir(project), REGISTRY_FILE);
}

function readRegistry(project) {
  return JSON.parse(fs.readFileSync(registryFile(project), 'utf8'));
}

function writeRegistry(project, payload) {
  fs.mkdirSync(sessionsDir(project), { recursive: true });
  fs.writeFileSync(
    registryFile(project),
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  );
}

function storedSession(over) {
  return {
    id: 'T-0011',
    kind: 'briefing',
    pid: 4242,
    startedAt: '2026-01-01T00:00:00.000Z',
    logPath: path.join('nowhere', 'T-0011.log'),
    status: 'running',
    exitCode: null,
    signal: null,
    endedAt: null,
    ...(over || {}),
  };
}

// A process this test process did not start, standing in for another board (or,
// once killed, for one that is gone). Real pids, because the liveness check is
// exactly what these tests are about.
const strangers = [];

function liveStranger() {
  const child = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], {
    stdio: 'ignore',
  });
  strangers.push(child);
  return child.pid;
}

async function deadPid() {
  const pid = liveStranger();
  await stopProcess(strangers[strangers.length - 1]);
  return pid;
}

afterEach(async () => {
  // Awaiting shutdown is not what makes the removal safe, though it read that
  // way until T-0195 measured it: what holds a project directory on Windows is
  // the session's CWD, not its log, and the cwd comes back a beat after the
  // process does — up to a second under four concurrent suites. This teardown
  // lost that race once (T-0197) with 0.4 s of its own retries; removeTree waits
  // for the directory itself, bounded.
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown()));
  for (const child of strangers.splice(0)) child.kill();
  while (roots.length) await removeTree(roots.pop());
});

// ---------- command template parsing ----------

describe('parseCommandTemplate — argv split without a shell', () => {
  it('splits on whitespace', () => {
    assert.deepStrictEqual(parseCommandTemplate('claude -p run'), ['claude', '-p', 'run']);
  });

  it('keeps a double-quoted run of spaces as ONE argv element', () => {
    assert.deepStrictEqual(parseCommandTemplate('claude -p "do the thing"'), [
      'claude',
      '-p',
      'do the thing',
    ]);
  });

  it('keeps a single-quoted run of spaces as ONE argv element', () => {
    assert.deepStrictEqual(parseCommandTemplate("claude -p 'do the thing'"), [
      'claude',
      '-p',
      'do the thing',
    ]);
  });

  it('lets one quote style hold the other verbatim', () => {
    assert.deepStrictEqual(parseCommandTemplate(`node -e "console.log('hi there')"`), [
      'node',
      '-e',
      "console.log('hi there')",
    ]);
  });

  it('treats backslashes literally (a Windows path survives unquoted)', () => {
    assert.deepStrictEqual(parseCommandTemplate('C:\\tools\\agent.exe -x'), [
      'C:\\tools\\agent.exe',
      '-x',
    ]);
  });

  it('collapses repeated whitespace and ignores leading/trailing space', () => {
    assert.deepStrictEqual(parseCommandTemplate('  a \t b   c  '), ['a', 'b', 'c']);
  });

  it('throws on an unterminated quote', () => {
    assert.throws(() => parseCommandTemplate('claude -p "unterminated'), /unterminated quote/);
  });

  it('throws on an empty template', () => {
    assert.throws(() => parseCommandTemplate('   '), /empty/);
  });
});

// T-0107: a headless session has no TTY, so a template without an explicit
// permission list produces a session that asks an absent human and exits 0
// having written nothing. What is shipped for copying has to carry the list.
describe('the shipped command templates grant tools explicitly', () => {
  const DOCS = [
    'README.md', 'README.ru.md', 'README.ja.md',
    'doc/guide/guide.en.md', 'doc/guide/guide.ru.md', 'doc/guide/guide.ja.md',
  ];
  const TAIL = "' \\\n  node server/server.js";

  const shippedArgv = (file, name) => {
    const text = fs
      .readFileSync(path.join(__dirname, '..', file), 'utf8')
      .split('\r\n')
      .join('\n');
    const start = text.indexOf(`${name}='`);
    assert.notStrictEqual(start, -1, `${file} must ship a ready-to-copy ${name}`);
    const end = text.indexOf(TAIL, start);
    assert.notStrictEqual(end, -1, `${name} in ${file} must end in the documented shape`);
    return parseCommandTemplate(text.slice(start + name.length + 2, end));
  };

  for (const file of DOCS) {
    it(`${file}: both templates put the prompt first and the flags after it`, () => {
      for (const name of ['BRIEFBOARD_SESSION_CMD', 'BRIEFBOARD_WORKER_CMD']) {
        const argv = shippedArgv(file, name);
        // The prompt before any flag: --allowedTools takes a list, so a flag in
        // front of it swallows the prompt as one more tool name.
        assert.ok(argv[2] && !argv[2].startsWith('-'), `${name} in ${file}: prompt must come before the flags`);
        const allowed = argv.indexOf('--allowedTools');
        assert.ok(allowed > 2, `${name} in ${file}: --allowedTools must follow the prompt`);
        assert.match(argv[allowed + 1], /Bash\(node tools\/task\.mjs:\*\)/);
      }
    });

    // T-0118: the runner puts AGENTBOARD_ROOT in the session's environment, so
    // the status write is an ordinary `node tools/task.mjs` call. Asking the
    // agent for an env prefix instead needed a rule matching the exact text of a
    // command the agent was free to write differently — twice it wrote it
    // otherwise and only the status write was blocked (T-0107, T-0112).
    it(`${file}: the worker template asks for no env prefix and ships no rule for one`, () => {
      const argv = shippedArgv(file, 'BRIEFBOARD_WORKER_CMD');
      for (const arg of argv) {
        // `$AGENTBOARD_ROOT/doc/brief/...` is where the briefs are read from
        // (T-0113); what must not come back is the variable as an assignment in
        // front of a command, and the relative path it replaced.
        assert.ok(
          !arg.includes('AGENTBOARD_ROOT=') && !arg.includes('../../..'),
          `the worker template in ${file} must not prefix a command with AGENTBOARD_ROOT: ${arg}`
        );
      }
      const allowed = argv[argv.indexOf('--allowedTools') + 1];
      assert.match(allowed, /Bash\(node tools\/task\.mjs:\*\)/);
      assert.strictEqual(argv[argv.indexOf('--disallowedTools') + 1], 'Edit(doc/backlog.md)');
    });

    // T-0113: the worktree is made from a commit, so the brief written for the
    // task minutes ago — an untracked file — is not in it. A prompt that sends
    // the session to the doc/brief/ under its own feet is the bug itself: the
    // session finds an empty directory and guesses.
    it(`${file}: the worker template reads the briefs from the shared checkout`, () => {
      const argv = shippedArgv(file, 'BRIEFBOARD_WORKER_CMD');
      const prompt = argv[2];
      const ROOT_PREFIX = '$AGENTBOARD_ROOT/';
      assert.match(
        prompt,
        /\$AGENTBOARD_ROOT\/doc\/brief\/\{id\}-\*\.md/,
        `the worker prompt in ${file} must name the shared checkout's brief path`
      );
      for (const match of prompt.matchAll(/(.{0,17})doc\/brief\/\{id\}/g)) {
        assert.ok(
          match[1].endsWith(ROOT_PREFIX),
          `the worker prompt in ${file} points at a brief path that is not under ${ROOT_PREFIX}: ${match[0]}`
        );
      }
      // The variable is in the session's environment either way; a tool call is
      // what turns it into a path the agent can open a file from.
      assert.match(argv[argv.indexOf('--allowedTools') + 1], /Bash\(printenv:\*\)/);
    });

    it(`${file}: the briefing template stays narrower than the worker one`, () => {
      const briefing = shippedArgv(file, 'BRIEFBOARD_SESSION_CMD');
      const allowed = briefing[briefing.indexOf('--allowedTools') + 1];
      assert.match(allowed, /Edit\(doc\/brief\/\*\*\)/);
      for (const wider of ['Bash(git:*)', 'Bash(npm test)', 'Edit(**)']) {
        assert.ok(!allowed.includes(wider), `a briefing session has no use for ${wider}`);
      }
    });
  }
});

describe('substituteId — the id can never change the argv structure', () => {
  it('substitutes inside elements, after the split', () => {
    const argv = parseCommandTemplate('agent --task "brief {id} now"');
    assert.deepStrictEqual(substituteId(argv, 'T-0007'), ['agent', '--task', 'brief T-0007 now']);
  });

  it('replaces every occurrence', () => {
    assert.deepStrictEqual(substituteId(['{id}-{id}'], 'T-0001'), ['T-0001-T-0001']);
  });

  it('never introduces new argv elements (argv length is fixed by the split)', () => {
    const argv = parseCommandTemplate('agent --task {id}');
    assert.strictEqual(substituteId(argv, 'T-0007').length, argv.length);
  });
});

// ---------- disabled by configuration ----------

describe('the runner is disabled unless it is deliberately configured', () => {
  it('no command → disabled, and startSession spawns nothing', async () => {
    const project = makeProject();
    const runner = makeRunner({ project });
    assert.strictEqual(runner.enabled, false);
    assert.deepStrictEqual(await runner.startSession('T-0001'), {
      started: false,
      reason: 'disabled',
    });
    assert.strictEqual(fs.existsSync(sessionsDir(project)), false);
  });

  it('an empty/whitespace command counts as no command', () => {
    assert.strictEqual(makeRunner({ command: '   ' }).enabled, false);
  });

  it('a non-loopback bind disables sessions even with a command, and warns', async () => {
    const project = makeProject();
    const runner = makeRunner({ project, command: nodeCmd('console.log(1)'), loopback: false });
    assert.strictEqual(runner.enabled, false);
    assert.match(runner.logged.warn.join('\n'), /WARNING/);
    assert.match(runner.logged.warn.join('\n'), /loopback/);
    assert.deepStrictEqual(await runner.startSession('T-0001'), {
      started: false,
      reason: 'disabled',
    });
    assert.strictEqual(fs.existsSync(sessionsDir(project)), false);
  });

  it('an unparseable template disables sessions and logs an error instead of throwing', async () => {
    const runner = makeRunner({ command: 'agent -p "unterminated' });
    assert.strictEqual(runner.enabled, false);
    assert.match(runner.logged.error.join('\n'), /not parseable/);
    assert.deepStrictEqual(await runner.startSession('T-0001'), {
      started: false,
      reason: 'disabled',
    });
  });
});

// ---------- the second command template (T-0084) ----------

describe('the worker command is configured, reported and run apart from the briefing one', () => {
  it('each kind is enabled only by its own template', () => {
    const briefingOnly = makeRunner({ command: nodeCmd('console.log(1)') });
    assert.strictEqual(briefingOnly.enabled, true);
    assert.strictEqual(briefingOnly.workerEnabled, false);
    assert.strictEqual(briefingOnly.workerDisabledReason, 'not configured');

    const workerOnly = makeRunner({ workerCommand: nodeCmd('console.log(1)') });
    assert.strictEqual(workerOnly.enabled, false);
    assert.strictEqual(workerOnly.disabledReason, 'not configured');
    assert.strictEqual(workerOnly.workerEnabled, true);
  });

  it('kind:"worker" runs the worker template, the default kind runs the briefing one', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      command: nodeCmd("console.log('briefing {id}')"),
      workerCommand: nodeCmd("console.log('working on {id}')"),
    });

    const briefing = await runner.startSession('T-0011');
    await waitFor(() => /briefing T-0011/.test(readLog(briefing.logPath)), SPAWN_WAIT_BUDGET_MS, 'the briefing output');
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the briefing session to exit');

    const worker = await runner.startSession('T-0012', { kind: 'worker' });
    await waitFor(() => /working on T-0012/.test(readLog(worker.logPath)), SPAWN_WAIT_BUDGET_MS, 'the worker output');
    assert.doesNotMatch(readLog(worker.logPath), /briefing/);
  });

  it('an unconfigured worker command answers "disabled" while briefing still starts', async () => {
    const runner = makeRunner({ command: nodeCmd('console.log(1)') });

    assert.deepStrictEqual(await runner.startSession('T-0011', { kind: 'worker' }), {
      started: false,
      reason: 'disabled',
    });
    assert.strictEqual((await runner.startSession('T-0011')).started, true);
  });

  it('an unparseable worker template disables only the worker kind, and names it', async () => {
    const runner = makeRunner({
      command: nodeCmd('console.log(1)'),
      workerCommand: 'agent -p "unterminated',
    });

    assert.strictEqual(runner.enabled, true);
    assert.strictEqual(runner.workerEnabled, false);
    assert.strictEqual(runner.workerDisabledReason, 'invalid command template');
    assert.match(runner.logged.error.join('\n'), /BRIEFBOARD_WORKER_CMD is not parseable/);
    assert.deepStrictEqual(await runner.startSession('T-0011', { kind: 'worker' }), {
      started: false,
      reason: 'disabled',
    });
  });

  it('a non-loopback bind disables both kinds and warns about each by name', () => {
    const runner = makeRunner({
      command: nodeCmd('console.log(1)'),
      workerCommand: nodeCmd('console.log(2)'),
      loopback: false,
    });

    assert.strictEqual(runner.enabled, false);
    assert.strictEqual(runner.workerEnabled, false);
    assert.strictEqual(runner.workerDisabledReason, 'non-loopback bind');
    const warnings = runner.logged.warn.join('\n');
    assert.match(warnings, /BRIEFBOARD_SESSION_CMD/);
    assert.match(warnings, /BRIEFBOARD_WORKER_CMD/);
  });

  it('the concurrency cap counts both kinds together', async () => {
    const long = nodeCmd('setInterval(function(){}, 1000)');
    const runner = makeRunner({ command: long, workerCommand: long, maxSessions: 1 });

    assert.strictEqual((await runner.startSession('T-0001')).started, true);
    assert.deepStrictEqual(await runner.startSession('T-0002', { kind: 'worker' }), {
      started: false,
      reason: 'limit',
    });
  });

  it('an unknown kind starts nothing', async () => {
    const runner = makeRunner({ command: nodeCmd('console.log(1)') });
    assert.deepStrictEqual(await runner.startSession('T-0011', { kind: 'nonsense' }), {
      started: false,
      reason: 'error',
    });
  });
});

// ---------- starting sessions ----------

describe('startSession', () => {
  it('spawns the configured command and captures stdout AND stderr into a log', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      command: nodeCmd("console.log('out for {id}'); console.error('err for {id}')"),
    });
    const result = await runner.startSession('T-0011');

    assert.strictEqual(result.started, true);
    assert.ok(result.pid > 0);
    assert.strictEqual(path.dirname(result.logPath), sessionsDir(project));
    assert.match(path.basename(result.logPath), /^T-0011-.*\.log$/);

    await waitFor(() => /out for T-0011/.test(readLog(result.logPath)), SPAWN_WAIT_BUDGET_MS, 'stdout in the log');
    await waitFor(() => /err for T-0011/.test(readLog(result.logPath)), SPAWN_WAIT_BUDGET_MS, 'stderr in the log');
  });

  it('logs live outside doc/ (a log there would become an SSE storm)', async () => {
    const project = makeProject();
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });
    const { logPath } = await runner.startSession('T-0011');
    const relative = path.relative(project, logPath).split(path.sep);
    assert.strictEqual(relative[0], '.briefboard');
    assert.notStrictEqual(relative[0], 'doc');
  });

  it('passes a quoted argument containing the substituted id as ONE argv element', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      command: nodeCmd(
        'console.log(JSON.stringify(process.argv.slice(1)))',
        `${q('refine {id} please')} plain`
      ),
    });
    const { logPath } = await runner.startSession('T-0011');
    await waitFor(() => firstLogLine(logPath) !== '', SPAWN_WAIT_BUDGET_MS, 'the child argv dump');
    assert.deepStrictEqual(JSON.parse(firstLogLine(logPath)), ['refine T-0011 please', 'plain']);
  });

  it('runs the session with the project as its cwd', async () => {
    const project = makeProject();
    const runner = makeRunner({ project, command: nodeCmd('console.log(process.cwd())') });
    const { logPath } = await runner.startSession('T-0011');
    await waitFor(() => firstLogLine(logPath) !== '', SPAWN_WAIT_BUDGET_MS, 'the cwd line');
    assert.strictEqual(fs.realpathSync(firstLogLine(logPath)), fs.realpathSync(project));
  });

  // T-0118: the project reaches the session as AGENTBOARD_ROOT, so its
  // `node tools/task.mjs` writes to the SHARED backlog with no env prefix for the
  // agent to type — and for a permission rule to fail to match.
  it('gives the session AGENTBOARD_ROOT pointing at the project', async () => {
    const project = makeProject();
    const runner = makeRunner({ project, command: nodeCmd('console.log(process.env.AGENTBOARD_ROOT)') });
    const { logPath } = await runner.startSession('T-0011');
    await waitFor(() => firstLogLine(logPath) !== '', SPAWN_WAIT_BUDGET_MS, 'the env dump');
    assert.strictEqual(fs.realpathSync(firstLogLine(logPath)), fs.realpathSync(project));
  });

  it('gives the worker session the same variable', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      workerCommand: nodeCmd('console.log(process.env.AGENTBOARD_ROOT)'),
    });
    const { logPath } = await runner.startSession('T-0011', { kind: 'worker' });
    await waitFor(() => firstLogLine(logPath) !== '', SPAWN_WAIT_BUDGET_MS, 'the env dump');
    assert.strictEqual(fs.realpathSync(firstLogLine(logPath)), fs.realpathSync(project));
  });

  it('the runner project wins over an AGENTBOARD_ROOT the board itself inherited', async () => {
    const project = makeProject();
    const foreign = makeProject();
    const previous = process.env.AGENTBOARD_ROOT;
    process.env.AGENTBOARD_ROOT = foreign;
    try {
      const runner = makeRunner({ project, command: nodeCmd('console.log(process.env.AGENTBOARD_ROOT)') });
      const { logPath } = await runner.startSession('T-0011');
      await waitFor(() => firstLogLine(logPath) !== '', SPAWN_WAIT_BUDGET_MS, 'the env dump');
      assert.strictEqual(fs.realpathSync(firstLogLine(logPath)), fs.realpathSync(project));
    } finally {
      if (previous === undefined) delete process.env.AGENTBOARD_ROOT;
      else process.env.AGENTBOARD_ROOT = previous;
    }
  });

  it('leaves the rest of the environment inherited (an agent CLI needs it)', async () => {
    const project = makeProject();
    const previous = process.env.BRIEFBOARD_TEST_MARKER;
    process.env.BRIEFBOARD_TEST_MARKER = 'inherited';
    try {
      const runner = makeRunner({
        project,
        command: nodeCmd('console.log(process.env.BRIEFBOARD_TEST_MARKER)'),
      });
      const { logPath } = await runner.startSession('T-0011');
      await waitFor(() => firstLogLine(logPath) !== '', SPAWN_WAIT_BUDGET_MS, 'the env dump');
      assert.strictEqual(firstLogLine(logPath), 'inherited');
    } finally {
      if (previous === undefined) delete process.env.BRIEFBOARD_TEST_MARKER;
      else process.env.BRIEFBOARD_TEST_MARKER = previous;
    }
  });

  it('refuses a second session for a task that already has a live one', async () => {
    const runner = makeRunner({ command: nodeCmd('setInterval(function(){}, 1000)') });
    const first = await runner.startSession('T-0011');
    assert.strictEqual(first.started, true);
    assert.deepStrictEqual(await runner.startSession('T-0011'), {
      started: false,
      reason: 'already-running',
    });
    assert.strictEqual(runner.list().filter((s) => s.status === 'running').length, 1);
  });

  it('refuses to start beyond BRIEFBOARD_SESSION_MAX', async () => {
    const runner = makeRunner({
      command: nodeCmd('setInterval(function(){}, 1000)'),
      maxSessions: 2,
    });
    assert.strictEqual((await runner.startSession('T-0001')).started, true);
    assert.strictEqual((await runner.startSession('T-0002')).started, true);
    assert.deepStrictEqual(await runner.startSession('T-0003'), { started: false, reason: 'limit' });
    assert.strictEqual(runner.list().filter((s) => s.status === 'running').length, 2);
  });

  it('a slot freed by a finished session can be used again', async () => {
    const runner = makeRunner({ command: nodeCmd('0'), maxSessions: 1 });
    const first = await runner.startSession('T-0001');
    assert.strictEqual(first.started, true);
    await waitFor(() => runner.get('T-0001').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the first session to exit');
    assert.strictEqual((await runner.startSession('T-0002')).started, true);
  });

  it('rejects anything that is not a task id instead of interpolating it', async () => {
    const runner = makeRunner({ command: nodeCmd('console.log(1)') });
    for (const bad of ['', 'T-1', 'nope', '../etc', 'T-0001; rm -rf /']) {
      assert.deepStrictEqual(await runner.startSession(bad), { started: false, reason: 'error' });
    }
  });
});

// ---------- failures ----------

describe('a failed spawn is reported, not thrown', () => {
  it('a non-existent binary resolves to { started:false, reason:"error" }', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      command: 'briefboard-no-such-binary-xyz --task {id}',
    });
    const result = await runner.startSession('T-0011');
    assert.deepStrictEqual(result, { started: false, reason: 'error' });
    assert.match(runner.logged.error.join('\n'), /failed to start/);
    assert.strictEqual(runner.get('T-0011'), null);
    assert.strictEqual(runner.list().length, 0);
  });

  it('writes the failure reason into the session log', async () => {
    const project = makeProject();
    const runner = makeRunner({ project, command: 'briefboard-no-such-binary-xyz {id}' });
    await runner.startSession('T-0011');
    const dir = sessionsDir(project);
    // The log stream is opened and flushed asynchronously, so wait for the file.
    await waitFor(() => fs.readdirSync(dir).length === 1, SPAWN_WAIT_BUDGET_MS, 'the log file to appear');
    const [file] = fs.readdirSync(dir);
    await waitFor(
      () => /failed to start session/.test(readLog(path.join(dir, file))),
      SPAWN_WAIT_BUDGET_MS,
      'the failure note in the log'
    );
  });

  // T-0086. The platform is always passed in: this suite must behave the same on
  // the Windows machine where the .cmd shim was measured and on POSIX CI.
  describe('the Windows .cmd-shim hint', () => {
    const einval = Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

    it('explains what to do instead, naming the template it applies to', () => {
      const hint = spawnFailureHint(einval, 'win32', 'BRIEFBOARD_SESSION_CMD');
      assert.match(hint, /\.cmd/);
      assert.match(hint, /claude\.exe/);
      assert.match(hint, /cmd \/c/);
      assert.match(hint, /BRIEFBOARD_SESSION_CMD/);
      assert.ok(spawnFailureHint(enoent, 'win32', 'BRIEFBOARD_WORKER_CMD').length > 0);
    });

    it('is not given off Windows, nor for unrelated error codes', () => {
      assert.strictEqual(spawnFailureHint(einval, 'linux', 'BRIEFBOARD_SESSION_CMD'), '');
      assert.strictEqual(spawnFailureHint(enoent, 'darwin', 'BRIEFBOARD_SESSION_CMD'), '');
      const eacces = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
      assert.strictEqual(spawnFailureHint(eacces, 'win32', 'BRIEFBOARD_SESSION_CMD'), '');
    });

    it('reaches the server log and the session log, without changing the reason', async () => {
      const project = makeProject();
      const runner = makeRunner({
        project,
        platform: 'win32',
        command: 'briefboard-no-such-binary-xyz {id}',
      });
      const result = await runner.startSession('T-0011');
      assert.deepStrictEqual(result, { started: false, reason: 'error' });
      assert.match(runner.logged.error.join('\n'), /cmd \/c/);

      const dir = sessionsDir(project);
      await waitFor(() => fs.readdirSync(dir).length === 1, SPAWN_WAIT_BUDGET_MS, 'the log file to appear');
      const [file] = fs.readdirSync(dir);
      await waitFor(
        () => /cmd \/c/.test(readLog(path.join(dir, file))),
        SPAWN_WAIT_BUDGET_MS,
        'the hint in the session log'
      );
      assert.match(readLog(path.join(dir, file)), /failed to start session/);
    });

    it('names BRIEFBOARD_WORKER_CMD when it is the worker session that failed', async () => {
      const runner = makeRunner({
        platform: 'win32',
        workerCommand: 'briefboard-no-such-binary-xyz {id}',
      });
      await runner.startSession('T-0011', { kind: 'worker' });
      assert.match(runner.logged.error.join('\n'), /BRIEFBOARD_WORKER_CMD/);
    });

    it('is absent on POSIX, where the same failure has other causes', async () => {
      const project = makeProject();
      const runner = makeRunner({
        project,
        platform: 'linux',
        command: 'briefboard-no-such-binary-xyz {id}',
      });
      await runner.startSession('T-0011');
      assert.match(runner.logged.error.join('\n'), /failed to start/);
      assert.doesNotMatch(runner.logged.error.join('\n'), /cmd \/c/);

      const dir = sessionsDir(project);
      await waitFor(() => fs.readdirSync(dir).length === 1, SPAWN_WAIT_BUDGET_MS, 'the log file to appear');
      const [file] = fs.readdirSync(dir);
      await waitFor(
        () => /failed to start session/.test(readLog(path.join(dir, file))),
        SPAWN_WAIT_BUDGET_MS,
        'the failure note in the log'
      );
      assert.doesNotMatch(readLog(path.join(dir, file)), /cmd \/c/);
    });
  });

  it('a failed spawn consumes no concurrency slot (the next attempt is not "limit")', async () => {
    const runner = makeRunner({ command: 'briefboard-no-such-binary-xyz {id}', maxSessions: 1 });
    await runner.startSession('T-0011');
    assert.strictEqual(runner.list().filter((s) => s.status === 'running').length, 0);
    assert.deepStrictEqual(await runner.startSession('T-0012'), { started: false, reason: 'error' });
  });
});

// ---------- registry bookkeeping ----------

describe('registry bookkeeping', () => {
  it('records exitCode and endedAt when a session finishes', async () => {
    const runner = makeRunner({ command: nodeCmd('process.exit(3)') });
    await runner.startSession('T-0011');
    assert.strictEqual(runner.get('T-0011').status, 'running');
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the session to exit');
    const record = runner.get('T-0011');
    assert.strictEqual(record.exitCode, 3);
    assert.ok(record.endedAt, 'endedAt is set');
    assert.ok(new Date(record.endedAt) >= new Date(record.startedAt));
  });

  // What is checked here is bookkeeping — a cap and the order things leave in —
  // and it used to be checked by starting MAX_FINISHED + 5 = 25 real sessions in
  // sequence, because at the shipped cap that is what "one more than the cap"
  // costs. Measured on 2026-08-16: 21 s idle, 83 s with four full suites running,
  // which put the test past the 120 s per-test backstop in 4 of 4 loaded runs and
  // bought it a five-minute bound of its own. The cap is now an argument
  // (T-0185), so the same eviction shows itself in three spawns and no special
  // bound.
  //
  // Still integration, deliberately: three REAL processes start, run and exit,
  // and the eviction is driven by their real exits through the same
  // rememberFinished the product uses. Nothing here is stubbed — what shrank is
  // the number of processes needed to see the third one push the first out, not
  // the path being exercised.
  it('evicts the oldest finished session once the cap is reached', async () => {
    const runner = makeRunner({ command: nodeCmd('0'), maxSessions: 1, maxFinished: 2 });
    const ids = ['T-0001', 'T-0002', 'T-0003'];
    for (const id of ids) {
      const started = await runner.startSession(id);
      assert.strictEqual(started.started, true, `session ${id} should have started`);
      await waitFor(() => runner.get(id) && runner.get(id).status === 'exited', SPAWN_WAIT_BUDGET_MS, `${id} to exit`);
    }

    assert.strictEqual(runner.list().length, 2);
    assert.strictEqual(runner.get('T-0001'), null, 'the oldest finished session was evicted');
    assert.ok(runner.get('T-0002'), 'T-0002 kept');
    assert.ok(runner.get('T-0003'), 'T-0003 kept');
  });

  // The cap the shipped board runs with, asserted where it can be asserted for
  // free. Twenty-five processes never proved this either — they proved eviction
  // at 20, and only because the test had hard-coded the same constant.
  it(`keeps ${MAX_FINISHED} finished sessions unless told otherwise`, () => {
    assert.strictEqual(makeRunner({ command: nodeCmd('0') }).maxFinished, MAX_FINISHED);
    assert.strictEqual(makeRunner({ command: nodeCmd('0'), maxFinished: 3 }).maxFinished, 3);
    for (const unusable of [undefined, null, '', 'abc', 0, -5, NaN]) {
      assert.strictEqual(
        makeRunner({ command: nodeCmd('0'), maxFinished: unusable }).maxFinished,
        MAX_FINISHED,
        `an unusable cap (${JSON.stringify(unusable)}) must not turn the limit off`
      );
    }
  });

  it('a restarted task replaces its own finished record instead of duplicating it', async () => {
    const runner = makeRunner({ command: nodeCmd('0'), maxSessions: 1 });
    const first = await runner.startSession('T-0011');
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the first session to exit');
    const second = await runner.startSession('T-0011');
    assert.strictEqual(second.started, true);
    assert.notStrictEqual(second.logPath, first.logPath);
    assert.strictEqual(runner.list().filter((s) => s.id === 'T-0011').length, 1);
  });
});

// ---------- reading a session log (T-0077) ----------

describe('readLogTail', () => {
  it('reads the log by task id — the caller never supplies a path', async () => {
    const runner = makeRunner({ command: nodeCmd("console.log('hello T-0011')") });
    const { logPath } = await runner.startSession('T-0011');
    await waitFor(() => readLog(logPath).includes('hello'), SPAWN_WAIT_BUDGET_MS, 'the session output');

    const tail = runner.readLogTail('T-0011');
    assert.strictEqual(tail.ok, true);
    assert.match(tail.text, /hello T-0011/);
    assert.strictEqual(tail.truncated, false);
    assert.ok(tail.totalBytes > 0);
  });

  it('returns the tail, not the whole file, and still reports the full size', async () => {
    const runner = makeRunner({
      command: nodeCmd("for (var i = 0; i < 500; i++) console.log('line ' + i)"),
    });
    const { logPath } = await runner.startSession('T-0011');
    await waitFor(() => readLog(logPath).includes('line 499'), SPAWN_WAIT_BUDGET_MS, 'the whole session output');
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the session to exit');

    const full = readLog(logPath);
    const tail = runner.readLogTail('T-0011', 200);
    assert.strictEqual(tail.ok, true);
    assert.strictEqual(tail.truncated, true);
    assert.strictEqual(tail.totalBytes, Buffer.byteLength(full));
    assert.ok(tail.text.length < 200, 'the tail is capped');
    assert.ok(full.endsWith(tail.text), 'the tail is the END of the log');
    // The cut lands mid-line; the partial first line is dropped rather than shown.
    assert.match(tail.text.split('\n')[0], /^line \d+$/);
  });

  it('an unknown task is "no-session", a vanished file is "no-log" — neither throws', async () => {
    const runner = makeRunner({ command: nodeCmd("console.log('x')") });
    assert.deepStrictEqual(runner.readLogTail('T-9999'), { ok: false, reason: 'no-session' });

    const { logPath } = await runner.startSession('T-0011');
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the session to exit');
    fs.rmSync(logPath);
    assert.deepStrictEqual(runner.readLogTail('T-0011'), { ok: false, reason: 'no-log' });
  });

  it('the registry record never carries the log path', async () => {
    const runner = makeRunner({ command: nodeCmd('0') });
    await runner.startSession('T-0011');
    assert.strictEqual('logPath' in runner.get('T-0011'), false);
    assert.strictEqual(runner.list().some((r) => 'logPath' in r), false);
  });
});

// ---------- stopping one session (T-0077) ----------

describe('stopSession', () => {
  it('kills a running session and the registry records the ending', async () => {
    const runner = makeRunner({ command: nodeCmd('setInterval(function(){}, 1000)') });
    const { pid } = await runner.startSession('T-0011');
    assert.deepStrictEqual(runner.stopSession('T-0011'), { stopped: true });
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the session to die');

    assert.strictEqual(isProcessAlive(pid), false);
  });

  it('frees the concurrency slot it held', async () => {
    const runner = makeRunner({
      command: nodeCmd('setInterval(function(){}, 1000)'),
      maxSessions: 1,
    });
    await runner.startSession('T-0011');
    assert.deepStrictEqual(await runner.startSession('T-0012'), { started: false, reason: 'limit' });
    runner.stopSession('T-0011');
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the session to die');
    assert.strictEqual((await runner.startSession('T-0012')).started, true);
  });

  it('tells an unknown task apart from an already finished one', async () => {
    const runner = makeRunner({ command: nodeCmd('0') });
    assert.deepStrictEqual(runner.stopSession('T-9999'), { stopped: false, reason: 'no-session' });
    await runner.startSession('T-0011');
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the session to exit');
    assert.deepStrictEqual(runner.stopSession('T-0011'), { stopped: false, reason: 'not-running' });
  });
});

// ---------- change notifications (T-0077) ----------

describe('onChange', () => {
  it('fires on start and on exit, with a record carrying no log path', async () => {
    const seen = [];
    const runner = makeRunner({
      command: nodeCmd('process.exit(2)'),
      onChange: (record) => seen.push(record),
    });
    await runner.startSession('T-0011');
    await waitFor(() => seen.length >= 2, SPAWN_WAIT_BUDGET_MS, 'both notifications');

    assert.strictEqual(seen[0].status, 'running');
    assert.strictEqual(seen[0].id, 'T-0011');
    assert.strictEqual('logPath' in seen[0], false);
    assert.strictEqual(seen[1].status, 'exited');
    assert.strictEqual(seen[1].exitCode, 2);
  });

  it('a listener that throws neither breaks the session nor the registry', async () => {
    const runner = makeRunner({
      command: nodeCmd('0'),
      onChange: () => {
        throw new Error('listener blew up');
      },
    });
    const started = await runner.startSession('T-0011');
    assert.strictEqual(started.started, true);
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the session to exit');
    assert.ok(runner.logged.error.some((m) => /change listener failed/.test(m)));
  });
});

// ---------- shutdown ----------

describe('shutdown', () => {
  it('kills every running session', async () => {
    const runner = makeRunner({ command: nodeCmd('setInterval(function(){}, 1000)') });
    const a = await runner.startSession('T-0001');
    const b = await runner.startSession('T-0002');
    runner.shutdown();
    await waitFor(
      () => runner.get('T-0001').status === 'exited' && runner.get('T-0002').status === 'exited',
      SPAWN_WAIT_BUDGET_MS,
      'both sessions to be killed'
    );
    for (const pid of [a.pid, b.pid]) {
      assert.strictEqual(isProcessAlive(pid), false, `pid ${pid} should be gone`);
    }
  });

  it('awaiting it releases the log files, whether or not the session is gone yet', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      command: nodeCmd("setInterval(function(){ console.log('tick') }, 5)"),
    });
    const { logPath } = await runner.startSession('T-0001');
    await waitFor(() => readLog(logPath).includes('tick'), SPAWN_WAIT_BUDGET_MS, 'the session to write its log');

    const at = Date.now();
    await runner.shutdown();
    const waited = Date.now() - at;

    // This test used to assert `exited` here, and under four concurrent suites
    // that failed in 11 runs of 12 (T-0206). The assertion was the mistake, not
    // the code: shutdown() promises that the LOG FILES are released, and the
    // wait for them is bounded on purpose (T-0173) — when the bound is what ends
    // it, the board closes the logs itself while the session is still being
    // killed, and the record is still `running`. Reproduced deterministically by
    // forcing SHUTDOWN_RELEASE_MS to 1ms: shutdown() resolved in 47ms with
    // T-0001 `running` and the warning below in the log. What is promised, and
    // what is checked here, is that the board never gives that up silently.
    const record = runner.get('T-0001');
    if (record.status !== 'exited') {
      assert.match(
        runner.logged.warn.join('\n'),
        /session log\(s\) were still open/,
        `shutdown() resolved after ${waited}ms with T-0001 still ${record.status}, and said nothing`
      );
    }
    // Released is released. The session prints every 5ms, so a stream the board
    // still held open — or one it closed while something went on writing into
    // it — would show up as a file that is still growing.
    const size = fs.statSync(logPath).size;
    await sleep(200);
    assert.strictEqual(fs.statSync(logPath).size, size, 'the log grew after shutdown() closed it');

    // The directory is a different promise, and not this one's to keep: what
    // holds a session's project is the session process's cwd, never the log
    // (T-0201), and it holds it for up to a second after that process is
    // reported gone (T-0195). So this waits for it instead of demanding that the
    // first attempt succeed.
    await removeTree(project);
    assert.strictEqual(fs.existsSync(project), false);
  });
});

// ---------- the registry on disk (T-0102) ----------

describe('the registry file', () => {
  it('is written next to the logs, versioned, on start and on exit', async () => {
    const project = makeProject();
    const runner = makeRunner({ project, command: nodeCmd("console.log('done')") });
    const { pid, logPath } = await runner.startSession('T-0011');

    const started = readRegistry(project);
    assert.strictEqual(started.version, REGISTRY_VERSION);
    assert.deepStrictEqual(
      { ...started.sessions[0], startedAt: undefined },
      {
        id: 'T-0011',
        kind: 'briefing',
        // Nothing to merge and nothing to clean up after a session that ran in
        // the shared checkout (T-0117).
        branch: null,
        worktree: null,
        pid,
        board: process.pid,
        startedAt: undefined,
        logPath,
        status: 'running',
        exitCode: null,
        signal: null,
        endedAt: null,
        // Nothing of this session's process tree has been written down yet — the
        // first scan is half a minute away — and the file says so rather than
        // looking like a session with no processes (T-0236).
        treeUnknown: true,
      }
    );
    // The pid of the board is bookkeeping for whoever reads the file next; it is
    // not part of what the board hands out (T-0103).
    assert.strictEqual('board' in runner.get('T-0011'), false);

    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the session to end');
    await waitFor(() => readRegistry(project).sessions[0].status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the save');
    assert.strictEqual(readRegistry(project).sessions[0].exitCode, 0);
  });

  it('records which kind of session it was', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      workerCommand: nodeCmd("console.log('worker')"),
    });
    await runner.startSession('T-0011', { kind: 'worker' });
    assert.strictEqual(readRegistry(project).sessions[0].kind, 'worker');
  });

  it('is written atomically, through the shared helper, and touches nothing in doc/', async () => {
    const project = makeProject();
    fs.mkdirSync(path.join(project, 'doc'), { recursive: true });
    fs.writeFileSync(path.join(project, 'doc', 'backlog.md'), 'untouched\n');
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });
    await runner.startSession('T-0011');
    await waitFor(() => runner.get('T-0011').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'the session to end');

    assert.strictEqual(fs.readFileSync(path.join(project, 'doc', 'backlog.md'), 'utf8'), 'untouched\n');
    assert.deepStrictEqual(
      fs.readdirSync(sessionsDir(project)).filter((name) => name.endsWith('.tmp')),
      []
    );
  });
});

describe('reconciliation when the board starts', () => {
  it('reports a session left running by a previous board as interrupted, log and all', async () => {
    const project = makeProject();
    const previous = makeRunner({
      project,
      command: nodeCmd("setInterval(function(){ console.log('tick') }, 5)"),
    });
    const { logPath, pid } = await previous.startSession('T-0011');
    await waitFor(() => readLog(logPath).includes('tick'), SPAWN_WAIT_BUDGET_MS, 'the session to write its log');

    // The previous board is deliberately NOT shut down, so the pid in the file
    // is a live process — the case the reconciliation must not mistake for a
    // session it can still talk to.
    const restarted = makeRunner({ project, command: nodeCmd("console.log('x')") });

    const record = restarted.get('T-0011');
    assert.strictEqual(record.status, 'interrupted');
    assert.strictEqual(record.pid, pid);
    assert.strictEqual(record.exitCode, null);
    assert.strictEqual(record.signal, null);
    assert.ok(record.endedAt, 'an interrupted session is a finished one');
    assert.deepStrictEqual(restarted.list().map((r) => r.status), ['interrupted']);
    // The log is what the human is sent to, so it must still be readable.
    const tail = restarted.readLogTail('T-0011');
    assert.strictEqual(tail.ok, true);
    assert.match(tail.text, /tick/);
    // And the new state is saved, so a third board sees it too.
    assert.strictEqual(readRegistry(project).sessions[0].status, 'interrupted');
  });

  it('never claims a live pid as a session it is running', async () => {
    const project = makeProject();
    // Our own pid: alive beyond any doubt, and certainly not a session.
    writeRegistry(project, {
      version: REGISTRY_VERSION,
      sessions: [storedSession({ pid: process.pid })],
    });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

    assert.strictEqual(runner.get('T-0011').status, 'interrupted');
    assert.strictEqual(runner.stopSession('T-0011').stopped, false);
    assert.strictEqual(runner.stopSession('T-0011').reason, 'not-running');
  });

  it('leaves a session that had already finished exactly as it was', () => {
    const project = makeProject();
    const finished = storedSession({
      status: 'exited',
      exitCode: 3,
      signal: null,
      endedAt: '2026-01-01T00:05:00.000Z',
    });
    writeRegistry(project, { version: REGISTRY_VERSION, sessions: [finished] });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

    const { logPath, ...expected } = finished;
    assert.deepStrictEqual(runner.get('T-0011'), expected);
  });

  it('restarts nothing by itself', async () => {
    const project = makeProject();
    writeRegistry(project, { version: REGISTRY_VERSION, sessions: [storedSession()] });
    const runner = makeRunner({
      project,
      command: nodeCmd("setInterval(function(){ console.log('tick') }, 5)"),
    });

    await sleep(100);
    assert.strictEqual(runner.get('T-0011').status, 'interrupted');
    assert.strictEqual(fs.readdirSync(sessionsDir(project)).some((n) => n.endsWith('.log')), false);
    // Starting it again is a decision for the human, and it still works.
    assert.strictEqual((await runner.startSession('T-0011')).started, true);
    assert.strictEqual(runner.get('T-0011').status, 'running');
  });

  it('keeps evicting down to MAX_FINISHED across a restart', () => {
    const project = makeProject();
    const sessions = [];
    for (let i = 1; i <= MAX_FINISHED + 5; i++) {
      const id = `T-${String(i).padStart(4, '0')}`;
      sessions.push(
        storedSession({ id, startedAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z` })
      );
    }
    writeRegistry(project, { version: REGISTRY_VERSION, sessions });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

    assert.strictEqual(runner.list().length, MAX_FINISHED);
    // The oldest went, the newest stayed.
    assert.strictEqual(runner.get('T-0001'), null);
    assert.ok(runner.get(`T-${String(MAX_FINISHED + 5).padStart(4, '0')}`));
  });

  it('starts with an empty registry when the file is missing, and says nothing about it', () => {
    const project = makeProject();
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });
    assert.deepStrictEqual(runner.list(), []);
    assert.deepStrictEqual(runner.logged.error, []);
  });

  for (const [what, payload] of [
    ['unparseable', '{ this is not json'],
    ['empty', ''],
    ['of an unknown version', JSON.stringify({ version: REGISTRY_VERSION + 1, sessions: [] })],
    ['not shaped like a registry', JSON.stringify({ version: REGISTRY_VERSION, sessions: 'no' })],
  ]) {
    it(`starts with an empty registry, and logs it, when the file is ${what}`, () => {
      const project = makeProject();
      writeRegistry(project, payload);
      const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

      assert.deepStrictEqual(runner.list(), []);
      assert.strictEqual(runner.logged.error.length, 1);
      assert.match(runner.logged.error[0], /empty registry/);
    });
  }

  it('drops entries that could not have come from this module', () => {
    const project = makeProject();
    writeRegistry(project, {
      version: REGISTRY_VERSION,
      sessions: [
        storedSession({ id: '../etc/passwd' }),
        storedSession({ id: 'T-0012', logPath: undefined }),
        storedSession({ id: 'T-0013' }),
      ],
    });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });
    assert.deepStrictEqual(runner.list().map((r) => r.id), ['T-0013']);
  });
});

// ---------- reading the registry from another process (T-0103) ----------

describe('readSessionRegistry — the registry without a board', () => {
  it('reports no sessions, and no error, when the project has no registry', () => {
    const project = makeProject();
    const read = readSessionRegistry(project);
    assert.deepStrictEqual(read.sessions, []);
    assert.strictEqual(read.error, '');
    assert.strictEqual(read.file, registryFile(project));
  });

  it('keeps a session whose board is still alive as running', () => {
    const project = makeProject();
    writeRegistry(project, {
      version: REGISTRY_VERSION,
      sessions: [storedSession({ board: liveStranger() })],
    });
    assert.strictEqual(readSessionRegistry(project).sessions[0].status, 'running');
  });

  it('reports a session whose board is gone as interrupted, and says when', async () => {
    const project = makeProject();
    writeRegistry(project, {
      version: REGISTRY_VERSION,
      sessions: [storedSession({ board: await deadPid(), pid: liveStranger() })],
    });

    const [session] = readSessionRegistry(project).sessions;
    assert.strictEqual(session.status, 'interrupted');
    assert.strictEqual(session.exitCode, null);
    assert.strictEqual(session.signal, null);
    assert.ok(session.endedAt, 'an interrupted session is a finished one');
    // The log is the whole point of showing it at all.
    assert.strictEqual(session.logPath, storedSession().logPath);
  });

  it('reports a record with no board at all as interrupted', () => {
    const project = makeProject();
    writeRegistry(project, { version: REGISTRY_VERSION, sessions: [storedSession()] });
    assert.strictEqual(readSessionRegistry(project).sessions[0].status, 'interrupted');
  });

  it('never rewrites what the reader has no business judging', () => {
    const project = makeProject();
    const finished = storedSession({
      status: 'exited',
      exitCode: 3,
      endedAt: '2026-01-01T00:05:00.000Z',
    });
    writeRegistry(project, { version: REGISTRY_VERSION, sessions: [finished] });
    assert.deepStrictEqual(readSessionRegistry(project).sessions[0], finished);
  });

  it('returns the sessions oldest first', () => {
    const project = makeProject();
    writeRegistry(project, {
      version: REGISTRY_VERSION,
      sessions: [
        storedSession({ id: 'T-0013', startedAt: '2026-01-03T00:00:00.000Z' }),
        storedSession({ id: 'T-0011', startedAt: '2026-01-01T00:00:00.000Z' }),
        storedSession({ id: 'T-0012', startedAt: '2026-01-02T00:00:00.000Z' }),
      ],
    });
    assert.deepStrictEqual(
      readSessionRegistry(project).sessions.map((r) => r.id),
      ['T-0011', 'T-0012', 'T-0013']
    );
  });

  it('hands a broken file back as an error instead of throwing', () => {
    const project = makeProject();
    writeRegistry(project, '{ this is not json');
    const read = readSessionRegistry(project);
    assert.deepStrictEqual(read.sessions, []);
    assert.match(read.error, /unreadable/);
  });

  it('answers about the project it is given, not about a running board', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      command: nodeCmd("setInterval(function(){ console.log('tick') }, 5)"),
    });
    const { pid, logPath } = await runner.startSession('T-0011');

    // Same file, read from outside: the session is this very process's, so the
    // reader treats the record as a leftover rather than as someone else's live
    // work — the pid it carries proves nothing on its own.
    const [session] = readSessionRegistry(project).sessions;
    assert.strictEqual(session.pid, pid);
    assert.strictEqual(session.logPath, logPath);
    assert.strictEqual(session.status, 'interrupted');
    // ...while a reader that is not this process sees it as it really is.
    assert.strictEqual(
      readSessionRegistry(project, { selfPid: process.pid + 1 }).sessions[0].status,
      'running'
    );
  });
});

describe('isProcessAlive', () => {
  it('says yes to this process and no to one that has exited', async () => {
    assert.strictEqual(isProcessAlive(process.pid), true);
    assert.strictEqual(isProcessAlive(await deadPid()), false);
  });

  for (const pid of [undefined, null, 0, -1, 1.5, 'nope']) {
    it(`says no to ${JSON.stringify(pid)}`, () => {
      assert.strictEqual(isProcessAlive(pid), false);
    });
  }
});

describe('one session per task, across board processes', () => {
  it('refuses to start a second session for a task another live board is running', async () => {
    const project = makeProject();
    writeRegistry(project, {
      version: REGISTRY_VERSION,
      sessions: [storedSession({ board: liveStranger() })],
    });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

    const result = await runner.startSession('T-0011');
    assert.deepStrictEqual(result, { started: false, reason: 'already-running' });
    // Nothing was spawned, and nothing was written on the other board's behalf.
    assert.deepStrictEqual(
      fs.readdirSync(sessionsDir(project)).filter((n) => n.endsWith('.log')),
      []
    );
    const stored = readRegistry(project).sessions;
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].status, 'running');
  });

  it('does not adopt the other board\'s session, and does not call it interrupted', () => {
    const project = makeProject();
    const board = liveStranger();
    writeRegistry(project, { version: REGISTRY_VERSION, sessions: [storedSession({ board })] });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

    // Not this board's to show or to stop...
    assert.strictEqual(runner.get('T-0011'), null);
    assert.deepStrictEqual(runner.list(), []);
    assert.deepStrictEqual(runner.logged.warn, []);
    // ...and not this board's to rewrite either.
    assert.deepStrictEqual(readRegistry(project).sessions, [storedSession({ board })]);
  });

  it('never writes back its own stale copy of the other board\'s session', async () => {
    const project = makeProject();
    const board = liveStranger();
    writeRegistry(project, { version: REGISTRY_VERSION, sessions: [storedSession({ board })] });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

    // The other board's session ends while we are up; only it knows that.
    writeRegistry(project, {
      version: REGISTRY_VERSION,
      sessions: [storedSession({ board, status: 'exited', exitCode: 0, endedAt: '2026-01-01T01:00:00.000Z' })],
    });
    await runner.startSession('T-0012');
    await waitFor(() => runner.get('T-0012').status === 'exited', SPAWN_WAIT_BUDGET_MS, 'our own session to end');

    const stored = readRegistry(project).sessions;
    assert.deepStrictEqual(stored.map((r) => r.id).sort(), ['T-0011', 'T-0012']);
    assert.strictEqual(stored.find((r) => r.id === 'T-0011').status, 'exited');
    // And with the ending now on record, the task can be started again.
    assert.strictEqual((await runner.startSession('T-0011')).started, true);
  });

  it('starts the session anyway once the board that owned it is gone', async () => {
    const project = makeProject();
    writeRegistry(project, {
      version: REGISTRY_VERSION,
      sessions: [storedSession({ board: await deadPid() })],
    });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

    assert.strictEqual((await runner.startSession('T-0011')).started, true);
    assert.strictEqual(runner.get('T-0011').status, 'running');
  });
});

// ---------- run profiles (T-0108) ----------

describe("parseProfiles — the list is the user's, briefboard only reads it", () => {
  it('splits on commas, trims, and takes the first entry as the default', () => {
    assert.deepStrictEqual(parseProfiles(' deep , fast '), {
      values: ['deep', 'fast'],
      default: 'deep',
    });
  });

  it('nothing declared means no profiles and no default', () => {
    for (const raw of [undefined, null, '', '   ', ',,', ' , ']) {
      assert.deepStrictEqual(parseProfiles(raw), { values: [], default: '' });
    }
  });

  it('drops repeats, keeping the first position', () => {
    assert.deepStrictEqual(parseProfiles('deep, fast, deep').values, ['deep', 'fast']);
  });

  it('drops a value with a line break — the field it is written to is one line', () => {
    assert.deepStrictEqual(parseProfiles('deep, fa\nst').values, ['deep']);
  });

  it('takes an array as readily as a string', () => {
    assert.deepStrictEqual(parseProfiles(['deep', 'fast']).values, ['deep', 'fast']);
  });

  it('does not interpret the values: any string the user declares is a profile', () => {
    assert.deepStrictEqual(parseProfiles('gl, --model, 3, {id}').values, [
      'gl',
      '--model',
      '3',
      '{id}',
    ]);
  });
});

describe('{profile} substitution — the same rule as {id}', () => {
  it('substitutes inside elements, after the split', () => {
    const argv = parseCommandTemplate('agent --model {profile} --task {id}');
    assert.deepStrictEqual(substitutePlaceholders(argv, { '{id}': 'T-0007', '{profile}': 'fast' }), [
      'agent',
      '--model',
      'fast',
      '--task',
      'T-0007',
    ]);
  });

  it('a value with spaces stays ONE argv element (argv length is fixed by the split)', () => {
    const argv = parseCommandTemplate('agent --model {profile}');
    const out = substitutePlaceholders(argv, { '{profile}': 'fast mode --dangerous' });
    assert.deepStrictEqual(out, ['agent', '--model', 'fast mode --dangerous']);
    assert.strictEqual(out.length, argv.length);
  });
});

describe("a session runs with the task's profile, or refuses to run at all", () => {
  // The stand-in agent prints the argv it was actually given. `model=` rather
  // than `--model`: node -e would eat a leading-dash argument as an option of
  // its own, and what is under test is the argv boundaries, not the flag syntax.
  const printArgv = () =>
    nodeCmd('console.log(JSON.stringify(process.argv.slice(1)))', 'model={profile} task={id}');

  async function argvOf(runner, taskId, options) {
    const started = await runner.startSession(taskId, options);
    assert.strictEqual(started.started, true, 'the session should have started');
    await waitFor(() => firstLogLine(started.logPath) !== '', SPAWN_WAIT_BUDGET_MS, 'the session output');
    return JSON.parse(firstLogLine(started.logPath));
  }

  it("substitutes the task's profile into the command", async () => {
    const runner = makeRunner({ command: printArgv(), profiles: 'deep, fast' });
    assert.deepStrictEqual(await argvOf(runner, 'T-0011', { profile: 'fast' }), [
      'model=fast',
      'task=T-0011',
    ]);
  });

  it('a task with no profile still gets a valid command — the first declared one', async () => {
    const runner = makeRunner({ command: printArgv(), profiles: 'deep, fast' });
    assert.deepStrictEqual(await argvOf(runner, 'T-0011'), ['model=deep', 'task=T-0011']);
  });

  it('a profile value carrying spaces arrives as one argument, not two', async () => {
    const runner = makeRunner({ command: printArgv(), profiles: 'fast mode' });
    assert.deepStrictEqual(await argvOf(runner, 'T-0011', { profile: 'fast mode' }), [
      'model=fast mode',
      'task=T-0011',
    ]);
  });

  it('a profile outside the declared list starts nothing and says why', async () => {
    const runner = makeRunner({ command: printArgv(), profiles: 'deep, fast' });
    assert.deepStrictEqual(await runner.startSession('T-0011', { profile: 'fst' }), {
      started: false,
      reason: 'unknown-profile',
    });
    assert.deepStrictEqual(runner.list(), []);
    const logged = runner.logged.error.join('\n');
    assert.match(logged, /fst/);
    assert.match(logged, /BRIEFBOARD_PROFILES/);
    assert.match(logged, /deep, fast/);
  });

  it('the profile of a worker session is checked the same way', async () => {
    const runner = makeRunner({ workerCommand: printArgv(), profiles: 'deep' });
    assert.deepStrictEqual(await runner.startSession('T-0011', { kind: 'worker', profile: 'fst' }), {
      started: false,
      reason: 'unknown-profile',
    });
    assert.deepStrictEqual(await argvOf(runner, 'T-0011', { kind: 'worker', profile: 'deep' }), [
      'model=deep',
      'task=T-0011',
    ]);
  });

  it('reports the declared list, in declaration order', () => {
    assert.deepStrictEqual(makeRunner({ profiles: 'deep, fast' }).profiles, ['deep', 'fast']);
    assert.strictEqual(makeRunner({ profiles: 'deep, fast' }).defaultProfile, 'deep');
    assert.deepStrictEqual(makeRunner({}).profiles, []);
  });
});

describe('with no profiles declared nothing about a session changes', () => {
  it("a task's profile is ignored entirely, and the session runs", async () => {
    const runner = makeRunner({ command: nodeCmd("console.log('briefing {id}')") });
    const started = await runner.startSession('T-0011', { profile: 'whatever' });
    assert.strictEqual(started.started, true);
    await waitFor(() => /briefing T-0011/.test(readLog(started.logPath)), SPAWN_WAIT_BUDGET_MS, 'the output');
  });

  it('a template that uses {profile} is disabled instead — no dangling flag reaches the agent', async () => {
    const runner = makeRunner({ command: nodeCmd('console.log(1)', '--model {profile}') });
    assert.strictEqual(runner.enabled, false);
    assert.strictEqual(runner.disabledReason, 'no profiles configured');
    assert.deepStrictEqual(await runner.startSession('T-0011'), {
      started: false,
      reason: 'disabled',
    });
    assert.match(runner.logged.error.join('\n'), /BRIEFBOARD_PROFILES/);
  });

  it('the other kind of session is unaffected by that refusal', () => {
    const runner = makeRunner({
      command: nodeCmd('console.log(1)', '--model {profile}'),
      workerCommand: nodeCmd('console.log(1)'),
    });
    assert.strictEqual(runner.enabled, false);
    assert.strictEqual(runner.workerEnabled, true);
  });
});

// ---------- which template has somewhere to put a profile (T-0121) ----------

describe('the runner reports which template uses {profile}, per kind', () => {
  it('a placeholder in one template says nothing about the other', () => {
    const runner = makeRunner({
      command: nodeCmd('console.log(1)'),
      workerCommand: nodeCmd('console.log(1)', 'model={profile}'),
      profiles: 'deep, fast',
    });
    assert.deepStrictEqual(runner.profileUsedBy, { briefing: false, worker: true, orchestrator: false });
  });

  it('both false when neither template mentions it', () => {
    const runner = makeRunner({
      command: nodeCmd('console.log(1)'),
      workerCommand: nodeCmd('console.log(1)'),
      profiles: 'deep, fast',
    });
    assert.deepStrictEqual(runner.profileUsedBy, { briefing: false, worker: false, orchestrator: false });
  });

  it('an unconfigured or unparseable template uses nothing', () => {
    const runner = makeRunner({ command: 'agent --model {profile} -p "unterminated' });
    assert.deepStrictEqual(runner.profileUsedBy, { briefing: false, worker: false, orchestrator: false });
  });

  it('both true when both templates carry it', () => {
    const withProfile = nodeCmd('console.log(1)', 'model={profile}');
    const runner = makeRunner({ command: withProfile, workerCommand: withProfile, profiles: 'deep' });
    assert.deepStrictEqual(runner.profileUsedBy, { briefing: true, worker: true, orchestrator: false });
  });
});

// ---------- an empty run leaves a trace (T-0109) ----------

const TASK = 'T-0011';
const BACKLOG_HEAD = "const fs=require('fs'),f=require('path').join(process.cwd(),'doc','backlog.md');";

// The session's cwd is the project, so these scripts reach the backlog without a
// Windows path ever entering the -e source (see nodeCmd/q).
function backlogEdit(expression) {
  return nodeCmd(`${BACKLOG_HEAD}fs.writeFileSync(f, ${expression});`);
}

function backlogFile(project) {
  return path.join(project, 'doc', 'backlog.md');
}

function writeBacklog(project, { status = 'open', briefs = '', description = '' } = {}) {
  const file = backlogFile(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `# Backlog\n\n## ${TASK} · Major · Something to do\n` +
      `- type: feature\n- status: ${status}\n- created: 2026-01-01 00:00:00\n` +
      `- closed: —\n- briefs: ${briefs}\n` +
      (description ? `\n${description}\n` : '')
  );
  return file;
}

// shutdown() resolves once every session log is closed, and the hint is written
// on the child's 'close' — so this is the first moment the log is final.
async function runToCompletion(runner, taskId, options) {
  const started = await runner.startSession(taskId, options);
  assert.strictEqual(started.started, true);
  await waitFor(() => runner.get(taskId).status === 'exited', SPAWN_WAIT_BUDGET_MS, `${taskId} to exit`);
  await runner.shutdown();
  return readLog(started.logPath);
}

const HINT_RE = /\[briefboard\] this session ended without changing T-0011/;

describe('a session that changed nothing says so in its log', () => {
  it('writes the hint, in the existing [briefboard] form, pointing at the permissions', async () => {
    const project = makeProject();
    writeBacklog(project);
    const runner = makeRunner({ project, command: nodeCmd("console.log('thinking')") });

    const log = await runToCompletion(runner, TASK);
    assert.match(log, HINT_RE);
    assert.match(log, /permission/);
    assert.match(log, /BRIEFBOARD_SESSION_CMD/);
    assert.ok(log.indexOf('thinking') < log.search(HINT_RE), 'the hint comes after the output');

    // Pointing at a section that has since been renamed is worse than pointing
    // nowhere: the reader concludes the hint is stale and stops reading it.
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const section = /^### (Tool permissions.*)$/m.exec(readme);
    assert.ok(section, 'the README must still carry the section the hint sends people to');
    assert.ok(log.includes(section[1]), 'the hint must name that section by its exact title');
  });

  it('a session that left "### Session questions" is NOT empty — the legitimate ending', async () => {
    const project = makeProject();
    writeBacklog(project, { description: 'Refine this.' });
    const runner = makeRunner({
      project,
      command: backlogEdit(
        "fs.readFileSync(f,'utf8') + '\\n### Session questions\\n- which one wins?\\n'"
      ),
    });

    assert.doesNotMatch(await runToCompletion(runner, TASK), HINT_RE);
  });

  it('a heading quoted inside a sentence does not count as asking', async () => {
    const project = makeProject();
    writeBacklog(project, { description: 'Refine this.' });
    const runner = makeRunner({
      project,
      command: backlogEdit(
        "fs.readFileSync(f,'utf8') + '\\nI would write ### Session questions here.\\n'"
      ),
    });

    assert.match(await runToCompletion(runner, TASK), HINT_RE);
  });

  it('a session that moved the status is not empty', async () => {
    const project = makeProject();
    writeBacklog(project);
    const runner = makeRunner({
      project,
      command: backlogEdit("fs.readFileSync(f,'utf8').replace('status: open','status: ready')"),
    });

    assert.doesNotMatch(await runToCompletion(runner, TASK), HINT_RE);
  });

  it('a session that added a brief is not empty', async () => {
    const project = makeProject();
    writeBacklog(project);
    const runner = makeRunner({
      project,
      command: backlogEdit("fs.readFileSync(f,'utf8').replace('briefs:','briefs: T-0011-01')"),
    });

    assert.doesNotMatch(await runToCompletion(runner, TASK), HINT_RE);
  });

  it('a worker session that reached review is not empty', async () => {
    const project = makeProject();
    writeBacklog(project, { status: 'in_progress' });
    const runner = makeRunner({
      project,
      workerCommand: backlogEdit(
        "fs.readFileSync(f,'utf8').replace('status: in_progress','status: review')"
      ),
    });

    assert.doesNotMatch(await runToCompletion(runner, TASK, { kind: 'worker' }), HINT_RE);
  });

  it('an empty worker run names its own command variable', async () => {
    const project = makeProject();
    writeBacklog(project, { status: 'in_progress' });
    const runner = makeRunner({ project, workerCommand: nodeCmd("console.log('idle')") });

    const log = await runToCompletion(runner, TASK, { kind: 'worker' });
    assert.match(log, HINT_RE);
    assert.match(log, /BRIEFBOARD_WORKER_CMD/);
    assert.doesNotMatch(log, /BRIEFBOARD_SESSION_CMD/);
  });

  it('a non-zero exit gets the hint too — the code is not what is judged', async () => {
    const project = makeProject();
    writeBacklog(project);
    const runner = makeRunner({
      project,
      command: nodeCmd("console.error('gave up'); process.exit(3)"),
    });

    const log = await runToCompletion(runner, TASK);
    assert.strictEqual(runner.get(TASK).exitCode, 3);
    assert.match(log, HINT_RE);
  });

  it('changes nothing about the task: the backlog is byte-identical afterwards', async () => {
    const project = makeProject();
    const file = writeBacklog(project);
    const before = fs.readFileSync(file);
    const runner = makeRunner({ project, command: nodeCmd("console.log('idle')") });

    assert.match(await runToCompletion(runner, TASK), HINT_RE);
    assert.deepStrictEqual(fs.readFileSync(file), before);
    assert.strictEqual(runner.get(TASK).status, 'exited');
  });

  it('stays quiet when there is nothing to compare — no backlog, or no such task', async () => {
    const bare = makeProject();
    const bareRunner = makeRunner({ project: bare, command: nodeCmd("console.log('idle')") });
    assert.doesNotMatch(await runToCompletion(bareRunner, TASK), HINT_RE);

    const other = makeProject();
    writeBacklog(other);
    const otherRunner = makeRunner({ project: other, command: nodeCmd("console.log('idle')") });
    assert.doesNotMatch(await runToCompletion(otherRunner, 'T-0099'), /\[briefboard\] this session/);
  });
});

// =====================================================================
// what a task cost (T-0116)
// =====================================================================

function entry(over) {
  return Object.assign(
    {
      id: 'T-0011',
      kind: 'worker',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:10:00.000Z',
      status: 'exited',
      exitCode: 0,
      signal: null,
      tokens: null,
    },
    over || {}
  );
}

describe('summarizeSessions — measured for any agent, configured for none', () => {
  it('counts the runs, their kinds and their endings, and adds up the time', () => {
    const sum = summarizeSessions('T-0011', [
      entry({ kind: 'briefing', endedAt: '2026-01-01T00:05:00.000Z' }),
      entry({ startedAt: '2026-01-01T01:00:00.000Z', endedAt: '2026-01-01T01:20:00.000Z', exitCode: 1 }),
      entry({
        startedAt: '2026-01-01T02:00:00.000Z',
        endedAt: '2026-01-01T02:01:00.000Z',
        exitCode: null,
        signal: 'SIGTERM',
      }),
    ]);
    assert.strictEqual(sum.sessions, 3);
    assert.deepStrictEqual(sum.kinds, { briefing: 1, worker: 2 });
    assert.deepStrictEqual(sum.outcomes, { ended: 1, failed: 1, stopped: 1 });
    assert.strictEqual(sum.durationMs, (5 + 20 + 1) * 60000);
    assert.strictEqual(sum.running, false);
    // In the order they ran, so a card reads them as the story of the task.
    assert.deepStrictEqual(
      sum.entries.map((e) => e.outcome),
      ['ended', 'failed', 'stopped']
    );
    assert.strictEqual(sum.entries[1].exitCode, 1);
  });

  it('measures a session that is still going up to now, and says that it is', () => {
    const now = Date.parse('2026-01-01T00:30:00.000Z');
    const sum = summarizeSessions(
      'T-0011',
      [
        entry({ endedAt: '2026-01-01T00:10:00.000Z' }),
        entry({
          startedAt: '2026-01-01T00:20:00.000Z',
          endedAt: null,
          status: 'running',
          exitCode: null,
        }),
      ],
      { now }
    );
    assert.strictEqual(sum.running, true);
    assert.strictEqual(sum.entries[1].running, true);
    assert.strictEqual(sum.durationMs, 20 * 60000);
  });

  // A session the board never heard end (T-0102) is an ending of its own, not a
  // failure and not a run still going.
  it('keeps a cut-short session apart from a crash', () => {
    const sum = summarizeSessions('T-0011', [entry({ status: 'interrupted', exitCode: null })]);
    assert.deepStrictEqual(sum.outcomes, { interrupted: 1 });
  });

  it('carries the evicted runs with the sum instead of quietly leaving them out', () => {
    const whole = summarizeSessions('T-0011', [entry()]);
    assert.strictEqual(whole.complete, true);
    assert.strictEqual(whole.dropped, 0);

    const partial = summarizeSessions('T-0011', [entry()], { dropped: 4 });
    assert.strictEqual(partial.complete, false);
    assert.strictEqual(partial.dropped, 4);
    // The number it does have is not adjusted to look complete — it is labelled.
    assert.strictEqual(partial.sessions, 1);
  });

  it('leaves tokens null unless a run actually reported one', () => {
    const none = summarizeSessions('T-0011', [entry(), entry({ startedAt: '2026-01-02T00:00:00.000Z' })]);
    assert.strictEqual(none.tokens, null, 'no number is not the number zero');
    assert.strictEqual(none.tokenSessions, 0);

    const some = summarizeSessions('T-0011', [
      entry({ tokens: 1200 }),
      entry({ startedAt: '2026-01-02T00:00:00.000Z' }),
      entry({ startedAt: '2026-01-03T00:00:00.000Z', tokens: 800 }),
    ]);
    assert.strictEqual(some.tokens, 2000);
    assert.strictEqual(some.tokenSessions, 2, 'how much of the sum is covered travels with it');
  });
});

describe('the token extractor is the user’s declaration, not a format we know', () => {
  const LOG = 'thinking\nusage: in=1200 out=340\nusage: in=60 out=15\ndone\n';

  // The acceptance criterion of agent-agnosticism: nothing in the code decides
  // which number in a log is the one that matters.
  it('two declarations read two different numbers out of the same log', () => {
    const input = extractTokens(LOG, compileTokenPattern('in=(\\d+)'));
    const output = extractTokens(LOG, compileTokenPattern('out=(\\d+)'));
    assert.strictEqual(input, 1260);
    assert.strictEqual(output, 355);
    assert.notStrictEqual(input, output);
  });

  it('reads a number written with separators', () => {
    assert.strictEqual(extractTokens('total 1,234,567 tokens', compileTokenPattern('total ([\\d,]+)')), 1234567);
  });

  it('finds nothing rather than zero when the log holds no such number', () => {
    assert.strictEqual(extractTokens(LOG, compileTokenPattern('cost=(\\d+)')), null);
    assert.strictEqual(extractTokens(LOG, null), null, 'nothing declared, nothing claimed');
  });

  it('switches itself off, loudly, when the declaration is unusable', () => {
    const logged = [];
    const logger = { error: (m) => logged.push(String(m)), warn: () => {}, log: () => {} };

    assert.strictEqual(compileTokenPattern('tokens: (\\d+', logger), null);
    assert.strictEqual(compileTokenPattern('tokens: \\d+', logger), null, 'no group, no number');
    assert.strictEqual(logged.length, 2);
    for (const line of logged) assert.match(line, /BRIEFBOARD_TOKENS_RE/);
    // The second failure is the easy one to make, so it says how to fix it.
    assert.match(logged[1], /capturing group/);
  });

  it('is off, without a word, when nothing is declared', () => {
    const logged = [];
    const logger = { error: (m) => logged.push(String(m)), warn: () => {}, log: () => {} };
    assert.strictEqual(compileTokenPattern('', logger), null);
    assert.strictEqual(compileTokenPattern(undefined, logger), null);
    assert.deepStrictEqual(logged, []);
  });
});

describe('the user declares whether the number in the log is a sum or a total (T-0163)', () => {
  // Measured on Claude Code 2.1.232, one turn of 36 tokens: `output_tokens`
  // appears in the outer `usage` block and again inside `usage.iterations[]`, so
  // the obvious expression finds the same figure twice and the card said 72.
  const DOUBLED = '{"usage":{"output_tokens":36,"iterations":[{"output_tokens":36}]}}\n';
  const OBVIOUS = '"output_tokens":\\s*(\\d+)';

  it('reproduces the doubling, and the last-match mode ends it', () => {
    const re = () => compileTokenPattern(OBVIOUS);
    assert.strictEqual(extractTokens(DOUBLED, re()), 72, 'the sum is what it always was');
    assert.strictEqual(extractTokens(DOUBLED, re(), 'sum'), 72);
    assert.strictEqual(extractTokens(DOUBLED, re(), 'last'), 36, 'the session produced 36');
  });

  it('takes the last match, not the largest and not the first', () => {
    const log = 'total=100\ntotal=5\n';
    assert.strictEqual(extractTokens(log, compileTokenPattern('total=(\\d+)'), 'last'), 5);
  });

  it('in last mode skips a match that holds no number, rather than reporting none', () => {
    const log = 'used 40 tokens\nused unknown tokens\n';
    assert.strictEqual(extractTokens(log, compileTokenPattern('used (\\S+) tokens'), 'last'), 40);
  });

  it('finds nothing rather than zero in either mode when nothing matches', () => {
    assert.strictEqual(extractTokens(DOUBLED, compileTokenPattern('cost=(\\d+)'), 'last'), null);
  });

  it('sums by default, so a board configured before this stays as it was', () => {
    const logged = [];
    const logger = { error: (m) => logged.push(String(m)), warn: () => {}, log: () => {} };
    assert.strictEqual(parseTokensMode(undefined, logger), 'sum');
    assert.strictEqual(parseTokensMode('', logger), 'sum');
    assert.strictEqual(extractTokens(DOUBLED, compileTokenPattern(OBVIOUS)), 72);
    assert.deepStrictEqual(logged, [], 'the default is not something to announce');
  });

  it('reads the declaration as written, spacing and case aside', () => {
    assert.strictEqual(parseTokensMode('  last '), 'last');
    assert.strictEqual(parseTokensMode('LAST'), 'last');
    assert.strictEqual(parseTokensMode('Sum'), 'sum');
  });

  it('refuses an unknown mode instead of falling back to the sum', () => {
    const logged = [];
    const logger = { error: (m) => logged.push(String(m)), warn: () => {}, log: () => {} };

    assert.strictEqual(parseTokensMode('maximum', logger), null);
    assert.strictEqual(logged.length, 1);
    assert.match(logged[0], /BRIEFBOARD_TOKENS_MODE/);
    assert.match(logged[0], /sum/);
    assert.match(logged[0], /last/);
    // Counting nothing is the point: a silent sum is the doubled figure again,
    // and it looks exactly like a correct one.
    assert.strictEqual(extractTokens(DOUBLED, compileTokenPattern(OBVIOUS), null), null);
  });
});

describe('the runner sums every session a task had', () => {
  it('keeps both runs of a task, where the record map keeps only the last', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      command: nodeCmd("console.log('briefing')"),
      workerCommand: nodeCmd("console.log('worker')"),
    });
    await runToCompletion(runner, 'T-0011');
    await runToCompletion(runner, 'T-0011', { kind: 'worker' });

    const cost = runner.costs()['T-0011'];
    assert.strictEqual(cost.sessions, 2);
    assert.deepStrictEqual(cost.kinds, { briefing: 1, worker: 1 });
    assert.strictEqual(cost.complete, true);
    assert.ok(cost.durationMs >= 0);
    // The record map answers for the last session only — which is exactly why
    // the sum is not read off it.
    assert.strictEqual(runner.get('T-0011').kind, 'worker');
  });

  it('reads the number out of the session’s own log, as the user declared it', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      command: nodeCmd("console.log('usage: in=1200 out=340')"),
      tokensPattern: 'in=(\\d+)',
    });
    await runToCompletion(runner, 'T-0011');
    await waitFor(() => runner.costs()['T-0011'].tokens !== null, SPAWN_WAIT_BUDGET_MS, 'the tokens to be read');

    assert.strictEqual(runner.costs()['T-0011'].tokens, 1200);
    assert.strictEqual(runner.get('T-0011').tokens, 1200, 'it is stored with the run, in the registry');
    assert.strictEqual(readRegistry(project).history[0].tokens, 1200, 'and in the file, not the backlog');
  });

  it('another declaration reads another number from the same output', async () => {
    const project = makeProject();
    const runner = makeRunner({
      project,
      command: nodeCmd("console.log('usage: in=1200 out=340')"),
      tokensPattern: 'out=(\\d+)',
    });
    await runToCompletion(runner, 'T-0011');
    await waitFor(() => runner.costs()['T-0011'].tokens !== null, SPAWN_WAIT_BUDGET_MS, 'the tokens to be read');
    assert.strictEqual(runner.costs()['T-0011'].tokens, 340);
  });

  it('in last mode reports the figure once, where the sum reported it twice (T-0163)', async () => {
    const printsTwice = nodeCmd(
      "console.log('{\\'usage\\':{\\'output_tokens\\':36,\\'iterations\\':[{\\'output_tokens\\':36}]}}')"
    );
    const pattern = "'output_tokens':\\s*(\\d+)";

    const doubling = makeRunner({ command: printsTwice, tokensPattern: pattern });
    await runToCompletion(doubling, 'T-0011');
    await waitFor(() => doubling.costs()['T-0011'].tokens !== null, SPAWN_WAIT_BUDGET_MS, 'the tokens to be read');
    assert.strictEqual(doubling.costs()['T-0011'].tokens, 72, 'the sum counts the same figure twice');

    const runner = makeRunner({ command: printsTwice, tokensPattern: pattern, tokensMode: 'last' });
    await runToCompletion(runner, 'T-0011');
    await waitFor(() => runner.costs()['T-0011'].tokens !== null, SPAWN_WAIT_BUDGET_MS, 'the tokens to be read');
    assert.strictEqual(runner.costs()['T-0011'].tokens, 36);
  });

  it('counts nothing, and says why, when the declared mode is unknown', async () => {
    const runner = makeRunner({
      command: nodeCmd("console.log('usage: in=1200 out=340')"),
      tokensPattern: 'in=(\\d+)',
      tokensMode: 'biggest',
    });
    await runToCompletion(runner, 'T-0011');

    assert.strictEqual(runner.costs()['T-0011'].tokens, null, 'not a silent 1200');
    assert.ok(
      runner.logged.error.some((line) => line.includes('BRIEFBOARD_TOKENS_MODE')),
      'the refusal is at start-up, in the server output'
    );
  });

  it('with nothing declared the time is still there and no number is invented', async () => {
    const project = makeProject();
    const runner = makeRunner({ project, command: nodeCmd("console.log('usage: in=1200 out=340')") });
    await runToCompletion(runner, 'T-0011');

    const cost = runner.costs()['T-0011'];
    assert.strictEqual(cost.tokens, null);
    assert.strictEqual(cost.tokenSessions, 0);
    assert.strictEqual(cost.sessions, 1, 'the full mode, not a degraded one');
    assert.deepStrictEqual(cost.kinds, { briefing: 1 });
  });

  it('says nothing about a task no session ever ran on', async () => {
    const project = makeProject();
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });
    await runToCompletion(runner, 'T-0011');
    assert.strictEqual(runner.costs()['T-0012'], undefined);
  });
});

describe('the per-task history survives a restart, and admits what it lost', () => {
  function pastEntry(id, minute) {
    const stamp = String(minute).padStart(2, '0');
    return entry({
      id,
      startedAt: `2026-01-01T00:${stamp}:00.000Z`,
      endedAt: `2026-01-01T00:${stamp}:30.000Z`,
    });
  }

  it('reads the runs of the previous board back out of the file', () => {
    const project = makeProject();
    writeRegistry(project, {
      version: REGISTRY_VERSION,
      sessions: [],
      history: [pastEntry('T-0011', 1), pastEntry('T-0011', 2), pastEntry('T-0012', 3)],
      dropped: {},
    });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

    assert.strictEqual(runner.costs()['T-0011'].sessions, 2);
    assert.strictEqual(runner.costs()['T-0011'].durationMs, 60000);
    assert.strictEqual(runner.costs()['T-0012'].sessions, 1);
  });

  it('evicts the oldest runs and counts the loss against the task it belongs to', async () => {
    const project = makeProject();
    const overflow = 3;
    const history = [];
    for (let i = 0; i < MAX_HISTORY + overflow; i++) {
      history.push(
        entry({
          id: i < overflow ? 'T-0011' : 'T-0012',
          startedAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
          endedAt: new Date(Date.UTC(2026, 0, 1) + i * 60000 + 1000).toISOString(),
        })
      );
    }
    writeRegistry(project, { version: REGISTRY_VERSION, sessions: [], history, dropped: {} });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });

    // The oldest three were T-0011's, so it is T-0011 whose sum is short.
    assert.strictEqual(runner.costs()['T-0011'], undefined);
    const kept = runner.costs()['T-0012'];
    assert.strictEqual(kept.sessions, MAX_HISTORY);
    assert.strictEqual(kept.complete, true);

    // And the loss is not forgotten: it is written down, so the next board says
    // the same thing about T-0011 instead of quietly reporting a smaller sum.
    await runToCompletion(runner, 'T-0011');
    assert.strictEqual(runner.costs()['T-0011'].complete, false);
    assert.strictEqual(runner.costs()['T-0011'].dropped, overflow);
    assert.strictEqual(readRegistry(project).dropped['T-0011'], overflow);

    const restarted = makeRunner({ project, command: nodeCmd("console.log('x')") });
    assert.strictEqual(restarted.costs()['T-0011'].complete, false);
    assert.strictEqual(restarted.costs()['T-0011'].dropped, overflow);
  });

  it('a registry written without any history is a project with nothing to sum, not a broken one', () => {
    const project = makeProject();
    writeRegistry(project, { version: REGISTRY_VERSION, sessions: [] });
    const runner = makeRunner({ project, command: nodeCmd("console.log('x')") });
    assert.deepStrictEqual(runner.costs(), {});
    assert.deepStrictEqual(runner.logged.error, []);
  });
});
