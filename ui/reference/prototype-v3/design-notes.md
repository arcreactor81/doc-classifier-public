# Prototype v3: Light Architecture, polished (round 3, plus fix pass round 1)

Written 25 September 2026. This file replaces the round-2 notes. Earlier rounds are not kept separately. The fix pass (§0) came after round 3. Where it changed something, the round-3 text below has been edited in place; the §1 table is kept as the record of round 3.

**Status (AGENTS.md §8).** This is a static prototype. It is implemented and locally tested in headless Edge 153 on this PC (evidence in §10). It is not built into `ui/app/`. It is not deployed, not live verified, not owner accepted and not quality accepted. Nothing in it talks to the app or to any service. It started as a copy of the chosen `prototype-v2/light-architecture`, and that folder was not edited.

**Files.**

- `index.html`: every screen, the shell, and the prototype control bar.
- `la.css`: all tokens and components.
- `la.js`: state, rendering, the live indicator, the simulated status checks, the text reveal, the digit roll, the bar, and the layout glide.
- Evidence lives in `repo/.local/qa/ui-rebuild/prototype-v3/`:
  - `capture.mjs`: screens, frame sequences, 51 checks, `report.json`.
  - `contrast.py`: token contrast, colour-vision distances, the three-way outcome-colour comparison, and the outcome fills against the empty track. It writes `contrast.json` and `amber.html`.
  - `smoke.mjs`: a one-page debugging helper. It is not evidence.

---

## 0. Fix pass, round 1 (critic's remaining items only; no redesign, no new features)

| # | Critic's finding | What changed | Evidence (`report.json`) |
|---|---|---|---|
| M1 | Try again, Continue sending and an answer after a lapse set `S.lastChange`, so the light reported a result that never arrived. | Only `readMore` and `liveMore` move `S.lastChange` (a new count). Every recovery goes through `resumeLight()`, which calls `Pulse.confirm()` and nothing else. If the last change is already older than the quiet period, the light goes straight to Waiting. A waiting light is never a pulse target, so the renewed lease makes nothing pulse. The presets place the last change in the scene (`ago()`): 2 min before Can't reach the service, 41 min before Sending stopped, 2 min before Reading stopped. | `recoveryClaimsNoResult`, 8 cases, with no new outcome in any of them. Try again: "Working · last result 2 min ago · updated just now", count 73. Past the quiet period (3 min 20 s): "Waiting · no change for 3 min", 0 pulses. Continue sending (41 min): "Waiting · no new document for 41 min", sent 13, 0 pulses. Continue sending (2 min): "Sending · last received 2 min ago · updated just now". Choose the folder again: "Reading · last file 2 min ago · updated just now". An answer after a lapse at `?quiet=4000`, 5.2 s after the last outcome: Waiting, 0 pulses. `S.lastChange` moved in none of the 8 cases. |
| M2 | On stale and failed the Now line dropped to one line, so the stage glided up 27 px as the dot turned red. | The Now line keeps one height on the working screens: two lines of the sentence at 761 px and wider, three on phones. The reserve is on `.now` itself (sentence plus Next, rows at the top), not on the sentence. **Two more causes were found while testing more sizes, and both are fixed.** (1) On short phones the failure's action is below the fold, so Next appears in the Now line. It used to add a row and push the light down 22 px; it now uses the space the shorter failure sentence leaves. (2) With the control bar open at 761–1100 px, the +1, +10 and Fail labels got shorter when disabled. The bar re-wrapped and lifted the page 31–34 px. Each label now keeps its words for the screen while disabled. | `lightStillAcrossStates`: the pane light's top, the pane's top and the Now line's bottom have a spread of **0.00 px** across live / waiting / stale / failed. Covered: sorting, sending and reading, at 1440, 1024, 980 and 800 (control bar open), 390×844, 390×700 and 360×640. Next is shown in the failed state on the short phones, so that case is exercised. The control bar's height does not change. A scratch sweep over 21 widths (360–1366) and 10 sizes down to 360×640 also found 0 px everywhere. |
| M3 | The red head sat against a 2.77 px red segment and read as one smear; its resting glow washed the amber. | Every non-zero outcome is drawn at least 7 px. The extra comes out of the undecided rest, so a segment never shrinks while others arrive. The head stands in its own notch: 3 px of pane colour, the 4 px head, 3 px of pane colour, after the last decided segment. It overlaps no segment. The resting glow is gone; the only glow is the event flare. The bar is still 16 elements for any number of documents. | `headClearOfSegments` (both themes, 390 and 1440, working and failed). At 390: failed segment 7 px drawn, 6 px visible (was 2.77 px). Head 3 px clear of the last segment. Head `box-shadow: none`. Notch colour = pane colour. 16 elements before and after 20 more outcomes. `cutVisibleAt390` adds `redGapPx` ≥ 2.5 and a check that the crops are whole. `pipe-cut-390-{dark,light}.png` (working) and **`pipe-cut-390-checkfail-{dark,light}.png`** (Can't reach the service), at 4×. |
| M4 | Proposed B could not be loaded; its screenshots were Current. | `index.html` applies `amber=red` as well as `proposed`, from `?amber=` and from the saved choice. | `amberRedApplies`: `?amber=red` gives `--failed-bar #B3261E` and a segment of `rgb(179, 38, 30)`; the saved choice gives the same; dark stays `#FF5A4D`. A control (Current shot twice) is byte-identical. Proposed B differs from Current, and `live-amber-red-light-1440.png` differs from `live-light-1440.png`. |
| S1 | A cyan head stood past the finished bar. | No leading edge (and no notch) when sorting is done, on a complete Read bar, or on a complete Send bar. | `finishedLayout`: `headShown`, `notchShown` and `readDoneHeadShown` are all false; the complete Send bar has `display: none` on its head. |
| S2 | Waiting and Working looked the same in a still frame. | Waiting is a smaller dot (8 px) inside a full-strength 1.5 px ring 18 px across, with no halo. Working is the full 12 px dot with its glow. Done is the hollow ring with no dot. Entering Waiting, the dot draws in over 700 ms (transform) as the ring settles. | `waitingReadsWithoutMotion` (reduced motion, both themes): Working dot 12 px, halo .55. Waiting dot 8 px, ring 18 px at opacity 1 with a 1.5 px inset stroke, halo 0. Done has no fill and a ring. 0 animations. |
| S3 | A stopped Read or Send bar turned the work done into a dashed grey track. | The work done stays a solid bar in the muted neutral fill: `--stale-dot` at 80%, 3.18:1 against the track in dark and 3.55:1 in light. Only the head is red. | `stoppedWorkKept` (Reading stopped, Sending stopped, both themes): no background image, no dashed layer, head = `--fail-line`. |
| S4 | The per-document tick ruler was ornament whose density grew with the run. | Removed from the Read and Send bars (markup, CSS and script). A bar is rail, fill, head and flare for any number of documents. | `motionPerDocument`: +1 sent and +1 file read are **6** animations (were 8). The removed-ornament scan includes the tick selectors and finds none. |
| S5 | Five bars at once on the sorting screen. | The tally meters are gone from the sorting screen; the main bar shows the proportions. Once sorting starts, the finished send is one fact in the facts row ("All 114 sent at 13:59"), not a pane with a full bar. | `sortingScreenOneBar`: one bar shown at 1440 and at 390. At 390 the light is at 534 px (was 652) and the count at 572 px (was 692). |
| S6 | "Nothing to do now." and its hairline repeated the Now line. | The sorting pane's last line is not laid out unless it holds the one-document notice or the paused note. Reading keeps "Nothing to do now. Keep this page open." One consequence: the first failed document lays the line out, so the content below glides down by its height (320 ms, with the pane's surface). Nothing above it moves. | `footerOnlyWhenItSaysSomething`; `layoutStillOnDocumentFailure` (light, count and bar within 0.5 px; tallies move by exactly the line's height, as a 320 ms glide; nothing moves on the next document). "A document fails" is now 16 animations (was 13): the glide adds the tallies, the lower row and the surface. |
| S7 | Reading said "on this computer" three times, and "Just read" twice. | The reason uses the sorting evidence words: "last file just now", then "last file N min ago · updated just now". The "Just read …" footer is gone. The latest file is the first row of Just read. | `readEvidenceWords`. |
| S8 | Home's run card had no state. | The card carries its run's state word and dot, from the same function as the run header (`runLight`). It is red on failure, never pulses (`.ind--still`), and has no action; recovery stays on the run. | `homeRunCardState` (Working, Waiting, Can't reach the service, Sending stopped, Sorted): the word equals the run header's, and it is red with a red dot on both failures. 0 animations on the card and 0 pulses on Home. The only control is "Open Run 9". |
| S9 | "Live updates" stayed after the run was sorted. | Hidden when the phase is done. | `finishedLayout`: `liveToggleShown` false when sorted, true while sorting. |
| S10 | The Results Now line repeated the tallies. | "Next, make folders on this computer." | `resultsNowIsNextStep`. |
| Spec | VISUAL-SPEC-v2 deviation 1: needs review was 2.96:1 against the empty light track. | The light `--rail` is one step lighter, `.08` (was `.11`). On the stage pane that is `#E8ECED`. | `contrast.py`: light track `#E8ECED` gives filed 3.29, needs review **3.13**, could not process 3.92 (5.49 under B). Before, `#E1E6E8` gave needs review 2.95 by this script's rounding; the spec gives 2.96. `outcomeFillsOnTrack` measures the same as rendered. |

Not changed, and noted for the next round: a Waiting light does not lapse to "Not updated since …" if answers stop. Only a Working light has a lease that withdraws its claim. This was true before the fix pass and is outside its items. It matters a little more now, because recoveries past the quiet period go to Waiting.

---

## 1. What round 3 changed (critic's list, must-fix first)

| # | Critic's finding | What changed | Evidence (`report.json`) |
|---|---|---|---|
| M1 | Count digits were proportional, so the words beside a count jumped and the roll sliced digits. | `font-feature-settings: "tnum" 0` is gone from `body`. `font-variant-numeric: tabular-nums` now comes after the `font` shorthand on `.count__n`, `.tally__n` and `.spend__n`. A rolling digit's box holds both the old and the new digit in one grid cell, so it is as wide as the wider of the two. | `tabularCounts`: all ten digits are 44.2 px at 95 px. "of 114 have an outcome" moved 0.00 px over 73 → 81. The failed tally's "of 114" did not move on 1 → 2. |
| M2 | The roll window was a full line box, taller than the digits. | The window is now the numeral band. Its top and bottom are measured from the font in use (`numeralBand()`: canvas font metrics and the element's line height). The hard clip sits 12% of the band beyond cap height and beyond the baseline. Inside that margin is a static, steep fade: under 50% for the outer three-quarters. See the note below the table. | `digitRoll`: band 604.2–673.2 px (69 px), window 595.9–681.4 px, soft edge 8.3 px (0.12 of the band). The old digit never shows more than the soft edge above cap height, and the new digit never more than the soft edge below the baseline. `count-roll-zoom-f0…f4` (0/60/120/180/280 ms) and `count-roll-carry-zoom-*` (79 → 80). |
| M3 | The lapsed state contradicted itself: "Not updated since 14:23", while the Now line said sorting was carrying on. | New Now keys `sort-stale`, `send-stale` and `read-stale` say only "The numbers below may be out of date.", in ink, not red. Nothing below the light claims live activity. The leading edge becomes a plain `--stale-dot` mark with no glow, the count turns `ink-2` and the being-read fill rests. The Decided node is gone (M5). | `staleIsHonest` (sorting and sending, `?checks=off&lease=800`). `live-stale-*.png`. |
| M4 | Too much motion per document: 28 animations for "+1 decided" and 34 for a failed document. | Removed: `.pipe__sweep`, `.packet`, `.tally__flash`, `.activity__sweep`, the light-bar streak, and the tally-meter animation (the meter is now set in place). The bar is rebuilt from nested boundary wrappers (§5.4), so one document moves only its own segment, the one boundary after it, and the head. The activity list glides as one element inside a still clip. The flare is 24 px wide and inside the bar, which clips it. | `motionPerDocument`: +1 decided **8**; with a carry (79 → 80) **9**; a failed document **13** (the same 8 plus the one red beat on 3 lights and the notice's rule and line); +1 sent 8; +1 file read 8; a status check 0. The limit asserted is 12. The 5 pulse animations were already running and are not restarted. |
| M5 | The Decided station had a label and no number. | `.stations` is deleted. "Being read 19" and "Waiting its turn 22" are now in the bar legend, written in place. The sorting pane is 124 px shorter (346 px against about 470). | `live-*.png`, `finishedLayout`. |
| M6 | The notes claimed only transform, opacity and filter animate, but stroke-dash, colour and a canvas loop did too. | **Edge trace**: one gradient band moved by `translateX` behind a static 1.5 px ring mask (§7.5). **Tick**: scale plus opacity. **Home loop trail**: an opacity fade. **Callouts**: `transform`, not `translate`. **CSS transitions** on colour, border, background and shadow are removed; hover and state colours change at once. **Ambient canvas loop**: removed. It is now a single sweep of one element along a lattice line when Home opens (2.4 s, once). The ambient pause button is gone with it. The claim in §7 is now tested. | `onlyTransformOpacityFilter`: Element.animate was recorded on a 20-step tour of every screen and event, including hover. The only keyframe properties seen were transform, opacity and filter. The only CSS transitions seen were transform and opacity. The only properties declared in `la.css` are transform, opacity and none. There are 0 infinite animations. With Home settled there are 0 requestAnimationFrame calls in 1.5 s and 0 canvases. `ambientSingleSweep`. |
| S1 | The finished state said the outcome four times, and its action was below the fold. | **See the results** now sits directly beneath the light, in the place a failure's action takes. The 114 count and the station row are gone. The Now line reads "Every document has an outcome. Next, check the results, then make folders on this computer." The bar and the tallies are the record. | `finishedLayout`: at 1440×900 with the control bar open, the button is at 585–641 px (the critic measured about 922). Next is not doubled. |
| S2 | Zero tallies and the spending pane showed while sending. | Both are hidden until sorting starts. The one-line Sorting strip reads "Sorting · starts once all 114 are sent · nothing charged yet". When sorting starts, they fade in (420 ms). | `sendingShowsNoZeros`. |
| S3 | The lasting-failure pane had an empty footer, and the tallies slid over the pane's new edge. | The pane's last-line container is not laid out when it has nothing to say (send, fail, done). The three working panes (`.surf`) paint their surface on `::after`. On a lasting failure or a recovery, that layer is scaled from the old height to the new one, from the top, over the same 320 ms and easing as the content glide. The edge trace's ring follows the same transform. | `failureAboveFoldAndSurfaceGrows`: 346 → 380 px, `scaleY(0.9092)` → none, 320 ms, same easing as the tallies' glide. `stageMutedWhileFailed`: 33 px from the legend to the pane's edge. |
| S4 | The stage kept its live cues under "Can't reach the service". | The stage is muted while failed, exactly as when lapsed: count `ink-2`, being-read fill at rest. The head is the red leading edge, so red is the only thing that reads as live. | `stageMutedWhileFailed`, `indicator-fail-zoom-f0…f4`. |
| S5 | "last result 14:23" was a clock time the person cannot compare with anything. | The reason reads "last result just now" for the first minute. After that it reads "last result 2 min ago · updated just now", written in place. The quiet period is now the owner's choice: control bar **Quiet period: 90 s / 3 min** (§5.3). | `relativeTimeAndQuietChoice`. |
| S6 | The light amber proposal `#A38600` read olive. | Added **Proposed B: red only**: needs review keeps `#B07A10`, and only the light "Could not process" fill moves to `#B3261E`. The Amber control now has Current / Proposed A / Proposed B. `amber-decision.png` has three columns. The 2 px cut between filed and needs review was checked at 390 px. | §3.3; `copyHeaderAndAmberChoices`; `cutVisibleAt390` (cut against the fills: 9.03 / 9.24 dark, 3.81 / 3.62 light); `pipe-cut-390-{dark,light}.png`. |
| S7 | At 390 px, "Setup complete" shrank to a lone tick, and the phone labels were small. | "Setup complete" is hidden on phones. The legend is 13 px everywhere (the station labels are gone). The NOW label is 12 px on phones. | `phone`. |
| S8 | Opening a screen was busy around the text. | Only the pane that holds the screen's one action is traced, once (720 ms). A screen with no action on it is not traced. A bar draws itself only the first time it is shown in a session. The power-up is shorter (620 ms rail, no flare). | `screenOpen`: header settled at 500 ms; everything settled at 950 ms (was about 1.1 s with four traces). One traced pane on Read (the Choose folder pane) and on Confirm (the summary); 0 on the live screen. Rail draws: 1 the first time, 0 when shown again. |
| S9 | The same kind of failure had two colours, and the Read header stacked three statuses. | One rule on every screen: a document that could not be read or processed is a failure, so its count is in the red family from the first one and neutral at 0. This covers the Read foot ("2 could not be read", with its slash glyph), "Could not read" in Just read, the Confirm summary, and the "Could not process" tally. The run header drops "Not started yet" once reading has begun, and the overline says "This run" rather than repeating "New run". | `oneColourForFailedDocuments`, `copyHeaderAndAmberChoices` (Read header: "This run · New run · Reading"). |
| S10 | Two copy problems. | "Filing certainty 90%, not yet tested" is now "Filing certainty 90% (starting value)". The explanation belongs in How it works, which is not part of this prototype. The Sending stopped Now line is "Sorting can't start until every document is sent." The number appears only in the message. | `eachFailureSaidOnce` (no digit in any failure's Now line); the jargon scan now also bans "not yet tested". |

**Why the soft edge sits just outside the band (M2), not inside it.** A digit at rest fills the band exactly, from cap height to baseline. A fade inside the band would dim the top bar of a 7 or a 5, and the base of a 2, for as long as the roll lasts. Then, when the roll hands back to plain text, those strokes would jump to full strength. So the band itself stays fully opaque, and the soft edge is the 12% beyond it. The steep profile keeps what passes the edge close to the line. In the 60 ms frame, the old 3's lower bowl is still inside the band, which is simply mid-roll. Only its outer tip reaches into the soft edge. By 120 ms nothing shows above the 7, and the 4's stem ends in a faint tail at most 8.3 px below the baseline. If the owner prefers a hard cut at cap height and baseline, set the soft edge to 0 in `numeralBand()`. That is one number.

Removed this round, with no ornament added:

- the three stations and their line;
- the travelling packet;
- the sweep along Decided;
- the tally flash;
- the activity-row sweep;
- the light-bar streak;
- the big-bloom flares;
- three of the four screen-open traces;
- the ambient comets and their pause button;
- the zero tallies and the spending pane while sending;
- the 114 count and duplicate Next when finished;
- "Setup complete" on phones;
- "Not started yet" once reading has begun.

---

## 2. Screens and the prototype control bar

Presets are in the control bar, or use `index.html#<preset>`. URL options are `?theme=light`, `?motion=reduce`, `?amber=proposed|red` and `?checks=off`. For tests there are also `?lease=`, `?every=` and `?quiet=` (in ms).

| Preset | Screen | What it shows |
|---|---|---|
| `home` | Home | Hero, the journey loop, your runs, Start a new run. Run 9's card carries its state word and a still dot (red on failure, no action). |
| `read-choose`, `read`, `read-failed`, `read-done` | Read files | Choose folder. Reading, with the light. Reading stopped (red, "Choose the folder again"). All read, with "Review and start" |
| `confirm` | Confirm | Mode and spending limit; Start run is blocked until both are set |
| `live-sending` | Sending | The light says Sending; the bar advances per document received; Sorting is one line; no tallies, no spending pane |
| `live-stalled` | Sending stopped | Red light, Send step, leading edge and rule; Continue sending in the same block |
| `live` | Sorting | Working, pulsing. One bar; "All 114 sent at 13:59" is a fact in the facts row |
| `live-waiting` | Waiting | An 8 px dot inside a still, full-strength ring, no glow; "queued at the AI service · no change for 4 min" |
| `live-checkfail` | Can't reach the service | Red; Try again in the same block; stage muted; the red head in its own notch |
| `live-done` | Sorted | A still hollow cyan ring; See the results directly beneath it; no leading edge; no Live updates toggle |
| `results`, `review`, `review-answered` | Results, Review folders | As v2, with the red outcome family. The Results Now line gives the next step. |

**Control bar ("Not part of the app").**

| Control | Event it stands for | Available when |
|---|---|---|
| **Status checks: Every 5 s (simulated) / Stopped** | The page asking the service every 5 s. Each answer that shows the work moving renews the light's lease. | On by default for the working presets. Stopped shows the honest lapse. |
| **Quiet period: 90 s / 3 min** | Not an app event. It is the owner's choice of how long answers may show no new outcome before the light says Waiting (§5.3). | Always |
| **+1 / +10** (labelled "file read", "sent", "decided") | An update that saw progress | Reading, sending or sorting, and not failed. A disabled button keeps its screen's label, so the bar never re-wraps on a failure. |
| **Stall** | Sorting: the service reports the work is queued. Sending: the service has not confirmed the last document. Reading: a large file. | Working and not paused |
| **Fail: …** (named per screen) | Folder access lost / sending stops / can't reach the service | Reading, sending or sorting |
| **A document fails** | The next decided document could not be processed | Sorting, while such a document remains |
| **Recover** | The natural resolution: Choose the folder again, Continue sending, Try again, the queue moves, or an answer arrives after the lapse. Only the queue moving (and, on Read, the next file arriving after a wait or a lapse) brings a new count; the others renew the lease and nothing else (§5.3). | Any non-live state |
| **Next step** | Moves the flow on (or "Reply arrives" while a save is waiting) | Always |
| **Amber: Current / Proposed A / Proposed B: red only** | Not an app event. It switches the outcome colours for the owner's comparison. | Always |

Status checks are the only timer in the prototype, and they are labelled as simulated. They stand for the app's real polling. They never create progress: a check alone never changes a count, and it starts 0 animations (measured).

---

## 3. Visual system

### 3.1 Colour tokens

Values are six-digit hex, or `rgb()` with alpha composited as in §3.2. The dark theme is primary. Round 3 changed no colour token; it added the Proposed B override (§3.3). The fix pass changed two:

- the light `--rail`, one step lighter (spec deviation 1);
- `--hold-a`, the waiting ring's opacity, now 1 in both themes (with the smaller dot, S2).

The sorting bar's head has no resting glow.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--ground` | `#0E141A` | `#E4E9ED` | Page ground |
| `--panel` / `--panel-stage` | composited `#182129` / `#1B242C` | composited `#F7F9FA` / `#FAFCFC` | Panes and stage panes (on `::after` for `.surf` panes) |
| `--ink` / `--ink-2` / `--ink-3` | `#E3EAEF` / `#A9B6C0` / `#909DA8` | `#121A21` / `#3A4650` / `#4F5D68` | Text. The count is in `ink-2` while the stage is muted. |
| `--light-ink` | `#8ADCE8` | `#086476` | Cyan text: overlines, links, Next |
| `--light-line` | `#5FDDED` | `#0A8AA1` | The live light, fills, spine, trails. Never body text. |
| `--light-hot` | `#CDF8FC` | `#08788D` | Leading edges, heads, the current node's centre |
| `--wait-dot` / `--hold-a` | `#5FDDED` / 1 | `#0A8AA1` / 1 | The waiting light (an 8 px dot) and the opacity of its still 18 px outer ring (was .4 / .6 around a 12 px dot) |
| `--rail` | `rgb(150 205 222/.12)` → `#293842` on the stage | `rgb(20 50 65/.08)` → `#E8ECED` on the stage (was `.11`, `#E1E6E8`) | The empty track of every bar, the spine rail, the phone segments |
| `--stale-dot` | `#909DA8` | `#4F5D68` | Hollow ring (not updated, paused, not started), and the muted leading edge. It makes no claim. |
| `--fail` | `#FF8F84` | `#B3261E` | Red text: the failed state word, "Could not process", "could not be read" |
| `--fail-line` | `#FF5A4D` | `#D23F33` | Red non-text: failed light, failed node, leading edge, rule, "Could not process" fill |
| `--fail-glow` / `--fail-soft` | `rgb(255 90 77/.38)` / `.12` | `rgb(210 63 51/.26)` / `.10` | Red halo; red tint |
| `--filed` / `--filed-bar` | `#7AD7A0` | `#186A34` / `#2E9254` | Filed |
| `--review` / `--review-bar` | `#EDC069` | `#7A4D00` / `#B07A10` | Needs review (choices in §3.3) |
| `--failed` / `--failed-bar` | `= --fail` / `= --fail-line` | same | "Could not process" shares the failure red |

**Colour discipline.**

- **Cyan** is the product's light: where you are, what to do, and that work is moving.
- **Red** means only that something failed: a request, a document, the run, or sending. A count of failed documents is neutral at 0 and red from its first one, on every screen. The action that fixes a failure stays cyan. There are no red buttons.
- **Green and amber** are outcomes only. They never appear on status, lights, the spine or buttons. Waiting is cyan. A finished run is not green.
- **Grey (`--stale-dot`, `ink-2`)** means "no claim". It is used for not updated, updates paused, not started, and a muted stage.

### 3.2 Computed WCAG contrast (`contrast.py`, run this session)

Method:

- Panes are composited over the ground; wells, open rows and tints over the pane.
- Text needs 4.5:1; non-text needs 3:1.
- The rendered check in `capture.mjs` walks every visible text node on every screen: 6,398 nodes over 21 screens × 2 widths × 2 themes (fewer than round 3's 6,490, because the Sent strip, the idle footer and the tick labels are gone). It now also reads a `.surf` pane's `::after` surface. It composites the real backgrounds and reports the minimum: **dark 4.99, light 5.35, 0 failures**.

**Dark text.**

| text | ground | panel | stage | well | open row |
|---|---|---|---|---|---|
| ink `#E3EAEF` | 15.24 | 13.42 | 12.95 | 12.19 | 11.40 |
| ink-2 `#A9B6C0` | 8.94 | 7.88 | 7.60 | 7.15 | 6.69 |
| ink-3 `#909DA8` | 6.68 | 5.88 | 5.68 | 5.34 | **4.99** |
| light-ink `#8ADCE8` | 11.89 | 10.47 | 10.10 | 9.51 | 8.89 |
| fail `#FF8F84` | 8.39 | 7.39 | 7.13 | 6.71 | 6.27 |
| filed `#7AD7A0` | 10.63 | 9.36 | 9.03 | 8.50 | 7.95 |
| review `#EDC069` | 10.89 | 9.59 | 9.25 | 8.71 | 8.14 |

**Dark non-text (3:1).**

| token | panel | stage | well | open row |
|---|---|---|---|---|
| light-line / wait-dot `#5FDDED` | 10.14 | 9.78 | 9.20 | 8.61 |
| light-hot `#CDF8FC` | 14.31 | 13.81 | 13.00 | 12.15 |
| stale-dot `#909DA8` (also the muted leading edge) | 5.88 | 5.68 | 5.34 | 4.99 |
| fail-line `#FF5A4D` | 5.30 | 5.11 | 4.81 | 4.50 |
| focus `#7FE6F2` | 11.27 | 10.87 | 10.23 | 9.56 |
| input edge `#6E7D89` | 3.85 | 3.72 | 3.50 | **3.27** |

Pills (text on its own tint): filed 7.04, review 7.22, could not process 6.41. Primary button text: 11.98 / 9.67.

**Light text.**

| text | ground | panel | stage | well | open row |
|---|---|---|---|---|---|
| ink `#121A21` | 14.37 | 16.64 | 17.07 | 15.60 | 15.29 |
| ink-2 `#3A4650` | 7.91 | 9.16 | 9.40 | 8.58 | 8.42 |
| ink-3 `#4F5D68` | 5.54 | 6.42 | 6.59 | 6.02 | 5.90 |
| light-ink `#086476` | 5.55 | 6.43 | 6.59 | 6.02 | 5.91 |
| fail `#B3261E` | **5.35** | 6.19 | 6.35 | 5.80 | 5.69 |
| filed `#186A34` | 5.45 | 6.32 | 6.48 | 5.92 | 5.80 |
| review `#7A4D00` | 5.95 | 6.89 | 7.06 | 6.45 | 6.33 |

**Light non-text (3:1).**

| token | panel | stage | well | open row |
|---|---|---|---|---|
| light-line / wait-dot `#0A8AA1` | 3.85 | 3.95 | 3.61 | 3.54 |
| light-hot `#08788D` (the leading edge) | 4.88 | 5.00 | 4.57 | 4.48 |
| stale-dot `#4F5D68` (also the muted leading edge) | 6.42 | 6.59 | 6.02 | 5.90 |
| fail-line `#D23F33` | 4.42 | 4.54 | 4.14 | 4.06 |
| focus `#07798E` | 4.81 | 4.94 | 4.51 | 4.42 |
| filed-bar / review-bar | 3.72 / 3.53 | 3.81 / 3.62 | 3.48 / 3.31 | 3.41 / 3.24 |
| input edge `#7A8791` | 3.49 | 3.58 | 3.27 | **3.21** |

Pills: filed 5.35, review 5.82, could not process 5.40. White on the primary: 5.44 / 7.73.

**Minimums.** Text: dark 4.99, light 5.35. Non-text: dark 3.27, light 3.21.

**Outcome fills against the empty track** (fix pass; VISUAL-SPEC-v2 deviation 1). The pane tables above do not cover this pair: a fill sits next to the empty rest of its own bar.

| Track | filed | needs review | could not process | kept work on a stop |
|---|---|---|---|---|
| dark `#293842` | 6.91 | 7.08 | 3.91 | 3.18 |
| light, before (`.11`, `#E1E6E8`) | 3.11 | **2.95** (spec: 2.96) | 3.70 | 3.35 |
| light, now (`.08`, `#E8ECED`) | 3.29 | **3.13** | 3.92 (5.49 under Proposed B) | 3.55 |

"Kept work on a stop" is the muted fill a stopped Read or Send bar keeps (S3). All pass 3:1. The capture's `outcomeFillsOnTrack` measures the same pairs as rendered.

Red passes with room in both themes:

- Red text is at least 6.27 in dark and 5.35 in light.
- Red lines are at least 4.50 in dark and 4.06 in light.
- In dark, red text is softer than the red line (`#FF8F84` against `#FF5A4D`), so the words stay readable without glare.

**The cut between filed and needs review.** The two fills have almost the same luminance: 1.02:1 in dark and 1.05:1 in light. They are told apart by hue and by the 2 px cut between them, painted in the stage pane's solid colour.

- The cut against the fills: 9.03 / 9.24 in dark, 3.81 / 3.62 in light. Both pass 3:1.
- At 390 px the cut is 2.00 px wide and visible in both themes (`pipe-cut-390-{dark,light}.png`, at 4×).

### 3.3 Keeping the three outcome colours apart: three choices

"Could not process" is a failure, so it uses the failure red. The weak pair is needs-review amber against that red, especially in the light theme and for colour-blind readers. `amber-decision.png` shows the three choices side by side: dark and light, normal vision and simulated deuteranopia.

- **Current.** No change.
- **Proposed A.** Dark: needs review `#EDC069` → `#F5D250`. Light: needs-review fill `#B07A10` → `#A38600`, and "Could not process" fill `#D23F33` → `#B3261E`.
- **Proposed B, red only.** Light only: "Could not process" fill `#D23F33` → `#B3261E`, the red family's own text red, used for the outcome fill only. Needs review keeps its amber. The dark theme is unchanged.

The prototype's **Amber** control applies each choice everywhere, so it can be judged in place.

| Light theme | Current | Proposed A | **Proposed B** |
|---|---|---|---|
| needs review vs could not process, normal vision (ΔE) | 47.8 | 61.3 | 48.2 |
| same, deuteranopia | 12.8 | 20.4 | **18.3** |
| neighbour contrast in the bar (review / could not process) | 1.25:1 | 1.86:1 | **1.75:1** |
| filed vs needs review, normal vision (ΔE) | 65.5 | 57.1 | **65.5** |
| filed vs needs review, deuteranopia | 36.4 | 38.6 | 36.4 |
| needs-review fill on the pane (needs 3:1) | 3.53 | 3.33 | 3.53 |
| could-not-process fill on the pane | 4.42 | 6.19 | 6.19 |

| Dark theme | Current (= B) | Proposed A |
|---|---|---|
| needs review vs could not process, normal / deuteranopia (ΔE) | 59.5 / 16.0 | 72.2 / 27.2 |
| neighbour contrast in the bar | 1.81:1 | 2.08:1 |
| filed vs needs review, normal / deuteranopia | 55.2 / 34.3 | 61.4 / 50.3 |

**Recommendation: Proposed B.** In light it keeps the amber reading as amber, where A's `#A38600` reads olive and moves needs review towards filed green (65.5 → 57.1). It also gets most of A's gain: neighbour contrast 1.25 → 1.75, and deuteranopia 12.8 → 18.3. B leaves dark unchanged. Dark is the weakest point left under deuteranopia (16.0). If the owner wants more there, A's dark yellow `#F5D250` is the lever, and it can be taken on its own. Nothing is applied; this changes a palette the owner approved.

Whichever is chosen, the colours are never the only signal:

- Every outcome carries its word and glyph (check, person, slash).
- Only red also means "failed", so only red ever moves (one red beat when a document fails). Green and amber never glow or pulse.

---

## 4. Type, radius, spacing

Faces are system faces only: Segoe UI Variable Display for headings and counts, Segoe UI Variable Text for everything else, and Cascadia Mono for the prototype bar. Edge resolves all three on this PC (checked). There are no web fonts and no external requests.

| Role | Size / line | Weight / tracking | Change in round 3 |
|---|---|---|---|
| Hero | clamp(40, 4.7vw, 68) / 1.0 | 600 / −0.032em | — |
| Stage heading | clamp(34, 3.9vw, 56) / 1.02 | 600 / −0.03em | — |
| Giant count | clamp(56, 6.6vw, 100) / .92 | 300 / −0.04em, **tabular figures** | Tabular; `ink-2` when the stage is muted; hidden when finished |
| Tally count / spend | 52 (40 phones) / 1; 40 / 1.1 | 300, **tabular figures** | Tabular |
| Light state word | 15 / 1.3 | 600, sentence case, ink; red on failure; ink-2 only for "not started" | — |
| Light reason | 13.5 / 1.4 | 400, ink-2 | "just now" / "N min ago" |
| Now line | 17 / 1.6 | 400; "NOW" 11 px (12 on phones) 600 +0.18em cyan | NOW 12 px on phones. Fix pass: on the working screens the line keeps one height, two lines (three at 760 px and below), with Next inside it |
| Bar legend | **13** / 1.45 | 400 ink-2; counts 600 ink | Was 12.5; now carries Being read and Waiting its turn |
| Could not be read (Read foot) | 14 | 600 in `--fail` from the first; 400 ink-2 at 0 | New rule |
| Run facts | 13 / 1.5 | 500, ink-2, dot separators | "Filing certainty 90% (starting value)" |
| Failure message / notice | 15 / 1.5; 14 / 1.5 | 400, ink | — |

**Light sizes.** Working: dot 12 px, halo 7 px beyond it, the live ring leaves to 3×. Waiting: dot 8 px inside a still, full-strength 1.5 px ring 18 px across, no halo. Done: a hollow 12 px ring, no dot.

**Bar head (sorting).** 4 × 32 px, in its own 10 px notch (3 px of pane colour either side). No resting glow: the only glow is the 900 ms event flare. Every non-zero outcome segment is drawn at least 7 px. The Read and Send heads keep their small resting glow; no outcome colour sits beside them.

**Radius:** xs 6, sm 10, md 14, radio and definition cards 18, lg 22 (panes and the one-line Sorting strip), xl 30 (stage panes), pill 999. The trace ring follows the pane's radius. The failure rule is a 2 px rounded bar.

**Spacing** (4 px base): 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 56 · 72 · 96.

- Light to state word: 14 px. State word to reason: 14 px.
- Status row to its action (a failure's, or See the results when finished): 18 px.
- Failure block: 18 px from its rule to the text, 12 px between message and action row, 18 px between button and consequence, 24 px below.
- Legend: 14 px below the bar; items 20 px apart (16 on phones).
- The pane's last line: 26 px above it, a hairline, 20 px to the text. It is not laid out when empty. On the sorting pane it is also not laid out when all it would say is "Nothing to do now.": it holds only the one-document notice or the paused note.
- Everything else as v2: pane padding 28, stage 32/38, 20 on phones; 20 between panes; gutters 48 / 32 / 16; spine 244.

---

## 5. The live indicator

### 5.1 Anatomy and placement

- **Dot**: 12 px (8 px while waiting).
- **Glow**: a radial halo, 7 px beyond the dot (none while waiting).
- **Live ring**: 1.5 px, leaving the dot to 3× once per beat.
- **Still ring**: the waiting state only; 18 px across, 1.5 px, full strength, drawn as an inset shadow so it is a true 1.5 px.
- **Red beat ring**: one-shot, on a failure.
- **State word**: 15 px, 600, sentence case.
- **Reason**: 13.5 px, ink-2.

Everything except the words is `aria-hidden`; the words carry the meaning. Changes are announced through one polite live region, at most one every 2.5 s, except failures and completions.

Placements (all beat together, from one shared start time):

1. **Run header**: under the run name in the spine; on phones, at the right of the compact run row.
2. **The working pane**: the first line of the Read, Send and Sorting panes.
3. **The active journey step**: the current node's ring leaves it to 1.9×. On phones the current segment's glow swells on the same beat (checked: same `startTime` as the lights).

### 5.2 States and the app events that drive them

| State | Look | Words (pane; the run header shows the state word only) | Entered on (app event) | Motion |
|---|---|---|---|---|
| **live** | Cyan 12 px dot; the ring leaves and the glow swells each beat | **Working** · last result just now (then · last result 2 min ago · updated just now) / **Sending** · last received just now (the same pattern) / **Reading** · last file just now (the same pattern) | A new count renews a 15 s lease: an outcome, a document received, a file read, Start run answered, Choose folder. A successful answer with no new count keeps the light live only while the last new count is younger than the quiet period. A recovery counts as such an answer: Try again succeeded, Continue sending accepted, the folder chosen again, an answer after a lapse. It never counts as a result, so the words keep the age of the last real one. | Pulse, 1600 ms per beat, only while the lease holds |
| **waiting** | A smaller 8 px cyan dot inside a **still, full-strength 18 px ring**; no glow | **Waiting** · queued at the AI service · no change for 4 min / · no change for 3 min / · no new document for 41 min / · for the service to confirm the last document | A successful answer, but either the service reports the work as queued, or nothing has changed for the quiet period. A recovery whose last new count is already older than the quiet period comes here directly. | The ring finishes its beat; the glow goes out and the dot draws in to 8 px (900 / 700 ms); the still ring settles in (700 ms from 0.6×); then nothing moves |
| **stale** | Hollow grey ring, no glow; **stage muted** | **Not updated since 14:23** · the run may still be working. Now line: "The numbers below may be out of date." | The lease ended with no answer at all (the tab slept, a request hangs). This is the only timeout, and it withdraws the claim. | The pulse has already stopped; the words resolve in (meaning changed) |
| **paused** | Hollow grey ring; stage muted | **Updates paused** · sorting carries on without them | The person turns Live updates off (WCAG 2.2.2) | The pulse stops at once |
| **failed** | Red dot, red glow; stage muted, red head | **Can't reach the service** · since 14:23 / **Sending stopped** · since 14:02, 41 min ago / **Reading stopped** · at 13:52 | A status request failed; sending stopped and needs the person; folder access was lost. A run that stopped gets the same treatment (not simulated). | One red beat (900 ms), never repeated |
| **done** | Hollow cyan ring | **Sorted** · at 14:31 / **All read** · at 13:53 | The last outcome arrived; the last file was read | None |
| **not started** | Hollow grey ring; the word in ink-2 | **Sorting** · starts once all 114 are sent · nothing charged yet | Sorting cannot begin yet | None |

**The muted stage** (stale, paused, failed). Nothing below the light still claims live activity:

- the count is `ink-2`;
- the leading edge is a plain `--stale-dot` mark (red when failed), still in its own notch;
- the being-read fill rests at a neutral 26% grey;
- there is no flare.

Checked in `staleIsHonest`, `stageMutedWhileFailed` and `livePause`.

**A document that could not be processed** is a red *moment* on a light that stays live, not a red state:

- one red beat on the pane light, the run-header light and the journey node;
- the bar's 24 px flare is the red one;
- the notice becomes the pane's last line: "'Fax copy' could not be processed: it is a scanned image with no text. The others carry on." Its rule draws down with the line. The line was not laid out before (S6), so the content below glides down by its height; nothing above it moves.

The notice stays until the next such document or the end of sorting. The lasting record is the red "Could not process" tally, plus the activity line and the Results row.

### 5.3 Honesty rules

- **The pulse needs evidence.** It runs only while the latest confirming answer is younger than the 15 s lease: three answers at the app's 5 s interval. The pulse's iteration count ends when the lease ends, and each answer extends it without restarting the beat. If answers stop, the pulse stops by itself, then the words change to "Not updated since …" and the Now line to "The numbers below may be out of date." (`pulseLease`, `staleIsHonest`.)
- **A check is not progress.** A successful answer that shows no change keeps the light live only within the quiet period. After that the light says Waiting and how long.
- **A recovery is not a result** (fix pass M1). Try again, Continue sending, Choose the folder again and an answer after a lapse only say that the page is back in touch: they call `Pulse.confirm()` and nothing else. Only a new count (`readMore`, `liveMore`) moves the time of the last change. So after Try again the reason reads "last result 2 min ago · updated just now", and a recovery whose last change is older than the quiet period goes straight to Waiting ("no new document for 41 min") without a pulse.
- **The quiet period is the owner's choice.** It is an interface setting, not a fitted constant. At the Interactive pace seen so far (114 documents in about 32 min, one outcome every ~17 s):
  - 3 min is about 10 documents' worth of silence while the light still pulses;
  - 90 s is about 5.
  - **Recommendation: 90 s.** The prototype default stays 3 min until the owner chooses. Switch it with **Quiet period** in the control bar.
- **Relative words, never a bare clock time, while working.** "last result just now" for the first minute, then "last result N min ago · updated just now" (the page is still in touch). Both are written in place with no animation. Times of day appear only where they mark an event: "since 14:23", "at 14:31".
- **"Queued" only when the service says so.** Otherwise the reason is only "no change for N min" (`quietPeriodWaiting`).
- **Checks move nothing else.** Over 3 s of simulated checks every 400 ms, no animation other than the pulse was created (`simulatedStatusChecks`).
- **Bars move only on counts.** Heads stay still between events. The pulse lives only in the light.

### 5.4 The bar (how one document stays cheap)

Sorting bar structure:

```
.pipe (overflow hidden)
  seg filed        scaleX(f)
  W1 translateX(f)
    seg review     scaleX(r)
    W2 translateX(r)
      seg failed   scaleX(x)
      W3 translateX(x)
        seg reading  scaleX(notch + rd)  (its first 10 px lie under the notch)
        W4 translateX(notch + rd)
          cut
        cut, notch (10 px, pane colour), flare, red flare
      cut
    cut
.pipe__headwrap translateX(D)            D = f + r + x, the decided width
  head                                   at 3 px inside the notch
```

- Each boundary wrapper is the full bar, translated by the segment before it, so it carries everything after it.
- Widths are in pixels of the bar's own width, so the bar is redrawn on resize. Every non-zero outcome is at least 7 px wide (`MIN_SEG`), so one failed document in a million is still a red segment about 6 px wide between its cuts. The extra width comes out of the undecided rest; only at the very end of a run, with no rest left, is it taken from the widest outcome.
- While sorting, the head stands in its own notch after the last decided segment: 3 px of pane colour, the 4 px head, 3 px of pane colour. It overlaps no segment and has no resting glow. When the run is finished there is no head and no notch.
- The element count is fixed: four segments, four cuts, one notch, one head and two flares, for 10 documents or a million.
- One filed document changes `f` only: the filed segment, W1 and the head move. That is 3 animations, plus a 24 px flare that rides inside W3 and is clipped by the bar.
- Reading and sending bars: fill, head and a 24 px flare. That is 3 animations. There is no tick ruler: one mark per document grew with the run and meant nothing at scale.
- The activity list and Just read list glide as one element inside a still clip, and the new row fades in: 2 animations.

---

## 6. Failure treatment

When something fails, four things turn red, and the cause with its one action sits directly beneath the light. The capture checks this in both themes for each failure (`redOnFailure_dark`, `redOnFailure_light`):

- the computed colours of the light, the run-header light, the journey node, the leading edge and the rule equal `--fail-line`;
- the state word equals `--fail`;
- the run header uses the same word as the pane;
- the action sits below the message.

| Element | Normal | Failed |
|---|---|---|
| The light (pane and run header) | Cyan, pulsing or steady | `--fail-line` dot and glow; the state word in `--fail` |
| The affected journey step | Cyan ring, hot centre | 2 px `--fail-line` ring, "!" in `--fail`, soft red halo; the label stays ink. On phones, the red segment. |
| The progress bar's leading edge | Hot cyan head | Reading or sending: the work so far stays a solid bar in the muted neutral fill (it is kept, as the message says), with no glow, and only the head is red. Sorting: the head is red in its own notch, clear of the red "Could not process" segment. The stage is muted and the outcome segments keep their colours. |
| The message | — | 2 px red rule, red alert glyph, text in ink, then the action row: cyan primary plus one line of consequence |
| The pane | Cyan resting top-edge light | Red resting top-edge light, plus one red edge trace on the event (900 ms) |

**What each line says** (each thing said once):

| Failure | Now line: the consequence | Reason: the time | Message: cause and what is kept | Action · consequence |
|---|---|---|---|---|
| Can't reach the service | The numbers below may be out of date. | since 14:23 | This page lost its connection to the service. The run itself may still be sorting; nothing is lost. | **Try again** · The page also keeps trying on its own. |
| Sending stopped | Sorting can't start until every document is sent. | since 14:02, 41 min ago | The tab that was sending was closed or went to sleep. This browser kept the text of the other 101 documents; you don't need the original folder. | **Continue sending** · This continues Run 9. It doesn't start a new run or change your spending limit. |
| Reading stopped | Reading can't go on until this browser can see the folder again. | at 13:52 | This browser lost permission to view 'Archive 2026'. The 38 files already read are kept. | **Choose the folder again** · Reading picks up at file 39. Nothing has been sent. |
| A document could not be processed | (unchanged) | (unchanged) | The notice in the pane's last line | None needed |

- The heading names the job and does not change on a failure; the light names the state.
- Next in the Now line appears only when the action is out of sight with the page at the top. At 1440×900 and 390×844 all three actions are on screen, so Next is hidden (checked). On a shorter phone (390×700, 360×640) Next appears. It sits in the space the Now line already reserves, so the light does not move (`lightStillAcrossStates`).
- "More about this stop" holds the longer explanation and "Discard this run…".
- Red never pulses. It beats once on the event, then stays still until recovery. There is at most one visible primary on every screen (checked).

**Layout.**

- On a lasting failure the content below glides down with a 320 ms transform. The pane's surface grows with it: its `::after` layer scales from the old height to the new one, from the top, on the same 320 ms and easing, so the tallies never slide over the pane's edge. On recovery both reverse.
- Everything above the status row stays exactly where it is when the light changes state (live, waiting, stale, failed). This covers the light, the pane's top and the Now line, at every size tested (fix pass M2).
- A one-document failure changes nothing above or beside its line. The line was not laid out before (S6), so the content below glides down by its 68 px (`layoutStillOnDocumentFailure`).
- At 1440×900 the red leading edge stays above the fold (can't reach the service / sending stopped / reading stopped). With the control bar closed: 656 / 674 / 652 px. With it open: 760 / 778 / 756 px. They moved because the Sent strip left the sorting screen, and because the Now line keeps its height on a failure.

---

## 7. Motion spec

Easing:

- `text` = cubic-bezier(.2, .8, .2, 1), for text;
- `out` = cubic-bezier(.16, 1, .3, 1), for glides, rules and the surface;
- `roll` = cubic-bezier(.3, .7, .1, 1), for digits;
- `soft` = cubic-bezier(.22, 1, .36, 1), for bars (760 ms);
- `trace` = cubic-bezier(.45, .05, .2, 1), for the edge trace;
- `leave` = cubic-bezier(.2, .6, .4, 1), for the outgoing screen.

**Only transform, opacity and filter animate.** Filter is used only on the stage-heading words when a screen opens. There are no CSS transitions on any other property; hover and state colours change at once. The capture tests this rather than asserting it (`onlyTransformOpacityFilter`, §1 M6).

**Every motion is started by an event.** A screen opening, a count arriving, a state change, a click. The only repeating motion is the pulse. It has a finite iteration count that ends with the lease, and it runs only while the light is live. Nothing loops without an event: there is no canvas, and no requestAnimationFrame loop.

### 7.1 When text animates

| Trigger | What animates | What does not |
|---|---|---|
| A screen opens | Overline, heading words, Now, Next, facts, pane first lines | — |
| The meaning changes (phase, state, failure, waiting reason, lapse) | That sentence, state word or reason | Sentences whose key did not change |
| A number or time changes inside the same meaning | Nothing; the text is written in place ("just now" → "2 min ago") | The sentence and the reason |
| A count changes | The changed digits roll | The unchanged digits; the legend counts (written in place) |
| A phase changes the heading ("Sending" → "Sorting") | Only the changed words | "114 documents" |
| A failure | Rule, message, action | Everything else |

### 7.2 Text kinds

| Kind | From → to | Duration | Delay / stagger |
|---|---|---|---|
| **word** (heading on screen open) | opacity 0, +10 px, blur 4 px → 1, 0, 0 | 320 ms | 20 ms per word, at most 7 steps |
| **open** (header sentences, pane first lines) | opacity 0, +8 px → 1, 0 | 300 ms | Header items 24 ms apart; pane first lines 60 ms after their pane |
| **change** (meaning changed) | opacity 0, +4 px → 1, 0 | 260 ms | Reason 50 ms after the state word |
| **fail** | opacity 0, +3 px → 1, 0 | 180 ms | Message 0 ms, action 60 ms; the rule draws down from the top at 0 ms (scaleY 0 → 1, 220 ms). A one-document notice resolves as one line. |
| **list line** (Just read, What's happening now) | the new row: opacity 0 → 1; the list: translateY(−row) → 0 inside a still clip | 300 ms | 30 ms per new row (a +10 batch) |

### 7.3 Digit roll

- Compare the old and new values right-aligned. Unchanged digits stay plain text. Each changed digit becomes a box with an invisible placeholder holding both digits in one grid cell, so the box is as wide as the wider of the two (with tabular figures, both are 44.2 px at 95 px).
- The window is the numeral band measured from the font in use, from cap height to baseline. It has a hard clip 12% of the band beyond each edge and a static, steep fade in that margin. §1 explains why it is outside the band.
- The column moves one line: up when counting up (old leaves at the top, new arrives from below), down when counting down.
- 280 ms, `roll` easing. When several digits change, the right-hand one leads by 24 ms. No blur, no opacity change.
- A screen-reader copy of the new value sits beside it; the rolling parts are `aria-hidden`.
- When the roll ends the count is plain text again, in the same place (top and height within 0.5 px). A new value mid-roll cancels the roll and starts from the last true value.

### 7.4 Screen-open timeline (measured, Home → Read)

- **0–90 ms**: the old screen fades and drifts 20 px against the direction of travel (Start run: 140 ms). At 90 ms it is at opacity 0.
- **60 ms**: the overline, where shown.
- **80 ms**: the heading, word by word. At 240 ms the six words stand at 0.95 / 0.92 / 0.89 / 0.84 / 0.77 / 0.66.
- **150–246 ms**: the Now label, sentence, Next, facts, toggle.
- **150 ms + 45 ms per pane**: panes rise 10 px and slide 12 px (420 ms). Each pane's first line follows 60 ms later.
- **230 ms**: the pane that holds the screen's one action is traced once (720 ms). No other pane is traced.
- **Header settled: 500 ms. Everything settled: 950 ms.** No body-text blur (0 animations with filter outside the heading).
- A bar draws itself (rail 620 ms, tip, head) only the first time it is shown in a session.

### 7.5 Other motion

| Motion | Spec |
|---|---|
| Edge trace | A band 34% of the pane wide slides from −100% to 295% of its width (translateX; opacity 0 → 1 by 12%, 1 until 78%, then 0), behind a static 1.5 px ring mask just inside the border. 900 ms (720 ms on screen open), `trace` easing. Cyan; red on a failure; the system's own colour in the evidence drawer. |
| Surface growth | `.surf::after`: scaleY(old/new) → none, from the top, 320 ms, `out`. The trace ring copies it when a trace runs at the same time. |
| Bars | 760 ms `soft`. Segment scaleX; boundary and head translateX. Flare: opacity 0 → .9 → 0, 900 ms, 24 px wide. |
| Red beat | One ring from each red light and the node: scale 1 → 3.2 (1.9 on the node), opacity .95 → 0, 900 ms. |
| Tick | scale .6 → 1 with opacity 0 → 1, 200 ms, `out`. |
| Home | Loop stations fade in order (360 ms, 40 ms apart); the lit trail fades up (700 ms); runs and callouts follow (callouts rise 10 px). Then one ambient sweep: a 260 px line of light runs once along a lattice line on the side away from the text (translateX, 2400 ms, opacity in and out). None on load, on work screens, below 980 px, or under reduced motion. |
| Unchanged from round 2 | Spine advance, tab light, launch ignite, evidence drawer, Show filter, sheet |

### 7.6 Reduced motion

Triggered by the OS setting, or the prototype's Reduced toggle, at load or mid-session. No animation is created: 0 on load and 0 after +1, +10, Stall, Recover and Fail. The end states are identical (same counts, sentences and lights). Switching it on mid-session stops the pulse and finishes everything in flight.

| Motion | Reduced-motion final state |
|---|---|
| Text reveal, heading words | Present at once, opaque, sharp |
| Digit roll | The new number at once |
| Layout glide, list glide, surface growth | Content and the pane's edge in their new place at once |
| Live pulse | No ring. A cyan dot with its resting glow and the word Working / Sending / Reading. |
| Waiting | An 8 px dot inside a full-strength 18 px ring, no glow, and the word Waiting. Working is the full 12 px dot with its glow; Done is a hollow ring. They differ in form, not only in motion. |
| Red beat, red trace, red flare | Absent. The red dot, node, leading edge, rule and top edge are present at once. |
| Lease end | Unchanged: the words switch to "Not updated since …" and the stage mutes. This is a state, not a motion. |
| Screen change | Instant swap; focus on the heading |
| Ambient sweep, bar power-up, edge traces | None |

---

## 8. Mapping to the build (SPEC §2.1, §7)

Interaction semantics are unchanged.

| Here | For `ui/app/` |
|---|---|
| `Pulse` (lease, shared beat, settle, beat) | `ui/app/view/motion.ts`, driven by the merge of each poll |
| `Checks` (simulator) | Not built. It stands for the real poll. On each successful poll whose snapshot shows the run working, call `Pulse.confirm()` if an outcome changed within the quiet period; otherwise enter Waiting with the reported reason. A failed poll enters the failed state. |
| Quiet period | A UI setting with the owner's value (§5.3); it is not a run policy |
| `S.lastChange`, `resumeLight()`, `evidence()` | The time of the last new count comes from the snapshot (the latest outcome, document received or file read), never from when the page last heard back. A recovery (retry succeeded, continuation accepted, folder granted again) only renews the lease; if that time is older than the quiet period, the light enters Waiting. |
| `pipeGeom()` | `SortBar` geometry in pixels of its own width: minimum 7 px per non-zero outcome, the head's 10 px notch, redrawn on resize |
| `paintHome()` | The runs list card shows `runLight()`'s word and a still dot (no pulse, no action) |
| `paintStatus()` / `paintRun()` | A `StatusLight` component in the RunHeader and in each working pane's ActionBlock. The key is the state plus the waiting reason. |
| `setLive()`, `setHeading()` | Text helpers in `motion.ts`: they animate only when the key changes on an event, and are no-ops under reduced motion |
| `setNum()`, `numeralBand()`, `bandStyle()` | A `Count` component: tabular figures and the digit roll with the measured window |
| `setPipe()` (nested boundaries) | A `SortBar` component; the legend carries Being read and Waiting its turn; no head once finished |
| `flip()` with `.surf` / `listUpdate()` | A layout helper used by the FeedbackSlot and the list components |
| `trace()` | A one-shot edge light on the pane that holds the action or the failure |
| `.fail` block, `.notice`, `.sort__next` | FeedbackSlot variants: lasting failure (cause, then action and consequence), one-document notice (the pane's last line), finished (the next action beneath the light) |
| `wantNext()` / `syncNext()` | The Now line's Next, shown only when the primary is out of sight at the top of the page |
| Tokens | `ui/app/styles/tokens.css` as six-digit hex; the outcome colours follow the owner's choice (§3.3) |

---

## 9. Placeholder content

- Categories: Procedures, Explainers, Reports, Forms, Training.
- File names: generic ("Week 3 slides", "Fax copy", "Guide to the booking system"). No client names.
- Run numbers, times and counts are invented.

---

## 10. Evidence (run in this session)

**How to run it.** From the repo root:

```
$env:PATH = "$env:LOCALAPPDATA\Programs\node-v24.18.0-win-x64;$env:PATH"
python .local/qa/ui-rebuild/prototype-v3/contrast.py
node .local/qa/ui-rebuild/prototype-v3/capture.mjs
```

`CHECKS_ONLY=1` runs the assertions without re-shooting. It is for iterating only; the evidence is the plain run.

The capture ran in headless Edge 153.0.4234.48 over `file://`, using Playwright from `repo/node_modules`, with no network.

**Last run (`report.json`, fix pass round 1; 6 min 53 s).**

- 84 screen captures (21 screens × 2 themes × 1440 and 390, plus folds); 327 PNGs in total.
- 0 console errors or warnings.
- 0 external requests.
- 0 px horizontal overflow at 390 px on every screen, both themes.
- At most one visible primary on every screen.
- Jargon scan clean (now also "not yet tested").
- Rendered-text contrast minimum: 4.99 dark, 5.35 light, over 6,398 text nodes.
- Animations per event: +1 decided 8 (9 with a carry), a document fails 16, +1 sent 6, +1 file read 6, a status check 0.
- **51 of 51 checks pass.** The 11 fix-pass checks:
  - **`recoveryClaimsNoResult`** (M1)
  - **`lightStillAcrossStates`** (M2)
  - **`headClearOfSegments`** (M3)
  - **`amberRedApplies`** (M4)
  - **`stoppedWorkKept`** (S3)
  - **`sortingScreenOneBar`** (S5)
  - **`footerOnlyWhenItSaysSomething`** (S6)
  - **`readEvidenceWords`** (S7)
  - **`homeRunCardState`** (S8)
  - **`resultsNowIsNextStep`** (S10)
  - **`outcomeFillsOnTrack`** (spec deviation 1)

  Existing checks the fix pass extended:
  - `finishedLayout` (S1, S9)
  - `waitingReadsWithoutMotion` (S2)
  - `motionPerDocument` (S4: tick selectors in the removed-ornament scan)
  - `layoutStillOnDocumentFailure` (S6: the tallies glide by the line's height)
  - `cutVisibleAt390` (M3: the checkfail crops, the red gap, whole crops)

The round-3 checks follow (bold marks those new or rewritten in round 3):
  - `textStillUnlessMeaningChanges`
  - **`tabularCounts`**
  - **`digitRoll`** (numeral window, soft edge 0.12 of the band, box width)
  - **`motionPerDocument`** (≤ 12 per +1; 8 measured)
  - **`onlyTransformOpacityFilter`** (keyframes, CSS transitions, declared transitions, no loops)
  - **`staleIsHonest`**
  - **`stageMutedWhileFailed`**
  - **`finishedLayout`**
  - **`sendingShowsNoZeros`**
  - **`failureAboveFoldAndSurfaceGrows`**
  - `layoutStillOnDocumentFailure`
  - `eachFailureSaidOnce` (now: no digit in any failure's Now line)
  - **`oneColourForFailedDocuments`**
  - `redOnlyWhenFailed`
  - `simulatedStatusChecks`
  - **`relativeTimeAndQuietChoice`**
  - `quietPeriodWaiting`
  - `pulseLease`
  - `reducedMotion`
  - `reducedMotionMidSession`
  - `reducedToggle`
  - `waitingReadsWithoutMotion`
  - **`phone`**
  - **`cutVisibleAt390`**
  - `redOnFailure_dark`
  - `redOnFailure_light`
  - `failureTextFastest`
  - **`screenOpen`** (one trace; bar drawn once)
  - `livePause` (now: stage muted)
  - **`ambientSingleSweep`**
  - `stillWhenNothingMoves`
  - `confirmBlockers`
  - **`copyHeaderAndAmberChoices`**
  - `keyboardFocus_results`
  - `keyboardFocus_live-checkfail`
  - **`keyboardFocus_live-done`**
  - `sheet`
  - `resultsSearch`
  - `phoneFacts`
  - `amberImage`
  - Plus the fonts record.

**Files in `.local/qa/ui-rebuild/prototype-v3/`.**

- `<screen>-<theme>-<1440|390>.png` is the full page; `…-fold.png` is the first screen height. New in round 3: `live-amber-red`, and folds of `live-done`. Fix pass: `live-amber-red-*` now really shows Proposed B.
- `pipe-cut-390-{dark,light}.png`: the 2 px cut at 4×, with the 1-document red segment and the head in its own notch. New in the fix pass: `pipe-cut-390-checkfail-{dark,light}.png`, the same bar under Can't reach the service, where the red head stands clear of the red segment.
- `amber-decision.png` (from `amber.html`): the three-way outcome-colour comparison.
- `report.json` (every assertion) and `contrast.json`.
- **Frame sequences.** These are taken at 0, 120, 240, 400 and 700 ms after the event; `count-roll` and `count-roll-carry` use 0, 60, 120, 180 and 280/300 ms. Animations are paused and seeked, so the frames are exact. Each sequence has full 1440×900 frames (`-f0…f4`) and 2× crops:

  | Sequence | What it shows |
  |---|---|
  | `indicator-live`, `indicator-live-light` | The pulse on +1 decided; the digit rolls; one segment, one boundary and the head move; the 24 px flare stays inside the bar (`-bar-` crop) |
  | `indicator-fail`, `indicator-fail-light` | Can't reach the service; rule and message by 120 ms; the surface grows; the stage mutes |
  | `send-fail` | Sending stops |
  | `doc-fail` | The notice in the last line; the red flare inside the bar; count 73 → 74 and tally 1 → 2 (`-count-`, `-tally-` crops) |
  | `waiting` | Stall: the glow goes out, the dot draws in to 8 px and the full-strength ring settles (still settling at 700 ms, the last frame) |
  | `text-screen` | Home → Read: one traced pane |
  | `text-status` | +1: the header stays still, the count rolls |
  | `text-meaning` | Working → Waiting: the sentence and the state words resolve in |
  | `count-roll`, `count-roll-carry` | The digit roll close up (73 → 74; 79 → 80) |
  | `loading-bar` | +10 files read |

**What this evidence does not show.**

- Smoothness on an ordinary office laptop. No frame-rate measurement was taken.
- A non-technical person reading the light and the failure words correctly without coaching. That is the acceptance test (SPEC §10.4).
- The owner's view of the pulse strength, the amount of red, the soft edge of the roll, and their choices of quiet period (90 s or 3 min) and outcome colours (Current, A or B).
- Screen-reader output. Roles and live-region text are set, but no screen reader was run.
- Widths and heights other than those listed in `lightStillAcrossStates`. A scratch sweep (21 widths from 360 to 1366, and 10 sizes down to 360×640) also found 0 px, but it is not part of the harness.
