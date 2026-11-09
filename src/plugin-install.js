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
 *
 * Whether Codex holds the plugin as this extension carries it is a matter of its files, not of its version: the version
 * goes up only when the plugin is released, and the hooks, skill and MCP server change between releases. The staged
 * copy carries a digest of the plugin's files and the Python it was fitted to, Codex copies it into its cache with the
 * rest, and installState() compares that with the digest of the files here and the Python found now.
 */
const crypto = require('crypto');
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
const pluginVersion = (source = SOURCE) => JSON.parse(fs.readFileSync(path.join(source, PLUGIN, '.codex-plugin', 'plugin.json'), 'utf8')).version;
/* In the plugin's own directory, which is what Codex copies into its cache; a dot file at that level (.mcp.json) is
   copied like the rest. */
const DIGEST_FILE = '.codex-extras-digest';

/** Whether some version of the plugin is in Codex's cache, and which. */
function installedVersions(home) {
  try { return fs.readdirSync(cacheDir(home)).filter((v) => fs.existsSync(path.join(cacheDir(home), v, '.codex-plugin'))); } catch (_) { return []; }
}

/*
 * A digest of the plugin's files as this extension carries them: every file's path and content, in path order, as
 * they are before fitting to a Python, so that the Python found on a machine does not count as a change of the plugin.
 * __pycache__ is left out, as staging leaves it out.
 */
function sourceDigest(source = SOURCE) {
  const root = path.join(source, PLUGIN);
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__pycache__' || e.name === DIGEST_FILE) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk(root, '');
  const hash = crypto.createHash('sha256');
  for (const f of files.sort()) hash.update(`${f}\0`).update(fs.readFileSync(path.join(root, ...f.split('/')))).update('\0');
  return hash.digest('hex');
}

/*
 * What a staged copy was fitted to, written under the digest of the plugin's files in DIGEST_FILE. A copy fitted to no
 * Python has no hooks, MCP server or skill, and one fitted to a Python started by another name names that Python's
 * path, so the copy in Codex's cache is current only for the Python found now as well as for the plugin's files. The
 * shipped `python3` is written by name alone, as fitHooks leaves those files untouched.
 */
function fitOf(python) {
  if (!python) return 'no python';
  if (python.launcher.length === 1 && python.launcher[0] === SHIPPED) return SHIPPED;
  return `${python.launcher.join(' ')} -> ${python.executable}`;
}

function digestLines(home, version) {
  try { return fs.readFileSync(path.join(cacheDir(home), version, DIGEST_FILE), 'utf8').trim().split(/\r?\n/); } catch (_) { return []; }
}
/** The digest Codex's cached copy of `version` carries, or '' for a copy without one (staged by an older build). */
function installedDigest(home, version) { return digestLines(home, version)[0] || ''; }
/** What that copy was fitted to (fitOf), or '' for a copy staged by a build that did not write it down. */
function installedFit(home, version) { return digestLines(home, version)[1] || ''; }

/*
 * Whether Codex's cache holds the plugin as it is here. `current` is true only for the same version with the same
 * files, fitted to `python` (what findPython found now, null for none) when one is given; `why` says otherwise:
 * 'not installed', 'other version', 'no digest' (installed by a build that recorded none, so its files are unknown and
 * taken to differ), 'files differ' or 'python differs'.
 */
function installState(home, source = SOURCE, python = undefined) {
  const versions = installedVersions(home);
  const want = pluginVersion(source);
  const digest = sourceDigest(source);
  let why = 'current';
  if (!versions.length) why = 'not installed';
  else if (!versions.includes(want)) why = 'other version';
  else {
    const have = installedDigest(home, want);
    why = !have ? 'no digest' : have !== digest ? 'files differ'
      : python !== undefined && installedFit(home, want) !== fitOf(python) ? 'python differs' : 'current';
  }
  return { current: why === 'current', why, versions, want, digest };
}

/*
 * Whether Codex is set to load the plugin, which is a thing apart from whether it is installed: 'loaded',
 * 'not loaded', or 'no entry' for a Codex that has never been told about it. Codex keeps it as `enabled` under
 * [plugins."<id>"] in config.toml, and its own settings page writes the same key.
 *
 * Read without a TOML parser, because only this one key of this one section is wanted and the shape of a section is
 * fixed: it runs from its own header to the next header, and `enabled` in it is a bare boolean. Another plugin's
 * section of the very same shape is therefore passed over rather than mistaken for this one.
 */
function pluginLoadState(home) {
  let text;
  try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch (_) { return 'no entry'; }
  const header = `[plugins.${JSON.stringify(PLUGIN_ID)}]`;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === header);
  if (at < 0) return 'no entry';
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('[')) break;
    const m = /^enabled\s*=\s*(true|false)\b/.exec(line);
    if (m) return m[1] === 'true' ? 'loaded' : 'not loaded';
  }
  /* Codex writes `enabled` when it installs a plugin, so a section without one has been edited by hand. A plugin Codex
     knows of and has not been told to skip is one it loads. */
  return 'loaded';
}

/*
 * Tell Codex to load the plugin, or to leave it where it is and not load it. Written through the app-server's own
 * config write, which takes Codex's lock on config.toml and keeps the rest of the file as it stands - the plugin, its
 * marketplace entry, the trust the user gave its hooks, and everything of the user's own.
 *
 * This is the step between keeping the plugin and removing it: uninstall() takes the plugin, its marketplace and that
 * trust away, and getting them back means installing and trusting again.
 */
const pluginEnabledEdits = (enabled) => [{ keyPath: `plugins.${JSON.stringify(PLUGIN_ID)}.enabled`,
  value: !!enabled, mergeStrategy: 'upsert' }];

async function setPluginEnabled({ binary, home, enabled }) {
  return withAppServer(binary, home, async (server) => {
    const edits = pluginEnabledEdits(enabled);
    const r = await server.request('config/batchWrite', { edits, filePath: null, expectedVersion: null, reloadUserConfig: true });
    if (r && r.status === 'okOverridden') throw new Error('Another config layer overrides whether this plugin is loaded.');
    return { enabled: !!enabled };
  });
}

/*
 * Copy the marketplace to `stage`, replacing what an earlier version left there, and fit the copy to the Python found
 * on this machine. `python` is what src/python-runtime.js findPython returned, or null when there is none.
 */
function stageMarketplace(stage, source = SOURCE, python = SHIPPED_PYTHON) {
  fs.mkdirSync(stage, { recursive: true });
  for (const name of fs.readdirSync(stage)) fs.rmSync(path.join(stage, name), { recursive: true, force: true });
  fs.cpSync(source, stage, { recursive: true, filter: (p) => !p.includes(`${path.sep}__pycache__`) });
  fitHooks(stage, python);
  fs.writeFileSync(path.join(stage, PLUGIN, DIGEST_FILE), `${sourceDigest(source)}\n${fitOf(python)}\n`);
  return path.join(stage, MANIFEST);
}

/* What the plugin ships as: the name in its own hooks and MCP server, which needs no fitting. */
const SHIPPED = 'python3';
const SHIPPED_PYTHON = { launcher: [SHIPPED], executable: SHIPPED, version: '' };
/* A hook command as the plugin ships it; the program is replaced and the rest of the line is left exactly as it was. */
const HOOK_COMMAND = /^python3 (".+")$/;
/* Hook commands are a shell line, as the `$PLUGIN_ROOT` in them shows, so a program with a space in its path is
   quoted the way the paths already in that line are. A Windows path cannot contain a double quote. */
const quote = (w) => (/^[\w@%+=:,./\\-]+$/.test(w) ? w : `"${w.replace(/"/g, '')}"`);

/**
 * Rewrite a staged copy of the plugin to use one Python. Returns a description of what it did, for the log.
 *
 * With `python3` nothing is written, because that is what the plugin already says. Rewriting it to the same thing
 * would change the plugin's file hashes, which is what Codex asks the user to trust, so every install would ask again.
 *
 * With any other Python, the three places that start it are rewritten to use the one that was found.
 *
 * A hook command is a shell line, since the `$PLUGIN_ROOT` in it needs a shell to expand it, so it gets the words
 * a person would type (`py -3`, `python`) rather than the interpreter's path. A bare name needs no quoting and runs
 * under whichever shell Codex uses; a quoted path does not, because PowerShell, which Codex uses on Windows, needs `&`
 * in front of one, and no single spelling runs in both it and a POSIX shell. The shipped command already resolves
 * `python3` through PATH, and keeping to a bare name keeps it that way. The only launcher with no name to use is a
 * Python downloaded by this extension, which is a path and is quoted; plan_path.launcher_quoted marks that same case
 * for the row command.
 *
 * The MCP server does get the full path, since Codex starts it as a program with its arguments rather than as a line
 * for a shell, and hooks/launcher.json gets the launcher words, which is what the model is told to type
 * (plan_path.py launcher, row_command).
 *
 * With no Python at all the copy keeps no hooks, no MCP server and no skill. Hooks that cannot start would put an
 * error in the conversation every turn, and the skill would have the model run a command that cannot start.
 */
function fitHooks(dir, python) {
  const plugin = path.join(dir, PLUGIN);
  const hooksFile = path.join(plugin, 'hooks', 'hooks.json');
  const mcpFile = path.join(plugin, '.mcp.json');
  if (!python) {
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }, null, 2) + '\n');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
    fs.rmSync(path.join(plugin, 'skills'), { recursive: true, force: true });
    return { state: 'stripped', hooks: 0, launcher: [] };
  }
  if (python.launcher.length === 1 && python.launcher[0] === SHIPPED) {
    return { state: 'shipped', hooks: hookKeys(dir).length, launcher: [SHIPPED] };
  }
  const program = python.launcher.map(quote).join(' ');
  const config = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  let fitted = 0, strange = [];
  for (const groups of Object.values(config.hooks || {})) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        const m = HOOK_COMMAND.exec(hook.command || '');
        if (m) { hook.command = `${program} ${m[1]}`; fitted++; } else strange.push(hook.command || '(no command)');
      }
    }
  }
  // Loudly, because the alternative is a plugin installed with some hooks still naming a Python that is not there.
  if (strange.length) throw new Error(`these hook commands are not in the form this extension knows how to fit to `
    + `another Python: ${strange.join('; ')}`);
  fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2) + '\n');
  const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  for (const server of Object.values(mcp.mcpServers || {})) {
    if (server && server.command === SHIPPED) {
      server.command = python.executable;
      if (python.launcher.length > 1) server.args = python.launcher.slice(1).concat(server.args || []);
    }
  }
  fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + '\n');
  fs.writeFileSync(path.join(plugin, 'hooks', 'launcher.json'), JSON.stringify({ row: python.launcher }) + '\n');
  return { state: 'fitted', hooks: fitted, launcher: python.launcher };
}

/*
 * What the hooks are told by this editor: written into the plugin's data directory as config.json (plan_path.py reads
 * it). `values` holds only keys the hooks know.
 *
 * `marker` is this editor's global storage directory for this extension. Every editor sharing the Codex home lists its
 * own in extensionMarkers, and a directory that is gone is dropped. VS Code deletes that directory once no copy of this
 * extension is left in its extensions folder, and not on an update, so a list in which none of them exists any more is
 * a plugin whose extension was uninstalled everywhere, and its hooks then do nothing (plan_path.py settings).
 */
function writeHookSettings(home, values, { marker = '' } = {}) {
  const dir = planDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const out = { ...values };
  if (marker) {
    fs.mkdirSync(marker, { recursive: true });
    let before = [];
    try { const v = JSON.parse(fs.readFileSync(file, 'utf8')).extensionMarkers; if (Array.isArray(v)) before = v; } catch (_) { /* none yet */ }
    out.extensionMarkers = before.filter((d) => typeof d === 'string' && path.isAbsolute(d) && d !== marker && fs.existsSync(d))
      .concat(marker);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/*
 * Install or upgrade the plugin into `home`. Resolves to { version, marketplace, python, loaded }.
 *
 * `load` says what becomes of whether Codex loads it: true has Codex load it (the install command, which is also the way
 * back from "Stop Loading"); 'keep' leaves a plugin the user set not to be loaded as it was (the install at start-up).
 * Either is written after plugin/install, in the same app-server, so the outcome does not depend on what Codex's install
 * does with the key. `loaded` is false only when it was kept off.
 */
async function install({ binary, home, stage, source = SOURCE, python = SHIPPED_PYTHON, load = true }) {
  const manifest = stageMarketplace(stage, source, python);
  const keepOff = load === 'keep' && pluginLoadState(home) === 'not loaded';
  return withAppServer(binary, home, async (server) => {
    const add = () => server.request('marketplace/add', { source: stage });
    let added;
    try {
      added = await add();
    } catch (e) {
      // Codex refuses a second source under a name it already holds, such as a staging path of an earlier build.
      if (!/already added from a different source/i.test(String((e && e.message) || ''))) throw e;
      await server.request('marketplace/remove', { marketplaceName: MARKETPLACE });
      added = await add();
    }
    if (added && added.installedRoot && path.resolve(added.installedRoot) !== path.resolve(fs.realpathSync(stage))
      && path.resolve(added.installedRoot) !== path.resolve(stage)) {
      // A marketplace of this name registered elsewhere (an older staging path): point it here.
      await server.request('marketplace/remove', { marketplaceName: MARKETPLACE });
      await server.request('marketplace/add', { source: stage });
    }
    await server.request('plugin/install', { marketplacePath: manifest, pluginName: PLUGIN });
    if (load === true || keepOff) {
      const r = await server.request('config/batchWrite', { edits: pluginEnabledEdits(!keepOff), filePath: null,
        expectedVersion: null, reloadUserConfig: true });
      if (r && r.status === 'okOverridden') throw new Error('Another config layer overrides whether this plugin is loaded.');
    }
    return { version: pluginVersion(source), marketplace: stage, python, loaded: !keepOff };
  });
}

/*
 * Remove the plugin and its marketplace from `home`. The plans are copied first to
 * <home>/agent-work-plan-plans-<timestamp>/, because removing a plugin may remove its data directory with it. Resolves
 * to the folder they were copied to, or '' when there were none. When they cannot be copied (the folder cannot be read
 * for any reason but not existing, or a copy fails) it throws before anything is removed, and the plans stay where they
 * are.
 */
async function uninstall({ binary, home }) {
  const kept = savePlans(home);
  await withAppServer(binary, home, async (server) => {
    try { await server.request('plugin/uninstall', { pluginId: PLUGIN_ID }); } catch (_) { /* not installed */ }
    try { await server.request('marketplace/remove', { marketplaceName: MARKETPLACE }); } catch (_) { /* not added */ }
    // The trust the user gave the hooks is kept by Codex under each hook's key; a null removes it.
    const edits = hookKeys().map((key) => ({ keyPath: `hooks.state.${JSON.stringify(key)}`, value: null, mergeStrategy: 'replace' }));
    try { await server.request('config/batchWrite', { edits, filePath: null, expectedVersion: null, reloadUserConfig: true }); } catch (_) { /* none kept */ }
  });
  return kept;
}

/* Copies the plans out of `home` before an uninstall. '' when there are none; throws when they could not all be copied. */
function savePlans(home, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  const dir = planDir(home);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    if (e && e.code === 'ENOENT') return '';
    throw new Error(`The plans in ${dir} could not be read (${(e && e.code) || e}), so the plugin was not removed and they are where they were.`);
  }
  const plans = names.filter((n) => n.endsWith('.json') && n !== 'config.json');
  if (!plans.length) return '';
  const kept = path.join(home, `agent-work-plan-plans-${stamp}`);
  try {
    fs.mkdirSync(kept, { recursive: true });
    for (const n of plans) fs.copyFileSync(path.join(dir, n), path.join(kept, n));
  } catch (e) {
    throw new Error(`The plans in ${dir} could not all be copied to ${kept} (${(e && e.code) || e}), so the plugin was not removed `
      + 'and they are where they were.');
  }
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
 * written to hooks.state."<key>".trusted_hash in the user's config.toml. Only for a caller that has the user's yes, and
 * only for what the user was shown: `shown` is that list of { key, currentHash }. When the hooks needing review are no
 * longer exactly those (the plugin was updated, another window trusted some, the Codex home changed) nothing is written
 * and the new list comes back to be shown again. Resolves to { trusted, changed, review }.
 */
async function trustHooks({ binary, home, cwds, shown }) {
  return withAppServer(binary, home, async (server) => {
    const review = (await listOurHooks(server, cwds)).filter((h) => NEEDS_REVIEW.has(h.trustStatus));
    if (!sameHooks(review, shown)) return { trusted: 0, changed: true, review };
    if (!review.length) return { trusted: 0, changed: false, review };
    const edits = review.map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash,
      mergeStrategy: 'upsert' }));
    const r = await server.request('config/batchWrite', { edits, filePath: null, expectedVersion: null, reloadUserConfig: true });
    if (r && r.status === 'okOverridden') throw new Error('Another config layer overrides these hook settings.');
    return { trusted: review.length, changed: false, review };
  });
}

/* Whether two lists of hooks name the same keys with the same hashes, in any order. */
function sameHooks(a, b) {
  const sig = (list) => (Array.isArray(list) ? list : []).map((h) => `${h && h.key}\u0000${h && h.currentHash}`).sort().join('\n');
  return Array.isArray(b) && sig(a) === sig(b);
}

module.exports = {
  MARKETPLACE, PLUGIN, PLUGIN_ID, DATA_DIR, DIGEST_FILE, SOURCE, SHIPPED, SHIPPED_PYTHON, planDir, cacheDir, installedVersions,
  pluginVersion, sourceDigest, installedDigest, installedFit, fitOf, installState, stageMarketplace, fitHooks, pluginLoadState, setPluginEnabled, pluginEnabledEdits,
  writeHookSettings, install, uninstall, savePlans, hookStatus, trustHooks, sameHooks, hookKeys,
};
