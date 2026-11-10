// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Activation: reads the settings, points the Codex file readers at the right CODEX_HOME, builds the Codex source and
 * registers it with Agent Plus (xnervwang.agent-plus), which draws the work plan, Conversations and Answer
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
const { createSeen } = require('./src/seen');
const { CodexReader } = require('./src/codex-reader');
const hostLink = require('./src/host-link');
const { TabMemory } = require('./src/tab-memory');
const { SessionsModel, SessionsView, COLORS, looksLikeId } = require('./src/sessions-view');
const { createGroups, createPlacer } = require('./src/session-groups');
const accountUsage = require('./src/account-usage');
const patching = require('./src/patching');
const supported = require('./src/supported');
const pythonRuntime = require('./src/python-runtime');
const { folderTest } = require('./src/folders');
const openTimes = require('./src/open-times');
const codexConfig = require('./src/codex-config');
const uninstallPlan = require('./src/uninstall-plan');

const CONFIG = 'codexPlus';
/* This copy's id and folder, kept for deactivate, which runs after the editor's API is gone. */
const ID = (() => { try { const p = require('./package.json'); return `${p.publisher}.${p.name}`; } catch (_) { return uninstallPlan.ID; } })();
let selfPath = '';
let loadedStamp = 0;
let log = null;
let reader = null;
/* The memento that remembers "Remove the Patch" (patching.PATCH_REMOVED_KEY) until Turn On or Toggle. */
let memento = null;

function cfg() { return vscode.workspace.getConfiguration(CONFIG); }

let toldStale = false;
function standsDown() {
  const s = uninstallPlan.standing(selfPath, [ID, ...uninstallPlan.FORMER_IDS], loadedStamp);
  if (s && !toldStale && log) {
    toldStale = true;
    const what = s === 'replaced' ? 'no longer the installed one' : 'being uninstalled';
    log.appendLine(`${new Date().toISOString()} this window runs a build of Codex Plus that is ${what}; `
      + 'it leaves the hooks\' settings, the plugin and the patch to the windows running the installed build');
  }
  return s;
}

async function offerReloadForStale() {
  const reload = 'Reload Window';
  const pick = await vscode.window.showInformationMessage('This window is running an earlier build of Codex Plus than the one now installed. '
    + 'Reload the window to run it.', reload);
  if (pick === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/*
 * The settings, with the master switch (codexPlus.enabled) already applied to the ones it covers.
 *
 * The switch is a setting of its own rather than a command that writes `false` over each of the settings below, so that
 * turning everything off and on again gives back the choices the user had made rather than every default. Everything
 * it covers is read through it here, which is why nothing else in the extension has to ask about it.
 *
 * What it does not cover: the work plan and the session list. Those are not of a piece with the rest - a work plan the
 * model is keeping is not an adornment to be switched off by the command that stops a chime - and the README says as
 * much.
 *
 * `patchCodex` is 'on' or 'off' and is not a setting: Codex is patched at start-up unless the switch is off or the user
 * ran "Remove the Patch from Codex", which holds until they run Turn On or Toggle. 'off' stops the patch being applied or
 * kept up to date; with the switch off it does not take an applied patch out of Codex's files, which only the remove
 * command does.
 */
function settings() {
  const c = cfg();
  const on = c.get('enabled', true);
  const removed = !!(memento && memento.get(patching.PATCH_REMOVED_KEY) === true);
  return {
    enabled: on,
    workPlan: c.get('workPlan', true),
    hideBackgroundSessions: c.get('hideBackgroundSessions', true),
    recentClosedSessions: c.get('recentClosedSessions', 10),
    reopenDroppedTabs: c.get('reopenDroppedTabs', true),
    patchCodex: on && !removed ? 'on' : 'off',
    chime: on && c.get('chime', true),
    figures: on && c.get('turnFigures', true),
    replyDuration: on && c.get('replyDuration', true),
    timestamps: on && c.get('timestamps', true),
    conversationNavigation: on && c.get('conversationNavigation', true),
    userMessageColor: on ? c.get('userMessageColor', '') : '',
    userMessageEdge: on && c.get('userMessageEdge', true),
    lowContextOutline: on && c.get('lowContextOutline', true),
    infoButton: on && c.get('infoButton', true),
    chimeButton: on && c.get('chimeButton', true),
    contextMeter: on && c.get('contextMeter', true),
  };
}

/* The compaction limit the user set in config.toml, read again only when that file has changed: the context meter asks
   for it on every redraw of the pages. */
let limitSeen = { key: '', value: 0 };
function compactLimitNow() {
  const file = path.join(files.codexHome(), 'config.toml');
  let key = 'none';
  try { const st = fs.statSync(file); key = `${st.mtimeMs}:${st.size}`; } catch (_) { key = 'none'; }
  if (key !== limitSeen.key) limitSeen = { key, value: key === 'none' ? 0 : codexConfig.compactLimit(files.codexHome()) };
  return limitSeen.value;
}
const trusted = () => vscode.workspace.isTrusted !== false;

/** The version of Codex's own extension, or '' when it is not installed. */
function codexVersion() {
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  return String(((ext && ext.packageJSON) || {}).version || '');
}

/* The codex program Codex's own extension runs, which is the one the plugin has to be installed with. */
function codexProgram() {
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  const configured = vscode.workspace.getConfiguration('chatgpt').get('cliExecutable') || '';
  return codexBinary(ext && ext.extensionPath, configured);
}

/*
 * A request to this window's app-server, on Codex's own connection (src/patching.js hostRequest). Before the patch has
 * handed that connection over, a short-lived app-server is started instead, unless `fallback` is false. Resolves to
 * { outcome, result, reason } and never rejects.
 */
async function askAppServer(method, params, { fallback = true } = {}) {
  const r = await patching.hostRequest(method, params);
  if (r.outcome !== 'unavailable' || !fallback) return r;
  const binary = codexProgram();
  if (!binary) return { outcome: 'failed', reason: 'the codex program of the Codex extension was not found' };
  try {
    const result = await require('./src/appserver').withAppServer(binary, files.codexHome(), (server) => server.request(method, params));
    return { outcome: 'done', result };
  } catch (e) { return { outcome: 'failed', reason: e.message }; }
}

/* What the plugin's hooks read: the few settings that change their behaviour, and the user's time zone. */
function writeHookSettings(context) {
  if (!trusted() || standsDown()) return;
  const c = cfg();
  try {
    install.writeHookSettings(files.codexHome(), {
      enabled: c.get('workPlan', true),
      offerMinTurns: c.get('workPlanOfferMinTurns', 3),
      offerMinToolCalls: c.get('workPlanOfferMinToolCalls', 25),
      quietWhenReplyMatches: c.get('workPlanQuietWhenReplyMatches', ''),
      tellTimeZone: c.get('tellCodexYourTimeZone', true),
      compactTokenLimit: codexConfig.compactLimit(files.codexHome()),
    }, { marker: context.globalStorageUri && context.globalStorageUri.fsPath });
    install.writeClientZone(files.codexHome(), context.globalState.get('codexPlus.clientTimeZone'));
  } catch (e) { log.appendLine(`could not write the hooks' settings: ${e.message}`); }
}

async function activate(context) {
  selfPath = context.extensionPath || '';
  loadedStamp = uninstallPlan.installStamp(selfPath);
  log = vscode.window.createOutputChannel('Codex Plus');
  context.subscriptions.push(log);
  memento = context.globalState;
  const say = (m) => log.appendLine(`${new Date().toISOString()} ${m}`);
  /* Said once, in the log only: an unrecorded Codex is a thing to know, not a thing to interrupt anyone about. */
  { const line = supported.noticeLine(codexVersion()); if (line) say(line); }

  reader = new CodexReader({ log: say });
  context.subscriptions.push(reader);
  const source = createCodexSource(vscode, { log: say, reader, patching, trusted, enabled: () => cfg().get('workPlan', true),
    seen: createSeen(context.globalState) });
  context.subscriptions.push(source);
  planSource = source;
  /* The user's time zone, as Codex's page reported it through the patch. */
  source.timeZone = () => context.globalState.get('codexPlus.clientTimeZone') || '';
  const reportTimeZone = async (zone) => {
    if (!zone || zone === context.globalState.get('codexPlus.clientTimeZone')) return;
    await context.globalState.update('codexPlus.clientTimeZone', zone);
    writeHookSettings(context);
  };

  /* ── The Codex session list, in Agent Plus's container ── */
  const memory = new TabMemory(vscode, context.workspaceState, {
    titleOf: (id) => (reader.thread(id) || {}).title || '',
    exists: (id) => reader.present(id),
    // Tabs Codex opened with its own New button do not name their conversation in their URI; the patch does.
    alsoOpen: () => patching.panelThreads(),
    nowShowing: (id) => patching.nowShowing(id),
  });
  context.subscriptions.push(memory, patching.onPanelClosed((thread, opened) => memory.panelClosed(thread, opened)));
  /* Ctrl/Cmd+Shift+T is this extension's only while the tab closed last was a Codex tab (codexPlus.reopenClosedSession). */
  let reopenKey = null;
  const keepReopenKey = () => {
    const on = memory.lastClosedWasCodex();
    if (on === reopenKey) return;
    reopenKey = on;
    Promise.resolve(vscode.commands.executeCommand('setContext', 'codexPlus.lastClosedWasCodex', on)).catch(() => {});
  };
  context.subscriptions.push(memory.onDidChange(keepReopenKey));
  keepReopenKey();
  let lastConversations = new Map();
  const groups = createGroups({ ask: askAppServer, sections: () => reader.sections(), memento: context.globalState });
  let sessionsModel = null;
  const account = accountUsage.createAccountUsage({ ask: askAppServer, onChange: () => { if (sessionsModel) sessionsModel.refresh(); } });
  context.subscriptions.push(patching.onAccountNotification((method, params) => account.heard(method, params)));
  /* The conversation in front: the active tab's when it is Codex's, else the one Codex's sidebar shows. */
  const frontNow = () => {
    const tab = (vscode.window.tabGroups.activeTabGroup || {}).activeTab;
    const id = tab ? source.sessionForTab(tab) : null;
    return typeof id === 'string' ? id : patching.sidebarShowing();
  };
  sessionsModel = new SessionsModel(vscode, { memory, memento: context.globalState, settings, reader,
    stateOf: (id) => lastConversations.get(id), wantState: (ids) => source.wantState(ids),
    sidebarShowing: () => patching.sidebarShowing(), sections: () => new Map(groups.list()),
    account: () => account.view(), front: frontNow, noGroups: () => groups.supported() === false });
  /* Whether this Codex can make groups is asked on Codex's own connection once the list is on screen, and never by
     starting an app-server for it; until it is known the group commands are offered. */
  let sessionsView = null;
  const probeGroups = () => {
    if (groups.supported() !== null || !sessionsView || !sessionsView.visible) return;
    groups.probe({ fallback: false }).then((yes) => {
      if (yes !== false) return;
      vscode.commands.executeCommand('setContext', 'codexPlus.noGroups', true);
      sessionsModel.refresh();
    }).catch(() => { /* asked again on the next redraw */ });
  };
  /* ACCOUNT & USAGE is asked for when the list comes into view (src/account-usage.js). */
  const showAccount = () => { if (sessionsView && sessionsView.visible) account.load().catch(() => { /* the section stays as it was */ }); };
  sessionsView = new SessionsView(vscode, { model: sessionsModel, extensionUri: context.extensionUri || vscode.Uri.file(context.extensionPath || __dirname),
    onVisible: () => { showAccount(); probeGroups(); } });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('codexPlus.sessions', sessionsView));
  /* Start New Session in This Group, waiting for its conversation to exist (src/session-groups.js createPlacer). */
  const placer = createPlacer({ threads: () => reader.threads(), shown: () => patching.panelThreads(), move: (ids, id) => groups.move(ids, id) });
  const place = () => {
    placer.check().then((r) => {
      if (!r) return;
      if (r.outcome === 'failed') vscode.window.showErrorMessage(`Codex could not move the new conversation into its group: ${r.reason}`);
      else source._poll();
    }).catch(() => { /* left where Codex put it */ });
  };
  const relist = () => { sessionsModel.refresh(); probeGroups(); place(); };
  const redrawSessions = async () => {
    try { lastConversations = new Map((await source.listConversations()).map((c) => [c.sessionId, c])); } catch (_) { /* the last one stays */ }
    relist();
  };
  /* The conversation in front changed: its row is drawn as the current one. */
  const follow = () => sessionsModel.refresh();
  context.subscriptions.push(source.onDidChangeConversations(redrawSessions), memory.onDidChange(relist), patching.onSidebarChanged(relist),
    source.onDidFocus(() => follow()));
  if (typeof vscode.window.tabGroups.onDidChangeTabs === 'function') context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => follow()));

  /* ── Agent Plus draws the rest ── */
  const link = await hostLink.link(vscode, source, { log: say, memento: context.globalState });
  if (link.registered) {
    say('the Codex source is registered with Agent Plus');
    context.subscriptions.push(link.registration);
  }
  redrawSessions();

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(CONFIG)) { writeHookSettings(context); sessionsModel.refresh(); }
    /* The time stamps, the message list and the colours live in Codex's page, and this is how a change to one of them
       gets there: the same redraw the figures use, rather than a watcher of its own. The master switch is in the list
       because it decides all three, and a page has to be told when it goes either way. */
    if (e.affectsConfiguration(`${CONFIG}.enabled`) || e.affectsConfiguration(`${CONFIG}.timestamps`)
      || e.affectsConfiguration(`${CONFIG}.conversationNavigation`)
      || e.affectsConfiguration(`${CONFIG}.userMessageColor`) || e.affectsConfiguration(`${CONFIG}.userMessageEdge`)
      || e.affectsConfiguration(`${CONFIG}.lowContextOutline`) || e.affectsConfiguration(`${CONFIG}.chime`)
      || e.affectsConfiguration(`${CONFIG}.replyDuration`)) {
      const typed = String(cfg().get('userMessageColor', '') || '').trim();
      if (typed && !patching.safeColor(typed)) {
        vscode.window.showWarningMessage(`Codex Plus: "${typed}" is not a CSS colour (use for example #90EE90, `
          + 'lightgreen or rgb(144,238,144)); the colour of your own messages is left as Codex draws it.');
      }
      patching.refreshPanels().catch((err) => say(`redrawing the Codex pages: ${err.message}`));
    }
  }));
  /* A conversation's session information, as its rows, for the information button in its page. */
  const sessionInfoRows = async (id) => [...await reader.request('info', { home: files.codexHome(), id }),
    { label: 'Account', value: codexConfig.accountLine(files.codexHome()) }];
  /* When the user's own messages were sent, for the stamps Codex's page draws on them: read in the worker thread, since
     the first read of a conversation goes through its whole rollout (src/user-times.js). */
  const userTimes = (id) => reader.request('userTimes', { home: files.codexHome(), id });
  /* How long Codex's pages took to open, from Codex's own log; read only when Show Status or its command asks. */
  const opens = openTimes.createOpenTimes(openTimes.whereLogs(context.logUri && context.logUri.fsPath));
  registerCommands(context, { source, memory, sessionsModel, sessionsView, say, link, opens, groups, placer });

  /* Delayed start-up work is cancelled with the extension, so a window that closes within the delay starts none of it. */
  const later = (fn, ms) => {
    const t = setTimeout(fn, ms);
    context.subscriptions.push({ dispose: () => clearTimeout(t) });
  };
  /* Everything that writes waits for a trusted workspace. */
  let wrote = false;
  const whenTrusted = () => {
    if (wrote || !trusted()) return;
    wrote = true;
    writeHookSettings(context);
    later(() => ensurePlugin(context, say), 3000);
    later(() => {
      reader.request('sweep', { home: files.codexHome() }).then((r) => {
        if (r.deleted) say(`removed ${r.deleted} plan file(s) of conversations that no longer exist`);
        else if (r.why) say(`plan cleanup: ${r.why}`);
      }).catch((e) => say(`plan cleanup: ${e.message}`));
    }, 60000);
    try {
      patching.activate(context, { vscode, log: say, codexProgram, source, context, settings, onTimeZone: reportTimeZone,
        userTimes, sessionInfo: (id) => sessionInfoRows(id), compactLimit: compactLimitNow,
        copy: async (value, label) => { await vscode.env.clipboard.writeText(value); vscode.window.setStatusBarMessage(`Copied ${label}`, 3000); },
        toggleChime: () => cfg().update('chime', !cfg().get('chime', true), vscode.ConfigurationTarget.Global) });
    } catch (e) { say(`patching: ${e.message}`); }
  };
  whenTrusted();
  if (!wrote && typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') {
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(whenTrusted));
  }
  later(() => reopenDropped(memory, say), 8000);
}

/* Reopen the Codex tabs VS Code did not restore, and show in the status bar for ten seconds how many there were. */
async function reopenDropped(memory, say) {
  const reopened = await memory.reopenDropped({ enabled: settings().reopenDroppedTabs });
  if (!reopened.length) return reopened;
  const n = reopened.length;
  say(`reopened ${n} Codex tab(s) VS Code did not restore`);
  vscode.window.setStatusBarMessage(`Reopened ${n} Codex tab${n === 1 ? '' : 's'} VS Code did not restore`, 10000);
  return reopened;
}

/*
 * A new Codex conversation in a tab, in a group already holding Codex tabs or else the main editor area
 * (src/codex-tabs.js codexGroup). Codex's own chatgpt.newCodexPanel asks for the group of the text file last focused,
 * which puts the conversation in a split the user was not looking at. Codex's command is the fallback, in case it stops
 * taking the route.
 */
async function newConversationInTab(say) {
  try {
    if (await tabs.openNewInTab(vscode)) return;
    say('Codex did not open a conversation for its new-panel route; asking Codex itself');
  } catch (e) {
    say(`opening a new conversation: ${e.message}`);
  }
  await vscode.commands.executeCommand('chatgpt.newCodexPanel');
}

function registerCommands(context, { source, memory, sessionsModel, sessionsView, say, link, opens, groups, placer }) {
  const reg = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG}.${name}`, fn));
  /* A conversation as a command is given it: its id, a row of the session list (data-vscode-context), or Agent Plus's. */
  const threadArg = (arg) => (typeof arg === 'string' ? arg : arg && typeof arg.threadId === 'string' ? arg.threadId
    : arg && arg.thread ? arg.thread.id : arg && arg.sessionId) || '';
  /* Whether a command came from the session list's own right-click menu. */
  const fromList = (arg) => !!(arg && arg.webview === 'codexPlus.sessions');
  const restricted = () => {
    if (trusted()) return false;
    vscode.window.showInformationMessage('Codex Plus: in Restricted Mode nothing is installed or changed. Trust the workspace first.');
    return true;
  };

  reg('status', async () => {
    const home = files.codexHome();
    const python = await findPython(context);
    const tried = pythonRuntime.pythons(context.globalStorageUri.fsPath);
    const installed = install.installedVersions(home);
    const copy = install.installState(home, undefined, python).why;
    const loadState = install.pluginLoadState(home);
    const threads = reader.threads() || [];
    const counts = {};
    for (const t of threads) counts[t.kind] = (counts[t.kind] || 0) + 1;
    const lines = [
      `CODEX_HOME: ${home}`,
      `Account: ${codexConfig.accountLine(home)} (the model provider in config.toml)`,
      `State database: ${files.stateDbPath(home) || '(not found)'}`,
      `Threads: ${threads.length} (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`,
      /* Installed and loaded are two states, not one: Codex can hold the plugin and be set not to load it, and then
         the work plan simply stays empty with nothing else to show why. */
      `Work plan plugin: ${install.installedVersions(home).join(', ') || 'not installed'}`
        + `${installed.length ? `, ${loadState === 'not loaded' ? 'INSTALLED BUT NOT LOADED (Codex is set to skip it)'
          : loadState === 'no entry' ? 'no entry in config.toml, so Codex does not know of it' : 'loaded'}` : ''}`
        + ` (this extension ships ${install.pluginVersion()}`
        + `${installed.length ? `; Codex's copy has ${({ current: 'the same files', 'other version': 'another version',
          'no digest': 'files of unknown age', 'files differ': 'DIFFERENT FILES, reinstall to update it',
          'python differs': 'files fitted to another Python than the one found now, reinstall to update it' })[copy] || copy}` : ''})`,
      `Additions: ${settings().enabled ? 'on' : 'OFF (codexPlus.enabled); the patch to Codex is left as it is'}`,
      `Python for the hooks: ${python ? `${python.version} as ${python.launcher.join(' ')} (${python.executable})`
        : `none found, tried ${tried.map((l) => l.join(' ')).join(', ')}`
          + (pythonRuntime.build() ? '; "Codex Plus: Download Python for the Work Plan Hooks" fetches one' : '')}`,
      `Plans: ${install.planDir(home)}`,
      `codex program: ${codexProgram() || '(not found)'}`,
      `Agent Plus: ${link.registered ? 'the Codex source is registered' : `not registered (${link.code}: ${link.reason})`}`,
      `Workspace trusted: ${trusted() ? 'yes' : 'no (Restricted Mode: nothing is written)'}`,
      ...patching.statusLines(),
      ...supported.statusLines(codexVersion()),
      ...openTimes.reportLines(await opens.read().catch(() => []), { zone: context.globalState.get('codexPlus.clientTimeZone') || '', last: 3 }),
      /* What Codex's own page makes of the conversation in front. A window with no patch, or none with a Codex tab in
         front, answers with the one line saying so rather than holding this command up. */
      ...patching.selfCheckLines(await patching.selfCheckPage()),
    ];
    log.appendLine(lines.join('\n'));
    log.show(true);
  });
  /*
   * The master switch for all the additions. Like Claude Code Plus's, it shows no message.
   *
   * It writes only codexPlus.enabled, which settings() applies on top of the other settings, so each of those keeps the
   * value the user chose and has it again when the switch comes back on. Turning it off leaves the patch in Codex's
   * files, unused; only `Codex Plus: Remove the Patch from Codex` restores those files. Turning it on after a Remove
   * applies the patch again.
   */
  const removed = () => context.globalState.get(patching.PATCH_REMOVED_KEY) === true;
  const setEnabled = async (on) => {
    const unremoving = on && removed();
    if (unremoving) {
      if (restricted()) return;
      await context.globalState.update(patching.PATCH_REMOVED_KEY, false);
    }
    if (settings().enabled !== on) await vscode.workspace.getConfiguration(CONFIG).update('enabled', on, vscode.ConfigurationTarget.Global);
    sessionsModel.refresh();
    patching.refreshPanels().catch((e) => say(`redrawing the Codex pages: ${e.message}`));
    /* Only the patch is applied again here. Activation already added the hooks and listeners; adding them on every
       Turn On would stack up copies, and each copy redraws every panel on each change. */
    const stale = unremoving && standsDown();
    if (stale === 'replaced') offerReloadForStale().catch(() => { /* dismissed */ });
    else if (unremoving && !stale) patching.ensurePatched(vscode, context, say, 'on').catch((e) => say(`patch: ${e.message}`));
  };
  reg('turnOn', () => setEnabled(true));
  reg('turnOff', () => setEnabled(false));
  reg('toggle', () => setEnabled(!(settings().enabled && !removed())));
  reg('removePatch', async () => {
    if (restricted()) return;
    /* Remembered before the files are put back, and kept until Turn On or Toggle: every start-up patches Codex
       otherwise. */
    await context.globalState.update(patching.PATCH_REMOVED_KEY, true);
    const lines = patching.removePatch(vscode);
    say(lines.join('\n'));
    const reload = 'Reload Window';
    if (await vscode.window.showInformationMessage('Codex\'s own files are back. Reload the window to run them.', reload) === reload) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
  reg('showOpenTimes', async () => {
    const spans = await opens.read().catch(() => []);
    log.appendLine(openTimes.reportLines(spans, { zone: context.globalState.get('codexPlus.clientTimeZone') || '', last: 20 }).join('\n'));
    log.show(true);
  });
  reg('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:xnervwang.codex-plus'));
  /* The command is also the way back after "Stop Loading": it tells Codex to load the plugin again, as Claude Code Plus's
     install command registers its plugin again. */
  reg('installWorkPlanPlugin', () => (restricted() ? undefined : installPlugin(context, say, { interactive: true })));
  reg('downloadPython', async () => {
    if (restricted()) return;
    if (await downloadPython(context, say)) await installPlugin(context, say, { interactive: true });
  });
  reg('trustWorkPlanHooks', () => (restricted() ? undefined : trustPlugin(say, { interactive: true })));
  /*
   * The step between keeping the plugin and removing it: Codex holds it, with its marketplace entry and the trust given
   * to its hooks, and is told not to load it. Removing it instead takes all three away, so getting back from that means
   * installing and trusting again. The install command undoes it; the install at start-up leaves it as it is.
   */
  reg('stopLoadingWorkPlanPlugin', async () => {
    if (restricted()) return;
    const binary = codexProgram();
    if (!binary) { vscode.window.showErrorMessage('The codex program of the Codex extension was not found.'); return; }
    try {
      await install.setPluginEnabled({ binary, home: files.codexHome(), enabled: false });
      say(`Codex is now set to skip the work plan plugin in ${files.codexHome()}`);
      vscode.window.showInformationMessage('Codex Plus: Codex will not load the work plan plugin. It stays installed, with its '
        + 'hooks still trusted; "Install the Work Plan Plugin into Codex" has it loaded again.');
    } catch (e) { vscode.window.showErrorMessage(`Could not change whether Codex loads the plugin: ${e.message}`); }
  });
  reg('newInTab', () => newConversationInTab(say));
  reg('newInSidebar', async () => {
    if (await tabs.openRouteInSidebar(vscode, '/')) return;
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    try { await vscode.commands.executeCommand('chatgpt.newChat'); } catch (_) { /* the shortcut is not enabled in every build */ }
  });
  /*
   * The tab bar's button: a new Codex conversation in a tab. Codex's own button beside it opens its sidebar. It never
   * raises a conversation that is already open: the session list is where an existing one is picked, and a button that
   * sometimes only moved the focus read as doing nothing.
   */
  reg('openCodex', () => newConversationInTab(say));
  reg('openThreadInTab', async (arg) => {
    const id = threadArg(arg);
    if (!id) return;
    // A tab already showing it without naming it in its URI: raise that panel, or opening the URI leaves a second tab
    // on the same conversation.
    if (!tabs.codexTabs(vscode).some((t) => t.thread === id) && patching.revealPanel(id)) return;
    if (!(await tabs.openInTab(vscode, id))) vscode.window.showWarningMessage('Codex could not open that conversation in a tab.');
  });
  reg('reopenClosedSession', async () => {
    const id = memory.reopenTarget();
    memory.reopened();
    if (!id) { await vscode.commands.executeCommand('workbench.action.reopenClosedEditor'); return; }
    if (!(await tabs.openInTab(vscode, id))) vscode.window.showWarningMessage('Codex could not open that conversation in a tab.');
  });
  reg('openThreadInSidebar', async (arg) => {
    const id = threadArg(arg);
    if (!id) return;
    if (await tabs.openRouteInSidebar(vscode, tabs.threadRoute(id)) || await patching.openInSidebar(id)) return;
    vscode.window.showInformationMessage('Codex did not take the link that opens a conversation in its sidebar, so it was opened in a tab instead.');
    await tabs.openInTab(vscode, id);
  });
  reg('setTitleColor', async (arg) => {
    const id = threadArg(arg);
    if (!id) return;
    const pick = await vscode.window.showQuickPick([...Object.keys(COLORS), 'none'].map((label) => ({ label })), { placeHolder: 'Title colour' });
    if (pick) await sessionsModel.setColor(id, pick.label === 'none' ? '' : pick.label);
  });
  reg('findThread', async () => {
    /* The same conversations the list holds: this workspace's, as the Codex sessions view filters them. */
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const inWorkspace = folders.length ? folderTest(folders, new Map()) : null;
    const threads = (reader.threads() || []).filter((t) => (t.kind === 'user' || !settings().hideBackgroundSessions)
      && !t.archived && (!inWorkspace || inWorkspace(t.cwd)));
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
  /* Which rows a list command acts on: all the selected rows if the right-clicked row is one of them, otherwise only
     the right-clicked row, as in a file explorer. */
  const chosen = (arg, selected) => {
    if (!threadArg(arg)) return [inFront()].filter(Boolean);
    if (!Array.isArray(selected) && fromList(arg)) selected = sessionsView.selection;
    const ids = Array.isArray(selected) && selected.length && selected.some((s) => threadArg(s) === threadArg(arg))
      ? selected.map(threadArg) : [threadArg(arg)];
    return [...new Set(ids.filter(Boolean))];
  };
  /* A conversation tab's own right-click menu names no conversation: it is the one in the tab in front. */
  const inFront = () => {
    const tab = (vscode.window.tabGroups.activeTabGroup || {}).activeTab;
    const id = tab ? source.sessionForTab(tab) : null;
    return typeof id === 'string' ? id : '';
  };
  /*
   * Change a conversation through this window's app-server, on Codex's own connection (src/patching.js hostRequest).
   * Before the patch has handed that connection over, a short-lived app-server is started instead. The list re-reads
   * Codex's files afterwards. Returns false if Codex refused, after showing the user why.
   */
  const changeThread = async (doing, method, params) => done(doing, await askAppServer(method, params));
  /* Shows why Codex refused, or has the list read Codex's files again. */
  const done = (doing, r) => {
    if (r && r.outcome === 'failed') { vscode.window.showErrorMessage(`Codex could not ${doing}: ${r.reason}`); return false; }
    source._poll();
    return true;
  };
  reg('renameThread', async (arg) => {
    if (restricted()) return;
    const id = threadArg(arg) || inFront();
    if (!id) return;
    /* In the list the title is edited where it is, as in Claude Code's list. */
    if (fromList(arg) && sessionsView.tell({ type: 'startRename', id })) return;
    const was = (reader.thread(id) || {}).title || '';
    const name = await vscode.window.showInputBox({ prompt: 'A new title for this Codex conversation', value: was, valueSelection: [0, was.length] });
    if (name === undefined || !name.trim() || name.trim() === was) return;
    await changeThread('rename it', 'thread/name/set', { threadId: id, name: name.trim() });
  });
  /*
   * The groups. A command run before this Codex is known to have them asks first; one without them is told so, and the
   * commands are then no longer offered.
   */
  const groupsHere = async () => {
    const yes = await groups.probe({ fallback: true });
    if (yes === false) {
      vscode.commands.executeCommand('setContext', 'codexPlus.noGroups', true);
      vscode.window.showInformationMessage('Codex Plus: this Codex has no groups (sections) to sort conversations into.');
    }
    return yes !== false;
  };
  const sectionArg = (arg) => {
    const key = arg && typeof arg.groupKey === 'string' ? arg.groupKey : arg && arg.group && typeof arg.group.key === 'string' ? arg.group.key
      : typeof arg === 'string' ? `section:${arg}` : '';
    return key.startsWith('section:') ? key.slice('section:'.length) : '';
  };
  const askName = (prompt, value) => vscode.window.showInputBox({ prompt, value, valueSelection: [0, value.length] })
    .then((name) => (name === undefined || !name.trim() ? '' : name.trim()));
  /* From the list, as in Claude Code's: the group is made as "New group" and its name is then edited where it is drawn. */
  const newGroup = async (ids, inList) => {
    if (restricted() || !await groupsHere()) return;
    const name = inList ? 'New group' : await askName('A name for the new group', 'New group');
    if (!name) return;
    const r = await groups.create(name);
    if (r.outcome !== 'done') { done('make the group', r); return; }
    done('move it', ids.length ? await groups.move(ids, r.id) : r);
    if (inList) sessionsView.tell({ type: 'startRenameGroup', key: `section:${r.id}` });
  };
  reg('newGroup', (arg) => newGroup([], fromList(arg)));
  reg('newGroupFromThreads', (arg, selected) => newGroup(chosen(arg, selected), fromList(arg)));
  reg('newThreadInGroup', async (arg) => {
    const id = sectionArg(arg);
    if (!id || restricted() || !await groupsHere()) return;
    placer.start(id);
    await newConversationInTab(say);
  });
  reg('renameGroup', async (arg) => {
    const id = sectionArg(arg);
    if (!id || restricted() || !await groupsHere()) return;
    if (fromList(arg) && sessionsView.tell({ type: 'startRenameGroup', key: `section:${id}` })) return;
    const was = reader.sections().get(id) || '';
    const name = await askName('A new name for this group', was);
    if (!name || name === was) return;
    done('rename the group', await groups.rename(id, name));
  });
  reg('deleteGroup', async (arg) => {
    const id = sectionArg(arg);
    if (!id || restricted() || !await groupsHere()) return;
    done('delete the group', await groups.remove(id));
  });
  /* Claude Code's Add to group: the groups that do not already hold every conversation chosen. */
  reg('moveThreadToSection', async (arg, selected) => {
    const ids = chosen(arg, selected);
    if (!ids.length || restricted() || !await groupsHere()) return;
    const items = groups.choices().filter(([sectionId]) => !ids.every((id) => (reader.thread(id) || {}).section === sectionId))
      .map(([sectionId, name]) => ({ label: name || 'Group', sectionId }));
    if (!items.length) { vscode.window.showInformationMessage('Codex Plus: there is no other group to add it to. New Group from Conversation makes one.'); return; }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Add to which group?' });
    if (pick) done('move it', await groups.move(ids, pick.sectionId));
  });
  reg('removeFromGroup', async (arg, selected) => {
    const ids = chosen(arg, selected).filter((id) => (reader.thread(id) || {}).section);
    if (!ids.length || restricted()) return;
    done('take it out of its group', await groups.move(ids, null));
  });
  reg('markThreadUnread', (arg, selected) => { for (const id of chosen(arg, selected)) source.markUnread(id); });
  /*
   * What the session list's page sends: a click on a row, its two new-conversation buttons and New group, a title or a
   * group's name edited where it is drawn, and rows dropped on a group. Each is done as the matching command does it.
   */
  sessionsView.receive = async (msg) => {
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (msg.kind === 'open' && id) await vscode.commands.executeCommand(msg.where === 'sidebar' ? 'codexPlus.openThreadInSidebar' : 'codexPlus.openThreadInTab', id);
    else if (msg.kind === 'newInTab') await vscode.commands.executeCommand('codexPlus.newInTab');
    else if (msg.kind === 'newInSidebar') await vscode.commands.executeCommand('codexPlus.newInSidebar');
    else if (msg.kind === 'newGroup') await newGroup([], true);
    else if (msg.kind === 'rename' && id && typeof msg.title === 'string') {
      const was = (reader.thread(id) || {}).title || '';
      const title = msg.title.replace(/\s+/g, ' ').trim();
      if (title && title !== was && !restricted()) await changeThread('rename it', 'thread/name/set', { threadId: id, name: title });
    } else if (msg.kind === 'renameGroup' && typeof msg.name === 'string') {
      const sec = sectionArg({ groupKey: msg.key });
      const name = msg.name.trim();
      if (sec && name && name !== (reader.sections().get(sec) || '') && !restricted()) done('rename the group', await groups.rename(sec, name));
    } else if (msg.kind === 'move' && Array.isArray(msg.ids) && typeof msg.key === 'string') {
      const sec = msg.key === 'ungrouped' ? null : sectionArg({ groupKey: msg.key });
      const ids = msg.ids.filter((x) => typeof x === 'string' && (reader.thread(x) || {}).section !== (sec || ''));
      if ((sec || msg.key === 'ungrouped') && ids.length && !restricted() && await groupsHere()) done('move it', await groups.move(ids, sec));
    }
  };
  reg('markThreadRead', (arg, selected) => { for (const id of chosen(arg, selected)) source.markRead(id); });

}

/*
 * At start-up the plugin is installed without asking whenever Codex does not hold it as this extension carries it, as
 * Claude Code Plus registers its own (syncPlugin(false)): missing, another version, or other files under the same
 * version. Codex still asks the user to trust its hooks, which is trustPlugin's dialog. A plugin the user told Codex not
 * to load stays not loaded through such an install; the install command is what loads it again.
 */
async function ensurePlugin(context, say) {
  if (!trusted() || standsDown()) return;
  if (!cfg().get('workPlan', true)) { for (const k of Object.keys(problems)) problem(k, null); return; }
  /* The Python found now is part of it: a copy installed while there was none has no hooks, and one is fitted to the
     Python it was installed with. */
  const python = await findPython(context);
  const st = install.installState(files.codexHome(), undefined, python);
  if (st.current) {
    problem('install', null);
    notePython(context, say, python);
    await trustPlugin(say, { interactive: false });
    return;
  }
  say(`work plan plugin in Codex: ${st.why} (${st.versions.join(', ') || 'none'}; this extension carries ${st.want})`);
  await installPlugin(context, say, { interactive: false });
}

/*
 * The Python that runs the plugin's hooks, looked for every time the plugin is staged rather than remembered: the
 * user may have installed one, or removed one, since the last install.
 */
function findPython(context) {
  return pythonRuntime.findPython(undefined, pythonRuntime.pythons(context.globalStorageUri.fsPath));
}

/* Eleven megabytes from python.org, and only ever from a command or a button the user pressed. */
async function downloadPython(context, say) {
  const storage = context.globalStorageUri.fsPath;
  if (!pythonRuntime.build()) {
    vscode.window.showInformationMessage('Codex Plus: python.org publishes an embeddable Python for Windows only. '
      + 'On this machine, install Python 3 and run "Codex Plus: Install the Work Plan Plugin into Codex".');
    return null;
  }
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Downloading Python ${pythonRuntime.VERSION} from python.org` },
    () => pythonRuntime.download(storage));
  say(`python download: ${r.said}`);
  if (!r.ok) { vscode.window.showErrorMessage(`Codex Plus: downloading Python failed. ${r.said}`); return null; }
  return r;
}

/*
 * The row above the work plan (Agent Plus's planNotice), modelled on Claude Code Plus's: the plugin could not be
 * installed, there is no Python for its hooks, or Codex has not been told to trust them. Each is set and cleared by
 * the check that finds it. When several apply, the first in that order is shown, since it has to be fixed first.
 */
let planSource = null;
const problems = { install: null, python: null, trust: null };
function problem(kind, notice) {
  problems[kind] = notice || null;
  if (planSource && typeof planSource._setNotice === 'function') planSource._setNotice(problems.install || problems.python || problems.trust);
}
const notInstalled = (step, said) => ({ title: 'The plugin that writes work plans is not installed', description: 'click to try again',
  detail: `${step} failed. ${said || 'It gave no reason.'} Until this succeeds nothing writes a work plan, so the plan stays empty.`,
  command: 'codexPlus.installWorkPlanPlugin', arguments: [] });
function noPython(context) {
  const canDownload = !!pythonRuntime.build();
  const tried = pythonRuntime.pythons(context.globalStorageUri.fsPath).map((l) => l.join(' ')).join(', ');
  return { title: 'Work plans need Python 3', description: canDownload ? 'click to download it' : 'click to try again',
    detail: `Finding Python 3 failed. No Python 3.7 or later was found (tried ${tried}). `
      + (canDownload ? 'Click to download it, or install Python and reload the window. ' : 'Install it from python.org, then click this to install the plugin again. ')
      + 'Until then the plugin is in Codex without its hooks, MCP server and skill, so nothing writes a work plan.',
    command: canDownload ? 'codexPlus.downloadPython' : 'codexPlus.installWorkPlanPlugin', arguments: [] };
}
const NOT_TRUSTED = { title: 'Codex does not run the work plan hooks yet', description: 'click to trust them',
  detail: 'Codex runs a plugin\'s hooks only after you trust them, and the work plan plugin\'s are not trusted. Until they are, the open '
    + 'rows of a plan are not put in front of the model each turn and nothing reminds it at the end of one.',
  command: 'codexPlus.trustWorkPlanHooks', arguments: [] };

/* With no Python the row says so. Where python.org has a build for this machine, the download is also offered once per
   version, as Claude Code Plus does; after "Not now" the row is the only way to get it. */
const PYTHON_OFFER_KEY = 'codexPlus.pythonOffer';
function notePython(context, say, python) {
  problem('python', python ? null : noPython(context));
  if (python || !pythonRuntime.build() || context.globalState.get(PYTHON_OFFER_KEY, '') === pythonRuntime.VERSION) return;
  context.globalState.update(PYTHON_OFFER_KEY, pythonRuntime.VERSION);
  Promise.resolve(vscode.window.showInformationMessage('Work plans need Python 3. Download it from python.org (11 MB)?', 'Download', 'Not now'))
    .then(async (pick) => { if (pick === 'Download' && await downloadPython(context, say)) await installPlugin(context, say, { interactive: false }); })
    .catch((e) => say(`offering Python: ${e.message}`));
}

async function installPlugin(context, say, { interactive }) {
  const stale = standsDown();
  if (stale) { if (interactive && stale === 'replaced') await offerReloadForStale(); return; }
  const binary = codexProgram();
  if (!binary) {
    problem('install', notInstalled('Finding the codex program of the Codex extension', 'It is looked for in that extension\'s bin folder, and at chatgpt.cliExecutable when that is set.'));
    if (interactive) vscode.window.showErrorMessage('The codex program of the Codex extension was not found.');
    return;
  }
  try {
    const stage = path.join(context.globalStorageUri.fsPath, 'marketplace');
    let python = await findPython(context);
    /*
     * With no Python the plugin still goes in, without its hooks, MCP server or skill (plugin-install fitHooks): the
     * work plan then stays empty rather than putting a failed hook in every turn. The download is offered here, in
     * the install command, so that activation never fetches anything.
     */
    if (!python && interactive && pythonRuntime.build()) {
      const go = 'Download Python';
      const pick = await vscode.window.showInformationMessage('Work plans need Python 3, and none was found.',
        { detail: `Download Python ${pythonRuntime.VERSION} from python.org (11 MB), saved in `
          + `${pythonRuntime.home(context.globalStorageUri.fsPath)}? Nothing is installed system-wide.` }, go, 'Not now');
      if (pick === go && await downloadPython(context, say)) python = await findPython(context);
    }
    say(python ? `work plan hooks will run with Python ${python.version} (${python.launcher.join(' ')})`
      : `no Python 3.7 or later was found (tried ${pythonRuntime.pythons(context.globalStorageUri.fsPath).map((l) => l.join(' ')).join(', ')});`
        + ' the plugin goes in without its hooks, MCP server and skill');
    const r = await install.install({ binary, home: files.codexHome(), stage, python, load: interactive ? true : 'keep' });
    say(`installed work plan plugin ${r.version} into ${files.codexHome()}${r.loaded === false ? '; Codex is still set not to load it' : ''}`);
    writeHookSettings(context);
    problem('install', null);
    notePython(context, say, python);
    await trustPlugin(say, { interactive: true });
  } catch (e) {
    problem('install', notInstalled('Installing it into Codex', e.message));
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
    if (!st.review.length) { problem('trust', null); if (interactive) vscode.window.setStatusBarMessage('The work plan hooks are trusted.', 4000); return; }
    const go = 'Trust them';
    const detail = `Codex runs hooks outside its sandbox and only after you trust them. These ${st.review.length} come from the work plan plugin`
      + ` in ${home}:\n\n` + st.review.map((h) => `${h.eventName}: ${h.command}`).join('\n')
      + '\n\nYou can also trust them in Codex: Settings > Hooks.';
    const pick = await vscode.window.showWarningMessage('Trust the work plan hooks in Codex?', { modal: interactive || round > 0, detail }, go, 'Open Codex settings');
    if (pick !== go) problem('trust', NOT_TRUSTED);
    if (pick === 'Open Codex settings') { try { await vscode.commands.executeCommand('chatgpt.openSidebar'); } catch (_) { /* gone */ } return; }
    if (pick !== go) return;
    if (files.codexHome() !== home) { say('the Codex home changed while the trust dialog was open; listing the hooks again'); continue; }
    try {
      const r = await install.trustHooks({ binary, home, cwds, shown: st.review.map((h) => ({ key: h.key, currentHash: h.currentHash })) });
      if (r.changed) { say('the hooks needing trust changed while the dialog was open; listing them again'); continue; }
      say(`trusted ${r.trusted} work plan hook(s) in ${home}`);
      problem('trust', null);
      return;
    } catch (e) { vscode.window.showErrorMessage(`Could not trust the hooks: ${e.message}`); return; }
  }
  vscode.window.showWarningMessage('The work plan hooks kept changing while you were asked, so none was trusted. Try again.');
}

/* An uninstall is handed to the uninstall script here rather than left until VS Code deletes the folder
   (src/uninstall-plan.js finishUninstall). */
function deactivate() {
  files.closeAll();
  try { uninstallPlan.finishUninstall(selfPath, [ID, ...uninstallPlan.FORMER_IDS]); } catch (_) { /* VS Code runs the hook later */ }
}

/* `_settings` is for the tests: the master switch only works if every part reads its settings from settings(), with the
   switch already applied, and the tests check that table directly.
   `_ensurePlugin` (the start-up install of the plugin) and `_reopenDropped` (reopening dropped tabs) run after a delay
   during activation, so the tests call them directly. */
module.exports = { activate, deactivate, _settings: settings, _ensurePlugin: ensurePlugin, _reopenDropped: reopenDropped };
