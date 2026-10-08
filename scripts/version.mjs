#!/usr/bin/env node
/**
 * Single source of truth for the addon version is `manifest.json`, because the
 * host reads it and the release archive name is derived from it. `package.json`
 * is kept in sync so npm tooling agrees.
 *
 * Usage:
 *   node scripts/version.mjs                 # print current version
 *   node scripts/version.mjs --check         # verify both files agree
 *   node scripts/version.mjs patch           # bump and persist
 *   node scripts/version.mjs minor|major
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const BUMP_TYPES = ['major', 'minor', 'patch'];

export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value);
}

/** Increments a semver string. Pre-release/build metadata is dropped. */
export function bumpVersion(version, type = 'patch') {
  if (!BUMP_TYPES.includes(type)) {
    throw new Error(`Unknown bump type "${type}" (expected ${BUMP_TYPES.join(', ')})`);
  }
  if (!isSemver(version)) {
    throw new Error(`Not a semantic version: "${version}"`);
  }

  const [major, minor, patch] = version
    .replace(/[-+].*$/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));

  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readManifest(root = REPO_ROOT) {
  return readJson(path.join(root, 'manifest.json'));
}

/** Current version, or throws when the manifest is unreadable. */
export async function currentVersion(root = REPO_ROOT) {
  const manifest = await readManifest(root);
  return manifest.version;
}

/** Persists `version` to manifest.json and package.json. */
export async function writeVersion(version, root = REPO_ROOT) {
  if (!isSemver(version)) {
    throw new Error(`Refusing to write invalid version "${version}"`);
  }

  const manifestPath = path.join(root, 'manifest.json');
  const manifest = await readJson(manifestPath);
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const packagePath = path.join(root, 'package.json');
  if (existsSync(packagePath)) {
    const pkg = await readJson(packagePath);
    pkg.version = version;
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }

  return version;
}

/** Bumps and persists; returns `{ from, to }`. */
export async function bump(type = 'patch', root = REPO_ROOT) {
  const from = await currentVersion(root);
  const to = bumpVersion(from, type);
  await writeVersion(to, root);
  return { from, to };
}

/**
 * Cross-file version invariants.
 * @returns {{ current: string, errors: string[] }}
 */
export async function checkVersions(root = REPO_ROOT) {
  const errors = [];

  let current = 'unknown';
  try {
    const manifest = await readManifest(root);
    current = manifest.version ?? 'missing';
    if (!isSemver(current)) {
      errors.push(`manifest.json version "${current}" is not a semantic version`);
    }
  } catch (cause) {
    errors.push(`cannot read manifest.json: ${cause.message}`);
    return { current, errors };
  }

  const packagePath = path.join(root, 'package.json');
  if (existsSync(packagePath)) {
    const pkg = await readJson(packagePath);
    if (pkg.version !== current) {
      errors.push(
        `version drift: manifest.json is ${current} but package.json is ${pkg.version ?? 'missing'}`,
      );
    }
  }

  return { current, errors };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const arg = process.argv[2];

  if (!arg) {
    console.log(await currentVersion());
  } else if (arg === '--check') {
    const { current, errors } = await checkVersions();
    for (const error of errors) console.error(`ERROR ${error}`);
    if (errors.length > 0) process.exit(1);
    console.log(current);
  } else if (BUMP_TYPES.includes(arg)) {
    const { from, to } = await bump(arg);
    console.log(`${from} -> ${to}`);
  } else {
    console.error(`Unknown argument "${arg}". Use: --check | ${BUMP_TYPES.join(' | ')}`);
    process.exit(1);
  }
}
