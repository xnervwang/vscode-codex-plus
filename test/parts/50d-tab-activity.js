// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A Codex tab shows its conversation's activity as the dot on its logo (a green dot working, a green ring with only
 * background work left, a red dot waiting for the user, Codex's own logo when stopped) and an unread reply as an
 * envelope at the end of its title. The envelope is only drawn: the conversation's name in Codex is left alone.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const X = '01a2f3f3-0000-7000-8000-00000000000a';
const Y = '01a2f3f3-0000-7000-8000-00000000000b';
const COLOUR = '\u{1F4E9}', TEXT = '✉︎';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (/[/\\]src[/\\](patching|codex-source|tab-memory)\.js$/.test(k)) delete require.cache[k];
  const patching = require('../../src/patching');
  const { createCodexSource } = require('../../src/codex-source');

  const dir = tmp('logo');
  const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg>';
  fs.writeFileSync(path.join(dir, 'light.svg'), logoSvg);
  fs.writeFileSync(path.join(dir, 'dark.svg'), logoSvg);
  const logo = { light: vscode.Uri.file(path.join(dir, 'light.svg')), dark: vscode.Uri.file(path.join(dir, 'dark.svg')) };
  const provider = { sendMessageToPanel() {}, postMessageToWebview() {}, navigateToRoute() {} };
  let conversations = [];
  let enabled = true;
  const source = { listConversations: async () => conversations, onDidChangeConversations: new fake.EventEmitter().event, logo, _focus() {} };
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  patching.installHooks();
  patching._approvals.clear();
  patching.activate(context, { vscode, log: () => {}, source, context,
    settings: () => ({ patchCodex: 'off', chime: false, figures: false, enabled, timestamps: false }) });
  const panelOf = (id) => ({ webview: { id }, title: 'Codex', visible: false, viewColumn: 1, active: false, iconPath: null,
    reveal() {}, onDidDispose(fn) { this.dispose = fn; } });
  const onX = panelOf('tab on X');
  globalThis.__codexExtrasPanel(onX, X, provider, `/local/${X}`);
  const conv = (activity, unseen, title = 'Fix the retry delay') => [{ sessionId: X, title, activity, unseen, working: activity === 'working' }];
  const drawn = async (activity, unseen, title) => {
    conversations = conv(activity, unseen, title);
    await patching.refreshPanels();
    const icon = onX.iconPath;
    const file = icon && icon.dark && icon.dark.fsPath;
    return { title: onX.title, logo: icon === logo, svg: file && file !== logo.dark.fsPath ? fs.readFileSync(file, 'utf8') : '' };
  };

  /* ── the dot ── */
  let d = await drawn('working', false);
  eq([/<circle cx="18.5" cy="5.5" r="5.5" fill="#22c55e"\/>/.test(d.svg), d.title], [true, 'Fix the retry delay'],
    'working: a green dot of Claude Code Plus\'s colour and size on the logo, and the title alone');
  d = await drawn('background', false);
  eq([/<circle cx="18.5" cy="5.5" r="4.5" fill="none" stroke="#22c55e" stroke-width="2"\/>/.test(d.svg), /fill="#22c55e"/.test(d.svg)], [true, false],
    'only background work left: a ring of the same green, whose outer edge is where the dot\'s is');
  d = await drawn('waiting', false);
  eq(/<circle cx="18.5" cy="5.5" r="5.5" fill="#ef4444"\/>/.test(d.svg), true, 'waiting for the user: a red dot');
  d = await drawn('stopped', false);
  eq(d.logo, true, 'stopped: Codex\'s own logo, with no dot');
  eq(Object.values(patching.TAB_DOTS).some((c) => /#3b82f6/i.test(JSON.stringify(c))), false, 'blue is no longer used');

  /* ── the envelope ── */
  d = await drawn('stopped', true);
  eq([d.logo, d.title], [true, `Fix the retry delay ${COLOUR}`], 'a reply not seen puts an envelope at the end of the title, and no dot');
  d = await drawn('working', true);
  eq([/fill="#22c55e"/.test(d.svg), d.title], [true, `Fix the retry delay ${COLOUR}`], 'working with a reply not seen: the green dot and the envelope');
  d = await drawn('stopped', true, `Fix ${COLOUR} the ${COLOUR}retry delay ✉`);
  eq(d.title, `Fix the retry delay ${COLOUR}`, 'envelopes in the conversation\'s name are left out, and the one drawn is alone and last');
  d = await drawn('stopped', false, `${COLOUR} Fix the retry delay`);
  eq(d.title, 'Fix the retry delay', 'and with no reply to read, there is none');
  d = await drawn('stopped', true, '(untitled)');
  eq(d.title, 'Fix the retry delay', 'a conversation with no title yet leaves the tab as it was, with no envelope on its own');
  conversations = conv('stopped', true);
  control.setTheme(1);
  await tick();
  eq(onX.title, `Fix the retry delay ${TEXT}`, 'switching to a light theme redraws the title with the envelope\'s text form');
  control.setTheme(2);
  await tick();
  eq(onX.title, `Fix the retry delay ${COLOUR}`, 'and back to a dark one, with the colour form');
  enabled = false;
  d = await drawn('stopped', true);
  eq([d.title, d.logo], ['Fix the retry delay', true], 'with Codex Plus turned off, neither the envelope nor a dot is drawn');
  enabled = true;

  /* ── a New tab is still found by its title, envelope and all ── */
  const fresh = panelOf('new tab');
  globalThis.__codexExtrasPanel(fresh, null, provider, '/extension/panel/new');
  globalThis.__codexExtrasPageRequest(fresh.webview, { id: 'start-1', method: 'thread/start', params: {} }, 'request');
  globalThis.__codexExtrasPageResponse(fresh.webview, { id: 'start-1', result: { thread: { id: Y } } });
  conversations = [...conv('stopped', false), { sessionId: Y, title: 'Draft the release notes', activity: 'stopped', unseen: true }];
  await patching.refreshPanels();
  eq([fresh.title, patching.newPanelThreadsTitled(`Draft the release notes ${COLOUR}`), patching.newPanelThreadsTitled('Draft the release notes')],
    [`Draft the release notes ${COLOUR}`, [Y], [Y]],
    'a New tab is matched to its panel by its title with or without the envelope, as VS Code may still show the label from before');
  const newTab = (label) => ({ label, input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route',
    path: '/extension/panel/new', fragment: 'n1' }), 'chatgpt.conversationEditor') });
  const reader = { threads: () => [], sections: () => new Map(), state: () => null, hasPlan: () => false, thread: () => null,
    refresh: async () => false, ready: async () => ({ threads: [], readable: true }) };
  control.setTabs([newTab(`Draft the release notes ${COLOUR}`), { ...control.codexTab(X), label: 'Fix the retry delay' }], 1);
  const src = createCodexSource(vscode, { reader, patching });
  try {
    eq(src.sessionForTab(control.groups[0].tabs[0]), Y, 'and so is the conversation in it');
  } finally { src.dispose(); }

  /* ── Recently closed ── */
  const { TabMemory } = require('../../src/tab-memory');
  const memory = new TabMemory(vscode, fake.memento(), { titleOf: () => '' });
  control.setTabs([], 0);
  control.fireTabs({ closed: [{ ...control.codexTab(X), label: `Fix the retry delay ${COLOUR}` }] });
  await tick();
  eq(memory.recentlyClosed(10).map((c) => c.title), ['Fix the retry delay'], 'Recently closed lists it without the envelope its tab had');
  memory.dispose && memory.dispose();

  for (const p of [onX, fresh]) p.dispose();
  patching._approvals.clear();
};
