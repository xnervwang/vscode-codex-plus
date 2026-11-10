// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * ACCOUNT & USAGE: the requests and their answers are in the shapes `codex app-server generate-json-schema` of Codex
 * 26.1021.22027 gives for account/read, account/rateLimits/read, account/usage/read and the two notifications. An
 * Amazon Bedrock account, whose rate limits Codex cannot read (its /status says "Rate limit: Unavailable"), shows the
 * Account line alone; no amount of money is ever shown.
 */
const fake = require('../fake-vscode');

module.exports = async ({ eq }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  const { createAccountUsage, viewOf, windowName, RELOAD_MS } = require('../../src/account-usage');

  eq([windowName(300), windowName(10080), windowName(1440 * 30), windowName(null)], ['5h', 'Weekly', '30-day', 'Limit'],
    'a window is named by its length, as Codex\'s /status names it');

  /* ── an Amazon Bedrock account ── */
  let t = 1000;
  const asked = [];
  const answers = {
    'account/read': { outcome: 'done', result: { account: { type: 'amazonBedrock', usesCodexManagedCredentials: false }, requiresOpenaiAuth: false } },
    'account/rateLimits/read': { outcome: 'failed', reason: 'codex account authentication required to read rate limits' },
    'account/usage/read': { outcome: 'failed', reason: 'codex account authentication required to read token usage' },
  };
  let changes = 0;
  const au = createAccountUsage({ ask: async (m, p, o) => { asked.push([m, o]); return answers[m]; }, onChange: () => changes++, now: () => t });
  eq(await au.load(), { account: 'Amazon Bedrock', windows: [], tokens: [] }, 'an Amazon Bedrock account shows the Account line and no usage at all');
  eq(asked, [['account/read', { fallback: false }], ['account/rateLimits/read', { fallback: false }], ['account/usage/read', { fallback: false }]],
    'it asks the three once, on Codex\'s own connection only');
  t += 1000;
  await au.load();
  eq([asked.length, changes], [3, 1], 'coming into view again within a minute asks nothing more');
  t += RELOAD_MS;
  await au.load();
  eq([asked.length, changes], [6, 1], 'after a minute it asks again, and draws nothing new when nothing changed');

  /* ── a ChatGPT account with its windows, merged from notifications ── */
  answers['account/read'] = { outcome: 'done', result: { account: { type: 'chatgpt', email: 'demo.user@example.com', planType: 'pro' }, requiresOpenaiAuth: true } };
  answers['account/rateLimits/read'] = { outcome: 'done', result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 23.4, windowDurationMins: 300, resetsAt: 1794300000 },
    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1794800000 }, credits: { hasCredits: true, unlimited: false, balance: '12.50' } } } };
  answers['account/usage/read'] = { outcome: 'done', result: { summary: { lifetimeTokens: 98765432 }, dailyUsageBuckets: [{ startDate: '2026-11-10', tokens: 1234567 }],
    threadUsage: null } };
  t += RELOAD_MS;
  const v = await au.load();
  eq([v.account, v.windows], ['demo.user@example.com · Pro', [{ name: '5h', usedPercent: 23, resetsAt: 1794300000 }, { name: 'Weekly', usedPercent: 61, resetsAt: 1794800000 }]],
    'a ChatGPT account shows its email and plan, and each window\'s share used with when it resets');
  eq(JSON.stringify(v).includes('12.50'), false, 'and no credit balance or other amount of money');
  au.heard('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1794300000 }, secondary: null } });
  eq(au.view().windows.map((w) => w.usedPercent), [40, 61], 'an update is merged into the last answer: what it leaves out stays');
  au.heard('account/updated', { authMode: 'bedrockAccessKeys', planType: null });
  eq(au.view().account, 'Amazon Bedrock', 'a change of sign-in is shown at once');
  eq(viewOf({ account: { type: 'chatgpt', email: null, planType: 'plus' }, limits: null, usage: { summary: {}, dailyUsageBuckets: [{ startDate: '2026-11-10', tokens: 5 }] } }, '2026-11-10'),
    { account: 'ChatGPT · Plus', windows: [], tokens: [{ label: 'Tokens today', value: 5 }] }, 'tokens by day are shown when Codex has them, with no money');
  eq(viewOf({ account: null }), null, 'and with no account known there is no section');

  /* ── drawn at the top of the list ── */
  const { rowsOf, resetText } = require('../../src/account-usage');
  const at = Date.UTC(2026, 10, 10, 5, 0) / 1000;
  eq([resetText(at, 'America/Los_Angeles', at * 1000 - 3600e3), resetText(at, 'America/Los_Angeles', at * 1000 - 3 * 86400e3)],
    ['resets 21:00', 'resets 11/09 21:00'], 'when a window resets is written in the reader\'s zone, with the date when it is not within a day');
  const rows = rowsOf({ account: 'Amazon Bedrock', windows: [{ name: '5h', usedPercent: 23, resetsAt: 0 }], tokens: [{ label: 'Tokens today', value: 1234567 }] }, '');
  eq(rows, [{ label: 'Account', value: 'Amazon Bedrock' }, { label: '5h', value: '23% used' }, { label: 'Tokens today', value: '1,234,567' }],
    'as rows of a label and a value');
  const { SessionsProvider } = require('../../src/sessions-view');
  const list = new SessionsProvider(vscode, { memory: { openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
    reader: { threads: () => [], sections: () => new Map(), state: () => null, thread: () => null }, stateOf: () => null,
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }), account: () => rows.slice(0, 1) });
  list.refresh();
  const top = list.getChildren();
  eq([top.map((r) => r.group.key), list.getChildren(top[0]).map((r) => [list.getTreeItem(r).label, list.getTreeItem(r).description])],
    [['account'], [['Account', 'Amazon Bedrock']]], 'the section comes first in the list');

  /* ── no connection: nothing is started to find out ── */
  const quiet = createAccountUsage({ ask: async () => ({ outcome: 'unavailable' }), now: () => t });
  eq(await quiet.load(), null, 'without Codex\'s connection the section is not drawn');

  /* ── the patch hands the notifications over ── */
  const patching = require('../../src/patching');
  patching.installHooks();
  const heard = [];
  const sub = patching.onAccountNotification((m, p) => heard.push([m, p]));
  globalThis.__codexExtrasAppServer('notification', { method: 'account/rateLimits/updated', params: { rateLimits: { primary: null } } });
  globalThis.__codexExtrasAppServer('notification', { method: 'turn/started', params: { threadId: 'x', turn: { id: 't' } } });
  sub.dispose();
  eq(heard, [['account/rateLimits/updated', { rateLimits: { primary: null } }]], 'the patch passes on the account notifications, and only those');
};
