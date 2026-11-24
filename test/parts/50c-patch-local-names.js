// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The names the patch declares inside Codex's code. Codex's bundle is minified: its names are one to three characters
 * and change with every build (the function the tab bar button runs was vi, Zs and ra in three builds in a row). A name
 * the patch declares that is also one of Codex's hides Codex's inside the patch's own code, and the hook then quietly
 * does nothing, as happened to Claude Code Plus with Claude Code 2.1.331. So every name a host edit declares starts
 * with the prefix of src/host.js, which no minifier hands out, and the edits that refer to one of Codex's names inside
 * a scope of their own are run with several names Codex could give it.
 *
 * The edits are read with each captured group, and the whole match, standing for a placeholder: what is left of the
 * replacement is the patch's own text, and the placeholders are Codex's names, which an edit may write again where
 * Codex had them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);
const PUNCT = ['...', '===', '!==', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '**'];
/* Words that may come before a "(...)" followed by "{" without that being a method's parameter list. */
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'void', 'new',
  'delete', 'await', 'yield', 'in', 'of', 'instanceof', 'do', 'else', 'try', 'finally', 'throw', 'case', 'super', 'import']);
const PLACEHOLDER = /^\$codex/;

/* Identifiers, strings, numbers and punctuation. A template literal is refused: code inside one would go unread. */
function tokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '`') throw new Error('a template literal in the replacement, which this reader does not look inside');
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out.push({ t: 'str', v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j++;
      out.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i)) || c;
    out.push({ t: 'p', v: p });
    i += p.length;
  }
  return out;
}

const punct = (tk, i) => (tk[i] && tk[i].t === 'p' ? tk[i].v : '');

function closeOf(tk, i) {
  let depth = 0;
  for (let j = i; j < tk.length; j++) {
    const v = punct(tk, j);
    if (OPEN[v]) depth++;
    else if (CLOSE.has(v) && --depth === 0) return j;
  }
  return tk.length;
}

function openOf(tk, i) {
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    const v = punct(tk, j);
    if (CLOSE.has(v)) depth++;
    else if (OPEN[v] && --depth === 0) return j;
  }
  return -1;
}

/* Indexes of the commas at the top level of tk[a..b), and b. */
function topCommas(tk, a, b) {
  const at = [];
  let depth = 0;
  for (let j = a; j < b; j++) {
    const v = punct(tk, j);
    if (OPEN[v]) depth++;
    else if (CLOSE.has(v)) depth--;
    else if (v === ',' && depth === 0) at.push(j);
  }
  return [...at, b];
}

/* The names bound by a comma-separated list of binding patterns in tk[a..b): parameters, or one declarator's target. */
function bindings(tk, a, b) {
  const names = [];
  let start = a;
  for (const end of topCommas(tk, a, b)) {
    let i = start;
    start = end + 1;
    if (punct(tk, i) === '...') i++;
    if (i >= end) continue;
    if (tk[i].t === 'id') names.push(tk[i].v);
    else if (punct(tk, i) === '[') names.push(...bindings(tk, i + 1, closeOf(tk, i)));
    else if (punct(tk, i) === '{') {
      const close = closeOf(tk, i);
      let s = i + 1;
      for (const e of topCommas(tk, i + 1, close)) {
        let colon = -1, depth = 0;
        for (let j = s; j < e && colon < 0; j++) {
          const v = punct(tk, j);
          if (OPEN[v]) depth++;
          else if (CLOSE.has(v)) depth--;
          else if (v === ':' && depth === 0) colon = j;
        }
        names.push(...bindings(tk, colon < 0 ? s : colon + 1, e));
        s = e + 1;
      }
    }
  }
  return names;
}

/** Every name a piece of JavaScript declares: let, const, var, function and class names, parameters, catch bindings. */
function declaredNames(src) {
  const tk = tokens(src);
  const names = new Set();
  const add = (list) => list.forEach((n) => names.add(n));
  const pattern = (i) => (tk[i] && tk[i].t === 'id' ? [tk[i].v] : OPEN[punct(tk, i)] ? bindings(tk, i, closeOf(tk, i) + 1) : []);
  for (let i = 0; i < tk.length; i++) {
    const k = tk[i];
    if (k.t === 'id' && (k.v === 'let' || k.v === 'const' || k.v === 'var')) {
      add(pattern(i + 1));
      let depth = 0;
      for (let j = i + 1; j < tk.length; j++) {
        const v = punct(tk, j);
        if (OPEN[v]) depth++;
        else if (CLOSE.has(v)) { if (!depth) break; depth--; }
        else if (v === ';' && !depth) break;
        else if (v === ',' && !depth) add(pattern(j + 1));
      }
    } else if (k.t === 'id' && k.v === 'class' && tk[i + 1] && tk[i + 1].t === 'id' && tk[i + 1].v !== 'extends') {
      names.add(tk[i + 1].v);
    } else if (k.t === 'id' && k.v === 'function') {
      let j = i + 1;
      if (punct(tk, j) === '*') j++;
      if (tk[j] && tk[j].t === 'id') names.add(tk[j++].v);
      if (punct(tk, j) === '(') add(bindings(tk, j + 1, closeOf(tk, j)));
    } else if (k.t === 'id' && k.v === 'catch' && punct(tk, i + 1) === '(') {
      add(bindings(tk, i + 2, closeOf(tk, i + 1)));
    } else if (k.t === 'p' && k.v === '=>') {
      if (punct(tk, i - 1) === ')') add(bindings(tk, openOf(tk, i - 1) + 1, i - 1));
      else if (tk[i - 1] && tk[i - 1].t === 'id') names.add(tk[i - 1].v);
    } else if (k.t === 'id' && !CONTROL.has(k.v) && punct(tk, i + 1) === '(' && punct(tk, i - 1) !== '.') {
      const close = closeOf(tk, i + 1);
      if (punct(tk, close + 1) === '{') add(bindings(tk, i + 2, close));
    }
  }
  return [...names];
}

/* One shape's replacement with each group, and the whole match, as a placeholder. */
function replacementOf(shape) {
  const groups = new RegExp(`${shape.re.source}|`, shape.re.flags.replace(/[gy]/g, '')).exec('').length - 1;
  const caps = Array.from({ length: groups }, (_, k) => `$codex${k + 1}`);
  const whole = '$codexMatch';
  if (typeof shape.to === 'function') return shape.to(whole, ...caps, 0, whole);
  return shape.to.replace(/\$(\d+|&)/g, (m, d) => (d === '&' ? whole : caps[Number(d) - 1] || m));
}

function codexInstalls() {
  const out = [];
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names) if (/^openai\.chatgpt-/.test(n) && fs.existsSync(path.join(root, n, 'out', 'extension.js'))) out.push(path.join(root, n));
  }
  return out;
}

module.exports = async ({ ok, bad, note, eq }) => {
  const host = require('../../src/host');
  const { applyEdits, shapesOf } = require('../../src/edits');
  const prefix = host.LOCAL_PREFIX;
  const ours = new RegExp(`^${prefix}[A-Z][A-Za-z0-9]*$`);

  /* The reader first, so that a check that finds nothing cannot pass for one that finds everything in order. */
  const sample = 'let r=1,{a:b,c=2,...d}=x;const[e,,f=3]=y;var g;function h(i,{j},k=(l)=>l){}class M{n(o,p){}}'
    + 'try{}catch(q){}(s,...t)=>0;u=>u;async(v)=>0;w.x({key:y});if(z){}for(let aa of bb){}';
  eq(declaredNames(sample).sort(), ['M', 'aa', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v'].sort(),
    'the reader finds every kind of declaration and none of the names that are only used');

  /* Every target whose file is JavaScript: today that is the host bundle alone. The page edit adds a script tag to an
     HTML page, and the manifest edit adds keys to JSON. */
  const targets = require('../../src/adapters').filter((t) => /\.js$/.test(t.targetFile(path.join(os.tmpdir(), 'codex'))));
  eq(targets.map((t) => t.name), ['Codex host'], 'the host bundle is the one patched file that is JavaScript');
  const found = new Map();
  const wrong = [];
  for (const t of targets) {
    for (const e of t.EDITS) {
      shapesOf(e).forEach((s, i) => {
        let names;
        try { names = declaredNames(replacementOf(s)); } catch (err) { wrong.push(`${e.name} [${i}]: ${err.message}`); return; }
        for (const n of names) {
          if (PLACEHOLDER.test(n)) continue;
          if (!ours.test(n)) wrong.push(`${e.name} [${i}]: ${n}`);
          else found.set(n, [...(found.get(n) || []), e.name]);
        }
      });
    }
  }
  if (wrong.length) bad(`these names the host edits declare inside Codex's code do not start with ${prefix} and an upper-case letter: ${wrong.join('; ')}`);
  else if (!found.size) bad('no name was found declared in the host edits, which have several: the reader is not reading them');
  else ok(`every name the host edits declare inside Codex's code starts with ${prefix} (${[...found.keys()].sort().join(', ')})`);

  /* The prefix is only worth having while no Codex build uses it. */
  const installs = codexInstalls();
  if (!installs.length) note('no Codex extension installed here: whether a build uses the prefix was not checked');
  const taken = new RegExp(`(?:^|[^\\w$])(${prefix}[A-Z][\\w$]*)`, 'g');
  for (const dir of installs) {
    const file = host.targetFile(dir);
    const backup = file + host.BACKUP_SUFFIX;
    const text = fs.readFileSync(fs.existsSync(backup) ? backup : file, 'utf8');
    if (text.includes(host.ANY_MARK)) { note(`${path.basename(dir)}: patched with no clean backup, so its own names were not read`); continue; }
    const uses = [...new Set([...text.matchAll(taken)].map((m) => m[1]))];
    eq(uses, [], `${path.basename(dir)}: Codex's own bundle has no name starting with ${prefix}`);
  }

  /*
   * The two edits whose own code refers to one of Codex's names: the tab bar button calls Codex's function, and the
   * conversation retain passes on Codex's id and calls Codex's callback. Each is run with names Codex has used and
   * could use, among them the one-letter names the patch itself once declared there.
   */
  const tabBar = host.EDITS.filter((e) => e.name === 'tab bar button');
  const tabBarRuns = {};
  for (const fn of ['ra', 'Zs', 'vi', 'a', 'e', 't', '_e']) {
    const src = `function ${fn}(...x){globalThis.calls.push(x);return"codex"}`
      + `const C={registerCommand(id,f){C.cmd=f}};C.registerCommand("chatgpt.openSidebar",${fn});`;
    const r = applyEdits(src, tabBar, 'Codex');
    if (r.error) { tabBarRuns[fn] = r.error; continue; }
    const box = vm.createContext({ calls: [] });
    box.globalThis = box;
    try {
      const cmd = vm.runInContext(`${r.out};C.cmd`, box);
      box.__codexExtrasTabBar = (a) => a.length === 2;
      const asTab = cmd('openai-codex://route/x', 1);
      const plain = cmd();
      box.__codexExtrasTabBar = () => { throw new Error('x'); };
      const faulty = cmd('y');
      delete box.__codexExtrasTabBar;
      const none = cmd('z');
      tabBarRuns[fn] = JSON.stringify([asTab === undefined, plain, faulty, none, box.calls]);
    } catch (err) { tabBarRuns[fn] = `threw ${err.message}`; }
  }
  const tabBarWant = JSON.stringify([true, 'codex', 'codex', 'codex', [[], ['y'], ['z']]]);
  eq(Object.entries(tabBarRuns).filter(([, v]) => v !== tabBarWant), [],
    'the tab bar button edit hands a tab bar call to this extension and every other call to Codex\'s function, whatever Codex names that function');

  const retain = host.EDITS.filter((e) => e.name === 'window broadcasts');
  const retainRuns = {};
  for (const [id, cb] of [['t', 'r'], ['e', 'a'], ['n', 'o'], ['r', 't'], ['a', 'e']]) {
    const src = `class S{retainActiveConversation(${id},${cb}){let k=this.interests.get(${id})??new Set;this.interests.set(${id},k);`
      + `let y=Symbol();return k.add(y),k.size===1&&${cb}(!0),()=>{this.interests.get(${id})!==k||!k.delete(y)||k.size!==0`
      + `||(this.interests.delete(${id}),${cb}(!1))}}}`;
    const r = applyEdits(src, retain, 'Codex');
    if (r.error) { retainRuns[`${id},${cb}`] = r.error; continue; }
    const got = [], heard = [];
    const box = vm.createContext({ Symbol, Set, Map });
    box.globalThis = box;
    box.__codexExtrasBroadcast = (method, params) => got.push([params.conversationId, params.following]);
    try {
      const s = vm.runInContext(`${r.out};const s=new S();s.interests=new Map();s`, box);
      const one = s.retainActiveConversation('t-1', (on) => heard.push(on));
      const two = s.retainActiveConversation('t-1', (on) => heard.push(on));
      one();
      two();
      retainRuns[`${id},${cb}`] = JSON.stringify([got, heard]);
    } catch (err) { retainRuns[`${id},${cb}`] = `threw ${err.message}`; }
  }
  const retainWant = JSON.stringify([[['t-1', true], ['t-1', true], ['t-1', false]], [true, false]]);
  eq(Object.entries(retainRuns).filter(([, v]) => v !== retainWant), [],
    'the conversation retain edit hands over the id Codex passed and Codex\'s callback still hears both, whatever Codex names the two');
};

module.exports.declaredNames = declaredNames;
module.exports.replacementOf = replacementOf;
