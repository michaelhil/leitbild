---
name: operator-displays
description: Composes a small live operator display (trends, loop comparisons, readouts and related alarms of Process Plant signals, with I&C alarm and trip thresholds) and shows it below the answer. Use after analysing a live Process Plant situation when the operator's next decision depends on how values are changing or how close they are to alarm or trip thresholds - for example transients, trips, active alarms, degraded or unexpected equipment states, heatup, cooldown or power changes, and procedure steps awaiting a plant response - and whenever the user asks to show, trend, plot, compare or watch plant data. Skip for single current values, explanations, product, wiki or scenario-authoring questions, requests for text only, and situations an earlier display in this conversation already covers.
allowed-tools: [workspace_explore, workspace_call]
---

A display is a small live panel set that the Process Plant module validates, lays out and keeps current below your answer. You decide what the operator must see and why; the module takes units, scales, alarm and trip thresholds, colours and layout from the plant model. Composing a display is read-only: it changes no Plant, Run or scenario state and needs no confirmation.

## Decide

Show at most one display per answer, and only when change over time or margin to a threshold matters for the operator's next action. A display complements a short answer; it never replaces your analysis. If a display earlier in this conversation still answers the question, refer to it instead of composing another.

## Plan

Fill the plan fields of `world.process-plant.display.compose` before choosing signals:

- `question`: what the operator should be able to answer at a glance.
- `need`: the decision or watch the display supports.
- each signal's `role`: `primary` for what the question is about, `context` for comparison (for example the healthy loop), `counter-evidence` for a signal that would look different if your diagnosis were wrong. Include one whenever you state a diagnosis.

Prefer the smallest display that answers the question, usually one trend, using exact tagIds or paths from the evidence you analysed. Panels (at most four):

- `trend`: how one to three numeric signals of one unit are changing. Choose the horizon by how fast they move: `2m` for fast pressure or power transients, `10m` for most levels and temperatures, `30m` for slow drifts. A second trend with the same horizon stacks a related signal in another unit, such as feed flow under a level.
- `comparison`: which of two to six parallel signals of one unit differs, such as the loops.
- `readouts`: current values or on/off states with margin to alarm and trip thresholds, such as pumps running or valve positions.
- `alarms`: active alarms acting on the displayed signals (`related`) or in the whole unit (`plant`); add it only next to signal panels.

Never supply numbers, limits, setpoints, forecasts, colours or positions; there are no fields for them. Never draw plant state as a Mermaid or other hand-written diagram: it would be neither live nor validated.

## Compose

1. Call `world.process-plant.display.compose` through `workspace_call` with the exact Run target and `plantId` you analysed. It is a read, so it can be batched with your other reads.
2. A rejection stores nothing and lists every issue with `Did you mean` suggestions. Fix all of them and call again. After two rejections, answer in text and say in one sentence that no display could be produced.

## Present

Write the answer first, then end it with this block, copying `viewRef` from the compose result exactly:

```leitbild-view
view <viewRef>
```

Keep the text to the assessment, the decisive values with their simulation time, and the recommended action or what to watch next. The display already shows the trends, current values, thresholds and alarms listed in the result's `shows`; refer to it ("see the trend below") instead of listing them again.
