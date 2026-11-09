// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Just enough PNG reading for the screenshots the headless shell writes (8-bit RGB or RGBA, not interlaced), to measure
 * how big a glyph is drawn: the box of the pixels inside a rectangle that differ from the rectangle's own background.
 */
const fs = require('fs');
const zlib = require('zlib');

function read(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const depth = data[8], colour = data[9], interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`unsupported PNG: depth ${depth}, colour ${colour}, interlace ${interlace}`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0, b = y ? px[row - stride + x] : 0, c = x >= channels && y ? px[row - stride + x - channels] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  const at = (x, y) => { const i = y * stride + x * channels; return [px[i], px[i + 1], px[i + 2]]; };
  return { width, height, at };
}

/*
 * The inked box inside `r` ({ x0, y0, x1, y1 } in pixels of the image): its background is the colour most of the
 * rectangle's edge has, and a pixel is ink when one channel differs from that by more than `threshold`.
 */
function ink(img, r, threshold = 40) {
  const x0 = Math.max(0, r.x0), y0 = Math.max(0, r.y0), x1 = Math.min(img.width, r.x1), y1 = Math.min(img.height, r.y1);
  if (x1 <= x0 || y1 <= y0) return null;
  const count = new Map();
  const edge = (x, y) => { const k = img.at(x, y).join(','); count.set(k, (count.get(k) || 0) + 1); };
  for (let x = x0; x < x1; x++) { edge(x, y0); edge(x, y1 - 1); }
  for (let y = y0; y < y1; y++) { edge(x0, y); edge(x1 - 1, y); }
  const bg = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  let ix0 = Infinity, iy0 = Infinity, ix1 = -1, iy1 = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = img.at(x, y);
      if (Math.max(Math.abs(p[0] - bg[0]), Math.abs(p[1] - bg[1]), Math.abs(p[2] - bg[2])) > threshold) {
        if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
      }
    }
  }
  return ix1 < 0 ? { w: 0, h: 0 } : { w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 };
}

module.exports = { read, ink };
