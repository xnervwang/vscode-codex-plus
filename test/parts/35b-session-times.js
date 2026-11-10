// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The time beside a row of the Codex session list, held to Claude Code's own list: how long ago as now, 5m, 3h, 2d,
 * 1mo or 1y, then the dates it spans, with the year when it is not this one.
 */
module.exports = async ({ eq }) => {
  const { dateSpan } = require('../../src/sessions-view');
  /* ── the time ── */
  const now = new Date(2026, 10, 9, 18, 0, 0).getTime();
  const ago = (ms) => dateSpan(now - ms, now - ms, now).split(' · ')[0];
  const m = 60e3, h = 60 * m, d = 24 * h;
  eq([ago(30e3), ago(5 * m), ago(3 * h), ago(47 * h), ago(45 * d), ago(400 * d)], ['now', '5m', '3h', '1d', '1mo', '1y'],
    'how long ago is written as Claude Code writes it: now, minutes, hours, days, months, years');
  eq([dateSpan(new Date(2026, 10, 5).getTime(), new Date(2026, 10, 9, 9).getTime(), now),
    dateSpan(new Date(2025, 2, 4).getTime(), new Date(2025, 2, 9).getTime(), now),
    dateSpan(new Date(2025, 11, 30).getTime(), new Date(2026, 0, 2).getTime(), now)],
  ['9h · 11/05→11/09', '1y · 2025/03/04→03/09', '10mo · 2025/12/30→01/02'],
  'the dates carry the year only when it is not this one, and only once for a span within one such year');
};
