// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Codex session list: every conversation, grouped the way a person looks for one.
 *
 *   Open in this window   the Codex tabs of this window, the one last in front first, each with its status colour
 *   Recently closed       tabs closed in this workspace, newest first (collapsed)
 *   Pinned, <sections>    Codex's own pins and sections, as its sidebar keeps them
 *   Ungrouped             the rest
 *   Archived              Codex's archived threads (collapsed)
 *
 * Above them, when the workspace filter left anything out, a row saying how many and offering to list those too. The
 * filter compares real paths (src/folders.js): the same directory reached through a symbolic link used to match
 * nothing, and the whole view came up empty with no reason shown.
 *
 * Threads Codex started by itself - sub-agents, the reviews of approval requests - and `codex exec` runs are left out
 * unless codexExtras.hideBackgroundSessions is off, when they are listed under Background. Clicking a conversation opens
 * it in a tab. The hover gives its thread id and which group it sits in, and the title can be given a colour.
 *
 * It is drawn in this extension's own activity bar container, so it does not sit in the work plan sidebar while another
 * agent's conversation is in front. The threads come
 * from the reader's latest snapshot (src/codex-reader.js), so drawing it reads no file.
 */
const { folderTest } = require('./folders');

/* The colours a title can be given: the eight Claude Code's /color offers, as theme colours. */
const COLORS = {
  red: 'charts.red', orange: 'charts.orange', yellow: 'charts.yellow', green: 'charts.green',
  cyan: 'terminal.ansiCyan', blue: 'charts.blue', purple: 'charts.purple', pink: 'terminal.ansiMagenta',
};
const COLOR_KEY = 'codexExtras.titleColors';
const SCHEME = 'codex-extras-thread';
const STATE_LOOK = {
  working: { icon: 'circle-filled', color: 'charts.green', word: 'working' },
  unread: { icon: 'circle-filled', color: 'charts.red', word: 'replied, not read' },
  idle: { icon: 'circle-outline', color: 'descriptionForeground', word: 'idle' },
  prompt: { icon: 'bell-dot', color: 'charts.orange', word: 'waiting for you' },
};

const pad = (n) => String(n).padStart(2, '0');
function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
/* `11d · 09/05→09/16`: how long ago it was last active, then the dates it spans. One date when it began and ended on
   the same day. Month before day, as the rest of the panel writes them. */
function dateSpan(createdMs, updatedMs, now = Date.now()) {
  if (!updatedMs) return '';
  const d = (ms) => { const t = new Date(ms); return `${pad(t.getMonth() + 1)}/${pad(t.getDate())}`; };
  const a = createdMs ? d(createdMs) : '', b = d(updatedMs);
  return `${ago(updatedMs, now)} · ${a && a !== b ? `${a}→${b}` : b}`;
}

/** Group a list of threads for the tree. Pure, so the test can hold it to the order above. */
function group(threads, { open = [], closed = [], sections = new Map(), hideBackground = true, cwdFilter = null, frontAt = () => 0 }) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const visible = threads.filter((t) => (hideBackground ? t.kind === 'user' : true) && (!cwdFilter || cwdFilter(t.cwd)));
  const openRows = open.map((id) => byId.get(id) || { id, title: '', kind: 'user', updatedMs: 0, createdMs: 0 })
    .sort((a, b) => (frontAt(b.id) - frontAt(a.id)) || (b.updatedMs - a.updatedMs));
  const openSet = new Set(open);
  const out = [{ key: 'open', label: 'Open in this window', expanded: true, threads: openRows }];
  const closedRows = closed.map((c) => byId.get(c.thread) || { id: c.thread, title: c.title, kind: 'user', updatedMs: c.at, createdMs: 0 })
    .filter((t) => !openSet.has(t.id));
  out.push({ key: 'closed', label: 'Recently closed', expanded: false, threads: closedRows });
  const rest = visible.filter((t) => t.kind === 'user' && !t.archived);
  const pinned = rest.filter((t) => t.pinned);
  if (pinned.length) out.push({ key: 'pinned', label: 'Pinned', expanded: true, threads: pinned });
  for (const [id, name] of sections) {
    const inSection = rest.filter((t) => !t.pinned && t.section === id);
    if (inSection.length) out.push({ key: `section:${id}`, label: name || 'Section', expanded: true, threads: inSection });
  }
  const known = new Set(sections.keys());
  out.push({ key: 'ungrouped', label: 'Ungrouped', expanded: true, threads: rest.filter((t) => !t.pinned && (!t.section || !known.has(t.section))) });
  const background = visible.filter((t) => t.kind !== 'user');
  if (!hideBackground && background.length) out.push({ key: 'background', label: 'Background', expanded: false, threads: background });
  out.push({ key: 'archived', label: 'Archived', expanded: false, threads: visible.filter((t) => t.kind === 'user' && t.archived) });
  return out;
}

/** Where a thread sits below Open in this window, in words, for the hover. */
function placeOf(t, sections) {
  if (t.archived) return 'Archived';
  if (t.kind !== 'user') return `Background (${t.kind === 'guardian' ? 'approval review' : t.kind === 'subagent' ? 'sub-agent' : 'codex exec'})`;
  if (t.pinned) return 'Pinned';
  if (t.section && sections.has(t.section)) return sections.get(t.section);
  return 'Ungrouped';
}

class SessionsProvider {
  constructor(vscode, { memory, memento, settings, stateOf, reader }) {
    this.vscode = vscode;
    this.reader = reader;
    this.memory = memory;
    this.memento = memento;
    this.settings = settings;
    this.stateOf = stateOf;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.decoEmitter = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this.decoEmitter.event;
    this.threads = [];
    this.sections = new Map();
    this.groups = [];
    /* How many conversations the workspace filter left out, so the view never just comes up empty with no reason given. */
    this.hidden = 0;
  }

  colors() { return this.memento.get(COLOR_KEY) || {}; }
  async setColor(thread, name) {
    const all = { ...this.colors() };
    if (name && COLORS[name]) all[thread] = name; else delete all[thread];
    await this.memento.update(COLOR_KEY, all);
    this.decoEmitter.fire(this.vscode.Uri.from({ scheme: SCHEME, path: `/${thread}` }));
  }

  /* FileDecorationProvider: a title colour is drawn as the decoration colour of the row's resource. */
  provideFileDecoration(uri) {
    if (uri.scheme !== SCHEME) return undefined;
    const name = this.colors()[uri.path.slice(1)];
    return name ? new this.vscode.FileDecoration(undefined, undefined, new this.vscode.ThemeColor(COLORS[name])) : undefined;
  }

  refresh() {
    this.threads = this.reader.threads() || [];
    this.sections = this.reader.sections();
    const folders = (this.vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    /*
     * Real paths, not the strings: VS Code gives the workspace folder as /home/<user>/... where Codex recorded the
     * thread's cwd as /local/home/<user>/..., the same directory through a symbolic link. The memo lasts this pass
     * only, so a folder created or moved since is resolved again next time.
     */
    const cwdFilter = this.settings().sessionsInWorkspaceOnly && folders.length ? folderTest(folders, new Map()) : null;
    this.hidden = cwdFilter ? this.threads.filter((t) => t.kind === 'user' && !cwdFilter(t.cwd)).length : 0;
    this.groups = group(this.threads, {
      open: this.memory.openThreads(), closed: this.memory.recentlyClosed(this.settings().recentClosedSessions),
      sections: this.sections, hideBackground: this.settings().hideBackgroundSessions, cwdFilter,
      frontAt: (id) => this.memory.frontAt(id),
    });
    this.emitter.fire();
  }

  getChildren(element) {
    if (!element) {
      const rows = this.groups.filter((g) => g.threads.length || g.key === 'open').map((g) => ({ kind: 'group', group: g }));
      if (this.hidden > 0) rows.unshift({ kind: 'hidden', count: this.hidden });
      return rows;
    }
    if (element.kind === 'group') return element.group.threads.map((t) => ({ kind: 'thread', thread: t, group: element.group.key }));
    return [];
  }

  getTreeItem(element) {
    const vscode = this.vscode;
    if (element.kind === 'hidden') {
      const n = element.count;
      const item = new vscode.TreeItem(`${n} conversation${n === 1 ? '' : 's'} hidden: not in this workspace`,
        vscode.TreeItemCollapsibleState.None);
      item.id = 'hidden';
      item.iconPath = new vscode.ThemeIcon('filter');
      item.contextValue = 'codexExtrasHidden';
      item.tooltip = 'Started in a folder outside this window\'s workspace. Click to list every conversation instead'
        + ' (codexExtras.sessionsInWorkspaceOnly).';
      item.command = { command: 'codexExtras.showAllFolders', title: 'List conversations from every folder' };
      return item;
    }
    if (element.kind === 'group') {
      const g = element.group;
      const item = new vscode.TreeItem(g.label, g.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${g.key}`;
      item.description = String(g.threads.length);
      item.contextValue = `codexExtrasGroup-${g.key}`;
      return item;
    }
    const t = element.thread;
    const conv = this.stateOf(t.id);
    const look = STATE_LOOK[(conv && conv.state) || 'idle'] || STATE_LOOK.idle;
    const item = new vscode.TreeItem(t.title || '(untitled)', vscode.TreeItemCollapsibleState.None);
    item.id = `${element.group}:${t.id}`;
    item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${t.id}` });
    item.description = dateSpan(t.createdMs, t.updatedMs);
    item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
    const open = element.group === 'open';
    item.contextValue = t.archived ? 'codexExtrasThreadArchived' : open ? 'codexExtrasThreadOpen' : 'codexExtrasThread';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${(t.title || '(untitled)').replace(/[*_`[\]]/g, '\\$&')}**\n\n`);
    md.appendMarkdown(`${look.word} · ${placeOf(t, this.sections)}${open ? ' · open in this window' : ''}\n\n`);
    md.appendCodeblock(t.id, 'text');
    if (t.cwd) md.appendMarkdown(`\n${t.cwd}${t.branch ? ` (${t.branch})` : ''}`);
    item.tooltip = md;
    item.command = { command: 'codexExtras.openThreadInTab', title: 'Open in a tab', arguments: [t.id] };
    return item;
  }
}

/* Whether a search string is meant as part of a thread id: four or more characters of hex and hyphens. */
const looksLikeId = (q) => /^[0-9a-f-]{4,}$/i.test(String(q || '').trim());

module.exports = { SessionsProvider, group, dateSpan, placeOf, looksLikeId, COLORS, COLOR_KEY, SCHEME, STATE_LOOK };
