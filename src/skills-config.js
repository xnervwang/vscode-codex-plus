// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The two settings that change how Codex lists skills, written into Codex's config.toml through its app-server, which
 * writes it under Codex's own lock:
 *
 *   codexPlus.skillsListBudget  skills.max_context_tokens: the tokens Codex may spend on its list of skills each turn.
 *                               Without it Codex spends 2% of the model's context window, which with a hundred or more
 *                               skills cuts every description to about 50 characters; 10,000 is the most it takes.
 *   codexPlus.disabledSkills    one [[skills.config]] entry with enabled = false per skill named: Codex leaves it out of
 *                               the list and does not run it when it is named with $name either. A plugin's skill is
 *                               named with its plugin's name in front, which is the only form Codex matches.
 *
 * What this extension last wrote is kept in its global state, and a setting back at its default takes out exactly that:
 * 0 removes the budget it set, and a name taken off the list removes that name's entry. A value the user wrote into
 * config.toml by hand is left as it is. A request Codex refuses is not remembered, so it is asked again the next time
 * the settings are applied.
 */
const APPLIED_KEY = 'codexPlus.skillSettingsApplied';
const MAX_TOKENS = 10000;

/* `ask(method, params)` resolves to { outcome, result, reason } (extension.js askAppServer). */
async function applySkillSettings({ ask, memento, maxTokens, disabled, log = () => {} }) {
  const last = memento.get(APPLIED_KEY) || { maxTokens: 0, disabled: [] };
  const want = Math.max(0, Math.min(MAX_TOKENS, Math.floor(+maxTokens) || 0));
  const next = { maxTokens: +last.maxTokens || 0, disabled: Array.isArray(last.disabled) ? [...last.disabled] : [] };
  const ok = (r, doing) => {
    if (r && (r.outcome === 'done' || r.outcome === 'sent')) return true;
    log(`could not ${doing} in Codex's config: ${(r && r.reason) || 'no answer'}`);
    return false;
  };
  if (want !== next.maxTokens) {
    const r = want > 0
      ? await ask('config/value/write', { keyPath: 'skills.max_context_tokens', value: want, mergeStrategy: 'upsert' })
      : await ask('config/value/write', { keyPath: 'skills.max_context_tokens', value: null, mergeStrategy: 'replace' });
    if (ok(r, 'set the skills list budget')) next.maxTokens = want;
  }
  const names = [...new Set((Array.isArray(disabled) ? disabled : []).map((n) => String(n || '').trim()).filter(Boolean))];
  for (const name of names.filter((n) => !next.disabled.includes(n))) {
    if (ok(await ask('skills/config/write', { name, enabled: false }), `turn off ${name}`)) next.disabled.push(name);
  }
  for (const name of next.disabled.filter((n) => !names.includes(n))) {
    if (ok(await ask('skills/config/write', { name, enabled: true }), `turn ${name} back on`)) next.disabled = next.disabled.filter((n) => n !== name);
  }
  if (JSON.stringify(next) !== JSON.stringify(last)) await memento.update(APPLIED_KEY, next);
  return next;
}

module.exports = { applySkillSettings, APPLIED_KEY, MAX_TOKENS };
