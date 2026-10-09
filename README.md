# Contribution Stats

A chart of your deposits inside [Wealthfolio](https://wealthfolio.app), broken down
**month by month, day by day and year by year**.

Requires Wealthfolio 3.7+. English and Polish interface.

---

## What is Wealthfolio?

Wealthfolio is a free, open-source app for tracking your investments, net worth and
spending. It runs on your own machine, keeps your financial data local, and supports
Windows, macOS, Linux, iOS and Android.

Find it at [wealthfolio.app](https://wealthfolio.app).

## What this addon does

Wealthfolio records every movement of money as an *activity*. The ones that add money to
your accounts are **deposits** — a transfer from your salary, a BLIK payment, a standing
order. By default the app shows you totals, but not *how* your deposits are spread over
time.

This addon answers that question:

- **Total contributed** over the selected period
- **Contribution count** — how many deposits there were
- **Average per deposit** — the mean size of a single deposit
- **Average per month** — the mean monthly pace across the selected range
- **A bar chart** you can regroup by month, day or year

Two figures that look similar but are not: *average per deposit* divides the sum by the
number of deposits, while *average per month* divides it by the number of months in the
range. With irregular deposits they can differ several-fold.

### Selecting a period

The row of pills uses the same period selector as Wealthfolio's own reports — last month,
3M, 6M, YTD, 1Y and so on. The calendar button next to it lets you set any custom range,
for example March 2019 → July 2022.

The **Month / Day / Year** tabs below decide how the chart groups the money inside that
period. They combine: *1Y + Month* gives twelve monthly bars, *1M + Day* gives one bar per
day of the current month. Periods without deposits are drawn as empty slots, so the
spacing always reflects time.

### Splitting by account

When your deposits span more than one account, a **Total / Per account** switch appears
next to the grouping tabs. *Per account* stacks each period's bar into one segment per
account, so you can see at a glance which account carried the month — and how that changes
year over year. Segments are ordered by total contribution and colours follow the host
theme. Accounts without a name, or without deposits in a given period, are handled without
leaving gaps.

### Looking at the deposits behind a bar

Hover a bar to see the period's total, and click it to open the individual deposits that
make it up: date, account and amount per entry, newest first. In *Per account* view, hover
a stacked bar to get one row per account, and click the row you are interested in to see
only that account's deposits. The panel appears below the chart and closes with the
**×** button.

The panel lists exactly the deposits the bar is built from, so its total always matches
the bar — including for a period that the selected interval only partly covers, such as
the first year under a *1Y* range.

### Privacy

The eye button in the top-right corner hides the amounts: every amount in the summary, in
the tooltip and in the drill-down panel turns into a fixed `••••`, and the value axis
disappears. The bars stay, so you can still read the *shape* of your contributions without
seeing a single number — not even the order of magnitude, which a partially masked value
would still give away.

The choice is remembered for this add-on, so it survives a reload, and it is removed
together with the add-on. It is deliberately **not** Wealthfolio's own privacy toggle:
add-ons run in a sandboxed frame where the browser storage that setting is kept in is
unavailable, so the two cannot be shared.

## Requirements

- Wealthfolio 3.7.0 or newer

## Installation

1. Download the archive from the
   [releases page](https://github.com/mateuszlor/wealthfolio-addon-contribution-tracker-stats/releases)
   (`contribution-tracker-stats-<version>.zip`).
2. In Wealthfolio open **Settings → Add-ons → Import from file**.
3. Pick the downloaded `.zip`. A **Contribution Stats** entry appears in the sidebar.
4. Click it. The first load reads your activity history; large portfolios take a moment.

## Uninstall

**Settings → Add-ons → Contribution Stats → Remove.** The addon only reads your data and
never writes to it, so removing it leaves no trace in your portfolio.

## Troubleshooting

**The chart is empty.** The addon counts only activities of type `DEPOSIT`. If your
deposits were imported as something else (for example `TRANSFER_IN` or plain transfers),
they are not picked up. Check the Activities page and adjust the import, or open the
browser console and look for the addon's diagnostic line:

```
[contribution-tracker-stats] fetched=1234 deposits=87 kept=87 skippedNoDate=0 skippedZeroAmount=0 types={"BUY":800,"DEPOSIT":87,…}
```

It reports how many rows the host returned, which types they had, and how many deposits
were dropped and why.

**Amounts are hidden.** Press the eye button in the top-right corner to show them again.
The choice is remembered for this add-on, so it also survives a reload of the page.

## Privacy and data

The addon requests a single permission: `activities.getAll`. It uses it to read your
deposits and nothing else. No data leaves your machine — the addon has no network access,
no analytics and no third-party dependencies at runtime.

## Contributing

Bug reports and pull requests are welcome. See [DEVELOPING.md](DEVELOPING.md) for the
build, validation and release process, and the host-API rules this addon follows.
