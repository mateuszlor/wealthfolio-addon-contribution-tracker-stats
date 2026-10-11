import { useEffect, useMemo, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { Account, AccountType } from '@wealthfolio/addon-sdk';

/**
 * Account scoping for the flow ledger.
 *
 * The page covers **investment and cash** accounts only. Wealthfolio's `AccountType`
 * has four values; of those, a *credit card* is a liability — a withdrawal from it
 * is spending on borrowed money, not money leaving savings — so it is excluded
 * here rather than per view.
 */
export const INCLUDED_ACCOUNT_TYPES: readonly AccountType[] = [
  'SECURITIES',
  'CRYPTOCURRENCY',
  'CASH',
];

export function isIncludedAccountType(type: AccountType | string | undefined): boolean {
  return (
    typeof type === 'string' &&
    (INCLUDED_ACCOUNT_TYPES as readonly string[]).includes(type.toUpperCase())
  );
}

export interface AccountScopeState {
  /** Ids of the accounts the ledger covers, or `undefined` while loading. */
  includedIds?: string[];
  /** True once the accounts bridge answered (or failed). */
  ready: boolean;
}

/**
 * Resolves which account ids belong on this page.
 *
 * `activities.getAll()` returns every account's rows, including credit-card
 * spending, and the activities bridge carries no account *type* — only the
 * accounts bridge does. The hook therefore reads `accounts.getAll()` once and
 * exposes the id set the page filters with; a failure hides the scope gate
 * rather than blanking the page, matching how the rest of the addon treats a
 * degraded bridge.
 */
export function useAccountScope(ctx: AddonContext): AccountScopeState {
  const [accounts, setAccounts] = useState<Account[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const accountsApi = ctx?.api?.accounts;

    if (!accountsApi || typeof accountsApi.getAll !== 'function') {
      // No bridge, no scope: falling open would put credit-card activity on an
      // investment ledger, which is the one mistake this hook exists to prevent.
      setAccounts([]);
      return () => {
        cancelled = true;
      };
    }

    accountsApi
      .getAll()
      .then((all) => {
        if (!cancelled) setAccounts(Array.isArray(all) ? all : []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });

    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const includedIds = useMemo(() => {
    if (!accounts) return undefined;
    return accounts
      .filter((account) => isIncludedAccountType(account.accountType))
      .map((account) => account.id);
  }, [accounts]);

  return { includedIds, ready: accounts !== undefined };
}

/** Keeps records whose account is inside the scope. Open gate while loading. */
export function scopeRecords<T extends { accountId: string }>(
  records: T[],
  includedIds: string[] | undefined,
): T[] {
  if (!includedIds) return records;
  const allowed = new Set(includedIds);
  return records.filter((record) => allowed.has(record.accountId));
}
