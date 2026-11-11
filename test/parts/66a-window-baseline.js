// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* How the window test compares a crop with its approved copy (test/vscode/lib/baseline.js), on made-up images. */
const { diff, closest, TOLERANCE } = require('../vscode/lib/baseline');

/* A `w` by `h` image, dark, with a light square whose top left corner is at (`x`, `y`). */
function picture(w, h, x, y, size = 6) {
  const data = Buffer.alloc(w * h * 4);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = (r * w + c) * 4, lit = c >= x && c < x + size && r >= y && r < y + size;
      data[i] = data[i + 1] = data[i + 2] = lit ? 220 : 30;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

module.exports = ({ eq }) => {
  const a = picture(20, 16, 6, 5);
  const same = closest(a, picture(20, 16, 6, 5));
  eq([same.differ, same.dx, same.dy], [0, 0, 0], 'a crop drawn as approved differs in no pixel, at no offset');

  const right = closest(a, picture(20, 16, 7, 5)), up = closest(a, picture(20, 16, 6, 4));
  eq([right.differ, right.dx, right.dy, up.differ, up.dx, up.dy], [0, 1, 0, 0, 0, -1],
    'a crop drawn a pixel to the right, or a pixel higher, matches at that offset');
  eq(diff(a, picture(20, 16, 7, 5)).differ > 0, true, 'which a comparison at no offset counts as a difference');

  const far = closest(a, picture(20, 16, 8, 5));
  eq(far.differ > Math.floor(far.compared * TOLERANCE.share), true, 'a crop two pixels to one side still fails');

  const wider = closest(a, picture(21, 16, 6, 5));
  eq([wider.differ, wider.image.width], [0, 20], 'a crop a pixel wider is compared on the part both have');

  const spotted = picture(20, 16, 6, 5);
  for (let c = 0; c < 3; c++) spotted.data[(2 * 20 + c) * 4] = 255;
  eq(closest(a, spotted).differ, 3, 'three pixels of another colour are three that differ');
  eq(closest(a, spotted, [{ x: 0, y: 2, w: 3, h: 1 }]).differ, 0, 'and none once a mask covers them');
};
