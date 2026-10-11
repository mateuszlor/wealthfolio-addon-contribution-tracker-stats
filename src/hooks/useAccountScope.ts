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
  /**
   * Ids of the accounts the ledger covers.
   *
   * `undefined` is an **open gate**: either the bridge has not answered yet, or
   * it could not be read at all. `[]` is a real answer — the host has no
   * investment or cash account — and it is a *closed* gate.
   */
  includedIds?: string[];
  /** True once the accounts bridge settled: with accounts, or without. */
  ready: boolean;
  /**
   * True when no account *type* could be read (bridge missing, rejecting, or
   * answering with something other than a list), so the gate is open and every
   * account is on the page, credit cards included. The page has to say so.
   */
  degraded: boolean;
}

/** The slice of the accounts bridge this hook needs; structural, so no new import. */
type AccountsBridge = { getAll?: () => Promise<Account[]> } | undefined;

export interface AccountScopeOutcome {
  /** The accounts the bridge returned, or `undefined` when it could not be read. */
  accounts?: Account[];
  /** True when the bridge is missing or failed — see `AccountScopeState`. */
  degraded: boolean;
}

/**
 * Reads the accounts bridge and reports what it managed to learn.
 *
 * A bridge that is **absent, rejecting, or answering with a non-list** resolves
 * to `{ accounts: undefined, degraded: true }` — deliberately *not* an empty
 * array. The difference is the whole point: `scopeRecords` opens its gate on
 * `undefined` and closes it on `[]`, so an unreachable bridge turned into `[]`
 * silently filtered every record away and blanked the page, which is the
 * failure this hook was supposed to prevent rather than cause.
 *
 * Credit-card spending can therefore reach the page when the bridge is broken.
 * That is a disclosed trade — an empty ledger with no explanation is worse than
 * a labelled one — and the caller renders `degraded` as a warning.
 */
export async function loadAccountScope(
  accountsApi: AccountsBridge,
): Promise<AccountScopeOutcome> {
  if (!accountsApi || typeof accountsApi.getAll !== 'function') {
    return { accounts: undefined, degraded: true };
  }

  try {
    const all = await accountsApi.getAll();
    // A non-array answer is a broken bridge, not "this user has no accounts".
    if (!Array.isArray(all)) return { accounts: undefined, degraded: true };
    return { accounts: all, degraded: false };
  } catch {
    return { accounts: undefined, degraded: true };
  }
}

/**
 * Narrows a list of accounts to the ids the ledger covers.
 *
 * `undefined` — the accounts could not be read — passes straight through as
 * `undefined` so the gate stays open. An empty list stays an empty list: that is
 * the host's honest answer, and it closes the gate.
 */
export function includedAccountIds(accounts: Account[] | undefined): string[] | undefined {
  if (!accounts) return undefined;
  return accounts
    .filter((account) => isIncludedAccountType(account.accountType))
    .map((account) => account.id);
}

/**
 * Turns a bridge outcome into the state the page consumes.
 *
 * Kept separate from the hook so the decision — which gate state each outcome
 * produces — is testable without a React renderer. It is the step that decides
 * whether the page is scoped or blank, so it is the step worth pinning.
 */
export function accountScopeState(outcome?: AccountScopeOutcome): AccountScopeState {
  return {
    // `undefined` while loading *and* when degraded: both mean "no types known",
    // and both must leave the gate open.
    includedIds: includedAccountIds(outcome?.accounts),
    ready: outcome !== undefined,
    degraded: outcome?.degraded ?? false,
  };
}

/**
 * Resolves which account ids belong on this page.
 *
 * `activities.getAll()` returns every account's rows, including credit-card
 * spending, and the activities bridge carries no account *type* — only the
 * accounts bridge does. The hook therefore reads `accounts.getAll()` once and
 * exposes the id set the page filters with; a bridge that cannot be read leaves
 * the gate open and raises `degraded`, matching how the rest of the addon treats
 * a degraded bridge.
 */
export function useAccountScope(ctx: AddonContext): AccountScopeState {
  const [outcome, setOutcome] = useState<AccountScopeOutcome | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    loadAccountScope(ctx?.api?.accounts)
      .then((result) => {
        if (!cancelled) setOutcome(result);
      })
      .catch(() => {
        // `loadAccountScope` does not reject; this only guards a broken
        // `accountsApi.getAll` that throws synchronously inside the promise.
        if (!cancelled) setOutcome({ accounts: undefined, degraded: true });
      });

    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const state = useMemo(() => accountScopeState(outcome), [outcome]);

  return state;
}

/**
 * Keeps records whose account is inside the scope.
 *
 * The gate is open for `undefined` — loading, or a bridge that could not be read
 * — and closed for `[]`, which is the honest answer for "the host reported no
 * investment or cash account". An empty list is deliberately *not* treated as
 * open: that would put credit-card spending on an investment ledger the moment
 * the host legitimately reported an empty scope.
 */
export function scopeRecords<T extends { accountId: string }>(
  records: T[],
  includedIds: string[] | undefined,
): T[] {
  if (!includedIds) return records;
  const allowed = new Set(includedIds);
  return records.filter((record) => allowed.has(record.accountId));
}
