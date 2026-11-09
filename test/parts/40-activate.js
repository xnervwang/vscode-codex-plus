// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * activate() itself, against a stand-in VS Code and a stand-in Agent Work Plan: the Codex source is registered with it,
 * the session list shows only once that registration was accepted, every command the manifest names is registered, and
 * Restricted Mode writes nothing.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

async function run(root, tmp, { core = 'accept', trusted = true, config = {}, takesRoute = false, probe = null, logDir = '', configToml = '' } = {}) {
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
  control.state.config = { codexHome: home, installWorkPlanPlugin: 'never', reopenDroppedTabs: false, patchCodex: 'off', ...config };
  const registered = [];
  if (core) {
    const registerSource = (s) => {
      registered.push(s);
      return core === 'accept' ? { accepted: true, code: '', reason: '', registration: { dispose() {} } }
        : { accepted: false, code: 'core-too-old', reason: 'protocol 1 is not one this host accepts (2)', registration: null };
    };
    control.state.extensions.set('xnervwang.agent-work-plan', { isActive: true, exports: core === 'bare' ? {} : { agentWorkPlan: { protocol: 1, accepts: [1], features: [], registerSource } } });
  }
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const globalState = fake.memento();
  const context = { subscriptions: subs, workspaceState: fake.memento(), globalState, globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root };
  if (logDir) context.logUri = vscode.Uri.file(logDir);
  await ext.activate(context);
  await new Promise((r) => setTimeout(r, 300));
  let hookSettings = null;
  try { hookSettings = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras', 'config.json'), 'utf8')); } catch (_) { /* none */ }
  const out = { state: control.state, registered, home, hookSettings, wroteSettings: fs.existsSync(path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras', 'config.json')) };
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
    [1, 'codex', 1], 'the Codex source is registered with Agent Work Plan, at protocol 1');
  eq(hosted.state.context['codexExtras.registered'], true, 'an accepted registration shows the session list');
  eq(hosted.state.views, ['codexExtras.sessions'], 'the session list is the only view this extension provides');
  eq(hosted.state.status.filter((s) => s.shown).length, 0, 'and nothing of its own is in the status bar while no conversation is waiting on anybody');
  eq(declared.filter((c) => !hosted.state.registered.includes(c)), [], 'every command in the manifest is registered');
  eq(hosted.wroteSettings, true, 'in a trusted window the hooks\' settings are written');
  const planPath = fs.readFileSync(path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks', 'plan_path.py'), 'utf8');
  const known = [...(/^DEFAULTS = \{([\s\S]*?)^\}/m.exec(planPath) || ['', ''])[1].matchAll(/^ {4}"(\w+)":/gm)].map((m) => m[1]);
  eq(Object.keys(hosted.hookSettings || {}).filter((k) => !known.includes(k)), [], 'every key written for the hooks is one plan_path.py knows');
  eq(hosted.hookSettings.compactTokenLimit, 0, 'with no compaction limit in config.toml the hooks are handed none');
  const limited = await run(root, tmp, { configToml: 'model_provider = "amazon-bedrock"\nmodel_auto_compact_token_limit = 150000\n' });
  eq(limited.hookSettings.compactTokenLimit, 150000, 'and with one set there, the hooks are handed it, since Codex compacts at it');

  /* Which account Codex uses: the model provider and its region in config.toml, in Show Status and Session Information. */
  {
    const w = await run(root, tmp, { configToml: 'model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "us-west-2"\n',
      probe: async ({ control, home }) => {
        const mark = control.state.log.length;
        await control.state.handlers['codexExtras.status']();
        const id = /([0-9a-f-]{36})\.jsonl$/.exec(fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).map(String).find((f) => f.endsWith('.jsonl')).replace(/\\/g, '/'))[1];
        await control.state.handlers['codexExtras.sessionInfo'](id);
        return { status: control.state.log.slice(mark).join('\n'), info: (control.state.picks[control.state.picks.length - 1] || []).map((p) => `${p.label}=${p.value}`) };
      } });
    eq([/^Account: Amazon Bedrock · us-west-2 /m.test(w.probed.status), w.probed.info.includes('Account=Amazon Bedrock · us-west-2')], [true, true],
      'Show Status and Session Information name the account as the provider and region Codex is set to use');
  }
  eq(hosted.state.said.length, 0, 'nothing is said when it is taken');

  /*
   * The status bar count of conversations stopped waiting for permission, which is hidden when there are none. The
   * input goes through the hook the patch calls, so this covers the whole way from an app-server request to the
   * status bar.
   */
  const waiting = await run(root, tmp, { probe: async ({ control, home }) => {
    const id = fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))[0];
    const thread = /([0-9a-f-]{36})\.jsonl$/.exec(String(id).replace(/\\/g, '/'))[1];
    globalThis.__codexExtrasAppServer('request', { id: 'q1', method: 'item/commandExecution/requestApproval', params: { threadId: thread } });
    const shown = [...control.state.status].reverse().find((s) => s.shown) || null;
    globalThis.__codexExtrasAppServer('answer', { id: 'q1' });
    const after = [...control.state.status].reverse().find((s) => s.shown) || null;
    return { text: shown && shown.text, command: shown && shown.command, tooltip: shown && shown.tooltip,
      hiddenAgain: !(after && after.shown) };
  } });
  eq([waiting.probed.text, waiting.probed.command, /One/.test(waiting.probed.tooltip || '')],
    ['$(bell-dot) 1 to decide', 'codexExtras.goToWaiting', true],
    'a conversation waiting for permission puts a count in the status bar, naming it on hover and going to it when clicked');
  eq(waiting.probed.hiddenAgain, true, 'and the count goes once the request is answered, rather than sitting there at nought');

  /* How long Codex's pages took to open: read from the Codex.log beside this extension's own log folder, by its own
     command and in Show Status. */
  {
    const logs = tmp('logs');
    const ours = path.join(logs, '20261109T010000', 'exthost1', 'xnervwang.codex-extras');
    fs.mkdirSync(path.join(path.dirname(ours), 'openai.chatgpt'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(ours), 'openai.chatgpt', 'Codex.log'), '2026-11-09 01:00:02.000 [info] '
      + 'client.performance.span backgroundDurationMs=0 clientPlatform=darwin durationMs=9320.4 hostType=extension '
      + 'initialSurface=thread marksMs={"renderer_entry_evaluated":6100.5,"shell_visible":7700.3,"thread_visible":9320.4} '
      + 'name=app_start outcome=success reason=null timingQuality=foreground wallDurationMs=9320.4\n');
    const w = await run(root, tmp, { logDir: ours, probe: async ({ control }) => {
      const before = control.state.log.length;
      await control.state.handlers['codexExtras.showOpenTimes']();
      const own = control.state.log.slice(before).join('\n');
      const mark = control.state.log.length;
      await control.state.handlers['codexExtras.status']();
      return { own, status: control.state.log.slice(mark).join('\n') };
    } });
    eq([/1 found/.test(w.probed.own), /thread +9\.3s .*\[this window\]/.test(w.probed.own), /Opening a Codex page.*1 found/.test(w.probed.status)],
      [true, true, true], 'its command writes how long this window\'s Codex page took to open, and Show Status includes it');
  }

  /* Session Information on a tab Codex opened with its own New button, whose URI names no conversation: the patch has
     tied its panel to the thread its own page started, and the command finds it through the source. */
  {
    const w = await run(root, tmp, { probe: async ({ vscode, control, home }) => {
      const id = /([0-9a-f-]{36})\.jsonl$/.exec(fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).map(String).find((f) => f.endsWith('.jsonl')).replace(/\\/g, '/'))[1];
      const provider = { postMessageToWebview() {}, sendMessageToPanel() {} };
      const panel = { webview: {}, visible: true, viewColumn: 1, reveal() {}, onDidDispose() {}, iconPath: null };
      globalThis.__codexExtrasPanel(panel, null, provider, '/extension/panel/new');
      globalThis.__codexExtrasPageRequest(panel.webview, { id: 7, method: 'thread/start' }, 'request');
      globalThis.__codexExtrasPageResponse(panel.webview, { id: 7, result: { thread: { id } } });
      await new Promise((r) => setTimeout(r, 200));
      control.setTabs([{ label: 'Codex', input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route',
        path: '/extension/panel/new' }), 'chatgpt.conversationEditor') }], 0);
      await control.state.handlers['codexExtras.sessionInfo']();
      const rows = (control.state.picks[control.state.picks.length - 1] || []).map((p) => `${p.label}=${p.value}`);
      return { id, rows, said: control.state.said.map((x) => x.message) };
    } });
    eq([w.probed.rows.includes(`Thread id=${w.probed.id}`), w.probed.said.some((m) => /Bring a Codex conversation tab/.test(m))], [true, false],
      'Session Information on a tab opened with Codex\'s New button shows the conversation that tab went on to start');
  }

  const refused = await run(root, tmp, { core: 'refuse' });
  eq([refused.state.context['codexExtras.registered'], refused.state.said.length], [false, 0],
    'a refused registration leaves the key off, and Agent Work Plan, not this extension, says which one to update');

  const bare = await run(root, tmp, { core: 'bare' });
  eq([bare.state.context['codexExtras.registered'], bare.state.said.map((s) => /Agent Work Plan has no agentWorkPlan interface/.test(s.message))],
    [false, [true]], 'with no interface to register with, it says so once');

  const restricted = await run(root, tmp, { trusted: false });
  if (restricted.registered.length === 1 && !restricted.wroteSettings) ok('in Restricted Mode it still registers, and writes nothing');
  else bad(`restricted: ${JSON.stringify([restricted.registered.length, restricted.wroteSettings])}`);

  /* ── the session list's own title bar: what a reader sees on it, and what is a click further away ── */
  const title = (pkg.contributes.menus['view/title'] || []).filter((m) => /codexExtras\.sessions/.test(m.when || ''));
  const onBar = title.filter((m) => /^navigation/.test(m.group || ''));
  const byCommand = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
  eq(onBar.length <= 4, true, `at most four buttons sit on the title bar, the rest in its ... menu (there are ${onBar.length})`);
  eq(onBar.sort((a, b) => a.group.localeCompare(b.group)).map((m) => m.command),
    ['codexExtras.newInTab', 'codexExtras.newInSidebar', 'codexExtras.findThread', 'codexExtras.refreshSessions'],
    'the two for opening a conversation come first, then search and refresh');
  eq(onBar.filter((m) => !byCommand.get(m.command) || !byCommand.get(m.command).icon).map((m) => m.command), [],
    'each of them has an icon, or it would show as a word on the bar');
  eq(title.filter((m) => !/^navigation/.test(m.group || '')).map((m) => m.command),
    ['codexExtras.showAllFolders', 'codexExtras.openSettings'], 'the ... menu holds the two that are not everyday actions');
  const menus = [].concat(...Object.values(pkg.contributes.menus)).map((m) => m.command);
  eq(menus.filter((c) => !byCommand.has(c)), [], 'every command a menu names is declared');

  /*
   * The tab bar's button starts a conversation and never raises one that is open: before this it opened the one last in
   * front, which with a single Codex tab already in front only moved the focus and looked like nothing happened. In a
   * tab it opens Codex's new-conversation route itself, naming the group in front, because Codex's own command asks for
   * the group of the text file last focused and so can put the conversation in a split.
   */
  {
    const w = await run(root, tmp, { config: { openButtonTarget: 'tab' }, takesRoute: true });
    const before = w.state.commands.length;
    await w.state.handlers['codexExtras.openCodex']();
    const ran = w.state.commands.slice(before);
    const [cmd, uri, viewType, options] = ran[0] || [];
    eq([ran.length, cmd, uri && uri.path, viewType, options && options.viewColumn, options && options.preview],
      [1, 'vscode.openWith', '/extension/panel/new', 'chatgpt.conversationEditor', 1, false],
      'in a tab it opens the new-conversation route itself, in the first editor group, and asks Codex for nothing more');
  }
  {
    // A split's narrow half is the group in front when its title bar button is pressed, so the group is a setting.
    const w = await run(root, tmp, { config: { openButtonTarget: 'tab', newConversationGroup: 'active' }, takesRoute: true });
    const before = w.state.commands.length;
    await w.state.handlers['codexExtras.openCodex']();
    const options = (w.state.commands.slice(before)[0] || [])[3];
    eq(options && options.viewColumn, -1, 'set to the group in front, it names that group instead of the first');
  }
  {
    const w = await run(root, tmp, { config: { openButtonTarget: 'tab' } });
    const before = w.state.commands.length;
    await w.state.handlers['codexExtras.openCodex']();
    eq(w.state.commands.slice(before).map((c) => c[0]), ['vscode.openWith', 'chatgpt.newCodexPanel'],
      'when the route leaves no conversation tab, Codex\'s own command is asked instead');
  }
  {
    const w = await run(root, tmp, { config: { openButtonTarget: 'sidebar' } });
    const before = w.state.commands.length;
    await w.state.handlers['codexExtras.openCodex']();
    eq(w.state.commands.slice(before).map((c) => c[0]), ['chatgpt.openSidebar'],
      'set to the sidebar it opens Codex\'s sidebar and no tab');
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
      await control.state.handlers['codexExtras.openThreadInSidebar'](id);
      await control.state.handlers['codexExtras.newInSidebar']();
      const ran = control.state.commands.slice(mark).map((c) => c[0]);
      control.state.externalAnswer = false;
      const mark2 = control.state.commands.length;
      await control.state.handlers['codexExtras.openThreadInSidebar'](id);
      await control.state.handlers['codexExtras.newInSidebar']();
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
