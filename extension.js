// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Activation: reads the settings, points the Codex file readers at the right CODEX_HOME, builds the Codex source and
 * registers it with Agent Work Plan (xnervwang.agent-work-plan), which draws the work plan, Conversations and Answer
 * views. What stays here is what only Codex has: the Codex session list, the companion plugin, the patch to Codex and
 * the tab bar's open button. Each part lives in its own module under src/; this file wires them together and owns the
 * commands.
 *
 * In Restricted Mode nothing is written: the hook settings, the plugin, the patch and the plan cleanup wait until the
 * workspace is trusted.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const files = require('./src/codex-files');
const tabs = require('./src/codex-tabs');
const install = require('./src/plugin-install');
const { codexBinary } = require('./src/appserver');
const { createCodexSource } = require('./src/codex-source');
const { CodexReader } = require('./src/codex-reader');
const hostLink = require('./src/host-link');
const { readPlan, planQuestions } = require('./src/workplan');
const { TabMemory } = require('./src/tab-memory');
const { SessionsProvider, COLORS, looksLikeId } = require('./src/sessions-view');
const { folderTest } = require('./src/folders');
const patching = require('./src/patching');

const CONFIG = 'codexExtras';
let log = null;
let reader = null;

function cfg() { return vscode.workspace.getConfiguration(CONFIG); }
function settings() {
  const c = cfg();
  return {
    patchCodex: c.get('patchCodex', 'ask'),
    chime: c.get('chime', true),
    figures: c.get('turnFigures', true),
    workPlan: c.get('workPlan', true),
    hideBackgroundSessions: c.get('hideBackgroundSessions', true),
    sessionsInWorkspaceOnly: c.get('sessionsInWorkspaceOnly', true),
    recentClosedSessions: c.get('recentClosedSessions', 10),
    reopenDroppedTabs: c.get('reopenDroppedTabs', true),
    installPlugin: c.get('installWorkPlanPlugin', 'ask'),
  };
}
const trusted = () => vscode.workspace.isTrusted !== false;

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
  if (!trusted()) return;
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

async function activate(context) {
  log = vscode.window.createOutputChannel('Codex Extras');
  context.subscriptions.push(log);
  applyCodexHome();
  const say = (m) => log.appendLine(`${new Date().toISOString()} ${m}`);

  reader = new CodexReader({ log: say });
  context.subscriptions.push(reader);
  const source = createCodexSource(vscode, { log: say, reader, patching, trusted, enabled: () => cfg().get('workPlan', true) });
  context.subscriptions.push(source);
  /* The reader's time zone, as Codex's page reported it through the patch. */
  source.timeZone = () => context.globalState.get('codexExtras.clientTimeZone') || '';
  const reportTimeZone = async (zone) => {
    if (!zone || zone === context.globalState.get('codexExtras.clientTimeZone')) return;
    await context.globalState.update('codexExtras.clientTimeZone', zone);
    writeHookSettings(context);
  };

  /* ── The Codex session list, in Agent Work Plan's container ── */
  const memory = new TabMemory(vscode, context.workspaceState, {
    titleOf: (id) => (reader.thread(id) || {}).title || '',
    exists: (id) => reader.present(id),
    // Tabs Codex opened with its own New button do not name their conversation in their URI; the patch does.
    alsoOpen: () => patching.panelThreads(),
  });
  context.subscriptions.push(memory);
  let lastConversations = new Map();
  const sessionsProvider = new SessionsProvider(vscode, { memory, memento: context.globalState, settings, reader,
    stateOf: (id) => lastConversations.get(id) });
  context.subscriptions.push(vscode.window.registerTreeDataProvider('codexExtras.sessions', sessionsProvider));
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(sessionsProvider));
  const redrawSessions = async () => {
    try { lastConversations = new Map((await source.listConversations()).map((c) => [c.sessionId, c])); } catch (_) { /* the last one stays */ }
    sessionsProvider.refresh();
  };
  context.subscriptions.push(source.onDidChangeConversations(redrawSessions), memory.onDidChange(() => sessionsProvider.refresh()));

  /* ── Agent Work Plan draws the rest ── */
  const link = await hostLink.link(vscode, source, { log: say, memento: context.globalState });
  if (link.registered) {
    say('the Codex source is registered with Agent Work Plan');
    context.subscriptions.push(link.registration);
  }
  redrawSessions();

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${CONFIG}.codexHome`)) { applyCodexHome(); source._poll(); }
    if (e.affectsConfiguration(CONFIG)) { writeHookSettings(context); sessionsProvider.refresh(); }
  }));
  registerCommands(context, { source, memory, sessionsProvider, say, link });

  /* Everything that writes waits for a trusted workspace. */
  let wrote = false;
  const whenTrusted = () => {
    if (wrote || !trusted()) return;
    wrote = true;
    writeHookSettings(context);
    setTimeout(() => offerPlugin(context, say), 3000);
    setTimeout(() => {
      reader.request('sweep', { home: files.codexHome() }).then((r) => {
        if (r.deleted) say(`removed ${r.deleted} plan file(s) of conversations that no longer exist`);
        else if (r.why) say(`plan cleanup: ${r.why}`);
      }).catch((e) => say(`plan cleanup: ${e.message}`));
    }, 60000);
    try {
      patching.activate(context, { vscode, log: say, codexProgram, source, context, settings, onTimeZone: reportTimeZone,
        planQuestions: (id) => planQuestions((readPlan(id) || {}).nodes).length });
    } catch (e) { say(`patching: ${e.message}`); }
  };
  whenTrusted();
  if (!wrote && typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') {
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(whenTrusted));
  }
  setTimeout(async () => {
    const reopened = await memory.reopenDropped({ enabled: settings().reopenDroppedTabs });
    if (reopened.length) say(`reopened ${reopened.length} Codex tab(s) VS Code did not restore`);
  }, 8000);
}

/* The Codex conversation the tab bar's button opens: the one last in front, else the newest in this workspace. */
function lastConversation(memory) {
  const last = memory.lastUsed();
  if (last && (!reader.threads() || reader.present(last))) return last;
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const test = folderTest(folders, new Map());
  const inside = (cwd) => !folders.length || test(cwd);
  const t = (reader.threads() || []).find((x) => x.kind === 'user' && !x.archived && inside(x.cwd));
  return t ? t.id : '';
}

function registerCommands(context, { source, memory, sessionsProvider, say, link }) {
  const reg = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG}.${name}`, fn));
  const threadArg = (arg) => (typeof arg === 'string' ? arg : arg && arg.thread ? arg.thread.id : arg && arg.sessionId) || '';
  const restricted = () => {
    if (trusted()) return false;
    vscode.window.showInformationMessage('Codex Extras: in Restricted Mode nothing is installed or changed. Trust the workspace first.');
    return true;
  };

  reg('status', async () => {
    const home = files.codexHome();
    const threads = reader.threads() || [];
    const counts = {};
    for (const t of threads) counts[t.kind] = (counts[t.kind] || 0) + 1;
    const lines = [
      `CODEX_HOME: ${home}`,
      `State database: ${files.stateDbPath(home) || '(not found)'}`,
      `Threads: ${threads.length} (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`,
      `Work plan plugin: ${install.installedVersions(home).join(', ') || 'not installed'} (this extension ships ${install.pluginVersion()})`,
      `Plans: ${install.planDir(home)}`,
      `codex program: ${codexProgram() || '(not found)'}`,
      `Agent Work Plan: ${link.registered ? 'the Codex source is registered' : `not registered (${link.code}: ${link.reason})`}`,
      `Workspace trusted: ${trusted() ? 'yes' : 'no (Restricted Mode: nothing is written)'}`,
      ...patching.statusLines(),
    ];
    log.appendLine(lines.join('\n'));
    log.show(true);
  });
  reg('applyPatch', async () => {
    if (restricted()) return;
    await context.globalState.update(`codexExtras.patchAsked:${(vscode.extensions.getExtension('openai.chatgpt') || { packageJSON: {} }).packageJSON.version}`, undefined);
    await vscode.workspace.getConfiguration(CONFIG).update('patchCodex', 'on', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Codex will be patched now; reload the window when asked.');
    patching.activate(context, { vscode, log: say, codexProgram, source, context, settings: () => ({ ...settings(), patchCodex: 'on' }),
      planQuestions: (id) => planQuestions((readPlan(id) || {}).nodes).length });
  });
  reg('removePatch', async () => {
    if (restricted()) return;
    const lines = patching.removePatch(vscode);
    await vscode.workspace.getConfiguration(CONFIG).update('patchCodex', 'off', vscode.ConfigurationTarget.Global);
    say(lines.join('\n'));
    const reload = 'Reload Window';
    if (await vscode.window.showInformationMessage('Codex\'s own files are back. Reload the window to run them.', reload) === reload) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
  reg('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:xnervwang.codex-extras'));
  reg('installWorkPlanPlugin', () => (restricted() ? undefined : installPlugin(context, say, { interactive: true })));
  reg('trustWorkPlanHooks', () => (restricted() ? undefined : trustPlugin(say, { interactive: true })));
  reg('removeWorkPlanPlugin', async () => {
    if (restricted()) return;
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
  reg('showAllFolders', async () => {
    await vscode.workspace.getConfiguration(CONFIG).update('sessionsInWorkspaceOnly', false, vscode.ConfigurationTarget.Global);
    sessionsProvider.refresh();
  });
  reg('newInTab', () => vscode.commands.executeCommand('chatgpt.newCodexPanel'));
  reg('newInSidebar', async () => {
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    try { await vscode.commands.executeCommand('chatgpt.newChat'); } catch (_) { /* the shortcut is not enabled in every build */ }
  });
  /* The tab bar's button: the last Codex conversation in a tab, or a new one; or Codex's sidebar, as the setting says. */
  reg('openCodex', async () => {
    if (cfg().get('openButtonTarget', 'tab') === 'sidebar') { await vscode.commands.executeCommand('chatgpt.openSidebar'); return; }
    const id = lastConversation(memory);
    if (id) {
      try { if (await tabs.openInTab(vscode, id)) return; } catch (e) { say(`opening ${id}: ${e.message}`); }
    }
    await vscode.commands.executeCommand('chatgpt.newCodexPanel');
  });
  reg('openThreadInTab', async (arg) => {
    const id = threadArg(arg);
    if (!id) return;
    // A tab already showing it without naming it in its URI: raise that panel, or opening the URI leaves a second tab
    // on the same conversation.
    if (!tabs.codexTabs(vscode).some((t) => t.thread === id) && patching.revealPanel(id)) return;
    if (!(await tabs.openInTab(vscode, id))) vscode.window.showWarningMessage('Codex could not open that conversation in a tab.');
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
    const threads = (reader.threads() || []).filter((t) => t.kind === 'user' || !settings().hideBackgroundSessions);
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
    if (restricted()) return;
    const id = threadArg(arg);
    const t = reader.thread(id);
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
      source._poll();
    } catch (e) { vscode.window.showErrorMessage(`Codex could not delete it: ${e.message}`); }
  });
  reg('sessionInfo', async (arg) => {
    const id = threadArg(arg) || tabs.activeThread(vscode);
    if (!id) { vscode.window.showInformationMessage('Bring a Codex conversation tab to the front first.'); return; }
    let rows = [];
    try { rows = await reader.request('info', { home: files.codexHome(), id }); } catch (e) { vscode.window.showErrorMessage(`Could not read it: ${e.message}`); return; }
    const pick = await vscode.window.showQuickPick(rows.map((r) => ({ label: r.label, description: r.value, value: r.value })),
      { placeHolder: 'Click a value to copy it' });
    if (pick && pick.value) { await vscode.env.clipboard.writeText(pick.value); vscode.window.setStatusBarMessage(`Copied ${pick.label}`, 3000); }
  });
}

/* The plugin is offered once per Codex home; after that it is the user's commands that install or remove it. */
async function offerPlugin(context, say) {
  if (!trusted() || !cfg().get('workPlan', true)) return;
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
 * Hooks page writes. What is trusted is exactly what was listed: if the hooks needing review, or the Codex home, changed
 * while the dialog was open, nothing is written and the new list is shown instead.
 */
const TRUST_ROUNDS = 3;
async function trustPlugin(say, { interactive }) {
  if (!trusted()) return;
  const binary = codexProgram();
  if (!binary) return;
  for (let round = 0; round < TRUST_ROUNDS; round++) {
    const home = files.codexHome();
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const cwds = folders.length ? folders : [home];
    let st;
    try { st = await install.hookStatus({ binary, home, cwds }); } catch (e) { say(`listing hooks failed: ${e.message}`); return; }
    if (!st.review.length) { if (interactive) vscode.window.setStatusBarMessage('The work plan hooks are trusted.', 4000); return; }
    const go = 'Trust them';
    const detail = `Codex runs hooks outside its sandbox and only after you trust them. These ${st.review.length} come from the work plan plugin`
      + ` in ${home}:\n\n` + st.review.map((h) => `${h.eventName}: ${h.command}`).join('\n')
      + '\n\nYou can also trust them in Codex: Settings > Hooks.';
    const pick = await vscode.window.showWarningMessage('Trust the work plan hooks in Codex?', { modal: interactive || round > 0, detail }, go, 'Open Codex settings');
    if (pick === 'Open Codex settings') { try { await vscode.commands.executeCommand('chatgpt.openSidebar'); } catch (_) { /* gone */ } return; }
    if (pick !== go) return;
    if (files.codexHome() !== home) { say('the Codex home changed while the trust dialog was open; listing the hooks again'); continue; }
    try {
      const r = await install.trustHooks({ binary, home, cwds, shown: st.review.map((h) => ({ key: h.key, currentHash: h.currentHash })) });
      if (r.changed) { say('the hooks needing trust changed while the dialog was open; listing them again'); continue; }
      say(`trusted ${r.trusted} work plan hook(s) in ${home}`);
      return;
    } catch (e) { vscode.window.showErrorMessage(`Could not trust the hooks: ${e.message}`); return; }
  }
  vscode.window.showWarningMessage('The work plan hooks kept changing while you were asked, so none was trusted. Try again.');
}

function deactivate() { files.closeAll(); }

module.exports = { activate, deactivate, lastConversation };
