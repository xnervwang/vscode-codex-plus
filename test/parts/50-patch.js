// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The patch to Codex: every edit matches exactly once on each pristine Codex build installed here, the results parse,
 * applying and restoring on a copy leaves Codex's files byte for byte as they were, the hooks do what they say with a
 * stand-in provider and panel, and the page script shares the page's API handle and draws only into a node of its own.
 * Codex's installed files are only read; every write goes to a copy.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');

function codexInstalls() {
  const out = [];
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names) if (/^openai\.chatgpt-/.test(n) && fs.existsSync(path.join(root, n, 'out', 'extension.js'))) out.push(path.join(root, n));
  }
  return out;
}

module.exports = async ({ ok, bad, note, eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const host = require('../../src/host');
  const page = require('../../src/webview-inject');
  const patching = require('../../src/patching');

  const installs = codexInstalls();
  if (!installs.length) note('no Codex extension installed here: the edits were not checked against a real build');
  for (const dir of installs) {
    const name = path.basename(dir);
    const file = host.targetFile(dir);
    const backup = file + host.BACKUP_SUFFIX;
    const pristine = fs.readFileSync(fs.existsSync(backup) ? backup : file, 'utf8');
    const r = host.patchSource(pristine);
    if (r.error) bad(`${name}: ${r.error}`);
    else ok(`${name}: every host edit matches once (${r.chosen.map((c) => c.name).join(', ')}) and the result parses`);
    const html = page.targetFile(dir);
    const pbackup = html + page.BACKUP_SUFFIX;
    const p = page.patchSource(fs.readFileSync(fs.existsSync(pbackup) ? pbackup : html, 'utf8'));
    if (p.error) bad(`${name}: page: ${p.error}`);
    else if (p.out.indexOf(`src="./${page.PAGE_FILE}"`) < p.out.search(/src="\.\/assets\/index-/)) ok(`${name}: the page script goes in ahead of Codex's entry script`);
    else bad(`${name}: the page script is not ahead of Codex's entry script`);
  }

  /* Apply and restore on a copy, never on the installed files. */
  if (installs.length) {
    const copy = tmp('codex-copy');
    fs.mkdirSync(path.join(copy, 'out'));
    fs.mkdirSync(path.join(copy, 'webview'));
    const src = installs[0];
    const origHost = fs.readFileSync(fs.existsSync(host.targetFile(src) + host.BACKUP_SUFFIX) ? host.targetFile(src) + host.BACKUP_SUFFIX : host.targetFile(src));
    const origPage = fs.readFileSync(fs.existsSync(page.targetFile(src) + page.BACKUP_SUFFIX) ? page.targetFile(src) + page.BACKUP_SUFFIX : page.targetFile(src));
    fs.writeFileSync(host.targetFile(copy), origHost);
    fs.writeFileSync(page.targetFile(copy), origPage);
    const targets = require('../../src/adapters');
    eq(targets.map((t) => t.apply(copy).current), [true, true], 'both targets apply to a copy');
    eq(targets.map((t) => t.status(copy)), ['patched', 'patched'], 'and report themselves patched');
    eq(targets.map((t) => t.apply(copy).changed), [false, false], 'a second apply changes nothing');
    try { new vm.Script(fs.readFileSync(host.targetFile(copy), 'utf8')); ok('the patched copy parses'); } catch (e) { bad(`the patched copy does not parse: ${e.message}`); }
    [...targets].reverse().forEach((t) => t.restore(copy));
    eq([fs.readFileSync(host.targetFile(copy)).equals(origHost), fs.readFileSync(page.targetFile(copy)).equals(origPage),
      fs.existsSync(path.join(copy, 'webview', page.PAGE_FILE))], [true, true, false], 'restoring leaves both files byte for byte as they were');

    /*
     * A build of this extension that changes what the patch writes leaves Codex carrying an older copy of it. That is
     * the state the refresh is for, and a clean Codex is patched the same way: at start-up, with no question put, as
     * Claude Code Plus patches Claude Code. "Remove the Patch from Codex" is remembered, and while it is nothing patches.
     */
    const stale = tmp('codex-stale');
    fs.mkdirSync(path.join(stale, 'out'));
    fs.mkdirSync(path.join(stale, 'webview'));
    fs.writeFileSync(host.targetFile(stale), origHost);
    fs.writeFileSync(page.targetFile(stale), origPage);
    targets.forEach((t) => t.apply(stale));
    /* What an older build looks like from status(): the mark is one of ours, with another build's digest in it. */
    const age = (file, anyMark) => {
      const text = fs.readFileSync(file, 'utf8');
      const dash = text.indexOf('-', text.indexOf(anyMark) + anyMark.length);
      fs.writeFileSync(file, `${text.slice(0, dash + 1)}d00000000000${text.slice(dash + 13)}`);
    };
    age(host.targetFile(stale), host.ANY_MARK);
    age(page.targetFile(stale), page.ANY_MARK);
    eq(targets.map((t) => t.status(stale)), ['outdated', 'outdated'], 'another build\'s patch in Codex reads as outdated, not as clean');

    const codexVersion = '26.1021.22027';
    control.state.extensions.set('openai.chatgpt', { extensionPath: stale, packageJSON: { version: codexVersion } });
    const memo = fake.memento();
    control.state.said.length = 0;
    await patching.ensurePatched(vscode, { globalState: memo }, () => {}, 'on');
    const refreshed = control.state.said.map((s) => s.message).join('\n');
    eq([targets.map((t) => t.status(stale)), control.state.said.length, refreshed.includes('Reload the window')],
      [['patched', 'patched'], 1, true],
      'so it is brought up to this build with no question put, and only a reload is asked for');

    const fromClean = async (mode, removed) => {
      [...targets].reverse().forEach((t) => t.restore(stale));
      await memo.update(patching.PATCH_REMOVED_KEY, removed);
      control.state.said.length = 0;
      await patching.ensurePatched(vscode, { globalState: memo }, () => {}, mode);
      return { status: targets.map((t) => t.status(stale)), said: control.state.said.map((m) => m.message),
        reason: patching._state().reason };
    };
    const fresh = await fromClean('on', undefined);
    eq([fresh.status, fresh.said.length, /Reload the window/.test(fresh.said[0] || '')], [['patched', 'patched'], 1, true],
      'a clean Codex is patched without asking, and the only thing said is to reload');
    const removed = await fromClean('off', true);
    eq([removed.status, removed.said, /Remove the Patch from Codex/.test(removed.reason)], [['clean', 'clean'], [], true],
      'after Remove the Patch it stays clean, saying nothing, and the status names the command that removed it');
    const switchedOff = await fromClean('off', undefined);
    eq([switchedOff.status, /codexPlus\.enabled/.test(switchedOff.reason)], [['clean', 'clean'], true],
      'and with the additions switched off it is left clean too, for that reason');

    /*
     * The uninstall hook puts back the Codex beside the copy of this extension being uninstalled, and the Codex of any
     * other editor on the machine that holds no copy of this extension any more. An editor that still holds one leaves
     * its Codex to that copy. The editors are laid out under a home of the test's own, which the hook is run with, so
     * the real extensions folders of this machine are never looked at.
     */
    const home = tmp('uninstall-home');
    const editor = (ext, copies = [], marked = {}) => {
      const codex = path.join(ext, 'openai.chatgpt-26.1021.22027-linux-x64');
      fs.mkdirSync(path.join(codex, 'out'), { recursive: true });
      fs.mkdirSync(path.join(codex, 'webview'), { recursive: true });
      fs.writeFileSync(host.targetFile(codex), origHost);
      fs.writeFileSync(page.targetFile(codex), origPage);
      targets.forEach((t) => t.apply(codex));
      for (const c of copies) fs.mkdirSync(path.join(ext, c));
      if (Object.keys(marked).length) fs.writeFileSync(path.join(ext, '.obsolete'), JSON.stringify(marked));
      return { ext, codex };
    };
    const inHome = (d) => path.join(home, d, 'extensions');
    const mine = editor(inHome('.vscode-server'));
    const kept = editor(inHome('.vscode-server-insiders'), ['xnervwang.codex-plus-0.2.0']);
    const former = editor(inHome('.cursor'), ['xnervwang.codex-extras-0.1.0']);
    const leaving = editor(inHome('.vscode'), ['xnervwang.codex-plus-1.0.0'], { 'xnervwang.codex-plus-1.0.0': true });
    const lookalike = editor(inHome('.vscode-insiders'), ['xnervwang.codex-plus-plus-1.0.0']);
    const elsewhere = editor(tmp('editor-elsewhere'));
    const self = path.join(mine.ext, 'xnervwang.codex-plus-1.0.0');
    fs.mkdirSync(self);
    for (const f of ['uninstall.js', 'package.json']) fs.copyFileSync(path.join(root, f), path.join(self, f));
    fs.cpSync(path.join(root, 'src'), path.join(self, 'src'), { recursive: true });
    require('child_process').execFileSync(process.execPath, [path.join(self, 'uninstall.js')],
      { stdio: 'pipe', env: { ...process.env, HOME: home, USERPROFILE: home } });
    const st = (e) => targets.map((t) => t.status(e.codex));
    eq([st(mine), st(kept), st(former)], [['clean', 'clean'], ['patched', 'patched'], ['patched', 'patched']],
      'uninstalling puts back the Codex in its own extensions folder and leaves one whose editor still has this extension, '
      + 'under this name or the one it had before, codex-extras');
    eq([st(leaving), st(lookalike)], [['clean', 'clean'], ['clean', 'clean']],
      'and puts back another editor\'s Codex when that editor has no copy of this extension left: only one '
      + 'marked for deletion, or only an extension whose name merely starts with this one\'s');
    eq(st(elsewhere), ['patched', 'patched'], 'a folder that is no editor\'s extensions folder is not looked in');
  }

  /*
   * A restore in one window and a patch in another at the same moment: whatever order their steps fall in, a patched
   * file keeps its backup. The other window's patch is run from inside the restore's rename, right after the original
   * lands, which is the one moment the file is clean while the restore is still running.
   */
  const race = (label, t, dir, patchOther) => {
    const file = t.targetFile(dir);
    const backup = file + t.BACKUP_SUFFIX;
    const realRename = fs.renameSync;
    let other = '';
    fs.renameSync = (from, to) => {
      realRename.call(fs, from, to);
      if (to !== file || other) return;
      other = 'clean';
      if (!fs.readFileSync(file, 'utf8').includes(t.ANY_MARK)) { patchOther(); other = 'patched'; }
    };
    try { t.restore(dir); } finally { fs.renameSync = realRename; }
    const now = fs.readFileSync(file, 'utf8');
    const patched = now.includes(t.ANY_MARK);
    const kept = fs.existsSync(backup) && !fs.readFileSync(backup, 'utf8').includes(t.ANY_MARK);
    eq([other, patched, kept, t.status(dir)], ['patched', true, true, 'patched'],
      `${label}: a patch landing just after a restore keeps its backup, and the target reads as patched`);
  };
  for (const t of require('../../src/adapters')) {
    const dir = tmp(`race-${t.name.replace(/\W+/g, '-')}`);
    const file = t.targetFile(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mark = t === host ? host.MARK : page.mark();
    /* A page backup is held to be a Codex page, one with the entry script the patch anchors on, as in Codex's
       webview/index.html. */
    const original = t === page ? '<html><head><script type="module" crossorigin src="./assets/index-0a1b2c3d.js"></script></head></html>' : 'original';
    const writePatched = () => {
      fs.writeFileSync(file + t.BACKUP_SUFFIX, original);
      if (t === page) fs.writeFileSync(path.join(path.dirname(file), page.PAGE_FILE), 'script');
      fs.writeFileSync(file, `${mark} patched`);
    };
    writePatched();
    race(`${t.name}, with stand-in contents`, t, dir, writePatched);
  }
  if (installs.length) {
    const src = installs[0];
    const pristine = (t) => fs.readFileSync(fs.existsSync(t.targetFile(src) + t.BACKUP_SUFFIX) ? t.targetFile(src) + t.BACKUP_SUFFIX : t.targetFile(src));
    for (const t of require('../../src/adapters')) {
      const dir = tmp(`race-real-${t.name.replace(/\W+/g, '-')}`);
      fs.mkdirSync(path.dirname(t.targetFile(dir)), { recursive: true });
      fs.writeFileSync(t.targetFile(dir), pristine(t));
      t.apply(dir);
      race(`${t.name}, on a copy of ${path.basename(src)}`, t, dir, () => t.apply(dir));
    }
  }

  /* The hooks, with a stand-in provider and panel. */
  const sent = [], navigated = [], focused = [];
  const provider = {
    sendMessageToPanel: (panel, msg) => sent.push(msg),
    navigateToRoute: (p) => navigated.push(p),
    postMessageToWebview: (w, msg) => sent.push(msg),
  };
  let disposed = null;
  const panel = { webview: {}, reveal() {}, onDidDispose: (fn) => { disposed = fn; }, iconPath: null };
  const thread = '01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31';
  patching.installHooks();
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, source: { onDidChangeConversations: () => ({ dispose() {} }), _focus: (id) => focused.push(id),
      listConversations: async () => [], logo: null }, settings: () => ({ patchCodex: 'off', chime: true, figures: true }),
    context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) } });
  eq(patching.canDeliver(thread), false, 'before Codex hands over a panel, nothing can be typed');
  globalThis.__codexExtrasPanel(panel, thread, provider);
  eq(patching.canDeliver(thread), true, 'once its panel is handed over, that conversation can take an answer');
  const r = await patching.deliver(thread, 'My answer to row 1', { waitMs: 50 });
  eq([r.outcome, sent[0] && sent[0].type, sent[0] && sent[0].path, sent[0] && sent[0].state.prefillPrompt,
    sent[0] && sent[0].state.prefillPromptOnlyIfEmpty],
  ['uncertain', 'navigate-to-route', `/local/${thread}`, 'My answer to row 1', true],
  'the answer goes to its panel as a draft, only into an empty box, and is reported uncertain when its page does not say what it saw');
  eq((await patching.deliver('aaaaaaaa-0000-0000-0000-000000000000', 'x')).outcome, 'notReceived', 'a conversation with no panel here does not receive it');
  vscode.commands.executeCommand = async () => {};
  eq([await patching.openInSidebar(thread), navigated[0]], [true, `/local/${thread}`], 'opening in the sidebar navigates Codex\'s sidebar to it');
  globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: thread, following: true });
  eq(focused, [], 'following a thread that has a tab here is not the sidebar');
  globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', following: true });
  eq([focused, patching.sidebarThread()], [['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    'following one with no tab here puts it in front (the sidebar), and is remembered for isFocused()');
  disposed();
  eq(patching.canDeliver(thread), false, 'a closed panel takes no more answers');
  const f = patching.figuresOf({ state: 'working', lastTurnMs: 130000, context: { used: 85000, window: 258400 }, model: 'openai.gpt-6.1-sol', effort: 'ultra',
    lastTool: { name: 'exec_command', startedMs: 5, endedMs: 0 } });
  eq([f.text, f.tool, f.toolSince], ['', 'exec_command', 5],
    'the strip carries only the tool call running now: the context, model and effort are beside each reply, the duration is Codex\'s own "Worked for"');

  /* The page script, in a stand-in page. */
  const posted = [];
  let handles = 0;
  const listeners = {};
  const body = { children: [], appendChild(c) { this.children.push(c); } };
  const document = { body, createElement: () => ({ style: {}, setAttribute(k, v) { this[k] = v; }, textContent: '' }), addEventListener() {} };
  const win = {
    acquireVsCodeApi: () => { handles++; if (handles > 1) throw new Error('second handle'); return { postMessage: (m) => posted.push(m) }; },
    addEventListener: (t, fn) => { listeners[t] = fn; }, Intl, setInterval: () => 1, clearInterval() {}, Date, Math, Object, String,
  };
  win.globalThis = win;
  const sandbox = vm.createContext({ globalThis: win, document, Intl, Date, Math, Object, String, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(page.pageScript(), sandbox);
  const first = win.acquireVsCodeApi(), second = win.acquireVsCodeApi();
  eq([first === second, handles], [true, 1], 'the page script and Codex share one API handle');
  eq(posted[0] && [posted[0].type, posted[0].kind, typeof posted[0].timeZone], ['codex-extras', 'tz', 'string'], 'it reports the page\'s time zone');
  listeners.message({ data: { type: 'codex-extras-figures', text: '12s · ctx 4%' } });
  eq([body.children.length, body.children[0] && body.children[0].textContent, body.children[0] && body.children[0]['data-codex-extras']],
    [1, '12s · ctx 4%', 'figures'], 'figures are drawn in one node of its own, appended to the body');
  listeners.message({ data: { type: 'navigate-to-route', path: '/x' } });
  eq(body.children.length, 1, 'Codex\'s own messages are left alone');
};
