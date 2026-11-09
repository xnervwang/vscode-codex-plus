// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The few parts of the VS Code API the extension's modules touch, enough to run them in Node: events, URIs, tab inputs,
 * a tab model the test drives, a command log, an extension registry the test fills, a clipboard, and tree-item shapes.
 * install() makes require('vscode') return it.
 */
const Module = require('module');
const path = require('path');

class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
  fire(e) { for (const fn of [...this.listeners]) fn(e); }
  dispose() { this.listeners.clear(); }
}

class Uri {
  constructor({ scheme = 'file', authority = '', path: p = '', query = '', fragment = '' }) {
    Object.assign(this, { scheme, authority, path: p, query, fragment });
  }
  static from(parts) { return new Uri(parts); }
  static file(p) { return new Uri({ scheme: 'file', path: p }); }
  static parse(text) {
    const m = /^([a-z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(String(text));
    return m ? new Uri({ scheme: m[1], authority: m[2], path: m[3] || '', query: m[4] || '', fragment: m[5] || '' }) : new Uri({ path: String(text) });
  }
  static joinPath(base, ...parts) { return new Uri({ ...base, path: path.posix.join(base.path, ...parts) }); }
  get fsPath() { return this.path; }
  with(change) { return new Uri({ ...this, ...change }); }
  toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}`; }
}

class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
class TabInputText { constructor(uri) { this.uri = uri; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class MarkdownString {
  constructor(v = '') { this.value = v; }
  appendMarkdown(s) { this.value += s; return this; }
  appendCodeblock(s) { this.value += '\n```\n' + s + '\n```\n'; return this; }
}
class FileDecoration { constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); } }

function create() {
  const tabsChanged = new EventEmitter();
  const groupsChanged = new EventEmitter();
  const extChanged = new EventEmitter();
  const groups = [{ viewColumn: 1, tabs: [], activeTab: null, isActive: true }];
  const state = { commands: [], context: {}, extensions: new Map(), clipboard: '', views: [], status: [], log: [], registered: [],
    said: [], answers: [], handlers: {}, external: [], externalAnswer: true };
  /* A notification is answered with the button the test set for text it contains (control.answer), else dismissed. */
  const answer = async (message, ...rest) => {
    const buttons = rest.filter((b) => typeof b === 'string');
    state.said.push({ message, buttons });
    for (const [match, pick] of state.answers) if (String(message).includes(match)) return typeof pick === 'function' ? pick(message, buttons) : pick;
    return undefined;
  };
  const vscode = {
    EventEmitter, Uri, TabInputCustom, TabInputText, ThemeIcon, ThemeColor, TreeItem, MarkdownString, FileDecoration,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    window: {
      tabGroups: {
        get all() { return groups; },
        get activeTabGroup() { return groups.find((g) => g.isActive) || groups[0]; },
        onDidChangeTabs: tabsChanged.event,
        onDidChangeTabGroups: groupsChanged.event,
      },
      createTreeView: (id, opts) => { state.views.push(id); return { id, opts, badge: undefined, description: '', dispose() {} }; },
      registerTreeDataProvider: (id) => { state.views.push(id); return { dispose() {} }; },
      registerWebviewViewProvider: (id) => { state.views.push(id); return { dispose() {} }; },
      registerFileDecorationProvider: () => ({ dispose() {} }),
      createStatusBarItem: () => { const item = { text: '', show() { item.shown = true; state.status.push(item); }, hide() { item.shown = false; }, dispose() {} }; return item; },
      createOutputChannel: () => ({ appendLine: (l) => state.log.push(l), show() {}, dispose() {} }),
      showInformationMessage: answer,
      showWarningMessage: answer,
      showErrorMessage: answer,
      setStatusBarMessage: () => ({ dispose() {} }),
    },
    commands: {
      executeCommand: async (cmd, ...args) => {
        state.commands.push([cmd, ...args]);
        if (cmd === 'setContext') state.context[args[0]] = args[1];
        if (cmd === 'vscode.openWith' && state.openWith) state.openWith(...args);
        if (state.handlers[cmd]) return state.handlers[cmd](...args);
        return undefined;
      },
      registerCommand: (id, fn) => { state.registered.push(id); state.handlers[id] = fn; return { dispose() {} }; },
    },
    extensions: {
      getExtension: (id) => state.extensions.get(id),
      onDidChange: extChanged.event,
    },
    env: { language: 'en', uriScheme: 'vscode',
      openExternal: async (u) => { state.external.push(String(u)); return state.externalAnswer; },
      clipboard: { writeText: async (t) => { state.clipboard = t; }, readText: async () => state.clipboard } },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, d) => (state.config && k in state.config ? state.config[k] : d) }),
      onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
  };
  /* Test controls: put tabs in place and announce the change as VS Code would. */
  const control = {
    state,
    groups,
    setTabs(list, active = 0) {
      groups[0].tabs = list.map((t) => ({ label: t.label || '', input: t.input, isActive: false }));
      groups[0].activeTab = groups[0].tabs[active] || null;
      if (groups[0].activeTab) groups[0].activeTab.isActive = true;
    },
    fireTabs(e = {}) { tabsChanged.fire({ opened: [], closed: [], changed: [], ...e }); },
    fireExtensions() { extChanged.fire(); },
    answer(match, pick) { state.answers.push([match, pick]); },
    codexTab(thread) { return { label: 't', input: new TabInputCustom(Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${thread}` }), 'chatgpt.conversationEditor') }; },
    fileTab(p) { return { label: path.basename(p), input: new TabInputText(Uri.file(p)) }; },
  };
  return { vscode, control };
}

/** Make require('vscode') return `vscode` from now on. */
function install(vscode) {
  const orig = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : orig.call(this, request, ...rest); };
}

/** A Memento kept in memory. */
function memento() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()] };
}

module.exports = { create, install, memento, EventEmitter, Uri };
