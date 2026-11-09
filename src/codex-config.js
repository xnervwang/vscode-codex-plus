// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A few plain values out of Codex's config.toml, read-only: which model provider it uses and in which region, and the
 * compaction limit the user set.
 *
 * Read without a TOML parser, because only `key = value` lines with a string, a number or a boolean are wanted. A value
 * of any other shape (an inline table, an array, a multi-line string) reads as absent. A `profile` named at the top
 * level is honoured for the keys a profile can set, the way Codex reads them.
 */
const fs = require('fs');
const path = require('path');

const KEY = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

function valueOf(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(v);
    if (!m) return undefined;
    try { return JSON.parse(`"${m[1]}"`); } catch (_) { return undefined; }
  }
  if (v.startsWith("'")) {
    const m = /^'([^']*)'/.exec(v);
    return m ? m[1] : undefined;
  }
  const bare = v.replace(/\s+#.*$/, '').trim();
  if (bare === 'true' || bare === 'false') return bare === 'true';
  if (/^[+-]?\d[\d_]*$/.test(bare)) return Number(bare.replace(/_/g, ''));
  return undefined;
}

/** Table name ('' for the top level) -> { key: value }, for the plain values. */
function tablesOf(text) {
  const out = { '': {} };
  let at = '';
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    if (s.startsWith('[')) {
      const m = /^\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$/.exec(s);
      at = m ? m[1].replace(/\s*\.\s*/g, '.') : '\0';
      if (!out[at]) out[at] = {};
      continue;
    }
    const m = KEY.exec(s);
    if (!m) continue;
    const v = valueOf(m[2]);
    if (v !== undefined) out[at][m[1]] = v;
  }
  return out;
}

function read(home) {
  try { return tablesOf(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')); } catch (_) { return { '': {} }; }
}

/* A key a profile can override: the profile's value when one is named and sets it, else the top level's. */
function profiled(tables, key) {
  const top = tables[''] || {};
  const p = typeof top.profile === 'string' ? tables[`profiles.${top.profile}`] || tables[`profiles."${top.profile}"`] : null;
  return p && p[key] !== undefined ? p[key] : top[key];
}

/** The compaction limit the user set (model_auto_compact_token_limit), or 0 when none is. */
function compactLimit(home) {
  const v = profiled(read(home), 'model_auto_compact_token_limit');
  return Number.isInteger(v) && v > 0 ? v : 0;
}

const NAMES = { 'amazon-bedrock': 'Amazon Bedrock', openai: 'OpenAI (ChatGPT sign-in or an API key)', oss: 'a local open-source model',
  ollama: 'Ollama', lmstudio: 'LM Studio' };

/** { id, name, region } of the model provider Codex is set to use. Codex's own default is openai. */
function provider(home) {
  const tables = read(home);
  const id = String(profiled(tables, 'model_provider') || 'openai');
  const own = tables[`model_providers.${id}`] || tables[`model_providers."${id}"`] || {};
  const aws = tables[`model_providers.${id}.aws`] || tables[`model_providers."${id}".aws`] || {};
  const region = typeof aws.region === 'string' ? aws.region : typeof own.region === 'string' ? own.region : '';
  return { id, name: typeof own.name === 'string' && own.name ? own.name : NAMES[id] || id, region };
}

/** One line for the account, as Session Information and Show Status show it. */
function accountLine(home) {
  const p = provider(home);
  return `${p.name}${p.region ? ` · ${p.region}` : ''}`;
}

module.exports = { tablesOf, compactLimit, provider, accountLine };
