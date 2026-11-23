// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * keepsShared() decides whether a window notes and sends the ends of work left running, and wake-ups. A window whose
 * build was installed over keeps them while no live window says it runs the installed build, so that they are not left
 * undone, and then sent hours late, while every window still runs an earlier build.
 */
const fs = require('fs');
const path = require('path');

module.exports = ({ ok, bad, eq, tmp, root }) => {
  const plan = require('../../src/uninstall-plan');
  const entries = require('../../src/window-entries');
  if (typeof plan.keepsShared !== 'function') { bad('src/uninstall-plan.js has no keepsShared'); return; }
  const keeps = plan.keepsShared;

  eq(keeps({ standing: '', build: '1' }, [{ installed: true, build: '2' }]), true, 'a window running the installed build keeps them');
  eq(keeps({ standing: 'replaced', build: '1' }, []), true, 'one whose build was installed over keeps them while no other window is open');
  eq(keeps({ standing: 'replaced', build: '1' }, [{ installed: false, build: '1' }, {}]), true,
    'and while the others are also replaced, or say nothing, as a window of a build older than this rule does');
  eq(keeps({ standing: 'replaced', build: '1' }, [{ installed: true, build: '2' }]), false, 'it leaves them once a window says it runs the installed build');
  eq(keeps({ standing: 'replaced', build: '1' }, [{ installed: true, build: '1' }]), true,
    'an entry claiming the installed build that is this window\'s own build is not believed, being written before that window\'s next pass');
  eq(keeps({ standing: 'replaced', build: '' }, [{ installed: true, build: '' }]), false, 'a window that does not know its own build believes the entry');
  eq(keeps({ standing: 'uninstalling', build: '1' }, []), false, 'a window being uninstalled never keeps them');
  eq(keeps({ standing: 'replaced', build: '1' }, null), true, 'no list of entries counts as none');

  try {
    const dir = tmp('keeps-shared');
    const pidOf = { a: 2147480001, b: 2147480002 };
    const alive = (pid) => pid === pidOf.a || pid === pidOf.b;
    const write = (pid, more) => entries.publisher(dir, () => Object.assign({ name: 'w', folders: [], sessions: [] }, more), { pid })();
    write(pidOf.a, { build: '1', installed: false });
    let others = entries.others(dir, { self: 1, alive });
    eq(others.map((w) => [w.build, w.installed]), [['1', false]], 'the entry a window writes carries its build and whether it is the installed one');
    eq(keeps({ standing: 'replaced', build: '1' }, others), true, 'read back from the windows folder, another replaced window leaves this one keeping them');
    write(pidOf.b, { build: '2', installed: true });
    others = entries.others(dir, { self: 1, alive });
    eq(keeps({ standing: 'replaced', build: '1' }, others), false, 'a window of the installed build, once its entry is written, takes them over');
  } catch (e) { bad(`keepsShared over window entries: ${(e && e.stack) || e}`); }

  const ext = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  eq(/const endsOn = \(\) => runs\('detachedEndNotices'\) && trusted\(\) && keepsShared\(\);/.test(ext), true,
    'the end notices of detached commands and claude --bg sessions follow it');
  eq(/scanLeft: \(\) => keepsShared\(\) && /.test(ext), true, 'so does the scan for work left running');
  eq(/enabled: \(\) => runs\('wakeUps'\) && trusted\(\) && keepsShared\(\)/.test(ext), true, 'and the wake-ups');
  eq(/uninstallPlan\.keepsShared\(\{ standing: s, build: String\(loadedStamp/.test(ext), true, 'asked with this window\'s install stamp as its build');
  eq(/build: String\(loadedStamp \|\| ''\), installed: !standsDown\(\) \}/.test(ext), true, 'which its own entry carries, with whether it is the installed one');
  ok('which window keeps the end notices and wake-ups is checked');
};
