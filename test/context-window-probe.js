// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/context-window-probe.js <codex program>
 *
 * test/parts/57c-context-window-codex.js runs this inside a network namespace with only loopback. It starts a fake
 * model on 127.0.0.1 and Codex's own app-server against throwaway Codex homes pointed at it, and prints what Codex
 * reported as one JSON object.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const BIN = process.argv[2];

function model() {
  const seen = [];
  const usage = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let input = [];
      try { input = JSON.parse(body).input || []; } catch (_) { input = []; }
      const texts = input.flatMap((it) => (it && Array.isArray(it.content) ? it.content : [])).map((c) => (c && c.text) || '');
      const compact = /compact|checkpoint|summar/i.test(texts[texts.length - 1] || '');
      seen.push(compact ? 'compact' : 'turn');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const sse = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      const id = `resp_${seen.length}`, item = `msg_${seen.length}`, text = compact ? 'Summary.' : 'ok';
      const message = { type: 'message', id: item, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
      sse('response.created', { response: { id } });
      sse('response.output_item.added', { output_index: 0, item: { ...message, content: [] } });
      sse('response.output_text.delta', { item_id: item, output_index: 0, content_index: 0, delta: text });
      sse('response.output_item.done', { output_index: 0, item: message });
      const tokens = compact ? 3000 : usage.length ? usage.shift() : 1200;
      sse('response.completed', { response: { id, usage: { input_tokens: tokens, input_tokens_details: { cached_tokens: 0 },
        output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: tokens + 40 } } });
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}/v1`, seen,
    report: (n) => usage.push(n), close: () => { server.closeAllConnections(); server.close(); } })));
}

const homes = [];
function home(url, extra = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxw-'));
  homes.push(dir);
  const ch = path.join(dir, 'c');
  fs.mkdirSync(ch);
  fs.writeFileSync(path.join(ch, 'config.toml'), [extra, 'model = "gpt-6.1-sol"', 'model_provider = "fake"', 'model_reasoning_effort = "low"', '',
    '[model_providers.fake]', 'name = "fake"', `base_url = "${url}"`, 'wire_api = "responses"', 'requires_openai_auth = false', '',
    '[analytics]', 'enabled = false', ''].join('\n'));
  return { dir, ch };
}

function server({ dir, ch }) {
  const proc = spawn(BIN, ['app-server'], { env: { PATH: process.env.PATH, CODEX_HOME: ch, HOME: dir, LANG: 'C.UTF-8', RUST_LOG: 'error' },
    cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', next = 1;
  const pending = new Map(), notes = [], waiters = [];
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(String(m.id))) {
        pending.get(String(m.id))(m);
        pending.delete(String(m.id));
      } else if (m.id !== undefined && m.method) proc.stdin.write(`${JSON.stringify({ id: m.id, result: { decision: 'accept' } })}\n`);
      else if (m.method) {
        notes.push(m);
        for (const w of waiters.slice()) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
      }
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = `r${next++}`;
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const wait = (test, ms) => new Promise((resolve) => {
    const w = { test, resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
  });
  const ready = request('initialize', { clientInfo: { name: 'codex_vscode', title: 'Codex Extension', version: '0' }, capabilities: { experimentalApi: true } })
    .then(() => proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`));
  const turn = async (threadId, extra = {}) => {
    const mark = notes.length;
    const r = await request('turn/start', { threadId, input: [{ type: 'text', text: 'hi', text_elements: [] }], ...extra });
    if (r.error) return { error: r.error.message };
    await wait((m) => m.method === 'turn/completed' && m.params.threadId === threadId && notes.indexOf(m) >= mark, 30000);
    const after = notes.slice(mark);
    const windows = after.filter((m) => m.method === 'thread/tokenUsage/updated').map((m) => m.params.tokenUsage.modelContextWindow);
    return { window: windows[windows.length - 1] || 0,
      compacted: after.some((m) => m.method === 'item/started' && m.params.item && m.params.item.type === 'contextCompaction') };
  };
  const start = async (params = {}) => {
    const r = await request('thread/start', { cwd: dir, ...params });
    return r.error ? { error: r.error.message } : { id: r.result.thread.id };
  };
  return { request, ready, turn, start, stop: () => { try { proc.kill('SIGKILL'); } catch (_) { /* gone */ } } };
}

const MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.5', 'made-up-model'];

(async () => {
  const m = await model();
  const out = { listed: null, reported: {}, compaction: {}, loaded: {}, override: {} };
  try {
    for (const value of [0, 500000, 1050000]) {
      const h = home(m.url, value ? `model_context_window = ${value}` : '');
      const s = server(h);
      await s.ready;
      if (!out.listed) {
        const l = await s.request('model/list', {});
        out.listed = l.error ? l.error.message : (l.result.data || []).filter((x) => !x.hidden).map((x) => x.model);
      }
      out.reported[value] = {};
      for (const name of MODELS) {
        const t = await s.start({ model: name });
        out.reported[value][name] = t.error ? t.error : (await s.turn(t.id)).window;
      }
      if (value === 500000) {
        for (const used of [440000, 460000]) {
          const t = await s.start();
          m.report(used);
          await s.turn(t.id);
          out.compaction[used] = (await s.turn(t.id)).compacted;
        }
      }
      s.stop();
    }

    const h = home(m.url);
    const s = server(h);
    await s.ready;
    const loaded = await s.start();
    out.loaded.before = (await s.turn(loaded.id)).window;
    const w = await s.request('config/value/write', { keyPath: 'model_context_window', value: 500000, mergeStrategy: 'upsert' });
    out.loaded.written = w.error ? w.error.message : w.result.status;
    out.loaded.after = (await s.turn(loaded.id)).window;
    await s.request('thread/resume', { threadId: loaded.id, excludeTurns: true, config: { model_context_window: 600000 } });
    out.loaded.resumedWithOverride = (await s.turn(loaded.id)).window;
    const fresh = await s.start();
    out.loaded.newConversation = (await s.turn(fresh.id)).window;
    const over = await s.start({ config: { model_context_window: 400000 } });
    out.override.started = (await s.turn(over.id)).window;
    out.override.switchedToLuna = (await s.turn(over.id, { model: 'gpt-6-luna' })).window;
    out.override.switchedToSmaller = (await s.turn(over.id, { model: 'gpt-5.5' })).window;
    const after = await s.start();
    out.override.nextStart = (await s.turn(after.id)).window;
    const none = await s.start({ config: { model_context_window: null } });
    out.override.nullStart = none.error ? 'refused' : 'started';
    s.stop();
  } catch (e) {
    out.error = e.stack || String(e);
  }
  m.close();
  for (const d of homes) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* left for the OS */ } }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
})();
