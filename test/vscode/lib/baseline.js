// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Compares element screenshots with an approved copy per platform, in test/vscode/baseline/<platform>/<name>.png. Only
 * what this extension draws is cropped, never Codex's or VS Code's own parts, which change with their releases.
 *
 * Every crop is written to <out>/actual/<platform>/<name>.png. With no approved copy for this platform the crop is only
 * saved, and the run prints a note saying so; update-baseline.js turns a run's crops into the approved copies. With one,
 * the two are compared pixel by pixel: a pixel differs when one of its channels is off by more than TOLERANCE.channel,
 * and the crop fails when more than TOLERANCE.share of its pixels differ. A failure writes
 * <out>/diff/<platform>/<name>.png, the approved copy dimmed with the differing pixels in red.
 *
 * Two runs on one machine drew every crop the same, but for a few pixels of one submenu off by a single level, and the
 * time stamps the masks leave out. Another machine of the same platform can place anti-aliasing a little differently.
 * A channel off by more than 32 of 255 is past that and short of any change of colour a reader would see; 0.2 per cent
 * of a 227 by 156 px menu is 70 px, about one letter. A crop of another size than the approved copy fails on its own,
 * unless it is one pixel off: an element 258.5 px tall is drawn 259 px tall where its top lands on a whole pixel and
 * 258 px where it lands on a half, and how far down a menu opens moves by half pixels from run to run. For the same
 * reason a whole element can come out a pixel to one side: the crop is laid on the approved copy at each offset of at
 * most one pixel across and down, compared on the part both have, and the offset with the fewest differing pixels counts.
 *
 * `masks` are rectangles of the crop, { x, y, w, h }, that are not compared: time stamps.
 */
const fs = require('fs');
const path = require('path');
const pixels = require('./pixels');

const ROOT = path.join(__dirname, '..', 'baseline');
const TOLERANCE = { channel: 32, share: 0.002 };

/* The `w` by `h` pixels of `img` from (`x`, `y`). */
function region(img, x, y, w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let r = 0; r < h; r++) img.data.copy(data, r * w * 4, ((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4);
  return { width: w, height: h, data };
}

function masked(masks, x, y) {
  return masks.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
}

/* { differ, compared } for two images of the same size, and the diff image. */
function diff(a, b, masks = []) {
  const out = Buffer.alloc(a.data.length);
  let differ = 0, compared = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const grey = Math.round((a.data[i] + a.data[i + 1] + a.data[i + 2]) / 9);
      out[i + 3] = 255;
      if (masked(masks, x, y)) { out[i] = grey; out[i + 1] = grey; out[i + 2] = grey + 80; continue; }
      compared++;
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      if (d > TOLERANCE.channel) { differ++; out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; } else { out[i] = grey; out[i + 1] = grey; out[i + 2] = grey; }
    }
  }
  return { differ, compared, image: { width: a.width, height: a.height, data: out } };
}

/* diff of the approved copy `a` and the crop `b`, laid on `a` at the offset that leaves the fewest pixels differing; `masks`
   are in `b`'s pixels. Adds `dx` and `dy`, where `a`'s pixel (x, y) met `b`'s (x + dx, y + dy). */
function closest(a, b, masks = []) {
  let best = null;
  for (const dy of [0, -1, 1]) {
    for (const dx of [0, -1, 1]) {
      const ax = Math.max(0, -dx), ay = Math.max(0, -dy), bx = Math.max(0, dx), by = Math.max(0, dy);
      const w = Math.min(a.width - ax, b.width - bx), h = Math.min(a.height - ay, b.height - by);
      if (w <= 0 || h <= 0) continue;
      const d = diff(region(a, ax, ay, w, h), region(b, bx, by, w, h), masks.map((m) => ({ ...m, x: m.x - bx, y: m.y - by })));
      if (!best || d.differ < best.differ) best = { ...d, dx, dy };
    }
  }
  return best;
}

function baselines({ out, check, note, platform = process.platform }) {
  const dir = (kind) => { const d = path.join(out, kind, platform); fs.mkdirSync(d, { recursive: true }); return d; };
  const results = [];
  /* `png` is the crop as a PNG buffer. */
  function compare(name, png, { masks = [] } = {}) {
    fs.writeFileSync(path.join(dir('actual'), `${name}.png`), png);
    const approved = path.join(ROOT, platform, `${name}.png`);
    if (!fs.existsSync(approved)) {
      note(`no approved ${platform}/${name}.png yet: the crop is kept as actual/${platform}/${name}.png and not compared`);
      results.push({ name, state: 'new' });
      return;
    }
    const a = pixels.decode(fs.readFileSync(approved)), b = pixels.decode(png);
    if (Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1) {
      check(false, `${name} is drawn as approved for ${platform}`, `it is ${b.width}x${b.height} px, the approved copy ${a.width}x${a.height}`);
      results.push({ name, state: 'size', size: [b.width, b.height], approved: [a.width, a.height] });
      return;
    }
    const off = a.width !== b.width || a.height !== b.height;
    const d = closest(a, b, masks);
    const allowed = Math.floor(d.compared * TOLERANCE.share);
    const ok = d.differ <= allowed;
    if (!ok) fs.writeFileSync(path.join(dir('diff'), `${name}.png`), pixels.encode(d.image));
    const left = d.image.width * d.image.height - d.compared;
    check(ok, `${name} is drawn as approved for ${platform} (${d.differ} of ${d.compared} px differ, ${allowed} allowed${left ? `, ${left} masked` : ''}`
      + `${off ? ', one pixel off in size' : ''}${d.dx || d.dy ? ', drawn a pixel to one side' : ''})`,
      ok ? undefined : `see diff/${platform}/${name}.png`);
    results.push({ name, state: ok ? 'same' : 'differs', differ: d.differ, compared: d.compared, allowed });
  }
  return { compare, results };
}

module.exports = { baselines, diff, closest, ROOT, TOLERANCE };
