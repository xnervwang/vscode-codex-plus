// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Conversations view, a tab of its own in the panel, drawn here when no host draws it: one row per conversation of
 * this workspace, and under it its questions and its `doing` rows. src/conversations.js builds the list.
 *
 * A conversation's row shows its agent's logo with a dot in its state's colour (src/logo-dot.js), and the state word
 * first in its description, so the state is never told by colour alone. Question and `doing` rows carry no logo.
 */
const path = require('path');
const { ageSince } = require('./workplan-view');
const { textFor, language } = require('./conversations-text');
const { iconsFor } = require('./logo-dot');

/* The plain icons, used when there is no logo to draw. */
const LOOK = {
  prompt: ['shield', 'charts.orange'],
  needs: ['question', 'charts.orange'],
  working: ['sync~spin', 'charts.blue'],
  unread: ['circle-filled', 'charts.green'],
  idle: ['circle-outline', 'descriptionForeground'],
};

class ConversationsProvider {
  constructor(vscode, { context, logoOf = () => null }) {
    this.vscode = vscode;
    this.iconDir = path.join(context.globalStorageUri.fsPath, 'icons');
    this.logoOf = logoOf;
    this.cache = new Map();
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.list = [];
    this.source = null;
    this.signature = '';
  }

  lang() { return language(this.vscode.env.language); }

  set(list, source, now = Date.now()) {
    this.list = list || [];
    this.source = source;
    const ages = [];
    for (const c of this.list) {
      ages.push(ageSince(c.lastActiveAt, now));
      for (const r of c.doing.concat(c.questions)) ages.push(ageSince(r.since, now));
    }
    const signature = JSON.stringify([this.lang(), this.list.map((c) => [c.sessionId, c.title, c.state, c.running, c.open,
      c.hasPlan, c.questions, c.doing]), ages]);
    if (signature === this.signature) return false;
    this.signature = signature;
    this._emitter.fire();
    return true;
  }

  /* The logo-and-dot icon for a state, or null to fall back to the plain icon. */
  logoIcon(state) {
    const logo = this.logoOf();
    if (!logo) return null;
    const icons = iconsFor({ light: logo.light.fsPath || logo.light, dark: logo.dark.fsPath || logo.dark }, this.iconDir, this.cache);
    const pair = icons && icons[state];
    return pair ? { light: this.vscode.Uri.file(pair.light), dark: this.vscode.Uri.file(pair.dark) } : null;
  }

  getChildren(element) {
    if (!element) {
      const rows = this.list.filter((c) => c.running).map((c) => ({ kind: 'conversation', c }));
      const stopped = this.list.filter((c) => !c.running);
      if (stopped.length) rows.push({ kind: 'stopped', stopped });
      return rows;
    }
    if (element.kind === 'stopped') return element.stopped.map((c) => ({ kind: 'conversation', c }));
    if (element.kind === 'conversation') {
      const c = element.c;
      return c.questions.map((q) => ({ kind: 'question', c, q })).concat(c.doing.map((d) => ({ kind: 'doing', c, d })));
    }
    return [];
  }

  getTreeItem(element) {
    const vscode = this.vscode;
    const t = textFor(this.lang());
    if (element.kind === 'stopped') {
      const item = new vscode.TreeItem(t.stopped(element.stopped.length), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'conversations/!stopped';
      item.iconPath = new vscode.ThemeIcon('history');
      return item;
    }
    const c = element.c;
    const label = (this.source && this.source.label) || '';
    const target = { sourceId: this.source && this.source.id, sessionId: c.sessionId, cwd: c.cwd, title: c.title };
    const open = { command: 'codexExtras.openConversation', title: 'Go to the conversation', arguments: [target] };
    const where = (c.running ? '' : 'stopped/') + c.sessionId;
    if (element.kind === 'conversation') {
      const kids = c.questions.length + c.doing.length;
      const expanded = c.running && (c.state === 'needs' || c.state === 'prompt' || c.state === 'working');
      const item = new vscode.TreeItem(c.title, !kids ? vscode.TreeItemCollapsibleState.None
        : expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `conversations/${this.source ? this.source.id : ''}/${where}`;
      const [icon, color] = LOOK[c.state] || LOOK.idle;
      item.iconPath = this.logoIcon(c.state) || new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      item.description = [t.state[c.state], c.questions.length ? t.questions(c.questions.length) : '',
        c.hasPlan ? t.open(c.open) : t.noPlan].filter(Boolean).join(' · ');
      item.tooltip = [c.title, `${label}${label ? ' · ' : ''}${t.state[c.state]}`, c.cwd ? t.folder(c.cwd) : ''].filter(Boolean).join('\n');
      item.command = open;
      return item;
    }
    if (element.kind === 'question') {
      const q = element.q;
      const item = new vscode.TreeItem(`${q.row}. ${q.question}`);
      item.id = `conversations/${this.source ? this.source.id : ''}/${where}/?${q.row}`;
      item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.orange'));
      item.description = t.asked(ageSince(q.since));
      item.tooltip = `${q.question}\n\n${q.row}. ${q.title}`;
      item.command = {
        command: 'codexExtras.answerQuestion', title: 'Answer it',
        arguments: [{
          sourceId: target.sourceId, sessionId: c.sessionId, row: q.row, rowTitle: q.title, question: q.question,
          note: q.note, detail: q.detail, since: q.since, conversation: c.title, running: true, open: target,
        }],
      };
      return item;
    }
    const d = element.d;
    const item = new vscode.TreeItem(`${d.row}. ${d.title}`);
    item.id = `conversations/${this.source ? this.source.id : ''}/${where}/>${d.row}`;
    const busy = c.state === 'working';
    item.iconPath = busy ? new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('descriptionForeground'));
    item.description = busy ? t.doing(ageSince(d.since)) : t.lastWorked(ageSince(c.lastActiveAt));
    item.tooltip = `${d.row}. ${d.title}\n\n${item.description}`;
    item.command = open;
    return item;
  }
}

module.exports = { ConversationsProvider, LOOK };
