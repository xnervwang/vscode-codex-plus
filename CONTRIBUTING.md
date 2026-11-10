# Contributing

## Layout

- `extension.js`: activation, settings, commands; wires the parts below together.
- `src/codex-files.js`: CODEX_HOME, the state database (read-only), rollouts (plain or `.jsonl.zst`), read receipts. Blocking; runs in the worker.
- `src/codex-worker.js`, `src/codex-reader.js`: the worker thread that reads Codex's files, and the snapshot the extension host reads instead.
- `src/codex-tabs.js`: Codex conversation tabs (`chatgpt.conversationEditor`, `openai-codex://route/local/<id>`), opening one in a tab. A tab Codex opened with its own New button stays at `/extension/panel/new` and names no conversation; the patch supplies the missing conversation ids (`patching.panelThreads`), from the thread start of the tab's own page.
- `src/folders.js`: whether a conversation's folder is in this window's workspace, by real path.
- `src/codex-source.js`: Codex as a source of Agent Plus, protocol 1, defined in Agent Plus's `docs/protocol.md`.
- `src/host-link.js`: finding Agent Plus's `agentPlus` interface, registering, the `codexPlus.registered` key.
- `src/workplan.js`: plan files: the states and limits they share with the plugin and Agent Plus, and the sweep of plans whose conversation is gone.
- `src/logo-dot.js`: Codex's logo with a state dot, for the tab icons.
- `src/sessions-view.js`, `src/tab-memory.js`, `src/session-info.js`, `src/session-groups.js`: the Codex sessions view, recently closed and dropped tabs, session information, the groups (Codex's sections) and their order.
- `src/appserver.js`: a short-lived `codex app-server` client.
- `src/plugin-install.js`: installing, trusting and removing the companion plugin through app-server.
- `codex-plugin/`: the companion Codex plugin (marketplace `codex-extras`, plugin `agent-work-plan`): hooks, skill, MCP server.
- `src/edits.js`, `src/host.js`, `src/webview-inject.js`, `src/adapters.js`, `src/patching.js`, `uninstall.js`, `src/uninstall-plan.js`: the patch to Codex and its use, and which editors' Codex an uninstall puts back.
- `src/page/codex-extras-page.js`: the script added to Codex's page; it also takes the layout sample (the structure of the conversation's DOM, with none of its text) for the render check, since the page is where Codex's run-time structure exists at all.
- `test/render/`: the render check (README, The render check): stand-ins for VS Code and Codex's host in the page, an offline app-server, a made-up conversation, and the measurements.
- `src/open-times.js`: how long Codex's pages took to open, from the `app_start` spans Codex writes to its own `Codex.log`.
- `images/codex-light.svg`, `images/codex-dark.svg`: the tab bar button, the Codex mark from `images/icon.svg`.

## Checks

- `node test/check.js`: the whole suite, no dependencies; parts in `test/parts/`, run in name order.
- `node test/e2e-codex.js <codex> <CODEX_HOME>`: the work plan against a real codex; needs model credentials.
- `node test/against-latest.js`: the patch against the newest Codex on the marketplace (`CODEX_EXTRAS_PRERELEASE=1` for pre-releases), and that build's app-server requests and question tool names against `src/protocol-known.js`.
- `node test/render/run.js [--out <dir>] [--only <scene>]`: Codex's real page with the page script in it, drawn in a headless Chromium against Codex's app-server offline, with what only a drawn page shows asserted; once per new Codex build. Needs a headless Chromium, `unshare -rn` and an installed Codex, and says which is missing otherwise (README, The render check).
- `test/parts/45-core.js`: this extension and Agent Plus together; needs its checkout beside this one, or `AGENT_WORK_PLAN_DIR`.
- `node test/against-core.js`: the protocol major against the newest Agent Plus on the marketplace.
- `bash build/pack.sh`: runs the suite and builds the `.vsix`.
- `node build/plan-health.js [--days N] [--home <CODEX_HOME>] [--json]`: over the plans written in the last N days (14 by default), how many of their rows are stale (`doing` while the conversation is running no turn) or incomplete (`waiting` without saying on whom). It counts rather than passing or failing, so run it before and after a change with the same `--days`. It stays in `build/`, which `pack.sh` does not copy, because it reads a person's plans.

### On CI

Two workflows in `.github/workflows/`. **Neither has ever run: this repository has not been pushed anywhere**, so they are checked only by `test/parts/66-workflows.js`, which runs the scheduled one's own shell against a stand-in `node`.

| | |
| --- | --- |
| `check.yml` | The suite, on every push to main, every pull request and once a day, on Node 22 and Node 24, with Agent Plus checked out beside this repository so `test/parts/45-core.js` runs; the daily run brings a change to Agent Plus's main that breaks this one to light within a day. Both, because `node:sqlite` is behind a flag in one and not the other and `test/check.js` re-execs itself with the flag only when it has to. A runner has no Codex installed, so three checks report themselves as not run; the suite's last line counts those separately and the rest still pass. |
| `against-latest.yml` | `test/against-latest.js` once a day, and on demand. This is the check that can go red with nothing here having changed: Codex ships a build an edit no longer fits, and the patch then quietly does nothing for everyone who updates. |

- The scheduled step is red for exit 1 (an edit no longer fits, or a patched file no longer parses) **and** for any other non-zero code (the check did not run), with a different annotation for each. A step that passes whatever happened reads the same as one that keeps working, and a scheduled check is the kind nobody looks at until it matters.
- A Codex release merely absent from `src/supported-versions.json` prints as a note and does not fail, which is `against-latest.js`'s own decision: the edits fitting a build is not the whole of what that file claims.

## Verified Codex builds

`src/supported-versions.json` records which Codex builds a commit was checked against, the date, and what was checked. Add an entry after checking a build; the suite then keeps that entry in step with the code.

- `test/parts/70-supported.js` compares each entry's three lists against the places they are read from: the patch's own rule names, the columns `src/codex-files.js` queries, and the `data-*` attributes `src/page/codex-extras-page.js` looks for. So a new column or a new attribute fails the suite until some build with it has been checked and recorded.
- It also fails when the Codex installed here is not in the record, which is how an upgrade gets noticed.
- Drop a build once it is no longer installed, rather than carrying it forward. `git log -S<version> -- src/supported-versions.json` finds the commits that claimed it.

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
| `DECOMPRESSED_MAX` (`src/codex-files.js`) | 256 MB | Largest decompressed rollout |
| `HELD_MAX` (`src/codex-reader.js`) | 200 | Conversation states retained after an on-demand read |

What a change must not break:

- Do not widen `STATE_WINDOW_MS` or `STAMP_WINDOW_MS` to put a status dot on an old conversation. A conversation whose rollout was not read shows no dot (`STATE_LOOK.unknown`); its state is read only when its group is expanded, and kept afterwards (`SessionsProvider.ask`, `source.wantState`, `reader.held`).
- Grouping, sorting and filtering are arithmetic over the snapshot. `listThreads` already returns every thread in one query, so grouping by folder costs no I/O.
- The poll keeps its cadence and its short circuit: the worker builds the stamp first and returns `same` without parsing a rollout when nothing moved.
- No new timer and no file watcher. Repeating work goes on the existing poll, and a one-off read forces a single pass (`refresh({ force: true })`) rather than scheduling one.
- Sampling the conversation layout runs only when the command asks for it. The page script adds no timer and no `MutationObserver` for it, and walks the page once per request within `MAX_NODES` and `MAX_DEPTH`. The host's only timer for it is the one timeout on that request, cleared as soon as either side finishes.

## Rules

- `package.json` `version` changes only for a release.
- Code, comments and commit messages are English; every source file starts with the BSD 3-Clause header.
- The page script never puts a node inside one Codex draws.
- Every patch edit matches exactly once on a pristine Codex build, or nothing is written.
