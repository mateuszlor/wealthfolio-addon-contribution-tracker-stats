# Contribution Tracker Stats

Wealthfolio addon that shows a card with contribution (deposit) statistics, aggregated
**month by month**, **day by day** and **year by year**.

The addon uses the host's own chart and layout primitives (`ChartContainer`,
`ChartTooltipContent`, `BarChart`, `Card`, `Tabs`) so it renders with the application's
theme instead of a hand-rolled look.

**No CSS is shipped** (`dist/` contains only `addon.js`). Two hard-won rules:

1. Do not copy `@wealthfolio/ui/styles.css` into the package — it is a Tailwind v4 *source*
   file (`@import "tailwindcss"`, `@theme`, `@apply`) and the host rejects it with
   *"Addon CSS @import rules are not supported; bundle or package the CSS file"*.
   `validate.mjs` fails the build on `@import` or an uncompiled Tailwind directive in
   packaged CSS.
2. Do not route chart colours through `var(--chart-1)`. `ChartStyle` expands the config
   into `--color-<key>`, so a token-based colour leaves `fill` unresolved and the bars
   render black. `ChartConfig.theme` emits concrete colours per mode instead:

   ```ts
   theme: { light: 'hsl(142 64% 34%)', dark: 'hsl(142 44% 48%)' }
   ```

Named imports from host packages are verified by **`npm run typecheck`**, not by a
hand-written parser: TypeScript resolves `export *` chains, `exports` maps and subpaths
exactly, and reports invented names (`Stack`, `Typography`, `Stat`) as `TS2305`.
`validate.mjs` only asserts the host packages are installed so that check stays
meaningful.

## Requirements

- Node.js >= 20
- Wealthfolio >= 3.7.0

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src` |
| `npm test` | Regression tests for intake/aggregation and version helpers |
| `npm run build` | Vite library build to `dist/addon.js` (ES module) |
| `npm run validate` | Validates manifest + bundle + package layout |
| `npm run verify` | `typecheck` → `test` → `build` → `validate` |
| `npm run package` | Bumps version, stages, validates and zips the archive |
| `npm run release` | `clean` → `verify` → `package` |
| `npm run clean` | Removes `dist`, `build`, `release`, local zip |

## Validation

`scripts/validate.mjs` is the source of truth and runs the host's own
`validateManifest()` from `@wealthfolio/addon-sdk`, plus structural checks:

- `manifest.main` exists and is non-empty
- every `permissions[].functions[].name` belongs to its declared category
- `contributes.routes` ids are relative and `contributes.links.*.route` references them
- sidebar icons are kebab-case names from `ADDON_ICON_NAMES`
- the bundle imports only declared `hostDependencies` (a declared package covers its own
  subpaths, so `@wealthfolio/ui` also covers `@wealthfolio/ui/chart`)
- the bundle contains **no** `react/jsx-runtime` or `react-dom/client` imports
- the bundle contains **no** `process.env` reference (the sandbox has no `process`)
- the host packages are installed, so `npm run typecheck` can verify import names
- every `ctx.api.<category>` reference in `src/**` is declared in
  `manifest.permissions`, so the host cannot reject it at runtime with
  *"tried to use '<fn>' without permission"*. Sources are scanned with comments
  stripped; baseline categories (`ui`, `query`, `toast`, `logger`, `storage`) are
  exempt. Undeclared and declared-but-unused permissions are both reported
- the archive has `manifest.json` at its root and no `node_modules`

## Versioning

`manifest.json` holds the version and is the single source of truth: the host reads it
and the release archive name is derived from it. `package.json` is rewritten to match,
so npm tooling never disagrees.

**Every generated ZIP increments the version.** `npm run package` bumps patch by default,
then stages, validates and archives, so the archive name, the manifest inside the archive
and the version the host records always agree.

| Command | Version effect |
| --- | --- |
| `npm run package` | `1.0.0` → `1.0.1` (patch) |
| `npm run package:minor` | `1.0.1` → `1.1.0` |
| `npm run package:major` | `1.0.1` → `2.0.0` |
| `npm run package:no-bump` | keeps the current version (re-packs only) |
| `npm run version` | prints the current version |
| `npm run version:bump` | bumps patch without packaging |
| `npm run version:check` | asserts manifest and package agree |

Three independent guards keep the version honest:

1. `validate.mjs` fails on a non-semver version or on drift between `manifest.json`
   and `package.json`
2. `build-release.mjs` bumps **before** staging, so the staged manifest already carries
   the new version
3. `assertArchiveMatchesVersion()` re-reads `manifest.json` from the built archive and
   aborts the release if it disagrees with the archive name

### Range selection

`IntervalSelector` provides the preset pills. The custom calendar button is **not**
`DateRangeSelector`: that component renders its own preset pills *and* a trigger, which
produced two rows of pills, and since every preset was hidden the trigger could never
match one, so it always rendered in the filled "custom range" variant instead of the
ghost variant the application uses.

`src/components/CustomRangeButton.tsx` composes the same built-in primitives the host
uses (`Button` + `Popover` + `DatePickerWithRange`), which keeps the application's own
components while leaving full control over the appearance: one ghost button, draft state
while the popover is open, apply/clear actions, and the filled variant only while a custom
range is actually applied.

## Install

Import `release/contribution-tracker-stats-<version>.zip`
(or the `contribution-tracker-stats.zip` copy) in
**Settings → Add-ons → Import from file**.

## Manifest shape

```jsonc
{
  "id": "contribution-tracker-stats",
  "name": "Contribution Tracker Stats",
  "version": "1.0.0",
  "main": "dist/addon.js",
  "sdkVersion": "3.9.0",
  "minWealthfolioVersion": "3.7.0",
  "icon": "chart-bar",
  "hostDependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "@wealthfolio/addon-sdk": "^3.9.0"
  },
  "permissions": [
    {
      "category": "activities",
      "purpose": "Reads deposit activities to calculate contribution statistics.",
      "functions": [{ "name": "getAll", "isDeclared": true, "isDetected": true }]
    }
  ],
  "contributes": {
    "routes": [{ "id": "contribution-stats" }],
    "links": {
      "sidebar": [{ "route": "contribution-stats", "label": "Contribution Stats", "icon": "chart-bar" }]
    }
  }
}
```

Notes that cost several iterations to get right:

- there is **no `entry` field**; the entry point is `main`
- `permissions[].functions` is an array of `{ name, isDeclared, isDetected }` objects,
  not strings
- `permissions[].purpose` is required
- routes live in `contributes.routes`, links in `contributes.links.<slot>`
- `contributes.routes[].id` **must** equal the `id` passed to `ctx.router.add`
- `contributes.routes[].path` is relative to `/addons/<addon-id>`; omit it for the
  addon root. Absolute paths and `..` are rejected
- do **not** call `ctx.sidebar.addItem` when the sidebar entry comes from
  `contributes.links.sidebar`. A runtime sidebar item with its own `route` creates a
  second navigation target that has no matching runtime route, and the host then reports
  `Addon route '<id>' is not available`
- `routes[].id` and `links[].id` should match, as in the reference addon

Runtime wiring that works (mirrors the documented reference addon):

```ts
ctx.router.add({
  id: 'contribution-stats',                  // === contributes.routes[0].id
  path: '/addons/contribution-tracker-stats', // === /addons/<manifest.id>
  component: Route,
});
```

- the runtime route `path` is the **absolute** host mount `/addons/<manifest.id>`.
  Registering `/<manifest.id>` leaves the declared route unresolvable and the host
  reports `Addon route '<id>' is not available` while the sidebar entry still shows
  (it is built declaratively, without running any addon code)
- the route `id` must equal `contributes.routes[].id`; the sidebar link `route`
  references that same id
- `validate.mjs` asserts the built bundle registers `/addons/<manifest.id>` and
  rejects a bare `/<manifest.id>` mount, so this cannot regress silently

## Data source

`ctx.api.activities.getAll()` resolves `ActivityDetails`, whose shape differs from
`Activity`:

| Field | `ActivityDetails` (`getAll`) | `Activity` |
| --- | --- | --- |
| date | `date` | `activityDate` |
| amount | `amount` (string) | `amount` (string) |
| symbol | `assetSymbol` | `symbol` |

Reading `activityDate` from a `getAll()` result silently yields an empty chart, so
`src/lib/intake.ts` accepts both shapes and is covered by a regression test. Deposits are
rows whose `activityType` (or `activityTypeOverride`) is `DEPOSIT`; rows with a zero amount
or an unparseable date are dropped and counted.

Every load logs one diagnostic line to the host logger:

```
[contribution-tracker-stats] fetched=1234 deposits=87 kept=87 skippedNoDate=0 skippedZeroAmount=0 types={"BUY":800,"DEPOSIT":87,...}
```

If the chart is ever empty again, that line says whether the host returned rows, which
types they had, and how many deposits were dropped and why.

Aggregation helpers are pure in `src/lib/contributions.ts`; the host bridge lives in
`src/hooks/useContributions.ts`.

## i18n

Translations are registered with `registerTranslations()` in `enable()` and read with
`useAddonTranslation()`. `src/i18n.ts` ships an `en` bundle (the host fallback) and a
`pl` bundle. Code, comments and identifiers are English; user-facing strings come from
the bundles.

## Release automation

### `ci.yml` — every push and pull request

| Job | What it does |
| --- | --- |
| `verify` | `typecheck` → `test` → `build` → `validate` on Node 20.19 and 22 |
| `package` | Builds and zips the addon as a downloadable artifact |
| `self-check` | Packs and inspects the archive: root `manifest.json`, an `addon.js` entry, no `node_modules`, no sourcemaps; on a tag, asserts the tag matches the manifest version |

### `release.yml` — `v*` tags and manual dispatch

Same pipeline, then attaches the archive to the GitHub release with generated notes.

Two guards worth knowing about:

- **A tag must equal `manifest.json`'s version.** `npm run package` bumps the version on
  every run, so a tagged build uses `package:no-bump`. Otherwise tagging `v1.0.9` after
  a local `npm run package` would ship `v1.0.10`'s archive under the old name.
- **Sourcemaps are excluded from release archives** (`build-release.mjs` removes
  `addon.js.map`), and `self-check` fails if one sneaks in.
