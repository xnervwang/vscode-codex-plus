// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Measurements taken inside the page, evaluated through the DevTools protocol: geometry, colours and counts, and none of
 * the conversation's words. `measure` is serialised with its source, so it uses nothing from this module's scope.
 *
 * Codex's elements are found by the attributes Codex itself puts on them (data-user-message-bubble, the composer root,
 * the approval surface), by role for its menus, and by aria-label only where it has nothing else (its buttons).
 */

/* eslint-disable no-undef */
function measure() {
  const R = (el) => { const b = el.getBoundingClientRect(); return { x0: Math.round(b.left), y0: Math.round(b.top), x1: Math.round(b.right), y1: Math.round(b.bottom) }; };
  const vis = (r) => r.x1 > r.x0 && r.y1 > r.y0 && r.x1 > 0 && r.y1 > 0 && r.x0 < innerWidth && r.y0 < innerHeight;
  const ourMark = (e) => e.closest('[data-codex-extras]:not([data-codex-extras="stamp"])');
  const inter = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const shown = (e) => { const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0; };
  const scroller = document.querySelector('[data-app-action-timeline-scroll]');
  const sr = scroller ? R(scroller) : null;
  /* Inside the scroller, only what the scroller does not clip away counts. */
  const clip = (r, el) => {
    if (!sr || !scroller.contains(el)) return r;
    return { x0: Math.max(r.x0, sr.x0), y0: Math.max(r.y0, sr.y0), x1: Math.min(r.x1, sr.x1), y1: Math.min(r.y1, sr.y1) };
  };
  const ours = [...document.querySelectorAll('[data-codex-extras]')].filter((e) => e.tagName !== 'STYLE' && shown(e))
    .map((e) => ({ mark: e.getAttribute('data-codex-extras'), cls: String(e.getAttribute('class') || '').split(' ').filter((c) => c.startsWith('codex-extras')).join(' '),
      rect: clip(R(e), e), el: e, inFrame: !!e.closest('[data-codex-composer-root]') }))
    .filter((o) => vis(o.rect));
  const pick = (sel, label) => [...document.querySelectorAll(sel)].filter((e) => !ourMark(e) && shown(e)).map((e) => ({ label, rect: clip(R(e), e) }));
  const codex = [].concat(pick('[data-user-message-bubble]', 'user bubble'), pick('[data-codex-composer-root]', 'composer frame'),
    pick('[data-codex-approval-surface]', 'approval card'), pick('[data-app-action-timeline-scroll] button', 'button in conversation'),
    pick('[data-codex-composer-root] button', 'composer button'), pick('[data-codex-approval-surface] button', 'approval button'),
    pick('[data-codex-composer-root] span[role="img"][aria-label]', 'context meter'),
    pick('[data-local-conversation-item-target-ids]', 'tool call row')).filter((c) => vis(c.rect));
  /* The list, when open, is a box over the conversation on purpose, as Claude Code Plus's is; the rail is measured
     against the column it stands in, below; stamps sit inside Codex's own elements, above their content. What this
     script puts into the message box's toolbar row is inside the box's frame on purpose, and is held to every one of
     Codex's buttons and its meter there instead. */
  const overlaps = [];
  for (const o of ours) {
    if (o.mark === 'nav' || o.mark === 'nav-list' || o.mark === 'nav-row' || o.mark === 'nav-filter' || o.mark === 'label') continue;
    for (const c of codex) {
      if (o.mark === 'stamp' && (c.label === 'user bubble' || c.label === 'tool call row')) continue;
      if (o.inFrame && c.label === 'composer frame') continue;
      const a = inter(o.rect, c.rect);
      if (a > 0) overlaps.push({ ours: o.mark + (o.cls ? ' ' + o.cls : ''), codex: c.label, area: a, ourRect: o.rect, codexRect: c.rect });
    }
  }
  /* What scrolls through the rail's column: each of these passes under the rail somewhere in its height. */
  const rail = document.querySelector('.codex-extras-rail');
  const railRect = rail && shown(rail) ? R(rail) : null;
  const railColumn = [];
  if (railRect && scroller) {
    for (const e of scroller.querySelectorAll('button, [data-user-message-bubble], .codex-extras-stamp, [data-assistant-message-sent-time]')) {
      if (!shown(e)) continue;
      let r = R(e);
      if (e.classList.contains('codex-extras-stamp')) {
        const rg = document.createRange();
        rg.selectNodeContents(e);
        const tb = rg.getBoundingClientRect();
        if (!(tb.width > 0)) continue;
        r = { x0: Math.round(tb.left), y0: Math.round(tb.top), x1: Math.round(tb.right), y1: Math.round(tb.bottom) };
      } else if (ourMark(e)) continue;
      if (r.x1 > railRect.x0 && r.x0 < railRect.x1) {
        railColumn.push({ what: e.matches('[data-user-message-bubble]') ? 'user bubble' : e.classList.contains('codex-extras-stamp') ? 'our stamp text'
          : e.matches('[data-assistant-message-sent-time]') ? 'reply sent time' : `Codex button (${String(e.getAttribute('aria-label') || '').slice(0, 30)})`,
        x0: r.x0, x1: r.x1, coveredPx: Math.min(r.x1, railRect.x1) - Math.max(r.x0, railRect.x0) });
      }
    }
  }
  /* The row below the message box: its distance from the box's frame, and whether its background shows. */
  const frame = document.querySelector('[data-codex-composer-root]');
  const fr = frame ? R(frame) : null;
  const bar = document.querySelector('[data-codex-extras="bar"]');
  const strip = document.querySelector('[data-codex-extras="figures"]');
  const rectOf = (e) => (e && shown(e) ? R(e) : null);
  const barRect = rectOf(bar), stripRect = rectOf(strip);
  const rgba = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const behind = (el) => {
    const r = el.getBoundingClientRect();
    const was = el.style.visibility;
    el.style.visibility = 'hidden';
    let e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    el.style.visibility = was;
    while (e) { const c = rgba(getComputedStyle(e).backgroundColor); if (c && c.a > 0) return c; e = e.parentElement; }
    return rgba(getComputedStyle(document.body).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
  };
  const tone = (el) => {
    if (!el) return null;
    const own = rgba(getComputedStyle(el).backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
    const under = behind(el);
    const a = own.a * (Number(getComputedStyle(el).opacity) || 1);
    const mix = (k) => Math.round(own[k] * a + under[k] * (1 - a));
    const seen = { r: mix('r'), g: mix('g'), b: mix('b') };
    return { own, under, seen, diff: Math.max(Math.abs(seen.r - under.r), Math.abs(seen.g - under.g), Math.abs(seen.b - under.b)) };
  };
  /* The box a glyph is drawn in: an icon's own, or the line box of a text glyph. How much of it is inked is read
     from a screenshot (run.js), since the page cannot see its own pixels. */
  const glyph = (el) => {
    const svg = el.querySelector('svg');
    if (svg) return { kind: 'svg', rect: R(svg), fontPx: 0 };
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const b = rg.getBoundingClientRect();
    return { kind: 'text', rect: { x0: Math.floor(b.left), y0: Math.floor(b.top), x1: Math.ceil(b.right), y1: Math.ceil(b.bottom) },
      fontPx: parseFloat(getComputedStyle(el).fontSize) };
  };
  const ourButtons = [...document.querySelectorAll('[data-codex-extras="bar-button"]')].filter(shown).map(glyph);
  const codexIcons = [...document.querySelectorAll('[data-codex-composer-root] button svg')].filter((s) => shown(s) && !s.closest('[data-codex-approval-surface]')).map(R)
    .filter((r) => r.y1 > r.y0);
  /* Codex's own sent time under a reply that carries our stamp: two times for one reply when it is shown. */
  const stamped = [...document.querySelectorAll('.codex-extras-stamp-assistant')].map((s) => s.parentElement);
  const replyTimes = stamped.map((b) => b.querySelector('[data-assistant-message-sent-time]')).filter(Boolean);
  const replyTimesShown = replyTimes.filter((t) => getComputedStyle(t).display !== 'none').length;
  /* Codex's toolbar row, and what of this script's stands in it. */
  const toolbar = (() => {
    if (!frame) return null;
    const q = (sel) => frame.querySelector(sel);
    const add = q('[data-composer-navigation-target="add-context"]'), perm = q('[data-composer-navigation-target="permissions"]');
    const model = q('[data-codex-intelligence-trigger]');
    const tools = document.querySelector('[data-codex-extras="tools"]'), meter = document.querySelector('[data-codex-extras="meter"]');
    const buttons = [...frame.querySelectorAll('button')].filter((b) => !ourMark(b) && shown(b)).map((b) => ({
      name: b.getAttribute('data-composer-navigation-target') || (b.hasAttribute('data-codex-intelligence-trigger') ? 'model' : '') || b.getAttribute('aria-label') || '',
      rect: R(b) })).filter((x) => vis(x.rect));
    const meters = [...frame.querySelectorAll('span[role="img"][aria-label]')].filter((e) => !ourMark(e))
      .map((e) => ({ label: e.getAttribute('aria-label'), drawn: e.getBoundingClientRect().width > 0 }));
    const rectIf = (e) => (e && shown(e) && e.getBoundingClientRect().width > 0 ? R(e) : null);
    return { add: add && R(add), perm: perm && R(perm), model: model && R(model), buttons, meters,
      tools: rectIf(tools), toolsInRow: !!(tools && frame.contains(tools)), meter: rectIf(meter), meterInRow: !!(meter && frame.contains(meter)),
      meterText: meter ? meter.textContent : '', toolTones: [...document.querySelectorAll('[data-codex-extras="bar-button"],[data-codex-extras="meter"]')]
        .filter((b) => frame.contains(b)).map((b) => tone(b).diff) };
  })();
  return {
    viewport: [innerWidth, innerHeight], scroller: sr, overlaps, rail: railRect, railColumn, toolbar,
    composer: fr, bar: barRect, strip: stripRect,
    gaps: { barBelowFrame: fr && barRect ? barRect.y0 - fr.y1 : null, stripBelowFrame: fr && stripRect ? stripRect.y0 - fr.y1 : null,
      barInView: barRect ? barRect.y1 <= innerHeight : null, stripInView: stripRect ? stripRect.y1 <= innerHeight : null },
    stripTone: tone(strip), barTone: tone(bar), ourButtons, codexIcons,
    replyTimes: { stamped: replyTimes.length, shown: replyTimesShown,
      blocks: stamped.map((b) => ({ timed: !!b.querySelector('[data-codex-extras-timed]'), hasTime: !!(b.querySelector('.codex-extras-stamp') || {}).textContent })),
      rule: [...document.querySelectorAll('style[data-codex-extras]')].some((s) => s.textContent.includes('codex-extras-timed')) },
    stripText: strip && shown(strip) ? strip.textContent : '',
    ours: ours.map((o) => ({ mark: o.mark, cls: o.cls, rect: o.rect })), codex,
  };
}

const MEASURE = `(${measure.toString()})()`;

/*
 * Whether any element of this script's is drawn over one of Codex's floating boxes (its menus and popovers): every
 * point sampled where the two overlap must hit the floating box, never one of ours. `sel` finds the floating box.
 */
function overFloating(sel) {
  const boxes = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const ours = [...document.querySelectorAll('[data-codex-extras]')].filter((e) => e.tagName !== 'STYLE' && e.getAttribute('data-codex-extras') !== 'stamp');
  let sampled = 0;
  const wrong = [];
  for (const box of boxes) {
    const b = box.getBoundingClientRect();
    for (const o of ours) {
      const r = o.getBoundingClientRect();
      const x0 = Math.max(b.left, r.left), x1 = Math.min(b.right, r.right), y0 = Math.max(b.top, r.top), y1 = Math.min(b.bottom, r.bottom);
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          const x = x0 + ((x1 - x0) * (i + 0.5)) / 5, y = y0 + ((y1 - y0) * (j + 0.5)) / 5;
          const hit = document.elementFromPoint(x, y);
          sampled++;
          if (!hit || !box.contains(hit)) wrong.push({ ours: o.getAttribute('data-codex-extras'), x: Math.round(x), y: Math.round(y), hitOurs: !!(hit && hit.closest('[data-codex-extras]')) });
        }
      }
    }
  }
  return { boxes: boxes.length, boxRects: boxes.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; }), sampled, wrong };
}
const OVER_FLOATING = (sel) => `(${overFloating.toString()})(${JSON.stringify(sel)})`;

module.exports = { MEASURE, OVER_FLOATING };
