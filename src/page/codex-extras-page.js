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
 *   - A chime plays when the host says a turn finished, Codex stopped for permission, or the model asked something,
 *     for the conversation shown here.
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
  var SCRIPT_VERSION = '1.0.1';

  var audio = null;
  /* Set by the Chimes button until the setting it asked for comes back. */
  var chimeAsked = false;
  /* The three sounds of Claude Code Extras, note for note and at its volume, so someone using both hears the same thing
     for the same event: rising for a finished turn, three equal notes for a permission, falling for a question. Each
     step is [frequency in Hz, start in s, length in s]. */
  var TONES = {
    done: [[880, 0, 0.09], [1174, 0.09, 0.16]],
    approval: [[880, 0, 0.07], [880, 0.13, 0.07], [880, 0.26, 0.11]],
    question: [[1174, 0, 0.09], [880, 0.10, 0.16]],
  };
  var CHIME_GAIN = 0.05;
  /* A context made before anyone has clicked or typed in the page starts suspended under the browser's autoplay rule
     and plays nothing. Each chime resumes it first, and so does the first click or key in the page. A refused resume()
     never settles, so the chime is dropped after RESUME_WAIT_MS rather than sounding at some later click. */
  var RESUME_WAIT_MS = 300;
  function audioCtx() {
    var Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    if (!audio || audio.state === 'closed') { try { audio = new Ctor(); } catch (e) { audio = null; } }
    return audio;
  }
  function unlockAudio() {
    var ac = audioCtx();
    if (ac && ac.state === 'suspended' && typeof ac.resume === 'function') { try { ac.resume(); } catch (e) { /* refused */ } }
  }
  try {
    document.addEventListener('pointerdown', unlockAudio, true);
    document.addEventListener('keydown', unlockAudio, true);
  } catch (e) { /* no document events */ }
  /* The host writes a line for the page's first chime and for each one that was not heard. */
  var toldChime = false;
  function tellChime(kind, state) {
    if (toldChime && state === 'running') return;
    toldChime = true;
    post({ kind: 'chime', sound: String(kind), state: String(state) });
  }
  function chime(kind) {
    var ac = audioCtx();
    if (!ac) { tellChime(kind, 'unavailable'); return; }
    var play = function () {
      try {
        var steps = TONES[kind] || TONES.done, t0 = ac.currentTime;
        steps.forEach(function (step) {
          var at = t0 + step[1], dur = step[2];
          var o = ac.createOscillator(), g = ac.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(step[0], at);
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(CHIME_GAIN, at + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
          o.connect(g); g.connect(ac.destination);
          o.start(at); o.stop(at + dur + 0.02);
        });
      } catch (e) { /* no audio here */ }
      tellChime(kind, ac.state);
    };
    if (ac.state !== 'suspended' || typeof ac.resume !== 'function') { play(); return; }
    var settled = false;
    var go = function () {
      if (settled) return;
      settled = true;
      if (ac.state === 'running') play(); else tellChime(kind, ac.state);
    };
    try { Promise.resolve(ac.resume()).then(go, go); } catch (e) { go(); }
    setTimeout(go, RESUME_WAIT_MS);
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
   * An outline round the context meter in the message box - this script's own while it is drawn, Codex's donut otherwise
   * - once LOW_AT percent or more of the window is used; Codex's own only fades its label past half. Codex compacts at 90% of the model's full window and the meter
   * counts against the window Codex reports, 95% of the full one, so on the meter compaction falls at 0.9 / 0.95, about
   * 94.7%; LOW_AT is 15 points before that, which is when Claude Code Extras outlines its own meter. Codex draws it only while its own setting is on. It is the
   * image in the composer whose accessible label carries a percentage; the label is localised, so only the number is
   * read. Checked on the approval watcher's pass, which already sees the composer change, and on the marks' pass. Only a
   * class goes on Codex's element.
   */
  var LOW_CLASS = 'codex-extras-ctx-low', LOW_AT = 80;
  var COMPOSER_SEL = '[data-codex-composer-root],[data-codex-composer]', METER_SEL = 'span[role="img"][aria-label]';
  var meter = { found: false, percent: null, low: false, ours: false, oursPercent: null };
  function markLowContext() {
    var found = codexMeter(), ours = meterBtn && meterBtn.isConnected && usage ? meterBtn : null;
    var target = ours || (found && !codexMeterHidden ? found.el : null);
    var pct = ours ? shareOf(usage) : found ? found.pct : null;
    var low = !!(target && view.lowContext !== false && pct >= LOW_AT);
    var flagged = all(document, '.' + LOW_CLASS);
    for (var k = 0; k < flagged.length; k++) if (flagged[k] !== target || !low) flag(flagged[k], LOW_CLASS, false);
    if (target && low) { flag(target, LOW_CLASS, true); if (!sheet || !sheet.isConnected) restyle(); }
    meter = { found: !!found, percent: found ? found.pct : null, low: low, ours: !!ours, oursPercent: ours ? Math.round(shareOf(usage)) : null };
  }

  /*
   * This script adds three controls to Codex's message-box toolbar: an information button and a chime button straight
   * after Codex's permissions button, and a context meter just left of the model picker, where Codex draws its own
   * meter. The toolbar row is a grid whose left column is as wide as its content and whose right group is pushed to the
   * right edge, so adding to either group leaves Codex's buttons where they are, as long as the gap between the groups
   * is wide enough (rowFits). When it does not, all three go to a row of this script's own on <body>,
   * just below the box's frame, placed by measuring the box; that row takes no pointer events, only its buttons do.
   * Codex's redraws can drop or move what was added, and each pass of either observer puts it back. With the master
   * switch off, or with no box recognised, nothing is drawn.
   *
   * The information comes from the host. Clicking a value sends back only its position in the list, and the host copies
   * it from its own copy, so no text leaves the page. The meter draws the usage the host sends (codex-extras-usage),
   * and a click on it asks the host to compact the conversation, sending nothing but an id.
   */
  var bar = null, tools = null, infoBtn = null, muteBtn = null, meterBtn = null, infoBox = null, infoAsk = '', barWired = false;
  var usage = null;
  /*
   * The two glyphs, drawn rather than taken from a font: a font's information sign and note are of different sizes
   * from each other and from one machine to the next, and Codex's own icons are drawn. Both are line drawings in a
   * 16-unit box, inked about as tall as Codex's toolbar icons; the note is struck through while chimes are off.
   */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgOf(box, size, parts) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + box + ' ' + box);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'block';
    for (var i = 0; i < parts.length; i++) {
      var p = document.createElementNS(SVG_NS, parts[i].tag);
      for (var k in parts[i].attrs) p.setAttribute(k, parts[i].attrs[k]);
      svg.appendChild(p);
    }
    return svg;
  }
  var icon = function (parts) { return svgOf(16, ICON_PX, parts); };
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
  /* The ring as Codex draws its own meter: a faint track and the share in use as an arc from the top, in a 12-unit box. */
  var ringIcon = function () {
    var ring = { cx: '6', cy: '6', r: '5', stroke: 'currentColor', 'stroke-width': '2', fill: 'none' };
    return svgOf(12, 12, [{ tag: 'circle', attrs: mix(ring, { opacity: '0.16' }) },
      { tag: 'circle', attrs: mix(ring, { 'stroke-linecap': 'round', pathLength: '100', 'stroke-dasharray': '100', 'stroke-dashoffset': '100',
        transform: 'rotate(-90 6 6)' }) }]);
  };
  /*
   * Above Codex's content and below every overlay it draws. Codex puts its content at z-index 0 to 20; the lowest layer
   * it gives a popover portalled to <body> is z-30 (zIndexClassName "z-30"), its menus and dialogs use z-50 or the menu
   * variable's 70, and its overlay ceiling is --max-app-overlay-z-index, 2147480000. The box that opens from a button is
   * one above the button, still under all of those.
   */
  var Z_BELOW_CODEX = 25, Z_BELOW_CODEX_BOX = 27;
  /*
   * The row below the message box, which holds the buttons on the left when the toolbar has no room for them, and the
   * figures on the right. It starts ROW_GAP below the box's frame, and is as tall as one of Codex's own toolbar icons,
   * which is also the size the glyphs are drawn at there. Codex leaves less room than that under the box, so while the
   * row is drawn the stylesheet gives the box ROW_ROOM more bottom margin, which takes that much height from the
   * conversation above it.
   */
  var ROW_GAP = 2, ROW_ROOM = 4, ICON_PX = 16;
  var iconPx = function (root) {
    var svg = root ? one(root, 'button svg') : null, h = 0;
    try { h = svg ? Math.round(svg.getBoundingClientRect().height) : 0; } catch (e) { h = 0; }
    return h >= 10 && h <= 24 ? h : ICON_PX;
  };
  var rectOf = function (el) { try { return el ? el.getBoundingClientRect() : null; } catch (e) { return null; } };
  var bottomOf = function (r) { return typeof r.bottom === 'number' ? r.bottom : (r.top || 0) + (r.height || 0); };
  var rightOf = function (r) { return typeof r.right === 'number' ? r.right : (r.left || 0) + (r.width || 0); };
  /* Where the row below the box goes: { top, left, right, size } in the page, or null with no message box recognised. */
  function rowPlace() {
    var root = document.body ? composerRoot() : null, r = rectOf(root);
    if (!r || !(r.width > 0)) return null;
    var size = iconPx(root), vh = +globalThis.innerHeight || 0, vw = +globalThis.innerWidth || 0;
    var top = bottomOf(r) + ROW_GAP;
    if (vh && top > vh - size) top = vh - size;
    return { top: Math.round(top), left: Math.round(r.left || 0), right: vw ? Math.max(0, Math.round(vw - (r.left || 0) - (r.width || 0))) : 8, size: size };
  }

  /*
   * Codex's toolbar row. Its buttons are found by the attributes Codex gives them for its own keyboard navigation and
   * for its model menu, never by class: the permissions button (the add-context one when that is missing) on the left,
   * the model picker on the right. Each sits in one of Codex's flex rows, the left group or the right one. When Codex
   * wraps the button in an element of its own (a tooltip trigger with display: contents), the new control has to go
   * next to that wrapper, so `slotOf` climbs to the node whose parent lays out the row.
   */
  var PERMS_SEL = '[data-composer-navigation-target="permissions"]', ADD_SEL = '[data-composer-navigation-target="add-context"]',
    MODEL_SEL = '[data-codex-intelligence-trigger]';
  var styleOf = function (el) { try { return typeof getComputedStyle === 'function' ? getComputedStyle(el) : null; } catch (e) { return null; } };
  function slotOf(el, root) {
    for (var n = el, i = 0; n && i < 5; n = n.parentElement, i++) {
      var p = n.parentElement;
      if (!p || p === root) return null;
      var s = styleOf(p), d = s ? String(s.display || '') : '';
      if ((d === 'flex' || d === 'inline-flex') && String(s.flexDirection || 'row').indexOf('column') !== 0) return n;
    }
    return null;
  }
  /* The two places in the row, or null when either is missing or they are not on one line. */
  function rowSlots(root) {
    var anchor = one(root, PERMS_SEL) || one(root, ADD_SEL), trigger = one(root, MODEL_SEL);
    var slotL = anchor ? slotOf(anchor, root) : null, slotR = trigger ? slotOf(trigger, root) : null;
    if (!slotL || !slotR || slotL.parentElement === slotR.parentElement) return null;
    var a = rectOf(slotL), b = rectOf(slotR);
    if (!a || !b || !(a.height > 0) || !(b.height > 0) || (a.top || 0) >= bottomOf(b) || (b.top || 0) >= bottomOf(a)) return null;
    return { left: slotL.parentElement, slotL: slotL, right: slotR.parentElement, slotR: slotR };
  }
  /* How far an element reaches, its children's reach when it has no box of its own (display: contents). */
  function reach(el) {
    var r = rectOf(el);
    if (r && r.width > 0) return { l: r.left || 0, r: rightOf(r) };
    var out = null, kids = el.children || [];
    for (var i = 0; i < kids.length; i++) {
      var k = rectOf(kids[i]);
      if (k && k.width > 0) out = out ? { l: Math.min(out.l, k.left || 0), r: Math.max(out.r, rightOf(k)) } : { l: k.left || 0, r: rightOf(k) };
    }
    return out;
  }
  /* The room between the two groups: from where the left one's content ends to where the right one's begins. */
  function rowRoom(s) {
    var end = -Infinity, start = Infinity, k, x;
    for (k = 0; k < s.left.children.length; k++) { x = reach(s.left.children[k]); if (x) end = Math.max(end, x.r); }
    for (k = 0; k < s.right.children.length; k++) { x = reach(s.right.children[k]); if (x) start = Math.min(start, x.l); }
    return isFinite(end) && isFinite(start) ? start - end : -1;
  }
  /*
   * Whether Codex's right group is being squeezed: once the row is out of room, the boxes holding that group shrink
   * below what it needs and it overflows them to the right, over Codex's send button, while the room measured between
   * the groups still looks fine. So an overflow in any box from the group up to the toolbar's grid counts as no room.
   */
  function squeezed(s) {
    for (var n = s.right, i = 0; n && i < 6 && n !== document.body; n = n.parentElement, i++) {
      var cw = +n.clientWidth || 0, sw = +n.scrollWidth || 0;
      if (cw > 0 && sw > cw + 1) return true;
      if (n.hasAttribute && n.hasAttribute('data-composer-footer-responsive')) break;
    }
    return false;
  }
  /*
   * This script's controls stay in Codex's row while at least ROW_KEEP is left between the groups and nothing of
   * Codex's right group has moved or overflowed. Out of the row, they go back in only once the room is what
   * they took last time plus ROW_KEEP plus ROW_AGAIN, so a window resized near the edge does not move them back and
   * forth. Their width is the gap before they went in minus the gap after, and at least
   * the gap that was there when they did not fit, so a failed attempt is not repeated until the row is wider. The
   * measurement is discarded whenever the set of controls drawn changes.
   */
  var ROW_KEEP = 8, ROW_AGAIN = 16;
  var rowMode = '', rowNeed = -1, rowSig = '';
  function intoRow(s) {
    dress('row');
    if (tools && !(tools.parentElement === s.left && tools.previousElementSibling === s.slotL)) s.left.insertBefore(tools, s.slotL.nextSibling);
    if (meterBtn && !(meterBtn.parentElement === s.right && meterBtn.nextElementSibling === s.slotR)) s.right.insertBefore(meterBtn, s.slotR);
  }
  function rowFits(s, at) {
    var sig = (infoBtn ? 'i' : '') + (muteBtn ? 'm' : '') + (meterBtn ? 'c' : '') + (codexMeterHidden ? 'h' : '');
    if (sig !== rowSig) { rowSig = sig; rowNeed = -1; }
    if (rowMode === 'row') {
      intoRow(s);
      var left = rowRoom(s);
      if (left >= ROW_KEEP && !squeezed(s)) return true;
      toBar(at);
      var out = rowRoom(s);
      rowNeed = Math.max(0, out - left, out - ROW_KEEP + 1);
      return false;
    }
    var free = rowRoom(s), was = rectOf(s.slotR), wasLeft = was ? was.left || 0 : 0;
    if (rowNeed >= 0 && free < rowNeed + ROW_KEEP + ROW_AGAIN) return false;
    intoRow(s);
    var after = rowRoom(s), now = rectOf(s.slotR);
    var moved = !!(was && now && Math.abs((now.left || 0) - wasLeft) > 0.5);
    if (after >= ROW_KEEP && !moved && !squeezed(s)) { rowNeed = Math.max(0, free - after); return true; }
    toBar(at);
    rowNeed = Math.max(0, free - after, free - ROW_KEEP + 1);
    return false;
  }

  /* A hover label drawn by this script, because a native title is not reliably shown in Codex's page. It is created on
     hover and removed on leave or click; a message shown after a click (flash) removes itself after FLASH_MS. */
  var labelBox = null, FLASH_MS = 3000;
  function hideLabel() { if (labelBox) { try { labelBox.remove(); } catch (e) { /* gone */ } labelBox = null; } }
  function showLabel(el, said) {
    var text = said || (el && el.getAttribute('aria-label'));
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
    var r = rectOf(el), b = rectOf(box);
    if (r && b) {
      var vw = +globalThis.innerWidth || 0;
      box.style.left = Math.max(8, vw ? Math.min(vw - (b.width || 0) - 8, r.left) : r.left) + 'px';
      box.style.top = Math.max(8, r.top - (b.height || 0) - 6) + 'px';
    }
    labelBox = box;
  }
  function flash(el, text) {
    showLabel(el, text);
    var box = labelBox;
    setTimeout(function () { if (labelBox === box) hideLabel(); }, FLASH_MS);
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
  var gone = function (el) { if (el) { try { el.remove(); } catch (e) { /* gone */ } } return null; };
  function dropBar() {
    hideLabel();
    ctxHideNow();
    bar = gone(bar); tools = gone(tools); meterBtn = gone(meterBtn); infoBox = gone(infoBox); ctxBox = gone(ctxBox);
    infoBtn = muteBtn = null;
    rowMode = '';
  }
  /* A press keeps the caret where it is in Codex's message box, and a click goes no further than the button. */
  function barButton(mark, label, onClick) {
    var b = document.createElement('button');
    b.setAttribute(MARK, mark);
    b.setAttribute('type', 'button');
    b.setAttribute('tabindex', '-1');
    if (label) labelled(b, label);
    b.addEventListener('mousedown', function (ev) { try { ev.preventDefault(); } catch (e) { /* none */ } });
    b.addEventListener('click', function (ev) { try { ev.stopPropagation(); } catch (e) { /* none */ } onClick(); });
    return b;
  }
  /*
   * In Codex's toolbar row each control copies the classes of a Codex button, read
   * from the page rather than hard-coded, so it gets that button's size, colour and hover in any build: the add-context
   * button's for the two icons, the permissions pill's for the meter. In the row below the box they are as small as
   * that row, with no background.
   */
  var BAR_BUTTON_CSS = 'pointer-events:auto;cursor:pointer;user-select:none;padding:0 4px;border-radius:3px;border:0;margin:0;'
    + 'background:none;color:inherit;font:inherit;display:flex;align-items:center;';
  var ROW_BUTTON_CSS = 'pointer-events:auto;flex-shrink:0;';
  var ROW_FALLBACK_CSS = 'pointer-events:auto;flex-shrink:0;cursor:pointer;min-width:28px;padding:0 6px;border:0;margin:0;'
    + 'border-radius:9999px;background:none;color:var(--vscode-descriptionForeground,#9d9d9d);display:flex;align-items:center;'
    + 'justify-content:center;gap:4px;font:12px var(--vscode-font-family,sans-serif);';
  function dressOne(el, cls, css, key, height) {
    if (!el || el.getAttribute(MARK + '-dress') === key) return;
    el.setAttribute(MARK + '-dress', key);
    if (cls) el.setAttribute('class', cls); else el.removeAttribute('class');
    el.style.cssText = css;
    el.style.height = height || '';
  }
  function dress(mode) {
    var root = composerRoot(), size = mode === 'row' ? ICON_PX : iconPx(root);
    var iconCls = mode === 'row' && root ? String((one(root, ADD_SEL) || { getAttribute: function () { return ''; } }).getAttribute('class') || '') : '';
    var pillCls = mode === 'row' && root ? String((one(root, PERMS_SEL) || { getAttribute: function () { return ''; } }).getAttribute('class') || '') : '';
    var key = mode + size + iconCls.length + ':' + pillCls.length;
    [infoBtn, muteBtn].forEach(function (b) {
      if (!b) return;
      if (mode === 'row') dressOne(b, iconCls, iconCls ? ROW_BUTTON_CSS : ROW_FALLBACK_CSS + 'padding:0;', key, iconCls ? '' : '28px');
      else dressOne(b, '', BAR_BUTTON_CSS, key, size + 'px');
      var svg = one(b, 'svg'), px = String(size);
      if (svg && svg.getAttribute('width') !== px) { svg.setAttribute('width', px); svg.setAttribute('height', px); }
    });
    if (tools) dressOne(tools, '', mode === 'row' ? 'display:flex;align-items:center;gap:5px;flex-shrink:0;pointer-events:none;'
      : 'display:flex;gap:2px;pointer-events:none;', key);
    if (meterBtn) {
      if (mode === 'row') dressOne(meterBtn, pillCls, pillCls ? ROW_BUTTON_CSS : ROW_FALLBACK_CSS, key, pillCls ? '' : '28px');
      else dressOne(meterBtn, '', BAR_BUTTON_CSS + 'gap:3px;font:11px var(--vscode-font-family,sans-serif);', key, size + 'px');
    }
  }
  /* Everything into the row below the box. */
  function toBar(at) {
    dress('bar');
    if (!bar || !bar.isConnected) {
      bar = gone(bar);
      bar = document.createElement('div');
      bar.setAttribute(MARK, 'bar');
      bar.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX + ';pointer-events:none;display:flex;align-items:center;gap:2px;'
        + 'font:11px var(--vscode-font-family,sans-serif);color:var(--vscode-descriptionForeground,#888);';
      document.body.appendChild(bar);
    }
    if (tools && (tools.parentElement !== bar || tools.previousElementSibling)) bar.insertBefore(tools, bar.firstChild);
    if (meterBtn && (meterBtn.parentElement !== bar || meterBtn.previousElementSibling !== tools)) bar.insertBefore(meterBtn, tools ? tools.nextSibling : bar.firstChild);
    if (at) { bar.style.left = at.left + 'px'; bar.style.top = at.top + 'px'; }
  }
  /* The controls asked for, made once and kept while they are wanted. */
  function build(wantInfo, wantMute, wantMeter) {
    if (wantInfo || wantMute) {
      if (!tools) { tools = document.createElement('div'); tools.setAttribute(MARK, 'tools'); }
      if (wantInfo && !infoBtn) {
        infoBtn = barButton('bar-button', 'About this conversation: its thread id, the process of Codex\'s server, the folder it '
          + 'started in, its rollout and size, the context in use and the tokens it used. Click a value to copy it.', toggleInfo);
        infoBtn.appendChild(infoIcon());
        tools.insertBefore(infoBtn, tools.firstChild);
      }
      if (!wantInfo && infoBtn) { infoBtn = gone(infoBtn); closeInfo(); }
      if (wantMute && !muteBtn) {
        muteBtn = barButton('bar-button', 'Chimes', function () { chimeAsked = true; post({ kind: 'toggleChime' }); });
        muteBtn.appendChild(noteIcon());
        tools.appendChild(muteBtn);
      }
      if (!wantMute && muteBtn) muteBtn = gone(muteBtn);
    } else { tools = gone(tools); infoBtn = muteBtn = null; closeInfo(); }
    if (wantMeter && !meterBtn) {
      meterBtn = barButton('meter', '', askCompact);
      var ringBox = document.createElement('span');
      ringBox.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0;';
      ringBox.appendChild(ringIcon());
      var pct = document.createElement('span');
      pct.setAttribute(MARK + '-pct', '');
      meterBtn.appendChild(ringBox);
      meterBtn.appendChild(pct);
      meterBtn.addEventListener('mouseenter', function () { ctxEnter(true); });
      meterBtn.addEventListener('mouseleave', function () { ctxEnter(false); });
    }
    if (!wantMeter && meterBtn) { meterBtn = gone(meterBtn); ctxHideNow(); }
  }
  function placeBar() {
    placeStrip();
    var on = view.buttons !== false;
    var wantInfo = on && view.infoButton !== false, wantMute = on && view.chimeButton !== false;
    var wantMeter = on && view.contextMeter !== false && !!usage;
    var root = document.body && (wantInfo || wantMute || wantMeter) ? composerRoot() : null;
    var at = root ? rowPlace() : null;
    if (!at) { dropBar(); hideCodexMeter(false); markLowContext(); restyleIfOn(); return; }
    build(wantInfo, wantMute, wantMeter);
    hideCodexMeter(!!meterBtn);
    var s = rowSlots(root);
    if (s && rowFits(s, at)) { rowMode = 'row'; bar = gone(bar); } else { rowMode = 'bar'; toBar(at); }
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
    if (muteBtn) {
      var muted = view.chime === false;
      var slash = one(muteBtn, '[data-codex-extras-mute]');
      if (slash) { var vis = muted ? 'visible' : 'hidden'; if (slash.getAttribute('visibility') !== vis) slash.setAttribute('visibility', vis); }
      if (muteBtn.getAttribute(MARK + '-muted') !== (muted ? 'true' : 'false')) muteBtn.setAttribute(MARK + '-muted', muted ? 'true' : 'false');
      var dim = muted ? '0.45' : rowMode === 'row' ? '' : '0.75';
      if (muteBtn.style.opacity !== dim) muteBtn.style.opacity = dim;
      labelled(muteBtn, muted ? 'Chimes are off: click to turn them on (codexPlus.chime)' : 'Chimes are on: click to turn them off (codexPlus.chime)');
    }
    if (infoBtn && rowMode !== 'row' && infoBtn.style.opacity !== '0.75') infoBtn.style.opacity = '0.75';
    drawMeter();
    markLowContext();
    restyleIfOn();
  }
  function restyleIfOn() { if (anythingOn() || view.buttons !== false) restyle(); }
  function toggleInfo() {
    if (infoOpen()) { closeInfo(); return; }
    infoAsk = 'info-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    post({ kind: 'infoAsk', id: infoAsk });
  }
  function showInfo(m) {
    if (!infoBtn || !infoBtn.isConnected || m.id !== infoAsk || !Array.isArray(m.rows)) return;
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
    var r = rectOf(infoBtn), vh = +globalThis.innerHeight || 0, vw = +globalThis.innerWidth || 0;
    infoBox.style.left = Math.round(r ? Math.max(8, vw ? Math.min(r.left || 0, vw - 436) : r.left || 0) : 8) + 'px';
    infoBox.style.bottom = Math.round(vh && r ? Math.max(4, vh - (r.top || 0) + 4) : 28) + 'px';
    infoBox.style.display = 'block';
  }

  /*
   * Codex's own context meter, which it draws only while its setting Show context window usage is on. While this
   * script's meter is drawn, Codex's is hidden, so the row never shows two different percentages: Codex divides the last
   * model call's input and output by the window, while this script uses the input alone, as the work plan plugin's
   * compaction marks and the line beside each reply do. Hiding it only adds a class to the node that holds Codex's
   * meter in the row, and the class is removed as soon as this script's meter is not drawn.
   */
  var HIDE_CLASS = 'codex-extras-ctx-hidden', codexMeterHidden = false;
  function codexMeter() {
    var boxes = all(document, COMPOSER_SEL);
    for (var b = 0; b < boxes.length; b++) {
      var spans = all(boxes[b], METER_SEL);
      for (var i = 0; i < spans.length; i++) {
        if (spans[i].closest && spans[i].closest('[' + MARK + ']')) continue;
        var m = /(\d+(?:[.,]\d+)?)\s*%/.exec(String(spans[i].getAttribute('aria-label') || ''));
        if (m) return { el: spans[i], pct: parseFloat(m[1].replace(',', '.')), root: boxes[b] };
      }
    }
    return null;
  }
  function hideCodexMeter(hide) {
    var found = hide ? codexMeter() : null, slot = found ? slotOf(found.el, found.root) || found.el : null;
    var flagged = all(document, '.' + HIDE_CLASS);
    for (var k = 0; k < flagged.length; k++) if (flagged[k] !== slot) flag(flagged[k], HIDE_CLASS, false);
    if (slot) flag(slot, HIDE_CLASS, true);
    codexMeterHidden = !!slot;
  }

  /* The meter's ring, its number, and its accessible label, from the host's usage. */
  var shareOf = function (u) { return u && u.window > 0 ? Math.max(0, Math.min(100, 100 * u.used / u.window)) : 0; };
  function drawMeter() {
    if (!meterBtn || !usage) return;
    var share = shareOf(usage), text = Math.round(share) + '%';
    var arc = meterBtn.querySelectorAll('circle')[1], off = (100 - share).toFixed(2);
    if (arc && arc.getAttribute('stroke-dashoffset') !== off) arc.setAttribute('stroke-dashoffset', off);
    var pct = one(meterBtn, '[' + MARK + '-pct]');
    if (pct && pct.textContent !== text) pct.textContent = text;
    var label = 'Context: ' + text + ' of the window in use. Click to compact this conversation now.';
    if (meterBtn.getAttribute('aria-label') !== label) meterBtn.setAttribute('aria-label', label);
  }

  /*
   * The figures behind the meter, shown on hover in the layout of Claude Code Plus's context breakdown: the model and
   * the share in use at the top, one bar across the window, then a row per figure. Everything in it was already sent by
   * the host, so nothing is requested; the box opens after the pointer has rested on the meter for CTX_OPEN_MS, so a
   * pointer just passing over opens nothing.
   */
  var ctxBox = null, ctxOpenAt = 0, ctxShutAt = 0, ctxOverMeter = false, ctxOverBox = false;
  var CTX_OPEN_MS = 300, CTX_SHUT_MS = 200;
  var kfmt = function (n) {
    if (typeof n !== 'number' || !isFinite(n)) return '-';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  };
  var pctOf = function (n, of) { if (!(of > 0)) return ''; var v = 100 * n / of; return v < 0.1 && v > 0 ? '<0.1%' : v.toFixed(1) + '%'; };
  function ctxRow(name, value, share, dim) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;padding:1px 0;' + (dim ? 'opacity:.65;' : '');
    var a = document.createElement('span'), b = document.createElement('span'), c = document.createElement('span');
    a.textContent = name;
    a.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    b.textContent = value;
    b.style.cssText = 'flex:0 0 auto;width:62px;text-align:right;font-variant-numeric:tabular-nums;';
    c.textContent = share || '';
    c.style.cssText = 'flex:0 0 auto;width:48px;text-align:right;opacity:.75;font-variant-numeric:tabular-nums;';
    row.appendChild(a); row.appendChild(b); row.appendChild(c);
    return row;
  }
  function ctxNote(text) {
    var d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = 'opacity:.55;padding:1px 0 3px 0;';
    return d;
  }
  function ctxHead(title) {
    var d = document.createElement('div');
    d.textContent = title;
    d.style.cssText = 'font-weight:600;margin-top:8px;padding-top:5px;border-top:1px solid var(--vscode-widget-border,rgba(255,255,255,.12));';
    return d;
  }
  function ctxRender() {
    var u = usage;
    ctxBox.textContent = '';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;gap:10px;font-weight:600;margin-bottom:6px;';
    var model = document.createElement('span');
    model.textContent = [u.model, u.effort].filter(Boolean).join(' ');
    model.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    var figs = document.createElement('span');
    figs.textContent = kfmt(u.used) + ' / ' + kfmt(u.window) + ' tokens (' + Math.round(shareOf(u)) + '%)';
    figs.style.cssText = 'flex:0 0 auto;font-variant-numeric:tabular-nums;';
    head.appendChild(model); head.appendChild(figs);
    ctxBox.appendChild(head);
    /* The window as one bar: what is in use, and a mark where Codex compacts. */
    var track = document.createElement('div');
    track.style.cssText = 'position:relative;height:6px;border-radius:3px;overflow:hidden;margin-bottom:8px;'
      + 'background:var(--vscode-widget-border,rgba(255,255,255,.10));';
    var seg = document.createElement('div');
    seg.style.cssText = 'height:100%;width:' + shareOf(u).toFixed(2) + '%;background:var(--vscode-charts-blue,#3794ff);';
    track.appendChild(seg);
    if (u.line > 0) {
      var mark = document.createElement('div');
      mark.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;left:calc(' + Math.min(100, 100 * u.line / u.window).toFixed(2) + '% - 1px);'
        + 'background:var(--vscode-editorWarning-foreground,#cca700);';
      track.appendChild(mark);
    }
    ctxBox.appendChild(track);
    ctxBox.appendChild(ctxRow('In context', kfmt(u.used), pctOf(u.used, u.window)));
    ctxBox.appendChild(ctxRow('Free', kfmt(Math.max(0, u.window - u.used)), pctOf(Math.max(0, u.window - u.used), u.window), true));
    if (u.line > 0) {
      ctxBox.appendChild(ctxRow('Auto-compact at', kfmt(u.line), pctOf(u.line, u.window)));
      ctxBox.appendChild(ctxNote((u.used < u.line ? kfmt(u.line - u.used) + ' to go' : 'reached') + ' · '
        + (u.lineFrom === 'config' ? 'model_auto_compact_token_limit in config.toml' : '90% of the model\'s full window')));
    }
    var t = u.total;
    if (t) {
      ctxBox.appendChild(ctxHead('This conversation'));
      ctxBox.appendChild(ctxRow('Input', kfmt(t.input)));
      ctxBox.appendChild(ctxRow('Cached input', kfmt(t.cached), '', true));
      ctxBox.appendChild(ctxRow('Output', kfmt(t.output)));
      ctxBox.appendChild(ctxRow('Reasoning', kfmt(t.reasoning), '', true));
      ctxBox.appendChild(ctxRow('Total', kfmt(t.total)));
    }
    var foot = ctxNote('Click to compact now.');
    foot.style.marginTop = '6px';
    ctxBox.appendChild(foot);
  }
  function ctxShow() {
    if (!meterBtn || !meterBtn.isConnected || !usage || !document.body) return;
    if (!ctxBox || !ctxBox.isConnected) {
      ctxBox = document.createElement('div');
      ctxBox.setAttribute(MARK, 'context');
      ctxBox.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX_BOX + ';display:none;width:300px;max-width:calc(100vw - 16px);'
        + 'box-sizing:border-box;padding:8px 10px;border-radius:5px;font:11px var(--vscode-font-family,sans-serif);line-height:1.5;'
        + 'background:var(--vscode-editorHoverWidget-background,rgba(30,30,30,.99));color:var(--vscode-editorHoverWidget-foreground,#ddd);'
        + 'border:1px solid var(--vscode-editorHoverWidget-border,rgba(255,255,255,.18));box-shadow:0 4px 14px rgba(0,0,0,.5);';
      ctxBox.addEventListener('mouseenter', function () { ctxOverBox = true; if (ctxShutAt) { clearTimeout(ctxShutAt); ctxShutAt = 0; } });
      ctxBox.addEventListener('mouseleave', function () { ctxOverBox = false; ctxLater(); });
      document.body.appendChild(ctxBox);
    }
    hideLabel();
    ctxRender();
    var r = rectOf(meterBtn), vh = +globalThis.innerHeight || 0, vw = +globalThis.innerWidth || 0;
    ctxBox.style.bottom = Math.round(vh && r ? Math.max(8, vh - (r.top || 0) + 6) : 40) + 'px';
    ctxBox.style.right = Math.round(vw && r ? Math.max(8, vw - rightOf(r)) : 8) + 'px';
    ctxBox.style.display = 'block';
  }
  function ctxHideNow() {
    if (ctxOpenAt) { clearTimeout(ctxOpenAt); ctxOpenAt = 0; }
    if (ctxShutAt) { clearTimeout(ctxShutAt); ctxShutAt = 0; }
    if (ctxBox) ctxBox.style.display = 'none';
  }
  function ctxLater() {
    if (ctxShutAt) clearTimeout(ctxShutAt);
    ctxShutAt = setTimeout(function () { ctxShutAt = 0; if (!ctxOverMeter && !ctxOverBox && ctxBox) ctxBox.style.display = 'none'; }, CTX_SHUT_MS);
  }
  function ctxEnter(over) {
    ctxOverMeter = over;
    if (!over) { if (ctxOpenAt) { clearTimeout(ctxOpenAt); ctxOpenAt = 0; } ctxLater(); return; }
    if (ctxShutAt) { clearTimeout(ctxShutAt); ctxShutAt = 0; }
    if (ctxBox && ctxBox.style.display === 'block') { ctxShow(); return; }
    if (ctxOpenAt) clearTimeout(ctxOpenAt);
    ctxOpenAt = setTimeout(function () { ctxOpenAt = 0; if (ctxOverMeter) ctxShow(); }, CTX_OPEN_MS);
  }

  /*
   * Compacting from the meter. The host refuses while a turn runs or an approval waits, as Codex refuses its own /compact
   * then, and the page shows the message Codex itself shows in that case. Only one request is out at a time: a click
   * while one is unanswered does nothing, and if no answer comes the button is freed after COMPACT_WAIT_MS.
   */
  var COMPACT_WAIT_MS = 8000, compactAsk = '';
  var COMPACT_SAID = { started: 'Compaction started', busy: 'Compact is disabled while a chat is in progress',
    none: 'No conversation in this page yet', sent: 'Asked Codex to compact this conversation; it has not answered yet' };
  function askCompact() {
    if (compactAsk) return;
    ctxHideNow();
    var id = 'compact-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    compactAsk = id;
    post({ kind: 'compact', id: id });
    setTimeout(function () { if (compactAsk === id) compactAsk = ''; }, COMPACT_WAIT_MS);
  }
  function compacted(m) {
    if (!compactAsk || m.id !== compactAsk) return;
    compactAsk = '';
    var reason = typeof m.reason === 'string' ? m.reason.slice(0, 200) : '';
    var text = COMPACT_SAID[m.outcome] || (m.outcome === 'failed' ? 'Could not compact: ' + (reason || 'Codex refused')
      : 'Compacting is not available here' + (reason ? ': ' + reason : ''));
    if (meterBtn && meterBtn.isConnected) flash(meterBtn, text);
  }
  /* What the host sent, kept only in the shape the meter reads. */
  function usageFrom(u) {
    var n = function (x) { return typeof x === 'number' && isFinite(x) && x >= 0 ? x : null; };
    if (!u || typeof u !== 'object' || n(u.used) === null || !(n(u.window) > 0)) return null;
    var t = u.total && typeof u.total === 'object' ? u.total : null;
    return { used: u.used, window: u.window, line: n(u.line) || 0, lineFrom: u.lineFrom === 'config' ? 'config' : 'default',
      model: typeof u.model === 'string' ? u.model.slice(0, 80) : '', effort: typeof u.effort === 'string' ? u.effort.slice(0, 20) : '',
      total: t ? { input: n(t.input) || 0, cached: n(t.cached) || 0, output: n(t.output) || 0, reasoning: n(t.reasoning) || 0, total: n(t.total) || 0 } : null };
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
      approvalDue = setTimeout(function () { approvalDue = 0; watchApproval(); tellApproval(); placeBar(); }, APPROVAL_DEBOUNCE_MS);
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
   *
   * The host says an answer is coming before it navigates with the answer, so text already in the box is the user's
   * own, even text that reads like the answer, and is left alone. An answer counts as sent once the box is empty again;
   * a box holding other text by then ('changed') says nothing either way.
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
    var boxText = function () { var el = composerEditor(); return el ? squash(el.textContent) : ''; };
    if (boxText()) { reply('occupied'); return; }
    var after = function (stillThere) {
      var have = boxText();
      if (!have) reply('submitted'); else if (have === want) stillThere(); else reply('changed');
    };
    var look = function () {
      var el = composerEditor(), have = el ? squash(el.textContent) : '';
      if (el && want && have === want) {
        pressEnter(el, false);
        setTimeout(function () {
          after(function () {
            pressEnter(composerEditor(), true);
            setTimeout(function () { after(function () { reply('drafted'); }); }, SENT_CHECK_MS);
          });
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
    replyDuration: true, buttons: true, chime: true, infoButton: true, chimeButton: true, contextMeter: true };
  /* Each turn's model, effort and context as the host read them from the rollout, by turn id: { turnId: text }. They
     are placed by the turn id Codex puts on each turn (data-content-search-turn-key), never by position. */
  var hostTurns = {};
  /* Each turn's times as the host read them from the rollout, keyed by the same turn id: { u: send times of the user's
     messages in the turn, r: times of its replies, d: its duration once it has ended }. */
  var hostTurnTimes = {};
  var FIG_ATTR = 'data-codex-extras-figures';
  /* One time per user message of this conversation, in the order the rollout has them.
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
  /* As wide as Claude Code Plus makes its list, with as many characters of each message a row. */
  var RAIL_W = 26, PANEL_W = 280, ROW_CHARS = 44;
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
  /* HH:MM:SS in the user's own zone, or HH:MM when the source had no seconds, rather than showing :00 seconds that
     nobody recorded. A day other than today is prefixed as MM/DD, with the year for another year, the date format
     Claude Code Plus and the session list use. */
  function clockOf(when) {
    if (!when) return '';
    var d = new Date(when.ms), now = new Date();
    var t = p2(d.getHours()) + ':' + p2(d.getMinutes()) + (when.secs ? ':' + p2(d.getSeconds()) : '');
    if (d.toDateString() === now.toDateString()) return t;
    var md = p2(d.getMonth() + 1) + '/' + p2(d.getDate());
    return (d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '/' + md) + ' ' + t;
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
      for (var u = 0; u < users.length; u++) out.push({ kind: 'user', node: users[u], day: day, turn: key, turnEl: turn });
      var sides = all(turn, SEL.assistantSide), firstReply = true;
      for (var s = 0; s < sides.length; s++) {
        var blocks = all(sides[s], SEL.assistant);
        for (var b = 0; b < blocks.length; b++) {
          var kind = roleOf(blocks[b]) === 'user' ? 'user' : 'assistant';
          out.push({ kind: kind, node: blocks[b], day: day, turn: key, turnEl: turn, first: kind === 'assistant' && firstReply });
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
  function stampOn(host, side, text, figures, took) {
    var el = null, kids = host.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute(MARK) === 'stamp') { el = kids[i]; break; }
    }
    if (!text && !figures && !took) {
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
    var fig = (took ? (text ? ' ' : '') + took : '') + (figures ? (text || took ? ' \u00b7 ' : '') + figures : '');
    if (fig) { if (el.getAttribute(FIG_ATTR) !== fig) el.setAttribute(FIG_ATTR, fig); }
    else if (el.getAttribute(FIG_ATTR) !== null) el.removeAttribute(FIG_ATTR);
  }

  /*
   * Whether a rollout time matches the time Codex shows on a message: the same minute, or, when the page shows no date
   * for the message (that day's divider is not drawn), the same hour and minute on whatever day the rollout gives.
   */
  function agrees(when, ms, dayKnown) {
    if (dayKnown) return sameMinute(when.ms, ms);
    var a = new Date(when.ms), b = new Date(ms);
    return a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes();
  }
  /* A turn's duration as Claude Code Plus writes it: 9s, 4m12s, 1h5m. */
  function dur(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var mi = Math.floor(s / 60), rs = s % 60;
    if (mi < 60) return mi + 'm' + (rs ? rs + 's' : '');
    return Math.floor(mi / 60) + 'h' + (mi % 60) + 'm';
  }
  /*
   * Codex draws its own "Worked for" in a turn only when the turn did something before its last reply, as a button
   * that expands that activity, inside the turn but outside its messages, and the button has no attribute of its own. So any button with aria-expanded in that position is taken to be it.
   */
  var WORKED_SEL = 'button[aria-expanded]';
  function codexShowsWorked(turn) {
    var found = turn ? all(turn, WORKED_SEL) : [];
    var mine = SEL.user + ',' + SEL.assistantSide + ',' + SEL.unit + ',[' + MARK + ']';
    for (var i = 0; i < found.length; i++) if (!(found[i].closest && found[i].closest(mine))) return true;
    return false;
  }
  var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  /* The time on every message, and the words for the list. Returns the user messages in document order. */
  function stampAll(list) {
    var users = [], inTurn = {};
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind !== 'user') continue;
      list[i].at = users.length;
      users.push(list[i]);
      list[i].nth = inTurn[list[i].turn] = (inTurn[list[i].turn] || 0) + 1;
    }
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
      var tt = e.turn && own(hostTurnTimes, e.turn) ? hostTurnTimes[e.turn] : null;
      if (view.timestamps) {
        var when = e.kind === 'assistant' ? assistantWhen(e.node, e.day) : userWhenInPage(e.node, e.day);
        if (e.kind === 'user') took = when ? 'clock' : '';
        /*
         * The turn's own times are tried first. A user message takes the time at its position in the turn, when the
         * rollout has as many user messages in that turn as the page shows. A reply takes the one reply time of the
         * turn that falls in the minute Codex shows on it. Either is still checked against Codex's own clock, if any.
         */
        if (e.kind === 'user' && tt && tt.u.length === inTurn[e.turn]) {
          var mine = { ms: tt.u[e.nth - 1], secs: true };
          if (!when || agrees(when, mine.ms, e.day !== null)) { when = mine; took = 'rollout'; }
        } else if (e.kind === 'assistant' && tt && when && !when.secs) {
          var hit = null, hits = 0;
          for (var q = 0; q < tt.r.length; q++) if (agrees(when, tt.r[q], e.day !== null)) { hit = tt.r[q]; hits++; }
          if (hits === 1) when = { ms: hit, secs: true };
        } else if (e.kind === 'user' && lined) {
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
      var figures = '', length = '';
      if (e.first && e.turn) {
        lastPass.turnsKeyed++;
        var known = own(hostTurns, e.turn) ? hostTurns[e.turn] : '';
        if (known) lastPass.turnsMatched++;
        if (known && view.replyFigures !== false) { figures = known; lastPass.figuresDrawn++; }
        if (view.replyDuration !== false && tt && tt.d > 0 && !codexShowsWorked(e.turnEl)) length = dur(tt.d);
      }
      stampOn(e.node, e.kind, text, figures, length);
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
    if ((bar && bar.isConnected) || (strip && strip.style.display !== 'none')) {
      css += '[data-codex-composer-root]{margin-bottom:' + ROW_ROOM + 'px !important;}';
    }
    if (codexMeterHidden) css += '.' + HIDE_CLASS + '{display:none !important;}';
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
  var closeList = function () { if (panel) panel.style.display = 'none'; hideTip(); mirror(); };

  /*
   * The box shown beside the list for the row under the pointer, like Claude Code Plus's: the row's time and its first
   * TIP_CHARS characters, shown at once rather than after a native title's delay. It is created on hover and removed on
   * leave or click. It goes to the left of the list, level with the row. In a page too narrow for that, such as Codex's
   * sidebar, it goes over the list just below the row.
   */
  var TIP_CHARS = 220, TIP_W = 360, TIP_ROOM = 160, tipBox = null;
  function hideTip() { tipBox = gone(tipBox); }
  function showTip(row, text) {
    hideTip();
    if (!document.body || !text) return;
    var box = document.createElement('div');
    box.setAttribute(MARK, 'nav-tip');
    box.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX_BOX + ';pointer-events:none;max-width:' + TIP_W + 'px;max-height:40vh;'
      + 'overflow:hidden;padding:6px 9px;border-radius:4px;box-sizing:border-box;font:11px var(--vscode-font-family,sans-serif);line-height:1.45;'
      + 'white-space:pre-wrap;word-break:break-word;background:var(--vscode-editorHoverWidget-background,rgba(30,30,30,.98));'
      + 'color:var(--vscode-editorHoverWidget-foreground,#ddd);border:1px solid var(--vscode-editorHoverWidget-border,rgba(255,255,255,.18));'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.4);';
    box.textContent = text;
    document.body.appendChild(box);
    var r = rectOf(row), p = rectOf(panel), vw = +globalThis.innerWidth || 0, vh = +globalThis.innerHeight || 0;
    var h = (rectOf(box) || {}).height || 60, room = p ? (p.left || 0) - 16 : 0;
    if (r && p && room >= TIP_ROOM) {
      box.style.maxWidth = Math.min(TIP_W, room) + 'px';
      box.style.right = Math.round(vw - (p.left || 0) + 8) + 'px';
      box.style.top = Math.round(Math.min(Math.max(8, (r.top || 0) - 6), Math.max(8, vh - h - 8))) + 'px';
    } else if (r) {
      box.style.left = Math.round((p ? p.left : r.left) || 0) + 'px';
      box.style.width = Math.round((p ? p.width : r.width) || 0) + 'px';
      box.style.top = Math.round(bottomOf(r) + 2) + 'px';
    }
    tipBox = box;
  }

  /*
   * scrollIntoView rather than an arithmetic scrollTop: the container is Codex's own and carries its own scroll padding
   * for its sticky header, which scrollIntoView honours and a computed position does not.
   */
  function scrollToNode(node) {
    try { node.scrollIntoView({ block: 'start', behavior: 'auto' }); return; } catch (e) { /* older signature */ }
    try { node.scrollIntoView(true); } catch (e) { /* gone */ }
  }
  /*
   * Jumps to a message and keeps it there for about a second, as Claude Code Plus does: Codex's turn list mounts and
   * measures turns while the view moves, which can push the message away from where the jump left it. Every SETTLE_MS
   * the message's position in the scroller is compared with that first position, and the jump is repeated while it is
   * more than LAND_TOL off, until it has stayed put twice or SETTLE_TRIES have passed. A wheel, touch or key event means
   * the user is scrolling and ends the hold. The key listener is added on the next tick, because a jump made with , or
   * . starts while that key's own event is still propagating.
   */
  var SETTLE_MS = 80, SETTLE_TRIES = 14, LAND_TOL = 6, holdStop = null;
  function topIn(node) {
    var a = rectOf(node), b = rectOf(scrollerEl());
    return a ? (a.top || 0) - (b ? b.top || 0 : 0) : 0;
  }
  function landOn(node) {
    if (!node) return;
    if (holdStop) holdStop();
    scrollToNode(node);
    var want = topIn(node), tries = 0, still = 0, timer = 0, arm = 0, sc = scrollerEl();
    var stop = function () {
      if (timer) clearTimeout(timer);
      if (arm) clearTimeout(arm);
      timer = arm = 0;
      if (holdStop === stop) holdStop = null;
      if (sc) { try { sc.removeEventListener('wheel', stop); sc.removeEventListener('touchstart', stop); } catch (e) { /* gone */ } }
      try { document.removeEventListener('keydown', stop, true); } catch (e) { /* gone */ }
    };
    var tick = function () {
      timer = 0;
      if (holdStop !== stop) return;
      if (node.isConnected === false || ++tries > SETTLE_TRIES) { stop(); return; }
      if (Math.abs(topIn(node) - want) <= LAND_TOL) { if (++still >= 2) { stop(); return; } } else { still = 0; scrollToNode(node); }
      timer = setTimeout(tick, SETTLE_MS);
    };
    holdStop = stop;
    if (sc) { try { sc.addEventListener('wheel', stop, { passive: true }); sc.addEventListener('touchstart', stop, { passive: true }); } catch (e) { /* none */ } }
    arm = setTimeout(function () { arm = 0; if (holdStop === stop) { try { document.addEventListener('keydown', stop, true); } catch (e) { /* none */ } } }, 0);
    timer = setTimeout(tick, SETTLE_MS);
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
    b.setAttribute(MARK, 'nav-button');
    labelled(b, label);
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
    hideTip();
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
    hideTip();
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
        if (when) {
          var at = document.createElement('span');
          at.setAttribute('class', 'codex-extras-row-when');
          at.textContent = when;
          row.appendChild(at);
        }
        var body = document.createElement('span');
        body.textContent = text.slice(0, ROW_CHARS);
        row.appendChild(body);
        row.addEventListener('mouseenter', function () { showTip(row, (when ? when + '\n' : '') + text.slice(0, TIP_CHARS)); });
        row.addEventListener('mouseleave', hideTip);
        row.addEventListener('click', function (ev) {
          try { ev.stopPropagation(); } catch (e) { /* none */ }
          hideTip();
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
    if (!turns || (list && list.length && composer)) { missRun = 0; missSince = 0; missTold = false; showWarn(false); return; }
    if (!missRun) missSince = Date.now();
    missRun++;
    if (missTold) { showWarn(true); return; }
    if (missRun < MISS_PASSES || Date.now() - missSince < MISS_MS) return;
    missTold = true;
    showWarn(true);
    post({ kind: 'anchorsMissing', version: SCRIPT_VERSION, turns: turns, scroller: !!list,
      messages: list ? list.length : 0, composer: composer });
  }

  /*
   * A 16 px yellow "!" at the top right whose hover label explains the miss. It sits just inside the top of the
   * conversation's scroller, below Codex's header and its buttons, and is removed once the messages are recognised again
   * or every addition is turned off.
   */
  var warn = null;
  var WARN_SAID = 'Codex Plus: this Codex build no longer matches what the page script looks for, so the times, the list of '
    + 'your messages and their marks are not drawn. The patch itself is in place; Codex\'s page changed. '
    + '"Codex Plus: Show Status" says which part was not found.';
  function showWarn(on) {
    if (!on || !document.body || (!anythingOn() && view.buttons === false)) { warn = gone(warn); return; }
    if (!warn || !warn.isConnected) {
      warn = document.createElement('div');
      warn.setAttribute(MARK, 'warn');
      warn.textContent = '!';
      warn.style.cssText = 'position:fixed;right:4px;z-index:' + Z_BELOW_CODEX + ';width:16px;height:16px;border-radius:50%;'
        + 'display:flex;align-items:center;justify-content:center;font:700 11px var(--vscode-font-family,sans-serif);cursor:help;'
        + 'background:var(--vscode-editorWarning-foreground,#cca700);color:var(--vscode-editor-background,#1e1e1e);';
      labelled(warn, WARN_SAID);
      document.body.appendChild(warn);
    }
    var sc = rectOf(scrollerEl());
    var top = Math.round(sc && sc.height > 0 ? (sc.top || 0) + 4 : 36) + 'px';
    if (warn.style.top !== top) warn.style.top = top;
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
      buttons: { setting: view.buttons !== false, composerFound: !!composerRoot(),
        drawn: !!((tools && tools.isConnected) || (meterBtn && meterBtn.isConnected)), inToolbar: rowMode === 'row',
        info: !!(infoBtn && infoBtn.isConnected), chime: !!(muteBtn && muteBtn.isConnected) },
      /* Codex's own context meter, and whether this script outlined it. The percentage is the number Codex shows. */
      context: { meterFound: meter.found, percentUsed: meter.percent, outlined: meter.low,
        outlineSetting: view.lowContext !== false, outlineAt: LOW_AT, ours: meter.ours, oursPercent: meter.oursPercent,
        codexMeterHidden: codexMeterHidden },
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
    else if (m.type === 'codex-extras-usage') { usage = usageFrom(m.usage); if (document.body) placeBar(); }
    else if (m.type === 'codex-extras-compacted') compacted(m);
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
      var wasOn = view.chime !== false;
      view = { timestamps: m.timestamps !== false, navigation: m.navigation !== false,
        userColor: typeof m.userColor === 'string' ? m.userColor : '', userEdge: m.userEdge !== false,
        lowContext: m.lowContext !== false, replyFigures: m.replyFigures !== false, replyDuration: m.replyDuration !== false, buttons: m.buttons !== false,
        chime: m.chime !== false, infoButton: m.infoButton !== false, chimeButton: m.chimeButton !== false,
        contextMeter: m.contextMeter !== false };
      /* Turned on from this page's own button: one chime, so the user hears at once whether sound comes out. */
      if (chimeAsked) { chimeAsked = false; if (!wasOn && view.chime) chime('done'); }
      if (!anythingOn() && view.buttons === false) showWarn(false);
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
      hostTurnTimes = {};
      if (m.turnTimes && typeof m.turnTimes === 'object') {
        var times = function (a) { return Array.isArray(a) ? a.filter(function (n) { return typeof n === 'number' && isFinite(n); }).slice(0, 8) : []; };
        Object.keys(m.turnTimes).forEach(function (k) {
          var v = m.turnTimes[k];
          if (!v || typeof v !== 'object') return;
          hostTurnTimes[k] = { u: times(v.u), r: times(v.r), d: typeof v.d === 'number' && isFinite(v.d) && v.d > 0 ? v.d : 0 };
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
