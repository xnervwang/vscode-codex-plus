// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan line appears on the context meter's hover, as in Claude Code Plus, and not in the information box,
 * which keeps the token mode. The page asks the host when the pointer reaches the meter, and the host reads the
 * rollout in the worker thread.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const { createDom } = require('../fake-dom');

function page(root) {
  const dom = createDom();
  dom.setBody(dom.el('body', { kids: [dom.el('div', { kids: [dom.el('div', { attrs: { 'data-codex-composer-root': '' },
    rect: { top: 600, left: 40, width: 700, height: 120 } })] })] }));
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1200 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const q = (sel) => dom.document.root.querySelectorAll(sel);
  return { dom, posted, q, send(m) { listeners.message({ data: m }); } };
}

const LINE = 'injected 2 times since the last compaction: 2960 characters, about 740 tokens, 2% of the 40000 in context';

module.exports = async ({ eq, tmp, root }) => {
  /* ── the page ── */
  {
    const p = page(root);
    p.send({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true, meter: true });
    p.send({ type: 'codex-extras-usage', usage: { used: 40000, window: 258400, line: 232560, model: 'gpt-test', effort: 'low' } });
    const meter = p.q('[data-codex-extras="meter"]')[0];
    const info = p.q('[data-codex-extras="bar-button"]')[0];
    eq([!!meter, info && info.getAttribute('aria-label')], [true, 'About this conversation: its thread id, the process of Codex\'s server, '
      + 'the folder it started in, its rollout and its size on disk, the model, the context in use, the tokens it used, and the token mode'],
    'the information button names the token mode, and not the work plan');
    meter.dispatch('mouseenter', {});
    const ask = p.posted.filter((m) => m.kind === 'planAsk');
    eq(ask.length, 1, 'reaching the context meter asks the host for the work plan\'s line');
    p.send({ type: 'codex-extras-plan', text: LINE });
    p.dom.runTimers();
    const box = p.q('[data-codex-extras="context"]')[0];
    eq([box && box.style.display, box && box.textContent.includes(`Work plan: ${LINE}`)], ['block', true],
      'and the hover shows it as one more line, worded as the information box worded it');
    meter.dispatch('mouseleave', {});
    p.dom.runTimers();
    meter.dispatch('mouseenter', {});
    eq(p.posted.filter((m) => m.kind === 'planAsk').length, 1, 'coming back to the meter soon after asks nothing more');
    p.send({ type: 'codex-extras-plan', text: '' });
    p.dom.runTimers();
    const again = p.q('[data-codex-extras="context"]')[0];
    eq(!!again && /Work plan:/.test(again.textContent), false, 'with nothing injected, or the work plan off, there is no such line');
  }

  /* ── the host ── */
  const { vscode } = fake.create();
  fake.install(vscode);
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  patching.installHooks();
  const asked = [];
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: true, figures: false }),
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) },
    sessionInfo: async () => [], planLine: async (id) => { asked.push(id); return LINE; } });
  const THREAD = '019a6a10-0000-7000-8000-0000000000c1';
  const sent = [];
  const provider = { postMessageToWebview: (w, m) => sent.push(m), sendMessageToPanel() {} };
  const panel = { webview: {}, reveal() {}, onDidDispose() {}, iconPath: null };
  globalThis.__codexExtrasPanel(panel, THREAD, provider);
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'planAsk' }, provider);
  await new Promise((r) => setTimeout(r, 20));
  const reply = sent.filter((m) => m.type === 'codex-extras-plan')[0];
  eq([asked, reply && reply.text], [[THREAD], LINE], 'the host answers with the line for the conversation the panel shows');
  patching._approvals.clear();

  /* ── the information box and the worker, on a rollout made for the test ── */
  const files = require(path.join(root, 'src', 'codex-files.js'));
  const sessionInfo = require(path.join(root, 'src', 'session-info.js'));
  const home = tmp('plan-hover-home');
  const id = '01a1b8e8-f7e2-7251-95a9-a95b65992112';
  const day = path.join(home, 'sessions', '2026', '11', '11');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-11-11T10-00-00-${id}.jsonl`);
  const plan = "This conversation's work plan (1 todo). " + 'r'.repeat(1000);
  fs.writeFileSync(rollout, [
    { timestamp: '2026-11-11T10:00:00Z', type: 'session_meta', payload: { id, cwd: home } },
    { timestamp: '2026-11-11T10:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: 1 } },
    { timestamp: '2026-11-11T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: plan }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  files.setCodexHome(home);
  try {
    eq(sessionInfo.rows(id, { pid: '1' }).some((r) => r.label === 'Work plan'), false, 'the information box has no Work plan row');
    const { ops } = require(path.join(root, 'src', 'codex-worker.js'));
    eq(ops.plan({ home, id }), `injected 1 time since the conversation began: ${plan.length} characters, about ${Math.round(plan.length / 4)} tokens`,
      'the worker reads the line the hover shows');
  } finally { files.setCodexHome(''); }
};
