---
name: operator-displays
description: Composes a small live operator display (trends, loop comparisons, readouts, an equipment mimic of any flow path, system or power supply, and related alarms of Process Plant signals, with I&C alarm and trip thresholds) and shows it below the answer. Use after analysing a live Process Plant situation when the operator's next decision depends on how values are changing, how close they are to alarm or trip thresholds, or which equipment runs and where flow or power goes - for example transients, trips, active alarms, degraded or unexpected equipment states, line-ups, heatup, cooldown or power changes, and procedure steps awaiting a plant response - and whenever the user asks to show, trend, plot, compare or watch plant data. Skip for single current values, explanations, product, wiki or scenario-authoring questions, requests for text only (still answer from current plant data), and situations an earlier display in this conversation already covers.
allowed-tools: [workspace_explore, workspace_call]
---

A display is a small live panel set that the Process Plant module validates, lays out and keeps current below your answer. You decide what the operator must see and why; the module takes units, scales, thresholds, symbols, colours and layout from the plant model. Composing is read-only and needs no confirmation.

## Decide

Show at most one display per answer, and only when change over time, margin to a threshold, or which equipment runs and where flow goes matters for the operator's next action. A display complements a short answer, never replaces your analysis. If an earlier display still answers the question, refer to it.

## Plan

Fill `question` (what the operator should answer at a glance) and `need` (the decision or watch it supports), and give each signal a `role`: `primary` for what the question is about, `context` for comparison (such as the healthy loop), `counter-evidence` for a signal that would look different if your diagnosis were wrong; include one whenever you state a diagnosis.

Start from the panel that answers the question, usually one trend of the signals it is about, using exact tagIds or paths from your evidence. Add a panel only for a part of the question it cannot answer; never repeat a trended signal as a readout. Most answers need one or two panels (at most three):

- `trend`: how two to four signals change. Put them all in one trend: the module gives each measurement its own strip on one time axis (parallel equipment, such as the four SG levels, shares one), at most four strips of four signals; signals the Run does not record show as current values. Horizon: `2m` for fast pressure or power transients, `10m` for most levels and temperatures, `30m` for slow drifts.
- `comparison`: which of two to six parallel signals of one unit differs, such as the loops.
- `readouts`: current values or on/off states with margin to alarm and trip thresholds.
- `mimic`: which equipment runs, is open or energized and where flow or power goes, when the answer depends on that (a pump trip, a stuck valve, whether feed or power arrives). The module generates it from the model. Name equipment by id, a tag measured on it or its short label: `from` and `to` draw every route between them, `to` alone what feeds an item, `from` alone where it goes; `services` (`feedwater`, `auxFeedwater`, `safetyInjection`, `electricalPower`…) with optional `loops` draws those systems or narrows a route, e.g. `{"kind":"mimic","to":["sgB"],"services":["feedwater","auxFeedwater"]}`. For a one-loop fault draw it and one healthy peer. It draws actual states and disagreeing commands: add no readout of drawn equipment; never use it for one state, a trended value or a loop comparison.
- `alarms`: active alarms of the displayed signals and equipment (`related`) or of the whole unit (`plant`), only next to other panels.

Size: next to a three- or four-measurement trend add only `alarms`; next to two, at most `alarms` and three readouts. A mimic leads its display: next to it add `alarms` and at most a one- or two-measurement trend.

Never supply numbers, limits, setpoints, forecasts, colours or positions; there are no fields for them. Never draw equipment or state yourself (Mermaid, ASCII or any diagram): it would be neither live nor validated.

## Compose

1. Call `world.process-plant.display.compose` through `workspace_call` with the exact Run target and `plantId` you analysed; it is a read and can be batched with others. A typical input is one trend: `{"plantId":"plant:halden-2","title":"SG B level","question":"Is SG B level recovering?","need":"Decide on manual feed","panels":[{"kind":"trend","horizon":"10m","signals":[{"ref":"SG-B-LVL-NR","role":"primary"},{"ref":"SG-A-LVL-NR","role":"context"}]}]}`.
2. A rejection stores nothing and lists every issue with `Did you mean` names and fixes known to fit. Apply them all and call again. After two rejections, answer in text and say in one sentence that no display could be produced.

## Present

Write the answer first, then end it with this block, copying `viewRef` from the compose result exactly:

```leitbild-view
view <viewRef>
```

With a display, write at most four plain sentences, under 80 words, before the block: the assessment, the one or two decisive values or states, and the action or what to watch next. Base what to watch on `margins`, the nearest alarm or trip limit of each value now. The display shows everything in `shows`; point to it ("see the mimic below") instead of restating it. Name signals and thresholds as `shows` does (such as "LO ALM 30 %"), and state equipment only as `equipment` gives it, never from a command. Give times as `simulationClock` (sim hh:mm:ss) and say "current", not "live". `warnings` are for you; mention one only if it changes the operator's conclusion.
