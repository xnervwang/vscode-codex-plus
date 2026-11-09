// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Codex session list: every conversation, grouped the way a person looks for one.
 *
 *   Open sessions         the Codex tabs of this window, the one last in front first, each with its status colour
 *   Recently closed       tabs closed in this workspace, newest first (collapsed)
 *   Pinned, <sections>    Codex's own pins and sections, as its sidebar keeps them
 *   Ungrouped             the rest of this workspace's
 *   Archived sessions     Codex's archived threads of this workspace (collapsed)
 *   Other folders         everything the workspace filter left out, by the folder it started in (collapsed)
 *
 * The group names are Claude Code's, so that both lists read the same way. Each carries its count; an empty one is
 * left out, except Open sessions, which says there is none.
 *
 * The workspace filter hides rather than drops, and Other folders holds what it hid, so no conversation disappears
 * from the view. That filter compares real paths (src/folders.js): the same directory reached through a symbolic link
 * used to match nothing, and the whole view came up empty with no reason shown.
 *
 * Grouping, sorting and filtering are arithmetic over the snapshot already in memory, and read no file of their own.
 * Conversations the user skipped carry no status dot until their group is expanded, which is the only moment their
 * rollout is asked for, and the answer comes back on the next scheduled poll (getChildren, ask).
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
  /* No dot: the user has not read this rollout, so whether a turn is running there is not known. */
  unknown: { icon: 'blank', color: 'descriptionForeground', word: 'not read' },
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

/*
 * The conversations of one directory, for Other folders: newest directory first, and within one the order they came in
 * (newest conversation first), archived ones after the rest.
 */
function byFolder(threads) {
  const dirs = new Map();
  for (const t of threads) {
    const dir = t.cwd || '(no folder)';
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(t);
  }
  const out = [...dirs].map(([dir, list]) => ({
    dir,
    threads: list.slice().sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0)),
    at: Math.max(...list.map((t) => t.updatedMs || 0)),
  }));
  out.sort((a, b) => b.at - a.at || a.dir.localeCompare(b.dir));
  return out;
}

/** Group a list of threads for the tree. Pure, so the test can hold it to the order above. */
function group(threads, { open = [], closed = [], sections = new Map(), hideBackground = true, cwdFilter = null, frontAt = () => 0,
  sidebar = '' }) {
  if (sidebar && !open.includes(sidebar)) open = [...open, sidebar];
  const byId = new Map(threads.map((t) => [t.id, t]));
  const kindOk = (t) => (hideBackground ? t.kind === 'user' : true);
  const here = threads.filter((t) => kindOk(t) && (!cwdFilter || cwdFilter(t.cwd)));
  /* Conversations of other folders are not dropped: they are the history group, so the list is never short with no
     reason shown. Background threads stay out of it - they belong to whatever started them, not to a folder. */
  const elsewhere = cwdFilter ? threads.filter((t) => t.kind === 'user' && !cwdFilter(t.cwd)) : [];
  const openRows = open.map((id) => byId.get(id) || { id, title: '', kind: 'user', updatedMs: 0, createdMs: 0 })
    .sort((a, b) => (frontAt(b.id) - frontAt(a.id)) || (b.updatedMs - a.updatedMs));
  const openSet = new Set(open);
  const out = [{ key: 'open', label: 'Open sessions', expanded: true, threads: openRows }];
  const closedRows = closed.map((c) => byId.get(c.thread) || { id: c.thread, title: c.title, kind: 'user', updatedMs: c.at, createdMs: 0 })
    .filter((t) => !openSet.has(t.id));
  out.push({ key: 'closed', label: 'Recently closed', expanded: false, threads: closedRows });
  const rest = here.filter((t) => t.kind === 'user' && !t.archived);
  const pinned = rest.filter((t) => t.pinned);
  if (pinned.length) out.push({ key: 'pinned', label: 'Pinned', expanded: true, threads: pinned });
  for (const [id, name] of sections) {
    const inSection = rest.filter((t) => !t.pinned && t.section === id);
    if (inSection.length) out.push({ key: `section:${id}`, label: name || 'Section', expanded: true, threads: inSection });
  }
  const known = new Set(sections.keys());
  out.push({ key: 'ungrouped', label: 'Ungrouped', expanded: true, threads: rest.filter((t) => !t.pinned && (!t.section || !known.has(t.section))) });
  const background = here.filter((t) => t.kind !== 'user');
  if (!hideBackground && background.length) out.push({ key: 'background', label: 'Background', expanded: false, threads: background });
  out.push({ key: 'archived', label: 'Archived sessions', expanded: false, threads: here.filter((t) => t.kind === 'user' && t.archived) });
  out.push({ key: 'other', label: 'Other folders', expanded: false, threads: elsewhere, folders: byFolder(elsewhere) });
  return out;
}

/** Where a thread sits below Open sessions, in words, for the hover. */
function placeOf(t, sections) {
  if (t.archived) return 'Archived sessions';
  if (t.kind !== 'user') return `Background (${t.kind === 'guardian' ? 'approval review' : t.kind === 'subagent' ? 'sub-agent' : 'codex exec'})`;
  if (t.pinned) return 'Pinned';
  if (t.section && sections.has(t.section)) return sections.get(t.section);
  return 'Ungrouped';
}

class SessionsProvider {
  constructor(vscode, { memory, memento, settings, stateOf, reader, wantState = () => {}, sidebarShowing = () => '' }) {
    this.vscode = vscode;
    this.reader = reader;
    this.memory = memory;
    this.memento = memento;
    this.settings = settings;
    this.stateOf = stateOf;
    /* Asks for the rollout state of conversations the user has not read, on the next poll it was going to make
       anyway. Called when a group is expanded, which is the only time those rows are on screen. */
    this.wantState = wantState;
    /* The conversation Codex's sidebar shows now, which counts as open in this window as a tab does. */
    this.sidebarShowing = sidebarShowing;
    this.sidebarNow = '';
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
    try { this.sidebarNow = this.sidebarShowing() || ''; } catch (_) { this.sidebarNow = ''; }
    this.groups = group(this.threads, {
      sidebar: this.sidebarNow,
      open: this.memory.openThreads(), closed: this.memory.recentlyClosed(this.settings().recentClosedSessions),
      sections: this.sections, hideBackground: this.settings().hideBackgroundSessions, cwdFilter,
      frontAt: (id) => this.memory.frontAt(id),
    });
    this.emitter.fire();
  }

  /*
   * VS Code asks for a group's children only once it is expanded, so this is where the rollout state of conversations
   * the user skipped is asked for. Nothing is read for a group nobody opened, and the answer arrives on the poll that
   * was due anyway rather than on a timer of its own.
   */
  getChildren(element) {
    if (!element) return this.groups.filter((g) => g.threads.length || g.key === 'open').map((g) => ({ kind: 'group', group: g }));
    if (element.kind === 'group') {
      const g = element.group;
      if (g.key === 'other') {
        this.ask(g.threads);
        return g.folders.map((f) => ({ kind: 'folder', folder: f }));
      }
      if (!g.threads.length && g.key === 'open') return [{ kind: 'empty', text: 'No conversation open in this window' }];
      this.ask(g.threads);
      return g.threads.map((t) => ({ kind: 'thread', thread: t, group: g.key }));
    }
    if (element.kind === 'folder') {
      this.ask(element.folder.threads);
      return element.folder.threads.map((t) => ({ kind: 'thread', thread: t, group: 'other' }));
    }
    return [];
  }

  /** Ask for the state of those of `threads` the user has not read. */
  ask(threads) {
    const want = threads.filter((t) => t && t.id && !this.reader.state(t.id)).map((t) => t.id);
    if (want.length) { try { this.wantState(want); } catch (_) { /* the rows show no dot, which is what they already do */ } }
  }

  getTreeItem(element) {
    const vscode = this.vscode;
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      item.id = 'empty:open';
      item.contextValue = 'codexExtrasEmpty';
      return item;
    }
    if (element.kind === 'folder') {
      const f = element.folder;
      const item = new vscode.TreeItem(f.dir, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `folder:${f.dir}`;
      item.description = String(f.threads.length);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.tooltip = `${f.threads.length} conversation${f.threads.length === 1 ? '' : 's'} started in ${f.dir}`;
      item.contextValue = 'codexExtrasFolder';
      return item;
    }
    if (element.kind === 'group') {
      const g = element.group;
      const item = new vscode.TreeItem(g.label, g.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${g.key}`;
      // An empty group says so in a row of its own instead of carrying a nought.
      if (g.threads.length) item.description = String(g.threads.length);
      item.contextValue = `codexExtrasGroup-${g.key}`;
      if (g.key === 'other') {
        item.iconPath = new vscode.ThemeIcon('history');
        item.tooltip = 'Conversations started outside this window\'s workspace, by the folder they started in.'
          + ' Right-click to list them with the rest instead (codexExtras.sessionsInWorkspaceOnly).';
      }
      return item;
    }
    const t = element.thread;
    const conv = this.stateOf(t.id);
    /* A conversation whose rollout the user has not read gets no status dot rather than a wrong one: not read is not
       the same as idle, and reading every old rollout to colour a dot is what the window must not pay for. */
    const look = this.reader.state(t.id) ? (STATE_LOOK[(conv && conv.state) || 'idle'] || STATE_LOOK.idle) : STATE_LOOK.unknown;
    const item = new vscode.TreeItem(t.title || '(untitled)', vscode.TreeItemCollapsibleState.None);
    item.id = `${element.group}:${t.id}`;
    item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${t.id}` });
    item.description = dateSpan(t.createdMs, t.updatedMs);
    item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
    const open = element.group === 'open';
    item.contextValue = t.archived ? 'codexExtrasThreadArchived' : open ? 'codexExtrasThreadOpen' : 'codexExtrasThread';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${(t.title || '(untitled)').replace(/[*_`[\]]/g, '\\$&')}**\n\n`);
    const place = element.group === 'other' ? 'Other folders' : placeOf(t, this.sections);
    const inSidebar = open && t.id === this.sidebarNow && !this.memory.openThreads().includes(t.id);
    md.appendMarkdown(`${look.word} · ${place}${inSidebar ? ' · in Codex\'s sidebar' : open ? ' · open in this window' : ''}\n\n`);
    md.appendCodeblock(t.id, 'text');
    if (t.cwd) md.appendMarkdown(`\n${t.cwd}${t.branch ? ` (${t.branch})` : ''}`);
    item.tooltip = md;
    item.command = inSidebar ? { command: 'codexExtras.openThreadInSidebar', title: 'Show in the sidebar', arguments: [t.id] }
      : { command: 'codexExtras.openThreadInTab', title: 'Open in a tab', arguments: [t.id] };
    return item;
  }
}

/* Whether a search string is meant as part of a thread id: four or more characters of hex and hyphens. */
const looksLikeId = (q) => /^[0-9a-f-]{4,}$/i.test(String(q || '').trim());

module.exports = { SessionsProvider, group, dateSpan, placeOf, looksLikeId, COLORS, COLOR_KEY, SCHEME, STATE_LOOK };
