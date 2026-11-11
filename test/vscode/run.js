// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/vscode/run.js <Codex Plus .vsix> [<Agent Plus .vsix>] [--out <dir>] [--vscode <executable>] [--local]
 *
 * Downloads the newest stable VS Code (unless --vscode names one), installs the newest Codex, Agent Plus and the .vsix
 * into a profile of its own, and runs two stages against that install: ui.js, which drives the window and checks what
 * is drawn, and ./suite inside VS Code, which checks the patched files and the plugin. Exits non-zero if either fails. Screenshots, crops, diffs and VS Code's logs go to --out (by default
 * a folder in the temporary root it makes).
 *
 * HOME (USERPROFILE on Windows), CODEX_HOME, VS Code's user data and extensions folders all point into a new folder
 * under RUNNER_TEMP or the system's temporary folder, kept short because Codex listens on a Unix socket under CODEX_HOME. It still refuses to run outside CI unless --local
 * is given, as Claude Code Plus's runner does.
 *
 * After the downloads the test stage runs again as a child of this script. On Linux that child is put in a network
 * namespace with loopback only (unshare -rn, then as-user.py to run as the caller rather than as root); when that is not
 * possible the run says so, and fails if CODEX_PLUS_UI_OFFLINE=require. The child's processes are also given a proxy
 * that does not exist, which on macOS and Windows is the only thing between them and the network.
 *
 * Needs @vscode/test-electron and playwright-core, which the workflow installs; on Linux a display (xvfb-run).
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return ''; const v = args[i + 1] || ''; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const NO_PROXY_TO = 'http://127.0.0.1:9';

/* The environment for VS Code and everything it starts. It drops the variables a VS Code that runs this script sets
   (ELECTRON_RUN_AS_NODE would start VS Code as plain Node, and VSCODE_IPC_HOOK_CLI would send an install to that other
   VS Code) and LD_LIBRARY_PATH (VS Code brings its own libraries), and puts HOME and CODEX_HOME in the temporary root. */
function cleanEnv(root, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/.test(k) || k === 'LD_LIBRARY_PATH') delete env[k];
  const home = path.join(root, 'home');
  Object.assign(env, { HOME: home, CODEX_HOME: path.join(root, 'c') }, extra);
  if (process.platform === 'win32') Object.assign(env, { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
  if (process.platform === 'linux') Object.assign(env, { XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share') });
  return env;
}

function profileOf(root) {
  return { exts: path.join(root, 'exts'), user: path.join(root, 'user'), folder: path.join(root, 'ws'), control: path.join(root, 'ctl'),
    codexHome: path.join(root, 'c'), home: path.join(root, 'home') };
}

/* The VS Code command line tool beside `exe`, as @vscode/test-electron finds it; a .cmd on Windows, run through a shell. */
function cli(te, exe) {
  const tool = te.resolveCliArgsFromVSCodeExecutablePath(exe, { reuseMachineInstall: true })[0];
  return (argv, env) => {
    const shell = process.platform === 'win32';
    const r = cp.spawnSync(shell ? `"${tool}"` : tool, shell ? argv.map((a) => `"${a}"`) : argv, { env, encoding: 'utf8', shell, maxBuffer: 64 << 20 });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
}

/* How to run `argv` with no network but loopback on this machine, or null with the reason. */
function offlineWrapper(argv) {
  if (process.platform !== 'linux') return { why: `${process.platform} has no unprivileged network namespace` };
  const ip = ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'].find((p) => fs.existsSync(p));
  if (!ip) return { why: 'there is no ip program to bring loopback up with' };
  const wrap = (rest) => ['unshare', ['-rn', 'sh', '-c', `${ip} link set lo up && exec python3 "$0" "$@"`, path.join(HERE, 'as-user.py'),
    String(process.getuid()), String(process.getgid()), ...rest]];
  const [p, a] = wrap(['true']);
  const probe = cp.spawnSync(p, a, { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return { why: `unshare -rn with as-user.py failed: ${((probe.error && probe.error.message) || probe.stderr || '').trim().slice(0, 300)}` };
  const [prog, full] = wrap(argv);
  return { prog, args: full };
}

async function fetchStage() {
  const vsix = path.resolve(args[0] || '');
  if (!args[0] || !fs.existsSync(vsix)) throw new Error('usage: node test/vscode/run.js <Codex Plus .vsix> [<Agent Plus .vsix>] [--out <dir>] [--vscode <exe>] [--local]');
  const core = args[1] ? path.resolve(args[1]) : 'xnervwang.agent-plus';
  if (args[1] && !fs.existsSync(core)) throw new Error(`no Agent Plus .vsix at ${core}`);
  const te = require('@vscode/test-electron');
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'cxp-'));
  const out = path.resolve(OUT || path.join(root, 'out'));
  const p = profileOf(root);
  for (const d of [p.exts, p.user, p.folder, p.control, p.codexHome, p.home, out]) fs.mkdirSync(d, { recursive: true });
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    const d = cleanEnv(root)[k];
    if (d && d.startsWith(p.home)) fs.mkdirSync(d, { recursive: true });
  }
  console.log(`temporary root ${root}; results in ${out}`);

  const exe = VSCODE ? path.resolve(VSCODE) : await te.downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(root, 'vscode') });
  const code = cli(te, exe);
  const env = cleanEnv(root);
  const profile = [`--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`];
  for (const ext of ['openai.chatgpt', core, vsix]) {
    const r = code(['--install-extension', ext, ...profile], env);
    console.log(r.out.split('\n').filter((l) => !/DeprecationWarning|trace-deprecation/.test(l)).join('\n'));
    if (r.status !== 0) throw new Error(`installing ${ext} failed (${r.status})`);
  }
  const listed = code(['--list-extensions', '--show-versions', ...profile], env);
  console.log('installed:\n' + listed.out);

  const argv = [process.execPath, __filename, '--stage', 'test', '--root', root, '--exe', exe, '--out', out];
  const off = offlineWrapper(argv);
  let prog = process.execPath, rest = argv.slice(1), offline = 'namespace';
  if (off.prog) { prog = off.prog; rest = off.args; } else {
    offline = 'proxy';
    if (process.env.CODEX_PLUS_UI_OFFLINE === 'require') throw new Error(`the test stage could not be cut off from the network: ${off.why}`);
    console.log(`note  the test stage runs with the network on, behind a proxy that does not exist only: ${off.why}`);
  }
  const child = cp.spawnSync(prog, rest, { stdio: 'inherit', env: { ...process.env, CODEX_PLUS_UI_OFFLINE_HOW: offline } });
  process.exitCode = child.status === 0 ? 0 : 1;
  /* On a machine of someone's own the root is removed once the results are somewhere else; a CI runner is thrown away. */
  if (!out.startsWith(root + path.sep) && process.env.CI !== 'true' && !process.env.CODEX_PLUS_UI_KEEP) fs.rmSync(root, { recursive: true, force: true });
}

/* ── the test stage, in the child ── */
async function testStage() {
  const root = flag('--root'), exe = flag('--exe'), out = OUT;
  const p = profileOf(root);
  const te = require('@vscode/test-electron');
  const playwright = require('playwright-core');
  const fakeModel = require('./lib/fake-model');
  const fakeHome = require('./lib/fake-home');
  const proxy = { HTTP_PROXY: NO_PROXY_TO, HTTPS_PROXY: NO_PROXY_TO, ALL_PROXY: NO_PROXY_TO, http_proxy: NO_PROXY_TO, https_proxy: NO_PROXY_TO,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const env = cleanEnv(root, proxy);
  /* The suite's VS Code is started by @vscode/test-electron with this process's own environment. */
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);

  let failed = 0, passed = 0, notes = 0;
  const check = (cond, what, detail) => {
    if (cond) { passed++; console.log(`  ok    ${what}`); return true; }
    failed++;
    console.log(`  FAIL  ${what}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    return false;
  };
  const note = (what) => { notes++; console.log(`  note  ${what}`); };
  console.log(`\nthe test stage: network ${process.env.CODEX_PLUS_UI_OFFLINE_HOW === 'namespace' ? 'cut off but for loopback' : 'behind a proxy that does not exist'}`);

  const model = await fakeModel.start();
  const made = fakeHome.write(p.codexHome, { folder: p.folder, modelUrl: model.url });
  fakeHome.wakeup(p.codexHome, made.threads[0].id);
  fs.writeFileSync(path.join(p.folder, 'notes.txt'), 'A file to have an editor open, so the tab bar has its buttons.\n');
  fs.mkdirSync(path.join(p.user, 'User'), { recursive: true });
  fs.writeFileSync(path.join(p.user, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    'workbench.startupEditor': 'none', 'workbench.tips.enabled': false, 'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none',
    'workbench.colorTheme': 'Default Dark Modern', 'chat.disableAIFeatures': true, 'git.enabled': false,
    'http.proxy': NO_PROXY_TO, 'http.proxySupport': 'override', 'http.noProxy': ['127.0.0.1', 'localhost'],
    /* On macOS and Windows the window opens at VS Code's default 1024 px, and a tab bar that narrow can scroll the dot
       on a Codex tab's logo out of view. */
    'workbench.editor.wrapTabs': true,
    /* Agent Plus would otherwise offer to edit VS Code's own files, which are what is under test here. */
    'agentPlus.webviewRequestLimit': 'leave',
    /* Draw modal dialogs, such as Delete's confirmation, inside the window so Playwright can read them and click their
       buttons. VS Code's default is the system dialog on every platform. */
    'window.dialogStyle': 'custom',
  }, null, 2));

  try {
    await require('./ui').run({ exe, profile: p, env, playwright, model, threads: made.threads, out, check, note });
  } catch (e) {
    check(false, 'the window stage ran to its end', (e && e.stack) || String(e));
  }
  await model.close();

  console.log('\n── inside VS Code');
  try {
    await te.runTests({ vscodeExecutablePath: exe, extensionDevelopmentPath: path.join(HERE, 'suite'), extensionTestsPath: path.join(HERE, 'suite', 'index.js'),
      launchArgs: [p.folder, `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`, ...require('./lib/window').SECRETS] });
    check(true, 'the suite inside VS Code passed');
  } catch (e) {
    check(false, 'the suite inside VS Code passed', e.message);
  }

  keepLogs(p.user, path.join(out, 'logs'));
  console.log(`\nVS Code window: ${passed} passed, ${failed} failed, ${notes} notes; screenshots in ${path.join(out, 'shots')}`);
  process.exitCode = failed ? 1 : 0;
}

/* VS Code's logs of every window this run opened, for the artifact; this extension's own log printed too. */
function keepLogs(user, to) {
  const from = path.join(user, 'logs');
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive: true });
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((n) => (n.isDirectory() ? walk(path.join(d, n.name)) : [path.join(d, n.name)]));
  for (const f of walk(to).filter((f) => /Codex Plus\.log$/.test(f))) {
    console.log(`\n--- ${path.relative(to, f)}`);
    console.log(fs.readFileSync(f, 'utf8'));
  }
}

const STAGE = flag('--stage');
const OUT = flag('--out');
const VSCODE = flag('--vscode');
const LOCAL = has('--local');
(async () => {
  if (STAGE === 'test') return testStage();
  /* Every home is a temporary one, but on someone's own machine the runner still asks to be told it is meant to run. */
  if (process.env.CI !== 'true' && !LOCAL) throw new Error('runs only where CI=true, or with --local: it starts VS Code and installs extensions');
  return fetchStage();
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
