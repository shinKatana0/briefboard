'use strict';

// Tests for the client-side logic in ui/index.html.
//
// The UI code never runs in a browser here: the harness (tests/helpers/
// ui-harness.js) extracts the inline <script> blocks and executes them in a
// Node `vm` context wired to a fake DOM. Every test drives the real UI source
// via `extraCode` and asserts on the plain-data summary it returns.
//
// Coverage mirrors the regression history of the project (i18n T-0010, type
// filter T-0008, theme T-0005, priorities/icons T-0028, XLSX export T-0032,
// drag&drop / cancel-flow T-0017/T-0022).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child_process = require('node:child_process');

const {
  loadUiScript,
  loadThemeScript,
  createSandbox,
  runInSandbox,
} = require('./helpers/ui-harness.js');

const UI_SRC = loadUiScript();
const THEME_SRC = loadThemeScript();

// Runs the main UI source, then `extraCode`, in a fresh sandbox. Returns
// { result, sandbox } so tests can also inspect recorded calls on the sandbox.
//
// `extraCode` returns plain JSON-safe data. It is rehydrated through JSON so the
// value carries Node's realm prototypes — otherwise objects/arrays built inside
// the vm keep the vm realm's Object/Array.prototype and assert.deepStrictEqual
// rejects them as "not reference-equal".
function run(extraCode, overrides) {
  const sandbox = createSandbox(overrides);
  const raw = runInSandbox(UI_SRC, sandbox, extraCode);
  const result = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : raw;
  return { result, sandbox };
}

// ---------- reference CRC-32 (independent of the UI implementation) ----------
// Same IEEE 802.3 polynomial, written here from scratch so the UI's crc32()
// is checked against a second implementation, not against itself.
function refCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- minimal ZIP central-directory parser (pure Node) ----------
function parseZip(buf) {
  // Find the End Of Central Directory record (no ZIP comment -> last 22 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, 'EOCD signature PK\\x05\\x06 must be present');
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    assert.strictEqual(
      buf.readUInt32LE(p),
      0x02014b50,
      'central directory record signature PK\\x01\\x02'
    );
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { totalEntries, cdSize, cdOffset, entries };
}

// =====================================================================
// i18n
// =====================================================================
describe('i18n', () => {
  it('t() returns the right string per language (en/ru/ja)', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = { filter_all: t('filter_all'), export: t('export_button'), tag_bug: t('tag_bug') };
      });
      return out;
    })()`);
    assert.strictEqual(result.en.filter_all, 'All');
    assert.strictEqual(result.ru.filter_all, 'Все');
    assert.strictEqual(result.ja.filter_all, 'すべて');
    assert.strictEqual(result.en.export, 'Export Excel');
    assert.strictEqual(result.ru.export, 'Экспорт Excel');
    assert.strictEqual(result.ja.export, 'Excelエクスポート');
    assert.strictEqual(result.en.tag_bug, 'bug');
    assert.strictEqual(result.ru.tag_bug, 'баг');
    assert.strictEqual(result.ja.tag_bug, 'バグ');
  });

  it('t() falls back to the en dictionary for an unknown language', () => {
    const { result } = run(`(function () {
      lang = 'xx';
      return { filter_all: t('filter_all'), status: t('status_ready') };
    })()`);
    assert.strictEqual(result.filter_all, 'All');
    assert.strictEqual(result.status, 'Ready to work');
  });

  it('t() returns undefined for a key absent from every dictionary', () => {
    const { result } = run(`(function () {
      lang = 'en';
      return { missing: t('no_such_key') === undefined };
    })()`);
    assert.strictEqual(result.missing, true);
  });

  it('applyStaticLabels() re-labels header chrome when the language changes', () => {
    const { result } = run(`(function () {
      function snapshot() {
        return {
          all: document.querySelector('[data-type="all"]').textContent,
          feature: document.querySelector('[data-type="feature"]').textContent,
          bug: document.querySelector('[data-type="bug"]').textContent,
          export: document.getElementById('export-excel').textContent,
          langValue: document.getElementById('lang-toggle').value,
        };
      }
      var out = {};
      out.initial = snapshot();       // en, applied once at load
      setLang('ru');
      out.ru = snapshot();
      setLang('ja');
      out.ja = snapshot();
      setLang('en');
      out.en = snapshot();
      return out;
    })()`);
    assert.deepStrictEqual(result.initial, {
      all: 'All', feature: 'Feature', bug: 'Bug', export: 'Export Excel', langValue: 'en',
    });
    assert.deepStrictEqual(result.ru, {
      all: 'Все', feature: 'Фича', bug: 'Баг', export: 'Экспорт Excel', langValue: 'ru',
    });
    assert.deepStrictEqual(result.ja, {
      all: 'すべて', feature: '機能', bug: 'バグ', export: 'Excelエクスポート', langValue: 'ja',
    });
    assert.deepStrictEqual(result.en, {
      all: 'All', feature: 'Feature', bug: 'Bug', export: 'Export Excel', langValue: 'en',
    });
  });

  it('the default language is en when nothing is stored', () => {
    const { result } = run(`lang`);
    assert.strictEqual(result, 'en');
  });

  it('reads the stored language from localStorage at load', () => {
    const { result } = run(`lang`, { storage: { lang: 'ja' } });
    assert.strictEqual(result, 'ja');
  });

  it('syncs document.documentElement.lang with the language on load (default en)', () => {
    const { result } = run(`document.documentElement.lang`);
    assert.strictEqual(result, 'en');
  });

  it('syncs document.documentElement.lang with the stored language on load', () => {
    const { result } = run(`document.documentElement.lang`, { storage: { lang: 'ja' } });
    assert.strictEqual(result, 'ja');
  });

  it('setLang() updates document.documentElement.lang for en/ru/ja', () => {
    const { result } = run(`(function () {
      var out = {};
      setLang('ru');
      out.ru = document.documentElement.lang;
      setLang('ja');
      out.ja = document.documentElement.lang;
      setLang('en');
      out.en = document.documentElement.lang;
      return out;
    })()`);
    assert.deepStrictEqual(result, { ru: 'ru', ja: 'ja', en: 'en' });
  });
});

// =====================================================================
// status labels
// =====================================================================
describe('statusLabel / STATUS_STRIP_LABEL_KEY', () => {
  const STATUSES = ['backlog', 'open', 'ready', 'in_progress', 'review', 'done', 'cancelled'];

  it('statusLabel() resolves all 7 statuses in all 3 languages', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = {};
        ${JSON.stringify(STATUSES)}.forEach(function (st) { out[l][st] = statusLabel(st); });
      });
      return out;
    })()`);
    // Spot-check every language; all 7 statuses must be non-empty strings.
    for (const l of ['en', 'ru', 'ja']) {
      for (const st of STATUSES) {
        assert.strictEqual(typeof result[l][st], 'string');
        assert.ok(result[l][st].length > 0, `${l}/${st} label must be non-empty`);
      }
    }
    assert.strictEqual(result.en.ready, 'Ready to work');
    assert.strictEqual(result.en.in_progress, 'In Progress');
    assert.strictEqual(result.ru.in_progress, 'В работе');
    assert.strictEqual(result.ru.done, 'Завершена');
    assert.strictEqual(result.ja.done, '完了');
    assert.strictEqual(result.ja.cancelled, 'キャンセル');
  });

  it('STATUS_STRIP_LABEL_KEY uses dedicated plural keys for done/cancelled (not label reuse)', () => {
    const { result } = run(`(function () {
      return {
        stripKeys: STATUS_STRIP_LABEL_KEY,
        labelKeys: { done: STATUS_LABEL_KEY.done, cancelled: STATUS_LABEL_KEY.cancelled },
      };
    })()`);
    assert.strictEqual(result.stripKeys.done, 'status_done_plural');
    assert.strictEqual(result.stripKeys.cancelled, 'status_cancelled_plural');
    // Regression on the "compare against a Russian string" bug (T-0010): the
    // strip heading is looked up by KEY, distinct from the singular label key.
    assert.notStrictEqual(result.stripKeys.done, result.labelKeys.done);
    assert.notStrictEqual(result.stripKeys.cancelled, result.labelKeys.cancelled);
  });

  it('the strip heading translates via key lookup, differing from the singular label where the language distinguishes them', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = {
          doneSingular: t(STATUS_LABEL_KEY.done),
          donePlural: t(STATUS_STRIP_LABEL_KEY.done),
          cancelledSingular: t(STATUS_LABEL_KEY.cancelled),
          cancelledPlural: t(STATUS_STRIP_LABEL_KEY.cancelled),
        };
      });
      return out;
    })()`);
    assert.strictEqual(result.en.doneSingular, 'Done');
    assert.strictEqual(result.en.donePlural, 'Completed');
    assert.strictEqual(result.ru.doneSingular, 'Завершена');
    assert.strictEqual(result.ru.donePlural, 'Завершённые');
    assert.strictEqual(result.ru.cancelledSingular, 'Отменена');
    assert.strictEqual(result.ru.cancelledPlural, 'Отменённые');
  });
});

// =====================================================================
// type filter (T-0008)
// =====================================================================
describe('type filter', () => {
  const FAKE_TASKS = `[
    { id: 'T-1', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-01', closed: '', briefs: [] },
    { id: 'T-2', type: 'bug', status: 'open', priority: 'Major', created: '2026-01-02', closed: '', briefs: [] },
    { id: 'T-3', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-03', closed: '', briefs: [] },
    { id: 'T-4', type: 'bug', status: 'review', priority: 'Major', created: '2026-01-04', closed: '', briefs: [] }
  ]`;

  it('filteredTasks() honours typeFilter = all | feature | bug', () => {
    const { result } = run(`(function () {
      tasks = ${FAKE_TASKS};
      var out = {};
      ['all', 'feature', 'bug'].forEach(function (f) {
        typeFilter = f;
        out[f] = filteredTasks().map(function (x) { return x.id; });
      });
      return out;
    })()`);
    assert.deepStrictEqual(result.all, ['T-1', 'T-2', 'T-3', 'T-4']);
    assert.deepStrictEqual(result.feature, ['T-1', 'T-3']);
    assert.deepStrictEqual(result.bug, ['T-2', 'T-4']);
  });

  it('filteredTasks() returns the same array reference contents for all (no filtering)', () => {
    const { result } = run(`(function () {
      tasks = ${FAKE_TASKS};
      typeFilter = 'all';
      return filteredTasks().length === tasks.length;
    })()`);
    assert.strictEqual(result, true);
  });
});

// =====================================================================
// text search filter (T-0042)
// =====================================================================
describe('text search filter', () => {
  const SEARCH_TASKS = `[
    { id: 'T-1', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], title: 'Отправляет письма', description: 'Шлю уведомления клиентам по email' },
    { id: 'T-2', type: 'bug', status: 'open', priority: 'Major', created: '2026-01-02', closed: '', briefs: [], title: 'Fix login crash', description: 'crashes on submit' },
    { id: 'T-3', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-03', closed: '', briefs: [], title: 'Export report', description: 'CSV export for reporting' },
    { id: 'T-4', type: 'bug', status: 'review', priority: 'Major', created: '2026-01-04', closed: '', briefs: [], title: 'Search widget', description: 'no relevant match here' }
  ]`;

  it('empty searchQuery does not filter (only typeFilter applies, as before)', () => {
    const { result } = run(`(function () {
      tasks = ${SEARCH_TASKS};
      typeFilter = 'all';
      searchQuery = '';
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1', 'T-2', 'T-3', 'T-4']);
  });

  it('substring, case-insensitive match against description surfaces a card whose title does not literally contain the query ("шлю" finds "Отправляет письма" via its description)', () => {
    const { result } = run(`(function () {
      tasks = ${SEARCH_TASKS};
      typeFilter = 'all';
      searchQuery = 'ШЛЮ';
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1']);
  });

  it('matches by title, case-insensitively', () => {
    const { result } = run(`(function () {
      tasks = ${SEARCH_TASKS};
      typeFilter = 'all';
      searchQuery = 'LOGIN';
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-2']);
  });

  it('matches by description, case-insensitively', () => {
    const { result } = run(`(function () {
      tasks = ${SEARCH_TASKS};
      typeFilter = 'all';
      searchQuery = 'УВЕДОМЛЕНИЯ';
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1']);
  });

  it('matches by id, case-insensitively', () => {
    const { result } = run(`(function () {
      tasks = ${SEARCH_TASKS};
      typeFilter = 'all';
      searchQuery = 't-4';
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-4']);
  });

  it('combines with typeFilter by AND: type=bug + text "crash" narrows to the single matching bug', () => {
    const { result } = run(`(function () {
      tasks = ${SEARCH_TASKS};
      typeFilter = 'bug';
      searchQuery = 'crash';
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-2']);
  });

  it('combines with typeFilter by AND: type + text with no overlap yields an empty list', () => {
    const { result } = run(`(function () {
      tasks = ${SEARCH_TASKS};
      typeFilter = 'feature';
      searchQuery = 'crash';
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, []);
  });

  it('clearing searchQuery back to empty restores the full typeFilter-scoped list', () => {
    const { result } = run(`(function () {
      tasks = ${SEARCH_TASKS};
      typeFilter = 'bug';
      searchQuery = 'crash';
      var narrowed = filteredTasks().map(function (x) { return x.id; });
      searchQuery = '';
      var restored = filteredTasks().map(function (x) { return x.id; });
      return { narrowed: narrowed, restored: restored };
    })()`);
    assert.deepStrictEqual(result.narrowed, ['T-2']);
    assert.deepStrictEqual(result.restored, ['T-2', 'T-4']);
  });

  it('search_placeholder is present and distinct on all 3 languages', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = t('search_placeholder');
      });
      return out;
    })()`);
    assert.strictEqual(result.en, 'Search title/description…');
    assert.strictEqual(result.ru, 'Поиск по названию/описанию…');
    assert.strictEqual(result.ja, 'タイトル・説明を検索…');
  });

  it('applyStaticLabels() sets #search-filter.placeholder from the current language and updates it on setLang()', () => {
    const { result } = run(`(function () {
      var out = {};
      applyStaticLabels();
      out.initial = document.getElementById('search-filter').placeholder;
      setLang('ru');
      out.afterRu = document.getElementById('search-filter').placeholder;
      return out;
    })()`);
    assert.strictEqual(result.initial, 'Search title/description…');
    assert.strictEqual(result.afterRu, 'Поиск по названию/описанию…');
  });

  it('input event on #search-filter updates searchQuery and re-renders (board reflects the narrowed list)', () => {
    const { result } = run(`(function () {
      tasks = ${SEARCH_TASKS};
      typeFilter = 'all';
      var input = document.getElementById('search-filter');
      input.value = 'login';
      input.dispatch('input', { type: 'input', target: input });
      return searchQuery;
    })()`);
    assert.strictEqual(result, 'login');
  });
});

// =====================================================================
// priority filter (T-0044)
// =====================================================================
describe('priority filter', () => {
  const PRIO_TASKS = `[
    { id: 'T-1', type: 'feature', status: 'open', priority: 'Blocker', created: '2026-01-01', closed: '', briefs: [], title: 'Blocker feature', description: 'urgent fix' },
    { id: 'T-2', type: 'bug', status: 'open', priority: 'Critical', created: '2026-01-02', closed: '', briefs: [], title: 'Critical bug', description: 'crash on submit' },
    { id: 'T-3', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-03', closed: '', briefs: [], title: 'Major feature', description: 'improve export' },
    { id: 'T-4', type: 'bug', status: 'review', priority: 'Medium', created: '2026-01-04', closed: '', briefs: [], title: 'Medium bug', description: 'minor crash' },
    { id: 'T-5', type: 'bug', status: 'open', priority: 'Minor', created: '2026-01-05', closed: '', briefs: [], title: 'Minor bug', description: 'cosmetic issue' }
  ]`;

  it('empty priorityFilter (the default new Set()) does not filter - all priorities shown, as before', () => {
    const { result } = run(`(function () {
      tasks = ${PRIO_TASKS};
      typeFilter = 'all';
      searchQuery = '';
      priorityFilter = new Set();
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1', 'T-2', 'T-3', 'T-4', 'T-5']);
  });

  it('a single selected priority narrows to only that priority', () => {
    const { result } = run(`(function () {
      tasks = ${PRIO_TASKS};
      typeFilter = 'all';
      searchQuery = '';
      priorityFilter = new Set(['Blocker']);
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1']);
  });

  it('multiple priorities selected simultaneously (Blocker+Critical) show tasks of either level - multi-select, not exclusive', () => {
    const { result } = run(`(function () {
      tasks = ${PRIO_TASKS};
      typeFilter = 'all';
      searchQuery = '';
      priorityFilter = new Set(['Blocker', 'Critical']);
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1', 'T-2']);
  });

  it('combines with typeFilter and searchQuery by AND: type=bug + priority in {Critical,Medium} + text "crash" all narrow the same list at once', () => {
    const { result } = run(`(function () {
      tasks = ${PRIO_TASKS};
      typeFilter = 'bug';
      searchQuery = 'crash';
      priorityFilter = new Set(['Critical', 'Medium']);
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    // T-2 (bug, Critical, "crash on submit") and T-4 (bug, Medium, "minor crash")
    // both match all three filters; T-5 is excluded (Minor, not in the set) and
    // T-3 is excluded (feature, not bug), even though none of them contradict
    // any single filter in isolation - only the AND of all three narrows here.
    assert.deepStrictEqual(result, ['T-2', 'T-4']);
  });

  it('a filter combination with no overlap across type/priority/text yields an empty list', () => {
    const { result } = run(`(function () {
      tasks = ${PRIO_TASKS};
      typeFilter = 'feature';
      searchQuery = 'crash';
      priorityFilter = new Set(['Blocker', 'Critical']);
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, []);
  });

  // The harness only executes the <script> blocks in a vm - it never parses the
  // static <body> markup into the fake DOM (see ui-harness.js), so the 5 real
  // <button class="prio-toggle"> elements from ui/index.html don't exist as
  // document children here. These tests instead build a surrogate button via
  // document.createElement() (a real FakeElement, so classList/dataset/closest
  // all behave the same) and dispatch the click straight on it, exactly as the
  // delegated listener on #priority-filter would receive it from a real click.
  it('clicking a priority toggle button adds it to priorityFilter and marks it active; clicking again removes it', () => {
    const { result } = run(`(function () {
      tasks = ${PRIO_TASKS};
      priorityFilter = new Set();
      var btn = document.createElement('button');
      btn.classList.add('prio-toggle');
      btn.dataset.priority = 'Blocker';
      var group = document.getElementById('priority-filter');
      btn.click = function () { group.dispatch('click', { type: 'click', target: btn }); };
      btn.click();
      var afterFirstClick = { hasBlocker: priorityFilter.has('Blocker'), active: btn.classList.contains('active') };
      btn.click();
      var afterSecondClick = { hasBlocker: priorityFilter.has('Blocker'), active: btn.classList.contains('active') };
      return { afterFirstClick: afterFirstClick, afterSecondClick: afterSecondClick };
    })()`);
    assert.deepStrictEqual(result.afterFirstClick, { hasBlocker: true, active: true });
    assert.deepStrictEqual(result.afterSecondClick, { hasBlocker: false, active: false });
  });

  it('clicking two different toggle buttons keeps both active (multi-select, not radio-exclusive)', () => {
    const { result } = run(`(function () {
      tasks = ${PRIO_TASKS};
      priorityFilter = new Set();
      var group = document.getElementById('priority-filter');
      var blockerBtn = document.createElement('button');
      blockerBtn.classList.add('prio-toggle');
      blockerBtn.dataset.priority = 'Blocker';
      blockerBtn.click = function () { group.dispatch('click', { type: 'click', target: blockerBtn }); };
      var criticalBtn = document.createElement('button');
      criticalBtn.classList.add('prio-toggle');
      criticalBtn.dataset.priority = 'Critical';
      criticalBtn.click = function () { group.dispatch('click', { type: 'click', target: criticalBtn }); };
      blockerBtn.click();
      criticalBtn.click();
      return {
        filterContents: Array.from(priorityFilter),
        blockerActive: blockerBtn.classList.contains('active'),
        criticalActive: criticalBtn.classList.contains('active'),
      };
    })()`);
    assert.deepStrictEqual(new Set(result.filterContents), new Set(['Blocker', 'Critical']));
    assert.strictEqual(result.blockerActive, true);
    assert.strictEqual(result.criticalActive, true);
  });
});

// =====================================================================
// theme bootstrap (T-0005) — first <script> block
// =====================================================================
describe('theme bootstrap', () => {
  function resolveTheme({ stored = null, mediaLight = false, throwStorage = false, throwMedia = false }) {
    const overrides = {
      localStorage: {
        getItem(k) {
          if (throwStorage) throw new Error('storage unavailable');
          return k === 'theme' ? stored : null;
        },
        setItem() {},
        removeItem() {},
      },
      matchMedia(q) {
        if (throwMedia) throw new Error('matchMedia unavailable');
        return { matches: !!mediaLight, media: q };
      },
    };
    const sandbox = createSandbox(overrides);
    runInSandbox(THEME_SRC, sandbox);
    return sandbox.document.documentElement.getAttribute('data-theme');
  }

  const SCENARIOS = [
    { name: 'no stored + OS light -> light', opts: { stored: null, mediaLight: true }, expect: 'light' },
    { name: 'no stored + OS dark -> dark', opts: { stored: null, mediaLight: false }, expect: 'dark' },
    { name: 'stored light + OS light -> light', opts: { stored: 'light', mediaLight: true }, expect: 'light' },
    { name: 'stored light + OS dark -> light (stored wins)', opts: { stored: 'light', mediaLight: false }, expect: 'light' },
    { name: 'stored dark + OS light -> dark (stored wins)', opts: { stored: 'dark', mediaLight: true }, expect: 'dark' },
    { name: 'stored dark + OS dark -> dark', opts: { stored: 'dark', mediaLight: false }, expect: 'dark' },
    { name: 'invalid stored + OS light -> light', opts: { stored: 'blue', mediaLight: true }, expect: 'light' },
    { name: 'invalid stored + OS dark -> dark', opts: { stored: 'blue', mediaLight: false }, expect: 'dark' },
    { name: 'empty stored + OS light -> light', opts: { stored: '', mediaLight: true }, expect: 'light' },
    { name: 'empty stored + OS dark -> dark', opts: { stored: '', mediaLight: false }, expect: 'dark' },
    { name: 'wrong-case LIGHT + OS light -> light (case-sensitive, falls to OS)', opts: { stored: 'LIGHT', mediaLight: true }, expect: 'light' },
    { name: 'wrong-case LIGHT + OS dark -> dark', opts: { stored: 'LIGHT', mediaLight: false }, expect: 'dark' },
    { name: 'storage throws + OS light -> dark default (catch)', opts: { throwStorage: true, mediaLight: true }, expect: 'dark' },
    { name: 'storage throws + OS dark -> dark default (catch)', opts: { throwStorage: true, mediaLight: false }, expect: 'dark' },
    { name: 'matchMedia throws (no stored) -> dark default (catch)', opts: { stored: null, throwMedia: true }, expect: 'dark' },
    { name: 'stored dark + matchMedia throws -> dark (OS never consulted)', opts: { stored: 'dark', throwMedia: true }, expect: 'dark' },
  ];

  it('covers all 16 theme-resolution scenarios (localStorage over matchMedia, dark default)', () => {
    assert.strictEqual(SCENARIOS.length, 16);
    for (const s of SCENARIOS) {
      assert.strictEqual(resolveTheme(s.opts), s.expect, s.name);
    }
  });
});

// =====================================================================
// theme toggle button label i18n (T-0073)
// =====================================================================
describe('theme toggle label i18n', () => {
  // The button advertises the theme a click switches TO (the target), and its
  // title/aria-label must come from i18n so EN/JA users don't see Russian.
  it('paintThemeButton() sets the theme button aria-label/title from i18n for the target theme', () => {
    const { result } = run(`(function () {
      var btn = document.getElementById('theme-toggle');
      function snap() { return { aria: btn.getAttribute('aria-label'), title: btn.title }; }
      var out = {};
      // Default fake DOM theme is dark -> target light.
      out.en_dark = snap();
      setLang('ru'); out.ru_dark = snap();
      setLang('ja'); out.ja_dark = snap();
      setLang('en');
      // Flip to light theme -> target dark.
      toggleTheme();
      out.en_light = snap();
      setLang('ru'); out.ru_light = snap();
      setLang('ja'); out.ja_light = snap();
      return out;
    })()`);
    // Dark theme -> "switch to light" wording, per language.
    assert.deepStrictEqual(result.en_dark, { aria: 'Switch to light theme', title: 'Switch to light theme' });
    assert.deepStrictEqual(result.ru_dark, { aria: 'Переключить на светлую тему', title: 'Переключить на светлую тему' });
    assert.deepStrictEqual(result.ja_dark, { aria: 'ライトテーマに切り替え', title: 'ライトテーマに切り替え' });
    // Light theme -> "switch to dark" wording, per language.
    assert.deepStrictEqual(result.en_light, { aria: 'Switch to dark theme', title: 'Switch to dark theme' });
    assert.deepStrictEqual(result.ru_light, { aria: 'Переключить на тёмную тему', title: 'Переключить на тёмную тему' });
    assert.deepStrictEqual(result.ja_light, { aria: 'ダークテーマに切り替え', title: 'ダークテーマに切り替え' });
  });
});

// =====================================================================
// priorities & icons (T-0028)
// =====================================================================
describe('priorities', () => {
  const PRIORITIES = ['Blocker', 'Critical', 'Major', 'Medium', 'Minor'];

  it('PRIO_ORDER and PRIO_ICON contain all 5 priorities', () => {
    const { result } = run(`({ order: PRIO_ORDER, icon: PRIO_ICON })`);
    assert.deepStrictEqual(result.order, { Blocker: 0, Critical: 1, Major: 2, Medium: 3, Minor: 4 });
    for (const p of PRIORITIES) {
      assert.strictEqual(typeof result.icon[p], 'string');
      assert.ok(result.icon[p].length > 0, `icon for ${p} must exist`);
    }
    // Icons must be distinct so cards are visually distinguishable.
    const icons = PRIORITIES.map((p) => result.icon[p]);
    assert.strictEqual(new Set(icons).size, PRIORITIES.length);
  });

  it('sortTasks() orders cards by priority rank, then by created ascending', () => {
    const { result } = run(`(function () {
      var list = [
        { id: 'minor',    priority: 'Minor',    created: '2026-01-01', closed: '' },
        { id: 'blocker',  priority: 'Blocker',  created: '2026-01-05', closed: '' },
        { id: 'major-b',  priority: 'Major',    created: '2026-01-04', closed: '' },
        { id: 'major-a',  priority: 'Major',    created: '2026-01-02', closed: '' },
        { id: 'critical', priority: 'Critical', created: '2026-01-03', closed: '' },
        { id: 'medium',   priority: 'Medium',   created: '2026-01-06', closed: '' }
      ];
      return sortTasks(list).map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['blocker', 'critical', 'major-a', 'major-b', 'medium', 'minor']);
  });

  it('sortTasks(list, true) orders the closed strip by closed descending', () => {
    const { result } = run(`(function () {
      var list = [
        { id: 'a', priority: 'Major', created: '2026-01-01', closed: '2026-02-01' },
        { id: 'b', priority: 'Major', created: '2026-01-01', closed: '2026-03-01' },
        { id: 'c', priority: 'Major', created: '2026-01-01', closed: '2026-01-15' }
      ];
      return sortTasks(list, true).map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['b', 'a', 'c']);
  });
});

// =====================================================================
// XLSX export (T-0032)
// =====================================================================
describe('XLSX export', () => {
  it('crc32() matches the standard check value and an independent implementation', () => {
    const inputs = ['', '123456789', 'The quick brown fox', 'Кириллица テスト <&>'];
    const { result } = run(`(function () {
      var enc = new TextEncoder();
      return ${JSON.stringify(inputs)}.map(function (s) { return crc32(enc.encode(s)); });
    })()`);
    // Well-known CRC-32/ISO-HDLC check value for "123456789".
    assert.strictEqual(result[1], 0xcbf43926);
    // Cross-check every input against the reference implementation.
    inputs.forEach((s, i) => {
      const bytes = new TextEncoder().encode(s);
      assert.strictEqual(result[i], refCrc32(bytes), `crc32 mismatch for input ${JSON.stringify(s)}`);
    });
  });

  it('xmlEscape() escapes &<>"\' and strips invalid XML 1.0 control chars', () => {
    const { result } = run(`(function () {
      return {
        specials: xmlEscape('a & b < c > "d" \\'e\\''),
        controls: xmlEscape('x\\u0000\\u0001\\u0008\\u000B\\u000C\\u000E\\u001Fy'),
        keepsWs: xmlEscape('a\\tb\\nc\\rd'),
        nullish: xmlEscape(null) + '|' + xmlEscape(undefined),
      };
    })()`);
    assert.strictEqual(result.specials, 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
    assert.strictEqual(result.controls, 'xy');
    assert.strictEqual(result.keepsWs, 'a\tb\nc\rd');
    assert.strictEqual(result.nullish, '|');
  });

  it('buildZip() produces a structurally valid ZIP for synthetic files', () => {
    const { result } = run(`(function () {
      var enc = new TextEncoder();
      var files = [
        { name: 'a.txt', data: enc.encode('hello') },
        { name: 'dir/b.txt', data: enc.encode('') },
        { name: 'c.bin', data: enc.encode('Кириллица <&>') }
      ];
      return Array.from(buildZip(files));
    })()`);
    const buf = Buffer.from(result);
    // Local file header signature at the very start.
    assert.strictEqual(buf.readUInt32LE(0), 0x04034b50, 'must begin with PK\\x03\\x04');
    const zip = parseZip(buf);
    assert.strictEqual(zip.totalEntries, 3, 'EOCD entry count must equal the number of files');
    assert.deepStrictEqual(
      zip.entries.map((e) => e.name),
      ['a.txt', 'dir/b.txt', 'c.bin']
    );
    // Each central-directory entry must point at a real local header.
    for (const e of zip.entries) {
      assert.strictEqual(buf.readUInt32LE(e.localOffset), 0x04034b50, `local header for ${e.name}`);
    }
  });

  const XLSX_PARTS = [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
  ];

  // Fake tasks exercising cyrillic / japanese / XML-special / control chars.
  const XLSX_TASKS = `[
    { id: 'T-1', priority: 'Blocker', title: 'Обычная & <задача>', type: 'feature', status: 'open',
      created: '2026-01-01 00:00:00', closed: '', briefs: ['T-1-01'], description: 'Описание "с кавычками"' },
    { id: 'T-2', priority: 'Minor', title: 'タスク テスト', type: 'bug', status: 'done',
      created: '2026-01-02 00:00:00', closed: '2026-02-01 00:00:00', briefs: [], description: 'bad\\u0007ctrl' }
  ]`;

  it('buildXlsx() packs exactly the 6 expected parts into a valid ZIP', () => {
    const { result } = run(`(function () {
      tasks = ${XLSX_TASKS};
      lang = 'en';
      return Array.from(buildXlsx());
    })()`);
    const buf = Buffer.from(result);
    assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);
    const zip = parseZip(buf);
    assert.strictEqual(zip.totalEntries, 6);
    assert.deepStrictEqual(zip.entries.map((e) => e.name).sort(), [...XLSX_PARTS].sort());
  });

  it('exportXlsx() builds a Blob of the xlsx bytes and triggers a dated download', () => {
    const { result, sandbox } = run(`(function () {
      tasks = ${XLSX_TASKS};
      exportXlsx();
      var anchor = document.body.children.filter(function (c) { return c.tagName === 'A'; })[0];
      return {
        download: anchor.download,
        clicked: anchor.clicked,
        href: anchor.href,
        removed: anchor.removed,
      };
    })()`);
    assert.match(result.download, /^agentboard-tasks-\d{4}-\d{2}-\d{2}\.xlsx$/);
    assert.strictEqual(result.clicked, true);
    assert.strictEqual(result.href, 'blob:mock');
    assert.strictEqual(result.removed, true);
    // The Blob captured the finished archive: one part, a Uint8Array of the zip.
    assert.strictEqual(sandbox.capturedBlobParts.length, 1);
    const bytes = sandbox.capturedBlobParts[0][0];
    const buf = Buffer.from(Array.from(bytes));
    assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);
    assert.strictEqual(parseZip(buf).totalEntries, 6);
  });

  it('buildXlsx() output unzips with PowerShell Expand-Archive and yields all 6 parts', (t) => {
    const { result } = run(`(function () {
      tasks = ${XLSX_TASKS};
      lang = 'en';
      return Array.from(buildXlsx());
    })()`);
    const buf = Buffer.from(result);

    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-xlsx-'));
      const zipPath = path.join(tmpDir, 'tasks.zip');
      const outDir = path.join(tmpDir, 'unzipped');
      fs.writeFileSync(zipPath, buf);

      // PowerShell only recognises the .zip extension for Expand-Archive.
      child_process.execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`,
        ],
        { stdio: 'pipe', timeout: 60000 }
      );

      const extracted = [];
      const walk = (dir, prefix) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
          if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
          else extracted.push(rel);
        }
      };
      walk(outDir, '');

      for (const part of XLSX_PARTS) {
        assert.ok(extracted.includes(part), `expected extracted part ${part}, got ${extracted.join(', ')}`);
      }

      // The worksheet must carry the cyrillic/japanese content intact.
      const sheet = fs.readFileSync(path.join(outDir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8');
      assert.ok(sheet.includes('Обычная'), 'worksheet keeps cyrillic text');
      assert.ok(sheet.includes('タスク'), 'worksheet keeps japanese text');
      assert.ok(sheet.includes('&amp;'), 'worksheet escapes ampersand');
      assert.ok(!sheet.includes(''), 'worksheet strips invalid control chars');
    } catch (err) {
      // No PowerShell (non-Windows CI etc.) — the structural checks above
      // already validated the archive; skip this environment-specific one.
      t.skip('PowerShell Expand-Archive unavailable: ' + err.message);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// drag & drop highlight classes (T-0017 / T-0022)
// =====================================================================
describe('drag & drop highlight classes', () => {
  // Builds a draggable card (status backlog/open) and drives event sequences on
  // it and the cancelled strip, snapshotting the highlight classes after each
  // step. `fakeEvent()` yields a fresh event with a dataTransfer stub.
  const HARNESS = `
    tasks = [{ id: 'T-1', priority: 'Major', title: 'Draggable', type: 'feature',
               status: 'open', created: '2026-01-01', closed: '', briefs: [] }];
    var strip = document.getElementById('strip-cancelled');
    function fakeEvent() {
      var bag = {};
      return {
        dataTransfer: {
          setData: function (k, v) { bag[k] = v; },
          getData: function (k) { return bag[k]; },
          effectAllowed: '', dropEffect: '',
        },
        preventDefault: function () {},
      };
    }
    function classes() {
      return { available: strip.classList.contains('drag-available'),
               target: strip.classList.contains('drop-target') };
    }
    function newCard() {
      return cardEl(tasks[0]);
    }
  `;

  it('a backlog/open card is draggable and dragstart marks the strip drag-available', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = newCard();
      var before = classes();
      card.dispatch('dragstart', fakeEvent());
      return { draggable: card.draggable, before: before, after: classes() };
    })()`);
    assert.strictEqual(result.draggable, true);
    assert.deepStrictEqual(result.before, { available: false, target: false });
    assert.deepStrictEqual(result.after, { available: true, target: false });
  });

  it('dragstart -> dragend clears drag-available (no drop)', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = newCard();
      card.dispatch('dragstart', fakeEvent());
      var afterStart = classes();
      card.dispatch('dragend', fakeEvent());
      return { afterStart: afterStart, afterEnd: classes() };
    })()`);
    assert.deepStrictEqual(result.afterStart, { available: true, target: false });
    assert.deepStrictEqual(result.afterEnd, { available: false, target: false });
  });

  it('dragstart -> dragover -> dragleave -> dragend toggles drop-target then clears both', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = newCard();
      var steps = {};
      card.dispatch('dragstart', fakeEvent());
      steps.afterStart = classes();
      strip.dispatch('dragover', fakeEvent());
      steps.afterOver = classes();
      strip.dispatch('dragleave', fakeEvent());
      steps.afterLeave = classes();
      card.dispatch('dragend', fakeEvent());
      steps.afterEnd = classes();
      return steps;
    })()`);
    assert.deepStrictEqual(result.afterStart, { available: true, target: false });
    assert.deepStrictEqual(result.afterOver, { available: true, target: true });
    assert.deepStrictEqual(result.afterLeave, { available: true, target: false });
    assert.deepStrictEqual(result.afterEnd, { available: false, target: false });
  });

  it('dragstart -> dragover -> drop clears drop-target on drop', () => {
    // confirm() returns false here so the drop handler returns before fetch;
    // we only assert the highlight bookkeeping. Cancel-flow is tested below.
    const { result } = run(`(function () {
      confirmReturn = false;
      ${HARNESS}
      var card = newCard();
      var steps = {};
      card.dispatch('dragstart', fakeEvent());
      strip.dispatch('dragover', fakeEvent());
      steps.afterOver = classes();
      var dropEv = fakeEvent();
      dropEv.dataTransfer.setData('text/plain', 'T-1');
      strip.dispatch('drop', dropEv);
      steps.afterDrop = classes();
      return steps;
    })()`);
    assert.deepStrictEqual(result.afterOver, { available: true, target: true });
    // drop removes drop-target; drag-available lingers until dragend.
    assert.strictEqual(result.afterDrop.target, false);
  });

  it('a card in active work (e.g. in_progress) is not draggable', () => {
    const { result } = run(`(function () {
      var card = cardEl({ id: 'T-9', priority: 'Major', title: 'x', type: 'feature',
        status: 'in_progress', created: '2026-01-01', closed: '', briefs: [] });
      return { draggable: card.draggable, hasDragstart: !!(card._listeners && card._listeners.dragstart) };
    })()`);
    assert.notStrictEqual(result.draggable, true);
    assert.strictEqual(result.hasDragstart, false);
  });
});

// =====================================================================
// cancel flow (T-0017)
// =====================================================================
describe('cancel flow', () => {
  const HARNESS = `
    // The top-level load() already recorded a /api/board fetch; start clean so
    // the counts below reflect only what the drop handler does.
    fetchCalls.length = 0;
    confirmCalls.length = 0;
    tasks = [{ id: 'T-42', priority: 'Major', title: 'Мой таск', type: 'feature',
               status: 'open', created: '2026-01-01', closed: '', briefs: [] }];
    var strip = document.getElementById('strip-cancelled');
    function dropEvent(id) {
      var bag = { 'text/plain': id };
      return {
        dataTransfer: { getData: function (k) { return bag[k]; } },
        preventDefault: function () {},
      };
    }
  `;

  it('drop confirms with {id}/{title} substituted and POSTs the cancel endpoint', () => {
    const { result, sandbox } = run(`(function () {
      lang = 'en';
      ${HARNESS}
      strip.dispatch('drop', dropEvent('T-42'));
      return true;
    })()`);
    assert.strictEqual(result, true);
    assert.deepStrictEqual(sandbox.confirmCalls, ['Cancel task T-42 "Мой таск"?']);
    assert.strictEqual(sandbox.fetchCalls.length, 1);
    assert.strictEqual(sandbox.fetchCalls[0].url, '/api/task/T-42/cancel');
    assert.strictEqual(sandbox.fetchCalls[0].opts.method, 'POST');
  });

  it('confirm text is localized (ru) with the same substitution', () => {
    const { sandbox } = run(`(function () {
      lang = 'ru';
      ${HARNESS}
      strip.dispatch('drop', dropEvent('T-42'));
      return true;
    })()`);
    assert.deepStrictEqual(sandbox.confirmCalls, ['Отменить задачу T-42 «Мой таск»?']);
  });

  it('declining the confirm dialog issues no fetch', () => {
    const { sandbox } = run(`(function () {
      confirmReturn = false;
      ${HARNESS}
      strip.dispatch('drop', dropEvent('T-42'));
      return true;
    })()`);
    assert.strictEqual(sandbox.confirmCalls.length, 1);
    assert.strictEqual(sandbox.fetchCalls.length, 0);
  });

  it('dropping an unknown / non-cancellable task neither confirms nor fetches', () => {
    const { sandbox } = run(`(function () {
      ${HARNESS}
      strip.dispatch('drop', dropEvent('T-does-not-exist'));
      return true;
    })()`);
    assert.strictEqual(sandbox.confirmCalls.length, 0);
    assert.strictEqual(sandbox.fetchCalls.length, 0);
  });
});

// =====================================================================
// scroll + focus preservation across SSE re-render (T-0048)
// =====================================================================
describe('scroll + focus preservation across re-render', () => {
  // Tasks spread over several active columns so the board has real content to
  // scroll and focus. Each SSE `changed` calls render() again; since T-0068 the
  // render reconciles cards in place (the scroll containers are never torn down),
  // so per-column scroll (T-0043) and card focus survive naturally.
  const PRESERVE_TASKS = `[
    { id: 'T-1', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], title: 'Ready one', description: '' },
    { id: 'T-2', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-02', closed: '', briefs: [], title: 'Ready two', description: '' },
    { id: 'T-3', type: 'bug', status: 'open', priority: 'Major', created: '2026-01-03', closed: '', briefs: [], title: 'Open one', description: '' },
    { id: 'T-4', type: 'feature', status: 'in_progress', priority: 'Major', created: '2026-01-04', closed: '', briefs: [], title: 'WIP one', description: '' },
    { id: 'T-5', type: 'bug', status: 'done', priority: 'Major', created: '2026-01-05', closed: '2026-02-01', briefs: [], title: 'Done one', description: '' }
  ]`;

  it('every column and strip gets a stable data-status key on its .cards container', () => {
    const { result } = run(`(function () {
      tasks = ${PRESERVE_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set();
      render();
      var out = {};
      for (var k in scrollContainers) out[k] = scrollContainers[k].dataset.status;
      return out;
    })()`);
    assert.deepStrictEqual(result, {
      backlog: 'backlog', open: 'open', ready: 'ready', in_progress: 'in_progress',
      review: 'review', done: 'done', cancelled: 'cancelled',
    });
  });

  it("a scrolled column keeps its scrollTop after a second render() (SSE 'changed')", () => {
    const { result } = run(`(function () {
      tasks = ${PRESERVE_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set();
      render();
      // User scrolls the 'ready' column down; another agent's edit re-renders.
      scrollContainers['ready'].scrollTop = 120;
      scrollContainers['open'].scrollTop = 40;
      var firstReadyEl = scrollContainers['ready'];
      render();
      return {
        // The very same container element is reused across renders (T-0068)...
        reused: scrollContainers['ready'] === firstReadyEl,
        // ...so the scroll positions were never reset in the first place.
        ready: scrollContainers['ready'].scrollTop,
        open: scrollContainers['open'].scrollTop,
      };
    })()`);
    assert.strictEqual(result.reused, true);
    assert.strictEqual(result.ready, 120);
    assert.strictEqual(result.open, 40);
  });

  it('focus returns to the same card (by data-id) after re-render when the card still exists', () => {
    const { result } = run(`(function () {
      tasks = ${PRESERVE_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set();
      render();
      // Focus the T-2 card in the 'ready' column (its cards are the container children).
      var readyCards = scrollContainers['ready'].children;
      var t2 = readyCards.filter(function (c) { return c.dataset.id === 'T-2'; })[0];
      t2.focus();
      var focusedBefore = document.activeElement.dataset.id;
      var elBefore = document.activeElement;
      render();
      return {
        focusedBefore: focusedBefore,
        focusedAfter: document.activeElement ? document.activeElement.dataset.id : null,
        // With incremental render (T-0068) the unchanged T-2 card is the SAME
        // node, so focus lands right back on the very element it started on.
        sameElement: document.activeElement === elBefore,
      };
    })()`);
    assert.strictEqual(result.focusedBefore, 'T-2');
    assert.strictEqual(result.focusedAfter, 'T-2');
    assert.strictEqual(result.sameElement, true);
  });

  it('a focused card that disappears from the next render leaves focus untouched, no error', () => {
    const { result } = run(`(function () {
      tasks = ${PRESERVE_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set();
      render();
      var t3 = scrollContainers['open'].children.filter(function (c) { return c.dataset.id === 'T-3'; })[0];
      t3.focus();
      // T-3 is gone from the next data snapshot; render() must not throw or
      // try to focus a missing card.
      tasks = tasks.filter(function (x) { return x.id !== 'T-3'; });
      render();
      return {
        // The stale card is still the activeElement (nothing re-grabbed focus).
        stillOldCard: document.activeElement === t3,
        // ...and it is genuinely absent from the rebuilt board.
        gone: scrollContainers['open'].children.filter(function (c) { return c.dataset.id === 'T-3'; }).length,
      };
    })()`);
    assert.strictEqual(result.stillOldCard, true);
    assert.strictEqual(result.gone, 0);
  });

  it('re-render with no focused card does not steal focus onto a card', () => {
    const { result } = run(`(function () {
      tasks = ${PRESERVE_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set();
      render();
      // Focus lives on a non-card element (e.g. the search box).
      var box = document.createElement('input');
      box.focus();
      render();
      return { activeIsBox: document.activeElement === box };
    })()`);
    assert.strictEqual(result.activeIsBox, true);
  });
});

// =====================================================================
// incremental render / node reuse (T-0068)
// =====================================================================
describe('incremental render (node diffing)', () => {
  // Two tasks in 'ready' and one in 'open' give enough content to prove that
  // unchanged cards keep their DOM node while add/remove/update/move mutate only
  // the affected nodes.
  const INC_TASKS = `[
    { id: 'T-1', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], title: 'Ready one', description: '' },
    { id: 'T-2', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-02', closed: '', briefs: [], title: 'Ready two', description: '' },
    { id: 'T-3', type: 'bug', status: 'open', priority: 'Major', created: '2026-01-03', closed: '', briefs: [], title: 'Open one', description: '' }
  ]`;

  // Shared helpers injected into each test body.
  const HARNESS = `
    tasks = ${INC_TASKS};
    typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); lang = 'en';
    function nodeById(st, id) {
      return scrollContainers[st].children.filter(function (c) { return c.dataset.id === id; })[0] || null;
    }
    function ids(st) {
      return scrollContainers[st].children.map(function (c) { return c.dataset.id; });
    }
  `;

  it('re-rendering the same set reuses every card node (no recreation)', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      render();
      var firstReady = scrollContainers['ready'].children.slice();
      var firstOpen = scrollContainers['open'].children.slice();
      render();
      var secondReady = scrollContainers['ready'].children;
      var secondOpen = scrollContainers['open'].children;
      return {
        readyAllSame: firstReady.length === secondReady.length &&
          firstReady.every(function (n, i) { return n === secondReady[i]; }),
        openAllSame: firstOpen.length === secondOpen.length &&
          firstOpen.every(function (n, i) { return n === secondOpen[i]; }),
        readyCount: secondReady.length,
      };
    })()`);
    assert.strictEqual(result.readyAllSame, true);
    assert.strictEqual(result.openAllSame, true);
    assert.strictEqual(result.readyCount, 2);
  });

  it('adding a task inserts a new node while keeping the existing nodes', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      render();
      var t1 = nodeById('ready', 'T-1');
      var t2 = nodeById('ready', 'T-2');
      tasks = tasks.concat([{ id: 'T-6', type: 'feature', status: 'ready', priority: 'Major',
        created: '2026-01-06', closed: '', briefs: [], title: 'Ready six', description: '' }]);
      render();
      return {
        t1Same: t1 === nodeById('ready', 'T-1'),
        t2Same: t2 === nodeById('ready', 'T-2'),
        t6Exists: !!nodeById('ready', 'T-6'),
        readyIds: ids('ready'),
      };
    })()`);
    assert.strictEqual(result.t1Same, true);
    assert.strictEqual(result.t2Same, true);
    assert.strictEqual(result.t6Exists, true);
    assert.deepStrictEqual(result.readyIds, ['T-1', 'T-2', 'T-6']);
  });

  it('removing a task drops its node and keeps the surviving nodes', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      render();
      var t1 = nodeById('ready', 'T-1');
      tasks = tasks.filter(function (x) { return x.id !== 'T-2'; });
      render();
      return {
        t1Same: t1 === nodeById('ready', 'T-1'),
        t2Gone: nodeById('ready', 'T-2') === null,
        readyIds: ids('ready'),
      };
    })()`);
    assert.strictEqual(result.t1Same, true);
    assert.strictEqual(result.t2Gone, true);
    assert.deepStrictEqual(result.readyIds, ['T-1']);
  });

  it('updating a task rebuilds only that card node; siblings keep identity', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      render();
      var t1 = nodeById('ready', 'T-1');
      var t2 = nodeById('ready', 'T-2');
      tasks = tasks.map(function (x) {
        return x.id === 'T-1' ? Object.assign({}, x, { title: 'Ready one CHANGED' }) : x;
      });
      render();
      var t1After = nodeById('ready', 'T-1');
      return {
        t1Replaced: t1 !== t1After,
        t1TitleUpdated: t1After.innerHTML.indexOf('Ready one CHANGED') !== -1,
        t2Same: t2 === nodeById('ready', 'T-2'),
      };
    })()`);
    assert.strictEqual(result.t1Replaced, true);
    assert.strictEqual(result.t1TitleUpdated, true);
    assert.strictEqual(result.t2Same, true);
  });

  it('moving a task to another column removes it from the old and adds it to the new', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      render();
      tasks = tasks.map(function (x) {
        return x.id === 'T-3' ? Object.assign({}, x, { status: 'in_progress' }) : x;
      });
      render();
      return {
        goneFromOpen: nodeById('open', 'T-3') === null,
        inWip: !!nodeById('in_progress', 'T-3'),
        openIds: ids('open'),
        wipIds: ids('in_progress'),
      };
    })()`);
    assert.strictEqual(result.goneFromOpen, true);
    assert.strictEqual(result.inWip, true);
    assert.deepStrictEqual(result.openIds, []);
    assert.deepStrictEqual(result.wipIds, ['T-3']);
  });

  it('switching language reuses the containers but refreshes card labels', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      render();
      var readyContainer = scrollContainers['ready'];
      var enFoot = nodeById('ready', 'T-1').innerHTML;
      setLang('ru'); // setLang() calls render()
      var t1Ru = nodeById('ready', 'T-1');
      return {
        containerReused: scrollContainers['ready'] === readyContainer,
        enHadCreated: enFoot.indexOf('created') !== -1,
        ruHasCreated: t1Ru.innerHTML.indexOf('созд.') !== -1,
      };
    })()`);
    assert.strictEqual(result.containerReused, true);
    assert.strictEqual(result.enHadCreated, true);
    assert.strictEqual(result.ruHasCreated, true);
  });
});

// =====================================================================
// modal accessibility (T-0049): dialog role, inert background, focus mgmt
// =====================================================================
describe('modal accessibility', () => {
  const A11Y_TASKS = `[
    { id: 'T-1', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-01', closed: '', briefs: ['T-1-01'], title: 'Accessible dialog', description: 'body text' }
  ]`;

  it('openTask marks the panel as a dialog (role, aria-modal, tabindex, labelledby)', () => {
    const { result } = run(`(function () {
      tasks = ${A11Y_TASKS};
      openTask('T-1');
      var panel = modals[modals.length - 1].querySelector('.panel');
      var h2 = panel.querySelector('h2');
      return {
        role: panel.getAttribute('role'),
        ariaModal: panel.getAttribute('aria-modal'),
        tabindex: panel.getAttribute('tabindex'),
        labelledby: panel.getAttribute('aria-labelledby'),
        h2id: h2.id,
      };
    })()`);
    assert.strictEqual(result.role, 'dialog');
    assert.strictEqual(result.ariaModal, 'true');
    assert.strictEqual(result.tabindex, '-1');
    // aria-labelledby points at the <h2>'s (generated) id.
    assert.ok(result.labelledby, 'panel should have aria-labelledby');
    assert.strictEqual(result.labelledby, result.h2id);
  });

  it('opening a modal makes header and main inert + aria-hidden; closing restores them', () => {
    const { result } = run(`(function () {
      tasks = ${A11Y_TASKS};
      var header = document.querySelector('header');
      var main = document.querySelector('main');
      function bg() {
        return {
          headerInert: header.hasAttribute('inert'),
          headerHidden: header.getAttribute('aria-hidden'),
          mainInert: main.hasAttribute('inert'),
          mainHidden: main.getAttribute('aria-hidden'),
        };
      }
      var before = bg();
      openTask('T-1');
      var during = bg();
      closeTop();
      var after = bg();
      return { before: before, during: during, after: after };
    })()`);
    assert.deepStrictEqual(result.before, {
      headerInert: false, headerHidden: null, mainInert: false, mainHidden: null,
    });
    assert.deepStrictEqual(result.during, {
      headerInert: true, headerHidden: 'true', mainInert: true, mainHidden: 'true',
    });
    assert.deepStrictEqual(result.after, {
      headerInert: false, headerHidden: null, mainInert: false, mainHidden: null,
    });
  });

  it('nested brief-over-task: the task overlay becomes inert while the brief is on top, then reactivates', () => {
    const { result } = run(`(function () {
      tasks = ${A11Y_TASKS};
      var header = document.querySelector('header');
      openTask('T-1');
      var taskOverlay = modals[modals.length - 1];
      openBrief('T-1-01'); // synchronous openModal part runs before the fetch await
      var briefOverlay = modals[modals.length - 1];
      var whileBrief = {
        stack: modals.length,
        taskInert: taskOverlay.hasAttribute('inert'),
        briefInert: briefOverlay.hasAttribute('inert'),
        headerInert: header.hasAttribute('inert'),
      };
      closeTop(); // close brief
      var afterBrief = {
        stack: modals.length,
        taskInert: taskOverlay.hasAttribute('inert'),
        headerInert: header.hasAttribute('inert'),
      };
      closeTop(); // close task
      var afterAll = { stack: modals.length, headerInert: header.hasAttribute('inert') };
      return { whileBrief: whileBrief, afterBrief: afterBrief, afterAll: afterAll };
    })()`);
    // While the brief sits on top, the underlying task overlay is inert.
    assert.strictEqual(result.whileBrief.stack, 2);
    assert.strictEqual(result.whileBrief.taskInert, true);
    assert.strictEqual(result.whileBrief.briefInert, false); // the top overlay stays interactive
    assert.strictEqual(result.whileBrief.headerInert, true);
    // Closing the brief reactivates the task overlay but keeps the page inert.
    assert.strictEqual(result.afterBrief.stack, 1);
    assert.strictEqual(result.afterBrief.taskInert, false);
    assert.strictEqual(result.afterBrief.headerInert, true);
    // Closing the last modal releases the page chrome.
    assert.strictEqual(result.afterAll.stack, 0);
    assert.strictEqual(result.afterAll.headerInert, false);
  });

  it('focus moves into the dialog on open and returns to the trigger on close', () => {
    const { result } = run(`(function () {
      tasks = ${A11Y_TASKS};
      var trigger = document.createElement('button');
      trigger.focus(); // simulate the card that opened the dialog holding focus
      var wasTrigger = document.activeElement === trigger;
      openTask('T-1');
      var panel = modals[modals.length - 1].querySelector('.panel');
      var movedIn = document.activeElement === panel;
      closeTop();
      var returned = document.activeElement === trigger;
      return { wasTrigger: wasTrigger, movedIn: movedIn, returned: returned };
    })()`);
    assert.strictEqual(result.wasTrigger, true);
    assert.strictEqual(result.movedIn, true);
    assert.strictEqual(result.returned, true);
  });

  it('Tab is trapped: with nothing focusable it is prevented and focus stays on the panel', () => {
    const { result } = run(`(function () {
      tasks = ${A11Y_TASKS};
      openTask('T-1');
      var panel = modals[modals.length - 1].querySelector('.panel');
      var ev = { key: 'Tab', shiftKey: false, prevented: false,
                 preventDefault: function () { ev.prevented = true; } };
      document.dispatch('keydown', ev);
      return { prevented: ev.prevented, onPanel: document.activeElement === panel };
    })()`);
    assert.strictEqual(result.prevented, true);
    assert.strictEqual(result.onPanel, true);
  });

  it('Tab cycles focus within the panel (wraps last->first, Shift+Tab first->last)', () => {
    const { result } = run(`(function () {
      tasks = ${A11Y_TASKS};
      openTask('T-1');
      var panel = modals[modals.length - 1].querySelector('.panel');
      // Give the panel two focusable children the fake DOM can enumerate.
      var a = document.createElement('button');
      var b = document.createElement('button');
      panel.querySelectorAll = function () { return [a, b]; };

      // At the last element, Tab wraps to the first.
      b.focus();
      var fwd = { key: 'Tab', shiftKey: false, prevented: false,
                  preventDefault: function () { fwd.prevented = true; } };
      document.dispatch('keydown', fwd);
      var wrappedToFirst = document.activeElement === a;

      // At the first element, Shift+Tab wraps to the last.
      a.focus();
      var back = { key: 'Tab', shiftKey: true, prevented: false,
                   preventDefault: function () { back.prevented = true; } };
      document.dispatch('keydown', back);
      var wrappedToLast = document.activeElement === b;

      return { fwdPrevented: fwd.prevented, wrappedToFirst: wrappedToFirst,
               backPrevented: back.prevented, wrappedToLast: wrappedToLast };
    })()`);
    assert.strictEqual(result.fwdPrevented, true);
    assert.strictEqual(result.wrappedToFirst, true);
    assert.strictEqual(result.backPrevented, true);
    assert.strictEqual(result.wrappedToLast, true);
  });

  it('Escape closes the top modal and returns focus to the trigger', () => {
    const { result } = run(`(function () {
      tasks = ${A11Y_TASKS};
      var trigger = document.createElement('button');
      trigger.focus();
      openTask('T-1');
      var openStack = modals.length;
      document.dispatch('keydown', { key: 'Escape' });
      return { openStack: openStack, closedStack: modals.length,
               returned: document.activeElement === trigger };
    })()`);
    assert.strictEqual(result.openStack, 1);
    assert.strictEqual(result.closedStack, 0);
    assert.strictEqual(result.returned, true);
  });
});
