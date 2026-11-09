// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The few values read out of Codex's config.toml (src/codex-config.js), and the one the hooks are handed from it. The
 * config below has the tables and keys of a real Codex 0.164 config.toml on a machine using Amazon Bedrock; every value
 * in it is made up.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../../src/codex-config');

const REAL_SHAPE = `model_provider = "amazon-bedrock"
forced_login_method = "api"
check_for_update_on_startup = false
model_reasoning_effort = "high"
model = "openai.gpt-test"

[mcp_servers.some-mcp]
command = "some-mcp"
args = ["--flag", "x"]

[mcp_servers.some-mcp.env]
SOME_SETTING = "true"

[features]
guardian_reuse_parent_compaction = true

[model_providers.amazon-bedrock.aws]
region = "us-west-2"

[model_providers.amazon-bedrock.aws.credential_export]
command = "creds"
args = ["--profile", "p"]

[model_providers.amazon-bedrock-runtime.aws]
region = "eu-west-1"

[projects."/home/someone/work"]
trust_level = "trusted"

[plugins."agent-work-plan@codex-extras"]
enabled = true
`;

const python = () => {
  for (const exe of ['python3', 'python']) {
    const r = cp.spawnSync(exe, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return exe;
  }
  return '';
};

module.exports = async ({ eq, note, tmp, root }) => {
  const home = tmp('home');
  fs.writeFileSync(path.join(home, 'config.toml'), REAL_SHAPE);
  eq(config.provider(home), { id: 'amazon-bedrock', name: 'Amazon Bedrock', region: 'us-west-2' },
    'the provider is the top-level model_provider, with the region from its own aws table and not another provider\'s');
  eq(config.accountLine(home), 'Amazon Bedrock · us-west-2', 'and the account line names both');
  eq(config.compactLimit(home), 0, 'with no compaction limit set, none is read');
  const t = config.tablesOf(REAL_SHAPE);
  eq([t['mcp_servers.some-mcp'].args, t['plugins."agent-work-plan@codex-extras"'].enabled, t[''].check_for_update_on_startup],
    [undefined, true, false], 'an array reads as absent; a boolean in a quoted table name, or at the top, is read');

  fs.writeFileSync(path.join(home, 'config.toml'), `model_auto_compact_token_limit = 150_000  # lower\n${REAL_SHAPE}`);
  eq(config.compactLimit(home), 150000, 'the user\'s compaction limit is read, underscores and comment and all');
  fs.writeFileSync(path.join(home, 'config.toml'), `profile = "small"\nmodel_auto_compact_token_limit = 150000\n${REAL_SHAPE}`
    + '\n[profiles.small]\nmodel_auto_compact_token_limit = 90000\nmodel_provider = "openai"\n');
  eq([config.compactLimit(home), config.provider(home).id], [90000, 'openai'], 'a profile named at the top level overrides what it sets');
  const none = tmp('none');
  eq([config.provider(none).id, config.compactLimit(none), config.accountLine(none)], ['openai', 0, 'OpenAI (ChatGPT sign-in or an API key)'],
    'with no config.toml it is Codex\'s own default provider, and no limit');

  /* The refresh hook measures its marks against the lower line. */
  const py = python();
  if (!py) { note('no Python 3.7+ here: the refresh hook was not run against a lower compaction limit'); return; }
  const hooks = path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks');
  const data = tmp('data');
  const session = '01a1b8e8-f7e2-7251-95a9-a95b65992860';
  fs.writeFileSync(path.join(data, `${session}.json`), JSON.stringify({ nodes: [{ title: 'Row', state: 'doing' }] }));
  const transcript = path.join(data, 'rollout.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { input_tokens: 110000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110010 },
      model_context_window: 258400 } } }) + '\n');
  const run = () => cp.spawnSync(py, [path.join(hooks, 'refresh-work-plan.py'), data], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, transcript_path: transcript, tool_name: 'exec_command' }) }).stdout.trim();
  eq(run(), '', 'at 110k of a 258k window, 45% of Codex\'s own line, nothing is said');
  fs.unlinkSync(path.join(data, `${session}.watermark`));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ compactTokenLimit: 150000 }));
  eq(/73% of the point where Codex compacts it on its own \(110000 of about 150000 tokens\)/.test(run()), true,
    'with the user\'s limit at 150k the same context is 73% of the line, and the first mark speaks');
};
