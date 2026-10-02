#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Build the npm package into dist/.
 *
 * A checkout runs the .ts files directly, but Node refuses to strip types from
 * anything under node_modules, so an installed copy needs plain JavaScript.
 * Node's own type stripper does it — the code already runs under it, so there
 * is nothing it can't handle — and the build stays dependency-free.
 */
import { stripTypeScriptTypes } from 'node:module';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const path = join(dir, e.name);
  if (e.isDirectory()) return e.name === 'fixtures' ? [] : sources(path);
  return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
});

rmSync(DIST, { recursive: true, force: true });
for (const file of [...sources(join(ROOT, 'bin')), ...sources(join(ROOT, 'src'))]) {
  const js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' })
    .replace(/((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
  const out = join(DIST, relative(ROOT, file)).replace(/\.ts$/, '.js');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, js);
  if (js.startsWith('#!')) chmodSync(out, 0o755);
}
// Read at runtime relative to the code: the bundled registry and the Indeed puller.
cpSync(join(ROOT, 'companies.json'), join(DIST, 'companies.json'));
cpSync(join(ROOT, 'scripts', 'jobspy_pull.py'), join(DIST, 'scripts', 'jobspy_pull.py'));
console.log(`built ${relative(ROOT, DIST)}/`);
