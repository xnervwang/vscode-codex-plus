// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Installs the companion Codex plugin (codex-plugin/agent-work-plan: the work plan's hooks, skill and MCP server) into
 * a CODEX_HOME, and removes it again.
 *
 * The plugin reaches Codex the way any plugin does: a local marketplace is registered (marketplace/add) and the plugin
 * installed from it (plugin/install), both through `codex app-server`, which writes config.toml under Codex's own lock.
 * Codex then copies the plugin into its own cache, so the marketplace only has to exist while installing; it is staged
 * in this extension's global storage, which keeps one path across the extension's updates.
 *
 * Codex runs a plugin's hooks only once the user has trusted them, by hash, and the hash changes with every change of
 * the plugin's files. Trusting is the user's act: hookStatus() says what needs review, and trustHooks() writes the same
 * keys Codex's own Settings > Hooks page writes when Trust is clicked, and is only ever called after the user said yes
 * to a dialog naming the hooks.
 */
const fs = require('fs');
const path = require('path');
const { withAppServer } = require('./appserver');

const MARKETPLACE = 'codex-extras';
const PLUGIN = 'agent-work-plan';
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
/* Codex names a plugin's data directory <plugin>-<marketplace>; the hooks fall back to the same name (plan_path.py). */
const DATA_DIR = `${PLUGIN}-${MARKETPLACE}`;
const SOURCE = path.join(__dirname, '..', 'codex-plugin');
const MANIFEST = path.join('.agents', 'plugins', 'marketplace.json');

const planDir = (home) => path.join(home, 'plugins', 'data', DATA_DIR);
const cacheDir = (home) => path.join(home, 'plugins', 'cache', MARKETPLACE, PLUGIN);
const pluginVersion = () => JSON.parse(fs.readFileSync(path.join(SOURCE, PLUGIN, '.codex-plugin', 'plugin.json'), 'utf8')).version;

/** Whether some version of the plugin is in Codex's cache, and which. */
function installedVersions(home) {
  try { return fs.readdirSync(cacheDir(home)).filter((v) => fs.existsSync(path.join(cacheDir(home), v, '.codex-plugin'))); } catch (_) { return []; }
}

/* Copy the marketplace to `stage`, replacing what an earlier version left there. */
function stageMarketplace(stage, source = SOURCE) {
  fs.mkdirSync(stage, { recursive: true });
  for (const name of fs.readdirSync(stage)) fs.rmSync(path.join(stage, name), { recursive: true, force: true });
  fs.cpSync(source, stage, { recursive: true, filter: (p) => !p.includes(`${path.sep}__pycache__`) });
  return path.join(stage, MANIFEST);
}

/*
 * What the hooks are told by this editor: written into the plugin's data directory as config.json (plan_path.py reads
 * it). `values` holds only keys the hooks know.
 */
function writeHookSettings(home, values) {
  const dir = planDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Install or upgrade the plugin into `home`. Resolves to { version, marketplace }. */
async function install({ binary, home, stage, source = SOURCE }) {
  const manifest = stageMarketplace(stage, source);
  return withAppServer(binary, home, async (server) => {
    const added = await server.request('marketplace/add', { source: stage });
    if (added && added.installedRoot && path.resolve(added.installedRoot) !== path.resolve(fs.realpathSync(stage))
      && path.resolve(added.installedRoot) !== path.resolve(stage)) {
      // A marketplace of this name registered elsewhere (an older staging path): point it here.
      await server.request('marketplace/remove', { marketplaceName: MARKETPLACE });
      await server.request('marketplace/add', { source: stage });
    }
    await server.request('plugin/install', { marketplacePath: manifest, pluginName: PLUGIN });
    return { version: pluginVersion(), marketplace: stage };
  });
}

/*
 * Remove the plugin and its marketplace from `home`. The plans are copied first to
 * <home>/agent-work-plan-plans-<timestamp>/, because removing a plugin may remove its data directory with it. Resolves
 * to the folder they were copied to, or '' when there were none.
 */
async function uninstall({ binary, home }) {
  let kept = '';
  const dir = planDir(home);
  try {
    const plans = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'config.json');
    if (plans.length) {
      kept = path.join(home, `agent-work-plan-plans-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.mkdirSync(kept, { recursive: true });
      for (const n of plans) fs.copyFileSync(path.join(dir, n), path.join(kept, n));
    }
  } catch (_) { /* no plans */ }
  await withAppServer(binary, home, async (server) => {
    try { await server.request('plugin/uninstall', { pluginId: PLUGIN_ID }); } catch (_) { /* not installed */ }
    try { await server.request('marketplace/remove', { marketplaceName: MARKETPLACE }); } catch (_) { /* not added */ }
    // The trust the user gave the hooks is kept by Codex under each hook's key; a null removes it.
    const edits = hookKeys().map((key) => ({ keyPath: `hooks.state.${JSON.stringify(key)}`, value: null, mergeStrategy: 'replace' }));
    try { await server.request('config/batchWrite', { edits, filePath: null, expectedVersion: null, reloadUserConfig: true }); } catch (_) { /* none kept */ }
  });
  return kept;
}

/* The keys Codex files the plugin's hooks under: <plugin id>:<hooks file>:<event in snake case>:<group>:<handler>. */
function hookKeys(source = SOURCE) {
  const file = path.join(source, PLUGIN, 'hooks', 'hooks.json');
  const hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks || {};
  const snake = (e) => e.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const out = [];
  for (const [event, groups] of Object.entries(hooks)) {
    groups.forEach((g, gi) => (g.hooks || []).forEach((_, hi) => out.push(`${PLUGIN_ID}:hooks/hooks.json:${snake(event)}:${gi}:${hi}`)));
  }
  return out;
}

/* Our plugin's hooks as Codex lists them for `cwds`. */
async function listOurHooks(server, cwds) {
  const r = await server.request('hooks/list', { cwds });
  const out = [];
  for (const entry of (r && r.data) || []) {
    for (const h of entry.hooks || []) if (h.pluginId === PLUGIN_ID) out.push(h);
  }
  const seen = new Set();
  return out.filter((h) => (seen.has(h.key) ? false : seen.add(h.key)));
}

const NEEDS_REVIEW = new Set(['untrusted', 'modified']);

/** { total, review: [{ key, eventName, command, trustStatus, currentHash }] } for the plugin's hooks in `home`. */
async function hookStatus({ binary, home, cwds }) {
  return withAppServer(binary, home, async (server) => {
    const hooks = await listOurHooks(server, cwds);
    return { total: hooks.length, review: hooks.filter((h) => NEEDS_REVIEW.has(h.trustStatus)) };
  });
}

/*
 * Trust the plugin's hooks that need review, exactly as Codex's Settings > Hooks page does on Trust: the current hash
 * written to hooks.state."<key>".trusted_hash in the user's config.toml. Only for a caller that has the user's yes.
 */
async function trustHooks({ binary, home, cwds }) {
  return withAppServer(binary, home, async (server) => {
    const review = (await listOurHooks(server, cwds)).filter((h) => NEEDS_REVIEW.has(h.trustStatus));
    if (!review.length) return 0;
    const edits = review.map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash,
      mergeStrategy: 'upsert' }));
    const r = await server.request('config/batchWrite', { edits, filePath: null, expectedVersion: null, reloadUserConfig: true });
    if (r && r.status === 'okOverridden') throw new Error('Another config layer overrides these hook settings.');
    return review.length;
  });
}

module.exports = {
  MARKETPLACE, PLUGIN, PLUGIN_ID, DATA_DIR, SOURCE, planDir, cacheDir, installedVersions, pluginVersion, stageMarketplace,
  writeHookSettings, install, uninstall, hookStatus, trustHooks, hookKeys,
};
