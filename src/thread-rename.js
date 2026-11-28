// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Renaming a Codex conversation with the app-server's thread/name/set, which Codex applies only to a conversation whose
 * rollout is under sessions/; for an archived one it answers "no rollout found for thread id". That one is taken out of
 * the archive, renamed and archived again.
 *
 * Codex then records the time of that last archive. A pass of src/archive-sweep.js, which runs only while Agent Plus's
 * session list does not manage archiving, treats the conversation as archived at the rename, which can only put its
 * deletion off. The session list keeps its own archive time.
 */
const NOT_ACTIVE = /^no rollout found for thread id/;

const why = (r) => (r && r.outcome === 'sent' ? 'Codex did not answer' : String((r && r.reason) || 'Codex did not say why'));

/*
 * `ask(method, params)` resolves to { outcome, reason }, as askAppServer in extension.js does. The answer is
 * { outcome: 'done' } or { outcome: 'failed', reason }.
 */
async function renameThread(ask, threadId, name) {
  const first = await ask('thread/name/set', { threadId, name });
  if (first && first.outcome === 'done') return { outcome: 'done' };
  if (!(first && first.outcome === 'failed' && NOT_ACTIVE.test(String(first.reason || '')))) return { outcome: 'failed', reason: why(first) };
  const out = await ask('thread/unarchive', { threadId });
  if (!(out && out.outcome === 'done')) {
    return { outcome: 'failed', reason: `Codex renames only a conversation that is not archived, and did not take this one out of the archive: ${why(out)}` };
  }
  const named = await ask('thread/name/set', { threadId, name });
  const back = await ask('thread/archive', { threadId });
  const archived = !!(back && back.outcome === 'done');
  if (!(named && named.outcome === 'done')) {
    return { outcome: 'failed', reason: `${why(named)}${archived ? '' : `; it is no longer archived, as Codex did not archive it again: ${why(back)}`}` };
  }
  if (!archived) return { outcome: 'failed', reason: `it was renamed, but Codex did not archive it again: ${why(back)}` };
  return { outcome: 'done' };
}

module.exports = { renameThread, NOT_ACTIVE };
