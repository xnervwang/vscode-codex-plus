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
 *   - When Codex says the conversation is open in another app, which after a window reload usually means the
 *     app-server of the window before is still exiting, the page clicks its Retry for the user every few seconds for
 *     about two minutes.
 *   - When Codex replaces the page with its recovery page because one of its own modules failed to load, the host is
 *     told and loads the page again.
 *   - The id of the newest turn shown goes to the host, which is how a tab Codex opened for a new conversation is
 *     matched to the conversation it goes on to show.
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
  /* agentPlusKit comes from Agent Plus's shared page code, put in front of this script (src/webview-inject.js). */
  var kit = agentPlusKit;

  /* This script's own version. A page runs the copy it was built with, so a page left on an older patch answers a
     self-check with an older version here, which is the one case the host cannot tell from reading its own files.
     test/parts/62-selfcheck.js holds it to package.json, since a page cannot read that file. */
  var SCRIPT_VERSION = '1.8.0';

  /* Set by the Chimes button until the setting it asked for comes back. */
  var chimeAsked = false;
  /* The three sounds Claude Code Plus plays, note for note and at its volume, so someone using both hears the same thing
     for the same event (agentPlusKit.chime). The first click or key in the page unlocks audio for them. */
  try {
    document.addEventListener('pointerdown', kit.unlockAudio, true);
    document.addEventListener('keydown', kit.unlockAudio, true);
  } catch (e) { /* no document events */ }
  /* The host writes a line for the page's first chime and for each one that was not heard. */
  var toldChime = false;
  function tellChime(kind, state) {
    if (toldChime && state === 'running') return;
    toldChime = true;
    post({ kind: 'chime', sound: String(kind), state: String(state) });
  }
  function chime(kind) { kit.chime(kind, tellChime); }


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
   * is wide enough (rowFits). When it is not, they go to a line of their own inside the box, below Codex's row
   * (toLine), as Claude Code's footer wraps its buttons onto another line, the two buttons still on the left and the
   * meter on the right. A box with no footer grid gets a row of this script's own on <body> instead, just below the
   * box's frame, placed by measuring the box. Neither line takes pointer events, only its buttons do.
   * Codex's redraws can drop or move what was added, and each pass of either observer puts it back. With the main
   * switch off, or with no box recognised, nothing is drawn.
   *
   * The information comes from the host. Clicking a value sends back only its position in the list, and the host copies
   * it from its own copy, so no text leaves the page. The meter draws the usage the host sends (codex-extras-usage),
   * and a click on it asks the host to compact the conversation, sending nothing but an id.
   */
  /* Font declarations for the boxes this script draws: a fixed size, and the font family inherited from Codex's page.
     The `font` shorthand would set a family too, so each property is written separately. */
  function pageFont(px, weight) {
    return 'font-style:normal;font-weight:' + (weight || 'normal') + ';font-size:' + px + 'px;line-height:normal;font-family:inherit;';
  }
  var bar = null, line = null, lineEnd = null, tools = null, infoBtn = null, muteBtn = null, meterBtn = null, infoBox = null, infoAsk = '', barWired = false;
  var usage = null;
  /*
   * The two glyphs Claude Code Plus uses, ℹ and ♪, drawn rather than taken from a font: a font's information sign and
   * note are of different sizes from each other and from one machine to the next, and Codex's own icons are drawn.
   * Both are solid shapes in a 16-unit box, inked about as tall as Codex's toolbar icons. While chimes are off a line
   * runs straight across the note, where a strike-through would cross Claude Code Plus's.
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
  var SOLID = { fill: 'currentColor' };
  var infoIcon = function () {
    return icon([{ tag: 'circle', attrs: mix(SOLID, { cx: '8.3', cy: '3.3', r: '1.5' }) },
      { tag: 'path', attrs: mix(SOLID, { d: 'M5.9 6.1h3.5v6.4h1.5V14H5.5v-1.5h1.6V7.6H5.9z' }) }]);
  };
  var noteIcon = function () {
    return icon([{ tag: 'ellipse', attrs: mix(SOLID, { cx: '6.2', cy: '12.1', rx: '2.5', ry: '1.85', transform: 'rotate(-20 6.2 12.1)' }) },
      { tag: 'path', attrs: mix(SOLID, { d: 'M7.9 1.8h1.4v10.4H7.9z' }) },
      { tag: 'path', attrs: mix(SOLID, { d: 'M9.3 1.8c.3 1.5 1.3 2.3 2.4 3.1 1.1.8 1.6 2 1.1 3.5-.2-1.3-.8-2.1-1.7-2.7-.6-.4-1.2-.8-1.8-1.3z' }) },
      { tag: 'path', attrs: mix(LINE, { d: 'M1.5 8.5h13', 'data-codex-extras-mute': '' }) }]);
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
   * Codex's toolbar row. Its buttons are found by data-composer-navigation-target, which Codex sets for its keyboard
   * navigation, never by class: the permissions button (the add-context one when that is missing) on the left, the
   * model picker ("reasoning") on the right. Each sits in one of Codex's flex rows, the left group or the right one.
   * When Codex wraps the button in an element of its own (a tooltip trigger with display: contents), the new control
   * has to go next to that wrapper, so `slotOf` climbs to the node whose parent lays out the row.
   */
  var PERMS_SEL = '[data-composer-navigation-target="permissions"]', ADD_SEL = '[data-composer-navigation-target="add-context"]',
    MODEL_SEL = '[data-composer-navigation-target="reasoning"]';
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
  /* The grid Codex lays out the message box's input and toolbar row in, the nearest ancestor of its permissions (or
     add-context) button whose display is grid, inside the box; null when there is none. */
  function footerGrid(root) {
    var anchor = one(root, PERMS_SEL) || one(root, ADD_SEL);
    for (var n = anchor ? anchor.parentElement : null, i = 0; n && n !== root && i < 8; n = n.parentElement, i++) {
      var s = styleOf(n);
      if (s && String(s.display || '') === 'grid') return n;
    }
    return null;
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
  /* How many pixels of Codex's model picker are hidden: its label shrinks with the row, down to nothing. */
  function cutOff(slot) {
    var all = slot && slot.querySelectorAll ? slot.querySelectorAll('*') : [], most = 0;
    for (var i = 0; i < all.length && i < 40; i++) {
      var hidden = (+all[i].scrollWidth || 0) - (+all[i].clientWidth || 0);
      if (hidden <= most) continue;
      var st = styleOf(all[i]), ox = st ? String(st.overflowX || st.overflow || '') : '';
      if (ox && ox !== 'visible') most = hidden;
    }
    return most;
  }
  /* Codex draws its model picker as a bare icon if the row is full when the name is laid out, and keeps it so. */
  function pickerNamed(slot) { return !!(slot && String(slot.textContent || '').trim()); }
  /* Whether the pointer is on one of this script's controls or on a box one of them opened. */
  function pointedAt() {
    if (ctxOverMeter && meterBtn && meterBtn.isConnected) return true;
    if (ctxOverBox && ctxBox && ctxBox.isConnected && ctxBox.style.display === 'block') return true;
    try { return !!document.querySelector('[' + MARK + ']:hover'); } catch (e) { return false; }
  }
  /*
   * This script's controls stay in Codex's row while at least ROW_KEEP is left between the groups and nothing of
   * Codex's right group has moved, overflowed or had more of its model name hidden than rowCut. Out of the row, they go
   * back in only once the room is what they took last time plus ROW_KEEP plus ROW_AGAIN, so a window resized near the
   * edge does not move them back and forth. Their width is the gap before they went in minus the gap after, and at
   * least the gap that was there when they did not fit, so a failed attempt is not repeated until the row is wider.
   * The measurement is discarded whenever the set of controls drawn changes.
   */
  var ROW_KEEP = 8, ROW_AGAIN = 16;
  var rowMode = '', rowNeed = -1, rowSig = '', rowCut = 0;
  function intoRow(s) {
    dress('row');
    if (tools && !(tools.parentElement === s.left && tools.previousElementSibling === s.slotL)) s.left.insertBefore(tools, s.slotL.nextSibling);
    /* The meter, then the Agent map pill, then Codex's model picker: Claude Code's pill follows its meter. */
    if (agentsBtn && !(agentsBtn.parentElement === s.right && agentsBtn.nextElementSibling === s.slotR)) s.right.insertBefore(agentsBtn, s.slotR);
    var next = agentsBtn || s.slotR;
    if (meterBtn && !(meterBtn.parentElement === s.right && meterBtn.nextElementSibling === next)) s.right.insertBefore(meterBtn, next);
    if (line) { line = gone(line); lineEnd = null; }
  }
  function rowFits(s, at, grid) {
    var sig = (infoBtn ? 'i' : '') + (muteBtn ? 'm' : '') + (meterBtn ? 'c' : '') + (codexMeterHidden ? 'h' : '')
      + (agentsBtn ? 'a' + agentsBtn.textContent.length : '');
    if (sig !== rowSig) { rowSig = sig; rowNeed = -1; }
    /* A control taken out from under the pointer gets no mouseleave, and the box it opened would stay open. A new one,
       such as the pill when the map arrives, is still put in, since intoRow leaves the controls already there alone. */
    if (rowMode && pointedAt()) {
      if (rowMode === 'row') intoRow(s);
      return rowMode === 'row';
    }
    if (rowMode === 'row') {
      intoRow(s);
      var left = rowRoom(s), roomy = left >= ROW_KEEP && !squeezed(s) && pickerNamed(s.slotR), cut = cutOff(s.slotR);
      if (roomy && cut <= rowCut + 1) { rowCut = Math.min(rowCut, cut); return true; }
      outOfRow(at, grid);
      /* Codex hides that much of a long name without these controls too, so it is not theirs to make room for. */
      if (roomy && cutOff(s.slotR) + 1 >= cut) { intoRow(s); rowCut = cut; return true; }
      var out = rowRoom(s);
      rowNeed = Math.max(0, out - left, out - ROW_KEEP + 1);
      return false;
    }
    var free = rowRoom(s), was = rectOf(s.slotR), wasLeft = was ? was.left || 0 : 0, wasCut = cutOff(s.slotR);
    if ((rowNeed >= 0 && free < rowNeed + ROW_KEEP + ROW_AGAIN) || !pickerNamed(s.slotR)) return false;
    intoRow(s);
    var after = rowRoom(s), now = rectOf(s.slotR), cutNow = cutOff(s.slotR);
    var moved = !!(was && now && Math.abs((now.left || 0) - wasLeft) > 0.5) || cutNow > wasCut + 1;
    if (after >= ROW_KEEP && !moved && !squeezed(s)) { rowNeed = Math.max(0, free - after); rowCut = cutNow; return true; }
    outOfRow(at, grid);
    rowNeed = Math.max(0, free - after, free - ROW_KEEP + 1);
    return false;
  }

  /* A hover label drawn by this script, because a native title is not reliably shown in Codex's page
     (agentPlusKit.labels), in Claude Code Plus's look. A message shown after a click (flash) removes itself after
     FLASH_MS. */
  var FLASH_MS = 3000;
  var TIP_LOOK = 'padding:8px;background:var(--vscode-menu-background,var(--vscode-editorWidget-background,#252526));'
    + 'border:1px solid var(--vscode-inlineChatInput-border,var(--vscode-input-border,var(--vscode-widget-border,#7f7f7f66)));border-radius:8px;'
    + 'color:var(--vscode-foreground,#ccc);font-size:.9em;';
  var tips = kit.labels({ mark: [MARK, 'label'], css: 'z-index:' + Z_BELOW_CODEX_BOX + ';' + TIP_LOOK });
  var hideLabel = tips.hide, showLabel = tips.show;
  function flash(el, text) {
    showLabel(el, text);
    var box = tips.current();
    setTimeout(function () { if (tips.current() === box) hideLabel(); }, FLASH_MS);
  }
  function labelled(el, text) { tips.wire(el, text, MARK + '-labelled'); }
  var composerRoot = function () { return one(document, '[data-codex-composer-root]') || one(document, '[data-codex-composer]'); };
  /*
   * Whether Codex draws this page with no message box on purpose, as it does a sub-agent's conversation and one archived
   * while its tab is open: it then leaves out the element its message box sits in, data-thread-find-composer, as well.
   * A box missing from a page that has that element is one this script no longer recognises.
   */
  var boxWithheld = function () { return !composerRoot() && !one(document, '[data-thread-find-composer]'); };
  var infoOpen = function () { return !!(infoBox && infoBox.isConnected && infoBox.style.display === 'block'); };
  function closeInfo() { if (infoBox) infoBox.style.display = 'none'; }
  var gone = function (el) { if (el) { try { el.remove(); } catch (e) { /* gone */ } } return null; };
  function dropBar() {
    hideLabel();
    ctxHideNow();
    bar = gone(bar); tools = gone(tools); meterBtn = gone(meterBtn); infoBox = gone(infoBox); ctxBox = gone(ctxBox); agentsBtn = gone(agentsBtn);
    line = gone(line); lineEnd = null;
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
   * In Codex's toolbar row and in the controls' own line inside the box, each control copies the classes of a Codex
   * button, read from the page rather than hard-coded, so it gets that button's size, colour and hover in any build:
   * the add-context button's for the two icons, the permissions pill's for the meter. In the row below the box they
   * are as small as that row, with no background.
   */
  var BAR_BUTTON_CSS = 'pointer-events:auto;cursor:pointer;user-select:none;padding:0 4px;border-radius:3px;border:0;margin:0;'
    + 'background:none;color:inherit;font:inherit;display:flex;align-items:center;';
  var ROW_BUTTON_CSS = 'pointer-events:auto;flex-shrink:0;';
  var ROW_FALLBACK_CSS = 'pointer-events:auto;flex-shrink:0;cursor:pointer;min-width:28px;padding:0 6px;border:0;margin:0;'
    + 'border-radius:9999px;background:none;color:var(--vscode-descriptionForeground,#9d9d9d);display:flex;align-items:center;'
    + 'justify-content:center;gap:4px;' + pageFont(12);
  function dressOne(el, cls, css, key, height) {
    if (!el || el.getAttribute(MARK + '-dress') === key) return;
    el.setAttribute(MARK + '-dress', key);
    if (cls) el.setAttribute('class', cls); else el.removeAttribute('class');
    el.style.cssText = css;
    el.style.height = height || '';
  }
  function dress(mode) {
    var inBox = mode !== 'bar';
    var root = composerRoot(), size = inBox ? ICON_PX : iconPx(root);
    var iconCls = inBox && root ? String((one(root, ADD_SEL) || { getAttribute: function () { return ''; } }).getAttribute('class') || '') : '';
    var pillCls = inBox && root ? String((one(root, PERMS_SEL) || { getAttribute: function () { return ''; } }).getAttribute('class') || '') : '';
    var key = mode + size + iconCls.length + ':' + pillCls.length;
    [infoBtn, muteBtn].forEach(function (b) {
      if (!b) return;
      if (inBox) dressOne(b, iconCls, iconCls ? ROW_BUTTON_CSS : ROW_FALLBACK_CSS + 'padding:0;', key, iconCls ? '' : '28px');
      else dressOne(b, '', BAR_BUTTON_CSS, key, size + 'px');
      var svg = one(b, 'svg'), px = String(size);
      if (svg && svg.getAttribute('width') !== px) { svg.setAttribute('width', px); svg.setAttribute('height', px); }
    });
    if (tools) dressOne(tools, '', inBox ? 'display:flex;align-items:center;gap:5px;flex-shrink:0;pointer-events:none;'
      : 'display:flex;gap:2px;pointer-events:none;', key);
    if (meterBtn) {
      if (inBox) dressOne(meterBtn, pillCls, pillCls ? ROW_BUTTON_CSS : ROW_FALLBACK_CSS, key, pillCls ? '' : '28px');
      else dressOne(meterBtn, '', BAR_BUTTON_CSS + 'gap:3px;' + pageFont(11), key, size + 'px');
    }
    /* Claude Code's own pill rather than a Codex button's classes: 18 px tall in the box, as tall as the row below. In
       Codex's row it keeps a gap before the model picker; the line has a gap of its own. */
    if (agentsBtn) dressOne(agentsBtn, '', AGENTS_CSS + (mode === 'row' ? 'margin-right:6px;' : inBox ? '' : 'margin-left:4px;font-size:11px;'), key,
      (inBox ? 18 : size) + 'px');
  }
  var AGENTS_CSS = 'pointer-events:auto;flex-shrink:0;cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:4px;padding:0 8px;'
    + 'border:0;border-radius:9999px;margin:0;font:inherit;font-size:.85em;line-height:1;white-space:nowrap;color:var(--vscode-foreground,#ccc);'
    + 'background:color-mix(in srgb,var(--vscode-foreground,#ccc) 10%,transparent);';
  /*
   * Everything into the controls' own line inside the message box: the last row of Codex's footer grid, spanning
   * every column, the two buttons at its start and the meter with the Agent map pill at its end. It wraps within the
   * box's width rather than widening Codex's columns, and moves with the box as Codex lays it out. A redraw of Codex's
   * that takes it out is undone on the next pass, as for the controls in Codex's row.
   */
  var LINE_CSS = 'grid-column:1/-1;min-width:0;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;'
    + 'gap:4px 8px;pointer-events:none;';
  function toLine(grid) {
    dress('line');
    if (!line) {
      line = document.createElement('div');
      line.setAttribute(MARK, 'line');
      line.style.cssText = LINE_CSS;
      lineEnd = document.createElement('div');
      lineEnd.setAttribute(MARK, 'line-end');
      lineEnd.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:4px;min-width:0;margin-left:auto;pointer-events:none;';
      line.appendChild(lineEnd);
    }
    if (line.parentElement !== grid || line.nextElementSibling) grid.appendChild(line);
    if (lineEnd.parentElement !== line) line.appendChild(lineEnd);
    if (tools && !(tools.parentElement === line && tools.nextElementSibling === lineEnd)) line.insertBefore(tools, lineEnd);
    if (meterBtn && !(meterBtn.parentElement === lineEnd && !meterBtn.previousElementSibling)) lineEnd.insertBefore(meterBtn, lineEnd.firstChild);
    if (agentsBtn && !(agentsBtn.parentElement === lineEnd && agentsBtn.previousElementSibling === meterBtn)) {
      lineEnd.insertBefore(agentsBtn, meterBtn && meterBtn.parentElement === lineEnd ? meterBtn.nextSibling : lineEnd.firstChild);
    }
    bar = gone(bar);
  }
  function outOfRow(at, grid) { if (grid) toLine(grid); else toBar(at); }
  /* Everything into the row below the box. */
  function toBar(at) {
    dress('bar');
    if (line) { line = gone(line); lineEnd = null; }
    if (!bar || !bar.isConnected) {
      bar = gone(bar);
      bar = document.createElement('div');
      bar.setAttribute(MARK, 'bar');
      bar.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX + ';pointer-events:none;display:flex;align-items:center;gap:2px;'
        + pageFont(11) + 'color:var(--vscode-descriptionForeground,#888);';
      document.body.appendChild(bar);
    }
    if (tools && (tools.parentElement !== bar || tools.previousElementSibling)) bar.insertBefore(tools, bar.firstChild);
    if (meterBtn && (meterBtn.parentElement !== bar || meterBtn.previousElementSibling !== tools)) bar.insertBefore(meterBtn, tools ? tools.nextSibling : bar.firstChild);
    var prev = meterBtn || tools;
    if (agentsBtn && (agentsBtn.parentElement !== bar || agentsBtn.previousElementSibling !== prev)) bar.insertBefore(agentsBtn, prev ? prev.nextSibling : bar.firstChild);
    if (at) { bar.style.left = at.left + 'px'; bar.style.top = at.top + 'px'; }
  }
  /* The controls asked for, made once and kept while they are wanted. */
  function build(wantInfo, wantMute, wantMeter, wantAgents) {
    if (wantAgents && !agentsBtn) agentsBtn = makePill();
    if (!wantAgents && agentsBtn) agentsBtn = gone(agentsBtn);
    if (wantInfo || wantMute) {
      if (!tools) { tools = document.createElement('div'); tools.setAttribute(MARK, 'tools'); }
      if (wantInfo && !infoBtn) {
        infoBtn = barButton('bar-button', 'About this conversation: its thread id, the process of Codex\'s server, the folder it '
          + 'started in, its rollout and its size on disk, the model, the context in use, the tokens it used, and the token mode', toggleInfo);
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
  /*
   * The page's watcher looks at the conversation, not at the toolbar, so nothing would place the controls again when
   * the model picker's name arrives, changes, or is redrawn in a font that loads late.
   */
  var pickerSeen = null, pickerWatch = null, pickerDue = 0, fontsWired = false;
  function againSoon() { if (!pickerDue) pickerDue = setTimeout(function () { pickerDue = 0; placeBar(); }, 0); }
  function watchPicker(slot) {
    if (!fontsWired) {
      fontsWired = true;
      try { if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', againSoon); } catch (e) { /* none */ }
    }
    if (!slot || slot === pickerSeen || typeof MutationObserver !== 'function') return;
    if (pickerWatch) { try { pickerWatch.disconnect(); } catch (e) { /* gone */ } }
    pickerSeen = slot;
    pickerWatch = new MutationObserver(againSoon);
    try { pickerWatch.observe(slot, { childList: true, subtree: true, characterData: true }); } catch (e) { pickerWatch = null; }
  }
  /* The controls first: going to their own line inside the message box, or leaving it, changes the box's height, which
     the row below the box and the plan bar above it are placed by. */
  function placeBar() {
    keepEnd(function () {
      placeControls();
      placeStrip();
      placePlanBar();
    });
  }
  function placeControls() {
    var on = view.buttons !== false;
    var wantInfo = on && view.infoButton !== false, wantMute = on && view.chimeButton !== false;
    var wantMeter = on && view.contextMeter !== false && !!usage;
    var wantAgents = on && !!agentMap;
    if (!wantAgents) closeMap();
    var root = document.body && (wantInfo || wantMute || wantMeter || wantAgents) ? composerRoot() : null;
    var at = root ? rowPlace() : null;
    if (!at) { dropBar(); hideCodexMeter(false); markLowContext(); restyleIfOn(); return; }
    build(wantInfo, wantMute, wantMeter, wantAgents);
    drawPill();
    hideCodexMeter(!!meterBtn);
    var s = rowSlots(root), grid = footerGrid(root);
    watchPicker(s && s.slotR);
    if (s && rowFits(s, at, grid)) { rowMode = 'row'; bar = gone(bar); } else { rowMode = grid ? 'line' : 'bar'; outOfRow(at, grid); }
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
      var dim = muted ? '0.4' : rowMode === 'bar' ? '0.75' : '';
      if (muteBtn.style.opacity !== dim) muteBtn.style.opacity = dim;
      labelled(muteBtn, muted ? 'Chimes are muted - click to hear a chime when a turn finishes'
        : 'A chime when a turn finishes, and when Codex is waiting for you - click to mute');
    }
    if (infoBtn && rowMode === 'bar' && infoBtn.style.opacity !== '0.75') infoBtn.style.opacity = '0.75';
    drawMeter();
    markLowContext();
    restyleIfOn();
  }
  function restyleIfOn() { if (anythingOn() || view.buttons !== false) restyle(); }

  /*
   * The plan bar: one line just above the message box, saying where the conversation's work plan stands. Agent Plus's
   * shared fragment draws the bar. The host sends this page's conversation summary from src/plan-bars.js in a
   * codex-extras-plan-bar message, and a click posts only 'open' for the bar or 'answer' for its questions part.
   *
   * Like the row below the box it is this script's own element on <body>, placed by measuring the box, since nothing of
   * this script's goes inside an element Codex draws. While it is drawn the stylesheet gives the box PLAN_ROOM more top
   * margin, so the bar covers neither the conversation nor anything Codex draws above the box. Each pass of either
   * observer repositions the bar and reattaches it to <body> if a Codex redraw removed it; a ResizeObserver on the
   * message box repositions the bar when the box changes size, including as it grows taller during typing. It sits on
   * Codex's content and under every overlay Codex draws (Z_BELOW_CODEX).
   */
  var planBarApi = agentPlusPlanBar;
  var PLAN_H = 26, PLAN_GAP = 6, PLAN_ROOM = PLAN_H + PLAN_GAP;
  var planBarMsg = { on: false, summary: null }, planBar = null, planBox = null, planSizer = null, planRoomOn = false;
  var planShown = function () { return !!(planBar && planBar.el.isConnected && planBar.el.style.display !== 'none'); };
  function dropPlanBar() {
    if (planSizer) { try { planSizer.disconnect(); } catch (e) { /* gone */ } }
    planSizer = null; planBox = null;
    if (planBar) { planBar.destroy(); planBar = null; }
    var left = all(document, 'style[' + planBarApi.MARK + '-style]');
    for (var i = 0; i < left.length; i++) gone(left[i]);
    placeRail();
  }
  function makePlanBar() {
    var b = planBarApi.create(document, {
      onOpen: function () { post({ kind: 'planBar', action: 'open' }); },
      onAnswer: function () { post({ kind: 'planBar', action: 'answer' }); },
      css: 'position:fixed;z-index:' + Z_BELOW_CODEX + ';margin:0;'
    });
    b.el.setAttribute(MARK, 'plan-bar');
    return b;
  }
  function placePlanBar() {
    var root = planBarMsg.on && planBarMsg.summary && view.buttons !== false && document.body ? composerRoot() : null;
    var r = rectOf(root);
    if (!r || !(r.width > 0)) {
      dropPlanBar();
      if (planRoomOn) restyleIfOn();
      return;
    }
    /* If a redraw removed the bar's style element, the bar is made again, which adds the style back. */
    if (planBar && !one(document, 'style[' + planBarApi.MARK + '-style]')) dropPlanBar();
    if (!planBar) planBar = makePlanBar();
    if (!planBar.el.isConnected) document.body.appendChild(planBar.el);
    planBar.update(planBarMsg.summary);
    /* The room goes in before the box is measured, since a box that is not at the bottom of the page (a new
       conversation's) moves down by it. */
    if (planShown() !== planRoomOn) { restyleIfOn(); r = rectOf(root) || r; }
    var width = Math.round(r.width);
    planBar.el.style.left = Math.round(r.left || 0) + 'px';
    planBar.el.style.top = Math.max(0, Math.round(r.top || 0) - PLAN_ROOM) + 'px';
    planBar.el.style.width = width + 'px';
    planBar.fit(width);
    placeRail();
    if (planBox !== root && typeof ResizeObserver === 'function') {
      if (planSizer) { try { planSizer.disconnect(); } catch (e) { /* gone */ } }
      planBox = root;
      try { planSizer = new ResizeObserver(function () { keepEnd(placePlanBar); }); planSizer.observe(root); } catch (e) { planSizer = null; }
    }
  }

  /*
   * The Agent map: a copy of Claude Code's dialog of that name and of the "N agents" pill that opens it, with Claude
   * Code Plus's timers added. It shows this conversation's own row, its sub-agents, the work it started that still
   * runs, its wake-up and its goal, which the host sends (codex-extras-agent-map, src/agent-map.js) whenever they
   * change. The pill sits in the row with the other controls whenever there is something to show. Its dot is green
   * while any of that work runs, red while a sub-agent waits for the user, and grey once it has all ended. The dialog
   * is built when it opens and removed when it closes. Each button posts one of the host's ACTIONS; Open also posts the
   * sub-agent's id.
   */
  var agentMap = null, agentsBtn = null, mapBox = null, mapKeysWired = false;
  var Z_MAP = 28;
  var DIM = 'var(--vscode-descriptionForeground,#9d9d9d)';
  var EDGE = 'var(--vscode-inlineChatInput-border,var(--vscode-input-border,var(--vscode-widget-border,#7f7f7f66)))';
  /* The dots the tabs and the session list draw: green while a turn runs, a green ring once only work it started is
     left, red while it waits for the user. A stopped sub-agent has none, in a space of the same size, and the pill is
     grey once everything has ended. */
  var GREEN = '#22c55e', RED = '#ef4444';
  var GOAL_SHORT = { active: 'goal', paused: 'goal paused', blocked: 'goal blocked', usageLimited: 'goal: usage limit',
    budgetLimited: 'goal: budget spent', complete: 'goal done' };
  var GOAL_STATE = { active: 'in progress', paused: 'paused', blocked: 'blocked', usageLimited: 'stopped at the usage limit',
    budgetLimited: 'budget spent', complete: 'done' };
  var GOAL_RESUMABLE = ['paused', 'blocked', 'usageLimited', 'budgetLimited'];
  var PILL_TITLE = { waiting: 'An agent is waiting for you · Click to open the agent map',
    working: 'Work this conversation started is still running · Click to open the agent map', idle: 'Click to open the agent map' };
  /* The work besides sub-agents and detached commands, in the order the pill counts it: [one, more, in the dialog]. */
  var WORK = ['command', 'codexExec', 'claudeWorker', 'claudeBg'];
  var WORK_WORD = { command: ['terminal', 'terminals', 'Background terminal'], codexExec: ['codex exec', 'codex exec', 'codex exec'],
    claudeWorker: ['claude -p', 'claude -p', 'claude -p'], claudeBg: ['claude --bg', 'claude --bg', 'claude --bg'] };
  /* The dialog's line for a kind of work the host knows is running but has no entries for, as with Codex's background
     terminals in a window without /proc. */
  var WORK_BARE = { detached: 'A command it detached is still running', command: 'A background terminal is still running',
    codexExec: 'A codex exec it started is still running', claudeWorker: 'A claude -p worker it started is still running',
    claudeBg: 'A claude --bg session it started is still busy' };
  var plural = function (n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); };
  function mk(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function dotEl(state, px) {
    var css = 'display:inline-block;flex-shrink:0;box-sizing:border-box;border-radius:50%;width:' + px + 'px;height:' + px + 'px;';
    if (state === 'working') css += 'background:' + GREEN + ';';
    else if (state === 'background') css += 'border:2px solid ' + GREEN + ';';
    else if (state === 'waiting') css += 'background:' + RED + ';';
    else if (state === 'idle') css += 'background:' + DIM + ';opacity:.4;';
    var d = mk('span', css);
    d.setAttribute(MARK + '-dot', state);
    return d;
  }
  var jobsOf = function (m) { return Array.isArray(m.detached) ? m.detached : []; };
  var workOf = function (m) { return Array.isArray(m.background) ? m.background : []; };
  var kindsOf = function (m) { return Array.isArray(m.kinds) ? m.kinds : []; };
  var countOf = function (m, kind) { return workOf(m).filter(function (w) { return w.kind === kind; }).length; };
  function pillDot(m) {
    var dots = m.agents.map(function (a) { return a.dot; });
    if (dots.indexOf('waiting') >= 0) return 'waiting';
    var busy = dots.indexOf('working') >= 0 || dots.indexOf('background') >= 0 || jobsOf(m).length || workOf(m).length || kindsOf(m).length;
    return busy ? 'working' : 'idle';
  }
  /* Its label as Claude Code Plus writes it: "2 agents · 1 detached · 1 timer", each part only when there is one, and the
     running work before the timers. */
  function pillText(m) {
    var parts = [];
    if (m.agents.length) parts.push(plural(m.agents.length, 'agent'));
    if (jobsOf(m).length) parts.push(jobsOf(m).length + ' detached');
    else if (kindsOf(m).indexOf('detached') >= 0) parts.push('detached');
    for (var i = 0; i < WORK.length; i++) {
      var n = countOf(m, WORK[i]), w = WORK_WORD[WORK[i]];
      if (n) parts.push(n + ' ' + (n === 1 ? w[0] : w[1]));
      else if (kindsOf(m).indexOf(WORK[i]) >= 0) parts.push(w[0]);
    }
    if (m.wakeups.length) parts.push(plural(m.wakeups.length, 'timer'));
    if (m.goal) parts.push(GOAL_SHORT[m.goal.status] || 'goal');
    return parts.join(' · ');
  }
  function drawPill() {
    if (!agentsBtn || !agentMap) return;
    var state = pillDot(agentMap), text = pillText(agentMap);
    var dot = one(agentsBtn, '[' + MARK + '-dot]'), label = one(agentsBtn, '[' + MARK + '-text]');
    if (!dot || dot.getAttribute(MARK + '-dot') !== state) {
      var fresh = dotEl(state, 6);
      agentsBtn.insertBefore(fresh, dot || agentsBtn.firstChild);
      if (dot) dot.remove();
    }
    if (label && label.textContent !== text) label.textContent = text;
    agentsBtn.setAttribute('aria-label', text + ' · ' + PILL_TITLE[state]);
    labelled(agentsBtn, PILL_TITLE[state]);
  }
  function makePill() {
    var b = barButton('agents', '', openMap);
    var label = mk('span', 'white-space:nowrap;');
    label.setAttribute(MARK + '-text', '');
    b.appendChild(label);
    return b;
  }

  var mapOpen = function () { return !!(mapBox && mapBox.isConnected); };
  function closeMap() { if (mapTips) mapTips.hide(); mapBox = gone(mapBox); }
  var SMALL_BTN = 'cursor:pointer;font:inherit;font-size:.92em;padding:2px 8px;border-radius:4px;color:inherit;background:transparent;'
    + 'border:1px solid ' + EDGE + ';';
  function actButton(text, action, id) {
    var b = mk('button', SMALL_BTN, text);
    b.setAttribute('type', 'button');
    b.setAttribute(MARK, 'map-act');
    b.setAttribute(MARK + '-act', action);
    b.addEventListener('click', function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* none */ }
      if (b.disabled) return;
      b.disabled = true;
      b.style.opacity = '0.5';
      post({ kind: 'agentMap', action: action, id: id || '' });
    });
    return b;
  }
  var PRE = 'white-space:pre-wrap;word-break:break-word;margin:0;padding:8px;max-height:200px;overflow-y:auto;font-size:.92em;'
    + 'line-height:1.5;border-radius:4px;background:var(--vscode-textCodeBlock-background,rgba(255,255,255,.05));';
  var acts = function (list) { var r = mk('div', 'display:flex;gap:6px;flex-wrap:wrap;'); for (var i = 0; i < list.length; i++) r.appendChild(list[i]); return r; };
  var tokensText = function (g) {
    var n = function (x) { return Number(x || 0).toLocaleString('en-US'); };
    return g.tokenBudget ? n(g.tokensUsed) + ' of ' + n(g.tokenBudget) + ' tokens' : n(g.tokensUsed) + ' tokens, no budget';
  };
  var firstLine = function (text) {
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) if (lines[i].trim()) return lines[i].trim();
    return '';
  };
  var cutTo = function (text, n) { return text.length > n ? text.slice(0, n - 1) + '…' : text; };

  /*
   * The layout: the conversation's own row first, under a heading of its own, then a section for each kind of thing
   * listed, in the order named above. A section's heading is a label in capitals and a count, smaller and bolder than
   * the rows, behind a thin line. Every row is a card in the form Claude Code draws its own: a dot, a one-line title
   * and a line of details under it. An empty section is left out.
   *
   * The map's hover text is drawn above its overlay, which covers the page's other labels.
   */
  var mapTips = kit.labels({ mark: [MARK, 'map-label'], css: 'z-index:' + (Z_MAP + 1) + ';' + TIP_LOOK });
  var mapLabelled = function (el, text) { if (text) mapTips.wire(el, text, MARK + '-map-labelled'); };
  var MAP_HEAD = 'display:block;align-self:stretch;box-sizing:border-box;margin:12px 0 0;padding-top:8px;'
    + 'border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.35));'
    + 'color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground,#ccc));font-weight:700;letter-spacing:.04em;'
    + 'line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;';
  var MAP_BADGE = 'display:inline-block;box-sizing:border-box;min-width:18px;margin-left:6px;padding:0 5px;border-radius:9px;text-align:center;'
    + 'vertical-align:1px;line-height:16px;font-weight:600;letter-spacing:0;font-size:10px;'
    + 'background:var(--vscode-badge-background,rgba(128,128,128,.35));color:var(--vscode-badge-foreground,inherit);';
  var MAP_CARD = 'box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:stretch;gap:2px;width:300px;'
    + 'max-width:100%;margin:0;padding:6px 10px;text-align:left;font:inherit;color:var(--vscode-foreground,#ccc);list-style:none;'
    + 'background-color:var(--vscode-menu-background,#252526);border:1px solid ' + EDGE + ';border-radius:4px;';
  /* A section's heading; `count` is null for the heading over the conversation's own row, which shows no count and no
     line. */
  function mapHead(label, count, note) {
    var hd = mk('div', MAP_HEAD + (count === null ? 'border-top:0;margin:0;padding-top:0;' : ''));
    hd.setAttribute(MARK + '-head', label);
    hd.appendChild(mk('span', 'text-transform:uppercase;', label));
    if (count !== null) {
      var c = mk('span', MAP_BADGE, String(count));
      c.setAttribute(MARK + '-count', String(count));
      hd.appendChild(c);
    }
    mapLabelled(hd, note);
    return hd;
  }
  function mapSection(mark, head, items) {
    var s = mk('div', 'display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:0 8px 8px 0;');
    s.setAttribute(MARK, mark);
    s.appendChild(head);
    for (var i = 0; i < items.length; i++) s.appendChild(items[i]);
    return s;
  }
  /*
   * A card. `o.dot` is a state of dotEl, `o.title` the first line, `o.after` what follows the title on it, `o.meta` the
   * second line; `o.tag` the element it is (a div by default). Its hover text is `o.note` and then the second line.
   * A card with `o.body` is the summary of a <details> that opens the body below it
   * on a click, with an arrow that says so; `o.key` is its key in `open`, which keeps it open or closed across redraws.
   */
  function mapCard(o, open) {
    var line = mk('span', 'display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap;');
    line.appendChild(dotEl(o.dot, 8));
    var name = mk('span', 'flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;', o.title);
    name.setAttribute(MARK + '-name', '');
    line.appendChild(name);
    if (o.after) line.appendChild(o.after);
    if (o.body) {
      var more = mk('span', 'margin-left:auto;padding-left:4px;color:' + DIM + ';font-size:.8em;line-height:1;', '▸');
      more.setAttribute(MARK + '-more', '');
      line.appendChild(more);
    }
    var card = mk(o.body ? 'summary' : o.tag || 'div', MAP_CARD + (o.body || o.tag === 'button' ? 'cursor:pointer;' : ''));
    if (o.tag === 'button') card.setAttribute('type', 'button');
    card.setAttribute(MARK + '-card', o.kind);
    card.appendChild(line);
    /* It wraps rather than being cut: a card of work ends it with when the work started. */
    var meta = mk('span', 'padding-left:14px;color:' + DIM + ';font-size:.85em;overflow-wrap:anywhere;', o.meta || '');
    meta.setAttribute(MARK + '-meta', '');
    card.appendChild(meta);
    mapLabelled(card, [o.note, o.meta].filter(Boolean).join('\n'));
    if (!o.body) return card;
    var d = mk('details', 'max-width:100%;');
    d.setAttribute(MARK + '-key', o.key);
    if (open[o.key]) d.setAttribute('open', '');
    d.appendChild(card);
    var body = mk('div', 'box-sizing:border-box;width:300px;max-width:100%;margin:6px 0 2px;padding-left:14px;');
    for (var i = 0; i < o.body.length; i++) body.appendChild(o.body[i]);
    d.appendChild(body);
    return d;
  }
  function withActs(card, buttons) {
    var w = mk('div', 'display:flex;flex-direction:column;align-items:flex-start;gap:6px;max-width:100%;');
    w.appendChild(card);
    w.appendChild(acts(buttons));
    return w;
  }
  var ME_STATE = { working: 'running', background: 'work it started is still running', waiting: 'waiting for you', stopped: 'idle', unknown: '' };
  var AGENTS_NOTE = 'The sub-agents this conversation started. Click one to open it in a tab.';
  var WORK_NOTE = 'Work this conversation or a sub-agent started that is still running after its turn: commands it detached, '
    + 'background terminals, codex exec runs, claude -p workers and claude --bg sessions. They keep the conversation\'s dot green. '
    + 'A card\'s hover text is its whole command line.';
  var WAKE_NOTE = 'Sent when the conversation is idle. Click one to read its prompt.';
  var GOAL_NOTE = 'Codex starts another turn each time the conversation is idle, until the goal is done. Click it to read the goal.';
  /* The second line of a card of work: what it is, then its job, pid and when it started. */
  function workMeta(word, d, first) {
    var age = d.startMs ? kit.age(d.startMs) : '';
    var parts = [word].concat(first || []);
    if (d.pid) parts.push('pid ' + d.pid);
    if (d.startMs) parts.push('started ' + kit.stamp(d.startMs, false) + (age === 'now' ? ', just now' : ', ' + age + ' ago'));
    return parts.join(' · ');
  }
  var WORK_META = { detached: 'detached', command: 'background terminal', codexExec: 'codex exec', claudeWorker: 'claude -p', claudeBg: 'claude --bg' };
  var CMD_SHOWN = 120, CMD_HOVER = 500;
  /* Shortens a command line's program to the last part of its path, as Claude Code Plus titles its cards: a program
     run by its full path, such as the codex in Codex's extension folder, would otherwise fill the title with the path. */
  var titleOf = function (cmd) { return cmd.replace(/^[\/~]\S*\/([^\/\s]+)(?=\s|$)/, '$1'); };
  function jobCard(d, open) {
    var cmd = String(d.cmd || '');
    var c = mapCard({ kind: 'detached', dot: 'working', title: cutTo(titleOf(cmd), CMD_SHOWN) || '(command line not read)', meta: workMeta('detached', d),
      note: cutTo(cmd, CMD_HOVER) }, open);
    c.setAttribute(MARK, 'map-job');
    return c;
  }
  function workCard(w, open) {
    var cmd = String(w.cmd || ''), word = WORK_META[w.kind] || w.kind;
    var title = w.kind === 'claudeWorker' || w.kind === 'claudeBg' ? w.name || (w.kind === 'claudeBg' ? w.job : titleOf(cmd)) || word : titleOf(cmd) || word;
    var c = mapCard({ kind: 'work', dot: 'working', title: cutTo(title, CMD_SHOWN), meta: workMeta(word, w, w.job ? ['job ' + w.job] : []),
      note: cutTo(cmd, CMD_HOVER) }, open);
    c.setAttribute(MARK, 'map-bg');
    c.setAttribute(MARK + '-kind', w.kind);
    return c;
  }
  function bareCard(k, open) {
    var c = mapCard({ kind: 'work', dot: 'working', title: WORK_BARE[k] || k, meta: WORK_META[k] || k }, open);
    c.setAttribute(MARK, 'map-bg');
    c.setAttribute(MARK + '-kind', k);
    return c;
  }
  function mapSections(m, open) {
    var out = [];
    /* The conversation's own row: its title, the dot its tab has, and the model and the context in use as the meter has
       them, with the model's name in the form the reply stamps use (src/user-times.js). */
    var me = m.me && typeof m.me === 'object' ? m.me : {};
    var ownMeta = [];
    if (usage && usage.model) ownMeta.push(usage.model.replace(/^openai\./, ''));
    if (usage && usage.used > 0) ownMeta.push(kit.kfmt(usage.used) + ' tokens in context');
    var own = mapCard({ kind: 'me', dot: me.dot || 'stopped', title: me.title || 'This conversation',
      meta: ownMeta.join(' · ') || ME_STATE[me.dot] || '' }, open);
    out.push(mapSection('map-me', mapHead('This conversation', null, ''), [own]));
    if (m.agents.length) {
      out.push(mapSection('map-agents', mapHead('Sub-agents', m.agents.length, AGENTS_NOTE), m.agents.map(function (a) {
        var env = null;
        if (a.unseen) {
          env = mk('span', 'flex-shrink:0;line-height:1;', m.envelope || '\uD83D\uDCE9');
          env.setAttribute(MARK + '-unseen', '');
        }
        var age = kit.age(a.updatedMs);
        var b = mapCard({ kind: 'agent', tag: 'button', dot: a.dot, title: a.name, after: env,
          meta: a.updatedMs ? (age === 'now' ? 'active now' : 'active ' + age + ' ago') : '',
          note: [a.title && a.title !== a.name ? a.title : '', a.unseen ? 'Has a reply you have not read.' : ''].filter(Boolean).join('\n') }, open);
        b.setAttribute(MARK, 'map-agent');
        b.setAttribute(MARK + '-id', a.id);
        b.addEventListener('click', function (ev) {
          try { ev.stopPropagation(); } catch (e) { /* none */ }
          post({ kind: 'agentMap', action: 'openAgent', id: a.id });
          closeMap();
        });
        return b;
      })));
    }
    var jobs = jobsOf(m), bare = ['detached'].concat(WORK).filter(function (k) {
      return kindsOf(m).indexOf(k) >= 0 && !(k === 'detached' ? jobs.length : countOf(m, k));
    });
    var work = jobs.map(function (d) { return jobCard(d, open); })
      .concat(workOf(m).map(function (w) { return workCard(w, open); }), bare.map(function (k) { return bareCard(k, open); }));
    if (work.length) out.push(mapSection('map-work', mapHead('Work left running', work.length, WORK_NOTE), work));
    if (m.wakeups.length) {
      out.push(mapSection('map-wakeups', mapHead('Wake-ups', m.wakeups.length, WAKE_NOTE), m.wakeups.map(function (w, i) {
        var when = w.paused ? 'paused until a turn starts' : 'next ' + kit.stamp(w.nextMs, false);
        return withActs(mapCard({ kind: 'wakeup', key: 'wake' + i, dot: 'idle', title: cutTo(firstLine(w.prompt), CMD_SHOWN) || '(no prompt)',
          meta: 'every ' + w.everyMinutes + ' min · ' + when + ' · until ' + kit.stamp(w.expiresMs, false),
          body: [mk('pre', PRE, String(w.prompt || ''))] }, open), [actButton('Remove', 'removeWakeup')]);
      })));
    }
    if (m.goal) {
      var g = m.goal, buttons = [];
      if (g.status === 'active') buttons.push(actButton('Pause', 'pauseGoal'));
      if (GOAL_RESUMABLE.indexOf(g.status) >= 0) buttons.push(actButton('Resume', 'resumeGoal'));
      buttons.push(actButton('Clear', 'clearGoal'));
      out.push(mapSection('map-goal', mapHead('Goal', 1, GOAL_NOTE), [withActs(mapCard({ kind: 'goal', key: 'goal', dot: 'idle',
        title: cutTo(firstLine(g.objective), CMD_SHOWN) || '(no objective)', meta: (GOAL_STATE[g.status] || g.status) + ' · ' + tokensText(g),
        body: [mk('pre', PRE, g.objective)] }, open), buttons)]));
    }
    return out;
  }
  function drawMap() {
    if (!mapOpen() || !agentMap) return;
    var body = one(mapBox, '[' + MARK + '="map-body"]');
    if (!body) return;
    var open = {}, folds = body.querySelectorAll('details[' + MARK + '-key]');
    for (var i = 0; i < folds.length; i++) if (folds[i].hasAttribute('open')) open[folds[i].getAttribute(MARK + '-key')] = true;
    mapTips.hide();
    body.replaceChildren.apply(body, mapSections(agentMap, open));
    snapMap();
  }
  /* The overlay's flex box centres the dialog, which leaves it a fraction of a pixel off the grid whenever the room
     around it is odd, and its lines of text then land a pixel up or down depending on that fraction. Shifting the
     dialog by the fraction puts it on whole device pixels; it is measured again whenever its content or the window
     changes size. */
  function snapMap() {
    var dlg = mapOpen() && one(mapBox, '[' + MARK + '="map-dialog"]');
    if (!dlg) return;
    dlg.style.left = '';
    dlg.style.top = '';
    var r = dlg.getBoundingClientRect(), px = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1;
    if (!r) return;
    var dx = Math.round((r.left || 0) * px) / px - (r.left || 0), dy = Math.round((r.top || 0) * px) / px - (r.top || 0);
    if (dx) dlg.style.left = dx + 'px';
    if (dy) dlg.style.top = dy + 'px';
  }
  function openMap() {
    if (mapOpen()) { closeMap(); return; }
    if (!agentMap || !document.body) return;
    hideLabel();
    var overlay = mk('div', 'position:fixed;inset:0;z-index:' + Z_MAP + ';display:flex;align-items:center;justify-content:center;'
      + 'overflow-y:auto;background-color:#000000bf;');
    overlay.setAttribute(MARK, 'agent-map');
    var dlg = mk('div', 'position:relative;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;width:fit-content;min-width:min(320px,calc(100vw - 32px));'
      + 'max-width:min(1200px,calc(100vw - 32px));max-height:calc(100vh - 32px);margin:16px;padding:16px;border-radius:8px;outline:0;'
      + 'user-select:text;' + pageFont(13) + 'color:var(--vscode-foreground,#ccc);'
      + 'background-color:var(--vscode-sideBar-background,var(--vscode-editor-background,#181818));'
      + 'border:1px solid var(--vscode-sideBarActivityBarTop-border,var(--vscode-widget-border,#2b2b2b));');
    dlg.setAttribute(MARK, 'map-dialog');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', 'Agent map');
    dlg.setAttribute('tabindex', '-1');
    var head = mk('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;');
    head.appendChild(mk('h3', 'flex:1;min-width:0;margin:0;font-size:16px;font-weight:600;color:var(--vscode-foreground,#ccc);', 'Agent map'));
    var shut = mk('button', 'display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:4px;'
      + 'background:transparent;color:inherit;cursor:pointer;');
    shut.setAttribute('type', 'button');
    shut.setAttribute('aria-label', 'Close');
    shut.setAttribute(MARK, 'map-close');
    shut.appendChild(icon([{ tag: 'path', attrs: mix(LINE, { d: 'M4 4l8 8M12 4l-8 8' }) }]));
    shut.addEventListener('click', function (ev) { try { ev.stopPropagation(); } catch (e) { /* none */ } closeMap(); });
    head.appendChild(shut);
    var body = mk('div', 'overflow:auto;flex:1;min-height:0;');
    body.setAttribute(MARK, 'map-body');
    dlg.appendChild(head);
    dlg.appendChild(body);
    overlay.appendChild(dlg);
    overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) { try { ev.preventDefault(); } catch (e) { /* none */ } } });
    overlay.addEventListener('click', function (ev) { try { ev.stopPropagation(); } catch (e) { /* none */ } if (ev.target === overlay) closeMap(); });
    /* Keys stay in the dialog while it is open, so none of them reaches Codex's own shortcuts. */
    dlg.addEventListener('keydown', function (ev) { try { ev.stopPropagation(); } catch (e) { /* none */ } });
    /* Esc closes the dialog wherever the focus is, including after a disabled button has dropped it. The listener is
       added to the document once, in the capture phase, so Codex's own Esc handling does not also run. */
    if (!mapKeysWired) {
      mapKeysWired = true;
      try { globalThis.addEventListener('resize', snapMap); } catch (e) { /* no window events */ }
      document.addEventListener('keydown', function (ev) {
        if (!mapOpen() || !ev || ev.key !== 'Escape') return;
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* none */ }
        closeMap();
      }, true);
    }
    document.body.appendChild(overlay);
    mapBox = overlay;
    drawMap();
    try { dlg.focus(); } catch (e) { /* no focus here */ }
  }
  /* A path is one long word to the line breaker, so it gets a <wbr> after each slash but a leading one; a <wbr> adds
     nothing to the text that is selected or copied. */
  function fillValue(el, text) {
    el.textContent = '';
    var from = 0;
    for (var i = 1; i < text.length; i++) {
      var c = text.charAt(i);
      if (c !== '/' && c !== '\\') continue;
      el.appendChild(document.createTextNode(text.slice(from, i + 1)));
      el.appendChild(document.createElement('wbr'));
      from = i + 1;
    }
    if (from < text.length) el.appendChild(document.createTextNode(text.slice(from)));
  }
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
      infoBox.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX_BOX + ';display:none;width:400px;max-width:calc(100vw - 32px);'
        + 'padding:8px 10px;border-radius:5px;' + pageFont(11) + 'line-height:1.5;'
        + 'background:var(--vscode-editorHoverWidget-background,rgba(30,30,30,.99));'
        + 'color:var(--vscode-editorHoverWidget-foreground,#ddd);'
        + 'border:1px solid var(--vscode-editorHoverWidget-border,rgba(255,255,255,.18));box-shadow:0 4px 14px rgba(0,0,0,.5);';
      document.body.appendChild(infoBox);
    }
    infoBox.textContent = '';
    m.rows.slice(0, 20).forEach(function (row, i) {
      if (!row || typeof row.label !== 'string') return;
      var line = document.createElement('div');
      line.style.cssText = 'display:flex;align-items:baseline;gap:10px;padding:2px 0;';
      var k = document.createElement('span');
      k.textContent = row.label;
      k.style.cssText = 'flex:0 0 72px;opacity:.6;';
      var v = document.createElement('span');
      var value = String(row.value == null ? '' : row.value);
      fillValue(v, value);
      v.style.cssText = 'flex:1 1 auto;min-width:0;overflow-wrap:anywhere;cursor:pointer;'
        + 'font-family:var(--vscode-editor-font-family,monospace);';
      v.setAttribute('title', 'Click to copy');
      v.addEventListener('click', function (ev) {
        try { ev.stopPropagation(); } catch (e) { /* none */ }
        post({ kind: 'infoCopy', id: m.id, index: i });
        v.textContent = 'copied';
        v.style.opacity = '0.6';
        setTimeout(function () { if (v.isConnected) { fillValue(v, value); v.style.opacity = ''; } }, 900);
      });
      line.appendChild(k); line.appendChild(v);
      infoBox.appendChild(line);
    });
    var r = rectOf(infoBtn), vh = +globalThis.innerHeight || 0, vw = +globalThis.innerWidth || 0;
    infoBox.style.bottom = Math.round(vh && r ? Math.max(4, vh - (r.top || 0) + 4) : 28) + 'px';
    infoBox.style.display = 'block';
    var w = infoBox.offsetWidth || 0;
    infoBox.style.left = Math.round(r ? Math.max(8, vw ? Math.min(r.left || 0, vw - w - 8) : r.left || 0) : 8) + 'px';
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
  /* The work plan line from the host's last codex-extras-plan message. The host reads the rollout to build it, so the
     page asks at most once every PLAN_ASK_MS, when the pointer reaches the meter. */
  var planText = '', planAskedAt = 0, PLAN_ASK_MS = 15000;
  function askPlan() {
    var now = Date.now();
    if (planAskedAt && now - planAskedAt < PLAN_ASK_MS) return;
    planAskedAt = now;
    post({ kind: 'planAsk' });
  }
  function tookPlan(m) {
    planText = typeof m.text === 'string' ? m.text.slice(0, 300) : '';
    if (m.cleared) planAskedAt = 0;
    if (ctxBox && ctxBox.style.display === 'block') ctxRender();
  }
  var kfmt = kit.kfmt, pctOf = kit.pct;
  function ctxRow(name, value, share, dim) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;padding:1px 0;' + (dim ? 'opacity:.65;' : '');
    var a = document.createElement('span'), b = document.createElement('span'), c = document.createElement('span');
    a.textContent = name;
    a.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    b.textContent = value;
    b.style.cssText = 'flex:0 0 auto;width:54px;text-align:right;font-variant-numeric:tabular-nums;';
    c.textContent = share || '';
    c.style.cssText = 'flex:0 0 auto;width:48px;text-align:right;opacity:.75;font-variant-numeric:tabular-nums;';
    row.appendChild(a); row.appendChild(b); row.appendChild(c);
    return row;
  }
  /* `whole`, a part of `text` such as a model's name, is kept on one line rather than broken at its hyphens. */
  function ctxNote(text, whole) {
    var d = document.createElement('div');
    var at = whole ? text.indexOf(whole) : -1;
    if (at < 0) d.textContent = text;
    else {
      var w = document.createElement('span');
      w.textContent = whole;
      w.style.whiteSpace = 'nowrap';
      d.appendChild(document.createTextNode(text.slice(0, at)));
      d.appendChild(w);
      d.appendChild(document.createTextNode(text.slice(at + whole.length)));
    }
    d.style.cssText = 'opacity:.55;padding:1px 0 3px 0;';
    return d;
  }
  function ctxHead(title) {
    var d = document.createElement('div');
    d.textContent = title;
    d.style.cssText = 'font-weight:600;margin-top:8px;padding-top:5px;border-top:1px solid var(--vscode-widget-border,rgba(255,255,255,.12));';
    return d;
  }
  /* The note under the window row (src/context-window.js windowFrom); Codex reports 95% of the value it works with. */
  function windowNote(f) {
    var of = f.used > 0 ? '95% of ' + kfmt(f.used) + (f.most ? ', Codex\'s maximum' : '') + ' · ' : '';
    if (f.kind === 'setting') return of + 'codexPlus.contextWindow for ' + f.model + (f.asked ? ', ' + f.asked : '');
    if (f.kind === 'config') return of + 'model_context_window in config.toml';
    if (f.kind === 'default') return of + 'Codex\'s default for ' + f.model;
    return 'set when Codex opened this conversation, before the window set now; a reload of the window applies it';
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
    ctxBox.appendChild(ctxRow('Context window', kfmt(u.window)));
    if (u.windowFrom) ctxBox.appendChild(ctxNote(windowNote(u.windowFrom), u.windowFrom.model || ''));
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
    if (planText) {
      var plan = document.createElement('div');
      plan.textContent = 'Work plan: ' + planText;
      plan.style.cssText = 'margin-top:8px;padding-top:5px;border-top:1px solid var(--vscode-widget-border,rgba(255,255,255,.12));';
      ctxBox.appendChild(plan);
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
      ctxBox.style.cssText = 'position:fixed;z-index:' + Z_BELOW_CODEX_BOX + ';display:none;width:330px;max-width:calc(100vw - 16px);'
        + 'box-sizing:border-box;padding:8px 10px;border-radius:5px;' + pageFont(11) + 'line-height:1.5;'
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
    askPlan();
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
    var f = u.windowFrom && typeof u.windowFrom === 'object' && /^(setting|config|default|earlier)$/.test(String(u.windowFrom.kind)) ? u.windowFrom : null;
    var text = function (x, most) { return typeof x === 'string' ? x.slice(0, most) : ''; };
    return { used: u.used, window: u.window, line: n(u.line) || 0, lineFrom: u.lineFrom === 'config' ? 'config' : 'default',
      windowFrom: f ? { kind: f.kind, model: text(f.model, 80), asked: text(f.asked, 20), used: n(f.used) || 0, most: f.most === true } : null,
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
   * Codex's notice that a conversation is open in another app, with its Retry button. Codex's app-server takes a
   * conversation only while no other process holds its writer lock, and after a window reload the app-server of the
   * window before can keep that lock for half a minute or more while it exits. The page asks once, shows the notice and
   * waits for a click. A retry starts again once the notice has been gone for two steps in a row (it goes away for a
   * moment while Codex retries), or when it is about another conversation.
   *
   * The notice is recognised by the message id of its title, in the props React keeps on its elements, so it is found
   * whatever language Codex's interface is in.
   */
  var CONFLICT_TITLE = 'localConversation.writerConflict.title', HISTORY_FAILED = 'localConversation.historyLoadFailed', ALERT_UP = 30;
  var CONFLICT_FIRST_MS = 3000, CONFLICT_EVERY_MS = 5000, CONFLICT_TRIES = 24, CONFLICT_DEBOUNCE_MS = 300, HISTORY_TRIES = 3;
  var conflictObserver = null, conflictDue = 0, conflictTimer = 0, conflictWaiting = false;
  var conflictFor = null, conflictTries = 0, conflictMissed = 0, historyTimer = 0, historyTries = 0;
  /* The message id of a React element made with Codex's FormattedMessage, or ''. */
  var messageId = function (el) { var p = el && typeof el === 'object' ? el.props : null; return p && typeof p.id === 'string' ? p.id : ''; };
  /* { retry, disabled, thread } for the first alert on the page whose callout `match` accepts, or null. The callout is
     the component above the alert element that was given onPrimaryCtaClick; thread is the forkConversationId of a
     component above that, or ''. */
  function alertWith(match) {
    var alerts = [];
    try { alerts = document.querySelectorAll('[role="alert"]'); } catch (e) { return null; }
    for (var i = 0; i < alerts.length; i++) {
      var f = fiberOf(alerts[i]), found = null;
      for (var j = 0; f && j < ALERT_UP; j++, f = f.return) {
        try {
          var p = f.memoizedProps;
          if (!p || typeof p !== 'object') continue;
          if (!found) {
            if (typeof p.onPrimaryCtaClick === 'function' && match(p)) found = { retry: p.onPrimaryCtaClick, disabled: p.isPrimaryCtaDisabled === true, thread: '' };
          } else if (typeof p.forkConversationId === 'string') { found.thread = p.forkConversationId.slice(0, 200); break; }
        } catch (e) { /* not ours to read */ }
      }
      if (found) return found;
    }
    return null;
  }
  function conflictNotice() { return alertWith(function (p) { return messageId(p.title) === CONFLICT_TITLE; }); }
  /* "Couldn't load messages": its text is a span holding the message. */
  function historyNotice() {
    return alertWith(function (p) { var c = p.content && typeof p.content === 'object' ? p.content.props : null; return !!c && messageId(c.children) === HISTORY_FAILED; });
  }
  /* Codex also tries to load a conversation's earlier messages, and that fails the same way while the lock is held,
     leaving "Couldn't load messages" with a Retry of its own after the conversation has opened. Once the notice has
     gone while the retries run, that Retry is clicked too. */
  function retryHistory() {
    historyTimer = 0;
    var n = historyNotice();
    if (!n || historyTries >= HISTORY_TRIES) { historyTries = 0; return; }
    if (!n.disabled) { historyTries++; try { n.retry(); } catch (e) { /* Codex's own to handle */ } }
    historyTimer = setTimeout(retryHistory, CONFLICT_EVERY_MS);
  }
  function tellConflict(event, thread, tries) { post({ kind: 'writerConflict', event: event, thread: thread || '', tries: tries }); }
  function conflictStep() {
    conflictTimer = 0;
    var n = conflictNotice();
    if (!n) {
      if (++conflictMissed < 2) { conflictTimer = setTimeout(conflictStep, CONFLICT_EVERY_MS); return; }
      if (conflictTries) {
        tellConflict('cleared', conflictFor, conflictTries);
        if (!historyTimer) { historyTries = 0; retryHistory(); }
      }
      conflictFor = null; conflictTries = 0; conflictMissed = 0;
      return;
    }
    conflictMissed = 0;
    if (n.thread !== conflictFor) { conflictFor = n.thread; conflictTries = 0; }
    if (conflictTries >= CONFLICT_TRIES) return;
    if (!n.disabled) {
      if (!conflictTries) tellConflict('retrying', n.thread, 0);
      conflictTries++;
      try { n.retry(); } catch (e) { /* Codex's own to handle */ }
      if (conflictTries >= CONFLICT_TRIES) { tellConflict('stopped', n.thread, conflictTries); return; }
    }
    conflictTimer = setTimeout(conflictStep, CONFLICT_EVERY_MS);
  }
  function lookForConflict() {
    if (conflictTimer) return;
    var n = conflictNotice();
    if (!n) {
      /* Gone after the retries stopped: whatever happened to it, a later notice starts afresh. */
      if (conflictTries >= CONFLICT_TRIES) { conflictFor = null; conflictTries = 0; conflictMissed = 0; }
      return;
    }
    if (n.thread !== conflictFor) { conflictFor = n.thread; conflictTries = 0; conflictMissed = 0; }
    if (conflictTries >= CONFLICT_TRIES) return;
    conflictTimer = setTimeout(conflictStep, conflictTries ? CONFLICT_EVERY_MS : CONFLICT_FIRST_MS);
  }
  /*
   * Codex's recovery page ("ChatGPT hit a snag"), which its error boundary draws in place of the whole page when one of
   * its own modules fails to load. The browser keeps that failure for the rest of the page's life, so neither Codex's own
   * button nor a reload of the page brings it back (a reload leaves VS Code's empty placeholder page); only a new page
   * does. The page tells the host once, with the module's file name, and the host builds a new page in its place
   * (src/broken-pages.js). It is found by the props of the boundary's fallback in React's fibers above a heading: an
   * `error` and a `resetError`; any other error is left alone.
   */
  var MODULE_FAILED = /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
  var brokenTold = false;
  function lookForBroken() {
    if (brokenTold) return;
    var heads = [];
    try { heads = document.querySelectorAll('h1, h2'); } catch (e) { return; }
    for (var i = 0; i < heads.length; i++) {
      var f = fiberOf(heads[i]);
      for (var j = 0; f && j < ALERT_UP; j++, f = f.return) {
        try {
          var p = f.memoizedProps, err = p && typeof p === 'object' && typeof p.resetError === 'function' ? p.error : null;
          if (!err) continue;
          var said = String(err && err.message || err);
          if (!MODULE_FAILED.test(said)) return;
          var file = (/[\w.-]+\.m?js\b/.exec(said) || [''])[0].slice(0, 120);
          brokenTold = true;
          post({ kind: 'brokenPage', reason: 'module', file: file });
          return;
        } catch (e) { /* not ours to read */ }
      }
    }
  }
  function conflictReady() {
    if (!document.body) {
      if (!conflictWaiting) { conflictWaiting = true; document.addEventListener('DOMContentLoaded', function () { conflictWaiting = false; conflictReady(); }); }
      return;
    }
    if (conflictObserver || typeof MutationObserver !== 'function') return;
    conflictObserver = new MutationObserver(function () {
      if (conflictDue) return;
      conflictDue = setTimeout(function () { conflictDue = 0; lookForConflict(); lookForBroken(); }, CONFLICT_DEBOUNCE_MS);
    });
    try { conflictObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) { conflictObserver = null; return; }
    lookForConflict();
    lookForBroken();
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

  /*
   * Text from the host for the message box of the conversation this page shows (src/patching.js prefill), for the user
   * to finish and send: it goes after whatever the box holds, with the cursor after it, and nothing is sent. Typed with
   * insertText at the end of the box, so Codex's editor takes it as typing and keeps what was there.
   */
  var PREFILL_TRIES = 50;
  var prefillTaken = {};
  function takePrefill(m) {
    if (prefillTaken[m.id]) return;
    prefillTaken[m.id] = true;
    var tries = 0, want = squash(m.text);
    var reply = function (outcome) { post({ kind: 'prefill', id: m.id, outcome: outcome }); };
    var look = function () {
      var el = composerEditor();
      if (!el) { if (++tries >= PREFILL_TRIES) reply('noComposer'); else setTimeout(look, ANSWER_STEP_MS); return; }
      var had = String(el.textContent || '');
      var text = had && !/\s$/.test(had) ? ' ' + m.text : m.text;
      try { if (typeof el.focus === 'function') el.focus(); } catch (e) { /* not focusable */ }
      try {
        var range = document.createRange(), sel = globalThis.getSelection();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* no selection here; insertText then types where the caret is */ }
      try { document.execCommand('insertText', false, text); } catch (e) { /* checked below */ }
      setTimeout(function () {
        var now = composerEditor(), have = now ? squash(now.textContent) : '';
        reply(want && have.length >= squash(had).length + want.length && have.slice(-want.length) === want ? 'drafted' : 'changed');
      }, ANSWER_STEP_MS);
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
        + pageFont(11) + 'color:var(--vscode-descriptionForeground,#888);padding:0 4px;opacity:.8;';
      document.body.appendChild(strip);
    }
    placeStrip();
    var text = figures.text;
    if (tool && figures.toolSince) {
      text = tool + ' running for ' + dur(Math.max(0, Date.now() - figures.toolSince))
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
   * A message's opening words are read and shown here and go no further. This part posts two things to the host: the
   * id Codex puts on the newest turn (noteShownTurn), and the shape of a sent time it could not parse: its length, the
   * class of its first character and whether it is all digits. Neither includes anything the conversation says.
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
    replyDuration: true, buttons: true, chime: true, infoButton: true, chimeButton: true, contextMeter: true, replyImages: true };
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
  var p2 = kit.p2;
  /* HH:MM:SS in the user's own zone, or HH:MM when the source had no seconds, rather than showing :00 seconds that
     nobody recorded; another day goes in front as MM/DD (agentPlusKit.stamp). */
  function clockOf(when) { return when ? kit.stamp(when.ms, !!when.secs) : ''; }

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
   * display. With two candidates there is no telling which is the time, so none is returned. The result also carries
   * the element that shows the clock (`el`), so that it can be hidden while this script's stamp is on the message.
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
        found.el = n.parentNode && String(n.parentNode.textContent || '').trim() === t ? n.parentNode : null;
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
      /* Every reply block of the turn, not only those on its final-reply side: from 26.1117 a reply written before the
         turn's last one sits in the turn's activity part, and the rollout counts it. The turn's line still goes on the
         first reply of the final-reply side. */
      var blocks = all(turn, SEL.assistant), firstReply = true;
      for (var b = 0; b < blocks.length; b++) {
        if (blocks[b].closest && blocks[b].closest(SEL.user)) continue;
        var kind = roleOf(blocks[b]) === 'user' ? 'user' : 'assistant';
        var final = !!(blocks[b].closest && blocks[b].closest(SEL.assistantSide));
        out.push({ kind: kind, node: blocks[b], day: day, turn: key, turnEl: turn, first: kind === 'assistant' && final && firstReply });
        if (kind === 'assistant' && final) firstReply = false;
      }
    }
    return out;
  }

  /*
   * A stamp line wraps only after a "·" and after the time, as in Claude Code Plus, so "ctx 21%" or "gpt-6.1-sol high"
   * never splits across lines. Each hyphen gets a U+2060 after it, since Chromium breaks after a hyphen.
   */
  var NBSP = '\u00a0', DOT = '\u00b7', JOIN = '\u2060';
  function breakable(v) {
    return String(v).split('  ').map(function (gap) {
      return gap.split(' ' + DOT + ' ').map(function (part) { return part.split(' ').join(NBSP).split('-').join('-' + JOIN).split(',' + NBSP).join(', '); })
        .join(NBSP + DOT + ' ');
    }).join('  ');
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
    var shown = breakable(text);
    if (el.textContent !== shown) el.textContent = shown;
    var timed = side === 'assistant' && !!text;
    if (timed !== (el.getAttribute(TIMED_ATTR) !== null)) { if (timed) el.setAttribute(TIMED_ATTR, ''); else el.removeAttribute(TIMED_ATTR); }
    /* As Claude Code Plus writes a reply's line: two spaces after the time, then the duration and the figures. */
    var bits = [took, figures].filter(Boolean);
    var fig = bits.length ? breakable((text ? '  ' : '') + bits.join(' \u00b7 ')) : '';
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
   * Codex draws its own "Worked for" only when a turn did something before its last reply. It sits inside the turn,
   * outside its messages: a button that expands that activity, or, from 26.1117, a line of text after it.
   * Neither has an attribute of its own. So a button with aria-expanded in that position is taken to be it, and so is
   * any text in the turn's body outside its messages; the day's divider is outside the body.
   */
  var WORKED_SEL = 'button[aria-expanded]';
  function codexShowsWorked(turn) {
    var found = turn ? all(turn, WORKED_SEL) : [];
    var mine = SEL.user + ',' + SEL.assistantSide + ',' + SEL.unit + ',' + SEL.assistant + ',[' + MARK + ']';
    for (var i = 0; i < found.length; i++) if (!(found[i].closest && found[i].closest(mine))) return true;
    var stack = turn ? all(turn, SEL.turnBody) : [];
    while (stack.length) {
      var kids = stack.pop().childNodes || [];
      for (var k = 0; k < kids.length; k++) {
        var n = kids[k];
        if (n.nodeType === 3 && String(n.nodeValue || '').trim()) return true;
        if (n.nodeType === 1 && !(n.matches && n.matches(mine))) stack.push(n);
      }
    }
    return false;
  }
  var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  /* The time on every message, and the words for the list. Returns the user messages in document order. */
  function stampAll(list) {
    var users = [], inTurn = {}, repliesIn = {};
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind !== 'user') { list[i].nth = repliesIn[list[i].turn] = (repliesIn[list[i].turn] || 0) + 1; continue; }
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
        var ownEl = e.kind === 'user' && when ? when.el : null;
        if (e.kind === 'user') took = when ? 'clock' : '';
        /*
         * The turn's own times are tried first. A user message takes the time at its position in the turn, when the
         * rollout has as many user messages in that turn as the page shows. A reply takes the one reply time of the
         * turn that falls in the minute Codex shows on it. Either is still checked against Codex's own clock, if any.
         */
        if (e.kind === 'user' && tt && tt.u.length === inTurn[e.turn]) {
          var mine = { ms: tt.u[e.nth - 1], secs: true };
          if (!when || agrees(when, mine.ms, e.day !== null)) { when = mine; took = 'rollout'; }
        } else if (e.kind === 'assistant' && tt && !when && tt.r.length === repliesIn[e.turn]) {
          /* From 26.1117 Codex draws no time on a reply. It takes the rollout's time for its place in the turn, if the
             rollout and the page hold the same number of replies in that turn. */
          when = { ms: tt.r[e.nth - 1], secs: true };
        } else if (e.kind === 'assistant' && tt && !when && tt.r.length > repliesIn[e.turn] && codexShowsWorked(e.turnEl)) {
          /* A finished turn's "Worked for" folds its earlier replies away, so the replies on the page are its last ones. */
          when = { ms: tt.r[tt.r.length - repliesIn[e.turn] + e.nth - 1], secs: true };
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
        /* Codex's own clock beside the message, hidden as Claude Code Plus hides Claude Code's while its stamp is on.
           Codex's redraws drop the class, so each pass puts it back. */
        if (ownEl && text && !(ownEl.classList && ownEl.classList.contains(OWN_TIME_CLASS))) flag(ownEl, OWN_TIME_CLASS, true);
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
      var anchor = users[i].node, bubble = one(anchor, SEL.bubble);
      var hook = !!(bubble && bubble.getAttribute(HOOK) !== null);
      flag(anchor, INK_CLASS, !!view.userColor && !hook);
      flag(bubble || anchor, EDGE_CLASS, view.userEdge !== false && !hook);
    }
  }

  /*
   * Other conversations a reply names, drawn as links (codexPlus.conversationLinks). The host sends every agent's
   * conversations and the one this page shows (codex-extras-conversations); agentPlusKit finds the names and puts one
   * of this script's own elements in place of each. A click sends the host the conversation's agent and id, nothing
   * else.
   *
   * Only a reply Codex has finished writing is touched. Codex's page is React's: while a reply streams, React keeps
   * rewriting the text nodes this would split, and inserting next to them, and once it ends Codex draws it again with
   * its finished renderer. Whether a reply is finished is read from the rollout, as for the stamps' times. In every
   * turn but the last one shown, all replies are finished. In the last one, a reply is finished once the rollout holds
   * it at its place in the turn, and all of them are once the rollout has ended the turn. A newly finished reply is
   * linked LINK_HOLD_MS later, after that redraw.
   */
  var convos = { on: false, ix: null, version: 0 };
  var LINK_MARK = 'convo-link', LINK_SEL = '[' + MARK + '="' + LINK_MARK + '"]', LINK_HOLD_MS = 600;
  var finishedAt = (typeof WeakMap === 'function') ? new WeakMap() : null, linkDue = 0, linksDrawn = 0;
  /* What each reply looked like when it was last linked: the version of the list, its text length and its number of
     links. A reply that still looks the same is not read again, which spares a long conversation a scan of every reply
     on each pass. */
  var linkedAs = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var looks = function (node) { return String(node.textContent || '').length + ':' + all(node, LINK_SEL).length; };
  function finished(e, lastTurn) {
    if (e.turnEl !== lastTurn) return true;
    var tt = e.turn && own(hostTurnTimes, e.turn) ? hostTurnTimes[e.turn] : null;
    return !!tt && (tt.e || e.nth <= tt.r.length);
  }
  function makeLink(r, text) {
    var a = document.createElement('span');
    a.setAttribute(MARK, LINK_MARK);
    a.setAttribute('role', 'link');
    a.setAttribute('tabindex', '0');
    a.textContent = text;
    var open = function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* none */ }
      hideLabel();
      post({ kind: 'openConversation', sourceId: String(r.sourceId), sessionId: String(r.sessionId) });
    };
    a.addEventListener('mouseenter', function () { showLabel(a, kit.mentionTip(r)); });
    a.addEventListener('mouseleave', hideLabel);
    a.addEventListener('click', open);
    a.addEventListener('keydown', function (ev) { if (ev && ev.key === 'Enter') open(ev); });
    return a;
  }
  /* Turns a link back into text and joins it with the text nodes on either side: the link was split out of one text
     node, and a name is found only within one. */
  function unlink(a) {
    var p = a.parentNode;
    if (!p) return;
    var t = document.createTextNode(a.textContent || '');
    p.insertBefore(t, a);
    p.removeChild(a);
    var kids = p.childNodes, at = -1;
    for (var i = 0; i < kids.length; i++) if (kids[i] === t) { at = i; break; }
    var s = at, e = at;
    while (s > 0 && kids[s - 1].nodeType === 3) s--;
    while (e >= 0 && e < kids.length - 1 && kids[e + 1].nodeType === 3) e++;
    if (s === e) return;
    var joined = '';
    for (var k = s; k <= e; k++) joined += kids[k].nodeValue;
    kids[s].nodeValue = joined;
    for (var m = e; m > s; m--) p.removeChild(kids[m]);
  }
  function unlinkAll() {
    var found = all(document, LINK_SEL);
    for (var i = 0; i < found.length; i++) unlink(found[i]);
    if (found.length) hideLabel();
    linksDrawn = 0;
  }
  function linkAll(list) {
    if (!convos.on || !convos.ix || !convos.ix.size) { if (linksDrawn || one(document, LINK_SEL)) unlinkAll(); return; }
    var last = list.length ? list[list.length - 1].turnEl : null, now = Date.now(), wait = 0;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.kind !== 'assistant') continue;
      if (!finished(e, last)) { if (finishedAt) finishedAt.delete(e.node); continue; }
      var since = finishedAt ? finishedAt.get(e.node) : 0;
      if (since === undefined) { finishedAt.set(e.node, now); since = now; }
      if (now - since < LINK_HOLD_MS) { wait = Math.max(wait, LINK_HOLD_MS - (now - since)); continue; }
      var was = linkedAs ? linkedAs.get(e.node) : null;
      if (was && was.version === convos.version && was.looks === looks(e.node)) continue;
      var kids = e.node.children || [];
      for (var k = 0; k < kids.length; k++) if (!isOurs(kids[k])) kit.linkMentions(kids[k], convos.ix, makeLink);
      if (linkedAs) linkedAs.set(e.node, { version: convos.version, looks: looks(e.node) });
    }
    linksDrawn = all(document, LINK_SEL).length;
    if (wait && !linkDue) linkDue = setTimeout(function () { linkDue = 0; refresh(); }, wait);
  }

  /* A CSS colour the user typed, or '' for anything else: nothing but a colour may reach the stylesheet. */
  var SAFE_COLOR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/deg]+\))$/;

  /* How wide the scroller's scrollbar is, read off the page: 0 where scrollbars are drawn over the content. */
  function scrollbarOf(sc) {
    if (!sc) return 0;
    var cs = styleOf(sc) || {};
    return Math.max(0, Math.round((sc.offsetWidth || 0) - (sc.clientWidth || 0)
      - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0)));
  }

  /*
   * The room taken by the plan bar and by the row below the message box makes Codex's scroller shorter, and the stamps
   * and the rail's padding make the turns taller. Codex scrolls back to the end after such a change only while it is
   * following the end: it stops following when the user scrolls up, and starts again only when the user scrolls back
   * down or clicks its arrow. When this script's rail brings the conversation back to the end after a scroll up, Codex
   * is still not following the end: the room the plan bar takes leaves the end under the message box, and when the
   * turns grow, Codex, which measures them on its next frame, keeps the passage at the top of the view where it was and
   * moves the end down by what they grew.
   *
   * Each pass reads how far the scroller is from its end before it changes anything. Codex itself treats a
   * conversation within END_PX of its end as being at its end, and if the scroller was that close, it is brought back
   * to the same distance after the pass and held there on each frame for END_HOLD_MS, which outlasts Codex's
   * measuring. A wheel, touch, key or press anywhere in the page ends the hold. The hold also ends when the end moves
   * away by more than the height of the view, which means Codex is showing another part of the conversation or another
   * conversation. Passes run inside one another, and only the outermost one measures.
   */
  var END_PX = 24, END_HOLD_MS = 500, END_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  var endDepth = 0, endBefore = -1, endHold = null;
  function fromEnd(sc) {
    return sc && sc.clientHeight > 0 ? Math.max(0, (sc.scrollHeight || 0) - sc.clientHeight - (sc.scrollTop || 0)) : -1;
  }
  function backToEnd(sc, want) {
    var d = fromEnd(sc);
    if (d > want + 0.5) { try { sc.scrollTop = (sc.scrollTop || 0) + d - want; } catch (e) { /* gone */ } }
  }
  function keepEnd(pass) {
    if (endDepth++ === 0) endBefore = fromEnd(scrollerEl());
    try { return pass(); } finally {
      if (--endDepth === 0 && endBefore >= 0 && endBefore <= END_PX) {
        var sc = scrollerEl();
        if (sc) { backToEnd(sc, endBefore); holdEnd(sc, endBefore); }
      }
    }
  }
  var nextFrame = function (fn) { return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16); };
  function holdEnd(sc, want) {
    if (endHold && endHold.sc === sc) { endHold.until = Date.now() + END_HOLD_MS; endHold.want = Math.min(endHold.want, want); return; }
    if (endHold) endHold.stop();
    var h = { sc: sc, want: want, until: Date.now() + END_HOLD_MS, frame: 0 };
    var opts = { capture: true, passive: true };
    h.stop = function () {
      if (h.frame) { try { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h.frame); else clearTimeout(h.frame); } catch (e) { /* gone */ } }
      h.frame = 0;
      if (endHold === h) endHold = null;
      for (var i = 0; i < END_INPUT.length; i++) { try { document.removeEventListener(END_INPUT[i], h.stop, opts); } catch (e) { /* none */ } }
    };
    var tick = function () {
      h.frame = 0;
      if (endHold !== h) return;
      if (sc.isConnected === false || Date.now() > h.until || fromEnd(sc) - h.want > sc.clientHeight) { h.stop(); return; }
      backToEnd(sc, h.want);
      h.frame = nextFrame(tick);
    };
    endHold = h;
    for (var i = 0; i < END_INPUT.length; i++) { try { document.addEventListener(END_INPUT[i], h.stop, opts); } catch (e) { /* none */ } }
    h.frame = nextFrame(tick);
  }

  var sheet = null, sheetText = '';
  var OWN_TIME_CLASS = 'codex-extras-own-time';
  function dropSheet() {
    if (sheet) { try { sheet.remove(); } catch (e) { /* gone */ } }
    sheet = null; sheetText = '';
    planRoomOn = false;
  }
  /* One stylesheet of this script's own for everything it shows. Stamps copy Claude Code Plus's: the editor's
     monospace font, 0.8em, and the message's text colour at 60% opacity. */
  function restyle() {
    var css = '.codex-extras-stamp{font-family:var(--vscode-editor-font-family,monospace);font-size:.8em;font-weight:normal;'
      + 'font-style:normal;opacity:.6;line-height:1.4;white-space:normal;overflow-wrap:anywhere;user-select:none;pointer-events:none;}'
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
    if (view.timestamps) css += SEL.assistant + ':has(> [' + TIMED_ATTR + ']) ' + SEL.sent + '{display:none !important;}'
      + '.' + OWN_TIME_CLASS + '{display:none !important;}';
    /* While the rail is drawn, the scroller's content gets right padding as wide as the rail, as in Claude Code Plus.
       The scroller itself gets none, so its scrollbar stays at the right edge of the page and the rail sits just left
       of it. */
    var railed = !!(view.navigation && nav && nav.isConnected), gutter = railed ? scrollbarOf(scrollerEl()) : 0;
    if (railed) css += SEL.scroller + ' > *{padding-inline-end:' + (RAIL_W + 2) + 'px !important;}';
    if ((bar && bar.isConnected) || (strip && strip.style.display !== 'none')) {
      css += '[data-codex-composer-root]{margin-bottom:' + ROW_ROOM + 'px !important;}';
    }
    planRoomOn = planShown();
    if (planRoomOn) css += '[data-codex-composer-root]{margin-top:' + PLAN_ROOM + 'px !important;}';
    if (codexMeterHidden) css += '.' + HIDE_CLASS + '{display:none !important;}';
    if (convos.on) css += LINK_SEL + '{color:var(--vscode-textLink-foreground,#4493f8);cursor:pointer;}' + LINK_SEL + ':hover{text-decoration:underline;}';
    css += NAV_CSS;
    if (gutter) {
      css += '.codex-extras-rail{right:' + gutter + 'px;}.codex-extras-panel{right:' + (RAIL_W + 2 + gutter) + 'px;'
        + 'width:min(' + PANEL_W + 'px,calc(100vw - ' + (RAIL_W + 14 + gutter) + 'px));}';
    }
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
  var NAV_CSS = '.codex-extras-rail{position:fixed;right:0;top:0;z-index:' + Z_RAIL + ';'
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
    + 'padding:5px 0;border-radius:5px;box-sizing:border-box;' + pageFont(11)
    + 'line-height:1.4;background:var(--vscode-editorWidget-background,rgba(35,35,35,.98));'
    + 'border:1px solid var(--vscode-widget-border,rgba(255,255,255,.14));box-shadow:0 4px 14px rgba(0,0,0,.45);}'
    + '.codex-extras-panel-head{position:sticky;top:0;z-index:1;padding:3px 8px 6px 8px;'
    + 'background:var(--vscode-editorWidget-background,rgba(35,35,35,.98));}'
    + '.codex-extras-filter{width:100%;margin:0;padding:3px 6px;box-sizing:border-box;font-size:11px;border-radius:3px;'
    + 'outline:none;background:var(--vscode-input-background,rgba(0,0,0,.3));'
    + 'color:var(--vscode-input-foreground,#ddd);border:1px solid var(--vscode-input-border,rgba(255,255,255,.16));}'
    + '.codex-extras-row{padding:4px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    + 'color:var(--vscode-foreground,#ccc);}'
    + '.codex-extras-row:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.08));}'
    + '.codex-extras-rule{display:flex;align-items:center;gap:6px;padding:4px 10px;opacity:.6;cursor:pointer;font-size:10px;}'
    + '.codex-extras-rule:hover{opacity:.9;}'
    + '.codex-extras-rule-line{flex:1 1 auto;height:1px;background:var(--vscode-widget-border,rgba(255,255,255,.22));}'
    /* The Agent map's pill, its rows and its buttons, hovered as Claude Code's are. */
    + '[data-codex-extras="agents"]:hover{background:color-mix(in srgb,var(--vscode-foreground,#ccc) 18%,transparent) !important;}'
    + '[data-codex-extras="map-agent"]:hover,summary[data-codex-extras-card]:hover{background-color:var(--vscode-list-hoverBackground,rgba(255,255,255,.08)) !important;}'
    + 'summary[data-codex-extras-card]::-webkit-details-marker{display:none;}'
    + 'details[open]>summary [data-codex-extras-more]{transform:rotate(90deg);}'
    + '[data-codex-extras="map-close"]:hover,[data-codex-extras="map-act"]:hover{background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.12)) !important;}'
    /* Claude Code's dialog border while the dialog holds the focus: the active input border at 65%. */
    + '[data-codex-extras="map-dialog"]:focus-within{border-color:color-mix(in srgb,var(--vscode-inputOption-activeBorder,#2488db) 65%,transparent) !important;}';

  /* ── the list of your own messages, and stepping between them ── */
  var nav = null, railBox = null, panel = null, rowsBox = null, filter = null, chevron = null;
  /* Placed by script rather than by top 50% and translateY(-50%), which leave the rail half a pixel off whenever the page
     and the rail differ in height by an odd number, and blur its arrows. */
  var railResizeWired = false, RAIL_GAP = 4;
  /* In a page too short for the rail to be centred above the plan bar, as on Windows while Codex shows its setup notice
     over the message box, it is moved up just far enough to end RAIL_GAP above the bar, so the bar covers none of its
     buttons. It goes no higher than RAIL_GAP below the top of the conversation's scroller: above that is Codex's header,
     whose New chat button the rail would cover. A page with no room between the two keeps the rail over the bar. */
  function placeRail() {
    var h = globalThis.innerHeight;
    if (!(railBox && railBox.isConnected && h > 0)) return;
    var height = railBox.offsetHeight, top = Math.round((h - height) / 2);
    var barTop = planShown() ? parseFloat(planBar.el.style.top) : NaN;
    if (barTop > 0 && top + height > barTop - RAIL_GAP) {
      var sc = rectOf(scrollerEl()), floor = sc ? Math.round((sc.top || 0) + RAIL_GAP) : 0;
      top = Math.max(floor, Math.min(top, Math.round(barTop - RAIL_GAP - height)));
    }
    railBox.style.top = Math.max(0, top) + 'px';
  }
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
      + 'overflow:hidden;padding:6px 9px;border-radius:4px;box-sizing:border-box;' + pageFont(11) + 'line-height:1.45;'
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
      h = (rectOf(box) || {}).height || h;
      var below = bottomOf(r) + 2, over = (r.top || 0) - h - 2;
      box.style.top = Math.round(vh && below + h > vh - 8 && over >= 8 ? over : below) + 'px';
    }
    tipBox = box;
  }

  /*
   * scrollIntoView rather than an arithmetic scrollTop: the container is Codex's own and carries its own scroll padding
   * for its sticky header, which scrollIntoView honours and a computed position does not. Only that container is
   * scrolled: VS Code's box round a webview is a few pixels taller than the webview, and scrolling it moved the whole
   * page up under the tab bar.
   */
  function scrollToNode(node) {
    try { node.scrollIntoView({ block: 'start', behavior: 'auto', container: 'nearest' }); return; } catch (e) { /* older signature */ }
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
    placeRail();
    if (typeof ResizeObserver === 'function') new ResizeObserver(placeRail).observe(railBox);
    if (!railResizeWired) {
      railResizeWired = true;
      try { globalThis.addEventListener('resize', placeRail); } catch (e) { /* no window events */ }
    }
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
        /* tabular-nums on the time keeps every row's message starting at the same x. */
        if (when) {
          var clock = document.createElement('span');
          clock.style.fontVariantNumeric = 'tabular-nums';
          clock.style.fontKerning = 'none';
          clock.textContent = when;
          row.appendChild(clock);
        }
        row.appendChild(document.createTextNode((when ? '  ' : '') + (text.length > ROW_CHARS ? text.slice(0, ROW_CHARS) + '\u2026' : text)));
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
     conversation when there is none yet. Hovering it shows its label in the same box as a row's, because Codex's page
     does not reliably show native titles. */
  function addRule(rule) {
    var label = 'Context compacted' + (rule.at ? ' ' + clockOf({ ms: rule.at, secs: false }) : '');
    var d = document.createElement('div');
    d.setAttribute('class', 'codex-extras-rule');
    d.setAttribute(MARK, 'nav-rule');
    d.addEventListener('mouseenter', function () { showTip(d, label); });
    d.addEventListener('mouseleave', hideTip);
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
    if (!(anythingOn() || view.buttons !== false) || typeof MutationObserver !== 'function' || !document.body) { unwatch(); return; }
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
   * Codex's page has turns and this script recognised none of the messages in them, or no message box: a Codex release
   * has most likely changed an attribute it selects by. The pages boxWithheld() describes are left out: a sub-agent's
   * conversation there can hold a turn with no message in it yet. Told to the host once MISS_PASSES passes in a row
   * have seen it and at least MISS_MS has gone by since the first, so a conversation still being drawn does not count,
   * and told again only after the messages have been found in between. The message holds counts, flags and this
   * script's version, nothing else.
   */
  var MISS_PASSES = 3, MISS_MS = 5000, missRun = 0, missSince = 0, missTold = false;
  /* Tells the host that Codex has drawn its message box, which means Codex's own code in the page is running and takes
     the host's messages. The host waits for this before it sends a page to a conversation (src/patching.js goFollowed). */
  var boxTold = false;
  function noteBox() {
    if (boxTold || !composerRoot()) return;
    boxTold = true;
    post({ kind: 'boxShown' });
  }
  function noteMisses(list) {
    var turns = list ? lastTurns : all(document, SEL.turn).length;
    var composer = !!composerRoot();
    if (!turns || boxWithheld() || (list && list.length && composer)) { missRun = 0; missSince = 0; missTold = false; showWarn(false); return; }
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
        + 'display:flex;align-items:center;justify-content:center;' + pageFont(11, 700) + 'cursor:help;'
        + 'background:var(--vscode-editorWarning-foreground,#cca700);color:var(--vscode-editor-background,#1e1e1e);';
      labelled(warn, WARN_SAID);
      document.body.appendChild(warn);
    }
    var sc = rectOf(scrollerEl());
    var top = Math.round(sc && sc.height > 0 ? (sc.top || 0) + 4 : 36) + 'px';
    if (warn.style.top !== top) warn.style.top = top;
  }

  /*
   * Codex itself draws a reply's image when the link is a local file or a data: URL. An image at a web address it loads
   * only after a server-side check that needs a ChatGPT login, and otherwise draws a disabled placeholder. This script
   * turns those into plain links, so nothing is fetched from them and the address can still be opened. While
   * codexPlus.replyImages is off (view.replyImages) it also turns the others into "[Image]", with the path in the
   * hover, as Claude Code's panel does.
   *
   * The address is not in the page, since the placeholder carries only the alt text. It is read from the props React
   * keeps on the element: the nearest component above it given both `src` and `blockRemoteMedia`, which is Codex's
   * markdown media component.
   */
  var IMG_HIDDEN = MARK + '-img-hidden', IMG_SRC = MARK + '-img-src', IMG_STAND = 'img-stand', IMG_UP = 60;
  var REMOTE = /^(?:https?:)?\/\//i;
  /* The React fiber React keeps on a DOM element, or null. */
  function fiberOf(el) {
    try { for (var k in el) { if (k.indexOf('__reactFiber$') === 0) return el[k] || null; } } catch (e) { /* not ours to read */ }
    return null;
  }
  function mediaOf(el) {
    var f = fiberOf(el);
    for (var i = 0; f && i < IMG_UP; i++, f = f.return) {
      var p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.src === 'string' && p.src && 'blockRemoteMedia' in p) {
        return { src: p.src, alt: typeof p.alt === 'string' ? p.alt : '' };
      }
    }
    return null;
  }
  /* What stands in for the element, as [kind, text, hover], or null to leave Codex's own drawing. */
  function standFor(media) {
    if (REMOTE.test(media.src)) return ['link', media.alt || media.src, media.src];
    if (view.replyImages !== false) return null;
    return ['image', '[Image]', /^data:/i.test(media.src) ? (media.alt || 'An image written into the reply') : media.src];
  }
  function sameStand(n, src, want) {
    return !!(n && n.getAttribute && n.getAttribute(MARK) === IMG_STAND && n.getAttribute(IMG_SRC) === src
      && n.textContent === want[1] && n.title === want[2]);
  }
  function makeStand(el, src, want) {
    var link = want[0] === 'link' && !(el.closest && el.closest('a'));
    var n = document.createElement(link ? 'a' : 'span');
    n.setAttribute(MARK, IMG_STAND);
    n.setAttribute(IMG_SRC, src);
    if (link) n.setAttribute('href', src);
    n.style.cssText = link ? 'word-break:break-all;' : 'opacity:0.75;';
    n.textContent = want[1];
    n.title = want[2];
    return n;
  }
  var imageCounts = { media: 0, links: 0, hidden: 0 };
  function fixImages() {
    var on = view.buttons !== false;
    var counts = { media: 0, links: 0, hidden: 0 };
    if (on && document.head && !one(document, 'style[' + MARK + '="' + IMG_STAND + '"]')) {
      var css = document.createElement('style');
      css.setAttribute(MARK, IMG_STAND);
      /* Codex caps a reply's image at 10rem high, too small to read a chart in. The cap here is 640 by 480 px, the size
         of a matplotlib figure saved with the defaults, and 70% of the panel's height. */
      css.textContent = '[' + IMG_HIDDEN + ']{display:none !important;}'
        + SEL.assistant + ' img[class*="max-h-["]{max-height:min(480px,70vh) !important;max-width:min(100%,640px) !important;'
        + 'width:auto !important;height:auto !important;}';
      document.head.appendChild(css);
    }
    var found = on ? all(document, SEL.assistant + ' img,' + SEL.assistant + ' button[disabled]') : [];
    for (var i = 0; i < found.length; i++) {
      var el = found[i];
      if (isOurs(el) || (el.closest && el.closest('[' + MARK + ']'))) continue;
      var media = mediaOf(el);
      if (!media) continue;
      counts.media++;
      var want = standFor(media), next = el.nextElementSibling;
      if (!want) {
        if (el.hasAttribute(IMG_HIDDEN)) el.removeAttribute(IMG_HIDDEN);
        if (next && next.getAttribute(MARK) === IMG_STAND) next.remove();
        continue;
      }
      if (!sameStand(next, media.src, want)) {
        if (next && next.getAttribute(MARK) === IMG_STAND) next.remove();
        el.parentNode.insertBefore(makeStand(el, media.src, want), el.nextSibling);
      }
      if (!el.hasAttribute(IMG_HIDDEN)) el.setAttribute(IMG_HIDDEN, '');
      counts[want[0] === 'link' ? 'links' : 'hidden']++;
    }
    var stands = all(document, '[' + MARK + '="' + IMG_STAND + '"]:not(style)');
    for (var j = 0; j < stands.length; j++) {
      var before = stands[j].previousElementSibling;
      if (!on || !before || !before.hasAttribute(IMG_HIDDEN)) stands[j].remove();
    }
    if (!on) {
      var hidden = all(document, '[' + IMG_HIDDEN + ']');
      for (var h = 0; h < hidden.length; h++) hidden[h].removeAttribute(IMG_HIDDEN);
      var sheetOf = one(document, 'style[' + MARK + '="' + IMG_STAND + '"]');
      if (sheetOf) sheetOf.remove();
    }
    imageCounts = counts;
  }

  /*
   * A Stop hook keeps a turn going by handing the model a prompt as the next user message, and Codex draws it as one:
   * the user's bubble, with "Hook feedback" under it. The work plan plugin asks this way, at the end of a turn, for the
   * plan and the brief to be brought up to date, and its prompt runs to several lines. The script folds that bubble to
   * one dim line. A click toggles it.
   *
   * It folds other hooks' prompts too: after the window reloads, Codex no longer says which hook a prompt came from.
   * The notices this extension sends a conversation about work it left running (src/detached-ends.js, src/bg-ends.js)
   * go in as user messages as well, and are folded the same way.
   */
  var HOOK = MARK + '-hook', HOOK_UP = 16, HOOK_SHEET = 'hook-fold', HOOK_WIRED = '__codexExtrasHookWired';
  var OWN_NOTICE = /^Codex Plus notice, not a message from the user:/;
  function hookFed(el) {
    var f = fiberOf(el);
    for (var i = 0; f && i < HOOK_UP; i++, f = f.return) {
      var p = f.memoizedProps, item = p && typeof p === 'object' ? p.item : null;
      if (item && typeof item === 'object' && item.type === 'user-message') return item.hookFeedback === true || OWN_NOTICE.test(String(item.message || ''));
    }
    return false;
  }
  function toggleHook(b) {
    if (b.getAttribute(HOOK) === null) return;
    try { var sel = globalThis.getSelection && globalThis.getSelection(); if (sel && !sel.isCollapsed) return; } catch (e) { /* none */ }
    b.setAttribute(HOOK, b.getAttribute(HOOK) === 'open' ? 'fold' : 'open');
  }
  var hookCount = 0;
  function foldHooks() {
    var on = view.buttons !== false, n = 0;
    var sheetEl = one(document, 'style[' + MARK + '="' + HOOK_SHEET + '"]');
    if (on && document.head && !sheetEl) {
      var css = document.createElement('style');
      css.setAttribute(MARK, HOOK_SHEET);
      /* The colour goes to every element inside as well: Codex's markdown root in the bubble sets its own. */
      css.textContent = SEL.bubble + '[' + HOOK + ']{background:transparent !important;box-shadow:none !important;cursor:pointer;}'
        + SEL.bubble + '[' + HOOK + '],' + SEL.bubble + '[' + HOOK + '] *{color:var(--vscode-descriptionForeground,#9d9d9d) !important;}'
        + SEL.bubble + '[' + HOOK + '="fold"] [data-markdown-text-tone]{display:-webkit-box !important;-webkit-box-orient:vertical;'
        + '-webkit-line-clamp:1;overflow:hidden;}';
      document.head.appendChild(css);
    }
    var bubbles = on ? all(document, SEL.bubble) : [];
    for (var i = 0; i < bubbles.length; i++) {
      var b = bubbles[i];
      if (!hookFed(b)) { if (b.getAttribute(HOOK) !== null) b.removeAttribute(HOOK); continue; }
      n++;
      if (b.getAttribute(HOOK) === null) b.setAttribute(HOOK, 'fold');
      if (!b[HOOK_WIRED]) { b[HOOK_WIRED] = true; b.addEventListener('click', toggleHook.bind(null, b)); }
    }
    if (!on) {
      var marked = all(document, '[' + HOOK + ']');
      for (var m = 0; m < marked.length; m++) marked[m].removeAttribute(HOOK);
      if (sheetEl) sheetEl.remove();
    }
    hookCount = n;
  }

  /*
   * Tells the host the id Codex puts on the newest turn this page shows, each time it changes. The host recorded which
   * conversation each started turn belongs to, and a tab opened on Codex's new-conversation route has no other way of
   * saying which conversation it went on to show. Codex first draws a turn under a placeholder key, which the host
   * finds no conversation for. Only the id is sent.
   */
  var shownTurn = '';
  function noteShownTurn(list) {
    var key = '';
    for (var i = list.length - 1; i >= 0 && !key; i--) key = list[i].turn || '';
    if (key === shownTurn) return;
    shownTurn = key;
    if (key) post({ kind: 'turnShown', turn: key.slice(0, 100) });
  }

  var refreshing = false;
  function refresh() {
    if (refreshing || !document.body) return;
    refreshing = true;
    try { keepEnd(refreshPass); } catch (e) { /* this is Codex's page: a fault here leaves everything of its own as it was */ }
    finally { refreshing = false; }
  }
  function refreshPass() {
    fixImages();
    foldHooks();
    var list = entries();
    noteBox();
    noteMisses(list);
    if (!list) { dropNav(); return; }
    noteShownTurn(list);
    var users = stampAll(list);
    colourAll(users);
    try { linkAll(list); } catch (e) { /* the links wait for the next pass */ }
    if (view.navigation) buildNav(users); else dropNav();
    if (anythingOn() || view.buttons !== false) restyle(); else dropSheet();
    placeBar();
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
      buttons: { setting: view.buttons !== false, composerFound: !!composerRoot(), withheld: boxWithheld(),
        drawn: !!((tools && tools.isConnected) || (meterBtn && meterBtn.isConnected)), inToolbar: rowMode === 'row', inBoxLine: rowMode === 'line',
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
      /* Images in replies: how many of Codex's media elements were read, and how many of them stand behind a link or
         behind "[Image]". */
      images: { media: imageCounts.media, links: imageCounts.links, hidden: imageCounts.hidden, setting: view.replyImages !== false },
      /* Prompts a Stop hook gave the model, folded to one line. */
      hookPrompts: { folded: hookCount },
      conversationLinks: { on: convos.on, known: convos.ix ? convos.ix.size : 0, drawn: all(document, LINK_SEL).length },
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
    else if (m.type === 'codex-extras-prefill' && typeof m.text === 'string' && m.id) takePrefill(m);
    else if (m.type === 'codex-extras-info') showInfo(m);
    else if (m.type === 'codex-extras-plan') tookPlan(m);
    else if (m.type === 'codex-extras-usage') { usage = usageFrom(m.usage); if (document.body) placeBar(); drawMap(); }
    else if (m.type === 'codex-extras-agent-map') {
      agentMap = m.shown === true && Array.isArray(m.wakeups) && Array.isArray(m.agents) ? m : null;
      if (agentMap) drawMap(); else closeMap();
      if (document.body) placeBar();
    }
    else if (m.type === 'codex-extras-compacted') compacted(m);
    else if (m.type === 'codex-extras-plan-bar') {
      planBarMsg = { on: m.on === true, summary: m.on === true && m.summary && typeof m.summary === 'object' ? m.summary : null };
      if (document.body) placeBar();
    }
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
        contextMeter: m.contextMeter !== false, replyImages: m.replyImages !== false };
      /* Turned on from this page's own button: one chime, so the user hears at once whether sound comes out. */
      if (chimeAsked) { chimeAsked = false; if (!wasOn && view.chime) chime('done'); }
      if (!anythingOn() && view.buttons === false) showWarn(false);
      ready();
      placeBar();
    } else if (m.type === 'codex-extras-conversations') {
      var self = m.self && typeof m.self === 'object' ? m.self : {};
      convos.on = m.on === true && Array.isArray(m.list);
      convos.version++;
      convos.ix = convos.on ? kit.mentionIndex(m.list, { sourceId: 'codex', sessionId: typeof self.sessionId === 'string' ? self.sessionId : '',
        title: typeof self.title === 'string' ? self.title : '' }) : null;
      /* Drawn again from the new list, so a link to a conversation gone or renamed does not stay. */
      unlinkAll();
      ready();
    } else if (m.type === 'codex-extras-user-times') {
      hostWhen = Array.isArray(m.times)
        ? m.times.filter(function (n) { return typeof n === 'number' && isFinite(n); })
        : null;
      hostTurns = {};
      if (m.turns && typeof m.turns === 'object') {
        Object.keys(m.turns).forEach(function (k) {
          if (typeof m.turns[k] === 'string' && m.turns[k].length <= 600) hostTurns[k] = m.turns[k];
        });
      }
      hostTurnTimes = {};
      if (m.turnTimes && typeof m.turnTimes === 'object') {
        var times = function (a) { return Array.isArray(a) ? a.filter(function (n) { return typeof n === 'number' && isFinite(n); }).slice(0, 8) : []; };
        Object.keys(m.turnTimes).forEach(function (k) {
          var v = m.turnTimes[k];
          if (!v || typeof v !== 'object') return;
          hostTurnTimes[k] = { u: times(v.u), r: times(v.r), d: typeof v.d === 'number' && isFinite(v.d) && v.d > 0 ? v.d : 0, e: v.e === true };
        });
      }
      hostCompactions = Array.isArray(m.compactions)
        ? m.compactions.filter(function (c) { return c && typeof c.after === 'number' && c.after >= 0; })
          .map(function (c) { return { after: Math.floor(c.after), at: typeof c.at === 'number' && isFinite(c.at) ? c.at : 0 }; })
        : [];
      ready();
    }
  });

  /* The approval and conflict watchers start with the page rather than waiting for the host to speak: they are not
     among the marks, they carry no setting of their own, and the host has nothing to tell them. */
  approvalReady();
  conflictReady();
})();
