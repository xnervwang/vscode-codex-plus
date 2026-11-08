// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Activation: reads the settings, points the Codex file readers at the right CODEX_HOME, builds the Codex source, and
 * either hands it to claude-code-extras (which then draws the shared work plan and Conversations views) or draws them
 * here. Each part lives in its own module under src/; this file only wires them together and owns the commands.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const files = require('./src/codex-files');
const tabs = require('./src/codex-tabs');
const install = require('./src/plugin-install');
const { codexBinary } = require('./src/appserver');
const { createCodexSource } = require('./src/codex-source');
const hostLink = require('./src/host-link');
const { FocusTracker } = require('./src/focus');
const { WorkPlanProvider, ageSince } = require('./src/workplan-view');
const { language } = require('./src/conversations-text');
const { readPlan, countOpen, sweepOrphans } = require('./src/workplan');
const { TabMemory } = require('./src/tab-memory');
const { SessionsProvider, COLORS, looksLikeId } = require('./src/sessions-view');
const conversations = require('./src/conversations');
const { ConversationsProvider } = require('./src/conversations-view');
const { AnswerView } = require('./src/answer-view');
const answers = require('./src/answers');
const sessionInfo = require('./src/session-info');
const patching = require('./src/patching');
const requestLimit = require('./src/request-limit');

const CONFIG = 'codexExtras';
let log = null;

function cfg() { return vscode.workspace.getConfiguration(CONFIG); }
function settings() {
  const c = cfg();
  return {
    patchCodex: c.get('patchCodex', 'ask'),
    chime: c.get('chime', true),
    figures: c.get('turnFigures', true),
    workPlan: c.get('workPlan', true),
    conversations: c.get('conversations', true),
    hideBackgroundSessions: c.get('hideBackgroundSessions', true),
    sessionsInWorkspaceOnly: c.get('sessionsInWorkspaceOnly', true),
    recentClosedSessions: c.get('recentClosedSessions', 10),
    reopenDroppedTabs: c.get('reopenDroppedTabs', true),
    installPlugin: c.get('installWorkPlanPlugin', 'ask'),
  };
}

function applyCodexHome() {
  files.setCodexHome(String(cfg().get('codexHome') || '').trim());
}

/* The codex program Codex's own extension runs, which is the one the plugin has to be installed with. */
function codexProgram() {
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  const configured = vscode.workspace.getConfiguration('chatgpt').get('cliExecutable') || '';
  return codexBinary(ext && ext.extensionPath, configured);
}

/* What the plugin's hooks read: the few settings that change their behaviour, and the reader's time zone. */
function writeHookSettings(context) {
  const c = cfg();
  try {
    install.writeHookSettings(files.codexHome(), {
      enabled: c.get('workPlan', true),
      offerMinTurns: c.get('workPlanOfferMinTurns', 3),
      offerMinToolCalls: c.get('workPlanOfferMinToolCalls', 25),
      quietWhenReplyMatches: c.get('workPlanQuietWhenReplyMatches', ''),
      tellTimeZone: c.get('tellCodexYourTimeZone', true),
    });
    const zone = context.globalState.get('codexExtras.clientTimeZone');
    if (zone) fs.writeFileSync(path.join(install.planDir(files.codexHome()), 'client-time-zone.json'), JSON.stringify({ timeZone: zone }) + '\n');
  } catch (e) { log.appendLine(`could not write the hooks' settings: ${e.message}`); }
}

/* Parts that need disposing, and status lines for Show Status. */
const parts = [];

async function activate(context) {
  log = vscode.window.createOutputChannel('Codex Extras');
  context.subscriptions.push(log);
  applyCodexHome();
  const say = (m) => log.appendLine(`${new Date().toISOString()} ${m}`);

  const source = createCodexSource(vscode, { log: say });
  context.subscriptions.push(source);
  /* Typing into a conversation needs the patch to Codex; until it is connected these refuse, as the interface wants. */
  source.canDeliver = (id) => patching.canDeliver(id);
  source.deliverAnswer = (id, text) => patching.deliver(id, text);
  const timeZoneListeners = [];
  const reportTimeZone = async (zone) => {
    if (!zone || zone === context.globalState.get('codexExtras.clientTimeZone')) return;
    await context.globalState.update('codexExtras.clientTimeZone', zone);
    for (const fn of timeZoneListeners) fn(zone);
    writeHookSettings(context);
  };

  /* ── Codex session list: always drawn here; the shared views are not the only thing this extension adds. ── */
  const memory = new TabMemory(vscode, context.workspaceState, {
    titleOf: (id) => ((files.listThreads() || []).find((t) => t.id === id) || {}).title || '',
    exists: (id) => !!files.rolloutOf(id),
  });
  context.subscriptions.push(memory);
  let lastConversations = new Map();
  const sessionsProvider = new SessionsProvider(vscode, { memory, memento: context.globalState, settings,
    stateOf: (id) => lastConversations.get(id) });
  /* One provider, two views: this extension's container when it draws alone, the host's container when it has one. */
  context.subscriptions.push(vscode.window.registerTreeDataProvider('codexExtras.sessions', sessionsProvider));
  context.subscriptions.push(vscode.window.registerTreeDataProvider('codexExtras.sessionsHosted', sessionsProvider));
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(sessionsProvider));

  /* ── The shared views: handed to claude-code-extras when it is the host, drawn here otherwise. ── */
  let standalone = null;
  const startStandalone = () => {
    const ui = { disposables: [] };
    const focus = new FocusTracker(vscode, [source]);
    const planProvider = new WorkPlanProvider();
    const planView = vscode.window.createTreeView('codexExtras.workPlan', { treeDataProvider: planProvider });
    const convProvider = new ConversationsProvider(vscode, { context, logoOf: () => source.logo });
    const convView = vscode.window.createTreeView('codexExtras.conversations', { treeDataProvider: convProvider });
    const clock = (ms) => {
      const zone = context.globalState.get('codexExtras.clientTimeZone') || undefined;
      try { return new Date(ms).toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' }); } catch (_) { return new Date(ms).toLocaleTimeString(); }
    };
    const answerView = new AnswerView({
      send: async (q, text) => {
        answerView.setState(q.key, { kind: 'waiting' });
        const r = await answers.deliver(vscode, source, q, text, { canType: patching.canType() });
        if (r.kind === 'clipboard') say(`answer to ${q.sessionId} row ${q.row} copied to the clipboard`);
        answerView.setState(q.key, r);
      },
      open: (target) => source.reveal(target.sessionId),
      age: (ms) => ageSince(ms),
      clock,
      onTimeZone: reportTimeZone,
    });
    answerView.setLanguage(language(vscode.env.language));
    ui.disposables.push(vscode.window.registerWebviewViewProvider('codexExtras.answer', answerView, { webviewOptions: { retainContextWhenHidden: true } }));
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    status.command = 'codexExtras.showConversations';
    const zone = context.globalState.get('codexExtras.clientTimeZone');
    if (zone) planProvider.setTimeZone(zone);
    timeZoneListeners.push((z) => { if (planProvider.setTimeZone(z)) planProvider.refresh(); });

    const redrawPlan = () => {
      const cur = focus.current;
      planProvider.setFocus(cur && cur.sessionId);
      planProvider.refresh();
      const plan = planProvider.shown();
      const c = plan ? countOpen(plan.nodes) : null;
      const open = c ? c.discussing + c.todo : 0;
      planView.badge = open ? { value: open, tooltip: `${open} row${open === 1 ? '' : 's'} to agree or start` } : undefined;
      const conv = cur && lastConversations.get(cur.sessionId);
      planView.description = cur ? `${source.label}${conv ? ' · ' + conv.title : ''}` : '';
    };
    const redrawConversations = async () => {
      const list = await source.listConversations();
      lastConversations = new Map(list.map((c) => [c.sessionId, c]));
      const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      const shown = conversations.build(list, { folders, readPlan: (id) => readPlan(id), planFile: (id) => source.planPath(id), now: Date.now() });
      convProvider.set(shown, source);
      const toDecide = shown.reduce((n, c) => n + c.questions.length, 0);
      if (settings().conversations) {
        status.text = toDecide ? `$(question) ${toDecide} to decide` : `$(comment-discussion) Conversations ${shown.filter((c) => c.running).length}`;
        status.backgroundColor = toDecide ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        status.tooltip = 'Codex conversations in this workspace';
        status.show();
      } else status.hide();
      convView.badge = toDecide ? { value: toDecide, tooltip: `${toDecide} question${toDecide === 1 ? '' : 's'} to decide` } : undefined;
      sessionsProvider.refresh();
      redrawPlan();
    };
    ui.redrawConversations = redrawConversations;
    const planWatch = (() => {
      try {
        fs.mkdirSync(source.planDir(), { recursive: true });
        const w = fs.watch(source.planDir(), () => { redrawPlan(); redrawConversations(); });
        return { dispose: () => w.close() };
      } catch (_) { return { dispose() {} }; }
    })();
    ui.disposables.push(planView, convView, status, focus, planWatch,
      focus.onDidChange(redrawPlan),
      source.onDidChangeConversations(redrawConversations),
      vscode.workspace.onDidChangeWorkspaceFolders(redrawConversations),
      answers.receive(vscode, source, { storage: context.globalStorageUri.fsPath, log: say }),
      ...registerSharedCommands({ source, focus, planProvider, answerView, redrawConversations }));
    const tick = setInterval(() => { planProvider.refresh(); }, 60000);
    ui.disposables.push({ dispose: () => clearInterval(tick) });
    redrawConversations();
    ui.dispose = () => { for (const d of ui.disposables) { try { d.dispose(); } catch (_) { /* gone */ } } };
    return ui;
  };

  const link = await hostLink.link(vscode, source, {
    log: say,
    memento: context.globalState,
    onHosted: (registration) => {
      if (standalone) { standalone.dispose(); standalone = null; }
      context.subscriptions.push(registration);
    },
  });
  if (link.hosted) {
    say('claude-code-extras draws the work plan and Conversations views; the Codex source is registered with it');
    if (link.registration) context.subscriptions.push(link.registration);
  } else {
    standalone = startStandalone();
    if (link.watcher) context.subscriptions.push(link.watcher);
  }
  context.subscriptions.push({ dispose: () => { if (standalone) standalone.dispose(); } });

  /* Session list refreshes with the conversations; in hosted mode nothing else drives it. */
  context.subscriptions.push(source.onDidChangeConversations(async () => {
    if (standalone) return;
    lastConversations = new Map((await source.listConversations()).map((c) => [c.sessionId, c]));
    sessionsProvider.refresh();
  }), memory.onDidChange(() => sessionsProvider.refresh()));
  sessionsProvider.refresh();

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${CONFIG}.codexHome`)) applyCodexHome();
    if (e.affectsConfiguration(CONFIG)) { writeHookSettings(context); sessionsProvider.refresh(); if (standalone) standalone.redrawConversations(); }
  }));

  const limit = requestLimit.create(vscode, context, { cfg, log: say });
  context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG}.restoreWebviewRequestLimit`, () => limit.putBack()));
  setTimeout(() => limit.check().catch((e) => say(`webview request limit: ${e.message}`)), 8000);
  registerCommands(context, { source, memory, sessionsProvider, say });
  writeHookSettings(context);
  setTimeout(() => offerPlugin(context, say), 3000);
  setTimeout(async () => {
    const reopened = await memory.reopenDropped({ enabled: settings().reopenDroppedTabs });
    if (reopened.length) say(`reopened ${reopened.length} Codex tab(s) VS Code did not restore`);
  }, 8000);
  setTimeout(() => {
    try {
      const r = sweepOrphans();
      if (r.deleted) say(`removed ${r.deleted} plan file(s) of conversations that no longer exist`);
    } catch (e) { say(`plan cleanup: ${e.message}`); }
  }, 60000);
  try {
    patching.activate(context, { vscode, log: say, codexProgram, source, context, settings, onTimeZone: reportTimeZone,
      planQuestions: (id) => conversations.planQuestions((readPlan(id) || {}).nodes).length });
  } catch (e) { say(`patching: ${e.message}`); }
}

/* Commands that only make sense while this extension draws the shared views itself. */
function registerSharedCommands({ source, focus, planProvider, answerView, redrawConversations }) {
  const reg = (name, fn) => vscode.commands.registerCommand(`${CONFIG}.${name}`, fn);
  return [
    reg('refreshWorkPlan', () => { planProvider.signature = ''; planProvider.refresh(); redrawConversations(); }),
    reg('openWorkPlanFile', async () => {
      const cur = focus.current;
      const file = cur && source.planPath(cur.sessionId);
      if (!file || !fs.existsSync(file)) { vscode.window.showInformationMessage('This conversation has no work plan yet.'); return; }
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
    reg('showWorkPlanDetail', async (row) => {
      if (!row) return;
      const head = [[row.state, row.note].filter(Boolean).join(' · ')];
      if (row.question) head.push('Question: ' + row.question);
      if (row.times) head.push(row.times);
      if (row.path && row.path.length) head.push('in: ' + row.path.join(' › '));
      if (row.children) head.push(row.children + ' of its own to finish first');
      await vscode.window.showInformationMessage(row.title, { modal: true,
        detail: head.concat(['', row.detail || 'No description was written for this one.']).join('\n') });
    }),
    reg('showConversations', () => vscode.commands.executeCommand('codexExtras.conversations.focus')),
    reg('answerQuestion', async (q) => { if (!q) return; answerView.show(q); await vscode.commands.executeCommand('codexExtras.answer.focus'); }),
    reg('openConversation', async (target) => {
      if (!target || !target.sessionId) return;
      if (!(await source.reveal(target.sessionId))) vscode.window.showWarningMessage('Codex could not open that conversation in a tab.');
    }),
  ];
}

function registerCommands(context, { source, memory, sessionsProvider, say }) {
  const reg = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG}.${name}`, fn));
  const threadArg = (arg) => (typeof arg === 'string' ? arg : arg && arg.thread ? arg.thread.id : arg && arg.sessionId) || '';

  reg('status', async () => {
    const home = files.codexHome();
    const threads = files.listThreads(home) || [];
    const counts = {};
    for (const t of threads) counts[t.kind] = (counts[t.kind] || 0) + 1;
    const lines = [
      `CODEX_HOME: ${home}`,
      `State database: ${files.stateDbPath(home) || '(not found)'}`,
      `Threads: ${threads.length} (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`,
      `Work plan plugin: ${install.installedVersions(home).join(', ') || 'not installed'} (this extension ships ${install.pluginVersion()})`,
      `Plans: ${install.planDir(home)}`,
      `codex program: ${codexProgram() || '(not found)'}`,
      `Shared views drawn by: ${(await hostLink.findHost(vscode)) ? 'claude-code-extras' : 'this extension'}`,
      ...patching.statusLines(),
    ];
    log.appendLine(lines.join('\n'));
    log.show(true);
  });
  reg('applyPatch', async () => {
    await context.globalState.update(`codexExtras.patchAsked:${(vscode.extensions.getExtension('openai.chatgpt') || { packageJSON: {} }).packageJSON.version}`, undefined);
    await vscode.workspace.getConfiguration(CONFIG).update('patchCodex', 'on', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Codex will be patched now; reload the window when asked.');
    patching.activate(context, { vscode, log: say, codexProgram, source, context, settings: () => ({ ...settings(), patchCodex: 'on' }),
      planQuestions: (id) => conversations.planQuestions((readPlan(id) || {}).nodes).length });
  });
  reg('removePatch', async () => {
    const lines = patching.removePatch(vscode);
    await vscode.workspace.getConfiguration(CONFIG).update('patchCodex', 'off', vscode.ConfigurationTarget.Global);
    say(lines.join('\n'));
    const reload = 'Reload Window';
    if (await vscode.window.showInformationMessage('Codex\'s own files are back. Reload the window to run them.', reload) === reload) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
  reg('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:xnervwang.codex-extras`));
  reg('installWorkPlanPlugin', () => installPlugin(context, say, { interactive: true }));
  reg('trustWorkPlanHooks', () => trustPlugin(say, { interactive: true }));
  reg('removeWorkPlanPlugin', async () => {
    const binary = codexProgram();
    if (!binary) { vscode.window.showErrorMessage('The codex program of the Codex extension was not found.'); return; }
    const go = 'Remove';
    const pick = await vscode.window.showWarningMessage('Remove the work plan plugin from Codex?', { modal: true,
      detail: 'Codex stops loading its hooks, skill and tools. Plans are first copied to a folder under CODEX_HOME.' }, go);
    if (pick !== go) return;
    try {
      const kept = await install.uninstall({ binary, home: files.codexHome() });
      vscode.window.showInformationMessage(kept ? `Removed. The plans were copied to ${kept}.` : 'Removed.');
    } catch (e) { vscode.window.showErrorMessage(`Could not remove the plugin: ${e.message}`); }
  });
  reg('refreshSessions', () => { source._poll(); sessionsProvider.refresh(); });
  reg('newInTab', () => vscode.commands.executeCommand('chatgpt.newCodexPanel'));
  reg('newInSidebar', async () => {
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    try { await vscode.commands.executeCommand('chatgpt.newChat'); } catch (_) { /* the shortcut is not enabled in every build */ }
  });
  reg('openThreadInTab', async (arg) => {
    const id = threadArg(arg);
    if (id && !(await tabs.openInTab(vscode, id))) vscode.window.showWarningMessage('Codex could not open that conversation in a tab.');
  });
  reg('openThreadInSidebar', async (arg) => {
    const id = threadArg(arg);
    if (!id) return;
    if (!(await patching.openInSidebar(id))) {
      vscode.window.showInformationMessage('Opening a given conversation in the sidebar needs the patch to Codex, which is not in place. It was opened in a tab instead.');
      await tabs.openInTab(vscode, id);
    }
  });
  reg('copyThreadId', async (arg) => {
    const id = threadArg(arg);
    if (id) { await vscode.env.clipboard.writeText(id); vscode.window.setStatusBarMessage(`Copied ${id}`, 3000); }
  });
  reg('setTitleColor', async (arg) => {
    const id = threadArg(arg);
    if (!id) return;
    const pick = await vscode.window.showQuickPick([...Object.keys(COLORS), 'none'].map((label) => ({ label })), { placeHolder: 'Title colour' });
    if (pick) await sessionsProvider.setColor(id, pick.label === 'none' ? '' : pick.label);
  });
  reg('findThread', async () => {
    const threads = (files.listThreads() || []).filter((t) => t.kind === 'user' || !settings().hideBackgroundSessions);
    const qp = vscode.window.createQuickPick();
    qp.placeholder = 'Search titles, or four or more characters of a thread id';
    qp.matchOnDescription = true;
    const items = (q) => threads.filter((t) => !looksLikeId(q) || t.id.includes(q.toLowerCase()) || t.title.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 200).map((t) => ({ label: t.title || '(untitled)', description: t.id, detail: t.cwd, id: t.id, alwaysShow: looksLikeId(q) }));
    qp.items = items('');
    qp.onDidChangeValue((q) => { qp.items = items(q.trim()); });
    qp.onDidAccept(async () => { const it = qp.selectedItems[0]; qp.hide(); if (it) await tabs.openInTab(vscode, it.id); });
    qp.show();
  });
  reg('deleteArchivedThread', async (arg) => {
    const id = threadArg(arg);
    const t = (files.listThreads() || []).find((x) => x.id === id);
    if (!t || !t.archived) return;
    if (tabs.codexTabs(vscode).some((x) => x.thread === id)) { vscode.window.showWarningMessage('Close its tab first.'); return; }
    const go = 'Delete';
    const pick = await vscode.window.showWarningMessage(`Delete "${t.title || id}" permanently?`, { modal: true,
      detail: 'Codex deletes the conversation and its rollout. Its work plan is deleted too. This cannot be undone.' }, go);
    if (pick !== go) return;
    const binary = codexProgram();
    try {
      await require('./src/appserver').withAppServer(binary, files.codexHome(), (s) => s.request('thread/delete', { threadId: id }));
      for (const ext of ['.json', '.turn', '.nudged', '.settled', '.offered', '.watermark', '.tz']) {
        try { fs.unlinkSync(path.join(install.planDir(files.codexHome()), id + ext)); } catch (_) { /* none */ }
      }
      sessionsProvider.refresh();
    } catch (e) { vscode.window.showErrorMessage(`Codex could not delete it: ${e.message}`); }
  });
  reg('sessionInfo', async (arg) => {
    const id = threadArg(arg) || tabs.activeThread(vscode);
    if (!id) { vscode.window.showInformationMessage('Bring a Codex conversation tab to the front first.'); return; }
    const rows = sessionInfo.rows(id);
    const pick = await vscode.window.showQuickPick(rows.map((r) => ({ label: r.label, description: r.value, value: r.value })),
      { placeHolder: 'Click a value to copy it' });
    if (pick && pick.value) { await vscode.env.clipboard.writeText(pick.value); vscode.window.setStatusBarMessage(`Copied ${pick.label}`, 3000); }
  });
}

/* The plugin is offered once per Codex home; after that it is the user's commands that install or remove it. */
async function offerPlugin(context, say) {
  if (!cfg().get('workPlan', true)) return;
  const home = files.codexHome();
  const have = install.installedVersions(home);
  const want = install.pluginVersion();
  if (have.includes(want)) { await trustPlugin(say, { interactive: false }); return; }
  const mode = settings().installPlugin;
  if (mode === 'never') return;
  if (mode === 'ask') {
    const key = `codexExtras.offered:${home}:${want}`;
    if (context.globalState.get(key)) return;
    await context.globalState.update(key, true);
    const go = have.length ? 'Upgrade' : 'Install';
    const pick = await vscode.window.showInformationMessage(
      have.length ? `The Codex work plan plugin ${have.join(', ')} is older than ${want}.` : 'Install the work plan plugin into Codex?',
      { detail: `It adds a skill, hooks and a small MCP server to ${home}. Codex asks you to trust the hooks afterwards.` }, go, 'Not now');
    if (pick !== go) return;
  }
  await installPlugin(context, say, { interactive: mode === 'ask' });
}

async function installPlugin(context, say, { interactive }) {
  const binary = codexProgram();
  if (!binary) { if (interactive) vscode.window.showErrorMessage('The codex program of the Codex extension was not found.'); return; }
  try {
    const stage = path.join(context.globalStorageUri.fsPath, 'marketplace');
    const r = await install.install({ binary, home: files.codexHome(), stage });
    say(`installed work plan plugin ${r.version} into ${files.codexHome()}`);
    writeHookSettings(context);
    await trustPlugin(say, { interactive: true });
  } catch (e) {
    say(`installing the plugin failed: ${e.message}`);
    if (interactive) vscode.window.showErrorMessage(`Could not install the work plan plugin: ${e.message}`);
  }
}

/*
 * Codex runs the plugin's hooks only once they are trusted, and every new version of the plugin needs trusting again.
 * The user decides: this lists what needs review and, only on their yes, writes the same trust Codex's own Settings >
 * Hooks page writes. Declining leaves them for Codex's page.
 */
async function trustPlugin(say, { interactive }) {
  const binary = codexProgram();
  if (!binary) return;
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const cwds = folders.length ? folders : [files.codexHome()];
  let st;
  try { st = await install.hookStatus({ binary, home: files.codexHome(), cwds }); } catch (e) { say(`listing hooks failed: ${e.message}`); return; }
  if (!st.review.length) { if (interactive) vscode.window.setStatusBarMessage('The work plan hooks are trusted.', 4000); return; }
  const go = 'Trust them';
  const detail = `Codex runs hooks outside its sandbox and only after you trust them. These ${st.review.length} come from the work plan plugin:\n\n`
    + st.review.map((h) => `${h.eventName}: ${h.command}`).join('\n')
    + '\n\nYou can also trust them in Codex: Settings > Hooks.';
  const pick = await vscode.window.showWarningMessage('Trust the work plan hooks in Codex?', { modal: interactive, detail }, go, 'Open Codex settings');
  if (pick === 'Open Codex settings') { try { await vscode.commands.executeCommand('chatgpt.openSidebar'); } catch (_) { /* gone */ } return; }
  if (pick !== go) return;
  try {
    const n = await install.trustHooks({ binary, home: files.codexHome(), cwds });
    say(`trusted ${n} work plan hook(s) in ${files.codexHome()}`);
  } catch (e) { vscode.window.showErrorMessage(`Could not trust the hooks: ${e.message}`); }
}

function deactivate() { files.closeAll(); }

module.exports = { activate, deactivate };
