// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A stand-in page for the script src/webview-inject.js copies into Codex's webview folder, so that the real file can be
 * run and what it does to a page can be read back. Enough DOM for that script and no more: elements with attributes, a
 * class list, a style object, children and siblings, a tiny selector engine, events, the three measurements it takes
 * (getBoundingClientRect, scrollIntoView, scrollTo), and getComputedStyle answering what a test set on an element.
 *
 * The timers and the mutation observer are driven by the test instead of by the clock, since that is where this kind
 * of script goes wrong: the timers so a debounce can be stepped through, the observer so the records it is handed can
 * be chosen, including the records the script's own writes generate).
 *
 * For the session list's page (src/page/sessions-page.js) it also has classList.toggle, dataset, append,
 * replaceChildren, contentEditable, getElementById, and bubble(), which calls an element's listeners and then its
 * ancestors', the way a click reaches a listener on the page's root.
 *
 * The selector engine takes a comma-separated list of selectors, each a chain of `tag`, `*`, `.class`,
 * `[attr]`/`[attr="value"]` and `:not(...)` pieces joined by spaces for descendant, which is every selector that
 * script uses. The approval card's is Codex's own and uses all of it:
 * `[data-codex-approval-surface]:not([data-app-shell-active-page="false"] *)`.
 */

/* Split on `sep` at the top level only, so a separator inside [] or () stays where it is. */
function splitTop(text, sep) {
  const out = [];
  let depth = 0, at = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0 && (sep === ' ' ? /\s/.test(c) : c === sep)) { out.push(text.slice(at, i)); at = i + 1; }
  }
  out.push(text.slice(at));
  return out.filter((s) => s.trim() !== '');
}

/** One compound: everything about a single element, `:not()` included. */
function parseCompound(text) {
  const part = { tag: '', classes: [], attrs: [], nots: [] };
  let rest = String(text).trim();
  if (rest.startsWith('*')) rest = rest.slice(1);
  else {
    const tag = /^[a-zA-Z][\w-]*/.exec(rest);
    if (tag) { part.tag = tag[0].toUpperCase(); rest = rest.slice(tag[0].length); }
  }
  for (;;) {
    const cls = /^\.([\w-]+)/.exec(rest);
    if (cls) { part.classes.push(cls[1]); rest = rest.slice(cls[0].length); continue; }
    const attr = /^\[([\w-]+)(?:([*~^]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest);
    if (attr) {
      part.attrs.push({ name: attr[1], op: attr[2] || '', value: attr[3] !== undefined ? attr[3] : attr[4] !== undefined ? attr[4] : attr[5] });
      rest = rest.slice(attr[0].length);
      continue;
    }
    if (rest.startsWith(':not(')) {
      let depth = 0, end = -1;
      for (let i = 4; i < rest.length; i++) {
        if (rest[i] === '(') depth++;
        else if (rest[i] === ')' && --depth === 0) { end = i; break; }
      }
      if (end < 0) throw new Error(`fake-dom cannot read the selector ${JSON.stringify(text)}`);
      part.nots.push(parseSelector(rest.slice(5, end)));
      rest = rest.slice(end + 1);
      continue;
    }
    break;
  }
  if (rest) throw new Error(`fake-dom cannot read the selector ${JSON.stringify(text)}`);
  return part;
}

/** One selector as its chain of compounds, the element it selects last. */
const parseChain = (text) => splitTop(String(text).trim(), ' ').map(parseCompound);
const parseSelector = (text) => splitTop(String(text), ',').map(parseChain);

function matchesCompound(el, part) {
  if (part.tag && el.tagName !== part.tag) return false;
  for (const c of part.classes) if (!el.classList.contains(c)) return false;
  for (const a of part.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value === undefined) continue;
    const s = String(v);
    if (a.op === '*=' ? !s.includes(a.value) : a.op === '^=' ? !s.startsWith(a.value)
      : a.op === '~=' ? !s.split(/\s+/).includes(a.value) : s !== a.value) return false;
  }
  for (const nots of part.nots) if (nots.some((chain) => matchesChain(el, chain))) return false;
  return true;
}

/* The chain right to left: the last compound is this element, and each one before it has to be met by some ancestor,
   nearer ones first. Backtracking, since a nearer ancestor meeting one compound can leave the rest unmet. */
function matchesChain(el, chain) {
  const at = (node, i) => {
    if (i < 0) return true;
    if (!node || node.nodeType !== 1) return false;
    if (!matchesCompound(node, chain[i])) return false;
    if (i === 0) return true;
    for (let up = node.parentElement; up; up = up.parentElement) if (at(up, i - 1)) return true;
    return false;
  };
  return at(el, chain.length - 1);
}

const matchesAny = (el, chains) => chains.some((chain) => matchesChain(el, chain));

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
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.classList = {
      contains: (n) => el.className.split(/\s+/).includes(n),
      add(n) { if (!this.contains(n)) el.setAttribute('class', (el.className + ' ' + n).trim()); },
      remove(n) { el.setAttribute('class', el.className.split(/\s+/).filter((x) => x && x !== n).join(' ')); },
      toggle(n, force) {
        const on = force === undefined ? !this.contains(n) : !!force;
        if (on) this.add(n); else this.remove(n);
        return on;
      },
    };
    const name = (k) => `data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    this.dataset = new Proxy({}, {
      get: (_, k) => (typeof k === 'string' && el.hasAttribute(name(k)) ? el.getAttribute(name(k)) : undefined),
      set: (_, k, v) => { el.setAttribute(name(k), v); return true; },
    });
  }

  get contentEditable() { return this.editable || 'inherit'; }
  set contentEditable(v) { this.editable = String(v); this.isContentEditable = this.editable === 'true'; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new Text(n) : n); }
  replaceChildren(...nodes) { while (this.childNodes.length) this.removeChild(this.childNodes[0]); this.append(...nodes); }
  /* `event` handed to this element's listeners and then up through its ancestors, until one stops it. */
  bubble(type, event = {}) {
    let stopped = false;
    const e = Object.assign({ type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { stopped = true; } }, event);
    for (let n = this; n && !stopped; n = n.parentNode) {
      e.currentTarget = n;
      for (const fn of ((n.listeners || {})[type] || []).slice()) fn(e);
    }
    return e;
  }

  get className() { const v = this.getAttribute('class'); return v === null ? '' : String(v); }
  set className(v) { this.setAttribute('class', v); }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get nextSibling() { return this.parentNode ? this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null : null; }
  get previousSibling() { return this.parentNode ? this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) - 1] || null : null; }
  get nextElementSibling() { const k = this.parentNode ? this.parentNode.children : []; return k[k.indexOf(this) + 1] || null; }
  get previousElementSibling() { const k = this.parentNode ? this.parentNode.children : []; return k[k.indexOf(this) - 1] || null; }

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

  matches(sel) { return matchesAny(this, parseSelector(sel)); }
  closest(sel) {
    const chains = parseSelector(sel);
    for (let n = this; n && n.nodeType === 1; n = n.parentElement) if (matchesAny(n, chains)) return n;
    return null;
  }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }

  querySelectorAll(sel) {
    const chains = parseSelector(sel), out = [];
    const walk = (el) => {
      for (const k of el.children) { if (matchesAny(k, chains)) out.push(k); walk(k); }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  getBoundingClientRect() { return this.rect; }
  scrollIntoView() { this.scrolledIntoView++; }
  scrollTo(opts) { this.scrolledTo.push(opts); this.scrollTop = (opts && opts.top) || 0; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  /* An event the page script dispatched itself, handed to this element's listeners and to the document's. */
  dispatchEvent(event) {
    (this.dispatched = this.dispatched || []).push(event);
    for (const fn of (this.listeners[event.type] || []).slice()) fn(Object.assign(event, { target: this }));
    return true;
  }
  focus() { this.focused = true; }
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
    getElementById(id) { return document.root ? document.root.querySelector(`[id="${id}"]`) : null; },
    createRange: () => ({ selectNodeContents() {} }),
    /* Every change of children, for the observers to be handed when the test says so. */
    pending: [],
    mutate(target) { document.pending.push({ type: 'childList', target }); },
  };
  const el = (tag, opts = {}) => {
    const e = new El(tag, document);
    for (const [name, value] of Object.entries(opts.attrs || {})) e.setAttribute(name, value);
    if (opts.class) e.setAttribute('class', opts.class);
    if (opts.rect) e.rect = Object.assign({ top: 0, left: 0, width: 0, height: 0 }, opts.rect);
    if (opts.computed) e.computed = Object.assign({}, opts.computed);
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
    KeyboardEvent: class KeyboardEvent { constructor(type, init = {}) { Object.assign(this, init, { type }); } },
    /* What a test said an element computes to (opts.computed), over its inline style, over a block box. */
    getComputedStyle: (node) => Object.assign({ display: 'block', flexDirection: 'row' }, (node && node.style) || {}, (node && node.computed) || {}),
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
