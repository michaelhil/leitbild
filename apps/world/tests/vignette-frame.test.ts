import { describe, expect, test } from 'bun:test'
import type { Observation } from '../src/core/observation/model.ts'
import type { VignetteValue } from '../src/features/displays/compose/model.ts'
import { safetyFunctionReading } from '../src/packs/process-plant/observation/safety-function-reading.ts'
import type { SafetyFunctionEvaluation } from '../src/packs/process-plant/safety-functions.ts'
import { frameLayout } from '../src/ui/embed/vignette/grid.ts'
import { chipOrder, stateChipLook } from '../src/ui/embed/vignette/state-chip.ts'

// A vignette's frame (plan v5 W4.1, W4.3, W8.1): an object's own states as
// compact chips on its title row, the per-sample pointer and path the Plant
// reads them with, and the window frame's layout by its width.

const at = '2026-10-22T10:00:00.000Z'
const observation = (ref: string, value: Observation['value'], extra: Partial<Observation> = {}): Observation =>
  ({ ref, at, clock: 'simulation', value, quality: 'good', priority: 'none', ...extra })

const statuses = ['green', 'yellow', 'orange', 'red', 'unknown', 'not-monitored'].map(value => ({ value, label: value === 'not-monitored' ? 'NOT JUDGED' : value.toUpperCase() }))
const heatSink: VignetteValue = {
  ref: 'unit-1#csf.heat-sink', label: 'Unit 1 · Heat sink (CSF)', shortLabel: 'HEAT SINK', quantity: 'state', unit: '', valueType: 'enum',
  states: statuses, thresholds: [], series: null, decidingElement: 'sgA',
}
const mode: VignetteValue = {
  ref: 'unit-1#mode', label: 'Unit 1 · Operating mode', quantity: 'state', unit: '', valueType: 'enum',
  states: [{ value: 'hotStandby', label: 'Hot standby' }], thresholds: [], series: null,
}

describe('own-state chips (W4.1)', () => {
  test('satisfied, a chip is its short label alone, neutral; its title says what it reads and why', () => {
    const look = stateChipLook(heatSink, observation(heatSink.ref, 'green', { why: 'GREEN: the heat sink is satisfied.' }), 'Unit 1', false)
    expect(look).toMatchObject({ text: 'HEAT SINK', tone: null, mark: null, doubtful: false, emphasis: false, label: 'Heat sink (CSF): GREEN' })
    expect(look.title).toBe('Heat sink (CSF): GREEN\nGREEN: the heat sink is satisfied.')
  })

  test('challenged, it is filled at its priority and names where it sends people, else its state word: colour is never the only cue', () => {
    expect(stateChipLook(heatSink, observation(heatSink.ref, 'red', { priority: 'alarm', note: 'FR-H.1' }), 'Unit 1', false))
      .toMatchObject({ text: 'HEAT SINK · FR-H.1', tone: 'alarm', label: 'Heat sink (CSF): RED · FR-H.1' })
    expect(stateChipLook(heatSink, observation(heatSink.ref, 'yellow', { priority: 'caution' }), 'Unit 1', false)).toMatchObject({ text: 'HEAT SINK · YELLOW', tone: 'caution' })
    // Emergency draws as alarm: OpenBridge's status indicator has none (register deviation own-state-emergency-as-alarm).
    expect(stateChipLook(heatSink, observation(heatSink.ref, 'red', { priority: 'emergency' }), 'Unit 1', false).tone).toBe('alarm')
    // A notice is bold without a hue, and says its word.
    expect(stateChipLook(heatSink, observation(heatSink.ref, 'yellow', { priority: 'notice' }), 'Unit 1', false)).toMatchObject({ text: 'HEAT SINK · YELLOW', tone: null, emphasis: true })
  })

  test('not known reads dashed with "?"; outside its validity dashed with "—"; neither takes a colour or a pointer', () => {
    expect(stateChipLook(heatSink, observation(heatSink.ref, 'unknown', { quality: 'uncertain', note: 'FR-H.1', priority: 'alarm' }), 'Unit 1', false))
      .toMatchObject({ text: 'HEAT SINK ?', mark: 'unknown', tone: null, label: 'Heat sink (CSF): not known' })
    expect(stateChipLook(heatSink, undefined, 'Unit 1', false)).toMatchObject({ text: 'HEAT SINK ?', mark: 'unknown' })
    expect(stateChipLook(heatSink, observation(heatSink.ref, 'not-monitored', { quality: 'not-applicable' }), 'Unit 1', false))
      .toMatchObject({ text: 'HEAT SINK —', mark: 'outside', tone: null, label: 'Heat sink (CSF): —' })
  })

  test('a state that declares no short label reads as its word alone (an operating mode), its name in the title', () => {
    expect(stateChipLook(mode, observation(mode.ref, 'hotStandby'), 'Unit 1', false)).toMatchObject({ text: 'Hot standby', tone: null, label: 'Operating mode: Hot standby' })
    expect(stateChipLook(mode, undefined, 'Unit 1', false)).toMatchObject({ text: 'Operating mode ?', mark: 'unknown' })
  })

  test('stale, or its display frozen, it is doubtful (the low-integrity style) and keeps its words', () => {
    expect(stateChipLook(heatSink, observation(heatSink.ref, 'red', { priority: 'alarm', note: 'FR-H.1' }), 'Unit 1', true)).toMatchObject({ text: 'HEAT SINK · FR-H.1', doubtful: true })
    expect(stateChipLook(heatSink, observation(heatSink.ref, 'green', { quality: 'stale' }), 'Unit 1', false)).toMatchObject({ doubtful: true, title: 'Heat sink (CSF): GREEN\nquality: stale' })
  })

  test('the states that read as their word alone stand first, the others as declared', () => {
    const subcrit = { ...heatSink, ref: 'unit-1#csf.subcriticality', shortLabel: 'SUBCRIT' }
    expect(chipOrder([subcrit, heatSink, mode]).map(chip => chip.ref)).toEqual([mode.ref, subcrit.ref, heatSink.ref])
  })
})

describe('the safety function reading (W4.1, per sample)', () => {
  const step = (question: string, answer: 'yes' | 'no', signal: string, value: number) =>
    ({ question, basis: '', answer, comparisons: [{ reads: [{ signal, path: signal, label: signal, value, unit: 'percent' }], operator: '>' as const, threshold: 10, unit: 'percent', answer }] })
  const evaluation = (fields: Partial<SafetyFunctionEvaluation>): SafetyFunctionEvaluation => ({
    id: 'heat-sink', label: 'Heat sink', shortLabel: 'HEAT SINK', basis: '', status: 'green', meaning: 'The heat sink is satisfied.', path: [], checks: [], expected: [], missingSignals: [], ...fields,
  })

  test('challenged: coloured at its challenge, its procedure the pointer, its path with the readings that answered each question', () => {
    expect(safetyFunctionReading(evaluation({ status: 'red', procedure: 'FR-H.1', meaning: 'No feed.', path: [step('Level above 10 % in a steam generator', 'no', 'SG-A-LVL-NR', 4.2)] }))).toEqual({
      value: 'red', quality: 'good', priority: 'alarm', note: 'FR-H.1', why: 'Level above 10 % in a steam generator: no (SG-A-LVL-NR 4.20 %) · RED · FR-H.1: No feed.',
    })
  })

  test('not judged reads outside its validity; one that cannot be judged is uncertain; satisfied has no pointer', () => {
    expect(safetyFunctionReading(evaluation({ status: 'not-monitored', meaning: 'Judged once a trip is demanded.' }))).toEqual({ value: 'not-monitored', quality: 'not-applicable', priority: 'none', why: 'NOT JUDGED: Judged once a trip is demanded.' })
    expect(safetyFunctionReading(evaluation({ status: 'unknown' }))).toMatchObject({ quality: 'uncertain', priority: 'none' })
    expect(safetyFunctionReading(evaluation({})).note).toBeUndefined()
  })

  test('within 300 characters the earliest questions give way first, so what the path ends in is always said', () => {
    const long = Array.from({ length: 8 }, (_, at) => step(`Question ${at} about a steam generator's narrow-range level on span`, 'yes', `SG-${at}-LVL-NR`, 55))
    const why = safetyFunctionReading(evaluation({ path: long })).why!
    expect(why.length).toBeLessThanOrEqual(300)
    expect(why.startsWith('… · ')).toBe(true)
    expect(why.endsWith('GREEN: The heat sink is satisfied.')).toBe(true)
    expect(why).toContain('Question 7')
  })
})

describe('the window frame by its width (W4.3)', () => {
  // The whole-plant drawing is 1488 px; beside it, 16 px and the 360 px column.
  test('side by side where drawing and column fit; until it is measured, as composed', () => {
    expect(frameLayout({ width: 1864, drawingWidth: 1488, zoom: 1 })).toEqual({ kind: 'beside' })
    expect(frameLayout({ width: 0, drawingWidth: 1488, zoom: 1 })).toEqual({ kind: 'beside' })
  })

  test('narrower, the column goes first as a band; the drawing stands whole where it fits', () => {
    expect(frameLayout({ width: 1863, drawingWidth: 1488, zoom: 1 })).toEqual({ kind: 'band', drawing: 'whole' })
    expect(frameLayout({ width: 1488, drawingWidth: 1488, zoom: 1 })).toEqual({ kind: 'band', drawing: 'whole' })
  })

  test('scaled to the width only where its whole fits with its text at 11 px or more on screen; else it scrolls, never both', () => {
    expect(frameLayout({ width: 1400, drawingWidth: 1488, zoom: 1 })).toEqual({ kind: 'band', drawing: 'scaled', scale: 1400 / 1488 })
    // At the window's 92 % its 12 px text is already 11 px: any further scale would go below the floor.
    expect(frameLayout({ width: 1400, drawingWidth: 1488, zoom: 0.917 })).toEqual({ kind: 'band', drawing: 'scrolled' })
    expect(frameLayout({ width: 1030, drawingWidth: 1488, zoom: 1 })).toEqual({ kind: 'band', drawing: 'scrolled' })
  })
})
