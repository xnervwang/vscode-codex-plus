// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Session list groups are Codex sections: threadSection/create, /update and /delete manage them, and
 * thread/section/move puts a conversation in one or takes it out. Codex stores no section order, so ORDER_KEY in
 * globalState does. create() appends to it, which puts a new group last as Claude Code's list does; sections made in
 * another client are not in it and follow the stored ones.
 *
 * Codex's desktop app pins a conversation by moving it into the built-in Pinned section. choices() leaves that section
 * out, and the list draws it only when it is not empty.
 *
 * probe() sends threadSection/list once. An app-server that answers `unknown variant` lacks all of these methods, and
 * the group commands are hidden.
 */
const PINNED_SECTION = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const ORDER_KEY = 'codexPlus.groupOrder';
/* Claude Code's own limits on a group's name and on how many groups there are. */
const NAME_MAX = 100;
const GROUPS_MAX = 100;

/** `sections` (id -> name, in Codex's order) as [id, name] pairs: the stored order first, then the rest. */
function ordered(sections, order = []) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(order) ? order : []) {
    if (sections.has(id) && !seen.has(id)) { seen.add(id); out.push([id, sections.get(id)]); }
  }
  for (const [id, name] of sections) if (!seen.has(id)) out.push([id, name]);
  return out;
}

const cleanName = (name) => [...String(name || '').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('');

/*
 * `ask(method, params)` resolves to { outcome: 'done', result } or { outcome: 'failed', reason }, like extension.js
 * askAppServer; `sections()` is the snapshot's id -> name; `memento` holds the order.
 */
function createGroups({ ask, sections, memento }) {
  let supported = null;
  let probing = null;
  const order = () => memento.get(ORDER_KEY) || [];
  const setOrder = (list) => Promise.resolve(memento.update(ORDER_KEY, list)).catch(() => {});
  const known = () => ordered(sections(), order());

  return {
    /* true, false, or null while not known yet. */
    supported: () => supported,
    /* `opts` goes to `ask`: { fallback: false } asks only on Codex's own connection, and leaves it unknown without one. */
    probe(opts = {}) {
      if (supported !== null) return Promise.resolve(supported);
      if (!probing) {
        probing = Promise.resolve(ask('threadSection/list', {}, opts)).then((r) => {
          if (r && r.outcome === 'done') supported = true;
          else if (r && r.outcome === 'failed' && /unknown variant/i.test(r.reason || '')) supported = false;
          return supported;
        }).catch(() => supported).finally(() => { probing = null; });
      }
      return probing;
    },
    /* The groups a conversation can be moved to: every section but the built-in one. */
    choices: () => known().filter(([id]) => id !== PINNED_SECTION),
    /* Every section in the order the list draws them, the built-in one first. */
    list: () => {
      const all = known();
      const pinned = all.filter(([id]) => id === PINNED_SECTION);
      return pinned.concat(all.filter(([id]) => id !== PINNED_SECTION));
    },
    async create(name) {
      const clean = cleanName(name) || 'New group';
      if (known().filter(([id]) => id !== PINNED_SECTION).length >= GROUPS_MAX) return { outcome: 'failed', reason: `there are already ${GROUPS_MAX} groups` };
      const r = await ask('threadSection/create', { name: clean });
      const id = r && r.outcome === 'done' && r.result && r.result.section && r.result.section.id;
      if (!id) return r && r.outcome === 'failed' ? r : { outcome: 'failed', reason: 'Codex did not say which group it made' };
      await setOrder(order().filter((x) => x !== id).concat(String(id)));
      return { outcome: 'done', id: String(id), name: clean };
    },
    async rename(sectionId, name) {
      const clean = cleanName(name);
      if (!clean) return { outcome: 'failed', reason: 'a group needs a name' };
      return ask('threadSection/update', { sectionId, name: clean });
    },
    async remove(sectionId) {
      const r = await ask('threadSection/delete', { sectionId });
      if (r && r.outcome === 'done') await setOrder(order().filter((x) => x !== sectionId));
      return r;
    },
    /* Each of `threads` into `sectionId`, or out of any group with null. Stops at the first refusal. */
    async move(threads, sectionId) {
      for (const threadId of threads) {
        const r = await ask('thread/section/move', { threadId, sectionId });
        if (!r || r.outcome !== 'done') return r || { outcome: 'failed', reason: 'no answer' };
      }
      return { outcome: 'done' };
    },
  };
}

/*
 * Start New Session in This Group. Codex cannot start a conversation inside a section, so the new conversation is moved
 * there after its first message, once it appears in the snapshot. check() runs on each redraw of the list and
 * takes the oldest ungrouped conversation created since start(), preferring one that a panel in this window shows; it
 * stops looking after PLACE_MS. `threads()` returns the snapshot, `shown()` the conversations this window's panels show,
 * and `move(ids, sectionId)` is createGroups().move.
 */
const PLACE_MS = 30 * 60e3;
function createPlacer({ threads, shown, move, now = Date.now }) {
  let pending = null;
  return {
    start(sectionId) { pending = sectionId ? { sectionId, at: now() } : null; },
    pending: () => pending,
    /* Resolves to the move's answer when a conversation was placed, else null. */
    check() {
      if (!pending) return Promise.resolve(null);
      if (now() - pending.at > PLACE_MS) { pending = null; return Promise.resolve(null); }
      const since = pending.at - 2000;
      const fresh = (threads() || []).filter((t) => t.kind === 'user' && !t.archived && !t.section && t.createdMs >= since)
        .sort((a, b) => a.createdMs - b.createdMs);
      if (!fresh.length) return Promise.resolve(null);
      let here = [];
      try { here = shown() || []; } catch (_) { here = []; }
      const pick = fresh.find((t) => here.includes(t.id)) || fresh[0];
      const { sectionId } = pending;
      pending = null;
      return Promise.resolve(move([pick.id], sectionId)).then((r) => ({ thread: pick.id, sectionId, ...r }));
    },
  };
}

module.exports = { createGroups, createPlacer, ordered, cleanName, PINNED_SECTION, ORDER_KEY, NAME_MAX, GROUPS_MAX, PLACE_MS };
