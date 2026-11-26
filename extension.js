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
const loadTabs = require('./src/load-tabs');
const install = require('./src/plugin-install');
const { codexBinary } = require('./src/appserver');
const { createCodexSource } = require('./src/codex-source');
const { createSeen } = require('./src/seen');
const { CodexReader } = require('./src/codex-reader');
const hostLink = require('./src/host-link');
const { createConversationLinks } = require('./src/convo-links');
const { createPlanBars } = require('./src/plan-bars');
const { TabMemory } = require('./src/tab-memory');
const sessionList = require('./src/session-list-source');
const { COLOR_KEY, PINNED_SECTION } = sessionList;
const accountUsage = require('./src/account-usage');
const patching = require('./src/patching');
const supported = require('./src/supported');
const pythonRuntime = require('./src/python-runtime');
const pythonOffer = require('./src/python-offer');
const { folderTest } = require('./src/folders');
const { worktreesOf } = require('./src/git-worktrees');
const openTimes = require('./src/open-times');
const codexConfig = require('./src/codex-config');
const uninstallPlan = require('./src/uninstall-plan');
const wakeup = require('./src/wakeup');
const detachedEnds = require('./src/detached-ends');
const bgEnds = require('./src/bg-ends');
const { SHARE_DIR } = require('./src/left-running');
const workplan = require('./src/workplan');
const agentMaps = require('./src/agent-map');
const skillsConfig = require('./src/skills-config');
const contextWindow = require('./src/context-window');
const codexManifest = require('./src/manifest');
const tokenMode = require('./src/token-mode');
const archiveSweep = require('./src/archive-sweep');
const windowEntries = require('./src/window-entries');
const { withoutEnvelope } = require('./src/title-marks');
const { envelope } = require('./src/envelope');

const CONFIG = 'codexPlus';
/* This copy's id and folder, kept for deactivate, which runs after the editor's API is gone. */
const ID = (() => { try { const p = require('./package.json'); return `${p.publisher}.${p.name}`; } catch (_) { return uninstallPlan.ID; } })();
let selfPath = '';
let loadedStamp = 0;
let log = null;
let reader = null;
/* The memento that remembers "Remove the Patch" (patching.PATCH_REMOVED_KEY) until Turn On or Toggle. */
let memento = null;
/* Deletes conversations archived longer than codexPlus.deleteArchivedAfterDays (src/archive-sweep.js). */
let archiveSweeper = null;
/* Set once the commands are registered: listManages, explained there, and what tells Agent Plus's session list that
   Account & usage changed. */
let listManages = () => false;
let accountHeard = () => {};
/* Writes this window's entry (src/window-entries.js); activate() sets it once it knows what the window shows. */
let publishWindow = () => {};
/* Which of the archived conversations given the daily pass would leave alone; set with the commands. */
let holdArchived = null;
/* True while loadRestored() brings the background Codex tabs forward one by one. */
let loadingTabs = false;

function cfg() { return vscode.workspace.getConfiguration(CONFIG); }
/* Whether a feature that adds to Codex's context runs: its own setting in the Custom token mode, the mode's table in the
   others (src/token-mode.js). */
const runs = (name) => tokenMode.effective(vscode, `${CONFIG}.${name}`);
/* This extension's settings that the token mode decides. */
const MODE_SWITCHES = tokenMode.SWITCHES.filter((s) => s.key.startsWith(`${CONFIG}.`)).map((s) => s.key);

let toldStale = false;
/* Asked before every scan for work left running, so the answer is kept while the files it comes from are unchanged. */
let standingOf = null;
function standsDown() {
  if (!standingOf || standingOf.path !== selfPath || standingOf.stamp !== loadedStamp) {
    standingOf = { path: selfPath, stamp: loadedStamp, now: uninstallPlan.keptStanding(selfPath, [ID, ...uninstallPlan.FORMER_IDS], loadedStamp) };
  }
  const s = standingOf.now();
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
 * The settings, with the main switch (codexPlus.enabled) already applied to the ones it covers.
 *
 * The switch is a setting of its own rather than a command that writes `false` over each of the settings below, so that
 * turning everything off and on again gives back the choices the user had made rather than every default. Everything
 * it covers is read through it here, which is why nothing else in the extension has to ask about it.
 *
 * What it does not cover: the work plan and the session list. Those are not of a piece with the rest - a work plan the
 * model is keeping is not an adornment to be switched off by the command that stops a chime - and docs/install.md says as
 * much.
 *
 * `patchCodex` is 'on' or 'off' and is not a setting: Codex is patched at start-up unless the switch is off or the user
 * ran "Remove the Patch from Codex", which holds until they run Turn On or Toggle. 'off' stops the patch being applied or
 * kept up to date; with the switch off it does not take an applied patch out of Codex's files, which only the remove
 * command does.
 */
/* The settings Codex's pages draw from: those of viewOf in src/patching.js, and
   conversationLinks, which a page gets together with the list of conversations (src/convo-links.js). */
const PAGE_SETTINGS = ['enabled', 'timestamps', 'conversationNavigation', 'userMessageColor', 'userMessageEdge', 'lowContextOutline',
  'turnFigures', 'replyDuration', 'chime', 'infoButton', 'chimeButton', 'contextMeter', 'replyImages', 'conversationLinks'];
function settings() {
  const c = cfg();
  const on = c.get('enabled', true);
  const removed = !!(memento && memento.get(patching.PATCH_REMOVED_KEY) === true);
  return {
    enabled: on,
    workPlan: runs('workPlan'),
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
    replyImages: on && c.get('replyImages', true),
    conversationLinks: on && c.get('conversationLinks', true),
    planBar: on && c.get('planBar', true),
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

/*
 * Like askAppServer, for several requests in turn. Before the patch has handed Codex's connection over, the remaining
 * ones share a single short-lived app-server instead of starting one each. Resolves to the answers in order.
 */
async function askAppServerEach(requests) {
  const out = [];
  for (const [method, params] of requests) {
    const r = await patching.hostRequest(method, params);
    if (r.outcome === 'unavailable') break;
    out.push(r);
  }
  const rest = requests.slice(out.length);
  if (!rest.length) return out;
  const binary = codexProgram();
  if (!binary) return out.concat(rest.map(() => ({ outcome: 'failed', reason: 'the codex program of the Codex extension was not found' })));
  try {
    await require('./src/appserver').withAppServer(binary, files.codexHome(), async (server) => {
      for (const [method, params] of rest) {
        try { out.push({ outcome: 'done', result: await server.request(method, params) }); } catch (e) { out.push({ outcome: 'failed', reason: e.message }); }
      }
    });
  } catch (e) { while (out.length < requests.length) out.push({ outcome: 'failed', reason: e.message }); }
  return out;
}

/*
 * codexPlus.skillsListBudget and codexPlus.disabledSkills, written into Codex's config.toml (src/skills-config.js). One
 * write at a time, so two quick changes of a setting cannot write the same entry twice.
 */
let skillsWriting = Promise.resolve();
function applySkillSettings(context, say) {
  if (!trusted() || standsDown()) return skillsWriting;
  const c = cfg();
  skillsWriting = skillsWriting.then(() => skillsConfig.applySkillSettings({ ask: askAppServer, memento: context.globalState,
    maxTokens: c.get('skillsListBudget', 0), disabled: c.get('disabledSkills', []), log: say }))
    .catch((e) => say(`writing the skills settings into Codex's config: ${e.message}`));
  return skillsWriting;
}

/*
 * codexPlus.contextWindow (src/context-window.js). config.toml's `model` and model_context_window are read again only
 * when the file changes, because every page request that opens a conversation checks them before Codex sends it. If
 * config.toml names no model, the default model is the one Codex's model/list returns with isDefault.
 */
let modelSeen = { key: '', model: '', window: 0 };
function modelSettingsNow() {
  const file = path.join(files.codexHome(), 'config.toml');
  let key = 'none';
  try { const st = fs.statSync(file); key = `${file}:${st.mtimeMs}:${st.size}`; } catch (_) { key = 'none'; }
  if (key !== modelSeen.key) modelSeen = { key, ...(key === 'none' ? { model: '', window: 0 } : codexConfig.modelSettings(files.codexHome())) };
  return modelSeen;
}
let listedDefault = '';
const windowTable = () => { const m = cfg().get('contextWindow', {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; };
const startingModel = () => modelSettingsNow().model || listedDefault;
let windowWriting = Promise.resolve();
function applyContextWindow(context, say) {
  if (!trusted() || standsDown()) return windowWriting;
  windowWriting = windowWriting.then(async () => {
    if (!modelSettingsNow().model && !listedDefault && Object.keys(windowTable()).length) {
      const r = await askAppServer('model/list', {});
      const data = (r && r.result && Array.isArray(r.result.data)) ? r.result.data : [];
      listedDefault = String((data.find((m) => m && m.isDefault) || {}).model || '');
    }
    const model = startingModel();
    const inFile = modelSettingsNow().window;
    const r = await contextWindow.applyTopLevel({ ask: askAppServer, memento: context.globalState, map: windowTable(), model, inFile, log: say });
    if (r && r.state === 'theirs') offerHandWindow(context, say, model, inFile);
    return r;
  }).catch((e) => say(`writing the context window into Codex's config: ${e.message}`));
  return windowWriting;
}
/*
 * A model_context_window that someone else wrote into config.toml keeps the setting from applying (handWritten). Each
 * window asks once per value whether to keep it, recorded as the setting's value for the default model, or to replace
 * it with the setting's. A value that equals the setting's value is treated as written by this extension, and nothing
 * is asked.
 */
const handWindowAsked = new Set();
let handWindowKept = false;
function offerHandWindow(context, say, model, inFile) {
  const map = windowTable();
  const applied = context.globalState.get(contextWindow.APPLIED_KEY) || {};
  const found = contextWindow.handWritten({ map, model, inFile, ours: +applied.value || 0 });
  if (!found) return;
  const key = (contextWindow.entryFor(map, model) || {}).key || String(model);
  const record = (text) => context.globalState.update(contextWindow.APPLIED_KEY, { value: found.file, model: String(model), key, text });
  if (found.same) { record(found.want.text); return; }
  const asked = `${model}|${found.file}|${found.want ? found.want.value : 0}`;
  if (handWindowAsked.has(asked)) return;
  handWindowAsked.add(asked);
  const t = contextWindow.tokensText;
  const keep = `Keep ${t(found.file)}`;
  const other = found.want ? `Replace with ${t(found.want.value)}` : 'Remove it';
  const instead = found.want
    ? `replace it with the ${t(found.want.value)} the setting gives${found.want.text !== t(found.want.value) ? ` (${found.want.text})` : ''}`
    : 'remove it from config.toml so that the setting applies to your other models';
  vscode.window.showInformationMessage(`Codex Plus: config.toml sets model_context_window to ${t(found.file)}, which this extension `
    + `did not write, so codexPlus.contextWindow is not applied. Keep ${t(found.file)} and record it in the setting for ${model}, `
    + `or ${instead}?`, keep, other).then(async (pick) => {
    if (pick === keep) {
      const text = contextWindow.textFor(model, found.file);
      handWindowKept = true;
      await record(text);
      await cfg().update('contextWindow', Object.assign({}, windowTable(), { [key]: text }), vscode.ConfigurationTarget.Global);
    } else if (pick === other) {
      await context.globalState.update(contextWindow.APPLIED_KEY, { value: found.file });
      await applyContextWindow(context, say);
    }
  }, (e) => say(`asking about the context window in config.toml: ${e.message}`));
}
/* The page-request hook that adds the context window override (src/context-window.js overrideFor). */
function windowOverride(context, say) {
  return (request, kind) => {
    if (!contextWindow.opens(request, kind)) return;
    const map = windowTable();
    const applied = context.globalState.get(contextWindow.APPLIED_KEY) || {};
    if (!Object.keys(map).length && !applied.value) return;
    const value = contextWindow.overrideFor(request, kind, { map, top: modelSettingsNow().window, ours: +applied.value || 0,
      defaultModel: startingModel(), threadModel: (id) => (reader.state(id) || {}).model || (reader.thread(id) || {}).model || '' });
    if (!value) return;
    contextWindow.addOverride(request, value);
    say(`a context window of ${value} was added to ${kind === 'prewarm' ? 'a prewarmed thread/start' : request.method}`);
  };
}
function windowSource(context) {
  return (c) => contextWindow.windowFrom({ model: c.model, reported: c.context && c.context.window, map: windowTable(),
    top: modelSettingsNow().window, applied: context.globalState.get(contextWindow.APPLIED_KEY) || null });
}
/* One notice per change of the setting, shown only while this window has a Codex conversation open. */
let windowToldAt = null;
function tellWindowChange() {
  if (windowToldAt) clearTimeout(windowToldAt);
  windowToldAt = setTimeout(() => {
    windowToldAt = null;
    if (!patching.panelThreads().length && !patching.sidebarShowing()) return;
    vscode.window.showInformationMessage('Codex Plus: the new context window applies to conversations you start or open after this. '
      + 'Conversations already loaded, including tabs closed in the last few hours, keep their window until you run Developer: Reload Window.');
  }, 1200);
}

/* What the plugin's hooks read: the few settings that change their behaviour, and the user's time zone. */
function writeHookSettings(context) {
  if (!trusted() || standsDown()) return;
  const c = cfg();
  try {
    install.writeHookSettings(files.codexHome(), {
      enabled: runs('workPlan'),
      offerMinTurns: c.get('workPlanOfferMinTurns', 3),
      offerMinToolCalls: c.get('workPlanOfferMinToolCalls', 25),
      quietWhenReplyMatches: c.get('workPlanQuietWhenReplyMatches', ''),
      tellTimeZone: runs('tellCodexYourTimeZone'),
      /* Codex draws the images itself; the note is given only for a build whose page has been checked. */
      replyImages: settings().replyImages && supported.verified(codexVersion()),
      brief: runs('conversationBrief'),
      compactTokenLimit: codexConfig.compactLimit(files.codexHome()),
    }, { marker: context.globalStorageUri && context.globalStorageUri.fsPath });
    install.writeClientZone(files.codexHome(), context.globalState.get('codexPlus.clientTimeZone'));
  } catch (e) { log.appendLine(`could not write the hooks' settings: ${e.message}`); }
}

/* The record of plan directories already cleared sits in global storage, on the machine Codex runs on: globalState is
   kept by the client, and one client may connect to several machines. */
function removeSkillSearchLeftovers(context, say) {
  if (!context.globalStorageUri) return;
  try {
    const r = workplan.removeSkillSearchLeftovers({ dir: install.planDir(files.codexHome()),
      doneFile: path.join(context.globalStorageUri.fsPath, 'skill-search-leftovers-cleared.json') });
    if (r && r.failed) say(`deleting what the skill search left in the plan directory: ${r.failed}`);
    else if (r && (r.folder || r.files)) {
      say(`deleted what the skill search left in the plan directory: ${r.folder ? `${workplan.SKILL_SEARCH_DIR}/ and ` : ''}${r.files} .routed file(s)`);
    }
  } catch (e) { say(`deleting what the skill search left in the plan directory: ${e.message}`); }
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
  /* A conversation is shown as working while something it started is still running (src/left-running.js). A window
     running an older build than the installed one leaves this scan, the end notices and wake-ups to the windows running
     the installed build, and keeps doing them while no window runs the installed build (src/uninstall-plan.js
     keepsShared). */
  const keepsShared = () => {
    const s = standsDown();
    if (!s) return true;
    let others = [];
    try { others = windowEntries.others(install.planDir(files.codexHome())); } catch (_) { /* none readable */ }
    return uninstallPlan.keepsShared({ standing: s, build: String(loadedStamp || '') }, others);
  };
  /* The notice a conversation gets once a command it left running detached is no longer running (src/detached-ends.js). */
  const sharedDir = () => path.join(install.planDir(files.codexHome()), SHARE_DIR);
  const endsOn = () => runs('detachedEndNotices') && trusted() && keepsShared();
  const ends = detachedEnds.createDetachedEnds({ dir: sharedDir,
    ask: (m, p) => patching.hostRequest(m, p), log: say, enabled: endsOn,
    ran: (thread, cmd, startMs) => {
      const file = files.existingRollout((reader.thread(thread) || {}).rollout || '');
      return detachedEnds.ranBy(file ? files.tailLines(file, detachedEnds.RAN_BYTES) : null, cmd, startMs);
    } });
  let delivering = false;
  const onScan = (scan) => {
    ends.observe(scan);
    if (delivering) return;
    delivering = true;
    (async () => {
      await ends.deliver().catch((e) => say(`detached command notices: ${e.message}`));
      /* The news of claude --bg sessions (src/bg-ends.js), written down in the worker and sent the same way. */
      const told = await reader.request('bgEnds', { home: files.codexHome(), dir: sharedDir(), claim: endsOn() });
      if (Array.isArray(told) && told.length) say(`claude --bg sessions changed: ${told.map((e) => `${e.job} ${e.kind} for ${e.thread}`).join(', ')}`);
      await ends.deliver({ sub: bgEnds.ENDS_DIR, text: bgEnds.noticeText });
    })().catch((e) => say(`claude --bg session notices: ${e.message}`)).finally(() => { delivering = false; });
  };
  const source = createCodexSource(vscode, { log: say, reader, patching, trusted, enabled: () => runs('workPlan'),
    briefs: () => runs('conversationBrief'), seen: createSeen(context.globalState),
    scanLeft: () => keepsShared() && (settings().enabled !== false || listManages()), onPoll: () => { publishWindow(); if (archiveSweeper) archiveSweeper.tick(); }, onScan,
    holdSeen: () => loadingTabs });
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
    // Tabs Codex opened with its own New button do not name their conversation in their URI; the patch does, also for
    // a restored tab whose panel Codex has not built yet.
    alsoOpen: () => patching.panelThreads().concat(patching.shownByTabs()),
    nowShowing: (id) => patching.nowShowing(id),
  });
  context.subscriptions.push(memory, patching.onPanelClosed((thread, opened) => memory.panelClosed(thread, opened)));
  /* Ctrl/Cmd+Shift+T is this extension's only while the tab closed last was a Codex tab (codexPlus.reopenClosedSession). */
  let reopenKey = null;
  const keepReopenKey = () => {
    /* While Agent Plus's session list is on, Ctrl+Shift+T is the list's own command,
       agentPlus.reopenClosedConversation. */
    const on = memory.lastClosedWasCodex() && !listManages();
    if (on === reopenKey) return;
    reopenKey = on;
    Promise.resolve(vscode.commands.executeCommand('setContext', 'codexPlus.lastClosedWasCodex', on)).catch(() => {});
  };
  context.subscriptions.push(memory.onDidChange(keepReopenKey));
  keepReopenKey();
  const account = accountUsage.createAccountUsage({ ask: askAppServer, onChange: () => accountHeard() });
  context.subscriptions.push(patching.onAccountNotification((method, params) => account.heard(method, params)));
  /*
   * This window's entry (src/window-entries.js) lists the conversations its tabs and Codex's sidebar show.
   * The other windows leave those alone when they delete. Written at once, on the source's poll and when the tabs change.
   */
  const shownHere = () => [...new Set([...memory.openThreads(), patching.sidebarShowing()].filter(Boolean))];
  let published = false;
  const writeEntry = windowEntries.publisher(install.planDir(files.codexHome()), () => ({ name: vscode.workspace.name || '',
    folders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath), sessions: shownHere(),
    build: String(loadedStamp || ''), installed: !standsDown() }), { log: say });
  publishWindow = () => { if (trusted() && standsDown() !== 'uninstalling' && writeEntry()) published = true; };
  context.subscriptions.push({ dispose: () => {
    publishWindow = () => {};
    if (published) windowEntries.withdraw(install.planDir(files.codexHome()));
  } });
  publishWindow();
  context.subscriptions.push(source.onDidChangeConversations(() => publishWindow()), memory.onDidChange(() => publishWindow()),
    patching.onSidebarChanged(() => publishWindow()));
  if (typeof vscode.window.tabGroups.onDidChangeTabs === 'function') context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => publishWindow()));

  /* ── Agent Plus draws the rest ── */
  const link = await hostLink.link(vscode, source, { log: say, memento: context.globalState });
  if (link.registered) {
    say('the Codex source is registered with Agent Plus');
    context.subscriptions.push(link.registration);
  }
  /* Links in Codex's page to the other conversations a reply names (src/convo-links.js), through the Agent Plus this
     source is registered with. */
  const convoLinks = createConversationLinks({ core: link.registered ? link.core : null, log: say,
    enabled: () => settings().conversationLinks, onChange: () => patching.refreshConversationLinks(),
    exec: (...a) => vscode.commands.executeCommand(...a) });
  context.subscriptions.push(convoLinks);
  convoLinks.sync();
  /* The plan bar above the message box in Codex's page (src/plan-bars.js), from the same Agent Plus. */
  const planBars = createPlanBars({ core: link.registered ? link.core : null, log: say,
    enabled: () => settings().planBar, onChange: (id) => patching.refreshPlanBars(id),
    exec: (...a) => vscode.commands.executeCommand(...a) });
  context.subscriptions.push(planBars);
  planBars.sync();

  context.subscriptions.push(tokenMode.warnOutsideCustom(vscode, MODE_SWITCHES, { who: 'Codex Plus', log: say }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    const modeChanged = e.affectsConfiguration(tokenMode.SETTING);
    if (e.affectsConfiguration(CONFIG) || modeChanged) writeHookSettings(context);
    if (e.affectsConfiguration(`${CONFIG}.conversationLinks`) || e.affectsConfiguration(`${CONFIG}.enabled`)) convoLinks.sync();
    if (e.affectsConfiguration(`${CONFIG}.planBar`) || e.affectsConfiguration(`${CONFIG}.enabled`)) planBars.sync();
    if (modeChanged || e.affectsConfiguration(`${CONFIG}.conversationBrief`) || e.affectsConfiguration(`${CONFIG}.workPlan`)) source.featuresChanged();
    if (e.affectsConfiguration(`${CONFIG}.enabled`)) ownTabBar();
    if (e.affectsConfiguration(`${CONFIG}.skillsListBudget`) || e.affectsConfiguration(`${CONFIG}.disabledSkills`)) applySkillSettings(context, say);
    if (e.affectsConfiguration(`${CONFIG}.contextWindow`)) {
      applyContextWindow(context, say);
      /* Keeping config.toml's value leaves every conversation's window as it was. */
      if (handWindowKept) handWindowKept = false; else tellWindowChange();
    }
    /* A change of mode only unloads or reloads the plugin, so it does not ask again to trust the hooks. If the plugin
       was never installed, because the first start was in Interface features, it is installed as at start-up. */
    if (modeChanged) {
      followTokenMode(context, say).then((r) => (r === 'left' && runs('workPlan') && !install.installedVersions(files.codexHome()).length
        ? ensurePlugin(context, say) : undefined)).catch((err) => say(`the work plan plugin under the new token mode: ${err.message}`));
    }
    /* These settings take effect in Codex's page (time stamps, message list, colours, figures, toolbar controls, images
       in replies). A change reaches the page through the same redraw the figures use, not through a watcher of its own.
       `enabled` is in the list because it turns all of them on or off, and a page has to be told when it changes. */
    if (PAGE_SETTINGS.some((k) => e.affectsConfiguration(`${CONFIG}.${k}`))) {
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
    { label: 'Account', value: codexConfig.accountLine(files.codexHome()) },
    { label: 'Token mode', value: tokenMode.labelOf(tokenMode.modeNow(vscode)) }];
  /* When the user's own messages were sent, for the stamps Codex's page draws on them: read in the worker thread, since
     the first read of a conversation goes through its whole rollout (src/user-times.js). */
  const userTimes = (id) => reader.request('userTimes', { home: files.codexHome(), id });
  /* How long Codex's pages took to open, from Codex's own log; read only when Show Status or its command asks. */
  const opens = openTimes.createOpenTimes(openTimes.whereLogs(context.logUri && context.logUri.fsPath));
  registerCommands(context, { source, memory, say, link, opens, account });

  /* Wake-ups the model set with the work plan's set_wakeup, queued for this window's conversations when due
     (src/wakeup.js). Only over Codex's own connection: hostRequest answers 'unavailable' until the patch hands it over,
     and a short-lived app-server would queue for a conversation nobody has open. */
  const wakes = wakeup.createWakeups({ dir: () => install.planDir(files.codexHome()), ask: (m, p) => patching.hostRequest(m, p),
    log: say, enabled: () => runs('wakeUps') && trusted() && keepsShared() });
  context.subscriptions.push(wakes.start(), patching.onAppServerNotification((m, p) => {
    wakes.heard(m, p).catch(() => { /* asked again next time */ });
    /* A goal changed, by a command here, by the model or by Codex itself: the list reads the goals database again. */
    if (m.startsWith('thread/goal/')) source._poll();
  }));
  /* The Agent map's goal buttons run the commands of the same name, and its Remove deletes the wake-up through
     src/wakeup.js. */
  const agentMap = (thread) => agentMaps.mapOf(thread, { reader, stateOf: (id) => source.threadState(id), detached: (id) => source.detachedOf(id),
    left: (id) => source.leftOf(id), running: (id) => source.runningOf(id), envelope: envelope(vscode) });
  const agentMapAct = async (thread, action, id) => {
    if (action === 'removeWakeup') { await wakes.remove(thread); source._poll(); return; }
    if (action === 'openAgent') {
      if ((reader.thread(id) || {}).parent === thread) await vscode.commands.executeCommand('codexPlus.openThreadInTab', id);
      return;
    }
    await vscode.commands.executeCommand(`codexPlus.${action}`, thread);
  };

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
    applySkillSettings(context, say);
    applyContextWindow(context, say);
    /* Codex's model picker writes the default model into config.toml. */
    const toml = path.join(files.codexHome(), 'config.toml');
    const tomlChanged = () => applyContextWindow(context, say);
    fs.watchFile(toml, { interval: 2000, persistent: false }, tomlChanged);
    context.subscriptions.push({ dispose: () => fs.unwatchFile(toml, tomlChanged) });
    later(() => ensurePlugin(context, say), 3000);
    later(() => {
      reader.request('sweep', { home: files.codexHome() }).then((r) => {
        if (r.deleted) say(`removed ${r.deleted} plan file(s) of conversations that no longer exist`);
        else if (r.why) say(`plan cleanup: ${r.why}`);
      }).catch((e) => say(`plan cleanup: ${e.message}`));
      removeSkillSearchLeftovers(context, say);
      if (archiveSweeper) archiveSweeper.start();
    }, 60000);
    try {
      patching.activate(context, { vscode, log: say, codexProgram, source, context, settings, onTimeZone: reportTimeZone,
        /* A restored tab is sent back only to a conversation that still exists. */
        present: (id) => !reader.threads() || reader.present(id),
        userTimes, sessionInfo: (id) => sessionInfoRows(id), compactLimit: compactLimitNow, agentMap, agentMapAct,
        planLine: (id) => (runs('workPlan') ? reader.request('plan', { home: files.codexHome(), id }) : Promise.resolve('')),
        adjustRequest: windowOverride(context, say), contextWindowFrom: windowSource(context),
        copy: async (value, label) => { await vscode.env.clipboard.writeText(value); vscode.window.setStatusBarMessage(`Copied ${label}`, 3000); },
        toggleChime: () => cfg().update('chime', !cfg().get('chime', true), vscode.ConfigurationTarget.Global),
        conversations: () => convoLinks.view(), openConversation: (sourceId, sessionId) => convoLinks.open(sourceId, sessionId),
        planBar: (id, opts) => planBars.view(id, opts), planBarAct: (id, action) => planBars.act(id, action) });
    } catch (e) { say(`patching: ${e.message}`); }
  };
  whenTrusted();
  if (!wrote && typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') {
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(whenTrusted));
  }
  /* codexPlus.loadRestoredTabs right after: Codex puts "Codex could not start" in a page not shown within 30 seconds of
     its creation, and a restored tab's page is created with the window. */
  later(() => reopenDropped(memory, say).catch((e) => say(`reopening dropped Codex tabs: ${e.message}`))
    .then(() => loadRestored(say)).catch((e) => say(`loading restored Codex tabs: ${e.message}`)), 8000);
}

/* Each Codex tab VS Code restored behind another is shown for a moment, so that its page and conversation load
   (src/load-tabs.js). Returns how many tabs it showed. */
async function loadRestored(say) {
  if (settings().enabled === false || cfg().get('loadRestoredTabs', false) !== true) return 0;
  const front = vscode.window.tabGroups.activeTabGroup;
  const at = front ? front.tabs.findIndex((t) => t.isActive) : -1;
  loadingTabs = true;
  let n = 0;
  try {
    n = await loadTabs.loadAll({ groups: vscode.window.tabGroups.all, front,
      isTab: (t) => tabs.isCodexTab(vscode, t), exec: (...a) => vscode.commands.executeCommand(...a),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  } finally { loadingTabs = false; }
  if (n) say(`loaded ${n} Codex tab(s) VS Code restored behind another, and put tab ${at + 1} of editor group ${front ? front.viewColumn : 0} in front again`);
  return n;
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

function ownTabBar() {
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  vscode.commands.executeCommand('setContext', codexManifest.CONTEXT_KEY,
    settings().enabled !== false && !!codex && codexManifest.carries(codex.packageJSON));
}

function registerCommands(context, { source, memory, say, link, opens, account }) {
  const reg = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG}.${name}`, fn));
  /* A conversation as a command is given it: its id, the context of a session list row, or Agent Plus's. */
  const threadArg = (arg) => (typeof arg === 'string' ? arg : arg && typeof arg.threadId === 'string' ? arg.threadId
    : arg && arg.thread ? arg.thread.id : arg && arg.sessionId) || tabThread(arg);
  /* Right-clicking a tab passes that tab's URI, which need not be the tab in front. Returns its conversation, as Agent
     Plus is told it, or '' for a URI that is not a Codex tab's. */
  const tabThread = (uri) => {
    if (!uri || typeof uri.scheme !== 'string' || typeof uri.path !== 'string') return '';
    const key = String(uri);
    for (const g of vscode.window.tabGroups.all || []) {
      for (const tab of g.tabs || []) {
        if (!tab.input || !tab.input.uri || String(tab.input.uri) !== key) continue;
        const id = source.sessionForTab(tab);
        return typeof id === 'string' ? id : '';
      }
    }
    return '';
  };
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
    await snapshotIn();
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
        + `${installed.length ? `, ${loadState === 'not loaded' ? (fs.existsSync(path.join(install.planDir(home), install.UNLOADED_MARKER))
          ? 'not loaded, as the Interface features token mode has it' : 'INSTALLED BUT NOT LOADED (Codex is set to skip it)')
          : loadState === 'no entry' ? 'no entry in config.toml, so Codex does not know of it' : 'loaded'}` : ''}`
        + ` (this extension ships ${install.pluginVersion()}`
        + `${installed.length ? `; Codex's copy has ${({ current: 'the same files', 'other version': 'another version',
          'no digest': 'files of unknown age', 'files differ': 'DIFFERENT FILES, reinstall to update it',
          'python differs': 'files fitted to another Python than the one found now, reinstall to update it' })[copy] || copy}` : ''})`,
      `Additions: ${settings().enabled ? 'on' : 'OFF (codexPlus.enabled); the patch to Codex is left as it is'}`,
      tokenModeLine(),
      `Python for the hooks: ${python ? `${python.version} as ${python.launcher.join(' ')} (${python.executable})`
        : `none found, tried ${tried.map((l) => l.join(' ')).join(', ')}`
          + (pythonRuntime.build() ? '; "Codex Plus: Download Python for the Work Plan Hooks" fetches one' : '')}`,
      `Plans: ${install.planDir(home)}`,
      `Wake-ups: ${(() => {
        const set = wakeup.listed(install.planDir(home)).filter((w) => !w.expired);
        if (!set.length) return 'none set';
        return `${set.length} set${runs('wakeUps') ? '' : `, NOT SENT (${tokenMode.modeNow(vscode) === tokenMode.CUSTOM
          ? 'codexPlus.wakeUps is off' : `the token mode is ${tokenMode.labelOf(tokenMode.modeNow(vscode))}`})`}: `
          + set.map((w) => `${w.thread} every ${w.everyMinutes} min until ${new Date(w.expiresMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`).join('; ');
      })()}`,
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
   * The main switch for all the additions. Like Claude Code Plus's, it shows no message.
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
  reg('trustWorkPlanHooks', () => (restricted() ? undefined : trustPlugin(say, { interactive: true, command: true })));
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
  /* The patch first: VS Code hands Codex's link to the window it last saw focused, which may be another one. */
  reg('newInSidebar', async () => {
    if (await patching.openSidebarRoute('/') || await tabs.openRouteInSidebar(vscode, '/')) return;
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    try { await vscode.commands.executeCommand('chatgpt.newChat'); } catch (_) { /* the shortcut is not enabled in every build */ }
  });
  /*
   * It never raises a conversation that is already open: the session list is where an existing one is picked, and a
   * button that sometimes only moved the focus read as doing nothing.
   */
  reg('openCodex', () => (cfg().get('tabBarButton', 'tab') === 'sidebar'
    ? vscode.commands.executeCommand('codexPlus.newInSidebar') : newConversationInTab(say)));
  reg('tabBarNewInTab', () => newConversationInTab(say));
  reg('tabBarOpenSidebar', () => vscode.commands.executeCommand('chatgpt.openSidebar'));
  ownTabBar();
  context.subscriptions.push(vscode.extensions.onDidChange(ownTabBar));
  /*
   * Handles clicks on Codex's own tab bar button, which the host patch routes here (src/host.js, "tab bar button").
   * With codexPlus.tabBarButton set to tab, a click opens a new conversation in a tab.
   */
  const fromTabBar = (args) => (Array.isArray(args) ? args : []).some((a) => !!a && typeof a === 'object'
    && ((typeof a.scheme === 'string' && typeof a.path === 'string') || typeof a.groupId === 'number'));
  globalThis.__codexExtrasTabBar = (args) => {
    if (!fromTabBar(args) || settings().enabled === false || cfg().get('tabBarButton', 'tab') !== 'tab') return false;
    newConversationInTab(say).catch((e) => say(`new conversation in a tab: ${e.message}`));
    return true;
  };
  /*
   * Codex's own New Codex Agent, once patched (src/host.js, "new conversation tabs"), calls this for the fragment of
   * the tab it opens. '' leaves Codex's URI as it built it.
   */
  globalThis.__codexExtrasNewPanelFragment = () => (settings().enabled === false ? '' : tabs.newPanelFragment());
  /* Set below, beside Unarchive. */
  let unarchiveToOpen = async () => {};
  reg('openThreadInTab', async (arg) => {
    const id = threadArg(arg);
    if (!id) return;
    await unarchiveToOpen(id);
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
    await unarchiveToOpen(id);
    if (await patching.openInSidebar(id) || await tabs.openRouteInSidebar(vscode, tabs.threadRoute(id))) return;
    vscode.window.showInformationMessage('Codex did not take the link that opens a conversation in its sidebar, so it was opened in a tab instead.');
    await tabs.openInTab(vscode, id);
  });
  /* A command acts on the selection VS Code passes when the clicked conversation is in it, otherwise on the one it is
     given. */
  const chosen = (arg, selected) => {
    if (!threadArg(arg)) return [inFront()].filter(Boolean);
    const ids = Array.isArray(selected) && selected.length && selected.some((s) => threadArg(s) === threadArg(arg))
      ? selected.map(threadArg) : [threadArg(arg)];
    return [...new Set(ids.filter(Boolean))];
  };
  /* The menu inside a conversation's page passes no conversation, so it acts on the one in the tab in front. */
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
    await snapshotIn();
    /* The envelope a tab or row draws for an unread reply is never part of the name, here or in what is saved. */
    const stored = (reader.thread(id) || {}).title || '';
    const was = withoutEnvelope(stored);
    const name = await vscode.window.showInputBox({ prompt: 'A new title for this Codex conversation', value: was, valueSelection: [0, was.length] });
    const next = withoutEnvelope(name || '').trim();
    if (name === undefined || !next || next === stored) return;
    await changeThread('rename it', 'thread/name/set', { threadId: id, name: next });
  });
  reg('markThreadUnread', (arg, selected) => { for (const id of chosen(arg, selected)) source.markUnread(id); });
  /*
   * A conversation's goal, which Codex works toward on its own: each time the conversation goes idle it starts another
   * turn, until the goal is done, blocked or has used its token budget. Each change carries origin: user, which the
   * app-server requires before it starts or stops that work for the user.
   */
  const goalThread = (arg) => threadArg(arg) || inFront();
  reg('pauseGoal', async (arg) => {
    const id = goalThread(arg);
    if (id && !restricted()) await changeThread('pause the goal', 'thread/goal/set', { threadId: id, status: 'paused', origin: 'user' });
  });
  reg('resumeGoal', async (arg) => {
    const id = goalThread(arg);
    if (id && !restricted()) await changeThread('resume the goal', 'thread/goal/set', { threadId: id, status: 'active', origin: 'user' });
  });
  reg('clearGoal', async (arg) => {
    const id = goalThread(arg);
    if (id && !restricted()) await changeThread('clear the goal', 'thread/goal/clear', { threadId: id, origin: 'user' });
  });
  /*
   * Codex's thread/delete deletes the sub-agents below a conversation too (test/parts/35r-thread-delete-codex.js), so
   * a conversation whose sub-agent is open or running is left alone, as one that is open or running itself is.
   *
   * Open means in a tab of this window or in Codex's sidebar. Only the patch can name the sidebar's conversation and
   * that of a tab opened with Codex's own New button, so while Codex runs here without the patch connected, nothing is
   * deleted. If Codex has not started in this window, the request goes to a short-lived app-server, as Rename's does.
   */
  const openNow = () => {
    const codex = vscode.extensions.getExtension('openai.chatgpt');
    if (!patching.canType() && codex && codex.isActive) return null;
    try { return new Set([...memory.openThreads(), patching.sidebarShowing()].filter(Boolean)); } catch (_) { return null; }
  };
  /* The conversations other windows show, as id -> the names of those windows, from their entries (src/window-entries.js). */
  const elsewhereNow = () => { try { return windowEntries.shownElsewhere(install.planDir(files.codexHome())); } catch (_) { return new Map(); } };
  const windowNames = (names) => `the VS Code window${names.length === 1 ? '' : 's'} ${names.map((n) => `"${n}"`).join(', ')}`;
  const subAgentsOf = (id) => {
    const all = reader.threads() || [];
    const out = [];
    for (let i = -1; i < out.length; i++) {
      const parent = i < 0 ? id : out[i];
      for (const t of all) if (t.parent === parent && t.id !== id && !out.includes(t.id)) out.push(t.id);
    }
    return out;
  };
  /* Reads the rollouts of `ids` again, to catch a turn started since the last poll. */
  const readNow = async (ids) => {
    while (reader.busy) await reader.busy;
    await reader.refresh({ home: files.codexHome(), extra: ids, force: true });
  };
  /* Which conversations are archived is known only from a snapshot, so a command that picks by it waits for the first. */
  const snapshotIn = async () => { if (!reader.threads()) await readNow([]); };
  /* A turn running or waiting for the user. A rollout that could not be read counts as running. */
  const busyNow = (id) => {
    if (!reader.present(id)) return false;
    const st = source.threadState(id);
    return !st || !!(st.working || st.decide || st.soon || st.runningHere);
  };
  const nameOf = (id) => {
    const t = reader.thread(id) || {};
    return String((t.kind === 'subagent' && t.nickname) || t.title || '(untitled)').slice(0, 120);
  };
  /* A no-break space before the unit: VS Code's confirmation wraps its detail at spaces, and "11.6" and "KB" can land
     on two lines. */
  const sizeText = (bytes) => (bytes < 1024 ? `${bytes}\u00a0B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 102.4) / 10}\u00a0KB` : `${Math.round(bytes / 104857.6) / 10}\u00a0MB`);
  const describe = (id, subs) => {
    const dir = install.planDir(files.codexHome());
    const bytes = [id, ...subs].reduce((n, x) => {
      const t = reader.thread(x);
      try { return n + (t && t.rollout ? fs.statSync(files.existingRollout(t.rollout) || t.rollout).size : 0); } catch (_) { return n; }
    }, 0);
    let what = 'the rollout';
    if (subs.length) what += ` and ${subs.length} sub-agent conversation${subs.length === 1 ? '' : 's'}`;
    if (fs.existsSync(path.join(dir, `${id}.json`))) what += ', the work plan';
    if (fs.existsSync(path.join(dir, `${id}.wakeup`))) what += ', the wake-up';
    return `${what} (${sizeText(bytes)})`;
  };
  /* Removes Codex Plus's own data for conversations Codex has deleted: their side files in the plans' folder, the title
     colours the session list takes over once, and their entries in this window's recently closed tabs
     (src/tab-memory.js). Returns the files it could not remove. */
  const forgetDeleted = async (ids) => {
    const stuck = workplan.removeSideFiles(install.planDir(files.codexHome()), ids);
    try {
      const all = { ...(context.globalState.get(COLOR_KEY) || {}) };
      for (const id of ids) delete all[id];
      await context.globalState.update(COLOR_KEY, all);
    } catch (_) { /* the colours stay; nothing shows them */ }
    try { await memory.forget(ids); } catch (_) { /* Recently closed keeps the row until it drops off */ }
    return stuck;
  };
  /* Sends `method` for each of `ids`, then has the list read Codex's files again. A refusal matching `already` means it
     was done already, from another window say. */
  const sendEach = async (doing, method, ids, already) => {
    const answers = await askAppServerEach(ids.map((id) => [method, { threadId: id }]));
    const refused = [];
    ids.forEach((id, i) => {
      const r = answers[i];
      if (r.outcome === 'done' || (r.outcome === 'failed' && already.test(r.reason || ''))) return;
      refused.push(`"${nameOf(id)}" (${id}): ${r.outcome === 'sent' ? 'Codex did not answer' : r.reason}`);
    });
    if (ids.length) source._poll({ tell: true });
    if (!refused.length) return;
    say(`Could not ${doing}:\n  ${refused.join('\n  ')}`);
    vscode.window.showWarningMessage(`${refused.length} conversation${refused.length === 1 ? '' : 's'} could not be ${doing}d; the output "Codex Plus" lists them.`);
  };
  /*
   * Codex shows no archived conversation: a tab or its sidebar routed to one draws a new conversation instead. So one
   * opened from here is unarchived first.
   */
  /* Agent Plus, its session list included, brings forward a conversation shown in this window through reveal. When Codex
     has archived it, it is unarchived first and opened again in the tab or sidebar that shows it, since its page stays
     read-only until then. */
  const revealShown = source.reveal;
  source.reveal = async (sessionId, row) => {
    let unarchived = false;
    try { unarchived = await unarchiveToOpen(sessionId); } catch (_) { /* brought forward as it is */ }
    if (!unarchived) return revealShown.call(source, sessionId, row);
    let inSidebar = false;
    try { inSidebar = !tabs.codexTabs(vscode).some((t) => t.thread === sessionId) && patching.sidebarShowing() === sessionId; } catch (_) { inSidebar = false; }
    await vscode.commands.executeCommand(inSidebar ? 'codexPlus.openThreadInSidebar' : 'codexPlus.openThreadInTab', sessionId);
    return true;
  };
  unarchiveToOpen = async (id) => {
    /* Read afresh: a conversation archived a moment ago, in Codex or another window, is not in the last snapshot yet. */
    await readNow([id]);
    if (!(reader.thread(id) || {}).archived || restricted()) return false;
    await sendEach('unarchive', 'thread/unarchive', [id], /^no archived rollout found for thread id/);
    return true;
  };
  /* The daily pass over archived conversations (src/archive-sweep.js), with the same checks Delete makes. */
  holdArchived = async (ids) => {
    if (!openNow()) return null;
    await readNow([...new Set(ids.flatMap((id) => [id, ...subAgentsOf(id)]))]);
    const open = openNow(), elsewhere = elsewhereNow();
    if (!open) return null;
    const held = (x) => source.holdersOf(x);
    const away = ids.filter((id) => ![id, ...subAgentsOf(id)].some((x) => open.has(x) || busyNow(x))
      && [id, ...subAgentsOf(id)].some((x) => elsewhere.has(x) || held(x).length));
    for (const id of away) {
      const by = [id, ...subAgentsOf(id)].find((x) => elsewhere.has(x)) || [id, ...subAgentsOf(id)].find((x) => held(x).length);
      const where = elsewhere.has(by) ? windowNames(elsewhere.get(by)) : held(by)[0].label;
      say(`left for the next pass "${nameOf(id)}" (${id}), archived long enough to be deleted: ${by === id ? 'it' : `its sub-agent "${nameOf(by)}"`} is open in ${where}`);
    }
    return new Set(ids.filter((id) => away.includes(id) || [id, ...subAgentsOf(id)].some((x) => open.has(x) || busyNow(x))));
  };
  archiveSweeper = archiveSweep.createArchiveSweep({
    dir: () => path.join(context.globalStorageUri.fsPath, 'archive-sweep'),
    home: () => files.codexHome(),
    days: () => cfg().get('deleteArchivedAfterDays', 30),
    threads: () => reader.threads(),
    check: () => (!context.globalStorageUri ? 'there is no storage folder' : !trusted() ? 'the workspace is not trusted'
      : standsDown() ? 'this window runs a replaced build of Codex Plus' : listManages() ? 'Agent Plus\'s session list archives and deletes conversations' : ''),
    hold: (ids) => holdArchived(ids),
    remove: async (list) => {
      const subs = new Map(list.map((t) => [t.id, subAgentsOf(t.id)]));
      const titles = new Map(list.map((t) => [t.id, nameOf(t.id)]));
      const answers = await askAppServerEach(list.map((t) => ['thread/delete', { threadId: t.id }]));
      const deleted = [], failed = [], gone = [];
      list.forEach((t, i) => {
        const r = answers[i];
        if (r.outcome !== 'done' && !(r.outcome === 'failed' && /^no rollout found for thread id/.test(r.reason || ''))) {
          failed.push(`"${titles.get(t.id)}" (${t.id}): ${r.outcome === 'sent' ? 'Codex did not answer' : r.reason}`);
          return;
        }
        deleted.push({ id: t.id, title: titles.get(t.id) });
        gone.push(t.id, ...subs.get(t.id));
      });
      if (gone.length) failed.push(...await forgetDeleted(gone));
      if (list.length) source._poll({ tell: true });
      return { deleted, failed };
    },
    log: say,
  });
  /* ── Agent Plus's session list: what the Codex source gives it (src/session-list-source.js) ── */
  const core = link.registered ? link.core : null;
  /* Whether the list archives and deletes conversations in this window now, which this extension's own daily pass
     then leaves to it. Asked each time, so that an older Agent Plus, or one in Restricted Mode, gets the
     pass back. */
  listManages = () => { try { return !!core && typeof core.sessionListManages === 'function' && core.sessionListManages() === true; } catch (_) { return false; } };
  const sessionsChanged = new vscode.EventEmitter(), accountChanged = new vscode.EventEmitter();
  context.subscriptions.push(sessionsChanged, accountChanged, source.onDidChangeConversations(() => sessionsChanged.fire()));
  accountHeard = () => accountChanged.fire();
  /* The test for a thread of `folders`: in one of them, below one, or in a linked git worktree of their repositories;
     with no folders, every thread passes. treeOf names the worktree a thread is in, or gives '' for one in the folders
     themselves. */
  const inFolders = (folders) => {
    if (!Array.isArray(folders) || !folders.length) return Object.assign(() => true, { treeOf: () => '' });
    const memo = new Map();
    const test = folderTest(folders, memo);
    const trees = worktreesOf(folders).map((w) => ({ name: w.name, test: folderTest([w.path], memo) }));
    const treeOf = (t) => { const w = test(t.cwd) ? null : trees.find((x) => x.test(t.cwd)); return w ? w.name : ''; };
    return Object.assign((t) => test(t.cwd) || trees.some((x) => x.test(t.cwd)), { treeOf });
  };
  const baseFeatures = Object.getOwnPropertyDescriptor(source, 'features').get;
  Object.defineProperty(source, 'features', { configurable: true, enumerable: true,
    get: () => baseFeatures().concat(['sessions', 'sessionImport', 'sessionSeen', 'accountInfo']) });
  /* Deletes what the list asks to, except a conversation that is open or running here, open in another window or held
     open by another Codex process, or that has a sub-agent in that state. The list has already asked the user. */
  const deleteForList = async (ids) => {
    const results = [];
    if (!openNow()) return ids.map((id) => ({ sessionId: id, outcome: 'refused', reason: 'this window could not tell which conversations are open' }));
    await readNow([...new Set(ids.flatMap((id) => [id, ...subAgentsOf(id)]))]);
    const open = openNow() || new Set(ids), elsewhere = elsewhereNow();
    const gone = [];
    for (const id of ids) {
      const family = [id, ...subAgentsOf(id)];
      const by = family.find((x) => open.has(x) || busyNow(x)) || family.find((x) => elsewhere.has(x)) || family.find((x) => source.holdersOf(x).length);
      if (by) {
        const who = by === id ? 'it' : `its sub-agent "${nameOf(by)}"`;
        const held = source.holdersOf(by);
        const reason = elsewhere.has(by) && !open.has(by) ? `${who} is open in ${windowNames(elsewhere.get(by))}`
          : open.has(by) || busyNow(by) || !held.length ? `${who} is open or running` : `${who} is open in ${held[0].label}`;
        results.push({ sessionId: id, outcome: 'refused', reason });
        continue;
      }
      const subs = subAgentsOf(id);
      const r = await askAppServer('thread/delete', { threadId: id });
      const already = r.outcome === 'failed' && /^no rollout found for thread id/.test(r.reason || '');
      if (r.outcome !== 'done' && !already) { results.push({ sessionId: id, outcome: 'failed', reason: r.outcome === 'sent' ? 'Codex did not answer' : String(r.reason || '') }); continue; }
      say(`Deleted "${nameOf(id)}" (${id}) from the session list`);
      gone.push(id, ...subs);
      results.push({ sessionId: id, outcome: 'done' });
    }
    if (gone.length) await forgetDeleted(gone);
    source._poll({ tell: true });
    return results;
  };
  let importWait = '';
  const GOALS = { 'goal.pause': ['thread/goal/set', { status: 'paused' }], 'goal.resume': ['thread/goal/set', { status: 'active' }], 'goal.clear': ['thread/goal/clear', {}] };
  Object.assign(source, {
    async listSessions({ folders = [], cursor = null, limit = 500 } = {}) {
      await snapshotIn();
      const keep = inFolders(folders);
      const here = openNow() || new Set();
      const all = (reader.threads() || []).filter(keep).map((t) => {
        const s = sessionList.sessionOf(t, source.threadState(t.id), reader.goal(t.id), source.holdersOf(t.id), { here: here.has(t.id) });
        const tree = keep.treeOf(t);
        if (tree) s.worktree = tree.slice(0, 100);
        const viewed = source.viewedAt(t.id);
        if (viewed > 0) s.viewedAt = viewed;
        return s;
      });
      return sessionList.pageOf(all, cursor, limit);
    },
    onDidChangeSessions: sessionsChanged.event,
    sessionActions: Object.freeze({ open: ['tab', 'sidebar'], create: ['tab', 'sidebar'], rename: true, delete: true, own: sessionList.OWN }),
    async runSessionAction(action, sessionIds, args) {
      const ids = (Array.isArray(sessionIds) ? sessionIds : []).filter((id) => files.THREAD_ID.test(String(id)));
      const opts = args && typeof args === 'object' ? args : {};
      const failed = (id, reason, outcome = 'failed') => ({ sessionId: id, outcome, reason });
      try {
        if (action === 'open') {
          if (!ids[0]) return { results: [] };
          await vscode.commands.executeCommand(opts.where === 'sidebar' ? 'codexPlus.openThreadInSidebar' : 'codexPlus.openThreadInTab', ids[0]);
          return { results: [{ sessionId: ids[0], outcome: 'done' }] };
        }
        if (!trusted()) return { results: ids.map((id) => failed(id, 'Codex Plus changes nothing in Restricted Mode', 'refused')) };
        if (action === 'create') {
          await vscode.commands.executeCommand(opts.where === 'sidebar' ? 'codexPlus.newInSidebar' : 'codexPlus.newInTab');
          return { results: [{ sessionId: '', outcome: 'done' }] };
        }
        if (action === 'rename') {
          const id = ids[0], name = withoutEnvelope(String(opts.title || '')).replace(/\s+/g, ' ').trim();
          if (!id || !name) return { results: ids.map((x) => failed(x, 'no title', 'refused')) };
          const r = await askAppServer('thread/name/set', { threadId: id, name });
          source._poll();
          return { results: [r.outcome === 'done' ? { sessionId: id, outcome: 'done' } : failed(id, r.outcome === 'sent' ? 'Codex did not answer' : String(r.reason || ''))] };
        }
        if (action === 'delete') { await snapshotIn(); return { results: await deleteForList(ids) }; }
        if (GOALS[action]) {
          const [method, more] = GOALS[action];
          const answers = await askAppServerEach(ids.map((id) => [method, Object.assign({ threadId: id, origin: 'user' }, more)]));
          source._poll();
          return { results: ids.map((id, i) => (answers[i].outcome === 'done' ? { sessionId: id, outcome: 'done' } : failed(id, answers[i].outcome === 'sent' ? 'Codex did not answer' : String(answers[i].reason || '')))) };
        }
        return { results: ids.map((id) => failed(id, `Codex Plus has no action "${String(action).slice(0, 40)}"`, 'refused')) };
      } catch (e) { return { results: ids.map((id) => failed(id, (e && e.message) || String(e))) }; }
    },
    async describeDeletion(ids) {
      await snapshotIn();
      return (Array.isArray(ids) ? ids : []).filter((id) => files.THREAD_ID.test(String(id))).map((id) => ({ sessionId: id, what: describe(id, subAgentsOf(id)) }));
    },
    wantSessionDetail(ids) { try { source.wantState((Array.isArray(ids) ? ids : []).filter((id) => files.THREAD_ID.test(String(id)))); } catch (_) { /* the rows keep no dot */ } },
    async importSessions({ folders = [] } = {}) {
      await snapshotIn();
      /* Until Codex has filled its database, a conversation it archived may not be marked archived yet, and the list
         imports only once: returning null makes the list ask again on the next change. */
      const wait = !reader.threads() ? 'Codex\'s conversations have not been read yet' : !reader.backfilled() ? 'Codex is still filling its state database from the rollouts' : '';
      if (wait) { if (importWait !== wait) say(`the session list's import waits: ${wait}`); importWait = wait; return null; }
      importWait = '';
      const got = sessionList.importOf((reader.threads() || []).filter(inFolders(folders)), { sections: [...reader.sections()], pinnedSection: PINNED_SECTION,
        colors: context.globalState.get(COLOR_KEY) || {} });
      say(`the session list's import: ${got.archived.length} archived, ${got.groups.length} group(s), ${got.pinned.length} pinned`);
      return got;
    },
    noteSeen(ids, seen) { for (const id of Array.isArray(ids) ? ids : []) { if (seen) source.markRead(id); else source.markUnread(id); } },
    accountInfo({ sessionId = '' } = {}) {
      account.load().catch(() => { /* drawn as it was */ });
      return sessionList.accountOf(account.view(), sessionId ? source.threadState(sessionId) : null);
    },
    onDidChangeAccountInfo: accountChanged.event,
  });


}

/*
 * At start-up the plugin is installed without asking whenever Codex does not hold it as this extension carries it, as
 * Claude Code Plus registers its own (syncPlugin(false)): missing, another version, or other files under the same
 * version. Codex still asks the user to trust its hooks, which is trustPlugin's dialog. A plugin the user told Codex not
 * to load stays not loaded through such an install; the install command is what loads it again.
 */
async function ensurePlugin(context, say) {
  if (!trusted() || standsDown()) return;
  if (await followTokenMode(context, say) === 'loaded') return;
  if (!runs('workPlan')) { for (const k of Object.keys(problems)) problem(k, null); return; }
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

/* Eleven megabytes from python.org, and only ever from a command or a button the user pressed. It goes into the folder
   Agent Plus and its extensions share, so with Claude Code Plus installed too it is fetched once; a window runs one
   download at a time. */
const downloadPython = pythonOffer.single(async (context, say) => {
  if (!pythonRuntime.build()) {
    vscode.window.showInformationMessage('Codex Plus: python.org publishes an embeddable Python for Windows only. '
      + 'On this machine, install Python 3 and run "Codex Plus: Install the Work Plan Plugin into Codex".');
    return null;
  }
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Downloading Python ${pythonRuntime.VERSION} from python.org` },
    () => pythonRuntime.download(undefined, { userAgent: 'codex-plus' }));
  say(`python download: ${r.said}`);
  if (!r.ok) { vscode.window.showErrorMessage(`Codex Plus: downloading Python failed. ${r.said}`); return null; }
  return r;
});

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
  return pythonOffer.notice(pythonRuntime.pythons(context.globalStorageUri.fsPath), { download: 'codexPlus.downloadPython',
    install: 'codexPlus.installWorkPlanPlugin',
    without: 'Until then the plugin is in Codex without its hooks, MCP server and skill, so nothing writes a work plan.' });
}
const NOT_TRUSTED = { title: 'Codex does not run the work plan hooks yet', description: 'click to trust them',
  detail: 'Codex runs a plugin\'s hooks only after you trust them, and the work plan plugin\'s are not trusted. Until they are, the open '
    + 'rows of a plan are not put in front of the model each turn and nothing reminds it at the end of one.',
  command: 'codexPlus.trustWorkPlanHooks', arguments: [] };

/* With no Python the row says so. Where python.org has a build for this machine, the download is also offered, once per
   version on the machine (src/python-offer.js); after "Not now" the row is the only way to get it. */
function notePython(context, say, python) {
  problem('python', python ? null : noPython(context));
  if (python) return;
  pythonOffer.offer({ ask: (...a) => vscode.window.showInformationMessage(...a), get: () => downloadPython(context, say) })
    .then(async (got) => { if (got) await installPlugin(context, say, { interactive: false }); })
    .catch((e) => say(`offering Python: ${e.message}`));
}

async function installPlugin(context, say, { interactive, load }) {
  const stale = standsDown();
  if (stale) { if (interactive && stale === 'replaced') await offerReloadForStale(); return false; }
  const binary = codexProgram();
  if (!binary) {
    problem('install', notInstalled('Finding the codex program of the Codex extension', 'It is looked for in that extension\'s bin folder, and at chatgpt.cliExecutable when that is set.'));
    if (interactive) vscode.window.showErrorMessage('The codex program of the Codex extension was not found.');
    return false;
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
    const r = await install.install({ binary, home: files.codexHome(), stage, python, load: load !== undefined ? load : interactive ? true : 'keep' });
    say(`installed work plan plugin ${r.version} into ${files.codexHome()}${r.loaded === false ? '; Codex is still set not to load it' : ''}`);
    writeHookSettings(context);
    problem('install', null);
    notePython(context, say, python);
    await trustPlugin(say, { interactive: true });
    return true;
  } catch (e) {
    problem('install', notInstalled('Installing it into Codex', e.message));
    say(`installing the plugin failed: ${e.message}`);
    if (interactive) vscode.window.showErrorMessage(`Could not install the work plan plugin: ${e.message}`);
    return false;
  }
}

/*
 * The Interface features mode takes the plugin out of Codex, and the next mode puts it back (src/plugin-install.js
 * followTokenMode). One change at a time in this window, so that a quick change of mode and back cannot interleave
 * them. Codex reads which plugins to load when a conversation starts, so either applies to conversations started
 * afterwards.
 */
let following = Promise.resolve('left');
function followTokenMode(context, say) {
  following = following.then(async () => {
    const binary = codexProgram();
    if (!trusted() || standsDown() || !binary) return 'left';
    const home = files.codexHome();
    const r = await install.followTokenMode({ binary, home, unload: tokenMode.unloadsPlugin(tokenMode.modeNow(vscode)),
      load: () => installPlugin(context, say, { interactive: false, load: true }) });
    if (r === 'unloaded') say(`the token mode is Interface features, so Codex is set to skip the work plan plugin in ${home}`);
    if (r === 'loaded') say(`the token mode is ${tokenMode.labelOf(tokenMode.modeNow(vscode))}, so Codex loads the work plan plugin in ${home} again`);
    return r;
  }).catch((e) => { say(`the work plan plugin under the token mode: ${e.message}`); return 'failed'; });
  return following;
}

/* The line Show Status gives the token mode, with what it leaves running in Codex. */
function tokenModeLine() {
  const mode = tokenMode.modeNow(vscode);
  const what = tokenMode.SWITCHES.filter((s) => MODE_SWITCHES.includes(s.key))
    .map((s) => `${tokenMode.featureOf(s.feature).name} ${tokenMode.effective(vscode, s.key) ? 'on' : 'off'}`);
  return `Token mode: ${tokenMode.labelOf(mode)} (agentPlus.tokenMode); in Codex: ${what.join(', ')}`;
}

/*
 * Codex runs the plugin's hooks only once they are trusted, and every new version of the plugin needs trusting again.
 * The user decides: this lists what needs review and, only on their yes, writes the same trust Codex's own Settings >
 * Hooks page writes. What is trusted is exactly what was listed: if the hooks needing review, or the Codex home, changed
 * while the dialog was open, nothing is written and the new list is shown instead.
 */
const TRUST_ROUNDS = 3;
async function trustPlugin(say, { interactive, command = false }) {
  if (!trusted()) return;
  const binary = codexProgram();
  if (!binary) {
    if (command) vscode.window.showErrorMessage('The codex program of the Codex extension was not found.');
    return;
  }
  for (let round = 0; round < TRUST_ROUNDS; round++) {
    const home = files.codexHome();
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const cwds = folders.length ? folders : [home];
    let st;
    try { st = await install.hookStatus({ binary, home, cwds }); } catch (e) {
      say(`listing hooks failed: ${e.message}`);
      if (command) vscode.window.showErrorMessage(`Could not list the work plan hooks: ${e.message}`);
      return;
    }
    /* From the command the result is a notification; after an install it only goes to the status bar. */
    if (!st.review.length) {
      problem('trust', null);
      if (command) vscode.window.showInformationMessage('Codex Plus: Every work plan hook is trusted already.');
      else if (interactive) vscode.window.setStatusBarMessage('The work plan hooks are trusted.', 4000);
      return;
    }
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
  /* A patched Codex still running then finds no one to ask, and its button opens its sidebar again. */
  delete globalThis.__codexExtrasTabBar;
  delete globalThis.__codexExtrasNewPanelFragment;
  files.closeAll();
  try { uninstallPlan.finishUninstall(selfPath, [ID, ...uninstallPlan.FORMER_IDS]); } catch (_) { /* VS Code runs the hook later */ }
}

/* `_settings` is for the tests: the main switch only works if every part reads its settings from settings(), with the
   switch already applied, and the tests check that table directly.
   `_ensurePlugin` (the start-up install of the plugin), `_reopenDropped` (reopening dropped tabs) and `_loadRestored`
   (codexPlus.loadRestoredTabs) run after a delay during activation, so the tests call them directly. `_tokenModeLine`
   is Show Status's line for the token mode. `_sweepArchived` runs the pass over archived conversations that activation
   starts a minute in, and `_holdArchived` says which of the conversations given that pass would leave alone.
   `_removeSkillSearchLeftovers` deletes the skill search's files; activation also runs it a minute in. */
module.exports = { activate, deactivate, _settings: settings, _ensurePlugin: ensurePlugin, _reopenDropped: reopenDropped, _loadRestored: loadRestored,
  _tokenModeLine: tokenModeLine, _sweepArchived: () => (archiveSweeper ? archiveSweeper.run() : Promise.resolve(null)),
  _holdArchived: (ids) => (holdArchived ? holdArchived(ids) : Promise.resolve(null)), _removeSkillSearchLeftovers: removeSkillSearchLeftovers };
