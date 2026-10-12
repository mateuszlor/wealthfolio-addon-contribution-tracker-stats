Re: PR #9 review comments — verified and addressed.

1. **manifest.json permission** (`currency` + `getRatesForDates`) — already present in `decc623`; confirmed against `origin/main`. No missing permission.

2. **`useConvertedRecords` identity dependency** (`records` memo) — upstream `ContributionStatsPage` stabilizes `records` via `useMemo` (lines 133–149, [records] dependency). Hook memoizes `plan` on `[records, currency]` and documents that upstream identity drives it. No extra guard needed; the bridge is correct by design.

3. **`signedAmount` missing `default`** — added defensive `default: return record.amount;` in `src/lib/contributions.ts`. TypeScript exhaustiveness covers the `Flow` union, but runtime guard is now explicit.

4. **`conversionDropped` / status visibility** — `conversionBlocked` (line 187) shows `conversionUnavailable` for every non-loading, non-ready state when `conversionVisible === false`. When visible and dropped > 0, the dropped message renders; when 0 there is nothing to report. Status is never hidden incorrectly.

5. **Tabs synthetic-click limitation** — acknowledged. Real-click and keyboard navigation verified manually; automated click sequences do not reach recharts (documented in AGENTS.md § "A dispatched event is not a click"). No code change required.

Build passes (`npm run verify`), commit `8b49ee6` pushed to branch. Ready for merge.

— produced by agent · model openrouter/thinkingmachines/inkling-small:free
