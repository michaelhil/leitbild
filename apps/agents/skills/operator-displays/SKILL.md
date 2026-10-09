---
name: operator-displays
description: Composes a small live operator display (trends, loop comparisons, readouts, equipment mimics and related alarms of Process Plant signals, with I&C alarm and trip thresholds) and shows it below the answer. Use after analysing a live Process Plant situation when the operator's next decision depends on how values are changing or how close they are to alarm or trip thresholds - for example transients, trips, active alarms, degraded or unexpected equipment states, heatup, cooldown or power changes, and procedure steps awaiting a plant response - and whenever the user asks to show, trend, plot, compare or watch plant data. Skip for single current values, explanations, product, wiki or scenario-authoring questions, requests for text only (still answer from current plant data), and situations an earlier display in this conversation already covers.
allowed-tools: [workspace_explore, workspace_call]
---

A display is a small live panel set that the Process Plant module validates, lays out and keeps current below your answer. You decide what the operator must see and why; the module takes units, scales, thresholds, colours and layout from the plant model. Composing a display is read-only: it changes no Plant, Run or scenario state and needs no confirmation.

## Decide

Show at most one display per answer, and only when change over time or margin to a threshold matters for the operator's next action. A display complements a short answer; it never replaces your analysis. If a display earlier in this conversation still answers the question, refer to it instead of composing another.

## Plan

Fill the plan fields of `world.process-plant.display.compose` before choosing signals:

- `question`: what the operator should be able to answer at a glance.
- `need`: the decision or watch the display supports.
- each signal's `role`: `primary` for what the question is about, `context` for comparison (for example the healthy loop), `counter-evidence` for a signal that would look different if your diagnosis were wrong. Include one whenever you state a diagnosis.

Start from one trend of the signals the question is about, using exact tagIds or paths from the evidence you analysed. Add another panel only for a part of the question that trend cannot answer, and do not repeat a trended signal as a readout. Most answers need one or two panels. Panels (at most three):

- `trend`: how the signals the question is about are changing, usually two to four. Put them all in one trend: the module gives each measurement its own strip on a shared time axis (the same measurement on parallel equipment, such as the four SG levels, shares one), at most four strips of four signals. Signals the Run does not record appear as current values beside the trend. Choose the horizon by how fast they move: `2m` for fast pressure or power transients, `10m` for most levels and temperatures, `30m` for slow drifts.
- `comparison`: which of two to six parallel signals of one unit differs, such as the loops.
- `readouts`: current values or on/off states with margin to alarm and trip thresholds.
- `mimic`: which equipment runs, is open or carries flow, when the answer depends on that (a pump trip, a stuck valve, whether feed reaches a steam generator). View `feed-to-sg` draws main and auxiliary feedwater pumps, headers and valves into the steam generators; `"loops":["B"]` limits it. It draws actual states and any disagreeing command, so add no readout of its pumps or valves. Never use it to illustrate a trended value.
- `alarms`: active alarms of the displayed signals and their equipment (`related`) or of the whole unit (`plant`); add it only next to signal or mimic panels.

Each measurement makes the trend taller: next to three or four measurements add only `alarms`; next to two, at most `alarms` and three readouts. A mimic is tall: next to it, add a one-measurement trend and `alarms`, or a two-measurement trend.

Never supply numbers, limits, setpoints, forecasts, colours or positions; there are no fields for them. Never draw plant state as a Mermaid or other hand-written diagram: it would be neither live nor validated.

## Compose

1. Call `world.process-plant.display.compose` through `workspace_call` with the exact Run target and `plantId` you analysed. It is a read, so it can be batched with your other reads. A typical input is one trend: `{"plantId":"plant:halden-2","title":"SG B level","question":"Is SG B level recovering?","need":"Decide on manual feed","panels":[{"kind":"trend","horizon":"10m","signals":[{"ref":"SG-B-LVL-NR","role":"primary"},{"ref":"SG-A-LVL-NR","role":"context"}]}]}`.
2. A rejection stores nothing and lists every issue with `Did you mean` suggestions. Fix all of them and call again. After two rejections, answer in text and say in one sentence that no display could be produced.

## Present

Write the answer first, then end it with this block, copying `viewRef` from the compose result exactly:

```leitbild-view
view <viewRef>
```

With a display, write at most four plain sentences, under 80 words, before the block: the assessment, the one or two decisive values, and the action or what to watch next. Base what to watch on the result's `margins`, which name each signal's nearest alarm or trip limit now. The display shows everything in the accepted result's `shows`; point to it ("see the trend below") instead of restating those values or thresholds. Name signals and thresholds as `shows` does (such as "LO ALM 30 %"), give times as the result's `simulationClock` (sim hh:mm:ss, never elapsed time), and say "current" rather than "live", since the Run may be paused. `warnings` are for you; mention one only if it changes the operator's conclusion.
