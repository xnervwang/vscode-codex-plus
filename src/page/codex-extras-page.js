// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Runs in Codex's page (its sidebar and every conversation tab), added by src/webview-inject.js as a module script
 * ahead of Codex's own, so it runs first.
 *
 *   - The page's time zone goes to the extension host, since this is the one part that runs where the reader is.
 *   - A chime plays when the host says a turn finished, or a plan question appeared, for the conversation shown here.
 *   - The strip shows the figures the host sends for this conversation: the last turn's duration, how much of the
 *     context window is in use, model and effort, and while a turn runs, the tool call in progress and for how long.
 *   - On request, a sample of the conversation layout: its shape and nothing it says.
 *   - A time on every message and reply block, a list of your own messages on the right edge, and your own messages
 *     marked out. These three reach inside Codex's own tree; the rest is a strip of this script's own beside it.
 *
 * Messages to the host are of type "codex-extras", which the patched host hands to this extension; messages from it
 * are of types starting "codex-extras-", which Codex's page ignores.
 */
(function () {
  'use strict';
  var orig = globalThis.acquireVsCodeApi;
  if (typeof orig !== 'function') return;
  /* The editor gives a page one handle and throws on a second request; Codex asks for one as it starts. Both go
     through this, so whichever asks first creates it and the other gets the same one. */
  var api = null;
  globalThis.acquireVsCodeApi = function () { if (!api) api = orig(); return api; };
  var post = function (m) { try { globalThis.acquireVsCodeApi().postMessage(Object.assign({ type: 'codex-extras' }, m)); } catch (e) { /* lost */ } };

  try { post({ kind: 'tz', timeZone: String(Intl.DateTimeFormat().resolvedOptions().timeZone || '') }); } catch (e) { /* none */ }

  var MARK = 'data-codex-extras';

  var audio = null;
  function chime(kind) {
    try {
      audio = audio || new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      var notes = kind === 'question' ? [660, 880] : [880, 660];
      notes.forEach(function (f, i) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.12 + 0.11);
        o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + i * 0.12); o.stop(audio.currentTime + i * 0.12 + 0.12);
      });
    } catch (e) { /* no audio here */ }
  }

  var strip = null, figures = null, timer = null;
  function draw() {
    if (!figures || !figures.text) { if (strip) strip.style.display = 'none'; return; }
    if (!strip) {
      strip = document.createElement('div');
      strip.setAttribute(MARK, 'figures');
      strip.style.cssText = 'position:fixed;right:8px;bottom:2px;z-index:2147483000;pointer-events:none;'
        + 'font:11px var(--vscode-font-family,sans-serif);color:var(--vscode-descriptionForeground,#888);'
        + 'background:var(--vscode-editor-background,transparent);opacity:.85;padding:0 4px;border-radius:3px;';
      document.body.appendChild(strip);
    }
    var text = figures.text;
    if (figures.tool && figures.toolSince) {
      var s = Math.max(0, Math.round((Date.now() - figures.toolSince) / 1000));
      text = figures.tool + ' running for ' + (s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's') + ' · ' + text;
    }
    strip.textContent = text;
    strip.style.display = '';
  }

  /*
   * A sample of the conversation layout, taken only when the host asks for one and leaving behind neither a timer nor an
   * observer. Codex's own class names are not known to this script, so nothing here is selected by name: one pass over
   * the page finds the element the reader actually scrolls, and the sample is the tree under it.
   *
   * It carries shape, never content. Each element gives its tag, its class names, the NAMES of its attributes, its depth,
   * how many children it has and its rounded size; each text node gives its length and the shape of its first few
   * characters (d for a digit, a for a letter, o for anything else), which is enough to tell a timestamp from a sentence
   * while carrying neither. No attribute value is read, except an id with anything thread-id-shaped masked out, and the
   * page's query string is left out altogether since Codex puts route state there and route state can hold what the
   * reader typed. Siblings one piece of code drew look alike here, so each such group keeps three samples and a count,
   * or a long conversation would answer with tens of thousands of nodes.
   */
  var MAX_NODES = 1600, MAX_DEPTH = 24, MAX_TWINS = 3, HEAD = 8, SURVEY_MAX = 6000;
  var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  /* A route segment this long is not a route segment; whatever it is, it is not going into the sample. */
  var LONG = /[^/#?&=]{41,}/g;
  function noIds(s) { return String(s == null ? '' : s).replace(UUID, '<id>').replace(LONG, '<long>'); }
  function shapeOf(t) {
    var out = '';
    for (var i = 0; i < t.length && i < HEAD; i++) out += /[0-9]/.test(t.charAt(i)) ? 'd' : /\p{L}/u.test(t.charAt(i)) ? 'a' : 'o';
    return out;
  }
  var nodes = function (el, kind) { return [].filter.call(el.childNodes || [], function (n) { return n.nodeType === kind; }); };
  var tagOf = function (el) { return String(el.tagName || '').toLowerCase(); };
  /* An SVG element keeps its class list in baseVal rather than in a string. */
  var classesOf = function (el) {
    var cn = el.className;
    return String((cn && typeof cn === 'object' ? cn.baseVal : cn) || '').trim().split(/\s+/).filter(Boolean);
  };
  var attrsOf = function (el) {
    return [].map.call(el.attributes || [], function (a) { return String(a.name); })
      .filter(function (n) { return n !== 'class' && n !== 'style'; }).sort();
  };
  var kidsOf = function (el) { return nodes(el, 1); };
  var textsOf = function (el) {
    return nodes(el, 3).map(function (n) { return String(n.nodeValue || '').trim(); }).filter(Boolean)
      .map(function (t) { return { len: t.length, head: shapeOf(t) }; });
  };
  var sizeOf = function (el) {
    try { var r = el.getBoundingClientRect(); return [Math.round(r.width || 0), Math.round(r.height || 0)]; }
    catch (err) { return [0, 0]; }
  };
  var scrollOf = function (el) {
    return { top: Math.round(el.scrollTop || 0), height: Math.round(el.scrollHeight || 0), client: Math.round(el.clientHeight || 0) };
  };
  /* What one piece of code draws the same way every time, and so what makes two siblings one group. */
  var signOf = function (el) { return tagOf(el) + '.' + classesOf(el).join('.') + '[' + attrsOf(el).join(',') + ']'; };
  var nameOf = function (n) { return n.tag + (n.classes && n.classes.length ? '.' + n.classes.join('.') : ''); };

  function walk(el, depth, budget) {
    var size = sizeOf(el), kids = kidsOf(el);
    var node = { tag: tagOf(el), classes: classesOf(el), attrs: attrsOf(el), depth: depth, children: kids.length, w: size[0], h: size[1] };
    var id = el.getAttribute ? noIds(el.getAttribute('id')) : '';
    if (id) node.id = id.slice(0, 64);
    var texts = textsOf(el);
    if (texts.length) node.text = texts;
    if (!kids.length || depth >= MAX_DEPTH) return node;
    var groups = [], index = Object.create(null);
    for (var i = 0; i < kids.length; i++) {
      var sign = signOf(kids[i]), g = index[sign];
      if (!g) { g = index[sign] = { n: 0, picks: [] }; groups.push(g); }
      g.n++;
      if (g.picks.length < MAX_TWINS) g.picks.push(kids[i]);
    }
    node.kids = [];
    var missed = { groups: 0, elements: 0 };
    for (var k = 0; k < groups.length; k++) {
      var group = groups[k], taken = 0;
      for (var p = 0; p < group.picks.length && budget.left > 0; p++) {
        budget.left--;
        var child = walk(group.picks[p], depth + 1, budget);
        if (!taken) child.twins = group.n; /* the whole group's size, samples included, on the first of them */
        node.kids.push(child);
        taken++;
      }
      if (!taken) { missed.groups++; missed.elements += group.n; }
    }
    /* What the budget ran out before reaching, counted here rather than as hundreds of empty children. */
    if (missed.groups) node.unsampled = missed;
    return node;
  }

  /* How many data-* attribute names one sample carries. Codex 26.1021 uses ninety of them, and a list cut short is worse
     than a long one here: the list is what a later selector is checked against, and a name missing because it fell off
     the end of an alphabetical list reads exactly like a name Codex has dropped. */
  var DATA_ATTRS_MAX = 160;

  /* One pass over the page: how big it is, which elements actually scroll, and which data-* attribute names are in use. */
  function survey(root) {
    var info = { elements: 0, scrollers: 0, dataAttrs: [], dataAttrsTotal: 0, truncated: false };
    var names = Object.create(null), stack = [root], best = null, bestArea = -1;
    while (stack.length) {
      if (info.elements >= SURVEY_MAX) { info.truncated = true; break; }
      var el = stack.pop();
      info.elements++;
      var a = el.attributes || [];
      for (var i = 0; i < a.length; i++) if (String(a[i].name).indexOf('data-') === 0) names[a[i].name] = 1;
      if ((el.scrollHeight || 0) - (el.clientHeight || 0) > 40) {
        info.scrollers++;
        var area = (el.clientWidth || 0) * (el.clientHeight || 0);
        if (area > bestArea) { bestArea = area; best = el; }
      }
      var kids = kidsOf(el);
      for (var j = 0; j < kids.length; j++) stack.push(kids[j]);
    }
    var found = Object.keys(names).sort();
    /* The count as well as the list: the list is capped, and a reader of the file cannot otherwise tell a page that uses
       this many attributes from a page whose extra ones were cut off the end of an alphabetical list. */
    info.dataAttrsTotal = found.length;
    info.dataAttrs = found.slice(0, DATA_ATTRS_MAX);
    return { info: info, scroller: best };
  }

  /* The chain from <body> down to the sampled root, so a selector can be written for it. */
  function pathTo(el) {
    var out = [];
    for (var n = el; n && n !== document.body && out.length <= MAX_DEPTH; n = n.parentElement) {
      out.unshift(nameOf({ tag: tagOf(n), classes: classesOf(n) }));
    }
    return out;
  }

  /* A guess at the message list: the biggest group of look-alike siblings tall enough for a message to be in it. */
  function messageBlocks(node, out) {
    out = out || { count: 0, at: '', depth: 0 };
    if (node.twins > out.count && (node.h || 0) > 16) out = { count: node.twins, at: nameOf(node), depth: node.depth };
    (node.kids || []).forEach(function (k) { out = messageBlocks(k, out); });
    return out;
  }

  function sample() {
    if (!document.body) return { error: 'the page has no body yet' };
    var s = survey(document.body);
    var root = s.scroller || document.body;
    var budget = { left: MAX_NODES - 1 };
    var tree = walk(root, 0, budget);
    var loc = globalThis.location || {};
    return {
      limits: { nodes: MAX_NODES, depth: MAX_DEPTH, twins: MAX_TWINS, head: HEAD, survey: SURVEY_MAX, dataAttrs: DATA_ATTRS_MAX },
      page: { body: classesOf(document.body), route: noIds(String(loc.pathname || '') + String(loc.hash || '')).slice(0, 200),
        elements: s.info.elements, scrollers: s.info.scrollers, dataAttrs: s.info.dataAttrs,
        dataAttrsTotal: s.info.dataAttrsTotal, truncated: s.info.truncated },
      root: { fromScroller: !!s.scroller, path: pathTo(root), scroll: scrollOf(root) },
      messageBlocks: messageBlocks(tree),
      sampled: MAX_NODES - budget.left,
      tree: tree,
    };
  }

  /*
   * ── A time on each message, a list of your own messages, and a mark on them ──
   *
   * This is the only part of the script that reaches inside Codex's own tree, and it reaches in to add: a line of its
   * own above a message, and class names of its own on the element one of its own rules then styles. Codex's nodes are
   * read, never moved or removed and never given an inline style of this script's; everything this script adds carries
   * data-codex-extras, so one query finds all of it again when a setting goes off.
   *
   * Codex's elements are found by the data-* attributes it puts on them and never by class name, since its class names
   * are a build's output. Every attribute named in ATTR is checked by test/parts/60-page-features.js against a real
   * sample of a Codex conversation, so a Codex release that drops one turns a check red instead of quietly showing
   * nothing.
   *
   * Nothing read here leaves the page. A message's opening words are read in the page, shown in the page, and that is
   * the end of them. The one thing this part posts to the host is the shape of a sent time it could not parse: its
   * length, the class of its first character and whether it is all digits, which is what writing the next parser needs
   * and carries nothing of the value.
   */
  var ATTR = {
    scroller: 'data-app-action-timeline-scroll',
    turn: 'data-turn-key',
    turnBody: 'data-content-search-turn-key',
    user: 'data-local-conversation-user-anchor',
    assistantSide: 'data-local-conversation-final-assistant',
    assistant: 'data-response-annotation-target',
    role: 'data-conversation-role',
    sent: 'data-assistant-message-sent-time',
    bubble: 'data-user-message-bubble',
  };
  var SEL = { day: 'time[datetime]' };
  Object.keys(ATTR).forEach(function (k) { SEL[k] = '[' + ATTR[k] + ']'; });

  /* What the host last said to show. The defaults are the settings' own defaults, so a page the host has not spoken to
     yet shows what those settings say rather than nothing at all. */
  var view = { timestamps: true, navigation: true, userColor: '', userEdge: true };
  /* One time per user message of this conversation, in the order the rollout has them, as the host read them there.
     Used only when there are exactly as many as the page shows - see stampAll. */
  var hostWhen = null;

  var INK_CLASS = 'codex-extras-user-ink', EDGE_CLASS = 'codex-extras-user-edge';
  var DEBOUNCE_MS = 200, STEP_HOLD_MS = 600;
  var RAIL_W = 26, PANEL_W = 300;
  /* Below the figures strip's layer, so the strip is never covered by the list. */
  var Z_PANEL = 2147482900, Z_RAIL = 2147482800;

  var all = function (root, sel) { try { return [].slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } };
  var one = function (root, sel) { try { return (root || document).querySelector(sel); } catch (e) { return null; } };
  var scrollerEl = function () { return one(document, SEL.scroller); };
  var words = function (el) { return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim(); };
  var isOurs = function (el) { return !!(el && el.getAttribute && el.getAttribute(MARK) != null); };
  var anythingOn = function () { return !!(view.timestamps || view.navigation || view.userColor || view.userEdge !== false); };

  /* Anything outside these two years is not a time somebody wrote, whatever the number happened to parse as. */
  var EPOCH_LO = Date.UTC(2001, 0, 1), EPOCH_HI = Date.UTC(2100, 0, 1);
  /* A clock Codex has already rendered: 24-hour, or 12-hour with am or pm, with seconds optional in both. */
  var CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([AaPp])\.?[Mm]\.?)?$/;

  /* The local midnight of a day the page states, from a date-only value or from a full instant. */
  function dayMsOf(value) {
    var s = String(value == null ? '' : value).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    /* A date-only value parses as UTC midnight, which west of Greenwich is the day before: built locally instead. */
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    var t = Date.parse(s);
    return isFinite(t) ? t : null;
  }

  /* A clock with no date needs one; `dayMs` is the day the page put the message under, or today when it said none. */
  function parseClock(value, dayMs) {
    var m = CLOCK.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    var h = +m[1], mi = +m[2], se = m[3] === undefined ? 0 : +m[3], half = m[4];
    if (mi > 59 || se > 59) return null;
    if (half) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (/[Pp]/.test(half) ? 12 : 0);
    } else if (h > 23) return null;
    var d = new Date(typeof dayMs === 'number' && isFinite(dayMs) ? dayMs : Date.now());
    d.setHours(h, mi, se, 0);
    return { ms: d.getTime(), secs: m[3] !== undefined };
  }

  /* The three forms a sent time could be in: an epoch count, a clock already rendered, or a date string. */
  function parseWhen(value, dayMs) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return null;
    if (/^-?\d+(?:\.\d+)?$/.test(v)) {
      var n = parseFloat(v);
      /* Ten digits is a count of seconds, thirteen a count of milliseconds; the line between them is far from both. */
      var ms = Math.abs(n) < 1e11 ? n * 1000 : n;
      return (ms >= EPOCH_LO && ms <= EPOCH_HI) ? { ms: ms, secs: true } : null;
    }
    var clock = parseClock(v, dayMs);
    if (clock) return clock;
    var t = Date.parse(v);
    if (isFinite(t) && t >= EPOCH_LO && t <= EPOCH_HI) return { ms: t, secs: /\d:\d\d:\d\d/.test(v) };
    return null;
  }

  var sameMinute = function (a, b) { return Math.floor(a / 60000) === Math.floor(b / 60000); };
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  /* HH:MM:SS, in the reader's own zone. HH:MM when the source carried no seconds: a zero there would be a time nobody
     wrote, and the stamp is read as a fact about the message. */
  function clockOf(when) {
    if (!when) return '';
    var d = new Date(when.ms);
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + (when.secs ? ':' + p2(d.getSeconds()) : '');
  }

  /* A sent time in none of those forms. Told once per form, and as a form rather than a value. */
  var toldShapes = Object.create(null);
  function tellShape(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return;
    var first = /[0-9]/.test(v.charAt(0)) ? 'digit' : /\p{L}/u.test(v.charAt(0)) ? 'letter' : 'other';
    var digits = /^[0-9]+$/.test(v);
    var key = v.length + '|' + first + '|' + digits;
    if (toldShapes[key]) return;
    toldShapes[key] = 1;
    post({ kind: 'stampShape', len: v.length, first: first, digits: digits });
  }

  /* The day the turn sits under, from the date divider Codex draws above the first turn of a day. A <time> inside the
     conversation itself is not that divider, so the part of the turn that holds the conversation is left out. */
  function dayOfTurn(turn) {
    var body = one(turn, SEL.turnBody);
    var times = all(turn, SEL.day);
    for (var i = 0; i < times.length; i++) {
      if (body && body.contains && body.contains(times[i])) continue;
      var ms = dayMsOf(times[i].getAttribute('datetime'));
      if (ms !== null) return ms;
    }
    return null;
  }

  /* Codex's own sent time for a reply: the attribute's value, or else what it has already rendered in that element. */
  function assistantWhen(block, dayMs) {
    var el = one(block, SEL.sent);
    if (!el) return null;
    var raw = el.getAttribute(ATTR.sent) || '';
    var parsed = parseWhen(raw, dayMs);
    if (parsed) return parsed;
    var shown = words(el);
    var fromText = parseClock(shown, dayMs);
    if (fromText) return fromText;
    tellShape(raw || shown);
    return null;
  }

  /*
   * Codex's own time on one of your own messages. Unlike a reply's it carries no attribute of its own: it is a bare span
   * in the row of buttons beside the message, which no stable name reaches. So it is found by reading instead - the one
   * text in the message that reads as a clock and is not the message's own words - and only a clock counts, not an
   * epoch count or a date string, because what is being looked for is something Codex has already rendered for a reader.
   * Two candidates means it cannot be told which is the time, and then there is none.
   */
  function userWhenInPage(anchor, dayMs) {
    var body = one(anchor, SEL.bubble);
    var found = null, stack = [anchor];
    while (stack.length) {
      var el = stack.pop();
      if (el !== anchor && (isOurs(el) || (body && el === body))) continue;
      var kids = el.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i];
        if (n.nodeType === 1) { stack.push(n); continue; }
        if (n.nodeType !== 3) continue;
        var t = String(n.nodeValue || '').trim();
        if (!t || t.length > 12) continue;
        var when = parseClock(t, dayMs);
        if (!when) continue;
        if (found) return null;
        found = when;
      }
    }
    return found;
  }

  /*
   * The words of a message, with anything this script added left out: a stamp at the top of the same element would
   * otherwise read as the message's first words.
   *
   * Reading them walks the message's whole subtree, which is costly for a long paste and gives the same answer every
   * time once the message has been sent - so the answer is kept, weakly, and nothing is held once Codex has taken that
   * element away. `live` is for the newest message, which can still be arriving.
   */
  var wordCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
  function bodyWords(el, live) {
    if (!live && wordCache) {
      var hit = wordCache.get(el);
      if (typeof hit === 'string') return hit;
    }
    var out;
    var inner = one(el, SEL.bubble);
    if (inner) {
      out = words(inner);
    } else {
      out = '';
      var kids = (el && el.children) || [];
      for (var i = 0; i < kids.length; i++) if (!isOurs(kids[i])) out += ' ' + words(kids[i]);
      out = out.replace(/\s+/g, ' ').trim();
    }
    if (!live && wordCache) wordCache.set(el, out);
    return out;
  }

  /* Which side a block is, as Codex itself labels it for a screen reader. Read rather than taken from where the block
     sits, so a block Codex marks as the reader's own is stamped and listed as theirs; any other wording leaves the
     block where it sits. */
  function roleOf(el) {
    var h = one(el, SEL.role);
    var v = h && h.getAttribute(ATTR.role);
    return v ? String(v).toLowerCase() : '';
  }

  /* Every user message and reply block of the conversation, in document order, each with the day it sits under. */
  function entries() {
    var sc = scrollerEl();
    if (!sc) return null;
    var turns = all(sc, SEL.turn), out = [], day = null;
    for (var i = 0; i < turns.length; i++) {
      var turn = turns[i], d = dayOfTurn(turn);
      if (d !== null) day = d;
      var users = all(turn, SEL.user);
      for (var u = 0; u < users.length; u++) out.push({ kind: 'user', node: users[u], day: day });
      var sides = all(turn, SEL.assistantSide);
      for (var s = 0; s < sides.length; s++) {
        var blocks = all(sides[s], SEL.assistant);
        for (var b = 0; b < blocks.length; b++) {
          out.push({ kind: roleOf(blocks[b]) === 'user' ? 'user' : 'assistant', node: blocks[b], day: day });
        }
      }
    }
    return out;
  }

  /* This script's own line at the top of Codex's element, put there once and only retitled afterwards. */
  function stampOn(host, side, text) {
    var el = null, kids = host.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute(MARK) === 'stamp') { el = kids[i]; break; }
    }
    if (!text) {
      if (el) { try { host.removeChild(el); } catch (e) { /* already gone */ } }
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.setAttribute(MARK, 'stamp');
      el.setAttribute('class', 'codex-extras-stamp codex-extras-stamp-' + side);
      /* Codex reads a reply's own sent time out to a screen reader already; a second one would be read twice. */
      el.setAttribute('aria-hidden', 'true');
      if (host.firstChild) host.insertBefore(el, host.firstChild); else host.appendChild(el);
    }
    if (el.textContent !== text) el.textContent = text;
  }

  /* The time on every message, and the words for the list. Returns the user messages in document order. */
  function stampAll(list) {
    var users = [];
    for (var i = 0; i < list.length; i++) if (list[i].kind === 'user') { list[i].at = users.length; users.push(list[i]); }
    /*
     * The host's times line up with the page only when it read exactly as many user messages from the rollout as the
     * page shows. A rollout can hold messages inherited from a conversation this one was forked from, and a page can
     * hold a message the rollout does not have yet, so the two counts really do differ; lining them up by position when
     * they do would put a time against the wrong message, which is worse than showing none.
     */
    var lined = hostWhen && hostWhen.length === users.length ? hostWhen : null;
    for (var j = 0; j < list.length; j++) {
      var e = list[j], text = '';
      if (view.timestamps) {
        var when = e.kind === 'assistant' ? assistantWhen(e.node, e.day) : userWhenInPage(e.node, e.day);
        if (e.kind === 'user' && lined) {
          /*
           * The rollout's time carries seconds and the clock Codex rendered does not, so the rollout's is the better
           * of the two - but only where they agree to the minute, which is this one message saying for itself that the
           * two lists do line up. Where they disagree, or where there is no clock to compare against, what Codex
           * rendered stands; a page and a rollout that happen to hold the same number of messages without holding the
           * same messages is exactly the case the count alone cannot see.
           */
          var host = { ms: lined[e.at], secs: true };
          if (!when || sameMinute(when.ms, host.ms)) when = host;
        }
        text = clockOf(when);
        if (e.kind === 'user') e.when = text;
      }
      stampOn(e.node, e.kind, text);
    }
    return users;
  }

  var flag = function (el, name, on) {
    if (!el || !el.classList) return;
    try { if (on) el.classList.add(name); else el.classList.remove(name); } catch (e) { /* not an element */ }
  };
  /*
   * Your own messages marked out. Only class names go on Codex's elements; what those class names mean is in this
   * script's own stylesheet, so a setting going off takes the rule with it and leaves Codex's own styling as it was.
   * The bar goes on the bubble when Codex still draws one, since the message's own element spans the whole thread and a
   * bar down its edge would sit far from the words.
   */
  function colourAll(users) {
    for (var i = 0; i < users.length; i++) {
      var anchor = users[i].node;
      flag(anchor, INK_CLASS, !!view.userColor);
      flag(one(anchor, SEL.bubble) || anchor, EDGE_CLASS, view.userEdge !== false);
    }
  }

  /* A CSS colour the reader typed, or '' for anything else: nothing but a colour may reach the stylesheet. */
  var SAFE_COLOR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/deg]+\))$/;

  var sheet = null, sheetText = '';
  function dropSheet() {
    if (sheet) { try { sheet.remove(); } catch (e) { /* gone */ } }
    sheet = null; sheetText = '';
  }
  /* One stylesheet of this script's own for everything it shows. */
  function restyle() {
    var css = '.codex-extras-stamp{font:11px var(--vscode-font-family,sans-serif);'
      + 'color:var(--vscode-descriptionForeground,#8b949e);opacity:.85;line-height:1.4;'
      + 'user-select:none;pointer-events:none;}'
      + '.codex-extras-stamp-user{text-align:end;}';
    if (view.userColor && SAFE_COLOR.test(view.userColor)) {
      css += '.' + INK_CLASS + ',.' + INK_CLASS + ' *{color:' + view.userColor + ' !important;}';
    }
    if (view.userEdge !== false) {
      css += '.' + EDGE_CLASS + '{border-inline-start:3px solid '
        + 'var(--vscode-focusBorder,var(--vscode-textLink-foreground,#4493f8)) !important;'
        + 'padding-inline-start:8px !important;}';
    }
    css += NAV_CSS;
    if (!sheet || !sheet.isConnected) {
      sheet = document.createElement('style');
      sheet.setAttribute(MARK, 'style');
      (document.head || document.documentElement || document.body).appendChild(sheet);
      sheetText = '';
    }
    if (css !== sheetText) { sheet.textContent = css; sheetText = css; }
  }

  var NAV_CSS = '.codex-extras-rail{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:' + Z_RAIL + ';'
    + 'display:flex;flex-direction:column;align-items:flex-end;}'
    + '.codex-extras-rail-btn{width:' + RAIL_W + 'px;height:24px;display:flex;align-items:center;justify-content:center;'
    + 'cursor:pointer;user-select:none;font-size:13px;border-radius:3px 0 0 3px;'
    + 'background:var(--vscode-editorWidget-background,rgba(40,40,40,.92));'
    + 'border:1px solid var(--vscode-widget-border,rgba(255,255,255,.14));border-right:none;'
    + 'color:var(--vscode-textLink-activeForeground,var(--vscode-focusBorder,#4493f8));}'
    + '.codex-extras-rail-handle{height:56px;font-size:18px;border-radius:4px 0 0 4px;}'
    + '.codex-extras-rail-btn:hover{background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12));}'
    /* Codex's sidebar loads this script too, and there the window is a few hundred pixels wide: the list is as wide as
       it fits rather than as wide as it would like, or in the sidebar it would reach past both edges. */
    + '.codex-extras-panel{position:fixed;right:' + (RAIL_W + 2) + 'px;top:8px;'
    + 'width:min(' + PANEL_W + 'px,calc(100vw - ' + (RAIL_W + 14) + 'px));'
    + 'max-height:calc(100vh - 16px);overflow-y:auto;z-index:' + Z_PANEL + ';display:none;'
    + 'padding:5px 0;border-radius:5px;box-sizing:border-box;font:11px var(--vscode-font-family,sans-serif);'
    + 'line-height:1.45;background:var(--vscode-editorWidget-background,rgba(35,35,35,.98));'
    + 'border:1px solid var(--vscode-widget-border,rgba(255,255,255,.14));box-shadow:0 4px 14px rgba(0,0,0,.45);}'
    + '.codex-extras-panel-head{position:sticky;top:0;z-index:1;padding:3px 8px 6px 8px;'
    + 'background:var(--vscode-editorWidget-background,rgba(35,35,35,.98));}'
    + '.codex-extras-filter{width:100%;margin:0;padding:3px 6px;box-sizing:border-box;font-size:11px;border-radius:3px;'
    + 'outline:none;background:var(--vscode-input-background,rgba(0,0,0,.3));'
    + 'color:var(--vscode-input-foreground,#ddd);border:1px solid var(--vscode-input-border,rgba(255,255,255,.16));}'
    + '.codex-extras-row{padding:4px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    + 'color:var(--vscode-foreground,#ccc);}'
    + '.codex-extras-row:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.08));}'
    + '.codex-extras-row-when{opacity:.7;margin-inline-end:6px;}';

  /* ── the list of your own messages, and stepping between them ── */
  var nav = null, railBox = null, panel = null, rowsBox = null, filter = null, chevron = null;
  var rows = [], navNodes = [], sigNodes = [], sigTexts = [];
  var stepIdx = -1, stepAt = 0, keysWired = false, outsideWired = false;

  var SHUT = String.fromCharCode(8249), OPEN = String.fromCharCode(8250);
  var panelOpen = function () { return !!(panel && panel.style.display === 'block'); };
  /* Open or shut is said by which way the chevron points, and by nothing else: dimming it as well only made it hard
     to see which state it was in. */
  var mirror = function () { if (chevron) chevron.textContent = panelOpen() ? OPEN : SHUT; };
  var openList = function () {
    if (!panel) return;
    panel.style.display = 'block';
    /* The newest message is the one most often wanted. */
    try { panel.scrollTop = panel.scrollHeight; } catch (e) { /* no box */ }
    mirror();
  };
  var closeList = function () { if (panel) panel.style.display = 'none'; mirror(); };

  /*
   * scrollIntoView rather than an arithmetic scrollTop: the container is Codex's own and carries its own scroll padding
   * for its sticky header, which scrollIntoView honours and a computed position does not.
   */
  function landOn(node) {
    if (!node) return;
    try { node.scrollIntoView({ block: 'start', behavior: 'auto' }); return; } catch (e) { /* older signature */ }
    try { node.scrollIntoView(true); } catch (e) { /* gone */ }
  }

  /* Which message the view is on now: the one whose top is nearest the top of the container. */
  function nearestIdx() {
    var sc = scrollerEl(), top = 0, best = 0, bestD = Infinity;
    try { if (sc) top = sc.getBoundingClientRect().top; } catch (e) { top = 0; }
    for (var i = 0; i < navNodes.length; i++) {
      var d = Infinity;
      try { d = Math.abs(navNodes[i].getBoundingClientRect().top - top); } catch (e) { /* no box */ }
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* One message up or down. A press while the last jump is still settling counts from that jump's target, so holding a
     key walks the list instead of returning to the message the view has not finished leaving. */
  function step(dir) {
    if (!navNodes.length) return;
    var from = (stepIdx >= 0 && stepIdx < navNodes.length && Date.now() - stepAt < STEP_HOLD_MS) ? stepIdx : nearestIdx();
    var to = Math.max(0, Math.min(navNodes.length - 1, from + dir));
    stepIdx = to; stepAt = Date.now();
    landOn(navNodes[to]);
  }

  /* To the very top or the very bottom. The end is measured at the moment of the jump, since a reply still arriving
     makes the conversation longer while the view is on its way there. */
  function toEdge(toEnd) {
    var sc = scrollerEl();
    stepIdx = -1; stepAt = 0;
    if (!sc) return;
    var top = toEnd ? (sc.scrollHeight || 0) : 0;
    try { sc.scrollTo({ top: top, behavior: 'auto' }); return; } catch (e) { /* older signature */ }
    try { sc.scrollTop = top; } catch (e) { /* gone */ }
  }

  function railButton(label, cls, onClick) {
    var b = document.createElement('div');
    b.setAttribute('class', 'codex-extras-rail-btn' + (cls ? ' ' + cls : ''));
    b.setAttribute('title', label);
    b.setAttribute(MARK, 'nav-button');
    b.addEventListener('click', function (ev) { try { ev.stopPropagation(); } catch (e) { /* none */ } onClick(); });
    return b;
  }

  /*
   * A triangle against a bar, pointing at the edge it goes to - the sign media controls use for first and last. Drawn
   * rather than taken from a font: a glyph the page's font does not carry draws an empty box with nothing to say why.
   */
  function edgeIcon(toEnd) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    var bar = document.createElementNS(NS, 'path');
    bar.setAttribute('d', toEnd ? 'M1.5 8.5h7' : 'M1.5 1.5h7');
    bar.setAttribute('stroke', 'currentColor');
    bar.setAttribute('stroke-width', '1.4');
    bar.setAttribute('stroke-linecap', 'round');
    bar.setAttribute('fill', 'none');
    var tri = document.createElementNS(NS, 'path');
    tri.setAttribute('d', toEnd ? 'M2 2.5h6L5 6.5z' : 'M2 7.5h6L5 3.5z');
    tri.setAttribute('fill', 'currentColor');
    svg.appendChild(bar);
    svg.appendChild(tri);
    return svg;
  }

  function applyFilter() {
    var q = String((filter && filter.value) || '').toLowerCase().trim();
    for (var i = 0; i < rows.length; i++) {
      rows[i].row.style.display = (!q || rows[i].hay.indexOf(q) !== -1) ? 'block' : 'none';
    }
  }

  /*
   * ',' and '.' step between your own messages, but only when the caret is not somewhere text goes. The guard is
   * deliberately broad: skipping a keystroke is harmless, swallowing one meant for Codex's composer is not.
   */
  function wireKeys() {
    if (keysWired) return;
    keysWired = true;
    document.addEventListener('keydown', function (ev) {
      if (!view.navigation || !navNodes.length) return;
      if (ev.key !== ',' && ev.key !== '.') return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
      var a = document.activeElement;
      if (a) {
        var tag = String(a.tagName || '');
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (a.isContentEditable) return;
        if (typeof a.closest === 'function'
          && a.closest('[contenteditable="true"],[contenteditable=""],input,textarea,[data-codex-composer]')) return;
      }
      try { ev.preventDefault(); } catch (e) { /* none */ }
      step(ev.key === ',' ? -1 : 1);
    });
  }

  function dropNav() {
    if (nav) { try { nav.remove(); } catch (e) { /* gone */ } }
    nav = railBox = panel = rowsBox = filter = chevron = null;
    rows = []; navNodes = []; sigNodes = []; sigTexts = [];
    stepIdx = -1; stepAt = 0;
  }

  function ensureNav() {
    if (nav && nav.isConnected) return;
    nav = document.createElement('div');
    nav.setAttribute(MARK, 'nav');

    railBox = document.createElement('div');
    railBox.setAttribute('class', 'codex-extras-rail');
    var top = railButton('Top of the conversation', '', function () { toEdge(false); });
    top.appendChild(edgeIcon(false));
    railBox.appendChild(top);
    var up = railButton('Previous message', '', function () { step(-1); });
    up.textContent = String.fromCharCode(9652);
    railBox.appendChild(up);
    chevron = railButton('Your messages in this conversation - click one to jump to it', 'codex-extras-rail-handle',
      function () { if (panelOpen()) closeList(); else openList(); });
    chevron.textContent = SHUT;
    railBox.appendChild(chevron);
    var down = railButton('Next message', '', function () { step(1); });
    down.textContent = String.fromCharCode(9662);
    railBox.appendChild(down);
    var bottom = railButton('Bottom of the conversation', '', function () { toEdge(true); });
    bottom.appendChild(edgeIcon(true));
    railBox.appendChild(bottom);
    nav.appendChild(railBox);

    panel = document.createElement('div');
    panel.setAttribute('class', 'codex-extras-panel');
    panel.setAttribute(MARK, 'nav-list');
    var head = document.createElement('div');
    head.setAttribute('class', 'codex-extras-panel-head');
    filter = document.createElement('input');
    filter.setAttribute('type', 'text');
    filter.setAttribute('class', 'codex-extras-filter');
    filter.setAttribute('placeholder', 'Filter your messages');
    filter.addEventListener('input', applyFilter);
    head.appendChild(filter);
    panel.appendChild(head);
    rowsBox = document.createElement('div');
    panel.appendChild(rowsBox);
    nav.appendChild(panel);

    document.body.appendChild(nav);
    /* A click anywhere else dismisses the list; one inside it, or on the rail, does not. Wired to the document once,
       so a list rebuilt after a setting came back on does not leave a second listener behind. */
    if (!outsideWired) {
      outsideWired = true;
      document.addEventListener('click', function (ev) {
        if (!panelOpen()) return;
        var t = ev && ev.target;
        if (t && panel && railBox && ((panel.contains && panel.contains(t)) || (railBox.contains && railBox.contains(t)))) return;
        closeList();
      });
    }
    wireKeys();
  }

  /* Whether the list is already the one these messages would build. Compared from the end, where a new one lands. */
  function sameRows(list, texts) {
    if (list.length !== sigNodes.length) return false;
    for (var i = list.length - 1; i >= 0; i--) if (list[i] !== sigNodes[i] || texts[i] !== sigTexts[i]) return false;
    return true;
  }

  function buildNav(users) {
    var nodes = [], texts = [], whens = [];
    for (var i = 0; i < users.length; i++) {
      var text = bodyWords(users[i].node, i === users.length - 1);
      if (!text) continue;
      nodes.push(users[i].node); texts.push(text); whens.push(users[i].when || '');
    }
    if (!nodes.length) { dropNav(); return; }
    ensureNav();
    navNodes = nodes;
    var marks = texts.map(function (t, k) { return whens[k] + '\u0000' + t; });
    if (sameRows(nodes, marks)) return;
    sigNodes = nodes.slice();
    sigTexts = marks;
    rowsBox.textContent = '';
    rows = [];
    for (var j = 0; j < nodes.length; j++) {
      (function (node, text, when) {
        var row = document.createElement('div');
        row.setAttribute('class', 'codex-extras-row');
        row.setAttribute(MARK, 'nav-row');
        row.setAttribute('title', (when ? when + '\n' : '') + text.slice(0, 220));
        if (when) {
          var at = document.createElement('span');
          at.setAttribute('class', 'codex-extras-row-when');
          at.textContent = when;
          row.appendChild(at);
        }
        var body = document.createElement('span');
        body.textContent = text.slice(0, 48);
        row.appendChild(body);
        row.addEventListener('click', function (ev) {
          try { ev.stopPropagation(); } catch (e) { /* none */ }
          stepIdx = -1; stepAt = 0;
          landOn(node);
        });
        rowsBox.appendChild(row);
        rows.push({ row: row, hay: (when + ' ' + text).toLowerCase() });
      })(nodes[j], texts[j], whens[j]);
    }
    applyFilter();
  }

  /*
   * One observer, on the one element the reader scrolls. Debounced, because a reply arrives a word at a time; dropped
   * while the page is hidden; and self-limiting rather than self-feeding, since a pass that finds nothing changed
   * writes nothing and so starts no further pass.
   *
   * Until Codex has drawn that element there is nothing to observe, so the first observer is on <body> and lasts only
   * until the scroller exists: every pass re-targets, and the body one is dropped the moment there is a scroller.
   */
  var observer = null, observed = null, due = 0;
  function unwatch() {
    if (observer) { try { observer.disconnect(); } catch (e) { /* gone */ } }
    observer = null; observed = null;
    if (due) { clearTimeout(due); due = 0; }
  }
  function watch() {
    if (!anythingOn() || typeof MutationObserver !== 'function' || !document.body) { unwatch(); return; }
    var target = scrollerEl() || document.body;
    if (observer && observed === target) return;
    unwatch();
    observer = new MutationObserver(function (records) {
      /* A record whose target is this script's own node is this script's own writing coming back. */
      var theirs = false;
      for (var i = 0; i < records.length && !theirs; i++) {
        var t = records[i] && records[i].target;
        if (!t || typeof t.closest !== 'function' || !t.closest('[' + MARK + ']')) theirs = true;
      }
      if (!theirs || due) return;
      due = setTimeout(function () { due = 0; watch(); refresh(); }, DEBOUNCE_MS);
    });
    observed = target;
    try { observer.observe(target, { childList: true, subtree: true }); } catch (e) { unwatch(); }
  }

  var refreshing = false;
  function refresh() {
    if (refreshing || !document.body) return;
    refreshing = true;
    try {
      var list = entries();
      if (!list) { dropNav(); return; }
      var users = stampAll(list);
      colourAll(users);
      if (view.navigation) buildNav(users); else dropNav();
      if (anythingOn()) restyle(); else dropSheet();
    } catch (e) { /* this is Codex's page: a fault here leaves everything of its own as it was */ }
    finally { refreshing = false; }
  }

  var waiting = false, visWired = false;
  function ready() {
    if (!document.body) {
      if (!waiting) { waiting = true; document.addEventListener('DOMContentLoaded', function () { waiting = false; ready(); }); }
      return;
    }
    if (!visWired) {
      visWired = true;
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) unwatch(); else { watch(); refresh(); }
      });
    }
    watch();
    refresh();
  }

  globalThis.addEventListener('message', function (e) {
    var m = e && e.data;
    if (!m || typeof m.type !== 'string' || m.type.indexOf('codex-extras-') !== 0) return;
    if (m.type === 'codex-extras-chime') chime(m.kind);
    else if (m.type === 'codex-extras-sample') {
      var reply = { kind: 'sample', id: m.id };
      try {
        var s = sample();
        if (s.error) reply.error = s.error; else reply.sample = s;
      } catch (err) { reply.error = 'sampling the layout failed: ' + String((err && err.name) || 'Error'); }
      post(reply);
    } else if (m.type === 'codex-extras-figures') {
      figures = m;
      if (timer) { clearInterval(timer); timer = null; }
      if (m.tool) timer = setInterval(draw, 1000);
      if (document.body) draw(); else document.addEventListener('DOMContentLoaded', draw);
    } else if (m.type === 'codex-extras-view') {
      view = { timestamps: m.timestamps !== false, navigation: m.navigation !== false,
        userColor: typeof m.userColor === 'string' ? m.userColor : '', userEdge: m.userEdge !== false };
      ready();
    } else if (m.type === 'codex-extras-user-times') {
      hostWhen = Array.isArray(m.times)
        ? m.times.filter(function (n) { return typeof n === 'number' && isFinite(n); })
        : null;
      ready();
    }
  });
})();
