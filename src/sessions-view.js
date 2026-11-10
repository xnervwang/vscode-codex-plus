// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Codex session list: every conversation, grouped the way a person looks for one.
 *
 *   Recently closed       tabs closed in this workspace, newest first (collapsed)
 *   Open sessions         the Codex tabs of this window, the one last in front first, each with its status colour
 *   <groups>              Codex's sections (src/session-groups.js)
 *   Ungrouped             the rest of this workspace's
 *
 * The group names are Claude Code's, so that both lists read the same way. Each carries its count. A group the user
 * made is drawn even while empty, so it can be found and filled; the others are left out while empty, Codex's built-in
 * Pinned section among them. An archived conversation is not listed: VS Code's Codex has no page that shows one, so
 * the list offers no way to archive either.
 *
 * Like Claude Code's list, it holds this workspace's conversations only, and every conversation in a window with no
 * folder open. The workspace filter compares real paths (src/folders.js): the same directory reached through a symbolic link used to
 * match nothing, and the whole view came up empty with no reason shown.
 *
 * Grouping, sorting and filtering are arithmetic over the snapshot already in memory, and read no file of their own.
 * Conversations the user skipped carry no status dot until their group is expanded, which is the only moment their
 * rollout is asked for, and the answer comes back on the next scheduled poll (getChildren, ask).
 *
 * Threads Codex started by itself - sub-agents, the reviews of approval requests - and `codex exec` runs are left out
 * unless codexPlus.hideBackgroundSessions is off, when they are listed with the rest. Clicking a conversation opens it
 * in a tab. The hover gives the group it sits in and its thread id, and the title can be given a colour.
 *
 * It is drawn in this extension's own activity bar container, so it does not sit in the work plan sidebar while another
 * agent's conversation is in front. The threads come
 * from the reader's latest snapshot (src/codex-reader.js), so drawing it reads no file.
 */
const { folderTest } = require('./folders');
const { PINNED_SECTION } = require('./session-groups');

/* The colours a title can be given: the eight Claude Code's /color offers, as theme colours. */
const COLORS = {
  red: 'charts.red', orange: 'charts.orange', yellow: 'charts.yellow', green: 'charts.green',
  cyan: 'terminal.ansiCyan', blue: 'charts.blue', purple: 'charts.purple', pink: 'terminal.ansiMagenta',
};
const COLOR_KEY = 'codexPlus.titleColors';
const SCHEME = 'codex-extras-thread';
/* The same dots Claude Code's list uses: green running, blue waiting for you, red replied and unread or last turn
   failed, grey idle. A conversation running or waiting in another window gets a ring in that colour. */
const STATE_LOOK = {
  working: { icon: 'circle-filled', color: 'charts.green', word: 'working' },
  workingElsewhere: { icon: 'circle-outline', color: 'charts.green', word: 'working in another window' },
  unread: { icon: 'circle-filled', color: 'charts.red', word: 'replied, not read' },
  failed: { icon: 'circle-filled', color: 'charts.red', word: 'last turn failed' },
  idle: { icon: 'circle-filled', color: 'disabledForeground', word: 'idle' },
  prompt: { icon: 'circle-filled', color: 'charts.blue', word: 'waiting for you' },
  promptElsewhere: { icon: 'circle-outline', color: 'charts.blue', word: 'waiting for you in another window' },
  /* No dot: the user has not read this rollout, so whether a turn is running there is not known. */
  unknown: { icon: 'blank', color: 'descriptionForeground', word: 'not read' },
};

/*
 * Picks the dot for a conversation from what the source reported. `here` is whether this window shows it, in a tab or
 * in Codex's sidebar. A conversation that is running or waiting, but that this window neither shows nor runs, is in
 * another window. A conversation with an approval counted in this window, or with a turn running on this window's
 * app-server, is always this window's.
 */
function lookOf(conv, here) {
  const state = (conv && conv.state) || 'idle';
  const ours = here || !!(conv && (conv.runningHere || conv.decide || conv.soon));
  if (state === 'working') return ours ? STATE_LOOK.working : STATE_LOOK.workingElsewhere;
  if (state === 'prompt') return ours ? STATE_LOOK.prompt : STATE_LOOK.promptElsewhere;
  if (conv && conv.failed) return STATE_LOOK.failed;
  return STATE_LOOK[state] || STATE_LOOK.idle;
}

const pad = (n) => String(n).padStart(2, '0');
/* How long ago, as Claude Code's own list writes it: now, then whole minutes, hours, days, months of 30 days, years. */
function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const mo = Math.floor(d / 30), y = Math.floor(d / 365);
  return y > 0 ? `${y}y` : mo > 0 ? `${mo}mo` : d > 0 ? `${d}d` : h > 0 ? `${h}h` : m > 0 ? `${m}m` : 'now';
}
/* `2d · 11/05→11/09`: how long ago it was last active, then the dates it spans, or one date if both are the same day.
   Month comes before day, as elsewhere in the panel, and a year other than the current one goes in front, once for a
   span within that year: `2025/11/05→11/09`, `2025/12/30→01/02`. */
function dateSpan(createdMs, updatedMs, now = Date.now()) {
  if (!updatedMs) return '';
  const year = new Date(now).getFullYear();
  const ymd = (ms) => { const t = new Date(ms); return { y: t.getFullYear(), md: `${pad(t.getMonth() + 1)}/${pad(t.getDate())}` }; };
  const one = (v) => (v.y === year ? v.md : `${v.y}/${v.md}`);
  const e = ymd(updatedMs), s = createdMs ? ymd(createdMs) : null;
  let body = one(e);
  if (s && (s.y !== e.y || s.md !== e.md)) body = s.y === e.y && s.y !== year ? `${s.y}/${s.md}→${e.md}` : `${one(s)}→${one(e)}`;
  return `${ago(updatedMs, now)} · ${body}`;
}

/** Group a list of threads for the tree. Pure, so the test can hold it to the order above. */
function group(threads, { open = [], closed = [], sections = new Map(), hideBackground = true, cwdFilter = null, frontAt = () => 0,
  sidebar = '' }) {
  if (sidebar && !open.includes(sidebar)) open = [...open, sidebar];
  const byId = new Map(threads.map((t) => [t.id, t]));
  const kindOk = (t) => (hideBackground ? t.kind === 'user' : true);
  const here = threads.filter((t) => kindOk(t) && !t.archived && (!cwdFilter || cwdFilter(t.cwd)));
  const openRows = open.map((id) => byId.get(id) || { id, title: '', kind: 'user', updatedMs: 0, createdMs: 0 })
    .sort((a, b) => (frontAt(b.id) - frontAt(a.id)) || (b.updatedMs - a.updatedMs));
  const openSet = new Set(open);
  const closedRows = closed.map((c) => byId.get(c.thread) || { id: c.thread, title: c.title, kind: 'user', updatedMs: c.at, createdMs: 0 })
    .filter((t) => !openSet.has(t.id));
  const out = [{ key: 'closed', label: 'Recently closed', expanded: false, threads: closedRows },
    { key: 'open', label: 'Open sessions', expanded: true, threads: openRows }];
  for (const [id, name] of sections) {
    const inSection = here.filter((t) => t.section === id);
    if (id === PINNED_SECTION && !inSection.length) continue;
    out.push({ key: `section:${id}`, label: name || 'Group', expanded: true, threads: inSection, made: id !== PINNED_SECTION });
  }
  const known = new Set(sections.keys());
  out.push({ key: 'ungrouped', label: 'Ungrouped', expanded: true, threads: here.filter((t) => !t.section || !known.has(t.section)) });
  return out;
}

/* The groups drawn: those holding something, and every group the user made. */
const drawn = (groups) => groups.filter((g) => g.threads.length || g.made);

/** The group a thread is listed under below Open sessions, for the hover. */
function placeOf(t, sections) {
  return t.section && sections.has(t.section) ? sections.get(t.section) || 'Group' : 'Ungrouped';
}

class SessionsProvider {
  constructor(vscode, { memory, memento, settings, stateOf, reader, wantState = () => {}, sidebarShowing = () => '', sections = null }) {
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
    /* Codex's sections in the order the list draws them (src/session-groups.js); the snapshot's order otherwise. */
    this.sectionsOf = sections || (() => reader.sections());
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.decoEmitter = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this.decoEmitter.event;
    this.threads = [];
    this.sections = new Map();
    this.groups = [];
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
    this.sections = this.sectionsOf();
    const folders = (this.vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    /*
     * Real paths, not the strings: VS Code gives the workspace folder as /home/<user>/... where Codex recorded the
     * thread's cwd as /local/home/<user>/..., the same directory through a symbolic link. The memo lasts this pass
     * only, so a folder created or moved since is resolved again next time.
     */
    const cwdFilter = folders.length ? folderTest(folders, new Map()) : null;
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
    if (!element) return drawn(this.groups).map((g) => ({ kind: 'group', group: g }));
    if (element.kind === 'group') {
      const g = element.group;
      this.ask(g.threads);
      return g.threads.map((t) => ({ kind: 'thread', thread: t, group: g.key }));
    }
    return [];
  }

  /* A row's group, which is what VS Code walks up through to reveal the row. */
  getParent(element) {
    if (!element || element.kind !== 'thread') return undefined;
    const g = this.groups.find((x) => x.key === element.group);
    return g ? { kind: 'group', group: g } : undefined;
  }

  /** The row a conversation open in this window has in Open sessions, or null. */
  rowOf(id) {
    const open = this.groups.find((g) => g.key === 'open');
    const t = open && open.threads.find((x) => x.id === id);
    return t ? { kind: 'thread', thread: t, group: 'open' } : null;
  }

  /** Ask for the state of those of `threads` the user has not read. */
  ask(threads) {
    const want = threads.filter((t) => t && t.id && !this.reader.state(t.id)).map((t) => t.id);
    if (want.length) { try { this.wantState(want); } catch (_) { /* the rows show no dot, which is what they already do */ } }
  }

  getTreeItem(element) {
    const vscode = this.vscode;
    if (element.kind === 'group') {
      const g = element.group;
      const item = new vscode.TreeItem(g.label, g.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${g.key}`;
      item.description = String(g.threads.length);
      item.contextValue = g.key === `section:${PINNED_SECTION}` ? 'codexPlusGroup-pinned'
        : g.key.startsWith('section:') ? 'codexPlusGroup-section' : `codexPlusGroup-${g.key}`;
      return item;
    }
    const t = element.thread;
    const conv = this.stateOf(t.id);
    /* A conversation whose rollout the user has not read gets no status dot rather than a wrong one: not read is not
       the same as idle, and reading every old rollout to colour a dot is what the window must not pay for. */
    const here = this.memory.openThreads().includes(t.id) || t.id === this.sidebarNow;
    const look = this.reader.state(t.id) ? lookOf(conv, here) : STATE_LOOK.unknown;
    const item = new vscode.TreeItem(t.title || '(untitled)', vscode.TreeItemCollapsibleState.None);
    item.id = `${element.group}:${t.id}`;
    item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${t.id}` });
    item.description = dateSpan(t.createdMs, t.updatedMs);
    item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
    const open = element.group === 'open';
    item.contextValue = (open ? 'codexPlusThreadOpen' : 'codexPlusThread') + (t.section && this.sections.has(t.section) ? ' grouped' : '')
      + (conv && conv.state === 'unread' ? ' unread' : '');
    const inSidebar = open && t.id === this.sidebarNow && !this.memory.openThreads().includes(t.id);
    item.tooltip = `Group: ${placeOf(t, this.sections)}\nSession ID: ${t.id}`;
    item.command = inSidebar ? { command: 'codexPlus.openThreadInSidebar', title: 'Show in the sidebar', arguments: [t.id] }
      : { command: 'codexPlus.openThreadInTab', title: 'Open in a tab', arguments: [t.id] };
    return item;
  }
}

/*
 * Keeps the list on the conversation in front, like Claude Code's list: its row in Open sessions is selected and
 * scrolled into view without taking the focus. Nothing happens while the list is hidden, because revealing a row of a
 * hidden view opens the view. Returns a function to call whenever the front may have changed; `frontOf` returns the id
 * of the conversation in front, or ''.
 */
function createFollower(view, provider, frontOf) {
  let followed = '';
  const follow = () => {
    let front = '';
    try { front = frontOf() || ''; } catch (_) { front = ''; }
    if (!front) { followed = ''; return; }
    if (front === followed || !view.visible) return;
    const row = provider.rowOf(front);
    if (!row) return;
    followed = front;
    Promise.resolve(view.reveal(row, { select: true, focus: false })).catch(() => { followed = ''; });
  };
  if (typeof view.onDidChangeVisibility === 'function') view.onDidChangeVisibility(() => { followed = ''; follow(); });
  return follow;
}

/* Whether a search string is meant as part of a thread id: four or more characters of hex and hyphens. */
const looksLikeId = (q) => /^[0-9a-f-]{4,}$/i.test(String(q || '').trim());

module.exports = { SessionsProvider, createFollower, group, dateSpan, placeOf, looksLikeId, lookOf, COLORS, COLOR_KEY, SCHEME, STATE_LOOK };
