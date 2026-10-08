#!/usr/bin/env node
/** Removes build output and staged/release artifacts. */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'dist',
  'build',
  'release',
  'contribution-tracker-stats.zip',
  'tsconfig.tsbuildinfo',
];

for (const target of targets) {
  await rm(path.join(ROOT, target), { recursive: true, force: true });
  console.log(`removed ${target}`);
}
