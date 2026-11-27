// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * How long Codex took to open a page, from the app_start spans in Codex's own log. The lines below have the fields, in
 * the order and with the stage names, of the 12 app_start lines and 7 thread_hydration lines in the 49 Codex.log files
 * of a real VS Code server (Codex 26.1021 on a Mac client); the numbers and the commit hash are made up.
 */
const fs = require('fs');
const path = require('path');
const ot = require('../../src/open-times');

const SAMPLING = 'samplingReason=Network:Recognized samplingRuleId=0aAaAaA0A0aaAaaA0A0AA0:0.0:0';
const thread = (ts, total) => `${ts} [info] client.performance.span backgroundDurationMs=0 buildCommitSha=0a0a0a0a0a0a0a0a0a0a0a0a `
  + `clientPlatform=darwin durationMs=${total} hostType=extension initialSurface=thread marksMs={"renderer_entry_evaluated":6100.5,`
  + `"host_services_ready":6300.1,"renderer_ready":6310.2,"settings_ready":6600.7,"shell_visible":7700.3,"resume_started":7710.4,`
  + `"resume_finished":9310.9,"thread_visible":${total}} name=app_start outcome=success reason=null ${SAMPLING} `
  + 'timingQuality=foreground wallDurationMs=' + total;
const homeTimeout = (ts) => `${ts} [info] client.performance.span backgroundDurationMs=0 buildCommitSha=0a0a0a0a0a0a0a0a0a0a0a0a `
  + 'clientPlatform=darwin durationMs=126870.4 hostType=extension initialSurface=home marksMs={"renderer_entry_evaluated":6318,'
  + '"host_services_ready":6521.6,"renderer_ready":6527.7,"settings_ready":6842.3} name=app_start outcome=failure reason=timeout '
  + `${SAMPLING} timingQuality=foreground wallDurationMs=126870.6`;
const hydration = (ts) => `${ts} [info] client.performance.span backgroundDurationMs=0 buildCommitSha=0a0a0a0a0a0a0a0a0a0a0a0a `
  + 'clientPlatform=darwin durationMs=1600.2 hostType=extension marksMs={"writable_roots_ready":10.1,"metadata_ready":20.2,'
  + '"runtime_resume_started":30.3,"runtime_resume_finished":1500.4,"history_ready":1600.2} name=thread_hydration outcome=success '
  + `reason=null ${SAMPLING} startupResume=true threadKind=regular timingQuality=foreground wallDurationMs=1601`;

module.exports = async ({ eq, tmp }) => {
  const s = ot.parseSpan(thread('2026-11-08 20:58:10.000', 9320.4));
  eq([s.surface, s.outcome, s.ms, s.marks.renderer_entry_evaluated, s.marks.shell_visible, s.at],
    ['thread', 'success', 9320.4, 6100.5, 7700.3, new Date(2026, 10, 8, 20, 58, 10).getTime() - 9320.4],
    'an app_start line gives the surface, the outcome, the whole time and the stages, and starts that long before it was logged');
  const f = ot.parseSpan(homeTimeout('2026-11-08 21:01:08.567'));
  eq([f.surface, f.outcome, f.reason, f.marks.shell_visible], ['home', 'failure', 'timeout', undefined],
    'a page that gave up is read with its reason, and with only the stages it reached');
  eq([ot.parseSpan(hydration('2026-11-08 20:58:11.000')), ot.parseSpan('2026-11-08 20:58:11.000 [info] app routes mounted after 7600 ms')],
    [null, null], 'a span of another name, and any other line, is not an open');

  const line = ot.describe(s, 'UTC');
  eq([/9\.3s/.test(line), /script run 6\.1s/.test(line), /first screen 7\.7s/.test(line), /restoring the conversation 1\.6s/.test(line)],
    [true, true, true, true], 'one open is shown with its whole time, when the script had run, the first screen, and restoring the conversation');
  eq(/TIMEOUT after 127s .*last stage reached: settings_ready/.test(ot.describe(f, 'UTC')), true,
    'one that gave up says so, and names the last stage it got to');

  /* Where the logs are: this extension's log folder has Codex's beside it, and VS Code's logs folder two levels up. */
  const root = tmp('logs');
  const ours = path.join(root, '20261109T010000', 'exthost2', 'xnervwang.codex-plus');
  const w = ot.whereLogs(ours);
  eq([w.own, w.root], [path.join(root, '20261109T010000', 'exthost2', 'openai.chatgpt', 'Codex.log'), root],
    'this window\'s Codex.log is beside this extension\'s log folder');
  eq(ot.whereLogs(undefined), { own: '', root: '' }, 'with no log folder there is nothing to read');

  /* Two windows' logs, read incrementally: a line half written is left for the next read, and a file that shrank is
     read again from its start. */
  const other = path.join(root, '20261108T090000', 'exthost5', 'openai.chatgpt', 'Codex.log');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.mkdirSync(path.dirname(w.own), { recursive: true });
  fs.writeFileSync(other, `2026-11-08 09:00:00.000 [info] Activating Codex extension\n${homeTimeout('2026-11-08 09:02:10.000')}\n`);
  fs.writeFileSync(w.own, `${hydration('2026-11-09 01:00:01.000')}\n${thread('2026-11-09 01:00:02.000', 10000.1)}\n`);
  fs.mkdirSync(path.join(root, '20261109T010000', 'exthost3'), { recursive: true });
  const reader = ot.createOpenTimes(w);
  let all = await reader.read();
  eq(all.map((x) => [x.surface, x.outcome, x.here]), [['home', 'failure', false], ['thread', 'success', true]],
    'every window\'s log is read, oldest open first, with this window\'s marked; a folder with no Codex.log is passed over');
  const half = thread('2026-11-09 01:05:00.000', 20000.2);
  fs.appendFileSync(w.own, half.slice(0, 80));
  all = await reader.read();
  eq(all.length, 2, 'a line still being written is not read');
  fs.appendFileSync(w.own, `${half.slice(80)}\n`);
  all = await reader.read();
  eq([all.length, all[2].ms], [3, 20000.2], 'and is read once it is whole, with nothing read twice');
  fs.writeFileSync(w.own, `${thread('2026-11-09 02:00:00.000', 8000.3)}\n`);
  all = await reader.read();
  eq(all.filter((x) => x.here).map((x) => x.ms), [8000.3], 'a log that was replaced is read from its start');

  const report = ot.reportLines(all, { zone: 'UTC', last: 5 });
  eq([/2 found/.test(report[0]), report.some((l) => /home: 1 opened, median \?, slowest \?, 1 gave up/.test(l)),
    report.some((l) => /thread: 1 opened, median 8\.0s, slowest 8\.0s$/.test(l))], [true, true, true],
  'the report counts the opens per surface, with the median and slowest of those that finished and how many gave up');
  eq(ot.reportLines([], {}).length, 1, 'with nothing found it says so in one line');

  /* Codex 26.1117 writes the spans only while a switch it fetches from OpenAI is on. Without it, its one line per page
     start is the time its app's routes were mounted, measured from the page's start. */
  const mounted = (ts, ms) => `${ts} [info] [startup][renderer] app routes mounted after ${ms}ms`;
  const desk = tmp('desktop-logs');
  const w1 = ot.whereLogs(path.join(desk, '20261122T005035', 'window1', 'exthost', 'xnervwang.codex-plus'));
  const w2 = path.join(desk, '20261122T005035', 'window2', 'exthost', 'openai.chatgpt', 'Codex.log');
  for (const f of [w1.own, w2]) fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(w1.own, ['2026-11-22 00:50:38.535 [info] Activating Codex extension', mounted('2026-11-22 00:50:58.232', 5830),
    mounted('2026-11-22 00:52:11.504', 3453), ''].join('\n'));
  fs.writeFileSync(w2, `${mounted('2026-11-22 00:51:00.000', 4000)}\n${thread('2026-11-22 00:51:30.000', 9000.5)}\n`);
  const starts = await ot.createOpenTimes(w1).read();
  eq(starts.map((x) => [x.surface, x.ms, x.here]), [['page', 5830, true], ['thread', 9000.5, false], ['page', 3453, true]],
    'with no span in a window\'s log, each page start is read from that line; a log that has spans gives only those, so no start counts twice; '
      + 'and a desktop window\'s log beside another window\'s is read too');
  eq(starts[0].at, new Date(2026, 10, 22, 0, 50, 58, 232).getTime() - 5830, 'such a start began that long before its line was logged');
  const crlf = [mounted('2026-11-22 00:50:58.232', 5830), thread('2026-11-22 00:51:30.000', 9000.5), ''].join('\r\n');
  eq([ot.mountsIn(crlf).map((x) => x.ms), ot.spansIn(crlf).map((x) => [x.surface, x.ms])], [[5830], [['thread', 9000.5]]],
    'VS Code\'s log files on Windows end each line with CRLF, and those lines are read the same');
  const told = ot.reportLines(starts, { zone: 'UTC', last: 5 });
  eq([/3 found/.test(told[0]), told.some((l) => /page: 2 opened, median 4\.6s, slowest 5\.8s$/.test(l)),
    told.some((l) => /Codex logged only how long it took to start/.test(l))], [true, true, true],
  'the report counts those starts as pages, and says Codex logged no more about them');
  const pagesOnly = ot.reportLines(starts.filter((x) => x.surface === 'page'), { zone: 'UTC', last: 5 });
  eq([pagesOnly.some((l) => /"script run"/.test(l)), told.some((l) => /"script run" is when/.test(l))], [false, true],
    'and says what "script run" is only when a start it shows has that stage, as the conversation page among them does');
};
