#!/usr/bin/env node
/**
 * Validates the addon package the way the Wealthfolio host does, plus structural
 * checks the host cannot express.
 *
 * Usage: node scripts/validate.mjs [--root <dir>]
 * Exit code 0 when valid, 1 otherwise.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  validateManifest,
  PERMISSION_CATEGORIES,
  BASELINE_PERMISSION_CATEGORIES,
  ADDON_ICON_NAMES,
} from '@wealthfolio/addon-sdk';
import { checkVersions } from './version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');
const require = createRequire(import.meta.url);

const errors = [];
const warnings = [];

const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

/** Packages the sandbox provides. Importing these is safe. */
const ALLOWED_RUNTIME_IMPORTS = new Set([
  'react',
  'react-dom',
  '@wealthfolio/addon-sdk',
  '@wealthfolio/ui',
  '@wealthfolio/ui/chart',
  '@wealthfolio/ui/styles',
  'recharts',
]);

/**
 * Must never appear in the bundle: `react/jsx-runtime` is not a host dependency of
 * every release, and `process` does not exist in the sandbox at all.
 */
const FORBIDDEN_IMPORTS = ['react/jsx-runtime', 'react-dom/client'];

/* -------------------------------------------------------------- utilities */

async function collectSourceFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * Removes comments so documentation that merely *mentions* an API is not
 * mistaken for a call site.
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Host-provided packages must be installed locally, otherwise `npm run typecheck`
 * cannot verify that the named imports exist.
 *
 * Verifying import names is deliberately left to TypeScript: it resolves
 * `export * from` chains, package `exports` maps and subpaths exactly, so it
 * catches invented names such as `Stack` or `Typography` with no extra tooling.
 * The host reports those at runtime as
 * `does not provide an export named 'X'`, one error at a time, with no stack trace.
 */
function validateHostPackagesInstalled(root) {
  const required = ['@wealthfolio/ui', '@wealthfolio/addon-sdk', 'recharts', 'react'];

  for (const name of required) {
    const entry = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(entry)) {
      fail(
        `${name} is not installed; add it as a devDependency so typecheck can ` +
          `verify host import names`,
      );
    }
  }
}

/* --------------------------------------------------------------- manifest */

export async function readManifest(root) {
  const manifestPath = path.join(root, 'manifest.json');
  if (!existsSync(manifestPath)) {
    fail('manifest.json not found at package root');
    return null;
  }

  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    fail(`manifest.json is not valid JSON: ${cause.message}`);
    return null;
  }
}

function validateWithSdk(manifest) {
  const result = validateManifest(manifest);
  for (const error of result.errors) fail(`[sdk] ${error}`);
  for (const warning of result.warnings) warn(`[sdk] ${warning}`);
}

function validatePermissions(manifest) {
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || permissions.length === 0) {
    fail('manifest.permissions must be a non-empty array');
    return;
  }

  for (const [index, permission] of permissions.entries()) {
    const at = `manifest.permissions[${index}]`;

    if (!permission || typeof permission !== 'object') {
      fail(`${at} must be an object`);
      continue;
    }
    if (typeof permission.category !== 'string' || !permission.category) {
      fail(`${at}.category is required`);
    }
    if (typeof permission.purpose !== 'string' || !permission.purpose.trim()) {
      fail(`${at}.purpose is required and must be a non-empty string`);
    }
    if (!Array.isArray(permission.functions) || permission.functions.length === 0) {
      fail(`${at}.functions must be a non-empty array of { name, isDeclared, isDetected }`);
      continue;
    }

    const category = PERMISSION_CATEGORIES.find((c) => c.id === permission.category);
    if (!category) {
      warn(
        `${at}.category "${permission.category}" is not a known SDK category ` +
          `(known: ${PERMISSION_CATEGORIES.map((c) => c.id).join(', ')})`,
      );
      continue;
    }

    for (const [fIndex, fn] of permission.functions.entries()) {
      const fnAt = `${at}.functions[${fIndex}]`;
      if (!fn || typeof fn !== 'object' || typeof fn.name !== 'string' || !fn.name) {
        fail(`${fnAt} must be an object with a "name" string`);
        continue;
      }
      if (typeof fn.isDeclared !== 'boolean') fail(`${fnAt}.isDeclared must be a boolean`);
      if (typeof fn.isDetected !== 'boolean') fail(`${fnAt}.isDetected must be a boolean`);

      if (!category.functions.includes(fn.name)) {
        fail(
          `${fnAt} "${fn.name}" is not part of category "${category.id}" ` +
            `(allowed: ${category.functions.join(', ')})`,
        );
      }
    }
  }
}

function validateContributes(manifest) {
  const contributes = manifest.contributes;
  if (contributes === undefined) return;

  if (!contributes || typeof contributes !== 'object') {
    fail('manifest.contributes must be an object');
    return;
  }

  const routeIds = new Set();

  if (contributes.routes !== undefined) {
    if (!Array.isArray(contributes.routes)) {
      fail('manifest.contributes.routes must be an array');
    } else {
      for (const [index, route] of contributes.routes.entries()) {
        const at = `manifest.contributes.routes[${index}]`;
        if (!route || typeof route.id !== 'string' || !route.id) {
          fail(`${at}.id is required`);
          continue;
        }
        routeIds.add(route.id);
        if (route.path !== undefined) {
          if (typeof route.path !== 'string') {
            fail(`${at}.path must be a string`);
          } else if (route.path.startsWith('/') || route.path.includes('..')) {
            fail(`${at}.path must be relative to /addons/<addon-id> (got "${route.path}")`);
          }
        }
      }
    }
  }

  if (contributes.links !== undefined) {
    if (!contributes.links || typeof contributes.links !== 'object') {
      fail('manifest.contributes.links must be an object keyed by slot');
    } else {
      for (const [slot, links] of Object.entries(contributes.links)) {
        if (!Array.isArray(links)) {
          fail(`manifest.contributes.links.${slot} must be an array`);
          continue;
        }
        for (const [index, link] of links.entries()) {
          const at = `manifest.contributes.links.${slot}[${index}]`;
          if (!link || typeof link.route !== 'string' || !link.route) {
            fail(`${at}.route is required`);
          } else if (routeIds.size > 0 && !routeIds.has(link.route)) {
            fail(`${at}.route "${link.route}" must reference a declared route id`);
          }
          if (typeof link.label !== 'string' || !link.label) {
            fail(`${at}.label is required`);
          }
          if (link.icon !== undefined && !ADDON_ICON_NAMES.includes(link.icon)) {
            fail(
              `${at}.icon "${link.icon}" is not a supported addon icon ` +
                `(kebab-case, see ADDON_ICON_NAMES)`,
            );
          }
        }
      }
    }
  }
}

/**
 * A contributed route without `path` means the addon root, so the runtime route
 * must be registered at exactly `/addons/<manifest.id>`. Registering `/<id>`
 * leaves the declared route id unresolvable and the host reports
 * `Addon route '<id>' is not available`.
 */
function validateRoutePath(manifest, code) {
  if (!manifest.id) return;

  const expected = `/addons/${manifest.id}`;
  if (!code.includes(expected)) {
    fail(
      `bundle never registers the route path "${expected}"; runtime routes must ` +
        `use /addons/<manifest.id>, not /<manifest.id>`,
    );
  }

  const bareMount = new RegExp(`path\\s*:\\s*["'\`]\/${manifest.id}["'\`]`);
  if (bareMount.test(code)) {
    fail(`bundle registers "/${manifest.id}" as a route path; it must be "${expected}"`);
  }
}

/* ----------------------------------------------------------------- bundle */

async function validateEntry(manifest, root) {
  if (typeof manifest.main !== 'string' || !manifest.main) {
    fail('manifest.main is required and must point at the packaged entry file');
    return;
  }

  const entryPath = path.join(root, manifest.main);
  if (!existsSync(entryPath)) {
    fail(`manifest.main "${manifest.main}" does not exist in the package`);
    return;
  }

  const { size } = await stat(entryPath);
  if (size === 0) fail(`manifest.main "${manifest.main}" is empty`);
  return entryPath;
}

/**
 * Static analysis of the built bundle: every `ctx.api.<category>.<fn>(...)` call
 * must be covered by a declared permission, unless the category is a baseline
 * capability.
 */
function validateDeclaredApiUsage(manifest, code) {
  const baseline = new Set(BASELINE_PERMISSION_CATEGORIES);

  const declared = new Map();
  for (const permission of manifest.permissions ?? []) {
    if (!permission?.category) continue;
    const names = declared.get(permission.category) ?? new Set();
    for (const fn of permission.functions ?? []) {
      if (fn?.name) names.add(fn.name);
    }
    declared.set(permission.category, names);
  }

  const used = new Map();

  // Matches `x.api.category.fn(`. Optional-chained calls (`x.api?.category?.fn`)
  // do not match, which is why the sources are scanned separately.
  const callRe = /\.api\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = callRe.exec(code)) !== null) {
    const category = match[1];
    const fn = match[2];
    if (baseline.has(category)) continue;

    const categoryDef = PERMISSION_CATEGORIES.find((c) => c.id === category);
    if (!categoryDef) {
      warn(`bundle calls ctx.api.${category}.${fn}() which is not a known SDK API domain`);
      continue;
    }
    if (!categoryDef.functions.includes(fn)) {
      fail(
        `bundle calls ctx.api.${category}.${fn}() but "${fn}" is not a function of ` +
          `the "${category}" API (allowed: ${categoryDef.functions.join(', ')})`,
      );
      continue;
    }

    if (!used.has(category)) used.set(category, new Set());
    used.get(category).add(fn);
  }

  for (const [category, functions] of used) {
    for (const fn of functions) {
      if (!declared.get(category)?.has(fn)) {
        fail(
          `bundle calls ctx.api.${category}.${fn}() without declaring it in ` +
            `manifest.permissions - the host blocks it at runtime`,
        );
      }
    }
  }

  for (const [category, functions] of declared) {
    const usedFunctions = used.get(category);
    if (!usedFunctions) continue;
    for (const fn of functions) {
      if (!usedFunctions.has(fn)) {
        warn(`manifest declares ${category}.${fn} but the bundle never calls it`);
      }
    }
  }
}

/**
 * Requires every `ctx.api.<category>` reference in the TypeScript sources to be
 * declared in manifest.permissions.
 *
 * This complements `validateDeclaredApiUsage`: optional chaining
 * (`ctx?.api?.activities`) is compiled down to `m.getAll()`, so the category name
 * does not survive next to the call in the bundle and cannot be detected there.
 */
async function validateSourceApiUsage(manifest, root) {
  const srcDir = path.join(root, 'src');
  // A staged release payload intentionally ships no sources.
  if (!existsSync(srcDir)) return;

  const baseline = new Set(BASELINE_PERMISSION_CATEGORIES);
  const known = new Set(PERMISSION_CATEGORIES.map((category) => category.id));
  const declared = new Set((manifest.permissions ?? []).map((p) => p?.category).filter(Boolean));

  const used = new Set();

  for (const file of await collectSourceFiles(srcDir)) {
    const code = stripComments(await readFile(file, 'utf8'));
    const relative = path.relative(root, file);

    const refRe = /\bapi\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g;
    let match;
    while ((match = refRe.exec(code)) !== null) {
      const category = match[1];
      if (baseline.has(category)) continue;
      if (!known.has(category)) {
        warn(`${relative}: ctx.api.${category} is not a known SDK API domain`);
        continue;
      }
      used.add(category);

      if (!declared.has(category)) {
        fail(
          `${relative}: uses ctx.api.${category} but manifest.permissions does not ` +
            `declare the "${category}" category - the host blocks it at runtime`,
        );
      }
    }
  }

  for (const category of declared) {
    if (!used.has(category)) {
      warn(`manifest declares "${category}" but no source file uses ctx.api.${category}`);
    }
  }
}

async function validateBundle(manifest, root) {
  const entryPath = await validateEntry(manifest, root);
  if (!entryPath) return;

  const code = await readFile(entryPath, 'utf8');

  for (const forbidden of FORBIDDEN_IMPORTS) {
    if (code.includes(`'${forbidden}'`) || code.includes(`"${forbidden}"`)) {
      fail(`bundle imports "${forbidden}"; the host does not expose it to addons`);
    }
  }

  if (/\bprocess\.env\b/.test(code)) {
    fail('bundle references process.env; the sandbox has no `process` global');
  }

  const importRe = /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s*from\s*["']([^"']+)["']/g;
  const externals = new Set();
  let match;
  while ((match = importRe.exec(code)) !== null) {
    const specifier = match[1];
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) externals.add(specifier);
  }

  for (const specifier of externals) {
    if (!ALLOWED_RUNTIME_IMPORTS.has(specifier)) {
      fail(`bundle has undeclared external import "${specifier}"`);
    }
  }

  const declared = Object.keys(manifest.hostDependencies ?? {});
  for (const specifier of externals) {
    // A declared package covers its own subpaths, e.g. `@wealthfolio/ui` covers
    // `@wealthfolio/ui/chart` and `@wealthfolio/ui/styles`.
    const covered = declared.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    );
    if (!covered) {
      fail(`bundle imports "${specifier}" but manifest.hostDependencies does not declare it`);
    }
  }

  if (!/export\s*\{[^}]*\bas default\b/.test(code)) {
    fail('bundle has no default export; the host cannot call the addon enable() function');
  }

  validateRoutePath(manifest, code);
  validateDeclaredApiUsage(manifest, code);
}

/* ---------------------------------------------------------------- archive */

async function validateArchiveLayout(root) {
  // When validating the repository root, also check any produced archive.
  if (path.resolve(root) !== path.resolve(REPO_ROOT)) return;

  const zipPath = path.join(REPO_ROOT, 'contribution-tracker-stats.zip');
  if (!existsSync(zipPath)) {
    warn('contribution-tracker-stats.zip not found (run `npm run package` to create it)');
    return;
  }

  let entries = [];
  try {
    const AdmZip = require('adm-zip');
    entries = new AdmZip(zipPath).getEntries().map((entry) => entry.entryName);
  } catch {
    warn('cannot inspect zip contents (install adm-zip)');
    return;
  }

  if (!entries.includes('manifest.json')) {
    fail('zip: manifest.json must sit at the archive root');
  }
  if (!entries.some((entry) => entry.endsWith('addon.js'))) {
    fail('zip: no addon.js entry file found');
  }
  if (entries.some((entry) => entry.includes('node_modules/'))) {
    fail('zip: node_modules must not be packaged');
  }
}

/**
 * The host parses CSS shipped in the package and rejects `@import` rules with
 * "Addon CSS @import rules are not supported; bundle or package the CSS file".
 * `@wealthfolio/ui/styles.css` is a Tailwind v4 *source* file (`@import`,
 * `@theme`, `@apply`) and must never be copied into a package: the sandbox is already
 * styled by the host, since the host's own components are Tailwind-based.
 */
async function validatePackagedCss(root) {
  const distDir = path.join(root, 'dist');
  if (!existsSync(distDir)) return;

  let entries;
  try {
    entries = await readdir(distDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.css')) continue;

    const css = await readFile(path.join(distDir, entry.name), 'utf8');
    const relative = path.join('dist', entry.name);

    const atImport = css.match(/@import[^;]*;?/);
    if (atImport) {
      fail(relative + ' uses "' + atImport[0].trim() + '" - the host rejects @import in addon CSS');
    }

    for (const directive of ['@theme', '@apply', '@custom-variant', '@source']) {
      if (css.includes(directive)) {
        fail(relative + ' contains the uncompiled Tailwind directive "' + directive + '"');
      }
    }
  }
}

/* -------------------------------------------------------------------- run */

export async function run(options = {}) {
  const root = options.root ? path.resolve(options.root) : REPO_ROOT;

  const manifest = await readManifest(root);
  if (manifest) {
    validateWithSdk(manifest);
    validatePermissions(manifest);
    validateContributes(manifest);
    await validateSourceApiUsage(manifest, root);
    await validateBundle(manifest, root);
  }

  validateHostPackagesInstalled(REPO_ROOT);

  // Version invariants only make sense against the repository, where package.json
  // can be compared with manifest.json.
  const versionCheck = await checkVersions(REPO_ROOT);
  for (const error of versionCheck.errors) fail(error);
  if (versionCheck.errors.length === 0) {
    console.log(`Version: ${versionCheck.current}`);
  }

  await validatePackagedCss(root);

  await validateArchiveLayout(root);

  for (const warning of warnings) console.warn(`WARN  ${warning}`);
  for (const error of errors) console.error(`ERROR ${error}`);

  if (errors.length > 0) {
    console.error(`\nValidation failed: ${errors.length} error(s), ${warnings.length} warning(s).`);
    return false;
  }

  console.log(`Validation passed (${warnings.length} warning(s)).`);
  return true;
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const rootIndex = process.argv.indexOf('--root');
  const ok = await run({ root: rootIndex === -1 ? undefined : process.argv[rootIndex + 1] });
  process.exit(ok ? 0 : 1);
}
