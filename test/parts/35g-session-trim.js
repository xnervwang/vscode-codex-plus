// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which groups the session list draws, compared with Claude Code's list and Claude Code Plus. There is no Pinned group:
 * Codex sets no pin flag the list could show, and it deletes nothing old, so a pin would protect nothing. There is no
 * Background group. Archived sessions is there, last, as in Claude Code's list: it is where an archived conversation can
 * be seen again, unarchived or deleted (test/parts/35t-session-archive.js). Rows carry the two hover lines, Open sessions
 * is hidden while empty, and a group the user made is drawn even when empty.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { vscode } = fake.create();
  fake.install(vscode);
  const { group, SessionsModel } = require('../../src/sessions-view');
  const { PINNED_SECTION } = require('../../src/session-groups');

  const t = (n, extra = {}) => ({ id: ID(n), title: `t${n}`, kind: 'user', cwd: '/w', archived: false, pinned: false, section: '',
    createdMs: 1000, updatedMs: 2000 + n, ...extra });
  const threads = [t(1), t(2, { pinned: true }), t(3, { kind: 'subagent' }), t(4, { archived: true }), t(5, { section: 'sec-a' }),
    t(6, { section: PINNED_SECTION })];
  const sections = new Map([[PINNED_SECTION, 'Pinned'], ['sec-a', 'Alpha'], ['sec-empty', 'Empty one']]);
  const keys = (gs) => gs.map((g) => `${g.key}:${g.threads.map((x) => x.title).join('|')}`);

  eq(keys(group(threads, { sections })),
    ['closed:', 'open:', `section:${PINNED_SECTION}:t6`, 'section:sec-a:t5', 'section:sec-empty:', 'ungrouped:t1|t2', 'archived:t4'],
    'no Pinned group of its own and no Background, Archived sessions last; Codex\'s built-in Pinned section only as a group holding what is in it');
  eq(keys(group(threads.filter((x) => x.section !== PINNED_SECTION), { sections })),
    ['closed:', 'open:', 'section:sec-a:t5', 'section:sec-empty:', 'ungrouped:t1|t2', 'archived:t4'], 'an empty built-in Pinned section is not drawn');
  eq(keys(group(threads, { sections, hideBackground: false })).find((k) => k.startsWith('ungrouped:')), 'ungrouped:t1|t2|t3',
    'with the background filter off, Codex\'s own threads are listed among the rest, as Claude Code has no group for them');

  const provider = new SessionsModel(vscode, { memory: { openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
    reader: { threads: () => threads, sections: () => sections, state: () => null, thread: () => null }, stateOf: () => null,
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  const m = provider.model();
  eq([m.closed.length, m.open.length, m.groups.map((g) => g.key)],
    [0, 0, [`section:${PINNED_SECTION}`, 'section:sec-a', 'section:sec-empty', 'ungrouped', 'archived']],
    'with nothing open and nothing closed, neither Open sessions nor Recently closed has a row, and the empty group made by the user is drawn');
  eq(m.groups.find((g) => g.key === 'section:sec-empty').rows.length, 0, 'with no rows, so the page counts its nought, as Claude Code\'s does');
  const rowOf = (key) => m.groups.find((g) => g.key === key).rows[0];
  eq([[rowOf('ungrouped').group, rowOf('ungrouped').id], [rowOf('section:sec-a').group, rowOf('section:sec-a').id]],
    [['Ungrouped', ID(1)], ['Alpha', ID(5)]], 'each row carries its group and its session ID, which the page\'s hover shows in Claude Code Plus\'s two lines');

  const all = Object.values(pkg.contributes.menus).flat().map((m) => m.command).concat(pkg.contributes.commands.map((c) => c.command));
  eq(['codexPlus.archiveThread', 'codexPlus.unarchiveThread', 'codexPlus.deleteThread', 'codexPlus.deleteArchivedThread'].map((c) => all.includes(c)),
    [true, true, true, false], 'Archive and Unarchive are commands, since Archived sessions shows what is archived, and Delete is a single '
      + 'command offered only there');
};
