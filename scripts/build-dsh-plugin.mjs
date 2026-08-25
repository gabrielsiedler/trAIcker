/**
 * Builds the @traicker/dsh-plugin package.
 *
 * 1. Compiles src/dsh-plugin/ with tsconfig.dsh-plugin.json
 * 2. Copies package.json + README + .js + .d.ts into packages/dsh-plugin/
 * 3. Result lives in packages/dsh-plugin/, ready to publish
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'dsh-plugin');
const DIST = path.join(ROOT, 'dist', 'dsh-plugin');
const OUT = path.join(ROOT, 'packages', 'dsh-plugin');

// Step 1: compile
console.log('Building @traicker/dsh-plugin...');
execSync('npx tsc -p tsconfig.dsh-plugin.json', { cwd: ROOT, stdio: 'inherit' });

// Step 2: ensure output dir exists
mkdirSync(OUT, { recursive: true });

// Step 3: copy .js + .d.ts + .js.map from dist to packages
for (const file of readdirSync(DIST)) {
  const src = path.join(DIST, file);
  if (!existsSync(src)) continue;
  // Skip node_modules if it somehow ends up there
  if (file === 'node_modules' || file.startsWith('.')) continue;

  const dest = path.join(OUT, file);
  if (file.endsWith('.js') || file.endsWith('.d.ts') || file.endsWith('.js.map')) {
    copyFileSync(src, dest);
  }
}

// Step 4: write package.json
const pkg = JSON.parse(readFileSync(path.join(SRC, 'package.json'), 'utf8'));
pkg.main = 'index.js';
pkg.types = 'index.d.ts';
delete pkg.private;
delete pkg.devDependencies;
writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// Step 5: copy README
const readmeSrc = path.join(OUT, 'README.md');
if (existsSync(readmeSrc)) {
  copyFileSync(readmeSrc, path.join(OUT, 'README.md'));
}

console.log(`\n@traicker/dsh-plugin ready at ${OUT}`);
console.log('To publish: cd packages/dsh-plugin && npm publish --access public');
console.log('To link locally: cd packages/dsh-plugin && npm link');