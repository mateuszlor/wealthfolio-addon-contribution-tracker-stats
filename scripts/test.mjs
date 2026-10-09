#!/usr/bin/env node
/**
 * Regression tests for the pure aggregation and intake modules.
 *
 * The TS sources are transpiled on the fly with esbuild (already present via
 * vite), so no test framework dependency is needed.
 *
 * Usage: node scripts/test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadTs(entry) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cts-test-'));
  const outfile = path.join(dir, 'module.mjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------------ intake */

const { mod: intake, cleanup: cleanupIntake } = await loadTs('src/lib/intake.ts');

test('reads ActivityDetails rows, which expose `date` and `assetSymbol`', () => {
  // Regression: reading `activityDate` only silently dropped every row, because
  // `ctx.api.activities.getAll()` resolves `ActivityDetails`.
  const { records, stats } = intake.toContributionRecords([
    {
      activityType: 'DEPOSIT',
      date: new Date('2026-01-15T12:00:00Z'),
      amount: '1000.50',
      currency: 'PLN',
      assetSymbol: '$CASH-PLN',
    },
  ]);

  assert.equal(records.length, 1, 'expected the ActivityDetails row to be kept');
  assert.equal(records[0].amount, 1000.5);
  assert.equal(stats.skippedNoDate, 0);
  assert.equal(stats.deposits, 1);
  assert.deepEqual(records[0].date.toISOString(), '2026-01-15T12:00:00.000Z');
});

test('accepts the Activity shape with `activityDate`', () => {
  const { records } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', activityDate: '2026-02-01T09:00:00Z', amount: 250 },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].amount, 250);
});

test('accepts Date instances as well as ISO strings', () => {
  const { records } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', date: new Date('2026-03-03T00:00:00Z'), amount: '10' },
  ]);
  assert.equal(records.length, 1);
});

test('ignores non-deposit activity types and counts them', () => {
  const { records, stats } = intake.toContributionRecords([
    { activityType: 'BUY', date: '2026-01-01T00:00:00Z', amount: '100' },
    { activityType: 'DIVIDEND', date: '2026-01-02T00:00:00Z', amount: '5' },
    { activityType: 'DEPOSIT', date: '2026-01-03T00:00:00Z', amount: '7' },
  ]);

  assert.equal(records.length, 1);
  assert.equal(stats.fetched, 3);
  assert.equal(stats.deposits, 1);
  assert.equal(stats.byType.BUY, 1);
  assert.equal(stats.byType.DIVIDEND, 1);
});

test('honours activityTypeOverride over activityType', () => {
  const kept = intake.toContributionRecords([
    { activityType: 'BUY', activityTypeOverride: 'DEPOSIT', date: '2026-01-01T00:00:00Z', amount: '3' },
  ]);
  assert.equal(kept.records.length, 1);

  const dropped = intake.toContributionRecords([
    { activityType: 'DEPOSIT', activityTypeOverride: 'SELL', date: '2026-01-01T00:00:00Z', amount: '3' },
  ]);
  assert.equal(dropped.records.length, 0);
});

test('reads the currency from the activity itself', () => {
  // Regression: the page hard-coded `currency = 'PLN'`, so EUR deposits (Sejf
  // EUR, Revolut EUR) were formatted with the wrong symbol and, worse, their
  // totals were shown as if comparable with the PLN ones.
  const { records } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', date: '2026-01-01T00:00:00Z', amount: '100', currency: 'EUR' },
  ]);
  assert.equal(records[0].currency, 'EUR');
});

test('falls back to the $CASH symbol when the currency field is missing', () => {
  const { records } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', activityDate: '2026-02-01T09:00:00Z', amount: 250, assetSymbol: '$CASH-USD' },
  ]);
  assert.equal(records[0].currency, 'USD');
});

test('keeps a deposit with no currency hint instead of dropping it', () => {
  const { records } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', activityDate: '2026-02-01T09:00:00Z', amount: 250 },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].currency, intake.FALLBACK_CURRENCY);
});

test('drops rows without a usable date and reports the count', () => {
  const { records, stats } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', amount: '100' },
    { activityType: 'DEPOSIT', date: 'not-a-date', amount: '100' },
  ]);
  assert.equal(records.length, 0);
  assert.equal(stats.skippedNoDate, 2);
});

test('drops zero amounts and reports the count', () => {
  const { records, stats } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', date: '2026-01-01T00:00:00Z', amount: '0' },
    { activityType: 'DEPOSIT', date: '2026-01-02T00:00:00Z', amount: null },
  ]);
  assert.equal(records.length, 0);
  assert.equal(stats.skippedZeroAmount, 2);
});

test('parses amounts written with a comma decimal separator', () => {
  const { records } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', date: '2026-01-01T00:00:00Z', amount: '1 234,56' },
  ]);
  assert.equal(records[0].amount, 1234.56);
});

test('normalises negative amounts to positive contributions', () => {
  const { records } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', date: '2026-01-01T00:00:00Z', amount: '-50' },
  ]);
  assert.equal(records[0].amount, 50);
});

test('returns records sorted chronologically', () => {
  const { records } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', date: '2026-03-01T00:00:00Z', amount: '1' },
    { activityType: 'DEPOSIT', date: '2025-12-31T00:00:00Z', amount: '2' },
    { activityType: 'DEPOSIT', date: '2026-01-15T00:00:00Z', amount: '3' },
  ]);
  assert.deepEqual(
    records.map((r) => r.amount),
    [2, 3, 1],
  );
});

test('tolerates a non-array payload', () => {
  assert.deepEqual(intake.toContributionRecords(null).records, []);
  assert.deepEqual(intake.toContributionRecords(undefined).records, []);
  assert.deepEqual(intake.toContributionRecords({}).records, []);
});

/* ----------------------------------------------------------- contributions */

const { mod: contributions, cleanup: cleanupContributions } = await loadTs('src/lib/contributions.ts');

const record = (iso, amount, account = 'acc-1', accountName = 'Main') => ({
  date: new Date(iso),
  amount,
  accountId: account,
  accountName: accountName || account,
});

test('buckets by month', () => {
  const buckets = contributions.bucketize(
    [
      record('2026-01-05T00:00:00Z', 100),
      record('2026-01-20T00:00:00Z', 50),
      record('2026-02-02T00:00:00Z', 70),
    ],
    'month',
    'en',
  );

  assert.deepEqual(
    buckets.map((b) => b.key),
    ['2026-01', '2026-02'],
  );
  assert.equal(buckets[0].total, 150);
  assert.equal(buckets[0].count, 2);
});

test('buckets by day', () => {
  const buckets = contributions.bucketize(
    [record('2026-01-05T00:00:00Z', 10), record('2026-01-05T10:00:00Z', 5)],
    'day',
  );
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].key, '2026-01-05');
  assert.equal(buckets[0].total, 15);
});

test('buckets by year', () => {
  const buckets = contributions.bucketize(
    [record('2025-06-01T00:00:00Z', 1), record('2026-06-01T00:00:00Z', 2)],
    'year',
  );
  assert.deepEqual(
    buckets.map((b) => b.key),
    ['2025', '2026'],
  );
});

test('summarises totals, counts and averages', () => {
  const summary = contributions.summarize([
    record('2026-01-15T00:00:00Z', 100),
    record('2026-03-15T00:00:00Z', 300),
  ]);

  assert.equal(summary.total, 400);
  assert.equal(summary.count, 2);
  assert.equal(summary.average, 200);
  // Jan..Mar is a 3-month span, so 400/3.
  assert.equal(Math.round(summary.monthlyAverage), 133);
  assert.equal(summary.first, '2026-01-15');
  assert.equal(summary.last, '2026-03-15');
});

test('a single month counts as one month, not zero', () => {
  const summary = contributions.summarize([record('2026-02-10T00:00:00Z', 500)]);
  assert.equal(summary.monthlyAverage, 500);
});

test('summarising nothing yields zeros', () => {
  const summary = contributions.summarize([]);
  assert.deepEqual(summary, { total: 0, count: 0, average: 0, monthlyAverage: 0 });
});

/* ---------------------------------------------------------------- privacy */

const { mod: privacy, cleanup: cleanupPrivacy } = await loadTs('src/lib/privacy.ts');

test('shows the formatted amount untouched while amounts are visible', () => {
  assert.equal(privacy.maskAmount('PLN 12 345', false), 'PLN 12 345');
  assert.equal(privacy.maskAmount('1,2 mln', false), '1,2 mln');
});

test('a hidden amount is the fixed mask in every locale', () => {
  // Regression: masking only the digits left the group separators and the compact
  // suffix intact, so a hidden total still read as "hundreds of thousands".
  for (const formatted of ['PLN 12,345', 'PLN 1,234,567', '1.2K', '1,2 mln', '0']) {
    assert.equal(privacy.maskAmount(formatted, true), privacy.HIDDEN_AMOUNT);
  }
});

test('the mask cannot give away the order of magnitude', () => {
  // The failure mode this guards: a mask built from the input leaks its length,
  // its separators and its unit suffix.
  const small = privacy.maskAmount('PLN 1 200', true);
  const large = privacy.maskAmount('PLN 1 234 567 890', true);

  assert.equal(small, large, 'the mask must not depend on the value');
  assert.equal(small.length, large.length, 'the mask must have a fixed width');
  assert.ok(!/[\d.,]/.test(small), 'the mask must not contain digits or separators');
  assert.ok(!/k|m|tys|mln|mld|bn/i.test(small), 'the mask must not contain a unit suffix');
});

test('the mask is the one the host renders', () => {
  // `AmountDisplay` / `PrivacyAmount` render four U+2022, so the tooltip cannot
  // look different from the summary.
  assert.equal(privacy.HIDDEN_AMOUNT, '\u2022\u2022\u2022\u2022');
});

/* -------------------------------------------------------------- version.mjs */

const version = await import(pathToFileURL(path.join(ROOT, 'scripts', 'version.mjs')).href);

test('bumps patch, minor and major', () => {
  assert.equal(version.bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(version.bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(version.bumpVersion('1.2.3', 'major'), '2.0.0');
});

test('drops pre-release metadata when bumping', () => {
  assert.equal(version.bumpVersion('1.2.3-beta.1', 'patch'), '1.2.4');
});

test('rejects invalid versions and bump types', () => {
  assert.throws(() => version.bumpVersion('1.2', 'patch'));
  assert.throws(() => version.bumpVersion('1.2.3', 'nope'));
});

/* ---------------------------------------------------------- per account */

test('groups deposits by period and account', () => {
  const result = contributions.bucketizeByAccount(
    [
      record('2026-01-05T00:00:00Z', 100, 'a', 'Broker'),
      record('2026-01-20T00:00:00Z', 50, 'b', 'Bank'),
      record('2026-02-02T00:00:00Z', 70, 'a', 'Broker'),
    ],
    'month',
    'en',
  );

  assert.deepEqual(
    result.accounts.map((a) => a.id),
    ['a', 'b'],
    'largest contributor first',
  );
  assert.deepEqual(
    result.accounts.map((a) => a.name),
    ['Broker', 'Bank'],
  );

  assert.deepEqual(
    result.buckets.map((b) => b.key),
    ['2026-01', '2026-02'],
  );
  assert.equal(result.buckets[0].values.a, 100);
  assert.equal(result.buckets[0].values.b, 50);
  assert.equal(result.buckets[0].total, 150);
  assert.equal(result.buckets[1].values.b, 0, 'missing account is zero, not absent');
});

test('every bucket carries every account, even with no deposits', () => {
  const result = contributions.bucketizeByAccount(
    [
      record('2026-01-05T00:00:00Z', 100, 'a'),
      record('2026-01-06T00:00:00Z', 30, 'b'),
      record('2026-04-05T00:00:00Z', 70, 'a'),
    ],
    'month',
    'en',
  );

  assert.deepEqual(
    result.buckets.map((b) => b.key),
    ['2026-01', '2026-02', '2026-03', '2026-04'],
    'empty months are inserted',
  );

  for (const bucket of result.buckets) {
    assert.ok('a' in bucket.values, 'account a present in every bucket');
    assert.ok('b' in bucket.values, 'account b present in every bucket');
  }

  assert.equal(result.buckets[1].values.a, 0);
  assert.equal(result.buckets[1].values.b, 0);
  assert.equal(result.buckets[3].values.a, 70);
});

test('account order is by total then name, so it is stable across reloads', () => {
  const result = contributions.bucketizeByAccount(
    [
      record('2026-01-05T00:00:00Z', 100, 'a', 'Zeta'),
      record('2026-01-06T00:00:00Z', 100, 'b', 'Alpha'),
      record('2026-01-07T00:00:00Z', 400, 'c', 'Mid'),
    ],
    'month',
    'en',
  );

  assert.deepEqual(
    result.accounts.map((a) => a.name),
    ['Mid', 'Alpha', 'Zeta'],
  );
});

test('a later activity can supply the account name an earlier one lacked', () => {
  const result = contributions.bucketizeByAccount(
    [
      record('2026-01-05T00:00:00Z', 10, 'a', 'a'),
      record('2026-02-05T00:00:00Z', 10, 'a', 'Broker'),
    ],
    'month',
    'en',
  );

  assert.deepEqual(
    result.accounts.map((a) => a.name),
    ['Broker'],
  );
});

test('splitting one account yields a single series with the same total', () => {
  const records = [record('2026-01-05T00:00:00Z', 100), record('2026-02-05T00:00:00Z', 250)];

  const split = contributions.bucketizeByAccount(records, 'month', 'en');
  const total = contributions.fillGaps(contributions.bucketize(records, 'month', 'en'), 'month', 'en');

  assert.equal(split.accounts.length, 1);
  assert.equal(
    split.buckets.reduce((sum, b) => sum + b.total, 0),
    total.reduce((sum, b) => sum + b.total, 0),
  );
});

test('splitting nothing yields no accounts and no buckets', () => {
  const result = contributions.bucketizeByAccount([], 'month', 'en');
  assert.deepEqual(result.accounts, []);
  assert.deepEqual(result.buckets, []);
});

test('unknown accounts collapse into a single series', () => {
  const result = contributions.bucketizeByAccount(
    [
      { date: new Date('2026-01-05T00:00:00Z'), amount: 10 },
      { date: new Date('2026-01-06T00:00:00Z'), amount: 20 },
    ],
    'month',
    'en',
  );

  assert.deepEqual(
    result.accounts.map((a) => a.id),
    ['unknown-account'],
  );
  assert.equal(result.buckets[0].total, 30);
});

test('intake reads accountId and accountName', () => {
  const { records } = intake.toContributionRecords([
    {
      activityType: 'DEPOSIT',
      date: '2026-01-05T00:00:00Z',
      amount: '100',
      accountId: 'acc-9',
      accountName: '  Bank  ',
    },
  ]);

  assert.equal(records[0].accountId, 'acc-9');
  assert.equal(records[0].accountName, 'Bank', 'account name is trimmed');
});

/* ---------------------------------------------------------------- gaps */

test('fills empty months between the first and last bucket', () => {
  const buckets = contributions.bucketize(
    [record('2025-11-10T00:00:00Z', 100), record('2026-02-10T00:00:00Z', 300)],
    'month',
    'en',
  );

  assert.deepEqual(
    buckets.map((b) => b.key),
    ['2025-11', '2026-02'],
  );

  const filled = contributions.fillGaps(buckets, 'month', 'en');

  assert.deepEqual(
    filled.map((b) => b.key),
    ['2025-11', '2025-12', '2026-01', '2026-02'],
  );
  assert.equal(filled[1].total, 0);
  assert.equal(filled[1].count, 0);
  assert.equal(filled[0].total, 100, 'existing values survive');
  assert.equal(filled[3].total, 300);
});

test('fills empty years', () => {
  const buckets = contributions.bucketize(
    [record('2023-05-01T00:00:00Z', 1), record('2026-05-01T00:00:00Z', 2)],
    'year',
  );

  const filled = contributions.fillGaps(buckets, 'year', 'en');

  assert.deepEqual(
    filled.map((b) => b.key),
    ['2023', '2024', '2025', '2026'],
  );
  assert.equal(filled[1].total, 0);
});

test('filling gaps crosses a year boundary correctly', () => {
  const buckets = contributions.bucketize(
    [record('2024-11-01T00:00:00Z', 5), record('2025-02-01T00:00:00Z', 9)],
    'month',
    'en',
  );

  assert.deepEqual(
    contributions.fillGaps(buckets, 'month', 'en').map((b) => b.key),
    ['2024-11', '2024-12', '2025-01', '2025-02'],
  );
});

test('filling gaps is a no-op for short series', () => {
  const buckets = contributions.bucketize([record('2026-01-05T00:00:00Z', 5)], 'month', 'en');
  assert.equal(contributions.fillGaps(buckets, 'month', 'en').length, 1);
  assert.deepEqual(contributions.fillGaps([], 'month', 'en'), []);
});

test('filling gaps respects the bucket ceiling', () => {
  // A day-level view over a year would otherwise emit 365 empty columns.
  const buckets = contributions.bucketize(
    [record('2020-01-01T00:00:00Z', 1), record('2026-01-01T00:00:00Z', 2)],
    'year',
  );

  assert.equal(contributions.fillGaps(buckets, 'year', 'en', 3).length, 3);
});

/* ------------------------------------------------------------ date windows */

test('filters records by an inclusive date window', () => {
  const records = [
    record('2025-11-30T00:00:00Z', 1),
    record('2025-12-01T00:00:00Z', 2),
    record('2025-12-31T00:00:00Z', 3),
    record('2026-01-01T00:00:00Z', 4),
  ];

  const window = {
    from: new Date('2025-12-01T00:00:00Z'),
    to: new Date('2025-12-31T00:00:00Z'),
  };

  assert.deepEqual(
    contributions.filterByRange(records, window).map((r) => r.amount),
    [2, 3],
  );
});

test('an open window keeps every record', () => {
  const records = [record('2024-01-01T00:00:00Z', 1), record('2026-01-01T00:00:00Z', 2)];

  assert.deepEqual(contributions.filterByRange(records, {}), records);
  assert.equal(
    contributions.filterByRange(records, { from: new Date('2025-01-01T00:00:00Z') }).length,
    1,
  );
});

test('the interval window and the bucket granularity compose', () => {
  // Regression shape: selecting an interval and grouping by month must aggregate
  // only the records inside that window.
  const records = [
    record('2024-06-15T00:00:00Z', 10),
    record('2026-01-10T00:00:00Z', 20),
    record('2026-02-10T00:00:00Z', 30),
  ];

  const window = {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-12-31T00:00:00Z'),
  };

  const buckets = contributions.bucketize(
    contributions.filterByRange(records, window),
    'month',
    'en',
  );

  assert.deepEqual(
    buckets.map((b) => b.key),
    ['2026-01', '2026-02'],
  );
  assert.equal(
    buckets.reduce((sum, b) => sum + b.total, 0),
    50,
  );
});

/* ------------------------------------------------------- drill-down panel */

const OPEN = { from: undefined, to: undefined };

test('the drill-down lists every deposit behind the bar', () => {
  const records = [
    record('2026-01-05T00:00:00Z', 100),
    record('2026-01-20T00:00:00Z', 50),
    record('2026-02-02T00:00:00Z', 70),
  ];

  const january = contributions.selectDrillDownRecords(
    records,
    OPEN,
    { periodKey: '2026-01' },
    'month',
  );

  assert.equal(january.length, 2);
  assert.equal(january.reduce((sum, r) => sum + r.amount, 0), 150);
});

test('the drill-down narrows to one account in the per-account view', () => {
  const records = [
    record('2026-01-05T00:00:00Z', 100, 'acc-1', 'Main'),
    record('2026-01-06T00:00:00Z', 200, 'acc-2', 'Pension'),
    record('2026-01-07T00:00:00Z', 300, 'acc-1', 'Main'),
  ];

  const pension = contributions.selectDrillDownRecords(
    records,
    OPEN,
    { periodKey: '2026-01', accountId: 'acc-2' },
    'month',
  );

  assert.equal(pension.length, 1);
  assert.equal(pension[0].amount, 200);
});

test('the drill-down applies the interval window itself', () => {
  // The selector owns the window rather than taking a pre-scoped list, so the
  // scoping is covered here instead of at a call site no test can reach. Reverting
  // the call to pass unscoped records used to leave this suite green.
  const all = [
    record('2025-10-15T00:00:00Z', 100),
    record('2025-12-01T00:00:00Z', 200),
    record('2025-03-01T00:00:00Z', 999), // outside the window
  ];

  const window = { from: new Date('2025-10-09T00:00:00Z') };
  const bar = contributions.bucketize(
    contributions.filterByRange(all, window),
    'year',
    'en',
  )[0];

  const shown = contributions.selectDrillDownRecords(all, window, { periodKey: bar.key }, 'year');

  // The bar covers Oct-Dec only, so the panel has to agree with it.
  assert.equal(bar.total, 300);
  assert.equal(shown.reduce((sum, r) => sum + r.amount, 0), bar.total);

  // And the mistake the panel used to make, now asserted rather than assumed.
  const unscoped = contributions.selectDrillDownRecords(all, OPEN, { periodKey: bar.key }, 'year');
  assert.equal(unscoped.reduce((sum, r) => sum + r.amount, 0), 1299);
});

test('the drill-down window narrows within a single period', () => {
  const records = [
    record('2026-01-10T00:00:00Z', 100),
    record('2026-01-20T00:00:00Z', 250),
  ];

  const inside = contributions.selectDrillDownRecords(
    records,
    { from: new Date('2026-01-15T00:00:00Z') },
    { periodKey: '2026-01' },
    'month',
  );

  assert.equal(inside.length, 1);
  assert.equal(inside[0].amount, 250);
});

test('the drill-down is empty for a period with no deposits', () => {
  const records = [record('2026-01-05T00:00:00Z', 100)];

  assert.deepEqual(
    contributions.selectDrillDownRecords(records, OPEN, { periodKey: '2026-03' }, 'month'),
    [],
  );
});

test('a series key resolves to the account behind it', () => {
  const accounts = [
    { id: 'acc-1', name: 'Main' },
    { id: 'acc-2', name: 'Pension' },
  ];

  assert.deepEqual(contributions.resolveAccountFromSeriesKey(accounts, 's0'), accounts[0]);
  assert.deepEqual(contributions.resolveAccountFromSeriesKey(accounts, 's1'), accounts[1]);
});

test('an out-of-range series key resolves to nothing, not to "every account"', () => {
  const accounts = [{ id: 'acc-1', name: 'Main' }];

  assert.equal(contributions.resolveAccountFromSeriesKey(accounts, 's7'), undefined);
  assert.equal(contributions.resolveAccountFromSeriesKey(accounts, 'total'), undefined);
});

/* --------------------------------------------------------------------- run */
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (cause) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${cause.message}`);
  }
}

await cleanupIntake();
await cleanupContributions();
await cleanupPrivacy();

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
