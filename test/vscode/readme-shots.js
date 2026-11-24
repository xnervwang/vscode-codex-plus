// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: xvfb-run -a -s "-screen 0 3200x2000x24" node test/vscode/readme-shots.js --pack <dir> --vsix <file>
 *          [--core <Agent Plus .vsix>] [--out <dir>] [--cache <dir>] [<shot> ...]
 *
 * Takes the README's screenshots in a separate VS Code install: the current stable release, with the newest Codex build
 * src/supported-versions.json lists, Agent Plus from --core or else the marketplace, and this extension from --vsix, so
 * a feature can be shown before it is published. With shot names it takes only those. Needs @vscode/test-electron and
 * playwright-core, as run.js does, and a display (xvfb-run on Linux).
 *
 * The pack is a folder holding a demo project and demo conversations (pack.json says which). Each run copies them into
 * a new HOME, CODEX_HOME and workspace under ROOT and rewrites the records to match, so a screenshot shows only paths
 * under ROOT. Each Codex conversation gets a new thread id, because other VS Code windows on the machine scan the same
 * processes and would otherwise count the demo's sleep as the original conversation's command.
 *
 * VS Code and the marketplace extensions are kept in --cache between runs. The window runs at twice the pixel density,
 * and each shot leaves out the title bar and status bar, which show the window's name.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HERE = __dirname;
const REPO = path.join(HERE, '..', '..');
const SCALE = 2;
/* VS Code takes the device scale factor only on its command line, which window.js builds; this adds it to that one
   executable's command line. */
const realSpawn = cp.spawn;
let EXE = '';
cp.spawn = (exe, args, opts) => realSpawn(exe, exe === EXE ? [...args, `--force-device-scale-factor=${SCALE}`] : args, opts);
const win = require('./lib/window');
const fakeModel = require('./lib/fake-model');
const fakeHome = require('./lib/fake-home');
const { sleep, until } = win;

/* Short, because Codex listens on a Unix socket under CODEX_HOME. */
const ROOT = path.join(os.tmpdir(), 'codex-plus-demo');
const PLAN_DIR = path.join('plugins', 'data', 'agent-work-plan-codex-extras');
const SHOTS = ['work-plan', 'images-in-replies', 'reply-figures', 'navigation', 'context-meter', 'session-info', 'agent-map',
  'session-list'];

const args = process.argv.slice(2);
const flag = (name, dflt = '') => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1] || ''; args.splice(i, 2); return v; };
const PACK = path.resolve(flag('--pack'));
const VSIX = path.resolve(flag('--vsix'));
const CORE_ARG = flag('--core');
const CORE = CORE_ARG ? path.resolve(CORE_ARG) : '';
const OUT = path.resolve(flag('--out', path.join(REPO, 'images', 'shots')));
const CACHE = path.resolve(flag('--cache', path.join(os.homedir(), '.cache', 'codex-plus-shots')));
const ONLY = args.filter((a) => SHOTS.includes(a));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* The newest Codex build this commit was verified against. */
function codexVersion() {
  const v = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'src', 'supported-versions.json'), 'utf8')).codex || {});
  const num = (s) => s.split('.').map(Number);
  v.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
  if (!v.length) throw new Error('src/supported-versions.json lists no Codex build');
  return v[v.length - 1];
}

/* A new thread id that keeps the original's leading time stamp. The rest is a hash of the original, the same on every run. */
function demoId(id) {
  const h = crypto.createHash('sha1').update(`readme-shots:${id}`).digest('hex');
  return `${id.slice(0, 14)}7${h.slice(0, 3)}-8${h.slice(3, 6)}-${h.slice(6, 18)}`;
}

/* The pack does not carry the demo conversation's name. */
const TITLE = 'Import bank statements';
const TITLES = { '01a1c321-8585-7621-93b0-f7d7106ca508': 'Import bank statements' };

/* The pack's rollouts were recorded on a machine where Codex Plus 1.3.0 or earlier injected skill lists. Those lists
   name that machine's skills and paths, so they are left out of the copy. */
const routed = (line) => line.includes('"role":"developer"') && line.includes('Skills that may fit this message');

function lastTime(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const t = JSON.parse(lines[i]).timestamp; if (t) return t; } catch (_) { /* not a record */ }
  }
  return new Date().toISOString();
}

/* As Codex Plus names scratch folders. */
const dashed = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/.test(k) || k === 'LD_LIBRARY_PATH') delete env[k];
  const home = path.join(ROOT, 'home');
  return Object.assign(env, { HOME: home, CODEX_HOME: path.join(ROOT, 'c'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share') }, extra);
}

function cli(te, exe) {
  const tool = te.resolveCliArgsFromVSCodeExecutablePath(exe, { reuseMachineInstall: true })[0];
  return (argv, env) => {
    const r = cp.spawnSync(tool, argv, { env, encoding: 'utf8', maxBuffer: 64 << 20 });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
}

function seed(pack, manifest, codexHome, home, folder, modelUrl) {
  const skip = /(^|\/)(\.git|__pycache__)(\/|$)/;
  fs.cpSync(path.join(pack, 'project'), folder, { recursive: true, filter: (src) => !skip.test(path.relative(pack, src)) });
  fakeHome.write(codexHome, { folder, modelUrl });
  /* Codex took the demo model's window as 95% of 500k. The information box shows the provider's name. */
  const config = path.join(codexHome, 'config.toml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(/^model = .*$/m, 'model = "openai.gpt-6.1-sol"\nmodel_context_window = 500000')
    .replace(/^name = .*$/m, 'name = "Amazon Bedrock"'));
  const srcHome = manifest.sourceHome, srcProject = manifest.sourceProject;
  const ids = manifest.codex.map((c) => [c.id, demoId(c.id), c.rollout]);
  const pairs = [[path.join(srcHome, '.codex'), codexHome], [srcProject, folder], [dashed(srcProject), dashed(folder)]];
  for (const [a, b] of ids) pairs.push([a, b]);
  pairs.push([srcHome, home]);
  if (manifest.linkedHome) pairs.push([path.join(manifest.linkedHome, '.codex'), codexHome], [manifest.linkedHome, home]);
  /* Codex looks for AGENTS.md in every folder up the tree, so the records name the folder above the home too. */
  pairs.push([path.dirname(srcHome) + '/', path.dirname(home) + '/']);
  /* fake-home.js points Codex at the made-up model under this provider's name. */
  pairs.push([/"model_provider":"[^"]*"/g, '"model_provider":"fake"']);
  const fix = (text) => pairs.reduce((t, [a, b]) => (a instanceof RegExp ? t.replace(a, b) : t.split(a).join(b)), text);
  const plans = path.join(codexHome, PLAN_DIR);
  fs.mkdirSync(plans, { recursive: true });
  const names = [];
  for (const [id, as, rollout] of ids) {
    const src = path.join(pack, 'codex', id);
    const to = path.join(codexHome, rollout.split(id).join(as));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const lines = fix(fs.readFileSync(path.join(src, 'rollout.jsonl'), 'utf8')).split('\n').filter((l) => !routed(l));
    fs.writeFileSync(to, lines.join('\n'));
    names.push({ id: as, thread_name: TITLES[id] || TITLE, updated_at: lastTime(lines) });
    if (fs.existsSync(path.join(src, 'plan.json'))) fs.writeFileSync(path.join(plans, `${as}.json`), fix(fs.readFileSync(path.join(src, 'plan.json'), 'utf8')));
    if (fs.existsSync(path.join(src, 'scratch'))) fs.cpSync(path.join(src, 'scratch'), path.join(codexHome, 'scratch', dashed(folder), as), { recursive: true });
  }
  /* Codex shows a conversation's name from this index; without one its header reads "New chat". */
  fs.appendFileSync(path.join(codexHome, 'session_index.jsonl'), names.map((n) => JSON.stringify(n) + '\n').join(''));
  const main = ids[0][1];
  fakeHome.wakeup(codexHome, main, { everyMinutes: 60, prompt: 'Import this week\'s bank statement and report anything over budget.' });
  return main;
}

function writeSettings(user) {
  fs.mkdirSync(path.join(user, 'User'), { recursive: true });
  fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    'workbench.startupEditor': 'none', 'workbench.tips.enabled': false, 'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none',
    'workbench.colorTheme': 'Default Dark Modern', 'chat.disableAIFeatures': true, 'git.enabled': false,
    'window.newWindowDimensions': 'maximized', 'window.dialogStyle': 'custom', 'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'agentPlus.webviewRequestLimit': 'leave',
  }, null, 2));
}

async function main() {
  if (!fs.existsSync(path.join(PACK, 'pack.json')) || !fs.existsSync(VSIX) || (CORE && !fs.existsSync(CORE))) {
    throw new Error('usage: readme-shots.js --pack <dir with pack.json> --vsix <codex-plus .vsix> [--core <agent-plus .vsix>] [--out <dir>] [--cache <dir>] [<shot> ...]');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PACK, 'pack.json'), 'utf8'));
  if (!(manifest.codex || []).length) throw new Error('the pack has no Codex conversation');
  const te = require('@vscode/test-electron');
  const playwright = require('playwright-core');
  fs.rmSync(ROOT, { recursive: true, force: true });
  const p = { exts: path.join(CACHE, 'exts'), user: path.join(ROOT, 'user'), folder: path.join(ROOT, 'ws', manifest.project),
    control: path.join(ROOT, 'ctl'), home: path.join(ROOT, 'home'), codexHome: path.join(ROOT, 'c') };
  for (const d of [p.exts, p.user, path.dirname(p.folder), p.control, p.home, p.codexHome, OUT]) fs.mkdirSync(d, { recursive: true });
  const env = cleanEnv();
  for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) fs.mkdirSync(env[k], { recursive: true });

  const exe = await te.downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(CACHE, 'vscode') });
  EXE = exe;
  const code = cli(te, exe);
  const profile = [`--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`];
  const have = code(['--list-extensions', '--show-versions', ...profile], env).out.split('\n');
  for (const ext of [`openai.chatgpt@${codexVersion()}`, ...(CORE ? [] : ['xnervwang.agent-plus'])]) {
    if (have.some((l) => (ext.includes('@') ? l === ext : l.startsWith(`${ext}@`)))) continue;
    const r = code(['--install-extension', ext, '--force', ...profile], env);
    if (r.status !== 0) throw new Error(`installing ${ext}: ${r.out}`);
  }
  for (const file of [CORE, VSIX].filter(Boolean)) {
    const r = code(['--install-extension', file, '--force', ...profile], env);
    if (r.status !== 0) throw new Error(`installing ${file}: ${r.out}`);
  }
  log('installed', code(['--list-extensions', '--show-versions', ...profile], env).out.replace(/\n/g, ', '));

  const model = await fakeModel.start();
  const tid = seed(PACK, manifest, p.codexHome, p.home, p.folder, model.url);
  writeSettings(p.user);
  /* Codex Plus finds detached commands through /proc, so the Agent map lists this one on Linux only. Started by setsid
     from a shell that exits at once, it leads its own session and has init as its parent, like a command a conversation
     detaches. The cleanup finds it by the thread id in its environment. */
  const mark = `CODEX_THREAD_ID=${tid}`;
  const sleepers = () => (process.platform !== 'linux' ? [] : fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
    try { return fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim() === 'sleep' && fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(mark); } catch (_) { return false; }
  }).map(Number));
  if (process.platform === 'linux') {
    cp.spawnSync('sh', ['-c', 'setsid sleep 1800 < /dev/null > /dev/null 2>&1 &'], { env: { ...env, CODEX_THREAD_ID: tid }, cwd: p.folder, stdio: 'ignore' });
  }

  const w = await win.open({ exe, profile: p, env, playwright, log: path.join(ROOT, 'vscode-window.log') });
  const { page, call } = w;
  const exec = (command, ...a) => call(`await vscode.commands.executeCommand(${JSON.stringify(command)}, ...arg); return true;`, a);
  const patched = () => call(`
    const mine = vscode.extensions.getExtension('xnervwang.codex-plus'), codex = vscode.extensions.getExtension('openai.chatgpt');
    if (!mine || !codex) return false;
    const A = require(require('path').join(mine.extensionPath, 'src', 'adapters'));
    return A.every((a) => a.status(codex.extensionPath) === 'patched');`);
  const frameWhere = (test, ms, arg) => until(async () => {
    for (const f of page.frames()) { try { if (await f.evaluate(test, arg)) return f; } catch (_) { /* not ready, or gone */ } }
    return null;
  }, ms, 500);
  const away = async () => { await page.mouse.move(2, 450); await sleep(300); };
  const quiet = async () => { await exec('notifications.hideToasts').catch(() => {}); };
  const part = (id) => page.evaluate((id) => {
    const e = document.getElementById(id);
    if (!e || !e.offsetWidth) return null;
    const b = e.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  }, id);
  const snap = async (name, clip) => {
    await quiet();
    const c = { x: Math.round(clip.x), y: Math.round(clip.y), width: Math.round(clip.width), height: Math.round(clip.height) };
    await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled', clip: c });
    log('shot', name, `${c.width * SCALE}x${c.height * SCALE}`);
  };
  const want = (name) => !ONLY.length || ONLY.includes(name);
  /* Codex Plus asks whether to trust its plugin's hooks, first in a notification and later in a dialog. The answer is
     yes, in this temporary Codex home, so that the question stays out of the shots. */
  let watching = true;
  const trustWatch = (async () => {
    while (watching) {
      try {
        for (const box of [page.locator('.monaco-dialog-box').filter({ hasText: 'Trust the work plan hooks in Codex?' }).first(),
          page.locator('.notification-list-item').filter({ hasText: 'Trust the work plan hooks in Codex?' }).first()]) {
          if (await box.isVisible()) await box.locator('.monaco-button').filter({ hasText: 'Trust them' }).first().dispatchEvent('click');
        }
      } catch (_) { /* the window is reloading */ }
      await sleep(400);
    }
  })();

  try {
    await w.hostUp();
    if (!await until(patched, 120000, 1000)) throw new Error('Codex Plus did not patch Codex in 120 s');
    await w.reload();
    await sleep(5000);
    await exec('workbench.action.closeAuxiliaryBar').catch(() => {});
    await exec('workbench.action.closePanel').catch(() => {});
    await exec('codexPlus.openThreadInTab', tid);
    const conv = await frameWhere(() => innerWidth > 600 && document.querySelectorAll('[data-response-annotation-target]').length >= 4
      && !!document.querySelector('[data-codex-extras="stamp"]'), 120000);
    if (!conv) throw new Error('the demo conversation did not open in 120 s');
    await sleep(3000);
    /* Scrolls the conversation so that your message starting with `text` is at the top, leaving the rail's copy alone. */
    const toMessage = async (text) => {
      for (let i = 0; i < 40; i++) {
        const found = await conv.evaluate((text) => {
          const b = [...document.querySelectorAll('[data-user-message-bubble]')].find((e) => e.textContent.trim().startsWith(text));
          if (!b) return false;
          b.scrollIntoView({ block: 'start', container: 'nearest' });
          document.querySelector('[data-app-action-timeline-scroll]').scrollBy(0, -110);
          return true;
        }, text);
        if (found) { await sleep(1200); return true; }
        /* The list draws only the turns near the view, so the message may not be in the page yet. */
        await conv.evaluate(() => { const s = document.querySelector('[data-app-action-timeline-scroll]'); s.scrollBy(0, -s.clientHeight * 0.8); });
        await sleep(500);
      }
      return false;
    };
    const toBottom = async () => {
      await conv.evaluate(() => { const s = document.querySelector('[data-app-action-timeline-scroll]'); s.scrollTop = s.scrollHeight; });
      await sleep(1500);
    };
    /* Drags the side bar's sash: at the default width its rows are cut short. */
    const widen = async (to = 460) => {
      const sb = await part('workbench.parts.sidebar');
      if (!sb || sb.width >= to - 4) return;
      const sash = await page.evaluate((edge) => {
        const b = [...document.querySelectorAll('.monaco-sash.vertical')].map((e) => e.getBoundingClientRect())
          .find((r) => r.height > 200 && Math.abs(r.left + r.width / 2 - edge) < 6);
        return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
      }, sb.x + sb.width);
      if (!sash) return;
      await page.mouse.move(sash.x, sash.y);
      await sleep(200);
      await page.mouse.down();
      await page.mouse.move(sash.x + (to - sb.width), sash.y, { steps: 10 });
      await page.mouse.up();
      await sleep(500);
    };
    const editor = () => part('workbench.parts.editor');
    const sidebar = () => part('workbench.parts.sidebar');
    /* The editor's width in a shot must not depend on which other shots are taken: the side bar is widened here,
       before the first. */
    await exec('workbench.view.extension.agentPlus');
    await sleep(1500);
    await widen();

    if (want('work-plan')) {
      await exec('workbench.view.extension.agentPlus');
      await sleep(2500);
      await widen();
      await away();
      await snap('work-plan', await sidebar());
    }
    if (want('images-in-replies')) {
      await toBottom();
      await until(() => conv.evaluate(() => [...document.querySelectorAll('[data-response-annotation-target] img')].some((i) => i.naturalWidth > 0)), 30000, 500);
      await conv.evaluate(() => [...document.querySelectorAll('[data-response-annotation-target] img')].find((i) => i.naturalWidth > 0)
        .scrollIntoView({ block: 'center', container: 'nearest' }));
      await sleep(1000);
      await away();
      await snap('images-in-replies', await editor());
    }
    if (want('reply-figures')) {
      /* Codex draws only a long conversation's last few turns, so the shot uses one of those. */
      if (!await toMessage('Put those under')) throw new Error('the message "Put those under …" is not on the page');
      await away();
      await snap('reply-figures', await editor());
    }
    if (want('navigation')) {
      await toMessage('What should happen when a row matches no rule');
      await conv.locator('.codex-extras-rail-handle').first().click();
      if (!await until(() => conv.evaluate(() => { const p = document.querySelector('.codex-extras-panel'); return !!(p && getComputedStyle(p).display !== 'none'); }), 5000, 200)) {
        throw new Error(`the rail's list did not open: ${await conv.evaluate(() => document.querySelectorAll('[data-codex-extras="nav-row"]').length)} rows`);
      }
      await away();
      /* The list holds only the messages Codex has drawn. */
      const rows = conv.locator('[data-codex-extras="nav-row"]');
      await rows.nth(Math.min(3, await rows.count() - 1)).hover();
      await sleep(800);
      await snap('navigation', await editor());
      await conv.locator('.codex-extras-rail-handle').first().click();
      await sleep(400);
    }
    if (want('context-meter')) {
      await toBottom();
      await conv.locator('[data-codex-extras="meter"]').first().hover();
      const shown = await until(() => conv.evaluate(() => { const b = document.querySelector('[data-codex-extras="context"]'); return !!(b && getComputedStyle(b).display !== 'none'); }), 10000, 200);
      if (!shown) log('the context meter showed no hover: context-meter skipped');
      else { await sleep(2500); await snap('context-meter', await editor()); }
      await away();
    }
    if (want('session-info')) {
      const button = conv.locator('[data-codex-extras="bar-button"][aria-label^="About this conversation"]').first();
      await button.click();
      await until(() => conv.evaluate(() => { const b = document.querySelector('[data-codex-extras="info"]'); return !!(b && getComputedStyle(b).display !== 'none'); }), 10000, 200);
      await away();
      await snap('session-info', await editor());
      await button.click();
      await sleep(400);
    }
    if (want('agent-map')) {
      const pill = conv.locator('[data-codex-extras="agents"]').first();
      await until(() => conv.evaluate(() => /\bdetached\b/.test((document.querySelector('[data-codex-extras="agents"]') || {}).textContent || '')),
        process.platform === 'linux' ? 60000 : 1, 500);
      if (!await pill.isVisible().catch(() => false)) log('the Agent map button counted nothing: agent-map skipped');
      else {
        await pill.click();
        await until(() => conv.evaluate(() => !!document.querySelector('[data-codex-extras="map-dialog"]')), 5000, 200);
        await sleep(800);
        await away();
        await snap('agent-map', await editor());
        await page.keyboard.press('Escape');
        await sleep(400);
      }
    }
    if (want('session-list')) {
      await exec('workbench.view.extension.codexPlus');
      const list = await frameWhere(() => !!document.querySelector('.cp-root'), 60000);
      if (!list) log('the session list did not open: session-list skipped');
      else {
        await sleep(2500);
        await widen();
        await away();
        await snap('session-list', await sidebar());
      }
    }
  } finally {
    watching = false;
    await trustWatch;
    await w.close();
    await model.close();
    for (const pid of sleepers()) { try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gone */ } }
  }
}

main().catch((e) => { console.error((e && e.stack) || e); process.exitCode = 1; });
