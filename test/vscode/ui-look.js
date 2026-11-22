// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The window stage of `run.js --look`. It drives the same window as ui.js through every feature that
 * ui-look-features.json lists and takes a screenshot at each step for a reader to judge by eye. Nothing here is a pass
 * or fail of the extension; a step whose actions failed records that in its log, and the screenshot is taken anyway.
 *
 * Each look('<name>', ...) call is one step. After the step's actions it saves two PNGs at twice the CSS pixel density,
 * a close view of the part the step is about and the whole window, and adds an entry to <out>/look.json:
 *
 *   name, features   the step and the ids of the features that list it in ui-look-features.json
 *   expect           what the step should show, in words
 *   unchanged        what the step should not have changed
 *   image, full      paths of those two PNGs, relative to <out>
 *   previous         the previous step's whole window, or null
 *   log              new lines since the step before in the extension host's log and in the Codex Plus and Agent Plus
 *                    output channels, the notifications on screen, and the step's own failures, marked [ui-look]
 *
 * Notifications stay on screen, since an error notification is one of the things the reader looks for.
 *
 * Unlike ui.js, it trusts the work plan plugin's hooks when asked, so the skill search, the plan's injection and its
 * Stop hook run.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const SCALE = 2;
/* VS Code takes the device scale factor only on its command line, which lib/window.js builds; this adds it to the
   executable's command line, before lib/window.js keeps its own reference to spawn. */
let EXE = '';
const realSpawn = cp.spawn;
cp.spawn = (exe, args, opts) => realSpawn(exe, exe === EXE ? [...args, `--force-device-scale-factor=${SCALE}`] : args, opts);
const win = require('./lib/window');
const pixels = require('./lib/pixels');
const { codexBinary } = require('../../src/appserver');

const { sleep, until } = win;
const FEATURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'ui-look-features.json'), 'utf8'));
/* Added to the settings run.js writes: a window as large as the screen, no secondary side bar until a step opens one
   (Codex's would otherwise open there at start-up, beside every shot), and a context window the meter's hover can say
   it took from this extension's setting. */
const LOOK_SETTINGS = { 'window.newWindowDimensions': 'maximized', 'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'codexPlus.contextWindow': { 'gpt-6.1-sol': '600K' } };
/* TAB_DOTS in src/patching.js. */
const DOTS = { working: [0x22, 0xc5, 0x5e], unread: [0xef, 0x44, 0x44], prompt: [0x3b, 0x82, 0xf6] };
const PLAN_DIR = path.join('plugins', 'data', 'agent-work-plan-codex-extras');
const TRUST = 'Trust the work plan hooks in Codex?';
const WAKEUP_LINE = 'Wake-up set in this conversation';
const LOG_LINES = 80;

async function run({ exe, profile, env, playwright, model, threads, out, check, note }) {
  EXE = exe;
  const shotsDir = path.join(out, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const plans = path.join(profile.codexHome, PLAN_DIR);
  fs.mkdirSync(plans, { recursive: true });
  const t0 = threads[0], t1 = threads[1], t2 = threads[2];
  const title = t0.title;

  /* ── what the window starts with, beyond run.js's made-up home ── */
  const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');
  const QUESTION = 'Should the default retry delay stay at 30 seconds, or go up to 60?';
  const writePlan = (findState) => fs.writeFileSync(path.join(plans, `${t0.id}.json`), JSON.stringify({
    nodes: [{ title: 'Find the retry delay', state: findState, since: iso(), ...(findState === 'done' ? { closed: iso() } : {}) },
      { title: 'Decide the default delay', state: 'waiting', waitingOn: 'user', question: QUESTION, asked: iso(), since: iso() },
      { title: 'Update the docs', state: 'todo', since: iso() }],
    brief: { summary: 'Finding where the inventory sync sets its retry delay, and deciding its default.', summaryAt: iso(),
      status: { doing: 'Reading the sync job\'s configuration', progress: 'Found the setting', next: 'Wait for the decision on the default' },
      statusAt: iso() } }));
  /* A row left doing at the end of a turn makes the plugin's Stop hook ask for the plan to be brought up to date, which
     Codex draws as a prompt of the user's with "Hook feedback" under it. */
  writePlan('doing');
  /* A skill only the default extra folder of codexPlus.skillRoutingExtraFolders holds, for the skill search to name. */
  const skill = path.join(profile.home, '.claude', 'skills', 'inventory-sync-retry');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: inventory-sync-retry\ndescription: Where the inventory sync sets its retry '
    + 'delay and back-off, and how to change the retry delay of the sync job.\n---\n\nRead config/sync.yaml first.\n');
  const wakeupFile = path.join(plans, `${t0.id}.wakeup`);
  const setWakeup = (everyMinutes, setAgo = 0) => {
    const w = JSON.parse(fs.readFileSync(wakeupFile, 'utf8'));
    const at = Math.floor(Date.now() / 1000) - setAgo;
    fs.writeFileSync(wakeupFile, JSON.stringify({ ...w, everyMinutes, setAt: at, expiresAt: at + 7 * 86400 }));
  };

  const w = await win.open({ exe, profile, env, playwright, log: path.join(out, 'vscode-window.log') });
  const { page, call } = w;
  const OWN = `const mine = vscode.extensions.getExtension('xnervwang.codex-plus');
    const own = (m) => { const file = require('path').join(mine.extensionPath, 'src', m + '.js');
      const k = Object.keys(require.cache).find((x) => x.toLowerCase() === file.toLowerCase());
      return k ? require.cache[k].exports : require(file); };`;

  /* ── the vscode API, as ui.js uses it ── */
  const patchState = () => call(`
    const mine = vscode.extensions.getExtension('xnervwang.codex-plus'), codex = vscode.extensions.getExtension('openai.chatgpt');
    if (!mine || !codex) return null;
    const A = require(require('path').join(mine.extensionPath, 'src', 'adapters'));
    return { active: mine.isActive, targets: A.map((a) => [a.name, a.status(codex.extensionPath)]) };`);
  const tabs = () => call(`return vscode.window.tabGroups.all.map((g) => ({ column: g.viewColumn, active: g.isActive,
    tabs: g.tabs.map((t) => ({ label: t.label, active: t.isActive, view: (t.input && t.input.viewType) || '' })) }));`);
  const frontTab = async () => { const t = await tabs(); const g = t.find((x) => x.active); return g && g.tabs.find((x) => x.active); };
  const exec = (command, ...a) => call(`await vscode.commands.executeCommand(${JSON.stringify(command)}, ...arg); return true;`, a);
  /* Started and not waited for: the command opens a prompt that is answered through the window. */
  const start = (command, ...a) => call(`vscode.commands.executeCommand(${JSON.stringify(command)}, ...arg); return true;`, a);
  const setting = (key, value, section = 'codexPlus') => call(`await vscode.workspace.getConfiguration(${JSON.stringify(section)})
    .update(${JSON.stringify(key)}, arg, vscode.ConfigurationTarget.Global); return true;`, value);
  const openNotes = () => call(`await vscode.window.showTextDocument(vscode.Uri.file(${JSON.stringify(path.join(profile.folder, 'notes.txt'))}), { preview: false }); return true;`);
  const hostRequest = (method, params) => call(`${OWN} return own('patching').hostRequest(${JSON.stringify(method)}, arg);`, params);
  const focused = () => call('return vscode.window.state.focused;');

  /* ── the page ── */
  const codexButtons = () => page.evaluate(() => [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-item .action-label')]
    .map((a) => a.getAttribute('aria-label') || a.title || '').filter((t) => /Codex/.test(t)));
  const codexButton = () => page.locator('.editor-group-container.active .editor-actions .action-item .action-label[aria-label*="Codex"]').first();
  /* In several moves, as a hand would, so the page under the pointer sees it leave. */
  const away = async () => { await page.mouse.move(3, 500, { steps: 8 }); await sleep(400); };
  const hoverShown = () => page.evaluate(() => !![...document.querySelectorAll('.monaco-hover, .workbench-hover')].find((e) => e.offsetParent && e.innerText.trim()));
  const tab = (label) => page.locator('.tabs-container .tab').filter({ hasText: label }).first();
  const frameWhere = async (test, ms, arg) => until(async () => {
    for (const f of page.frames()) {
      try { if (await f.evaluate(test, arg)) return f; } catch (_) { /* not ready, or gone */ }
    }
    return null;
  }, ms, 500);
  const still = async (loc) => {
    let last = '';
    return until(async () => {
      const busy = await loc.evaluate((e) => e.getAnimations({ subtree: true }).some((a) => a.playState === 'running'));
      const box = JSON.stringify(await loc.boundingBox());
      const same = !busy && box === last;
      last = box;
      return same;
    }, 3000, 100);
  };
  const dotsOn = async (label) => {
    const box = await tab(label).boundingBox().catch(() => null);
    if (!box) return null;
    const x = Math.round(box.x), y = Math.round(box.y);
    const img = pixels.decode(await page.screenshot({ clip: { x, y, width: Math.min(40, Math.round(box.width)), height: Math.round(box.height) } }));
    const count = {};
    for (const [k, c] of Object.entries(DOTS)) {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        if (Math.abs(img.data[i] - c[0]) <= 24 && Math.abs(img.data[i + 1] - c[1]) <= 24 && Math.abs(img.data[i + 2] - c[2]) <= 24) n++;
      }
      count[k] = n;
    }
    return count;
  };
  /* Agent Plus's bell. VS Code's own notifications entry, at the right end, shows the same icon while it holds any. */
  const AGENT_BELL = '.statusbar-item:not([id="status.notifications"])';
  const bellCount = () => page.evaluate((q) => {
    const e = [...document.querySelectorAll(q)].find((x) => x.querySelector('.codicon-bell-dot'));
    return e ? Number(e.innerText.trim()) || 0 : 0;
  }, AGENT_BELL);

  /* ── boxes, in the window's CSS pixels ── */
  const union = (boxes) => {
    const b = boxes.filter((x) => x && x.width > 0 && x.height > 0);
    if (!b.length) return null;
    const x0 = Math.min(...b.map((r) => r.x)), y0 = Math.min(...b.map((r) => r.y));
    return { x: x0, y: y0, width: Math.max(...b.map((r) => r.x + r.width)) - x0, height: Math.max(...b.map((r) => r.y + r.height)) - y0 };
  };
  /* The box round every visible element matching `sel` in `frame` (the window itself when null). */
  const boxIn = async (frame, sel) => {
    const at = frame ? await (await frame.frameElement()).boundingBox() : { x: 0, y: 0 };
    const r = await (frame || page).evaluate((q) => {
      const all = [...document.querySelectorAll(q)].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
      if (!all.length) return null;
      const x0 = Math.min(...all.map((b) => b.left)), y0 = Math.min(...all.map((b) => b.top));
      return { x: x0, y: y0, width: Math.max(...all.map((b) => b.right)) - x0, height: Math.max(...all.map((b) => b.bottom)) - y0 };
    }, sel).catch(() => null);
    return r && at ? { x: at.x + r.x, y: at.y + r.y, width: r.width, height: r.height } : null;
  };
  const part = (id) => page.evaluate((i) => {
    const e = document.getElementById(i);
    if (!e || !e.offsetWidth) return null;
    const b = e.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  }, id);
  const PARTS = { sidebar: 'workbench.parts.sidebar', editor: 'workbench.parts.editor', panel: 'workbench.parts.panel',
    statusbar: 'workbench.parts.statusbar', auxiliary: 'workbench.parts.auxiliarybar', titlebar: 'workbench.parts.titlebar' };
  const toastsBox = () => boxIn(null, '.notifications-toasts .notification-toast, .notifications-center.visible');
  const tabsBox = () => boxIn(null, '.editor-group-container.active .title');
  const viewport = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight }));

  /* ── the logs ── */
  const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((n) => (n.isDirectory() ? walk(path.join(d, n.name)) : [path.join(d, n.name)])); } catch (_) { return []; } };
  const read = new Map();
  /* What the extension host's log and the two output channels gained since the last call, as "<file>: <line>". */
  const newLogLines = () => {
    const root = path.join(profile.user, 'logs');
    const lines = [];
    for (const f of walk(root).filter((x) => /(exthost\.log|Codex Plus\.log|Agent Plus\.log)$/.test(x))) {
      let size = 0;
      try { size = fs.statSync(f).size; } catch (_) { continue; }
      const from = read.get(f) || 0;
      if (size <= from) { read.set(f, size); continue; }
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      read.set(f, size);
      const name = path.basename(f).replace(/^\d+-/, '');
      for (const l of buf.toString('utf8').split('\n').filter((x) => x.trim())) lines.push(`${name}: ${l.slice(0, 400)}`);
    }
    if (lines.length <= LOG_LINES) return lines;
    return [`[ui-look] ${lines.length - LOG_LINES} earlier lines left out`, ...lines.slice(-LOG_LINES)];
  };
  const toastLines = () => page.evaluate(() => [...document.querySelectorAll('.notification-toast')].filter((e) => e.offsetParent).map((e) => {
    const icon = e.querySelector('.notification-list-item-icon');
    const kind = icon ? (/codicon-error/.test(icon.className) ? 'error' : /codicon-warning/.test(icon.className) ? 'warning' : 'info') : 'info';
    const text = (e.querySelector('.notification-list-item-message') || e).innerText.replace(/\s+/g, ' ').trim();
    const source = ((e.querySelector('.notification-list-item-source') || {}).innerText || '').trim();
    return `notification (${kind})${source ? ` [${source}]` : ''}: ${text}`;
  })).catch(() => []);

  /* ── a step ── */
  const entries = [];
  let stepNo = 0, previous = null, told = [];
  /* A line for the current step's log saying what the step did beyond its expect, such as answering VS Code's prompt. */
  const tell = (line) => told.push(`[ui-look note] ${line}`);
  const featuresOf = (name) => FEATURES.filter((f) => f.steps.includes(name)).map((f) => f.id);
  /*
   * One step: `act` does what the step needs and returns the box (window CSS pixels) of what it is about, or null for
   * the whole window. Its failure is logged and the screenshots are taken all the same.
   */
  const look = async (name, spec, act) => {
    console.log(`\n── ${name}`);
    const said = [];
    told = [];
    let box = null;
    /* A tab that was closed and opened again has a new page; the steps after it work on that one. */
    if (codex && codex.isDetached()) {
      codex = await frameWhere((want) => !!document.querySelector('[data-turn-key]') && document.body.innerText.includes(want) && innerWidth > 600, 30000, title);
      tell(codex ? 'the conversation\'s page had gone, so the step works on the one its tab shows now' : 'the conversation\'s page had gone and no other was found');
    }
    try {
      box = await act();
    } catch (e) {
      const why = String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ');
      said.push(`[ui-look] the step's actions failed: ${why}`);
      said.push(`[ui-look] the tabs then: ${JSON.stringify(await tabs().catch((x) => String(x))).slice(0, 600)}`);
      check(false, `${name}: its actions ran`, why);
    }
    await sleep(300);
    const n = String(++stepNo).padStart(2, '0');
    const full = `shots/${n}-${name}-full.png`, image = `shots/${n}-${name}.png`;
    const vp = await viewport().catch(() => null);
    let clip = null;
    if (box && vp) {
      const pad = 6;
      const x = Math.max(0, Math.floor(box.x - pad)), y = Math.max(0, Math.floor(box.y - pad));
      clip = { x, y, width: Math.min(vp.width, Math.ceil(box.x + box.width + pad)) - x, height: Math.min(vp.height, Math.ceil(box.y + box.height + pad)) - y };
      if (clip.width < 4 || clip.height < 4) clip = null;
    }
    /* The close view first: a hover can be gone by the time a second screenshot is taken. */
    if (clip) await page.screenshot({ path: path.join(out, image), clip, animations: 'disabled' }).catch(() => { clip = null; });
    await page.screenshot({ path: path.join(out, full), animations: 'disabled' }).catch((e) => said.push(`[ui-look] no screenshot: ${e.message}`));
    if (!clip) {
      if (box) said.push('[ui-look] the box of what this step is about was empty, so the close view is the whole window');
      try { fs.copyFileSync(path.join(out, full), path.join(out, image)); } catch (_) { /* no full either */ }
    }
    const log = [...said, ...told, ...newLogLines(), ...await toastLines()];
    entries.push({ name, features: featuresOf(name), expect: spec.expect, unchanged: spec.unchanged || '', image, full, previous, log });
    previous = full;
    fs.writeFileSync(path.join(out, 'look.json'), JSON.stringify(entries, null, 2));
  };

  /* ── the trust prompt: the first is a step of its own; later ones are answered, unless a step is watching for one ── */
  let trustAuto = false, trusted = 0;
  const trustPrompt = () => {
    const dlg = page.locator('.monaco-dialog-box').filter({ hasText: TRUST }).first();
    const toast = page.locator('.notification-list-item').filter({ hasText: TRUST }).first();
    return { dlg, toast };
  };
  const trustShown = async () => {
    const { dlg, toast } = trustPrompt();
    if (await dlg.isVisible().catch(() => false)) return dlg;
    if (await toast.isVisible().catch(() => false)) return toast;
    return null;
  };
  const trustIt = async (box) => { await box.locator('.monaco-button').filter({ hasText: /^Trust/ }).first().dispatchEvent('click'); trusted++; };
  let watching = true;
  const trustWatch = (async () => {
    while (watching) {
      try { if (trustAuto) { const b = await trustShown(); if (b) await trustIt(b); } } catch (_) { /* the window is reloading */ }
      await sleep(500);
    }
  })();

  /* ── the session list ── */
  let list = null;
  const row = (id) => list.locator(`.cp-row[data-id="${id}"]`).last();
  const rowIn = (key, id) => list.locator(`.cp-group[data-key="${key}"] .cp-row[data-id="${id}"], .cp-section[data-key="${key}"] .cp-row[data-id="${id}"]`).first();
  const inList = (sel) => boxIn(list, sel);
  const rowBox = (id, where = '.cp-groups') => inList(`${where} .cp-row[data-id="${id}"]`);
  const menuBox = () => inList('.cp-ctx');
  const closeMenus = async () => {
    if (!await list.evaluate(() => !!document.querySelector('.cp-ctx, .cp-menu:not(.cp-hidden)'))) return;
    await page.keyboard.press('Escape');
    if (await until(() => list.evaluate(() => !document.querySelector('.cp-ctx')), 1000, 100)) return;
    const box = await (await list.frameElement()).boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height - 12);
    await until(() => list.evaluate(() => !document.querySelector('.cp-ctx')), 3000, 100);
  };
  const subOpenFor = (item) => item.evaluate((b) => b.getAttribute('aria-expanded') === 'true' && !!document.querySelector('.cp-ctx-sub')).catch(() => false);
  const openSubOf = async (item) => {
    for (let n = 1; n <= 3; n++) {
      if (await subOpenFor(item)) return n;
      if (n === 1) await item.hover({ timeout: 3000 }).catch(() => {});
      else await item.press('ArrowRight', { timeout: 3000 }).catch(() => {});
      if (await until(() => subOpenFor(item), 2000, 100)) return n;
    }
    return 0;
  };
  /* What the list shows, for a step that could not find a row in it. */
  const listState = () => list.evaluate(() => ({ search: (document.querySelector('.cp-search input') || {}).value || '',
    groups: [...document.querySelectorAll('.cp-section, .cp-group')].map((g) => `${g.dataset.key}: ${[...g.querySelectorAll('.cp-row .cp-title')].map((t) => t.textContent).join(' | ')}`) }))
    .catch((e) => String(e));
  /* Another view can take the side bar, such as Codex's when it opens there; the list's page is then kept but hidden. */
  const listShown = async () => {
    if (!list) return false;
    try { const b = await (await list.frameElement()).boundingBox(); return !!(b && b.width > 0 && b.height > 0); } catch (_) { return false; }
  };
  const showList = async () => { if (await listShown()) return; await toList(); await until(listShown, 10000, 300); await sleep(800); };
  /* Right-clicks `target` (a locator in the list) and leaves its menu open. */
  const menuOn = async (target) => {
    await showList();
    await closeMenus();
    try { await target.click({ button: 'right', timeout: 10000 }); } catch (e) {
      throw new Error(`${e.message.split('\n')[0]}; the list shows ${JSON.stringify(await listState())}, visible ${await listShown()}`);
    }
    if (!await until(() => list.evaluate(() => !!document.querySelector('.cp-ctx')), 5000, 100)) throw new Error('no menu opened on the right-click');
    await still(list.locator('.cp-ctx').first());
  };
  const ctxItem = (label, sub = false) => list.locator(`${sub ? '.cp-ctx-sub' : '.cp-ctx:not(.cp-ctx-sub)'} .cp-ctx-item`).filter({ hasText: label }).first();
  /* Right-clicks `target` and clicks labels[0], or that item's submenu item labels[1]. The page closes its menu when
     another webview takes the focus, so a click that missed for that reason is tried again, as in ui.js. */
  const pick = async (target, labels) => {
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      await menuOn(target);
      try {
        if (labels.length > 1) {
          if (!await openSubOf(ctxItem(labels[0]))) throw new Error(`${labels[0]} opened no submenu`);
          await ctxItem(labels[1], true).click({ timeout: 5000 });
        } else await ctxItem(labels[0]).click({ timeout: 5000 });
        await until(() => list.evaluate(() => !document.querySelector('.cp-ctx')), 3000, 100);
        await away();
        return attempt;
      } catch (e) { last = e.message.split('\n')[0]; await sleep(500); }
    }
    throw new Error(`could not click ${labels.join(' > ')}: ${last}`);
  };
  const toList = async () => {
    await exec('workbench.view.extension.codexPlus');
    list = await frameWhere(() => !!document.querySelector('.cp-root'), 30000);
    if (!list) throw new Error('the session list did not open');
    return list;
  };
  /* Drags the side bar's edge to `to` CSS pixels, as readme-shots.js does: at the default width a title is cut short. */
  const widen = async (to = 420) => {
    const sb = await part(PARTS.sidebar);
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

  /* VS Code asks once before an extension opens a vscode:// link, which Codex Plus's sidebar actions use. */
  const allowUri = async () => {
    const allow = page.locator('.monaco-dialog-box').filter({ hasText: 'open this URI' }).first();
    if (!await allow.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)) return;
    const text = (await allow.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    await allow.locator('.dialog-buttons .monaco-button').filter({ hasText: 'Open' }).first().click({ timeout: 5000 });
    tell(`VS Code asked "${text.slice(0, 160)}", and Open was clicked`);
  };

  /* ── a Codex conversation ── */
  let codex = null;
  const composer = (f = codex) => f.locator('[data-codex-composer-root] [contenteditable="true"]').first();
  const type = async (text, f = codex) => {
    await composer(f).click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  const inCodex = (sel, f = codex) => boxIn(f, sel);
  const toBottom = async (f = codex) => {
    await f.evaluate(() => { const s = document.querySelector('[data-app-action-timeline-scroll]'); if (s) s.scrollTop = s.scrollHeight; }).catch(() => {});
    await sleep(800);
  };
  const toTop = async (f = codex) => {
    for (let i = 0; i < 6; i++) {
      await f.evaluate(() => { const s = document.querySelector('[data-app-action-timeline-scroll]'); if (s) s.scrollTop = 0; }).catch(() => {});
      await sleep(400);
    }
  };
  /* The lower part of the conversation: its last `h` CSS pixels above the message box, the box itself, and the row
     Codex Plus adds below it. */
  const bottomBox = async (h = 420, f = codex) => {
    const fb = await (await f.frameElement()).boundingBox();
    if (!fb) return null;
    const end = fb.y + fb.height;
    return { x: fb.x, y: Math.max(fb.y, end - h), width: fb.width, height: end - Math.max(fb.y, end - h) };
  };
  const pageText = (f = codex) => f.evaluate(() => document.body.innerText).catch(() => '');
  /* Sends `text` and waits for the turn it starts to end: the tab's green dot gone and no new request for 3 seconds. */
  const sendAndWait = async (text, ms = 60000) => {
    const before = model.turns();
    await type(text);
    if (!await until(() => model.turns() > before, 20000, 300)) throw new Error(`"${text}" reached no model in 20 s`);
    let quietSince = 0, seen = model.turns();
    const ended = await until(async () => {
      const d = await dotsOn(title);
      if (model.turns() !== seen) { seen = model.turns(); quietSince = 0; return false; }
      if (d && d.working >= 6) { quietSince = 0; return false; }
      if (!quietSince) quietSince = Date.now();
      return Date.now() - quietSince > 3000;
    }, ms, 500);
    if (!ended) throw new Error(`the turn of "${text}" did not end in ${ms / 1000} s`);
  };
  const card = () => codex.evaluate(() => {
    const s = document.querySelector('[data-codex-approval-surface]');
    return s ? { text: s.innerText.slice(0, 300), buttons: [...s.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) } : null;
  }).catch(() => null);
  const approve = async () => {
    const buttons = codex.locator('[data-codex-approval-surface] button');
    const yes = buttons.filter({ hasText: /^(Yes|Allow once|Allow this time|Approve|Run)\b/ }).first();
    if (await yes.count()) await yes.click();
    const submit = buttons.filter({ hasText: /^Submit$/ }).first();
    if (await submit.count()) await submit.click();
    if (!await until(async () => !await card(), 10000, 300)) throw new Error('the approval card stayed after Yes');
  };
  const pill = () => codex.locator('[data-codex-extras="agents"]').first();
  const pillText = () => codex.evaluate(() => ((document.querySelector('[data-codex-extras="agents"]') || {}).textContent || '')).catch(() => '');
  const mapBox = () => inCodex('[data-codex-extras="map-dialog"]');
  const openMap = async () => {
    await pill().click();
    if (!await until(() => codex.evaluate(() => !!document.querySelector('[data-codex-extras="map-dialog"]')), 5000, 200)) throw new Error('the Agent map did not open');
    await still(codex.locator('[data-codex-extras="map-dialog"]').first());
  };
  const closeMap = async () => { await page.keyboard.press('Escape'); await until(() => codex.evaluate(() => !document.querySelector('[data-codex-extras="map-dialog"]')), 3000, 200); };
  const rolloutOf = (id) => {
    const sessions = path.join(profile.codexHome, 'sessions');
    try { return fs.readdirSync(sessions, { recursive: true }).map((r) => path.join(sessions, r)).find((f) => f.endsWith(`${id}.jsonl`)) || ''; } catch (_) { return ''; }
  };
  /* The context window Codex put on the conversation's latest turn. */
  const windowOf = (id) => {
    let win0 = 0;
    try {
      for (const l of fs.readFileSync(rolloutOf(id), 'utf8').trim().split('\n')) {
        const r = JSON.parse(l), q = r.payload || {};
        const v = q.model_context_window || (q.info && q.info.model_context_window);
        if (v) win0 = v;
      }
    } catch (_) { /* none */ }
    return win0;
  };

  try {
    await w.hostUp();

    /* ═══ start-up: the patch and the plugin ═══ */
    const patched = await until(async () => { const s = await patchState(); return s && s.targets.every(([, x]) => x === 'patched') && s; }, 120000, 1000);
    if (!patched) note(`Codex was not patched in 120 s: ${JSON.stringify(await patchState())}`);
    await look('trust-hooks-prompt', {
      expect: 'Codex Plus asks, in a modal dialog in the middle of the dimmed window or in a notification at the bottom right, "Trust the work plan hooks in Codex?", '
        + 'saying what the hooks are, with a button to trust them and one to cancel.',
    }, async () => {
      const box = await until(trustShown, 60000, 500);
      if (!box) throw new Error('no trust prompt in 60 s');
      return box.boundingBox();
    });
    {
      const box = await trustShown();
      if (box) await trustIt(box);
      trustAuto = true;
    }
    await look('patched-reload-prompt', {
      expect: 'A notification at the bottom right says Codex is patched and the window has to be reloaded, with a Reload button. No error notification is shown.',
      unchanged: 'The rest of the window as before, now without the trust prompt.',
    }, async () => {
      const shown = await until(() => page.evaluate(() => [...document.querySelectorAll('.notification-toast')].some((e) => e.offsetParent && /Codex is patched/.test(e.innerText))), 15000, 500);
      if (!shown) await exec('notifications.showList');
      await sleep(600);
      return toastsBox();
    });
    await look('tab-bar-before-reload', {
      expect: 'With notes.txt open in the editor, the editor tab bar has exactly one Codex button at its right end, Codex\'s own, and its hover reads "Open Codex Sidebar".',
    }, async () => {
      await openNotes();
      await until(async () => (await codexButtons()).length > 0, 15000);
      await away();
      await codexButton().hover();
      await until(hoverShown, 5000, 200);
      await sleep(400);
      return union([await tabsBox(), await boxIn(null, '.monaco-hover, .workbench-hover')]);
    });

    await exec('notifications.clearAll');
    await w.reload();
    await until(async () => { const s = await patchState(); return s && s.active; }, 60000, 1000);

    /* ═══ the tab bar ═══ */
    await look('tab-bar-button-hover', {
      expect: 'After the reload the tab bar still has exactly one Codex button, now Codex Plus\'s, in the same place; its hover reads "Codex Plus: New Codex Conversation in a Tab".',
      unchanged: 'notes.txt is still the open editor; the button is where Codex\'s own was.',
    }, async () => {
      await openNotes();
      await until(async () => { const b = await codexButtons(); return b.length === 1 && /in a Tab/.test(b[0]); }, 30000, 500);
      await away();
      await codexButton().hover();
      await until(hoverShown, 5000, 200);
      await sleep(400);
      return union([await tabsBox(), await boxIn(null, '.monaco-hover, .workbench-hover')]);
    });
    let fresh = null;
    await look('tab-bar-new-tab', {
      expect: 'A click on the button opens a new tab titled "Codex" in the same editor group, beside notes.txt rather than in a new split, showing Codex\'s new-conversation page with its message box.',
    }, async () => {
      await away();
      const before = new Set(page.frames());
      await codexButton().click();
      /* Codex keeps the page of its hidden sidebar, which also shows a message box and no turns. */
      fresh = await until(async () => {
        for (const f of page.frames()) {
          if (before.has(f)) continue;
          try { if (await f.evaluate(() => !!document.querySelector('[data-codex-composer-root]') && !document.querySelector('[data-turn-key]') && innerWidth > 600)) return f; } catch (_) { /* gone */ }
        }
        return null;
      }, 90000, 500);
      if (!fresh) throw new Error('no new Codex page with a message box in 90 s');
      await sleep(1500);
      return part(PARTS.editor);
    });
    let freshTitle = '';
    await look('new-tab-titled', {
      expect: 'After a first message is sent in the new tab and answered, the tab\'s title is no longer "Codex" but the conversation\'s name; the conversation shows the message, with a time above it, and the reply. '
        + 'No notification says it finished, since its tab is in front of the focused window.',
      unchanged: 'The tab is still in the same group, in the same place.',
    }, async () => {
      if (!fresh) throw new Error('the new tab did not open');
      const before = model.turns();
      await type('Draft the release notes for 1.2.', fresh);
      await until(() => model.turns() > before, 20000, 300);
      const named = await until(async () => { const t = await frontTab(); return t && t.label !== 'Codex' && t.label; }, 40000, 500);
      freshTitle = named || ((await frontTab()) || {}).label || '';
      if (!named) {
        const sessions = path.join(profile.codexHome, 'sessions');
        const newest = fs.readdirSync(sessions, { recursive: true }).map((r) => path.join(sessions, r)).filter((f) => f.endsWith('.jsonl') && !threads.some((t) => f.includes(t.id)))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
        const id = (newest.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/) || [])[1] || '';
        const read = id ? await hostRequest('thread/read', { threadId: id }).catch((e) => ({ error: String(e) })) : null;
        const th = (read && read.result && read.result.thread) || {};
        const mapped = await call(`${OWN} const tab = (vscode.window.tabGroups.activeTabGroup || {}).activeTab;
          const p = own('patching'); return { tabUri: tab && tab.input && tab.input.uri ? String(tab.input.uri) : '', front: typeof p.frontThread === 'function' ? p.frontThread() : 'n/a' };`).catch((e) => String(e));
        throw new Error(`the tab kept the title ${JSON.stringify(freshTitle)}; Codex's thread ${id} has name ${JSON.stringify(th.name)} and preview ${JSON.stringify(th.preview)}`
          + `${read && read.error ? ` (${read.error})` : ''}; the tab ${JSON.stringify(mapped)}`);
      }
      await sleep(1500);
      return union([await tabsBox(), await part(PARTS.editor)]);
    });
    await look('tab-bar-sidebar', {
      expect: 'With codexPlus.tabBarButton set to "sidebar", the tab bar still has one Codex button, and a click on it shows Codex in the secondary side bar on the right, with no new editor group.',
    }, async () => {
      await setting('tabBarButton', 'sidebar');
      await openNotes();
      await until(async () => { const b = await codexButtons(); return b.length === 1 && /Sidebar/.test(b[0]); }, 15000, 500);
      await codexButton().click();
      await until(async () => { const a = await part(PARTS.auxiliary); return a && a.width > 0; }, 15000, 500);
      await sleep(3000);
      return union([await tabsBox(), await part(PARTS.auxiliary)]);
    });
    await exec('workbench.action.closeAuxiliaryBar');
    await setting('tabBarButton', 'tab');

    /* ═══ the session list ═══ */
    await look('session-list', {
      expect: 'The Codex Plus side bar shows the Codex sessions view. From the top: an "Account & usage" section, an "Open sessions" section listing the conversation just started in a tab, '
        + 'a session manager with "New in tab" and "New in sidebar" side by side (each with a plus icon), a filter row (a funnel, "Active · N", a search icon and "New group"), '
        + 'and an "Ungrouped" group with four conversations: the one just started and the three made-up ones, "Can you find where the retry delay for the inventory sync is set?", '
        + '"Why does the nightly export skip archived rows?" and "Add a dry-run flag to the cleanup script". Each row has a small dot or space for it, the title, and at the right how long ago it was used with its first and last day, as "1m · 11/20→11/21". '
        + 'Section labels are in capitals.',
    }, async () => {
      await toList();
      await until(() => list.evaluate((want) => want.every((t) => [...document.querySelectorAll('.cp-row .cp-title')].some((e) => e.textContent === t)), threads.map((t) => t.title)), 30000, 500);
      await widen();
      await away();
      return part(PARTS.sidebar);
    });
    await look('account-usage', {
      expect: 'The made-up provider needs no OpenAI sign-in, so Codex reports no account, and the list has no "Account & usage" section: the list starts with Open sessions, with no empty header or gap above it.',
    }, async () => {
      /* Codex's account/read answers { account: null, requiresOpenaiAuth: false } for such a provider, with or without an
         API key in auth.json, and a real sign-in needs the network the window does not have. */
      const answer = await hostRequest('account/read', {}).catch((e) => ({ error: String(e) }));
      tell(`Codex's account/read answered ${JSON.stringify(answer).slice(0, 200)}`);
      await sleep(1000);
      const top = await inList('.cp-section:not(.cp-hidden)');
      return top && { x: top.x, y: top.y, width: top.width, height: Math.min(top.height, 160) };
    });
    await look('row-hover', {
      expect: 'Resting the pointer on the row "Why does the nightly export skip archived rows?" shows a hover box next to it with its group (Ungrouped) and its session ID; '
        + 'on the row itself the time is replaced by a pencil (Rename) and an archive button.',
    }, async () => {
      await showList();
      await away();
      await row(t1.id).hover();
      await until(() => list.evaluate(() => { const h = document.querySelector('.cp-hover'); return h && !h.classList.contains('cp-hidden'); }), 5000, 200);
      await sleep(500);
      return union([await rowBox(t1.id), await inList('.cp-hover:not(.cp-hidden)')]);
    });
    await look('row-menu', {
      expect: 'A right-click on that row opens the list\'s own menu, drawn like Claude Code\'s, with no VS Code menu over it: "Codex Plus: Resume in Tab", "Codex Plus: Resume in Sidebar", '
        + '"Codex Plus: Mark as Unread", "Codex Plus: Rename", "Codex Plus: Text Color" with a chevron, and "Codex Plus: Archive", in groups split by separators. There is no Add to Group while no group exists. '
        + 'The menu opens at the pointer, so its top edge may lie over the row that was right-clicked.',
    }, async () => {
      await menuOn(row(t1.id));
      return union([await rowBox(t1.id), await menuBox()]);
    });
    await look('text-color-submenu', {
      expect: 'Resting on Text Color opens its submenu to the right: "Default" (checked) and Red, Blue, Green, Yellow, Purple, Orange, Pink and Cyan, each with a swatch of its colour.',
      unchanged: 'The main menu stays open beside it.',
    }, async () => {
      if (!await openSubOf(ctxItem('Text Color'))) throw new Error('Text Color opened no submenu');
      await still(list.locator('.cp-ctx-sub').first());
      return union([await menuBox()]);
    });
    await look('row-title-red', {
      expect: 'Clicking Red closes the menu and draws that row\'s title in the theme\'s red; the other rows keep their colour.',
    }, async () => {
      await ctxItem('Red', true).click({ timeout: 5000 });
      await until(() => list.evaluate(() => !document.querySelector('.cp-ctx')), 3000, 100);
      await sleep(800);
      return inList('.cp-groups');
    });
    await look('search-sessions', {
      expect: 'The search box opens across the top of the filter row with "export" typed in it and a clear button; the list shows only "Why does the nightly export skip archived rows?", with "export" marked in its title.',
    }, async () => {
      await showList();
      await list.locator('.cp-tool[data-tool="search"]').first().click();
      await sleep(300);
      await list.locator('.cp-search input').first().fill('export');
      await sleep(1000);
      return inList('.cp-section[data-key="manager"]');
    });
    await list.locator('.cp-clear').first().click().catch(() => {});
    await page.keyboard.press('Escape');
    await sleep(500);
    await look('status-filter-menu', {
      expect: 'The funnel button opens a menu under it: a "Status" heading with Needs input, Working and Completed, a separator, a "Tabs" heading with Open and Closed, each with its count.',
      unchanged: 'The search box is closed again and all four conversations are listed again.',
    }, async () => {
      await list.locator('.cp-tool[data-tool="filter"]').first().click();
      await until(() => list.evaluate(() => { const m = document.querySelector('.cp-menu'); return m && !m.classList.contains('cp-hidden'); }), 5000, 200);
      await sleep(300);
      return union([await inList('.cp-filter-row'), await inList('.cp-menu:not(.cp-hidden)')]);
    });
    await page.keyboard.press('Escape');
    await list.locator('.cp-tool[data-tool="filter"]').first().click().catch(() => {});
    await closeMenus();

    const groupHead = (name) => list.locator('.cp-group-head').filter({ hasText: name }).first();
    await look('new-group-inline', {
      expect: '"New group" in the filter row adds a group named "New group" above Ungrouped, with its name in an edit field, selected, ready to type over.',
    }, async () => {
      await list.locator('.cp-tool[data-send="newGroup"]').first().click();
      if (!await until(() => list.evaluate(() => !!document.querySelector('.cp-group-head .cp-editing, .cp-editing')), 20000, 300)) throw new Error('no group name being edited in 20 s');
      return inList('.cp-groups');
    });
    await look('group-made', {
      expect: 'Typing "Release 1.2" and Enter names the group: a header "Release 1.2" with a count of 0, which stays listed while empty, above Ungrouped.',
    }, async () => {
      await page.keyboard.press('Control+A');
      await page.keyboard.type('Release 1.2');
      await page.keyboard.press('Enter');
      if (!await until(() => list.evaluate(() => [...document.querySelectorAll('.cp-group-name')].some((e) => e.textContent === 'Release 1.2')), 20000, 500)) throw new Error('no group "Release 1.2" in 20 s');
      await sleep(500);
      return inList('.cp-groups');
    });
    await look('add-to-group-submenu', {
      expect: 'The row\'s menu now has "Codex Plus: Add to Group" with a chevron; resting on it opens a submenu listing "Release 1.2".',
    }, async () => {
      await menuOn(row(t1.id));
      if (!await openSubOf(ctxItem('Add to Group'))) throw new Error('Add to Group opened no submenu');
      await still(list.locator('.cp-ctx-sub').first());
      return menuBox();
    });
    await look('row-in-group', {
      expect: 'Clicking Release 1.2 moves the row "Why does the nightly export skip archived rows?" under the "Release 1.2" header, whose count reads 1; the row keeps its red title.',
    }, async () => {
      await ctxItem('Release 1.2', true).click({ timeout: 5000 });
      if (!await until(() => list.evaluate((id) => {
        const g = [...document.querySelectorAll('.cp-group')].find((x) => (x.querySelector('.cp-group-name') || {}).textContent === 'Release 1.2');
        return !!(g && g.querySelector(`.cp-row[data-id="${id}"]`));
      }, t1.id), 20000, 500)) throw new Error('the row did not move into the group in 20 s');
      await sleep(500);
      return inList('.cp-groups');
    });
    await look('group-header-menu', {
      expect: 'A right-click on the "Release 1.2" header opens a menu with "Codex Plus: Start New Session in This Group" and "Codex Plus: New Group...", a separator, "Codex Plus: Rename Group...", a separator, and "Codex Plus: Delete Group". Every label is shown whole.',
    }, async () => {
      await menuOn(groupHead('Release 1.2'));
      return union([await inList('.cp-group-head'), await menuBox()]);
    });
    await look('rename-group-inline', {
      expect: 'Rename Group edits the name where it is drawn; after typing "Release 1.3" and Enter the header reads "Release 1.3", still with a count of 1.',
    }, async () => {
      await ctxItem('Rename Group').click({ timeout: 5000 });
      if (!await until(() => list.evaluate(() => !!document.querySelector('.cp-editing')), 10000, 200)) throw new Error('the group name was not put in an edit field');
      await page.keyboard.press('Control+A');
      await page.keyboard.type('Release 1.3');
      await page.keyboard.press('Enter');
      if (!await until(() => list.evaluate(() => [...document.querySelectorAll('.cp-group-name')].some((e) => e.textContent === 'Release 1.3')), 20000, 500)) throw new Error('the group was not renamed in 20 s');
      return inList('.cp-groups');
    });
    await look('new-session-in-group', {
      expect: 'Start New Session in This Group opens a new Codex tab titled "Codex" in the editor, in front, with Codex\'s new-conversation page.',
    }, async () => {
      const before = new Set(page.frames());
      await pick(groupHead('Release 1.3'), ['Start New Session in This Group']);
      await until(async () => { const t = await frontTab(); return t && t.label === 'Codex' && t.view === 'chatgpt.conversationEditor'; }, 20000, 500);
      const drawn = await until(async () => {
        for (const f of page.frames()) {
          if (before.has(f)) continue;
          try { if (await f.evaluate(() => !!document.querySelector('[data-codex-composer-root]') && innerWidth > 600)) return true; } catch (_) { /* gone */ }
        }
        return false;
      }, 60000, 500);
      if (!drawn) tell('the new tab drew no message box in 60 s');
      await sleep(1500);
      return union([await tabsBox(), await part(PARTS.editor)]);
    });
    await exec('workbench.action.closeActiveEditor');
    await look('remove-from-group', {
      expect: 'Remove from Group on the row puts "Why does the nightly export skip archived rows?" back in Ungrouped; the "Release 1.3" group stays, empty, with a count of 0.',
      unchanged: 'The script closed the tab the step before opened, so notes.txt is in front again.',
    }, async () => {
      await pick(row(t1.id), ['Remove from Group']);
      if (!await until(() => list.evaluate((id) => !!document.querySelector(`.cp-group[data-key="ungrouped"] .cp-row[data-id="${id}"]`), t1.id), 20000, 500)) throw new Error('the row did not go back to Ungrouped');
      await sleep(500);
      return inList('.cp-groups');
    });
    await look('delete-group', {
      expect: 'Delete Group on the header removes the "Release 1.3" group from the list; Ungrouped still holds all four conversations.',
    }, async () => {
      await pick(groupHead('Release 1.3'), ['Delete Group']);
      if (!await until(() => list.evaluate(() => ![...document.querySelectorAll('.cp-group-name')].some((e) => e.textContent === 'Release 1.3')), 20000, 500)) throw new Error('the group was still listed after 20 s');
      return inList('.cp-groups');
    });
    await look('mark-unread', {
      expect: 'Mark as Unread on the row "Why does the nightly export skip archived rows?" gives it a red dot at its left; its title stays red from Text Color. As an unread conversation it now counts in "Active · N" and in Agent Plus\'s bell in the status bar, each one more than before.',
    }, async () => {
      await pick(row(t1.id), ['Mark as Unread']);
      await until(() => list.evaluate((id) => /d-unread/.test((document.querySelector(`.cp-groups .cp-row[data-id="${id}"] .cp-dot`) || {}).className || ''), t1.id), 10000, 300);
      await sleep(500);
      return rowBox(t1.id);
    });
    await look('mark-read', {
      expect: 'Mark as Read, which its menu now offers in place of Mark as Unread, takes the red dot away again; the title stays red from Text Color, and "Active · N" and the bell drop back by one.',
    }, async () => {
      await pick(row(t1.id), ['Mark as Read']);
      await until(() => list.evaluate((id) => !/d-unread/.test((document.querySelector(`.cp-groups .cp-row[data-id="${id}"] .cp-dot`) || {}).className || ''), t1.id), 10000, 300);
      await sleep(500);
      return rowBox(t1.id);
    });
    let t2title = t2.title;
    await look('rename-row-inline', {
      expect: 'The pencil on the row "Add a dry-run flag to the cleanup script" turns its title into an edit field holding the title, selected, inside the row.',
    }, async () => {
      await showList();
      await away();
      await row(t2.id).hover();
      await sleep(400);
      await row(t2.id).locator('.cp-act[data-act="rename"]').click({ timeout: 5000 });
      if (!await until(() => list.evaluate(() => !!document.querySelector('.cp-row.cp-editing, .cp-row .cp-editing, .cp-editing')), 5000, 200)) throw new Error('the title was not put in an edit field');
      return rowBox(t2.id);
    });
    await look('row-renamed', {
      expect: 'After typing "Add a dry-run flag to the cleanup job" and Enter, the row shows that title, no longer in an edit field.',
    }, async () => {
      await page.keyboard.press('Control+A');
      await page.keyboard.type('Add a dry-run flag to the cleanup job');
      await page.keyboard.press('Enter');
      if (!await until(() => list.evaluate((id) => ((document.querySelector(`.cp-row[data-id="${id}"] .cp-title`) || {}).textContent || '') === 'Add a dry-run flag to the cleanup job', t2.id), 20000, 500)) throw new Error('the title did not change in 20 s');
      t2title = 'Add a dry-run flag to the cleanup job';
      await away();
      return rowBox(t2.id);
    });
    await look('find-thread', {
      expect: 'Find a Codex Conversation opens a quick pick at the top of the window; with "nightly" typed it lists "Why does the nightly export skip archived rows?", with its thread ID beside it and its folder under it.',
    }, async () => {
      await start('codexPlus.findThread');
      const input = page.locator('.quick-input-widget input').first();
      await input.waitFor({ state: 'visible', timeout: 10000 });
      await input.fill('nightly');
      await sleep(1200);
      return boxIn(null, '.quick-input-widget');
    });
    await page.keyboard.press('Escape');
    await look('list-new-in-sidebar', {
      expect: '"New in sidebar" in the session list opens Codex in the secondary side bar on the right, on its new-conversation page with a message box.',
    }, async () => {
      await list.locator('.cp-new[data-send="newInSidebar"]').first().click();
      await allowUri();
      await until(async () => { const a = await part(PARTS.auxiliary); return a && a.width > 0; }, 15000, 500);
      await sleep(3000);
      return part(PARTS.auxiliary);
    });
    await exec('workbench.action.closeAuxiliaryBar');

    /* ═══ archive and delete: the conversation no later step uses ═══ */
    const under = (top) => { try { return fs.readdirSync(path.join(profile.codexHome, top), { recursive: true }).filter((n) => String(n).includes(t2.id)); } catch (_) { return []; } };
    const shelved = () => list.evaluate((id) => !!document.querySelector(`.cp-group[data-key="archived"] .cp-row[data-id="${id}"]`), t2.id);
    await look('archived-section', {
      expect: 'Archive moves the renamed conversation into "Archived sessions", the last group, shown open here with that one row; it is gone from Ungrouped. Its rollout moved to archived_sessions/.',
    }, async () => {
      await pick(row(t2.id), ['Archive']);
      if (!await until(async () => await shelved() && under('archived_sessions').length === 1, 30000, 500)) throw new Error('the conversation was not archived in 30 s');
      const open = await list.evaluate(() => { const g = document.querySelector('.cp-group[data-key="archived"]'); return g && g.classList.contains('cp-open'); });
      if (!open) await list.locator('.cp-group[data-key="archived"] .cp-group-head').first().click();
      await sleep(800);
      return inList('.cp-groups');
    });
    await look('archived-row-menu', {
      expect: 'The archived row\'s menu has Resume in Tab, Resume in Sidebar, Text Color and Unarchive, then after a separator "Codex Plus: Delete Conversation...", and no Rename, Archive or Add to Group.',
    }, async () => {
      await menuOn(rowIn('archived', t2.id));
      return union([await inList(`.cp-group[data-key="archived"] .cp-row[data-id="${t2.id}"]`), await menuBox()]);
    });
    await closeMenus();
    const dialogBox = () => boxIn(null, '.monaco-dialog-box');
    const dialogShown = () => page.evaluate(() => !![...document.querySelectorAll('.monaco-dialog-box')].find((e) => e.offsetParent));
    const press = (label) => page.locator('.monaco-dialog-box .dialog-buttons .monaco-button').filter({ hasText: label }).first().click({ timeout: 5000 });
    await look('delete-confirmation', {
      expect: `Delete Conversation... opens VS Code's modal confirmation in the window: "Delete "${t2title}" from disk?", saying the rollout and its sub-agents' rollouts go and that this cannot be undone, with Delete and Cancel buttons.`,
    }, async () => {
      await pick(rowIn('archived', t2.id), ['Delete Conversation']);
      if (!await until(dialogShown, 15000, 300)) throw new Error('no confirmation drawn in the window');
      await sleep(400);
      return dialogBox();
    });
    await look('deleted', {
      expect: 'Cancel closes the confirmation and keeps the row; Delete, on a second try, deletes it: the row leaves Archived sessions, which is no longer listed when it is empty.',
    }, async () => {
      if (await dialogShown()) await press('Cancel');
      await sleep(1500);
      if (!await rowIn('archived', t2.id).count()) throw new Error('Cancel did not keep the row');
      await pick(rowIn('archived', t2.id), ['Delete Conversation']);
      if (!await until(dialogShown, 15000, 300)) throw new Error('the second Delete opened no confirmation');
      await press('Delete');
      if (!await until(async () => !await rowIn('archived', t2.id).count() && !under('sessions').length && !under('archived_sessions').length, 30000, 500)) throw new Error('the conversation was not deleted in 30 s');
      return inList('.cp-groups');
    });

    /* ═══ a conversation in a tab ═══ */
    await look('resume-in-tab', {
      expect: `Resume in Tab opens "${title}" in a tab of the editor group there, titled by the conversation, showing its four messages and replies and the message box at the bottom.`,
    }, async () => {
      await pick(row(t0.id), ['Resume in Tab']);
      codex = await frameWhere((want) => !!document.querySelector('[data-codex-composer-root]') && document.querySelectorAll('[data-turn-key]').length >= 4
        && document.body.innerText.includes(want), 90000, title);
      if (!codex) throw new Error('the conversation did not open in 90 s');
      await sleep(2500);
      return union([await tabsBox(), await part(PARTS.editor)]);
    });
    if (!codex) throw new Error('the conversation did not open, so the steps inside it cannot run');
    await look('conversation-stamps', {
      expect: 'At the top of the conversation: a time (HH:MM:SS, or with MM/DD before it for another day) above each message of the user and above each reply; beside each reply\'s time its context share, model and effort, '
        + 'as "ctx 13% · gpt-6.1-sol high"; the user\'s messages have a coloured bar down their leading edge. No time is cut off or overlaps the text.',
    }, async () => {
      await toTop();
      const fb = await (await codex.frameElement()).boundingBox();
      return { x: fb.x, y: fb.y, width: fb.width, height: Math.min(fb.height, 520) };
    });
    await look('rail-list', {
      expect: 'The rail\'s handle at the right edge opens a list, about 280 px wide, of the user\'s four messages, one row each with its time and opening words, with a filter field; the rail beside it keeps its buttons to jump to the top or bottom.',
    }, async () => {
      await codex.locator('.codex-extras-rail-handle').first().click();
      if (!await until(() => codex.evaluate(() => { const p = document.querySelector('.codex-extras-panel'); return p && getComputedStyle(p).display !== 'none'; }), 5000, 200)) throw new Error('the rail\'s list did not open');
      await sleep(500);
      return union([await inCodex('.codex-extras-panel'), await inCodex('.codex-extras-rail')]);
    });
    await look('rail-row-hover', {
      expect: 'Resting on the second row of the rail\'s list shows a box beside the list with that message\'s time and its text.',
      unchanged: 'The list stays open.',
    }, async () => {
      await codex.locator('[data-codex-extras="nav-row"], .codex-extras-row').nth(1).hover();
      await sleep(1000);
      return union([await inCodex('.codex-extras-panel'), await inCodex('[data-codex-extras="nav-tip"]')]);
    });
    await codex.locator('.codex-extras-rail-handle').first().click().catch(() => {});
    await away();
    const toolbar = () => inCodex('[data-codex-composer-root]');
    await look('composer-toolbar', {
      expect: 'In the message box\'s toolbar, after Codex\'s permissions button: an information button and a note button; left of the model picker a ring with the share of the context window in use, such as "13%"; '
        + 'right of it a pill reading "1 timer". There is only one context reading in the row, and the model picker still shows the model\'s name.',
    }, async () => { await toBottom(); return toolbar(); });
    const infoButton = () => codex.locator('[data-codex-extras="bar-button"][aria-label^="About this conversation"]').first();
    await look('info-box', {
      expect: 'The information button opens a box above the message box listing the conversation\'s thread ID, title, folder, rollout and its size, model, context use, tokens, account and "Token mode: All features". Nothing in it is cut off.',
    }, async () => {
      await infoButton().click();
      if (!await until(() => codex.evaluate(() => { const b = document.querySelector('[data-codex-extras="info"]'); return b && getComputedStyle(b).display !== 'none'; }), 10000, 200)) throw new Error('the information box did not open');
      await sleep(400);
      return union([await inCodex('[data-codex-extras="info"]'), await toolbar()]);
    });
    await infoButton().click().catch(() => {});
    await look('context-meter-hover', {
      expect: 'Resting on the context meter shows a box with the context window it uses and where that figure came from (codexPlus.contextWindow is set to 600K for this model), the tokens in use and free, where Codex compacts and how far away that is, '
        + 'the conversation\'s input, cached input, output and reasoning tokens, the model and effort, and a line "Work plan: injected ..." saying how much the plan added.',
    }, async () => {
      await codex.locator('[data-codex-extras="meter"]').first().hover();
      if (!await until(() => codex.evaluate(() => { const b = document.querySelector('[data-codex-extras="context"]'); return b && getComputedStyle(b).display !== 'none'; }), 10000, 200)) throw new Error('the meter showed no hover');
      await sleep(600);
      return union([await inCodex('[data-codex-extras="context"]'), await toolbar()]);
    });
    {
      const talk = await inCodex('[data-app-action-timeline-scroll]');
      await page.mouse.move(talk ? talk.x + 30 : 3, talk ? talk.y + 15 : 300);
      await sleep(500);
    }
    await look('agent-map', {
      expect: 'The pill opens the Agent map, a dialog with a wake-up section: "every 45 min", the next time, when it ends and a Remove button; its row, opened, shows the prompt "Check whether the nightly export has finished."',
    }, async () => {
      await openMap();
      await codex.locator('[data-codex-extras="map-wakeups"] summary').first().click();
      await sleep(600);
      return mapBox();
    });
    await closeMap();
    const noteButton = () => codex.locator('[data-codex-extras="bar-button"]:not([aria-label^="About this conversation"])').first();
    await look('chime-button-off', {
      expect: 'A click on the note button turns the chimes off: the note icon is drawn struck through; the information button beside it is unchanged.',
    }, async () => {
      await noteButton().click();
      await sleep(800);
      return inCodex('[data-codex-extras="bar-button"]');
    });
    await noteButton().click().catch(() => {});
    await look('user-message-color', {
      expect: 'With codexPlus.userMessageColor set to #90EE90 the text of the user\'s own messages is light green; the replies keep their colour, and the messages keep their bar down the leading edge.',
      unchanged: 'The script clicked the note button again after the step before, so it is no longer struck through.',
    }, async () => {
      await setting('userMessageColor', '#90EE90');
      await toTop();
      await sleep(1500);
      const fb = await (await codex.frameElement()).boundingBox();
      return { x: fb.x, y: fb.y, width: fb.width, height: Math.min(fb.height, 520) };
    });
    await setting('userMessageColor', '');
    await look('turned-off', {
      expect: 'Codex Plus: Turn Off takes away what it draws in Codex\'s page: no times, no rail at the right edge, no information or note button, no context meter or pill in the toolbar; '
        + 'Codex\'s page itself still shows the conversation and its message box.',
    }, async () => {
      await exec('codexPlus.turnOff');
      await until(() => codex.evaluate(() => !document.querySelector('.codex-extras-rail') && !document.querySelector('[data-codex-extras="bar-button"]')), 15000, 500);
      await sleep(1000);
      return part(PARTS.editor);
    });
    await look('turned-on', {
      expect: 'Codex Plus: Turn On draws them all again: the times, the rail, the two buttons, the meter and the "1 timer" pill.',
    }, async () => {
      await exec('codexPlus.turnOn');
      await until(() => codex.evaluate(() => !!document.querySelector('.codex-extras-rail') && !!document.querySelector('[data-codex-extras="bar-button"]')), 15000, 500);
      const at = Date.now();
      if (!await until(async () => /timer/.test(await pillText()), 10000, 500)) tell('the Agent map pill was not drawn within 10 s of the rest');
      else if (Date.now() - at > 2000) tell(`the Agent map pill came ${Math.round((Date.now() - at) / 1000)} s after the rest`);
      await sleep(1500);
      return part(PARTS.editor);
    });
    await look('toggled-off', {
      expect: 'Codex Plus: Toggle On/Off turns them off again, the same as Turn Off.',
    }, async () => {
      await exec('codexPlus.toggle');
      await until(() => codex.evaluate(() => !document.querySelector('.codex-extras-rail')), 15000, 500);
      await sleep(1000);
      return part(PARTS.editor);
    });
    await exec('codexPlus.toggle');
    await until(() => codex.evaluate(() => !!document.querySelector('.codex-extras-rail')), 15000, 500);

    /* ═══ a turn: running, unread, read ═══ */
    const sideRow = () => list.evaluate((id) => { const r = document.querySelector(`.cp-row[data-id="${id}"]`); return r && r._row ? String(r._row.dot) : ''; }, t0.id).catch(() => '');
    const tabAndRow = async () => union([await tab(title).boundingBox().catch(() => null), await inList(`.cp-row[data-id="${t0.id}"]`)]);
    await look('turn-running', {
      expect: 'While the turn of a message sent from the tab runs, the tab\'s Codex logo carries a green dot, and the conversation\'s rows in the session list have a green dot.',
      unchanged: 'The script turned the additions back on with Toggle after the step before, so the times, rail and toolbar controls are drawn again.',
    }, async () => {
      await showList();
      model.hold();
      const turns = model.turns();
      await type('How is the inventory sync retry delay configured?');
      if (!await until(() => model.turns() > turns, 20000, 300)) throw new Error('the message reached no model');
      await until(async () => ((await dotsOn(title)) || {}).working >= 6, 20000, 500);
      await sleep(800);
      return tabAndRow();
    });
    await look('reply-unread', {
      expect: 'With notes.txt in front when the reply lands, the conversation\'s tab carries a red dot, its rows in the list a red dot, Agent Plus\'s bell in the status bar a count of 1, '
        + `and a notification says "${title}" finished, with a button to open it.`,
    }, async () => {
      await openNotes();
      await sleep(800);
      model.release();
      await until(async () => { const d = await dotsOn(title); return d && d.unread >= 6 && d.working === 0; }, 60000, 500);
      await until(async () => (await bellCount()) >= 1, 15000, 500);
      await sleep(1500);
      return union([await tabAndRow(), await part(PARTS.statusbar), await toastsBox()]);
    });
    await look('attention-list', {
      expect: 'A click on the bell in the status bar opens a list at the top of the window of the conversations that need the user, with this conversation in it.',
    }, async () => {
      const bell = page.locator(AGENT_BELL).filter({ has: page.locator('.codicon-bell-dot') }).first();
      await bell.locator('.statusbar-item-label, a').first().click({ timeout: 5000 });
      if (!await page.locator('.quick-input-widget').first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)) {
        const toastsNow = await toastLines();
        await start('agentPlus.showAttention');
        await page.locator('.quick-input-widget').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        throw new Error(`a click on the bell opened no list (notifications then: ${JSON.stringify(toastsNow)}); Agent Plus: Show the Conversations That Need You was run instead`);
      }
      await sleep(600);
      return union([await boxIn(null, '.quick-input-widget'), await part(PARTS.statusbar)]);
    });
    await page.keyboard.press('Escape');
    await until(() => page.locator('.quick-input-widget').first().isHidden(), 3000, 200);
    await look('reply-read', {
      expect: 'Bringing the tab to the front clears the red dot on its logo and on its rows in the list, takes the count off the bell, and closes the notification.',
    }, async () => {
      await tab(title).click();
      await until(async () => { const d = await dotsOn(title); return d && d.unread === 0 && d.working === 0; }, 20000, 500);
      await sleep(2000);
      return union([await tabAndRow(), await part(PARTS.statusbar)]);
    });
    const hookBubble = '[data-codex-extras-hook]';
    await look('hook-prompt-folded', {
      expect: 'The plugin\'s Stop hook asked, at the end of that turn, for the plan to be brought up to date; Codex Plus draws that prompt on the user\'s side as one dim line, with no bubble background and no coloured bar, '
        + 'and "Hook feedback" under it.',
    }, async () => {
      await toBottom();
      if (!await until(() => codex.evaluate((q) => !!document.querySelector(q), hookBubble), 20000, 500)) throw new Error('no Stop hook prompt was found in the conversation');
      await codex.evaluate((q) => { const b = [...document.querySelectorAll(q)].pop(); b.scrollIntoView({ block: 'center' }); }, hookBubble);
      await sleep(800);
      const b = await inCodex(`${hookBubble}`);
      return b && { x: b.x - 40, y: b.y - 40, width: b.width + 80, height: b.height + 80 };
    });
    await look('hook-prompt-unfolded', {
      expect: 'A click on that line unfolds it: the whole prompt, over several lines, still dim and without the bubble background.',
    }, async () => {
      await codex.locator(hookBubble).last().click();
      await sleep(800);
      const b = await inCodex(`${hookBubble}[data-codex-extras-hook="open"]`) || await inCodex(hookBubble);
      return b && { x: b.x - 40, y: b.y - 40, width: b.width + 80, height: b.height + 80 };
    });
    await codex.locator(hookBubble).last().click().catch(() => {});
    writePlan('done');
    await look('reply-duration', {
      expect: 'Above the last reply its time is followed, when Codex shows no "Worked for" of its own, by how long the turn took, and then its figures, as "14:02:11  3s · ctx 0% · gpt-6.1-sol medium"; '
        + 'under that turn\'s reply a line names the skill "inventory-sync-retry" that the skill search gave Codex.',
    }, async () => {
      await toBottom();
      return bottomBox(520);
    });

    /* ═══ work left running after a turn ═══ */
    await look('left-running-command', {
      expect: 'After a turn that started "sleep 30" in the background has ended, the tab\'s logo still carries a green dot, the conversation\'s rows in the list stay green, and the row below the message box '
        + 'says at its right end that a command is still running.',
    }, async () => {
      model.script(t0.id, [{ call: 'exec_command', args: { cmd: 'sleep 30', yield_time_ms: 1000 } }, { reply: 'Started the job.' }]);
      await type('Start the background command and come back.');
      if (!await until(async () => model.left() === 0 && ((await dotsOn(title)) || {}).working >= 6 && /^working/.test(await sideRow()), 40000, 500)) throw new Error('the conversation was not green after its turn');
      await sleep(4000);
      return union([await tab(title).boundingBox(), await bottomBox(160)]);
    });
    await look('left-running-row-hover', {
      expect: 'The hover of the conversation\'s row in the session list says "A background command is still running".',
    }, async () => {
      await showList();
      await away();
      await row(t0.id).hover();
      await until(() => list.evaluate(() => { const h = document.querySelector('.cp-hover'); return h && !h.classList.contains('cp-hidden'); }), 5000, 200);
      await sleep(500);
      return union([await rowBox(t0.id, '.cp-section[data-key="open"]') || await rowBox(t0.id), await inList('.cp-hover:not(.cp-hidden)')]);
    });
    await away();
    await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 60000, 1000);
    model.script(null);

    const outside = (cmd) => ({ call: 'exec_command', args: { cmd, yield_time_ms: 1000, sandbox_permissions: 'require_escalated', justification: 'Start the job outside the sandbox.' } });
    const notices = model.sent('Codex Plus notice');
    await look('approval-waiting', {
      expect: 'A command asked to run outside the sandbox: Codex shows its approval card above the message box, asking whether to run "setsid sleep 40 ..." with its buttons; the tab\'s logo carries a blue dot and the conversation\'s rows in the list a blue dot.',
    }, async () => {
      model.script(t0.id, [outside('setsid sleep 40 >/dev/null 2>&1 < /dev/null &'), { reply: 'Started the job.' }]);
      await type('Start the detached job and come back.');
      if (!await until(card, 20000, 300)) throw new Error('Codex showed no approval card');
      await until(async () => ((await dotsOn(title)) || {}).prompt >= 6, 20000, 500);
      await sleep(1500);
      return union([await tabAndRow(), await bottomBox(360)]);
    });
    await look('detached-running', {
      expect: 'Once approved and the turn has ended, the tab\'s logo and the conversation\'s rows are green again, and the Agent map pill counts the detached command: "1 detached · 1 timer".',
    }, async () => {
      await approve();
      if (!await until(async () => model.left() === 0 && /\b1 detached\b/.test(await pillText()), 40000, 500)) throw new Error(`the pill read ${JSON.stringify(await pillText())}`);
      await sleep(1000);
      return union([await tab(title).boundingBox(), await toolbar()]);
    });
    await look('detached-agent-map', {
      expect: 'The Agent map lists the detached command "sleep 40" with when it started, besides the wake-up.',
    }, async () => { await openMap(); return mapBox(); });
    await closeMap();
    await look('detached-end-notice', {
      expect: 'Once "sleep 40" has ended, the conversation is sent a notice from Codex Plus that the detached command is no longer running and its exit code cannot be known; it shows at the bottom of the conversation with Codex\'s reply after it, and the green dot is gone.',
    }, async () => {
      if (!await until(() => model.sent('Codex Plus notice') > notices, 90000, 1000)) throw new Error('no notice reached the model in 90 s');
      await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 30000, 1000);
      await sleep(1500);
      await toBottom();
      return bottomBox(520);
    });
    model.script(null);
    await look('subagent-agent-map', {
      expect: 'After a turn that started a sub-agent, the pill counts it ("1 agent"), and the Agent map lists the sub-agent with a status dot and when it was last active.',
    }, async () => {
      model.script(t0.id, [{ call: 'spawn_agent', namespace: 'collaboration', args: { task_name: 'job', message: 'Wait for the job.', fork_turns: 'none' } }, { reply: 'Started a helper.' }]);
      await type('Start a helper and come back.');
      if (!await until(async () => model.left() === 0 && /\bagent/.test(await pillText()), 40000, 500)) throw new Error(`the pill read ${JSON.stringify(await pillText())}`);
      await sleep(1000);
      await openMap();
      return mapBox();
    });
    await closeMap();
    await look('subagent-row-indented', {
      expect: 'With codexPlus.hideBackgroundSessions off, the session list also lists the sub-agent, indented under the conversation that started it.',
    }, async () => {
      await showList();
      await setting('hideBackgroundSessions', false);
      await until(() => list.evaluate(() => !!document.querySelector('.cp-row.cp-child')), 20000, 500);
      await sleep(800);
      return inList('.cp-groups');
    });
    model.releaseOthers();
    await setting('hideBackgroundSessions', true);
    await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 60000, 1000);
    model.script(null);

    /* ═══ images in a reply ═══ */
    {
      const zlib = require('zlib');
      const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
      const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
      const chunk = (t, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(t, 'latin1'), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
      const png = (wd, h) => {
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(wd, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
        const line = Buffer.alloc(1 + wd * 3);
        for (let x = 0; x < wd; x++) { line[1 + x * 3] = x < wd / 2 ? 220 : 30; line[2 + x * 3] = 60; line[3 + x * 3] = x < wd / 2 ? 40 : 200; }
        return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
          chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => line)))), chunk('IEND', Buffer.alloc(0))]);
      };
      const chart = path.join(profile.folder, 'test-chart.png'), diagram = path.join(profile.folder, 'test-diagram.svg');
      fs.writeFileSync(chart, png(320, 180));
      fs.writeFileSync(diagram, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="80" height="90" fill="#2a2"/><rect x="80" width="80" height="90" fill="#a2a"/></svg>');
      const reply = `Chart: ![test chart](${chart})\n\nDiagram: ![test diagram](${diagram})\n\nSame chart: ![test file url](file://${chart})\n\n`
        + `Inline: ![test inline](data:image/png;base64,${png(12, 12).toString('base64')})\n\nWeb: ![test web](https://example.com/test-logo.png)`;
      const drawnImgs = () => codex.evaluate(() => [...document.querySelectorAll('img')].filter((i) => /^test /.test(i.alt) && i.naturalWidth > 0).length).catch(() => 0);
      const imagesBox = () => inCodex('img[alt^="test "], a[data-codex-extras="img-stand"], span[data-codex-extras="img-stand"]');
      await look('reply-images', {
        expect: 'A reply drawing a red-and-blue PNG chart and a green-and-purple SVG by absolute path, the same chart from a file:// URL and a small data: image, each at its own size and no larger than 640 by 480, '
          + 'and the image at a web address shown as a plain link "test web" with no image.',
      }, async () => {
        model.script(t0.id, [{ reply }]);
        await type('Show the test images.');
        if (!await until(async () => { await toBottom(); return (await drawnImgs()) >= 4; }, 30000, 500)) throw new Error(`only ${await drawnImgs()} of the images were drawn`);
        await sleep(1500);
        await codex.evaluate(() => {
          const web = [...document.querySelectorAll('[data-codex-extras="img-stand"]')].find((x) => x.textContent === 'test web');
          const s = document.querySelector('[data-app-action-timeline-scroll]');
          if (web && s) { web.scrollIntoView({ block: 'end' }); s.scrollBy(0, 60); }
        });
        await sleep(800);
        return (await imagesBox()) || bottomBox(600);
      });
      await look('reply-images-off', {
        expect: 'With codexPlus.replyImages off the four drawn images become "[Image]" text, and the web link stays a link.',
      }, async () => {
        await setting('replyImages', false);
        await until(async () => (await drawnImgs()) === 0, 15000, 500);
        await sleep(1000);
        return bottomBox(600);
      });
      await setting('replyImages', true);
      model.script(null);
    }

    /* ═══ a wake-up ═══ */
    await look('wake-up-sent', {
      unchanged: 'The script turned codexPlus.replyImages back on after the step before, so the reply\'s images are drawn again.',
      expect: 'A wake-up due on the idle conversation is sent into it as a message whose first line reads "[Wake-up set in this conversation: sent by its timer, not by the user, ...]" followed by the prompt '
        + '"Check whether the nightly export has finished.", and Codex answers it.',
    }, async () => {
      const before = model.sent(WAKEUP_LINE);
      setWakeup(1, 120);
      if (!await until(() => model.sent(WAKEUP_LINE) > before, 90000, 1000)) throw new Error('no wake-up reached the model in 90 s');
      setWakeup(45);
      await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 30000, 1000);
      await sleep(1500);
      await toBottom();
      return bottomBox(520);
    });

    /* ═══ the context meter near the end of the window, and a compaction ═══ */
    await look('low-context-outline', {
      expect: 'After a turn that used 86% of the context window the meter reads about 86% and has an outline round it.',
    }, async () => {
      const span = windowOf(t0.id) || 380000;
      model.script(t0.id, [{ reply: 'Read the whole build log.', inputTokens: Math.round(span * 0.86) }]);
      await sendAndWait('Read the whole build log.');
      if (!await until(() => codex.evaluate(() => !!document.querySelector('.codex-extras-ctx-low')), 15000, 500)) throw new Error(`no outline; the meter reads ${await codex.evaluate(() => (document.querySelector('[data-codex-extras="meter"]') || {}).textContent)}`);
      return toolbar();
    });
    model.script(null);
    await look('compact-on-click', {
      expect: 'A click on the meter starts a compaction: the conversation shows Codex\'s note that the context was compacted, and the meter reads much less afterwards, with no outline.',
    }, async () => {
      const before = model.turns();
      await codex.locator('[data-codex-extras="meter"]').first().click();
      if (!await until(() => model.turns() > before, 20000, 500)) throw new Error('the click sent nothing to the model');
      await until(() => codex.evaluate(() => !document.querySelector('.codex-extras-ctx-low')), 30000, 500);
      await sleep(2000);
      await toBottom();
      return bottomBox(420);
    });

    /* ═══ a goal ═══ */
    const goalOf = () => list.evaluate((id) => { const r = document.querySelector(`.cp-row[data-id="${id}"]`); return r && r._row ? String(r._row.goal || '') : ''; }, t0.id).catch(() => '');
    await look('goal-paused', {
      expect: 'With a paused goal set on the conversation, its row in the list shows "goal paused" after the title, and its menu offers "Codex Plus: Resume Goal" and "Codex Plus: Clear Goal".',
    }, async () => {
      const r = await hostRequest('thread/goal/set', { threadId: t0.id, objective: 'Make the nightly export include archived rows', status: 'paused', origin: 'user' });
      if (r && r.error) throw new Error(`thread/goal/set: ${JSON.stringify(r.error)}`);
      if (!await until(async () => (await goalOf()) === 'paused', 30000, 500)) throw new Error(`the row's goal is ${JSON.stringify(await goalOf())}`);
      await menuOn(row(t0.id));
      return union([await rowBox(t0.id), await menuBox()]);
    });
    await look('goal-active', {
      expect: 'Resume Goal sets it going: the row shows "goal", its dot turns green as Codex starts a turn for the goal, and the Agent map pill names the goal.',
    }, async () => {
      model.hold();
      await ctxItem('Resume Goal').click({ timeout: 5000 });
      if (!await until(async () => (await goalOf()) === 'active', 30000, 500)) throw new Error(`the row's goal is ${JSON.stringify(await goalOf())}`);
      await sleep(2000);
      return union([await rowBox(t0.id), await tab(title).boundingBox(), await toolbar()]);
    });
    await pick(row(t0.id), ['Pause Goal']).catch((e) => note(`Pause Goal: ${e.message}`));
    model.release();
    await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 60000, 1000);
    await look('goal-cleared', {
      expect: 'After Pause Goal and then Clear Goal the row shows no goal word, and the Agent map pill no longer names a goal.',
    }, async () => {
      await pick(row(t0.id), ['Clear Goal']);
      if (!await until(async () => (await goalOf()) === '', 30000, 500)) throw new Error(`the row's goal is ${JSON.stringify(await goalOf())}`);
      await sleep(1000);
      return union([await rowBox(t0.id), await toolbar()]);
    });

    /* ═══ tabs ═══ */
    const vsMenu = () => page.evaluate(() => { const m = [...document.querySelectorAll('.context-view .monaco-menu')].find((e) => e.offsetParent); return m ? m.innerText : ''; });
    await look('tab-context-menu', {
      expect: 'A right-click on the conversation, on its tab or else inside its page, opens a VS Code menu holding "Codex Plus: Mark as Unread", "Codex Plus: Rename" and "Codex Plus: Add to Group".',
    }, async () => {
      await tab(title).click({ button: 'right' });
      await until(vsMenu, 5000, 200);
      let at = await tab(title).boundingBox();
      if (!/Codex Plus/.test(await vsMenu())) {
        await page.keyboard.press('Escape');
        await toTop();
        const talk = await inCodex('[data-turn-key]');
        if (!talk) throw new Error('the tab\'s menu has no Codex Plus item, and the page has no turn to right-click');
        await page.mouse.click(talk.x + talk.width / 2, talk.y + 20, { button: 'right' });
        await until(vsMenu, 5000, 200);
        at = { x: talk.x + talk.width / 2 - 4, y: talk.y + 16, width: 8, height: 8 };
      }
      if (!/Codex Plus/.test(await vsMenu())) throw new Error(`no menu with Codex Plus items: ${JSON.stringify((await vsMenu()).slice(0, 200))}`);
      await sleep(500);
      return union([at, await boxIn(null, '.context-view .monaco-menu')]);
    });
    await page.keyboard.press('Escape');
    await look('recently-closed', {
      expect: `Once the tab of "${freshTitle || 'the conversation started from the tab bar'}" is closed, the session list's "Recently closed" section, opened, lists it.`,
    }, async () => {
      if (!freshTitle) throw new Error('the conversation started from the tab bar has no title');
      await showList();
      await tab(freshTitle).click();
      await exec('workbench.action.closeActiveEditor');
      await until(() => list.evaluate(() => !!document.querySelector('.cp-section[data-key="closed"] .cp-row')), 20000, 500);
      const open = await list.evaluate(() => { const s = document.querySelector('.cp-section[data-key="closed"]'); return s && s.classList.contains('cp-open'); });
      if (!open) await list.locator('.cp-section[data-key="closed"] .cp-section-head').first().click();
      await sleep(800);
      return inList('.cp-section[data-key="closed"]');
    });
    await look('reopen-closed-shortcut', {
      expect: `Ctrl+Shift+T, with the editor focused, reopens "${freshTitle}" in a tab, in front, showing its message and reply.`,
    }, async () => {
      await tab(title).click();
      await sleep(500);
      await page.keyboard.press('Control+Shift+T');
      if (!await until(async () => { const t = await frontTab(); return t && t.label === freshTitle; }, 20000, 500)) throw new Error(`the tab in front is ${JSON.stringify(await frontTab())}`);
      await sleep(3000);
      return union([await tabsBox(), await part(PARTS.editor)]);
    });

    /* ═══ Agent Plus ═══ */
    await look('work-plan-view', {
      expect: 'Agent Plus\'s Work plan view, in its own side bar, shows the plan of the Codex conversation in front: "Find the retry delay" done, "Decide the default delay" waiting on the user with its question, and "Update the docs" to do.',
    }, async () => {
      await tab(title).click();
      await exec('agentPlus.refreshWorkPlan');
      await exec('workbench.view.extension.agentPlus');
      const at = Date.now();
      const rows = await until(() => page.evaluate(() => {
        const sb = document.getElementById('workbench.parts.sidebar');
        return sb && /Decide the default delay/.test(sb.innerText);
      }), 20000, 500);
      if (!rows) tell('the Work plan view did not show the plan\'s rows within 20 s of the tab coming to the front');
      else if (Date.now() - at > 3000) tell(`the Work plan view showed the plan ${Math.round((Date.now() - at) / 1000)} s after the tab came to the front`);
      await sleep(1000);
      return part(PARTS.sidebar);
    });
    const panelRow = (text) => page.locator('[id="workbench.parts.panel"] .monaco-list-row').filter({ hasText: text }).first();
    await look('conversations-view', {
      expect: 'Agent Plus\'s Conversations view in the panel lists the Codex conversations of this workspace with Codex\'s logo; this one shows its question "Should the default retry delay stay at 30 seconds, or go up to 60?" waiting for the user, '
        + 'and the status bar has "1 to decide".',
    }, async () => {
      await exec('agentPlus.showConversations');
      await panelRow(title).waitFor({ state: 'visible', timeout: 30000 });
      await sleep(1500);
      return union([await part(PARTS.panel), await part(PARTS.statusbar)]);
    });
    let answer = null;
    await look('conversation-brief', {
      expect: 'A click on the conversation\'s row shows its brief in the Answer view beside it: its title, a button to go to it, the summary "Finding where the inventory sync sets its retry delay, and deciding its default." and its status.',
    }, async () => {
      await panelRow(title).click();
      answer = await frameWhere((want) => { const b = document.getElementById('brief'), t = document.getElementById('btitle'); return !!b && b.style.display === 'flex' && !!t && t.textContent === want; }, 30000, title);
      if (!answer) throw new Error('the Answer view did not show the brief');
      await sleep(800);
      return part(PARTS.panel);
    });
    await look('answer-question', {
      expect: 'A click on the question\'s row shows it in the Answer view: the conversation, the row "Decide the default delay", the question, a text box holding "Keep it at 30 seconds." and Send and Open buttons.',
    }, async () => {
      await panelRow('Should the default retry delay').click();
      answer = await frameWhere(() => { const m = document.getElementById('main'); return !!m && getComputedStyle(m).display !== 'none' && !!document.getElementById('text'); }, 20000);
      if (!answer) throw new Error('the Answer view did not show the question');
      await answer.locator('#text').fill('Keep it at 30 seconds.');
      await sleep(500);
      return part(PARTS.panel);
    });
    await look('answer-sent', {
      expect: 'Send puts the answer into the conversation\'s message box and sends it: the Answer view says it was sent, and the conversation shows "Keep it at 30 seconds." as the user\'s message, followed by a reply.',
    }, async () => {
      if (!answer) throw new Error('the Answer view is not open');
      const before = model.turns();
      await answer.locator('#send').click();
      if (!await until(() => model.turns() > before, 30000, 500)) throw new Error(`the answer reached no model; the view says ${JSON.stringify(await answer.evaluate(() => document.getElementById('status').textContent).catch(() => ''))}`);
      await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 30000, 1000);
      await sleep(1500);
      await toBottom();
      return union([await part(PARTS.panel), await bottomBox(300)]);
    });

    /* ═══ the token mode ═══ */
    const tokenEntry = () => page.locator('.statusbar-item').filter({ has: page.locator('.codicon-dashboard') }).first();
    await look('token-mode-list', {
      expect: 'A click on Agent Plus\'s token mode entry in the status bar ("All") opens a list of four modes at the top of the window, Interface features, Essential features, All features and Custom, each with a line saying what it runs.',
    }, async () => {
      await tokenEntry().click({ timeout: 10000 });
      await page.locator('.quick-input-widget .quick-input-list .monaco-list-row').first().waitFor({ state: 'visible', timeout: 10000 });
      await sleep(600);
      return union([await boxIn(null, '.quick-input-widget'), await tokenEntry().boundingBox()]);
    });
    await look('token-mode-essential', {
      expect: 'Choosing Essential features closes the list and the status bar entry reads "Essential".',
    }, async () => {
      await page.locator('.quick-input-widget .quick-input-list .monaco-list-row').filter({ hasText: 'Essential features' }).first().click();
      await until(async () => (await tokenEntry().innerText().catch(() => '')).trim() === 'Essential', 10000, 300);
      await away();
      await sleep(500);
      return part(PARTS.statusbar);
    });
    await setting('tokenMode', undefined, 'agentPlus');

    /* ═══ Codex's sidebar ═══ */
    await look('resume-in-sidebar', {
      expect: 'Resume in Sidebar on "Why does the nightly export skip archived rows?" shows it in Codex\'s sidebar on the right, with a time on each message and reply, each inside its column; the session list\'s Open sessions lists it.',
    }, async () => {
      await toList();
      await pick(row(t1.id), ['Resume in Sidebar']);
      await allowUri();
      const side = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want) && document.querySelectorAll('.codex-extras-stamp-assistant').length >= 4, 90000, t1.title);
      if (!side) throw new Error('the conversation did not show in Codex\'s sidebar');
      await sleep(1500);
      return union([await part(PARTS.auxiliary), await part(PARTS.sidebar)]);
    });
    await exec('workbench.action.closeAuxiliaryBar');

    /* ═══ archived while its tab is open ═══ */
    const shelvedOnDisk = () => { try { return fs.readdirSync(path.join(profile.codexHome, 'archived_sessions'), { recursive: true }).some((n) => String(n).includes(t0.id)); } catch (_) { return false; } };
    await look('archived-while-open', {
      expect: 'Archived while its tab is open, the conversation stays in the tab with all its turns, read-only, with no message box; the session list shows it under Archived sessions.',
    }, async () => {
      await tab(title).click();
      await exec('codexPlus.archiveThread', { webviewSection: 'thread', threadId: t0.id, webview: 'codexPlus.sessions' }, [t0.id]);
      if (!await until(shelvedOnDisk, 30000, 500)) throw new Error('the rollout did not move to archived_sessions/');
      await until(() => codex.evaluate(() => document.querySelectorAll('[data-turn-key]').length > 0 && !document.querySelector('[data-codex-composer-root]')).catch(() => false), 30000, 500);
      await sleep(1500);
      return union([await part(PARTS.editor), await part(PARTS.sidebar)]);
    });
    await look('unarchived-from-list', {
      expect: 'A click on its row in Archived sessions unarchives it: the row goes back among the others, and the tab has its message box again.',
    }, async () => {
      const open = await list.evaluate(() => { const g = document.querySelector('.cp-group[data-key="archived"]'); return g && g.classList.contains('cp-open'); });
      if (!open) await list.locator('.cp-group[data-key="archived"] .cp-group-head').first().click();
      await sleep(500);
      await rowIn('archived', t0.id).click({ timeout: 10000 });
      if (!await until(() => !shelvedOnDisk(), 30000, 500)) throw new Error('the conversation was not unarchived');
      await until(() => codex.evaluate(() => !!document.querySelector('[data-codex-composer-root]')).catch(() => false), 30000, 500);
      await sleep(1500);
      return union([await part(PARTS.editor), await part(PARTS.sidebar)]);
    });

    /* ═══ commands ═══ */
    await look('show-status', {
      expect: 'Codex Plus: Show Status shows the Codex Plus output channel in the panel: what is installed and patched, what is registered with Agent Plus, the token mode and which features run, whether this Codex build was checked, '
        + 'the wake-up that is set, commands still running, the last times a Codex page opened, and what the page script found.',
    }, async () => {
      await exec('codexPlus.status');
      await sleep(2500);
      return part(PARTS.panel);
    });
    await look('open-times', {
      expect: 'Show How Long Opening a Codex Page Took writes, in the same channel, how long each Codex page of this run took to open: the page script, the first screen, the conversation or home page, the restore.',
    }, async () => {
      await exec('codexPlus.showOpenTimes');
      await sleep(2500);
      return part(PARTS.panel);
    });
    await look('settings-page', {
      expect: 'Codex Plus: Settings opens VS Code\'s settings editor filtered to "@ext:xnervwang.codex-plus", listing Codex Plus\'s settings with their descriptions.',
    }, async () => {
      await exec('codexPlus.openSettings');
      await sleep(2500);
      return part(PARTS.editor);
    });
    await exec('workbench.action.closeActiveEditor');
    await look('session-list-hidden', {
      expect: 'With codexPlus.sessionList off, the Codex Plus side bar no longer shows the Codex sessions view.',
    }, async () => {
      await exec('workbench.view.extension.codexPlus');
      await setting('sessionList', false);
      await sleep(2000);
      return part(PARTS.sidebar);
    });
    await setting('sessionList', true);
    trustAuto = false;
    await look('stop-loading-plugin', {
      expect: 'Stop Loading the Work Plan Plugin shows a notification that Codex will not load the plugin and that it stays installed, with its trust kept.',
    }, async () => {
      await exec('notifications.clearAll');
      await start('codexPlus.stopLoadingWorkPlanPlugin');
      await until(async () => (await toastLines()).length > 0, 20000, 500);
      await sleep(500);
      return toastsBox();
    });
    await look('install-plugin-again', {
      expect: 'Install the Work Plan Plugin into Codex installs it again and says so, or asks again to trust its hooks; no error notification.',
    }, async () => {
      await exec('notifications.clearAll');
      await start('codexPlus.installWorkPlanPlugin');
      await until(async () => (await toastLines()).length > 0 || !!await trustShown(), 30000, 500);
      await sleep(1000);
      const t = await trustShown();
      return t ? t.boundingBox() : toastsBox();
    });
    {
      const t = await trustShown();
      if (t) await trustIt(t);
    }
    await look('trust-hooks-command', {
      expect: 'Trust the Work Plan Hooks in Codex either asks again to trust them or says there is nothing left to trust; no error notification.',
    }, async () => {
      await exec('notifications.clearAll');
      await start('codexPlus.trustWorkPlanHooks');
      await until(async () => (await toastLines()).length > 0 || !!await trustShown(), 20000, 500);
      await sleep(800);
      const t = await trustShown();
      return t ? t.boundingBox() : toastsBox();
    });
    {
      const t = await trustShown();
      if (t) await trustIt(t);
    }
    trustAuto = true;
    await look('download-python', {
      expect: 'Download Python for the Work Plan Hooks says, on Linux, that python.org publishes an embeddable Python for Windows only, and to install Python 3 and run Install the Work Plan Plugin.',
    }, async () => {
      await exec('notifications.clearAll');
      await start('codexPlus.downloadPython');
      await until(async () => (await toastLines()).length > 0, 20000, 500);
      await sleep(500);
      return toastsBox();
    });

    /* ═══ the patch removed and put back: last, since it takes the page's additions away ═══ */
    await look('remove-patch-prompt', {
      expect: 'Remove the Patch from Codex says Codex\'s own files are back and the window has to be reloaded to run them, with a Reload button.',
    }, async () => {
      await exec('notifications.clearAll');
      await start('codexPlus.removePatch');
      await until(async () => (await toastLines()).some((l) => /own files are back/.test(l)), 30000, 500);
      await sleep(500);
      return toastsBox();
    });
    await look('after-remove-reload', {
      expect: 'After the reload Codex runs its own code: the conversation\'s tab shows no times, rail, information or note button, context meter or pill, and the tab bar has Codex\'s own button.',
    }, async () => {
      await exec('notifications.clearAll');
      await w.reload();
      await sleep(4000);
      await exec('codexPlus.openThreadInTab', t0.id);
      codex = await frameWhere((want) => !!document.querySelector('[data-codex-composer-root]') && document.body.innerText.includes(want), 90000, title);
      await sleep(3000);
      return union([await tabsBox(), await part(PARTS.editor)]);
    });
    await look('turn-on-after-remove', {
      expect: 'Codex Plus: Turn On after the removal patches Codex again and offers to reload the window, in a notification with a Reload button.',
    }, async () => {
      await start('codexPlus.turnOn');
      await until(async () => (await toastLines()).some((l) => /reload/i.test(l)), 60000, 500);
      await sleep(500);
      return toastsBox();
    });
  } finally {
    watching = false;
    await trustWatch;
    if (trusted) note(`the work plan hooks were trusted ${trusted} time(s)`);
    fs.writeFileSync(path.join(out, 'look.json'), JSON.stringify(entries, null, 2));
    console.log(`\n${entries.length} look steps in ${path.join(out, 'look.json')}`);
    await w.close();
  }
}

module.exports = { run, LOOK_SETTINGS, SCALE };
