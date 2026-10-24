import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Observation } from '../src/core/observation/model.ts'
import type { VignetteValue } from '../src/features/displays/compose/model.ts'
import { safetyFunctionReading } from '../src/packs/process-plant/observation/safety-function-reading.ts'
import type { SafetyFunctionEvaluation } from '../src/packs/process-plant/safety-functions.ts'
import { frameLayout } from '../src/ui/embed/vignette/grid.ts'
import { tripFit, tripWidth } from '../src/ui/embed/vignette/trip-fit.ts'
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
    // A meaning too long to stand beside the question that decided it gives way by whole words, never that question.
    const decided = safetyFunctionReading(evaluation({ status: 'yellow', procedure: 'FR-H.5', meaning: 'A steam generator\'s narrow-range level is below span while feed holds the heat sink. '.repeat(4), path: long.slice(0, 2) })).why!
    expect(decided.length).toBeLessThanOrEqual(300)
    expect(decided).toContain('Question 1 about a steam generator\'s narrow-range level on span: yes (SG-1-LVL-NR 55.0 %) · YELLOW · FR-H.5: A steam generator')
    expect(decided.endsWith('…')).toBe(true)
  })
})

describe('the window frame by its width (W4.3)', () => {
  // The whole-plant drawing is 1488 px; beside it, 16 px and the 360 px column.
  test('side by side where drawing and column fit; until it is measured, as composed', () => {
    expect(frameLayout({ width: 1864, drawingWidth: 1488, drawn: 1, zoom: 1 })).toEqual({ kind: 'beside' })
    expect(frameLayout({ width: 0, drawingWidth: 1488, drawn: 1, zoom: 1 })).toEqual({ kind: 'beside' })
  })

  test('narrower, the column goes first as a band; the drawing stands whole where it fits', () => {
    expect(frameLayout({ width: 1863, drawingWidth: 1488, drawn: 1, zoom: 1 })).toEqual({ kind: 'band', drawing: 'whole' })
    expect(frameLayout({ width: 1488, drawingWidth: 1488, drawn: 1, zoom: 1 })).toEqual({ kind: 'band', drawing: 'whole' })
  })

  test('scaled to the width only where its whole fits with its text at 11 px or more on screen; else it scrolls, never both', () => {
    expect(frameLayout({ width: 1400, drawingWidth: 1488, drawn: 1, zoom: 1 })).toEqual({ kind: 'band', drawing: 'scaled', scale: 1400 / 1488 })
    // At the window's 92 % its 12 px text is already 11 px: any further scale would go below the floor.
    expect(frameLayout({ width: 1400, drawingWidth: 1488, drawn: 1, zoom: 0.917 })).toEqual({ kind: 'band', drawing: 'scrolled' })
    expect(frameLayout({ width: 1030, drawingWidth: 1488, drawn: 1, zoom: 1 })).toEqual({ kind: 'band', drawing: 'scrolled' })
    // A drawing its rows already show at 95 % (1488 px wide at it) has that much less to give: 94 % more would take its text to 10.7 px.
    expect(frameLayout({ width: 1400, drawingWidth: 1488, drawn: 0.95, zoom: 1 })).toEqual({ kind: 'band', drawing: 'scrolled' })
    expect(frameLayout({ width: 1460, drawingWidth: 1488, drawn: 0.95, zoom: 1 })).toEqual({ kind: 'band', drawing: 'scaled', scale: 1460 / 1488 })
  })
})

const source = (file: string): string => readFileSync(join(import.meta.dir, '../src/ui/embed/vignette', file), 'utf8')

describe('a table of parallel values (W1.4 table, plan v5 §2 rule 2)', () => {
  test('its values take their room first and are never cut; names, headings and chips give way; it stands exactly in its rows', () => {
    const table = source('GroupedValues.svelte')
    // Each value column at least as wide as its widest value, the names' column what the values leave.
    expect(table).toContain('grid-template-columns: minmax(0, max-content) repeat(var(--columns), minmax(min-content, 1fr))')
    // A heading never widens its column: its name over its unit, the name giving way by whole words, the whole in its title.
    expect(table).toMatch(/\.heading \{ contain: inline-size;/)
    expect(table).toContain('use:wholeWords={heading.name}')
    expect(table).toContain('title={whole} aria-label={whole}')
    // A hairline inside its line, never a border: the table is its rows' height.
    expect(table).toContain('box-shadow: inset 0 1px 0 var(--border-divider-color)')
    expect(table).not.toMatch(/border-(top|bottom)/)
    // In a cell the value stands at the right and its chip, left of it, wraps out of the row where both do not fit.
    expect(source('Readout.svelte')).toMatch(/\.cell \{ flex-direction: row-reverse; flex-wrap: wrap;[^}]*overflow: hidden; \}\n\s*\.cell \.reading \{ order: -1; \}/)
  })
})

describe('the trip line on its one row (W2.4, plan v5 §2 rules 2 and 4)', () => {
  // Run A's parts at 13 px: TURB TRIP with its age 123 px, RX TRIP 105, a separator with its gaps 16, "+1" 14, the
  // actuations listed ("ACTUATED: AFW START · FWI") 227, counted ("ACTUATED: 2") 95. The messages give way before any
  // of these, so the fit weighs these alone.
  const runA = { leads: [123, 105], actuated: { listed: 227, counted: 95 }, more: 14, sep: 16 }

  test('everything where it fits; else the actuations counted; else the later leads as "+n"; the first lead always stands', () => {
    expect(tripWidth(runA, { leads: 2, counted: false })).toBe(123 + 16 + 105 + 16 + 227)
    expect(tripFit(runA, 1030)).toEqual({ leads: 2, counted: false })
    expect(tripFit(runA, 487)).toEqual({ leads: 2, counted: false })
    expect(tripFit(runA, 486)).toEqual({ leads: 2, counted: true })
    expect(tripFit(runA, 355)).toEqual({ leads: 2, counted: true })
    expect(tripFit(runA, 354)).toEqual({ leads: 1, counted: true })
    expect(tripWidth(runA, { leads: 1, counted: true })).toBe(123 + 16 + 14 + 16 + 95)
    // Narrower still nothing more gives way: the first lead, "+1" and the count stand, the row clips its end.
    expect(tripFit(runA, 200)).toEqual({ leads: 1, counted: true })
  })

  test('without actuations the later leads fold from the last; with actuations alone they are counted', () => {
    const three = { leads: [100, 100, 100], actuated: null, more: 14, sep: 16 }
    expect(tripFit(three, 332)).toEqual({ leads: 3, counted: false })
    expect(tripFit(three, 246)).toEqual({ leads: 2, counted: false })
    expect(tripFit(three, 245)).toEqual({ leads: 1, counted: false })
    expect(tripFit({ leads: [], actuated: { listed: 227, counted: 95 }, more: 14, sep: 16 }, 100)).toEqual({ leads: 0, counted: true })
  })

  test('a lead never shrinks below its measured label and age, so nothing draws over its neighbour', () => {
    const trip = source('TripLine.svelte')
    expect(trip).not.toMatch(/\.lead \{[^}]*min-width: 0/)
    expect(trip).toContain('style:min-width={widths === null ? undefined : `${widths.leads[index]}px`}')
    expect(trip).toContain('tripFit(widths, room)')
  })
})

describe('a criterion\'s checks not yet met (W1.4)', () => {
  test('give way by whole words, the whole list kept in the title and for assistive technology; a lone "…" shows nothing', () => {
    const row = source('CriterionRow.svelte')
    expect(row).toContain('<span class="detail" aria-hidden="true" use:wholeWords={look.detail ?? \'\'}></span>')
    expect(row).toContain('<span class="full">{look.detail}</span>')
    // A lone "…", or part of a first word, shows nothing (wholeWordsThatFit; vignette-column tests it at every width).
    expect(readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/fit-words.ts'), 'utf8')).toContain('node.textContent = wholeWordsThatFit(full,')
  })
})
