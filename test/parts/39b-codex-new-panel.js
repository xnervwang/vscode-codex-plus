// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's own New Codex Agent opens every new conversation tab on one URI, and VS Code keeps one Codex editor per
 * resource, so without the patch a second press brings the first tab forward with whatever conversation it now shows.
 * The New chat button on a Codex page shown in a tab runs the same command. The host edit "new conversation tabs"
 * (src/host.js) gives that URI a fragment from this extension (src/codex-tabs.js newPanelFragment).
 *
 * Each copy of createNewPanel runs in a context of its own, with a stand-in openWith that keeps to that rule
 * (test/parts/39-new-tab-twice.js says where VS Code does it).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const fixture = require('../fixture');
const { uriParser } = require('../codex-uri-parser');

const EDIT = 'new conversation tabs';
const SHIPPED = {
  '26.1021.22027': 'async createNewPanel(){let e=F1("/extension/panel/new"),r=Be.window.activeTextEditor?.viewColumn??Be.ViewColumn.Active;await Be.commands.executeCommand("vscode.openWith",e,t.customEditorViewType,{viewColumn:r,preserveFocus:!1,preview:!1})}',
  '26.1111.21308': 'async createNewPanel(){let e=yL("/extension/panel/new"),r=ze.window.activeTextEditor?.viewColumn??ze.ViewColumn.Active;await ze.commands.executeCommand("vscode.openWith",e,t.customEditorViewType,{viewColumn:r,preserveFocus:!1,preview:!1})}',
  '26.1117.31558': 'async createNewPanel(){let t=gq("/extension/panel/new"),r=St.window.activeTextEditor?.viewColumn??St.ViewColumn.Active;await St.commands.executeCommand("vscode.openWith",t,e.customEditorViewType,{viewColumn:r,preserveFocus:!1,preview:!1})}',
  '26.1117.41037': 'async createNewPanel(){let t=gq("/extension/panel/new"),r=St.window.activeTextEditor?.viewColumn??St.ViewColumn.Active;await St.commands.executeCommand("vscode.openWith",t,e.customEditorViewType,{viewColumn:r,preserveFocus:!1,preview:!1})}',
  '26.1120.41243': 'async createNewPanel(){let t=Rq("/extension/panel/new"),r=yt.window.activeTextEditor?.viewColumn??yt.ViewColumn.Active;await yt.commands.executeCommand("vscode.openWith",t,e.customEditorViewType,{viewColumn:r,preserveFocus:!1,preview:!1})}',
};
const FRAGMENT = /^new-[0-9a-z]+-[0-9a-z]+$/;

function codexInstalls() {
  const out = [];
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names.sort()) if (/^openai\.chatgpt-/.test(n) && fs.existsSync(path.join(root, n, 'out', 'extension.js'))) out.push(path.join(root, n));
  }
  return out;
}

/* The bytes of a file as Codex shipped it. */
const pristine = (file, suffix) => fs.readFileSync(fs.existsSync(file + suffix) ? file + suffix : file);

/* createNewPanel out of a whole bundle, by its braces; strings are skipped so a brace in one is not counted. */
function methodText(src) {
  const at = src.indexOf('async createNewPanel(');
  if (at < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', at); i > 0 && i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i++; while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return null;
}

function runner(method, viewType) {
  const builder = (/([\w$]+)\("\/extension\/panel\/new"\)/.exec(method) || [])[1];
  const ns = (/([\w$]+)\.window\.activeTextEditor/.exec(method) || [])[1];
  const cls = (/([\w$]+)\.customEditorViewType/.exec(method) || [])[1];
  if (!builder || !ns || !cls) return null;
  return async (vscode, hook) => {
    const box = vm.createContext({});
    box.globalThis = box;
    if (hook !== undefined) box.__codexExtrasNewPanelFragment = hook;
    box[ns] = vscode;
    box[cls] = { customEditorViewType: viewType };
    box[builder] = (route) => {
      const q = route.indexOf('?');
      return vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: q < 0 ? route : route.slice(0, q), query: q < 0 ? '' : route.slice(q + 1) });
    };
    const P = vm.runInContext(`(class{${method}})`, box);
    await new P().createNewPanel();
  };
}

function codexParser(installs) {
  for (const dir of installs) {
    const p = uriParser(pristine(path.join(dir, 'out', 'extension.js'), '.codex-extras-host.bak').toString('utf8'));
    if (p) return { from: path.basename(dir), parse: p.parse };
  }
  return null;
}

module.exports = async ({ ok, bad, eq, note, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const host = require('../../src/host');
  const tabs = require('../../src/codex-tabs');
  const supported = require('../../src/supported');
  const { applyEdits } = require('../../src/edits');
  const edit = host.EDITS.find((e) => e.name === EDIT);
  if (!edit) { bad(`src/host.js has no edit named "${EDIT}"`); return; }
  eq([!!edit.optional, typeof (edit.optional || {}).sign, typeof (edit.optional || {}).lost], [true, 'string', 'string'],
    'the edit is optional, and says what it puts in and what is lost without it');

  const key = (u) => `${u.scheme}://${u.authority}${u.path}?${u.query || ''}#${u.fragment || ''}`;
  let opens = [];
  control.state.openWith = (uri, viewType, options) => {
    opens.push({ uri, viewType, options });
    const target = control.groups.find((g) => g.isActive) || control.groups[0];
    for (const g of control.groups) {
      const i = g.tabs.findIndex((t) => t.input && t.input.viewType === viewType && key(t.input.uri) === key(uri));
      if (i < 0) continue;
      const [tab] = g.tabs.splice(i, 1);
      target.tabs.push(tab);
      target.activeTab = tab;
      return;
    }
    const tab = { label: 'Codex', input: new vscode.TabInputCustom(uri, viewType) };
    target.tabs.push(tab);
    target.activeTab = tab;
  };
  const fresh = () => {
    opens = [];
    control.groups.length = 0;
    control.groups.push({ viewColumn: 1, tabs: [control.fileTab('/work/notes.txt')], activeTab: null, isActive: true });
  };
  const codexTabs = () => control.groups.flatMap((g) => g.tabs.filter((t) => tabs.isCodexTab(vscode, t)));

  const twice = async (run, hook) => {
    fresh();
    let threw = '';
    try { await run(vscode, hook); await run(vscode, hook); } catch (e) { threw = e.message; }
    return { threw, tabs: codexTabs().length, fragments: opens.map((o) => o.uri.fragment), paths: opens.map((o) => o.uri.path),
      views: [...new Set(opens.map((o) => o.viewType))], options: opens.map((o) => JSON.stringify(o.options)) };
  };
  const optionsWant = JSON.stringify({ viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false });
  const parser = codexParser(codexInstalls());

  const checkMethod = async (label, method) => {
    const r = applyEdits(method, [edit], 'Codex');
    if (r.error) { bad(`${label}: ${r.error}`); return; }
    const plain = runner(method, tabs.VIEW_TYPE), patched = runner(r.out, tabs.VIEW_TYPE);
    if (!plain || !patched) { bad(`${label}: the names createNewPanel uses were not found in it`); return; }

    const before = await twice(plain, tabs.newPanelFragment);
    eq([before.threw, before.tabs, before.fragments], ['', 1, ['', '']],
      `${label}: as Codex ships it, New Codex Agent pressed twice opens one tab, on a URI with no fragment`);
    const after = await twice(patched, tabs.newPanelFragment);
    eq([after.threw, after.tabs, after.paths, after.views, after.options, after.fragments.every((f) => FRAGMENT.test(f)), new Set(after.fragments).size],
      ['', 2, ['/extension/panel/new', '/extension/panel/new'], [tabs.VIEW_TYPE], [optionsWant, optionsWant], true, 2],
      `${label}: patched, it opens two tabs on Codex's New route, each URI with a fragment of its own of this extension's shape, `
      + 'in the view type and with the options Codex gives');
    const route = parser ? parser.parse(opens[0].uri) : { path: opens[0].uri.path, conversationId: null };
    eq([route.path, route.conversationId, tabs.threadOfUri(opens[0].uri)], ['/extension/panel/new', null, ''],
      `${label}: and Codex${parser ? ` (its URI parser, from ${parser.from})` : ''} and this extension both read such a URI as the New route, naming no conversation`);

    const fallbacks = {};
    for (const [what, hook] of [['no hook', undefined], ['an empty answer', () => ''], ['an answer that is not text', () => 5],
      ['a hook that throws', () => { throw new Error('x'); }]]) {
      const got = await twice(patched, hook);
      fallbacks[what] = [got.threw, got.tabs, got.fragments];
    }
    eq(Object.entries(fallbacks).filter(([, v]) => JSON.stringify(v) !== JSON.stringify(['', 1, ['', '']])).map(([k]) => k), [],
      `${label}: with no hook, an empty answer, an answer that is not text or a hook that throws, the patched method opens Codex's own URI and throws nothing`);
  };

  const record = supported.read();
  const recorded = supported.versions(record).filter((v) => (supported.entry(v, record).hostEdits || []).includes(EDIT));
  eq(recorded.filter((v) => !SHIPPED[v]), [], 'every Codex build the record says this edit was checked on has its createNewPanel here');
  for (const v of recorded) if (SHIPPED[v]) await checkMethod(`Codex ${v}`, SHIPPED[v]);
  const newest = SHIPPED[recorded[recorded.length - 1]];
  if (newest) {
    for (const [b, n, c] of [['n', 'a', 'o'], ['_e', '$', 'i'], ['cx', 'vs', 'K']]) {
      const renamed = newest.replace(/[\w$]+(?=\("\/extension\/panel\/new"\))/, b).replace(/[\w$]+(?=\.(?:window|ViewColumn|commands)\.)/g, n)
        .replace(/[\w$]+(?=\.customEditorViewType)/, c);
      await checkMethod(`the newest build's method with its names given as ${b}, ${n} and ${c}`, renamed);
    }
  }

  const installs = codexInstalls();
  if (!installs.length) note('no Codex extension installed here: the edit was not checked on a whole bundle');
  for (const dir of installs) {
    const name = path.basename(dir);
    const src = pristine(host.targetFile(dir), host.BACKUP_SUFFIX).toString('utf8');
    const r = host.patchSource(src);
    if (r.error) { bad(`${name}: ${r.error}`); continue; }
    eq([r.chosen.some((c) => c.name === EDIT), r.skipped], [true, []], `${name}: the whole patch goes in with "${EDIT}" among its edits and none left out`);
    const method = methodText(r.out);
    if (!method) { bad(`${name}: no createNewPanel in the patched bundle`); continue; }
    const run = runner(method, tabs.VIEW_TYPE);
    if (!run) { bad(`${name}: the names createNewPanel uses were not found in it`); continue; }
    const got = await twice(run, tabs.newPanelFragment);
    eq([got.threw, got.tabs, got.fragments.every((f) => FRAGMENT.test(f))], ['', 2, true],
      `${name}: the patched bundle's own createNewPanel, run twice, opens two tabs with fragments of this extension's shape`);
  }

  const targets = require('../../src/adapters');
  const page = require('../../src/webview-inject');
  const manifest = require('../../src/manifest');
  const copyOf = (dir, hostText) => {
    const copy = tmp('codex-new-panel');
    fs.mkdirSync(path.join(copy, 'out'));
    fs.mkdirSync(path.join(copy, 'webview'));
    fs.writeFileSync(host.targetFile(copy), hostText);
    fs.writeFileSync(page.targetFile(copy), pristine(page.targetFile(dir), page.BACKUP_SUFFIX));
    fs.writeFileSync(manifest.targetFile(copy), pristine(manifest.targetFile(dir), manifest.BACKUP_SUFFIX));
    return copy;
  };
  let fitted = '', unfitted = '';
  for (const dir of installs) {
    const orig = pristine(host.targetFile(dir), host.BACKUP_SUFFIX);
    const copy = copyOf(dir, orig);
    const applied = targets.map((t) => t.apply(copy).current);
    const text = fs.readFileSync(host.targetFile(copy), 'utf8');
    const inPlace = [applied, host.status(copy), host.missingOptional(copy), text.includes(edit.optional.sign)];
    [...targets].reverse().forEach((t) => t.restore(copy));
    eq([...inPlace, fs.readFileSync(host.targetFile(copy)).equals(orig), host.missingOptional(copy)],
      [[true, true, true], 'patched', [], true, true, []],
      `${path.basename(dir)}: applied to a copy the host patch carries the edit and lacks none, and Remove the Patch puts Codex's bundle back byte for byte`);
    if (!fitted) fitted = copyOf(dir, orig);
  }
  if (installs.length) {
    const dir = installs[installs.length - 1];
    const orig = pristine(host.targetFile(dir), host.BACKUP_SUFFIX).toString('utf8');
    const strange = orig.replace('async createNewPanel(){let ', 'async createNewPanel(){var ');
    const r = host.patchSource(strange);
    eq([r.error || '', (r.skipped || []).map((s) => s.name), host.EDITS.filter((e) => !e.optional).every((e) => (r.chosen || []).some((c) => c.name === e.name)),
      !!r.out && !r.out.includes(edit.optional.sign)],
    ['', [EDIT], true, true],
    'a build the edit does not fit is patched with every other edit and without this one, rather than not at all');
    unfitted = copyOf(dir, strange);
    targets.forEach((t) => t.apply(unfitted));
    eq([host.status(unfitted), host.missingOptional(unfitted).map((m) => m.name)], ['patched', [EDIT]],
      'and the patched file reads as patched, with the edit it went without named');
  }

  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const live = fake.create();
  fake.install(live.vscode);
  live.vscode.workspace.isTrusted = true;
  live.vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  live.control.state.config = { reopenDroppedTabs: false };
  const newestBuild = supported.versions(record).slice(-1)[0];
  live.control.state.extensions.set('openai.chatgpt', { extensionPath: unfitted || tmp('codex'), packageJSON: { version: newestBuild } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento(),
    globalStorageUri: live.vscode.Uri.file(tmp('storage')), extensionPath: root });
  const hook = globalThis.__codexExtrasNewPanelFragment;
  const answers = typeof hook === 'function' ? [hook(), hook()] : [];
  eq([typeof hook, answers.every((a) => FRAGMENT.test(a)), new Set(answers).size], ['function', true, 2],
    'once active, the extension answers Codex\'s New Codex Agent with a new fragment each time, of its New tabs\' shape');
  live.control.state.config.enabled = false;
  eq(hook(), '', 'with the main switch off it answers nothing, and Codex opens its own URI');
  live.control.state.config.enabled = true;
  if (unfitted) {
    /* Activation checks the patch on the next turn of the event loop. */
    const leftOutSaid = () => live.control.state.log.filter((l) => l.includes(`Left out of the host patch: "${EDIT}"`));
    for (let i = 0; i < 40 && !leftOutSaid().length; i++) await new Promise((done) => setTimeout(done, 50));
    const told = leftOutSaid();
    eq([told.length >= 1, told.every((l) => l.includes(edit.optional.lost))], [true, true],
      'next to a Codex the edit did not fit, activation writes to the log which edit was left out and what that loses');
    live.control.state.log.length = 0;
    await live.control.state.handlers['codexPlus.status']();
    eq(live.control.state.log.join('\n').includes(`Left out of the host patch: "${EDIT}"`), true, 'and Show Status says so too');
  }
  if (fitted) {
    live.control.state.extensions.set('openai.chatgpt', { extensionPath: fitted, packageJSON: { version: newestBuild } });
    targets.forEach((t) => t.apply(fitted));
    live.control.state.log.length = 0;
    await live.control.state.handlers['codexPlus.status']();
    eq(live.control.state.log.join('\n').includes('Left out of the host patch'), false, 'Show Status says nothing of the kind where every edit went in');
  }
  for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
  ext.deactivate();
  eq(typeof globalThis.__codexExtrasNewPanelFragment, 'undefined', 'and once deactivated it is gone, so a patched Codex opens its own URI again');
  if (installs.length) ok(`checked on ${installs.length} installed Codex build(s) and ${recorded.length} recorded one(s)`);
};
