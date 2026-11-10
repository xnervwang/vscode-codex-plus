// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * ACCOUNT & USAGE at the top of the session list, as Claude Code's list has it: how Codex is signed in, and, only when
 * Codex has the figures, the share of each rate-limit window used and the tokens spent. No amount of money is shown.
 *
 * Each time the list comes into view it asks this window's app-server, on Codex's own connection, for account/read,
 * account/rateLimits/read and account/usage/read, at most once every RELOAD_MS; between those it only merges the
 * account/rateLimits/updated and account/updated notifications Codex's app-server sends anyway. Nothing is asked
 * without that connection: a short-lived app-server would have to sign in and reach the network to answer.
 *
 * Codex answers account/rateLimits/read for an Amazon Bedrock account with an error, as its own /status shows
 * "Rate limit: Unavailable", so for such an account the section has the Account line alone.
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
 * What the section draws, or null when there is nothing to say: { account: [{ label, value }], windows: [{ name, usedPercent, resetsAt }],
 * tokens: [{ label, value }] }. resetsAt is in seconds since the epoch, for the page to write in the reader's zone,
 * which is the zone its browser runs in.
 */
function viewOf({ account, limits, usage }, today = new Date().toISOString().slice(0, 10)) {
  if (!account || !ACCOUNT_KINDS[account.type]) return null;
  /* Claude Code's Account block is an Email line; Codex's own menu says "Logged in with Amazon Bedrock". */
  const rows = [];
  if (account.type === 'chatgpt') {
    rows.push(account.email ? { label: 'Email', value: account.email } : { label: 'Signed in with', value: 'ChatGPT' });
    if (PLAN_NAMES[account.planType]) rows.push({ label: 'Plan', value: PLAN_NAMES[account.planType] });
  } else rows.push({ label: 'Signed in with', value: ACCOUNT_KINDS[account.type] });
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
 * `onChange()` is called when what the section draws may have changed.
 */
function createAccountUsage({ ask, onChange = () => {}, now = Date.now }) {
  const st = { account: null, limits: null, usage: null };
  let loadedAt = 0;
  let loading = null;
  let viewNow = null;
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
        if (a.outcome === 'done' && a.result) st.account = a.result.account || null;
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
        if (type) st.account = { ...(st.account && st.account.type === type ? st.account : {}), type, planType: params.planType || (st.account || {}).planType };
        else if (params.authMode === null) st.account = null;
        /* Another sign-in may have other limits; the next appearance asks again. */
        loadedAt = 0;
        changed();
      }
    },
  };
}

module.exports = { createAccountUsage, viewOf, mergeLimits, windowName, RELOAD_MS };
