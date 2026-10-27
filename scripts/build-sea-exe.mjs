#!/usr/bin/env node
/**
 * Automated Windows Single Executable Application (SEA) builder for PointerDrop-Turbo.exe
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_SEA = path.join(ROOT, 'dist-sea');
const TURBO_CJS = path.join(DIST_SEA, 'turbo.cjs');
const SEA_BLOB = path.join(DIST_SEA, 'sea-prep.blob');
const SEA_CONFIG = path.join(ROOT, 'sea-config.json');
const TARGET_EXE = path.join(ROOT, 'PointerDrop-Turbo.exe');

fs.mkdirSync(DIST_SEA, { recursive: true });

console.log('[1/4] Bundling warp-turbo.mjs into CommonJS...');
execSync(`npx esbuild scripts/warp-turbo.mjs --bundle --platform=node --target=node22 --format=cjs --outfile="${TURBO_CJS}"`, { cwd: ROOT, stdio: 'inherit' });

console.log('[2/4] Generating Node SEA preparation blob...');
execSync(`node --experimental-sea-config "${SEA_CONFIG}"`, { cwd: ROOT, stdio: 'inherit' });

console.log('[3/4] Copying node.exe binary base...');
const nodePath = process.execPath;
fs.copyFileSync(nodePath, TARGET_EXE);

console.log('[4/4] Injecting SEA blob via postject into PointerDrop-Turbo.exe...');
execSync(`npx --yes postject "${TARGET_EXE}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, { cwd: ROOT, stdio: 'inherit' });

console.log(`\n[SUCCESS] Standalone executable created: ${TARGET_EXE}`);
console.log('Zero dependencies, zero node_modules needed. Double-click to run on any Windows machine!');
