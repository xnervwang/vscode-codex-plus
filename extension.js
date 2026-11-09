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
const { createSeen } = require('./src/seen');
const { CodexReader } = require('./src/codex-reader');
const hostLink = require('./src/host-link');
const { readPlan, planQuestions } = require('./src/workplan');
const { TabMemory } = require('./src/tab-memory');
const { SessionsProvider, COLORS, looksLikeId } = require('./src/sessions-view');
const patching = require('./src/patching');
const domSample = require('./src/dom-sample');
const supported = require('./src/supported');
const pythonRuntime = require('./src/python-runtime');
const openTimes = require('./src/open-times');
const codexConfig = require('./src/codex-config');

const CONFIG = 'codexExtras';
let log = null;
let reader = null;

function cfg() { return vscode.workspace.getConfiguration(CONFIG); }

/*
 * The settings, with the master switch (codexExtras.enabled) already applied to the ones it covers.
 *
 * The switch is a setting of its own rather than a command that writes `false` over each of the settings below, so that
 * turning everything off and on again gives back the choices the user had made rather than every default. Everything
 * it covers is read through it here, which is why nothing else in the extension has to ask about it.
 *
 * What it does not cover: the work plan, the session list, and where a new conversation opens. Those are not of a piece
 * with the rest - a work plan the model is keeping is not an adornment to be switched off by the command that stops a
 * chime - and the README says as much.
 *
 * `patchCodex` reading 'off' stops the patch being applied or kept up to date. It does not take an applied patch out of
 * Codex's files: that is `Codex Extras: Remove the Patch from Codex`, and the two are different acts.
 */
function settings() {
  const c = cfg();
  const on = c.get('enabled', true);
  return {
    enabled: on,
    workPlan: c.get('workPlan', true),
    hideBackgroundSessions: c.get('hideBackgroundSessions', true),
    sessionsInWorkspaceOnly: c.get('sessionsInWorkspaceOnly', true),
    recentClosedSessions: c.get('recentClosedSessions', 10),
    reopenDroppedTabs: c.get('reopenDroppedTabs', true),
    installPlugin: c.get('installWorkPlanPlugin', 'ask'),
    patchCodex: on ? c.get('patchCodex', 'ask') : 'off',
    chime: on && c.get('chime', true),
    figures: on && c.get('turnFigures', true),
    timestamps: on && c.get('timestamps', true),
    conversationNavigation: on && c.get('conversationNavigation', true),
    userMessageColor: on ? c.get('userMessageColor', '') : '',
    userMessageEdge: on && c.get('userMessageEdge', true),
    lowContextOutline: on && c.get('lowContextOutline', true),
    waitingInStatusBar: on && c.get('waitingInStatusBar', true),
  };
}
const trusted = () => vscode.workspace.isTrusted !== false;

function applyCodexHome() {
  files.setCodexHome(String(cfg().get('codexHome') || '').trim());
}

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
  /* Said once, in the log only: an unrecorded Codex is a thing to know, not a thing to interrupt anyone about. */
  { const line = supported.noticeLine(codexVersion()); if (line) say(line); }

  reader = new CodexReader({ log: say });
  context.subscriptions.push(reader);
  const source = createCodexSource(vscode, { log: say, reader, patching, trusted, enabled: () => cfg().get('workPlan', true),
    seen: createSeen(context.globalState) });
  context.subscriptions.push(source);
  /* The user's time zone, as Codex's page reported it through the patch. */
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
    stateOf: (id) => lastConversations.get(id), wantState: (ids) => source.wantState(ids) });
  context.subscriptions.push(vscode.window.registerTreeDataProvider('codexExtras.sessions', sessionsProvider));
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(sessionsProvider));
  const redrawSessions = async () => {
    try { lastConversations = new Map((await source.listConversations()).map((c) => [c.sessionId, c])); } catch (_) { /* the last one stays */ }
    sessionsProvider.refresh();
  };
  context.subscriptions.push(source.onDidChangeConversations(redrawSessions), memory.onDidChange(() => sessionsProvider.refresh()));

  /*
   * How many conversations are stopped waiting for an answer, in the status bar: shown only while there is one, since
   * the point of it is the moment the user is away from the Codex tab. Only this window's conversations are counted -
   * its Codex app-server is its own (README, "What it cannot see").
   */
  const waitingItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  waitingItem.command = `${CONFIG}.goToWaiting`;
  context.subscriptions.push(waitingItem);
  const drawWaiting = () => {
    let n = 0, threads = [];
    try { n = patching.decideCount(); threads = patching.waitingThreads(); } catch (_) { n = 0; }
    if (!n || !settings().waitingInStatusBar) { waitingItem.hide(); return; }
    waitingItem.text = `$(bell-dot) ${n} to decide`;
    const named = threads.filter((t) => patching.approvalsOf(t).decide)
      .map((t) => `- ${(reader.thread(t) || {}).title || t}`);
    waitingItem.tooltip = `Codex is waiting for you in:\n${named.join('\n')}`;
    waitingItem.show();
  };
  context.subscriptions.push(patching.onApprovalsChanged(drawWaiting), source.onDidChangeConversations(drawWaiting));
  drawWaiting();

  /* ── Agent Work Plan draws the rest ── */
  const link = await hostLink.link(vscode, source, { log: say, memento: context.globalState });
  if (link.registered) {
    say('the Codex source is registered with Agent Work Plan');
    context.subscriptions.push(link.registration);
  }
  redrawSessions();

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${CONFIG}.codexHome`)) { applyCodexHome(); source._poll(); }
    if (e.affectsConfiguration(CONFIG)) { writeHookSettings(context); sessionsProvider.refresh(); drawWaiting(); }
    /* The time stamps, the message list and the colours live in Codex's page, and this is how a change to one of them
       gets there: the same redraw the figures use, rather than a watcher of its own. The master switch is in the list
       because it decides all three, and a page has to be told when it goes either way. */
    if (e.affectsConfiguration(`${CONFIG}.enabled`) || e.affectsConfiguration(`${CONFIG}.timestamps`)
      || e.affectsConfiguration(`${CONFIG}.conversationNavigation`)
      || e.affectsConfiguration(`${CONFIG}.userMessageColor`) || e.affectsConfiguration(`${CONFIG}.userMessageEdge`)
      || e.affectsConfiguration(`${CONFIG}.lowContextOutline`)) {
      const typed = String(cfg().get('userMessageColor', '') || '').trim();
      if (typed && !patching.safeColor(typed)) {
        vscode.window.showWarningMessage(`Codex Extras: "${typed}" is not a CSS colour (use for example #90EE90, `
          + 'lightgreen or rgb(144,238,144)); the colour of your own messages is left as Codex draws it.');
      }
      patching.refreshPanels().catch((err) => say(`redrawing the Codex pages: ${err.message}`));
    }
  }));
  /* When the user's own messages were sent, for the stamps Codex's page draws on them: read in the worker thread, since
     the first read of a conversation goes through its whole rollout (src/user-times.js). */
  const userTimes = (id) => reader.request('userTimes', { home: files.codexHome(), id });
  /* How long Codex's pages took to open, from Codex's own log; read only when Show Status or its command asks. */
  const opens = openTimes.createOpenTimes(openTimes.whereLogs(context.logUri && context.logUri.fsPath));
  registerCommands(context, { source, memory, sessionsProvider, say, link, userTimes, opens });

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
        userTimes, planQuestions: (id) => planQuestions((readPlan(id) || {}).nodes).length });
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

/*
 * A new Codex conversation in a tab. Codex's own chatgpt.newCodexPanel asks for the group of the text file last
 * focused, which puts the conversation in a split when that file is not where the user is looking; opening its route
 * here names the group instead: the first group, or the group in front when the setting says so. Codex's command is
 * the fallback, in case it stops taking the route.
 */
async function newConversationInTab(say) {
  try {
    if (await tabs.openNewInTab(vscode, { group: cfg().get('newConversationGroup', 'main') })) return;
    say('Codex did not open a conversation for its new-panel route; asking Codex itself');
  } catch (e) {
    say(`opening a new conversation: ${e.message}`);
  }
  await vscode.commands.executeCommand('chatgpt.newCodexPanel');
}

function registerCommands(context, { source, memory, sessionsProvider, say, link, userTimes, opens }) {
  const reg = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG}.${name}`, fn));
  const threadArg = (arg) => (typeof arg === 'string' ? arg : arg && arg.thread ? arg.thread.id : arg && arg.sessionId) || '';
  const restricted = () => {
    if (trusted()) return false;
    vscode.window.showInformationMessage('Codex Extras: in Restricted Mode nothing is installed or changed. Trust the workspace first.');
    return true;
  };

  reg('status', async () => {
    const home = files.codexHome();
    const python = await findPython(context);
    const tried = pythonRuntime.pythons(context.globalStorageUri.fsPath);
    const installed = install.installedVersions(home);
    const copy = install.installState(home).why;
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
          'no digest': 'files of unknown age', 'files differ': 'DIFFERENT FILES, reinstall to update it' })[copy] || copy}` : ''})`,
      `Additions: ${settings().enabled ? 'on' : 'OFF (codexExtras.enabled); the patch to Codex is left as it is'}`,
      `Python for the hooks: ${python ? `${python.version} as ${python.launcher.join(' ')} (${python.executable})`
        : `none found, tried ${tried.map((l) => l.join(' ')).join(', ')}`
          + (pythonRuntime.build() ? '; "Codex Extras: Download Python for the Work Plan Hooks" fetches one' : '')}`,
      `Plans: ${install.planDir(home)}`,
      `codex program: ${codexProgram() || '(not found)'}`,
      `Agent Work Plan: ${link.registered ? 'the Codex source is registered' : `not registered (${link.code}: ${link.reason})`}`,
      `Workspace trusted: ${trusted() ? 'yes' : 'no (Restricted Mode: nothing is written)'}`,
      ...patching.statusLines(),
      ...supported.statusLines(codexVersion()),
      ...openTimes.reportLines(await opens.read().catch(() => []), { zone: context.globalState.get('codexExtras.clientTimeZone') || '', last: 3 }),
      /* What Codex's own page makes of the conversation in front. A window with no patch, or none with a Codex tab in
         front, answers with the one line saying so rather than holding this command up. */
      ...patching.selfCheckLines(await patching.selfCheckPage()),
    ];
    log.appendLine(lines.join('\n'));
    log.show(true);
  });
  /*
   * The same self-check on its own, for pasting back: the parts drawn inside Codex's page are the ones nothing but a
   * person looking at them could confirm, and this is how they report themselves instead.
   */
  reg('pageSelfCheck', async () => {
    const answer = await patching.selfCheckPage();
    const lines = patching.selfCheckLines(answer);
    log.appendLine(lines.join('\n'));
    log.show(true);
    const copy = 'Copy';
    const pick = await vscode.window.showInformationMessage(answer.error
      ? `Codex Extras: ${answer.error}` : 'Codex Extras: the page self-check is in the output panel.', copy);
    if (pick === copy) await vscode.env.clipboard.writeText(lines.join('\n'));
  });
  /*
   * The master switch: one act for all the additions at once, rather than six settings to find.
   *
   * It writes the one setting the others are read through (settings()), so the user's own choices among them survive
   * being turned off and come back as they were. What it does not do is take the patch out of Codex's files: with the
   * switch off the patch is left in place and nothing is drawn with it, and the file is put back only by
   * `Codex Extras: Remove the Patch from Codex`. The command titles say so, because a "Turn Off" that was thought to
   * restore Codex's own files would be found out only much later.
   */
  const setEnabled = async (on) => {
    await vscode.workspace.getConfiguration(CONFIG).update('enabled', on, vscode.ConfigurationTarget.Global);
    sessionsProvider.refresh();
    patching.refreshPanels().catch((e) => say(`redrawing the Codex pages: ${e.message}`));
    vscode.window.showInformationMessage(on
      ? 'Codex Extras: the additions are on again, each as you had it set.'
      : 'Codex Extras: the additions are off. The patch to Codex\'s files is still in place and unchanged; '
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
    await context.globalState.update(`codexExtras.patchAsked:${(vscode.extensions.getExtension('openai.chatgpt') || { packageJSON: {} }).packageJSON.version}`, 'yes');
    await vscode.workspace.getConfiguration(CONFIG).update('patchCodex', 'on', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Codex will be patched now; reload the window when asked.');
    /* Only the patching itself: activation already wired the hooks and the listeners, and wiring them again would
       redraw every panel once more on each change for every time this command has run. */
    patching.ensurePatched(vscode, context, say, 'on').catch((e) => say(`patch: ${e.message}`));
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
  /*
   * A sample of the Codex conversation in front, for working out which elements to hang a time tick, in-conversation
   * navigation or a colour on: those are drawn at run time and no class name of theirs can be read off Codex's files.
   * The sample is shape only, and the file holds exactly what the page sent.
   */
  reg('sampleConversationDom', async () => {
    if (restricted()) return;
    const r = await patching.sampleLayout();
    if (r.error) { vscode.window.showWarningMessage(`Codex Extras: ${r.error}`); return; }
    const codex = vscode.extensions.getExtension('openai.chatgpt');
    let file;
    try {
      file = domSample.save({ dir: context.globalStorageUri.fsPath, sample: r.sample,
        codexVersion: ((codex && codex.packageJSON) || {}).version || '' });
    } catch (e) { vscode.window.showErrorMessage(`Codex Extras: the sample could not be written: ${e.message}`); return; }
    say(`conversation layout sample written to ${file}`);
    const copy = 'Copy Path';
    const pick = await vscode.window.showInformationMessage(`Codex Extras: the conversation layout sample is at ${file}`, copy);
    if (pick === copy) await vscode.env.clipboard.writeText(file);
  });
  /*
   * The conversation Codex is waiting on, from the status bar. With more than one it asks which, rather than picking
   * one the count in the status bar did not single out.
   */
  reg('goToWaiting', async () => {
    const waiting = patching.waitingThreads().filter((t) => patching.approvalsOf(t).decide);
    if (!waiting.length) { vscode.window.showInformationMessage('Codex Extras: no Codex conversation in this window is waiting for you.'); return; }
    let id = waiting[0];
    if (waiting.length > 1) {
      const pick = await vscode.window.showQuickPick(waiting.map((t) => ({ label: (reader.thread(t) || {}).title || t, description: t, id: t })),
        { placeHolder: 'Which conversation Codex is waiting on' });
      if (!pick) return;
      id = pick.id;
    }
    if (!tabs.codexTabs(vscode).some((t) => t.thread === id) && patching.revealPanel(id)) return;
    await source.reveal(id, null);
  });
  reg('showOpenTimes', async () => {
    const spans = await opens.read().catch(() => []);
    log.appendLine(openTimes.reportLines(spans, { zone: context.globalState.get('codexExtras.clientTimeZone') || '', last: 20 }).join('\n'));
    log.show(true);
  });
  reg('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:xnervwang.codex-extras'));
  reg('installWorkPlanPlugin', () => (restricted() ? undefined : installPlugin(context, say, { interactive: true })));
  reg('downloadPython', async () => {
    if (restricted()) return;
    if (await downloadPython(context, say)) await installPlugin(context, say, { interactive: true });
  });
  reg('trustWorkPlanHooks', () => (restricted() ? undefined : trustPlugin(say, { interactive: true })));
  /*
   * The step between keeping the plugin and removing it: Codex holds it, with its marketplace entry and the trust given
   * to its hooks, and is told not to load it. Removing it instead takes all three away, so getting back from that means
   * installing and trusting again.
   *
   * Both directions are commands, since the only other way back would be to install over it and trust its hooks afresh.
   */
  const loadPlugin = async (on) => {
    if (restricted()) return;
    const binary = codexProgram();
    if (!binary) { vscode.window.showErrorMessage('The codex program of the Codex extension was not found.'); return; }
    try {
      await install.setPluginEnabled({ binary, home: files.codexHome(), enabled: on });
      say(`Codex is now set to ${on ? 'load' : 'skip'} the work plan plugin in ${files.codexHome()}`);
      vscode.window.showInformationMessage(on
        ? 'Codex Extras: Codex will load the work plan plugin again. Open a new conversation for it to take effect.'
        : 'Codex Extras: Codex will not load the work plan plugin. It stays installed, with its hooks still trusted; '
          + '"Load the Work Plan Plugin in Codex" turns it back on.');
    } catch (e) { vscode.window.showErrorMessage(`Could not change whether Codex loads the plugin: ${e.message}`); }
  };
  reg('stopLoadingWorkPlanPlugin', () => loadPlugin(false));
  reg('loadWorkPlanPlugin', () => loadPlugin(true));
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
  reg('newInTab', () => newConversationInTab(say));
  reg('newInSidebar', async () => {
    if (await tabs.openRouteInSidebar(vscode, '/')) return;
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    try { await vscode.commands.executeCommand('chatgpt.newChat'); } catch (_) { /* the shortcut is not enabled in every build */ }
  });
  /*
   * The tab bar's button: a new Codex conversation in a tab, or Codex's sidebar, as the setting says. It never raises a
   * conversation that is already open: the session list is where an existing one is picked, and a button that sometimes
   * only moved the focus read as doing nothing.
   */
  reg('openCodex', async () => {
    if (cfg().get('openButtonTarget', 'tab') === 'sidebar') { await vscode.commands.executeCommand('chatgpt.openSidebar'); return; }
    await newConversationInTab(say);
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
    if (await tabs.openRouteInSidebar(vscode, tabs.threadRoute(id)) || await patching.openInSidebar(id)) return;
    vscode.window.showInformationMessage('Codex did not take the link that opens a conversation in its sidebar, so it was opened in a tab instead.');
    await tabs.openInTab(vscode, id);
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
    rows = [...rows, { label: 'Account', value: codexConfig.accountLine(files.codexHome()) }];
    const pick = await vscode.window.showQuickPick(rows.map((r) => ({ label: r.label, description: r.value, value: r.value })),
      { placeHolder: 'Click a value to copy it' });
    if (pick && pick.value) { await vscode.env.clipboard.writeText(pick.value); vscode.window.setStatusBarMessage(`Copied ${pick.label}`, 3000); }
  });
}

/*
 * The plugin is offered once per Codex home and per set of its files; after that it is the user's commands that install
 * or remove it. A plugin whose files changed under the same version is an upgrade like any other.
 */
async function offerPlugin(context, say) {
  if (!trusted() || !cfg().get('workPlan', true)) return;
  const home = files.codexHome();
  const st = install.installState(home);
  if (st.current) { await trustPlugin(say, { interactive: false }); return; }
  say(`work plan plugin in Codex: ${st.why} (${st.versions.join(', ') || 'none'}; this extension carries ${st.want})`);
  const mode = settings().installPlugin;
  if (mode === 'never') return;
  if (mode === 'ask') {
    const key = `codexExtras.offered:${home}:${st.want}:${st.digest}`;
    if (context.globalState.get(key)) return;
    await context.globalState.update(key, true);
    const have = st.versions;
    const go = have.length ? 'Upgrade' : 'Install';
    const pick = await vscode.window.showInformationMessage(
      !have.length ? 'Install the work plan plugin into Codex?'
        : have.includes(st.want) ? `The Codex work plan plugin ${st.want} in Codex is not the one this extension carries.`
          : `The Codex work plan plugin ${have.join(', ')} is older than ${st.want}.`,
      { detail: `It adds a skill, hooks and a small MCP server to ${home}. Codex asks you to trust the hooks afterwards.` }, go, 'Not now');
    if (pick !== go) return;
  }
  await installPlugin(context, say, { interactive: mode === 'ask' });
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
    vscode.window.showInformationMessage('Codex Extras: python.org publishes an embeddable Python for Windows only. '
      + 'On this machine, install Python 3 and run "Codex Extras: Install the Work Plan Plugin into Codex".');
    return null;
  }
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Downloading Python ${pythonRuntime.VERSION} from python.org` },
    () => pythonRuntime.download(storage));
  say(`python download: ${r.said}`);
  if (!r.ok) { vscode.window.showErrorMessage(`Codex Extras: downloading Python failed. ${r.said}`); return null; }
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
    const r = await install.install({ binary, home: files.codexHome(), stage, python });
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

/* `_settings` is for the checks: the master switch is only real if what every part reads comes out of settings() with
   it already applied, and that is a table to be read rather than inferred from what the extension then did.
   `_offerPlugin` is the start-up decision to install the plugin, which activation only makes after a delay. */
module.exports = { activate, deactivate, _settings: settings, _offerPlugin: offerPlugin };
