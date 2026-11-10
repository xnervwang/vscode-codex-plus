// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The groups of the Codex session list are Codex's own sections, made, renamed and removed through its app-server's
 * threadSection methods, and a conversation joins or leaves one with thread/section/move. Codex keeps no order for its
 * sections, so the order is kept here, in globalState: a group made here goes last, as in Claude Code's list, and one
 * made elsewhere comes after the ones whose place is known.
 *
 * Codex's built-in Pinned section is where its desktop app puts a pinned conversation. It is not a group the user made,
 * so it is never offered as a place to move to, and it is drawn only while it holds something.
 *
 * Whether this Codex has the methods at all is asked once, with threadSection/list; an app-server that answers
 * `unknown variant` has none of them, and the commands are then not offered.
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
 * `ask(method, params)` resolves to { outcome: 'done', result } or { outcome: 'failed', reason }, as extension.js
 * sends a request; `sections()` is the snapshot's id -> name; `memento` holds the order.
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

module.exports = { createGroups, ordered, cleanName, PINNED_SECTION, ORDER_KEY, NAME_MAX, GROUPS_MAX };
