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
 *
 * A tab's URI names the conversation it was opened on, and nothing for a tab opened with a New button; a page that
 * starts another conversation leaves the URI as it was. What the tab showed when it closed comes from the patch, which
 * reports the conversation of each panel it disposes (panelClosed). VS Code reports the closed tab and disposes its panel
 * in either order, so each side keeps what the other may still need. A panel disposed with no Codex tab closed within
 * CLOSE_PAIR_MS, as when the window shuts down, is not a tab the user closed.
 */
const tabs = require('./codex-tabs');

const OPEN_KEY = 'codexPlus.openTabs';
const CLOSED_KEY = 'codexPlus.recentlyClosed';
/* The conversation last in front in this workspace, kept across reloads, for the tab bar's open button. */
const LAST_KEY = 'codexPlus.lastInFront';
const KEEP_CLOSED = 50;
/* More than this many to reopen at once is more likely a record gone wrong than tabs a person had open. */
const REOPEN_LIMIT = 20;
const CLOSE_PAIR_MS = 2000;

class TabMemory {
  constructor(vscode, memento, { titleOf = () => '', exists = () => true, alsoOpen = () => [], nowShowing = (t) => t } = {}) {
    this.vscode = vscode;
    this.memento = memento;
    this.titleOf = titleOf;
    this.exists = exists;
    this.alsoOpen = alsoOpen;
    this.nowShowing = nowShowing;
    this.lastFront = new Map();
    /* The panels disposed with no Codex tab closed yet: { thread, at }. */
    this.disposed = [];
    /* The URI's conversation -> the one its panel showed when disposed, for the tab event that comes after: { thread, at }. */
    this.replaced = new Map();
    this.codexClosedAt = 0;
    /* Every tab closed in this window, newest last: { codex, thread }, for which tab Ctrl/Cmd+Shift+T reopens. */
    this.closeOrder = [];
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
    const now = Date.now();
    for (const tab of e.closed || []) {
      if (!tabs.isCodexTab(this.vscode, tab)) { this.closeOrder.push({ codex: false, thread: '' }); continue; }
      this.codexClosedAt = now;
      const named = tabs.threadOfTab(this.vscode, tab);
      const swap = named && this.replaced.get(named);
      if (swap) this.replaced.delete(named);
      let t = swap && now - swap.at <= CLOSE_PAIR_MS ? swap.thread : '';
      if (!t && named) { try { t = this.nowShowing(named) || named; } catch (_) { t = named; } }
      if (t) closed.push({ thread: t, title: this.titleOf(t) || tab.label || '', at: now });
      this.closeOrder.push({ codex: true, thread: t });
    }
    if (this.codexClosedAt === now) {
      for (const d of this.disposed.splice(0)) {
        if (now - d.at <= CLOSE_PAIR_MS && !closed.some((c) => c.thread === d.thread)) {
          closed.push({ thread: d.thread, title: this.titleOf(d.thread), at: now });
          this.nameLastClosed(d.thread);
        }
      }
    }
    this.closeOrder = this.closeOrder.slice(-KEEP_CLOSED);
    this.record(closed);
  }

  /* A Codex tab closed last whose URI named nothing gets the conversation its panel showed. */
  nameLastClosed(thread) {
    const top = this.closeOrder[this.closeOrder.length - 1];
    if (top && top.codex && !top.thread) top.thread = thread;
  }

  /** Whether the tab closed last in this window was a Codex tab, which is when Ctrl/Cmd+Shift+T is this extension's. */
  lastClosedWasCodex() {
    const top = this.closeOrder[this.closeOrder.length - 1];
    return !!(top && top.codex);
  }

  /** The conversation Ctrl/Cmd+Shift+T reopens: the one closed last, or '' if none is known. */
  reopenTarget() {
    const top = this.closeOrder[this.closeOrder.length - 1];
    if (top && top.codex && top.thread) return top.thread;
    const last = this.recentlyClosed(1)[0];
    return last ? last.thread : '';
  }

  /* The tab closed last was opened again: the key goes to whatever was closed before it. */
  reopened() {
    const top = this.closeOrder[this.closeOrder.length - 1];
    if (top && top.codex) this.closeOrder.pop();
    this.emitter.fire();
  }

  /*
   * The patch disposed a panel that showed `thread`, opened on `opened`. Recorded at once when a Codex tab closed just
   * before; otherwise kept for the tab event that should follow.
   */
  panelClosed(thread, opened) {
    if (!thread) return;
    const now = Date.now();
    if (opened && opened !== thread) {
      this.replaced.set(opened, { thread, at: now });
      while (this.replaced.size > KEEP_CLOSED) this.replaced.delete(this.replaced.keys().next().value);
    }
    if (now - this.codexClosedAt <= CLOSE_PAIR_MS) { this.nameLastClosed(thread); this.record([{ thread, title: this.titleOf(thread), at: now }]); return; }
    this.disposed = this.disposed.filter((d) => now - d.at <= CLOSE_PAIR_MS && d.thread !== thread).concat({ thread, at: now });
  }

  record(closed) {
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
