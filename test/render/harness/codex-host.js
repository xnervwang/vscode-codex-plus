// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Stand-in for Codex's extension host, inside the page. It answers the page's capnweb session (the host's `services`
 * object) with harness/services.js and the old-style postMessage requests, and hands every app-server request of the
 * page to Node through the __toNode binding (run.js), which gives it to Codex's real app-server.
 *
 * Codex's own capnweb module is imported, found by run.js by what it contains, and its three parts are told apart by
 * shape, since its file name and its minified export names change with every Codex build: the initialiser is the one
 * function export taking no arguments, RpcSession the class whose prototype has getRemoteMain, RpcTarget the empty
 * class. The import is asynchronous, so what the page sends before it is done is queued.
 */
const config = window.__renderConfig || {};
const services = window.__renderServices || {};
const queue = [];
let ready = false;
window.__hostReply = (m) => { if (ready) handle(m); else queue.push(m); };
const toPage = (msg) => setTimeout(() => window.__fromHost(JSON.parse(JSON.stringify(msg))), 0);
const toNode = (m) => window.__toNode(JSON.stringify(m));

let RpcSession = null, RpcTarget = null;
const sessions = new Map();

class Transport {
  constructor(id) { this.id = id; this.q = []; this.waiter = null; this.encodingLevel = 'jsonCompatibleWithBytes'; }
  send(message) { toPage({ type: 'vscode-capn-rpc-message', sessionId: this.id, message }); }
  deliver(message) { if (this.waiter) { const w = this.waiter; this.waiter = null; w(message); } else this.q.push(message); }
  receive() { return this.q.length ? Promise.resolve(this.q.shift()) : new Promise((resolve) => { this.waiter = resolve; }); }
  abort() {}
}

const SKIP = new Set(['then', 'toJSON', 'constructor', 'catch', 'finally', 'valueOf', 'toString']);
/* A service: every method answers, from harness/services.js when it names one and with undefined otherwise. */
function service(name) {
  const impl = services.services[name] || {};
  const base = new (class extends RpcTarget {})();
  return new Proxy(base, {
    get(t, p, r) {
      if (typeof p === 'symbol' || SKIP.has(p) || p in Object.prototype) return Reflect.get(t, p, r);
      return (...args) => (typeof impl[p] === 'function' ? impl[p](...args) : impl[p]);
    },
  });
}

function handle(m) {
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'vscode-capn-rpc-connect') {
    const tr = new Transport(m.sessionId);
    sessions.set(m.sessionId, tr);
    class HostMain extends RpcTarget {
      get services() { const out = {}; for (const n of services.serviceNames) out[n] = service(n); return out; }
      ping() {}
    }
    new RpcSession(tr, new HostMain());
    return;
  }
  if (m.type === 'vscode-capn-rpc-message') { const tr = sessions.get(m.sessionId); if (tr) tr.deliver(m.message); return; }
  if (m.type === 'mcp-request') { toNode({ kind: 'mcp-request', request: m.request || {} }); return; }
  if (m.type === 'mcp-notification' || m.type === 'mcp-response') { toNode({ kind: m.type, request: m.request, response: m.response }); return; }
  if (m.type === 'persisted-atom-sync-request') { toPage({ type: 'persisted-atom-sync', state: {} }); return; }
  if (m.type === 'shared-object-subscribe') { toPage({ type: 'shared-object-updated', key: m.key, value: undefined }); return; }
  if (m.type === 'ready') {
    toPage({ type: 'codex-app-server-initialized', hostId: 'local', transport: 'stdio', appServerVersion: '0.130.0', installedCodexVersion: null });
    return;
  }
  /* Offline: every fetch the page asks the host to make fails. */
  if (m.type === 'fetch') toPage({ type: 'fetch-response', requestId: m.requestId, responseType: 'error', status: 503, error: 'offline' });
}

(async () => {
  const ns = await import(config.capnweb);
  const fns = Object.values(ns).filter((v) => typeof v === 'function');
  for (const f of fns) {
    if (f.length === 0 && !/^class\b/.test(Function.prototype.toString.call(f))) { try { f(); } catch (_) { /* not the initialiser */ } }
  }
  const now = Object.values(ns).filter((v) => typeof v === 'function');
  RpcSession = now.find((v) => v.prototype && typeof v.prototype.getRemoteMain === 'function') || null;
  RpcTarget = now.find((v) => /^class\s*\{\s*\}$/.test(Function.prototype.toString.call(v))) || null;
  window.__hostShape = { rpcSession: !!RpcSession, rpcTarget: !!RpcTarget };
  if (!RpcSession || !RpcTarget) return;
  ready = true;
  for (const m of queue.splice(0)) handle(m);
})().catch((e) => { window.__hostShape = { error: String(e && e.message || e) }; });
