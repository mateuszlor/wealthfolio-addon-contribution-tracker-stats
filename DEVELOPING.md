# Developing the Contribution Stats addon

Audience: developers changing this addon. For what it does and how to install it, see
[README.md](README.md).

## Requirements

- Node.js >= 20 (CI covers 20.19 and 22)
- Wealthfolio >= 3.7 for running it

## Getting started

```bash
npm ci --legacy-peer-deps     # React 19 is host-provided, so peer ranges disagree
npm run verify                # typecheck -> test -> build -> validate
npm run build && npm run package:no-bump
```

`npm run package:no-bump` produces `release/contribution-tracker-stats-<version>.zip` and
a convenience copy at `contribution-tracker-stats.zip`. Import that copy through
**Settings → Add-ons → Import from file**.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src` |
| `npm test` | Regression tests for the pure intake and aggregation modules |
| `npm run build` | Vite library build to `dist/addon.js` (ES module) |
| `npm run validate` | Manifest, bundle and package layout checks |
| `npm run verify` | `typecheck` → `test` → `build` → `validate` |
| `npm run package` | Bumps the version, stages, validates and zips |
| `npm run package:no-bump` | Same, keeping the current version |
| `npm run release` | `clean` → `verify` → `package` |
| `npm run clean` | Removes `dist`, `build`, `release`, local zip |
| `npm run version` | Prints the current version |
| `npm run version:check` | Asserts manifest and package versions agree |
| `npm run version:bump` / `:minor` / `:major` | Bumps the version without packaging |

## Git workflow

**Never force-push.** Not `git push --force`, and not `--force-with-lease` either — that is
still a force push, it just checks the remote tip first.

A published branch is the shared record of what was reviewed, released and based on by other
work. A non-fast-forward push silently drops commits that someone may already have pulled,
so history is only ever extended, never rewritten.

Concretely:

- Amend, rebase and squash **before** the branch is pushed, or not at all.
- Once pushed, add follow-up commits. A fix becomes its own commit rather than an amend.
- `git revert` is the way to undo something already pushed.
- If a rewrite is genuinely unavoidable, delete the remote branch first — an explicit,
  separate act — and push again. That is a decision for the maintainer, not a default.

`.git/hooks/pre-push` enforces this locally: it refuses any ref whose remote tip is not an
ancestor of the local commit. Hooks are not tracked by git, so after a fresh clone reinstall
it:

```sh
cp docs/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

The copy lives in `docs/pre-push` for exactly that reason.

## Layout

```
src/
├── addon.tsx                          enable(): translations, route, sidebar
├── addon.css                          theme contract for the host's components
├── i18n.ts                            en and pl translation bundles
├── components/
│   ├── ContributionStatsPage.tsx      layout, selectors, summary
│   ├── ContributionChart.tsx          ChartContainer + BarChart
│   └── CustomRangeButton.tsx          ghost button + Popover + DatePickerWithRange
├── hooks/
│   ├── useContributions.ts            host bridge: activities -> records
│   └── useHiddenAmounts.ts            privacy flag in ctx.api.storage (sandbox-safe)
└── lib/
    ├── intake.ts                      raw activities -> contribution records (pure)
    ├── contributions.ts               bucketing, gap filling, summaries (pure)
    └── privacy.ts                     the host's amount mask, for tooltip strings (pure)

scripts/
├── test.mjs                unit tests (esbuild transpiles the TS on the fly)
├── validate.mjs            manifest + bundle + archive checks
├── version.mjs             get / set / bump / check
├── build-release.mjs       stage, validate, zip, checksum
└── clean.mjs               remove build output
```

The three `lib/` modules are deliberately free of React and of the SDK, which is what makes
them testable. The hooks are the only place that touches `ctx.api`.

### Per-account split

`bucketizeByAccount` returns `accounts` plus a bucket per period, where every bucket holds a
value for **every** account (zero included). That is what lets the chart render a stable
stack: if a period were missing an account key, the segment order would change between
columns.

Both views share `buildPeriodAxis`, so the total and the split chart lay bars on exactly
the same x-axis. `fillGaps` is a thin wrapper over it for the total view.

Account ordering is by total contribution, then by name. Without the name tiebreak the
legend would shuffle between reloads when two accounts contribute equally. Account names
are normalised in the lib (`readAccount` in `intake.ts`, plus a guard in
`bucketizeByAccount`) rather than at the call sites, because a record that reaches the lib
without an account would otherwise produce a series literally named `undefined`.

The chart component is series-generic: one series renders a plain bar chart, several share
a `stackId` and stack. Colours come from `seriesColor(index)`, a literal palette — never
from a CSS token, for the reason described above. Only the topmost segment gets
`radius`, otherwise every stacked segment shows rounded corners mid-column.

## Host API rules worth knowing

These cost real debugging time. `validate.mjs` and `typecheck` now enforce most of them,
but the reasoning is worth keeping.

**Named imports are verified by TypeScript, not by a parser.** `npm run typecheck`
resolves `export *` chains, `exports` maps and subpaths exactly, and reports invented
names (`Stack`, `Typography`, `Stat` — none of which exist in `@wealthfolio/ui`) as
`TS2305`. Do not hand-roll a checker for this; the type checker already does it.

**`entry` does not exist.** The entry point is `main`.

**`permissions[].functions` is an array of objects**, `{ name, isDeclared, isDetected }`,
not strings. `permissions[].purpose` is required.

**Routes are declarative.** They live in `contributes.routes`, links in
`contributes.links.<slot>`, and the sidebar icon must be a kebab-case name from
`ADDON_ICON_NAMES`. `contributes.routes[].id` must equal the `id` passed to
`ctx.router.add`.

**Do not call `ctx.sidebar.addItem` when the sidebar entry comes from
`contributes.links.sidebar`.** The host builds navigation from the manifest without
running addon code, so a runtime sidebar item with its own `route` registers a second
target with no matching route, and the host reports
`Addon route '<id>' is not available` while the sidebar entry still appears.

**The runtime route path is the absolute host mount** `/addons/<manifest.id>`. A
`contributes.routes[].path` is *relative* to that mount, and is omitted for the addon
root. Registering `/<manifest.id>` breaks route resolution in the same way.
`validate.mjs` asserts the built bundle registers the right path and rejects the bare form.

**`getAll()` resolves `ActivityDetails`, not `Activity`.** The shapes differ:

| Field | `ActivityDetails` (`getAll`) | `Activity` |
| --- | --- | --- |
| date | `date` | `activityDate` |
| amount | `amount` (string) | `amount` (string) |
| symbol | `assetSymbol` | `symbol` |

Reading `activityDate` from a `getAll()` result silently yields an empty chart. Both
shapes are accepted in `src/lib/intake.ts` and covered by a regression test.

**`ctx.api.settings.get()` needs a permission.** The UI language already comes from
`useAddonTranslation().language`, which normalises regional aliases, so reading settings
for it would request access for nothing.

**The sandbox has no `localStorage`, and no `useBalancePrivacy`.** The add-on runs in an
iframe created with `sandbox="allow-scripts"` (no `allow-same-origin`) from `srcdoc`, so it
has an **opaque origin**: `localStorage.getItem` throws and `localStorage.setItem` throws a
`SecurityError` on every write, which the host classifies into its *"this add-on uses browser
storage"* toast. Persist anything through `ctx.api.storage` instead — it is a baseline
category, so it needs no `manifest.permissions` entry. The same opaque origin owns its
storage area, so `storage` events and `window.dispatchEvent` never cross the frame: there is
no way to observe the host's own state from in here.

Consequently the built-in privacy helpers are unusable:

| Helper | Why |
| --- | --- |
| `useBalancePrivacy()` | reads and writes `localStorage`; read fails silently (always `false`), write throws |
| `PrivacyAmount` | calls `useBalancePrivacy()` internally, so it tracks the app setting, which this addon cannot see |
| `usePersistentState(key, …)` | `window.localStorage` under the hood — reads fail, writes are dropped |

What does work is **`AmountDisplay`**, which takes `isHidden` as a prop instead of reading
global state, and the built-in formatters `useAmountFormatting()` / `useDateFormatting()` /
`FormattingProvider`. The page renders them rather than hand-rolling `Intl`, so separators,
fraction digits and the `••••` mask are the host's. The mask lives in `src/lib/privacy.ts`
only because the chart tooltip is a formatter that must return a string, not a component.

Masking must be a **fixed** string. Replacing just the digits left the group separators and
the compact suffix readable, so a hidden total still said "hundreds of thousands" and the
Y-axis printed `••• mln` — which is why the axis is hidden outright (`hideAxis`) instead of
masked. `npm test` guards the mask against becoming value-dependent again.

**Externalise exactly what the host provides.** `vite.config.ts` lists the externals:
`react`, `react-dom`, `@wealthfolio/addon-sdk`, `@wealthfolio/ui`,
`@wealthfolio/ui/chart` and `recharts`. Bundling `react` would break hooks, because the
host renderer owns the dispatcher.

**The sandbox has no `process`.** `vite.config.ts` defines `process.env.NODE_ENV`, and
`validate.mjs` fails the build if the bundle still references `process.env`.

**Ship plain CSS only.** `addon.css` declares the shadcn custom properties the host's
components style themselves from (`--background`, `--foreground`, `--muted`, …); the
sandbox does not receive the application's stylesheet, so `Card` and `Tabs` render without
them. It must not contain `@import`, `@theme`, `@apply`, `@custom-variant` or `@source`.
In particular, never copy `@wealthfolio/ui/styles.css`: it is an uncompiled Tailwind v4
source file and the host rejects it with *"Addon CSS @import rules are not supported"*.

**Chart colours go through `ChartConfig.theme`, not `var(--chart-1)`.** `ChartStyle`
expands the config into `--color-<key>`, so a token-based colour leaves `fill` unresolved
and the bars render black:

```ts
theme: { light: 'hsl(142 64% 34%)', dark: 'hsl(142 44% 48%)' }
```

**`DateRangeSelector` is not a calendar button.** It renders its own preset pills *and* a
trigger. Combined with `IntervalSelector` that produces two rows of pills, and because
every preset is hidden the trigger can never match one, so it always renders in the
filled "custom range" variant. `CustomRangeButton` composes the same host primitives
instead.

## Manifest shape

```jsonc
{
  "id": "contribution-tracker-stats",
  "name": "Contribution Tracker Stats",
  "version": "1.0.1",
  "main": "dist/addon.js",
  "sdkVersion": "3.9.0",
  "minWealthfolioVersion": "3.7.0",
  "icon": "chart-bar",
  "hostDependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "@wealthfolio/addon-sdk": "^3.9.0",
    "@wealthfolio/ui": "^3.9.0",
    "recharts": "^3.7.0"
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
      "sidebar": [{ "route": "contribution-stats", "label": "Contribution Stats", "icon": "chart-bar", "order": 50 }]
    }
  }
}
```

`storage` is deliberately absent from `permissions`: it is a baseline category.

Runtime wiring that matches it (mirrors the documented reference addon):

```ts
ctx.router.add({
  id: 'contribution-stats',                     // === contributes.routes[0].id
  path: '/addons/contribution-tracker-stats',  // === /addons/<manifest.id>
  component: Route,
});
```

Field-level pitfalls are listed under [Host API rules](#host-api-rules-worth-knowing) above
and enforced by `scripts/validate.mjs`.

## i18n

Translations are registered with `registerTranslations()` inside `enable()` (`src/addon.tsx`)
and read with `useAddonTranslation()`, which also hands out the canonical `language`.
`src/i18n.ts` ships `en` — the host falls back to it for any missing language — and `pl`.

Code, comments and identifiers stay English; every user-facing string comes from a bundle.
New keys go into **both** bundles, otherwise one locale renders the raw key.

Formatting is *not* an i18n concern here: numbers, currencies and dates come from the host
(`FormattingProvider`, `AmountDisplay`, `useAmountFormatting()`, `useDateFormatting()`), so
they follow the application's formatting region rather than the interface language.

## Validation

`scripts/validate.mjs` runs the host's own `validateManifest()` from
`@wealthfolio/addon-sdk`, then adds checks the host cannot express:

- `manifest.main` exists and is non-empty
- every `permissions[].functions[].name` belongs to its declared category
- `contributes.links.*.route` references a declared route id; icons are valid
- the bundle registers `/addons/<manifest.id>` and rejects a bare `/<manifest.id>` mount
- the bundle imports only declared `hostDependencies` (a declared package covers its own
  subpaths)
- the bundle has no `react/jsx-runtime` / `react-dom/client` imports, no `process.env`,
  and a default export for the host to call
- the host packages are installed, so typecheck can verify import names
- every `ctx.api.<category>` reference in `src/**` is declared in `manifest.permissions`,
  with comments stripped and baseline categories exempt. Sources are scanned as well as
  the bundle, because optional chaining (`ctx?.api?.activities`) is compiled down to
  `m.getAll()` and the category name does not survive next to the call
- packaged CSS carries no `@import` or uncompiled Tailwind directive
- version agreement, and the archive contains `manifest.json` at its root with no
  `node_modules`

## Versioning

Locally, every generated ZIP increments the version:

| Command | Effect |
| --- | --- |
| `npm run package` | patch |
| `npm run package:minor` / `:major` | minor / major |
| `npm run package:no-bump` | keep the current version |
| `node scripts/version.mjs set <v>` | set an explicit version |
| `npm run version:check` | assert manifest and package agree |

In CI the **git tag is the source of truth** and nothing has to be mirrored by hand.
`release.yml` derives the version from the pushed tag (`v1.2.3` → `1.2.3`), or
auto-increments on manual dispatch via the `bump` choice, then packages with
`node scripts/build-release.mjs --version <v>`.

`--version` writes the version into the **staged** manifest only, so a tagged build never
mutates the checkout. Both `--version 1.2.3` and `--version=1.2.3` are accepted; an invalid
or missing value aborts the release instead of silently falling back to a bump.

The workflow performs **no git writes** — no commits, no tag pushes. That is deliberate:
an earlier version pushed the version bump to `github.ref_name`, which is the tag ref on a
tag push, and the release failed on `! [rejected] HEAD -> v1.0.0 (already exists)`.

`manifest.json` therefore keeps whatever version the last local `npm run package` wrote.
The released version lives in the tag and in the packaged archive, and
`assertArchiveMatchesVersion()` re-reads the manifest from the built archive to confirm it.

## CI and releases

`ci.yml` runs on every push and pull request:

| Job | What it does |
| --- | --- |
| `verify` | `typecheck` → `test` → `build` → `validate` on Node 20.19 and 22 |
| `package` | Builds and zips the addon as a downloadable artifact |
| `self-check` | Inspects the archive: root `manifest.json`, an `addon.js` entry, no `node_modules`, no sourcemaps |

`release.yml` runs on `v*` tags and manual dispatch, verifies, packages and attaches the
archive to the GitHub release. To publish:

```bash
git tag -a v1.0.1 -m "v1.0.1"
git push origin v1.0.1
```

If the tag already exists remotely, delete it first — tags are immutable and a stale one
will ship the wrong build:

```bash
git push origin :refs/tags/v1.0.1
```

If a local tag points at an older commit than `HEAD`, recreate it before pushing, otherwise
you re-publish a stale build:

```bash
git tag -d v1.0.1 && git tag -a v1.0.1 -m "v1.0.1"
```

## Testing

`npm test` transpiles the pure modules with esbuild and asserts behaviour with
`node:assert`, so there is no test framework dependency. Coverage is deliberately
concentrated on the parts that fail silently:

- `ActivityDetails` vs `Activity` field names, `activityTypeOverride`, comma decimal
  separators, negative amounts, unparseable dates, non-array payloads
- bucketing by month/day/year, chronological ordering
- the per-account split: grouping, zero-filling every account in every bucket, stable
  ordering, name supplied by a later activity, single-account and empty input, and the
  unknown-account collapse
- interval windows and gap filling, including the bucket ceiling
- the privacy mask: fixed width, no digits, separators or unit suffix, identical for every
  locale and every magnitude
- semver bumping

UI behaviour is verified by importing the package into Wealthfolio. That includes the one
thing CI cannot check at all — the sandbox itself: press the eye button, reload the route
(the mask must still be there, and no *"add-on uses browser storage"* toast may appear),
then uninstall and confirm the flag is gone.
