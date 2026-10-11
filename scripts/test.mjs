#!/usr/bin/env node
/**
 * Regression tests for the pure aggregation and intake modules.
 *
 * The TS sources are transpiled on the fly with esbuild (already present via
 * vite), so no test framework dependency is needed.
 *
 * Usage: node scripts/test.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

/* ------------------------------------------------------------- flows */

test('a WITHDRAWAL activity becomes a withdrawals record', () => {
  const { records, stats } = intake.toContributionRecords([
    {
      activityType: 'WITHDRAWAL',
      date: '2026-02-10T00:00:00Z',
      amount: '500',
      currency: 'PLN',
    },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].flow, 'withdrawals');
  assert.equal(records[0].amount, 500, 'the amount stays positive; the sign lives in flow');
  assert.equal(stats.withdrawals, 1);
  assert.equal(stats.deposits, 0);
});

test('TRANSFER_OUT is never counted as a withdrawal', () => {
  // The regression guard for the definitional choice: a transfer between the
  // user's own accounts is not money leaving the ledger.
  const { records, stats } = intake.toContributionRecords([
    { activityType: 'TRANSFER_OUT', date: '2026-02-10T00:00:00Z', amount: '500' },
    { activityType: 'TRANSFER_IN', date: '2026-02-10T00:00:00Z', amount: '500' },
  ]);

  assert.equal(records.length, 0);
  assert.equal(stats.withdrawals, 0);
  assert.equal(stats.deposits, 0);
  assert.equal(stats.byType.TRANSFER_OUT, 1, 'still counted, so a wrong filter is visible');
});

test('activityTypeOverride can turn a row into a withdrawal', () => {
  const { records } = intake.toContributionRecords([
    { activityType: 'BUY', activityTypeOverride: 'WITHDRAWAL', date: '2026-02-10T00:00:00Z', amount: '100' },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].flow, 'withdrawals');
});

test('deposits and withdrawals produce records in one pass', () => {
  const { records, stats } = intake.toContributionRecords([
    { activityType: 'DEPOSIT', date: '2026-01-05T00:00:00Z', amount: '100' },
    { activityType: 'WITHDRAWAL', date: '2026-01-20T00:00:00Z', amount: '40' },
  ]);

  assert.equal(records.length, 2);
  assert.equal(stats.deposits, 1);
  assert.equal(stats.withdrawals, 1);
});

/* ----------------------------------------------------------- contributions */

const { mod: contributions, cleanup: cleanupContributions } = await loadTs('src/lib/contributions.ts');

const record = (iso, amount, account = 'acc-1', accountName = 'Main', flow = 'deposits') => ({
  date: new Date(iso),
  amount,
  flow,
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

/* ----------------------------------------------------------------- window */

const { mod: window, cleanup: cleanupWindow } = await loadTs('src/lib/window.ts');

test('the same window keeps one identity across renders', () => {
  // The regression. `rangeFor` builds fresh `Date`s, so handing its result
  // straight to the hook gave every render a new object. The drill-down's reset
  // effect depends on the range, so it re-ran on every render and cleared the
  // panel in the same commit the click opened it — the click appeared to do
  // nothing while every other test stayed green.
  const intervalRange = () => ({ from: new Date('2025-10-10'), to: new Date('2026-10-10') });
  const selection = { kind: 'interval', code: '1Y' };

  const first = window.stableRange(selection, intervalRange, undefined);
  const second = window.stableRange(selection, intervalRange, first);
  const third = window.stableRange(selection, intervalRange, second);

  assert.equal(second, first, 'an unchanged window must keep its object');
  assert.equal(third, first);

  // A different window is a new object, so the effect that depends on it runs.
  const moved = window.stableRange({ kind: 'month', key: '2026-03' }, intervalRange, first);
  assert.notEqual(moved, first);
  assert.equal(moved.from?.getFullYear(), 2026);
  assert.equal(moved.from?.getMonth(), 2);
});

test('a window with equal instants but different objects is unchanged', () => {
  const resolver = () => ({ from: new Date(1000), to: new Date(2000) });
  const first = window.stableRange({ kind: 'interval', code: '1Y' }, resolver, undefined);

  // A resolver returning equal instants must not be mistaken for a new window,
  // or every preset lookup would reset the panel.
  const again = window.stableRange({ kind: 'interval', code: '1Y' }, resolver, first);
  assert.equal(again, first);
});

test('an open window stays open rather than collapsing to undefined', () => {
  const open = { from: undefined, to: undefined };
  const missing = undefined;

  assert.equal(window.sameWindow(open, missing), false);
  assert.equal(window.sameWindow(missing, missing), true);
  assert.equal(window.sameWindow(open, { from: undefined, to: undefined }), true);
});

/* ------------------------------------------------------- drill-down reset */

/**
 * The page closes an open drill-down whenever the chart's meaning changes. The
 * range used to be one of those dependencies, and React compares it by identity:
 * a window rebuilt during render re-ran the effect on every render, so a click
 * opened the panel and the same commit closed it. No bar ever showed its
 * deposits, with every test green.
 *
 * The dependency list is a source-level contract, so it is asserted as one. It
 * has to name granularity, view and currency, and it must not name the range.
 */
test('the drill-down reset does not depend on the range', async () => {
  const source = await readFile(path.join(ROOT, 'src/components/ContributionStatsPage.tsx'), 'utf8');

  const effect = source.match(/setDrillDown\(null\);\s*\},?\s*\[([^\]]*)\]/);
  assert.ok(effect, 'the reset effect must be findable, with its dependency list');

  const deps = effect[1];
  for (const required of ['granularity', 'splitMode', 'currency']) {
    assert.match(deps, new RegExp(required), `${required} must still reset the panel`);
  }
  assert.doesNotMatch(deps, /range/, 'the range must not reset the panel: identity comparison closed it');
});

/* -------------------------------------------------------- currency convert */

const { mod: convert, cleanup: cleanupConvert } = await loadTs('src/lib/convert.ts');

const convRecord = (iso, amount, currency) => ({
  date: new Date(iso),
  amount,
  flow: 'deposits',
  currency,
  accountId: 'acc-1',
  accountName: 'Main',
  activityId: '',
});

test('plans one (pair, day) per distinct currency+day, in base terms', () => {
  const plan = convert.planRateQueries(
    [
      convRecord('2026-01-05T00:00:00Z', 100, 'EUR'),
      convRecord('2026-01-05T10:00:00Z', 50, 'EUR'), // same day, deduped
      convRecord('2026-01-06T00:00:00Z', 20, 'PLN'), // already base
      convRecord('2026-01-07T00:00:00Z', 10, 'eur'), // case-normalised, deduped with the 5th
      convRecord('2026-01-07T00:00:00Z', 5, 'PLN'),
    ],
    'PLN',
  );

  assert.deepEqual(plan, [
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05' },
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-07' },
  ], 'distinct (currency, day) pairs only, sorted and deduplicated');
});

test('a result is matched by the pair it names, not by its position', () => {
  // The SDK documents "one result per requested pair, in the same order", so
  // positional pairing satisfies the contract — but a result carries its own
  // from/to/date precisely so it can be matched on identity, and pairing by
  // index mis-prices silently when the host ever deviates: the record converts,
  // the chart renders, and the number is simply wrong.
  const queries = [
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05' },
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-07' },
    { fromCurrency: 'USD', toCurrency: 'PLN', date: '2026-01-05' },
  ];

  // Same set of results, deliberately reversed.
  const table = convert.rateTableFromResults(queries, [
    { fromCurrency: 'USD', toCurrency: 'PLN', date: '2026-01-05', rate: 3.9, error: null },
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-07', rate: 4.6, error: null },
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05', rate: 4.5, error: null },
  ]);

  assert.equal(table.get('EUR|PLN|2026-01-05'), 4.5);
  assert.equal(table.get('EUR|PLN|2026-01-07'), 4.6);
  assert.equal(table.get('USD|PLN|2026-01-05'), 3.9);
});

test('a result naming a day nobody asked for is ignored, not applied', () => {
  // The SDK mentions "nearest available quotes". If the host echoes the quote's
  // own date rather than the requested one, pairing by identity must leave the
  // pair absent so the record is dropped and counted — never priced with the
  // wrong day's rate, which would look entirely plausible on screen.
  const queries = [{ fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05' }];

  const table = convert.rateTableFromResults(queries, [
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-06', rate: 4.5, error: null },
  ]);

  assert.equal(table.has('EUR|PLN|2026-01-05'), false, 'a different day must not answer the query');
  assert.equal(table.size, 0);
});

test('one failed pair cannot poison another by position', () => {
  const queries = [
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05' },
    { fromCurrency: 'USD', toCurrency: 'PLN', date: '2026-01-05' },
  ];

  const table = convert.rateTableFromResults(queries, [
    { fromCurrency: 'USD', toCurrency: 'PLN', date: '2026-01-05', rate: null, error: 'no quote' },
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05', rate: 4.5, error: null },
  ]);

  assert.equal(table.get('EUR|PLN|2026-01-05'), 4.5, 'the resolvable pair keeps its own rate');
  assert.equal(table.has('USD|PLN|2026-01-05'), false, 'the failed pair stays absent, not zero');
});

test('a result nobody requested never enters the table', () => {
  const queries = [{ fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05' }];

  const table = convert.rateTableFromResults(queries, [
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05', rate: 4.5, error: null },
    { fromCurrency: 'GBP', toCurrency: 'PLN', date: '2026-01-05', rate: 5.1, error: null },
  ]);

  assert.equal(table.size, 1, 'only the requested pair may be stored');
});

test('rates results become a table; unresolvable pairs stay absent', () => {
  const queries = [
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05' },
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-07' },
  ];

  const table = convert.rateTableFromResults(queries, [
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-05', rate: 4.5, error: null },
    { fromCurrency: 'EUR', toCurrency: 'PLN', date: '2026-01-07', rate: null, error: 'no quote' },
  ]);

  assert.equal(table.get('EUR|PLN|2026-01-05'), 4.5);
  assert.equal(table.has('EUR|PLN|2026-01-07'), false, 'a failed pair must be absent, not zero');
});

test('convertRecords scales by the historical rate and reports drops', () => {
  const records = [
    convRecord('2026-01-05T00:00:00Z', 100, 'EUR'),
    convRecord('2026-01-05T00:00:00Z', 500, 'PLN'),
    convRecord('2026-01-07T00:00:00Z', 20, 'EUR'), // no rate for this date
  ];

  const rates = new Map([['EUR|PLN|2026-01-05', 4.5]]);
  const { records: out, dropped } = convert.convertRecords(records, 'PLN', rates);

  assert.deepEqual(
    out.map((r) => ({ amount: r.amount, currency: r.currency, date: r.date })),
    [
      { amount: 450, currency: 'PLN', date: records[0].date },
      { amount: 500, currency: 'PLN', date: records[1].date },
    ],
    'base-currency records pass through untouched; EUR is converted to base',
  );
  assert.equal(dropped, 1, 'the unrated row is dropped, not zeroed');
});

test('an all-base record set converts to itself with zero drops', () => {
  const records = [convRecord('2026-01-05T00:00:00Z', 100, 'PLN')];
  const { records: out, dropped } = convert.convertRecords(records, 'PLN', new Map());

  assert.equal(out.length, 1);
  assert.equal(out[0].amount, 100);
  assert.equal(dropped, 0);
});

test('the page wiring: conversion is fed the bridge, the ALL sentinel returns to the last currency', async () => {
  // A source-level contract like the drill-down one: the hook call must be
  // unconditional (React forbids hooks behind a ternary that changes with
  // state), and the page must not clear the user's currency choice when the
  // sentinel is on.
  const source = await readFile(path.join(ROOT, 'src/components/ContributionStatsPage.tsx'), 'utf8');

  assert.match(source, /useConvertedRecords\(ctx, records\)/, 'hook is called unconditionally');
  assert.match(source, /CURRENCY_ALL/, 'the ALL sentinel exists');
  assert.match(source, /currencyChoice === CURRENCY_ALL/, 'the sentinel is switched on by selection');
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

/**
 * The regression the host exposed: the per-account split was fed the whole,
 * unfiltered `scoped` list, so under the withdrawals view the stacked chart
 * summed deposits into the bars while the drill-down panel (which filters by
 * flow) listed withdrawals. The bar and the panel disagreed by construction.
 *
 * The page now calls `bucketizeByAccount` on `flowRecords`, not `scoped`.
 * This test pins the composition the page must use.
 */
test('the per-account split under one flow sees only that flow', () => {
  const records = [
    record('2026-01-05T00:00:00Z', 100, 'a', 'Broker'),
    record('2026-01-20T00:00:00Z', 40, 'b', 'Bank', 'withdrawals'),
  ];

  const flowRecords = contributions.selectFlow(records, 'withdrawals');
  const split = contributions.bucketizeByAccount(flowRecords, 'month', 'en', 'withdrawals');

  assert.deepEqual(
    split.accounts.map((a) => a.id),
    ['b'],
    'the withdrawals view must not carry a deposits series',
  );
  // A withdrawal is an outflow: the bar for it must read *below* the axis.
  assert.equal(split.buckets[0].total, -40);

  // Conversely, feeding the unfiltered list is exactly the shape the bug had:
  // kept explicit so a revert that "works" is recognised as the old behaviour.
  const unfiltered = contributions.bucketizeByAccount(records, 'month', 'en', 'withdrawals');
  // Signed the new way, deposits (+100) outweigh the withdrawal (−40), so the
  // magnitude ordering puts 'a' first — the accounts themselves are the pin.
  assert.deepEqual(
    unfiltered.accounts.map((a) => a.id).sort(),
    ['a', 'b'],
    'unfiltered input yields both flows — the shape the bug had',
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

test('clicking a total-view bar lists its deposits, not an empty panel', () => {
  // The regression, end to end through the selector.
  //
  // The chart used to decide "is this an account?" by asking whether the key was
  // literally `total`. That is a rename away from silently answering "yes, an
  // account called s0" and filtering on an id no record has, which is what left
  // every click opening an empty panel.
  const records = [
    record('2026-01-05T00:00:00Z', 100, 'acc-1'),
    record('2026-01-06T00:00:00Z', 200, 'acc-2'),
  ];

  // The total view has no accounts behind its key.
  const info = contributions.barClickToDrillDown(
    { periodKey: '2026-01', periodLabel: 'Jan 2026', dataKey: 'total', value: 300 },
    [],
  );

  // No account filter: the segment belongs to the period, not to an account.
  assert.equal(info.accountId, undefined);

  const panel = contributions.selectDrillDownRecords(records, OPEN, info, 'month');

  assert.equal(panel.length, 2, 'the panel must list the deposits behind the bar');
  assert.equal(panel.reduce((sum, r) => sum + r.amount, 0), 300);
});

test('a per-account click resolves to the account behind the series', () => {
  const accounts = [
    { id: 'acc-1', name: 'Main' },
    { id: 'acc-2', name: 'Pension' },
  ];

  const info = contributions.barClickToDrillDown(
    { periodKey: '2026-01', periodLabel: 'Jan 2026', dataKey: 's1', value: 200 },
    accounts,
  );

  assert.equal(info.accountId, 'acc-2');

  const records = [
    record('2026-01-05T00:00:00Z', 100, 'acc-1', 'Main'),
    record('2026-01-06T00:00:00Z', 200, 'acc-2', 'Pension'),
  ];

  const panel = contributions.selectDrillDownRecords(records, OPEN, info, 'month');

  assert.equal(panel.length, 1);
  assert.equal(panel[0].amount, 200);
});

test('an unresolvable series key opens no panel at all', () => {
  const accounts = [{ id: 'acc-1', name: 'Main' }];

  // Out of range: opening the period here would list every account under a
  // segment name that names none of them.
  assert.equal(
    contributions.barClickToDrillDown(
      { periodKey: '2026-01', periodLabel: 'Jan 2026', dataKey: 's7', value: 10 },
      accounts,
    ),
    undefined,
  );
});

/* ------------------------------------------------------- flows aggregate */

test('summarize signs withdrawals under the net view only', () => {
  const records = [
    record('2026-01-05T00:00:00Z', 100),
    record('2026-01-20T00:00:00Z', 40, 'acc-1', 'Main', 'withdrawals'),
  ];

  // `summarize` signs the ledger but does not filter it: the caller narrows to
  // one flow first (`selectFlow`), which is what the page does.
  const depositsOnly = contributions.selectFlow(records, 'deposits');
  const withdrawalsOnly = contributions.selectFlow(records, 'withdrawals');

  assert.equal(contributions.summarize(depositsOnly, 'deposits').total, 100);
  // Under this ledger a withdrawal is an outflow: negative, not just a colour.
  assert.equal(contributions.summarize(withdrawalsOnly, 'withdrawals').total, -40);
  assert.equal(contributions.summarize(records, 'net').total, 60);
});

// The regression this pins: the old code summarised `record.amount` unconditionally,
// so switching the switch to Net left the hero reading 140 instead of 60 — a
// "withdrawal-proof" chart that ignored withdrawals.
test('the net total is not the deposits total with withdrawals present', () => {
  const records = [
    record('2026-01-05T00:00:00Z', 1000),
    record('2026-02-05T00:00:00Z', 250, 'acc-1', 'Main', 'withdrawals'),
  ];

  const net = contributions.summarize(records, 'net');
  assert.notEqual(net.total, contributions.summarize(records, 'deposits').total);
  assert.equal(net.total, 750);
});

test('bucketize totals signed under the net view', () => {
  const buckets = contributions.bucketize(
    [
      record('2026-01-05T00:00:00Z', 100),
      record('2026-01-20T00:00:00Z', 40, 'acc-1', 'Main', 'withdrawals'),
      record('2026-02-02T00:00:00Z', 70),
    ],
    'month',
    'en',
    'net',
  );

  assert.equal(buckets[0].total, 60);
  assert.equal(buckets[1].total, 70);
  assert.equal(buckets[0].count, 2, 'count counts both directions');
});

test('bucketizeByAccount signs per account under the net view', () => {
  const result = contributions.bucketizeByAccount(
    [
      record('2026-01-05T00:00:00Z', 100, 'a', 'Broker'),
      record('2026-01-20T00:00:00Z', 40, 'b', 'Bank', 'withdrawals'),
    ],
    'month',
    'en',
    'net',
  );

  assert.equal(result.buckets[0].values.a, 100);
  assert.equal(result.buckets[0].values.b, -40);
  assert.equal(result.buckets[0].total, 60);
  assert.deepEqual(
    result.accounts.map((a) => a.id),
    ['a', 'b'],
    'ordering still by contribution magnitude',
  );
});

test('the drill-down under net lists both directions', () => {
  const records = [
    record('2026-01-05T00:00:00Z', 100),
    record('2026-01-20T00:00:00Z', 40, 'acc-1', 'Main', 'withdrawals'),
  ];

  const january = contributions.selectDrillDownRecords(
    records,
    OPEN,
    { periodKey: '2026-01' },
    'month',
    'net',
  );

  assert.equal(january.length, 2, 'net mixes both flows in one panel');
  assert.equal(
    january.reduce((sum, r) => sum + contributions.signedAmount(r, 'net'), 0),
    60,
  );

  const depositsOnly = contributions.selectDrillDownRecords(
    records,
    OPEN,
    { periodKey: '2026-01' },
    'month',
    'deposits',
  );
  assert.equal(depositsOnly.length, 1);
});

test('the withdrawal view drills into withdrawals only', () => {
  const records = [
    record('2026-01-05T00:00:00Z', 100),
    record('2026-01-20T00:00:00Z', 40, 'acc-1', 'Main', 'withdrawals'),
  ];

  const panel = contributions.selectDrillDownRecords(
    records,
    OPEN,
    { periodKey: '2026-01' },
    'month',
    'withdrawals',
  );

  assert.equal(panel.length, 1);
  assert.equal(panel[0].amount, 40);
});

/**
 * The regression: withdrawals drew as positive, upward bars — visually
 * indistinguishable from "money added", only in another colour. An outflow
 * reads correctly only when its bars hang *below* the axis, so `signedAmount`
 * signs the whole ledger, not just the net view.
 */
test('a withdrawals bucket is negative: the bar goes below the axis', () => {
  const flowRecords = contributions.selectFlow(
    [record('2026-01-20T00:00:00Z', 40, 'acc-1', 'Main', 'withdrawals')],
    'withdrawals',
  );

  const bucket = contributions.bucketize(flowRecords, 'month', 'en', 'withdrawals')[0];
  assert.ok(bucket.total < 0, `expected a negative total, got ${bucket.total}`);
  assert.equal(bucket.total, -40);

  // The per-account split agrees, so stacked withdrawals also hang below.
  const split = contributions.bucketizeByAccount(flowRecords, 'month', 'en', 'withdrawals');
  assert.equal(split.buckets[0].total, -40);

  // Deposits keep the old, positive shape.
  const deposit = contributions.bucketize(
    [record('2026-01-05T00:00:00Z', 100)],
    'month',
    'en',
    'deposits',
  )[0];
  assert.equal(deposit.total, 100);
});

/* ---------------------------------------------------------- account scope */

const { mod: accountScope, cleanup: cleanupAccountScope } = await loadTs('src/hooks/useAccountScope.ts');

test('included account types are investment and cash, never credit cards', () => {
  assert.ok(accountScope.isIncludedAccountType('SECURITIES'));
  assert.ok(accountScope.isIncludedAccountType('CRYPTOCURRENCY'));
  assert.ok(accountScope.isIncludedAccountType('CASH'));
  assert.ok(accountScope.isIncludedAccountType('securities'), 'case-insensitive');

  assert.equal(accountScope.isIncludedAccountType('CREDIT_CARD'), false);
  assert.equal(accountScope.isIncludedAccountType(undefined), false);
  assert.equal(accountScope.isIncludedAccountType(''), false);
});

test('scopeRecords filters out excluded accounts and keeps the rest', () => {
  const records = [
    record('2026-01-05T00:00:00Z', 100, 'broker'),
    record('2026-01-06T00:00:00Z', 20, 'card'),
  ];

  assert.deepEqual(
    accountScope.scopeRecords(records, ['broker']).map((r) => r.accountId),
    ['broker'],
  );
  // The gate is open while the accounts bridge has not answered yet, so a slow
  // bridge never blanks the page.
  assert.equal(accountScope.scopeRecords(records, undefined).length, 2);
});

test('scopeRecords keeps unknown-account records out of a known scope', () => {
  // An activity without an account id collapses into `unknown-account`; when the
  // scope is known, that row cannot claim to belong to it.
  const records = [record('2026-01-05T00:00:00Z', 100, 'unknown-account')];
  assert.equal(accountScope.scopeRecords(records, ['broker']).length, 0);
});

test('an empty scope is a closed gate, not an open one', () => {
  // Pinned in the *other* direction on purpose. `[]` is the host's honest answer
  // for "no investment or cash account", so the gate is shut. Treating it as an
  // open gate would put credit-card spending on an investment ledger the moment
  // a host legitimately reported an empty scope.
  const records = [
    record('2026-01-05T00:00:00Z', 100, 'broker'),
    record('2026-01-06T00:00:00Z', 20, 'card'),
  ];
  assert.equal(accountScope.scopeRecords(records, []).length, 0);
});

test('a bridge that cannot be read is degraded, not an empty scope', async () => {
  // Regression: the hook resolved a missing / rejecting / non-list bridge to
  // `[]`, and `[]` is a *closed* gate - so a degraded bridge silently filtered
  // every record away and blanked the whole page.
  const cases = {
    'no bridge at all': undefined,
    'a bridge without getAll': {},
    'a rejecting bridge': { getAll: () => Promise.reject(new Error('bridge down')) },
    'a bridge that throws synchronously': {
      getAll: () => {
        throw new Error('bridge down');
      },
    },
    'a bridge answering with a non-list': { getAll: () => Promise.resolve(null) },
    'a bridge answering with an object': { getAll: () => Promise.resolve({ items: [] }) },
  };

  for (const [label, bridge] of Object.entries(cases)) {
    const outcome = await accountScope.loadAccountScope(bridge);
    const state = accountScope.accountScopeState(outcome);

    assert.equal(state.degraded, true, `${label}: should report degraded`);
    // The whole bug in one assertion: this must be undefined, not []. A closed
    // gate is what blanked the page.
    assert.equal(state.includedIds, undefined, `${label}: the gate must stay open`);
    assert.equal(state.ready, true, `${label}: the bridge has settled, one way or another`);
  }
});

test('a degraded bridge leaves the page populated instead of blank', async () => {
  const records = [
    record('2026-01-05T00:00:00Z', 100, 'broker'),
    record('2026-01-06T00:00:00Z', 20, 'card'),
  ];

  const outcome = await accountScope.loadAccountScope({
    getAll: () => Promise.reject(new Error('bridge down')),
  });
  const state = accountScope.accountScopeState(outcome);
  const scoped = accountScope.scopeRecords(records, state.includedIds);

  assert.equal(
    scoped.length,
    records.length,
    'an unreadable accounts bridge must not blank the page',
  );
  // The cost of that choice is explicit: with no types readable, nothing is
  // excluded, and the page has to disclose it.
  assert.equal(state.degraded, true);
});

test('a bridge that answers produces a real scope, and only the excluded one closes it', async () => {
  const outcome = await accountScope.loadAccountScope({
    getAll: () =>
      Promise.resolve([
        { id: 'broker', name: 'Broker', accountType: 'SECURITIES' },
        { id: 'wallet', name: 'Wallet', accountType: 'CASH' },
        { id: 'card', name: 'Card', accountType: 'CREDIT_CARD' },
      ]),
  });

  assert.equal(outcome.degraded, false, 'a real answer is not a degraded bridge');
  assert.deepEqual(
    accountScope.accountScopeState(outcome).includedIds,
    ['broker', 'wallet'],
  );

  // An empty answer is the one case that stays a closed gate.
  const empty = await accountScope.loadAccountScope({ getAll: () => Promise.resolve([]) });
  const emptyState = accountScope.accountScopeState(empty);
  assert.equal(empty.degraded, false);
  assert.deepEqual(emptyState.includedIds, []);
  assert.equal(
    accountScope.scopeRecords([record('2026-01-05T00:00:00Z', 100, 'broker')], emptyState.includedIds)
      .length,
    0,
    'an empty scope closes the gate',
  );
});

test('the gate is open, but not ready, before the bridge answers', () => {
  const state = accountScope.accountScopeState(undefined);
  assert.equal(state.includedIds, undefined, 'open gate while loading');
  assert.equal(state.ready, false);
  assert.equal(state.degraded, false, 'loading is not a degraded bridge');
});

/* ------------------------------------------------- no silent ledger swap */

test('a requested-but-unavailable conversion explains itself instead of reading zero', async () => {
  // Regression, measured on a real host: `ALL (PLN)` was selectable, `viewCurrency`
  // resolved to `null`, and `records.filter(r => r.currency === null)` matched
  // nothing. The page rendered `PLN 0.00` and zero contributions with no message
  // — indistinguishable from "you have no contributions". A plausible wrong total
  // is worse than a missing feature, so the fallback must be a real currency and
  // must be stated.
  const source = (
    await readFile(path.join(ROOT, 'src/components/ContributionStatsPage.tsx'), 'utf8')
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  assert.doesNotMatch(
    source,
    /viewCurrency = allRequested \? null/,
    'viewCurrency must never be null: a null currency filters every record away',
  );
  assert.match(
    source,
    /const conversionBlocked = allRequested && !conversionAvailable/,
    'the page must know when the conversion it was asked for is unavailable',
  );
  assert.match(
    source,
    /conversionBlocked && convertStatus !== 'loading'/,
    'the unavailable conversion must be explained on screen',
  );

  // The hook must name the reason rather than swallowing it into a comment: an
  // unnamed failure is what produced a silent zero in the first place.
  const hook = (
    await readFile(path.join(ROOT, 'src/hooks/useConvertedRecords.ts'), 'utf8')
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const status of [
    'no-settings-bridge',
    'settings-rejected',
    'no-base-currency',
    'no-rate-bridge',
    'rates-rejected',
  ]) {
    assert.ok(hook.includes(status), `${status} must be a nameable outcome`);
  }
});

test('the page has no alternate ledger to fall back to', async () => {
  // The silent swap lived in the *component*, so no test over the pure modules
  // could see it — the mutation run put a fallback straight back into
  // `ContributionStatsPage.tsx` and all 78 tests stayed green. Asserting it at
  // the source level is the only place the decision is made.
  //
  // Comments are stripped first: this file documents the fallback in prose on
  // purpose, and the ban below is about code, not about the word appearing.
  const raw = await readFile(path.join(ROOT, 'src/components/ContributionStatsPage.tsx'), 'utf8');
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // Every aggregation reads the state the user picked. `flow` is the one name
  // the hero, the buckets, the split and the drill-down are allowed to use.
  for (const [fn, call] of [
    ['selectFlow', /selectFlow\(scoped, ([A-Za-z_$][\w$]*)\)/],
    ['summarize', /summarize\(flowRecords, ([A-Za-z_$][\w$]*)\)/],
    ['bucketizeByAccount', /bucketizeByAccount\(flowRecords, granularity, locale, ([A-Za-z_$][\w$]*)\)/],
    ['selectDrillDownRecords', /selectDrillDownRecords\(currencyRecords, range, drillDown, granularity, ([A-Za-z_$][\w$]*)\)/],
  ]) {
    const match = source.match(call);
    assert.ok(match, `${fn} must be called`);
    assert.equal(match[1], 'flow', `${fn} must aggregate the picked flow, not another one`);
  }

  // Regression, found by reading the shipped diff rather than a test run: a
  // mutation pass restored this file from `HEAD~1`, which silently reverted the
  // switch-visibility guard and the empty-state wording below. Both are visible
  // only in this component, so both need a source-level contract.
  // Regression, found on a real host by the maintainer: narrowing the range to a
  // period with no records deleted the `Total / Per account` switch. Both
  // switches were gated on data inside the window, so the control the user was
  // holding vanished at the same moment its data did.
  assert.match(
    source,
    /\{\(hasWithdrawals \|\| flow !== 'deposits'\) && \(/,
    "the flow switch must survive an empty range in BOTH directions, or the user is stranded",
  );
  assert.match(source, /\{canSplit && \(/, 'the per-account switch must be rendered');

  // The guards above were not enough on their own, and that is the lesson worth
  // keeping: v1.2.7 shipped a guard on both switches and both still vanished on
  // the host, because the *guard* was right and the value behind it was still
  // window-scoped. Assert the source of the capability checks, not their use.
  const declaration = (name) => {
    const at = source.indexOf(`const ${name}`);
    assert.ok(at >= 0, `${name} must exist`);
    return source.slice(at, at + 260);
  };

  const withdrawals = declaration('hasWithdrawals');
  assert.match(
    withdrawals,
    /records\.some/,
    'a second ledger existing is a property of the data, not of the window',
  );
  assert.doesNotMatch(withdrawals, /scoped\.some/, 'the window must not decide what ledgers exist');

  const split = declaration('canSplit');
  assert.match(
    split,
    /records\.map/,
    'having more than one account is a property of the data, not of the window',
  );
  assert.doesNotMatch(split, /split\.accounts/, 'the window must not decide what ledgers exist');

  // ...and the effect that used to cancel that fix in the next commit. It reset
  // the mode to `total` the moment `canSplit` went false, which is what deleted
  // the switch in the first place.
  assert.doesNotMatch(
    source,
    /!canSplit && seriesMode === 'account'\) setSeriesMode\('total'\)/,
    "the user's series mode must not be reset behind them",
  );

  assert.match(
    source,
    /flow === 'withdrawals' \? t\('noWithdrawals'\) : t\('noContributions'\)/,
    'an empty ledger must say which ledger is empty',
  );
});

test('a ledger with nothing in it stays empty, it is never swapped for another', () => {
  // Regression: the page used to resolve an unsatisfiable view through an
  // `effectiveFlow` fallback, so asking for withdrawals in a window that had
  // none silently rendered the deposits ledger instead — the hero total, the
  // buckets, the split and the drill-down all relabelled behind the user's back.
  //
  // There is deliberately no `resolveEffectiveFlow` in the lib any more. What is
  // pinned here is the contract it used to break: narrowing to the ledger the
  // user picked yields that ledger's own records and nothing else.
  const depositsOnly = [record('2026-01-05T00:00:00Z', 100, 'broker', 'Broker', 'deposits')];

  assert.deepEqual(
    contributions.selectFlow(depositsOnly, 'withdrawals'),
    [],
    'the withdrawals view of a deposits-only window is empty, not the deposits',
  );
  assert.deepEqual(contributions.selectFlow(depositsOnly, 'deposits'), depositsOnly);

  // And the empty ledger aggregates to an empty panel rather than borrowing a total.
  const shown = contributions.selectFlow(depositsOnly, 'withdrawals');
  assert.equal(contributions.summarize(shown, 'withdrawals').total, 0);
  assert.deepEqual(contributions.bucketize(shown, 'month', 'en', 'withdrawals'), []);
  assert.deepEqual(contributions.bucketizeByAccount(shown, 'month', 'en', 'withdrawals'), {
    accounts: [],
    buckets: [],
  });
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
