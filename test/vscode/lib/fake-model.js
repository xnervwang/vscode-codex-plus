// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A stand-in for the model behind Codex: an HTTP server on 127.0.0.1 that answers the Responses API's streamed POST
 * /responses with a made-up reply. Codex's app-server sends each turn here when its config.toml names a provider with
 * this base_url (fake-home.js).
 *
 * hold() keeps the next turns' replies back until release() is called, so a turn can be watched while it runs.
 *
 * script(thread, steps) answers the next requests of conversation `thread` with `steps` in order, then with the usual
 * reply: { call, namespace, args } is a tool call, { reply } a message; either may give inputTokens, the input the
 * response reports using (1200 otherwise). While a script is set, a request from any other
 * conversation (a sub-agent's, or a codex exec's) is held until releaseOthers(). left() counts the steps not yet sent;
 * script(null) goes back to the usual reply for every conversation. sent(text) counts the requests whose body held `text`,
 * among the last BODIES_KEPT.
 */
const http = require('http');

function sse(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

/* The conversation a request is for, from the metadata Codex sends with it. */
function threadOf(body) {
  try {
    const meta = JSON.parse(body).client_metadata || {};
    if (meta.thread_id || meta.session_id) return String(meta.thread_id || meta.session_id);
    return String(JSON.parse(meta['x-codex-turn-metadata'] || '{}').thread_id || '');
  } catch (_) { return ''; }
}

const BODIES_KEPT = 40;

function opened() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}

async function start({ reply = 'Done. The cap is configurable.' } = {}) {
  const seen = [];
  const bodies = [];
  let gate = null, scripted = null, others = null;
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const thread = threadOf(body);
      seen.push({ method: req.method, url: req.url, bytes: body.length, thread });
      bodies.push(body);
      if (bodies.length > BODIES_KEPT) bodies.shift();
      if (req.method !== 'POST' || !/\/responses$/.test(req.url.replace(/\?.*/, ''))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"not served here"}}');
        return;
      }
      const id = `resp_fake_${++n}`, item = `msg_fake_${n}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      sse(res, 'response.created', { response: { id } });
      if (gate) await gate.promise;
      let step = null;
      if (scripted && thread === scripted.thread) step = scripted.steps.shift() || null;
      else if (scripted && others) await others.promise;
      if (step && step.call) {
        const call = { type: 'function_call', id: `fc_fake_${n}`, call_id: `call_fake_${n}`, name: step.call,
          ...(step.namespace ? { namespace: step.namespace } : {}), arguments: JSON.stringify(step.args || {}) };
        sse(res, 'response.output_item.added', { output_index: 0, item: call });
        sse(res, 'response.output_item.done', { output_index: 0, item: call });
      } else {
        const text = (step && step.reply) || reply;
        const message = { type: 'message', id: item, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
        sse(res, 'response.output_item.added', { output_index: 0, item: { ...message, content: [] } });
        sse(res, 'response.output_text.delta', { item_id: item, output_index: 0, content_index: 0, delta: text });
        sse(res, 'response.output_item.done', { output_index: 0, item: message });
      }
      const input = (step && step.inputTokens) || 1200;
      sse(res, 'response.completed', { response: { id, usage: { input_tokens: input, input_tokens_details: { cached_tokens: 0 },
        output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + 40 } } });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hold = () => { if (!gate) gate = opened(); };
  const release = () => { if (gate) { gate.open(); gate = null; } };
  const script = (thread, steps = []) => {
    if (others) others.open();
    scripted = thread == null ? null : { thread: String(thread), steps: steps.slice() };
    others = scripted ? opened() : null;
  };
  const releaseOthers = () => { if (others) others.open(); };
  const close = () => new Promise((r) => { release(); releaseOthers(); server.close(() => r()); server.closeAllConnections(); setTimeout(r, 2000); });
  return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}/v1`, seen, hold, release, close, script, releaseOthers,
    left: () => (scripted ? scripted.steps.length : 0),
    sent: (text) => bodies.filter((b) => b.includes(text)).length,
    turns: () => seen.filter((s) => s.method === 'POST' && /\/responses/.test(s.url)).length };
}

module.exports = { start };
