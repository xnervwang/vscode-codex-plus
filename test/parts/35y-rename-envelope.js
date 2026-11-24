// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The unread envelope is drawn after a title and never becomes part of the conversation's name. The rename box opens
 * without it, a saved name never keeps one wherever it was typed, and the title shows a single envelope at the end
 * only while a reply is unread (src/title-marks.js, from Agent Plus).
 */
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const COLOUR = '\u{1F4E9}', TEXT = '✉︎';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  const { withoutEnvelope, withEnvelope } = require('../../src/title-marks');

  /* ── the function ── */
  const cases = [
    [`Fix the build ${COLOUR}`, 'Fix the build', 'left in at the end'],
    ['Fix the build', 'Fix the build', 'deleted'],
    [`Fix the build ${COLOUR}${COLOUR}`, 'Fix the build', 'typed once more'],
    [`Fix ${COLOUR} the build`, 'Fix the build', 'typed in the middle'],
    [`${COLOUR} Fix the build`, 'Fix the build', 'typed at the start'],
    [`Fix the build ${TEXT}`, 'Fix the build', 'in its text form'],
    ['Fix the build ✉', 'Fix the build', 'with no variation selector'],
    [`  Fix   the${COLOUR}build  `, 'Fix the build', 'with spaces around it'],
    [`${COLOUR} ${TEXT}`, '', 'alone'],
  ];
  eq(cases.map(([name]) => withoutEnvelope(name)), cases.map(([, want]) => want),
    `the saved name carries no envelope whether it was ${cases.map(([, , how]) => how).join(', ')}`);
  eq([withEnvelope(`Fix ${COLOUR} the build ${COLOUR}`, true, COLOUR), withEnvelope(`${COLOUR} Fix the build`, false, COLOUR),
    withEnvelope('Fix the build', true, TEXT)],
  [`Fix the build ${COLOUR}`, 'Fix the build', `Fix the build ${TEXT}`],
  'a title is drawn with one envelope, last, only while a reply is not seen');

  /* ── renaming through the extension ── */
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  const made = fixture.codexHome(home, [{ title: `Plan ${COLOUR} the release`, cwd: home, turns: [{}] }, { title: 'Second', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  await tick(300);
  const requests = [];
  let handler = null;
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { requests.push({ method, params }); setTimeout(() => handler && handler.onResult({ id, result: {} }), 1); },
  };
  globalThis.__codexExtrasMessage({}, { kind: 'none' }, { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} });
  const row = (t) => ({ kind: 'thread', thread: { id: t.id }, group: 'ungrouped' });
  const names = () => requests.filter((r) => r.method === 'thread/name/set').map((r) => r.params.name);
  try {
    const prefills = [];
    const renamed = async (answer, t = made[1]) => {
      requests.length = 0;
      control.state.inputAnswer = (o) => { prefills.push(o.value); return answer; };
      await control.state.handlers['codexPlus.renameThread'](row(t));
      await tick();
      return names();
    };
    eq(await renamed(`Plan the launch ${COLOUR}`, made[0]), ['Plan the launch'], 'Rename with the envelope left in saves the name without it');
    eq(prefills[0], 'Plan the release', 'and its box starts from the name without the envelope, though the stored name had one');
    eq([await renamed(`Second ${COLOUR}${COLOUR}`), await renamed(`Sec ${COLOUR} ond`), await renamed(`${COLOUR} Third`)],
      [[], ['Sec ond'], ['Third']], 'an envelope typed once more, in the middle or at the start is not saved (the first leaves the name as it was)');
    eq(await renamed(`${COLOUR}`), [], 'and nothing is sent for a name that is only an envelope');

    const page = control.showWebviewView('codexPlus.sessions');
    await page.fromPage({ kind: 'ready' });
    requests.length = 0;
    await page.fromPage({ kind: 'rename', id: made[1].id, title: `New ${TEXT} title ${COLOUR}` });
    await tick();
    eq(names(), ['New title'], 'a title edited where the list draws it is saved without the envelopes typed into it');
    const envelopeNow = () => (page.posted.filter((x) => x.type === 'model').pop() || { model: {} }).model.envelope;
    const dark = envelopeNow();
    control.setTheme(4);
    await tick();
    const light = envelopeNow();
    control.setTheme(3);
    await tick();
    eq([dark, light, envelopeNow()], [COLOUR, TEXT, COLOUR], 'a change of theme redraws the list with the envelope of that theme');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
