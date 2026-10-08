import { useEffect, useMemo, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  bucketize,
  summarize,
  type Bucket,
  type ContributionRecord,
  type Granularity,
  type Summary,
} from '../lib/contributions';
import {
  emptyIntakeStats,
  formatIntakeLog,
  toContributionRecords,
  type IntakeStats,
} from '../lib/intake';

export type { IntakeStats } from '../lib/intake';

export interface ContributionsState {
  loading: boolean;
  error?: string;
  records: ContributionRecord[];
  summary: Summary;
  buckets: Bucket[];
  granularity: Granularity;
  setGranularity: (granularity: Granularity) => void;
  locale: string;
  intake: IntakeStats;
}

/**
 * Loads deposit activities through the host bridge and exposes aggregated views.
 *
 * `locale` comes from the host i18n runtime (`useAddonTranslation().language`),
 * which already normalises regional aliases. Reading it from `ctx.api.settings`
 * instead would need the `settings` permission for no benefit.
 */
export function useContributions(ctx: AddonContext, locale = 'en'): ContributionsState {
  const [records, setRecords] = useState<ContributionRecord[]>([]);
  const [intake, setIntake] = useState<IntakeStats>(emptyIntakeStats);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [granularity, setGranularity] = useState<Granularity>('month');

  useEffect(() => {
    let cancelled = false;
    const activitiesApi = ctx?.api?.activities;

    if (!activitiesApi || typeof activitiesApi.getAll !== 'function') {
      setLoading(false);
      setError('activities.getAll is not available on this host.');
      return;
    }

    setLoading(true);
    setError(undefined);

    activitiesApi
      .getAll()
      .then((activities: unknown) => {
        if (cancelled) return;

        const parsed = toContributionRecords(activities);
        setRecords(parsed.records);
        setIntake(parsed.stats);
        setLoading(false);

        // One line that makes an empty chart diagnosable: how many rows came back,
        // which types they had, and how many deposits survived filtering.
        ctx.api.logger?.info?.(
          `[contribution-tracker-stats] ${formatIntakeLog(parsed.stats, parsed.records.length)}`,
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setLoading(false);
        ctx.api.logger?.error?.(`[contribution-tracker-stats] ${message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const summary = useMemo(() => summarize(records), [records]);
  const buckets = useMemo(
    () => bucketize(records, granularity, locale),
    [records, granularity, locale],
  );

  return {
    loading,
    error,
    records,
    summary,
    buckets,
    granularity,
    setGranularity,
    locale,
    intake,
  };
}
