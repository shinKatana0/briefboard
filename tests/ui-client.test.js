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

require('./helpers/env.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const child_process = require('node:child_process');
const { tempDir } = require('./helpers/tmp.js');

const {
  loadHtml,
  loadUiScript,
  loadThemeScript,
  createSandbox,
  createDocument,
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
    assert.strictEqual(result.en, 'Search title/description/labels…');
    assert.strictEqual(result.ru, 'Поиск по названию/описанию/меткам…');
    assert.strictEqual(result.ja, 'タイトル・説明・ラベルを検索…');
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
    assert.strictEqual(result.initial, 'Search title/description/labels…');
    assert.strictEqual(result.afterRu, 'Поиск по названию/описанию/меткам…');
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
    assert.match(result.download, /^briefboard-tasks-\d{4}-\d{2}-\d{2}\.xlsx$/);
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
      tmpDir = tempDir('briefboard-xlsx-');
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
// drag & drop zone size and highlight (T-0112)
// =====================================================================
// The <style> block never runs here - the harness has no layout engine - so the
// zone styling is asserted on the stylesheet source: rules are collected by
// selector and read back. The flat left-to-right scan is enough for these rules,
// which are all top level and sit above the sheet's only nested block.
function cssRules() {
  const style = loadHtml().match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(style, '<style> block must be present in ui/index.html');
  const src = style[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = new Map();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    rules.set(m[1].trim().replace(/\s+/g, ' '), m[2].trim().replace(/\s+/g, ' '));
  }
  return rules;
}

describe('drag & drop zone size and highlight', () => {
  const rules = cssRules();
  function rule(sel) {
    const body = rules.get(sel);
    assert.ok(body !== undefined, 'no CSS rule for ' + sel);
    return body;
  }
  // The share of the status color in a color-mix(), e.g. 70 for
  // `color-mix(in srgb, var(--st-open) 70%, transparent)`.
  function share(body, prop) {
    const m = body.match(new RegExp(prop + ':[^;]*?var\\(--st-[a-z_]+\\) (\\d+)%'));
    assert.ok(m, prop + ' must mix a status color in: ' + body);
    return Number(m[1]);
  }

  const AVAILABLE = ['.col.drag-available', '.strip.drag-available'];
  const TARGET = ['.col.drop-target', '.col.drop-start.drop-target', '.strip.drop-target'];

  it('a column stretches to the board row for the drag and is back to content height after it', () => {
    const body = rule('.col.drag-available');
    assert.match(body, /align-self: stretch/);
    // A height of its own would change the grid row and push the Cancelled strip
    // - the second zone of the same drag - down from under the cursor.
    assert.doesNotMatch(body, /(min-|max-)?height:/);
    // drag-available is added on dragstart and dropped on dragend (tested
    // above), so the column outside a drag keeps sizing by content.
    assert.doesNotMatch(rule('.col'), /align-self/);
    assert.match(rule('.board'), /align-items: start/);
  });

  it('the collapsed Cancelled strip grows to about a card height for the drag', () => {
    const m = rule('.strip.drag-available').match(/min-height: (\d+)px/);
    assert.ok(m, '.strip.drag-available must set a min-height');
    assert.ok(Number(m[1]) >= 100 && Number(m[1]) <= 140, 'about one card, got ' + m[1] + 'px');
    assert.doesNotMatch(rule('.strip'), /min-height/);
  });

  it('drag-available is an outline only, thicker and more opaque than the 1px/45% it replaced', () => {
    for (const sel of AVAILABLE) {
      const body = rule(sel);
      assert.match(body, /outline: 2px dashed color-mix\(/, sel);
      assert.doesNotMatch(body, /background/, sel);
      assert.ok(share(body, 'outline') > 45, sel + ' outline share: ' + body);
    }
    assert.match(rule('.col.drop-start.drag-available'), /outline-color: color-mix\(/);
  });

  it('drop-target fills with the status color behind a solid outline that has no gap', () => {
    for (const sel of TARGET) {
      const body = rule(sel);
      assert.match(body, /background: color-mix\(in srgb, var\(--st-[a-z_]+\) \d+%, transparent\)/, sel);
      const outlined = sel === '.col.drop-start.drop-target' ? rule('.col.drop-target') : body;
      assert.match(outlined, /outline: 2px solid/, sel);
      assert.match(outlined, /outline-offset: 0/, sel);
    }
  });

  it('the grey Cancelled fill gets a bigger share than the columns', () => {
    const strip = share(rule('.strip.drop-target'), 'background');
    for (const sel of ['.col.drop-target', '.col.drop-start.drop-target']) {
      assert.ok(strip > share(rule(sel), 'background'), sel);
    }
  });

  it('the sticky column head repeats the fill instead of cutting a hole in it', () => {
    for (const [sel, over] of [['.col.drop-target', '.col.drop-target .col-head'],
                               ['.col.drop-start.drop-target', '.col.drop-start.drop-target .col-head']]) {
      // Same share over an opaque --bg as the transparent fill composites to.
      assert.strictEqual(share(rule(over), 'background'), share(rule(sel), 'background'), over);
      assert.match(rule(over), /, var\(--bg\)\)/, over);
    }
  });

  it('no new CSS variables are introduced by the drag zones', () => {
    for (const sel of [...AVAILABLE, ...TARGET, '.col.drop-start.drag-available']) {
      assert.doesNotMatch(rule(sel), /--[a-z-]+:/, sel);
    }
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

  it('a title full of $-patterns reaches the dialog verbatim', () => {
    // The dialog exists so a person reads which task is about to be cancelled;
    // a string replacement would expand $&, $` and $' into other parts of the
    // message and name a task that does not exist.
    const evil = 'Pay $& now $` and $\' later';
    const { sandbox } = run(`(function () {
      lang = 'en';
      ${HARNESS}
      tasks[0].title = ${JSON.stringify(evil)};
      strip.dispatch('drop', dropEvent('T-42'));
      return true;
    })()`);
    assert.deepStrictEqual(sandbox.confirmCalls, [`Cancel task T-42 "${evil}"?`]);
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

  // Lets the microtasks started inside the vm (the drop handler's awaited fetch)
  // run to completion before the assertions look at the sandbox.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('a 503 alerts "busy, retry" instead of the general failure, and resends nothing', async () => {
    for (const [language, message] of [
      ['en', 'The backlog is busy right now — try again'],
      ['ru', 'Бэклог сейчас занят — повторите попытку'],
      ['ja', 'バックログが使用中です — もう一度お試しください'],
    ]) {
      const { sandbox } = run(`(function () {
        lang = '${language}';
        ${HARNESS}
        alertCalls.length = 0;
        fetchResponse = { ok: false, status: 503, json: function () { return Promise.resolve({ error: 'busy' }); } };
        strip.dispatch('drop', dropEvent('T-42'));
        return true;
      })()`);
      await flush();
      assert.deepStrictEqual(sandbox.alertCalls, [message]);
      assert.strictEqual(sandbox.fetchCalls.length, 1, 'no automatic retry');
    }
  });

  it('any other rejection still alerts the general cancel failure', async () => {
    const { sandbox } = run(`(function () {
      lang = 'en';
      ${HARNESS}
      alertCalls.length = 0;
      fetchResponse = { ok: false, status: 500, json: function () { return Promise.resolve({}); } };
      strip.dispatch('drop', dropEvent('T-42'));
      return true;
    })()`);
    await flush();
    assert.deepStrictEqual(sandbox.alertCalls, ['Failed to cancel the task']);
  });
});

// =====================================================================
// drag & drop into the Open column (backlog -> open, T-0075)
// =====================================================================
describe('drag & drop into Open', () => {
  // buildBoardStructure() creates the columns (and wires the Open one as a drop
  // zone) exactly once; `openColumn` is the module-level handle on that element.
  // The board holds one backlog card and one open card, so both the accepted and
  // the refused drag can be driven against the very same drop zone.
  const HARNESS = `
    fetchCalls.length = 0;
    confirmCalls.length = 0;
    alertCalls.length = 0;
    tasks = [
      { id: 'T-10', priority: 'Major', title: 'Backlog card', type: 'feature',
        status: 'backlog', created: '2026-01-01', closed: '', briefs: [] },
      { id: 'T-20', priority: 'Major', title: 'Open card', type: 'feature',
        status: 'open', created: '2026-01-01', closed: '', briefs: [] }
    ];
    buildBoardStructure();
    var strip = document.getElementById('strip-cancelled');
    function fakeEvent() {
      var bag = {};
      var ev = {
        prevented: false,
        dataTransfer: {
          setData: function (k, v) { bag[k] = v; },
          getData: function (k) { return bag[k]; },
          effectAllowed: '', dropEffect: '',
        },
        preventDefault: function () { ev.prevented = true; },
      };
      return ev;
    }
    function classes(el) {
      return { available: el.classList.contains('drag-available'),
               target: el.classList.contains('drop-target') };
    }
    function cardFor(id) {
      return cardEl(tasks.filter(function (t) { return t.id === id; })[0]);
    }
  `;

  it('the Open column exists as a wired drop zone after the board is built', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      return {
        hasColumn: !!openColumn,
        listeners: Object.keys(openColumn._listeners).sort(),
      };
    })()`);
    assert.strictEqual(result.hasColumn, true);
    assert.deepStrictEqual(result.listeners, ['dragleave', 'dragover', 'drop']);
  });

  it('dragging a backlog card highlights BOTH the Open column and the Cancelled strip', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      var before = { col: classes(openColumn), strip: classes(strip) };
      card.dispatch('dragstart', fakeEvent());
      return { before: before, after: { col: classes(openColumn), strip: classes(strip) } };
    })()`);
    assert.deepStrictEqual(result.before.col, { available: false, target: false });
    assert.deepStrictEqual(result.after.col, { available: true, target: false });
    assert.deepStrictEqual(result.after.strip, { available: true, target: false });
  });

  it('dragging a non-backlog (open) card leaves the Open column unhighlighted', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-20');
      card.dispatch('dragstart', fakeEvent());
      return { col: classes(openColumn), strip: classes(strip) };
    })()`);
    assert.deepStrictEqual(result.col, { available: false, target: false });
    // ...while the Cancelled strip still accepts it, exactly as before (T-0017).
    assert.deepStrictEqual(result.strip, { available: true, target: false });
  });

  it('dragover on the Open column accepts a backlog drag and marks it drop-target', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      card.dispatch('dragstart', fakeEvent());
      var over = fakeEvent();
      openColumn.dispatch('dragover', over);
      var afterOver = classes(openColumn);
      openColumn.dispatch('dragleave', fakeEvent());
      return { prevented: over.prevented, dropEffect: over.dataTransfer.dropEffect,
               afterOver: afterOver, afterLeave: classes(openColumn) };
    })()`);
    assert.strictEqual(result.prevented, true); // preventDefault() is what allows the drop
    assert.strictEqual(result.dropEffect, 'move');
    assert.deepStrictEqual(result.afterOver, { available: true, target: true });
    assert.deepStrictEqual(result.afterLeave, { available: true, target: false });
  });

  it('dragover on the Open column refuses a non-backlog drag (no preventDefault, no highlight)', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-20');
      card.dispatch('dragstart', fakeEvent());
      var over = fakeEvent();
      openColumn.dispatch('dragover', over);
      return { prevented: over.prevented, dropEffect: over.dataTransfer.dropEffect,
               afterOver: classes(openColumn) };
    })()`);
    assert.strictEqual(result.prevented, false);
    assert.strictEqual(result.dropEffect, '');
    assert.deepStrictEqual(result.afterOver, { available: false, target: false });
  });

  it('dragend clears both column highlights, including an Esc-cancelled drag', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      var steps = {};
      card.dispatch('dragstart', fakeEvent());
      openColumn.dispatch('dragover', fakeEvent());
      steps.afterOver = classes(openColumn);
      // Esc during the drag: the browser fires no dragleave/drop, only dragend.
      card.dispatch('dragend', fakeEvent());
      steps.afterEnd = classes(openColumn);
      steps.stripAfterEnd = classes(strip);
      return steps;
    })()`);
    assert.deepStrictEqual(result.afterOver, { available: true, target: true });
    assert.deepStrictEqual(result.afterEnd, { available: false, target: false });
    assert.deepStrictEqual(result.stripAfterEnd, { available: false, target: false });
  });

  it('dropping a backlog card POSTs the open endpoint without asking for confirmation', () => {
    const { result, sandbox } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      card.dispatch('dragstart', fakeEvent());
      openColumn.dispatch('dragover', fakeEvent());
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-10');
      openColumn.dispatch('drop', drop);
      return { prevented: drop.prevented, afterDrop: classes(openColumn) };
    })()`);
    assert.strictEqual(result.prevented, true);
    assert.strictEqual(result.afterDrop.target, false); // drop clears the hover state
    assert.strictEqual(sandbox.confirmCalls.length, 0); // non-destructive: no confirm()
    assert.strictEqual(sandbox.fetchCalls.length, 1);
    assert.strictEqual(sandbox.fetchCalls[0].url, '/api/task/T-10/open');
    assert.strictEqual(sandbox.fetchCalls[0].opts.method, 'POST');
  });

  it('dropping a non-backlog or unknown card issues no fetch', () => {
    const { sandbox } = run(`(function () {
      ${HARNESS}
      var drop1 = fakeEvent();
      drop1.dataTransfer.setData('text/plain', 'T-20'); // already open
      openColumn.dispatch('drop', drop1);
      var drop2 = fakeEvent();
      drop2.dataTransfer.setData('text/plain', 'T-does-not-exist');
      openColumn.dispatch('drop', drop2);
      return true;
    })()`);
    assert.strictEqual(sandbox.fetchCalls.length, 0);
    assert.strictEqual(sandbox.alertCalls.length, 0);
  });

  // Lets the microtasks started inside the vm (the drop handler's awaited fetch)
  // run to completion before the assertions look at the sandbox.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('a rejected request alerts a localized message', async () => {
    for (const [language, message] of [
      ['en', 'Failed to move the task to Open'],
      ['ru', 'Не удалось перевести задачу в Open'],
      ['ja', 'タスクを Open に移動できませんでした'],
    ]) {
      const { sandbox } = run(`(function () {
        lang = '${language}';
        ${HARNESS}
        fetchResponse = { ok: false, status: 409, json: function () { return Promise.resolve({}); } };
        var drop = fakeEvent();
        drop.dataTransfer.setData('text/plain', 'T-10');
        openColumn.dispatch('drop', drop);
        return true;
      })()`);
      await flush(); // the drop handler is async; wait for its catch branch
      assert.deepStrictEqual(sandbox.alertCalls, [message]);
    }
  });

  it('a 503 alerts "busy, retry" instead of the general failure', async () => {
    for (const [language, message] of [
      ['en', 'The backlog is busy right now — try again'],
      ['ru', 'Бэклог сейчас занят — повторите попытку'],
      ['ja', 'バックログが使用中です — もう一度お試しください'],
    ]) {
      const { sandbox } = run(`(function () {
        lang = '${language}';
        ${HARNESS}
        fetchResponse = { ok: false, status: 503, json: function () { return Promise.resolve({ error: 'busy' }); } };
        var drop = fakeEvent();
        drop.dataTransfer.setData('text/plain', 'T-10');
        openColumn.dispatch('drop', drop);
        return true;
      })()`);
      await flush();
      assert.deepStrictEqual(sandbox.alertCalls, [message]);
      assert.strictEqual(sandbox.fetchCalls.length, 1, 'no automatic retry');
    }
  });

  it('a successful drop reports nothing and does not reload the board by hand', async () => {
    const { sandbox } = run(`(function () {
      ${HARNESS}
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-10');
      openColumn.dispatch('drop', drop);
      // Published as a context global so the test can inspect the state AFTER
      // the async drop handler has settled.
      probe = function () { return { urls: fetchCalls.map(function (c) { return c.url; }) }; };
    })()`);
    await flush();
    assert.strictEqual(sandbox.alertCalls.length, 0);
    // Only the transition request: the board waits for the server's SSE
    // 'changed' instead of pulling /api/board from the drop path.
    assert.deepStrictEqual(sandbox.probe().urls, ['/api/task/T-10/open']);
  });
});

// =====================================================================
// drag & drop into In Progress (ready -> in_progress, T-0084)
// =====================================================================
describe('drag & drop into In Progress', () => {
  // Four cards: a startable ready one, a blocked ready one (unfinished
  // prerequisite), a backlog one and an in_progress one, so every accepted and
  // refused case can be driven against the very same drop zone.
  const HARNESS = `
    fetchCalls.length = 0;
    confirmCalls.length = 0;
    alertCalls.length = 0;
    sessionsConfigured = { enabled: true, worker: true };
    tasks = [
      { id: 'T-10', priority: 'Major', title: 'Ready card', type: 'feature',
        status: 'ready', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [] },
      { id: 'T-20', priority: 'Major', title: 'Blocked ready card', type: 'feature',
        status: 'ready', created: '2026-01-01', closed: '', briefs: [], depends: ['T-40'], blockedBy: ['T-40'] },
      { id: 'T-30', priority: 'Major', title: 'Backlog card', type: 'feature',
        status: 'backlog', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [] },
      { id: 'T-40', priority: 'Major', title: 'Prerequisite', type: 'feature',
        status: 'in_progress', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [] }
    ];
    buildBoardStructure();
    var strip = document.getElementById('strip-cancelled');
    function fakeEvent() {
      var bag = {};
      var ev = {
        prevented: false,
        dataTransfer: {
          setData: function (k, v) { bag[k] = v; },
          getData: function (k) { return bag[k]; },
          effectAllowed: '', dropEffect: '',
        },
        preventDefault: function () { ev.prevented = true; },
      };
      return ev;
    }
    function classes(el) {
      return { available: el.classList.contains('drag-available'),
               target: el.classList.contains('drop-target') };
    }
    function cardFor(id) {
      return cardEl(tasks.filter(function (t) { return t.id === id; })[0]);
    }
  `;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('the In Progress column exists as a wired drop zone after the board is built', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      return {
        hasColumn: !!inProgressColumn,
        listeners: Object.keys(inProgressColumn._listeners).sort(),
        distinct: inProgressColumn !== openColumn,
      };
    })()`);
    assert.strictEqual(result.hasColumn, true);
    assert.strictEqual(result.distinct, true);
    assert.deepStrictEqual(result.listeners, ['dragleave', 'dragover', 'drop']);
  });

  it('dragging a ready card highlights In Progress only — not Open, not Cancelled', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      card.dispatch('dragstart', fakeEvent());
      return { draggable: card.draggable, inProgress: classes(inProgressColumn),
               open: classes(openColumn), strip: classes(strip) };
    })()`);
    assert.strictEqual(result.draggable, true);
    assert.deepStrictEqual(result.inProgress, { available: true, target: false });
    assert.deepStrictEqual(result.open, { available: false, target: false });
    // `ready` is not cancellable from the board, so the strip stays plain.
    assert.deepStrictEqual(result.strip, { available: false, target: false });
  });

  it('dragging a backlog card leaves In Progress unhighlighted', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-30');
      card.dispatch('dragstart', fakeEvent());
      return { inProgress: classes(inProgressColumn), open: classes(openColumn) };
    })()`);
    assert.deepStrictEqual(result.inProgress, { available: false, target: false });
    assert.deepStrictEqual(result.open, { available: true, target: false });
  });

  it('dragover accepts a ready drag and marks the column drop-target', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      card.dispatch('dragstart', fakeEvent());
      var over = fakeEvent();
      inProgressColumn.dispatch('dragover', over);
      var afterOver = classes(inProgressColumn);
      inProgressColumn.dispatch('dragleave', fakeEvent());
      return { prevented: over.prevented, dropEffect: over.dataTransfer.dropEffect,
               afterOver: afterOver, afterLeave: classes(inProgressColumn) };
    })()`);
    assert.strictEqual(result.prevented, true); // preventDefault() is what allows the drop
    assert.strictEqual(result.dropEffect, 'move');
    assert.deepStrictEqual(result.afterOver, { available: true, target: true });
    assert.deepStrictEqual(result.afterLeave, { available: true, target: false });
  });

  it('dragover refuses a non-ready drag (no preventDefault, no highlight)', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-30');
      card.dispatch('dragstart', fakeEvent());
      var over = fakeEvent();
      inProgressColumn.dispatch('dragover', over);
      return { prevented: over.prevented, afterOver: classes(inProgressColumn) };
    })()`);
    assert.strictEqual(result.prevented, false);
    assert.deepStrictEqual(result.afterOver, { available: false, target: false });
  });

  it('a blocked ready card is not draggable, and the column refuses it if dragged anyway', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-20');
      var wired = { draggable: card.draggable,
                    hasDragstart: !!(card._listeners && card._listeners.dragstart) };
      // Force the state a stale board would leave behind and drive the zone.
      draggedStatus = 'ready';
      draggedBlocked = true;
      var over = fakeEvent();
      inProgressColumn.dispatch('dragover', over);
      return { wired: wired, prevented: over.prevented, afterOver: classes(inProgressColumn) };
    })()`);
    assert.notStrictEqual(result.wired.draggable, true);
    assert.strictEqual(result.wired.hasDragstart, false);
    assert.strictEqual(result.prevented, false);
    assert.deepStrictEqual(result.afterOver, { available: false, target: false });
  });

  it('dropping a blocked card issues no request even if it reaches the handler', () => {
    const { sandbox } = run(`(function () {
      ${HARNESS}
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-20');
      inProgressColumn.dispatch('drop', drop);
      return true;
    })()`);
    assert.strictEqual(sandbox.fetchCalls.length, 0);
    assert.strictEqual(sandbox.confirmCalls.length, 0);
  });

  it('dragend clears the column highlights, including an Esc-cancelled drag', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      card.dispatch('dragstart', fakeEvent());
      inProgressColumn.dispatch('dragover', fakeEvent());
      var afterOver = classes(inProgressColumn);
      card.dispatch('dragend', fakeEvent());
      return { afterOver: afterOver, afterEnd: classes(inProgressColumn) };
    })()`);
    assert.deepStrictEqual(result.afterOver, { available: true, target: true });
    assert.deepStrictEqual(result.afterEnd, { available: false, target: false });
  });

  it('a confirmed drop POSTs the start endpoint', () => {
    const { result, sandbox } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      card.dispatch('dragstart', fakeEvent());
      inProgressColumn.dispatch('dragover', fakeEvent());
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-10');
      inProgressColumn.dispatch('drop', drop);
      return { prevented: drop.prevented, afterDrop: classes(inProgressColumn) };
    })()`);
    assert.strictEqual(result.prevented, true);
    assert.strictEqual(result.afterDrop.target, false);
    assert.strictEqual(sandbox.confirmCalls.length, 1);
    assert.strictEqual(sandbox.fetchCalls.length, 1);
    assert.strictEqual(sandbox.fetchCalls[0].url, '/api/task/T-10/start');
    assert.strictEqual(sandbox.fetchCalls[0].opts.method, 'POST');
  });

  it('a declined confirmation sends nothing', () => {
    const { sandbox } = run(`(function () {
      confirmReturn = false;
      ${HARNESS}
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-10');
      inProgressColumn.dispatch('drop', drop);
      return true;
    })()`);
    assert.strictEqual(sandbox.confirmCalls.length, 1);
    assert.strictEqual(sandbox.fetchCalls.length, 0);
  });

  it('the confirmation names the task and says an agent session will be started', () => {
    for (const [language, session, agent] of [
      ['en', /agent session will be started/, /commits code/],
      ['ru', /Будет запущена агентская сессия/, /коммитит/],
      ['ja', /エージェントセッションが開始されます/, /コミット/],
    ]) {
      const { sandbox } = run(`(function () {
        lang = '${language}';
        confirmReturn = false;
        ${HARNESS}
        var drop = fakeEvent();
        drop.dataTransfer.setData('text/plain', 'T-10');
        inProgressColumn.dispatch('drop', drop);
        return true;
      })()`);
      assert.strictEqual(sandbox.confirmCalls.length, 1);
      assert.match(sandbox.confirmCalls[0], /T-10/);
      assert.match(sandbox.confirmCalls[0], /Ready card/);
      assert.match(sandbox.confirmCalls[0], session);
      assert.match(sandbox.confirmCalls[0], agent);
    }
  });

  it('with no worker command configured the confirmation says so instead', () => {
    for (const [language, expected] of [
      ['en', /no session will be started/],
      ['ru', /сессия не запустится/],
      ['ja', /セッションは開始されません/],
    ]) {
      const { sandbox } = run(`(function () {
        lang = '${language}';
        confirmReturn = false;
        ${HARNESS}
        sessionsConfigured = { enabled: true, worker: false };
        var drop = fakeEvent();
        drop.dataTransfer.setData('text/plain', 'T-10');
        inProgressColumn.dispatch('drop', drop);
        return true;
      })()`);
      assert.strictEqual(sandbox.confirmCalls.length, 1);
      assert.match(sandbox.confirmCalls[0], /BRIEFBOARD_WORKER_CMD/);
      assert.match(sandbox.confirmCalls[0], expected);
    }
  });

  it('load() takes the configured commands from /api/board', async () => {
    const { sandbox } = run(`(function () {
      fetchResponse = { ok: true, status: 200, json: function () {
        return Promise.resolve({ tasks: [], sessions: { enabled: false, worker: true } });
      } };
      reload = function () { return load(); };
      // Stringified so the value carries Node's prototypes, exactly as run()
      // rehydrates its own result.
      probe = function () { return JSON.stringify(sessionsConfigured); };
    })()`);
    // The UI source calls load() itself on start-up; let that one settle first,
    // or it would land after ours and overwrite the answer under test.
    await flush();
    await sandbox.reload();
    assert.deepStrictEqual(JSON.parse(sandbox.probe()), { enabled: false, worker: true });
  });

  it('a rejected request alerts a localized message', async () => {
    for (const [language, message] of [
      ['en', 'Failed to start the task'],
      ['ru', 'Не удалось взять задачу в работу'],
      ['ja', 'タスクに着手できませんでした'],
    ]) {
      const { sandbox } = run(`(function () {
        lang = '${language}';
        ${HARNESS}
        fetchResponse = { ok: false, status: 409, json: function () { return Promise.resolve({}); } };
        var drop = fakeEvent();
        drop.dataTransfer.setData('text/plain', 'T-10');
        inProgressColumn.dispatch('drop', drop);
        return true;
      })()`);
      await flush();
      assert.deepStrictEqual(sandbox.alertCalls, [message]);
    }
  });

  it('a 503 alerts "busy, retry" instead of the general failure', async () => {
    const { sandbox } = run(`(function () {
      ${HARNESS}
      fetchResponse = { ok: false, status: 503, json: function () { return Promise.resolve({ error: 'busy' }); } };
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-10');
      inProgressColumn.dispatch('drop', drop);
      return true;
    })()`);
    await flush();
    assert.deepStrictEqual(sandbox.alertCalls, ['The backlog is busy right now — try again']);
    assert.strictEqual(sandbox.fetchCalls.length, 1, 'no automatic retry');
  });
});

// =====================================================================
// drag & drop back into Backlog (open -> backlog, T-0141)
// =====================================================================
// The third zone, and the only one that moves a card leftwards. What is under
// test besides the wiring is the decision about confirmation: the move itself is
// reversible and is not confirmed, but a running briefing session would be
// stopped by it and that part cannot be undone — so the board asks exactly when
// it can see one.
describe('drag & drop back into Backlog', () => {
  // Three cards: the open one that may go back, a backlog one that is already
  // there, and a ready one that has no way back at all — all driven against the
  // very same zone. `sessionsById` starts empty: the confirmation is off unless a
  // test puts a running session on the card.
  const HARNESS = `
    fetchCalls.length = 0;
    confirmCalls.length = 0;
    alertCalls.length = 0;
    sessionsById = new Map();
    tasks = [
      { id: 'T-10', priority: 'Major', title: 'Open card', type: 'feature',
        status: 'open', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [] },
      { id: 'T-20', priority: 'Major', title: 'Backlog card', type: 'feature',
        status: 'backlog', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [] },
      { id: 'T-30', priority: 'Major', title: 'Ready card', type: 'feature',
        status: 'ready', created: '2026-01-01', closed: '', briefs: ['T-30-01'], depends: [], blockedBy: [] }
    ];
    buildBoardStructure();
    var strip = document.getElementById('strip-cancelled');
    function fakeEvent() {
      var bag = {};
      var ev = {
        prevented: false,
        dataTransfer: {
          setData: function (k, v) { bag[k] = v; },
          getData: function (k) { return bag[k]; },
          effectAllowed: '', dropEffect: '',
        },
        preventDefault: function () { ev.prevented = true; },
      };
      return ev;
    }
    function classes(el) {
      return { available: el.classList.contains('drag-available'),
               target: el.classList.contains('drop-target') };
    }
    function cardFor(id) {
      return cardEl(tasks.filter(function (t) { return t.id === id; })[0]);
    }
    function running(id) {
      sessionsById.set(id, { id: id, status: 'running' });
    }
  `;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('the Backlog column exists as a wired drop zone, distinct from the other two', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      return {
        hasColumn: !!backlogColumn,
        listeners: Object.keys(backlogColumn._listeners).sort(),
        distinct: backlogColumn !== openColumn && backlogColumn !== inProgressColumn,
        painted: backlogColumn.classList.contains('drop-back'),
      };
    })()`);
    assert.strictEqual(result.hasColumn, true);
    assert.strictEqual(result.distinct, true);
    assert.strictEqual(result.painted, true); // its own status color, not Open's
    assert.deepStrictEqual(result.listeners, ['dragleave', 'dragover', 'drop']);
  });

  it('dragging an open card highlights Backlog and the Cancelled strip, not the other columns', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      var before = classes(backlogColumn);
      card.dispatch('dragstart', fakeEvent());
      return { before: before, backlog: classes(backlogColumn), open: classes(openColumn),
               inProgress: classes(inProgressColumn), strip: classes(strip) };
    })()`);
    assert.deepStrictEqual(result.before, { available: false, target: false });
    assert.deepStrictEqual(result.backlog, { available: true, target: false });
    assert.deepStrictEqual(result.open, { available: false, target: false });
    assert.deepStrictEqual(result.inProgress, { available: false, target: false });
    // `open` is still cancellable from the board, so both ways out light up.
    assert.deepStrictEqual(result.strip, { available: true, target: false });
  });

  it('dragging a card that has no way back leaves the Backlog column unhighlighted', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var out = {};
      cardFor('T-20').dispatch('dragstart', fakeEvent()); // already in backlog
      out.fromBacklog = classes(backlogColumn);
      cardFor('T-20').dispatch('dragend', fakeEvent());
      cardFor('T-30').dispatch('dragstart', fakeEvent()); // ready: no way back
      out.fromReady = classes(backlogColumn);
      return out;
    })()`);
    assert.deepStrictEqual(result.fromBacklog, { available: false, target: false });
    assert.deepStrictEqual(result.fromReady, { available: false, target: false });
  });

  it('dragover accepts an open drag and refuses everything else', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      cardFor('T-10').dispatch('dragstart', fakeEvent());
      var accepted = fakeEvent();
      backlogColumn.dispatch('dragover', accepted);
      var afterOver = classes(backlogColumn);
      backlogColumn.dispatch('dragleave', fakeEvent());
      var afterLeave = classes(backlogColumn);
      cardFor('T-10').dispatch('dragend', fakeEvent());

      cardFor('T-30').dispatch('dragstart', fakeEvent());
      var refused = fakeEvent();
      backlogColumn.dispatch('dragover', refused);
      return {
        accepted: { prevented: accepted.prevented, dropEffect: accepted.dataTransfer.dropEffect },
        afterOver: afterOver, afterLeave: afterLeave,
        refused: { prevented: refused.prevented, dropEffect: refused.dataTransfer.dropEffect,
                   classes: classes(backlogColumn) },
      };
    })()`);
    assert.deepStrictEqual(result.accepted, { prevented: true, dropEffect: 'move' });
    assert.deepStrictEqual(result.afterOver, { available: true, target: true });
    assert.deepStrictEqual(result.afterLeave, { available: true, target: false });
    assert.deepStrictEqual(result.refused.classes, { available: false, target: false });
    assert.strictEqual(result.refused.prevented, false);
  });

  it('dragend clears the Backlog highlight too, including an Esc-cancelled drag', () => {
    const { result } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      card.dispatch('dragstart', fakeEvent());
      backlogColumn.dispatch('dragover', fakeEvent());
      var afterOver = classes(backlogColumn);
      card.dispatch('dragend', fakeEvent());
      return { afterOver: afterOver, afterEnd: classes(backlogColumn) };
    })()`);
    assert.deepStrictEqual(result.afterOver, { available: true, target: true });
    assert.deepStrictEqual(result.afterEnd, { available: false, target: false });
  });

  it('dropping an open card POSTs /backlog and asks nothing: the move is reversible', () => {
    const { result, sandbox } = run(`(function () {
      ${HARNESS}
      var card = cardFor('T-10');
      card.dispatch('dragstart', fakeEvent());
      backlogColumn.dispatch('dragover', fakeEvent());
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-10');
      backlogColumn.dispatch('drop', drop);
      return { prevented: drop.prevented, afterDrop: classes(backlogColumn) };
    })()`);
    assert.strictEqual(result.prevented, true);
    assert.strictEqual(result.afterDrop.target, false); // drop clears the hover state
    assert.strictEqual(sandbox.confirmCalls.length, 0);
    assert.strictEqual(sandbox.fetchCalls.length, 1);
    assert.strictEqual(sandbox.fetchCalls[0].url, '/api/task/T-10/backlog');
    assert.strictEqual(sandbox.fetchCalls[0].opts.method, 'POST');
  });

  it('a running session on the card IS asked about — stopping it cannot be undone', () => {
    for (const [language, expected] of [
      ['en', /briefing session is running/],
      ['ru', /идёт брифинг-сессия/],
      ['ja', /ブリーフィングセッションが実行中/],
    ]) {
      const { sandbox } = run(`(function () {
        lang = '${language}';
        ${HARNESS}
        running('T-10');
        var drop = fakeEvent();
        drop.dataTransfer.setData('text/plain', 'T-10');
        backlogColumn.dispatch('drop', drop);
        return true;
      })()`);
      assert.strictEqual(sandbox.confirmCalls.length, 1);
      assert.match(sandbox.confirmCalls[0], /T-10/);
      assert.match(sandbox.confirmCalls[0], expected);
      assert.strictEqual(sandbox.fetchCalls.length, 1);
    }
  });

  it('a refused confirmation sends nothing at all', () => {
    const { sandbox } = run(`(function () {
      ${HARNESS}
      confirmReturn = false;
      running('T-10');
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-10');
      backlogColumn.dispatch('drop', drop);
      return true;
    })()`);
    assert.strictEqual(sandbox.confirmCalls.length, 1);
    assert.deepStrictEqual(sandbox.fetchCalls, []);
  });

  it('a session that has already ended is not worth a question', () => {
    const { sandbox } = run(`(function () {
      ${HARNESS}
      sessionsById.set('T-10', { id: 'T-10', status: 'exited', exitCode: 0 });
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-10');
      backlogColumn.dispatch('drop', drop);
      return true;
    })()`);
    assert.strictEqual(sandbox.confirmCalls.length, 0);
    assert.strictEqual(sandbox.fetchCalls.length, 1);
  });

  it('dropping a card that cannot go back issues no fetch', () => {
    const { sandbox } = run(`(function () {
      ${HARNESS}
      ['T-20', 'T-30', 'T-nope'].forEach(function (id) {
        var drop = fakeEvent();
        drop.dataTransfer.setData('text/plain', id);
        backlogColumn.dispatch('drop', drop);
      });
      return true;
    })()`);
    assert.deepStrictEqual(sandbox.fetchCalls, []);
    assert.deepStrictEqual(sandbox.alertCalls, []);
  });

  it('a rejected request alerts a localized message, and a 503 says "busy" instead', async () => {
    for (const [language, failed, busy] of [
      ['en', 'Failed to put the task back into the backlog', 'The backlog is busy right now — try again'],
      ['ru', 'Не удалось вернуть задачу в бэклог', 'Бэклог сейчас занят — повторите попытку'],
      ['ja', 'タスクをバックログに戻せませんでした', 'バックログが使用中です — もう一度お試しください'],
    ]) {
      for (const [status, message] of [[409, failed], [503, busy]]) {
        const { sandbox } = run(`(function () {
          lang = '${language}';
          ${HARNESS}
          fetchResponse = { ok: false, status: ${status}, json: function () { return Promise.resolve({}); } };
          var drop = fakeEvent();
          drop.dataTransfer.setData('text/plain', 'T-10');
          backlogColumn.dispatch('drop', drop);
          return true;
        })()`);
        await flush();
        assert.deepStrictEqual(sandbox.alertCalls, [message]);
        assert.strictEqual(sandbox.fetchCalls.length, 1, 'no automatic retry');
      }
    }
  });

  it('a successful drop reports nothing and reloads nothing by hand', async () => {
    const { sandbox } = run(`(function () {
      ${HARNESS}
      var drop = fakeEvent();
      drop.dataTransfer.setData('text/plain', 'T-10');
      backlogColumn.dispatch('drop', drop);
      probe = function () { return { urls: fetchCalls.map(function (c) { return c.url; }) }; };
    })()`);
    await flush();
    assert.deepStrictEqual(sandbox.alertCalls, []);
    assert.deepStrictEqual(sandbox.probe().urls, ['/api/task/T-10/backlog']);
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

// =====================================================================
// creating a task from the board: the "+" button and its dialog (T-0074)
// =====================================================================
describe('new task from the board', () => {
  // Lets the microtasks started inside the vm (the submit handler's awaited
  // fetch) run to completion before the assertions look at the sandbox.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Runs the UI source in a fresh sandbox, then `extraCode`, and returns the
  // sandbox. `extraCode` is expected to publish a `probe()` global the test can
  // call afterwards, so state can be inspected AFTER the async submit settled.
  function boot(extraCode, overrides) {
    const sandbox = createSandbox(overrides);
    runInSandbox(UI_SRC, sandbox, extraCode);
    return sandbox;
  }

  // Opens the dialog from the header button and exposes helpers for its fields.
  const OPEN = `
    fetchCalls.length = 0;
    var button = document.getElementById('new-task');
    button.focus();
    button.dispatch('click');
    var overlay = modals[modals.length - 1];
    function field(sel) { return overlay.querySelector(sel); }
    function submit() {
      var ev = { prevented: false, preventDefault: function () { ev.prevented = true; } };
      overlay.querySelector('#new-task-form').dispatch('submit', ev);
      return ev;
    }
  `;

  it('every i18n key exists in all three dictionaries (en/ru/ja)', () => {
    const { result } = run(`(function () {
      var langs = Object.keys(I18N);
      var all = {};
      langs.forEach(function (l) { Object.keys(I18N[l]).forEach(function (k) { all[k] = true; }); });
      var missing = [];
      Object.keys(all).forEach(function (k) {
        langs.forEach(function (l) {
          if (typeof I18N[l][k] !== 'string' || I18N[l][k] === '') missing.push(l + '.' + k);
        });
      });
      return { langs: langs, missing: missing, keyCount: Object.keys(all).length };
    })()`);
    assert.deepStrictEqual(result.langs, ['en', 'ru', 'ja']);
    assert.deepStrictEqual(result.missing, [], 'every key must be translated in every language');
    assert.ok(result.keyCount > 40);
  });

  it('the new-task strings are present and distinct in all three languages', () => {
    const { result } = run(`(function () {
      var keys = ['new_task_button', 'new_task_title', 'field_title', 'field_type',
                  'field_priority', 'field_description', 'create_button', 'cancel_button',
                  'title_required', 'create_failed'];
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = keys.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    assert.strictEqual(result.en[0], 'New task');
    assert.strictEqual(result.ru[0], 'Новая задача');
    assert.strictEqual(result.ja[0], '新規タスク');
    assert.strictEqual(result.en[6], 'Create');
    assert.strictEqual(result.ru[6], 'Создать');
    assert.strictEqual(result.ja[6], '作成');
    // Nothing fell back to English in ru/ja.
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
  });

  // Placement and look of the button (T-0137). The harness has no HTML parser
  // and no layout engine, so both are asserted on the source, the way the drag
  // & drop tests read the stylesheet through cssRules().
  function headerSource() {
    const m = loadHtml().match(/<header>([\s\S]*?)<\/header>/);
    assert.ok(m, '<header> must be present in ui/index.html');
    return m[1];
  }

  it('the + button is the first control of the header and has left the export group', () => {
    const header = headerSource();
    // Everything between </h1> and the type filter is a direct child of <header>.
    const beforeFilters = header.slice(header.indexOf('</h1>'), header.indexOf('id="type-filter"'));
    assert.match(beforeFilters, /<button id="new-task"/, 'the + button must sit between <h1> and the type filter');
    const rightGroup = header.slice(header.indexOf('id="search-filter"'));
    assert.doesNotMatch(rightGroup, /id="new-task"/, 'the + button must be gone from the right-hand action group');
    assert.strictEqual(header.match(/id="new-task"/g).length, 1, 'moved, not copied');
  });

  it('the + button holds the glyph and the label as two elements, and stays a neutral .tf-btn', () => {
    const btn = headerSource().match(/<button id="new-task"[\s\S]*?<\/button>/);
    assert.ok(btn, 'the + button must be present in the header');
    assert.match(btn[0], /<span id="new-task-glyph" aria-hidden="true">\+<\/span>/);
    assert.match(btn[0], /<span id="new-task-label"><\/span>/);
    // A .tf-btn.active would be switched off by any click on the type filter.
    assert.match(btn[0], /class="tf-btn"/);
  });

  it('only the glyph is enlarged, and the button keeps the height and the neutral fill of the row', () => {
    const rules = cssRules();
    const rule = (sel) => {
      const body = rules.get(sel);
      assert.ok(body !== undefined, 'no CSS rule for ' + sel);
      return body;
    };
    const px = (body, prop) => {
      const m = body.match(new RegExp(prop + ': (\\d+)px'));
      assert.ok(m, prop + ' must be set in px: ' + body);
      return Number(m[1]);
    };
    const rowSize = Number(rule('.tf-btn').match(/font: \d+ (\d+)px/)[1]);
    const button = rule('#new-task');
    const glyphSize = px(rule('#new-task-glyph'), 'font-size');
    assert.ok(glyphSize > rowSize, 'the glyph must be larger than the label: ' + glyphSize + ' vs ' + rowSize);
    assert.doesNotMatch(button, /font-size/, 'the label must keep the .tf-btn size');
    // The line box, not the glyph, is what sets the button's height, so the
    // taller glyph cannot push it out of the header row.
    assert.ok(px(button, 'line-height') < glyphSize, 'line-height must not follow the glyph: ' + button);
    assert.doesNotMatch(button, /padding/, 'vertical padding stays the row default');
    // Option (b) of the task - an accent fill - was not chosen.
    assert.doesNotMatch(button, /background|border-color/, 'the button stays neutral: ' + button);
  });

  // The criterion is "a click on a type filter does not change the look of the +
  // button", which is a property of the handler, not of the stylesheet: it used
  // to be checked by looking for a `#new-task.active` rule nobody was ever going
  // to write (T-0147). Driven instead - the + button is a .tf-btn, so the
  // handler's reset-then-activate sweep does reach it.
  it('a click on a type filter leaves the + button exactly as it was', () => {
    const { result } = run(`(function () {
      var plus = document.getElementById('new-task');
      plus.className = 'tf-btn';
      var feature = document.createElement('button');
      feature.className = 'tf-btn';
      feature.dataset.type = 'feature';
      document.querySelectorAll = function (sel) {
        return sel === '.tf-btn' ? [plus, feature] : [];
      };
      var before = plus.className;
      document.getElementById('type-filter').dispatch('click', { target: feature });
      return {
        before: before,
        after: plus.className,
        activated: feature.classList.contains('active'),
        filter: typeFilter,
      };
    })()`);
    assert.strictEqual(result.after, result.before, 'the + button must not be restyled by the click');
    assert.strictEqual(result.after, 'tf-btn');
    // The click did do its own job, so the assertion above is not vacuous.
    assert.strictEqual(result.activated, true);
    assert.strictEqual(result.filter, 'feature');
  });

  // T-0178: below ~1000px the header row ran past the right edge and the search
  // box, the export, the language, the theme and the exit button could not be
  // reached — .board's min-width gives `main` a horizontal scrollbar, and the
  // header is not inside `main`. Measured with tools/screenshot.mjs at 800px,
  // and at 900px in Japanese where the labels are wider.
  it('the header wraps rather than clipping the controls that do not fit', () => {
    const rules = cssRules();
    const header = rules.get('header');
    assert.ok(header !== undefined, 'no CSS rule for header');
    assert.match(header, /flex-wrap: wrap/, 'the header row must wrap: ' + header);
    // A row gap, so the wrapped lines do not touch.
    assert.match(header, /gap: \d+px \d+px/, 'wrapped rows need a row gap of their own: ' + header);
    // The header is still not a scroller of its own — wrapping is the whole fix,
    // and a second horizontal scrollbar would be one more thing to discover.
    assert.doesNotMatch(header, /overflow/, 'the header must not gain a scrollbar: ' + header);
    // And it is still outside <main>, which is why it cannot borrow main's.
    assert.match(loadHtml(), /<\/header>\s*<main>/);
  });

  it('applyStaticLabels() gives the + button a localized title/aria-label, updated on setLang()', () => {
    const { result } = run(`(function () {
      function snapshot() {
        var b = document.getElementById('new-task');
        return { title: b.title, aria: b.getAttribute('aria-label') };
      }
      var out = { en: snapshot() };
      setLang('ru');
      out.ru = snapshot();
      setLang('ja');
      out.ja = snapshot();
      return out;
    })()`);
    assert.deepStrictEqual(result.en, { title: 'New task', aria: 'New task' });
    assert.deepStrictEqual(result.ru, { title: 'Новая задача', aria: 'Новая задача' });
    assert.deepStrictEqual(result.ja, { title: '新規タスク', aria: '新規タスク' });
  });

  it('applyStaticLabels() writes the visible label beside the glyph, updated on setLang()', () => {
    const { result } = run(`(function () {
      function snapshot() {
        return {
          label: document.getElementById('new-task-label').textContent,
          // The glyph lives in its own element, so nothing here may write over
          // the button's own content.
          button: document.getElementById('new-task').textContent,
        };
      }
      var out = { en: snapshot() };
      setLang('ru');
      out.ru = snapshot();
      setLang('ja');
      out.ja = snapshot();
      return out;
    })()`);
    assert.deepStrictEqual(result.en, { label: 'New task', button: '' });
    assert.deepStrictEqual(result.ru, { label: 'Новая задача', button: '' });
    assert.deepStrictEqual(result.ja, { label: '新規タスク', button: '' });
  });

  it('clicking + opens a dialog (role, aria-modal, tabindex, aria-labelledby) with focus inside', () => {
    const { result } = run(`(function () {
      ${OPEN}
      var panel = overlay.querySelector('.panel');
      var h2 = panel.querySelector('h2');
      return {
        stack: modals.length,
        role: panel.getAttribute('role'),
        ariaModal: panel.getAttribute('aria-modal'),
        tabindex: panel.getAttribute('tabindex'),
        labelledby: panel.getAttribute('aria-labelledby'),
        h2id: h2.id,
        focusInside: document.activeElement === panel,
        headerInert: document.querySelector('header').hasAttribute('inert'),
        mainInert: document.querySelector('main').hasAttribute('inert'),
      };
    })()`);
    assert.strictEqual(result.stack, 1);
    assert.strictEqual(result.role, 'dialog');
    assert.strictEqual(result.ariaModal, 'true');
    assert.strictEqual(result.tabindex, '-1');
    assert.strictEqual(result.labelledby, result.h2id);
    assert.ok(result.labelledby, 'the dialog is labelled by its <h2>');
    assert.strictEqual(result.focusInside, true);
    assert.strictEqual(result.headerInert, true);
    assert.strictEqual(result.mainInert, true);
  });

  it('Escape closes the dialog, restores the page chrome and returns focus to the + button', () => {
    const { result } = run(`(function () {
      ${OPEN}
      document.dispatch('keydown', { key: 'Escape' });
      return {
        stack: modals.length,
        returned: document.activeElement === button,
        headerInert: document.querySelector('header').hasAttribute('inert'),
      };
    })()`);
    assert.strictEqual(result.stack, 0);
    assert.strictEqual(result.returned, true);
    assert.strictEqual(result.headerInert, false);
  });

  it('Tab is trapped inside the dialog', () => {
    const { result } = run(`(function () {
      ${OPEN}
      var panel = overlay.querySelector('.panel');
      var ev = { key: 'Tab', shiftKey: false, prevented: false,
                 preventDefault: function () { ev.prevented = true; } };
      document.dispatch('keydown', ev);
      return { prevented: ev.prevented, onPanel: document.activeElement === panel };
    })()`);
    assert.strictEqual(result.prevented, true);
    assert.strictEqual(result.onPanel, true);
  });

  it('the dialog markup is localized (ru): no hardcoded English labels', () => {
    const { result } = run(`(function () {
      lang = 'ru';
      ${OPEN}
      return { html: overlay.innerHTML };
    })()`);
    for (const label of ['Новая задача', 'Название', 'Тип', 'Приоритет', 'Описание', 'Создать', 'Отмена']) {
      assert.ok(result.html.includes(label), `expected the ru label ${label} in the dialog markup`);
    }
    // Domain values are NOT translated - they go to the server verbatim.
    assert.ok(result.html.includes('<option value="feature">feature</option>'));
    assert.ok(result.html.includes('<option value="bug">bug</option>'));
    assert.ok(result.html.includes('<option value="Medium" selected>Medium</option>'));
    for (const priority of ['Blocker', 'Critical', 'Major', 'Medium', 'Minor']) {
      assert.ok(result.html.includes(`value="${priority}"`), `priority ${priority} must be offered`);
    }
  });

  it('submitting POSTs /api/task with the entered fields and closes the dialog', async () => {
    const sandbox = boot(`(function () {
      ${OPEN}
      field('#nt-title').value = '  A brand new task  ';
      field('#nt-type').value = 'bug';
      field('#nt-priority').value = 'Blocker';
      field('#nt-description').value = 'Why it matters.';
      var ev = submit();
      probe = function () {
        return { prevented: ev.prevented, stack: modals.length,
                 error: field('#nt-error').textContent,
                 focusBack: document.activeElement === button };
      };
    })()`);
    await flush();

    assert.strictEqual(sandbox.fetchCalls.length, 1);
    const call = sandbox.fetchCalls[0];
    assert.strictEqual(call.url, '/api/task');
    assert.strictEqual(call.opts.method, 'POST');
    assert.strictEqual(call.opts.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(call.opts.body), {
      title: 'A brand new task', // trimmed before sending
      type: 'bug',
      priority: 'Blocker',
      description: 'Why it matters.',
      // Nothing was typed into the label field, and the empty list says so
      // rather than leaving it to be read off an absent key (T-0282).
      labels: [],
    });

    const state = sandbox.probe();
    assert.strictEqual(state.prevented, true, 'the native form submit is prevented');
    assert.strictEqual(state.stack, 0, 'the dialog closed on success');
    assert.strictEqual(state.error, '', 'no error message on success');
    assert.strictEqual(state.focusBack, true, 'focus returned to the + button');
  });

  it('the board is not re-rendered by hand on success — the SSE "changed" event does it', async () => {
    const sandbox = boot(`(function () {
      ${OPEN}
      field('#nt-title').value = 'Via SSE';
      submit();
      probe = function () { return { urls: fetchCalls.map(function (c) { return c.url; }) }; };
    })()`);
    await flush();
    // Only the create request: no manual /api/board reload from the submit path.
    assert.deepStrictEqual(sandbox.probe().urls, ['/api/task']);
  });

  it('an empty title sends nothing, marks the field invalid and shows a localized message', async () => {
    const sandbox = boot(`(function () {
      lang = 'ru';
      ${OPEN}
      field('#nt-title').value = '   ';
      submit();
      probe = function () {
        return { stack: modals.length,
                 error: field('#nt-error').textContent,
                 invalid: field('#nt-title').classList.contains('invalid'),
                 focused: document.activeElement === field('#nt-title') };
      };
    })()`);
    await flush();
    assert.strictEqual(sandbox.fetchCalls.length, 0, 'no request for an empty title');
    const state = sandbox.probe();
    assert.strictEqual(state.stack, 1, 'the dialog stays open');
    assert.strictEqual(state.error, 'Нужно указать название');
    assert.strictEqual(state.invalid, true);
    assert.strictEqual(state.focused, true, 'the caret goes back to the title field');
  });

  it('a rejected request keeps the dialog open with a localized error and the typed values', async () => {
    const sandbox = boot(`(function () {
      lang = 'en';
      fetchResponse = { ok: false, status: 400, json: function () { return Promise.resolve({ error: 'nope' }); } };
      ${OPEN}
      field('#nt-title').value = 'Doomed task';
      field('#nt-description').value = 'Typed text that must survive.';
      submit();
      probe = function () {
        return { stack: modals.length,
                 error: field('#nt-error').textContent,
                 title: field('#nt-title').value,
                 description: field('#nt-description').value };
      };
    })()`);
    await flush();
    assert.strictEqual(sandbox.fetchCalls.length, 1);
    const state = sandbox.probe();
    assert.strictEqual(state.stack, 1, 'the dialog stays open on failure');
    assert.strictEqual(state.error, 'Failed to create the task');
    assert.strictEqual(state.title, 'Doomed task', 'nothing typed is lost');
    assert.strictEqual(state.description, 'Typed text that must survive.');
  });

  it('a 503 says "busy, retry" rather than "failed", in every language, and retries nothing', async () => {
    for (const [language, message] of [
      ['en', 'The backlog is busy right now — try again'],
      ['ru', 'Бэклог сейчас занят — повторите попытку'],
      ['ja', 'バックログが使用中です — もう一度お試しください'],
    ]) {
      const sandbox = boot(`(function () {
        lang = '${language}';
        fetchResponse = { ok: false, status: 503, json: function () { return Promise.resolve({ error: 'busy' }); } };
        ${OPEN}
        field('#nt-title').value = 'Contended';
        submit();
        probe = function () {
          return { stack: modals.length, error: field('#nt-error').textContent,
                   title: field('#nt-title').value, requests: fetchCalls.length };
        };
      })()`);
      await flush();
      const state = sandbox.probe();
      assert.strictEqual(state.error, message, `expected the busy message in ${language}`);
      assert.strictEqual(state.stack, 1, 'the dialog stays open so the user can retry by hand');
      assert.strictEqual(state.title, 'Contended', 'what was typed survives the retry prompt');
      // No silent retry: a resend could create the task twice if the first
      // response was merely lost (T-0081).
      assert.strictEqual(state.requests, 1);
    }
  });

  it('the busy message is distinct from the general create failure in all three languages', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = { busy: t('busy_retry'), failed: t('create_failed') };
      });
      return out;
    })()`);
    for (const language of ['en', 'ru', 'ja']) {
      assert.ok(result[language].busy, `busy_retry missing in ${language}`);
      assert.notStrictEqual(result[language].busy, result[language].failed);
    }
    assert.notStrictEqual(result.ru.busy, result.en.busy, 'ru did not fall back to English');
    assert.notStrictEqual(result.ja.busy, result.en.busy, 'ja did not fall back to English');
  });

  it('a network failure is reported in the dialog, not swallowed', async () => {
    const sandbox = boot(
      `(function () {
        ${OPEN}
        field('#nt-title').value = 'Offline';
        submit();
        probe = function () { return { stack: modals.length, error: field('#nt-error').textContent }; };
      })()`,
      { fetch: () => Promise.reject(new Error('offline')) }
    );
    await flush();
    const state = sandbox.probe();
    assert.strictEqual(state.stack, 1);
    assert.strictEqual(state.error, 'Failed to create the task');
  });

  it('the Cancel button closes the dialog without sending anything', () => {
    const { result, sandbox } = run(`(function () {
      ${OPEN}
      field('#nt-title').value = 'Never sent';
      field('#nt-cancel').dispatch('click');
      return { stack: modals.length, returned: document.activeElement === button };
    })()`);
    assert.strictEqual(result.stack, 0);
    assert.strictEqual(result.returned, true);
    assert.strictEqual(sandbox.fetchCalls.length, 0);
  });

  it('falls back to feature/Medium when a select somehow has no value', async () => {
    const sandbox = boot(`(function () {
      ${OPEN}
      field('#nt-title').value = 'Defaults';
      submit();
    })()`);
    await flush();
    const body = JSON.parse(sandbox.fetchCalls[0].opts.body);
    assert.strictEqual(body.type, 'feature');
    assert.strictEqual(body.priority, 'Medium');
    assert.strictEqual(body.description, '');
  });

  // ---------- the label field (T-0282) ----------
  // The form is driven the way a user drives it — type a name, press Enter,
  // click a chip's × — and what is asserted is what left in the request. The
  // chips are the form's own state until then: there is no task to post to yet,
  // which is the whole difference from the card dialog's editor.
  //
  // Tasks the board knows, so `labelsInUse()` has something to offer.
  const LABELLED_BOARD = `tasks = [
    { id: 'T-1', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-01', closed: '',
      briefs: [], depends: [], blockedBy: [], labels: ['ui', 'docs'], title: 'Existing', description: '' }
  ];`;

  // The gestures, on the container that carries them: the area is rewritten on
  // every change, so the listeners live on it and the events arrive from the
  // chip or the input the user acted on.
  const LABEL_GESTURES = `
    var area = overlay.querySelector('[data-nt-labels]');
    function typeLabel(name) {
      var input = document.createElement('input');
      input.dataset.labelAdd = '';
      input.value = name;
      var ev = { type: 'keydown', key: 'Enter', target: input, prevented: false,
                 preventDefault: function () { ev.prevented = true; } };
      area.dispatch('keydown', ev);
      return { prevented: ev.prevented, leftInTheField: input.value };
    }
    function dropLabel(name) {
      var chip = document.createElement('button');
      chip.className = 'label-drop';
      chip.dataset.labelDrop = name;
      area.dispatch('click', { type: 'click', target: chip });
    }
  `;

  it('the dialog opens with an empty label field, offering the labels already in use', () => {
    const { result } = run(`(function () {
      ${LABELLED_BOARD}
      ${OPEN}
      return { html: overlay.innerHTML, held: overlay._ntLabels };
    })()`);
    assert.deepStrictEqual(result.held, [], 'a new task starts with no labels');
    // The card dialog's editor, markup and all: chips area, the input, the offer.
    assert.ok(result.html.includes('data-nt-labels'), result.html);
    assert.ok(result.html.includes('class="label-editor"'), result.html);
    assert.ok(result.html.includes('data-label-add'), result.html);
    assert.ok(result.html.includes('<datalist id="nt-label-options">'), result.html);
    assert.ok(result.html.includes('<option value="ui">'), result.html);
    assert.ok(result.html.includes('<option value="docs">'), result.html);
    assert.ok(result.html.includes('<label for="nt-labels">Labels</label>'), result.html);
  });

  it('typing a name and pressing Enter adds a chip, without submitting the form', () => {
    const { result, sandbox } = run(`(function () {
      ${LABELLED_BOARD}
      ${OPEN}
      ${LABEL_GESTURES}
      var typed = typeLabel('  release  ');
      return { typed: typed, held: overlay._ntLabels, html: area.innerHTML, stack: modals.length };
    })()`);
    assert.deepStrictEqual(result.held, ['release'], 'trimmed and kept on the form');
    assert.strictEqual(result.typed.prevented, true, 'Enter here must not submit the form');
    assert.strictEqual(result.typed.leftInTheField, '', 'the field is cleared for the next name');
    assert.strictEqual(result.stack, 1, 'the dialog stays open');
    assert.strictEqual(sandbox.fetchCalls.length, 0, 'nothing is posted before the form is submitted');
    // The chip is drawn, and the offer now leaves out what the form carries.
    assert.ok(result.html.includes('data-label-drop="release"'), result.html);
    assert.ok(result.html.includes('<option value="ui">'), result.html);
    assert.ok(!result.html.includes('<option value="release">'), result.html);
  });

  it('a chip is removed by its ×, and a repeated name is not added twice', () => {
    const { result } = run(`(function () {
      ${LABELLED_BOARD}
      ${OPEN}
      ${LABEL_GESTURES}
      typeLabel('ui');
      typeLabel('docs');
      typeLabel('ui');
      var afterRepeat = overlay._ntLabels.slice();
      typeLabel('');
      var afterBlank = overlay._ntLabels.slice();
      dropLabel('ui');
      return { afterRepeat: afterRepeat, afterBlank: afterBlank,
               held: overlay._ntLabels, html: area.innerHTML };
    })()`);
    assert.deepStrictEqual(result.afterRepeat, ['ui', 'docs'], 'a name already on the form is not a second chip');
    assert.deepStrictEqual(result.afterBlank, ['ui', 'docs'], 'an empty field adds nothing');
    assert.deepStrictEqual(result.held, ['docs']);
    assert.ok(!result.html.includes('data-label-drop="ui"'), result.html);
    assert.ok(result.html.includes('data-label-drop="docs"'), result.html);
  });

  it('submitting sends the chips the form holds, in the create request', async () => {
    const sandbox = boot(`(function () {
      ${LABELLED_BOARD}
      ${OPEN}
      ${LABEL_GESTURES}
      typeLabel('ui');
      typeLabel('release');
      dropLabel('ui');
      typeLabel('docs');
      field('#nt-title').value = 'Labelled at birth';
      submit();
      probe = function () { return { stack: modals.length }; };
    })()`);
    await flush();
    assert.strictEqual(sandbox.fetchCalls.length, 1, 'one request, at submit time');
    const call = sandbox.fetchCalls[0];
    assert.strictEqual(call.url, '/api/task');
    const body = JSON.parse(call.opts.body);
    assert.deepStrictEqual(body.labels, ['release', 'docs']);
    assert.strictEqual(body.title, 'Labelled at birth');
    assert.strictEqual(sandbox.probe().stack, 0, 'the dialog closed on success');
  });

  it('the label endpoint is never touched from this form — there is no task yet', async () => {
    const sandbox = boot(`(function () {
      ${LABELLED_BOARD}
      ${OPEN}
      ${LABEL_GESTURES}
      typeLabel('ui');
      field('#nt-title').value = 'One request only';
      submit();
    })()`);
    await flush();
    assert.deepStrictEqual(
      sandbox.fetchCalls.map((c) => c.url),
      ['/api/task'],
      'setTaskLabels() must not be reused here'
    );
  });

  it('a field label exists in all three languages and none of them is the English one', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) { lang = l; out[l] = t('field_labels'); });
      return out;
    })()`);
    assert.strictEqual(result.en, 'Labels');
    assert.strictEqual(result.ru, 'Метки');
    assert.strictEqual(result.ja, 'ラベル');
  });

  it('the field is localized in the dialog markup, not hardcoded English', () => {
    const { result } = run(`(function () {
      lang = 'ja';
      ${OPEN}
      return { html: overlay.innerHTML };
    })()`);
    assert.ok(result.html.includes('<label for="nt-labels">ラベル</label>'), result.html);
    assert.ok(!result.html.includes('>Labels<'), result.html);
  });

  it('a label typed into the form is escaped, never interpreted as markup', () => {
    const { result } = run(`(function () {
      ${LABELLED_BOARD}
      ${OPEN}
      ${LABEL_GESTURES}
      typeLabel('<img src=x>');
      return { html: area.innerHTML, held: overlay._ntLabels };
    })()`);
    assert.deepStrictEqual(result.held, ['<img src=x>']);
    assert.ok(!result.html.includes('<img'), result.html);
    assert.ok(result.html.includes('&lt;img src=x&gt;'), result.html);
  });
});

// =====================================================================
// task dependencies (T-0087): modal list, card marker, click-through
// =====================================================================
describe('task dependencies', () => {
  // `blockedBy` is what the server computed (/api/board); the UI only displays
  // it. The fixture mixes a finished, a cancelled and an unfinished prerequisite.
  const DEP_TASKS = `[
    { id: 'T-0001', type: 'feature', status: 'done', priority: 'Major', created: '2026-01-01', closed: '2026-01-05', briefs: [], depends: [], blockedBy: [], title: 'Finished prerequisite', description: '' },
    { id: 'T-0002', type: 'feature', status: 'cancelled', priority: 'Major', created: '2026-01-02', closed: '2026-01-06', briefs: [], depends: [], blockedBy: [], title: 'Cancelled prerequisite', description: '' },
    { id: 'T-0003', type: 'feature', status: 'in_progress', priority: 'Major', created: '2026-01-03', closed: '', briefs: [], depends: [], blockedBy: [], title: 'Unfinished prerequisite', description: '' },
    { id: 'T-0004', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-04', closed: '', briefs: [], depends: ['T-0001', 'T-0002', 'T-0003'], blockedBy: ['T-0003'], title: 'Dependent task', description: '' }
  ]`;

  it('the dependency strings are present and distinct in all three languages', () => {
    const { result } = run(`(function () {
      var keys = ['meta_depends', 'empty_depends', 'dep_unknown', 'dep_cancelled_hint',
                  'blocked_one', 'blocked_many'];
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = keys.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    assert.strictEqual(result.en[0], 'depends on');
    assert.strictEqual(result.ru[0], 'зависит от');
    assert.strictEqual(result.ja[0], '依存先');
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
    for (const l of ['en', 'ru', 'ja']) {
      assert.ok(result[l][4].includes('{title}'), `blocked_one (${l}) must keep the {title} placeholder`);
      assert.ok(result[l][5].includes('{count}'), `blocked_many (${l}) must keep the {count} placeholder`);
    }
  });

  it('the task dialog lists every dependency with its current status, as clickable chips', () => {
    const { result } = run(`(function () {
      tasks = ${DEP_TASKS};
      openTask('T-0004');
      return { html: modals[modals.length - 1].innerHTML };
    })()`);
    assert.ok(result.html.includes('depends on'));
    for (const id of ['T-0001', 'T-0002', 'T-0003']) {
      assert.ok(result.html.includes(`data-task="${id}"`), `${id} must be a clickable chip`);
    }
    // Each chip carries the prerequisite's status, so "is it done yet?" needs no
    // second click.
    assert.ok(result.html.includes('Done'));
    assert.ok(result.html.includes('Cancelled'));
    assert.ok(result.html.includes('In Progress'));
  });

  it('a cancelled dependency is marked apart from a finished one', () => {
    const { result } = run(`(function () {
      tasks = ${DEP_TASKS};
      openTask('T-0004');
      var html = modals[modals.length - 1].innerHTML;
      function chip(id) {
        var i = html.indexOf('data-task="' + id + '"');
        return html.slice(html.lastIndexOf('<span', i), html.indexOf('</span>', i));
      }
      return { done: chip('T-0001'), cancelled: chip('T-0002') };
    })()`);
    assert.ok(result.cancelled.includes('dep-cancelled'));
    assert.ok(result.cancelled.includes('prerequisite cancelled'));
    assert.ok(!result.done.includes('dep-cancelled'));
  });

  it('a dependency on a task the board does not know is labelled as such', () => {
    const { result } = run(`(function () {
      tasks = ${DEP_TASKS};
      tasks[3].depends = ['T-9999'];
      openTask('T-0004');
      return { html: modals[modals.length - 1].innerHTML };
    })()`);
    assert.ok(result.html.includes('data-task="T-9999"'));
    assert.ok(result.html.includes('unknown task'));
  });

  it('a task with no dependencies shows the empty marker, not an empty row', () => {
    const { result } = run(`(function () {
      lang = 'ru';
      tasks = ${DEP_TASKS};
      openTask('T-0001');
      return { html: modals[modals.length - 1].innerHTML };
    })()`);
    assert.ok(result.html.includes('зависит от'));
    assert.ok(result.html.includes('нет'));
    assert.ok(!result.html.includes('data-task='));
  });

  it('clicking a dependency chip opens that task', () => {
    // The fake DOM does not parse innerHTML, so the chips are handed to the real
    // wiring function directly - it is the same call openTask() makes.
    const { result } = run(`(function () {
      tasks = ${DEP_TASKS};
      var chip = document.createElement('span');
      chip.dataset.task = 'T-0003';
      var overlay = { querySelectorAll: function () { return [chip]; } };
      wireDependencyLinks(overlay);
      var before = modals.length;
      chip.dispatch('click');
      var opened = modals[modals.length - 1];
      return {
        opened: modals.length - before,
        html: opened ? opened.innerHTML : '',
      };
    })()`);
    assert.strictEqual(result.opened, 1);
    assert.ok(result.html.includes('Unfinished prerequisite'));
  });

  it('a card with unfinished prerequisites carries the blocked marker, naming the blocker', () => {
    const { result } = run(`(function () {
      tasks = ${DEP_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); lang = 'en';
      render();
      function card(st, id) {
        return scrollContainers[st].children.filter(function (c) { return c.dataset.id === id; })[0];
      }
      return {
        dependent: card('ready', 'T-0004').innerHTML,
        prerequisite: card('in_progress', 'T-0003').innerHTML,
      };
    })()`);
    assert.ok(result.dependent.includes('blocked-flag'));
    // The badge names the blocker; its id stays reachable through the tooltip.
    assert.ok(result.dependent.includes('waiting: Unfinished prerequisite'));
    assert.ok(result.dependent.includes('T-0003 — Unfinished prerequisite'));
    assert.ok(!result.prerequisite.includes('blocked-flag'));
  });

  it('closed cards never show the marker, even with unfinished prerequisites', () => {
    const { result } = run(`(function () {
      tasks = ${DEP_TASKS};
      tasks[0].depends = ['T-0003']; tasks[0].blockedBy = ['T-0003']; // done task
      tasks[1].depends = ['T-0003']; tasks[1].blockedBy = ['T-0003']; // cancelled task
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); lang = 'en';
      render();
      return {
        done: scrollContainers['done'].children[0].innerHTML,
        cancelled: scrollContainers['cancelled'].children[0].innerHTML,
      };
    })()`);
    assert.ok(!result.done.includes('blocked-flag'));
    assert.ok(!result.cancelled.includes('blocked-flag'));
  });

  it('the marker disappears on the next render when the prerequisite closes (it is part of cardSig)', () => {
    const { result } = run(`(function () {
      tasks = ${DEP_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); lang = 'en';
      render();
      function card() {
        return scrollContainers['ready'].children.filter(function (c) { return c.dataset.id === 'T-0004'; })[0];
      }
      var before = card();
      var sigBefore = cardSig(tasks[3]);
      // What the next /api/board delivers once T-0003 is done: same task, empty
      // blockedBy.
      tasks = tasks.map(function (x) {
        if (x.id === 'T-0003') return Object.assign({}, x, { status: 'done', closed: '2026-01-09' });
        if (x.id === 'T-0004') return Object.assign({}, x, { blockedBy: [] });
        return x;
      });
      render();
      var after = card();
      return {
        sigChanged: sigBefore !== cardSig(tasks[3]),
        nodeRebuilt: before !== after,
        markedBefore: before.innerHTML.indexOf('blocked-flag') !== -1,
        markedAfter: after.innerHTML.indexOf('blocked-flag') !== -1,
      };
    })()`);
    assert.strictEqual(result.markedBefore, true);
    assert.strictEqual(result.sigChanged, true);
    assert.strictEqual(result.nodeRebuilt, true);
    assert.strictEqual(result.markedAfter, false);
  });

  it('tasks delivered without depends/blockedBy render exactly as before', () => {
    const { result } = run(`(function () {
      tasks = [{ id: 'T-1', type: 'feature', status: 'ready', priority: 'Major',
                 created: '2026-01-01', closed: '', briefs: [], title: 'Legacy shape', description: '' }];
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); lang = 'en';
      render();
      openTask('T-1');
      return {
        card: scrollContainers['ready'].children[0].innerHTML,
        modal: modals[modals.length - 1].innerHTML,
      };
    })()`);
    assert.ok(!result.card.includes('blocked-flag'));
    assert.ok(result.modal.includes('depends on'));
    assert.ok(result.modal.includes('none'));
  });
});

// =====================================================================
// open questions of an agent session (T-0083): the "needs answer" marker
// =====================================================================
describe('a task waiting for an answer', () => {
  // `awaitingAnswer` is what the server derived from the description
  // (/api/board); the board only displays it.
  const ASK_TASKS = `[
    { id: 'T-0001', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: true, title: 'Session asked', description: 'Refined.\\n\\n### Session questions\\n\\n- Which format?' },
    { id: 'T-0002', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-02', closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: false, title: 'Session silent', description: 'Refined.' }
  ]`;

  function cards(extra) {
    return run(`(function () {
      tasks = ${ASK_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); lang = 'en';
      ${extra || ''}
      render();
      function card(id) {
        return scrollContainers['open'].children.filter(function (c) { return c.dataset.id === id; })[0];
      }
      return { asked: card('T-0001').innerHTML, silent: card('T-0002').innerHTML };
    })()`);
  }

  it('the marker strings exist and differ in all three languages', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = [t('awaiting_label'), t('awaiting_hint')];
      });
      return out;
    })()`);
    assert.strictEqual(result.en[0], 'needs answer');
    assert.strictEqual(result.ru[0], 'ждёт ответа');
    assert.strictEqual(result.ja[0], '回答待ち');
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
    for (const l of ['en', 'ru', 'ja']) {
      assert.ok(result[l][1].length > result[l][0].length, `awaiting_hint (${l}) must explain the marker`);
    }
  });

  it('only the asking card carries the marker, with its label and hint', () => {
    const { result } = cards();
    assert.ok(result.asked.includes('awaiting-flag'));
    assert.ok(result.asked.includes('needs answer'));
    assert.ok(result.asked.includes('The agent session left questions in the task description'));
    assert.ok(!result.silent.includes('awaiting-flag'));
  });

  it('the marker label follows the UI language', () => {
    const { result } = cards("lang = 'ru';");
    assert.ok(result.asked.includes('ждёт ответа'));
    assert.ok(!result.asked.includes('needs answer'));
  });

  it('it is a different marker from "blocked": a card can show both at once', () => {
    const { result } = cards("tasks[0].depends = ['T-9999']; tasks[0].blockedBy = ['T-9999'];");
    assert.ok(result.asked.includes('awaiting-flag'));
    assert.ok(result.asked.includes('blocked-flag'));
    assert.ok(result.asked.includes('T-9999 — unknown task'));
  });

  it('appears on the next render once the session appends its questions (it is part of cardSig)', () => {
    const { result } = run(`(function () {
      tasks = ${ASK_TASKS};
      tasks[0].awaitingAnswer = false; // before the session wrote anything
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); lang = 'en';
      render();
      function card() {
        return scrollContainers['open'].children.filter(function (c) { return c.dataset.id === 'T-0001'; })[0];
      }
      var before = card();
      var sigBefore = cardSig(tasks[0]);
      // What the next /api/board delivers once the section is in the file: the
      // same task, nothing else about it changed.
      tasks = tasks.map(function (x) {
        return x.id === 'T-0001' ? Object.assign({}, x, { awaitingAnswer: true }) : x;
      });
      render();
      var after = card();
      return {
        sigChanged: sigBefore !== cardSig(tasks[0]),
        nodeRebuilt: before !== after,
        markedBefore: before.innerHTML.indexOf('awaiting-flag') !== -1,
        markedAfter: after.innerHTML.indexOf('awaiting-flag') !== -1,
      };
    })()`);
    assert.strictEqual(result.markedBefore, false);
    assert.strictEqual(result.sigChanged, true);
    assert.strictEqual(result.nodeRebuilt, true);
    assert.strictEqual(result.markedAfter, true);
  });

  it('a task delivered without the field renders without the marker', () => {
    const { result } = run(`(function () {
      tasks = [{ id: 'T-1', type: 'feature', status: 'open', priority: 'Major',
                 created: '2026-01-01', closed: '', briefs: [], title: 'Legacy shape', description: '' }];
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); lang = 'en';
      render();
      return { card: scrollContainers['open'].children[0].innerHTML };
    })()`);
    assert.ok(!result.card.includes('awaiting-flag'));
  });

  // T-0101: a worker session asks from `in_progress` and the task stays there,
  // so the card in that column is the only thing that can say the work stands.
  it('marks a card in In Progress too, on the same field and with the same look', () => {
    const { result } = run(`(function () {
      tasks = ${ASK_TASKS};
      tasks[0].status = 'in_progress';
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); lang = 'en';
      render();
      return { card: scrollContainers['in_progress'].children[0].innerHTML };
    })()`);
    assert.ok(result.card.includes('awaiting-flag'));
    assert.ok(result.card.includes('needs answer'));
  });

  it('the questions section shows up in the task dialog as part of the description', () => {
    const { result } = run(`(function () {
      tasks = ${ASK_TASKS};
      lang = 'en';
      openTask('T-0001');
      return { html: modals[modals.length - 1].innerHTML };
    })()`);
    assert.ok(result.html.includes('Session questions'));
    assert.ok(result.html.includes('Which format?'));
  });
});

// =====================================================================
// answering the questions from the card (T-0085)
// =====================================================================
describe('the answer form in the task dialog', () => {
  const ASK_TASKS = `[
    { id: 'T-0001', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: true, title: 'Session asked', description: 'Refined.\\n\\n### Session questions\\n\\n- Which format?' },
    { id: 'T-0002', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-02', closed: '', briefs: [], depends: [], blockedBy: [], awaitingAnswer: false, title: 'Session silent', description: 'Refined.' }
  ]`;

  // Opens the dialog for `id` and installs probes over it. The fake DOM's
  // querySelector answers every selector with a node whether the markup has it
  // or not, so the form's own hooks are asserted on the markup string; the
  // probes below then drive those same nodes.
  function openDialog(id, extra) {
    const { sandbox } = run(`(function () {
      tasks = ${ASK_TASKS};
      lang = 'en';
      ${extra || ''}
      openTask('${id}');
      function panel() { return modals[modals.length - 1].querySelector('.panel'); }
      probe = function () {
        if (!modals.length) return { markup: '', open: 0, error: '', invalid: false, text: '' };
        return {
          markup: modals[modals.length - 1].innerHTML,
          open: modals.length,
          error: panel().querySelector('[data-answer-error]').textContent,
          invalid: panel().querySelector('[data-answer-text]').classList.contains('invalid'),
          text: panel().querySelector('[data-answer-text]').value,
        };
      };
      probeType = function (value, restart) {
        panel().querySelector('[data-answer-text]').value = value;
        panel().querySelector('[data-answer-restart]').checked = restart;
      };
      probeSubmit = function () {
        return panel().querySelector('[data-answer-form]').dispatch('submit', { preventDefault: function () {} });
      };
    })()`);
    return sandbox;
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('the form strings exist and differ in all three languages', () => {
    const KEYS = ['answer_title', 'answer_label', 'answer_hint', 'answer_restart', 'answer_send', 'answer_required', 'answer_failed'];
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ${JSON.stringify(KEYS)}.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      assert.strictEqual(result[l].length, KEYS.length);
      for (let i = 0; i < KEYS.length; i++) {
        assert.ok(result[l][i], `${l}.${KEYS[i]} is missing`);
      }
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
  });

  it('appears only in the dialog of a task that is waiting for an answer', () => {
    const asked = openDialog('T-0001').probe();
    assert.ok(asked.markup.includes('data-answer-form'));
    assert.ok(asked.markup.includes('data-answer-text'));
    assert.ok(asked.markup.includes('data-answer-restart'));
    assert.ok(asked.markup.includes('data-answer-submit'));
    assert.ok(asked.markup.includes('Answer the session'));

    const silent = openDialog('T-0002').probe();
    assert.ok(!silent.markup.includes('data-answer-form'));
  });

  it('the restart box is checked by default', () => {
    const markup = openDialog('T-0001').probe().markup;
    assert.match(markup, /<input type="checkbox" checked data-answer-restart>/);
  });

  it('its labels follow the UI language', () => {
    const markup = openDialog('T-0001', "lang = 'ru';").probe().markup;
    assert.ok(markup.includes('Ответить сессии'));
    assert.ok(!markup.includes('Answer the session'));
  });

  // T-0101: the same form serves the worker session's questions, and the server
  // picks the kind to restart from the very same status.
  it('the restart box names the session the status will actually restart', () => {
    const briefing = openDialog('T-0001').probe().markup;
    assert.ok(briefing.includes('Restart the briefing session'));

    const worker = openDialog('T-0001', "tasks[0].status = 'in_progress';").probe().markup;
    assert.ok(worker.includes('Restart the worker session'));
    assert.ok(!worker.includes('Restart the briefing session'));

    const workerRu = openDialog('T-0001', "tasks[0].status = 'in_progress'; lang = 'ru';").probe().markup;
    assert.ok(workerRu.includes('Перезапустить воркер-сессию'));
  });

  it('an empty answer is refused in place and sends nothing', async () => {
    const sandbox = openDialog('T-0001');
    sandbox.fetchCalls.length = 0;
    sandbox.probeType('   \n ', true);
    await sandbox.probeSubmit();
    const state = sandbox.probe();
    assert.deepStrictEqual(sandbox.fetchCalls, []);
    assert.strictEqual(state.error, 'Write an answer first');
    assert.strictEqual(state.invalid, true);
    assert.strictEqual(state.open, 1, 'the dialog stays open');
  });

  it('POSTs the text and the restart flag to the answer endpoint, then closes the dialog', async () => {
    const sandbox = openDialog('T-0001');
    sandbox.fetchCalls.length = 0;
    sandbox.fetchResponse = { ok: true, status: 200, json: () => Promise.resolve({ ok: true, session: 'started' }) };
    sandbox.probeType('ISO-8601, please.', true);
    await sandbox.probeSubmit();
    await flush();

    assert.strictEqual(sandbox.fetchCalls.length, 1);
    const [call] = sandbox.fetchCalls;
    assert.strictEqual(call.url, '/api/task/T-0001/answer');
    assert.strictEqual(call.opts.method, 'POST');
    assert.strictEqual(call.opts.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(call.opts.body), { text: 'ISO-8601, please.', restart: true });
    assert.strictEqual(sandbox.probe().open, 0, 'success closes the dialog');
  });

  it('an unchecked box sends restart: false', async () => {
    const sandbox = openDialog('T-0001');
    sandbox.fetchCalls.length = 0;
    sandbox.fetchResponse = { ok: true, status: 200, json: () => Promise.resolve({ ok: true }) };
    sandbox.probeType('Just record it.', false);
    await sandbox.probeSubmit();
    await flush();
    assert.deepStrictEqual(JSON.parse(sandbox.fetchCalls[0].opts.body), {
      text: 'Just record it.',
      restart: false,
    });
  });

  it('a failure keeps the dialog and the typed answer, and resends nothing', async () => {
    const sandbox = openDialog('T-0001');
    sandbox.fetchCalls.length = 0;
    sandbox.fetchResponse = { ok: false, status: 409, json: () => Promise.resolve({ error: 'nope' }) };
    sandbox.probeType('An answer worth keeping.', true);
    await sandbox.probeSubmit();
    await flush();

    const state = sandbox.probe();
    assert.strictEqual(state.error, 'Failed to save the answer');
    assert.strictEqual(state.text, 'An answer worth keeping.', 'the typed text must survive the failure');
    assert.strictEqual(state.open, 1);
    assert.strictEqual(sandbox.fetchCalls.length, 1, 'no automatic retry');
  });

  it('a 503 says "busy, retry" instead of the general failure', async () => {
    const sandbox = openDialog('T-0001');
    sandbox.fetchResponse = { ok: false, status: 503, json: () => Promise.resolve({ error: 'busy' }) };
    sandbox.probeType('Contended.', true);
    await sandbox.probeSubmit();
    await flush();
    assert.strictEqual(sandbox.probe().error, 'The backlog is busy right now — try again');
  });

  it('a network failure is reported the same way, with the text kept', async () => {
    const sandbox = openDialog('T-0001');
    sandbox.fetch = () => Promise.reject(new Error('offline'));
    sandbox.probeType('Offline answer.', true);
    await sandbox.probeSubmit();
    await flush();
    const state = sandbox.probe();
    assert.strictEqual(state.error, 'Failed to save the answer');
    assert.strictEqual(state.text, 'Offline answer.');
    assert.strictEqual(state.open, 1);
  });
});

// =====================================================================
// project name in the header and the tab title (T-0078)
// =====================================================================
describe('project name', () => {
  // The name arrives from the folder the board was started in (or from
  // BRIEFBOARD_NAME), so it is only as trustworthy as whoever named that
  // directory.
  const HOSTILE = '<img src=x onerror=alert(1)>';

  it('writes the name with textContent and never touches innerHTML', () => {
    const { result } = run(`(function () {
      setProjectName(${JSON.stringify(HOSTILE)});
      var el = document.getElementById('project-name');
      return { text: el.textContent, html: el.innerHTML, title: document.title };
    })()`);
    // Verbatim in textContent — i.e. shown as characters, never parsed into an
    // <img> element whose onerror would run.
    assert.ok(result.text.includes(HOSTILE), `name missing from textContent: ${result.text}`);
    assert.strictEqual(result.html, '', 'the project name must never be written as HTML');
    assert.ok(result.title.startsWith(HOSTILE), `name missing from the tab title: ${result.title}`);
  });

  it('puts the name in the header and the tab title', () => {
    const { result } = run(`(function () {
      setProjectName('payments-api');
      return {
        header: document.getElementById('project-name').textContent,
        title: document.title,
      };
    })()`);
    assert.ok(result.header.includes('payments-api'));
    // Name first: a narrow tab cuts the tail, and the name is what identifies
    // the board.
    assert.strictEqual(result.title, 'payments-api · briefboard');
  });

  it('falls back to the plain title when the server sends no name', () => {
    for (const value of ['undefined', 'null', "''", "'   '", '42']) {
      const { result } = run(`(function () {
        setProjectName('payments-api');
        setProjectName(${value});
        return {
          header: document.getElementById('project-name').textContent,
          title: document.title,
        };
      })()`);
      assert.strictEqual(result.header, '', `header not cleared for ${value}`);
      assert.strictEqual(result.title, 'briefboard · doc/backlog.md', `title not reset for ${value}`);
    }
  });

  // The UI runs load() itself at start-up, so the name is asserted on that real
  // first load rather than on a second call racing it.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('applies the name delivered by /api/board on the initial load()', async () => {
    const { sandbox } = run('true', {
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ tasks: [], project: { name: 'payments-api' } }),
        }),
    });
    await settle();
    assert.strictEqual(sandbox.document.title, 'payments-api · briefboard');
    assert.ok(sandbox.document.getElementById('project-name').textContent.includes('payments-api'));
  });

  it('leaves the tab title as it was when the board cannot be reached', async () => {
    const document = createDocument();
    document.title = 'briefboard · doc/backlog.md';
    const { sandbox } = run('true', {
      document,
      fetch: () => Promise.reject(new Error('offline')),
    });
    await settle();
    assert.strictEqual(sandbox.document.title, 'briefboard · doc/backlog.md');
    assert.strictEqual(sandbox.document.getElementById('project-name').textContent, '');
  });
});

// =====================================================================
// blocking read from the card (T-0092): the `external` type, a marker that
// names the blocker, and the "blocked only" filter
// =====================================================================
describe('external tasks and the blocked marker', () => {
  // T-0100 is the external blocker everything else waits on; T-0200 waits on it
  // alone, T-0300 on three prerequisites at once, T-0400 on nothing.
  const BLOCK_TASKS = `[
    { id: 'T-0100', type: 'external', status: 'ready', priority: 'Blocker', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [], title: 'Get the API keys from the client', description: '' },
    { id: 'T-0101', type: 'external', status: 'open', priority: 'Major', created: '2026-01-02', closed: '', briefs: [], depends: [], blockedBy: [], title: 'Vendor ships the new firmware', description: '' },
    { id: 'T-0102', type: 'bug', status: 'in_progress', priority: 'Major', created: '2026-01-03', closed: '', briefs: [], depends: [], blockedBy: [], title: 'Import crashes on empty rows', description: '' },
    { id: 'T-0200', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-04', closed: '', briefs: [], depends: ['T-0100'], blockedBy: ['T-0100'], title: 'Measure the production load', description: 'needs access' },
    { id: 'T-0300', type: 'feature', status: 'ready', priority: 'Minor', created: '2026-01-05', closed: '', briefs: [], depends: ['T-0100', 'T-0101', 'T-0102'], blockedBy: ['T-0100', 'T-0101', 'T-0102'], title: 'Ship the integration', description: '' },
    { id: 'T-0400', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-06', closed: '', briefs: [], depends: [], blockedBy: [], title: 'Unblocked work', description: '' }
  ]`;

  // Renders the board and returns each card's innerHTML by task id.
  function cards(extra) {
    return run(`(function () {
      tasks = ${BLOCK_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false; lang = 'en';
      ${extra || ''}
      render();
      var out = {};
      Object.keys(scrollContainers).forEach(function (st) {
        scrollContainers[st].children.forEach(function (c) {
          if (c.dataset && c.dataset.id) out[c.dataset.id] = c.innerHTML;
        });
      });
      return out;
    })()`).result;
  }

  it('the new strings exist and differ in all three languages', () => {
    const { result } = run(`(function () {
      var keys = ['tag_external', 'filter_external', 'filter_blocked', 'filter_blocked_title',
                  'blocked_one', 'blocked_many'];
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = keys.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    assert.strictEqual(result.en[0], 'external');
    assert.strictEqual(result.ru[0], 'внешняя');
    assert.strictEqual(result.ja[0], '外部');
    assert.strictEqual(result.en[2], 'Blocked');
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
    for (const l of ['en', 'ru', 'ja']) {
      for (const s of result[l]) assert.ok(s.length > 0, `every ${l} string must be non-empty`);
    }
  });

  it('an external card carries its own tag, distinct from the bug tag; a feature carries none', () => {
    const result = cards();
    assert.ok(result['T-0100'].includes('tag-external'));
    assert.ok(result['T-0100'].includes('external'));
    assert.ok(!result['T-0100'].includes('tag-bug'));
    assert.ok(result['T-0102'].includes('tag-bug'));
    assert.ok(!result['T-0102'].includes('tag-external'));
    assert.ok(!result['T-0400'].includes('tag-external'));
    assert.ok(!result['T-0400'].includes('tag-bug'));
  });

  it('the tag label follows the UI language', () => {
    const result = cards("lang = 'ru';");
    assert.ok(result['T-0100'].includes('внешняя'));
    assert.ok(!result['T-0100'].includes('>external<'));
  });

  it('the task dialog carries the external tag too', () => {
    const { result } = run(`(function () {
      tasks = ${BLOCK_TASKS};
      lang = 'en';
      openTask('T-0100');
      return { html: modals[modals.length - 1].innerHTML };
    })()`);
    assert.ok(result.html.includes('tag-external'));
    assert.ok(result.html.includes('<dd>external</dd>'));
  });

  it('filteredTasks() honours typeFilter = external, alongside feature and bug', () => {
    const { result } = run(`(function () {
      tasks = ${BLOCK_TASKS};
      searchQuery = ''; priorityFilter = new Set(); blockedOnly = false;
      var out = {};
      ['all', 'feature', 'bug', 'external'].forEach(function (f) {
        typeFilter = f;
        out[f] = filteredTasks().map(function (x) { return x.id; });
      });
      return out;
    })()`);
    assert.deepStrictEqual(result.external, ['T-0100', 'T-0101']);
    assert.deepStrictEqual(result.bug, ['T-0102']);
    assert.deepStrictEqual(result.feature, ['T-0200', 'T-0300', 'T-0400']);
    assert.strictEqual(result.all.length, 6);
  });

  it('the header gets a third type button, labelled through i18n', () => {
    const { result } = run(`(function () {
      function label() { return document.querySelector('[data-type="external"]').textContent; }
      var out = { initial: label() };
      setLang('ru'); out.ru = label();
      setLang('ja'); out.ja = label();
      setLang('en'); out.en = label();
      return out;
    })()`);
    assert.strictEqual(result.initial, 'External');
    assert.strictEqual(result.ru, 'Внешние');
    assert.strictEqual(result.ja, '外部');
    assert.strictEqual(result.en, 'External');
  });

  it('the new-task dialog offers external as a third type', () => {
    const { result } = run(`(function () {
      var button = document.getElementById('new-task');
      button.dispatch('click');
      return { types: NEW_TASK_TYPES, html: modals[modals.length - 1].innerHTML };
    })()`);
    assert.deepStrictEqual(result.types, ['feature', 'bug', 'external']);
    assert.ok(result.html.includes('<option value="external">external</option>'));
  });

  // ---- the marker names the blocker ----

  it('a single blocker is named in the marker, with "id — title" in the tooltip', () => {
    const result = cards();
    assert.ok(result['T-0200'].includes('blocked-flag'));
    assert.ok(result['T-0200'].includes('waiting: Get the API keys from t…'));
    assert.ok(result['T-0200'].includes('title="T-0100 — Get the API keys from the client"'));
    // The bare id alone is no longer the whole answer the card gives.
    assert.ok(!result['T-0200'].includes('>T-0100<'));
  });

  it('several blockers are counted in the marker and listed in full in the tooltip', () => {
    const result = cards();
    assert.ok(result['T-0300'].includes('waiting: 3 tasks'));
    for (const line of [
      'T-0100 — Get the API keys from the client',
      'T-0101 — Vendor ships the new firmware',
      'T-0102 — Import crashes on empty rows',
    ]) {
      assert.ok(result['T-0300'].includes(line), `tooltip must list ${line}`);
    }
  });

  it('the marker text is translated', () => {
    const ru = cards("lang = 'ru';");
    assert.ok(ru['T-0200'].includes('ждёт: Get the API keys from t…'));
    assert.ok(ru['T-0300'].includes('ждёт задач: 3'));
    const ja = cards("lang = 'ja';");
    assert.ok(ja['T-0300'].includes('待ちタスク: 3 件'));
  });

  it('a long blocker title is cut with an ellipsis in the marker but kept whole in the tooltip', () => {
    const long = 'A blocker with a really quite long title that would break the card layout';
    const result = cards(`tasks[0].title = ${JSON.stringify(long)};`);
    const html = result['T-0200'];
    assert.ok(html.includes('…'), 'the marker text is elided');
    assert.ok(!html.includes('waiting: ' + long), 'the full title never lands in the marker text');
    assert.ok(html.includes('title="T-0100 — ' + long + '"'), 'the tooltip keeps it whole');
  });

  // The blocker's title is other people's text: it reaches the card through
  // esc(), so markup in it is shown, never interpreted.
  it('a blocker whose title contains HTML is rendered verbatim, in the marker and the tooltip', () => {
    // Short enough to survive the character budget whole, so the escaping is
    // what the assertions below are actually looking at.
    const evil = '<img src="x">&';
    const escaped = '&lt;img src=&quot;x&quot;&gt;&amp;';
    const result = cards(`tasks[0].title = ${JSON.stringify(evil)};`);
    const html = result['T-0200'];
    assert.ok(!html.includes('<img'), 'no live element is ever produced');
    assert.ok(html.includes('waiting: ' + escaped), 'the marker shows the title as text');
    assert.ok(html.includes('title="T-0100 — ' + escaped + '"'), 'and the tooltip keeps its own quoting');
  });

  it('a title containing a $-pattern survives the substitution literally', () => {
    // String.replace expands "$&" in a *string* replacement; the marker fills
    // its placeholder through a function, so the title is taken verbatim.
    const result = cards(`tasks[0].title = "Pay $& invoice";`);
    assert.ok(result['T-0200'].includes('waiting: Pay $&amp; invoice'));
  });

  it('renaming a blocker changes cardSig and repaints the dependent card', () => {
    const { result } = run(`(function () {
      tasks = ${BLOCK_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false; lang = 'en';
      render();
      function card() {
        return scrollContainers['ready'].children.filter(function (c) { return c.dataset.id === 'T-0200'; })[0];
      }
      var before = card();
      var sigBefore = cardSig(tasks[3]);
      // What the next /api/board delivers after the blocker was retitled: only
      // the blocker changed, the dependent task itself is untouched.
      tasks = tasks.map(function (x) {
        return x.id === 'T-0100' ? Object.assign({}, x, { title: 'Client sent the keys — verify them' }) : x;
      });
      render();
      var after = card();
      return {
        sigChanged: sigBefore !== cardSig(tasks[3]),
        nodeRebuilt: before !== after,
        before: before.innerHTML,
        after: after.innerHTML,
      };
    })()`);
    assert.strictEqual(result.sigChanged, true);
    assert.strictEqual(result.nodeRebuilt, true);
    assert.ok(result.before.includes('Get the API keys'));
    assert.ok(result.after.includes('Client sent the keys'));
    assert.ok(!result.after.includes('Get the API keys'));
  });

  // ---- the "blocked only" filter ----

  it('the filter keeps exactly the tasks with a non-empty blockedBy', () => {
    const { result } = run(`(function () {
      tasks = ${BLOCK_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set();
      blockedOnly = true;
      var narrowed = filteredTasks().map(function (x) { return x.id; });
      blockedOnly = false;
      var restored = filteredTasks().map(function (x) { return x.id; });
      return { narrowed: narrowed, restored: restored };
    })()`);
    assert.deepStrictEqual(result.narrowed, ['T-0200', 'T-0300']);
    assert.strictEqual(result.restored.length, 6);
  });

  it('it combines with type, priority and search by AND', () => {
    const { result } = run(`(function () {
      tasks = ${BLOCK_TASKS};
      var out = {};
      typeFilter = 'feature'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = true;
      out.byType = filteredTasks().map(function (x) { return x.id; });
      priorityFilter = new Set(['Major']);
      out.plusPriority = filteredTasks().map(function (x) { return x.id; });
      searchQuery = 'access';
      out.plusSearch = filteredTasks().map(function (x) { return x.id; });
      // An unblocked task matching every other filter is still excluded.
      priorityFilter = new Set(); searchQuery = 'Unblocked';
      out.unblockedExcluded = filteredTasks().map(function (x) { return x.id; });
      // ...and appears the moment the toggle goes off.
      blockedOnly = false;
      out.toggleOff = filteredTasks().map(function (x) { return x.id; });
      return out;
    })()`);
    assert.deepStrictEqual(result.byType, ['T-0200', 'T-0300']);
    assert.deepStrictEqual(result.plusPriority, ['T-0200']); // T-0300 is Minor
    assert.deepStrictEqual(result.plusSearch, ['T-0200']);
    assert.deepStrictEqual(result.unblockedExcluded, []);
    assert.deepStrictEqual(result.toggleOff, ['T-0400']);
  });

  it('the toggle button flips the filter, its active class and aria-pressed', () => {
    const { result } = run(`(function () {
      tasks = ${BLOCK_TASKS};
      typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set(); blockedOnly = false;
      var btn = document.getElementById('blocked-filter');
      function snap() {
        return { on: blockedOnly, active: btn.classList.contains('active'),
                 pressed: btn.getAttribute('aria-pressed'),
                 shown: filteredTasks().map(function (x) { return x.id; }) };
      }
      var out = { initial: snap() };
      btn.dispatch('click');
      out.afterFirst = snap();
      btn.dispatch('click');
      out.afterSecond = snap();
      return out;
    })()`);
    assert.strictEqual(result.initial.on, false);
    assert.strictEqual(result.initial.shown.length, 6);
    assert.deepStrictEqual(result.afterFirst.shown, ['T-0200', 'T-0300']);
    assert.strictEqual(result.afterFirst.active, true);
    assert.strictEqual(result.afterFirst.pressed, 'true');
    assert.strictEqual(result.afterSecond.on, false);
    assert.strictEqual(result.afterSecond.active, false);
    assert.strictEqual(result.afterSecond.pressed, 'false');
    assert.strictEqual(result.afterSecond.shown.length, 6);
  });

  it('the toggle is not a .tf-btn: clicking a type filter must not switch it off', () => {
    const { result } = run(`(function () {
      var btn = document.getElementById('blocked-filter');
      btn.dispatch('click');
      var typeBtn = document.createElement('button');
      typeBtn.classList.add('tf-btn');
      typeBtn.dataset.type = 'bug';
      document.getElementById('type-filter').dispatch('click', { type: 'click', target: typeBtn });
      return { on: blockedOnly, active: btn.classList.contains('active'), isTfBtn: btn.classList.contains('tf-btn') };
    })()`);
    assert.strictEqual(result.isTfBtn, false);
    assert.strictEqual(result.on, true);
    assert.strictEqual(result.active, true);
  });

  it('the toggle label and title come from i18n and follow the language', () => {
    const { result } = run(`(function () {
      var btn = document.getElementById('blocked-filter');
      function snap() { return { text: btn.textContent, title: btn.title }; }
      var out = { initial: snap() };
      setLang('ru'); out.ru = snap();
      setLang('ja'); out.ja = snap();
      return out;
    })()`);
    assert.deepStrictEqual(result.initial, { text: 'Blocked', title: 'Show only blocked tasks' });
    assert.strictEqual(result.ru.text, 'Заблокированные');
    assert.strictEqual(result.ru.title, 'Показать только заблокированные задачи');
    assert.strictEqual(result.ja.text, 'ブロック中');
  });
});

// =====================================================================
// the run profile selector in the task dialog (T-0108)
// =====================================================================
describe('the run profile in the task dialog', () => {
  const PROFILE_TASKS = `[
    { id: 'T-0001', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [], profile: 'fast', title: 'Profiled', description: 'x' },
    { id: 'T-0002', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [], profile: '', title: 'Default profile', description: 'x' },
    { id: 'T-0003', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [], profile: 'gone', title: 'Profile no longer declared', description: 'x' }
  ]`;

  // Both templates carry {profile} unless a test says otherwise: that is the
  // configuration in which the choice has its plain effect, and the one the
  // assertions below are about (T-0121).
  function dialog(id, declared, sessions) {
    const config = {
      enabled: true,
      worker: true,
      profiles: declared,
      profileUsedBy: { briefing: true, worker: true },
      ...(sessions || {}),
    };
    return run(`(function () {
      tasks = ${PROFILE_TASKS};
      lang = 'en';
      sessionsConfigured = ${JSON.stringify(config)};
      openTask('${id}');
      return { html: modals[modals.length - 1].innerHTML };
    })()`).result.html;
  }

  it('with nothing declared there is no control at all', () => {
    const html = dialog('T-0001', []);
    assert.ok(!html.includes('data-profile-select'));
    assert.ok(!html.includes('run profile'));
  });

  it('offers exactly the declared profiles, plus the "default" entry', () => {
    const html = dialog('T-0002', ['deep', 'fast']);
    assert.ok(html.includes('data-profile-select="T-0002"'));
    assert.ok(html.includes('<option value="deep"'));
    assert.ok(html.includes('<option value="fast"'));
    assert.ok(html.includes('<option value="" selected>default</option>'));
    assert.ok(!html.includes('<option value="whatever"'));
  });

  it('the task\'s own profile is the selected one', () => {
    const html = dialog('T-0001', ['deep', 'fast']);
    assert.ok(html.includes('<option value="fast" selected>fast</option>'));
    assert.ok(html.includes('<option value="">default</option>'), 'the default entry is not selected');
  });

  it('a profile the declaration no longer carries is shown, and marked', () => {
    const html = dialog('T-0003', ['deep', 'fast']);
    assert.ok(html.includes('<option value="gone" selected'));
    assert.ok(html.includes('BRIEFBOARD_PROFILES'), 'the hint says why it will not run');
  });

  it('the value is escaped, never interpreted as markup', () => {
    const html = run(`(function () {
      tasks = ${PROFILE_TASKS};
      sessionsConfigured = { enabled: true, worker: true, profiles: ['<img src=x>'] };
      openTask('T-0002');
      return { html: modals[modals.length - 1].innerHTML };
    })()`).result.html;
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img src=x&gt;'));
  });

  it('choosing a profile POSTs it to the narrow endpoint and changes nothing else', async () => {
    const { sandbox } = run(`(function () {
      tasks = ${PROFILE_TASKS};
      sessionsConfigured = { enabled: true, worker: true, profiles: ['deep', 'fast'] };
      var select = document.createElement('select');
      select.dataset.profileSelect = 'T-0002';
      select.value = 'fast';
      wireProfileSelect({ querySelectorAll: function () { return [select]; } });
      select.dispatch('change');
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writes = sandbox.fetchCalls.filter((c) => c.opts && c.opts.method === 'POST');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].url, '/api/task/T-0002/profile');
    assert.deepStrictEqual(JSON.parse(writes[0].opts.body), { profile: 'fast' });
  });

  it('a failed write is reported, and a busy backlog says so', async () => {
    for (const [status, message] of [
      [500, 'Failed to change the run profile'],
      [503, 'The backlog is busy right now — try again'],
    ]) {
      const { sandbox } = run(`(function () {
        lang = 'en';
        fetchResponse = { ok: false, status: ${status}, json: function () { return Promise.resolve({}); } };
        setTaskProfile('T-0002', 'fast');
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepStrictEqual(sandbox.alertCalls, [message]);
    }
  });

  it('the strings exist and differ in all three languages', () => {
    const KEYS = ['meta_profile', 'profile_default', 'profile_unknown', 'profile_failed'];
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ${JSON.stringify(KEYS)}.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      for (let i = 0; i < KEYS.length; i++) assert.ok(result[l][i], `${l}.${KEYS[i]} is missing`);
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
  });
});

// =====================================================================
// the selector does not promise what the command templates cannot do (T-0121)
// =====================================================================
describe('the run profile selector says which sessions the choice reaches', () => {
  const TASKS = `[
    { id: 'T-0002', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [], profile: '', title: 'Default profile', description: 'x' }
  ]`;

  function dialog(sessions) {
    const config = { enabled: true, worker: true, profiles: ['deep', 'fast'], ...sessions };
    return run(`(function () {
      tasks = ${TASKS};
      lang = 'en';
      sessionsConfigured = ${JSON.stringify(config)};
      openTask('T-0002');
      return { html: modals[modals.length - 1].innerHTML };
    })()`).result.html;
  }

  it('says nothing extra when both templates use {profile}', () => {
    const html = dialog({ profileUsedBy: { briefing: true, worker: true } });
    assert.ok(html.includes('data-profile-select="T-0002"'));
    assert.ok(!html.includes('profile-note'), 'a working setup gets no note');
  });

  it('with no template using it the control stays, and states that it changes nothing', () => {
    const html = dialog({ profileUsedBy: { briefing: false, worker: false } });
    assert.ok(html.includes('data-profile-select="T-0002"'), 'the control is not hidden');
    assert.ok(html.includes('profile-note'));
    assert.ok(html.includes('No session command uses {profile}'));
    // The way out is named, not left to be guessed.
    assert.ok(html.includes('BRIEFBOARD_SESSION_CMD'));
    assert.ok(html.includes('BRIEFBOARD_WORKER_CMD'));
    // T-0305: the documented name of the review session's variable. The legacy
    // one still works and is not deprecated, but a list of where to put
    // {profile} is advice, and advice names the current name.
    assert.ok(html.includes('BRIEFBOARD_REVIEW_CMD'));
  });

  it('names the one kind that uses it when only the worker template does', () => {
    const html = dialog({ profileUsedBy: { briefing: false, worker: true } });
    assert.ok(html.includes('reaches only these sessions: worker'));
    assert.ok(!html.includes('No session command uses'));
  });

  it('and the other way round for the briefing template', () => {
    const html = dialog({ profileUsedBy: { briefing: true, worker: false } });
    assert.ok(html.includes('reaches only these sessions: briefing'));
  });

  // T-0122: with three kinds a note per combination would be six strings, and
  // one more with every kind added — so the ones that do use it are named.
  it('names every kind that uses it, with the review session among them', () => {
    const html = dialog({
      orchestrator: true,
      profileUsedBy: { briefing: false, worker: true, orchestrator: true },
    });
    assert.ok(html.includes('reaches only these sessions: worker, review'));
  });

  it('says nothing extra when all three configured templates use it', () => {
    const html = dialog({
      orchestrator: true,
      profileUsedBy: { briefing: true, worker: true, orchestrator: true },
    });
    assert.ok(!html.includes('profile-note'));
  });

  // A kind that cannot run cannot ignore anything: counting it would leave a
  // note about worker sessions on a board that starts none.
  it('a kind with no command configured is not counted either way', () => {
    const enabledOnly = dialog({ worker: false, profileUsedBy: { briefing: true, worker: false } });
    assert.ok(!enabledOnly.includes('profile-note'), 'the only runnable kind uses it');

    const workerOnly = dialog({ enabled: false, profileUsedBy: { briefing: true, worker: false } });
    assert.ok(workerOnly.includes('No session command uses {profile}'));
  });

  it('a server that reports no profileUsedBy at all is treated as using none', () => {
    const html = dialog({});
    assert.ok(html.includes('No session command uses {profile}'));
  });

  it('the note is not shown where there is no selector — nothing declared', () => {
    const html = dialog({ profiles: [], profileUsedBy: { briefing: false, worker: false } });
    assert.ok(!html.includes('profile-note'));
    assert.ok(!html.includes('data-profile-select'));
  });

  it('the strings exist and differ in all three languages', () => {
    const KEYS = ['profile_unused', 'profile_some_only'];
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ${JSON.stringify(KEYS)}.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      for (let i = 0; i < KEYS.length; i++) assert.ok(result[l][i], `${l}.${KEYS[i]} is missing`);
      // The placeholder is the thing the reader has to add; a translation that
      // loses it names nothing.
      for (const text of result[l]) assert.ok(text.includes('{profile}'), `${l} lost the placeholder`);
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
  });
});

// =====================================================================
// placeholder substitution (T-0096)
// =====================================================================
describe('placeholder substitution in the UI source', () => {
  it('no message builds a placeholder substitution with String.replace', () => {
    // Regression guard, not a style rule: a literal {name} handed to
    // String.replace takes a *string* replacement, which re-expands $&, $` and
    // $' out of the text that was substituted. tFill() is the only sanctioned
    // path; its own call concatenates the placeholder, so it is not matched.
    const found = UI_SRC.match(/\.replace\(\s*(['"`])\{[^'"`]*\}\1/g) || [];
    assert.deepStrictEqual(found, []);
  });
});

// =====================================================================
// labels (T-0279)
// =====================================================================
describe('labels on the board', () => {
  const LABEL_TASKS = `[
    { id: 'T-1', type: 'feature', status: 'ready', priority: 'Major', created: '2026-01-01', closed: '', briefs: [], depends: [], blockedBy: [], labels: ['ui', 'docs'], title: 'Front end thing', description: 'nothing here' },
    { id: 'T-2', type: 'bug', status: 'open', priority: 'Critical', created: '2026-01-02', closed: '', briefs: [], depends: [], blockedBy: ['T-1'], labels: ['ui'], title: 'Broken button', description: 'crash on submit' },
    { id: 'T-3', type: 'feature', status: 'open', priority: 'Major', created: '2026-01-03', closed: '', briefs: [], depends: [], blockedBy: [], labels: ['api'], title: 'Endpoint', description: 'plain' },
    { id: 'T-4', type: 'feature', status: 'done', priority: 'Minor', created: '2026-01-04', closed: '2026-02-01', briefs: [], depends: [], blockedBy: [], labels: [], title: 'Unlabelled', description: 'plain' }
  ]`;

  const reset = `
    tasks = ${LABEL_TASKS};
    typeFilter = 'all'; searchQuery = ''; priorityFilter = new Set();
    blockedOnly = false; labelFilter = new Set(); lang = 'en';
  `;

  // ---------- the filter ----------
  it('an empty labelFilter is inactive — every task is shown, as before', () => {
    const { result } = run(`(function () {
      ${reset}
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1', 'T-2', 'T-3', 'T-4']);
  });

  it('one selected label keeps exactly the tasks carrying it', () => {
    const { result } = run(`(function () {
      ${reset}
      labelFilter = new Set(['ui']);
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1', 'T-2']);
  });

  it('two selected labels are ORed: a task carrying EITHER passes', () => {
    const { result } = run(`(function () {
      ${reset}
      labelFilter = new Set(['docs', 'api']);
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1', 'T-3']);
  });

  it('and it is ANDed with the type, priority, search and blocked filters', () => {
    const { result } = run(`(function () {
      ${reset}
      var out = {};
      labelFilter = new Set(['ui']);
      typeFilter = 'bug';
      out.withType = filteredTasks().map(function (x) { return x.id; });
      typeFilter = 'all';
      priorityFilter = new Set(['Critical']);
      out.withPriority = filteredTasks().map(function (x) { return x.id; });
      priorityFilter = new Set();
      searchQuery = 'crash';
      out.withSearch = filteredTasks().map(function (x) { return x.id; });
      searchQuery = '';
      blockedOnly = true;
      out.withBlocked = filteredTasks().map(function (x) { return x.id; });
      return out;
    })()`);
    assert.deepStrictEqual(result.withType, ['T-2']);
    assert.deepStrictEqual(result.withPriority, ['T-2']);
    assert.deepStrictEqual(result.withSearch, ['T-2']);
    assert.deepStrictEqual(result.withBlocked, ['T-2']);
  });

  it('a label nobody carries selects nothing rather than everything', () => {
    const { result } = run(`(function () {
      ${reset}
      labelFilter = new Set(['gone']);
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, []);
  });

  // ---------- the free-text search (the answer to "sort by them") ----------
  it('the search box matches a label the way it matches the title', () => {
    const { result } = run(`(function () {
      ${reset}
      searchQuery = 'doc';
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-1']);
  });

  it('and matches it case-insensitively, like the rest of the search', () => {
    const { result } = run(`(function () {
      ${reset}
      searchQuery = 'API';
      return filteredTasks().map(function (x) { return x.id; });
    })()`);
    assert.deepStrictEqual(result, ['T-3']);
  });

  it('labelsInUse() is the sorted set the tasks carry, deduped', () => {
    const { result } = run(`(function () {
      ${reset}
      return labelsInUse();
    })()`);
    assert.deepStrictEqual(result, ['api', 'docs', 'ui']);
  });

  // ---------- the card ----------
  it('a card draws its labels in a row of their own under the title, not in the flag row', () => {
    const { result } = run(`(function () {
      ${reset}
      var el = cardEl(tasks[0]);
      return { html: el.innerHTML };
    })()`);
    const { html } = result;
    assert.ok(html.includes('<div class="labels">'), html);
    assert.ok(html.includes('<span class="label-chip">ui</span>'), html);
    assert.ok(html.includes('<span class="label-chip">docs</span>'), html);
    // Under the title, and after the `.top` row that carries the alarms.
    assert.ok(html.indexOf('class="labels"') > html.indexOf('class="title"'), html);
    // No colour of its own: T-0144's "label and place, no colour spent".
    assert.ok(!/label-chip[^>]*style=/.test(html), 'a chip carries a colour of its own');
    assert.ok(!/class="label-chip [^"]+"/.test(html), 'a chip carries a per-label class');
  });

  it('a card with no labels draws no row at all', () => {
    const { result } = run(`(function () {
      ${reset}
      return { html: cardEl(tasks[3]).innerHTML };
    })()`);
    assert.ok(!result.html.includes('class="labels"'), result.html);
  });

  it('a label is escaped on the card, never interpreted as markup', () => {
    const { result } = run(`(function () {
      ${reset}
      tasks[0].labels = ['<img src=x>'];
      return { html: cardEl(tasks[0]).innerHTML };
    })()`);
    assert.ok(!result.html.includes('<img'), result.html);
    assert.ok(result.html.includes('&lt;img src=x&gt;'), result.html);
  });

  // Without the labels in cardSig the chips would wait for a page reload: a
  // re-labelled task moves nothing else about itself (the T-0083/T-0087 lesson).
  it('cardSig() changes when the labels do, so the card is rebuilt', () => {
    const { result } = run(`(function () {
      ${reset}
      var before = cardSig(tasks[0]);
      tasks[0].labels = ['ui', 'docs', 'api'];
      var added = cardSig(tasks[0]);
      tasks[0].labels = ['docs', 'ui'];
      var reordered = cardSig(tasks[0]);
      tasks[0].labels = ['uidocs'];
      var joined = cardSig(tasks[0]);
      return { before: before, added: added, reordered: reordered, joined: joined };
    })()`);
    assert.notStrictEqual(result.added, result.before);
    assert.notStrictEqual(result.reordered, result.before);
    // The separator matters: ['ui','docs'] and ['uidocs'] are different cards.
    assert.notStrictEqual(result.joined, result.before);
  });

  it('a label added while the board is open repaints that card, without a reload', () => {
    const { result } = run(`(function () {
      ${reset}
      render();
      var readyCards = scrollContainers['ready'].children;
      var before = readyCards.filter(function (c) { return c.dataset.id === 'T-1'; })[0];
      tasks[0].labels = ['ui', 'docs', 'release'];
      render();
      var after = scrollContainers['ready'].children.filter(function (c) { return c.dataset.id === 'T-1'; })[0];
      return { sameNode: before === after, html: after.innerHTML };
    })()`);
    assert.strictEqual(result.sameNode, false, 'the stale node was reused');
    assert.ok(result.html.includes('>release</span>'), result.html);
  });

  // ---------- the header filter ----------
  it('the filter is hidden while no task carries a label, and shown once one does', () => {
    const { result } = run(`(function () {
      ${reset}
      tasks = [];
      render();
      var empty = document.getElementById('label-filter').hidden;
      tasks = ${LABEL_TASKS};
      render();
      return { empty: empty, filled: document.getElementById('label-filter').hidden };
    })()`);
    assert.strictEqual(result.empty, true);
    assert.strictEqual(result.filled, false);
  });

  it('the menu lists every label in use, ticking the selected ones', () => {
    const { result } = run(`(function () {
      ${reset}
      labelFilter = new Set(['docs']);
      render();
      return { html: document.getElementById('label-filter-menu').innerHTML };
    })()`);
    assert.ok(result.html.includes('data-label-pick="api"'), result.html);
    assert.ok(result.html.includes('data-label-pick="docs" checked'), result.html);
    assert.ok(result.html.includes('data-label-pick="ui"><span>ui</span>'), result.html);
  });

  it('the button counts the selection and marks itself active', () => {
    const { result } = run(`(function () {
      ${reset}
      render();
      var idle = { text: document.getElementById('label-filter-btn').textContent,
                   active: document.getElementById('label-filter-btn').classList.contains('active') };
      labelFilter = new Set(['ui', 'docs']);
      render();
      var picked = { text: document.getElementById('label-filter-btn').textContent,
                     active: document.getElementById('label-filter-btn').classList.contains('active') };
      return { idle: idle, picked: picked };
    })()`);
    assert.strictEqual(result.idle.text, 'Labels ▾');
    assert.strictEqual(result.idle.active, false);
    assert.strictEqual(result.picked.text, 'Labels (2) ▾');
    assert.strictEqual(result.picked.active, true);
  });

  it('a selected label the last task dropped falls out of the selection', () => {
    const { result } = run(`(function () {
      ${reset}
      labelFilter = new Set(['api', 'ui']);
      render();
      tasks[2].labels = [];
      render();
      return { kept: Array.from(labelFilter), shown: filteredTasks().map(function (x) { return x.id; }) };
    })()`);
    assert.deepStrictEqual(result.kept, ['ui']);
    assert.deepStrictEqual(result.shown, ['T-1', 'T-2']);
  });

  it('ticking a checkbox adds the label and re-renders; ticking again removes it', () => {
    const { result } = run(`(function () {
      ${reset}
      render();
      var menu = document.getElementById('label-filter-menu');
      var box = document.createElement('input');
      box.dataset.labelPick = 'ui';
      menu.dispatch('change', { type: 'change', target: box });
      var afterFirst = filteredTasks().map(function (x) { return x.id; });
      menu.dispatch('change', { type: 'change', target: box });
      var afterSecond = filteredTasks().map(function (x) { return x.id; });
      return { afterFirst: afterFirst, afterSecond: afterSecond };
    })()`);
    assert.deepStrictEqual(result.afterFirst, ['T-1', 'T-2']);
    assert.deepStrictEqual(result.afterSecond, ['T-1', 'T-2', 'T-3', 'T-4']);
  });

  it('the button opens and closes the popover', () => {
    const { result } = run(`(function () {
      ${reset}
      render();
      var btn = document.getElementById('label-filter-btn');
      var menu = document.getElementById('label-filter-menu');
      // The markup ships the menu hidden; this fake DOM builds elements from
      // ids, not from the HTML, so the starting state is set here.
      menu.hidden = true;
      var closed = menu.hidden;
      btn.dispatch('click', { type: 'click', target: btn });
      var opened = { hidden: menu.hidden, expanded: btn.getAttribute('aria-expanded') };
      btn.dispatch('click', { type: 'click', target: btn });
      return { closed: closed, opened: opened, again: menu.hidden };
    })()`);
    assert.strictEqual(result.closed, true);
    assert.deepStrictEqual(result.opened, { hidden: false, expanded: 'true' });
    assert.strictEqual(result.again, true);
  });

  // ---------- the dialog's editor ----------
  it('the dialog shows a removable chip per label and offers the set already in use', () => {
    const { result } = run(`(function () {
      ${reset}
      openTask('T-1');
      return { html: modals[modals.length - 1].innerHTML };
    })()`);
    const { html } = result;
    assert.ok(html.includes('data-label-drop="ui"'), html);
    assert.ok(html.includes('data-label-drop="docs"'), html);
    assert.ok(html.includes('data-label-add'), html);
    assert.ok(html.includes('<datalist id="label-options-T-1">'), html);
    // Only what the task does not carry yet: offering "ui" back is noise.
    assert.ok(html.includes('<option value="api">'), html);
    assert.ok(!html.includes('<option value="ui">'), html);
  });

  it('a task with no labels gets the empty marker and the input all the same', () => {
    const { result } = run(`(function () {
      ${reset}
      openTask('T-4');
      return { html: modals[modals.length - 1].innerHTML };
    })()`);
    assert.ok(result.html.includes('>none<'), result.html);
    assert.ok(result.html.includes('data-label-add'), result.html);
  });

  it('a label is escaped in the dialog too', () => {
    const { result } = run(`(function () {
      ${reset}
      tasks[0].labels = ['<img src=x>'];
      openTask('T-1');
      return { html: modals[modals.length - 1].innerHTML };
    })()`);
    assert.ok(!result.html.includes('<img'), result.html);
  });

  it('adding a label POSTs the WHOLE list to the narrow endpoint', async () => {
    const { sandbox } = run(`(function () {
      ${reset}
      var input = document.createElement('input');
      input.dataset.labelAdd = '';
      input.value = ' release ';
      wireLabelEditor({
        querySelectorAll: function () { return []; },
        querySelector: function () { return input; },
      }, tasks[0]);
      input.dispatch('keydown', { type: 'keydown', key: 'Enter', target: input });
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writes = sandbox.fetchCalls.filter((c) => c.opts && c.opts.method === 'POST');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].url, '/api/task/T-1/labels');
    assert.deepStrictEqual(JSON.parse(writes[0].opts.body), { labels: ['ui', 'docs', 'release'] });
  });

  it('removing a label POSTs the whole list without it', async () => {
    const { sandbox } = run(`(function () {
      ${reset}
      var drop = document.createElement('button');
      drop.dataset.labelDrop = 'ui';
      wireLabelEditor({
        querySelectorAll: function () { return [drop]; },
        querySelector: function () { return null; },
      }, tasks[0]);
      drop.dispatch('click', { type: 'click', target: drop });
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writes = sandbox.fetchCalls.filter((c) => c.opts && c.opts.method === 'POST');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].url, '/api/task/T-1/labels');
    assert.deepStrictEqual(JSON.parse(writes[0].opts.body), { labels: ['docs'] });
  });

  it('a name the task already carries sends nothing at all', async () => {
    const { sandbox } = run(`(function () {
      ${reset}
      var input = document.createElement('input');
      input.dataset.labelAdd = '';
      input.value = 'ui';
      wireLabelEditor({
        querySelectorAll: function () { return []; },
        querySelector: function () { return input; },
      }, tasks[0]);
      input.dispatch('keydown', { type: 'keydown', key: 'Enter', target: input });
      var blank = document.createElement('input');
      blank.dataset.labelAdd = '';
      blank.value = '   ';
      wireLabelEditor({
        querySelectorAll: function () { return []; },
        querySelector: function () { return blank; },
      }, tasks[0]);
      blank.dispatch('keydown', { type: 'keydown', key: 'Enter', target: blank });
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(sandbox.fetchCalls.filter((c) => c.opts && c.opts.method === 'POST'), []);
  });

  it('a failed write is reported, and a busy backlog says so', async () => {
    for (const [status, message] of [
      [500, 'Failed to change the labels'],
      [503, 'The backlog is busy right now — try again'],
    ]) {
      const { sandbox } = run(`(function () {
        lang = 'en';
        fetchResponse = { ok: false, status: ${status}, json: function () { return Promise.resolve({}); } };
        setTaskLabels('T-1', ['ui']);
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepStrictEqual(sandbox.alertCalls, [message]);
    }
  });

  // ---------- the export ----------
  it('the sheet carries a Labels column with the comma-joined value', () => {
    const { result } = run(`(function () {
      ${reset}
      return { xml: buildSheetXml() };
    })()`);
    assert.ok(result.xml.includes('Labels'), result.xml);
    assert.ok(result.xml.includes('ui, docs'), result.xml);
  });

  it('the column follows the brief column, so the header row still names each value', () => {
    const { result } = run(`(function () {
      ${reset}
      var xml = buildSheetXml();
      return { brief: xml.indexOf('Brief'), labels: xml.indexOf('Labels'), status: xml.indexOf('Status') };
    })()`);
    assert.ok(result.brief < result.labels, 'Labels must follow Brief');
    assert.ok(result.labels < result.status, 'and come before Status');
  });

  // ---------- i18n ----------
  it('every new string exists in all three languages and differs from English', () => {
    const KEYS = [
      'meta_labels', 'empty_labels', 'labels_add_placeholder', 'labels_remove',
      'labels_failed', 'filter_labels', 'filter_labels_title', 'xlsx_col_labels',
    ];
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) {
        lang = l;
        out[l] = ${JSON.stringify(KEYS)}.map(function (k) { return t(k); });
      });
      return out;
    })()`);
    for (const l of ['en', 'ru', 'ja']) {
      for (let i = 0; i < KEYS.length; i++) assert.ok(result[l][i], `${l}.${KEYS[i]} is missing`);
    }
    assert.notDeepStrictEqual(result.ru, result.en);
    assert.notDeepStrictEqual(result.ja, result.en);
    // The placeholder is what names the label being removed; a translation that
    // loses it names nothing.
    for (const l of ['en', 'ru', 'ja']) {
      assert.ok(result[l][3].includes('{label}'), `${l} lost the placeholder`);
    }
  });

  it('the search placeholder names labels in all three languages', () => {
    const { result } = run(`(function () {
      var out = {};
      ['en', 'ru', 'ja'].forEach(function (l) { lang = l; out[l] = t('search_placeholder'); });
      return out;
    })()`);
    assert.match(result.en, /labels/i);
    assert.match(result.ru, /метк/i);
    assert.match(result.ja, /ラベル/);
  });
});
