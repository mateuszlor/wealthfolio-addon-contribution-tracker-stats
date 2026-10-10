# AGENTS.md

Instructions for agents working on this repository. `DEVELOPING.md` covers the same ground for
humans; this file is the contract an agent is expected to follow.

## Attribution is required

Every artifact you produce names the agent **and the specific model** it came from. An
unattributed change is unreviewable — the reviewer cannot tell your reasoning from the
maintainer's — and an agent-attributed-but-model-less one is only half that, because
behaviour differs between models and nobody can tell which one produced a given commit.

| Artifact | Marker |
| --- | --- |
| Commit | `Co-Authored-By: <agent> (<provider>/<model>) <email>` as the last trailer |
| Pull request body | `— produced by <agent> · model <provider>/<model>` as the last line |
| PR comment | same last line |
| Reply to a review comment | same last line, plus a quote of the comment being answered |

Replace the placeholders with your own: the agent you are, and the model you are actually
running as right now. **Do not hardcode a model name into this file or `DEVELOPING.md`** —
different work will be done by different models, and a fixed name there goes stale and starts
attributing commits to the wrong one.

Do not sign on behalf of the maintainer. If you drafted text they will send under their own
name, say so in the body rather than signing it.

## Verify before you claim

- **Measure, do not guess.** Several defects here looked like positioning or z-index
  problems and were not. Opening the running addon and reading `getComputedStyle` and
  `getBoundingClientRect` found in one pass what four rounds of property-tweaking had not.
- **Run the build.** `npm run verify` covers typecheck, tests, build and validation. A claim
  that something works, with no command output behind it, is worthless.
- **Distinguish "verified" from "reasoned".** Say which one you did. Reviewers act on the
  difference.
- **Do not report a fix as working before it has been imported and exercised.** Rendering
  behaviour needs the host; a green build proves nothing about it.
- **If a test would pass with the bug still present, it is not a test.** Assert the wrong
  behaviour explicitly so the regression is pinned in both directions.

## Git

**Never force-push.** Not `--force`, not `--force-with-lease` — that is still a force push.
Amend, rebase and squash *before* the branch is pushed; afterwards add commits and use
`git revert`. A rewrite, if unavoidable, goes through an explicit branch deletion, which is
the maintainer's decision. `.git/hooks/pre-push` enforces this locally and `docs/pre-push`
is the tracked copy; see "Git workflow" in `DEVELOPING.md`.

Corollary: **do not create throwaway commits on a shared branch.** When testing anything
touched by git, use a throwaway branch and delete it. A test commit plus its revert is still
two commits of noise in a pull request.

Do not open pull requests against repositories you do not own without being asked, and never
write legal text — licences, attestations, terms — on the maintainer's behalf.

## Layout of the code

- `src/lib/*.ts` — pure, React-free and SDK-free aggregation and formatting. Everything
  testable belongs here, including selectors: a selector living in a component cannot be
  covered by `scripts/test.mjs`.
- `src/hooks/*.ts` — bridges between the host SDK and those pure functions.
- `src/components/*.tsx` — presentation only. If logic appears here and needs a test, move it.
- `scripts/test.mjs` — plain `node:test`-style assertions over the modules above, compiled on
  the fly with esbuild.

## Host behaviour that has already cost time

Verify against `node_modules` before assuming; these are not guesses, they are what the
installed SDK and UI package actually do.

- **The sandbox is an opaque origin.** `localStorage` throws on read and write. Use
  `ctx.api.storage` for persistence, and `useHiddenAmounts` rather than `useBalancePrivacy`.
- **`ChartStyle` emits `--color-<key>` on the `ChartContainer` element**, and custom properties
  only inherit downwards. Anything drawn beside that element sees no colours. The swatches in
  our tooltip are inside `ChartContainer` for this reason.
- **`ChartContainer` forwards its children to recharts' `ResponsiveContainer`.** They render
  inside its inner `div`, which is still a descendant of `[data-chart]`.
- **recharts' tooltip is non-interactive.** Its wrapper carries `pointer-events: none`, so a
  clickable row inside it cannot receive a click and `allowEscapeViewBox` / `wrapperStyle` /
  `trigger` do not change that. Ours is rendered by us instead.
- **`ChartTooltipContent` resolves the header through the chart config when `labelKey` is
  set**, looking up `config[labelKey]`. That key usually does not exist, and the header
  renders `undefined`. Leave `labelKey` unset so the axis label is used.
- **`ChartLegendContent` resolves a label under `nameKey`**, falling back to `dataKey`. The
  config is keyed by `dataKey`, so `nameKey="label"` renders empty entries.
- **`entry.x` from a recharts bar is the band's left edge**, not its centre.
- **The version in `manifest.json` tracks the last released tag**, because CI takes the
  version from the tag. Build a local archive with an explicit
  `node scripts/build-release.mjs --version <v>` or the import may be a no-op.

## Testing against a real host

`npm run verify` covers the pure modules and nothing else. Anything about rendering, the
sandbox or pointer behaviour needs a real Wealthfolio, and the procedure for that — the fixed
click targets, the browser tools, and the bisect for "the bar click did nothing" — is
[`docs/manual-test.md`](docs/manual-test.md).

Two things in it are not optional. **Run `git fetch origin` before comparing `main` with a
branch**: a stale local ref makes a merged branch look unmerged, which has already sent work to
the wrong branch. And **hand the ZIP to the maintainer and wait** — the install dialog opens a
native file picker that no automation can drive, so the human picks the file.

## Adding to this file

If you discover host behaviour that contradicts the above, fix the entry rather than adding a
second one. If you discover something new, add it with the symptom that led you to it, so the
next agent can recognise it.
