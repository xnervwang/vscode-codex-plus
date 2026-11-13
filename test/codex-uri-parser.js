// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Codex's minified names change with every build, so its URI parser for conversation tabs is matched by its body. The
   conversation id it returns is `s` in 26.1106 and an expression that accepts /local/ only from 26.1111 on. */
const PARSER = /function ([\w$]+)\(t\)\{let\{scheme:e,authority:r,path:n\}=t;if\(e!==([\w$]+)\)return null;if\(r!==([\w$]+)\)return null;[\s\S]*?conversationId:[^{}]*\}\}/;

function constant(src, name) {
  const m = new RegExp(`(?:^|[^\\w$])${name.replace(/\$/g, '\\$')}="([^"]+)"`).exec(src);
  return m ? m[1] : null;
}

/* Null when the bundle has no such function. */
function uriParser(src) {
  const fn = PARSER.exec(src);
  if (!fn) return null;
  const scheme = constant(src, fn[2]), authority = constant(src, fn[3]);
  if (!scheme || !authority) return null;
  return { parse: new Function(fn[2], fn[3], `${fn[0]};return ${fn[1]};`)(scheme, authority), scheme, authority };
}

module.exports = { uriParser };
