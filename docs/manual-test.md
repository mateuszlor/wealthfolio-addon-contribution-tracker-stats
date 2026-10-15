# Manual host testing

A green `npm run verify` proves the pure modules. It proves nothing about the one thing this
addon keeps getting wrong: rendering and pointer behaviour inside the host's sandboxed iframe.
This is the procedure for checking that, end to end, in a real Wealthfolio.

It exists because CI cannot run a host, and because getting to a working session takes more
than a URL — the install dialog opens a *native* file picker that no automation can drive, so
the human picks the file and the agent waits.

## The division of labour

**The maintainer signs in, picks the ZIP file, and clicks the bar.** Everything else the agent
does — including opening the install dialog itself, which is a page click, not a native one.

Never type into the login form and never guess a password. The session may also be absent
entirely, in which case the addon route renders a blank frame and every later step fails for
the wrong reason. Confirm a signed-in session before anything else — see step 2.

### Click what you can reach; ask only for what needs a human

The dividing line is the **native dialog**, not "the install". Opening *Install from File* is
ordinary page automation and belongs to the agent. Choosing the file inside the OS picker, and
clicking a chart bar, are not — no `evaluate` reaches them, and pretending otherwise is how a
session ends with a confident wrong answer.

Reporting a file path and stopping, while a click away from the dialog was still available, is
the failure this section exists to prevent. Do the part that is yours, then ask. It cost a round
trip once already: the agent handed over the path and stopped, and the maintainer had to come
back and say the button had never been clicked.

### Radix controls: a synthetic click does not select, focus() does

Two kinds of pointer target live on this page and they behave oppositely, which is
worth knowing before concluding anything is broken.

`evaluate` on a `[role=tab]` and call `.click()`, or dispatch the full
`pointerdown → mousedown → focus → pointerup → mouseup → click` sequence with
`{ bubbles, cancelable, composed }` — **neither selects the tab.** The `data-state`
stays `inactive` and every later measurement reads the previous view. This is not the
bar-click rule restated: it is a different failure, it looks exactly like a broken
feature, and it happens on an ordinary DOM element that click automation normally
reaches.

`tab.focus()` does select. Radix Tabs defaults to `activationMode="automatic"`, so
focus *is* the selection gesture, and a focus event is not subject to whatever makes
the synthesised mouse path a no-op. Diagnose the element before concluding anything:
`disabled`, `aria-disabled`, computed `pointer-events`, `getBoundingClientRect()` and
`document.contains()` all came back healthy on a tab that ignored every synthetic
click. The element was never the problem.

The same does not generalise to recharts bars — there, only a real pointer works, and
that stays the maintainer's.

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

### 4. Open the install dialog yourself, then wait

**Click first, ask second.** Opening the dialog is the agent's job, and stopping one step short
of it — reporting a path and waiting to be told to click a button you can already reach — wastes
the maintainer's turn and reads as not having tried.

1. Open `<HOST>/settings/addons`.
2. Click **Install from File**.
3. Report the absolute path of `contribution-tracker-stats.zip` and **wait** for the maintainer
   to pick it in the OS dialog.
4. **The dialog that comes back is yours to finish.** Once the file is chosen, the page shows a
   manifest preview with an **Approve & Install** button, and that button is ordinary page DOM —
   click it yourself. Only the OS file picker is beyond reach.

Step 4 is the one that gets skipped, and skipping it is expensive: the install silently does not
happen, the host keeps serving the previous version, and every later measurement is of the old
build. That is not a hypothetical — it cost a full round trip here, where the agent reported the
package as installed while the host was still on `v1.2.8`. The symptom is always the same and
always misleading: **the installed list still shows the old version.** Read the version back
before trusting anything.

```js
// after the maintainer has picked the file:
await tools["browser"].evaluate({
  tabID,
  script: `(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => /approve/i.test(b.innerText || ''));
    if (!btn) return 'NO APPROVE BUTTON - report what the dialog shows';
    btn.click();
    return 'approved';
  })()`
})
```

The button carries no visible `+`, and *Browse Add-ons* beside it is the marketplace, not a
local upload — there is no local ZIP anywhere in the marketplace flow.

```js
await tools["browser"].tabs.open({ url: "<HOST>/settings/addons", focus: true })
await tools["browser"].evaluate({
  tabID,
  script: `(() => {
    const all = [...document.querySelectorAll('button')];
    const browse = all.findIndex((b) => (b.innerText || '').trim() === 'Browse Add-ons');
    if (browse < 1) return 'layout changed';
    all[browse - 1].click();          // the + immediately left of Browse Add-ons
    return 'clicked';
  })()`
})
```

**Anchor on position, not on the accessibility label.** On this host the button's `aria-label`
is empty, `snapshot` returns a nearly empty tree with no ref pointing at it, and `find` on the
label finds nothing. `all[browse - 1]` was the only selector that worked. Do not conclude the
button is missing when the tree says so — that is the instrument, and the screenshot outranks it.

The click opens the OS file picker, which is a **native dialog**: it is not in the DOM, it does
not appear in a screenshot of the page, and no `evaluate` can reach it. So between step 3 and
step 4 the agent genuinely has nothing to do — the maintainer picks the file, and then the agent
resumes to approve it. Asking the maintainer to click *Approve & Install* as well hands them two
round trips for work that is one `evaluate` away.

This cost a round trip twice: the agent reported the path and stopped without opening the dialog,
and later opened the dialog but stopped without approving it. Both left the host on the previous
version while the conversation said the install was done. Open the dialog before handing over.

### 5. Verify the install

```js
// then, once the file is chosen and approved, the installed list carries the version:
await tools["browser"].evaluate({
  tabID,
  script: `document.body.innerText.match(/Contribution Tracker Stats\\s+v[\\d.]+/)`
})
```

Success reads `Contribution Tracker Stats v<v>` and `Addon installed successfully` in the
installed list. **Read the installed version back** — if it is not the one you just built, stop,
because everything after this point would be testing the old build. Comparing the build's own
`manifest.json` version against that string is the check, and it caught a session that was about
to measure a build from three commits earlier.

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

**Do not select on `[data-side]`.** This Radix build does not emit it — the open panel measured
here carried `role="dialog"`, `data-state="open"` and `class="fixed z-50 …"`, and **no
`data-side` attribute at all**. A read written against `[data-side]` returns `[]` with the panel
wide open, which is the exact false negative this step exists to prevent. Use:

```js
await tools["browser"].evaluate({ tabID, frameID, script: `(() => {
  const d = document.querySelector('[role=dialog][data-state=open]');
  return d ? d.innerText.slice(0, 200) : 'NO PANEL';
})()` })
```

Two more traps when reading the panel's contents, both of which produce a wrong number rather
than an obvious error:

- The row signs are **`+` (U+002B) and `−` (U+2212, a real minus sign), not an ASCII hyphen**.
  A regex over `[+-]` silently drops every withdrawal row, so the row count comes out short and
  the sum will not match. `DrillDownPanel` picks the glyph from `record.flow`.
- Amounts use the **host's** locale separators. Under `uiLocale=en` that is `16,620.45` — a
  comma for thousands. Replacing `,` with `.` before parsing turns the total into `16.62` and
  every comparison against the header fails.

Correct sign and correct locale parse, then compare the sum against the panel's own header — that
is the check that proves the panel is listing the right records:

```js
const re = /^(\w{3} \d{1,2}, \d{4})([+−])$/;   // note U+2212
const num = (s) => parseFloat(s.replace(/PLN\s*/g, '').replace(/,/g, ''));
```

A healthy net panel reads: caption `Net · N transactions`, a signed total, N rows each with a
date, an account name and a signed amount, and the row sum equal to the header total.

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