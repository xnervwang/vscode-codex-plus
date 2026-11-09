// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The descriptor files build/pack.sh writes into a local .vsix (build/make-manifest.js). A .vsix is an Open Packaging
 * Conventions zip: a part whose file extension has no Default in [Content_Types].xml is not part of the package to a
 * reader that follows the format, and the Marketplace finds the license by its extension, so it is packed as
 * LICENSE.txt, as Agent Plus and Claude Code Plus pack theirs.
 *
 * The staged tree is what pack.sh copies, read from its own cp lines, so a directory added there is checked here too.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp, root }) => {
  const pack = fs.readFileSync(path.join(root, 'build', 'pack.sh'), 'utf8');
  eq(/cp LICENSE "\$stage\/extension\/LICENSE\.txt"/.test(pack), true, 'pack.sh packs the license as LICENSE.txt');
  const stage = tmp('pack-stage');
  const into = path.join(stage, 'extension');
  fs.mkdirSync(into);
  for (const m of pack.matchAll(/^cp -r (.+) "\$stage\/extension\/"$/gm)) {
    for (const name of m[1].split(/\s+/)) fs.cpSync(path.join(root, name), path.join(into, name), { recursive: true, filter: (p) => !p.includes('__pycache__') });
  }
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(into, 'LICENSE.txt'));
  const run = () => cp.spawnSync(process.execPath, [path.join(root, 'build', 'make-manifest.js'), stage], { encoding: 'utf8' });
  const r = run();
  const types = fs.existsSync(path.join(stage, '[Content_Types].xml')) ? fs.readFileSync(path.join(stage, '[Content_Types].xml'), 'utf8') : '';
  const listed = new Set([...types.matchAll(/Extension="([^"]+)"/g)].map((x) => x[1]));
  const exts = new Set();
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else exts.add(path.extname(e.name).toLowerCase()); } };
  walk(into);
  eq([r.status, [...exts].filter((x) => !listed.has(x))], [0, []], 'every file extension in the package has a content type in [Content_Types].xml');
  const manifest = fs.existsSync(path.join(stage, 'extension.vsixmanifest')) ? fs.readFileSync(path.join(stage, 'extension.vsixmanifest'), 'utf8') : '';
  eq(/<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension\/LICENSE.txt"/.test(manifest), true,
    'and the manifest names LICENSE.txt as the license');
  fs.writeFileSync(path.join(into, 'NOTICE'), 'x');
  const bare = run();
  eq([bare.status, /NOTICE/.test(bare.stderr)], [1, true], 'a file with no extension, which the package could not carry, stops the build, naming it');
};
