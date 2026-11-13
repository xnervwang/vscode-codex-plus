// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * "New Codex Conversation in a Tab" pressed again while the tab it opened before is still open.
 *
 * Codex registers its conversation editor with supportsMultipleEditorsPerDocument: false, and VS Code then keeps one
 * editor per resource: opening a resource already open in any group moves that editor to the group asked for and
 * activates it (EditorResolverService doResolveEditor, singlePerResource; moveExistingEditorForResource). Resources are
 * the same when scheme, authority, path, query and fragment all are (ExtUri.getComparisonKey keeps the fragment unless
 * told otherwise). The stand-in openWith below does exactly that.
 *
 * Codex reads a tab's route from its URI's path and query and never its fragment (its URI parser, run here out of the installed
 * bundle when there is one), so a New tab whose URI carries a fragment of its own is still Codex's New route.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('../fake-vscode');
const { uriParser } = require('../codex-uri-parser');

/* The first installed Codex whose parser is found, and the installed ones in which it is not; null with none installed. */
function codexParser() {
  let found = null;
  const missing = [];
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names.filter((x) => /^openai\.chatgpt-/.test(x)).sort()) {
      const file = path.join(root, n, 'out', 'extension.js');
      let src = '';
      try { src = fs.readFileSync(fs.existsSync(file + '.codex-extras-host.bak') ? file + '.codex-extras-host.bak' : file, 'utf8'); } catch (_) { continue; }
      const parser = uriParser(src);
      if (!parser) missing.push(n);
      else if (!found) found = { from: n, parse: parser.parse };
    }
  }
  return found || missing.length ? { ...(found || {}), missing } : null;
}

/* Codex's URI parser as 26.1106.51428 and 26.1111.21308 ship it, cut out of their bundles. */
const PARSER_1106 = 'var Iv="openai-codex",NHe="route";function S2(t){let{scheme:e,authority:r,path:n}=t;if(e!==Iv)return null;if(r!==NHe)return null;'
  + 'let i=(n.startsWith("/")?n.slice(1):n).split("/"),s=null;return i.length>=2&&(i[0]==="local"||i[0]==="remote")&&(s=i[1]),'
  + '{path:`${n}${t.query===""?"":`?${t.query}`}`,conversationId:s}}';
const PARSER_1111 = 'var Av="openai-codex",yHe="route";function gL(t){let{scheme:e,authority:r,path:n}=t;if(e!==Av)return null;if(r!==yHe)return null;'
  + 'let o=n.startsWith("/")?n.slice(1):n,[i,s]=o.split("/");return{path:`${n}${t.query===""?"":`?${t.query}`}`,'
  + 'conversationId:i==="local"&&s!=null?s:null}}';

module.exports = async ({ eq, bad, note }) => {
  const reads = (src) => {
    const p = uriParser(src);
    if (!p) return null;
    return ['/local/L1', '/remote/R1', '/extension/panel/new'].map((at) => p.parse({ scheme: p.scheme, authority: p.authority, path: at, query: '' }).conversationId);
  };
  eq([reads(PARSER_1106), reads(PARSER_1111)], [['L1', 'R1', null], ['L1', null, null]],
    'Codex\'s URI parser is found in both shapes it has shipped in, the one that takes a conversation from /remote/ too and the one that takes it from /local/ only');

  const { vscode, control } = fake.create();
  fake.install(vscode);
  const tabs = require('../../src/codex-tabs');
  const key = (u) => `${u.scheme}://${u.authority}${u.path}?${u.query || ''}#${u.fragment || ''}`;
  let opened = 0;
  control.state.openWith = (uri, viewType, options) => {
    const target = control.groups.find((g) => g.viewColumn === options.viewColumn) || control.groups[0];
    for (const g of control.groups) {
      const i = g.tabs.findIndex((t) => t.input && t.input.viewType === viewType && key(t.input.uri) === key(uri));
      if (i < 0) continue;
      const [tab] = g.tabs.splice(i, 1);
      target.tabs.push(tab);
      for (const x of control.groups) x.isActive = x === target;
      target.activeTab = tab;
      return;
    }
    opened++;
    const tab = { label: 'Codex', input: new vscode.TabInputCustom(uri, viewType) };
    target.tabs.push(tab);
    for (const x of control.groups) x.isActive = x === target;
    target.activeTab = tab;
  };
  const group = (viewColumn, list, active) => ({ viewColumn, tabs: list, activeTab: list[0] || null, isActive: !!active });
  control.groups.length = 0;
  control.groups.push(group(1, [control.fileTab('/work/a.js')], true));

  eq(await tabs.openNewInTab(vscode), true, 'the first New opens a conversation tab');
  eq(await tabs.openNewInTab(vscode), true, 'and so does the second');
  const codexTabs = () => control.groups.flatMap((g) => g.tabs.filter((t) => tabs.isCodexTab(vscode, t)).map((t) => ({ g: g.viewColumn, t })));
  eq([opened, codexTabs().length, codexTabs().map((x) => x.g)], [2, 2, [1, 1]],
    'pressed twice it leaves two conversation tabs, both in the group it chose, rather than bringing the first one forward');
  const uris = codexTabs().map((x) => x.t.input.uri);
  eq(new Set(uris.map(key)).size, 2, 'because each New tab is a resource of its own');

  const parser = codexParser();
  if (!parser) note('no Codex extension installed here: its URI parser is not run on the New tabs\' URIs');
  else if (parser.missing.length) bad(`Codex's URI parser was not found in ${parser.missing.join(', ')}: test/codex-uri-parser.js does not match that build`);
  const parse = parser && parser.parse ? parser.parse : (u) => ({ path: `${u.path}${u.query ? `?${u.query}` : ''}`, conversationId: null });
  eq(uris.map((u) => { const r = parse(u); return [r.path, r.conversationId]; }), [['/extension/panel/new', null], ['/extension/panel/new', null]],
    `and Codex still reads each one as its New route${parser && parser.from ? ` (${parser.from})` : ''}, naming no conversation`);
  eq(uris.map((u) => tabs.threadOfUri(u)), ['', ''], 'as this extension does');

  /* With Codex tabs already in a second group, a New goes there, and no third group appears. */
  control.groups.length = 0;
  control.groups.push(group(1, [control.fileTab('/work/a.js')], true), group(2, [control.codexTab('01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31')]));
  await tabs.openNewInTab(vscode);
  await tabs.openNewInTab(vscode);
  eq([control.groups.length, codexTabs().map((x) => x.g)], [2, [2, 2, 2]], 'a New goes into the group already holding Codex tabs, each time, and opens no split');

  /* Codex not taking the route while one of its tabs is in front: nothing new opened, so the caller falls back. */
  control.state.openWith = () => {};
  control.groups.length = 0;
  control.groups.push(group(1, [control.codexTab('01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31')], true));
  eq(await tabs.openNewInTab(vscode), false, 'a Codex tab that was already in front is not taken for the new one');
};
