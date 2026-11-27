// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * How Codex Plus follows the token mode, agentPlus.tokenMode.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const KEYS = ['codexPlus.workPlan', 'codexPlus.tellCodexYourTimeZone', 'codexPlus.conversationBrief', 'codexPlus.wakeUps',
  'codexPlus.detachedEndNotices'];

/* A codex program whose app-server acts on the requests as Codex does: plugin/install copies the plugin into its cache,
   and it and config/batchWrite write `enabled` into config.toml. Its one hook is never trusted. Every request is logged
   to fake-codex-requests.jsonl. */
const FAKE_APP_SERVER = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME;
const config = path.join(home, 'config.toml');
let buf = '';
const answer = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
const setEnabled = (keyPath, value) => {
  const m = /^plugins\\.("[^"]+")\\.enabled$/.exec(keyPath);
  if (!m) return;
  const header = '[plugins.' + m[1] + ']';
  let text = '';
  try { text = fs.readFileSync(config, 'utf8'); } catch (_) { text = ''; }
  const parts = text.split('\\n\\n').filter((s) => s.trim() && !s.startsWith(header));
  parts.push(header + '\\nenabled = ' + (value ? 'true' : 'false'));
  fs.writeFileSync(config, parts.join('\\n\\n') + '\\n');
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    fs.appendFileSync(path.join(home, 'fake-codex-requests.jsonl'), JSON.stringify({ method: msg.method, edits: (msg.params && msg.params.edits) || null }) + '\\n');
    if (msg.method === 'marketplace/add') answer(msg.id, { installedRoot: msg.params.source });
    else if (msg.method === 'plugin/install') {
      const stage = path.dirname(path.dirname(path.dirname(msg.params.marketplacePath)));
      const plugin = path.join(stage, msg.params.pluginName);
      const version = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8')).version;
      const into = path.join(home, 'plugins', 'cache', 'codex-extras', msg.params.pluginName, version);
      fs.rmSync(into, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(into), { recursive: true });
      fs.cpSync(plugin, into, { recursive: true });
      const key = 'plugins.' + JSON.stringify(msg.params.pluginName + '@codex-extras') + '.enabled';
      let text = '';
      try { text = fs.readFileSync(config, 'utf8'); } catch (_) { text = ''; }
      if (!text.includes('[plugins.' + JSON.stringify(msg.params.pluginName + '@codex-extras') + ']')) setEnabled(key, true);
      answer(msg.id, {});
    } else if (msg.method === 'hooks/list') answer(msg.id, { data: [{ hooks: [{ pluginId: 'agent-work-plan@codex-extras', key: 'k', eventName: 'Stop',
      command: 'stop', trustStatus: 'untrusted', currentHash: 'h' }] }] });
    else if (msg.method === 'config/batchWrite') { for (const e of msg.params.edits || []) setEnabled(e.keyPath, e.value); answer(msg.id, { status: 'ok' }); }
    else answer(msg.id, {});
  }
});
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, note, tmp, root }) => {
  const tm = require(path.join(root, 'src', 'token-mode.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const props = Object.assign({}, ...[].concat(pkg.contributes.configuration).map((c) => c.properties || {}));
  eq(KEYS.filter((k) => !(props[k].markdownDescription || '').endsWith(` ${tm.ONLY_IN_CUSTOM}`)), [],
    'each of the five settings the token mode decides ends its description saying it is used only in Custom, with a link to the mode');
  eq(tm.SWITCHES.filter((s) => s.extension === 'xnervwang.codex-plus').map((s) => s.key), KEYS, 'and they are the five src/token-mode.js lists for Codex Plus');
  eq(tm.SWITCHES.filter((s) => s.key.startsWith('codexPlus.')).every((s) => props[s.key] && props[s.key].default === s.default), true,
    'with the defaults this extension declares');
  const doc = fs.readFileSync(path.join(root, 'docs', 'token-costs.md'), 'utf8');
  const table = /^# What it costs in tokens\n\n(?:[^|#\n][^\n]*\n\n)*((?:\|[^\n]*\n)+)/.exec(doc);
  eq([!!table && table[1].split('\n')[0], !!table && KEYS.every((k) => table[1].includes(`\`${k}\``))],
    ['| Feature | Interface features | Essential features | All features | Custom |', true],
    'docs/token-costs.md, after its opening paragraphs, has a table of the four modes, naming each feature\'s setting under Custom');

  /* Activates the extension with `config`, collecting every configuration listener so a change can be told to all. */
  const start = async (config, { codex = '', globalState, codexVersion = '' } = {}) => {
    const { vscode, control } = fake.create();
    const heard = [];
    vscode.workspace.onDidChangeConfiguration = (fn) => { heard.push(fn); return { dispose() {} }; };
    fake.install(vscode);
    for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
    const home = tmp('home');
    fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
    process.env.CODEX_HOME = home;
    control.state.config = Object.assign({ reopenDroppedTabs: false }, codex ? { cliExecutable: codex } : {}, config);
    const registered = [];
    if (codexVersion) control.state.extensions.set('openai.chatgpt', { isActive: false, packageJSON: { version: codexVersion }, extensionPath: tmp('codex-ext') });
    control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
      registerSource: (s) => { registered.push(s); return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
    const ext = require(path.join(root, 'extension.js'));
    const install = require(path.join(root, 'src', 'plugin-install.js'));
    const subs = [];
    const context = { subscriptions: subs, workspaceState: fake.memento(), globalState: globalState || fake.memento({ 'codexPlus.patchRemoved': true }),
      globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root };
    await ext.activate(context);
    const hooks = () => { try { return JSON.parse(fs.readFileSync(path.join(install.planDir(home), 'config.json'), 'utf8')); } catch (_) { return {}; } };
    const change = (set) => {
      Object.assign(control.state.config, set);
      for (const fn of heard) fn({ affectsConfiguration: (k) => Object.keys(set).some((c) => c === k || c.startsWith(k + '.') || (k === 'codexPlus' && !c.includes('.'))
        || `codexPlus.${c}` === k) });
    };
    const close = () => { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } ext.deactivate(); };
    return { vscode, control, ext, install, home, context, source: registered[0], hooks, change, close };
  };
  const given = (h) => [h.enabled, h.tellTimeZone, h.brief];

  /* ── What the hooks are given and what the source reports, in each mode ── */
  {
    const off = { workPlan: false, tellCodexYourTimeZone: false, conversationBrief: false, wakeUps: false,
      detachedEndNotices: false };
    const got = {};
    for (const mode of ['interface', 'essential', 'all', 'custom']) {
      const w = await start({ ...off, 'agentPlus.tokenMode': mode });
      got[mode] = [given(w.hooks()), w.source.features, w.ext._tokenModeLine()];
      w.close();
    }
    const unset = await start({});
    got.unset = [given(unset.hooks()), unset.source.features];
    unset.close();
    eq(got, {
      interface: [[false, false, false], ['openHere', 'shows', 'shownIn', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'accountInfo'], 'Token mode: Interface features (agentPlus.tokenMode); in Codex: work plan off, time-zone note off, conversation brief off, wake-ups off, notices when a detached command stops off'],
      essential: [[true, true, false], ['openHere', 'shows', 'shownIn', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'accountInfo'], 'Token mode: Essential features (agentPlus.tokenMode); in Codex: work plan on, time-zone note on, conversation brief off, wake-ups off, notices when a detached command stops off'],
      all: [[true, true, true], ['brief', 'openHere', 'shows', 'shownIn', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'accountInfo'], 'Token mode: All features (agentPlus.tokenMode); in Codex: work plan on, time-zone note on, conversation brief on, wake-ups on, notices when a detached command stops on'],
      custom: [[false, false, false], ['openHere', 'shows', 'shownIn', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'accountInfo'], 'Token mode: Custom (agentPlus.tokenMode); in Codex: work plan off, time-zone note off, conversation brief off, wake-ups off, notices when a detached command stops off'],
      unset: [[true, true, true], ['brief', 'openHere', 'shows', 'shownIn', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'accountInfo']],
    }, 'every setting turned off: each mode decides as its table says, Custom follows the settings, and nothing set is All features');
  }

  /* ── A change of mode, and of a setting outside Custom ── */
  {
    const w = await start({ conversationBrief: false });
    let fired = 0;
    w.source.onDidChangeConversations(() => { fired++; });
    const before = [given(w.hooks()), w.source.features];
    w.change({ 'agentPlus.tokenMode': 'essential' });
    const essential = [given(w.hooks()), w.source.features, fired];
    w.change({ 'agentPlus.tokenMode': 'custom' });
    const custom = [given(w.hooks()), w.source.features, fired];
    w.change({ 'agentPlus.tokenMode': 'all' });
    const all = [given(w.hooks()), w.source.features, fired];
    eq([before, essential, custom, all], [[[true, true, true], ['brief', 'openHere', 'shows', 'shownIn', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'accountInfo']], [[true, true, false], ['openHere', 'shows', 'shownIn', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'accountInfo'], 1],
      [[true, true, false], ['openHere', 'shows', 'shownIn', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'accountInfo'], 2], [[true, true, true], ['brief', 'openHere', 'shows', 'shownIn', 'prefill', 'sessions', 'sessionImport', 'sessionSeen', 'accountInfo'], 3]],
    'a change of mode rewrites config.json at once and tells Agent Plus the conversations changed; back in Custom the settings are as they were');
    eq(w.control.state.said.filter((s) => /token mode/.test(s.message)).length, 0, 'changing the mode itself says nothing');

    w.control.answer('codexPlus.wakeUps has no effect', tm.SWITCH_BUTTON);
    w.change({ wakeUps: false });
    w.change({ wakeUps: true });
    await wait(10);
    eq(w.control.state.said.filter((s) => /token mode/.test(s.message)).map((s) => [s.message, s.buttons]),
      [['Codex Plus: the token mode is All features, so codexPlus.wakeUps has no effect until the mode is Custom.', ['Switch to Custom']]],
      'outside Custom, a change of one of the five says once which mode is in effect, with a button');
    eq((w.control.state.configWrites || []).filter((x) => x[0] === 'agentPlus.tokenMode'), [['agentPlus.tokenMode', 'custom']],
      'and the button switches the mode to Custom');
    w.close();
  }

  /* ── Interface features takes the plugin out of Codex, and the next mode puts it back ── */
  if (process.platform === 'win32') { note('the stand-in codex is a shell script, so the plugin is not taken out and put back here'); return; }
  {
    const bin = tmp('fake-codex-mode');
    fs.writeFileSync(path.join(bin, 'app-server.js'), FAKE_APP_SERVER);
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'app-server.js'))}\n`);
    fs.chmodSync(codex, 0o755);
    const w = await start({}, { codex });
    const marker = path.join(w.install.planDir(w.home), w.install.UNLOADED_MARKER);
    const state = () => [w.install.pluginLoadState(w.home), fs.existsSync(marker)];
    const say = () => {};
    await w.ext._ensurePlugin(w.context, say);
    const installed = [w.install.installState(w.home).why, ...state()];
    w.control.state.config['agentPlus.tokenMode'] = 'interface';
    await w.ext._ensurePlugin(w.context, say);
    const unloaded = state();
    await w.ext._ensurePlugin(w.context, say);
    const again = state();
    w.control.state.config['agentPlus.tokenMode'] = 'essential';
    await w.ext._ensurePlugin(w.context, say);
    const back = [w.install.installState(w.home).why, ...state()];
    eq([installed, unloaded, again, back], [['current', 'loaded', false], ['not loaded', true], ['not loaded', true], ['current', 'loaded', false]],
      'Interface features has Codex skip the plugin and marks that the mode did it; the next mode loads it again and removes the mark');

    /* Stopped by hand, it stays stopped through Interface features and out of it. */
    await w.install.setPluginEnabled({ binary: codex, home: w.home, enabled: false });
    w.control.state.config['agentPlus.tokenMode'] = 'interface';
    await w.ext._ensurePlugin(w.context, say);
    const byHand = state();
    w.control.state.config['agentPlus.tokenMode'] = 'all';
    await w.ext._ensurePlugin(w.context, say);
    eq([byHand, state()], [['not loaded', false], ['not loaded', false]], 'a plugin the user stopped loading is left as it is');

    /* A change of mode in the window does the same, without a restart. */
    await w.install.setPluginEnabled({ binary: codex, home: w.home, enabled: true });
    w.change({ 'agentPlus.tokenMode': 'interface' });
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await wait(50);
    for (let i = 0; i < 100 && w.install.pluginLoadState(w.home) !== 'not loaded'; i++) await wait(50);
    const changedIn = state();
    w.change({ 'agentPlus.tokenMode': 'custom' });
    for (let i = 0; i < 200 && fs.existsSync(marker); i++) await wait(50);
    eq([changedIn, state()], [['not loaded', true], ['loaded', false]], 'choosing Interface features in the window takes the plugin out, and choosing another puts it back');
    const asked = () => w.control.state.said.filter((x) => /Trust the work plan hooks/.test(x.message)).length;
    const startUp = asked();
    await w.ext._ensurePlugin(w.context, say);
    const askedBefore = asked();
    w.change({ 'agentPlus.tokenMode': 'essential' });
    await wait(500);
    eq([askedBefore - startUp, asked() - askedBefore], [1, 0],
      'starting up asks to trust hooks not yet trusted, and a change of mode between the other three does not ask again');
    const status = [];
    w.control.state.config['agentPlus.tokenMode'] = 'interface';
    await w.ext._ensurePlugin(w.context, say);
    const mark = w.control.state.log.length;
    await w.control.state.handlers['codexPlus.status']();
    status.push(...w.control.state.log.slice(mark).join('\n').split('\n').filter((l) => l.startsWith('Work plan plugin:') || l.startsWith('Token mode:')));
    eq([status.length, /not loaded, as the Interface features token mode has it/.test(status.join('\n')), /^Token mode: Interface features/m.test(status.join('\n'))],
      [2, true, true], 'Show Status says the mode, and that the plugin is not loaded because of it');
    w.close();
  }

  /* ── The note on images in replies: given only with codexPlus.replyImages on and a Codex build this extension has been
     checked against, whatever the token mode ── */
  {
    const supported = require(path.join(root, 'src', 'supported.js'));
    const checked = supported.versions()[0];
    const got = [];
    for (const [config, version] of [[{}, checked], [{ replyImages: false }, checked], [{}, '0.0.1'], [{ enabled: false }, checked],
      [{ 'agentPlus.tokenMode': 'essential' }, checked]]) {
      const w = await start(config, { codexVersion: version });
      got.push(w.hooks().replyImages);
      w.close();
    }
    eq(got, [true, false, false, false, true],
      'the hooks are told to give the note on images only while the setting is on and the installed Codex is a build checked against, in any token mode');
  }
};
