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
 */
const http = require('http');

function sse(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

async function start({ reply = 'Done. The cap is configurable.' } = {}) {
  const seen = [];
  let gate = null;
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      seen.push({ method: req.method, url: req.url, bytes: body.length });
      if (req.method !== 'POST' || !/\/responses$/.test(req.url.replace(/\?.*/, ''))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"not served here"}}');
        return;
      }
      const id = `resp_fake_${++n}`, item = `msg_fake_${n}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      sse(res, 'response.created', { response: { id } });
      if (gate) await gate.promise;
      const message = { type: 'message', id: item, role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] };
      sse(res, 'response.output_item.added', { output_index: 0, item: { ...message, content: [] } });
      sse(res, 'response.output_text.delta', { item_id: item, output_index: 0, content_index: 0, delta: reply });
      sse(res, 'response.output_item.done', { output_index: 0, item: message });
      sse(res, 'response.completed', { response: { id, usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 0 },
        output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1240 } } });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hold = () => { if (!gate) { let open; const promise = new Promise((r) => { open = r; }); gate = { promise, open }; } };
  const release = () => { if (gate) { gate.open(); gate = null; } };
  const close = () => new Promise((r) => { release(); server.close(() => r()); server.closeAllConnections(); setTimeout(r, 2000); });
  return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}/v1`, seen, hold, release, close,
    turns: () => seen.filter((s) => s.method === 'POST' && /\/responses/.test(s.url)).length };
}

module.exports = { start };
