// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The record of Codex builds this extension has been verified against (src/supported-versions.json).
 *
 * Two things are checked. The first is the record's own shape, and that the installed build's standing is reported
 * where the spec says: one line in the log, never a dialog, and a line in the status command.
 *
 * The second is that each entry still describes the code as it stands. The three lists in an entry are compared
 * against the places they are read from, namely the host patch's own rule names, the columns the conversation list
 * queries, and the `data-*` attributes the page script looks for. Adding a dependency on a new column or a new
 * attribute therefore fails here until somebody has checked a build with it and said so in the record. Without that
 * comparison the record could go on describing a shape the code had already moved away from.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

/* The one attribute prefix that is ours; everything else matched in the page script is Codex's own anchor. */
const OURS = 'data-codex-extras';
const ATTR = /data-[a-z0-9-]+/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNRECORDED = '26.9999.99999';

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const supported = require('../../src/supported');
  const host = require('../../src/host');
  const files = require('../../src/codex-files');

  /* ── the record's shape ── */
  const raw = fs.readFileSync(supported.RECORD_FILE, 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { bad(`src/supported-versions.json does not parse: ${e.message}`); return; }
  eq([typeof parsed.codex, typeof parsed.comment], ['object', 'string'],
    'the record is an object of Codex builds, with a comment saying what it is for');
  const record = supported.read();
  const all = supported.versions(record);
  if (all.length) ok(`the record names ${all.length} Codex build(s): ${all.join(', ')}`);
  else bad('the record names no Codex build at all');

  for (const v of all) {
    const e = supported.entry(v, record);
    const shape = [/^\d+(\.\d+)+$/.test(v), ISO_DATE.test(e.checked || ''), Number.isFinite(Date.parse(e.checked)),
      Array.isArray(e.hostEdits), e.pagePatch === true, typeof e.stateDb === 'string' && !!e.stateDb,
      Array.isArray(e.threadColumns) && e.threadColumns.length > 0,
      Array.isArray(e.pageAnchors) && e.pageAnchors.length > 0];
    eq(shape, [true, true, true, true, true, true, true, true],
      `${v} carries a version key, a real date it was checked on, and one claim per thing that can break`);
  }

  /* ── each entry still describes this code ── */
  const newest = all[all.length - 1];
  const entry = supported.entry(newest, record);
  eq(entry.hostEdits, host.EDITS.map((e) => e.name),
    `the host patch's ${host.EDITS.length} rules are named in ${newest} exactly as src/host.js has them`);
  eq(entry.threadColumns, files.THREAD_COLUMNS,
    `the state database columns recorded for ${newest} are the ones src/codex-files.js queries`);
  const page = fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8');
  const anchors = [...new Set(page.match(ATTR) || [])].filter((a) => !a.startsWith(OURS)).sort();
  eq(entry.pageAnchors, anchors,
    `Codex's page attributes recorded for ${newest} are the ones src/page/codex-extras-page.js looks for`);

  /* The fixture is a sample taken from one build; that build is the one the parsing was checked against. */
  const fixtures = fs.readdirSync(path.join(root, 'test', 'fixtures'));
  for (const name of fixtures) {
    const m = /^conversation-layout-(\d+(?:\.\d+)+)\.json$/.exec(name);
    if (!m) continue;
    if (supported.verified(m[1], record)) ok(`the build the layout fixture came from, ${m[1]}, is in the record`);
    else bad(`the layout fixture is from Codex ${m[1]}, which the record does not name`);
  }

  /* ── what is said about a build, recorded or not ── */
  eq([supported.verified(newest, record), supported.verified(UNRECORDED, record), supported.verified('', record)],
    [true, false, false], 'a build is verified only when the record names it, and no build at all is not verified');
  const known = supported.statusLines(newest, record);
  eq([known.length >= 2, known[0].includes(newest), known[0].includes(entry.checked), /NOT this build/.test(known.join('\n'))],
    [true, true, true, false], 'a recorded build gets a status line naming it and the date it was checked on');
  eq(known[1].includes(entry.stateDb) && known[1].includes(`the host patch (${entry.hostEdits.length})`) && known[1].includes('the page patch'),
    true, 'and a second line listing what was checked on it');
  const strange = supported.statusLines(UNRECORDED, record);
  eq([/NOT this build/.test(strange[0]), strange[0].includes(UNRECORDED), strange[1].includes(newest)],
    [true, true, true], 'an unrecorded build is reported as unverified, next to what the record does name');
  eq(supported.statusLines('', record)[0].includes('could not be read'), true,
    'and with no Codex installed the status says the record and that the build could not be read');
  eq([supported.noticeLine(newest, record), supported.noticeLine('', record)], ['', ''],
    'nothing is written to the log for a recorded build, or when there is no Codex to judge');
  const notice = supported.noticeLine(UNRECORDED, record);
  eq([notice.includes(UNRECORDED), notice.includes(newest), /refuses as a whole/.test(notice)],
    [true, true, true], 'the log line names the build, what has been verified, and that nothing is disabled by it');

  /* ── and the build this suite is running next to ── */
  const here = fs.existsSync(path.join(require('os').homedir(), '.vscode-server', 'extensions'))
    ? fs.readdirSync(path.join(require('os').homedir(), '.vscode-server', 'extensions'))
      .map((d) => (/^openai\.chatgpt-(\d+(?:\.\d+)+)/.exec(d) || [])[1]).filter(Boolean)
    : [];
  if (!here.length) ok('no Codex is installed here, so there is no installed build to judge');
  else for (const v of here) {
    if (supported.verified(v, record)) ok(`the Codex installed here, ${v}, is in the record`);
    else bad(`Codex ${v} is installed here but is not in the record; check it and add it, or say why not`);
  }

  /* ── the line reaches the log and the status command, and raises no dialog ── */
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { vscode, control } = fake.create();
  fake.install(vscode);
  vscode.workspace.isTrusted = true;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  control.state.config = { codexHome: home, installWorkPlanPlugin: 'never', reopenDroppedTabs: false, patchCodex: 'off' };
  control.state.extensions.set('openai.chatgpt', { extensionPath: tmp('codex'), packageJSON: { version: UNRECORDED } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento(),
    globalStorageUri: vscode.Uri.file(tmp('storage')), extensionPath: root });
  const told = control.state.log.filter((l) => l.includes(UNRECORDED) && l.includes('verified against'));
  const dialogs = control.state.said.filter((s) => String(s.message).includes(UNRECORDED));
  eq([told.length, dialogs.length], [1, 0],
    'activating next to an unrecorded Codex writes one line to the log and puts up no dialog');

  control.state.log.length = 0;
  await control.state.handlers['codexPlus.status']();
  const shown = control.state.log.join('\n');
  eq([/Verified against Codex: NOT this build/.test(shown), shown.includes(UNRECORDED)], [true, true],
    'and the status command shows where the installed build stands');
  control.state.extensions.set('openai.chatgpt', { extensionPath: tmp('codex2'), packageJSON: { version: newest } });
  control.state.log.length = 0;
  await control.state.handlers['codexPlus.status']();
  eq(/Verified against Codex: this build/.test(control.state.log.join('\n')), true,
    'on a recorded build the same line says so instead');
  for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
  ext.deactivate();
};
