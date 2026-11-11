// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * codexPlus.contextWindow: a context window for each model listed, used by Codex instead of its own. Models not listed
 * keep Codex's default.
 *
 * How Codex 26.1021.22027 uses model_context_window (test/parts/57c-context-window-codex.js checks this against the
 * Codex installed here):
 *
 *   the value     the number of input tokens; Codex caps it at the maximum its model list allows, 872,000 for the
 *                 GPT-6 models
 *   the meter     Codex reports 95% of the value as the window, and the shares shown here are of that window
 *   compaction    before a turn whose context would pass 90% of the value; model_auto_compact_token_limit can only
 *                 move that earlier
 *   when          read when a conversation is started or loaded. A conversation the app-server has loaded keeps its
 *                 window through any change, even a change of model. Codex's page lets go of a conversation it
 *                 no longer shows after three hours, or sooner once more than ten are idle, and the app-server
 *                 unloads it half an hour later; reloading the window starts a new app-server
 *
 * config.toml gets the value for the default model (its `model`), through Codex's own config/value/write as in
 * src/skills-config.js; conversations loaded before this extension runs, such as the tabs VS Code restores at a reload,
 * get that one. Each request a page sends to start, prewarm, resume or fork a conversation also gets a config override
 * with the value for that conversation's own model (overrideFor) before Codex sends it.
 *
 * Codex rejects a null in a config override, so when config.toml holds another model's value, a model with no value of
 * its own is given Codex's default from CODEX instead.
 */
const APPLIED_KEY = 'codexPlus.contextWindowWritten';

/*
 * Windows the vendor publishes, which count output as well as input. The value written is the published window minus
 * the model's maximum output, and never more than `input`, the largest input Amazon Bedrock accepted from
 * openai.gpt-6.1-sol (it took 917,822 tokens and refused about 923,000). `source` was read on 2026-11-10.
 */
const PUBLISHED = [
  { models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna'], window: 1050000, output: 128000, input: 917000,
    source: 'https://developers.openai.com/api/docs/models' },
];
/* [default, maximum] for each model in Codex 26.1021.22027's own model list; its Bedrock names map to the same entries. */
const CODEX = {
  'gpt-6.1-sol': [272000, 872000], 'gpt-6-astra': [272000, 872000], 'gpt-6-sol': [272000, 872000], 'gpt-6-luna': [272000, 872000],
  'gpt-5.6-sol': [272000, 872000], 'gpt-5.6-terra': [272000, 872000], 'gpt-5.6-luna': [272000, 872000], 'gpt-5.5': [272000, 272000],
};
/* Default and maximum for a model Codex does not list (Codex gives such a model fallback metadata). */
const FALLBACK = 272000;
const SMALLEST = 16000;
/* Codex reports this percentage of the value as the window. */
const REPORTED = 95;

/* A model name without the Bedrock region and vendor prefix, or the part after the last slash of a namespaced name. */
function baseName(model) {
  return String(model || '').trim().toLowerCase().replace(/^.*\//, '').replace(/^(?:[a-z]{2,7}\.)?openai\./, '');
}
const published = (model) => PUBLISHED.find((p) => p.models.includes(baseName(model))) || null;
/** [default, maximum] for `model` in Codex's list, or null for a model not in this table. */
const codexWindow = (model) => CODEX[baseName(model)] || null;

const tokensText = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(3)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(n));

/** Tokens from 1050000, "1.05M", "512K" or "400,000"; null for anything else. */
function parseWindow(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM])?\s*$/.exec(String(raw == null ? '' : raw).replace(/[,_]/g, ''));
  if (!m) return null;
  const n = Math.floor(Number(m[1]) * (m[2] ? (/m/i.test(m[2]) ? 1e6 : 1e3) : 1));
  return n >= 1000 ? n : null;
}

/* The entry of `map` for `model`: an exact match, else one that names the same model without its region and vendor. */
function entryFor(map, model) {
  if (!map || typeof map !== 'object' || !model) return null;
  const keys = Object.keys(map);
  const key = keys.find((k) => k === model) || keys.find((k) => baseName(k) === baseName(model));
  return key === undefined ? null : { key, raw: map[key] };
}

/** The setting's entry for `model`, with `value` to write for Codex; null if there is none or it cannot be read. */
function valueFor(map, model) {
  const e = entryFor(map, model);
  const n = e ? parseWindow(e.raw) : null;
  if (!n) return null;
  const p = published(model);
  const text = typeof e.raw === 'string' ? e.raw.trim() : tokensText(n);
  if (!p) return { key: e.key, shown: n, text, value: n };
  const shown = Math.min(n, p.window);
  const value = Math.min(shown - p.output, p.input);
  return value >= SMALLEST ? { key: e.key, shown, text: shown < n ? tokensText(p.window) : text, value } : null;
}

/*
 * Sets config.toml's model_context_window for `model`, the default model. `inFile` is the value there now (0 for
 * none). Only a value this extension wrote is replaced or removed; a different value was written by someone else and
 * stays. `ask(method, params)` resolves to { outcome, result, reason }.
 */
async function applyTopLevel({ ask, memento, map, model, inFile, log = () => {} }) {
  const last = memento.get(APPLIED_KEY) || { value: 0 };
  const ours = +last.value || 0;
  const now = +inFile || 0;
  if (now && now !== ours) {
    if (ours) await memento.update(APPLIED_KEY, { value: 0 });
    return { state: 'theirs', value: now };
  }
  const want = valueFor(map, model);
  const target = want ? want.value : 0;
  const next = want ? { value: target, model: String(model), key: want.key, text: want.text } : { value: 0 };
  if (target === now) {
    if (JSON.stringify(next) !== JSON.stringify(last)) await memento.update(APPLIED_KEY, next);
    return { state: target ? 'ours' : 'none', value: target };
  }
  const r = target
    ? await ask('config/value/write', { keyPath: 'model_context_window', value: target, mergeStrategy: 'upsert' })
    : await ask('config/value/write', { keyPath: 'model_context_window', value: null, mergeStrategy: 'replace' });
  if (!r || (r.outcome !== 'done' && r.outcome !== 'sent')) {
    log(`could not ${target ? 'set' : 'remove'} the context window in Codex's config: ${(r && r.reason) || 'no answer'}`);
    return { state: 'failed', value: now };
  }
  await memento.update(APPLIED_KEY, next);
  return { state: target ? 'ours' : 'none', value: target };
}

const STARTS = new Set(['thread/start', 'thread/resume', 'thread/fork']);
/** Whether a page's request opens a conversation: a start, a prewarmed start, a resume or a fork. */
const opens = (request, kind) => kind === 'prewarm' || STARTS.has(request && request.method);

/**
 * The model_context_window to add to a page's request that opens a conversation, or 0 to send the request as it is.
 * `top` is the value in config.toml and `ours` the value this extension wrote there; `threadModel(id)` is the model a
 * conversation last ran with ('' when unknown).
 */
function overrideFor(request, kind, { map, top = 0, ours = 0, threadModel = () => '', defaultModel = '' }) {
  const method = kind === 'prewarm' ? 'thread/start' : request && request.method;
  const params = request && request.params;
  if (!opens(request, kind) || !params || typeof params !== 'object') return 0;
  if (params.config && typeof params.config === 'object' && params.config.model_context_window !== undefined) return 0;
  if (top && top !== ours) return 0;
  const model = typeof params.model === 'string' && params.model ? params.model
    : method === 'thread/start' ? defaultModel : threadModel(String(params.threadId || ''));
  if (!model) return 0;
  const want = valueFor(map, model);
  if (want) return want.value !== top ? want.value : 0;
  const own = codexWindow(model);
  return top && own ? own[0] : 0;
}

function addOverride(request, value) {
  const params = request.params;
  params.config = Object.assign({}, params.config && typeof params.config === 'object' ? params.config : {}, { model_context_window: value });
}

/*
 * The source of a conversation's reported window, for the meter's hover box. A value written into config.toml by hand
 * applies to every model; otherwise the candidates are this extension's value for the model and then Codex's default.
 * While config.toml holds the value this extension wrote for another model (`applied`), the conversation has that
 * value, or Codex's default when it was opened through a page. If none of these gives the reported window, the window
 * was set when Codex opened the conversation ('earlier'). `used` in the result is the value Codex works with, 0 when not
 * known.
 */
function windowFrom({ model, reported, map, top = 0, applied = null }) {
  const win = +reported || 0;
  if (!model || !win) return null;
  const own = codexWindow(model);
  const caps = own ? [own[1]] : [Infinity, FALLBACK];
  const usedFor = (v) => {
    for (const cap of caps) { const u = Math.min(v, cap); if (Math.floor(u * REPORTED / 100) === win) return u; }
    return 0;
  };
  const earlier = { kind: 'earlier', model: String(model), asked: '', used: 0, most: false };
  const mine = !!applied && +applied.value === top;
  if (top && !mine) {
    const u = usedFor(top);
    return u ? { kind: 'config', model: String(model), asked: '', used: u, most: u < top } : earlier;
  }
  const want = valueFor(map, model);
  if (want) {
    const u = usedFor(want.value);
    return u ? { kind: 'setting', model: want.key, asked: want.text, used: u, most: u < want.value } : earlier;
  }
  if (top) {
    const u = usedFor(top);
    if (u) return { kind: 'setting', model: String(applied.key || applied.model || ''), asked: String(applied.text || ''), used: u, most: u < top };
    if (!own) return earlier;
  }
  if (!own) return { kind: 'default', model: String(model), asked: '', used: 0, most: false };
  return Math.floor(own[0] * REPORTED / 100) === win ? { kind: 'default', model: String(model), asked: '', used: own[0], most: false } : earlier;
}

module.exports = { APPLIED_KEY, PUBLISHED, CODEX, FALLBACK, baseName, tokensText, published, codexWindow, parseWindow, entryFor, valueFor,
  applyTopLevel, opens, overrideFor, addOverride, windowFrom };
