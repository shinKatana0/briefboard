'use strict';

// Reusable test harness for the client-side logic in ui/index.html.
//
// The UI ships as a single HTML file with two inline <script> blocks:
//   [0] a tiny theme-bootstrap IIFE that runs before <style> (from T-0005), and
//   [1] the main application logic (i18n, rendering, XLSX export, drag&drop...).
//
// This module extracts those blocks by regexp and runs them inside a Node `vm`
// context that is seeded with a minimal fake DOM / browser environment. It
// replaces the throwaway smoke-tests every previous worker re-invented; keep the
// fake-DOM surface here (never inline a new one in each test).
//
// Key vm fact this relies on: top-level `function` declarations become
// properties of the context object, while top-level `const`/`let` become
// context-global lexical bindings. Neither is reachable from the outside as a
// plain property, but BOTH are visible to any later script run in the SAME
// context. So `runInSandbox(src, sandbox, extraCode)` runs the UI source first,
// then runs `extraCode` in the same context where it can call `t()`, reassign
// `tasks`/`lang`/`typeFilter`, and return a plain-data summary for assertions.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI_HTML_PATH = path.join(__dirname, '..', '..', 'ui', 'index.html');

function loadHtml() {
  return fs.readFileSync(UI_HTML_PATH, 'utf8');
}

// Returns the inner text of every <script>...</script> block, in document order.
// Non-greedy so each block stops at its own closing tag.
function extractScripts(html) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// Second <script> block: the main application logic.
function loadUiScript() {
  const scripts = extractScripts(loadHtml());
  if (scripts.length < 2) {
    throw new Error('expected at least 2 <script> blocks in ui/index.html, got ' + scripts.length);
  }
  return scripts[1];
}

// First <script> block: the pre-paint theme-resolution bootstrap (T-0005).
function loadThemeScript() {
  const scripts = extractScripts(loadHtml());
  if (scripts.length < 1) {
    throw new Error('expected at least 1 <script> block in ui/index.html');
  }
  return scripts[0];
}

// ---------- fake DOM ----------

class ClassList {
  constructor() {
    this._set = new Set();
  }
  add(...cs) {
    for (const c of cs) this._set.add(c);
  }
  remove(...cs) {
    for (const c of cs) this._set.delete(c);
  }
  contains(c) {
    return this._set.has(c);
  }
  toggle(c, force) {
    if (force === undefined) {
      if (this._set.has(c)) {
        this._set.delete(c);
        return false;
      }
      this._set.add(c);
      return true;
    }
    if (force) this._set.add(c);
    else this._set.delete(c);
    return !!force;
  }
  // Replace the whole set from a space-separated string, mirroring the browser
  // where assigning element.className rewrites the class list wholesale.
  set(v) {
    this._set = new Set(String(v == null ? '' : v).split(/\s+/).filter(Boolean));
  }
  get value() {
    return [...this._set].join(' ');
  }
}

// A single fake element. Deliberately permissive: it records the state the UI
// code touches (innerHTML/textContent/classList/style/listeners...) so tests can
// inspect it, and can `dispatch()` a synthetic event to fire the registered
// handlers.
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = new ClassList();
    this._attrs = Object.create(null);
    this._listeners = Object.create(null);
    this._selectorCache = new Map();
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.title = '';
    this.href = '';
    this.download = '';
    this.id = '';
    this.tabIndex = 0;
    this.draggable = false;
    this.clicked = false;
    this.removed = false;
    // Focus/inert support (T-0049 modal a11y). `ownerDocument` lets focus()
    // report back to document.activeElement; `focused` records the last focus.
    this.ownerDocument = null;
    this.focused = false;
  }
  // className and classList are two views of the same class set in a real
  // browser; keep them in sync so code that assigns `el.className = 'card'`
  // (e.g. cardEl) is still matched by classList-based lookups like closest().
  get className() {
    return this.classList.value;
  }
  set className(v) {
    this.classList.set(v);
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
  }
  removeAttribute(k) {
    delete this._attrs[k];
  }
  hasAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this._attrs, k);
  }
  // Moving focus here marks this element active on its owning document, so the
  // UI's focus-return logic (closeTop) and focus-trap can be observed in tests.
  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  appendChild(child) {
    this.children.push(child);
    if (child && !child.ownerDocument) child.ownerDocument = this.ownerDocument;
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    return child;
  }
  remove() {
    this.removed = true;
  }
  addEventListener(type, fn) {
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  // Fire every listener registered for `type`. Returns the last handler's
  // return value (useful for async handlers whose promise a test may await).
  dispatch(type, event) {
    const ev = event || {};
    if (ev.type === undefined) ev.type = type;
    if (ev.target === undefined) ev.target = this;
    const arr = this._listeners[type] || [];
    let ret;
    for (const fn of arr.slice()) ret = fn.call(this, ev);
    return ret;
  }
  click() {
    this.clicked = true;
    this.dispatch('click', { type: 'click', target: this });
  }
  querySelector(sel) {
    if (!this._selectorCache.has(sel)) {
      const el = new FakeElement('div');
      el.ownerDocument = this.ownerDocument;
      this._selectorCache.set(sel, el);
    }
    return this._selectorCache.get(sel);
  }
  querySelectorAll() {
    return [];
  }
  // Minimal support for the UI's `e.target.closest('.some-class')` click-
  // delegation pattern. Real closest() walks up the ancestor chain; this fake
  // tree doesn't track parent links, so it only matches the element itself -
  // enough for tests that dispatch a click directly on the leaf button (the
  // realistic case: the element the user actually clicks).
  closest(sel) {
    if (sel[0] === '.' && this.classList.contains(sel.slice(1))) return this;
    return null;
  }
}

// Fake document. Elements are memoised per id / per selector so that a test that
// reads `getElementById('export-excel')` sees the same node the UI code wrote to.
function createDocument() {
  const byId = new Map();
  const bySelector = new Map();
  const doc = {
    _listeners: Object.create(null),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    // Focused element, mirroring the browser default of <body> before any
    // explicit focus() call. Elements update this via FakeElement.focus().
    activeElement: null,
    getElementById(id) {
      if (!byId.has(id)) {
        const el = new FakeElement('div');
        el.id = id;
        el.ownerDocument = doc;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    querySelector(sel) {
      if (!bySelector.has(sel)) {
        const el = new FakeElement('div');
        el.ownerDocument = doc;
        bySelector.set(sel, el);
      }
      return bySelector.get(sel);
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      const el = new FakeElement(tag);
      el.ownerDocument = doc;
      return el;
    },
    // Approximate Node.contains: an element counts as connected while it has
    // not been remove()d. Enough for the focus-return check in closeTop().
    contains(el) {
      return !!el && el.removed !== true;
    },
    addEventListener(type, fn) {
      (doc._listeners[type] || (doc._listeners[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = doc._listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type, event) {
      const ev = event || {};
      if (ev.type === undefined) ev.type = type;
      const arr = doc._listeners[type] || [];
      let ret;
      for (const fn of arr.slice()) ret = fn.call(doc, ev);
      return ret;
    },
    _byId: byId,
    _bySelector: bySelector,
  };
  doc.body.ownerDocument = doc;
  doc.documentElement.ownerDocument = doc;
  doc.activeElement = doc.body;
  // Mirror the real <html data-theme="dark"> default so the theme bootstrap's
  // catch-branch (storage/matchMedia unavailable) leaves a meaningful value.
  doc.documentElement.setAttribute('data-theme', 'dark');
  return doc;
}

// ---------- sandbox ----------

// Builds the fake global environment. `overrides` may replace any top-level
// entry (document, localStorage, matchMedia, fetch, confirm, Blob, ...) and may
// pre-seed localStorage via `overrides.storage` (a plain {key:value} object).
function createSandbox(overrides) {
  overrides = overrides || {};
  const store = new Map(Object.entries(overrides.storage || {}));

  const sandbox = {
    console,
    TextEncoder,
    setTimeout,
    clearTimeout,
    // Instrumentation buffers the tests read after driving the UI.
    capturedBlobParts: [],
    fetchCalls: [],
    confirmCalls: [],
    alertCalls: [],
    // Configurable behaviour for the mocks below.
    confirmReturn: true,
    fetchResponse: null,
  };

  sandbox.document = overrides.document || createDocument();

  sandbox.localStorage =
    overrides.localStorage || {
      getItem(k) {
        return store.has(k) ? store.get(k) : null;
      },
      setItem(k, v) {
        store.set(k, String(v));
      },
      removeItem(k) {
        store.delete(k);
      },
      clear() {
        store.clear();
      },
    };

  sandbox.matchMedia =
    overrides.matchMedia ||
    function matchMedia(query) {
      return { matches: false, media: query, addListener() {}, removeListener() {} };
    };

  sandbox.EventSource =
    overrides.EventSource ||
    function EventSource(url) {
      this.url = url;
      this.readyState = 0;
      this.onmessage = null;
      this.onopen = null;
      this.onerror = null;
    };

  sandbox.URL =
    overrides.URL || {
      createObjectURL() {
        return 'blob:mock';
      },
      revokeObjectURL() {},
    };

  sandbox.Blob =
    overrides.Blob ||
    function Blob(parts, opts) {
      this.parts = parts;
      this.type = (opts && opts.type) || '';
      sandbox.capturedBlobParts.push(parts);
    };

  sandbox.fetch =
    overrides.fetch ||
    function fetch(url, opts) {
      sandbox.fetchCalls.push({ url, opts });
      return Promise.resolve(
        sandbox.fetchResponse || {
          ok: true,
          status: 200,
          json: async () => ({ tasks: [] }),
        }
      );
    };

  sandbox.confirm =
    overrides.confirm ||
    function confirm(msg) {
      sandbox.confirmCalls.push(msg);
      return sandbox.confirmReturn;
    };

  sandbox.alert =
    overrides.alert ||
    function alert(msg) {
      sandbox.alertCalls.push(msg);
    };

  return sandbox;
}

// Runs `src` in a fresh context built around `sandbox`, then (optionally) runs
// `extraCode` in the same context and returns its completion value.
function runInSandbox(src, sandbox, extraCode) {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'ui-index.main.js' });
  if (extraCode) {
    return vm.runInContext(extraCode, sandbox, { filename: 'ui-index.extra.js' });
  }
  return undefined;
}

module.exports = {
  UI_HTML_PATH,
  loadHtml,
  extractScripts,
  loadUiScript,
  loadThemeScript,
  createSandbox,
  createDocument,
  runInSandbox,
  FakeElement,
  ClassList,
};
