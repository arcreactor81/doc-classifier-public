# VISUAL-SPEC-v2: the Light Architecture visual system for `ui/app/`

Written 25 September 2026.

**Status (AGENTS.md §8).**
- **Written only.** Nothing in this file is implemented in `ui/app/`. It is not deployed, not live verified, not owner accepted and not quality accepted.
- **Contrast numbers:** computed in this session by `repo/.local/qa/ui-rebuild/prototype-v3/spec-v2-tokens.py`, which writes `spec-v2-tokens.json` beside it. That is arithmetic on token values. No browser rendered these exact tokens.
- **Motion numbers:** come from the prototype's measured capture (`report.json`: headless Edge 153, 40 of 40 checks, this PC only). Nobody has measured frame rate on an ordinary office laptop.
- **What it does:** this file turns the chosen prototype (`ui/reference/prototype-v3/`, notes in `design-notes.md`) into rules the real app can be built from.

**What this file replaces or amends.** When this file and the SPEC disagree on anything visual, this file wins. AGENTS.md wins over both. Interaction semantics stay exactly as in the SPEC, except for the amendments listed here.

| Source | What changes |
|---|---|
| `session-2026-09-25/frontend/design/SPEC.md` §8.1 | The token values are replaced. The token names stay, and 21 names are added (§2). |
| SPEC §8.2 | Type, weights, uppercase, controls, rows and the stage card change (§3). |
| SPEC §8.3, §0.1 rule 5 | Colour discipline is amended. The red family now also means failure (§6.1). |
| SPEC §8.4, §8.5 | The motion catalogue and honesty rules are amended (§7). |
| SPEC §2.1 | Where the shell regions sit changes. They are still mounted once and never rebuilt (§4). |
| SPEC §4.5 | The read problem is shown through the light and the failure block (§4, §6). |
| `repo/DESIGN.md` §11, UX line | "Outcome colours fixed and never reused" is amended (§6.1). Only the owner can approve the new wording, so the text is proposed and not applied. |

**Placeholder content only.** Examples use the categories Procedures, Explainers, Reports, Forms and Training, generic file names such as "Week 3 slides", and invented runs, times and counts.

---

## 0. Decisions in one page

1. **Keep the chosen design.** Keep the composition, the edge-lit graphite panes, the journey spine, the system type and the cyan light. Polish means fewer, stronger elements, not new ornament.
2. **One light says whether work is moving.** It is a `StatusLight` component driven by one pure function, `core/ui/live-light.ts`, which reads the facts the stores already hold (§5).
   - It pulses only while the last successful status check is younger than its lease **and** the run's own rules say the work is moving.
   - It becomes a still, steady glow with a stated reason when the work is waiting.
   - It becomes a grey ring when nothing has been heard for the lease.
   - It turns red when something failed.
3. **Red means failed, everywhere.** When something fails:
   - these four turn red: the light, the affected journey step, the leading edge of the bar, and the accent of the failure message;
   - the cause and the one action sit directly beneath the light;
   - "Could not process" is a failure, so it is red too;
   - the action button stays cyan, so there are no red buttons;
   - green and amber stay outcomes only (§6).
4. **Text resolves in only when its meaning changes.** Examples are a screen opening, a new state, or a failure. A new number or time inside the same meaning is written in place and does not animate. Counts roll only the digits that changed (§7).
5. **Only transform, opacity and filter animate.** Filter is used only for the heading words when a screen opens. Every motion starts from an event. The only repeating motion is the pulse, and its lease bounds it. Under reduced motion there is no animation at all, and every end state is identical (§7.9).
6. **The contrast gate grows from 73 to 103 pairs per theme.** Every themed colour stays six-digit hex. Computed now: dark 73/73 and 30/30, light 73/73 and 30/30. The minimum text contrast is 4.68 in dark and 5.35 in light (§2.5).
   - One real defect was found while computing this. In the prototype's light theme, the needs-review fill measures 2.96:1 against the empty track (3:1 needed).
   - The fix: the light track becomes one step lighter (§2.5, §11). The prototype's own check only measured fills against the pane, so it missed this.

**Owner decisions.** These are queued and nothing is applied. The build ships the "Default until chosen" column.

| # | Decision | Default until chosen | Recommendation |
|---|---|---|---|
| D1 | Outcome colours: Current, Proposed A or Proposed B (§6.7) | Current | **B**: only the light theme's "Could not process" fill becomes `#B3261E` |
| D2 | Quiet period: how long the run may record no activity before the light says Waiting. This is `SORT_QUIET_MS` in `core/ui/upload-status.ts` (§5.4). | 5 min (the code today) | **90 s**. At about 17 s per document, 5 min is about 17 documents of silence while the light still pulses. The prototype's default was 3 min. |
| D3 | Default theme when the person has not chosen one | System preference (`theme-boot.js` today) | Keep the system preference. Dark is the reference design, and both themes pass AA. |
| D4 | Roll soft edge: the static fade just outside the numeral band (§7.5) | 12% of the band | Keep. Set it to 0 for a hard cut. |
| D5 | Pulse strength: the ring's end scale and the halo's peak (§5.1) | Ring leaves to 3×; halo peaks at opacity 1 | Keep. Judge it on the built app. |

---

## 1. Principles

- **Cyan is the product's light.** It shows where you are, what to do, and that work is confirmed to be moving.
- **Red means only that something failed.** It covers a request, a document, the run, and sending that needs the person. It never pulses. It beats once on the event, then stays still until recovery. The action that fixes a failure is cyan.
- **Green and amber are outcomes only.** They never appear on status, the light, the spine or buttons. Waiting is cyan and still. A finished run is not green. A stalled run is never amber.
- **Grey (`--ink-3` ring, `--ink-2` words) means "no claim".** It is used for not updated, updates paused, not started, a discarded run and a muted stage.
- **Colour is never the only signal.** Every state has words. Every outcome has a word and a glyph: check, person or slash.
- **Every motion starts from an event.** The events are a route change, a count arriving, a state change or a click. A poll that changes nothing moves nothing. The only timeout in the system withdraws a claim; it never makes one.
- **Fewer, stronger.** The prototype's round 3 removed these, and they stay removed:
  - the station row;
  - the travelling packet;
  - the Decided sweep;
  - the tally flash;
  - the row sweep;
  - the bar streak;
  - the big flares;
  - three of four screen-open traces;
  - the ambient comets.
  None of them may be added back in the build.

---

## 2. Tokens

### 2.1 Method

- **Theme structure.** The file structure stays as it is. The light theme is `:root`, dark is `:root[data-theme="dark"]`, and the `prefers-color-scheme` fallback is a byte-identical copy of the dark block. `theme-boot.js` is unchanged.
- **Hex only for themed colours.** Every themed colour token is a six-digit hex, because `scripts/tokens-contrast.test.mjs` parses them. The prototype's translucent layers are composited once, in `spec-v2-tokens.py`:
  - panes are composited over the ground;
  - wells, tints and soft fills over the pane;
  - the track over the stage pane.
- **Panes are solid.** They use the composited colour, not the prototype's 80–84% glass over the fixed glow. The visible difference is at most 1.7% of the glow layer. In exchange, the contrast arithmetic is exactly what renders, and nothing has to be composited at paint time.
- **Effect tokens.** Glows, halos, shadows, the ground lattice and the trace band stay `rgb()` with alpha. They are listed in the test's exclusion list, as `--glow` is today.
- **Contrast targets.** Text needs 4.5:1. Non-text needs 3:1: lights, rings, rules, fills, input edges, focus and the leading edge. Decorative rows are recorded without a minimum.

### 2.2 Colour tokens

Existing names keep their role and get new values. Rows marked **new** are added.

| Token | Dark | Light | Role | Was (dark / light) |
|---|---|---|---|---|
| `--canvas` | `#0E141A` | `#E4E9ED` | Page ground. The spine and the stage head sit on it. | `#0C1117` / `#EEF1F5` |
| `--surface` | `#182129` | `#F7F9FA` | Panes | `#131A23` / `#F9FAFC` |
| `--surface-2` | `#202930` | `#EFF2F3` | Wells and inset panes | `#18212C` / `#F2F4F7` |
| `--surface-3` | `#262E36` | `#E9EDEE` | Row hover, switch track | `#212B37` / `#E6EAF0` |
| `--raised` | `#1B242C` | `#FAFCFC` | Stage panes (the working pane), sheets, tips. Also the 2 px cut between bar segments. | `#1B2430` / `#FFFFFF` |
| `--ink` | `#E3EAEF` | `#121A21` | Text | `#DCE3EB` / `#18212C` |
| `--ink-2` | `#A9B6C0` | `#3A4650` | Secondary text, the light's reason | `#AAB5C2` / `#434F5D` |
| `--ink-3` | `#909DA8` | `#4F5D68` | Tertiary text. Also the grey "no claim" ring and the muted leading edge (it replaces the prototype's `--stale-dot`, which had the same value). | `#8E9AA8` / `#5A6674` |
| `--line` | `#283741` | `#DCE1E4` | Pane hairline | `#253140` / `#DCE1E8` |
| `--line-2` | `#212E37` | `#E7EBED` | Row dividers | `#1D2733` / `#E8ECF1` |
| `--line-strong` | `#6E7D89` | `#7A8791` | Input, checkbox and radio borders only | `#667384` / `#7B8694` |
| `--track` | `#2A3841` | `#E8ECED` | The empty bar | `#26313E` / `#DCE2EA` |
| `--accent` | `#8ADCE8` | `#086476` | Cyan text: links, overlines, NOW, Next, focus ring, tab indicator | `#86A9FF` / `#2352BD` |
| `--accent-strong` | `#B9EEF5` | `#054C5A` | Link hover | `#A6C0FF` / `#1B4399` |
| `--accent-soft` | `#1F343D` | `#DFEFF2` | Cyan tint: open row, chosen card, halo ring | `#1B2A48` / `#E5ECFA` |
| `--on-accent` | `#05232A` | `#FFFFFF` | Text on the primary | `#0B1733` / `#FFFFFF` |
| `--trail` | `#CDF8FC` | `#08788D` | The hot light: leading edges, bar heads, the current node's centre | `#B8D6FF` / `#6F93E8` |
| **`--light`** new | `#5FDDED` | `#0A8AA1` | The live light's dot and rings, spine fill, lit rings, fills. Never text. | — |
| **`--primary-1`** new | `#9BE9F3` | `#0E7486` | Primary button gradient, top | — |
| **`--primary-2`** new | `#6AD6E6` | `#095B6A` | Primary button gradient, bottom | — |
| **`--reading-fill`** new | `#41636C` | `#B2DAE1` | The "being read" bar segment (decorative, §2.5) | — |
| `--sys-confidence` / `-soft` | `#BDB0FF` / `#2F3547` | `#5741B0` / `#E7E7F3` | Certainty-check evidence only | `#B3A3FF` / `#5A43B5` |
| `--sys-reader` / `-soft` | `#A7C7FF` / `#2C3847` | `#1D5AA8` / `#E1E9F2` | Reader evidence only. It is now blue, so it can never be confused with the cyan light. | `#62C6DA` / `#0B6A80` |
| `--filed` / `-soft` | `#7AD7A0` / `#253938` | `#186A34` / `#DDE9E3` | Filed: text and pill | `#6DD08B` / `#1C7439` |
| **`--filed-bar`** new | `#7AD7A0` | `#2E9254` | Filed fill: segment, meter, swatch | — |
| `--review` / `-soft` | `#EDC069` / `#343631` | `#7A4D00` / `#EBE6DA` | Needs review: text and pill | `#EDB85A` / `#865400` |
| **`--review-bar`** new | `#EDC069` | `#B07A10` | Needs-review fill | — |
| `--failed` / `-soft` | `#FF8F84` / `#34282D` | `#B3261E` / `#F3E6E6` | **Red text** for every failure word, and the "Could not process" pill | `#FF9282` / `#B0281D` |
| **`--failed-bar`** new | `#FF5A4D` | `#D23F33` (D1 B: `#B3261E`) | "Could not process" fill | — |
| **`--fail-line`** new | `#FF5A4D` | `#D23F33` | **Red non-text:** failed light, failed node ring, red leading edge, failure rule, red top edge of a pane | — |

### 2.3 Effect tokens (not hex; excluded from the hex check)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--glow` (existing) | `0 0 0 1px rgb(95 221 237 / .30), 0 0 14px rgb(95 221 237 / .22)` | `0 0 0 1px rgb(8 100 118 / .20), 0 0 10px rgb(10 150 175 / .16)` | Lit tab bar, current pip |
| `--light-glow` | `rgb(95 221 237 / .45)` | `rgb(10 150 175 / .32)` | The light's halo, the head's glow |
| `--light-glow-soft` | `rgb(95 221 237 / .16)` | `rgb(10 150 175 / .12)` | Fills, head outer glow |
| `--fail-glow` | `rgb(255 90 77 / .38)` | `rgb(210 63 51 / .26)` | Red halo on the dot, node and head. It is kept small, so red never glares. |
| `--edge-lit` / `--fail-edge-lit` | `rgb(120 232 246 / .55)` / `rgb(255 110 96 / .62)` | `rgb(10 147 171 / .72)` / `rgb(210 63 51 / .70)` | The resting 1 px top-edge light of a pane, cyan or red |
| `--trace-band` / `--fail-trace-band` | `rgb(160 240 250 / .95)` / `rgb(255 128 114 / .66)` | `rgb(8 130 155 / .95)` / `rgb(196 50 40 / .72)` | The edge trace's band |
| `--sheen` | `rgb(95 221 237 / .045)` | `rgb(10 147 171 / .05)` | Top sheen of stage panes |
| `--ground-glow-1` / `-2` | `rgb(70 200 230 / .085)` / `rgb(124 140 255 / .05)` | `rgb(10 156 184 / .06)` / `rgb(90 108 255 / .035)` | The fixed ground glow |
| `--lattice` | `rgb(140 210 230 / .038)` | `rgb(20 60 80 / .055)` | The fixed 160 px lattice ("the architecture") |
| `--focus-halo` | `rgb(127 230 242 / .20)` | `rgb(7 121 142 / .16)` | The 6 px halo outside the focus outline |
| `--hold-a` | `.4` | `.6` | Opacity of the waiting light's still outer ring |
| `--scrim` (existing) | `rgb(14 20 26 / .72)` | `rgb(228 233 237 / .72)` | Sheet backdrop |
| `--shadow-1` (existing) | `0 1px 0 rgb(0 0 0 / .35), 0 34px 70px -34px rgb(0 0 0 / .75)` | `0 1px 2px rgb(20 40 55 / .06), 0 26px 54px -30px rgb(20 40 55 / .32)` | Panes |
| `--shadow-2` (existing) | `0 20px 50px -18px rgb(0 0 0 / .7), 0 0 0 1px rgb(150 205 222 / .16)` | `0 20px 44px -18px rgb(20 40 55 / .35), 0 0 0 1px rgb(20 50 65 / .14)` | Sheets, tips, callouts |
| `--inner-highlight` (existing) | `inset 0 1px 0 rgb(255 255 255 / .04)` | `inset 0 1px 0 rgb(255 255 255 / .9)` | This is no longer `none` in light, so `box-shadow: var(--shadow-1), var(--inner-highlight)` works in both themes. The dark-only rule in `base.css` goes. |

### 2.4 Non-themed tokens (in `:root` only; the dark block must not declare them)

```css
/* type: system faces only; nothing is downloaded */
--font-sans: "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
--font-display: "Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
--fs-26: 26px; --fs-hero: clamp(40px, 4.7vw, 68px); --fs-h1: clamp(34px, 3.9vw, 56px);
--fs-count: clamp(56px, 6.6vw, 100px); --fs-tally: 52px; --fs-spend: 40px;
--lh-display: 1.02; --lh-count: .92; --fw-light: 300;
--tracking-display: -0.03em; --tracking-hero: -0.032em; --tracking-count: -0.04em; --tracking-overline: 0.16em;
--measure-now: 78ch;
/* space (4 px base) */
--sp-10: 72px; --sp-11: 96px;
/* radius */
--r-xs: 6px; --r-sm: 10px; --r: 14px; --r-card: 18px; --r-lg: 22px; --r-xl: 30px; --r-pill: 999px;
/* sizes and layout */
--control-h: 46px; --control-h-sm: 34px; --control-h-xl: 56px; --icon-btn: 40px;
--track-h: 6px; --track-h-lg: 16px; --focus-offset: 3px; --page-max: 1344px; --gutter: 48px;
--topbar-h: 64px; --row-h: 46px; --panel-w: 400px; --spine-w: 244px; --spine-gap: 52px; --light-dot: 12px;
/* motion: the full list is in §7.2 */
```

Existing values that change:

- `--r-xs` 4 → 6, `--r-sm` 8 → 10, `--r` 10 → 14, `--r-lg` 16 → 22;
- `--control-h` 40 → 46, `--control-h-sm` 32 → 34;
- `--track-h-lg` 10 → 16, `--focus-offset` 2 → 3;
- `--page-max` 1280 → 1344, `--gutter` 28 → 48;
- `--topbar-h` 56 → 64, `--row-h` 40 → 46, `--panel-w` 420 → 400;
- `--tracking-display` −0.02 → −0.03em, `--tracking-overline` 0.06 → 0.16em.

`--stage-narrow` and `--stage-wide` stay declared. `--stage-wide` caps the stage column on views without the spine.

### 2.5 Computed contrast (`spec-v2-tokens.py`, run in this session)

**Dark text** (4.5:1 needed):

| text \ on | `--canvas` | `--surface` | `--surface-2` | `--surface-3` | `--raised` | `--accent-soft` |
|---|---|---|---|---|---|---|
| `--ink` `#E3EAEF` | 15.24 | 13.41 | 12.16 | 11.32 | 12.94 | 10.69 |
| `--ink-2` `#A9B6C0` | 8.94 | 7.87 | 7.13 | 6.64 | 7.59 | 6.27 |
| `--ink-3` `#909DA8` | 6.68 | 5.88 | 5.33 | 4.96 | 5.67 | **4.68** |
| `--accent` `#8ADCE8` | 11.89 | 10.47 | 9.49 | 8.83 | 10.10 | 8.34 |
| `--failed` `#FF8F84` (red text) | 8.39 | 7.38 | 6.69 | 6.23 | 7.12 | 5.88 |
| `--filed` `#7AD7A0` | 10.63 | 9.36 | 8.48 | 7.90 | 9.03 | 7.46 |
| `--review` `#EDC069` | 10.89 | 9.58 | 8.69 | 8.09 | 9.24 | 7.64 |
| `--sys-confidence` `#BDB0FF` | 9.54 | 8.40 | 7.61 | 7.09 | 8.10 | 6.69 |
| `--sys-reader` `#A7C7FF` | 10.81 | 9.51 | 8.62 | 8.03 | 9.18 | 7.58 |

**Dark non-text** (3:1 needed):

| mark \ on | `--canvas` | `--surface` | `--surface-2` | `--raised` | `--track` |
|---|---|---|---|---|---|
| `--light` `#5FDDED` | 11.51 | 10.13 | 9.18 | 9.77 | 7.50 |
| `--trail` `#CDF8FC` (head, edge) | 16.26 | 14.30 | 12.97 | 13.80 | 10.59 |
| `--ink-3` (grey ring, muted edge) | 6.68 | 5.88 | 5.33 | 5.67 | 4.35 |
| `--fail-line` `#FF5A4D` | 6.02 | 5.29 | 4.80 | 5.11 | 3.92 |
| `--accent` (focus, tab bar) | 11.89 | 10.47 | 9.49 | 10.10 | 7.75 |
| `--line-strong` `#6E7D89` | 4.37 | 3.85 | **3.49** | 3.71 | not used |
| `--filed-bar` | 10.63 | 9.36 | 8.48 | 9.03 | 6.93 |
| `--review-bar` | 10.89 | 9.58 | 8.69 | 9.24 | 7.09 |
| `--failed-bar` | 6.02 | 5.29 | 4.80 | 5.11 | 3.92 |

**Dark, other pairs:**
- Pills (text on its own soft fill): filed 7.00, review 7.19, could not process 6.40.
- Evidence panels: certainty check 6.29, reader 6.95 (text on its soft fill).
- Banner text: `--ink` 10.04 / 10.06 / 11.62 and `--ink-2` 5.89 / 5.90 / 6.82 (on the filed / review / could-not-process soft fills).
- Primary label: 11.98 on `--primary-1`, 9.67 on `--primary-2`, 10.53 on `--accent`, 12.97 on `--accent-strong`.
- The 2 px cut against the fills: filed 9.03, review 9.24, could not process 5.11.

**Light text** (4.5:1 needed):

| text \ on | `--canvas` | `--surface` | `--surface-2` | `--surface-3` | `--raised` | `--accent-soft` |
|---|---|---|---|---|---|---|
| `--ink` `#121A21` | 14.37 | 16.63 | 15.61 | 14.90 | 17.06 | 14.86 |
| `--ink-2` `#3A4650` | 7.91 | 9.16 | 8.59 | 8.20 | 9.39 | 8.18 |
| `--ink-3` `#4F5D68` | 5.54 | 6.42 | 6.02 | 5.75 | 6.58 | 5.73 |
| `--accent` `#086476` | 5.55 | 6.43 | 6.03 | 5.76 | 6.59 | 5.74 |
| `--failed` `#B3261E` (red text) | **5.35** | 6.19 | 5.81 | 5.54 | 6.35 | 5.53 |
| `--filed` `#186A34` | 5.45 | 6.31 | 5.93 | 5.65 | 6.47 | 5.64 |
| `--review` `#7A4D00` | 5.95 | 6.88 | 6.46 | 6.17 | 7.06 | 6.15 |
| `--sys-confidence` `#5741B0` | 6.16 | 7.13 | 6.69 | 6.39 | 7.31 | 6.37 |
| `--sys-reader` `#1D5AA8` | 5.58 | 6.46 | 6.06 | 5.78 | 6.62 | 5.77 |

**Light non-text** (3:1 needed):

| mark \ on | `--canvas` | `--surface` | `--surface-2` | `--raised` | `--track` |
|---|---|---|---|---|---|
| `--light` `#0A8AA1` | 3.33 | 3.85 | 3.62 | 3.95 | 3.42 |
| `--trail` `#08788D` | 4.21 | 4.87 | 4.57 | 5.00 | 4.32 |
| `--ink-3` (grey ring, muted edge) | 5.54 | 6.42 | 6.02 | 6.58 | 5.70 |
| `--fail-line` `#D23F33` | 3.82 | 4.42 | 4.15 | 4.53 | 3.92 |
| `--accent` (focus, tab bar) | 5.55 | 6.43 | 6.03 | 6.59 | 5.70 |
| `--line-strong` `#7A8791` | 3.01 | 3.49 | 3.27 | 3.58 | not used |
| `--filed-bar` `#2E9254` | 3.21 | 3.71 | 3.49 | 3.81 | 3.30 |
| `--review-bar` `#B07A10` | 3.05 | 3.53 | 3.31 | 3.62 | **3.13** |
| `--failed-bar` `#D23F33` | 3.82 | 4.42 | 4.15 | 4.53 | 3.92 |

**Light, other pairs:**
- Pills: filed 5.35, review 5.84, could not process 5.38.
- Evidence panels: 6.14 and 5.56.
- Banner text: `--ink` 14.09 / 14.11 / 14.45 and `--ink-2` 7.75 / 7.76 / 7.95.
- Primary label (white): 5.44 on `--primary-1`, 7.73 on `--primary-2`, 6.79 on `--accent`, 9.60 on `--accent-strong`.
- The 2 px cut: 3.81 / 3.62 / 4.53.

**Summary:**

| | Gate pairs | New pairs | Lowest text | Lowest non-text |
|---|---|---|---|---|
| Dark | 73 / 73 | 30 / 30 | 4.68 (`--ink-3` on `--accent-soft`) | 3.49 (`--line-strong` on `--surface-2`) |
| Light | 73 / 73 | 30 / 30 | 5.35 (`--failed` on `--canvas`) | 3.13 (`--review-bar` on `--track`) |

- **Red text passes with room.** It is at least 5.88 in dark and 5.35 in light. In dark, the red text (`#FF8F84`) is softer than the red line (`#FF5A4D`), so words stay readable without glare. The red areas are small: a 12 px dot, 2 px rules, a 24 px node ring and a 4 px head.
- **The defect found here.** In the prototype's light theme, the track is `rgb(20 50 65 / .11)`. The needs-review fill measured **2.96:1** against it, and filed 3.11. In this spec the light `--track` is `.08` (`#E8ECED`), which gives 3.13 and 3.30. The empty track keeps its 1 px `--line` inset edge, so it still reads as a track. The prototype is not edited; this is recorded as deviation 1 in §11.
- **Decorative rows** (recorded, no minimum; their meaning is in text):
  - "being read" against the track: 1.85 dark, 1.26 light;
  - empty track on the stage pane: 1.30 / 1.16;
  - pane hairline: 1.33 / 1.25;
  - filed fill against needs-review fill: 1.02 / 1.05. These two are told apart by hue, word, glyph and the 2 px cut.

### 2.6 Changes to `scripts/tokens-contrast.test.mjs` (same commit as the token change)

1. **`REQUIRED` and `THEMED`.** Add the 8 new hex tokens (`--light`, `--primary-1`, `--primary-2`, `--reading-fill`, `--filed-bar`, `--review-bar`, `--failed-bar`, `--fail-line`) and the 13 new effect tokens (`--light-glow`, `--light-glow-soft`, `--fail-glow`, `--edge-lit`, `--fail-edge-lit`, `--trace-band`, `--fail-trace-band`, `--sheen`, `--ground-glow-1`, `--ground-glow-2`, `--lattice`, `--focus-halo`, `--hold-a`).
2. **The hex check's exclusion list** gains the 13 effect tokens.
3. **Non-themed tokens.** `REQUIRED` gains the tokens in §2.4 and §7.2. `THEMED` does not.
4. **`PAIRS` gains 30 rows**, in this order:
   - `--light` on `--canvas`, `--surface`, `--surface-2`, `--raised`, `--accent-soft` (3:1);
   - `--trail` on `--canvas`, `--surface`, `--raised`, `--track` (3:1);
   - `--ink-3` on `--track` (3:1);
   - `--fail-line` on `--canvas`, `--surface`, `--surface-2`, `--raised`, `--track` (3:1);
   - `--failed` on `--accent-soft` (4.5:1);
   - each of `--filed-bar`, `--review-bar` and `--failed-bar` on `--surface`, `--raised`, `--track` (3:1);
   - `--raised` on each `-bar` (3:1: the cut);
   - `--on-accent` on `--primary-1` and on `--primary-2` (4.5:1).
5. **Counts.** The count assertion changes to 103 (text 59, non-text 44). The diagnostic then reads "206 of 206".
6. **The literal-value tests** stay as they are. They check the formula, not the tokens.

---

## 3. Type, radius, spacing, layout

**Faces.** Segoe UI Variable Display is used for headings and counts, and Segoe UI Variable Text for everything else. Both are system fonts, fall back to Segoe UI and then `system-ui`, and nothing is downloaded. Edge resolved both on this PC.

**Scale.** The prototype's half sizes are normalised to the token scale. SPEC §8.2's 12 px minimum now holds everywhere; the prototype had 10.5, 11 and 11.5 px labels.

| Role | Size / line height | Weight / tracking | Colour | Change from the prototype |
|---|---|---|---|---|
| Hero (Home) | `--fs-hero` / 1.0 | 600 / `--tracking-hero` | ink; one `em` in `--accent` | — |
| Stage heading `h1` | `--fs-h1` / `--lh-display` | 600 / `--tracking-display` | ink | — |
| Giant count | `--fs-count` / `--lh-count` (72 px at ≤760) | **300** / `--tracking-count`, tabular figures **after** the `font` shorthand | ink; `--ink-2` when the stage is muted | — |
| Tally / spend | `--fs-tally` (40 at ≤760) / 1; `--fs-spend` / 1.1 | 300, tabular | ink | — |
| Pane heading | 20 / 1.25 | 600 display / −0.01em | ink | — |
| Run name (spine) | `--fs-26` / 1.1 (17 at ≤900) | 600 display / −0.015em | ink | — |
| Light: state word | 15 / 1.3 | 600, sentence case | ink; `--failed` when failed; `--ink-2` for grey states | — |
| Light: reason | 14 / 1.4 | 400 | `--ink-2` | 13.5 → 14 |
| Now line | 17 / 1.6, measure `--measure-now` | 400 ink. The label "NOW" is 12 px, 600, uppercase, `--tracking-overline`, `--accent`. | | NOW 11 → 12 |
| Overlines (step overline, pane overline, chapter names) | 12 / 1.25 | 600, uppercase, `--tracking-overline` | `--accent`; chapter names `--ink-3` | 10.5 and 11.5 → 12 |
| Body | 15 / 1.55 | 400 | ink | — |
| Legend, run facts, helper and feedback text | 13 / 1.45–1.5 | 400–500 | `--ink-2`; values ink 600 | 12.5 → 13 |
| Step labels (spine) | 15 / 1.25 | 500; current 600 | `--ink-3`, done `--ink-2`, current and failed ink | 14.5 → 15 |
| Failure message / notice | 15 / 1.5; 14 / 1.5 | 400 | **ink** (the red is the rule and the glyph) | — |
| Pills, captions | 12 | 600 | outcome text colour | — |

**Amendments to SPEC §8.2:**
- **Weight 300** is allowed for display numerals only: the giant count, tallies and spend. All other weights stay 400, 500 and 600.
- **Uppercase** is allowed for 12 px overlines. That covers the step overline, the NOW label, pane overlines, chapter names and evidence section heads.
- **Tabular figures** are used for every count, time and amount of money. On any element that sets `font`, `font-variant-numeric: tabular-nums` must come after the shorthand, because the shorthand resets it. That is how the prototype fixed M1, and the Playwright check `tabularCounts` asserts it.

**Radius.**
- `--r-xs` 6: tags, ext badges.
- `--r-sm` 10: small controls.
- `--r` 14: wells, rows.
- `--r-card` 18: radio and definition cards.
- `--r-lg` 22: panes, the one-line Sorting strip.
- `--r-xl` 30: stage panes.
- `--r-pill`: buttons, pills, toggles.
- The edge-trace ring follows its pane's radius. The failure rule is a 2 px bar with a 2 px radius.
- Below 760 px, panes use 20 and stage panes 24.

**Spacing** (4 px base): 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 56 · 72 · 96.

- **Panes.** Padding 28, stage panes 32 × 38, 20 on phones. 20 between panes.
- **Frame.** Gutters 48 / 32 / 16; spine column 244 (216 at ≤1180); column gap 52 (36 at ≤1180).
- **Light.** 14 from the light to the state word, and 14 from the state word to the reason.
- **Beneath the status row.** 18 from the status row to what sits under it (a failure block, or See the results).
- **Failure block.** 18 from the rule to the text, 12 between message and action row, 18 between button and consequence, 24 below.
- **Legend.** 14 below the bar; items 20 apart (16 on phones).
- **A pane's last line.** 26 above it, a hairline, then 20 to the text. The container is not laid out when empty.

**Controls.**
- Primary buttons are 46 px high (`--control-h`), 56 (`--control-h-xl`) for the one big action on a screen, and 34 for small ones.
- Targets are at least 24 × 24 CSS px.
- There is at most one visible primary per screen. This is unchanged and asserted by Playwright.

**Breakpoints** (these replace SPEC §2.7's 900 / 760 / 639):

| At or below | What changes |
|---|---|
| 1180 | Tighter frame; Results tallies stack above the table |
| 1100 | Review becomes one column; the definitions panel follows the list, with a Jump link |
| 980 | Home and Confirm become one column |
| 900 | The spine collapses to the compact run row and 10 segments. The frame becomes one column, and the RunStrip is enabled. |
| 760 | The top bar wraps and the tabs get their own row. The facts line shows two facts plus More. Tallies stack. Results rows become two-line cards. "Setup complete" is hidden. |

---

## 4. The shell: where the regions sit (amends SPEC §2.1)

The regions, their files and their update rules stay as in SPEC §2.1: mounted once, text and attributes rewritten in place, and `StageHost` remounting only on a route-shape change. Only their placement and look change.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ Document sorting   Home  Runs  Categories  How it works              ✓ Setup complete   ◐  │ TopBar 64, sticky, cornice light
├──────────────┬───────────────────────────────────────────────────────────────────────────────┤
│ THIS RUN     │ STEP 5 OF 10 · SORT                               (hidden on Progress, ≤900)  │ stage head (on the canvas)
│ Run 9        │ Sorting 114 documents                                   [● Live updates]      │  h1 · Live updates (while live)
│ 25 Sep 13:58 │ NOW  Both systems are reading the documents. You can close this page…         │  NarrationStrip = the Now line
│ ● Working    │      Next → (only when the primary is out of sight at the top of the page)    │
│              │ · Interactive · Spent $0.42 of $5.00 · 5 categories (version 4) · Run facts   │  RunHeader chips = the facts line
│ YOUR FILES   │ ╭───────────────────────────────────────────────────────────────────────────╮ │
│ ◉ Choose …   │ │ ● Working   last activity just now                                        │ │ the working pane (stage pane)
│ ◉ Read files │ │ [failure block or the finished action, directly beneath the light]        │ │
│ START        │ │ 73  of 114 have an outcome                                                │ │
│ ◉ Confirm    │ │ ███████████████▌██████▍░░░░░░░░░░░░░ + legend                            │ │
│ ◉ Send       │ ╰───────────────────────────────────────────────────────────────────────────╯ │
│ SORTING      │                                                                               │
│ ◎ Sort  ←pulse                                                                               │
│ …            │                                                                               │
└──────────────┴───────────────────────────────────────────────────────────────────────────────┘
 JourneyRail = the spine (vertical)                         StageHost: panes on the canvas, no stage card
```

| Region (file) | New placement and look | What stays |
|---|---|---|
| **TopBar** (`shell/top-bar.ts`) | 64 px, sticky. Background: canvas at 86% with a 12 px backdrop blur (the only blur outside the sheet). A 1 px "cornice" light fades out at both ends (`--edge-lit`, opacity .5). Brand mark: a 30 px SVG with a frame, trail and dot. Tabs have one sliding 2 px `--light` indicator with `--glow` (M8-style move, `--dur-tab`). The **activity pill** carries a 12 px StatusLight dot on the same shared beat, and turns red when that work failed. | Links, the setup word, the theme toggle, and text-only updates |
| **RunHeader** (`shell/run-header.ts`) | Split in two. **(a) Identity block** at the top of the spine: overline "THIS RUN", the name, when (hidden once reading has begun on a new run), and the **StatusLight** (state word only). **(b) Facts line** in the stage head: the chips as dot-separated quiet text; `Run facts` and **Live updates** at its end. Live updates is also placed at the right of the heading row on Progress. The "Checked … · Last change …" line moves into the Run facts sheet, as the rows "Last checked" and "Last change". The `seam-checked` and `shell-last-change` test ids stay on those rows. | Every chip value is read from the server. The Run facts sheet and its technical Details are unchanged. |
| **JourneyRail** (`shell/journey-rail.ts`) | **Vertical spine** in the left column, sticky at `--topbar-h + 32`. Five chapter names (12 px overlines) above pairs of steps. 24 px nodes and a 2 px rail at x = 11. The fill (scaleY) runs to the current node, with a 6 × 44 head that shows only while it advances. Node states are in §5.2 and §6.3. At ≤900: a compact line "**Step 5 of 10** · Sort" plus **10 segments**, one per step. The segments replace the 5 chapter pips; the current segment is hot, done segments cyan, and a failed one red. | `nav` + `ol`, `aria-current="step"`, the reason as text on hover and focus, and M2's rule that transitions happen only for a current step becoming done in this session |
| **NarrationStrip** (`shell/narration.ts`) | Becomes the **Now line** in the stage head. The hanging label "NOW", the sentence in its own column, and **Next** beneath it. The box, rule and background of `.narration` go. Next is hidden when the primary is already on screen with the page at the top: measured after mount and on resize (ResizeObserver, no timers). | Not a live region; announced through `a11y.narrate`. Next focuses `[data-primary]`. Written only when the text changes. |
| **StageHost** (`shell/stage-host.ts`) | No stage card: the `.stage` card's background, border, radius, shadow and padding go. Views compose panes on the canvas. The stage head (overline, h1, Now, facts) is the first child of every view that shows the subject. The screen-open motion is in §7.4. | Mount per route shape; view-state restore; the h1 focus rule; the loading placeholder inside the stage |
| **RunStrip** (`shell/run-strip.ts`) | Enabled **only at ≤900 px**, where the spine is not sticky, and only when the compact run row has scrolled out. It reads: name · "Step 5 of 10 · Sort" · the StatusLight with its state word. | 40 px, sticky under the TopBar, IntersectionObserver |
| **Read problem** (SPEC §4.5) | It is no longer a RunHeader line. On a working view it becomes the red failure block beneath the pane's light: "Can't reach the service · since 14:23", with **Try again** (`poller.nudge()`, a GET). On any other view of the subject, the spine light shows the red state word, with a quiet "Try again" link beneath it. | Back-off unchanged. The next-check time moves into the failure block's consequence line: "The page also tries again at 14:02:26." |

**Frame.** `.frame` is a grid of `var(--spine-w) minmax(0, 1fr)` with `column-gap: var(--spine-gap)`, max 1440 px, and padding `0 var(--gutter) 120px`. On views without a subject (Home, Runs, Categories, How it works, System) it is one column, and the spine column is not rendered.

**Ground.** These stay:
- `body::before`: two fixed radial glows (`--ground-glow-1/2`);
- `body::after`: the fixed 160 px lattice (`--lattice`), masked to fade in towards the bottom.

Both are painted once, are `position: fixed`, and never repaint on scroll.

---

## 5. The live indicator (`StatusLight`)

### 5.1 Anatomy

```html
<p class="status" data-light="live" data-key="live|last-activity">
  <span class="ind" aria-hidden="true">
    <span class="ind__halo"></span><span class="ind__hold"></span><span class="ind__ring"></span>
    <span class="ind__beat"></span><span class="ind__dot"></span>
  </span>
  <span class="status__state">Working</span>
  <span class="status__why">last activity just now</span>        <!-- absent in the compact (header) form -->
</p>
```

```css
.ind { --ic: var(--light); --ig: var(--light-glow); position: relative; flex: none; width: var(--light-dot); height: var(--light-dot); display: inline-grid; place-items: center; }
.ind > span { position: absolute; inset: 0; border-radius: 50%; pointer-events: none; }
.ind__dot  { background: var(--ic); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ic) 16%, transparent); }
.ind__halo { inset: -7px !important; background: radial-gradient(closest-side, var(--ig), transparent); opacity: .55; }
.ind__ring, .ind__beat { border: 1.5px solid var(--ic); opacity: 0; }
.ind__beat { border-color: var(--fail-line); }
.ind__hold { inset: -5px !important; border: 1.5px solid var(--ic); opacity: 0; }          /* waiting only */
.ind.is-waiting .ind__halo { opacity: .9; }  .ind.is-waiting .ind__hold { opacity: var(--hold-a); }
.ind.is-stale, .ind.is-paused, .ind.is-idle { --ic: var(--ink-3); --ig: transparent; }
.ind.is-stale .ind__dot, .ind.is-paused .ind__dot, .ind.is-idle .ind__dot, .ind.is-done .ind__dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--ic); }
.ind.is-failed { --ic: var(--fail-line); --ig: var(--fail-glow); }  .ind.is-failed .ind__halo { opacity: .8; }
.ind.is-done { --ig: transparent; }
.status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; min-width: 0; }
.status__state { font: 600 15px/1.3 var(--font-sans); color: var(--ink); }
.status__why { font-size: 14px; line-height: 1.4; color: var(--ink-2); }
.status.is-failed .status__state { color: var(--failed); }
.status.is-idle .status__state { color: var(--ink-2); }
@media (forced-colors: active) { .ind__dot { forced-color-adjust: none; background: CanvasText; } .ind__halo { display: none; } }
```

Sizes:
- the dot is 12 px;
- the halo reaches 7 px beyond it;
- the live ring (1.5 px) leaves the dot to 3×;
- the still waiting ring is 22 px (−5 inset) at `--hold-a`;
- the red beat ring leaves to 3.2×, once;
- a journey node's pulse ring leaves to 1.9×.

Everything except the words is `aria-hidden`. The words carry the meaning, so a person who cannot see colour, or who uses forced colours, loses nothing.

### 5.2 Placements (all beat together)

1. **Spine identity block (the run header):** state word only, and the same word as the pane.
2. **The working pane's first line:** Files (reading), Progress (sending and sorting), Build (making folders; not drawn in the prototype; same component and rules). The state word and the reason are both shown.
3. **The current journey node.**
   - Live: the ring leaves the node to 1.9× on the shared beat.
   - Waiting, stale or paused: the normal current node (2 px `--light` ring, 5 px `--accent-soft` halo, 8 px `--trail` centre) with no ring leaving.
   - Failed: see §6.3.
   - At ≤900 px the current segment's glow swells on the same beat instead.
4. **RunStrip** (≤900 px) and the **activity pill**: the dot only, on the same beat.

The subject's light is the light of the work going on for it: an active local controller for the subject (reading, building) if there is one; otherwise the run's light.

### 5.3 The model: `core/ui/live-light.ts` (pure; gate-tested; SPEC L3)

```ts
import type { RunStatus } from '../domain/run-status-types.ts';
import type { SendSituation } from './upload-status.ts';
import type { ProviderWait } from './provider-wait.ts';
import type { SendStateKind } from './journey.ts';       // core/ui never imports ui/app/state/types.ts

export const LIGHT_LEASE_MIN_MS = 15_000;   // five visible reads (RUN_POLL_VISIBLE_MS = 3 s); the prototype's measured lease
export const LOCAL_QUIET_MS = 15_000;       // local work (reading, copying) with no new file for this long reads Waiting
export type LightKind = 'live' | 'waiting' | 'stale' | 'paused' | 'failed' | 'done' | 'idle';
export type FailureKind = 'read' | 'upload-stalled' | 'upload-stalled-elsewhere' | 'handover-stalled' | 'send-dropped'
  | 'send-rejected' | 'handover-failed' | 'mode-mismatch' | 'halted' | 'halted-emergency' | 'scan-failed' | 'build-failed';
export type LightReason =
  | { kind: 'last-activity'; at: number | null; checkedAt: number }    // live, sorting
  | { kind: 'last-received'; at: number | null; from: 'here' | 'other-tab' | 'elsewhere' }
  | { kind: 'handing-over' } | { kind: 'on-this-computer' } | { kind: 'looking' }
  | { kind: 'provider-wait'; until: number } | { kind: 'quiet'; since: number } | { kind: 'closing' }
  | { kind: 'confirming'; since: number } | { kind: 'other-tab-quiet'; since: number }
  | { kind: 'first-document' } | { kind: 'one-file'; since: number }
  | { kind: 'not-updated'; since: number } | { kind: 'paused'; at: number | null }
  | { kind: 'failure'; failure: FailureKind; since: number }
  | { kind: 'finished'; at: number | null } | { kind: 'checking' } | { kind: 'sort-not-started' }
  | { kind: 'discarded'; at: number | null } | { kind: 'stopped-by-you'; done: number };
export interface Light {
  kind: LightKind;
  reason: LightReason;
  /** The meaning, for the text reveal: `${kind}|${reason.kind}` (+ `|${failure}` when failed). A new time or count inside the same key never animates. */
  key: string;
  /** Epoch ms until which the pulse may run (kind 'live' only), else null. */
  liveUntil: number | null;
}
export interface RunLightFacts {
  now: number; visible: boolean; status: RunStatus | null; total: number; decided: number; undispatched: number;
  checkedAt: number | null; lastEventAt: number | null; lastUploadAt: number | null; createdAt: number;
  undispatchedChangedAt: number | null;
  readProblem: { at: number } | null; liveToggle: boolean; pausedAt: number | null; controllersHere: number;
  send: { kind: SendStateKind; lastAckAt: number | null; startedAt: number | null; at: number | null };
  situation: SendSituation; quiet: { quiet: false } | { quiet: true; since: number };
  waits: readonly ProviderWait[]; stop: { emergency: boolean; at: number } | null;
}
export function leaseMs(visible: boolean): number;            // max(LIGHT_LEASE_MIN_MS, 3 × the poll interval in force): 15 s visible, 45 s hidden
export function runLight(f: RunLightFacts): Light;
export function runLightDeadline(f: RunLightFacts): number | null;  // the earliest time runLight() could change with no new facts
export interface LocalLightFacts { now: number; work: 'looking' | 'reading' | 'copying';
  state: 'working' | 'failed' | 'stopped' | 'done'; lastProgressAt: number | null; startedAt: number; at: number | null; done: number }
export function localLight(f: LocalLightFacts): Light;
export function localLightDeadline(f: LocalLightFacts): number | null;
```

**`runLight` evaluation order.** The first match wins, and the tests follow this order.

| # | When | Light |
|---|---|---|
| 1 | `status === null` (no read yet) | idle · `checking` |
| 2 | `status === 'halted'` | failed · `halted`, or `halted-emergency` when `stop.emergency`; since `stop.at` |
| 3 | `send.kind` ∈ {`rejected`, `dropped`, `handover-failed`, `mode-mismatch`}: this tab's own request failed | failed · `send-rejected` / `send-dropped` / `handover-failed` / `mode-mismatch`; since `send.at` |
| 4 | `situation.kind === 'mode-mismatch'` | failed · `mode-mismatch` |
| 5 | `readProblem !== null` | failed · `read`; since `readProblem.at` |
| 6 | `situation.kind === 'upload-stalled'` | failed · `upload-stalled` when `canContinueHere`, else `upload-stalled-elsewhere`; since `situation.since` |
| 7 | `situation.kind === 'handover-stalled'` | failed · `handover-stalled`; since `situation.since` |
| 8 | `status === 'complete'`, or `closed` with `decided === total` | done · `finished` at `lastEventAt` |
| 9 | `status === 'closed'` and `decided < total` | idle · `discarded` |
| 10 | `status === 'closing'` | waiting · `closing` |
| 11 | `!liveToggle && controllersHere === 0` | paused · `paused` at the time the toggle was turned off |
| 12 | `checkedAt === null` or `now − checkedAt ≥ leaseMs(visible)` | stale · `not-updated` since `checkedAt` |
| 13 | `status === 'uploading'`, `sending-here` | If `send.kind === 'sending'` and `now − (lastAckAt ?? startedAt) ≥ UPLOAD_QUIET_MS`: waiting · `confirming`. Otherwise: live · `last-received` (`here`). |
| 14 | `sending-elsewhere-this-browser` | If `now − (lastUploadAt ?? createdAt) ≥ UPLOAD_QUIET_MS`: waiting · `other-tab-quiet`. Otherwise: live · `last-received` (`other-tab`). |
| 15 | `arriving-from-elsewhere` | If `lastUploadAt === null`: waiting · `first-document`. Otherwise: live · `last-received` (`elsewhere`). |
| 16 | `status === 'running'` and `undispatched > 0` (`handover-in-progress`) | live · `handing-over` |
| 17 | `status === 'running'` and `waits.length > 0` | waiting · `provider-wait` until the latest `until` |
| 18 | `status === 'running'` and `quiet.quiet` | waiting · `quiet` since `quiet.since` |
| 19 | `status === 'running'` | live · `last-activity` (`lastEventAt`, `checkedAt`) |

For live results, `liveUntil = checkedAt + leaseMs(visible)`. In rule 13 it is `max(checkedAt, lastAckAt) + leaseMs`, because an upload acknowledgement is also a confirmation from the service.

**`localLight`:**
- `failed` gives failed · `scan-failed` or `build-failed`.
- `stopped` (the person pressed Stop after this file) gives idle · `stopped-by-you`. It is not red, because nothing failed.
- `done` gives done.
- `working` gives:
  - waiting · `one-file` when `now − (lastProgressAt ?? startedAt) ≥ LOCAL_QUIET_MS`;
  - otherwise live · `on-this-computer` (reading, copying) or `looking` (scanning), with `liveUntil = (lastProgressAt ?? startedAt) + LOCAL_QUIET_MS`.

**Store facts each input is bound to.** Nothing here is new except the three rows marked *new*.

| Fact | Read from |
|---|---|
| `status`, `total`, `decided`, `undispatched`, `lastEventAt`, `lastUploadAt`, `createdAt`, `stop` | `RunStore.view()` (the server snapshot; `stop.emergency` when the stop code is the emergency stop) |
| `checkedAt` | `RunStore.checkedAt()`: the last successful status read, changed or not. This is **the last successful status check**. |
| `readProblem` | `RunStore.readProblem()` (set by the poller on a failed read; cleared by the next success) |
| `liveToggle`, `pausedAt`, `controllersHere` | `RunStore.live()`. *New:* `RunStore.livePausedAt`, moved from `run-header.ts`'s module-level `pausedAt` map, so the light and the header share it. `AppStore.activity()` filtered by `runId`. |
| `undispatchedChangedAt` | `RunStore.undispatchedChangedAt` (as `sendSituation` already uses) |
| `send` | `RunStore.send()`. *New:* the `sending` state's start time (`startedAt`) and the `at` of `rejected` and `handover-failed` are recorded by the SendController. |
| `situation` | `sendSituation(SendFacts)` from `core/ui/upload-status.ts`, with `RunStore.lock()`, `localText()`, `undispatchedChangedAt` and `checkRun()` exactly as today |
| `quiet` | `sortQuiet({ now, status, undispatched, lastEventAt, waits: providerWaits().length })` from `core/ui/upload-status.ts` |
| `waits` | `RunStore.providerWaits()` (`activeProviderWaits` from `provider_cooldown` events) |
| `visible` | `StoreDeps.visibility.visible()` |
| `now` | *New:* `state/clock.ts` `deadlineClock(at: Read<number \| null>)`. It is a `Read<number>` that updates when `runLightDeadline()` (or `localLightDeadline()`) passes, and on the minute clock. It is one `setTimeout`, allowed by SPEC §5.5 rule 7. |
| local `lastProgressAt` | *New:* `DraftStore.lastReadAt: Signal<number \| null>`, written by the ExtractionController when it applies a record; `BuildState.copying.lastCopyAt`, written by the BuildController |

**Deadlines.** `runLightDeadline()` returns the earliest of:
- `checkedAt + leaseMs(visible)`;
- `lastEventAt + SORT_QUIET_MS` while running and not quiet;
- the earliest `waits[].until`;
- `(lastAckAt ?? startedAt) + UPLOAD_QUIET_MS`;
- `(lastUploadAt ?? createdAt) + UPLOAD_QUIET_MS`;
- `(undispatchedChangedAt ?? createdAt) + HANDOVER_QUIET_MS`.

That is why the light changes at the right moment rather than up to a minute late on the minute clock. Evaluating the light creates no motion.

**Tests (`live-light.test.ts`):**
- every row of the order table;
- rows 2–7 win over rows 8–19;
- an unchanged read (only `checkedAt` moves) keeps `live` inside the quiet period and never creates `live` from `waiting`;
- the lease ends at exactly 15 s visible and 45 s hidden, and `liveUntil` equals it;
- `waits` win over `quiet`;
- `closed` with `decided < total` is idle, not done;
- local stopped-by-you is idle, not failed;
- `runLightDeadline` returns the earliest boundary for each rule;
- the `key` is equal for two lights that differ only in times or counts.

### 5.4 Lease and quiet: the honesty rules

- **The pulse needs evidence.** It runs only while `liveUntil` is ahead.
  - Every successful read renews `checkedAt`, and so the lease. The pulse's iteration count is extended without restarting the beat.
  - If reads stop (the tab slept, or a request hangs; `api/client.ts` has no timeout, so a hung read simply never answers), the pulse ends by itself at `liveUntil`.
  - Then, at the deadline, the words become "Not updated since 14:23" and the stage mutes. This is the only timeout, and it withdraws the claim.
- **Why the lease is 15 s.** It is `max(15 s, 3 × interval)`: five visible reads, as measured in the prototype (lease 15 s over 5 s checks).
  - A short network hiccup does not flicker the light.
  - A hidden tab, read every 15 s, keeps a 45 s lease. Returning to it does not flash "Not updated" before the immediate read on `visibilitychange` answers.
- **A read is not progress.** An answer that changes nothing keeps the light live only while `sortQuiet` says the run is not quiet. After that, the light says **Waiting · no new activity for 5 min** and stops pulsing.
- **The quiet period is one number.**
  - The light's Waiting and the existing SPEC §4.8 sentence ("No new activity since 14:22…") both use `SORT_QUIET_MS`. There are never two quiet rules.
  - Its value is owner decision D2. It is an interface setting, not a fitted constant.
  - The code value of 5 min stands until the owner chooses. It changes in one line of `core/ui/upload-status.ts`, together with its test.
- **"Waiting on the AI service" only when the service said so.** The only such fact is an active `providerWaits` entry. The reason then reads "the AI service asked us to wait until 14:40", with no vendor name (DESIGN: model names only in Health and Details). Otherwise the reason is only "no new activity for N min".
- **Relative words while working.**
  - The reason reads "last activity just now" for the first minute after `lastEventAt`.
  - After that it reads "last activity 3 min ago · updated just now". The second part holds while `checkedAt` is under a minute old, and says the page is still in touch.
  - These change on the minute clock and are written in place, with no animation.
  - Clock times appear only where they mark an event: "since 14:23", "at 14:31", "until 14:40".
- **Reads move nothing else.** A read that changes nothing starts 0 animations and changes no visible text. The "Last checked" time is in the Run facts sheet, not on screen.

### 5.5 States

"Pane words" are `state word · reason`. The spine and RunStrip show the state word only. All copy is default English for copy keys in a new group, `copy-light.ts`; it passes the copy lint and contains no jargon.

| Light | Look | Pane words (examples) | Entered on | Motion (§7) | Reduced motion |
|---|---|---|---|---|---|
| **live** | Cyan dot; each beat, the ring leaves to 3× and the halo swells | **Working** · last activity just now / **Handing over** · last activity just now / **Sending** · last received just now (· from another tab / from another browser) / **Reading** · on this computer / **Looking for files** · on this computer / **Making folders** · on this computer | Rows 13–16 and 19; local working within `LOCAL_QUIET_MS` | P1 pulse, 1600 ms per beat, bounded by `liveUntil` | No ring. The dot with its resting halo and the word. |
| **waiting** | Cyan dot, steady brighter halo (.9), **still outer ring** at `--hold-a` | **Waiting** · no new activity for 5 min / · the AI service asked us to wait until 14:40 / · for the service to confirm the last document / · for the other tab to send the next document / · for the first document to arrive / · the run is being closed / · still reading one file | Rows 10, 13–15, 17, 18; local quiet | P2: the ring finishes its beat; the halo rises (900 ms); the still ring settles (700 ms from .6×); then nothing moves | The same dot, halo and still ring. It differs from live in form, not only in motion. |
| **stale** | Hollow `--ink-3` ring, no glow; **stage muted** (§6.6) | **Not updated since 14:23** · the run may still be working. Now line: "The numbers below may be out of date." | Row 12, the lease deadline | The pulse has already ended; the words resolve in (T4) | The words; no animation |
| **paused** | Hollow `--ink-3` ring; stage muted | **Updates paused** · sorting carries on without them | Row 11: the person turned Live updates off (WCAG 2.2.2) | The pulse stops at once | Same |
| **failed** | Red dot and halo; stage muted; red head | See §6.4 | Rows 2–7; local `failed` | P3: one red beat (900 ms), never repeated; red trace; failure text T5 | The red dot, node, head, rule and top edge, all at once |
| **done** | Hollow cyan ring | **Sorted** · at 14:31 / **All read** · at 13:53 / **Folders made** · at 15:10 | Row 8; local done | None | Same |
| **idle** | Hollow `--ink-3` ring; the word in `--ink-2` | **Checking…** / **Sorting** · starts once all 114 are sent · nothing charged yet / **Discarded** · at 14:31 / **Stopped** · after file 38, as you asked | Rows 1 and 9; the Sort strip while sending; local stopped | None | Same |

**The muted stage** applies to stale, paused and failed. Nothing below the light still claims live activity:
- the giant count turns `--ink-2`;
- the leading edge becomes a plain `--ink-3` mark with no glow. It is red when failed.
- the being-read fill rests at `color-mix(in srgb, var(--ink-3) 26%, transparent)`;
- there is no flare.

### 5.6 The pulse engine (`ui/app/view/motion.ts`)

```ts
export interface PulseTarget { el: HTMLElement; kind: 'ring' | 'node' | 'halo' | 'segment' }
export const Pulse: {
  /** The light is live until `liveUntil` (epoch ms). It extends running pulses (updateTiming) and never restarts the beat. */
  confirm(liveUntil: number): void;
  /** Registers or unregisters a visible target. Targets join the shared beat at its phase. */
  attach(target: PulseTarget): Dispose;
  /** Leaving live: a light that goes to waiting finishes the beat it is in; anything else stops at once. */
  settle(toWaiting: boolean): void;
  /** One red beat on every visible failed light and on the failed node. */
  beat(): void;
  stop(): void;
};
```

- **One shared start.** All targets use one `startTime` (`beat0 = document.timeline.currentTime` when the lease begins). The spine light, the pane light, the node and the compact segment therefore beat together. The prototype checked this: same `startTime`.
- **Finite iterations.** `iterations = ceil((liveUntil − beat0) / --dur-pulse)`, and each `confirm` raises it through `effect.updateTiming`. There are never infinite iterations. One `setTimeout` at `liveUntil + 40 ms` clears `beat0`. It is allowed in `view/motion.ts` by SPEC §5.5 rule 7.
- **Frames** (1600 ms, `fill: 'none'`, `composite: 'replace'`). The first two segments of the ring frames use `--ease-beat`.

  | Target | Frames |
  |---|---|
  | ring (`.ind__ring`) | `{scale(1), 0}` → `{scale(1), 1}` at .04 → `{scale(3), 0}` at .72 → `{scale(3), 0}` |
  | node (`.node__pulse`) | the same, to `scale(1.9)` |
  | halo | opacity .45 → 1 at .14 → .45 at .75 → .45 |
  | segment glow | opacity 0 → 1 at .14 → 0 at .75 → 0 |

- **Red beat** (`.ind__beat`, `.node__beat`): `{scale(1), .95}` → `{scale(3.2), 0}` (1.9 on the node), 900 ms, `--ease-beat`, once per failure event.
- **No pulse** under reduced motion, when the tab is hidden (the browser does not run it anyway), or when `--dur-pulse` resolves to 0 ms.
- **Wiring.** An `effect` over the subject's `Light` calls `Pulse.confirm(light.liveUntil)` for `live`, `Pulse.settle(true)` for `waiting`, and `Pulse.stop()` otherwise. It calls `Pulse.beat()` when the light enters `failed`, and on each `SignatureEvent` `outcome: 'failed'` (§6.5).

### 5.7 Accessibility

- **Announcements.** The light's words are not a live region. A change of `Light.kind` is announced through `a11y.announce` (polite):
  - at once when it enters `failed` or `done`;
  - otherwise at most once every 2.5 s per run.
  - A reason-only change (a new time) is never announced.
- **WCAG 2.2.2.** The pulse is the one moving thing that can last more than 5 s. **Live updates** stops it (the paused state), and so does the OS reduced-motion setting. The pulse is 0.625 Hz and small, far below the WCAG 2.3.1 flash threshold.
- **Journey steps.** A failed step's visually hidden text uses the light's words ("Sort, can't reach the service"). The node itself stays `aria-hidden`.

---

## 6. Red on failure

### 6.1 The rule it amends (proposed wording; the owner approves; not applied)

**DESIGN.md §11, UX principles.** Replace "outcome colours fixed and never reused (filed / review / could-not-process)" with:

> Outcome colours are fixed: green means filed and amber means needs review, and neither is used for anything else. Red means that something failed, everywhere in the interface: a request that failed, a document that could not be read or processed, a run that stopped, or sending that stopped and needs the person. "Could not process" is a failure, so it is red. Red is never used for anything else. Waiting is never red or amber. No colour is ever the only signal.

**SPEC §0.1 rule 5.** Replace the rule with:

> *Colours are fixed.* `--filed` and `--review` (and their `-soft` and `-bar` forms) appear only on outcome pills, tallies, meters, the outcome segments of the sorting bar, and the outcome filter. The red family (`--failed`, `--failed-soft`, `--failed-bar`, `--fail-line`, `--fail-glow`) means failure: the "Could not process" outcome, and every failure listed in VISUAL-SPEC-v2 §6.2. Nothing else uses red: not waiting, quiet, paused, not updated, blocked reasons, input corrections or readiness.

**SPEC §8.3.**
- "Action errors use the neutral notice (VL R-4)" becomes "Action errors use the problem notice with the red rule and glyph (§6.3)".
- "A stalled or stopped run is never amber. A complete run is never green" is kept.
- Add: "A quiet or waiting run is cyan and still, never red."

**SPEC §8.4 M9.** Stall freeze is split:
- `*-stalled` and `halted` get the failure treatment;
- `sortQuiet` gives the waiting light;
- in both cases the bar stops moving.

### 6.2 What is a failure

| Failure (store fact) | Red elements | Where the explanation and action sit |
|---|---|---|
| A status read failed (`readProblem`) | Light, spine light, current node, sorting head, message rule | Beneath the working pane's light; **Try again** |
| Sending stopped: this browser can continue (`upload-stalled`, `canContinueHere`) | Light, Send node, send bar head, rule | Beneath the Send pane's light; **Continue sending** |
| Sending stopped: continue elsewhere (`upload-stalled`, `!canContinueHere`) | Same | The message only; no action here |
| Hand-over stopped (`handover-stalled`, `handover-failed`) | Same | **Continue sending** (hand-over only; needs no local text) |
| A send request failed (`send.kind === 'dropped'`) | Same | **Continue sending** |
| A document was refused (`rejected`) | Same | **Discard this run…** (ConfirmSheet) |
| Mode mismatch (`mode-mismatch`) | Same | **Discard this run…** |
| The run stopped (`halted`, including by the emergency stop) | Light, the node of the step it stopped at, head, rule; the StopCard | StopCard beneath the light. The parked continuation appears only when `recoveryAvailable` (AGENTS §6.5; it lives on the run). |
| Reading stopped: folder access lost or the scan failed (`ScanState.failed`) | Read pane light, Read node, read bar head, rule | **Choose the folder again** |
| Files that could not be read (`DraftStore.counts.failed ≥ 1`) | The count words, in `--failed` with the slash glyph, from the first. At 0 they are neutral. | Files foot, Just read list, Confirm summary. No action needed. |
| A document could not be processed (`SignatureEvent` `outcome: 'failed'`) | A red *moment*: one red beat, a red 24 px flare, the notice rule. The tally is red from the first. | The notice replaces the pane's last line. No action needed. |
| Making folders failed (`BuildState.failed`) | Build pane light, Build node, head, rule | The Build action's slot, with the specific next step |
| Any ActionBlock `problem` (a request or operation the person started failed) | The problem notice's 2 px rule and glyph | Its own feedback slot, beneath its button (SPEC §5.3; REG 11) |

**Not a failure. These stay neutral or cyan:**
- blocked reasons ("Why this is unavailable:");
- an invalid amount in the MoneyField (ink, bold; it is a correction, not a failure);
- sort quiet;
- a provider pause;
- not updated;
- updates paused;
- Stop after this file (the person's choice);
- a discarded run;
- the non-failure `attention` rules: a folder choice needed, the source changed, no files, duplicates;
- an unconfirmed start (`intent-pending`: "We couldn't confirm whether this run was created" is *unknown*, not failed);
- the emergency stop's own state line on System.

`journey()` gains `failure: boolean` on the current step. It is true for J5 `scanFailed`, J11, the failing J12 and J13 rows, and J15. The rail draws red only when it is true. Other `attention` steps keep the ink "!" ring.

### 6.3 Anatomy: four red things, then the cause and one action

| Element | Normal | Failed |
|---|---|---|
| The light (pane and spine) | Cyan, pulsing or steady | `--fail-line` dot, `--fail-glow` halo; the state word in `--failed` |
| The affected journey step | Current: 2 px `--light` ring, 5 px `--accent-soft` halo, `--trail` centre | 2 px `--fail-line` ring; "!" (12 px, 700) in `--failed`; halo `0 0 0 5px var(--failed-soft), 0 0 16px var(--fail-glow)`. The label stays ink, 600. At ≤900: the red segment. |
| The leading edge of the bar | Hot `--trail` head | Reading or sending: the work so far becomes a still, dashed `--ink-3` segment (7 px dash, 4 px gap), and **only the head** is `--fail-line` (`0 0 8px 1px var(--fail-glow)`). Sorting: the head is red; the stage is muted; the outcome segments keep their colours. |
| The message accent | — | A 2 px `--fail-line` rule on the left (radius 2, `0 0 8px var(--fail-glow)`), a 16 px alert glyph in `--failed`, and text in **ink** (15/1.5, max 84 ch). Then the action row: the **cyan primary** plus one line of consequence (14, `--ink-2`, max 52 ch). |
| The pane | Resting 1 px top-edge light in `--edge-lit` | The top edge in `--fail-edge-lit` (opacity .9), plus one red edge trace on the event |

**Placement.**
- The failure block is the first thing beneath the pane's status row (18 px). On working views it is the `ActionSlot` holding the journey's primary, so the one action sits directly beneath the explanation.
- When the run finishes, **See the results** takes the same position.
- The heading names the job and does not change on a failure; the light names the state.
- "More about this stop" (a Disclosure) holds the longer explanation and **Discard this run…**.
- Next in the Now line appears only if the action is out of sight with the page at the top. At 1440 × 900 and at 390 px it was on screen in the prototype, so Next was hidden.

**No red buttons. Red never pulses.**

### 6.4 What each failure says (each thing said once)

These are default copy values for copy keys, written in plain language. Numbers appear only in the message, never in the Now line.

| Failure | Light (state · reason) | Now line (the consequence) | Message (cause and what is kept) | Action · consequence |
|---|---|---|---|---|
| Can't reach the service | **Can't reach the service** · since 14:23 | The numbers below may be out of date. | This page lost its connection to the service. The run itself may still be sorting; nothing is lost. | **Try again** · The page also tries again at 14:02:26. |
| Sending stopped (can continue) | **Sending stopped** · since 14:02, 41 min ago | Sorting can't start until every document is sent. | The tab that was sending was closed or went to sleep. This browser kept the text of the other 101 documents; you don't need the original folder. | **Continue sending** · This continues Run 9. It doesn't start a new run or change your spending limit. |
| Sending stopped (elsewhere) | **Sending stopped** · since 14:02 | Sorting can't start until every document is sent. | This run was sent from another browser. Open it there to continue sending. | — |
| Hand-over stopped | **Hand-over stopped** · since 14:03 | Sorting can't start for 12 documents until they are handed over. | Every document arrived, but 12 were not handed over for sorting. | **Continue sending** · This hands over the rest. Nothing is sent again. |
| A document was refused | **A document was refused** · at 14:02 | This run can't continue from this browser. | 'Week 3 slides' differs from what you confirmed, so it was not accepted. | **Discard this run…** · You can then start a new run. |
| Can't send from here | **Can't send from here** · since 13:58 | Nothing will be sent from this browser. | This run was recorded as Batch, but you chose Interactive. | **Discard this run…** |
| The run stopped | **Stopped** · at 14:20 (by the emergency stop at 14:20) | Documents already decided keep their outcomes. | The StopCard's headline, verbatim from the server, mapped by `error-copy.ts`. | The parked continuation only when `recoveryAvailable` |
| Reading stopped | **Reading stopped** · at 13:52 | Reading can't go on until this browser can see the folder again. | This browser lost permission to view 'Archive 2026'. The 38 files already read are kept. | **Choose the folder again** · Reading picks up at file 39. Nothing has been sent. |
| Making folders stopped | **Making folders stopped** · at 15:02 | The folders made so far are kept. | The specific cause from `error-copy.ts` | The specific next step |

### 6.5 A document that could not be processed: a red moment on a light that stays live

- **One red beat** on the pane light, the spine light and the current node. The light itself stays live and cyan.
- **The bar.** Its 24 px flare at the decided edge is the red one (`radial-gradient(closest-side, var(--fail-line), transparent)`), clipped inside the bar.
- **The notice.** It replaces the pane's last line: "'Fax copy' could not be processed: it is a scanned image with no text. The others carry on." Its 2 px rule draws down with the line (T5).
  - It stays until the next such document, or until sorting ends.
  - The lasting record is the red "Could not process" tally, plus the activity line and the Results row.
- **Nothing else moves.** Nothing above or beside the notice's line moves (the prototype's check `layoutStillOnDocumentFailure`). The event creates 13 animations, against 8 for an ordinary document.

### 6.6 The muted stage (stale, paused, failed)

See §5.5. In the failed state the head is the red leading edge, so **red is the only thing on the stage that still reads as live**.

### 6.7 Keeping the three outcome colours distinct

"Could not process" is a failure, so it shares the red family. The weak pair is needs-review amber next to that red, most of all in the light theme and for colour-blind readers.

- **Proposal (D1 = B, "red only").** In the light theme only, the "Could not process" fill (`--failed-bar`) becomes `#B3261E`, the red family's own text red. Needs review keeps its amber, `#B07A10`, and the dark theme is unchanged.

  | Measure | Light, Current | Light, **Proposed B** | Dark (Current = B) |
  |---|---|---|---|
  | Needs review vs could not process: fill contrast | 1.25:1 | **1.75:1** | 1.81:1 |
  | Same pair, colour difference (ΔE), normal vision | 47.8 | 48.2 | 59.5 |
  | Same pair, deuteranopia | 12.8 | **18.3** | 16.0 |
  | Same pair, protanopia | 31.4 | 35.6 | 33.0 |
  | Filed vs needs review, normal / deuteranopia | 65.5 / 36.4 | 65.5 / 36.4 | 55.2 / 34.3 |
  | Could-not-process fill on the stage pane / on the track | 4.53 / 3.92 | 6.35 / 5.49 | 5.11 / 3.92 |

  Proposed A (light amber `#A38600`) reads olive and moves needs review towards filed green (65.5 → 57.1). It is not recommended.

  If the owner wants more separation in dark (deuteranopia 16.0 is the weakest point left), A's dark yellow `#F5D250` can be taken on its own.
- **The colours are never the only signal.**
  - Every outcome carries its word and glyph: check (filed), person (needs review), slash (could not process).
  - The bar's segments are separated by a 2 px cut in `--raised`. It measures 9.03 / 9.24 / 5.11 in dark and 3.81 / 3.62 / 4.53 in light, and at 390 px it is still 2.00 px wide and visible.
  - The bar's `role="img"` label reads the whole sentence: "Of 114: 73 decided (52 filed, 20 need review, 1 could not be processed), 19 being read, 22 waiting their turn".
- **Only red moves.** Green and amber never glow, pulse or beat. A filed or needs-review outcome moves only its own segment, its boundary and the head (§7.6).
- **Zero is neutral.** The "Could not process" tally is neutral at 0 (word `--ink-2`, bar `--ink-3`) and red from its first document. The rule is the same for "could not be read".

---

## 7. Motion

### 7.1 Rules

1. **Only `transform`, `opacity` and `filter` animate.**
   - `filter` (blur 4 px → 0) is used only on the stage heading's words when a screen opens.
   - No CSS transition names `color`, `background-color`, `border-color`, `box-shadow`, `width`, `height`, `top` or `left`. Hover and state colours change at once.
   - Existing `base.css` and component transitions on colours are removed (§8).
2. **Every motion starts from an event.** The events are a route change, a merge that produced a `SignatureEvent`, a local controller's progress or failure, the Light's key changing, or the person's click or key.
   - Entrance motion never replays on remount or reload (SPEC M2's honesty rule).
   - The first facts for a subject apply with transitions off (the `rail--instant` pattern in `journey-rail.ts`, applied to every bar, count and light).
3. **The only repeating motion is the pulse.** Its iterations are finite and end with the lease. There is no `requestAnimationFrame` loop, no canvas and no `infinite` anywhere.
4. **Content never waits on `transitionend` or `animationend`.** Elements default to their final state, and only the motion-allowed path starts them from an offset. Final states are written through classes or CSS custom properties (`style.setProperty('--…')`), never `.style.<prop> =` (SPEC §5.5 rule 2).
5. **A new value mid-animation starts from what is on screen.** Bars use transitions on `transform`, which retarget from the current value. The digit roll is cancelled, and a new roll starts from the last true value.

### 7.2 Motion tokens (all in `:root`; all become 0 ms under reduced motion)

| Token | Value | Use |
|---|---|---|
| `--dur-press` | 90ms | Button press: `translateY(1px) scale(.99)` |
| `--dur-hover` | 160ms | Transform-only hover effects: chevron rotate, primary halo opacity |
| `--dur-reveal` | 300ms (was 240) | Text: open |
| `--dur-word` | 320ms | Text: heading word |
| `--dur-change` | 260ms | Text: meaning changed |
| `--dur-fail` | 180ms | Text: failure; the fastest text on the page |
| `--dur-rule` | 220ms | Failure rule draws down |
| `--dur-list` | 300ms | List line |
| `--dur-roll` | 280ms | Digit roll |
| `--dur-exit` / `--dur-exit-launch` | 90ms (was 140) / 140ms | Screen leave / leave on Start run |
| `--dur-pane` | 420ms | Pane rise on screen open |
| `--dur-move` | 320ms | Layout glide and surface growth |
| `--dur-fill` | 760ms (was 600) | Bars |
| `--dur-flash` | 900ms (was 800) | Bar flare; Confirm summary row flash (opacity) |
| `--dur-trace` / `--dur-trace-open` | 900ms / 720ms | Edge trace on an event / on screen open |
| `--dur-pulse` | 1600ms | One beat |
| `--dur-beat` | 900ms | Red beat |
| `--dur-settle` / `--dur-hold` | 900ms / 700ms | Waiting: halo rises / still ring settles |
| `--dur-power` | 620ms | A bar draws itself (first time shown in a session) |
| `--dur-tick` | 200ms | Checkbox tick |
| `--dur-spine` | 560ms | Spine column enters (Home ↔ a run) |
| `--dur-ignite` | 760ms | Start run ignite ring |
| `--dur-show` / `--dur-tab` | 420ms / 520ms | Show-control capsule / tab indicator |
| `--dur-ambient` | 2400ms | Home's single ambient sweep |
| `--dur-sweep` | 1200ms | M11 slot sweep (×4, ≤ 4.8 s) |
| `--stagger` | 45ms (was 40) | Panes |
| `--stagger-word` / `-head` / `-digit` / `-row` | 20 / 24 / 24 / 30ms | Heading words (at most 7 steps) / header items / digits (the right-hand digit leads) / new rows |
| `--ease-out` | `cubic-bezier(.2, .8, .2, 1)` | Text (the prototype's `text`) |
| `--ease-glide` | `cubic-bezier(.16, 1, .3, 1)` | Glides, rules, surface, tick, hold ring |
| `--ease-roll` | `cubic-bezier(.3, .7, .1, 1)` | Digits |
| `--ease-fill` | `cubic-bezier(.22, 1, .36, 1)` | Bars |
| `--ease-trace` | `cubic-bezier(.45, .05, .2, 1)` | Edge trace |
| `--ease-leave` | `cubic-bezier(.2, .6, .4, 1)` | The outgoing screen |
| `--ease-inout` | `cubic-bezier(.65, 0, .35, 1)` (was `.45, 0, .25, 1`) | Spine advance, power-up, waiting halo, capsule, tab bar, ambient |
| `--ease-beat` | `cubic-bezier(.2, .6, .3, 1)` | Pulse and red beat rings |
| `--ease-in`, `--ease-linear` | unchanged | — |

### 7.3 Catalogue

Each motion starts on the event in its "Trigger" column. "RM" is the final state under reduced motion.

| # | Motion | Element | Trigger (store fact) | Frames · duration · easing · delay | RM final state | vs SPEC §8.4 |
|---|---|---|---|---|---|---|
| T1 | Heading words | Stage `h1` split into `.w` spans | A user route change to a new shape (StageHost) | opacity 0, `translateY(10px)`, `blur(4px)` → 1, 0, 0 · `--dur-word` · `--ease-out` · +20 ms, then `--stagger-word` per word, at most 7 steps | Text present, opaque, sharp; focus on the h1 | New (replaces M3's content fade) |
| T2 | Header text | Overline, NOW, sentence, Next, facts, Live updates | Same | opacity 0, `translateY(8px)` → 1, 0 · `--dur-reveal` · `--ease-out` · overline +0, the rest +90 then `--stagger-head` | Present | New |
| T3 | Pane rise | Each `[data-enter]` pane, at most 8 | Same | opacity 0, `translate3d(12px × dir, 10px, 0)` → none · `--dur-pane` · `--ease-out` · +150 + i × `--stagger`. The first two text lines inside it (status row, count, pane heading) follow with T2 at +60 and +90. | Present | Replaces M3's `translateX(16px)` |
| T4 | Meaning changed | A Now sentence, a light's state word and reason, a heading's changed words | `narration.now.key` changed; `Light.key` changed; the heading's phrase key changed (only the changed words move) | opacity 0, `translateY(4px)` → 1, 0 · `--dur-change` · `--ease-out` · the reason 50 ms after the state word | Written at once | New |
| T5 | Failure text | Failure block: rule (`::before`), message, action; or a one-document notice | The Light entered `failed`; a `failed` outcome event (notice) | Rule `scaleY(0)`, opacity .4 → `scaleY(1)`, 1 · `--dur-rule` · `--ease-glide` · 0 ms. Message: opacity 0, `translateY(3px)` → 1, 0 · `--dur-fail` · 0 ms. Action: the same at +60 ms. A notice is one line. | All present at once | New |
| T6 | List line | ActivityList, Just read | A new event id in `recent`; a file result | The list: `translateY(−row)` → 0 inside a still clip (`overflow: hidden`) · `--dur-list` · `--ease-glide`. New rows: opacity 0 → 1 · `--dur-list` · + i × `--stagger-row`. A row falling off the bottom goes at once. | Final list | Replaces M13 |
| N1 | Digit roll | `Count`: giant count, tallies, spend, send and read counts | The value changed after its first value, in the same mount and subject (a `SignatureEvent` `count`, an outcome, or a local count) | Only changed digits (§7.5) · `--dur-roll` · `--ease-roll` · right-hand digit first, `--stagger-digit` | The new number at once | Replaces "numbers jump" and M6's flash on counts |
| B1 | Bar | `LightBar` (read, send, build) and `SortBar` | The count behind it changed after its first value | `transform` transitions on the one segment that grew, its boundary wrapper, and the head · `--dur-fill` · `--ease-fill` (§7.6) | Final geometry at once | Replaces M4 and M5 (no Decided sweep) |
| B2 | Flare | 24 px glow at the head, clipped inside the bar | Same event (red for a `failed` outcome) | opacity 0 → .9 at .3 → 0 · `--dur-flash` · ease-out · `fill: none` | None | Replaces M5's sweep |
| B3 | Power-up | Rail, drawing tip, ticks, head | A bar shown **for the first time in this session** (a WeakSet per bar key) | Rail `scaleX(0)`, 0 → 1, 1 · `--dur-power` · `--ease-inout`. Tip `translateX(0 → 100%)` with opacity 0 → 1 → 0. Ticks opacity 0 → 1 (360 ms, +300). Head `scaleY(.2)`, 0 → none, 1 (320 ms, +420). | Drawn | New |
| P1 | Pulse | Light rings, halos, node ring, compact segment | Light `live`; renewed by every successful read | §5.6 · `--dur-pulse` · shared `startTime` | No ring; resting halo | New (SPEC said "no pulse"; amended) |
| P2 | Waiting settle | Halo, hold ring | Light `live` → `waiting` | Halo opacity .55 → .9 · `--dur-settle` · `--ease-inout`. Hold ring opacity 0, `scale(.6)` → `--hold-a`, 1 · `--dur-hold` · `--ease-glide` · delay = what is left of the current beat's ring (at most 900 ms). | Still ring and bright halo at once | Replaces M10's stripes |
| P3 | Red beat | `.ind__beat`, `.node__beat` | Light enters `failed`; a `failed` outcome | §5.6 · `--dur-beat` · once | None (the red is present) | New |
| L1 | Layout glide | Content below a failure block or finished action (`[data-flip]`) | A block appears or goes | FLIP: `translateY(Δ)` → none · `--dur-move` · `--ease-glide`. Each element moves by its own distance, less its parent's. | New place at once | New |
| L2 | Surface growth | The pane's `::after` surface layer (`.surf`) | Same | `scaleY(old/new)` → none, from the top · `--dur-move` · `--ease-glide` (`pseudoElement: '::after'`). A trace running at the same time copies it. | New edge at once | New |
| E1 | Edge trace | `.trace` ring inside a pane (§7.7) | Screen open: only the pane holding the screen's one action, once. A failure: the pane holding it (red). Recovery: the same pane (cyan). | Band `translateX(−100% → 295%)`, opacity 0 → 1 at .12 → 1 at .78 → 0 · `--dur-trace-open` (screen open, +80 after its pane) or `--dur-trace` · `--ease-trace` | None | New |
| R1 | Spine advance | Spine fill, head, arriving node, compact segment | M2's rule: a step that was `current` becomes `done` in this session (never on first render, reload or a subject change) | Fill `scaleY(p0 → p1)` · min(1100, 520 + 2.2 × distance px) ms · `--ease-inout`. The head travels with it (opacity 0 → 1 → 0). The node: `scale(.55)`, .4 → none, 1, 520 ms, arriving 160 ms before the fill ends. The segment: opacity .2, `scaleX(.3)` → 1, 600 ms. | Final state | M2 kept; vertical form |
| S1 | Screen leave | The outgoing view | A user route change | opacity 1 → 0, `translate3d(−20px × dir, 0, 0) scale(.995)` (`.97` on launch) · `--dur-exit` (`--dur-exit-launch` on launch) · `--ease-leave`. It is gone by 90 ms, so two screens never read on top of each other. Removed by a timer (`stageTransition().leave`). | Instant swap | Replaces M3's out |
| S2 | Spine enters | The spine column | Home → a run view, or back | opacity 0, `translateX(−20px)` → 1, none · `--dur-spine` · `--ease-out` · +120 | Present | New |
| M1 | Launch | The Start run button | `POST /api/runs` answered and `checkRun` ok (unchanged trigger) | Ignite ring: opacity 0 → .9 at .15 → 0, `scale(1)` → `scale(1.02)` → `scale(1.28, 1.6)` · `--dur-ignite` · ease-out. Then S1 with the launch values. | Instant | Motion changed |
| M8 | Show capsule, tab bar | ShowControl, TopBar tabs | The person changes the filter; a route change changes the tab | `translate(x, y) scaleX(old/new)` → `translate(x', y')` · `--dur-show` / `--dur-tab` · `--ease-inout`. The width is set at rest, instantly. | Jumps | Kept; the capsule replaces the underline |
| M11 | Short local work | The feedback slot sweep | A person-started operation with no count | Unchanged: `translateX`, `--dur-sweep` × 4, then still | Still segment | Kept |
| M12 | Tick | A checkbox glyph | The person ticks | `scale(.6)`, 0 → none, 1 · `--dur-tick` · `--ease-glide` | Instant | Was a stroke draw (not transform or opacity) |
| M14 | Success turns the button | ActionSlot | `done` with `handoff` | The new button: opacity 0, `translateY(8px) scale(.97)` → none · 560 ms · `--ease-glide`, then M1's ignite at +260 | Instant | Motion changed |
| M15 | Sheet | ConfirmSheet | Open or close | Unchanged: `@starting-style` opacity and `translateY(8px)` · `--dur-reveal` | Instant | Kept |
| M6′ | Changed row | The Confirm summary row | The mode or limit the person set changed | `::after` overlay in `--accent-soft`: opacity 1 → 0 · `--dur-flash` | None | Was a `background-color` animation |
| H1 | Home | Loop stations, trail, run cards, callouts, one ambient sweep | Home opens (a route change) | Stations opacity (360 ms, 40 ms apart); trail opacity (700 ms); runs (420 ms, 100 ms apart); callouts rise 10 px (480 ms); **one** sweep of a 260 × 1.5 px line along a lattice line, `translateX`, `--dur-ambient`, `--ease-inout`. The sweep is skipped below 980 px. | Static | New; never loops |
| — | Removed | `sweepOnce()` (M5), `flash()` on `background-color` (M6), `enterOnce` on pills is kept (M7, opacity) | — | — | — | — |

### 7.4 The screen-open timeline (measured in the prototype: Home → Read)

- **0–90 ms:** S1. The old screen is at opacity 0 by 90 ms (140 ms on Start run).
- **60 ms:** T2 overline (120 ms on launch).
- **80 ms:** T1 heading words. At 240 ms the six words stood at opacity 0.95 / 0.92 / 0.89 / 0.84 / 0.77 / 0.66.
- **150–246 ms:** T2 NOW, sentence, Next, facts, Live updates.
- **150 ms + 45 ms per pane:** T3 panes. Each pane's first lines follow 60 ms later.
- **About 230 ms:** E1 on the pane holding the screen's one action (720 ms). No other pane is traced; a screen with no action gets none.
- **Header settled by 500 ms. Everything settled by 950 ms.** No body text is blurred: 0 filter animations outside the heading.

### 7.5 Digit roll (the `Count` component)

1. **Compare.** Compare old and new values right-aligned. Unchanged digits stay plain text.
2. **The box.** Each changed digit becomes a `.dg` box. Inside it:
   - an invisible placeholder `.dg__ph` holds both digits in one grid cell, so the box is as wide as the wider of the two (all ten digits are 44.2 px at 95 px with tabular figures, measured);
   - a window `.dg__m` holds a column `.dg__col` of the old digit and the new one.
3. **The window.**
   - It is the **numeral band**, from cap height to baseline, measured once per font from the font in use (canvas `measureText`, the actual ascent and descent), and cached.
   - It is clipped 12% of the band beyond each edge, with a static, steep fade inside that margin (under 50% for its outer three quarters).
   - It is set through custom properties: `--band-top`, `--band-bottom`, `--band-fade`. `clip-path: inset(var(--band-top) 0 var(--band-bottom) 0)` and the mask gradient read them. No inline style is written.
   - The fade sits just outside the band, not inside it. Inside, the top bar of a 7 or the base of a 2 would be dimmed through the roll, then jump to full strength when it ends. D4 can set the fade to 0.
4. **The roll.**
   - The column moves by exactly one line: up when counting up, down when counting down. `--dur-roll`, `--ease-roll`, no blur, no opacity change.
   - With several changed digits, the right-hand one leads, by `--stagger-digit` each.
5. **After the roll.** A visually hidden copy of the new value sits beside the rolling parts, which are `aria-hidden`. When the roll ends, the count is plain text again, in the same place (top and height within 0.5 px, measured).
6. **The number never counts up.** The true value is in the DOM from the first frame, and there are no intermediate values.

### 7.6 Bars (how one document stays cheap)

**SortBar** (`components/sort-bar.ts`; SPEC's PipelineTrack):

```
.pipe (overflow: hidden; 16 px; --track; inset 1 px --line)      vars: --f --r --x --rd (fractions 0…1)
  .seg--filed   transform: scaleX(var(--f))
  .pipe__w      transform: translateX(calc(var(--f) * 100%))        ← boundary 1 carries everything after it
    .seg--review  scaleX(var(--r))
    .pipe__w      translateX(calc(var(--r) * 100%))
      .seg--failed  scaleX(var(--x))
      .pipe__w      translateX(calc(var(--x) * 100%))
        .seg--reading scaleX(var(--rd))                               (--reading-fill; rests when muted)
        .pipe__w translateX(calc(var(--rd) * 100%)) > .cut
        .cut · .pipe__flare · .pipe__flare--fail
      .cut
    .cut
.pipe__headwrap translateX(calc((var(--f) + var(--r) + var(--x)) * 100%)) > .pipe__head (4 × 32, --trail)
```

- **What moves.** Each segment, wrapper and head has `transition: transform var(--dur-fill) var(--ease-fill)`.
  - One filed document changes `--f` only, so three transitions run: the segment, wrapper 1 and the head. A 24 px flare (B2) rides inside the last wrapper and is clipped by the bar.
  - Cuts are 2 px in `--raised`. A cut is hidden (opacity 0) where its boundary is at 0 or 1.
- **The head's resting glow** is `0 0 8px 1px var(--light-glow), 0 0 14px 2px var(--light-glow-soft)`. It is tight, so it never tints the outcome colour beside it.
  - Done: the head is `--light`, with no outer glow.
  - Muted: the head is `--ink-3`, with no glow.
  - Failed: the head is `--fail-line` (§6.3).
- **The legend** (13 px) names the colours and carries **Being read 19** and **Waiting its turn 22**, written in place. There is no station row. The outcomes have their tallies.

**LightBar** (`components/track.ts`, rebuilt):
- a 6 px rail;
- a fill (`scaleX(var(--fill))`) in a `--light` gradient;
- a head wrapper (`translateX`) with the 4 × 20 head and its flare;
- ticks: a static dim row of 1 px lines, with a lit copy revealed by a mask that moves by `translateX`, counter-moved inside;
- a still dashed segment (`--ink-3`) that replaces the fill when failed.

One document runs 5 transitions: fill, head, mask, counter-move and flare.

**Budget** (asserted by Playwright, as in `motionPerDocument`):

| Event | Animations measured in the prototype |
|---|---|
| +1 decided | 8 |
| +1 decided with a carry (79 → 80) | 9 |
| A failed document | 13 |
| +1 sent | 8 |
| +1 file read | 8 |
| A status read with no change | 0 |

The limit is 12 per ordinary document, and 0 for a read with no change. The already-running pulse animations are not restarted and are not counted.

### 7.7 Edge trace and surface

```css
.trace { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; pointer-events: none; padding: 1.5px; transform-origin: top;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
          mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
.trace > i { position: absolute; inset: 0 auto 0 0; width: 34%; opacity: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, var(--trace-band) 72%, var(--trail) 90%, transparent); }
.trace.is-fail > i { background: linear-gradient(90deg, transparent, var(--fail-trace-band) 72%, var(--fail-line) 90%, transparent); }
.surf { background: transparent; border-color: transparent; box-shadow: none; isolation: isolate; }
.surf::after { content: ""; position: absolute; inset: -1px; z-index: -1; border-radius: inherit; pointer-events: none; transform-origin: top;
  background-color: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-1), var(--inner-highlight); }
```

- The trace element is created once per pane and reused. One band moves behind a static 1.5 px ring mask.
- The three working panes (Read, Send, Sort) are `.surf`. On a stage pane, the surface uses `--raised` with the `--sheen` gradient.

### 7.8 Budgets

| Measure | Limit |
|---|---|
| Animations per +1 decided / sent / read | ≤ 12 (8 measured) |
| Animations per read with no change | 0 |
| Traced panes per screen open | ≤ 1 |
| Screen open | Header settled ≤ 500 ms; all ≤ 950 ms |
| Failure: text readable | Rule and message by 180–220 ms; action at 240 ms |
| Looping animations | 0 (the pulse is finite) |
| `requestAnimationFrame` loops, canvases | 0 |

### 7.9 Reduced motion

- **Triggers.** It is triggered by `prefers-reduced-motion: reduce`, at load or mid-session. `view/motion.ts` `reducedMotion` already listens for changes.
- **`styles/motion.css`.** Its reduced-motion block sets every `--dur-*` and `--stagger*` token (the full §7.2 list) to 0 ms, and `animation` and `transition` to `none !important`.
- **`view/motion.ts`.** Every helper is a no-op except for setting the final state.
- **Switching on mid-session.** It calls `Pulse.stop()` and finishes every animation in flight (`document.getAnimations().forEach(a => a.finish())`).
- **End states are identical.** They are asserted by Playwright (`reducedMotion`, `reducedMotionMidSession`): the same counts, sentences, lights and layout, and `document.getAnimations().length === 0` after +1, +10, a stall, a recovery and a failure.

| Motion | Reduced-motion final state |
|---|---|
| Text reveal, heading words | Present at once, opaque, sharp; focus on the heading |
| Digit roll | The new number at once |
| Layout glide, list glide, surface growth | Content and the pane's edge in their new place at once |
| Pulse | No ring. The cyan dot with its resting halo, and the word. |
| Waiting | The same dot, the brighter halo and the still outer ring, and the word Waiting |
| Red beat, red trace, red flare | Absent. The red dot, node, leading edge, rule and top edge are present at once. |
| Lease end | Unchanged: the words switch to "Not updated since …" and the stage mutes (a state, not a motion) |
| Screen change | Instant swap; focus on the heading |
| Ambient sweep, bar power-up, edge traces, ignite | None |

This follows AGENTS.md's rule that reduced motion "disables transitions only": no state, word or indicator depends on motion.

---

## 8. Component-by-component changes

### 8.1 Styles

| File | Changes | Stays |
|---|---|---|
| `styles/tokens.css` | Every value in §2.2–2.4 and §7.2; 21 new themed names; the fallback block copied from dark | The block structure, the comments' intent, 6-digit hex |
| `styles/base.css` | **Page:** `body::before` glow and `::after` lattice (§4). **Layout:** `.frame`, `.spine-col`, `.spine`, and the `.stage` card rules removed. **TopBar:** 64 px, translucent canvas plus blur, cornice, tab indicator bar, brand SVG. **RunHeader:** it becomes `.spine__run` (identity) and `.facts` (dot-separated; two plus More at ≤760). **JourneyRail:** vertical `.spine__list`, `.node`, `.spine__rail/__fill/__head`, `.segs` (10) at ≤900; states in §5.2 and §6.3. **Narration:** it becomes `.now`. **Buttons:** 46 px; primary gradient `linear-gradient(180deg, var(--primary-1), var(--primary-2))` with `inset 0 1px 0 rgb(255 255 255 / .42), 0 0 0 1px` ring and a glow `::after` whose opacity rises on hover (the one hover transition, opacity only); secondary `--surface-2` with a `--line` border and a `--light` border on hover; quiet `--accent`. **Removed:** every colour, border and background transition (`.nav__link`, `.icon-btn`, `.live`, `.live__switch`, `.btn`, `.step__node`). **Feedback:** working rule `inset 2px 0 0 var(--light)`; problem notice red (below). **Notice:** `.notice--problem`, `.notice--blocker`: a 2 px `--fail-line` rule (`::before`, so T5 can draw it), glyph `--failed`, headline ink 600. `.notice--info`: glyph `--accent`. **Focus:** `outline: 2px solid var(--accent); outline-offset: 3px; box-shadow: 0 0 0 6px var(--focus-halo)`, instant, both themes. The dark-only `--glow` focus rule goes. **Stage pane and pane:** `.pane` (`--surface`, `--line`, `--r-lg`, `--shadow-1` + `--inner-highlight`, resting top edge `--edge-lit`), `.pane--stage` (`--raised` + `--sheen`, `--r-xl`, 32 × 38), `.pane.is-failed::before` (`--fail-edge-lit`). | `[hidden]` rule, skip link, visually-hidden, glyph base, the ActionBlock DOM contract and its classes, `data-theme-switching` (instant theme) |
| `styles/motion.css` | The reduced-motion block lists every new token. `.motion-sweep` goes (M5 removed). `.trace`, `.surf`, `.dg*`, `.w` and the pulse-target classes are added. `.feedback__meter-fill` keeps its `transform` transition, now `--dur-fill` / `--ease-fill`. | `.feedback__sweep` (M11); View Transitions disabled under RM |

### 8.2 View helpers, stores and pure modules

| File | Changes | Stays |
|---|---|---|
| `view/motion.ts` | **Add:** `revealOnOpen(root, dir)` (§7.4); `meaningText(el, text, key, kind)` (T4 and T5; reveals only when `key` changes after the first value); `headingWords(el, phrase)` (T1, and changed words only for T4); `Pulse` (§5.6); `roll(el, from, to)` (N1); `glide(scope, mutate)` (L1 and L2); `trace(pane, {fail, open})` (E1); `powerUp(bar)` (B3). **Rewrite:** `stageTransition` to S1 plus `revealOnOpen`. **Remove:** `flash()` (a `background-color` animation) and `sweepOnce()`. **Keep:** `fillTo` for `--fill`. | `reducedMotion`, the token readers (they throw on a missing token), `onSignature`, and no waiting on animation events |
| `view/a11y.ts` | `announce(text, {throttleKey: 'light:<runId>', minGapMs: 2500, force})`. `force` is used for failed and done. | The narration throttle |
| `state/clock.ts` | Add `deadlineClock(at)` (§5.3) | `minuteClock` |
| `state/run-store.ts`, `state/types.ts` | Add `livePausedAt: Signal<number \| null>`, written by `poller.setLive`. Add a computed `light: Read<Light>` from `runLight()` (§5.3). | Merge, `checkedAt` writes, and everything else |
| `state/draft-store.ts`, `controllers/extraction.ts` | `lastReadAt` signal | — |
| `controllers/send.ts` | Record `startedAt` for `sending`, and `at` for `rejected` and `handover-failed` | The send loop, locks, no retries |
| `controllers/build.ts` | `lastCopyAt` in `copying` | — |
| `core/ui/live-light.ts` (+ test) | New (§5.3) | — |
| `core/ui/journey.ts` | `failure: boolean` on the current step (§6.2) | All rules and phrases |
| `core/ui/copy-light.ts` | New copy group for §5.5 and §6.4. It includes "Filing certainty 90% (starting value)" (prototype S10). | Copy lint |

### 8.3 Components

| File | Changes | Stays |
|---|---|---|
| `components/track.ts` / `.css` | Becomes the **LightBar** (§7.6). States: `moving` (live head, glow), `still`, `waiting` (head without flare; the stripes go), `muted` (grey head, no glow), `stalled`/`failed` (dashed `--ink-3` work, red head), `done` (head `--light`, no outer glow), `loading` (short still segment, "Starting…"). Transitions start only after the first value (§7.1 rule 2). | `role=progressbar`, the values, `valuetext`, the caption, "n of N", never beyond the recorded count |
| **new** `components/status-light.ts` / `.css` | §5.1–5.2. `statusLight({ light: Read<Light>, compact?: boolean })`. It writes words through `meaningText` and registers pulse targets. | — |
| **new** `components/count.ts` / `.css` | `count({ value: Read<number>, of?: Read<string> })`: tabular numerals and N1 | — |
| **new** `components/sort-bar.ts` / `.css` | §7.6 (SPEC PipelineTrack). There is no station `<dl>` row; the legend carries the two non-outcome counts. | `role=img` with the full sentence |
| **new** `components/outcome-tally.ts` / `.css` | Tallies: word and glyph in the outcome text colour, a `Count`, "of 114", and a 4 px meter in `-bar` set in place (no meter animation). "Could not process" is neutral at 0. | `<dl>`, meters `aria-hidden` |
| `view/action.ts` (FeedbackSlot variants) | Three layouts: (a) **lasting failure**: rule, glyph, message, then the action row with its consequence (§6.3); (b) **one-document notice** in a pane's last line; (c) **finished**: the next action beneath the light. `problem` notices get the red rule. | The DOM contract, one message per slot, `role=alert` for blockers only, timestamps, handoff, scrolling rules |
| `components/outcome-pill.css` | Tints from the new `-soft` tokens; `box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--X-bar) 30%, transparent)`; 24 px high | Word plus glyph, "Review first" text |
| `components/chip.ts` / `.css` | Chips render as quiet facts: 13 px `--ink-2`, values ink 600, a 3 px `--ink-3` dot 14 px to the left (the list clips, so a dot never starts a line), no border or fill. `dashed` becomes words only. `accent` becomes `--accent` text. The unverified caution glyph is kept. | Text first, "…" while pending, labels |
| `components/show-control.css` | A pill strip (`--surface-2`, inset `--line`, radius 22, 4 px padding) with a sliding **capsule** (`--accent-soft`, inset `color-mix(--light 55%)`, `0 0 14px var(--light-glow-soft)`) instead of the underline. M8 move. Dots use the `-bar` tokens. | radiogroup, arrow keys, disabled at 0, no weight change |
| `components/radio-cards.css` | `--r-card`; `--surface-2`; `--line` border; chosen: `--light` border + `--accent-soft` + `0 0 0 4px var(--accent-soft)`; dot `--trail` with `--light-glow`; `transform: scale()` transition only; disabled dashed | The native radio, the M2 click and change writers, parked reasons |
| `components/money-field.css` | 60 px field, `--r-card`, 30 px display numerals (tabular), focus ring plus halo; invalid stays ink | The error beneath, `inputmode`, never a float |
| `components/search-box.css` | 42 px pill input, glyph at 14 px, `/` hint as a `kbd` | Label, debounce |
| `components/confirm-sheet.css` | `--raised`, `--r-lg`, `--shadow-2`; scrim plus a 6 px backdrop blur | `@starting-style`, focus trap, Esc |
| `components/definition-card.css` | `--r-card`; `.mention` rule `inset 2px 0 0 var(--light)`; tag in `--accent` | "names Explainers" words |
| `components/disclosure.css` | The chevron rotates 90° (`--dur-hover`, transform) | Everything else |
| `components/folder-pick.css` | Well `--surface-2`, `--r` | Behaviour |
| `components/notice.css`, `action-slot.css`, `timestamp.css`, `judged-against.css` | Tokens only | Unchanged |

### 8.4 Shell

| File | Changes | Stays |
|---|---|---|
| `shell/app-shell.ts` | Markup: `.frame` > (`aside.spine-col` > `nav.spine` [identity block, compact row, rail]) + `main.stage`. The subject region's header, rail and narration are placed per §4. The frame is one column without a subject. | Mounted once; the watch per subject; the skip link |
| `shell/run-header.ts` | Split per §4; add the StatusLight; the status line moves into the Run facts sheet, test ids kept; the read problem is no longer rendered here (§4) | Chip values, Live toggle behaviour and pause time, the Run facts sheet |
| `shell/journey-rail.ts` | Vertical markup; `node__pulse` and `node__beat` spans; a failed class from `step.failure`; R1; 10 compact segments; rail geometry through `--rail-top`, `--rail-h` and `--rail-p` custom properties | Statuses, reasons, links, `rail--instant` |
| `shell/narration.ts` | Renders `.now`; T4 on key change; the Next visibility rule | Throttle, `focusPrimary` |
| `shell/run-strip.ts` | ≤900 only; adds the StatusLight | IntersectionObserver |
| `shell/top-bar.ts` | Brand SVG, tab bar (M8), activity pill with the light dot | Everything else |
| `shell/stage-host.ts` | S1 and §7.4; `data-enter` on panes; the action pane is marked for E1 | Route-shape mounts, view state, h1 focus |

---

## 9. Performance rules

1. **Compositor-only motion.** Animate `transform` and `opacity` only, plus `filter: blur()` on at most 7 heading words for 320 ms on a screen open. Never animate `box-shadow`, gradients, colours, `clip-path`, `mask` or layout properties.
   - Glows are static shadows on small elements (dot, head, node).
   - The halo is its own element whose opacity animates.
2. **No continuous work.** There is no `requestAnimationFrame` loop, no canvas and no `setInterval` for motion. The timers are the pulse's lease-end `setTimeout`, the stage leave timer, and the deadline clock. The pollers are unchanged.
3. **A read with no change costs nothing visible.** Only `checkedAt` changes. No DOM text is written and no animation is created; the gate's `motionPerDocument` check covers this with 0 for "a status check".
4. **One document is cheap.** Nested boundary wrappers mean one +1 moves one segment, one boundary and one head (§7.6). Lists glide as one element inside a still clip.
5. **Static ground.** The glow and lattice are `position: fixed` pseudo-elements, painted once. There is no `background-attachment: fixed`. Masks are static. Backdrop blur is used only on the sticky TopBar and behind the sheet.
6. **Solid panes.** There is no translucency and no backdrop filter on panes (§2.1).
7. **Measure once.** The numeral band is measured once per font and cached. Spine geometry is measured on mount, on resize (ResizeObserver) and on subject change, never per poll. FLIP reads and writes are batched: read all, mutate, read all, then animate.
8. **Containment.** `contain: paint` on `.pipe`, `.lightbar` and `.dg__m`, and `contain: layout paint` on `.list-clip`. Do not set a global `will-change`. The browser promotes animating layers itself.
9. **Hidden tabs.** Animations do not run there. The light's state is still computed and becomes correct at the next deadline.
10. **Budgets** (§7.8) are asserted by Playwright. A regression fails the check.
11. **Not measured yet.** Smoothness on an ordinary office laptop is a hand-off (§10).

---

## 10. Tests and evidence

**In the gate (`npm run check`):**
- `scripts/tokens-contrast.test.mjs`, extended per §2.6;
- `core/ui/live-light.test.ts` (§5.3);
- `journey.test.ts`: the `failure` flag per rule;
- `upload-status.test.ts` is unchanged until D2 is decided;
- **`scripts/ui-rules.test.mjs`, new rule 14:** in `ui/app/**/*.css`, `transition` and `transition-property` may name only `transform` and `opacity`. No `animation` may use `infinite`. `@keyframes` may set only `transform`, `opacity` and `filter`.
- **Rule 15:** no `--filed*` or `--review*` token outside the outcome components (pill, tally, sort bar, show control).

**Playwright (`npm run check:ui`, outside the gate).** Port the prototype's `capture.mjs` checks to the built app. They are named in `design-notes.md` §10:
- `tabularCounts`, `digitRoll`, `motionPerDocument`, `onlyTransformOpacityFilter`;
- `staleIsHonest`, `stageMutedWhileFailed`, `finishedLayout`, `failureAboveFoldAndSurfaceGrows`, `layoutStillOnDocumentFailure`;
- `eachFailureSaidOnce`, `oneColourForFailedDocuments`, `redOnlyWhenFailed`, `redOnFailure_dark`, `redOnFailure_light`;
- `pulseLease`, `quietPeriodWaiting`, `reducedMotion`, `reducedMotionMidSession`, `waitingReadsWithoutMotion`;
- `screenOpen`, `stillWhenNothingMoves`, `cutVisibleAt390`, `phone`, `keyboardFocus_*`;
- rendered-text contrast over every visible text node in both themes at 1440 and 390 px (via `scripts/ui-theme-contrast.mjs`).

Also update `01c-shell-lab.mjs`: its Notice check's wording "never an outcome colour" becomes "problem notices carry the red rule". Status checks are driven by a mocked `/status`, never by a timer in the test.

**Hand-offs** (a person or another machine is needed; nothing here claims them):
1. **Owner review** of the built app for D1–D5, in both themes, including the pulse strength and the amount of red.
2. **Frame rate on an ordinary office laptop.** Edge performance panel, 4× CPU throttle, 1440 × 900, on the Progress view with +10 decided and one failure. Target 60 fps and no long task over 50 ms. Record the result in HANDOFF.
3. **Screen reader** (Narrator and NVDA). The light's announcements, the failure block, a failed step's words.
4. **Acceptance** (SPEC §10.4). A non-technical person completes the flow without coaching and reads the light and the failure words correctly.

---

## 11. Deviations from the prototype (on purpose)

1. **The light track is lighter.** `--track` is `#E8ECED`, where the prototype's `.11` over the stage pane gave `#E1E6E7`. At `.11`, the needs-review fill was 2.96:1 against the empty track and failed 3:1. The prototype's contrast script measured fills on the pane only, so it did not catch this. The prototype is not edited. If it is re-shot, apply the same value.
2. **Solid panes** instead of 80–84% glass (§2.1).
3. **Sizes normalised to the token scale**, with a 12 px minimum (§3).
4. **The lease is `max(15 s, 3 × poll interval)`** over the app's 3 s reads. The prototype used a fixed 15 s over simulated 5 s checks.
5. **One quiet rule.** The light's Waiting uses `sortQuiet` and `SORT_QUIET_MS` (5 min today, D2). The prototype had its own 90 s / 3 min control.
6. **"Queued at the AI service" becomes "the AI service asked us to wait until 14:40".** The app's only fact is a provider pause with an end time. Where no pause is recorded, the reason is "no new activity for N min".
7. **"last result" becomes "last activity".** The fact is the run's last recorded event (`lastEventAt`), not specifically a new outcome.
8. **Focus uses `--accent`.** The prototype had a separate `--focus` of almost the same value.
9. **The prototype control bar, simulators, the `?motion=` override and the Amber control** are not built. The Amber choice becomes D1's single token value.

---

## 12. What this document does not establish

- It does not show that the build matches the prototype. That needs the built app and the Playwright port (§10).
- The contrast numbers are token arithmetic from this session. Rendered contrast on the built app still has to be measured.
- Smoothness on an ordinary laptop, screen-reader output, and whether a non-technical person reads the light correctly without coaching are all unmeasured.
- None of D1–D5 is decided, and the DESIGN.md and SPEC wording in §6.1 is proposed only.
