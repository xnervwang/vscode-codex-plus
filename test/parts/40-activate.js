// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * activate() itself, against a stand-in VS Code and a stand-in Agent Plus: the Codex source is registered with it,
 * the session list shows only once that registration was accepted, every command the manifest names is registered, and
 * Restricted Mode writes nothing.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

async function run(root, tmp, { core = 'accept', trusted = true, config = {}, takesRoute = false, probe = null, logDir = '', configToml = '',
  extensionPath = root } = {}) {
  const { vscode, control } = fake.create();
  vscode.workspace.isTrusted = trusted;
  vscode.workspace.onDidGrantWorkspaceTrust = () => ({ dispose() {} });
  fake.install(vscode);
  // Codex answers the new-conversation route by leaving a conversation tab in front; the stand-in does it on request.
  if (takesRoute) control.state.openWith = (u, viewType) => control.setTabs([{ label: 'Codex', input: new vscode.TabInputCustom(u, viewType) }], 0);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  if (configToml) fs.writeFileSync(path.join(home, 'config.toml'), configToml);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false, ...config };
  const registered = [];
  if (core) {
    const registerSource = (s) => {
      registered.push(s);
      return core === 'accept' ? { accepted: true, code: '', reason: '', registration: { dispose() {} } }
        : { accepted: false, code: 'core-too-old', reason: 'protocol 1 is not one this host accepts (2)', registration: null };
    };
    control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: core === 'bare' ? {} : { agentPlus: { protocol: 1, accepts: [1], features: [], registerSource } } });
  }
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const globalState = fake.memento({ 'codexPlus.patchRemoved': true });
  const context = { subscriptions: subs, workspaceState: fake.memento(), globalState, globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath };
  if (logDir) context.logUri = vscode.Uri.file(logDir);
  await ext.activate(context);
  await new Promise((r) => setTimeout(r, 300));
  let hookSettings = null;
  try { hookSettings = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras', 'config.json'), 'utf8')); } catch (_) { /* none */ }
  const out = { state: control.state, registered, home, hookSettings, storage: context.globalStorageUri.fsPath, wroteSettings: fs.existsSync(path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras', 'config.json')) };
  /* Asked while the extension is still up, since the lines below dispose it. */
  if (probe) out.probed = await probe({ vscode, control, home });
  for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
  ext.deactivate();
  return out;
}

module.exports = async ({ ok, bad, note, eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = pkg.contributes.commands.map((c) => c.command);

  const hosted = await run(root, tmp);
  eq([hosted.registered.length, hosted.registered[0] && hosted.registered[0].id, hosted.registered[0] && hosted.registered[0].protocol],
    [1, 'codex', 1], 'the Codex source is registered with Agent Plus, at protocol 1');
  eq(hosted.state.context['codexPlus.registered'], true, 'an accepted registration shows the session list');
  eq(hosted.state.views, ['codexPlus.sessions'], 'the session list is the only view this extension provides');
  eq(hosted.state.status.filter((s) => s.shown).length, 0, 'and nothing of its own is in the status bar while no conversation is waiting on anybody');
  eq(declared.filter((c) => !hosted.state.registered.includes(c)), [], 'every command in the manifest is registered');
  eq(hosted.wroteSettings, true, 'in a trusted window the hooks\' settings are written');
  const planPath = ['plan_path.py', 'plan_common.py', 'plan_agent.py']
    .map((f) => fs.readFileSync(path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks', f), 'utf8')).join('\n');
  const known = [...planPath.matchAll(/^(?:EXTRA_)?DEFAULTS = \{([\s\S]*?)^\}/gm)].flatMap((d) => [...d[1].matchAll(/^ {4}"(\w+)":/gm)].map((m) => m[1]))
    .concat([...planPath.matchAll(/\bgiven\.get\("(\w+)"\)/g)].map((m) => m[1]));
  eq(Object.keys(hosted.hookSettings || {}).filter((k) => !known.includes(k)), [], 'every key written for the hooks is one plan_path.py knows');
  eq(hosted.hookSettings.compactTokenLimit, 0, 'with no compaction limit in config.toml the hooks are handed none');
  eq(hosted.hookSettings.extensionMarkers, [hosted.storage],
    'and the window registers its global storage with them, which the hooks read as this extension still being installed');

  /* deactivate after an uninstall: this copy's folder marked for deletion, and no other copy beside it. */
  const leavingDir = tmp('extensions-leaving');
  const leavingSelf = path.join(leavingDir, `${pkg.publisher}.${pkg.name}-${pkg.version}`);
  fs.mkdirSync(leavingSelf);
  fs.writeFileSync(path.join(leavingDir, '.obsolete'), JSON.stringify({ [path.basename(leavingSelf)]: true }));
  const childProcess = require('child_process');
  const realSpawn = childProcess.spawn;
  const spawned = [];
  childProcess.spawn = (exe, args, opts) => { spawned.push({ args, detached: !!(opts && opts.detached) }); return { unref() {} }; };
  try {
    await run(root, tmp);
    const before = spawned.length;
    await run(root, tmp, { extensionPath: leavingSelf });
    eq([before, spawned.slice(before)], [0, [{ args: [path.join(leavingSelf, 'uninstall.js')], detached: true }]],
      'deactivate starts nothing on a reload, and on an uninstall starts the uninstall script in a process of its own');
  } finally { childProcess.spawn = realSpawn; }
  const limited = await run(root, tmp, { configToml: 'model_provider = "amazon-bedrock"\nmodel_auto_compact_token_limit = 150000\n' });
  eq(limited.hookSettings.compactTokenLimit, 150000, 'and with one set there, the hooks are handed it, since Codex compacts at it');

  /* Which account Codex uses: the model provider and its region in config.toml, in Show Status and Session Information. */
  {
    const w = await run(root, tmp, { configToml: 'model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "us-west-2"\n',
      probe: async ({ control, home }) => {
        const mark = control.state.log.length;
        await control.state.handlers['codexPlus.status']();
        const id = /([0-9a-f-]{36})\.jsonl$/.exec(fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).map(String).find((f) => f.endsWith('.jsonl')).replace(/\\/g, '/'))[1];
        /* Session information is the information button's, in the page of a tab showing the conversation. */
        const posted = [];
        const provider = { postMessageToWebview: (w, m) => posted.push(m), sendMessageToPanel() {} };
        const panel = { webview: {}, reveal() {}, onDidDispose() {}, iconPath: null };
        globalThis.__codexExtrasPanel(panel, id, provider);
        globalThis.__codexExtrasMessage(panel.webview, { kind: 'infoAsk', id: 'i1' }, provider);
        await new Promise((r) => setTimeout(r, 300));
        const rows = (posted.find((m) => m.type === 'codex-extras-info') || {}).rows || [];
        return { status: control.state.log.slice(mark).join('\n'), info: rows.map((p) => `${p.label}=${p.value}`) };
      } });
    eq([/^Account: Amazon Bedrock · us-west-2 /m.test(w.probed.status), w.probed.info.includes('Account=Amazon Bedrock · us-west-2')], [true, true],
      'Show Status and Session Information name the account as the provider and region Codex is set to use');
    eq([/^Token mode: All features \(agentPlus\.tokenMode\); in Codex: work plan on, time-zone note on, conversation brief on, skill suggestions on, wake-ups on$/m
      .test(w.probed.status), w.probed.info.includes('Token mode=All features')], [true, true],
    'and both say the token mode, Show Status with what it leaves running in Codex');
  }
  eq(hosted.state.said.length, 0, 'nothing is said when it is taken');

  /*
   * A conversation stopped waiting for permission is said where Claude Code says one is: its state in Conversations and
   * the dot on its tab. Nothing goes in the status bar, which Claude Code leaves alone too. The input goes through the
   * hook the patch calls, so this covers the whole way from an app-server request.
   */
  const waiting = await run(root, tmp, { probe: async ({ control, home }) => {
    const id = fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))[0];
    const thread = /([0-9a-f-]{36})\.jsonl$/.exec(String(id).replace(/\\/g, '/'))[1];
    globalThis.__codexExtrasAppServer('request', { id: 'q1', method: 'item/commandExecution/requestApproval', params: { threadId: thread } });
    const owed = require(path.join(root, 'src', 'patching.js')).approvalsOf(thread).decide;
    const shown = control.state.status.filter((s) => s.shown).length;
    globalThis.__codexExtrasAppServer('answer', { id: 'q1' });
    return { owed, shown };
  } });
  eq([waiting.probed.owed, waiting.probed.shown], [1, 0],
    'a conversation waiting for permission is counted as owing an answer, and nothing is put in the status bar for it');

  /* How long Codex's pages took to open: read from the Codex.log beside this extension's own log folder, by its own
     command and in Show Status. */
  {
    const logs = tmp('logs');
    const ours = path.join(logs, '20261109T010000', 'exthost1', 'xnervwang.codex-plus');
    fs.mkdirSync(path.join(path.dirname(ours), 'openai.chatgpt'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(ours), 'openai.chatgpt', 'Codex.log'), '2026-11-09 01:00:02.000 [info] '
      + 'client.performance.span backgroundDurationMs=0 clientPlatform=darwin durationMs=9320.4 hostType=extension '
      + 'initialSurface=thread marksMs={"renderer_entry_evaluated":6100.5,"shell_visible":7700.3,"thread_visible":9320.4} '
      + 'name=app_start outcome=success reason=null timingQuality=foreground wallDurationMs=9320.4\n');
    const w = await run(root, tmp, { logDir: ours, probe: async ({ control }) => {
      const before = control.state.log.length;
      await control.state.handlers['codexPlus.showOpenTimes']();
      const own = control.state.log.slice(before).join('\n');
      const mark = control.state.log.length;
      await control.state.handlers['codexPlus.status']();
      return { own, status: control.state.log.slice(mark).join('\n') };
    } });
    eq([/1 found/.test(w.probed.own), /thread +9\.3s .*\[this window\]/.test(w.probed.own), /Opening a Codex page.*1 found/.test(w.probed.status)],
      [true, true, true], 'its command writes how long this window\'s Codex page took to open, and Show Status includes it');
  }

  /* Session information for a tab opened with Codex's New button, whose URI names no conversation. The patch records
     the thread that page started as the panel's thread, and the information button in that page asks for it. */
  {
    const w = await run(root, tmp, { probe: async ({ vscode, control, home }) => {
      const id = /([0-9a-f-]{36})\.jsonl$/.exec(fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).map(String).find((f) => f.endsWith('.jsonl')).replace(/\\/g, '/'))[1];
      const posted = [];
      const provider = { postMessageToWebview: (w, m) => posted.push(m), sendMessageToPanel() {} };
      const panel = { webview: {}, visible: true, viewColumn: 1, reveal() {}, onDidDispose() {}, iconPath: null };
      globalThis.__codexExtrasPanel(panel, null, provider, '/extension/panel/new');
      globalThis.__codexExtrasPageRequest(panel.webview, { id: 7, method: 'thread/start' }, 'request');
      globalThis.__codexExtrasPageResponse(panel.webview, { id: 7, result: { thread: { id } } });
      await new Promise((r) => setTimeout(r, 200));
      control.setTabs([{ label: 'Codex', input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route',
        path: '/extension/panel/new' }), 'chatgpt.conversationEditor') }], 0);
      globalThis.__codexExtrasMessage(panel.webview, { kind: 'infoAsk', id: 'i2' }, provider);
      await new Promise((r) => setTimeout(r, 300));
      const rows = ((posted.find((m) => m.type === 'codex-extras-info') || {}).rows || []).map((p) => `${p.label}=${p.value}`);
      return { id, rows, said: control.state.said.map((x) => x.message) };
    } });
    eq([w.probed.rows.includes(`Thread=${w.probed.id}`), w.probed.said.some((m) => /Bring a Codex conversation tab/.test(m))], [true, false],
      'Session Information on a tab opened with Codex\'s New button shows the conversation that tab went on to start');
  }

  /* Find searches the conversations the list holds: this workspace's. */
  {
    const w = await run(root, tmp, { probe: async ({ vscode, control, home }) => {
      vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(tmp('another-workspace')) }];
      await control.state.handlers['codexPlus.findThread']();
      const elsewhere = control.state.quickPicks[control.state.quickPicks.length - 1].items.length;
      vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(home) }];
      await control.state.handlers['codexPlus.findThread']();
      const here = control.state.quickPicks[control.state.quickPicks.length - 1].items.map((i) => i.label);
      return { elsewhere, here };
    } });
    eq([w.probed.elsewhere, w.probed.here], [0, ['One']], 'Find lists this workspace\'s conversations only, as the session list does');
  }

  const refused = await run(root, tmp, { core: 'refuse' });
  eq([refused.state.context['codexPlus.registered'], refused.state.said.length], [false, 0],
    'a refused registration leaves the key off, and Agent Plus, not this extension, says which one to update');

  const bare = await run(root, tmp, { core: 'bare' });
  eq([bare.state.context['codexPlus.registered'], bare.state.said.map((s) => /Agent Plus has no agentPlus interface/.test(s.message))],
    [false, [true]], 'with no interface to register with, it says so once');

  const restricted = await run(root, tmp, { trusted: false });
  if (restricted.registered.length === 1 && !restricted.wroteSettings) ok('in Restricted Mode it still registers, and writes nothing');
  else bad(`restricted: ${JSON.stringify([restricted.registered.length, restricted.wroteSettings])}`);

  /* ── the session list's own title bar: empty, since the page draws New in tab, New in sidebar, search and New group ── */
  const title = (pkg.contributes.menus['view/title'] || []).filter((m) => /codexPlus\.sessions/.test(m.when || ''));
  const byCommand = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
  eq(title.map((m) => m.command), [], 'the bar holds nothing: the list\'s own buttons are in the list, as Claude Code\'s are, and it redraws itself, so there is no Refresh');
  const menus = [].concat(...Object.values(pkg.contributes.menus)).map((m) => m.command);
  eq(menus.filter((c) => !byCommand.has(c)), [], 'every command a menu names is declared');

  /*
   * The tab bar's button starts a conversation in a tab and never raises one that is open: before this it opened the one
   * last in front, which with a single Codex tab already in front only moved the focus and looked like nothing
   * happened. It opens Codex's new-conversation route itself, naming the editor group Claude Code's own Open command
   * would pick, because Codex's own command asks for the group of the text file last focused and so can put the
   * conversation in a split.
   */
  {
    const w = await run(root, tmp, { takesRoute: true });
    const before = w.state.commands.length;
    await w.state.handlers['codexPlus.tabBarNewInTab']();
    const ran = w.state.commands.slice(before);
    const [cmd, uri, viewType, options] = ran[0] || [];
    eq([ran.length, cmd, uri && uri.path, viewType, options && options.viewColumn, options && options.preview],
      [1, 'vscode.openWith', '/extension/panel/new', 'chatgpt.conversationEditor', 1, false],
      'in a window of one empty group it opens the new-conversation route itself in that group, and asks Codex for nothing more');
  }
  {
    const w = await run(root, tmp);
    const before = w.state.commands.length;
    await w.state.handlers['codexPlus.tabBarNewInTab']();
    eq(w.state.commands.slice(before).map((c) => c[0]), ['vscode.openWith', 'chatgpt.newCodexPanel'],
      'when the route leaves no conversation tab, Codex\'s own command is asked instead');
  }
  {
    /* Open Codex, in the command palette, with codexPlus.tabBarButton set to sidebar does what New in sidebar does. */
    const w = await run(root, tmp, { takesRoute: true, config: { tabBarButton: 'sidebar' } });
    const before = w.state.commands.length;
    await w.state.handlers['codexPlus.openCodex']();
    eq(w.state.commands.slice(before).map((c) => c[0]).includes('vscode.openWith'), false,
      'with codexPlus.tabBarButton set to sidebar Open Codex opens no tab');
    eq(w.state.commands.slice(before).map((c) => c[0]).includes('codexPlus.newInSidebar'), true,
      'and starts a new conversation in the sidebar instead');
  }
  {
    /*
     * Codex's own tab bar button with the host patch's "tab bar button" edit, which hands the click to this extension
     * first. VS Code's editor title menu calls the command with the editor's resource and { groupId }; keybindings, the
     * command palette and other extensions pass neither.
     */
    const vm = require('vm');
    const host = require(path.join(root, 'src', 'host.js'));
    const edit = host.EDITS.find((e) => e.name === 'tab bar button');
    const code = edit ? 'commands.registerCommand("chatgpt.openSidebar",open);'.replace(edit.re, edit.to) : '';
    const sandbox = { calls: [], handlers: {} };
    sandbox.commands = { registerCommand: (n, f) => { sandbox.handlers[n] = f; } };
    sandbox.open = (...a) => { sandbox.calls.push(a.length); return 'sidebar'; };
    if (code) vm.runInNewContext(code, sandbox);
    const button = sandbox.handlers['chatgpt.openSidebar'] || (() => undefined);
    const results = [button({ scheme: 'file', path: '/w/a.ts' }, { groupId: 1 })];
    sandbox.__codexExtrasTabBar = (args) => args.length > 0;
    results.push(button({ scheme: 'file', path: '/w/a.ts' }, { groupId: 1 }), button());
    sandbox.__codexExtrasTabBar = () => { throw new Error('broken'); };
    results.push(button({ groupId: 2 }));
    eq([!!edit, results, sandbox.calls], [true, ['sidebar', undefined, 'sidebar', 'sidebar'], [2, 0, 1]],
      'the patched command runs Codex\'s own function unless this extension takes the click: '
      + 'without this extension, for a call with no arguments, and when this extension fails');

    const fromBar = [{ scheme: 'file', path: '/w/a.ts', fsPath: '/w/a.ts' }, { groupId: 1 }];
    /* Asked while the extension is up: run() deactivates it before it returns. */
    const asked = (calls) => async ({ control }) => {
      const take = globalThis.__codexExtrasTabBar || (() => null);
      const before = control.state.commands.length;
      const took = calls.map((args) => take(args));
      await new Promise((r) => setTimeout(r, 50));
      return { took, tabs: control.state.commands.slice(before).filter((c) => c[0] === 'vscode.openWith').length };
    };
    const w = await run(root, tmp, { takesRoute: true, probe: asked([fromBar, [], [{ groupId: 1 }]]) });
    eq([w.probed.took, w.probed.tabs], [[true, false, true], 2],
      'with codexPlus.tabBarButton at tab, a click on Codex\'s button starts a conversation in a tab, and a call from anywhere else is left to Codex');
    const side = await run(root, tmp, { takesRoute: true, config: { tabBarButton: 'sidebar' }, probe: asked([fromBar]) });
    const off = await run(root, tmp, { takesRoute: true, config: { enabled: false }, probe: asked([fromBar]) });
    eq([side.probed.took, off.probed.took], [[false], [false]], 'set to sidebar, or with the additions off, the click is Codex\'s own: it opens Codex\'s sidebar');
    eq(typeof globalThis.__codexExtrasTabBar, 'undefined', 'and once this extension is deactivated a patched Codex has no one to ask, so its button is Codex\'s again');
  }
  {
    /* The group choice on its own, against the tab groups Claude Code's choice is made from. */
    const tabsMod = require(path.join(root, 'src', 'codex-tabs.js'));
    const { vscode, control } = fake.create();
    const file = control.fileTab('/work/a.js'), codex = control.codexTab('01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31');
    const layout = (...groups) => {
      control.groups.length = 0;
      groups.forEach(([tabs, active], i) => control.groups.push({ viewColumn: i + 1, tabs, activeTab: tabs[0] || null, isActive: !!active }));
      control.state.commands.length = 0;
    };
    layout([[file], true], [[file, codex]], [[codex]]);
    eq(await tabsMod.codexGroup(vscode), 3, 'a group holding only Codex tabs is taken before a mixed one, and before the group in front');
    layout([[file], true], [[file, codex]]);
    eq(await tabsMod.codexGroup(vscode), 2, 'failing that, a group holding any Codex tab');
    layout([[file, codex]], [[codex], true], [[codex]]);
    eq(await tabsMod.codexGroup(vscode), 2, 'and of several such groups, the one in front');
    layout([[file], true]);
    eq([await tabsMod.codexGroup(vscode), control.state.commands.map((c) => c[0])], [1, []],
      'with no Codex tab, the main editor area, and no new group is opened beside it');
    layout([[file]], [[file], true]);
    control.state.config = { openSideBySideDirection: 'down' };
    eq([await tabsMod.codexGroup(vscode), control.state.commands.map((c) => c[0])], [1, []],
      'the first group even when a split is the one in front, whichever way splits open');
  }
  /*
   * Resume in Sidebar and New in Sidebar go through Codex's own URI handler, which focuses its sidebar and navigates it,
   * so neither needs the patch. The link uses this editor's own scheme. When Codex does not take it, a conversation
   * opens in a tab instead and a new one through Codex's own commands.
   */
  {
    const id = '01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31';
    const w = await run(root, tmp, { probe: async ({ vscode, control }) => {
      vscode.env.uriScheme = 'vscode-insiders';
      const mark = control.state.commands.length;
      await control.state.handlers['codexPlus.openThreadInSidebar'](id);
      await control.state.handlers['codexPlus.newInSidebar']();
      const ran = control.state.commands.slice(mark).map((c) => c[0]);
      control.state.externalAnswer = false;
      const mark2 = control.state.commands.length;
      await control.state.handlers['codexPlus.openThreadInSidebar'](id);
      await control.state.handlers['codexPlus.newInSidebar']();
      return { external: control.state.external.slice(), ran, refused: control.state.commands.slice(mark2).map((c) => c[0]) };
    } });
    eq([w.probed.external.slice(0, 2), w.probed.ran],
      [[`vscode-insiders://openai.chatgpt/local/${id}`, 'vscode-insiders://openai.chatgpt/'], []],
      'Resume in Sidebar and New in Sidebar open Codex\'s own link for the route, in this editor\'s scheme, and run nothing else');
    eq(w.probed.refused, ['vscode.openWith', 'chatgpt.openSidebar', 'chatgpt.newChat'],
      'when Codex does not take the link, the conversation opens in a tab and a new one through Codex\'s own commands');
  }

  /* The Codex commands this extension runs, against the Codex installed here: New in sidebar needs no patch, since
     Codex contributes both commands it uses. */
  const ours = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const called = [...new Set((ours.match(/'chatgpt\.[A-Za-z]+'/g) || []).map((s) => s.slice(1, -1)))].sort();
  eq(called, ['chatgpt.newChat', 'chatgpt.newCodexPanel', 'chatgpt.openSidebar'], 'it runs three commands of Codex\'s own');
  const dirs = [];
  for (const base of [path.join(require('os').homedir(), '.vscode-server', 'extensions'), path.join(require('os').homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch (_) { continue; }
    for (const n of names) if (/^openai\.chatgpt-/.test(n)) dirs.push(path.join(base, n));
  }
  if (!dirs.length) note('no Codex extension installed here: the commands it contributes were not checked');
  for (const dir of dirs) {
    let codex;
    try { codex = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) { continue; }
    const has = new Set((codex.contributes.commands || []).map((c) => c.command));
    eq(called.filter((c) => !has.has(c)), [], `${path.basename(dir)} contributes all three`);
    eq((codex.activationEvents || []).includes('onUri'), true, `${path.basename(dir)} starts on a link to it, which Resume in Sidebar relies on`);
  }
};
