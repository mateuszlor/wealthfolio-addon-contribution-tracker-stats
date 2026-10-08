#!/usr/bin/env node
/**
 * Bumps the version, stages the addon package, validates it, and produces a
 * release archive plus a SHA-256 checksum.
 *
 * The version lives in manifest.json (single source of truth); package.json is
 * kept in sync. Every archive produced here increments it, so the file name,
 * the manifest inside the archive and the installed addon all agree.
 *
 * Usage:
 *   node scripts/build-release.mjs              # bump patch (default)
 *   node scripts/build-release.mjs --bump=minor
 *   node scripts/build-release.mjs --bump=major
 *   node scripts/build-release.mjs --no-bump    # keep the current version
 *
 * Output: release/contribution-tracker-stats-<version>.zip (+ .sha256)
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { run as validate } from './validate.mjs';
import { bump, currentVersion } from './version.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
const STAGE = path.join(ROOT, 'build', 'package');
const RELEASE = path.join(ROOT, 'release');
const LEGACY_ZIP = path.join(ROOT, 'contribution-tracker-stats.zip');

/** Accepts both `--version=1.2.3` and `--version 1.2.3`. */
function parseVersionOption(argv) {
  const equals = argv.find((arg) => arg.startsWith('--version='));
  if (equals) return equals.slice('--version='.length);

  const index = argv.indexOf('--version');
  if (index !== -1) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--version requires a value, e.g. --version 1.2.3');
    }
    return value;
  }

  return undefined;
}

function parseBumpOption(argv) {
  if (argv.includes('--no-bump')) return { bumpType: null };

  const bumpArg = argv.find((arg) => arg.startsWith('--bump='));
  if (!bumpArg) return { bumpType: 'patch' };

  const type = bumpArg.slice('--bump='.length);
  if (!['major', 'minor', 'patch'].includes(type)) {
    throw new Error(`Invalid --bump value "${type}" (expected major, minor or patch)`);
  }
  return { bumpType: type };
}

/**
 * Resolves the release version.
 *
 * `--version=<v>` wins and is written into the staged manifest only, so CI can
 * release the version carried by a git tag without rewriting the working tree.
 * Otherwise the working manifest is bumped, which is the local workflow.
 */
async function resolveVersion(argv) {
  const explicit = parseVersionOption(argv);

  if (explicit) {
    const normalised = explicit.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(normalised)) {
      throw new Error(`Invalid --version value "${explicit}" (expected e.g. 1.2.3)`);
    }
    console.log(`Version ${normalised} (explicit)`);
    return normalised;
  }

  const { bumpType } = parseBumpOption(argv);

  if (!bumpType) {
    const current = await currentVersion(ROOT);
    console.log(`Version kept at ${current} (--no-bump)`);
    return current;
  }

  const { from, to } = await bump(bumpType, ROOT);
  console.log(`Version ${from} -> ${to} (${bumpType})`);
  return to;
}

/** Guards against shipping an archive whose name disagrees with its manifest. */
function assertArchiveMatchesVersion(zip, version) {
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new Error('archive is missing manifest.json');

  const packaged = JSON.parse(entry.getData().toString('utf8'));
  if (packaged.version !== version) {
    throw new Error(
      `archive manifest version ${packaged.version} does not match release version ${version}`,
    );
  }
}

async function stage(version) {
  await rm(path.join(ROOT, 'build'), { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });

  if (!existsSync(path.join(ROOT, 'dist', 'addon.js'))) {
    throw new Error('dist/addon.js missing - run `npm run build` first.');
  }

  await cp(path.join(ROOT, 'dist'), path.join(STAGE, 'dist'), { recursive: true });

  // The staged manifest carries the release version even when the working tree was
  // left untouched (`--version`), so the archive always matches the tag.
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
  manifest.version = version;
  await writeFile(
    path.join(STAGE, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  await cp(path.join(ROOT, 'README.md'), path.join(STAGE, 'README.md'));
  await cp(path.join(ROOT, 'DEVELOPING.md'), path.join(STAGE, 'DEVELOPING.md'));

  const license = path.join(ROOT, 'LICENSE');
  if (existsSync(license)) await cp(license, path.join(STAGE, 'LICENSE'));

  // Ship the sourcemap only outside release archives.
  const dist = path.join(STAGE, 'dist');
  await rm(path.join(dist, 'addon.js.map'), { force: true });

  const entries = await readdir(dist);
  console.log(`Staged: dist/${entries.join(', dist/')}`);
}

function archive() {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFolder(STAGE, '');
  return zip;
}

async function main() {
  const version = await resolveVersion(process.argv.slice(2));

  await stage(version);

  // Validate the exact payload that will be archived, not the working tree.
  const ok = await validate({ root: STAGE });
  if (!ok) throw new Error('Validation failed - release not produced.');

  const zip = archive();
  assertArchiveMatchesVersion(zip, version);

  await mkdir(RELEASE, { recursive: true });

  const name = `contribution-tracker-stats-${version}.zip`;
  const releasePath = path.join(RELEASE, name);
  await rm(releasePath, { force: true });
  zip.writeZip(releasePath);

  const buffer = await readFile(releasePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  await writeFile(`${releasePath}.sha256`, `${sha256}  ${name}\n`);

  // Convenience copy for the "Import from file" flow in the UI.
  await writeFile(LEGACY_ZIP, buffer);

  const { size } = await stat(releasePath);
  console.log(`\nRelease: ${path.relative(ROOT, releasePath)} (${(size / 1024).toFixed(1)} kB)`);
  console.log(`SHA-256: ${sha256}`);
  console.log(`Copy:    ${path.relative(ROOT, LEGACY_ZIP)}`);
}

main().catch((cause) => {
  console.error(`\nRelease failed: ${cause.message}`);
  process.exit(1);
});
