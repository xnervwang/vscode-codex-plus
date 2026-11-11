// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * codexPlus.contextWindow gives each model listed its own context window (src/context-window.js). A listed model's
 * value goes into config.toml when it is the default model, and into the config overrides of every page request that
 * opens a conversation using that model. A value the user wrote into config.toml is left alone, and the meter's hover
 * box shows where the window came from.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const prop = pkg.contributes.configuration.properties['codexPlus.contextWindow'];
  eq(prop && [prop.type, prop.default, prop.additionalProperties && prop.additionalProperties.type],
    ['object', {}, 'string'], 'codexPlus.contextWindow is a table of model to window, empty by default');
  eq(!!prop && /1\.05M/.test(prop.markdownDescription) && /reload/i.test(prop.markdownDescription)
    && /developers\.openai\.com\/api\/docs\/models/.test(prop.markdownDescription),
  true, 'its description gives the most, where it comes from, and that an open conversation needs a reload');

  const cw = require(path.join(root, 'src', 'context-window.js'));

  /* ── the value written for a window the user names ── */
  eq(['1.05M', '512K', '400,000', 300000, '0', 'big', ''].map(cw.parseWindow), [1050000, 512000, 400000, 300000, null, null, null],
    'a window is a number of tokens, written as it is or with K or M');
  const MAP = { 'gpt-6.1-sol': '1.05M', 'gpt-6-luna': '512K', 'my-model': '200000' };
  eq(['gpt-6.1-sol', 'openai.gpt-6.1-sol', 'us.openai.gpt-6.1-sol', 'gpt-6-luna', 'my-model', 'gpt-6-sol']
    .map((m) => { const v = cw.valueFor(MAP, m); return v && [v.key, v.text, v.value]; }),
  [['gpt-6.1-sol', '1.05M', 917000], ['gpt-6.1-sol', '1.05M', 917000], ['gpt-6.1-sol', '1.05M', 917000],
    ['gpt-6-luna', '512K', 384000], ['my-model', '200000', 200000], null],
  'a published model\'s window loses its 128K of output and stays under the largest input Bedrock took; a Bedrock name finds its model; '
    + 'a model with no published window is written as given; a model with no entry has none');
  eq(cw.valueFor({ 'openai.gpt-6.1-sol': '2M' }, 'gpt-6.1-sol'), { key: 'openai.gpt-6.1-sol', shown: 1050000, text: '1.05M', value: 917000 },
    'a window over the published one is the published one');
  eq(cw.valueFor({ 'gpt-6.1-sol': '100K' }, 'gpt-6.1-sol'), null, 'and one that leaves no room for input is not used');

  /* ── config.toml's value, for the model a new conversation starts with ── */
  const memento = fake.memento();
  const sent = [];
  let refuse = false;
  const ask = async (method, params) => { sent.push([method, params]); return refuse ? { outcome: 'failed', reason: 'no' } : { outcome: 'done', result: {} }; };
  const top = async (map, model, inFile) => { sent.length = 0; const r = await cw.applyTopLevel({ ask, memento, map, model, inFile }); return [r.state, sent.slice()]; };
  const SET = ['config/value/write', { keyPath: 'model_context_window', value: 917000, mergeStrategy: 'upsert' }];
  const UNSET = ['config/value/write', { keyPath: 'model_context_window', value: null, mergeStrategy: 'replace' }];
  eq(await top({}, 'openai.gpt-6.1-sol', 0), ['none', []], 'with the table empty nothing is written');
  eq(await top(MAP, 'gpt-5.5', 0), ['none', []], 'nor while the model new conversations start with has no entry');
  eq(await top(MAP, 'openai.gpt-6.1-sol', 0), ['ours', [SET]], 'its entry is written as model_context_window');
  eq(await top(MAP, 'openai.gpt-6.1-sol', 917000), ['ours', []], 'and not again while it is there');
  eq(await top(MAP, 'gpt-5.5', 917000), ['none', [UNSET]], 'a change to a model with no entry takes the value back out');
  eq(await top({}, 'gpt-5.5', 0), ['none', []], 'and then nothing is left to take out');
  eq(await top(MAP, 'openai.gpt-6.1-sol', 500000), ['theirs', []], 'a value the user wrote is not replaced');
  eq(await top({}, 'openai.gpt-6.1-sol', 500000), ['theirs', []], 'nor taken out');
  refuse = true;
  eq((await top(MAP, 'openai.gpt-6.1-sol', 0))[0], 'failed', 'a write Codex refuses is reported');
  refuse = false;
  eq((await top(MAP, 'openai.gpt-6.1-sol', 0))[0], 'ours', 'and made again next time');
  eq(memento.get(cw.APPLIED_KEY), { value: 917000, model: 'openai.gpt-6.1-sol', key: 'gpt-6.1-sol', text: '1.05M' },
    'what was written is remembered, with the entry it came from');

  /* ── the override added to a page's request ── */
  const models = { t1: 'gpt-6-luna', t2: 'openai.gpt-6.1-sol', t3: 'gpt-5.5', t4: 'made-up' };
  const ctx = (over) => ({ map: MAP, top: 0, ours: 0, threadModel: (id) => models[id] || '', defaultModel: 'openai.gpt-6.1-sol', ...over });
  const ov = (method, params, over, kind = 'request') => cw.overrideFor({ id: 1, method, params }, kind, ctx(over));
  eq([ov('thread/start', {}), ov('thread/start', { model: 'gpt-6-luna' }), ov('thread/start', { model: 'gpt-5.5' }),
    ov('thread/resume', { threadId: 't1' }), ov('thread/resume', { threadId: 't2' }), ov('thread/fork', { threadId: 't1' }),
    ov('thread/resume', { threadId: 'zz' }), ov('turn/start', { threadId: 't1' }), ov('thread/start', {}, {}, 'prewarm')],
  [917000, 384000, 0, 384000, 917000, 384000, 0, 0, 917000],
  'with nothing in config.toml: a start takes its model\'s value, or the default model\'s; a resume or a fork the value of the '
    + 'conversation\'s own model; a model with no entry, or a conversation whose model is not known, nothing; a turn nothing; a prewarm as a start');
  const ours = { top: 917000, ours: 917000 };
  eq([ov('thread/start', {}, ours), ov('thread/start', { model: 'gpt-6-luna' }, ours), ov('thread/resume', { threadId: 't3' }, ours),
    ov('thread/resume', { threadId: 't1' }, ours), ov('thread/start', { model: 'gpt-6-sol' }, ours), ov('thread/resume', { threadId: 't4' }, ours)],
  [0, 384000, 272000, 384000, 272000, 0],
  'with this extension\'s value in config.toml: nothing for the model it was written for, another model\'s own value, '
    + 'Codex\'s own default for a model Codex lists that has no entry, and nothing for a model Codex does not list, which it holds to its default itself');
  eq([ov('thread/start', { model: 'gpt-6-luna' }, { top: 500000, ours: 0 }), ov('thread/resume', { threadId: 't2' }, { top: 500000, ours: 917000 })],
    [0, 0], 'a value the user wrote into config.toml is never overridden');
  eq(ov('thread/start', { model: 'gpt-6-luna', config: { model_context_window: 123456 } }), 0, 'nor one the page itself sent');
  const req = { id: 2, method: 'thread/start', params: { model: 'gpt-6-luna', config: { 'features.x': true } } };
  const params = req.params;
  cw.addOverride(req, 384000);
  eq([req.params === params, req.params.config], [true, { 'features.x': true, model_context_window: 384000 }],
    'the override goes into the same params object Codex sends, beside the overrides it had');
  eq(Object.values(cw.CODEX).every(([d, m]) => d > 0 && m >= d) && cw.FALLBACK === 272000, true,
    'every model Codex lists has a default and a most, and a model it does not list gets 272,000');

  /* ── where the window a conversation reports comes from ── */
  const from = (model, reported, over = {}) => cw.windowFrom({ model, reported, map: MAP, ...over });
  eq([from('openai.gpt-6.1-sol', 828400), from('gpt-6-luna', 364800), from('openai.gpt-6.1-sol', 258400, { map: {} }),
    from('gpt-6-sol', 828400, { top: 917000, applied: { value: 917000, key: 'gpt-6.1-sol', text: '1.05M' } }),
    from('gpt-6-sol', 475000, { top: 500000 }), from('openai.gpt-6.1-sol', 258400), from('made-up', 190000, { map: {} }),
    from('gpt-5.6-sol', 258400, { top: 917000, applied: { value: 917000, key: 'gpt-6.1-sol', text: '1.05M' } }),
    from('openai.gpt-6.1-sol', 475000, { top: 500000 })],
  [{ kind: 'setting', model: 'gpt-6.1-sol', asked: '1.05M', used: 872000, most: true },
    { kind: 'setting', model: 'gpt-6-luna', asked: '512K', used: 384000, most: false },
    { kind: 'default', model: 'openai.gpt-6.1-sol', asked: '', used: 272000, most: false },
    { kind: 'setting', model: 'gpt-6.1-sol', asked: '1.05M', used: 872000, most: true },
    { kind: 'config', model: 'gpt-6-sol', asked: '', used: 500000, most: false },
    { kind: 'earlier', model: 'openai.gpt-6.1-sol', asked: '', used: 0, most: false },
    { kind: 'default', model: 'made-up', asked: '', used: 0, most: false },
    { kind: 'default', model: 'gpt-5.6-sol', asked: '', used: 272000, most: false },
    { kind: 'config', model: 'openai.gpt-6.1-sol', asked: '', used: 500000, most: false }],
  'the window comes from: the setting, which Codex held to its most; the setting; Codex\'s default; another model\'s setting in config.toml; '
    + 'config.toml written by hand; a value from before the setting changed; a model this extension does not know; '
    + 'Codex\'s default, given by an override, for a model with no entry while config.toml holds another\'s; '
    + 'and a value written into config.toml by hand, which wins over the setting');

  /* ── the line under each reply ── */
  {
    const dir = tmp('figures');
    const start = Date.parse('2026-11-10T18:00:00Z');
    const lines = fixture.rolloutLines({ id: 'th', cwd: dir, turns: [{ id: 'a', startMs: start, context: 129200 }, { id: 'b', startMs: start + 60e3, context: 248520 }], startMs: start - 1000 })
      .split('\n');
    const at = lines.findIndex((l) => /"turn_id":"b"/.test(l));
    const file = path.join(dir, 'rollout-th.jsonl');
    fs.writeFileSync(file, lines.map((l, i) => (i >= at ? l.replace(/"model_context_window":258400/, '"model_context_window":828400') : l)).join('\n'));
    eq(require(path.join(root, 'src', 'user-times.js')).rolloutMarks(file).turns, { a: 'ctx 50% · gpt-test low', b: 'ctx 30% · gpt-test low' },
      'each reply\'s ctx share is out of the window Codex reported for that turn');
  }

  /* ── in the extension ── */
  const { vscode, control } = fake.create();
  let changed = null;
  vscode.workspace.onDidChangeConfiguration = (fn) => { changed = fn; return { dispose() {} }; };
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  const [t1] = fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "openai.gpt-6.1-sol"\nmodel_provider = "amazon-bedrock"\n');
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const globalState = fake.memento({ 'codexPlus.patchRemoved': true });
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState,
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  const requests = [];
  let handler = null;
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) {
      requests.push([method, params]);
      if (method === 'config/value/write') {
        const file = path.join(home, 'config.toml');
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^model_context_window/.test(l));
        if (params.value !== null) lines.unshift(`model_context_window = ${params.value}`);
        fs.writeFileSync(file, lines.join('\n'));
      }
      setTimeout(() => handler && handler.onResult({ id, result: {} }), 1);
    },
  };
  const provider = { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} };
  globalThis.__codexExtrasMessage({}, { kind: 'none' }, provider);
  const panel = { webview: { postMessage: () => Promise.resolve(true) }, onDidDispose: () => ({ dispose() {} }), viewType: 'chatgpt.conversationEditor', visible: true };
  try {
    globalThis.__codexExtrasPanel(panel, t1.id, provider, `/local/${t1.id}`);
    control.state.config = { reopenDroppedTabs: false, contextWindow: { 'gpt-6.1-sol': '1.05M', 'gpt-test': '400K' } };
    control.state.said.length = 0;
    changed({ affectsConfiguration: (k) => k === 'codexPlus' || k === 'codexPlus.contextWindow' });
    changed({ affectsConfiguration: (k) => k === 'codexPlus' || k === 'codexPlus.contextWindow' });
    await tick(2000);
    eq(requests.filter((r) => r[0] === 'config/value/write'), [SET], 'a change of the table writes the default model\'s value on Codex\'s own connection');
    const told = control.state.said.filter((s) => /context window/i.test(s.message));
    eq([told.length, told.length && /reload/i.test(told[0].message)], [1, true],
      'with a conversation open in this window, the user is told once that it keeps its window until a reload');

    const start = { id: 'p1', method: 'thread/start', params: { model: 'gpt-test', cwd: home } };
    globalThis.__codexExtrasPageRequest(panel.webview, start, 'request');
    const resume = { id: 'p2', method: 'thread/resume', params: { threadId: t1.id } };
    globalThis.__codexExtrasPageRequest(panel.webview, resume, 'request');
    const plain = { id: 'p3', method: 'thread/start', params: { cwd: home } };
    globalThis.__codexExtrasPageRequest({}, plain, 'prewarm');
    eq([start.params.config, resume.params.config, plain.params.config], [{ model_context_window: 400000 }, { model_context_window: 400000 }, undefined],
      'a page\'s start and resume get the value of their own model, in a tab or the sidebar, and a prewarm of the default model is left to config.toml');

    const usage = require(path.join(root, 'src', 'patching.js')).usageOf({ context: { used: 100000, window: 828400 }, model: 'openai.gpt-6.1-sol' }, 0,
      { kind: 'setting', model: 'gpt-6.1-sol', asked: '1.05M', used: 872000, most: true });
    eq([usage.usage.window, usage.usage.line, usage.usage.windowFrom && usage.usage.windowFrom.kind], [828400, Math.floor(828400 * 0.9 / 0.95), 'setting'],
      'the meter takes the window Codex reports, compacts at 90% of the value Codex uses, and carries where the window came from');

    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.5"\nmodel_context_window = 917000\nmodel_provider = "amazon-bedrock"\n');
    requests.length = 0;
    await tick(4500);
    eq(requests.filter((r) => r[0] === 'config/value/write'), [UNSET], 'a change of the default model to one with no entry takes the value back out');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
