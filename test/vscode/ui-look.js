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
 *   unchanged        what the step should not have changed, or null
 *   image, full      paths of those two PNGs, relative to <out>
 *   previous         the previous step's whole window, or null
 *   width, height    the close view's size in pixels
 *   log              new lines since the step before in the extension host's log and in the Codex Plus and Agent Plus
 *                    output channels, the notifications on screen, and the step's own failures, marked [ui-look]
 *   note             only on a step whose actions failed: why
 *
 * Notifications stay on screen, since an error notification is one of the things the reader looks for. LOOK.md beside
 * this file is what the reader is given; it comes from Agent Plus with the other shared files (build/sync-shared.js).
 *
 * Unlike ui.js, it trusts the work plan plugin's hooks when asked, so the plan's injection and its Stop hook run.
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
const FEATURES = require('./lib/feature-list').load().features;
/* Added to the settings run.js writes: a window as large as the screen, no secondary side bar until a step opens one
   (Codex's would otherwise open there at start-up, beside every shot), and a context window the meter's hover can say
   it took from this extension's setting. */
const LOOK_SETTINGS = { 'window.newWindowDimensions': 'maximized', 'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'codexPlus.contextWindow': { 'gpt-6.1-sol': '600K' } };
/* TAB_DOTS in src/patching.js: green working, drawn as a ring with only background work left, and red waiting. */
const DOTS = { working: [0x22, 0xc5, 0x5e], waiting: [0xef, 0x44, 0x44] };
/* The unread envelope in the Dark Modern theme that run.js sets (src/envelope.js). */
const ENVELOPE = '\u{1F4E9}';
const bare = (text) => String(text || '').replace(/(?:\uD83D\uDCE9|\u2709)[\uFE0E\uFE0F]?/g, ' ').replace(/\s+/g, ' ').trim();
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
  const t0 = threads[0], t1 = threads[1];
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
    const near = (i, c) => Math.abs(img.data[i] - c[0]) <= 24 && Math.abs(img.data[i + 1] - c[1]) <= 24 && Math.abs(img.data[i + 2] - c[2]) <= 24;
    for (const [k, c] of Object.entries(DOTS)) {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (near(i, c)) n++;
      count[k] = n;
    }
    /* A ring is a green mark whose centre pixel is not green. */
    let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        if (near((yy * img.width + xx) * 4, DOTS.working)) { x0 = Math.min(x0, xx); y0 = Math.min(y0, yy); x1 = Math.max(x1, xx); y1 = Math.max(y1, yy); }
      }
    }
    count.ring = count.working >= 6 && !near((Math.round((y0 + y1) / 2) * img.width + Math.round((x0 + x1) / 2)) * 4, DOTS.working);
    return count;
  };
  /* Finds the tab whose title is `want` once its envelope is removed. */
  const labelOf = async (want) => {
    const t = (await tabs()).flatMap((g) => g.tabs).find((x) => bare(x.label) === want);
    return t ? t.label : null;
  };
  /* The bell, a separate entry Agent Plus dropped after 1.7.0, shows the number of conversations waiting or finished.
     The Conversations entry's "N conversations need you" counts those with a question in their plan and those waiting
     for the user to approve something or answer; its hover, which the entry's aria-label carries, lists the waiting ones
     last under WAITS_HEAD, one a line for the first ten and then "and N more". */
  const WAITS_HEAD = 'Waiting for you to approve something or answer:';
  const agentStatus = () => page.evaluate(() => {
    const shown = [...document.querySelectorAll('.statusbar-item')].filter((x) => x.offsetParent);
    const bell = shown.find((x) => /agentPlus\.attention$/.test(x.id));
    const entry = shown.find((x) => /agentPlus\.conversations$/.test(x.id));
    return { bell: bell ? Number(bell.innerText.trim()) || 0 : null, text: entry ? entry.innerText : '', label: entry ? entry.getAttribute('aria-label') || '' : '' };
  });
  const agentCount = async () => {
    const s = await agentStatus();
    if (s.bell !== null) return s.bell;
    const lines = s.label.split(/\r?\n/).map((l) => l.trim()), at = lines.indexOf(WAITS_HEAD);
    let n = 0;
    for (const l of at < 0 ? [] : lines.slice(at + 1)) {
      const more = /^and (\d+) more$/.exec(l);
      if (more) return n + Number(more[1]);
      if (!l || l.endsWith(':')) break;
      n++;
    }
    return n;
  };

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
  const runNote = note;
  /* What a step throws when this machine cannot be put into the step's state, which is not the extension's failing: the
     step keeps the error as its note and the run notes it rather than counting a failure. */
  const notHere = (why) => Object.assign(new Error(why), { notHere: true });
  /* Codex runs a sandboxed command under bubblewrap, which on some machines cannot bind the root directory at all; the
     command then exits at once with bwrap's message as its output, in the conversation's rollout. */
  const sandboxRefused = (id) => {
    try {
      const sessions = path.join(profile.codexHome, 'sessions');
      const file = fs.readdirSync(sessions, { recursive: true }).map((r) => path.join(sessions, String(r))).find((f) => f.endsWith(`${id}.jsonl`));
      const m = /bwrap: [^"\\]*/.exec(fs.readFileSync(file, 'utf8').split('\n').slice(-30).join('\n'));
      return m ? m[0] : '';
    } catch (_) { return ''; }
  };
  /* The last user-role message of a conversation's rollout holding `part`; hooks add user-role messages of their own. */
  const lastUserText = (id, part) => {
    try {
      const sessions = path.join(profile.codexHome, 'sessions');
      const file = fs.readdirSync(sessions, { recursive: true }).map((r) => path.join(sessions, String(r))).find((f) => f.endsWith(`${id}.jsonl`));
      const said = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter((r) => r && r.type === 'response_item' && r.payload && r.payload.type === 'message' && r.payload.role === 'user')
        .map((r) => (Array.isArray(r.payload.content) ? r.payload.content : []).map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(''))
        .filter((s) => s.includes(part));
      return said.length ? said[said.length - 1] : null;
    } catch (e) { return `unreadable: ${e.message}`; }
  };
  const featuresOf = (name) => FEATURES.filter((f) => f.steps.includes(name)).map((f) => f.id);
  /*
   * One step: `act` does what the step needs and returns the box (window CSS pixels) of what it is about, or null for
   * the whole window. Its failure is logged and the screenshots are taken all the same.
   */
  /* `clip`, in the window's CSS pixels, out of a screenshot taken at SCALE. */
  const cut = (png, clip) => {
    const img = pixels.decode(png);
    const x0 = Math.round(clip.x * SCALE), y0 = Math.round(clip.y * SCALE);
    const w = Math.min(img.width - x0, Math.round(clip.width * SCALE)), h = Math.min(img.height - y0, Math.round(clip.height * SCALE));
    if (w < 1 || h < 1) throw new Error('the close view lies outside the screenshot');
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) img.data.copy(data, y * w * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4);
    return pixels.encode({ width: w, height: h, data });
  };
  const pngSize = (file) => {
    try {
      const b = fs.readFileSync(file);
      return b.toString('ascii', 12, 16) === 'IHDR' ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
    } catch (_) { return null; }
  };
  const look = async (name, spec, act) => {
    console.log(`\n── ${name}`);
    const said = [];
    told = [];
    let box = null, note = '';
    /* A tab that was closed and opened again has a new page; the steps after it work on that one. */
    if (codex && codex.isDetached()) {
      codex = await frameWhere((want) => !!document.querySelector('[data-turn-key]') && document.body.innerText.includes(want) && innerWidth > 600, 30000, title);
      tell(codex ? 'the conversation\'s page had gone, so the step works on the one its tab shows now' : 'the conversation\'s page had gone and no other was found');
    }
    try {
      box = await act();
    } catch (e) {
      if (e && e.notHere) {
        note = `the window could not be put into this step's state on this machine: ${e.message}`;
        said.push(`[ui-look] ${note}`);
        runNote(`${name}: ${e.message}`);
      } else {
        const why = String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ');
        note = `the step's actions failed: ${why}`;
        said.push(`[ui-look] ${note}`);
        said.push(`[ui-look] the tabs then: ${JSON.stringify(await tabs().catch((x) => String(x))).slice(0, 600)}`);
        check(false, `${name}: its actions ran`, why);
      }
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
    /* A screenshot taken with a clip makes the webview under the pointer see it leave and close any hover box, such as
       the rail's, so the close view is cut out of the whole-window one. */
    const png = await page.screenshot({ animations: 'disabled' }).catch((e) => { said.push(`[ui-look] no screenshot: ${e.message}`); return null; });
    if (png) fs.writeFileSync(path.join(out, full), png);
    if (clip) {
      try { fs.writeFileSync(path.join(out, image), cut(png, clip)); } catch (_) { clip = null; }
    }
    if (!clip) {
      if (box) said.push('[ui-look] the box of what this step is about was empty, so the close view is the whole window');
      try { fs.copyFileSync(path.join(out, full), path.join(out, image)); } catch (_) { /* no full either */ }
    }
    const log = [...said, ...told, ...newLogLines(), ...await toastLines()];
    const size = pngSize(path.join(out, image));
    entries.push({ name, features: featuresOf(name), expect: spec.expect, unchanged: spec.unchanged || null, image, full, previous,
      width: size ? size.width : null, height: size ? size.height : null, log, ...(note ? { note } : {}) });
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

  /* ── Agent Plus's session list, which lists Codex's conversations from what this extension hands it ── */
  let list = null;
  /* A row's data-key, as Agent Plus's keyOf makes it. */
  const slKey = (id) => JSON.stringify(['codex', id]);
  const ROW = (id) => `.sl-section:not([data-key="closed"]) .sl-row[data-key='${slKey(id)}']`;
  const row = (id) => list.locator(ROW(id)).first();
  const inList = (sel) => boxIn(list, sel);
  const rowBox = (id) => inList(ROW(id));
  const menuBox = () => inList('.sl-ctx');
  /* What `id`'s row shows: dot, stripe, title, badges and the unread mark. */
  const slRow = (id) => (list ? list.evaluate((key) => {
    const r = [...document.querySelectorAll('.sl-section:not([data-key="closed"]) .sl-row')].find((x) => x.dataset.key === key);
    return r ? { dot: r.dataset.dot, stripe: r.dataset.stripe, title: (r.querySelector('.sl-title') || {}).textContent || '', unread: !!r.querySelector('.sl-unread'),
      badges: [...r.querySelectorAll('.sl-badge')].map((b) => b.textContent) } : null;
  }, slKey(id)).catch(() => null) : Promise.resolve(null));
  const closeMenus = async () => {
    if (!await list.evaluate(() => !!document.querySelector('.sl-ctx')).catch(() => false)) return;
    await page.keyboard.press('Escape');
    if (await until(() => list.evaluate(() => !document.querySelector('.sl-ctx')), 1000, 100)) return;
    const box = await (await list.frameElement()).boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height - 12);
    await until(() => list.evaluate(() => !document.querySelector('.sl-ctx')), 3000, 100);
  };
  /* What the list shows, for a step that could not find a row in it. */
  const listState = () => list.evaluate(() => [...document.querySelectorAll('.sl-section')].map((s) => `${s.dataset.key}: ${[...s.querySelectorAll('.sl-row .sl-title')]
    .map((t) => t.textContent).join(' | ')}`)).catch((e) => String(e));
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
    if (!await until(() => list.evaluate(() => !!document.querySelector('.sl-ctx')), 5000, 100)) throw new Error('no menu opened on the right-click');
    await still(list.locator('.sl-ctx').first());
  };
  /* An item of the menu, or of its submenu, labelled `label`: Archive is not Unarchive. */
  const ctxItem = (label, sub = false) => list.locator(sub ? '.sl-ctx-sub .sl-ctx-item' : '.sl-ctx:not(.sl-ctx-sub) .sl-ctx-item')
    .filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[›✓]?\\s*$`) }).first();
  /* The page closes its menu when another webview takes the focus, so the right-click is tried again when no menu
     opened or the click on its item missed, as in ui.js. */
  const pick = async (target, labels) => {
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await menuOn(target);
        if (labels.length > 1) {
          await ctxItem(labels[0]).click({ timeout: 5000 });
          await ctxItem(labels[1], true).click({ timeout: 5000 });
        } else await ctxItem(labels[0]).click({ timeout: 5000 });
        await until(() => list.evaluate(() => !document.querySelector('.sl-ctx')), 3000, 100);
        await away();
        return attempt;
      } catch (e) { last = e.message.split('\n')[0]; await sleep(500); }
    }
    throw new Error(`could not click ${labels.join(' > ')}: ${last}`);
  };
  const toList = async () => {
    await exec('workbench.view.extension.agentPlusSessions');
    list = await frameWhere(() => !!document.querySelector('.sl-root .sl-new'), 30000);
    if (!list) throw new Error('the session list did not open');
    return list;
  };
  /* Drags the side bar's edge to `to` CSS pixels, as readme-shots.js does: at the default width a title is cut short. */
  const widen = async (to = 420) => {
    const sb = await part(PARTS.sidebar);
    if (!sb || sb.width >= to - 4) return;
    await sideTo(to);
  };
  const sideTo = async (to) => {
    const sb = await part(PARTS.sidebar);
    if (!sb || Math.abs(sb.width - to) < 4) return;
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

  /* Drags the left edge of the secondary side bar, the one Codex's sidebar is in, until it is `to` CSS pixels wide, and
     resolves to the width it had before. */
  const auxTo = async (to) => {
    const ab = await part(PARTS.auxiliary);
    if (!ab || Math.abs(ab.width - to) < 4) return ab ? ab.width : 0;
    const sash = await page.evaluate((edge) => {
      const b = [...document.querySelectorAll('.monaco-sash.vertical')].map((e) => e.getBoundingClientRect())
        .find((r) => r.height > 200 && Math.abs(r.left + r.width / 2 - edge) < 6);
      return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
    }, ab.x);
    if (!sash) return ab.width;
    await page.mouse.move(sash.x, sash.y);
    await sleep(200);
    await page.mouse.down();
    await page.mouse.move(sash.x + (ab.width - to), sash.y, { steps: 10 });
    await page.mouse.up();
    await sleep(800);
    return ab.width;
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

    /* What every notification of this extension's starts with (src/notice-time.js). Until a page has told the extension
       the zone of the machine VS Code runs on, as at the first start, the time names this machine's zone. */
    const NOTICE_TIME = 'A notification\'s text starts with the time it was shown, in brackets, hours and minutes such as [14:05], '
      + 'with the zone\'s name after them, such as [14:05 UTC], until a Codex page has told Codex Plus the time zone of the machine VS Code runs on; '
      + 'a modal dialog has no time.';
    /* ═══ start-up: the patch and the plugin ═══ */
    const patched = await until(async () => { const s = await patchState(); return s && s.targets.every(([, x]) => x === 'patched') && s; }, 120000, 1000);
    if (!patched) note(`Codex was not patched in 120 s: ${JSON.stringify(await patchState())}`);
    await look('trust-hooks-prompt', {
      expect: 'Codex Plus asks, in a modal dialog in the middle of the dimmed window or in a notification at the bottom right, "Trust the work plan hooks in Codex?", '
        + 'saying what the hooks are, with a button to trust them and one to cancel. ' + NOTICE_TIME,
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
      expect: 'A notification at the bottom right says Codex is patched and the window has to be reloaded, with a Reload button. No error notification is shown. ' + NOTICE_TIME,
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

    /* ═══ Agent Plus's session list ═══ */
    await look('agent-plus-session-list', {
      expect: 'Agent Plus\'s "Conversations" side bar, its session list, shows the Codex conversations. From the top: a New bar (Codex\'s logo with a small caret, then "New in tab" and "New in sidebar", each with a plus), '
        + 'a row of chips (All, Open, Running, Needs you, each with a count), and an UNGROUPED section with four rows and no others: the conversation just started in a tab, '
        + '"Can you find where the retry delay for the inventory sync is set?", "Why does the nightly export skip archived rows?" and "Add a dry-run flag to the cleanup script". '
        + 'Each row has Codex\'s logo, its title and at the right how long ago it was last active. The conversation just started, whose tab is in front, has a solid stripe at the start of its row '
        + 'and is drawn as the current one, and no other row is. "Can you find where the retry delay for the inventory sync is set?" has a red dot at the top right of its logo, as its work plan asks '
        + 'the user a question put after the user\'s last message; the other rows have no dot. No row has the list\'s envelope of a reply not seen, the made-up conversations '
        + 'having been seen. Above them an ACCOUNT & USAGE section holds a Codex block that says Not signed in, since the made-up provider has no account.',
    }, async () => {
      /* The step before left notes.txt in front. */
      if (freshTitle) await tab(freshTitle).click();
      await toList();
      if (!await until(async () => (await Promise.all(threads.map((t) => slRow(t.id)))).every(Boolean), 30000, 500)) {
        throw new Error(`the list does not have the made-up conversations: ${JSON.stringify(await listState())}`);
      }
      await until(async () => ((await slRow(t0.id)) || {}).dot === 'red', 15000, 500);
      await widen();
      await away();
      await sleep(800);
      return part(PARTS.sidebar);
    });
    await look('account-not-signed-in', {
      expect: 'The ACCOUNT & USAGE section at the top of Agent Plus\'s session list, expanded: a block headed by Codex\'s logo and the name Codex, and under it one line, '
        + 'Sign-in at the left and Not signed in at the right, and no bars, since the made-up provider has no account. Below a thin line, THIS CONVERSATION in small capitals, '
        + 'the title of the conversation in front and its Tokens. Nothing is cut off or overlaps.',
    }, async () => {
      await toList();
      const said = await until(() => list.evaluate(() => { const a = document.querySelector('.sl-section[data-key="account"]');
        return !!a && !a.classList.contains('sl-hidden') && /Not signed in/.test(a.innerText); }).catch(() => false), 30000, 500);
      if (!said) throw new Error(`Account & usage does not say Not signed in: ${JSON.stringify(await listState())}`);
      if (!await list.evaluate(() => document.querySelector('.sl-section[data-key="account"]').classList.contains('sl-open'))) {
        await list.locator('.sl-section[data-key="account"] .sl-head').first().click();
      }
      await away();
      return inList('.sl-section[data-key="account"]');
    });
    await look('list-new-in-sidebar', {
      expect: '"New in sidebar" in Agent Plus\'s session list, with Codex as the agent of a new conversation, opens Codex in the secondary side bar on the right, on its new-conversation page with a message box.',
    }, async () => {
      await showList();
      await list.locator('.sl-new [data-where="sidebar"]').first().click();
      await allowUri();
      await until(async () => { const a = await part(PARTS.auxiliary); return a && a.width > 0; }, 15000, 500);
      await sleep(3000);
      return part(PARTS.auxiliary);
    });
    await exec('workbench.action.closeAuxiliaryBar');

    /* ═══ a conversation in a tab ═══ */
    await look('opened-from-list', {
      expect: `A click on the row of "${title}" in Agent Plus's session list opens it in a tab of the editor group there, titled by the conversation, showing its four messages and replies and the message box at the bottom. `
        + 'The tab\'s Codex logo carries a red dot, for the question its work plan put to the user after the user\'s last message. '
        + `In the list on the left, the row of "${title}" now has a solid stripe at its start, as open in this window, and is drawn as the current one, without its envelope icon; `
        + 'no other row is drawn as current, and the row of the conversation that was in front before keeps its stripe, as its tab is still open.',
    }, async () => {
      await showList();
      await row(t0.id).click({ timeout: 10000 });
      codex = await frameWhere((want) => !!document.querySelector('[data-codex-composer-root]') && document.querySelectorAll('[data-turn-key]').length >= 4
        && document.body.innerText.includes(want), 90000, title);
      if (!codex) throw new Error('the conversation did not open in 90 s');
      await until(async () => ((await slRow(t0.id)) || {}).stripe === 'here', 15000, 500);
      await away();
      await sleep(2500);
      return union([await tabsBox(), await part(PARTS.editor), await part(PARTS.sidebar)]);
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
    {
      const talk = await inCodex('[data-app-action-timeline-scroll]');
      await page.mouse.move(talk ? talk.x + 30 : 3, talk ? talk.y + 15 : 300);
      await sleep(500);
    }
    await look('agent-map', {
      expect: 'The pill opens the Agent map. At the top THIS CONVERSATION, with no count and no line above it, over a card titled by the conversation (cut short with an ellipsis), '
        + 'with the same dot as its tab and, under the title, the model and the tokens in context. Below, after a thin line, WAKE-UPS with a count badge 1 over the wake-up\'s card: '
        + 'its prompt\'s first line over "every 45 min", the next time and when it ends, and a Remove button under the card. The card, clicked open, shows the whole prompt '
        + '"Check whether the nightly export has finished." under it, and its arrow points down.',
    }, async () => {
      await openMap();
      await codex.locator('[data-codex-extras="map-wakeups"] summary').first().click();
      await sleep(600);
      return mapBox();
    });
    await closeMap();
    const planBarBox = async (f = codex) => union([await inCodex('[data-codex-extras="plan-bar"]', f), await inCodex('[data-codex-composer-root]', f)]);
    /* The plan bar's bubbles in frame `f`, as "state count" joined with commas. */
    const barBubbles = (f = codex) => f.evaluate(() => {
      const b = document.querySelector('[data-codex-extras="plan-bar"]');
      return b ? [...b.querySelectorAll('.apb-b')].map((x) => x.getAttribute('data-state') + ' ' + x.textContent.trim()).join() : '';
    }).catch(() => '');
    const PLAN_BAR = 'From the left: a list icon and "Plan" in bold; a small blue-tinted bubble with a blue play icon and 1, for the row doing; a purple-tinted bubble '
      + 'with a purple circle and 1, for the row to do; then empty space; at the right a solid orange pill with a question mark and "1 to decide" in dark letters, and an '
      + 'arrow. The row waiting for the answer has no bubble of its own: it is the 1 in "1 to decide". ';
    await look('plan-bar', {
      expect: `Just above the message box, as wide as it and 6 px clear of its top edge, the plan bar, one line high with a thin border and rounded corners. ${PLAN_BAR}`
        + 'It covers neither the last lines of the conversation nor the message box: the conversation ends above it. The toolbar inside the message box is unchanged.',
    }, async () => {
      if (!await until(async () => (await barBubbles()) === 'doing 1,todo 1', 20000, 500)) {
        tell('the plan bar did not show a bubble of 1 doing and one of 1 to do within 20 s');
      }
      await toBottom();
      return planBarBox();
    });
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
    const sideRow = async () => ((await slRow(t0.id)) || {}).dot || '';
    const tabAndRow = async () => union([await tab(title).boundingBox().catch(() => null), await rowBox(t0.id)]);
    await look('turn-running', {
      expect: 'While the turn of a message sent from the tab runs, the tab\'s Codex logo carries a solid green dot, and the conversation\'s row in Agent Plus\'s session list a solid green dot at the top right of its logo.',
      unchanged: 'The script turned the additions back on with Toggle after the step before, so the times, rail and toolbar controls are drawn again.',
    }, async () => {
      await showList();
      model.hold();
      const turns = model.turns();
      await type('How is the inventory sync retry delay configured?');
      if (!await until(() => model.turns() > turns, 20000, 300)) throw new Error('the message reached no model');
      await until(async () => { const d = await dotsOn(title); return d && d.working >= 6 && !d.ring; }, 20000, 500);
      await sleep(800);
      return tabAndRow();
    });
    await look('reply-unread', {
      expect: `With notes.txt in front when the reply lands, the conversation has stopped: its tab\'s Codex logo carries no dot and the tab\'s title reads "${title} 📩", the envelope once and last; `
        + 'its row in the session list has no dot and a small envelope icon after its title, and no envelope inside the title; Agent Plus\'s status bar does not count it, as a reply not read is left to its notification, '
        + `and a notification says "${title}" finished, with two buttons, Open and Dismiss, and no progress bar.`,
    }, async () => {
      await openNotes();
      await sleep(800);
      model.release();
      await until(async () => { const d = await dotsOn(title); return d && d.working === 0 && d.waiting === 0 && (await labelOf(title)) === `${title} ${ENVELOPE}`; }, 60000, 500);
      /* Agent Plus announces a conversation once it has stayed stopped with an unread reply for 5 seconds. */
      if (!await until(async () => (await toastLines()).some((l) => l.includes(`"${title}" finished`)), 20000, 500)) {
        tell(`no "finished" notification in 20 s; the window has the focus: ${await call('return vscode.window.state.focused;').catch((e) => String(e))}`);
      }
      await until(async () => ((await slRow(t0.id)) || {}).unread, 10000, 300);
      await sleep(1500);
      return union([await tabAndRow(), await part(PARTS.statusbar), await toastsBox()]);
    });
    await look('attention-list', {
      expect: 'A list at the top of the window of the conversations that need the user, with this conversation in it.',
    }, async () => {
      const bell = page.locator('.statusbar-item[id$="agentPlus.attention"]').first();
      if (await bell.isVisible().catch(() => false)) await bell.locator('.statusbar-item-label, a').first().click({ timeout: 5000 });
      else await start('agentPlus.showAttention');
      if (!await page.locator('.quick-input-widget').first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)) {
        const toastsNow = await toastLines();
        await start('agentPlus.showAttention');
        await page.locator('.quick-input-widget').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        throw new Error(`no list opened (notifications at the time: ${JSON.stringify(toastsNow)}); ran Agent Plus: Show the Conversations That Need You afterwards`);
      }
      await sleep(600);
      return union([await boxIn(null, '.quick-input-widget'), await part(PARTS.statusbar)]);
    });
    await page.keyboard.press('Escape');
    await until(() => page.locator('.quick-input-widget').first().isHidden(), 3000, 200);

    /* ═══ the unread envelope in the light themes (src/envelope.js) ═══ */
    const lightUnread = (theme) => ({
      expect: `In ${theme}, with the reply still unread, the tab's title ends in the envelope's text form ✉︎, an outline glyph in the theme's text colour rather than a white emoji, `
        + 'and the conversation\'s row in Agent Plus\'s Conversations panel at the bottom has one such envelope after the title, clearly visible on the light background. '
        + 'Its row in the session list on the left has its unread mark after the title.',
    });
    const inLight = (theme) => async () => {
      await setting('colorTheme', theme, 'workbench');
      if (!await until(async () => (await labelOf(title)) === `${title} \u2709\uFE0E`, 15000, 500)) throw new Error(`the tab read ${JSON.stringify(await labelOf(title))}`);
      await showList();
      await exec('agentPlus.showConversations');
      await away();
      await sleep(1500);
      return union([await tab(title).boundingBox().catch(() => null), await part(PARTS.sidebar), await part(PARTS.panel)]);
    };
    await look('unread-light-theme', lightUnread('Default Light Modern'), inLight('Default Light Modern'));
    await look('unread-high-contrast-light', lightUnread('Default High Contrast Light'), inLight('Default High Contrast Light'));
    await setting('colorTheme', 'Default Dark Modern', 'workbench');
    await exec('workbench.action.closePanel');
    await until(async () => (await labelOf(title)) === `${title} ${ENVELOPE}`, 15000, 500);

    /* ═══ renaming while the reply is unread ═══ */
    const renameBox = page.locator('.quick-input-widget input').first();
    const renameTo = async (name) => {
      await start('codexPlus.renameThread', t0.id);
      await renameBox.waitFor({ state: 'visible', timeout: 10000 });
      await renameBox.fill(name);
      await renameBox.press('Enter');
    };
    await look('rename-unread', {
      expect: `Rename on the conversation whose reply has not been seen opens a box at the top of the window holding "${title}", selected, without the envelope its tab shows.`,
    }, async () => {
      await start('codexPlus.renameThread', t0.id);
      await renameBox.waitFor({ state: 'visible', timeout: 10000 });
      await sleep(500);
      const offered = await renameBox.inputValue();
      if (offered !== title) throw new Error(`the box held ${JSON.stringify(offered)}`);
      return union([await boxIn(null, '.quick-input-widget'), await tab(title).boundingBox().catch(() => null)]);
    });
    const renamed = `${title} (renamed)`;
    const sideBefore = ((await part(PARTS.sidebar)) || {}).width || 0;
    await look('renamed-unread', {
      expect: `After "${renamed} 📩" is typed, the envelope at its end as if it had been left in, and Enter, the tab's title reads "${renamed} 📩": one envelope, last, still there because the reply has not been seen. `
        + `The conversation's row in Agent Plus's session list reads "${renamed}", with no envelope inside the title and its unread mark after it.`,
    }, async () => {
      await renameBox.fill(`${renamed} ${ENVELOPE}`);
      await renameBox.press('Enter');
      await showList();
      if (!await until(async () => (await labelOf(renamed)) === `${renamed} ${ENVELOPE}`, 20000, 500)) throw new Error(`the tab read ${JSON.stringify(await labelOf(renamed))}`);
      await until(async () => ((await slRow(t0.id)) || {}).title === renamed, 15000, 500);
      /* Widened so the whole new title fits in the picture. */
      await sideTo(760);
      await away();
      await sleep(800);
      return union([await tab(renamed).boundingBox().catch(() => null), await rowBox(t0.id)]);
    });
    const kept = `${title} (kept short)`;
    await look('rename-envelope-anywhere', {
      expect: `When the conversation is renamed to "📩 📩 ${title} 📩 (kept short)" while its reply is unread, the tab's title reads "${kept} 📩". `
        + `The conversation's row in Agent Plus's session list reads "${kept}", with no envelope inside the title and its unread mark after it.`,
    }, async () => {
      await renameTo(`${ENVELOPE} ${ENVELOPE} ${title} ${ENVELOPE} (kept short)`);
      if (!await until(async () => (await labelOf(kept)) === `${kept} ${ENVELOPE}`, 20000, 500)) throw new Error(`the tab read ${JSON.stringify(await labelOf(kept))}`);
      await showList();
      await until(async () => ((await slRow(t0.id)) || {}).title === kept, 15000, 500);
      /* At 420 px the editor has room for the whole title on its tab. */
      await sideTo(420);
      await away();
      await sleep(800);
      return union([await tab(kept).boundingBox().catch(() => null), await rowBox(t0.id)]);
    });
    await look('rename-unread-pencil', {
      expect: `The pencil on the conversation's row in Agent Plus's session list, while the reply is unread, turns the title into an edit field holding only "${kept}", with no envelope in it.`,
    }, async () => {
      await showList();
      await away();
      await row(t0.id).hover();
      await sleep(400);
      await row(t0.id).locator('.sl-act[data-act="rename"]').click({ timeout: 5000 });
      if (!await until(() => list.evaluate(() => !!document.querySelector('.sl-title.sl-editing')), 5000, 200)) throw new Error('the title was not put in an edit field');
      const editing = await list.evaluate(() => (document.querySelector('.sl-title.sl-editing') || {}).textContent || '');
      tell(`the edit field holds ${JSON.stringify(editing)}`);
      return rowBox(t0.id);
    });
    await page.keyboard.press('Escape');
    await until(() => list.evaluate(() => !document.querySelector('.sl-title.sl-editing')), 5000, 200);
    try {
      if (sideBefore) await sideTo(sideBefore);
      await renameTo(title);
      await until(async () => (await labelOf(title)) !== null, 20000, 500);
    } catch (e) { tell(`putting the title and the side bar back failed: ${(e && e.message) || e}`); }
    await look('reply-read', {
      expect: `Bringing the tab to the front takes the envelope off its title, which reads "${title}" again, and the unread mark off its row in the list; the stopped conversation has no dot on its logo or its row. The count goes off the bell, and the notification closes.`,
    }, async () => {
      await tab(title).click();
      await until(async () => { const d = await dotsOn(title); return d && d.waiting === 0 && d.working === 0 && (await labelOf(title)) === title; }, 20000, 500);
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
      await codex.evaluate((q) => { const b = [...document.querySelectorAll(q)].pop(); b.scrollIntoView({ block: 'center', container: 'nearest' }); }, hookBubble);
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
      expect: 'Above the last reply its time is followed, when Codex shows no "Worked for" of its own, by how long the turn took, and then its figures, as "14:02:11  3s · ctx 0% · gpt-6.1-sol medium".',
    }, async () => {
      await toBottom();
      return bottomBox(520);
    });
        /* This step waits for the turns above: the meter shows the window Codex recorded on the latest turn, and the
       made-up turns recorded theirs before codexPlus.contextWindow was set. */
    await look('context-meter-hover', {
      expect: 'Resting on the context meter shows a box with the context window it uses and where that figure came from, codexPlus.contextWindow for gpt-6.1-sol set to 600K '
        + '(a published window, which counts output, so the value Codex works with is smaller); also the tokens in use and free, where Codex compacts and how far away that is, '
        + 'the conversation\'s input, cached input, output and reasoning tokens, the model and effort, and a line "Work plan: injected ..." saying how much the plan added.',
    }, async () => {
      await away();
      await codex.locator('[data-codex-extras="meter"]').first().hover();
      if (!await until(() => codex.evaluate(() => { const b = document.querySelector('[data-codex-extras="context"]'); return b && getComputedStyle(b).display !== 'none'; }), 10000, 200)) throw new Error('the meter showed no hover');
      await sleep(600);
      tell(`the window Codex recorded on the conversation's latest turn: ${windowOf(t0.id)}`);
      return union([await inCodex('[data-codex-extras="context"]'), await toolbar()]);
    });
    await away();

    /* ═══ work left running after a turn ═══ */
    let leftRefused = '';
    await look('left-running-command', {
      expect: 'After a turn that started "sleep 30" in the background has ended, the tab\'s logo carries a hollow green ring rather than a solid dot, the conversation\'s row in the session list a green ring, and the row below the message box '
        + 'says at its right end that a command is still running.',
    }, async () => {
      model.script(t0.id, [{ call: 'exec_command', args: { cmd: 'sleep 30', yield_time_ms: 1000 } }, { reply: 'Started the job.' }]);
      await type('Start the background command and come back.');
      if (!await until(async () => model.left() === 0 && ((await dotsOn(title)) || {}).ring && (await sideRow()) === 'greenRing', 40000, 500)) {
        leftRefused = sandboxRefused(t0.id);
        if (leftRefused) throw notHere(`Codex's own sandbox could not start the command ("${leftRefused}"), so it ended at once and nothing was left running`);
        throw new Error('the conversation had no green ring after its turn');
      }
      await sleep(4000);
      return union([await tab(title).boundingBox(), await bottomBox(160)]);
    });
    await look('left-running-row-hover', {
      expect: 'The hover box of the conversation\'s row in Agent Plus\'s session list, under the row, ends with the line "A background command is still running", which Codex Plus gives it.',
    }, async () => {
      if (leftRefused) throw notHere(`the step before left nothing running, as Codex's own sandbox could not start its command ("${leftRefused}")`);
      await showList();
      await away();
      await row(t0.id).hover();
      await until(() => list.evaluate(() => { const h = document.querySelector('.sl-hover'); return h && !h.classList.contains('sl-hidden') && /still running/.test(h.textContent); }), 5000, 200);
      await sleep(500);
      return union([await rowBox(t0.id), await inList('.sl-hover:not(.sl-hidden)')]);
    });
    await away();
    await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 60000, 1000);
    model.script(null);

    const outside = (cmd) => ({ call: 'exec_command', args: { cmd, yield_time_ms: 1000, sandbox_permissions: 'require_escalated', justification: 'Start the job outside the sandbox.' } });
    const notices = model.sent('Codex Plus notice');
    await look('approval-waiting', {
      expect: 'A command asked to run outside the sandbox: Codex shows its approval card in place of the message box, asking whether to run "setsid sleep 40 ..." with its buttons; the tab\'s logo carries a red dot and the conversation\'s row in the session list the blue dot of a dialog waiting for the user.',
    }, async () => {
      model.script(t0.id, [outside('setsid sleep 40 >/dev/null 2>&1 < /dev/null &'), { reply: 'Started the job.' }]);
      await type('Start the detached job and come back.');
      if (!await until(card, 20000, 300)) throw new Error('Codex showed no approval card');
      await until(async () => ((await dotsOn(title)) || {}).waiting >= 6, 20000, 500);
      await until(async () => (await sideRow()) === 'blue', 10000, 300);
      await sleep(1500);
      return union([await tabAndRow(), await bottomBox(360)]);
    });
    await look('detached-running', {
      expect: 'Once approved and the turn has ended, the tab\'s logo carries the green ring, and the Agent map pill counts the detached command: "1 detached · 1 timer".',
    }, async () => {
      await approve();
      if (!await until(async () => model.left() === 0 && /\b1 detached\b/.test(await pillText()), 40000, 500)) throw new Error(`the pill read ${JSON.stringify(await pillText())}`);
      await sleep(1000);
      return union([await tab(title).boundingBox(), await toolbar()]);
    });
    await look('detached-agent-map', {
      expect: 'The Agent map has, between the conversation\'s own card and WAKE-UPS, a WORK LEFT RUNNING section with a count badge 1: a card titled "sleep 40" with a solid green '
        + 'dot, and under it "detached", its pid and when it started.',
    }, async () => { await openMap(); return mapBox(); });
    await closeMap();
    await look('detached-end-notice', {
      expect: 'Once "sleep 40" has ended, the conversation is sent a notice from Codex Plus that the detached command is no longer running and its exit code cannot be known; it shows at the bottom of the conversation '
        + 'folded to one dim line without a bubble, as a hook\'s prompt is, with Codex\'s reply after it, and the green ring is gone.',
    }, async () => {
      if (!await until(() => model.sent('Codex Plus notice') > notices, 90000, 1000)) throw new Error('no notice reached the model in 90 s');
      await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 30000, 1000);
      await sleep(1500);
      await toBottom();
      return bottomBox(520);
    });
    model.script(null);
    await look('detached-end-notice-off', {
      expect: 'In the Custom token mode with codexPlus.detachedEndNotices off, a second detached command, "setsid sleep 8", approved and left running, ends with no notice: '
        + 'the conversation ends with Codex\'s reply that it started the short job.',
    }, async () => {
      await setting('tokenMode', 'custom', 'agentPlus');
      await setting('detachedEndNotices', false);
      model.script(t0.id, [outside('setsid sleep 8 >/dev/null 2>&1 < /dev/null &'), { reply: 'Started the short job.' }]);
      await type('Start the short detached job and come back.');
      if (!await until(card, 20000, 300)) throw new Error('Codex showed no approval card');
      await approve();
      await until(() => model.left() === 0, 20000, 500);
      await sleep(45000);
      /* Every request quotes the notices sent before, so the check reads the rollout for a notice naming this command. */
      const told = lastUserText(t0.id, 'sleep 8');
      tell(told ? `a notice naming "sleep 8" was sent: ${told.slice(0, 200)}` : 'no message naming "sleep 8" was sent into the conversation while codexPlus.detachedEndNotices was off');
      await toBottom();
      return bottomBox(420);
    });
    await setting('detachedEndNotices', undefined);
    await setting('tokenMode', undefined, 'agentPlus');
    model.script(null);
    await look('subagent-agent-map', {
      expect: 'After a turn that started a sub-agent, the pill has a green dot and counts it ("1 agent"), and the Agent map has a SUB-AGENTS section with a count badge 1, right '
        + 'after the conversation\'s own card: a card with the sub-agent\'s name and a solid green dot (it is still running), and under them the time it was last active.',
    }, async () => {
      model.script(t0.id, [{ call: 'spawn_agent', namespace: 'collaboration', args: { task_name: 'job', message: 'Wait for the job.', fork_turns: 'none' } }, { reply: 'Started a helper.' }]);
      await type('Start a helper and come back.');
      if (!await until(async () => model.left() === 0 && /\bagent/.test(await pillText()), 40000, 500)) throw new Error(`the pill read ${JSON.stringify(await pillText())}`);
      await sleep(1000);
      await openMap();
      return mapBox();
    });
    await closeMap();
    model.releaseOthers();
    await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 60000, 1000);
    model.script(null);

    /* ═══ a background terminal and a codex exec left running ═══ */
    {
      const ext = fs.readdirSync(profile.exts).find((d) => d.startsWith('openai.chatgpt-'));
      const bin = ext && process.platform === 'linux' ? codexBinary(path.join(profile.exts, ext)) : '';
      await look('background-work-pill', {
        expect: 'After a turn that left a background terminal ("sleep 60") and a codex exec running, the Agent map pill in the message box\'s toolbar has a solid green dot and reads "1 agent · 1 terminal · 1 codex exec · 1 timer": the sub-agent of the step before, which has stopped, the two pieces of work, and the wake-up.',
      }, async () => {
        if (!bin) throw new Error('a codex exec is started only on Linux, with the Codex extension\'s own codex program');
        /* The made-up model answers the conversation's next request with the script, so the step waits until the
           conversation has sent none for a few seconds; otherwise a request the previous step left in flight would take
           the script's first call. */
        const asked = () => model.seen.filter((r) => r.thread === t0.id).length;
        let was = -1;
        await until(() => { const k = asked(); const still = k === was; was = k; return still; }, 30000, 3000);
        const from = asked();
        /* Both run outside the sandbox: in some runs a sandboxed exec_command never ran, or ended as soon as it started. */
        model.script(t0.id, [outside('sleep 60'), outside(`setsid nohup '${bin}' exec --skip-git-repo-check 'Wait for the job.' >/dev/null 2>&1 &`),
          { reply: 'Started the work.' }]);
        await type('Start the background work and come back.');
        for (const n of [1, 2]) {
          if (!await until(card, 20000, 300)) throw new Error(`Codex showed no approval card for command ${n}`);
          await approve();
        }
        const both = async () => { const t = await pillText(); return model.left() === 0 && /\bterminal\b/.test(t) && /codex exec/.test(t); };
        if (!await until(both, 40000, 500)) {
          const host = await call(`${OWN}
            const scan = own('left-running').scan({}), id = String(arg).toLowerCase();
            return { commands: own('patching').runningCommands(arg).map((c) => c.command.slice(0, 80)), kinds: scan.threads[id] || [],
              running: (scan.running || []).filter((r) => r.thread === id).map((r) => r.kind + ' ' + r.cmd.slice(0, 80)) };`, t0.id).catch((e) => String(e));
          throw new Error(`the pill read ${JSON.stringify(await pillText())}; the conversation sent ${asked() - from} requests in this step; `
            + `the host saw ${JSON.stringify(host)}`);
        }
        await sleep(1000);
        return toolbar();
      });
      const MAP_SECTIONS = 'From the top: THIS CONVERSATION, with no count and no line above it, over a card titled by the conversation, its dot the green ring the tab has '
        + 'while only work it started runs, and under the title the model and the tokens in context. Then SUB-AGENTS with a count badge 1: the sub-agent\'s card, '
        + 'which has stopped and so has an empty space where its dot was, its name still lined up with where the dot would be, an envelope after its name for the reply '
        + 'it finished with, and "active ... ago" under it. Then WORK LEFT RUNNING 2: a card of a background terminal running "sleep 60" and one of a codex exec, each '
        + 'titled by its command line with a solid green dot, and under it "background terminal" or "codex exec", the pid when the scan found its process (one only this '
        + 'window\'s Codex reports has none) and when it started. Then WAKE-UPS 1: a card of the wake-up\'s prompt, "Check whether the nightly export has finished.", '
        + 'with a grey dot and a small arrow at its right, "every 45 min" and the next and last times under it, and a Remove button below the card. Then GOAL 1: a card '
        + 'of "Make the nightly export include archived rows" with a grey dot, "paused" and its tokens under it, and Resume and Clear buttons below. Each heading is in '
        + 'capitals, smaller and bolder than the cards, with a thin line across the dialog above it; every card is the same width, with a 1 px border and rounded corners.';
      await look('background-work-agent-map', {
        expect: `The Agent map in the dark theme. ${MAP_SECTIONS}`,
      }, async () => {
        /* Also a paused goal, which starts no turn: the map then has every section at once. */
        const r = await hostRequest('thread/goal/set', { threadId: t0.id, objective: 'Make the nightly export include archived rows', status: 'paused', origin: 'user' });
        if (r && r.error) throw new Error(`thread/goal/set: ${JSON.stringify(r.error)}`);
        if (!await until(async () => /goal/.test(await pillText()), 15000, 500)) tell(`the pill read ${JSON.stringify(await pillText())} with the goal set`);
        await openMap();
        return mapBox();
      });
      await look('agent-map-light', {
        expect: `The same Agent map in the Default Light Modern theme: the headings, their count badges, the thin lines above them and the cards are all readable against the light background, and the dots are visible. ${MAP_SECTIONS}`,
        unchanged: 'The conversation behind the map is the same, now in the light theme.',
      }, async () => {
        await closeMap();
        await setting('colorTheme', 'Default Light Modern', 'workbench');
        await sleep(2500);
        await openMap();
        return mapBox();
      });
      await closeMap();
      await look('plan-bar-light', {
        expect: 'The plan bar above the message box in the Default Light Modern theme, as wide as the box: "Plan" in bold, one purple-tinted bubble with a purple '
          + 'circle and 1, for the row to do, then empty space, and at the right the solid orange pill with a question mark and "1 to decide" in dark letters, and an '
          + 'arrow. Its background and border are the light theme\'s input colours, and every part is readable.',
        unchanged: 'The first row of the plan is done by now, so it has no bubble.',
      }, async () => {
        if (!await until(async () => (await barBubbles()) === 'todo 1', 20000, 500)) {
          tell('the plan bar did not show just a bubble of 1 to do within 20 s');
        }
        return planBarBox();
      });
      await setting('colorTheme', 'Default Dark Modern', 'workbench');
      await sleep(2000);
      await hostRequest('thread/goal/clear', { threadId: t0.id, origin: 'user' }).catch(() => null);
      model.releaseOthers();
      await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 90000, 1000);
      model.script(null);
    }

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
          if (web && s) { web.scrollIntoView({ block: 'end', container: 'nearest' }); s.scrollBy(0, 60); }
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

    /* ═══ links to other conversations in a reply ═══ */
    {
      /* Three ways a reply can name the conversation t1. */
      const reply = `That was 「${t1.title}」, whose thread ${t1.id} has the details.\n\nNext time, open ${t1.title} first.`;
      const links = () => codex.evaluate(() => document.querySelectorAll('[data-codex-extras="convo-link"]').length).catch(() => 0);
      await look('conversation-links', {
        expect: 'A reply that names the conversation "' + t1.title + '" three ways, each drawn in the theme\'s link colour: its title in corner brackets, its thread id, and its whole title on its own '
          + 'in the second paragraph. The corner brackets and the rest of the sentences are in the reply\'s own colour. The pointer rests on the first link, and a label beside it gives that '
          + 'conversation\'s title, "Codex conversation" with the first 8 characters of its id, and when it was last active.',
      }, async () => {
        model.script(t0.id, [{ reply }]);
        await type('Which conversations were those?');
        if (!await until(async () => { await toBottom(); return (await links()) >= 3; }, 45000, 500)) throw new Error(`only ${await links()} of the 3 links were drawn`);
        await codex.locator('[data-codex-extras="convo-link"]').first().hover();
        await sleep(800);
        return bottomBox(420);
      });
      model.script(null);
    }

    /* ═══ a wake-up ═══ */
    await look('wake-ups-off', {
      expect: 'In the Custom token mode with codexPlus.wakeUps off, a wake-up that falls due is not sent: a minute and a half later the conversation still ends '
        + 'with no message beginning "[Wake-up set in this conversation".',
    }, async () => {
      await setting('tokenMode', 'custom', 'agentPlus');
      await setting('wakeUps', false);
      const before = model.sent(WAKEUP_LINE);
      setWakeup(1, 120);
      await sleep(90000);
      tell(`wake-ups that reached the model while codexPlus.wakeUps was off: ${model.sent(WAKEUP_LINE) - before}`);
      setWakeup(45);
      await toBottom();
      return bottomBox(420);
    });
    await setting('wakeUps', undefined);
    await setting('tokenMode', undefined, 'agentPlus');
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
    await look('low-context-outline-off', {
      expect: 'With codexPlus.lowContextOutline off, the meter still reads about 86% but has no outline round it.',
    }, async () => {
      await setting('lowContextOutline', false);
      if (!await until(() => codex.evaluate(() => !document.querySelector('.codex-extras-ctx-low')), 10000, 300)) throw new Error('the outline stayed');
      await sleep(500);
      return toolbar();
    });
    await setting('lowContextOutline', undefined);
    await until(() => codex.evaluate(() => !!document.querySelector('.codex-extras-ctx-low')), 10000, 300);
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
    /* The goal badge on the conversation's row (GOAL_WORD in src/session-list-source.js), '' for none. */
    const goalOf = async () => ((await slRow(t0.id)) || { badges: [] }).badges.find((b) => /^goal/.test(b)) || '';
    await look('goal-paused', {
      expect: 'With a paused goal set on the conversation, its row in Agent Plus\'s session list shows a dimmed "goal paused" badge after the title, and its menu offers Codex\'s own "Resume Goal" and "Clear Goal".',
    }, async () => {
      const r = await hostRequest('thread/goal/set', { threadId: t0.id, objective: 'Make the nightly export include archived rows', status: 'paused', origin: 'user' });
      if (r && r.error) throw new Error(`thread/goal/set: ${JSON.stringify(r.error)}`);
      await showList();
      if (!await until(async () => (await goalOf()) === 'goal paused', 30000, 500)) throw new Error(`the row's goal badge is ${JSON.stringify(await goalOf())}`);
      await menuOn(row(t0.id));
      return union([await rowBox(t0.id), await menuBox()]);
    });
    await look('goal-active', {
      expect: 'Resume Goal sets it going: the row\'s badge reads "goal", its dot turns green as Codex starts a turn for the goal, and the Agent map pill names the goal.',
    }, async () => {
      model.hold();
      await ctxItem('Resume Goal').click({ timeout: 5000 });
      if (!await until(async () => (await goalOf()) === 'goal', 30000, 500)) throw new Error(`the row's goal badge is ${JSON.stringify(await goalOf())}`);
      await sleep(2000);
      return union([await rowBox(t0.id), await tab(title).boundingBox(), await toolbar()]);
    });
    await pick(row(t0.id), ['Pause Goal']).catch((e) => note(`Pause Goal: ${e.message}`));
    model.release();
    await until(async () => !(((await dotsOn(title)) || {}).working >= 6), 60000, 1000);
    await look('goal-cleared', {
      expect: 'After Pause Goal and then Clear Goal the row shows no goal badge, and the Agent map pill no longer names a goal.',
    }, async () => {
      await pick(row(t0.id), ['Clear Goal']);
      if (!await until(async () => (await goalOf()) === '', 30000, 500)) throw new Error(`the row's goal badge is ${JSON.stringify(await goalOf())}`);
      await sleep(1000);
      return union([await rowBox(t0.id), await toolbar()]);
    });

    /* ═══ tabs ═══ */
    const vsMenu = () => page.evaluate(() => { const m = [...document.querySelectorAll('.context-view .monaco-menu')].find((e) => e.offsetParent); return m ? m.innerText : ''; });
    await look('tab-context-menu', {
      expect: 'A right-click on the conversation, on its tab or else inside its page, opens a VS Code menu holding "Codex Plus: Mark as Unread" and "Codex Plus: Rename".',
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
    /* ═══ a closed conversation reopened ═══ */
    if (freshTitle) {
      await tab(freshTitle).click();
      await exec('workbench.action.closeActiveEditor');
      await sleep(1000);
    }
    await look('reopen-closed-shortcut', {
      expect: `With the tab of "${freshTitle || 'the conversation started from the tab bar'}" closed, Ctrl+Shift+T with the editor focused, which Agent Plus's session list takes while it is on, `
        + 'reopens that conversation in a tab, in front, showing its message and reply.',
    }, async () => {
      if (!freshTitle) throw new Error('the conversation started from the tab bar has no title');
      await tab(title).click();
      await sleep(500);
      const at = Date.now();
      await page.keyboard.press('Control+Shift+T');
      if (!await until(async () => { const t = await frontTab(); return t && t.label === freshTitle; }, 20000, 500)) throw new Error(`the tab in front is ${JSON.stringify(await frontTab())}`);
      /* A reopened tab is a new page, which Codex 26.1117 takes some seconds to draw the conversation in. */
      const drawn = await frameWhere((want) => document.querySelectorAll('[data-turn-key]').length > 0 && innerWidth > 600
        && document.body.innerText.includes(want.message) && document.body.innerText.includes(want.reply), 60000, { message: 'Draft the release notes for 1.2.', reply: 'Done. The cap is configurable.' });
      tell(drawn ? `the reopened page drew the conversation ${((Date.now() - at) / 1000).toFixed(1)} s after the shortcut` : 'the reopened page drew no conversation within 60 s of the shortcut');
      await sleep(1500);
      return union([await tabsBox(), await part(PARTS.editor)]);
    });
    await look('reopen-shortcut-off', {
      expect: `With codexPlus.reopenClosedSessionShortcut off and "${freshTitle}" closed again, Ctrl+Shift+T is still Agent Plus's session list's, since the list is on: `
        + 'it reopens that conversation in a tab, in front, as in the step before.',
    }, async () => {
      await setting('reopenClosedSessionShortcut', false);
      await tab(freshTitle).click();
      await exec('workbench.action.closeActiveEditor');
      await sleep(1000);
      await tab(title).click();
      await sleep(500);
      const before = await tabs();
      await page.keyboard.press('Control+Shift+T');
      await sleep(5000);
      const t = await frontTab();
      tell(`the tab in front after the shortcut: ${JSON.stringify(t)}; tabs before: ${JSON.stringify(before).slice(0, 300)}`);
      return union([await tabsBox(), await part(PARTS.editor)]);
    });
    await setting('reopenClosedSessionShortcut', undefined);

    /* ═══ Agent Plus ═══ */
    await look('work-plan-view', {
      expect: 'Agent Plus\'s Work plan view, in its own side bar, shows the plan of the Codex conversation in front: "Find the retry delay" done, "Decide the default delay" waiting, with how long it has waited, and "Update the docs" to do. '
        + 'A row shows only its title and times. Resting on the waiting row shows a hover box with its title, "waiting on you" and its question "Should the default retry delay stay at 30 seconds, or go up to 60?".',
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
      /* Rows show only titles and times. The question appears in the row's hover, and in the Conversations and Answer
         views of the next steps. */
      await away();
      await page.locator('[id="workbench.parts.sidebar"] .monaco-list-row').filter({ hasText: 'Decide the default delay' }).first().hover();
      const asked = () => page.evaluate(() => !![...document.querySelectorAll('.monaco-hover, .workbench-hover')].find((e) => e.offsetParent && /Question:/.test(e.innerText)));
      if (!await until(asked, 8000, 300)) tell('resting on the waiting row showed no hover with its question within 8 s');
      await sleep(400);
      return union([await part(PARTS.sidebar), await boxIn(null, '.monaco-hover, .workbench-hover')]);
    });
    await away();
    const panelRow = (text) => page.locator('[id="workbench.parts.panel"] .monaco-list-row').filter({ hasText: text }).first();
    await look('conversations-view', {
      expect: 'Agent Plus\'s Conversations view in the panel lists the Codex conversations of this workspace, with no agent logo since only one agent is installed; this one shows its question "Should the default retry delay stay at 30 seconds, or go up to 60?" waiting for the user, '
        + 'and the status bar has "1 conversation needs you".',
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
      /* Codex may draw a line break in a user message as a space, so the text it recorded is logged, escaped. */
      tell(`the answer as Codex recorded it: ${JSON.stringify(lastUserText(t0.id, 'My answer to row'))}`);
      await sleep(1500);
      await toBottom();
      /* The close view starts at the user message the answer became, whatever the height of the reply below it. */
      const fb = await (await codex.frameElement()).boundingBox();
      const sent = fb && await codex.evaluate(() => {
        const b = [...document.querySelectorAll('[data-user-message-bubble]')].filter((e) => /Keep it at 30 seconds/.test(e.innerText)).pop();
        const r = b && b.getBoundingClientRect();
        return r && r.height ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
      }).catch(() => null);
      if (!sent) tell('the message the answer became was not found in the page, so the close view may not show it');
      const asked = sent && { x: fb.x, y: Math.max(fb.y, fb.y + sent.y - 24), width: fb.width, height: sent.height + 24 };
      return union([await part(PARTS.panel), await bottomBox(300), asked]);
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
    await look('opened-in-sidebar', {
      expect: 'Open in Sidebar, in the menu of the row "Why does the nightly export skip archived rows?" in Agent Plus\'s session list, with notes.txt the tab in front, shows that conversation in Codex\'s sidebar on the right, '
        + 'with a time on each message and reply, each inside its column; in the list its row has a solid stripe at its start, as open in this window, and is drawn as the current conversation, with no other row drawn so.',
    }, async () => {
      await openNotes();
      await toList();
      await pick(row(t1.id), ['Open in Sidebar']);
      await allowUri();
      const side = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want) && document.querySelectorAll('.codex-extras-stamp-assistant').length >= 4, 90000, t1.title);
      if (!side) throw new Error('the conversation did not show in Codex\'s sidebar');
      await sleep(1500);
      return union([await part(PARTS.auxiliary), await part(PARTS.sidebar)]);
    });
    /* The same conversation's message box, with Codex's sidebar too narrow for Codex Plus's controls to fit in Codex's
       toolbar row. */
    {
      let auxBefore = 0;
      await look('sidebar-narrow-box', {
        expect: 'Codex\'s sidebar on the right, dragged to about 280 px wide, showing the bottom of "Why does the nightly export skip archived rows?": its message box. '
          + 'Inside the box\'s rounded border, below Codex\'s own row of buttons (the + button, the hand, the model picker with its name or its icon, the send button and the others Codex shows), '
          + 'a line of its own holds Codex Plus\'s information button (i) and note button (♪) at its left and the context ring with its percentage at its right, '
          + 'drawn in the same size and colour as Codex\'s own buttons. None of them is outside the box\'s border or below it against the window\'s edge, '
          + 'none covers or touches one of Codex\'s buttons, and none is cut off at the box\'s edge.',
        unchanged: 'The sidebar shows the same conversation as before, at about 280 px.',
      }, async () => {
        auxBefore = await auxTo(280);
        const side = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want) && !!document.querySelector('[data-codex-composer-root]'), 30000, t1.title.slice(0, 30));
        if (!side) throw new Error('Codex\'s sidebar no longer shows the conversation');
        const placed = await until(() => side.evaluate(() => (document.querySelector('[data-codex-extras="line"]') ? 'line'
          : document.querySelector('[data-codex-extras="bar"]') ? 'bar' : '')).catch(() => ''), 15000, 300);
        if (placed !== 'line') tell(`at about 280 px Codex Plus's controls are ${placed === 'bar' ? 'in the row below the message box' : 'not in a line of their own'}`);
        await sleep(800);
        const box = await boxIn(side, '[data-codex-composer-root]'), ab = await part(PARTS.auxiliary);
        if (!box || !ab) return ab;
        const top = Math.max(ab.y, box.y - 30);
        return { x: ab.x, y: top, width: ab.width, height: Math.min(ab.y + ab.height, box.y + box.height + 30) - top };
      });
      if (auxBefore) await auxTo(auxBefore);
    }
    /* The same conversation's Agent map in Codex's narrow sidebar: a paused goal and a wake-up of its own give
       it a pill and two sections. */
    {
      const wake1 = path.join(plans, `${t1.id}.wakeup`);
      await look('agent-map-sidebar', {
        expect: 'In Codex\'s narrow sidebar on the right, the Agent map of "Why does the nightly export skip archived rows?", opened from the pill by its message box: '
          + 'THIS CONVERSATION over a card with the conversation\'s title (cut short with an ellipsis if the sidebar is too narrow), with the model and tokens in context under it. '
          + 'Below it, WAKE-UPS 1: a card of "Look at the export logs again." over "every 30 min" and its times, with a Remove button. Then GOAL 1: a card of '
          + '"Find out why archived rows are skipped" over "paused" and its tokens, with Resume and Clear. The dialog fits inside the sidebar; the cards are no wider than '
          + 'it, and a second line too long for it ends in an ellipsis; the headings, badges and lines are as in the editor tab.',
      }, async () => {
        const w0 = JSON.parse(fs.readFileSync(wakeupFile, 'utf8'));
        const at = Math.floor(Date.now() / 1000);
        fs.writeFileSync(wake1, JSON.stringify({ ...w0, thread: t1.id, everyMinutes: 30, prompt: 'Look at the export logs again.', setAt: at, expiresAt: at + 7 * 86400 }));
        const r = await hostRequest('thread/goal/set', { threadId: t1.id, objective: 'Find out why archived rows are skipped', status: 'paused', origin: 'user' });
        if (r && r.error) throw new Error(`thread/goal/set: ${JSON.stringify(r.error)}`);
        const side = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want) && !!document.querySelector('[data-codex-composer-root]'), 30000, t1.title.slice(0, 30));
        if (!side) throw new Error('Codex\'s sidebar no longer shows the conversation');
        const sidePill = () => side.evaluate(() => ((document.querySelector('[data-codex-extras="agents"]') || {}).textContent || '')).catch(() => '');
        if (!await until(async () => /timer/.test(await sidePill()) && /goal/.test(await sidePill()), 30000, 500)) throw new Error(`the sidebar's pill read ${JSON.stringify(await sidePill())}`);
        await side.locator('[data-codex-extras="agents"]').first().click();
        if (!await until(() => side.evaluate(() => !!document.querySelector('[data-codex-extras="map-dialog"]')), 5000, 200)) throw new Error('the Agent map did not open in the sidebar');
        await still(side.locator('[data-codex-extras="map-dialog"]').first());
        return part(PARTS.auxiliary);
      });
      await page.keyboard.press('Escape');
      await hostRequest('thread/goal/clear', { threadId: t1.id, origin: 'user' }).catch(() => null);
      try { fs.unlinkSync(wake1); } catch (_) { /* never written */ }
      const plan1 = path.join(plans, `${t1.id}.json`);
      await look('plan-bar-sidebar', {
        expect: 'In Codex\'s sidebar on the right, which is narrow, the plan bar of "Why does the nightly export skip archived rows?" just above its message box and as '
          + 'wide as it, in its compact form: the list icon with no "Plan" after it, a blue-tinted bubble with a play icon and 1, a purple-tinted bubble with a circle and 1, '
          + 'then empty space and, at the right end, a solid orange pill with a question mark and just "1". No arrow. It fits inside the sidebar and covers nothing of '
          + 'the conversation or of the message box.',
      }, async () => {
        fs.writeFileSync(plan1, JSON.stringify({ nodes: [{ title: 'Look at the export logs', state: 'doing', since: iso() },
          { title: 'Choose what to log', state: 'waiting', waitingOn: 'user', question: 'Log every skipped row, or a count?', asked: iso(), since: iso() },
          { title: 'Fix the archive filter', state: 'todo', since: iso() }] }));
        const side = await frameWhere((want) => innerWidth < 800 && document.body.innerText.includes(want) && !!document.querySelector('[data-codex-composer-root]'), 30000, t1.title.slice(0, 30));
        if (!side) throw new Error('Codex\'s sidebar no longer shows the conversation');
        const drawn = await until(() => side.evaluate(() => {
          const b = document.querySelector('[data-codex-extras="plan-bar"]');
          const bubbles = b ? [...b.querySelectorAll('.apb-b')].map((x) => x.getAttribute('data-state') + ' ' + x.textContent.trim()).join() : '';
          return bubbles === 'doing 1,todo 1' && { compact: b.getAttribute('data-compact') === '1', page: innerWidth };
        }), 20000, 500);
        if (!drawn) tell('the sidebar\'s plan bar did not show a bubble of 1 doing and one of 1 to do within 20 s');
        else if (!drawn.compact) tell(`the sidebar's page is ${drawn.page} px wide, so its plan bar is the full one`);
        /* The pointer rests where the step before clicked the Agent map pill; with the pill gone or shorter now, the meter
           next to it can have moved under the pointer and opened its hover box. It is moved first to an empty spot near the
           top of the sidebar's page, so the page sees it leave whatever it was over, and then in one move onto the editor
           beside it. A pointer that leaves the page on its way across can leave a hover box or a tooltip open there. */
        const bar = await part(PARTS.auxiliary);
        if (bar) {
          await page.mouse.move(bar.x + 24, bar.y + 115, { steps: 4 });
          await sleep(400);
          await page.mouse.move(Math.max(3, bar.x - 200), bar.y + 300);
          await sleep(800);
        }
        return union([await planBarBox(side), await part(PARTS.auxiliary)]);
      });
      try { fs.unlinkSync(plan1); } catch (_) { /* never written */ }
    }
    await exec('workbench.action.closeAuxiliaryBar');

    /* ═══ archived while its tab is open ═══ */
    const shelvedOnDisk = () => { try { return fs.readdirSync(path.join(profile.codexHome, 'archived_sessions'), { recursive: true }).some((n) => String(n).includes(t0.id)); } catch (_) { return false; } };
    await look('archived-while-open', {
      expect: 'Archived in Codex while its tab is open, as Codex\'s own Archive does, the conversation stays in the tab with all its turns, read-only, with no message box, and no "!" or warning from Codex Plus on the page.',
    }, async () => {
      await tab(title).click();
      const r = await hostRequest('thread/archive', { threadId: t0.id });
      if (!await until(shelvedOnDisk, 30000, 500)) throw new Error(`the rollout did not move to archived_sessions/: ${JSON.stringify(r).slice(0, 200)}`);
      await until(() => codex.evaluate(() => document.querySelectorAll('[data-turn-key]').length > 0 && !document.querySelector('[data-codex-composer-root]')).catch(() => false), 30000, 500);
      await sleep(1500);
      return part(PARTS.editor);
    });
    await look('unarchived-on-open', {
      expect: 'Codex Plus\'s Open in Tab, which Agent Plus\'s session list runs for a conversation not open in the window, unarchives it: the tab, in front, has its message box at the bottom again.',
    }, async () => {
      await exec('codexPlus.openThreadInTab', t0.id);
      if (!await until(() => !shelvedOnDisk(), 30000, 500)) throw new Error('the conversation was not unarchived');
      await until(() => codex.evaluate(() => !!document.querySelector('[data-codex-composer-root]')).catch(() => false), 30000, 500);
      await sleep(1500);
      return part(PARTS.editor);
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
