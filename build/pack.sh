#!/bin/bash
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

# Build a .vsix without npm. A .vsix is a zip holding the extension under extension/ plus two descriptor files;
# vsce adds nothing else that VS Code requires for a local install.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
id=$(node -p "const p=require('$root/package.json'); p.publisher+'.'+p.name+'-'+p.version")
out="$root/build/$id.vsix"

node "$root/test/check.js" >/dev/null || { echo "pack.sh: test/check.js failed; run it to see why" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/extension"

cd "$root"
# codex-plugin/ is the companion Codex plugin. It ships inside the extension so the two always match.
cp -r package.json extension.js uninstall.js src codex-plugin README.md LICENSE "$stage/extension/"
cp -r images "$stage/extension/"
# Running the plugin's hooks locally seeds __pycache__ inside the tree copied above; it has no business in a package.
find "$stage/extension" -name __pycache__ -type d -prune -exec rm -rf {} +
node build/make-manifest.js "$stage"

rm -f "$out"
(cd "$stage" && zip -q -r -X "$out" '[Content_Types].xml' extension.vsixmanifest extension)
echo "$out"
