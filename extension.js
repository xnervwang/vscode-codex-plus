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
const { SessionsProvider, COLORS, looksLikeId } = require('./src/sessions-view');
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
let log = null;
let reader = null;
/* The memento that remembers "Remove the Patch" (patching.PATCH_REMOVED_KEY) until "Patch Codex" is run again. */
let memento = null;

function cfg() { return vscode.workspace.getConfiguration(CONFIG); }

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
 * ran "Remove the Patch from Codex", which holds until they run "Patch Codex". 'off' stops the patch being applied or
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

/* What the plugin's hooks read: the few settings that change their behaviour, and the user's time zone. */
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
      compactTokenLimit: codexConfig.compactLimit(files.codexHome()),
    }, { marker: context.globalStorageUri && context.globalStorageUri.fsPath });
    const zone = context.globalState.get('codexPlus.clientTimeZone');
    if (zone) fs.writeFileSync(path.join(install.planDir(files.codexHome()), 'client-time-zone.json'), JSON.stringify({ timeZone: zone }) + '\n');
  } catch (e) { log.appendLine(`could not write the hooks' settings: ${e.message}`); }
}

async function activate(context) {
  selfPath = context.extensionPath || '';
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
  });
  context.subscriptions.push(memory);
  let lastConversations = new Map();
  const sessionsProvider = new SessionsProvider(vscode, { memory, memento: context.globalState, settings, reader,
    stateOf: (id) => lastConversations.get(id), wantState: (ids) => source.wantState(ids),
    sidebarShowing: () => patching.sidebarShowing() });
  context.subscriptions.push(vscode.window.registerTreeDataProvider('codexPlus.sessions', sessionsProvider));
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(sessionsProvider));
  const redrawSessions = async () => {
    try { lastConversations = new Map((await source.listConversations()).map((c) => [c.sessionId, c])); } catch (_) { /* the last one stays */ }
    sessionsProvider.refresh();
  };
  context.subscriptions.push(source.onDidChangeConversations(redrawSessions), memory.onDidChange(() => sessionsProvider.refresh()),
    patching.onSidebarChanged(() => sessionsProvider.refresh()));

  /* ── Agent Plus draws the rest ── */
  const link = await hostLink.link(vscode, source, { log: say, memento: context.globalState });
  if (link.registered) {
    say('the Codex source is registered with Agent Plus');
    context.subscriptions.push(link.registration);
  }
  redrawSessions();

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(CONFIG)) { writeHookSettings(context); sessionsProvider.refresh(); }
    /* The time stamps, the message list and the colours live in Codex's page, and this is how a change to one of them
       gets there: the same redraw the figures use, rather than a watcher of its own. The master switch is in the list
       because it decides all three, and a page has to be told when it goes either way. */
    if (e.affectsConfiguration(`${CONFIG}.enabled`) || e.affectsConfiguration(`${CONFIG}.timestamps`)
      || e.affectsConfiguration(`${CONFIG}.conversationNavigation`)
      || e.affectsConfiguration(`${CONFIG}.userMessageColor`) || e.affectsConfiguration(`${CONFIG}.userMessageEdge`)
      || e.affectsConfiguration(`${CONFIG}.lowContextOutline`) || e.affectsConfiguration(`${CONFIG}.chime`)) {
      const typed = String(cfg().get('userMessageColor', '') || '').trim();
      if (typed && !patching.safeColor(typed)) {
        vscode.window.showWarningMessage(`Codex Plus: "${typed}" is not a CSS colour (use for example #90EE90, `
          + 'lightgreen or rgb(144,238,144)); the colour of your own messages is left as Codex draws it.');
      }
      patching.refreshPanels().catch((err) => say(`redrawing the Codex pages: ${err.message}`));
    }
  }));
  /* A conversation's session information, as its rows: Session Information and the page's own info button both show it. */
  const sessionInfoRows = async (id) => [...await reader.request('info', { home: files.codexHome(), id }),
    { label: 'Account', value: codexConfig.accountLine(files.codexHome()) }];
  /* When the user's own messages were sent, for the stamps Codex's page draws on them: read in the worker thread, since
     the first read of a conversation goes through its whole rollout (src/user-times.js). */
  const userTimes = (id) => reader.request('userTimes', { home: files.codexHome(), id });
  /* How long Codex's pages took to open, from Codex's own log; read only when Show Status or its command asks. */
  const opens = openTimes.createOpenTimes(openTimes.whereLogs(context.logUri && context.logUri.fsPath));
  registerCommands(context, { source, memory, sessionsProvider, say, link, userTimes, opens, sessionInfoRows });

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
  later(async () => {
    const reopened = await memory.reopenDropped({ enabled: settings().reopenDroppedTabs });
    if (reopened.length) say(`reopened ${reopened.length} Codex tab(s) VS Code did not restore`);
  }, 8000);
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

function registerCommands(context, { source, memory, sessionsProvider, say, link, userTimes, opens, sessionInfoRows }) {
  const reg = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG}.${name}`, fn));
  const threadArg = (arg) => (typeof arg === 'string' ? arg : arg && arg.thread ? arg.thread.id : arg && arg.sessionId) || '';
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
   * The master switch: one act for all the additions at once, rather than six settings to find.
   *
   * It writes the one setting the others are read through (settings()), so the user's own choices among them survive
   * being turned off and come back as they were. What it does not do is take the patch out of Codex's files: with the
   * switch off the patch is left in place and nothing is drawn with it, and the file is put back only by
   * `Codex Plus: Remove the Patch from Codex`. The command titles say so, because a "Turn Off" that was thought to
   * restore Codex's own files would be found out only much later.
   */
  const setEnabled = async (on) => {
    await vscode.workspace.getConfiguration(CONFIG).update('enabled', on, vscode.ConfigurationTarget.Global);
    sessionsProvider.refresh();
    patching.refreshPanels().catch((e) => say(`redrawing the Codex pages: ${e.message}`));
    vscode.window.showInformationMessage(on
      ? 'Codex Plus: the additions are on again, each as you had it set.'
      : 'Codex Plus: the additions are off. The patch to Codex\'s files is still in place and unchanged; '
        + '"Remove the Patch from Codex" is what puts those back.');
  };
  reg('turnOn', () => setEnabled(true));
  reg('turnOff', () => setEnabled(false));
  reg('toggle', () => setEnabled(!settings().enabled));
  reg('applyPatch', async () => {
    if (restricted()) return;
    /* Patching while the switch is off would leave the patch in Codex with nothing drawing anything through it, so the
       command that asks for the patch turns the switch back on as part of doing it. */
    if (!settings().enabled) {
      await vscode.workspace.getConfiguration(CONFIG).update('enabled', true, vscode.ConfigurationTarget.Global);
      say('the additions were off; turned back on, since the patch is only of use to them');
    }
    await context.globalState.update(patching.PATCH_REMOVED_KEY, false);
    vscode.window.showInformationMessage('Codex will be patched now; reload the window when asked.');
    /* Only the patching itself: activation already wired the hooks and the listeners, and wiring them again would
       redraw every panel once more on each change for every time this command has run. */
    patching.ensurePatched(vscode, context, say, 'on').catch((e) => say(`patch: ${e.message}`));
  });
  reg('removePatch', async () => {
    if (restricted()) return;
    /* Remembered before the files are put back, and kept until "Patch Codex" is run: every start-up patches Codex
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
  reg('showRunningCommands', async () => {
    const running = patching.runningCommands();
    if (!running.length) { vscode.window.showInformationMessage('Codex Plus: no command Codex started is running in this window.'); return; }
    const zone = context.globalState.get('codexPlus.clientTimeZone') || undefined;
    const when = (ms) => { try { return new Date(ms).toLocaleTimeString('en-GB', { timeZone: zone }); } catch (_) { return new Date(ms).toISOString().slice(11, 19); } };
    const pick = await vscode.window.showQuickPick(running.map((c) => ({ label: c.command.slice(0, 120) || '(no command line)',
      description: c.cwd, detail: `since ${when(c.startedMs)} · ${(reader.thread(c.thread) || {}).title || c.thread}`, thread: c.thread })),
    { placeHolder: 'Commands Codex started that are still running; pick one to open its conversation' });
    if (pick && pick.thread) await tabs.openInTab(vscode, pick.thread);
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
  /* Uninstalling this extension removes the plugin only once no editor on the machine holds a copy (uninstall.js), so
     this is how one editor's user takes it out of a Codex home the others still share. */
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
    if (pick) await sessionsProvider.setColor(id, pick.label === 'none' ? '' : pick.label);
  });
  reg('findThread', async () => {
    /* The same conversations the list holds: this workspace's, as the Codex sessions view filters them. */
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const inWorkspace = folders.length ? folderTest(folders, new Map()) : null;
    const threads = (reader.threads() || []).filter((t) => (t.kind === 'user' || !settings().hideBackgroundSessions)
      && (!inWorkspace || inWorkspace(t.cwd)));
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
    /* A tab Codex opened with its New button names no conversation in its URI; the source knows it through the patch. */
    const front = (vscode.window.tabGroups.activeTabGroup || {}).activeTab;
    const id = threadArg(arg) || (front && source.sessionForTab(front)) || tabs.activeThread(vscode);
    if (!id) { vscode.window.showInformationMessage('Bring a Codex conversation tab to the front first; a new one counts once its first message is sent.'); return; }
    let rows = [];
    try { rows = await sessionInfoRows(id); } catch (e) { vscode.window.showErrorMessage(`Could not read it: ${e.message}`); return; }
    const pick = await vscode.window.showQuickPick(rows.map((r) => ({ label: r.label, description: r.value, value: r.value })),
      { placeHolder: 'Click a value to copy it' });
    if (pick && pick.value) { await vscode.env.clipboard.writeText(pick.value); vscode.window.setStatusBarMessage(`Copied ${pick.label}`, 3000); }
  });
}

/*
 * At start-up the plugin is installed without asking whenever Codex does not hold it as this extension carries it, as
 * Claude Code Plus registers its own (syncPlugin(false)): missing, another version, or other files under the same
 * version. Codex still asks the user to trust its hooks, which is trustPlugin's dialog. A plugin the user told Codex not
 * to load stays not loaded through such an install; the install command is what loads it again.
 */
async function ensurePlugin(context, say) {
  if (!trusted() || !cfg().get('workPlan', true)) return;
  /* The Python found now is part of it: a copy installed while there was none has no hooks, and one is fitted to the
     Python it was installed with. */
  const st = install.installState(files.codexHome(), undefined, await findPython(context));
  if (st.current) { await trustPlugin(say, { interactive: false }); return; }
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

async function installPlugin(context, say, { interactive }) {
  const binary = codexProgram();
  if (!binary) { if (interactive) vscode.window.showErrorMessage('The codex program of the Codex extension was not found.'); return; }
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

/* An uninstall is handed to the uninstall script here rather than left until VS Code deletes the folder
   (src/uninstall-plan.js finishUninstall). */
function deactivate() {
  files.closeAll();
  try { uninstallPlan.finishUninstall(selfPath, [ID, ...uninstallPlan.FORMER_IDS]); } catch (_) { /* VS Code runs the hook later */ }
}

/* `_settings` is for the checks: the master switch is only real if what every part reads comes out of settings() with
   it already applied, and that is a table to be read rather than inferred from what the extension then did.
   `_ensurePlugin` is the start-up install of the plugin, which activation only runs after a delay. */
module.exports = { activate, deactivate, _settings: settings, _ensurePlugin: ensurePlugin };
