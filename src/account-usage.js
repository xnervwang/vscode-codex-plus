// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * ACCOUNT & USAGE at the top of the session list, as in Claude Code's list: the sign-in, plus each rate-limit window's
 * share used and the tokens spent when Codex reports them. Prices and credit balances are left out.
 *
 * load() runs when the list comes into view and sends account/read, account/rateLimits/read and account/usage/read on
 * Codex's own connection, at most once per RELOAD_MS. In between, heard() merges the account/rateLimits/updated and
 * account/updated notifications. Without that connection it sends nothing, because a short-lived app-server would have
 * to sign in and go to the network.
 *
 * For an Amazon Bedrock account Codex answers account/rateLimits/read with an error (its /status prints "Rate limit:
 * Unavailable"), so the section shows the Account line only.
 */
const RELOAD_MS = 60e3;

const ACCOUNT_KINDS = { apiKey: 'API key', amazonBedrock: 'Amazon Bedrock', gcp: 'Google Cloud Vertex AI', chatgpt: 'ChatGPT' };
/* account/updated names the sign-in by its auth mode, not by account type. */
const MODE_KINDS = { apikey: 'apiKey', chatgpt: 'chatgpt', chatgptAuthTokens: 'chatgpt', bedrockApiKey: 'amazonBedrock', bedrockAccessKeys: 'amazonBedrock' };
const PLAN_NAMES = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: 'Team', business: 'Business',
  enterprise: 'Enterprise', edu: 'Edu' };

/* A window's name from its length, as Codex's own /status names them. */
function windowName(mins) {
  const m = Number(mins);
  if (!Number.isFinite(m) || m <= 0) return 'Limit';
  if (m === 10080) return 'Weekly';
  if (m % 1440 === 0) return `${m / 1440}-day`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

/* `into` with every value of `over` that is not null or missing; windows are replaced whole. */
function mergeLimits(into, over) {
  const out = { ...(into || {}) };
  for (const [k, v] of Object.entries(over || {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

const hasWindow = (w) => !!(w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent));

/*
 * The section's contents: { account: [{ label, value }], windows: [{ name, usedPercent, resetsAt }], tokens: [{ label,
 * value }] }. resetsAt is in seconds since the epoch; the page formats it. With no account the section still says so,
 * "Not signed in" once Codex has answered account/read without one and "Not known yet" before it has, so that it reads
 * apart from an agent that has no such section. `read` is whether Codex has answered.
 */
function viewOf({ account, limits, usage, read = false }, today = new Date().toISOString().slice(0, 10)) {
  if (!account) return { account: [{ label: 'Sign-in', value: read ? 'Not signed in' : 'Not known yet' }], windows: [], tokens: [] };
  /* Claude Code's Account block is an Email line; Codex's own menu says "Logged in with Amazon Bedrock". Sign-in is the label
     Claude Code Plus gives the same line, so the two agents' blocks read alike. */
  const rows = [];
  if (!ACCOUNT_KINDS[account.type]) rows.push({ label: 'Sign-in', value: 'Signed in' });
  else if (account.type === 'chatgpt') {
    rows.push(account.email ? { label: 'Email', value: account.email } : { label: 'Sign-in', value: 'ChatGPT' });
    if (PLAN_NAMES[account.planType]) rows.push({ label: 'Plan', value: PLAN_NAMES[account.planType] });
  } else rows.push({ label: 'Sign-in', value: ACCOUNT_KINDS[account.type] });
  const windows = [];
  for (const w of [limits && limits.primary, limits && limits.secondary]) {
    if (!hasWindow(w)) continue;
    windows.push({ name: windowName(w.windowDurationMins), usedPercent: Math.max(0, Math.min(100, Math.round(w.usedPercent))),
      resetsAt: Number.isFinite(+w.resetsAt) && +w.resetsAt > 0 ? +w.resetsAt : 0 });
  }
  const tokens = [];
  const days = usage && Array.isArray(usage.dailyUsageBuckets) ? usage.dailyUsageBuckets : [];
  const todayBucket = days.find((d) => d && d.startDate === today);
  if (todayBucket && Number.isFinite(+todayBucket.tokens)) tokens.push({ label: 'Tokens today', value: +todayBucket.tokens });
  const total = usage && usage.summary && usage.summary.lifetimeTokens;
  if (Number.isFinite(+total) && total !== null && +total > 0) tokens.push({ label: 'Tokens in all', value: +total });
  return { account: rows, windows, tokens };
}

/*
 * `ask(method, params, { fallback: false })` sends on Codex's connection and resolves to { outcome, result };
 * `onChange()` is called when viewOf's result changes.
 */
function createAccountUsage({ ask, onChange = () => {}, now = Date.now }) {
  const st = { account: null, limits: null, usage: null, read: false };
  let loadedAt = 0;
  let loading = null;
  let viewNow = viewOf(st);
  const changed = () => {
    const next = viewOf(st);
    if (JSON.stringify(next) === JSON.stringify(viewNow)) return;
    viewNow = next;
    try { onChange(); } catch (_) { /* the next change draws it */ }
  };
  const one = (method) => Promise.resolve(ask(method, {}, { fallback: false })).catch(() => ({ outcome: 'failed' }));
  return {
    view: () => viewNow,
    /* The list came into view. Resolves once the answers are in, or at once when asked within RELOAD_MS. */
    load() {
      if (loading) return loading;
      if (loadedAt && now() - loadedAt < RELOAD_MS) return Promise.resolve(viewNow);
      loading = Promise.all([one('account/read'), one('account/rateLimits/read'), one('account/usage/read')]).then(([a, l, u]) => {
        if (a.outcome === 'unavailable') return viewNow;
        loadedAt = now();
        if (a.outcome === 'done' && a.result) { st.account = a.result.account || null; st.read = true; }
        st.limits = l.outcome === 'done' && l.result && l.result.rateLimits ? l.result.rateLimits : null;
        st.usage = u.outcome === 'done' && u.result ? u.result : null;
        changed();
        return viewNow;
      }).finally(() => { loading = null; });
      return loading;
    },
    /* A notification from the app-server; only the two account ones are looked at. */
    heard(method, params) {
      if (method === 'account/rateLimits/updated' && params && params.rateLimits) {
        st.limits = mergeLimits(st.limits, params.rateLimits);
        changed();
      } else if (method === 'account/updated' && params) {
        const type = MODE_KINDS[params.authMode];
        if (type) { st.account = { ...(st.account && st.account.type === type ? st.account : {}), type, planType: params.planType || (st.account || {}).planType }; st.read = true; }
        else if (params.authMode === null) { st.account = null; st.read = true; }
        /* Another sign-in may have other limits; the next appearance asks again. */
        loadedAt = 0;
        changed();
      }
    },
  };
}

module.exports = { createAccountUsage, viewOf, mergeLimits, windowName, RELOAD_MS };
