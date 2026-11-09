// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Runs in Codex's page (its sidebar and every conversation tab), added by src/webview-inject.js as a module script
 * ahead of Codex's own, so it runs first.
 *
 *   - The page's time zone goes to the extension host, since this is the one part that runs where the user is.
 *   - Whether an approval card is on screen goes to the host as a flag, which is how the conversation Codex's sidebar
 *     is showing is seen as waiting even though it has no tab of its own.
 *   - A chime plays when the host says a turn finished, a plan question appeared, or Codex stopped for permission, for
 *     the conversation shown here.
 *   - The strip shows the figures the host sends for this conversation: the last turn's duration, how much of the
 *     context window is in use, model and effort, and while a turn runs, the tool call in progress and for how long.
 *   - On request, a sample of the conversation layout: element structure only, with no text from it. The render check
 *     (test/render/run.js) asks for one of the page it draws.
 *   - On request, a self-check: how much of Codex's own tree each part below found, and how much of its own each one
 *     drew, as counts and flags. This is how the parts that only a person looking at a live Codex could confirm are
 *     confirmed by a command instead.
 *   - A time on every message and reply block, a list of your own messages on the right edge, and your own messages
 *     marked out. Those three write into Codex's own tree; everything else this script draws sits in a strip of its
 *     own alongside.
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

  /* This script's own version. A page runs the copy it was built with, so a page left on an older patch answers a
     self-check with an older version here, which is the one case the host cannot tell from reading its own files.
     test/parts/62-selfcheck.js holds it to package.json, since a page cannot read that file. */
  var SCRIPT_VERSION = '1.0.0';

  var audio = null;
  /* The three sounds of Claude Code Extras, note for note and at its volume, so someone using both hears the same thing
     for the same event: rising for a finished turn, three equal notes for a permission, falling for a question. Each
     step is [frequency in Hz, start in s, length in s]. */
  var TONES = {
    done: [[880, 0, 0.09], [1174, 0.09, 0.16]],
    approval: [[880, 0, 0.07], [880, 0.13, 0.07], [880, 0.26, 0.11]],
    question: [[1174, 0, 0.09], [880, 0.10, 0.16]],
  };
  var CHIME_GAIN = 0.05;
  function chime(kind) {
    try {
      audio = audio || new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      var steps = TONES[kind] || TONES.done, t0 = audio.currentTime;
      steps.forEach(function (step) {
        var at = t0 + step[1], dur = step[2];
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(step[0], at);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(CHIME_GAIN, at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g); g.connect(audio.destination);
        o.start(at); o.stop(at + dur + 0.02);
      });
    } catch (e) { /* no audio here */ }
  }

  /*
   * Whether an approval card is on this page, told to the host as a flag and nothing else.
   *
   * The host reads approvals from the app-server itself (src/approvals.js), which needs no page at all. This adds the
   * one conversation that has no tab of its own: the one Codex's sidebar is showing. It is also the page's own
   * immediate answer, where the host's arrives on the next request through the message pump.
   *
   * The selector is Codex's own, copied as it stands: Codex uses the same one to decide whether an approval surface is
   * up (its Escape handler and its keyboard navigation both query this attribute), so what matches here is what Codex
   * itself treats as a card. The :not() excludes a card on a page of its desktop app's shell that is not in front;
   * VS Code's webview has no such attribute, so there it selects nothing extra, and it is left in so that the query
   * stays Codex's.
   *
   * This watcher differs from the one below in two ways:
   *
   *   - It is not the scroller's observer. An approval card is drawn above the message box, outside the element the
   *     conversation scrolls, so the observer down there cannot see it appear. This one is on the activity root, which
   *     is the narrowest element Codex keeps around both the scroller and the message box.
   *   - It is not dropped while the page is hidden, which is when a tab in the background needs it. Codex's webviews
   *     keep their context when hidden, so the page is still running and the card still appears.
   */
  var APPROVAL_SEL = '[data-codex-approval-surface]:not([data-app-shell-active-page="false"] *)';
  var ACTIVITY_SEL = '[data-request-input-activity-root]';
  var APPROVAL_DEBOUNCE_MS = 150;
  var approvalOn = null, approvalObserver = null, approvalObserved = null, approvalDue = 0, approvalWaiting = false;

  function tellApproval() {
    var on = false;
    try { on = !!document.querySelector(APPROVAL_SEL); } catch (e) { return; }
    if (on === approvalOn) return;
    approvalOn = on;
    post({ kind: 'approval', on: on });
  }

  /*
   * An outline round Codex's own context meter, the donut in the message box, once LOW_AT percent or more of the window
   * is used; Codex's own only fades its label past half. Codex compacts at 90% of the model's full window and the meter
   * counts against the window Codex reports, 95% of the full one, so on the meter compaction falls at 0.9 / 0.95, about
   * 94.7%; LOW_AT is 15 points before that, which is when Claude Code Extras outlines its own meter. Codex draws it only while its own setting is on. It is the
   * image in the composer whose accessible label carries a percentage; the label is localised, so only the number is
   * read. Checked on the approval watcher's pass, which already sees the composer change, and on the marks' pass. Only a
   * class goes on Codex's element.
   */
  var LOW_CLASS = 'codex-extras-ctx-low', LOW_AT = 80;
  var COMPOSER_SEL = '[data-codex-composer-root],[data-codex-composer]', METER_SEL = 'span[role="img"][aria-label]';
  var meter = { found: false, percent: null, low: false };
  function markLowContext() {
    var found = null, pct = null, boxes = all(document, COMPOSER_SEL);
    for (var b = 0; b < boxes.length && !found; b++) {
      var spans = all(boxes[b], METER_SEL);
      for (var i = 0; i < spans.length; i++) {
        var m = /(\d+(?:[.,]\d+)?)\s*%/.exec(String(spans[i].getAttribute('aria-label') || ''));
        if (m) { found = spans[i]; pct = parseFloat(m[1].replace(',', '.')); break; }
      }
    }
    var low = !!(found && view.lowContext !== false && pct >= LOW_AT);
    var flagged = all(document, '.' + LOW_CLASS);
    for (var k = 0; k < flagged.length; k++) if (flagged[k] !== found || !low) flag(flagged[k], LOW_CLASS, false);
    if (found && low) { flag(found, LOW_CLASS, true); if (!sheet || !sheet.isConnected) restyle(); }
    meter = { found: !!found, percent: found ? pct : null, low: low };
  }

  /*
   * Two buttons in the row below Codex's message box, outside the box: this conversation's session information, and the
   * chime on or off. The row is a node of this script's own on <body>, placed by measuring the box
   * (data-codex-composer-root) on each pass of either observer and on a resize; the row takes no pointer events, only
   * its two buttons do. With the master switch off, or with no box recognised, nothing is drawn.
   *
   * The information comes from the host. Clicking a value sends back only its position in the list, and the host copies
   * it from its own copy, so no text leaves the page.
   */
  var bar = null, infoBtn = null, muteBtn = null, infoBox = null, infoAsk = '', barWired = false;
  /*
   * The two glyphs, drawn rather than taken from a font: a font's information sign and note are of different sizes
   * from each other and from one machine to the next, and Codex's own icons are drawn. Both are line drawings in a
   * 16-unit box, inked about as tall as Codex's toolbar icons; the note is struck through while chimes are off.
   */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(parts) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(ICON_PX));
    svg.setAttribute('height', String(ICON_PX));
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'block';
    for (var i = 0; i < parts.length; i++) {
      var p = document.createElementNS(SVG_NS, parts[i].tag);
      for (var k in parts[i].attrs) p.setAttribute(k, parts[i].attrs[k]);
      svg.appendChild(p);
    }
    return svg;
  }
  var LINE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  var mix = function (a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; };
  var infoIcon = function () {
    return icon([{ tag: 'circle', attrs: mix(LINE, { cx: '8', cy: '8', r: '6.35' }) },
      { tag: 'path', attrs: mix(LINE, { d: 'M8 7.3v3.9' }) },
      { tag: 'circle', attrs: { cx: '8', cy: '4.95', r: '0.85', fill: 'currentColor' } }]);
  };
  var noteIcon = function () {
    return icon([{ tag: 'path', attrs: mix(LINE, { d: 'M9.6 11.4V1.9c.4 1.6 1.9 2.4 3.1 3.1' }) },
      { tag: 'ellipse', attrs: { cx: '7.3', cy: '11.9', rx: '2.5', ry: '1.9', transform: 'rotate(-20 7.3 11.9)', fill: 'currentColor' } },
      { tag: 'path', attrs: mix(LINE, { d: 'M2.6 2.6l10.8 10.8', 'data-codex-extras-mute': '' }) }]);
  };
  /*
   * Above Codex's content and below every overlay it draws. Codex puts its content at z-index 0 to 20; the lowest layer
   * it gives a popover portalled to <body> is z-30 (zIndexClassName "z-30"), its menus and dialogs use z-50 or the menu
   * variable's 70, and its overlay ceiling is --max-app-overlay-z-index, 2147480000. The box that opens from a button is
   * one above the button, still under all of those.
   */
  var Z_BELOW_CODEX = 25, Z_BELOW_CODEX_BOX = 27;
  /*
   * The row below the message box, which holds the two buttons on the left and the figures on the right. It starts
   * ROW_GAP below the box's frame, and is as tall as one of Codex's own toolbar icons, which is also the size the two
   * glyphs are drawn at. Codex leaves less room than that under the box, so while the row is drawn the box is given
   * ROW_ROOM more at its foot (the stylesheet), which takes that much height from the conversation above it.
   */
  var ROW_GAP = 2, ROW_ROOM = 4, ICON_PX = 16;
  var iconPx = function (root) {
    var svg = root ? one(root, 'button svg') : null, h = 0;
    try { h = svg ? Math.round(svg.getBoundingClientRect().height) : 0; } catch (e) { h = 0; }
    return h >= 10 && h <= 24 ? h : ICON_PX;
  };
  /* Where the row goes: { top, left, right, size } in the page, or null with no message box recognised. */
  function rowPlace() {
    var root = document.body ? composerRoot() : null, r = null;
    try { r = root ? root.getBoundingClientRect() : null; } catch (e) { r = null; }
    if (!r || !(r.width > 0)) return null;
    var size = iconPx(root), vh = +globalThis.innerHeight || 0, vw = +globalThis.innerWidth || 0;
    var bottom = typeof r.bottom === 'number' ? r.bottom : (r.top || 0) + (r.height || 0);
    var top = bottom + ROW_GAP;
    if (vh && top > vh - size) top = vh - size;
    return { top: Math.round(top), left: Math.round(r.left || 0), right: vw ? Math.max(0, Math.round(vw - (r.left || 0) - (r.width || 0))) : 8, size: size };
  }

  /* A hover label of this script's own, since a native title is not reliably shown in Codex's page. Created on hover
     and removed on leave or click, so nothing stays in the page. */
  var labelBox = null;
  function hideLabel() { if (labelBox) { try { labelBox.remove(); } catch (e) { /* gone */ } labelBox = null; } }
  function showLabel(el) {
    var text = el && el.getAttribute('aria-label');
    if (!text || !document.body) return;
    hideLabel();
    var box = document.createElement('div');
    box.setAttribute(MARK, 'label');
    box.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX_BOX + ';pointer-events:none;max-width:260px;padding:6px 8px;'
      + 'background:var(--vscode-editorHoverWidget-background,#252526);color:var(--vscode-editorHoverWidget-foreground,#ccc);'
      + 'border:1px solid var(--vscode-editorHoverWidget-border,#454545);border-radius:4px;'
      + 'font:11px var(--vscode-font-family,sans-serif);line-height:1.35;white-space:pre-line;overflow-wrap:anywhere;';
    box.textContent = text;
    document.body.appendChild(box);
    var r = null, b = null;
    try { r = el.getBoundingClientRect(); b = box.getBoundingClientRect(); } catch (e) { r = null; }
    if (r && b) {
      var vw = +globalThis.innerWidth || 0;
      box.style.left = Math.max(8, vw ? Math.min(vw - (b.width || 0) - 8, r.left) : r.left) + 'px';
      box.style.top = Math.max(8, r.top - (b.height || 0) - 6) + 'px';
    }
    labelBox = box;
  }
  function labelled(el, text) {
    if (el.getAttribute('aria-label') !== text) el.setAttribute('aria-label', text);
    if (el.getAttribute(MARK + '-labelled') !== null) return;
    el.setAttribute(MARK + '-labelled', '');
    el.addEventListener('mouseenter', function () { showLabel(el); });
    el.addEventListener('mouseleave', hideLabel);
    el.addEventListener('click', hideLabel);
  }
  var composerRoot = function () { return one(document, '[data-codex-composer-root]') || one(document, '[data-codex-composer]'); };
  var infoOpen = function () { return !!(infoBox && infoBox.isConnected && infoBox.style.display === 'block'); };
  function closeInfo() { if (infoBox) infoBox.style.display = 'none'; }
  function dropBar() {
    hideLabel();
    if (bar) { try { bar.remove(); } catch (e) { /* gone */ } }
    if (infoBox) { try { infoBox.remove(); } catch (e) { /* gone */ } }
    bar = infoBtn = muteBtn = infoBox = null;
  }
  function barButton(label, onClick) {
    var b = document.createElement('div');
    b.setAttribute(MARK, 'bar-button');
    b.setAttribute('role', 'button');
    labelled(b, label);
    b.style.cssText = 'pointer-events:auto;cursor:pointer;user-select:none;padding:0 4px;border-radius:3px;opacity:.75;';
    b.addEventListener('click', function (ev) { try { ev.stopPropagation(); } catch (e) { /* none */ } onClick(); });
    return b;
  }
  function placeBar() {
    var at = view.buttons !== false ? rowPlace() : null;
    placeStrip();
    if (!at) { dropBar(); return; }
    if (!bar || !bar.isConnected) {
      dropBar();
      bar = document.createElement('div');
      bar.setAttribute(MARK, 'bar');
      bar.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX + ';pointer-events:none;display:flex;gap:2px;'
        + 'font:11px var(--vscode-font-family,sans-serif);color:var(--vscode-descriptionForeground,#888);';
      infoBtn = barButton('About this conversation: its thread id, the process of Codex\'s server, the folder it '
        + 'started in, its rollout and size, the context in use and the tokens it used. Click a value to copy it.', toggleInfo);
      infoBtn.appendChild(infoIcon());
      muteBtn = barButton('Chimes', function () { post({ kind: 'toggleChime' }); });
      muteBtn.appendChild(noteIcon());
      bar.appendChild(infoBtn);
      bar.appendChild(muteBtn);
      document.body.appendChild(bar);
      if (!barWired) {
        barWired = true;
        try { globalThis.addEventListener('resize', function () { placeBar(); }); } catch (e) { /* no window events */ }
        document.addEventListener('click', function (ev) {
          if (!infoOpen()) return;
          var t = ev && ev.target;
          if (t && ((infoBox && infoBox.contains && infoBox.contains(t)) || (infoBtn && infoBtn.contains && infoBtn.contains(t)))) return;
          closeInfo();
        });
      }
    }
    bar.style.left = at.left + 'px';
    bar.style.top = at.top + 'px';
    var px = String(at.size);
    for (var k = 0; k < bar.children.length; k++) {
      var s = bar.children[k].style, svg = one(bar.children[k], 'svg');
      if (s.height !== px + 'px') { s.height = px + 'px'; s.display = 'flex'; s.alignItems = 'center'; }
      if (svg && svg.getAttribute('width') !== px) { svg.setAttribute('width', px); svg.setAttribute('height', px); }
    }
    var muted = view.chime === false;
    var slash = one(muteBtn, '[data-codex-extras-mute]');
    if (slash) { var vis = muted ? 'visible' : 'hidden'; if (slash.getAttribute('visibility') !== vis) slash.setAttribute('visibility', vis); }
    if (muteBtn.getAttribute(MARK + '-muted') !== (muted ? 'true' : 'false')) muteBtn.setAttribute(MARK + '-muted', muted ? 'true' : 'false');
    if (muteBtn.style.opacity !== (muted ? '0.45' : '0.75')) muteBtn.style.opacity = muted ? '0.45' : '0.75';
    labelled(muteBtn, muted ? 'Chimes are off: click to turn them on (codexPlus.chime)' : 'Chimes are on: click to turn them off (codexPlus.chime)');
  }
  function toggleInfo() {
    if (infoOpen()) { closeInfo(); return; }
    infoAsk = 'info-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    post({ kind: 'infoAsk', id: infoAsk });
  }
  function showInfo(m) {
    if (!bar || m.id !== infoAsk || !Array.isArray(m.rows)) return;
    if (!infoBox || !infoBox.isConnected) {
      infoBox = document.createElement('div');
      infoBox.setAttribute(MARK, 'info');
      infoBox.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX_BOX + ';display:none;width:420px;max-width:calc(100vw - 32px);'
        + 'padding:8px 10px;border-radius:5px;font:11px var(--vscode-font-family,sans-serif);line-height:1.5;'
        + 'background:var(--vscode-editorHoverWidget-background,rgba(30,30,30,.99));'
        + 'color:var(--vscode-editorHoverWidget-foreground,#ddd);'
        + 'border:1px solid var(--vscode-editorHoverWidget-border,rgba(255,255,255,.18));box-shadow:0 4px 14px rgba(0,0,0,.5);';
      document.body.appendChild(infoBox);
    }
    infoBox.textContent = '';
    m.rows.slice(0, 20).forEach(function (row, i) {
      if (!row || typeof row.label !== 'string') return;
      var line = document.createElement('div');
      line.style.cssText = 'display:flex;gap:10px;padding:2px 0;';
      var k = document.createElement('span');
      k.textContent = row.label;
      k.style.cssText = 'flex:0 0 110px;opacity:.6;';
      var v = document.createElement('span');
      v.textContent = String(row.value == null ? '' : row.value);
      v.style.cssText = 'flex:1 1 auto;min-width:0;word-break:break-all;cursor:pointer;'
        + 'font-family:var(--vscode-editor-font-family,monospace);';
      v.setAttribute('title', 'Click to copy');
      v.addEventListener('click', function (ev) {
        try { ev.stopPropagation(); } catch (e) { /* none */ }
        post({ kind: 'infoCopy', id: m.id, index: i });
        var was = v.textContent;
        v.textContent = 'copied';
        setTimeout(function () { if (v.isConnected) v.textContent = was; }, 900);
      });
      line.appendChild(k); line.appendChild(v);
      infoBox.appendChild(line);
    });
    var r = null;
    try { r = bar.getBoundingClientRect(); } catch (e) { r = null; }
    var vh = +globalThis.innerHeight || 0;
    infoBox.style.left = Math.round(r ? r.left : 8) + 'px';
    infoBox.style.bottom = Math.round(vh && r ? Math.max(4, vh - r.top + 4) : 28) + 'px';
    infoBox.style.display = 'block';
  }

  function watchApproval() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    var target = null;
    try { target = document.querySelector(ACTIVITY_SEL); } catch (e) { target = null; }
    target = target || document.body;
    if (approvalObserver && approvalObserved === target) return;
    if (approvalObserver) { try { approvalObserver.disconnect(); } catch (e) { /* gone */ } }
    approvalObserver = new MutationObserver(function () {
      if (approvalDue) return;
      approvalDue = setTimeout(function () { approvalDue = 0; watchApproval(); tellApproval(); markLowContext(); placeBar(); }, APPROVAL_DEBOUNCE_MS);
    });
    approvalObserved = target;
    try { approvalObserver.observe(target, { childList: true, subtree: true }); }
    catch (e) { approvalObserver = null; approvalObserved = null; }
  }

  function approvalReady() {
    if (!document.body) {
      if (!approvalWaiting) { approvalWaiting = true; document.addEventListener('DOMContentLoaded', function () { approvalWaiting = false; approvalReady(); }); }
      return;
    }
    watchApproval();
    tellApproval();
  }

  /*
   * An answer from the host for the conversation this page shows. The host has already put it in the message box as a
   * draft through Codex's own route state (prefillPrompt, into an empty box only). This waits for it to appear there and
   * then sends it as the user would: Enter, and if the box still holds it, the modified Enter Codex's own setting may ask
   * for instead (Cmd on a Mac, Ctrl elsewhere). While a turn runs Codex queues it or steers with it, as it does with
   * anything sent then. What goes back is a word for what was seen, and no text.
   */
  var ANSWER_TRIES = 30, ANSWER_STEP_MS = 100, SENT_CHECK_MS = 800;
  var squash = function (s) { return String(s || '').replace(/\s+/g, ''); };
  function composerEditor() {
    var boxes = all(document, COMPOSER_SEL);
    for (var i = 0; i < boxes.length; i++) {
      var el = one(boxes[i], '[data-composer-input] [contenteditable="true"]') || one(boxes[i], '[contenteditable="true"]');
      if (el) return el;
    }
    return null;
  }
  function pressEnter(el, modified) {
    if (!el) return;
    var init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    if (modified) {
      if (/Mac|iPhone|iPad/.test(String((globalThis.navigator || {}).platform || ''))) init.metaKey = true; else init.ctrlKey = true;
    }
    try { if (typeof el.focus === 'function') el.focus(); } catch (e) { /* not focusable */ }
    try { el.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (e) { /* no keyboard events here */ }
  }
  function takeAnswer(m) {
    var want = squash(m.text), tries = 0;
    var reply = function (outcome) { post({ kind: 'answer', id: m.id, outcome: outcome }); };
    var holds = function () { var el = composerEditor(); return !!el && squash(el.textContent) === want; };
    var look = function () {
      var el = composerEditor(), have = el ? squash(el.textContent) : '';
      if (el && want && have === want) {
        pressEnter(el, false);
        setTimeout(function () {
          if (!holds()) { reply('submitted'); return; }
          pressEnter(composerEditor(), true);
          setTimeout(function () { reply(holds() ? 'drafted' : 'submitted'); }, SENT_CHECK_MS);
        }, SENT_CHECK_MS);
        return;
      }
      if (++tries >= ANSWER_TRIES) { reply(!el ? 'noComposer' : have ? 'occupied' : 'noDraft'); return; }
      setTimeout(look, ANSWER_STEP_MS);
    };
    look();
  }

  var strip = null, figures = null, timer = null;
  /* On the row, at its right end under the box's right edge; in the page's corner when there is no box to go by. */
  function placeStrip() {
    if (!strip) return;
    var at = rowPlace();
    if (at) {
      strip.style.top = at.top + 'px'; strip.style.right = at.right + 'px'; strip.style.bottom = '';
      strip.style.lineHeight = at.size + 'px'; strip.style.height = at.size + 'px';
    } else { strip.style.top = ''; strip.style.right = '8px'; strip.style.bottom = '2px'; }
  }
  /*
   * Whether Codex's page shows the tool call itself, in view: its row carries the call's id among
   * data-local-conversation-item-target-ids. Then the strip leaves it to Codex, whose own "Working for" line and row say
   * the same; scrolled out of view, or with no id from the host, the strip says it.
   */
  function codexShowsCall(id) {
    if (!id) return false;
    var rows = all(document, '[data-local-conversation-item-target-ids*="' + String(id).replace(/["\\]/g, '\\$&') + '"]');
    var vh = +globalThis.innerHeight || 0;
    for (var i = 0; i < rows.length; i++) {
      var ids = String(rows[i].getAttribute('data-local-conversation-item-target-ids') || '').split(/[\s,]+/);
      if (ids.indexOf(String(id)) === -1) continue;
      var b = null;
      try { b = rows[i].getBoundingClientRect(); } catch (e) { b = null; }
      var bottom = b ? (typeof b.bottom === 'number' ? b.bottom : (b.top || 0) + (b.height || 0)) : 0;
      if (b && b.height > 0 && (!vh || (bottom > 0 && (b.top || 0) < vh))) return true;
    }
    return false;
  }
  function draw() {
    var tool = figures && figures.tool && !codexShowsCall(figures.toolCall) ? figures.tool : '';
    if (!figures || (!figures.text && !tool)) { if (strip) strip.style.display = 'none'; return; }
    if (!strip) {
      strip = document.createElement('div');
      strip.setAttribute(MARK, 'figures');
      strip.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX + ';pointer-events:none;white-space:nowrap;'
        + 'font:11px var(--vscode-font-family,sans-serif);color:var(--vscode-descriptionForeground,#888);padding:0 4px;';
      document.body.appendChild(strip);
    }
    placeStrip();
    var text = figures.text;
    if (tool && figures.toolSince) {
      var s = Math.max(0, Math.round((Date.now() - figures.toolSince) / 1000));
      text = tool + ' running for ' + (s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's')
        + ' (since ' + clockOf({ ms: figures.toolSince, secs: true }) + ')' + (text ? ' · ' + text : '');
    }
    strip.textContent = text;
    strip.style.display = '';
  }

  /*
   * A sample of the conversation layout, taken only when asked for one (the render check asks) and leaving behind
   * neither a timer nor an observer. Codex's own class names are not known to this script, so nothing here is selected by name: one pass over
   * the page finds the element the user actually scrolls, and the sample is the tree under it.
   *
   * Only shape is sent. Each element gives its tag, its class names, the names of its attributes, its depth, how many
   * children it has and its rounded size; each text node gives its length and the shape of its first few characters
   * (d for a digit, a for a letter, o for anything else), which is enough to tell a timestamp from a sentence while
   * carrying neither. No attribute value is read, except an id with anything thread-id-shaped masked out, and the
   * page's query string is left out altogether since Codex puts route state there and route state can hold what the
   * user typed. Sibling elements rendered by the same component look alike here, so each such group keeps three
   * samples and a count,
   * or a long conversation would answer with tens of thousands of nodes.
   */
  var MAX_NODES = 1600, MAX_DEPTH = 24, MAX_TWINS = 3, HEAD = 8, SURVEY_MAX = 6000;
  var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  /* Anything this long is not a route segment, so it is masked out as well. */
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
   * This is the only part of the script that works inside Codex's own tree. It adds two things there: a line of its
   * own above a message, and class names that one of its own rules then styles. Codex's nodes are only read, and
   * everything this script adds carries data-codex-extras, so one query finds all of it again when a setting goes off.
   *
   * Codex's elements are found by the data-* attributes it puts on them and never by class name, since its class names
   * are a build's output. Every attribute named in ATTR is checked by test/parts/60-page-features.js against a real
   * sample of a Codex conversation, so a Codex release that drops one turns a check red instead of quietly showing
   * nothing.
   *
   * A message's opening words are read and shown here and go no further. The one thing this part posts to the host is
   * the shape of a sent time it could not parse: its length, the class of its first character and whether it is all
   * digits. None of that includes the value itself.
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
    unit: 'data-content-search-unit-key',
  };
  var SEL = { day: 'time[datetime]' };
  Object.keys(ATTR).forEach(function (k) { SEL[k] = '[' + ATTR[k] + ']'; });

  /* What the host last said to show. The defaults are the settings' own defaults, so a page the host has not spoken to
     yet shows what those settings say rather than nothing at all. */
  var view = { timestamps: true, navigation: true, userColor: '', userEdge: true, lowContext: true, replyFigures: true,
    buttons: true, chime: true };
  /* Each turn's model, effort and context as the host read them from the rollout, by turn id: { turnId: text }. They
     are placed by the turn id Codex puts on each turn (data-content-search-turn-key), never by position. */
  var hostTurns = {};
  var FIG_ATTR = 'data-codex-extras-figures';
  /* One time per user message of this conversation, in the order the rollout has them, as the host read them there.
     Used only when there are exactly as many as the page shows - see stampAll. */
  var hostWhen = null;
  /* Where Codex compacted this conversation's context: { after, at }, `after` being how many of the user's messages
     came before it in the rollout. Placed in the list only under the same condition as hostWhen. */
  var hostCompactions = [];

  /*
   * Which source the last pass took each user-side time from. This is the one thing the self-check cannot read back off
   * the page: a stamp reads the same whichever source it came from, and the user side has two (the clock Codex rendered
   * in the hover row, and the rollout's own times through the host). Counted where the choice is made rather than
   * worked out again afterwards, so what is reported is what was drawn.
   */
  var lastPass = { fromClock: 0, fromRollout: 0, unstamped: 0, hostTimes: 0, linedUp: false };

  var INK_CLASS = 'codex-extras-user-ink', EDGE_CLASS = 'codex-extras-user-edge';
  /*
   * On this script's own stamp when it shows a time. The stylesheet hides Codex's own sent time in a reply whose stamp
   * carries it, so the reply shows one time. It is on the stamp rather than on Codex's element because Codex's render
   * rewrites the class of its own elements, which no observer here sees.
   */
  var TIMED_ATTR = MARK + '-timed';
  var DEBOUNCE_MS = 200, STEP_HOLD_MS = 600;
  var RAIL_W = 26, PANEL_W = 300;
  /* Under Codex's overlays, as the row below the message box is (Z_BELOW_CODEX); the list one above the rail. */
  var Z_PANEL = 26, Z_RAIL = 25;

  var all = function (root, sel) { try { return [].slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } };
  var one = function (root, sel) { try { return (root || document).querySelector(sel); } catch (e) { return null; } };
  var scrollerEl = function () { return one(document, SEL.scroller); };
  var words = function (el) { return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim(); };
  var isOurs = function (el) { return !!(el && el.getAttribute && el.getAttribute(MARK) != null); };
  var anythingOn = function () {
    return !!(view.timestamps || view.navigation || view.userColor || view.userEdge !== false || view.lowContext !== false
      || view.replyFigures !== false);
  };

  /* Anything outside these two years is not a time somebody wrote, whatever the number happened to parse as. */
  var EPOCH_LO = Date.UTC(2001, 0, 1), EPOCH_HI = Date.UTC(2100, 0, 1);
  /* A clock Codex has already rendered: 24-hour, or 12-hour with am or pm, with seconds optional in both. */
  var CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([AaPp])\.?[Mm]\.?)?$/;
  /* The same clock after a few words naming its day, as Codex writes the time of a message from an earlier day
     ("Sunday 9:02 AM"). */
  var DAY_AND_CLOCK = /^(\S.{0,23}?)[\s,]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)$/;

  /* The local midnight of a day the page states, from a date-only value or from a full instant. */
  function dayMsOf(value) {
    var s = String(value == null ? '' : value).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    /* A date-only value parses as UTC midnight, which west of Greenwich is the day before: built locally instead. */
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    var t = Date.parse(s);
    return isFinite(t) ? t : null;
  }

  /*
   * A clock with no date needs one; `dayMs` is the day the page put the message under, or today when it said none. A
   * clock after the words for its day is read only with a day from the page: those words are not read as a date, and
   * taken as today they would put the message on the wrong day.
   */
  function parseClock(value, dayMs) {
    var s = String(value == null ? '' : value).trim();
    var m = CLOCK.exec(s);
    if (!m) {
      var dated = DAY_AND_CLOCK.exec(s);
      if (!dated || !(typeof dayMs === 'number' && isFinite(dayMs))) return null;
      m = CLOCK.exec(dated[2]);
      if (!m) return null;
    }
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
  /* HH:MM:SS, in the user's own zone. HH:MM when the source carried no seconds: a zero there would be a time nobody
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

  /*
   * Codex's own sent time for a reply. The attribute marks the element that shows it and carries no time: Codex 26.1021
   * sets it to true (its value reads "true"), so the time is read from the element's text, the clock Codex rendered.
   * A value that does parse as a time is still taken first, for a build that puts one there.
   */
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
   * The time Codex renders beside a message of the user's. Unlike a reply's it carries no attribute of its own: it is a bare
   * span in the row of buttons beside the message, with no stable name to select it by. So it is found by reading
   * instead, as the one text in the message that reads as a clock and is not the message's own words. Only a clock
   * counts, not an epoch count or a date string, because this is looking for something Codex has already rendered for
   * display. With two candidates there is no telling which is the time, so none is returned.
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
        if (!t || t.length > 36) continue;
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
   * time once the message has been sent. The answer therefore goes in a WeakMap, which drops it once Codex has taken
   * that element away. `live` is for the newest message, which can still be arriving.
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
     sits, so a block Codex marks as the user's own is stamped and listed as theirs; any other wording leaves the
     block where it sits. */
  function roleOf(el) {
    var h = one(el, SEL.role);
    var v = h && h.getAttribute(ATTR.role);
    return v ? String(v).toLowerCase() : '';
  }

  /*
   * The user's messages in a turn, in document order. Codex anchors the message a page sent to start a turn
   * (data-local-conversation-user-anchor) and not one steered into a turn already running, nor one in a turn another
   * page started; those are a search unit holding a user bubble and no anchor, and are taken as the user's too. One
   * inside an anchor or inside a reply block is left to that.
   */
  function usersIn(turn) {
    var out = [], found = all(turn, SEL.user + ',' + SEL.unit);
    for (var i = 0; i < found.length; i++) {
      var el = found[i];
      if (el.hasAttribute && el.hasAttribute(ATTR.user)) { out.push(el); continue; }
      var up = el.parentElement;
      if (!one(el, SEL.bubble) || (up && up.closest && (up.closest(SEL.user) || up.closest(SEL.assistant) || up.closest(SEL.unit)))) continue;
      out.push(el);
    }
    return out;
  }

  /* How many turns the last entries() saw. */
  var lastTurns = 0;
  /* Every user message and reply block of the conversation, in document order, each with the day it sits under. */
  function entries() {
    var sc = scrollerEl();
    if (!sc) { lastTurns = 0; return null; }
    var turns = all(sc, SEL.turn), out = [], day = null;
    lastTurns = turns.length;
    for (var i = 0; i < turns.length; i++) {
      var turn = turns[i], d = dayOfTurn(turn);
      if (d !== null) day = d;
      var keyed = one(turn, SEL.turnBody);
      var key = keyed ? String(keyed.getAttribute(ATTR.turnBody) || '') : '';
      var users = usersIn(turn);
      for (var u = 0; u < users.length; u++) out.push({ kind: 'user', node: users[u], day: day, turn: key });
      var sides = all(turn, SEL.assistantSide), firstReply = true;
      for (var s = 0; s < sides.length; s++) {
        var blocks = all(sides[s], SEL.assistant);
        for (var b = 0; b < blocks.length; b++) {
          var kind = roleOf(blocks[b]) === 'user' ? 'user' : 'assistant';
          out.push({ kind: kind, node: blocks[b], day: day, turn: key, first: kind === 'assistant' && firstReply });
          if (kind === 'assistant') firstReply = false;
        }
      }
    }
    return out;
  }

  /*
   * This script's own line at the top of Codex's element, put there once and only retitled afterwards. `figures` is the
   * turn's line from the host, shown after the time by the stylesheet from an attribute, so the line's own text stays
   * the time alone.
   */
  function stampOn(host, side, text, figures) {
    var el = null, kids = host.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute(MARK) === 'stamp') { el = kids[i]; break; }
    }
    if (!text && !figures) {
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
    var timed = side === 'assistant' && !!text;
    if (timed !== (el.getAttribute(TIMED_ATTR) !== null)) { if (timed) el.setAttribute(TIMED_ATTR, ''); else el.removeAttribute(TIMED_ATTR); }
    var fig = figures ? (text ? ' \u00b7 ' : '') + figures : '';
    if (fig) { if (el.getAttribute(FIG_ATTR) !== fig) el.setAttribute(FIG_ATTR, fig); }
    else if (el.getAttribute(FIG_ATTR) !== null) el.removeAttribute(FIG_ATTR);
  }

  /* The time on every message, and the words for the list. Returns the user messages in document order. */
  function stampAll(list) {
    var users = [];
    for (var i = 0; i < list.length; i++) if (list[i].kind === 'user') { list[i].at = users.length; users.push(list[i]); }
    /*
     * The host's times line up with the page only when it read exactly as many user messages from the rollout as the
     * page shows. A rollout can hold messages inherited from a conversation this one was forked from, and a page can
     * hold a message the rollout does not have yet, so the two counts really do differ; lining them up by position when
     * they do would put a time against the wrong message.
     */
    var lined = hostWhen && hostWhen.length === users.length ? hostWhen : null;
    lastPass = { fromClock: 0, fromRollout: 0, unstamped: 0, hostTimes: hostWhen ? hostWhen.length : 0, linedUp: !!lined,
      turnsKeyed: 0, turnsMatched: 0, figuresDrawn: 0 };
    for (var j = 0; j < list.length; j++) {
      var e = list[j], text = '', took = '';
      if (view.timestamps) {
        var when = e.kind === 'assistant' ? assistantWhen(e.node, e.day) : userWhenInPage(e.node, e.day);
        if (e.kind === 'user') took = when ? 'clock' : '';
        if (e.kind === 'user' && lined) {
          /*
           * The rollout's time carries seconds and the clock Codex rendered does not, so the rollout's is preferred,
           * but only where the two agree to the minute. That agreement is per-message evidence that the two lists line
           * up. Where they disagree, or where there is no clock to compare against, what Codex rendered stands: the
           * count alone cannot see a page and a rollout that hold the same number of messages but not the same ones.
           */
          var host = { ms: lined[e.at], secs: true };
          if (!when || sameMinute(when.ms, host.ms)) { when = host; took = 'rollout'; }
        }
        text = clockOf(when);
        if (e.kind === 'user') e.when = text;
      }
      if (e.kind === 'user') {
        if (!text) lastPass.unstamped++;
        else if (took === 'rollout') lastPass.fromRollout++;
        else lastPass.fromClock++;
      }
      var figures = '';
      if (e.first && e.turn) {
        lastPass.turnsKeyed++;
        var known = Object.prototype.hasOwnProperty.call(hostTurns, e.turn) ? hostTurns[e.turn] : '';
        if (known) lastPass.turnsMatched++;
        if (known && view.replyFigures !== false) { figures = known; lastPass.figuresDrawn++; }
      }
      stampOn(e.node, e.kind, text, figures);
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

  /* A CSS colour the user typed, or '' for anything else: nothing but a colour may reach the stylesheet. */
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
      + '.codex-extras-stamp-user{text-align:end;}'
      + '.codex-extras-stamp[' + FIG_ATTR + ']::after{content:attr(' + FIG_ATTR + ');}';
    if (view.userColor && SAFE_COLOR.test(view.userColor)) {
      css += '.' + INK_CLASS + ',.' + INK_CLASS + ' *{color:' + view.userColor + ' !important;}';
    }
    if (view.userEdge !== false) {
      css += '.' + EDGE_CLASS + '{border-inline-start:3px solid '
        + 'var(--vscode-focusBorder,var(--vscode-textLink-foreground,#4493f8)) !important;'
        + 'padding-inline-start:8px !important;}';
    }
    if (view.lowContext !== false) {
      css += '.' + LOW_CLASS + '{outline:1px solid var(--vscode-editorWarning-foreground,#cca700) !important;'
        + 'outline-offset:1px;border-radius:4px;}';
    }
    if (view.timestamps) css += SEL.assistant + ':has(> [' + TIMED_ATTR + ']) ' + SEL.sent + '{display:none !important;}';
    /* The rail stands in the conversation's right edge, so while it is drawn the conversation keeps clear of its
       column: a transparent border, which leaves Codex's own padding as it is. */
    if (view.navigation && nav && nav.isConnected) css += SEL.scroller + '{border-inline-end:' + (RAIL_W + 2) + 'px solid transparent !important;}';
    if (view.buttons !== false || (strip && strip.style.display !== 'none')) {
      css += '[data-codex-composer-root]{margin-bottom:' + ROW_ROOM + 'px !important;}';
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

  /* Sized as Claude Code Extras sizes its own rail, so the two read as one control. Codex's stylesheet makes every
     element border-box and Claude Code's page does not, so the buttons say content-box: otherwise each comes out a
     pixel narrower and two shorter here, the border taken out of the size instead of added to it. */
  var NAV_CSS = '.codex-extras-rail{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:' + Z_RAIL + ';'
    + 'display:flex;flex-direction:column;align-items:flex-end;}'
    + '.codex-extras-rail-btn{box-sizing:content-box;width:' + RAIL_W + 'px;height:24px;display:flex;align-items:center;'
    + 'justify-content:center;cursor:pointer;user-select:none;font-size:13px;border-radius:3px 0 0 3px;'
    + 'background-color:var(--vscode-editorWidget-background,#282828);'
    + 'border:1px solid var(--vscode-widget-border,rgba(255,255,255,.14));border-right:none;'
    + 'color:var(--vscode-textLink-activeForeground,var(--vscode-focusBorder,#4493f8));}'
    + '.codex-extras-rail-handle{height:60px;font-size:18px;border-radius:4px 0 0 4px;}'
    /* The hover colour is a tint over the button's own colour, so the button stays opaque while it shows. */
    + '.codex-extras-rail-btn:hover{background-image:linear-gradient(var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12)),'
    + 'var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12)));}'
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
    + '.codex-extras-row-when{opacity:.7;margin-inline-end:6px;}'
    + '.codex-extras-rule{display:flex;align-items:center;gap:6px;padding:4px 10px;opacity:.6;cursor:pointer;font-size:10px;}'
    + '.codex-extras-rule:hover{opacity:.9;}'
    + '.codex-extras-rule-line{flex:1 1 auto;height:1px;background:var(--vscode-widget-border,rgba(255,255,255,.22));}';

  /* ── the list of your own messages, and stepping between them ── */
  var nav = null, railBox = null, panel = null, rowsBox = null, filter = null, chevron = null;
  var rows = [], navNodes = [], sigNodes = [], sigTexts = [], sigRules = '';
  var stepIdx = -1, stepAt = 0, keysWired = false, outsideWired = false;

  var SHUT = String.fromCharCode(8249), OPEN = String.fromCharCode(8250);
  var panelOpen = function () { return !!(panel && panel.style.display === 'block'); };
  /* Open or shut is said by which way the chevron points, and by nothing else: dimming it as well only made it hard
     to see which state it was in. */
  var mirror = function () { if (chevron) chevron.textContent = panelOpen() ? OPEN : SHUT; };
  var openList = function () {
    if (!panel) return;
    /* Kept above the message box, so a long list never covers Codex's send and stop buttons. Measured when it opens. */
    var box = composerRoot(), top = 0;
    try { top = box ? box.getBoundingClientRect().top : 0; } catch (e) { top = 0; }
    panel.style.maxHeight = top > 120 ? Math.round(top - 16) + 'px' : '';
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
   * A triangle against a bar, pointing at the edge it goes to, as media controls mark first and last. Drawn rather
   * than taken from a font, because a font without the glyph renders an empty box instead.
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
   * ',' and '.' step between your own messages, but only when the caret is not somewhere text goes. The guard errs
   * wide, since the cost of skipping a keystroke is far lower than the cost of swallowing one meant for Codex's
   * composer.
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
    rows = []; navNodes = []; sigNodes = []; sigTexts = []; sigRules = '';
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

  /*
   * The compaction points to draw, each with the row it goes before: they are counted in the rollout's messages, so
   * they are drawn only when the page shows exactly as many messages of the user's as the rollout holds, which is the
   * same test the rollout's times have to pass. Otherwise none, rather than one in the wrong place.
   */
  function rulesFor(users, order) {
    if (!hostCompactions.length || !hostWhen || hostWhen.length !== users.length) return [];
    var out = [];
    for (var c = 0; c < hostCompactions.length; c++) {
      var after = hostCompactions[c].after, before = order.length;
      for (var k = 0; k < order.length; k++) if (order[k] >= after) { before = k; break; }
      out.push({ before: before, at: hostCompactions[c].at, target: after < users.length ? users[after].node : null });
    }
    return out;
  }

  function buildNav(users) {
    var nodes = [], texts = [], whens = [], order = [];
    for (var i = 0; i < users.length; i++) {
      var text = bodyWords(users[i].node, i === users.length - 1);
      if (!text) continue;
      nodes.push(users[i].node); texts.push(text); whens.push(users[i].when || ''); order.push(i);
    }
    if (!nodes.length) { dropNav(); return; }
    ensureNav();
    navNodes = nodes;
    var marks = texts.map(function (t, k) { return whens[k] + '\u0000' + t; });
    var rules = rulesFor(users, order);
    var ruleSig = rules.map(function (r) { return r.before + '@' + r.at; }).join(',');
    if (sameRows(nodes, marks) && ruleSig === sigRules) return;
    sigNodes = nodes.slice();
    sigTexts = marks;
    sigRules = ruleSig;
    rowsBox.textContent = '';
    rows = [];
    var placeRules = function (upto) {
      for (var r = 0; r < rules.length; r++) if (rules[r].before === upto) addRule(rules[r]);
    };
    for (var j = 0; j < nodes.length; j++) {
      placeRules(j);
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
    placeRules(nodes.length);
    applyFilter();
  }

  /* A compaction point, as a rule across the list. Clicking it goes to the first message after it, or to the end of the
     conversation when there is none yet. */
  function addRule(rule) {
    var label = 'Context compacted' + (rule.at ? ' ' + clockOf({ ms: rule.at, secs: false }) : '');
    var d = document.createElement('div');
    d.setAttribute('class', 'codex-extras-rule');
    d.setAttribute(MARK, 'nav-rule');
    d.setAttribute('title', label);
    var line = function () { var l = document.createElement('div'); l.setAttribute('class', 'codex-extras-rule-line'); return l; };
    var t = document.createElement('span');
    t.textContent = label;
    d.appendChild(line()); d.appendChild(t); d.appendChild(line());
    d.addEventListener('click', function (ev) {
      try { ev.stopPropagation(); } catch (e) { /* none */ }
      stepIdx = -1; stepAt = 0;
      if (rule.target) landOn(rule.target); else toEdge(true);
    });
    rowsBox.appendChild(d);
    rows.push({ row: d, hay: label.toLowerCase() });
  }

  /*
   * One observer, on the one element the user scrolls. Debounced, because a reply arrives a word at a time, and
   * dropped while the page is hidden. It cannot loop on itself: a pass that finds nothing changed writes nothing, so
   * it starts no further pass.
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

  /*
   * Codex's page has turns and this script recognised none of the messages in them: a Codex release has most likely
   * changed an attribute it selects by. Told to the host once MISS_PASSES passes in a row have seen it and at least
   * MISS_MS has gone by since the first, so a conversation still being drawn does not count, and told again only after
   * the messages have been found in between. The message holds counts, flags and this script's version, nothing else.
   */
  var MISS_PASSES = 3, MISS_MS = 5000, missRun = 0, missSince = 0, missTold = false;
  function noteMisses(list) {
    var turns = list ? lastTurns : all(document, SEL.turn).length;
    var composer = !!composerRoot();
    if (!turns || (list && list.length && composer)) { missRun = 0; missSince = 0; missTold = false; return; }
    if (!missRun) missSince = Date.now();
    missRun++;
    if (missTold || missRun < MISS_PASSES || Date.now() - missSince < MISS_MS) return;
    missTold = true;
    post({ kind: 'anchorsMissing', version: SCRIPT_VERSION, turns: turns, scroller: !!list,
      messages: list ? list.length : 0, composer: composer });
  }

  var refreshing = false;
  function refresh() {
    if (refreshing || !document.body) return;
    refreshing = true;
    try {
      var list = entries();
      noteMisses(list);
      if (!list) { dropNav(); return; }
      var users = stampAll(list);
      colourAll(users);
      if (view.navigation) buildNav(users); else dropNav();
      if (anythingOn() || view.buttons !== false) restyle(); else dropSheet();
      markLowContext();
      placeBar();
    } catch (e) { /* this is Codex's page: a fault here leaves everything of its own as it was */ }
    finally { refreshing = false; }
  }

  /*
   * ── What this script makes of the page it is actually running in ──
   *
   * Everything above this is drawn for a person to look at, which left one question answerable only by that person:
   * whether any of it found what it was looking for in a live Codex. This answers it instead, as counts and flags that
   * one command copies out.
   *
   * Two sources, and the difference matters when they disagree. What Codex drew is counted by querying Codex's own
   * data-* attributes, and what this script drew by querying its own `data-codex-extras` marks - so a count of turns
   * with no stamps against them says the anchors were found and the times were not, which is a different fault from
   * finding no turns at all. The one thing neither query can answer is which source a user-side time came from, since
   * both render the same stamp; that comes from `lastPass`, recorded where the choice is made.
   *
   * It carries no text from the conversation: no message, no title, no stamp's value, and no selector read off the
   * page. The selector strings in the reply are this script's own constants, which are already in its source.
   * test/parts/62-selfcheck.js plants nine strings in a stand-in page and looks for each of them in the whole reply.
   */
  var SELFCHECK_FORMAT = 1;
  function selfCheck() {
    if (!document.body) return { error: 'the page has no body yet' };
    /* A pass first, so the counts describe the page as it stands rather than as it was before the last reply arrived. */
    refresh();
    var list = entries();
    var turns = all(scrollerEl(), SEL.turn);
    var userStamps = all(document, '.codex-extras-stamp-user');
    var assistantStamps = all(document, '.codex-extras-stamp-assistant').filter(function (el) { return !!el.textContent; });
    var users = 0, assistants = 0;
    for (var i = 0; i < (list || []).length; i++) { if (list[i].kind === 'user') users++; else assistants++; }
    var card = null;
    try { card = document.querySelector(APPROVAL_SEL); } catch (e) { card = null; }
    return {
      format: SELFCHECK_FORMAT,
      script: { version: SCRIPT_VERSION, running: true },
      /* What the host last told this page to show. The colour is a flag rather than its value: what is being checked
         is whether one got through, and a value the user typed is still a value. */
      settings: { timestamps: !!view.timestamps, navigation: !!view.navigation,
        userColor: !!view.userColor, userEdge: view.userEdge !== false },
      /* Codex's own tree, by the attributes this script selects by. `found` false means the conversation was not
         recognised at all, which is the failure a Codex release causes. */
      codex: {
        scroller: { selector: SEL.scroller, found: !!scrollerEl() },
        turns: turns.length,
        userAnchors: all(scrollerEl(), SEL.user).length,
        userWithoutAnchor: users - all(scrollerEl(), SEL.user).length,
        assistantBlocks: all(scrollerEl(), SEL.assistant).length,
        sentTimeElements: all(scrollerEl(), SEL.sent).length,
        bubbles: all(scrollerEl(), SEL.bubble).length,
        dayDividers: turns.length ? all(scrollerEl(), SEL.day).length : 0,
        /* What entries() made of all that, which is what every feature below works from. */
        entries: list === null ? null : { user: users, assistant: assistants },
      },
      /* The times. Both sides are counted from the stamps on screen; the user side's source is the recorded one. */
      times: {
        assistant: assistantStamps.length,
        user: userStamps.length,
        userFromClock: lastPass.fromClock,
        userFromRollout: lastPass.fromRollout,
        userUnstamped: lastPass.unstamped,
        userSource: lastPass.fromRollout ? (lastPass.fromClock ? 'both' : 'rollout')
          : lastPass.fromClock ? 'clock' : 'none',
        hostTimes: lastPass.hostTimes,
        hostTimesLinedUp: !!lastPass.linedUp,
        /* Forms of a sent time the parser could not read, as a count of distinct forms. The forms themselves have
           already gone to the host's log, one line each (kind 'stampShape'). */
        unreadableForms: Object.keys(toldShapes).length,
      },
      /* The list down the right edge, and which scroll container its buttons move. */
      navigation: {
        railButtons: all(document, '[' + MARK + '="nav-button"]').length,
        rows: all(document, '[' + MARK + '="nav-row"]').length,
        compactions: all(document, '[' + MARK + '="nav-rule"]').length,
        compactionsFromHost: hostCompactions.length,
        listOpen: panelOpen(),
        scrolls: { selector: SEL.scroller, found: !!scrollerEl() },
      },
      /* The user's own messages marked out: class names counted on Codex's elements, since that is where they go. */
      colour: {
        inked: all(document, '.' + INK_CLASS).length,
        edged: all(document, '.' + EDGE_CLASS).length,
        colourAccepted: !!(view.userColor && SAFE_COLOR.test(view.userColor)),
        styleSheet: !!(sheet && sheet.isConnected),
      },
      /*
       * The approval card. `observing` and `marksObserving` are read together on purpose: the card's watcher is meant
       * to survive the page being hidden and the marks' watcher is meant not to, so a self-check taken on a hidden page
       * is what tells the two apart. `hidden` says which kind of page this was taken on.
       */
      approval: {
        onScreen: !!card,
        told: approvalOn,
        watching: { selector: approvalObserved ? (approvalObserved === document.body ? 'body' : ACTIVITY_SEL) : '',
          activityRootFound: !!one(document, ACTIVITY_SEL), observing: !!approvalObserver },
        cardSelector: APPROVAL_SEL,
      },
      /* The line under each reply: how many turns carried an id, how many of those the host had figures for, and on
         how many replies they were drawn. */
      replyFigures: { setting: view.replyFigures !== false, fromHost: Object.keys(hostTurns).length,
        turnsKeyed: lastPass.turnsKeyed, matched: lastPass.turnsMatched, drawn: lastPass.figuresDrawn },
      /* The two buttons below the message box, and the box they are placed by. */
      buttons: { setting: view.buttons !== false, composerFound: !!composerRoot(), drawn: !!(bar && bar.isConnected) },
      /* Codex's own context meter, and whether this script outlined it. The percentage is the number Codex shows. */
      context: { meterFound: meter.found, percentUsed: meter.percent, outlined: meter.low,
        outlineSetting: view.lowContext !== false, outlineAt: LOW_AT },
      /* The strip in the corner. Its text is the host's figures for this conversation, so only whether there is any. */
      figures: { present: !!(strip && strip.isConnected), showing: !!(strip && strip.style.display !== 'none'),
        hasText: !!(figures && figures.text), toolRunning: !!(figures && figures.tool) },
      /* Everything this script has in the page, as one count: nothing of its own left behind when all of it is off. */
      marks: { total: all(document, '[' + MARK + ']').length },
      page: { hidden: !!document.hidden, marksObserving: !!observer },
    };
  }

  var waiting = false, visWired = false;
  function ready() {
    if (!document.body) {
      if (!waiting) { waiting = true; document.addEventListener('DOMContentLoaded', function () { waiting = false; ready(); }); }
      return;
    }
    if (!visWired) {
      visWired = true;
      /* Only the marks' observer goes when the page is hidden; the approval watcher stays, since a tab in the
         background is the case it is for. */
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
    else if (m.type === 'codex-extras-answer' && typeof m.text === 'string' && m.id) takeAnswer(m);
    else if (m.type === 'codex-extras-info') showInfo(m);
    else if (m.type === 'codex-extras-sample') {
      var reply = { kind: 'sample', id: m.id };
      try {
        var s = sample();
        if (s.error) reply.error = s.error; else reply.sample = s;
      } catch (err) { reply.error = 'sampling the layout failed: ' + String((err && err.name) || 'Error'); }
      post(reply);
    } else if (m.type === 'codex-extras-selfcheck') {
      var answer = { kind: 'selfcheck', id: m.id };
      try {
        var r = selfCheck();
        if (r.error) answer.error = r.error; else answer.report = r;
        /* The error's name and never its message: a message can quote a selector or a node's text. */
      } catch (err2) { answer.error = 'the self-check failed: ' + String((err2 && err2.name) || 'Error'); }
      post(answer);
    } else if (m.type === 'codex-extras-figures') {
      figures = m;
      if (timer) { clearInterval(timer); timer = null; }
      if (m.tool) timer = setInterval(draw, 1000);
      if (document.body) draw(); else document.addEventListener('DOMContentLoaded', draw);
    } else if (m.type === 'codex-extras-view') {
      view = { timestamps: m.timestamps !== false, navigation: m.navigation !== false,
        userColor: typeof m.userColor === 'string' ? m.userColor : '', userEdge: m.userEdge !== false,
        lowContext: m.lowContext !== false, replyFigures: m.replyFigures !== false, buttons: m.buttons !== false,
        chime: m.chime !== false };
      ready();
      placeBar();
    } else if (m.type === 'codex-extras-user-times') {
      hostWhen = Array.isArray(m.times)
        ? m.times.filter(function (n) { return typeof n === 'number' && isFinite(n); })
        : null;
      hostTurns = {};
      if (m.turns && typeof m.turns === 'object') {
        Object.keys(m.turns).forEach(function (k) {
          if (typeof m.turns[k] === 'string' && m.turns[k].length <= 120) hostTurns[k] = m.turns[k];
        });
      }
      hostCompactions = Array.isArray(m.compactions)
        ? m.compactions.filter(function (c) { return c && typeof c.after === 'number' && c.after >= 0; })
          .map(function (c) { return { after: Math.floor(c.after), at: typeof c.at === 'number' && isFinite(c.at) ? c.at : 0 }; })
        : [];
      ready();
    }
  });

  /* The approval watcher starts with the page rather than waiting for the host to speak: it is not one of the marks,
     it carries no setting of its own, and the host has nothing to tell it. */
  approvalReady();
})();
