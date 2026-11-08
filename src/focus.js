// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which conversation is in front, for this extension's own views when no host draws them (the work plan host protocol
 * in claude-code-extras' docs/work-plan-host.md, "The active conversation").
 *
 * The active editor tab is offered to every source's sessionForTab; the first that claims it is in front. A source's
 * onDidFocus puts one of its conversations in front from somewhere that is not an editor tab. Whichever happened last
 * wins. When the active tab is nobody's - a file, a terminal, the settings - the conversation in front stays what it
 * was, so the plan beside the code does not vanish the moment the reader looks at the code.
 */
class FocusTracker {
  constructor(vscode, sources) {
    this.vscode = vscode;
    this.sources = sources;
    this.current = null;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
    this.subs = [
      vscode.window.tabGroups.onDidChangeTabs(() => this.fromActiveTab()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.fromActiveTab()),
      ...sources.filter((s) => s.onDidFocus).map((s) => s.onDidFocus((e) => e && this.set(s.id, e.sessionId))),
    ];
    this.fromActiveTab();
  }

  fromActiveTab() {
    const group = this.vscode.window.tabGroups.activeTabGroup;
    const tab = group && group.activeTab;
    if (!tab) return;
    for (const s of this.sources) {
      let id = null;
      try { id = s.sessionForTab(tab); } catch (_) { id = null; }
      if (id) { this.set(s.id, id); return; }
    }
  }

  set(sourceId, sessionId) {
    if (!sessionId) return;
    if (this.current && this.current.sourceId === sourceId && this.current.sessionId === sessionId) return;
    this.current = { sourceId, sessionId };
    this.emitter.fire(this.current);
  }

  source() { return this.current ? this.sources.find((s) => s.id === this.current.sourceId) || null : null; }

  dispose() { for (const d of this.subs) d.dispose(); this.emitter.dispose(); }
}

module.exports = { FocusTracker };
