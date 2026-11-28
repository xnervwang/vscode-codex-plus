// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex answers "no rollout found" for an archived conversation, which is then unarchived, renamed and archived again;
 * test/parts/35v-thread-archive-codex.js checks the same with Codex itself.
 */
const path = require('path');

const ID = '01a1b8e8-f7e2-7251-95a9-a95b65992841';
const GONE = `no rollout found for thread id ${ID}`;

module.exports = async ({ eq, root }) => {
  const { renameThread } = require(path.join(root, 'src', 'thread-rename.js'));
  const asker = (answers) => {
    const asked = [];
    const left = Object.fromEntries(Object.entries(answers).map(([m, list]) => [m, [...list]]));
    const ask = async (method, params) => { asked.push([method, params]); return (left[method] || []).shift() || { outcome: 'failed', reason: `nothing scripted for ${method}` }; };
    return { ask, asked };
  };
  const done = { outcome: 'done' };
  const methods = (asked) => asked.map((a) => a[0]);

  let a = asker({ 'thread/name/set': [done] });
  eq([await renameThread(a.ask, ID, 'New'), a.asked], [done, [['thread/name/set', { threadId: ID, name: 'New' }]]],
    'a conversation that is not archived is renamed with one thread/name/set');

  a = asker({ 'thread/name/set': [{ outcome: 'failed', reason: GONE }, done], 'thread/unarchive': [done], 'thread/archive': [done] });
  eq([await renameThread(a.ask, ID, 'New'), methods(a.asked), a.asked[2][1]],
    [done, ['thread/name/set', 'thread/unarchive', 'thread/name/set', 'thread/archive'], { threadId: ID, name: 'New' }],
    'an archived one, which Codex says it has no rollout for, is taken out of the archive, renamed and archived again');

  a = asker({ 'thread/name/set': [{ outcome: 'failed', reason: GONE }], 'thread/unarchive': [{ outcome: 'failed', reason: 'locked' }] });
  let r = await renameThread(a.ask, ID, 'New');
  eq([r.outcome, /did not take this one out of the archive: locked$/.test(r.reason), methods(a.asked)], ['failed', true, ['thread/name/set', 'thread/unarchive']],
    'when Codex does not take it out of the archive, nothing more is asked and the answer says why');

  a = asker({ 'thread/name/set': [{ outcome: 'failed', reason: GONE }, { outcome: 'failed', reason: 'bad name' }], 'thread/unarchive': [done], 'thread/archive': [done] });
  r = await renameThread(a.ask, ID, 'New');
  eq([r, methods(a.asked).pop()], [{ outcome: 'failed', reason: 'bad name' }, 'thread/archive'],
    'when the second thread/name/set fails, the conversation is still archived again, and the answer gives Codex\'s reason');

  a = asker({ 'thread/name/set': [{ outcome: 'failed', reason: GONE }, { outcome: 'failed', reason: 'bad name' }], 'thread/unarchive': [done],
    'thread/archive': [{ outcome: 'failed', reason: 'busy' }] });
  r = await renameThread(a.ask, ID, 'New');
  eq([r.outcome, /^bad name; it is no longer archived, as Codex did not archive it again: busy$/.test(r.reason)], ['failed', true],
    'and when that archive fails too, the answer says the conversation is no longer archived');

  a = asker({ 'thread/name/set': [{ outcome: 'failed', reason: GONE }, done], 'thread/unarchive': [done], 'thread/archive': [{ outcome: 'failed', reason: 'busy' }] });
  r = await renameThread(a.ask, ID, 'New');
  eq([r.outcome, r.reason], ['failed', 'it was renamed, but Codex did not archive it again: busy'],
    'renamed but not archived again is a failure that says so');

  a = asker({ 'thread/name/set': [{ outcome: 'failed', reason: 'thread is busy' }] });
  eq([await renameThread(a.ask, ID, 'New'), methods(a.asked)], [{ outcome: 'failed', reason: 'thread is busy' }, ['thread/name/set']],
    'any other refusal is passed on without touching the archive');

  a = asker({ 'thread/name/set': [{ outcome: 'sent' }] });
  eq(await renameThread(a.ask, ID, 'New'), { outcome: 'failed', reason: 'Codex did not answer' }, 'a request Codex did not answer is a failure saying so');
};
