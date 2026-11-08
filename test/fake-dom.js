// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A stand-in page for the script src/webview-inject.js copies into Codex's webview folder, so that the real file can be
 * run and what it does to a page can be read back. Enough DOM for that script and no more: elements with attributes, a
 * class list, a style object, children, a tiny selector engine, events, and the three measurements it takes
 * (getBoundingClientRect, scrollIntoView, scrollTo).
 *
 * Two things are under the test's control rather than the clock's, because both are where this kind of script goes
 * wrong: the timers (so a debounce can be stepped through) and the mutation observer (so the records it is handed can
 * be chosen, including records that are the script's own writing coming back).
 *
 * The selector engine takes a comma-separated list of `tag`, `.class` and `[attr]` or `[attr="value"]` in any order,
 * which is every selector that script uses.
 */

function parseOne(text) {
  const part = { tag: '', classes: [], attrs: [] };
  let rest = String(text).trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) { part.tag = tag[0].toUpperCase(); rest = rest.slice(tag[0].length); }
  for (;;) {
    const cls = /^\.([\w-]+)/.exec(rest);
    if (cls) { part.classes.push(cls[1]); rest = rest.slice(cls[0].length); continue; }
    const attr = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest);
    if (attr) {
      part.attrs.push({ name: attr[1], value: attr[2] !== undefined ? attr[2] : attr[3] !== undefined ? attr[3] : attr[4] });
      rest = rest.slice(attr[0].length);
      continue;
    }
    break;
  }
  if (rest) throw new Error(`fake-dom cannot read the selector ${JSON.stringify(text)}`);
  return part;
}
const parseSelector = (text) => String(text).split(',').map(parseOne);

function matchesOne(el, part) {
  if (part.tag && el.tagName !== part.tag) return false;
  for (const c of part.classes) if (!el.classList.contains(c)) return false;
  for (const a of part.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== undefined && String(v) !== a.value) return false;
  }
  return true;
}

class Text {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentNode = null; }
  get textContent() { return this.nodeValue; }
}

class El {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.attributes = [];
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = {};
    this.rect = { top: 0, left: 0, width: 0, height: 0 };
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.clientWidth = 0;
    this.value = '';
    this.isContentEditable = false;
    /* What the script asked this element to do, for the test to read back. */
    this.scrolledIntoView = 0;
    this.scrolledTo = [];
    const el = this;
    this.classList = {
      contains: (n) => el.className.split(/\s+/).includes(n),
      add(n) { if (!this.contains(n)) el.setAttribute('class', (el.className + ' ' + n).trim()); },
      remove(n) { el.setAttribute('class', el.className.split(/\s+/).filter((x) => x && x !== n).join(' ')); },
    };
  }

  get className() { const v = this.getAttribute('class'); return v === null ? '' : String(v); }
  set className(v) { this.setAttribute('class', v); }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }

  get isConnected() {
    for (let n = this; n; n = n.parentNode) if (n === (this.ownerDocument || {}).root) return true;
    return false;
  }

  getAttribute(name) { const a = this.attributes.find((x) => x.name === name); return a ? a.value : null; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  setAttribute(name, value) {
    const a = this.attributes.find((x) => x.name === name);
    if (a) a.value = String(value); else this.attributes.push({ name, value: String(value) });
  }
  removeAttribute(name) { this.attributes = this.attributes.filter((x) => x.name !== name); }

  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(node); else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    (this.ownerDocument || {}).mutate && this.ownerDocument.mutate(this);
    return node;
  }
  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    if (at < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(at, 1);
    node.parentNode = null;
    (this.ownerDocument || {}).mutate && this.ownerDocument.mutate(this);
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) {
    while (this.childNodes.length) this.removeChild(this.childNodes[0]);
    if (value !== '' && value !== null && value !== undefined) this.appendChild(new Text(String(value)));
  }

  matches(sel) { return parseSelector(sel).some((p) => matchesOne(this, p)); }
  closest(sel) {
    const parts = parseSelector(sel);
    for (let n = this; n && n.nodeType === 1; n = n.parentElement) if (parts.some((p) => matchesOne(n, p))) return n;
    return null;
  }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }

  querySelectorAll(sel) {
    const parts = parseSelector(sel), out = [];
    const walk = (el) => {
      for (const k of el.children) { if (parts.some((p) => matchesOne(k, p))) out.push(k); walk(k); }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  getBoundingClientRect() { return this.rect; }
  scrollIntoView() { this.scrolledIntoView++; }
  scrollTo(opts) { this.scrolledTo.push(opts); this.scrollTop = (opts && opts.top) || 0; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((x) => x !== fn); }
  dispatch(type, event) { for (const fn of (this.listeners[type] || []).slice()) fn(Object.assign({ target: this }, event)); }
}

/** A page, its document, and the controls over its timers and its observers. */
function createDom() {
  const timers = [];
  const observers = [];
  const document = {
    root: null,
    hidden: false,
    activeElement: null,
    listeners: {},
    createElement(tag) { return new El(tag, document); },
    createElementNS(ns, tag) { const e = new El(tag, document); e.namespaceURI = ns; return e; },
    addEventListener(type, fn) { (document.listeners[type] = document.listeners[type] || []).push(fn); },
    dispatch(type, event) { for (const fn of (document.listeners[type] || []).slice()) fn(Object.assign({ target: null }, event)); },
    querySelector(sel) { return document.root ? document.root.querySelector(sel) : null; },
    querySelectorAll(sel) { return document.root ? document.root.querySelectorAll(sel) : []; },
    /* Every change of children, for the observers to be handed when the test says so. */
    pending: [],
    mutate(target) { document.pending.push({ type: 'childList', target }); },
  };
  const el = (tag, opts = {}) => {
    const e = new El(tag, document);
    for (const [name, value] of Object.entries(opts.attrs || {})) e.setAttribute(name, value);
    if (opts.class) e.setAttribute('class', opts.class);
    if (opts.rect) e.rect = Object.assign({ top: 0, left: 0, width: 0, height: 0 }, opts.rect);
    if (opts.scrollHeight !== undefined) e.scrollHeight = opts.scrollHeight;
    if (opts.clientHeight !== undefined) e.clientHeight = opts.clientHeight;
    if (opts.clientWidth !== undefined) e.clientWidth = opts.clientWidth;
    for (const t of opts.texts || []) e.appendChild(new Text(t));
    for (const k of opts.kids || []) e.appendChild(k);
    return e;
  };

  class MutationObserver {
    constructor(fn) { this.fn = fn; this.targets = []; this.live = true; observers.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
    disconnect() { this.live = false; }
  }

  const sandbox = {
    document,
    MutationObserver,
    Intl,
    Date,
    Math,
    JSON,
    Object,
    String,
    Number,
    Array,
    Boolean,
    RegExp,
    Error,
    WeakMap,
    parseFloat,
    parseInt,
    isFinite,
    isNaN,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, id: timers.length + 1 }); return timers.length; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    setInterval: () => 1,
    clearInterval: () => {},
  };

  return {
    document,
    el,
    text: (v) => new Text(v),
    sandbox,
    /* The page: one html element with a head and the body the test built. */
    setBody(body) {
      const html = el('html');
      const head = el('head');
      document.root = html;
      document.documentElement = html;
      document.head = head;
      document.body = body;
      html.appendChild(head);
      html.appendChild(body);
      document.pending = [];
    },
    /** Run the timers waiting now, once each, which is how a debounce is stepped through. */
    runTimers() {
      const due = timers.filter((t) => !t.dead && !t.ran);
      for (const t of due) { t.ran = true; t.fn(); }
      return due.length;
    },
    waiting: () => timers.filter((t) => !t.dead && !t.ran).length,
    observers,
    live: () => observers.filter((o) => o.live),
    /** Hand the live observers the records the test chose, as the browser would. */
    fire(records) { for (const o of observers) if (o.live) o.fn(records); },
    takeMutations() { const out = document.pending; document.pending = []; return out; },
  };
}

module.exports = { createDom, parseSelector, El, Text };
