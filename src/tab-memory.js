// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What this window remembers about its Codex conversation tabs: which are open, which were closed recently, and when
 * each was last in front.
 *
 * The open set is written to the workspace's memento on every change of tabs. A tab the user closes is taken out of it
 * at once and put at the head of the recently-closed list, which survives reloads. So when the window starts, a thread
 * in the open set that no tab shows is one VS Code dropped rather than one the user closed: VS Code saves a window's
 * tabs only now and then, and keeps a webview tab only if the extension that restores it was running at that moment,
 * so a tab opened since the last save can be missing after the window lost its remote connection. reopenDropped()
 * opens those again.
 *
 * A tab closed while the window could not reach the extension host is not recorded as closed, and comes back at the next
 * start; closing it again once connected is the remedy.
 */
const tabs = require('./codex-tabs');

const OPEN_KEY = 'codexExtras.openTabs';
const CLOSED_KEY = 'codexExtras.recentlyClosed';
/* The conversation last in front in this workspace, kept across reloads, for the tab bar's open button. */
const LAST_KEY = 'codexExtras.lastInFront';
const KEEP_CLOSED = 50;
/* More than this many to reopen at once is more likely a record gone wrong than tabs a person had open. */
const REOPEN_LIMIT = 20;

class TabMemory {
  constructor(vscode, memento, { titleOf = () => '', exists = () => true, alsoOpen = () => [] } = {}) {
    this.vscode = vscode;
    this.memento = memento;
    this.titleOf = titleOf;
    this.exists = exists;
    this.alsoOpen = alsoOpen;
    this.lastFront = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
    this.startedWith = (memento.get(OPEN_KEY) || []).slice();
    this.ready = false;
    this.subs = [vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabs(e))];
    this.noteFront();
  }

  /*
   * The conversations open here: the ones named by their tab's URI, and the ones only the patch can name, which it
   * learns from the thread start of the tab's own page. A tab Codex opened with its New button keeps the URI
   * /extension/panel/new whatever conversation goes into it, so without `alsoOpen` every such conversation is missing
   * from the open list and gets reopened in a second tab as though dropped.
   */
  openThreads() {
    const out = tabs.codexTabs(this.vscode).map((t) => t.thread);
    let extra = [];
    try { extra = this.alsoOpen() || []; } catch (_) { extra = []; }
    for (const t of extra) if (t && !out.includes(t)) out.push(t);
    return out;
  }

  noteFront() {
    const t = tabs.activeThread(this.vscode);
    if (!t) return;
    this.lastFront.set(t, Date.now());
    const kept = this.memento.get(LAST_KEY);
    if (!kept || kept.thread !== t) Promise.resolve(this.memento.update(LAST_KEY, { thread: t, at: Date.now() })).catch(() => {});
  }

  /** The conversation most recently in front here: in this window, else as recorded, else the one closed last. '' if none. */
  lastUsed() {
    let best = '', at = 0;
    for (const [t, ms] of this.lastFront) if (ms > at) { best = t; at = ms; }
    if (best) return best;
    const kept = this.memento.get(LAST_KEY);
    if (kept && typeof kept.thread === 'string' && kept.thread) return kept.thread;
    const closed = (this.memento.get(CLOSED_KEY) || [])[0];
    return closed && typeof closed.thread === 'string' ? closed.thread : '';
  }

  onTabs(e) {
    this.noteFront();
    const closed = [];
    for (const tab of e.closed || []) {
      const t = tabs.threadOfTab(this.vscode, tab);
      if (t) closed.push({ thread: t, title: this.titleOf(t) || tab.label || '', at: Date.now() });
    }
    const open = this.openThreads();
    // Until the start-up comparison has run, the record still holds what the last session had open, and overwriting it
    // with the half-restored set would lose the very tabs it is there to bring back.
    if (this.ready) this.memento.update(OPEN_KEY, open);
    if (closed.length) {
      const still = new Set(open);
      const gone = closed.filter((c) => !still.has(c.thread));
      const list = gone.concat((this.memento.get(CLOSED_KEY) || []).filter((c) => !gone.some((g) => g.thread === c.thread)));
      this.memento.update(CLOSED_KEY, list.slice(0, KEEP_CLOSED));
      if (!this.ready) this.startedWith = this.startedWith.filter((t) => !gone.some((g) => g.thread === t));
    }
    this.emitter.fire();
  }

  /** Recently closed conversations not open now, newest first, at most `limit`. */
  recentlyClosed(limit = 10) {
    const open = new Set(this.openThreads());
    return (this.memento.get(CLOSED_KEY) || []).filter((c) => c && !open.has(c.thread)).slice(0, Math.max(0, limit));
  }

  /** When a thread was last in front in this window, or 0. */
  frontAt(thread) { return this.lastFront.get(thread) || 0; }

  /** The threads the last session had open that no tab shows now: to be reopened. */
  dropped() {
    const open = new Set(this.openThreads());
    return this.startedWith.filter((t) => !open.has(t) && this.exists(t)).slice(0, REOPEN_LIMIT);
  }

  /*
   * Reopen what VS Code dropped, in the background, and from then on keep the record current. Called once the window has
   * had time to restore its own tabs.
   */
  async reopenDropped({ enabled = true } = {}) {
    const missing = enabled ? this.dropped() : [];
    for (const t of missing) {
      try { await tabs.openInTab(this.vscode, t, { preserveFocus: true }); } catch (_) { /* Codex not ready: left for next start */ }
    }
    this.ready = true;
    await this.memento.update(OPEN_KEY, this.openThreads());
    return missing;
  }

  dispose() { for (const d of this.subs) d.dispose(); this.emitter.dispose(); }
}

module.exports = { TabMemory, OPEN_KEY, CLOSED_KEY, LAST_KEY, REOPEN_LIMIT };
