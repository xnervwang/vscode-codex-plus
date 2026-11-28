# Contributing

## Layout

- `extension.js`: activation, settings, commands; wires the parts below together.
- `src/codex-files.js`: CODEX_HOME, the state database (read-only), rollouts (plain or `.jsonl.zst`), read receipts. Blocking; runs in the worker.
- `src/codex-worker.js`, `src/codex-reader.js`: the worker thread that reads Codex's files, and the snapshot the extension host reads instead.
- `src/left-running.js`: finds what a conversation started that is still running after its turn (a background command in Codex, a detached shell, a `codex exec`, `claude -p` or `claude --bg` it started), from /proc, Claude Code's session records and the launching conversation's rollout. Blocking; runs in the worker. The windows share one reading of /proc through `shared/left-running.json` in the plan directory, `$CODEX_HOME/plugins/data/agent-work-plan-codex-extras/`.
- `src/codex-tabs.js`: Codex conversation tabs (`chatgpt.conversationEditor`, `openai-codex://route/local/<id>`), opening one in a tab. A tab Codex opened with its own New button stays at `/extension/panel/new` and names no conversation; the patch supplies the missing conversation ids (`patching.panelThreads`), from the thread start of the tab's own page.
- `src/folders.js`: whether a conversation's folder is in this window's workspace, by real path.
- `src/codex-source.js`: Codex as a source of Agent Plus, protocol 1, defined in Agent Plus's `docs/protocol.md`.
- `src/host-link.js`: finding Agent Plus's `agentPlus` interface, registering, the `codexPlus.registered` key.
- `src/workplan.js`: plan files: the states and limits they share with the plugin and Agent Plus, and the sweep of plans whose conversation is gone.
- `src/logo-dot.js`: Codex's logo with an activity dot or ring, for the tab icons.
- `src/title-marks.js` (from Agent Plus): the envelope for a reply not seen, kept out of a conversation's name and drawn once after its title; `src/envelope.js` (from Agent Plus) picks its form for the colour theme.
- `src/plan-bars.js`: the host side of the plan bar above the message box. It asks Agent Plus for each conversation's plan summary, keeps it until Agent Plus reports a change, and runs the two commands behind the bar's clicks (`agentPlus.showWorkPlanOf` and `agentPlus.answerQuestionOf`); `src/page/plan-bar.js` (from Agent Plus) draws the bar in Codex's page.
- `src/session-list-source.js`: Codex's part of Agent Plus's session list: each conversation as an entry of the session list's protocol (Agent Plus `docs/protocol.md`), the one-time import of archived conversations, sections and pins from Codex's own list, and Codex's part of the session list's Account & usage section; `src/writer-locks.js`: which process holds a conversation open, from Codex's writer locks; `src/git-worktrees.js`: the linked git worktrees whose conversations the session list also takes in; `src/tab-memory.js`, `src/session-info.js`: recently closed tabs and tabs VS Code dropped when a remote window reconnects, session information; `src/account-usage.js`: Account & usage.
- `src/archive-sweep.js`: deleting the conversations archived longer than `codexPlus.deleteArchivedAfterDays`, by one window a day, with its state file and lock folder in this extension's global storage.
- `src/agent-map.js`: each conversation's Agent map (its wake-up, goal and sub-agents) from the snapshot, which the page script draws as Claude Code's pill and dialog; `src/wakeup.js` lists the wake-ups for the worker and removes one.
- `src/appserver.js`: a short-lived `codex app-server` client.
- `src/plugin-install.js`: installing, trusting and removing the companion plugin through app-server.
- `codex-plugin/`: the companion Codex plugin (marketplace `codex-extras`, plugin `agent-work-plan`): hooks, skill, MCP server.
- `src/edits.js`, `src/host.js`, `src/webview-inject.js`, `src/manifest.js`, `src/adapters.js`, `src/patching.js`, `uninstall.js`, `src/uninstall-plan.js`: the patch to Codex and its use, and which editors' Codex an uninstall puts back.
- `src/page/codex-extras-page.js`: the script added to Codex's page; it also takes the layout sample (the structure of the conversation's DOM, with none of its text) for the render check, since the page is where Codex's run-time structure exists at all.
- `docs/codex-page.md`: what the page script looks for in Codex's page before it draws there, and how to see what it found.
- `test/render/`: the render check ([The render check](#the-render-check)): stand-ins for VS Code and Codex's host in the page, an offline app-server, a made-up conversation, and the measurements.
- `test/vscode/`: what the `.github/workflows/vscode.yml` workflow runs: `run.js` (the runner), `ui.js` (the window, driven through Playwright), `suite/` (checks inside VS Code), `helper/` (the vscode API for `ui.js`), `lib/`, `baseline/<platform>/` (the approved crops) and `update-baseline.js`; `readme-shots.js`, which takes the README's screenshots and is not run by the workflow.
- `src/open-times.js`: how long Codex's pages took to open, from the `app_start` spans Codex writes to its own `Codex.log`, or from its `app routes mounted` line in a log with no span.
- `images/codex-light.svg`, `images/codex-dark.svg`: the tab bar button, the Codex mark from `images/icon.svg`.

## Checks

- `node test/check.js`: the whole suite, no dependencies; parts in `test/parts/`, run in name order.
- `node test/e2e-codex.js <codex> <CODEX_HOME>`: the work plan against a real codex; needs model credentials.
- `node test/against-latest.js`: the patch against the newest Codex on the marketplace (`CODEX_EXTRAS_PRERELEASE=1` for pre-releases), and that build's app-server requests and question tool names against `src/protocol-known.js`.
- `node test/render/run.js [--out <dir>] [--only <scene>]`: Codex's real page with the page script in it, drawn in a headless Chromium against Codex's app-server offline, with what only a drawn page shows asserted; once per new Codex build. Needs a headless Chromium, `unshare -rn` and an installed Codex, and says which is missing otherwise ([The render check](#the-render-check)).
- `node test/vscode/run.js <.vsix> [<Agent Plus .vsix>] [--out <dir>] [--vscode <executable>] [--local]`: runs this extension with the newest VS Code, and the newest Codex listed in `src/supported-versions.json` (`CODEX_PLUS_UI_CODEX` names another), in a real window, checks what the window shows, and compares crops of this extension's elements with `test/vscode/baseline/<platform>/`. It refuses to run where `CI` is not `true` unless given `--local`; every home folder it uses is a new one under the system's temporary folder. Needs `@vscode/test-electron` and `playwright-core` (`npm install --no-save --no-package-lock`), and on Linux a display. When a change to what the extension draws is intended, `node test/vscode/update-baseline.js <its --out, or a CI artifact>` copies the run's crops over the approved ones; the person merging looks at every crop and diff first.
- `node test/vscode/run.js <.vsix> <Agent Plus .vsix> --out <dir> --local --look`: the look run, on a development machine only. It walks every feature in `test/vscode/ui-look-features.json` and writes a close view and a whole-window screenshot of each step, with `look.json`, to `<dir>`. Nothing in it passes or fails; give `<dir>` and `test/vscode/LOOK.md` to a reviewer who has not seen the change. `test/parts/77-ui-look-features.js` checks that the feature list covers every setting and command, and every one of Agent Plus's against the Agent Plus it finds.
- `test/parts/45-core.js`: this extension and Agent Plus together; needs its checkout beside this one, or `AGENT_WORK_PLAN_DIR`.
- `node test/against-core.js`: the protocol major against the newest Agent Plus on the marketplace.
- `bash build/pack.sh`: runs the suite and builds the `.vsix`.
- `xvfb-run -a -s "-screen 0 3200x2000x24" node test/vscode/readme-shots.js --pack <demo pack> --vsix <.vsix> [--core <Agent Plus .vsix>] [--out <dir>] [--cache <dir>] [<shot> ...]`: takes the README's screenshots in `images/shots/` from a demo pack (a demo project and demo Codex conversations, which `pack.json` names), in a VS Code whose homes are all under `/tmp/codex-plus-demo`. Needs `@vscode/test-electron` and `playwright-core`, as `run.js` does. Look at every shot, and check that the copied records under `/tmp/codex-plus-demo` hold no path of your own home, before committing them.
- `node build/plan-health.js [--days N] [--home <CODEX_HOME>] [--json]`: over the plans written in the last N days (14 by default), how many of their rows are stale (`doing` while the conversation is running no turn) or incomplete (`waiting` without saying on whom). It counts rather than passing or failing, so run it before and after a change with the same `--days`. It stays in `build/`, which `pack.sh` does not copy, because it reads a person's plans.

### On CI

`.github/workflows/` contains the three workflows below and the release publishing workflow, `release.yml`. `test/parts/66-workflows.js` checks all four, and runs the shell of `against-latest.yml`'s step (below) against a stand-in `node`.

| | |
| --- | --- |
| `check.yml` | The suite, on every push to main, every pull request and once a day, on Node 22 and Node 24, with Agent Plus checked out beside this repository so `test/parts/45-core.js` runs. Pushes and pull requests use the commit named in `.github/agent-plus-commit`. The daily run uses Agent Plus's newest commit, so a change on Agent Plus's main that breaks this extension shows up within a day without failing push checks against the pinned commit. Both, because `node:sqlite` is behind a flag in one and not the other and `test/check.js` re-execs itself with the flag only when it has to. A runner has no Codex installed, so three checks report themselves as not run; the suite's last line counts those separately and the rest still pass. |
| `against-latest.yml` | `test/against-latest.js` once a day, and on demand. This is the check that can go red with nothing here having changed: Codex ships a build a required edit no longer fits (see [Verified Codex builds](#verified-codex-builds)), and the patch then quietly does nothing for everyone who updates. |
| `vscode.yml` | `test/vscode/run.js` on Linux, macOS and Windows once a day, before each release and on demand. `release.yml` calls `vscode.yml` and publishes only after every step passes. A push or a pull request runs `check.yml` only. Each system runs the window test in shards side by side, each starting at a step named in `SHARD_STARTS` in `test/vscode/ui.js`, and keeps the results folder of each as an artifact, with a `state/` folder holding the window's HTML and text for every step that failed. Before a release, `vscode.yml` builds against the Agent Plus commit named in `.github/agent-plus-commit` and installs the newest Codex version listed in `src/supported-versions.json`. The daily run uses Agent Plus's newest commit and the latest Codex release. If it fails, the failure message says how to tell whether the newer Agent Plus or the newer Codex caused it. For a manual run, set `os` to one system or `all`. Use `steps` to match the names of window test steps in `test/vscode/ui.js` with a regular expression. Only the matching steps and their dependencies run, in one job per system. To find out which update caused a daily failure, set either `agent_plus` or `codex` to `latest`, leaving the other at its default (`agent_plus` `pinned`, `codex` `supported`), and test one update at a time. Only the Linux crops have approved copies so far, made on a development machine; macOS and Windows runs save their crops without comparing them until someone approves a set from a CI run. On Linux the window runs in a namespace with loopback only; macOS and Windows get only a proxy that does not exist. |

- The step of `against-latest.yml` is red for exit 1 (an edit no longer fits, or a patched file no longer parses) **and** for any other non-zero code (the check did not run), with a different annotation for each. A step that passes whatever happened reads the same as one that keeps working, and a scheduled check is the kind nobody looks at until it matters.
- Exit 1 also opens an issue titled with the Codex version, quoting the failing lines of the check's report and linking the run. Each Codex version has at most one issue. Later failures on that version reuse the issue, reopening it if it was closed. When the check passes on that version, the workflow closes the issue with a comment naming the commit the check passed on. If the check cannot run (exit 2), the workflow does not open, close or comment on any issue. On a manual run with `issue_preview` set, the workflow makes no issue changes. It records what it would have done in the run summary.
- A Codex release merely absent from `src/supported-versions.json` prints as a note and does not fail, which is `against-latest.js`'s own decision: the edits fitting a build is not the whole of what that file claims.
- `CODEX_PLUS_UI_STEPS` (a regular expression of step names) and `CODEX_PLUS_UI_SHARD` (`k/n`, the k-th of n shards) pick the steps `run.js` takes locally too. In `ui.js`, a step that depends on an earlier step must name it in `STEP_NEEDS`. This includes dependencies on variables the earlier step set or conversations it opened. Without that entry, the dependent step fails when run alone or in a later shard.
- To move to a newer Agent Plus, run `vscode.yml` by hand with `agent_plus` `latest`, and once it passes write the Agent Plus commit that run used into `.github/agent-plus-commit`. A Codex release is taken on once it has an entry in `src/supported-versions.json` (see [Verified Codex builds](#verified-codex-builds)).
- To test a fix or a new or changed window test step, push the change to a branch other than `main`. Run `vscode.yml` by hand on that branch. Set `steps` to match the steps the change touches. Use `os` to run each system those steps need once. Once that passes, merge it. The daily run and the run before each release take every step. If a step fails in one of those, rerun only that job, once, with GitHub's "Re-run failed jobs" button. If it fails again, treat it as a real failure.
- To test a change to `vscode.yml` itself, push it to a branch and start a manual run there so GitHub uses that branch's version of the workflow.

## Verified Codex builds

Everything this extension adds to Codex depends on the exact shape of one build, and Codex ships weekly. The patch matches a fixed set of places in Codex's own bundle and one in its `package.json`, the page script (the script this extension adds to Codex's page) selects elements by Codex's `data-*` attributes, and the conversation list reads columns out of Codex's state database.

- The builds each release was checked against are recorded in `src/supported-versions.json`, with the date and what was checked on each.
- `Codex Plus: Show Status` says whether the installed build is one of them. An unrecorded build is also noted in one line of the Codex Plus output channel; it does not open a dialog.
- An unrecorded build is still patched if every place the patch requires is found in it. If one is not, the patch leaves Codex untouched and says so in the status. The optional `new conversation tabs` edit (each tab Codex's New Codex Agent command opens gets an address of its own) is the exception: a build that has every required place but not this one is patched with the other edits, and `test/against-latest.js` reports that build as a failure.

Add an entry after checking a build; the suite then keeps that entry in step with the code.

- `test/parts/70-supported.js` compares each entry's three lists against the places they are read from: the patch's own rule names, the columns `src/codex-files.js` queries, and the `data-*` attributes `src/page/codex-extras-page.js` looks for. So a new column or a new attribute fails the suite until some build with it has been checked and recorded.
- It also fails when the Codex installed here is not in the record, which is how an upgrade gets noticed.
- Drop a build once it is no longer installed, rather than carrying it forward. `git log -S<version> -- src/supported-versions.json` finds the commits that claimed it. Keep the build that the layout sample in `test/fixtures/` was taken from, though: `test/parts/70-supported.js` fails if the record does not name it.
- When you add a build to `src/supported-versions.json` with `new conversation tabs` in its `hostEdits`, the list of host edits checked on it, copy that build's `createNewPanel` method from its `out/extension.js`, exactly as shipped, into `SHIPPED` (one entry per build, keyed by its version) in `test/parts/39b-codex-new-panel.js`, which fails until you do.

## The render check

- `test/render/run.js` draws Codex's real conversation page, from the installed Codex extension, with this repository's page script in it, and checks what can only be seen in a drawn page.
- It is not part of the main test suite (`test/check.js`) and not in the package.

```sh
node test/render/run.js [--out <dir>] [--codex <Codex extension folder>] [--only <scenes>]
```

| | |
| --- | --- |
| When to run it | Once for every new Codex build, before adding it to `src/supported-versions.json`, and after a change to how the page script draws |
| What it draws | A made-up conversation, in eight states: four turns at 1100, 400 and 1600 pixels wide; a turn stopped on an approval; a command still running in the background with Codex's own context meter on; a chime before and after a click in the page; 25 turns over two days; Codex's model menu and conversation menu open. |
| What it asserts | The page script finds the conversation and draws a time on every message; nothing of this extension's overlaps Codex's bubbles, buttons, message box, approval card, context meter or tool rows; nothing of Codex's is in the rail's column; the row below the message box is 2 px below the box's frame, with no background, its glyphs no taller than Codex's toolbar icons; Codex's own reply time is hidden where ours is drawn; an approval card is reported; nothing of ours is over Codex's menus. |
| What it writes | Screenshots in `<out>/shots`, the measurements in `<out>/results.json`, and the page script's layout sample of the drawn page (see [Sampling a conversation's layout](docs/codex-page.md#sampling-a-conversations-layout)) in `<out>/layout-sample.json`; the run prints the `data-*` names it does not share with the fixture in `test/fixtures/`. `<out>` is a new folder in the system's temporary folder unless given |
| What it needs | A headless Chromium (Playwright's `chromium_headless_shell`, or `CHROME`), `unshare -rn` for an unprivileged user, and an installed Codex extension. Without one of them it says which and exits 0 |
| What leaves the machine | Nothing. The browser fails every request not to `127.0.0.1` and the run prints how many it failed; Codex's app-server runs in a namespace with no network. Codex's installed files are only read |
| How long | About four minutes: each scene starts Codex's app-server and loads Codex's page afresh. `--only narrow,approval` runs some of them (`conversation`, `narrow`, `wide`, `approval`, `background`, `compact`, `chime`, `long`) |

- A new Codex build may need the stand-ins updated (`test/render/harness/`): they answer the page's host services and its app-server requests the way Codex's host does.
- The browser keeps its own autoplay rule, as Codex's webview does: an audio context made before anyone clicked or typed in the page stays suspended. The `chime` scene checks that a chime then reports `suspended` to the host and plays nothing, and that after one click (`Input.dispatchMouseEvent`) the next chime runs in a running context and starts its oscillators. With the rule turned off, as it once was, the check before the click could not fail, and a chime nobody hears passed.
- `test/against-latest.js`, run once a day against the newest Codex in the marketplace, also holds that build to `src/protocol-known.js`: every request its app-server can make of its client, listed by its own `codex app-server generate-json-schema`, and every `request_user_input…` name in its page. Each is marked handled or left alone on purpose, and one marked neither way fails the check, printed by name. A question tool that is not an app-server request, as `request_user_input_async` is, is invisible to a check that knows only the requests.
- `test/parts/52a-known-protocol.js` checks that what those lists mark handled is recognised by the code they name, and compares them with the installed Codex when there is one.

## Cost budget

This extension aims to give what the Claude Code extension plus Agent Plus gives, for no more CPU and memory than that is worth. A feature whose data is already in the snapshot is worth adding; one that would need a wider read is not.

All file reading is in one thread:

- Every file read is in the worker thread (`src/codex-worker.js`): the state database, rollouts, read receipts, plan files.
- The extension host's own thread reads only the snapshot in memory (`src/codex-reader.js`). Drawing a view reads no file.
- The one exception is Codex's own log (`src/open-times.js`): read with `fs.promises` in the extension host, only when `Show Status` or its own command runs, each file from where it was last read.

What bounds a single pass:

| Constant | Value | What it bounds |
| --- | --- | --- |
| `POLL_MS` (`src/codex-source.js`) | 3000 ms | How often a snapshot is asked for |
| `STATE_WINDOW_MS` (`src/codex-worker.js`) | 2 days | Only threads touched this recently have their rollout read |
| `STAMP_WINDOW_MS` (`src/codex-worker.js`) | 1 day | Only rollouts this recent are `stat`ed to build the stamp, the fingerprint a pass compares to see whether anything moved |
| `COMPRESSED_MAX` (`src/codex-files.js`) | 64 MB | Largest `.jsonl.zst` read at all |
| `DECOMPRESSED_MAX` (`src/codex-files.js`) | 256 MB | Largest decompressed rollout; compressed rollouts are decompressed once per read, however far back in the file the latest turn starts |
| `STATES_KEPT` (`src/codex-files.js`) | 500 | Rollout states the worker keeps between snapshots. The worker skips a rollout file if it has not changed since the last read and its change time was at least `SETTLED_MS` (2 s, the coarsest file-time tick) old at that read |
| `HELD_MAX` (`src/codex-reader.js`) | 200 | Conversation states retained after an on-demand read |
| `SUBAGENT_WINDOW_MS` (`src/codex-worker.js`) | 2 hours | Sub-agents updated this recently have their rollout read, so their conversation can show one of them still running |
| `LEFT_EVERY_MS` (`src/left-running.js`) | 10 s | Shortest time between two scans for what conversations left running; each scan reads /proc and Claude Code's session records once, with a single read call per stat file, and reads a process's environ the first time it sees that process |
| `SHARE_MS` (`src/left-running.js`) | 9 s | Maximum age of a scan written by another editor window that can be reused instead of reading /proc |
| `DAY_MS` (`src/archive-sweep.js`) | 1 day | How often a window tries the pass that deletes old archived conversations, checked on the poll rather than on a timer; the pass reads the snapshot and one small state file, and only the window holding the lock runs it |
| `RETRY_MS` (`src/archive-sweep.js`) | 1 hour | How soon a window tries that pass again after one it could not run: another window held the lock, or which conversations are open was not known |
| `LAUNCH_TAIL` (`src/left-running.js`) | 8 MB | How much of a rollout's end the first read for `claude --bg` launches covers; later reads take only what was appended. A rollout is read for this only while such a session is busy |

What a change must not break:

- Do not widen `STATE_WINDOW_MS` or `STAMP_WINDOW_MS` to put a status dot on an old conversation. A conversation whose rollout was not read shows no dot (`STATE_LOOK.unknown`); its state is read only once Agent Plus's session list shows its row (`wantSessionDetail`, `source.wantState`), and kept afterwards (`reader.held`).
- Grouping, sorting and filtering are arithmetic over the snapshot. `listThreads` already returns every thread in one query, so grouping by folder costs no I/O; when SQLite's `data_version` on the same connection shows no commits to the state database since the last query, `listThreads` returns the cached list without another database read.
- The poll keeps its cadence and its short circuit: the worker builds the stamp first and returns `same` without parsing a rollout when nothing moved.
- No new timer and no file watcher. Repeating work goes on the existing poll, and a one-off read forces a single pass (`refresh({ force: true })`) rather than scheduling one.
- No click, hover, key or expanded group does more than about 100 ms of synchronous work, in the extension host or in a page. Anything that has to be scanned is bounded, incremental and in the worker. An action that reads a file or sends a request (Account & usage, a rename or a delete for the session list) is asynchronous, has a time limit, and says when it failed.
- Sampling the conversation layout runs only when the command asks for it. The page script adds no timer and no `MutationObserver` for it, and walks the page once per request within `MAX_NODES` and `MAX_DEPTH`. The host's only timer for it is the one timeout on that request, cleared as soon as either side finishes.

## Rules

- `package.json` `version` changes only for a release.
- Code, comments and commit messages are English; every source file starts with the BSD 3-Clause header.
- The page script never puts a node inside one Codex draws.
- Every required patch edit matches exactly once on a pristine Codex build, or nothing is written. The optional `new conversation tabs` edit is tried only once all of them match.
- Every name the edits in `src/host.js` declare inside Codex's code starts with `cxp` and an upper-case letter (`LOCAL_PREFIX`), so that it cannot hide one of Codex's minified names. `test/parts/50c-patch-local-names.js` checks this rule.
