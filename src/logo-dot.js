// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation row's icon in the Conversations view: its agent's logo with a dot in its state's colour on the corner
 * (the work plan host protocol in claude-code-extras' docs/work-plan-host.md, "The active conversation"). The logo is
 * read from the agent's own installed extension and the composite written into this extension's global storage, so no
 * copy of anyone's logo ships here.
 *
 * The logo is drawn inside a 24-unit box with a circle masked out round the dot, so the dot reads against any theme. A
 * logo that is not one SVG element with a viewBox is not composited, and the row keeps its plain state icon.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* The Conversations view's state colours, as SVG fills. */
const DOT = { prompt: '#f59e0b', needs: '#f59e0b', working: '#3b82f6', unread: '#22c55e', idle: '#8b8b8b' };
const BOX = 24;
const R = 4.2;
const GAP = 1.4;

/** The logo with a dot of `color`, or '' when `svg` is not something this knows how to wrap. */
function withDot(svg, color) {
  const text = String(svg || '');
  const open = /<svg\b[^>]*>/i.exec(text);
  const close = text.lastIndexOf('</svg>');
  if (!open || close < open.index) return '';
  const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(open[0]);
  if (!vb) return '';
  const inner = text.slice(open.index + open[0].length, close);
  if (/<script/i.test(inner)) return '';
  const cx = BOX - R, cy = R;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BOX}" height="${BOX}" viewBox="0 0 ${BOX} ${BOX}">`
    + `<defs><mask id="d"><rect width="${BOX}" height="${BOX}" fill="white"/><circle cx="${cx}" cy="${cy}" r="${R + GAP}" fill="black"/></mask></defs>`
    + `<g mask="url(#d)"><svg width="${BOX}" height="${BOX}" viewBox="${vb[1]}" fill="none">${inner}</svg></g>`
    + `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${color}"/></svg>`;
}

/* Written under another name and moved into place: a file is named by its content and never rewritten once it is
   there, so one cut off half way would stay broken for as long as that name is asked for. */
function writeWhole(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
}

/*
 * Icon paths for every state, { [state]: { light, dark } } as file paths, written into `dir` once per logo version; null
 * when either logo is missing or cannot be wrapped.
 */
function iconsFor(logo, dir, cache = new Map(), palette = DOT) {
  if (!logo || !logo.light || !logo.dark) return null;
  let light, dark;
  try { light = fs.readFileSync(logo.light, 'utf8'); dark = fs.readFileSync(logo.dark, 'utf8'); } catch (_) { return null; }
  const key = crypto.createHash('sha1').update(light).update(dark).update(JSON.stringify(palette)).digest('hex').slice(0, 12);
  if (cache.has(key)) return cache.get(key);
  const out = {};
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [state, color] of Object.entries(palette)) {
      const l = withDot(light, color), d = withDot(dark, color);
      if (!l || !d) { cache.set(key, null); return null; }
      const lp = path.join(dir, `logo-${key}-${state}-light.svg`), dp = path.join(dir, `logo-${key}-${state}-dark.svg`);
      if (!fs.existsSync(lp)) writeWhole(lp, l);
      if (!fs.existsSync(dp)) writeWhole(dp, d);
      out[state] = { light: lp, dark: dp };
    }
  } catch (_) { cache.set(key, null); return null; }
  cache.set(key, out);
  return out;
}

module.exports = { withDot, iconsFor, DOT };
