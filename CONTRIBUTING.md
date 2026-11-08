# Contributing

## Layout

- `extension.js`: activation, settings, commands; wires the parts below together.
- `src/codex-files.js`: CODEX_HOME, the state database (read-only), rollouts (plain or `.jsonl.zst`), read receipts. Blocking; runs in the worker.
- `src/codex-worker.js`, `src/codex-reader.js`: the worker thread that reads Codex's files, and the snapshot the extension host reads instead.
- `src/codex-tabs.js`: Codex conversation tabs (`chatgpt.conversationEditor`, `openai-codex://route/local/<id>`), opening one in a tab.
- `src/codex-source.js`: Codex as a source of Agent Work Plan, protocol 1, defined in Agent Work Plan's `docs/protocol.md`.
- `src/host-link.js`: finding Agent Work Plan's `agentWorkPlan` interface, registering, the `codexExtras.registered` key.
- `src/workplan.js`: plan files (reading, the sweep of plans whose conversation is gone, questions for the chime).
- `src/logo-dot.js`: Codex's logo with a state dot, for the tab icons.
- `src/sessions-view.js`, `src/tab-memory.js`, `src/session-info.js`: the Codex sessions view, recently closed and dropped tabs, session information.
- `src/appserver.js`: a short-lived `codex app-server` client.
- `src/plugin-install.js`: installing, trusting and removing the companion plugin through app-server.
- `codex-plugin/`: the companion Codex plugin (marketplace `codex-extras`, plugin `agent-work-plan`): hooks, skill, MCP server.
- `src/edits.js`, `src/host.js`, `src/webview-inject.js`, `src/adapters.js`, `src/patching.js`, `uninstall.js`: the patch to Codex and its use.
- `src/page/codex-extras-page.js`: the script added to Codex's page.
- `images/codex-light.svg`, `images/codex-dark.svg`: the tab bar button, the Codex mark from `images/icon.svg`.

## Checks

- `node test/check.js`: the whole suite, no dependencies; parts in `test/parts/`, run in name order.
- `node test/e2e-codex.js <codex> <CODEX_HOME>`: the work plan against a real codex; needs model credentials.
- `node test/against-latest.js`: the patch against the newest Codex on the marketplace (`CODEX_EXTRAS_PRERELEASE=1` for pre-releases).
- `test/parts/45-core.js`: this extension and Agent Work Plan together; needs its checkout beside this one, or `AGENT_WORK_PLAN_DIR`.
- `node test/against-core.js`: the protocol major against the newest Agent Work Plan on the marketplace.
- `bash build/pack.sh`: runs the suite and builds the `.vsix`.

## Rules

- `package.json` `version` changes only for a release.
- Code, comments and commit messages are English; every source file starts with the BSD 3-Clause header.
- The page script never puts a node inside one Codex draws.
- Every patch edit matches exactly once on a pristine Codex build, or nothing is written.
