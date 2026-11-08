// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Where a sample of the conversation layout is written: this extension's own global storage, one file per sample, named
 * by the second it was taken in the reader's own clock. Nothing of the conversation is in one - the page sends shape and
 * no content (src/page/codex-extras-page.js) - and the file is meant to be read back as a fixture when selectors are
 * written for what Codex draws.
 *
 * `format` is the number to raise when a later version of the page script sends a differently shaped sample, so a file
 * found on disk says which reader it was written for.
 */
const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const PREFIX = 'conversation-layout-';

const two = (n) => String(n).padStart(2, '0');

/** YYYYMMDD-HHMMSS, local time: the file names then sort by when they were taken. */
function stamp(date) {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
    + `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

const fileName = (date) => `${PREFIX}${stamp(date)}.json`;

/** Write one sample into `dir`, making it if it is not there, and return the file's absolute path. */
function save({ dir, date = new Date(), codexVersion = '', sample }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName(date));
  const body = { format: FORMAT, takenAt: date.toISOString(), codexVersion: String(codexVersion || ''), sample };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

module.exports = { FORMAT, PREFIX, stamp, fileName, save };
