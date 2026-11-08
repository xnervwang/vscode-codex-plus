// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Delivery of answers typed in the Conversations tab, by the same folder-and-rename protocol claude-code-extras uses;
 * each answer record carries its source's id ('codex'), so one folder can serve several sources.
 *
 * The conversation can be open in any VS Code window on this machine, and every window runs its own copy of this
 * extension. So an answer is a file in a folder they all read: this extension's storage, which the windows on one
 * machine share. The window showing that conversation takes the file, has the panel put the text in the conversation's
 * input and send it, and writes a result file that the window it came from reads.
 *
 * A window takes an answer by renaming its file, and only the first rename succeeds, so only one window gets each
 * answer. The sending window withdraws an answer the same way, by renaming it, so an answer nobody took cannot be
 * sent after the sender has reported it as not sent.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { languageOf, textFor } = require('./conversations-text');

const FOLDER = 'answers';
/* The shape of an answer record this code writes and understands (protocol section 7, rule 4). A record of a newer
   format is left for a window that understands it; if none takes it, its sender copies it to the clipboard. */
const FORMAT = 1;
/* How long an answer waits for a window to take it, how long a taken one waits for its panel, and how long any file in
   the folder is kept. */
const TAKE_MS = 15000;
const SEND_MS = 15000;
const KEEP_MS = 3600e3;
const NAME = /^[0-9a-z]+-[0-9a-f]{8}$/;

const folder = (storage) => path.join(storage, FOLDER);
const file = (dir, id, ext) => path.join(dir, id + ext);

function writeWhole(target, text) {
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

/** Puts an answer in the folder and returns its id. */
function post(dir, answer, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  const id = now.toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  writeWhole(file(dir, id, '.json'), JSON.stringify(Object.assign({ format: FORMAT }, answer, { id, at: now })));
  return id;
}

/** The answers no window has taken yet. One that cannot be read is being written or taken, and is left for next time. */
function waiting(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json') || !NAME.test(n.slice(0, -5))) continue;
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (a && a.id === n.slice(0, -5) && typeof a.sessionId === 'string' && typeof a.text === 'string'
        && !(Number(a.format) > FORMAT)) out.push(a);
    } catch (_) { /* next time */ }
  }
  return out;
}

/** Takes answer `id` for this window. False when another window, or the sender giving up, got to it first. */
function take(dir, id) {
  try { fs.renameSync(file(dir, id, '.json'), file(dir, id, '.taken')); return true; } catch (_) { return false; }
}

/** Writes the outcome of a taken answer, for the window that sent it. */
function settle(dir, id, outcome) {
  try { writeWhole(file(dir, id, '.result'), JSON.stringify(Object.assign({}, outcome, { id }))); } catch (_) { /* lost */ }
  try { fs.unlinkSync(file(dir, id, '.taken')); } catch (_) { /* already gone */ }
}

/** Reads the outcome of answer `id` and deletes its file. Null until there is one. */
function outcome(dir, id) {
  let r;
  try { r = JSON.parse(fs.readFileSync(file(dir, id, '.result'), 'utf8')); } catch (_) { return null; }
  try { fs.unlinkSync(file(dir, id, '.result')); } catch (_) { /* read once is enough */ }
  return r && typeof r === 'object' ? r : null;
}

/** The sender gives up on an answer nobody took. False when a window took it in the meantime. */
function withdraw(dir, id) {
  try { fs.renameSync(file(dir, id, '.json'), file(dir, id, '.withdrawn')); } catch (_) { return false; }
  try { fs.unlinkSync(file(dir, id, '.withdrawn')); } catch (_) { /* removed by the sweep */ }
  return true;
}

/** Whether answer `id` has been taken and not yet settled. */
function taken(dir, id) {
  return fs.existsSync(file(dir, id, '.taken'));
}

/** Removes files older than KEEP_MS: results nobody read, answers a closed window took and never settled. */
function sweep(dir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  let gone = 0;
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > KEEP_MS) { fs.unlinkSync(p); gone++; }
    } catch (_) { /* someone else removed it */ }
  }
  return gone;
}

/**
 * What one window does with answers: it takes the ones meant for conversations it shows and has its panel send
 * them, and it tracks the answers it sent until each gets a result or times out.
 *
 * `canShow(sessionId)` says whether this window has a panel showing the conversation; `hand(sessionId, text, id)` gives
 * the text to that panel and returns whether it could, after which the panel's report arrives through handed(). The
 * `finish(sent, outcome)` callback hears the outcome of each answer this window sent, with `outcome.kind` one of
 * 'sent', 'nobody' (no window took it in time), 'lost' (taken, then no word back) or the reason the panel gave.
 */
class Courier {
  constructor({ dir, canShow, hand, finish, now = Date.now, later = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { dir, canShow, hand, finish, now, later, cancel });
    this.outgoing = new Map();
    this.handing = new Map();
  }

  /** Sends `answer` ({ sessionId, row, text }) and returns its id; `extra` comes back to finish() with the outcome. */
  send(answer, extra) {
    const id = post(this.dir, answer, this.now());
    this.outgoing.set(id, Object.assign({ id, at: this.now(), text: answer.text }, extra));
    /* Checked again when the time to take it is up, and when a window that took it has had time to report, even if
       no change in the folder is seen. */
    this.later(() => this.pump(), TAKE_MS + 100);
    this.later(() => this.pump(), TAKE_MS + SEND_MS + 5100);
    this.pump();
    return id;
  }

  pump() {
    for (const a of waiting(this.dir)) {
      if (this.handing.has(a.id) || !this.canShow(a.sessionId) || !take(this.dir, a.id)) continue;
      this.handing.set(a.id, this.later(() => this.handed(a.id, false, 'no-reply'), SEND_MS));
      let handed = false;
      try { handed = this.hand(a.sessionId, a.text, a.id) === true; } catch (_) { /* not handed */ }
      if (!handed) this.handed(a.id, false, 'not-shown');
    }
    for (const [id, o] of this.outgoing) {
      const r = outcome(this.dir, id);
      const age = this.now() - o.at;
      let kind = '';
      if (r) kind = r.sent ? 'sent' : (r.reason || 'error');
      else if (age > TAKE_MS && !taken(this.dir, id) && withdraw(this.dir, id)) kind = 'nobody';
      else if (age > TAKE_MS + SEND_MS + 5000) kind = 'lost';
      if (!kind) continue;
      this.outgoing.delete(id);
      this.finish(o, { kind });
    }
  }

  /** The panel's report on answer `id`, after this window gave it to the panel. */
  handed(id, sent, reason) {
    if (!this.handing.has(id)) return;
    this.cancel(this.handing.get(id));
    this.handing.delete(id);
    settle(this.dir, id, { sent: !!sent, reason: reason || '' });
    this.pump();
  }

  dispose() {
    for (const t of this.handing.values()) this.cancel(t);
    this.handing.clear();
  }
}

/** The message sent to the conversation. An agent reads it, so it uses the question's language, not the tab's. */
function message(row, question, answer) {
  const t = textFor(languageOf(question));
  return t.answerMessage(row, String(question || '').trim(), String(answer || '').trim());
}

/*
 * This window's courier. receive() starts it; deliver() sends through it. A source that cannot type into any
 * conversation (Codex without the patch) is answered at once with 'clipboard': the text is copied and the conversation
 * opened in a tab, rather than waiting TAKE_MS for a window that cannot exist.
 */
let courier = null;
const finished = new Map();

function receive(vscode, source, { storage, log = () => {} }) {
  const dir = folder(storage);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* reported on send */ }
  courier = new Courier({
    dir,
    canShow: (sessionId) => { try { return source.canDeliver(sessionId); } catch (_) { return false; } },
    hand: (sessionId, text, id) => {
      Promise.resolve(source.deliverAnswer(sessionId, text))
        .then((r) => courier && courier.handed(id, !!(r && r.delivered), r && r.reason))
        .catch((e) => courier && courier.handed(id, false, String(e && e.message || e)));
      return true;
    },
    finish: (sent, outcome) => { const done = finished.get(sent.id); finished.delete(sent.id); if (done) done(outcome); },
  });
  let watcher = null;
  try { watcher = fs.watch(dir, () => courier && courier.pump()); } catch (e) { log(`answers folder: ${e.message}`); }
  const tick = setInterval(() => courier && courier.pump(), 2000);
  const sweeper = setInterval(() => sweep(dir), KEEP_MS);
  sweep(dir);
  return { dispose() { if (watcher) watcher.close(); clearInterval(tick); clearInterval(sweeper); if (courier) courier.dispose(); courier = null; } };
}

/** Send `text` as the answer to question `q`; resolves to { kind } as the Answer view shows it. */
async function deliver(vscode, source, q, text, { canType = false } = {}) {
  const body = message(q.row, q.question, text);
  if (!canType || !courier) {
    await vscode.env.clipboard.writeText(body);
    try { await source.reveal(q.sessionId); } catch (_) { /* the clipboard still has it */ }
    return { kind: 'clipboard' };
  }
  return new Promise((resolve) => {
    const id = courier.send({ source: source.id, sessionId: q.sessionId, row: q.row, text: body }, { key: q.key });
    finished.set(id, async (outcome) => {
      if (outcome.kind !== 'sent') await vscode.env.clipboard.writeText(body);
      resolve(outcome);
    });
  });
}

module.exports = { FORMAT, FOLDER, TAKE_MS, SEND_MS, KEEP_MS, folder, post, waiting, take, settle, outcome, withdraw, taken, sweep, message,
  Courier, receive, deliver };
