#!/usr/bin/env node
// Print a module's REAL export surface: names, kinds, signatures, and the
// shape of what functions actually return.
//
// Written because guessing an export name or a return shape has produced a
// wrong probe in four consecutive sessions. A guess that THROWS is cheap. A
// guess that returns `undefined` is expensive: it yields confident output
// that is either vacuous ("no secret leaked" from an empty string) or blames
// working code ("attribution ABSENT" when the fixture was wrong).
//
//   node scripts/surface.mjs src/server/screens.ts
//   node scripts/surface.mjs src/providers/open-meteo.ts geocode Reykjavik
//
// With extra arguments it CALLS the named export and prints the shape of the
// result, because a signature does not tell you that geocode() returns an
// array or that read() returns {provider, reading}.

import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const [, , modulePath, callName, ...callArgs] = process.argv;

if (!modulePath) {
  console.error('usage: node scripts/surface.mjs <module.ts> [exportToCall] [args...]');
  process.exit(2);
}

const url = pathToFileURL(resolve(modulePath)).href;
let mod;
try {
  mod = await import(url);
} catch (cause) {
  console.error(`could not import ${modulePath}:\n  ${cause.message}`);
  process.exit(1);
}

/* The first line of a function's source is its real parameter list, including
 * destructured option names — which is exactly where {from, to} vs
 * {fromMs, toMs} hides. */
function signatureOf(fn) {
  const src = String(fn);
  const open = src.indexOf('(');
  if (open === -1) return '()';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1).replace(/\s+/g, ' ');
    }
  }
  return '(…)';
}

/* A shape, not a value: enough to see "array of {name, latitude}" rather than
 * a page of data. */
function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `Array(${value.length}) of ${shapeOf(value[0], depth + 1)}`;
  }
  const t = typeof value;
  if (t !== 'object') return t === 'string' ? `string(${JSON.stringify(value).slice(0, 40)})` : t;
  if (value instanceof Date) return 'Date';
  if (depth > 2) return '{…}';
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  return `{${keys.slice(0, 12).map((k) => `${k}: ${shapeOf(value[k], depth + 1)}`).join(', ')}${keys.length > 12 ? ', …' : ''}}`;
}

console.log(`\n${modulePath}\n`);
const names = Object.keys(mod).sort();
if (names.length === 0) console.log('  (no exports)');

for (const name of names) {
  const v = mod[name];
  if (typeof v === 'function') {
    const kind = /^\s*class\b/.test(String(v)) ? 'class' : 'function';
    console.log(`  ${kind.padEnd(8)} ${name}${signatureOf(v)}`);
    if (kind === 'class') {
      const methods = Object.getOwnPropertyNames(v.prototype)
        .filter((m) => m !== 'constructor')
        .map((m) => {
          try { return `${m}${signatureOf(v.prototype[m])}`; } catch { return m; }
        });
      for (const m of methods) console.log(`           · ${m}`);
    }
  } else {
    console.log(`  ${'const'.padEnd(8)} ${name} = ${shapeOf(v)}`);
  }
}

if (callName) {
  const fn = mod[callName];
  if (typeof fn !== 'function') {
    console.error(`\n${callName} is not a callable export. Available: ${names.join(', ')}`);
    process.exit(1);
  }
  const parsed = callArgs.map((a) => {
    try { return JSON.parse(a); } catch { return a; }
  });
  console.log(`\ncalling ${callName}(${parsed.map((p) => JSON.stringify(p)).join(', ')})`);
  try {
    const result = await fn(...parsed);
    console.log(`  returns: ${shapeOf(result)}`);
  } catch (cause) {
    console.log(`  threw: ${cause.message}`);
  }
}
console.log('');
