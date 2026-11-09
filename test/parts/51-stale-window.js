// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A window whose Codex started before the patch was written: it runs Codex's own code, so the patched host never hands
 * anything over. When such a window gets the focus and Codex's files on disk carry this build's patch, it offers a
 * reload once.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

/* A Codex extension directory whose two patched files carry this build's marks, which is all status() reads. */
function patchedCodex(dir, root, { clean = false } = {}) {
  const host = require(path.join(root, 'src', 'host'));
  const page = require(path.join(root, 'src', 'webview-inject'));
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'webview'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'extension.js'), `${clean ? '' : host.MARK}\nexports.activate=()=>{};\n`);
  fs.writeFileSync(path.join(dir, 'webview', 'index.html'), `${clean ? '' : page.mark()}\n<html></html>\n`);
  fs.writeFileSync(path.join(dir, 'webview', page.PAGE_FILE), '');
}

async function windowWith(root, tmp, { clean = false, active = true, connected = false, patchCodex = 'on' } = {}) {
  const { vscode, control } = fake.create();
  const focus = new fake.EventEmitter();
  vscode.window.onDidChangeWindowState = focus.event;
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(root, 'src') + path.sep)) delete require.cache[k];
  delete globalThis.__codexExtrasProvider;
  const dir = tmp('codex');
  patchedCodex(dir, root, { clean });
  control.state.extensions.set('openai.chatgpt', { extensionPath: dir, isActive: active, packageJSON: { version: '26.1021.22027' } });
  const patching = require(path.join(root, 'src', 'patching'));
  const subs = [];
  patching.activate({ subscriptions: subs, globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, settings: () => ({ patchCodex, chime: false, figures: false }),
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) } });
  await new Promise((r) => setImmediate(r));
  if (connected) globalThis.__codexExtrasMessage({}, { kind: 'tz', timeZone: 'UTC' }, {});
  const offers = () => control.state.said.filter((s) => /patched after this window's Codex started/.test(s.message));
  const focusOnce = async () => { focus.fire({ focused: true }); await new Promise((r) => setTimeout(r, 20)); };
  return { patching, offers, focusOnce, control, dispose: () => { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } } };
}

module.exports = async ({ eq, tmp, root }) => {
  const w = await windowWith(root, tmp);
  await w.focusOnce();
  eq([w.offers().length, (w.offers()[0] || {}).buttons], [1, ['Reload Window']],
    'a window whose Codex runs unpatched while the files on disk are patched offers a reload when it gets the focus');
  eq(/after this window's Codex started/.test(w.patching._state().reason), true, 'and Show Status says why it is not connected');
  await w.focusOnce();
  eq(w.offers().length, 1, 'only once');
  w.control.answer('patched after this window', 'Reload Window');
  w.dispose();

  const clicked = await windowWith(root, tmp);
  clicked.control.answer('patched after this window', 'Reload Window');
  await clicked.focusOnce();
  eq(clicked.control.state.commands.some((c) => c[0] === 'workbench.action.reloadWindow'), true, 'and its button reloads the window');
  clicked.dispose();

  for (const [what, opts] of [
    ['Codex\'s files are not patched', { clean: true }],
    ['the patched host has already handed something over in this window', { connected: true }],
    ['Codex has not started in this window, so it will load the patched files when it does', { active: false }],
    ['the patch is turned off', { patchCodex: 'off' }],
  ]) {
    const q = await windowWith(root, tmp, opts);
    await q.focusOnce();
    eq(q.offers().length, 0, `nothing is offered when ${what}`);
    q.dispose();
  }
  delete globalThis.__codexExtrasProvider;
};
