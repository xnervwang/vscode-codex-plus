// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Codex session list: every conversation of this workspace, in the layout of Claude Code's list with the sections
 * Claude Code Plus adds.
 *
 *   ACCOUNT & USAGE       the sign-in, and usage when Codex reports it (src/account-usage.js)
 *   RECENTLY CLOSED       tabs closed in this workspace, newest first (collapsed)
 *   OPEN SESSIONS         this window's Codex tabs and the conversation in Codex's sidebar, last focused first
 *   SESSION MANAGER       New in tab and New in sidebar, the filter row, then the groups (Codex's sections,
 *                         src/session-groups.js) and Ungrouped
 *
 * Groups the user made are drawn even when empty, so a new one can take conversations dropped on it; the other groups,
 * Codex's built-in Pinned section included, are hidden while empty. Archived conversations are not listed: VS Code's
 * Codex has no page that lists them, so the list does not archive either.
 *
 * Like Claude Code's list, it holds this workspace's conversations only, and every conversation in a window with no
 * folder open. The workspace filter compares real paths (src/folders.js): the same directory reached through a symbolic
 * link used to match nothing, and the whole view came up empty with no reason shown.
 *
 * The list is a webview view drawn by src/page/sessions-page.js. SessionsModel turns the in-memory snapshot into plain
 * values (groups, dots, time text) without reading files; the page filters and searches that model. SessionsView posts
 * the model only when it changed and the view is visible.
 *
 * Conversations whose rollout was not read carry no status dot until their group is expanded, which is the only moment
 * their rollout is asked for; the answer comes back on the next scheduled poll (SessionsModel.expanded).
 *
 * Threads Codex started by itself - sub-agents, the reviews of approval requests - and `codex exec` runs are left out
 * unless codexPlus.hideBackgroundSessions is off, when they are listed with the rest.
 */
const { folderTest } = require('./folders');
const { PINNED_SECTION } = require('./session-groups');

/* The colours a title can be given: the eight Claude Code's /color offers, as theme colours. */
const COLORS = {
  red: 'charts.red', orange: 'charts.orange', yellow: 'charts.yellow', green: 'charts.green',
  cyan: 'terminal.ansiCyan', blue: 'charts.blue', purple: 'charts.purple', pink: 'terminal.ansiMagenta',
};
const COLOR_KEY = 'codexPlus.titleColors';
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
function lookKey(conv, here) {
  const state = (conv && conv.state) || 'idle';
  const ours = here || !!(conv && (conv.runningHere || conv.decide || conv.soon));
  if (state === 'working') return ours ? 'working' : 'workingElsewhere';
  if (state === 'prompt') return ours ? 'prompt' : 'promptElsewhere';
  if (conv && conv.failed) return 'failed';
  return STATE_LOOK[state] ? state : 'idle';
}
const lookOf = (conv, here) => STATE_LOOK[lookKey(conv, here)];

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

/** Group a list of threads for the list. Pure, so the test can hold it to the order above. */
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

/*
 * Builds the plain-value model the page draws (model()).
 */
class SessionsModel {
  constructor(vscode, { memory, memento, settings, stateOf, reader, wantState = () => {}, sidebarShowing = () => '', sections = null,
    account = () => null, front = () => '', noGroups = () => false }) {
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
    /* ACCOUNT & USAGE (src/account-usage.js viewOf), or null for no section. */
    this.accountOf = account;
    /* The conversation in front, whose row is drawn as the current one. */
    this.frontOf = front;
    this.noGroups = noGroups;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
    this.threads = [];
    this.sections = new Map();
    this.groups = [];
    this.json = '';
    this.value = null;
  }

  colors() { return this.memento.get(COLOR_KEY) || {}; }
  async setColor(thread, name) {
    const all = { ...this.colors() };
    if (name && COLORS[name]) all[thread] = name; else delete all[thread];
    await this.memento.update(COLOR_KEY, all);
    this.refresh();
  }

  /* Works the model out again, and tells the view when it changed. */
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
    const value = this.build();
    const json = JSON.stringify(value);
    if (json === this.json) return false;
    this.json = json;
    this.value = value;
    this.emitter.fire();
    return true;
  }

  model() { return this.value || (this.refresh(), this.value); }

  build() {
    const now = Date.now();
    const colors = this.colors();
    const open = new Set(this.memory.openThreads());
    let front = '';
    try { front = this.frontOf() || ''; } catch (_) { front = ''; }
    const row = (t, where) => {
      const here = open.has(t.id) || t.id === this.sidebarNow;
      /* No dot for a conversation whose rollout has not been read: unread state is unknown, not idle, and reading
         every old rollout just to colour dots costs too much. */
      const conv = this.stateOf(t.id);
      const dot = this.reader.state(t.id) ? lookKey(conv, here) : 'unknown';
      return { id: t.id, title: t.title || '(untitled)', time: dateSpan(t.createdMs, t.updatedMs, now), dot,
        color: COLORS[colors[t.id]] || '', open: open.has(t.id), sidebar: where === 'open' && t.id === this.sidebarNow && !open.has(t.id),
        unread: !!(conv && conv.state === 'unread'), grouped: !!(t.section && this.sections.has(t.section)),
        group: placeOf(t, this.sections), branch: t.branch || '' };
    };
    const keep = (key) => this.groups.find((g) => g.key === key);
    const rowsOf = (g) => (g ? g.threads.map((t) => row(t, g.key)) : []);
    let account = null;
    try { account = this.accountOf() || null; } catch (_) { account = null; }
    const manager = drawn(this.groups.filter((g) => g.key !== 'closed' && g.key !== 'open'));
    return {
      account,
      closed: rowsOf(keep('closed')),
      open: rowsOf(keep('open')),
      groups: manager.map((g) => ({ key: g.key, label: g.label, made: !!g.made, rows: rowsOf(g) })),
      front,
      noGroups: !!this.noGroups(),
    };
  }

  /* The page expanded `keys`: ask for the state of their conversations the user has not read. */
  expanded(keys) {
    const want = new Set(Array.isArray(keys) ? keys : []);
    const ids = this.groups.filter((g) => want.has(g.key)).flatMap((g) => g.threads)
      .filter((t) => t && t.id && !this.reader.state(t.id)).map((t) => t.id);
    if (ids.length) { try { this.wantState([...new Set(ids)]); } catch (_) { /* the rows show no dot, which is what they already do */ } }
    return ids;
  }
}

/*
 * The webview view. Without retainContextWhenHidden VS Code drops the page while the view is hidden; a page that comes
 * back sends `ready`, and the view posts it the current model. `receive(msg)` gets every message the page sends.
 */
const PAGE_FILES = ['sessions-page.js', 'sessions-page.css'];
class SessionsView {
  constructor(vscode, { model, extensionUri, receive = () => {}, onVisible = () => {} }) {
    this.vscode = vscode;
    this.modelOf = model;
    this.extensionUri = extensionUri;
    this.receive = receive;
    this.onVisible = onVisible;
    this.view = null;
    this.posted = '';
    this.selection = [];
    model.onDidChange(() => this.post());
  }

  get visible() { return !!(this.view && this.view.visible); }

  resolveWebviewView(view) {
    const vscode = this.vscode;
    this.view = view;
    this.posted = '';
    const dir = vscode.Uri.joinPath(this.extensionUri, 'src', 'page');
    view.webview.options = { enableScripts: true, localResourceRoots: [dir] };
    const [js, css] = PAGE_FILES.map((f) => view.webview.asWebviewUri(vscode.Uri.joinPath(dir, f)));
    view.webview.html = pageHtml({ js: String(js), css: String(css), csp: view.webview.cspSource, nonce: nonce() });
    const subs = [
      view.webview.onDidReceiveMessage((msg) => {
        if (msg && msg.kind === 'ready') { this.posted = ''; this.post(); }
        if (msg && msg.kind === 'select' && Array.isArray(msg.ids)) this.selection = msg.ids.filter((x) => typeof x === 'string').slice(0, 1000);
        if (msg && msg.kind === 'expanded') this.modelOf.expanded(msg.keys);
        try { this.receive(msg || {}); } catch (_) { /* the page asks again */ }
      }),
      view.onDidChangeVisibility(() => { if (view.visible) { this.post(); this.onVisible(); } }),
    ];
    view.onDidDispose(() => { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } if (this.view === view) this.view = null; });
    this.onVisible();
  }

  /* The model, when it differs from what the page has and the page is on screen. */
  post() {
    if (!this.visible) return false;
    const m = this.modelOf.model();
    const json = this.modelOf.json;
    if (json === this.posted) return false;
    this.posted = json;
    Promise.resolve(this.view.webview.postMessage({ type: 'model', model: m })).catch(() => { this.posted = ''; });
    return true;
  }

  /* Anything else for the page: { type: 'startRename', id } and the like. */
  tell(msg) {
    if (!this.view) return false;
    Promise.resolve(this.view.webview.postMessage(msg)).catch(() => {});
    return true;
  }
}

function nonce() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}

function pageHtml({ js, css, csp, nonce: n }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${n}'; img-src ${csp} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root" class="cp-root" tabindex="0" data-vscode-context='{"preventDefaultContextMenuItems":true}'></div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}

/* Whether a search string is meant as part of a thread id: four or more characters of hex and hyphens. */
const looksLikeId = (q) => /^[0-9a-f-]{4,}$/i.test(String(q || '').trim());

module.exports = { SessionsModel, SessionsView, pageHtml, group, drawn, dateSpan, placeOf, looksLikeId, lookOf, lookKey, COLORS, COLOR_KEY, STATE_LOOK, PAGE_FILES };
