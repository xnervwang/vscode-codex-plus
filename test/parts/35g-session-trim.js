// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the session list draws, held to Claude Code's list with Claude Code Plus: no Pinned group (Codex keeps no pin
 * the list could show, and nothing ages out of it to pin against), no Background group, no Archived sessions (Codex
 * neither archives nor cleans up by itself, and VS Code's Codex has no page where an archived conversation could be
 * found again, so archiving is not offered either), a hover of two lines, an Open sessions that is left out while empty
 * and a group made by the user that is drawn even when empty.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { vscode } = fake.create();
  fake.install(vscode);
  const { group, SessionsProvider } = require('../../src/sessions-view');
  const { PINNED_SECTION } = require('../../src/session-groups');

  const t = (n, extra = {}) => ({ id: ID(n), title: `t${n}`, kind: 'user', cwd: '/w', archived: false, pinned: false, section: '',
    createdMs: 1000, updatedMs: 2000 + n, ...extra });
  const threads = [t(1), t(2, { pinned: true }), t(3, { kind: 'subagent' }), t(4, { archived: true }), t(5, { section: 'sec-a' }),
    t(6, { section: PINNED_SECTION })];
  const sections = new Map([[PINNED_SECTION, 'Pinned'], ['sec-a', 'Alpha'], ['sec-empty', 'Empty one']]);
  const keys = (gs) => gs.map((g) => `${g.key}:${g.threads.map((x) => x.title).join('|')}`);

  eq(keys(group(threads, { sections })),
    ['closed:', 'open:', `section:${PINNED_SECTION}:t6`, 'section:sec-a:t5', 'section:sec-empty:', 'ungrouped:t1|t2'],
    'no Pinned group of its own, no Archived sessions, no Background; Codex\'s built-in Pinned section only as a group holding what is in it');
  eq(keys(group(threads.filter((x) => x.section !== PINNED_SECTION), { sections })),
    ['closed:', 'open:', 'section:sec-a:t5', 'section:sec-empty:', 'ungrouped:t1|t2'], 'an empty built-in Pinned section is not drawn');
  eq(keys(group(threads, { sections, hideBackground: false })).pop(), 'ungrouped:t1|t2|t3',
    'with the background filter off, Codex\'s own threads are listed among the rest, as Claude Code has no group for them');

  const provider = new SessionsProvider(vscode, { memory: { openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
    reader: { threads: () => threads, sections: () => sections, state: () => null, thread: () => null }, stateOf: () => null,
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  provider.refresh();
  const top = provider.getChildren();
  eq(top.map((r) => r.group.key), [`section:${PINNED_SECTION}`, 'section:sec-a', 'section:sec-empty', 'ungrouped'],
    'with nothing open and nothing closed, neither Open sessions nor Recently closed is drawn, and the empty group made by the user is');
  eq(provider.getTreeItem(top.find((r) => r.group.key === 'section:sec-empty')).description, '0', 'which counts its nought, as Claude Code\'s does');
  const ungrouped = provider.getChildren(top.find((r) => r.group.key === 'ungrouped'));
  const grouped = provider.getChildren(top.find((r) => r.group.key === 'section:sec-a'));
  eq([provider.getTreeItem(ungrouped[0]).tooltip, provider.getTreeItem(grouped[0]).tooltip],
    [`Group: Ungrouped\nSession ID: ${ID(1)}`, `Group: Alpha\nSession ID: ${ID(5)}`],
    'the hover says the group and the session ID, in Claude Code Plus\'s two lines');

  const all = Object.values(pkg.contributes.menus).flat().map((m) => m.command).concat(pkg.contributes.commands.map((c) => c.command));
  eq(['codexPlus.archiveThread', 'codexPlus.unarchiveThread', 'codexPlus.deleteArchivedThread'].filter((c) => all.includes(c)), [],
    'Archive, Unarchive and Delete Conversation are gone, since nothing could bring an archived conversation back into sight');
};
