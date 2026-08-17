'use strict';

// The suite brings its own environment (T-0119). The board spawns a worker
// session with the environment inherited, so BRIEFBOARD_SESSION_CMD and the
// rest are set inside it — and ten tests that assert the shipped defaults
// ("sessions are off") failed there while the same tree was green outside. The
// worker reported a broken tree.
//
// Requiring this module removes every variable the product reads, so a test
// observes the defaults and nothing else. Requiring it FIRST is what makes that
// true: server/parser.js reads BRIEFBOARD_LOCK_TIMEOUT_MS once at load (T-0081),
// so a neutralisation that comes after that require has already lost.
//
// A test that needs a value sets it itself, after this. Child processes spawned
// from a test inherit the cleaned environment along with everything else.

const PRODUCT_ENV_VARS = [
  'AGENTBOARD_HOST',
  'AGENTBOARD_ROOT',
  'BRIEFBOARD_ALLOWED_HOSTS',
  'BRIEFBOARD_LOCK_TIMEOUT_MS',
  'BRIEFBOARD_NAME',
  'BRIEFBOARD_ORCHESTRATOR_CMD',
  'BRIEFBOARD_PROFILES',
  'BRIEFBOARD_SESSION_CMD',
  'BRIEFBOARD_SESSION_MAX',
  'BRIEFBOARD_SETUP_CMD',
  'BRIEFBOARD_SILENCE_MS',
  'BRIEFBOARD_TEST_TIMEOUT_MS',
  'BRIEFBOARD_TOKENS_MODE',
  'BRIEFBOARD_TOKENS_RE',
  'BRIEFBOARD_WATCHDOG_MS',
  'BRIEFBOARD_WORKER_CMD',
  'HOST',
  'MAX_SSE_CLIENTS',
  'PORT',
];

for (const name of PRODUCT_ENV_VARS) delete process.env[name];

module.exports = { PRODUCT_ENV_VARS };
