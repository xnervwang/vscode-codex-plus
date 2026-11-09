// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * src/python-runtime.js - which Python runs the work plan plugin, and fetching one on a Windows machine that has none -
 * together with plugin-install.fitHooks, which is what tells the plugin the answer.
 *
 * Nothing here downloads anything. The fetch and the unpacking are both handed in, so each outcome is produced on
 * purpose rather than waited for: a digest that does not match, an unpacking that fails, an archive with no
 * interpreter in it, a transfer that dies. Every one of them is checked for the same thing, that no half-made
 * interpreter is left behind where findPython would go on to pick it up and run it.
 *
 * Which build is offered turns on process.platform, so Windows' answer is asked for in a child process that reports
 * itself as Windows. Overwriting platform in this process would leave it overwritten for every check that follows.
 *
 * This machine is not Windows, so the download has never been run end to end anywhere. That leaves the real network
 * transfer, tar.exe and Expand-Archive, and whether Codex on Windows starts a fitted hook command the way it starts
 * the shipped one. The last of those is covered as far as it can be here, by running the rewritten command as a shell
 * line with a real interpreter path in it.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

/* A stand-in for child_process.execFile: answers one fixed thing, whatever it is asked. */
const says = (text, err = null) => (bin, args, opts, done) => done(err, text, '');

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const rt = require('../../src/python-runtime');
  const pi = require('../../src/plugin-install');

  /* ── which build is offered, and from where ── */
  const win = rt.build('win32', 'x64');
  eq([win.name, win.size, win.url], ['amd64', 11062583,
    'https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip'],
  'on 64-bit Windows the embeddable build comes from python.org, at a pinned version, with its size recorded');
  eq([/^[0-9a-f]{64}$/.test(win.sha256), rt.build('win32', 'arm64').name, rt.build('win32', 'ia32').name],
    [true, 'arm64', 'win32'], 'each processor has its own build and its own SHA-256');
  eq([rt.build('linux', 'x64'), rt.build('darwin', 'arm64'), rt.build('win32', 'mips')], [null, null, null],
    'and nothing is offered where python.org publishes no embeddable build, this machine included');
  for (const [arch, [name, sha]] of Object.entries(rt.BUILDS)) {
    const b = rt.build('win32', arch);
    if (b.url.endsWith(`python-${rt.VERSION}-embed-${name}.zip`) && b.sha256 === sha && /^[0-9a-f]{64}$/.test(sha)) continue;
    bad(`the ${arch} build is not pinned to ${rt.VERSION} with a digest: ${JSON.stringify(b)}`);
  }
  ok(`all ${Object.keys(rt.BUILDS).length} builds name version ${rt.VERSION} and carry a 64-character digest`);
  const store = tmp('storage');
  eq([rt.home(store, win).endsWith(path.join('python', '3.12.7-amd64')),
    rt.executable(store, win).endsWith('python.exe')],
  [true, true], 'it lands under the extension\'s own storage, in a directory named by version and processor');

  /* ── finding one that is already here ── */
  const found = await rt.findPython();
  if (!found) bad('no Python 3 was found on this machine, so the hooks could not run here either');
  else {
    eq([found.launcher[0], path.isAbsolute(found.executable), /^\d+\.\d+$/.test(found.version)],
      ['python3', true, true], 'the Python already on this machine is found by name, and gives its own path and version');
  }
  eq(await rt.findPython(says(''), [['nothing-by-this-name']]), null,
    'a name that does not run at all is passed over, and with no candidate left the answer is that there is none');
  eq(await rt.findPython(says('3 6\n/usr/bin/python3.6\n')), null,
    'so is a Python older than 3.7, rather than being used and failing later inside a hook');
  eq(await rt.findPython(says('Python was not found; run without arguments to install from the Microsoft Store')), null,
    "and so is a name that answers something which is not a version, such as Windows' stand-in python.exe");
  eq((await rt.findPython(says('3 12\nC:\\py\\python.exe\n'), [['py', '-3']])).launcher, ['py', '-3'],
    'a launcher that needs arguments keeps them');
  const order = [];
  await rt.findPython((bin, args, opts, done) => { order.push([bin, ...args.slice(0, -2)].join(' ')); done(new Error('no'), '', ''); },
    [['py', '-3'], ['python'], ['python3']]);
  eq(order, ['py -3', 'python', 'python3'], 'the candidates are tried in order, and each is asked only once');

  /* A Python this extension downloaded is a fallback, never a preference. */
  eq(rt.pythons(''), rt.PYTHONS, 'with nowhere to have downloaded one, the candidates are just the names');
  eq(rt.pythons(store), rt.PYTHONS, 'and so they are while nothing has been downloaded');

  /* ── the download, with the transfer and the unpacking handed in ── */
  const script = (body) => `
    const rt = require(${JSON.stringify(path.join(root, 'src', 'python-runtime.js'))});
    const fs = require('fs'), path = require('path'), os = require('os');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pyrt-'));
    const sha = rt.build().sha256;
    const wrote = (text) => async (url, file) => { fs.writeFileSync(file, text); return sha; };
    const leftovers = () => { try { return fs.readdirSync(path.join(store, 'python')); } catch (_) { return []; } };
    const unpacked = async (zip, dir) => { fs.writeFileSync(path.join(dir, 'python.exe'), 'x'); return true; };
    (async () => { const out = await (async () => { ${body} })();
      console.log(JSON.stringify(out)); fs.rmSync(store, { recursive: true, force: true }); })();`;
  const run = (body) => {
    const r = cp.spawnSync(process.execPath, ['-e', script(body)], { encoding: 'utf8' });
    try { return JSON.parse(r.stdout); } catch (_) { bad(`the download check did not report: ${r.stdout} ${r.stderr}`); return null; }
  };

  const good = run(`const r = await rt.download(store, { fetch: wrote('zip'), extract: unpacked });
    return { r, left: leftovers(), exe: fs.existsSync(rt.executable(store)), url: rt.build().url };`);
  if (good) {
    eq([good.r.ok, good.exe, good.left.length, /Python 3\.12\.7 is in /.test(good.r.said)], [true, true, 1, true],
      'a download whose digest matches is unpacked and moved into place, leaving one directory and a python.exe in it');
    eq(good.url.startsWith('https://www.python.org/ftp/python/'), true, 'fetched from python.org over https, and nowhere else');
  }
  const wrongSha = run(`const r = await rt.download(store, { fetch: async (u, f) => { fs.writeFileSync(f, 'zip'); return '0'.repeat(64); },
    extract: unpacked });
    return { r, left: leftovers(), exe: fs.existsSync(rt.executable(store)) };`);
  if (wrongSha) {
    eq([wrongSha.r.ok, /SHA-256/.test(wrongSha.r.said), wrongSha.left.length, wrongSha.exe], [false, true, 0, false],
      'a download that does not match its recorded SHA-256 is thrown away whole and never unpacked');
  }
  const badZip = run(`const r = await rt.download(store, { fetch: wrote('zip'), extract: async () => false });
    return { r, left: leftovers(), exe: fs.existsSync(rt.executable(store)) };`);
  if (badZip) {
    eq([badZip.r.ok, /Unpacking python-3\.12\.7-embed-amd64\.zip failed/.test(badZip.r.said), badZip.left.length, badZip.exe],
      [false, true, 0, false], 'an unpacking that fails leaves nothing behind, and the message names the archive');
  }
  const noExe = run(`const r = await rt.download(store, { fetch: wrote('zip'), extract: async () => true });
    return { r, left: leftovers(), exe: fs.existsSync(rt.executable(store)) };`);
  if (noExe) {
    eq([noExe.r.ok, /no python\.exe in it/.test(noExe.r.said), noExe.left.length, noExe.exe], [false, true, 0, false],
      'an archive that unpacked to no python.exe is refused, rather than leaving a directory that cannot run');
  }
  const died = run(`const r = await rt.download(store, { fetch: async () => { throw new Error('the download stalled for two minutes'); },
    extract: unpacked });
    return { r, left: leftovers() };`);
  if (died) {
    eq([died.r.ok, died.r.said, died.left.length], [false, 'the download stalled for two minutes', 0],
      'a transfer that dies is reported in the words it failed with, and leaves nothing behind');
  }
  const replaced = run(`await rt.download(store, { fetch: wrote('zip'), extract: unpacked });
    fs.writeFileSync(path.join(rt.home(store), 'stale.txt'), 'from an older download');
    const r = await rt.download(store, { fetch: wrote('zip2'), extract: unpacked });
    return { r, stale: fs.existsSync(path.join(rt.home(store), 'stale.txt')), left: leftovers() };`);
  if (replaced) {
    eq([replaced.r.ok, replaced.stale, replaced.left.length], [true, false, 1],
      'downloading again replaces the whole directory rather than unpacking on top of what was there');
  }
  const offered = run(`const exe = rt.executable(store);
    fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'x');
    return { names: rt.pythons(store).map((l) => l.join(' ')), shipped: rt.PYTHONS.map((l) => l.join(' ')) };`);
  if (offered) {
    /* The candidate names themselves are fixed when the module loads, so in this child they are this machine's; what
       is being checked is only where the downloaded one is put among them. */
    const last = offered.names[offered.names.length - 1] || '';
    eq([offered.names.slice(0, offered.shipped.length), offered.names.length - offered.shipped.length,
      last.endsWith('/python.exe')],
    [offered.shipped, 1, true], 'once one has been downloaded it is tried last, after any Python the reader installed');
  }

  /* ── fitting the staged plugin to whichever Python won ── */
  const hooksOf = (stage) => JSON.parse(fs.readFileSync(path.join(stage, pi.PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const commands = (stage) => { const out = []; for (const g of Object.values(hooksOf(stage).hooks)) for (const x of g) for (const h of (x.hooks || [])) out.push(h.command); return out; };
  const mcpOf = (stage) => JSON.parse(fs.readFileSync(path.join(stage, pi.PLUGIN, '.mcp.json'), 'utf8')).mcpServers.work_plan;
  const launcherFile = (stage) => path.join(stage, pi.PLUGIN, 'hooks', 'launcher.json');

  const asShipped = tmp('stage-shipped');
  pi.stageMarketplace(asShipped, pi.SOURCE, pi.SHIPPED_PYTHON);
  const shipped = commands(asShipped);
  eq([shipped.length, shipped.every((c) => c.startsWith('python3 ')), fs.existsSync(launcherFile(asShipped)),
    mcpOf(asShipped).command], [9, true, false, 'python3'],
  'with python3 the staged copy is left exactly as it ships, and no launcher file is written');

  const fitted = tmp('stage-py3-launcher');
  const r1 = pi.fitHooks(pi.stageMarketplace(fitted, pi.SOURCE, pi.SHIPPED_PYTHON) && fitted,
    { launcher: ['py', '-3'], executable: 'C:/Python312/python.exe', version: '3.12' });
  eq([r1.state, r1.hooks, commands(fitted).every((c) => c.startsWith('py -3 "$PLUGIN_ROOT/hooks/'))],
    ['fitted', 9, true], 'a launcher with arguments goes in front of every hook command, leaving the rest of the line alone');
  eq([mcpOf(fitted).command, mcpOf(fitted).args], ['C:/Python312/python.exe', ['-3', './hooks/plan-mcp.py']],
    "the MCP server gets the interpreter's own path, since it is not started from the reader's shell");
  eq(JSON.parse(fs.readFileSync(launcherFile(fitted), 'utf8')), { row: ['py', '-3'] },
    'and launcher.json gets the words a person would type, which is what the model is told to run');

  /* A name resolves through PATH in whichever shell Codex uses; a quoted path does not, so the name is preferred even
     though the interpreter's own path is known. */
  const named = tmp('stage-named');
  pi.stageMarketplace(named, pi.SOURCE, { launcher: ['python'], executable: 'C:/Python312/python.exe', version: '3.12' });
  eq(commands(named)[0], 'python "$PLUGIN_ROOT/hooks/inject-work-plan.py" "$PLUGIN_DATA"',
    "a hook command names the launcher rather than the interpreter's path, the way the shipped one names python3");
  eq(mcpOf(named).command, 'C:/Python312/python.exe',
    'while the MCP server, which Codex starts as a program rather than as a shell line, still gets the path');

  /* The one launcher with no name to use: a Python this extension downloaded. */
  const spaced = tmp('stage-spaced');
  pi.stageMarketplace(spaced, pi.SOURCE, { launcher: ['C:/Users/Jo Ann/py/python.exe'],
    executable: 'C:/Users/Jo Ann/py/python.exe', version: '3.12' });
  eq(commands(spaced)[0], '"C:/Users/Jo Ann/py/python.exe" "$PLUGIN_ROOT/hooks/inject-work-plan.py" "$PLUGIN_DATA"',
    'a launcher that is a path, having no name to use, is quoted the way the paths already in that line are');

  const none = tmp('stage-none');
  const r2 = pi.fitHooks(pi.stageMarketplace(none, pi.SOURCE, null) && none, null);
  eq([r2.state, hooksOf(none).hooks, JSON.parse(fs.readFileSync(path.join(none, pi.PLUGIN, '.mcp.json'), 'utf8')).mcpServers,
    fs.existsSync(path.join(none, pi.PLUGIN, 'skills'))], ['stripped', {}, {}, false],
  'with no Python the copy keeps no hooks, no MCP server and no skill, rather than failing in every turn');

  /* A hook command this extension does not know how to fit has to stop the install, not be left naming python3. */
  const odd = tmp('stage-odd');
  pi.stageMarketplace(odd, pi.SOURCE, pi.SHIPPED_PYTHON);
  const oddFile = path.join(odd, pi.PLUGIN, 'hooks', 'hooks.json');
  const oddConfig = JSON.parse(fs.readFileSync(oddFile, 'utf8'));
  oddConfig.hooks.UserPromptSubmit[0].hooks[0].command = 'uv run $PLUGIN_ROOT/hooks/inject-work-plan.py';
  fs.writeFileSync(oddFile, JSON.stringify(oddConfig, null, 2));
  let threw = '';
  try { pi.fitHooks(odd, { launcher: ['python'], executable: '/usr/bin/python', version: '3.12' }); } catch (e) { threw = e.message; }
  eq([/not in the form this extension knows how to fit/.test(threw), threw.includes('uv run')], [true, true],
    'and a command in a shape it cannot fit stops it, naming the command rather than half-fitting the plugin');

  /*
   * The two sides together, as far as a machine that is not Windows can show it: a real interpreter put in by path
   * rather than by name, the rewritten line run as a shell line the way its own `$PLUGIN_ROOT` implies, and the
   * Python side reading back the launcher this wrote.
   */
  if (!found) { ok('no Python here, so the fitted command could not be run'); return; }
  const live = tmp('stage-live');
  pi.stageMarketplace(live, pi.SOURCE, { launcher: [found.executable], executable: found.executable, version: found.version });
  const pluginRoot = path.join(live, pi.PLUGIN);
  const data = tmp('plan-data');
  const session = '01a1b8f2-fd2b-7e60-9ffc-16e5cb642e31';
  fs.writeFileSync(path.join(data, `${session}.json`), JSON.stringify({ nodes: [{ title: 'Fit the hooks', state: 'doing' }] }));
  const line = commands(live).find((c) => c.includes('inject-work-plan.py'));
  const shell = cp.spawnSync('bash', ['-c', line], { encoding: 'utf8',
    env: { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: data },
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: 'turn-1',
      transcript_path: null, cwd: data, model: 'm', permission_mode: 'default', prompt: 'p' }) });
  let injected = '';
  try { injected = JSON.parse(shell.stdout).hookSpecificOutput.additionalContext; } catch (_) { injected = ''; }
  eq([line.startsWith(found.executable), /Fit the hooks/.test(injected)], [true, true],
    'a hook command fitted to an interpreter path runs as a shell line and still injects the plan');
  const askPython = cp.spawnSync(found.executable, ['-c',
    `import json,sys; sys.path.insert(0, ${JSON.stringify(path.join(pluginRoot, 'hooks'))}); import plan_path; `
    + 'print(json.dumps([plan_path.launcher(), plan_path.launcher_quoted()]))'], { encoding: 'utf8' });
  let readBack = null;
  try { readBack = JSON.parse(askPython.stdout); } catch (_) { readBack = null; }
  eq(readBack, [[found.executable], false],
    'and the plugin reads that same launcher back out of launcher.json, which is what it builds the row command from');
};
