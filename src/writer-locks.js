// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which Codex process has each conversation open, from Codex's own writer locks. A Codex process that loads a
 * conversation (an editor's app-server, the terminal interface, `codex exec`) takes an exclusive lock on
 * CODEX_HOME/thread-writer-locks/<thread id>.lock and keeps it while the conversation stays loaded, idle or not. An
 * app-server lets go up to a minute after its page closes the conversation. The file stays behind once nobody holds
 * it, so only a lock held now counts.
 *
 * Linux lists every lock in /proc/locks with the process that took it and the device and inode of the file. Reading
 * that takes no lock, so it cannot get in the way of a Codex process opening a conversation. Without /proc/locks
 * nothing is found.
 *
 * A holder is described by where it sits: under the extension host of an editor of the VS Code family (an app-server
 * of the Codex extension), a `codex exec`, or a codex program reading a terminal. Its ancestors are kept, so that each
 * window can leave out the app-server of its own Codex.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_DIR = 'thread-writer-locks';
const LOCK_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
/* Ancestors walked at most, against a loop in a parent chain read while processes come and go. */
const MAX_DEPTH = 64;
/* The protocol's limits for one place (Agent Plus docs/protocol.md, Limits). */
const LABEL_MAX = 80;
const DETAIL_MAX = 200;
/* Editors of the VS Code family, by their program's name, and the folders their remote servers run from. */
const EDITORS = new Set(['code', 'code-insiders', 'codium', 'cursor', 'windsurf', 'kiro']);
const SERVER_DIR = /[\\/]\.(?:vscode|vscode-insiders|vscodium|cursor|windsurf|kiro)-server[\\/]/;

const readLink = (file) => { try { return fs.readlinkSync(file); } catch (_) { return ''; } };
const read = (file, enc) => { try { return fs.readFileSync(file, enc); } catch (_) { return null; } };

/* `<major>:<minor>:<inode>` -> pids, for the write locks a /proc/locks text says are held. A line for a process waiting
   on a lock has `->` after its number and is passed over; the device numbers are hex. */
function heldLocks(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[1] === '->' || f[3] !== 'WRITE') continue;
    const pid = Number(f[4]);
    const m = /^([0-9a-f]+):([0-9a-f]+):(\d+)$/i.exec(f[5]);
    if (!m || !Number.isInteger(pid) || pid <= 0) continue;
    const key = `${parseInt(m[1], 16)}:${parseInt(m[2], 16)}:${m[3]}`;
    if (!out.has(key)) out.set(key, []);
    if (!out.get(key).includes(pid)) out.get(key).push(pid);
  }
  return out;
}

/* The key heldLocks uses for `file`, from its device number as Linux encodes it, or ''. */
function keyOf(file) {
  let st;
  try { st = fs.statSync(file, { bigint: true }); } catch (_) { return ''; }
  const d = st.dev;
  const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn);
  const minor = (d & 0xffn) | ((d >> 12n) & ~0xffn);
  return `${major}:${minor}:${st.ino}`;
}

/* The ancestors of `pid` in `all` (pid -> { ppid }), nearest first. */
function ancestorsOf(pid, all) {
  const out = [];
  for (let p = (all.get(pid) || {}).ppid; p > 1 && out.length < MAX_DEPTH && !out.includes(p); p = (all.get(p) || {}).ppid) out.push(p);
  return out;
}

const isEditor = (argv, comm) => argv.some((a) => a === '--type=extensionHost') || SERVER_DIR.test(argv[0] || '')
  || EDITORS.has(path.basename(argv[0] || '').toLowerCase()) || EDITORS.has(String(comm || '').toLowerCase());

/* `folder` with the home folder written as ~, by its path or by the real path of a home that is a symbolic link. */
function tilde(folder) {
  const home = os.homedir();
  let real = home;
  try { real = fs.realpathSync(home); } catch (_) { /* as given */ }
  for (const h of [home, real]) if (h && (folder === h || folder.startsWith(h + path.sep))) return '~' + folder.slice(h.length);
  return folder;
}

/*
 * One holder: { kind, label, detail } for the place, kind being 'vscode', 'terminal', 'exec' or 'other'. `isExec` is
 * src/left-running.js isCodexExec.
 */
function placeOf(pid, { all, proc, argvOf, isExec, envOf }) {
  const argv = argvOf(pid);
  const comm = (all.get(pid) || {}).comm || path.basename(argv[0] || '') || 'process';
  const cwd = readLink(path.join(proc, String(pid), 'cwd'));
  const where = cwd ? ` in ${tilde(cwd)}` : '';
  const tty = readLink(path.join(proc, String(pid), 'fd', '0'));
  const pts = /^\/dev\/(pts\/\d+|tty\w*)$/.exec(tty);
  const detail = [`process ${pid}`];
  if (cwd) detail.push(`folder ${cwd}`);
  const cmd = argv.filter((a, i, list) => a || i < list.length - 1).join(' ');
  if (cmd) detail.push(`command ${cmd}`);
  let kind = 'other', label = `${comm} process ${pid}`;
  if (isExec(argv)) { kind = 'exec'; label = `codex exec${where}`; }
  else if (argv.includes('app-server') && ancestorsOf(pid, all).some((p) => isEditor(argvOf(p), (all.get(p) || {}).comm))) {
    kind = 'vscode'; label = `another VS Code window${where}`;
  } else if (pts) {
    kind = 'terminal'; label = `terminal ${pts[1]}${where}`;
    const env = envOf(pid);
    if (env.TMUX) detail.push('in tmux');
    else if (env.TERM_PROGRAM === 'vscode') detail.push('in a terminal of VS Code');
  }
  return { kind, label: label.slice(0, LABEL_MAX), detail: detail.map((d) => d.slice(0, DETAIL_MAX)) };
}

/*
 * The conversations of `codexHome` a process holds open now, as [{ thread, pid, start, kind, label, detail, ancestors }],
 * thread in lower case. `all` is src/left-running.js processes() of `proc`; `argvOf` reads a command line.
 */
function holders({ codexHome, proc = '/proc', all, argvOf, isExec }) {
  if (!codexHome || !all || !all.size) return [];
  const held = heldLocks(read(path.join(proc, 'locks'), 'latin1'));
  if (!held.size) return [];
  const dir = path.join(codexHome, LOCK_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const envOf = (pid) => {
    const out = {};
    for (const kv of String(read(path.join(proc, String(pid), 'environ'), 'latin1') || '').split('\0')) {
      const at = kv.indexOf('=');
      if (at > 0 && (kv.startsWith('TMUX=') || kv.startsWith('TERM_PROGRAM='))) out[kv.slice(0, at)] = kv.slice(at + 1);
    }
    return out;
  };
  const out = [];
  for (const n of names) {
    const m = LOCK_FILE.exec(n);
    if (!m) continue;
    const pids = held.get(keyOf(path.join(dir, n)));
    if (!pids) continue;
    for (const pid of pids) {
      const p = all.get(pid);
      if (!p) continue;
      out.push({ thread: m[1].toLowerCase(), pid, start: String(p.start), ...placeOf(pid, { all, proc, argvOf, isExec, envOf }),
        ancestors: ancestorsOf(pid, all) });
    }
  }
  return out.sort((a, b) => (a.thread < b.thread ? -1 : a.thread > b.thread ? 1 : a.pid - b.pid));
}

const KINDS = new Set(['vscode', 'terminal', 'exec', 'other']);
/* Whether `e` is a holder as holders() writes one, for a scan another window shared. */
const isHolder = (e) => !!e && /^[0-9a-f-]{36}$/.test(e.thread) && Number.isInteger(e.pid) && e.pid > 0 && typeof e.start === 'string'
  && KINDS.has(e.kind) && typeof e.label === 'string' && Array.isArray(e.detail) && e.detail.every((d) => typeof d === 'string')
  && Array.isArray(e.ancestors) && e.ancestors.every((p) => Number.isInteger(p));

module.exports = { holders, heldLocks, keyOf, placeOf, ancestorsOf, isHolder, LOCK_DIR };
