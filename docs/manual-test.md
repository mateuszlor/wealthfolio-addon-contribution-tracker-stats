# Manual host testing

A green `npm run verify` proves the pure modules. It proves nothing about the one thing this
addon keeps getting wrong: rendering and pointer behaviour inside the host's sandboxed iframe.
This is the procedure for checking that, end to end, in a real Wealthfolio.

It exists because CI cannot run a host, and because getting to a working session takes more
than a URL — the install dialog opens a *native* file picker that no automation can drive, so
the human picks the file and the agent waits.

## The division of labour

**The maintainer signs in, picks the ZIP file, and clicks the bar.** Everything else the agent
does.

Never type into the login form and never guess a password. The session may also be absent
entirely, in which case the addon route renders a blank frame and every later step fails for
the wrong reason. Confirm a signed-in session before anything else — see step 2.

### The bar click is a human action, and that is the point

The maintainer clicks the bar and reports what happened. Do not try to synthesise the click.

A dispatched `MouseEvent` sequence does not reach recharts the way a real pointer does, and an
agent that cannot see that will read the empty result as a broken fix. That has happened: a
correct drill-down was declared broken because the synthetic click never landed, and the
failing measurement was then treated as proof that the fix was innocent. It was not a proof of
anything — it was a broken instrument.

The cost of asking for one click is a minute. The cost of not asking is a long detour through
fiber introspection, worktrees and control builds, ending in a confident wrong answer.

Read the browser tools the same way: `evaluate` has returned an empty object on a page that was
visibly rendering, and `snapshot` has returned a tree with no refs for the same page. When the
instrument disagrees with the screenshot, the instrument is wrong. Do not draw a conclusion
from it, and do not spend the session forcing it.

## Parameter

| Parameter | Example |
| --- | --- |
| Host base URL | `http://192.168.104.188:8088` |

Only the host varies. Every path below is fixed by the addon id and the host's own routing.

## Steps

### 1. Fetch before saying anything about the branches

```sh
git fetch origin
```

**Do this first, before comparing `main` with a feature branch.** A stale local ref makes a
merged feature look unmerged, which has already caused the wrong branch to be chosen and a
bug that exists on `main` to be declared non-existent. Verify with
`git rev-list --count origin/main..HEAD` — zero means the branch is fully merged.

### 2. Open the host and confirm the session

```js
await tools["browser"].tabs.open({ url: "<HOST>", focus: true })
await tools["browser"].screenshot({ tabID })
```

A logged-out host shows a single empty field and a **Sign In** button. Stop and ask for a
session rather than trying to authenticate.

The sign of a live session is the portfolio: a total balance, an accounts list, and
`Syncing market data...`. That is enough; do not read account data.

### 3. Build the release

```sh
node scripts/build-release.mjs --version <v>      # explicit: manifest.json tracks the last tag
```

The version **must** be explicit. `manifest.json` carries the version of the last released tag,
so an import of an unchanged version can be a no-op and you end up testing the build that is
already installed. Pick anything above the installed version, e.g. `1.0.5`.

Output: `release/contribution-tracker-stats-<v>.zip` plus `contribution-tracker-stats.zip`.

### 4. Hand over, and wait

Report the absolute path of `contribution-tracker-stats.zip` and **stop**. The maintainer
selects it. Resume only when they say the install is done.

This is the step that cannot be automated: *Install from File* opens the OS file picker, and
the dialog contains no `<input type=file>` in the DOM for automation to fill.

### 5. Install

```js
await tools["browser"].tabs.open({ url: "<HOST>/settings/addons", focus: true })
```

The button is labelled **Install from File**. It is easy to miss because it carries no visible
`+`, and *Browse Add-ons* next to it is the marketplace, not a local upload — there is no local
ZIP anywhere in the marketplace flow.

```js
// then, once the file is chosen, the dialog previews the parsed manifest:
await tools["browser"].evaluate({ tabID, script: `... find button matching /Approve & Install/ ... click()` })
```

Success reads `Contribution Tracker Stats v<v>` and `Addon installed successfully` in the
installed list. **Read the installed version back** — if it is not the one you just built, stop,
because everything after this point would be testing the old build.

### 6. Open the addon and find the sandbox frame

```js
await tools["browser"].tabs.open({ url: "<HOST>/addons/contribution-tracker-stats", focus: true })
await tools["browser"].frames({ tabID })
```

The addon renders inside an `about:srcdoc` iframe with an opaque origin. **Every `evaluate`
after this needs `frameID`** of that frame, or it silently inspects the host page and reports
nothing found.

The frame id changes on each load, so call `frames` again after any reload. Tabs also close on
their own during this flow — call `tabs.list()` rather than reusing a stored id.

Sanity check that the addon mounted:

```js
await tools["browser"].evaluate({ tabID, frameID, script: `JSON.stringify({
  bars: document.querySelectorAll('.recharts-bar-rectangle').length,
  text: document.body.innerText.slice(0, 80)
})` })
```

Non-zero bars and a `TOTAL CONTRIBUTED` line mean the route and the data path work.

### 7. The maintainer clicks the bar

Ask for it, then stop and wait. Do not synthesise the event.

"Click a bar in Contribution Stats and tell me whether the details panel opens, and whether it
lists anything" is one sentence and settles in a minute what an agent cannot measure reliably.

For reference, the bars are `.recharts-bar-rectangle path` inside the sandbox frame, and the
tallest one is the most informative to click. But whether they are there is the maintainer's
answer to rely on, not an `evaluate` result.

### 8. Read the result

If the maintainer reports it open, the remaining checks worth doing are the ones automation is
good at — reading the rendered totals and comparing them with the summary above the chart.

The drill-down panel is a Radix `Sheet side="right"`, which **portals out of the addon frame and
attaches to `document.body`**. Checking `.cts-root` children, or anything scoped inside the
frame's own subtree, will report that no panel exists even when one is open. That is how a
working panel gets mistaken for a broken one.

If a machine read is wanted anyway, assert on the panel itself:

```js
await tools["browser"].evaluate({ tabID, frameID, script: `JSON.stringify({
  hasDetails: document.body.innerText.includes('Details for'),
  sheet: [...document.querySelectorAll('[data-side]')].map(e => e.getAttribute('data-state'))
})` })
```

An open sheet is a `[data-side]` element with `data-state="open"`.

### When the panel does not open

First establish *who* observed it. If a human clicked and saw nothing, the failure is real and
worth chasing. If an agent's own instrumentation said so, the first hypothesis is the
instrumentation: a synthetic click, a stale fiber tree, or an `evaluate` that returned `{}`
while the page was plainly rendering. Confirm with the maintainer before touching any code.

Only once a human click has been ruled out, bisect the chain:

| Check | How | Reading |
| --- | --- | --- |
| `onBarClick` is wired | `getComputedStyle(barPath).cursor` on `.recharts-bar-rectangle path` | `pointer` only when `onBarClick` is set; `default` means the chart got no handler |
| tooltip receives it | from the tooltip's `__reactFiber`, walk `.return` for a node whose `memoizedProps` has `onSelect` | absent `onSelect` means the tooltip was rendered non-interactive |
| handler is the fixed one | read `memoizedProps.onSelect.toString()` | the source tells you which code is actually running — minified, but readable |

Find that fiber by id-free traversal from any DOM node inside the frame:

```js
const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
const stack = [el[key]];
while (stack.length) { const n = stack.pop(); /* … */ if (n.child) stack.push(n.child); if (n.sibling) stack.push(n.sibling); }
```

Component names are minified, so match on prop **shape**, not on name.

Two traps that cost time here:

- `document.querySelector('div.pointer-events-auto')` matches the **interval selector**, not
  the chart tooltip. Anchor on the tooltip row's `aria-label` instead.
- Reading a fiber's `memoizedProps` gives you the props **as of the last render that fiber
  committed**. After an event, the live tree may already be a newer one, so a stale read says
  `open: false` on a panel that is open. This is the specific way an agent concluded a correct
  fix was broken; treat a fiber read as a hint, never as a verdict, and never as grounds for
  rewriting working code.

### 9. Console noise that is not a failure

These appear in a healthy sandboxed addon and are unrelated to any click:

- `localStorage` `SecurityError` from host components that were not written for an opaque origin
- `Failed to load resource: 403` and `restore_sync_session` / `No refresh token configured`

Judge the click by the DOM, not by these.

## The bar click, in one line

If a bar click does nothing, ask the maintainer to click it before touching anything. One human
click separates "the feature is broken" from "my instrument is broken", and the second is the
more common one.

## What this procedure does not cover

- Keyboard access to the drill-down. Recharts bars are not focusable; see *Known limitations of
  the drill-down* in `DEVELOPING.md`.
- Light theme. The chart resolves its own literals for both, but only the dark theme has been
  exercised here.
- Non-`pl` locales. The addon honours `useAddonTranslation().language`, and the host was
  running Polish.