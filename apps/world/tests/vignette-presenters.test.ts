import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AlertState } from '../src/core/model/alerts.ts'
import type { ObjectId } from '../src/core/model/ids.ts'
import type { Observable, Observation } from '../src/core/observation/model.ts'
import { unacknowledged, type AlertRow } from '../src/features/displays/alerts/rows.ts'
import { alertDetail, alertIcon, alertsTarget, alertTitle, detailText, fitRow, inSection, rowParts, rowWidth, UNACK_WORD, wordsThatFit, worstChip } from '../src/ui/embed/vignette/alerts.ts'
import { provenanceMark, provenanceMarks, quantityText } from '../src/ui/embed/vignette/format.ts'
import type { VignetteValue } from '../src/features/displays/compose/model.ts'
import { activeState, orderWord, readingLook, valueLook } from '../src/ui/embed/vignette/readout.ts'
import { appendPoint, bandStretches, LABEL_LINE, labelRows, labelWidth, rateNow, rateText, sharedLines, stackLabels, stepPath, stripDrawing, stripDomain, timeTicks } from '../src/ui/embed/vignette/trend.ts'
import { recordedHoldMs } from '../src/features/historian/policy.ts'
import { stripRows, stripsOf, trendRows } from '../src/features/displays/compose/strips.ts'

// The vignette renderer's presenters (architecture B1): the limit chip, the
// step-and-hold trace, the limits a strip shares, neutral values without an
// observation priority, and "priority not declared".

type Threshold = Observable['thresholds'][number]
const threshold = (id: string, direction: 'low' | 'high', order: number, value: number, extra: Partial<Threshold> = {}): Threshold =>
  ({ id, direction, order, value, effect: 'alarm', priority: 'warning', ...extra })

const level: VignetteValue = {
  ref: 'unit-1#level', label: 'Unit 1 · Vessel level', quantity: 'level', unit: '%', valueType: 'number',
  thresholds: [threshold('lo', 'low', 1, 30), threshold('lolo', 'low', 2, 20, { effect: 'trip', priority: 'alarm', consequence: 'unit trip' }), threshold('hi', 'high', 1, 80)],
  series: { seriesId: 'unit-1.level', intervalMs: 1_000 },
}
const at = '2026-10-21T10:00:00.000Z'
const observation = (ref: string, value: Observation['value'], extra: Partial<Observation> = {}): Observation =>
  ({ ref, at, clock: 'simulation', value, quality: 'good', priority: 'none', ...extra })

describe('readout', () => {
  test('a value past a limit carries its chip: order word, the limit at its decimals, the consequence; the colour is the observation\'s', () => {
    const look = valueLook(level, [observation(level.ref, 18.04, { priority: 'alarm', past: 'lolo' })], level.ref)
    expect(look.text).toBe('18.0')
    expect(look.unit).toBe('%')
    expect(look.tone).toBe('alarm')
    expect(look.chip).toEqual({ word: 'LO-LO', text: 'LO-LO 20.0 · unit trip', tone: 'alarm' })
  })

  test('order words name the direction once per order', () => {
    expect([orderWord({ direction: 'low', order: 1 }), orderWord({ direction: 'low', order: 2 }), orderWord({ direction: 'high', order: 1 }), orderWord({ direction: 'high', order: 2 })])
      .toEqual(['LO', 'LO-LO', 'HI', 'HI-HI'])
  })

  test('the chip takes the observation\'s priority, not the threshold\'s: an advisory past a limit is drawn neutral', () => {
    const look = valueLook(level, [observation(level.ref, 85, { priority: 'none', past: 'hi' })], level.ref)
    expect(look.chip).toEqual({ word: 'HI', text: 'HI 80.0', tone: null })
    expect(look.tone).toBeNull()
  })

  test('neutral telemetry: a value without an observation priority takes no colour and no emphasis', () => {
    const look = readingLook('Vehicle · Fuel', 'number', undefined, { value: 4.2, unit: '%', thresholds: [] })
    expect(look).toMatchObject({ kind: 'number', text: '4.2', tone: null, emphasis: false, chip: null })
  })

  test('notice is bold without a hue; a bad reading is "?", one that does not apply "—"', () => {
    expect(valueLook(level, [observation(level.ref, 50, { priority: 'notice' })], level.ref)).toMatchObject({ tone: null, emphasis: true })
    expect(valueLook(level, [observation(level.ref, 50, { quality: 'bad' })], level.ref)).toMatchObject({ text: '?', unit: '' })
    expect(valueLook(level, [observation(level.ref, null, { quality: 'not-applicable' })], level.ref).text).toBe('—')
    // Outside its declared validity a reading shows neither its value nor its unit.
    const invalid = valueLook(level, [observation(level.ref, 50, { quality: 'not-applicable' })], level.ref)
    expect([invalid.text, invalid.unit, invalid.value]).toEqual(['—', '', null])
    expect(valueLook(level, [], level.ref).text).toBe('?')
  })

  test('a countdown names the effect of the limit it runs to', () => {
    const look = valueLook(level, [observation(level.ref, 24, { priority: 'warning', timeToAct: { threshold: 'lolo', seconds: 240 } })], level.ref)
    expect(look.note).toBe('trip in 4 min')
  })

  test('the readout block gets the number and its decimals, or nothing and the word it shows instead', () => {
    expect(valueLook(level, [observation(level.ref, 18.04)], level.ref)).toMatchObject({ value: 18, decimals: 1, text: '18.0' })
    expect(readingLook('Roll', 'number', undefined, { value: -0.3, unit: 'deg', thresholds: [] })).toMatchObject({ value: 0, text: '0' })
    // A count reads whole, as the card writes it.
    expect(readingLook('Energised islands', 'number', undefined, { value: 1, unit: '1', quantity: 'count', thresholds: [] })).toMatchObject({ text: '1', decimals: 0 })
    expect(valueLook(level, [observation(level.ref, 50, { quality: 'bad' })], level.ref)).toMatchObject({ value: null, text: '?' })
    // A reading over decades is shown as written (the block's text value), never as NaN, which the block draws as "—".
    const current = readingLook('Intermediate range current', 'number', undefined, { value: 4.4e-8, unit: 'A', decades: true, thresholds: [] })
    expect(current).toMatchObject({ kind: 'number', text: '4.4×10⁻⁸', value: '4.4×10⁻⁸', unit: 'A' })
    // A leak rate's noise, not read over decades, reads 0 (H9).
    expect(readingLook('Leak rate', 'number', undefined, { value: 2.3e-12, unit: 'kg/s', thresholds: [] })).toMatchObject({ text: '0', value: 0 })
    expect(readingLook('Leak rate', 'number', undefined, { value: 0, unit: 'kg/s', thresholds: [] }).value).toBe(0)
  })

  test('states: a word from the declaration, active only where declared so or true (Q8), "?" while unknown, "since" its last change', () => {
    const states = [{ value: 'open', label: 'open' }, { value: 'closed', label: 'closed' }]
    expect(readingLook('Breaker', 'enum', states, { value: 'closed', unit: '', thresholds: [], since: { at, clock: 'simulation' } })).toMatchObject({ kind: 'state', text: 'closed', fill: 'hollow', note: 'since 10:00:00' })
    const declared = [{ value: 'open', label: 'open' }, { value: 'closed', label: 'closed', active: true as const }]
    expect(readingLook('Breaker', 'enum', declared, { value: 'closed', unit: '', thresholds: [] }).fill).toBe('filled')
    expect([activeState('closed', declared), activeState('open', declared), activeState('closed', states), activeState(false, undefined)]).toEqual([true, false, null, false])
    expect(readingLook('Bus · Energised', 'boolean', undefined, { value: true, unit: '', thresholds: [] })).toMatchObject({ text: 'yes', fill: 'filled' })
    expect(readingLook('Bus · Energised', 'boolean', undefined, { value: null, unit: '', thresholds: [], quality: 'bad' })).toMatchObject({ text: '?', fill: 'unknown' })
  })

  test('numbers read as the card writes them', () => {
    expect([quantityText(287.44, 'degC'), quantityText(-0.01, '%'), quantityText(3, '1'), quantityText(1234.5, 'MW')]).toEqual(['287.4 °C', '0.0 %', '3.00', '1235 MW'])
  })
})

describe('trend strip', () => {
  const window = { start: 0, end: 10_000 }
  // A strip as the renderer lays it out: a measure of 7 px a character, no set points unless asked.
  const laid = { setPoints: false, room: 200, measure: (text: string): number => text.length * 7 }
  const x = (t: number): number => t / 100
  const y = (v: number): number => 100 - v

  test('step-and-hold: each value holds until the next sample, and the trace breaks where the record is silent past the hold gap', () => {
    expect(stepPath([{ t: 0, v: 10 }, { t: 2_000, v: 20 }], x, y, window, 3_000)).toBe('M0.0 90.0 L20.0 90.0 L20.0 80.0 L50.0 80.0')
    expect(stepPath([{ t: 0, v: 10 }, { t: 6_000, v: 20 }], x, y, window, 3_000)).toBe('M0.0 90.0 L30.0 90.0 M60.0 80.0 L90.0 80.0')
  })

  test('the Historian\'s hold, served with the record: a steady value it stores 30 to 88 s apart draws as one piece over ten minutes; a silence past the hold breaks it', () => {
    const now = 600_000
    const drawn = (points: ReadonlyArray<{ t: number; v: number }>) => stripDrawing({ pens: [level], series: new Map([[level.ref, { holdMs: recordedHoldMs, points }]]), observations: [], now, horizonMs: 600_000, width: 600, height: 72, ...laid })!
    const pieces = (path: string): number => path.match(/M/g)?.length ?? 0
    // The heartbeat's stored samples of a steady value, with the longest gap measured on Halden (88 s), and the live point now.
    const steady = [0, 30_000, 118_000, 150_000, 210_000, 298_000, 330_000, 390_000, 450_000, 538_000, 570_000, 600_000].map(t => ({ t, v: 50 }))
    expect(pieces(drawn(steady).pens[0]!.path)).toBe(1)
    expect(drawn(steady).unrecorded).toBeNull()
    // Nothing stored for 150 s (the Run was not recording): the trace holds 90 s, then breaks until the next sample.
    const gap = [...steady.filter(point => point.t <= 330_000), ...steady.filter(point => point.t >= 480_000)]
    expect(pieces(drawn(gap).pens[0]!.path)).toBe(2)
    expect(drawn(gap).pens[0]!.path).toContain('L420.0')
    // The guess this replaces, three recording intervals of 5 s, broke the same steady record into pieces.
    expect(pieces(stepPath(steady, t => t / 1_000, () => 0, { start: 0, end: now }, 15_000))).toBeGreaterThan(2)
  })

  test('the time before the record starts is hatched; a value held into the window\'s start leaves nothing hatched', () => {
    const drawn = (points: ReadonlyArray<{ t: number; v: number }>) => stripDrawing({ pens: [level], series: new Map([[level.ref, { holdMs: recordedHoldMs, points }]]), observations: [], now: 600_000, horizonMs: 600_000, width: 600, height: 72, ...laid })!
    // A Run that started 90 s ago: hatched up to its first sample, and the trace starts there.
    const young = drawn([{ t: 510_000, v: 50 }, { t: 540_000, v: 50 }, { t: 600_000, v: 50 }])
    expect(young.unrecorded).toEqual({ width: 510 })
    expect(young.pens[0]!.path.startsWith('M510.0')).toBe(true)
    // Its sample 40 s before the window holds into its start: nothing to hatch.
    expect(drawn([{ t: -40_000, v: 50 }, { t: 30_000, v: 50 }]).unrecorded).toBeNull()
    // One 100 s before holds only 90: what lies between is not recorded.
    expect(drawn([{ t: -100_000, v: 50 }, { t: 100_000, v: 50 }]).unrecorded).toEqual({ width: 100 })
  })

  test('a live point keeps the window and the one point before it', () => {
    expect(appendPoint([{ t: 0, v: 1 }, { t: 5, v: 2 }, { t: 9, v: 3 }], { t: 12, v: 4 }, 7)).toEqual([{ t: 5, v: 2 }, { t: 9, v: 3 }, { t: 12, v: 4 }])
  })

  test('a strip draws a limit where every pen declares one at that value and direction, whatever each calls it; set points apart', () => {
    const other = { ...level, ref: 'unit-1#level-b', thresholds: [threshold('b-lo', 'low', 1, 30), threshold('b-lolo', 'low', 2, 25), threshold('b-hi', 'high', 1, 80), threshold('b-ctl', 'high', 1, 60, { effect: 'control' })] }
    expect(sharedLines([level, other]).map(line => line.key)).toEqual(['low 30', 'high 80'])
    expect(sharedLines([level]).map(line => line.key)).toEqual(['low 30', 'low 20', 'high 80'])
    expect(sharedLines([level, { ...level, thresholds: [] }])).toEqual([])
    expect(sharedLines([other], true).map(line => line.key)).toEqual(['high 60'])
  })

  test('one quantity per strip: pens share one only in one unit, with the same limits and within a factor of three of scale; states read as bands after them (W5.2)', () => {
    const pen = (ref: string, quantity: VignetteValue['quantity'], unit: string, limits: ReadonlyArray<number>, extra: Partial<VignetteValue> = {}): VignetteValue =>
      ({ ...level, ref, label: ref, quantity, unit, thresholds: limits.map((value, at) => threshold(`${ref}-${at}`, 'high', at + 1, value)), ...extra })
    const cet = pen('cet', 'temperature', 'degC', [343])
    const subcooling = pen('subcooling', 'temperature-difference', 'degC', [16.7])
    const pzr = pen('pzr', 'pressure', 'MPa', [16.55, 12.7])
    const sg = pen('sg', 'pressure', 'MPa', [8.1])
    const sgs = ['a', 'b', 'c', 'd', 'e'].map(ref => pen(`sg-${ref}`, 'level', '%', [20, 30, 75]))
    const wide = pen('sg-wide', 'level', '%', [])
    const afw = pen('afw', 'flow', 'kg/s', [])
    const steam = pen('steam', 'flow', 'kg/s', [])
    const tenfold = (scale: number) => ({ thresholds: [threshold('x', 'high', 1, scale, { effect: 'control' })] })
    const running = pen('running', 'count', '1', [], { valueType: 'boolean' })
    const strips = (pens: ReadonlyArray<VignetteValue>) => stripsOf(pens).map(strip => strip.map(entry => entry.ref))
    // Subcooling never shares CET's axis (H8); pressures whose limits differ each keep their own strip, and their limits.
    expect(strips([cet, subcooling, pzr, sg])).toEqual([['cet'], ['subcooling'], ['pzr'], ['sg']])
    // Four steam generator levels with one set of limits share a strip, at most four to it; the wide range, without them, its own.
    expect(strips([...sgs, wide])).toEqual([['sg-a', 'sg-b', 'sg-c', 'sg-d'], ['sg-e'], ['sg-wide']])
    // Without limits, scales a tenfold apart (their set points) do not share; within three they do. A state is a band, last.
    expect(strips([running, { ...afw, ...tenfold(60) }, { ...steam, ...tenfold(600) }, { ...steam, ref: 'feed', ...tenfold(500) }])).toEqual([['afw'], ['steam', 'feed'], ['running']])
    // A plot of five rows and a legend row per pen; a band a row; the time axis once.
    expect([stripRows(sgs.slice(0, 2)), stripRows([running]), trendRows([sgs.slice(0, 2), [cet], [running]])]).toEqual([7, 1, 7 + 6 + 1 + 1])
  })

  test('the scale widens a steady value and reaches limits within reach only', () => {
    const steady = stripDomain({ min: 50, max: 50 }, [], 1)
    expect(steady.max - steady.min).toBeGreaterThan(2)
    const reached = stripDomain({ min: 40, max: 60 }, [30, 1_000], 1)
    expect(reached.min).toBeLessThan(30)
    expect(reached.max).toBeLessThan(100)
  })

  test('beyond its scale a strip names the limit nearest each edge, at that edge; a pen takes colour only from its observation', () => {
    const pens = [level, { ...level, ref: 'unit-1#level-b', thresholds: level.thresholds.map(limit => (limit.id === 'hi' ? { ...limit, value: 80 } : limit)) }]
    const drawn = (values: ReadonlyArray<number>) => stripDrawing({
      pens, series: new Map([[level.ref, { holdMs: 90_000, points: values.map((v, index) => ({ t: index * 1_000, v })) }], ['unit-1#level-b', { holdMs: 90_000, points: [{ t: 0, v: values[0]! }] }]]),
      observations: [observation('unit-1#level-b', values[0]!, { priority: 'caution' })], now: 10_000, horizonMs: 10_000, width: 100, height: 120, ...laid,
    })!
    const names = (drawing: NonNullable<ReturnType<typeof drawn>>) => drawing.labels.map(label => label.rows.map(row => row.map(run => run.text).join('')).join(' / '))
    const wide = drawn([35, 50])
    expect(wide.pens.map(pen => [pen.dash, pen.tone])).toEqual([['', null], ['6 3', 'caution']])
    expect([wide.lines.length, names(wide)]).toEqual([3, ['HI 80.0', 'LO 30.0', 'LO-LO 20.0 · unit trip']])
    const steady = drawn([49, 51])
    expect([steady.lines, names(steady)]).toEqual([[], ['▲ HI 80.0', '▼ LO 30.0']])
    expect(stripDrawing({ pens: [level], series: new Map(), observations: [], now: 1, horizonMs: 1, width: 1, height: 1, ...laid })).toBeNull()
  })

  // The pressurizer's limits after a trip in hot standby (H8, U-10): alarms and trips as neutral dashes named outside the
  // plot in value order with their consequence; the heater and spray set points no limit; the trip of modes 1–2 idle.
  const pressure: VignetteValue = {
    ref: 'unit-1#pzr', label: 'Unit 1 · Pressurizer pressure', quantity: 'pressure', unit: 'MPa', valueType: 'number', series: { seriesId: 'unit-1.pzr', intervalMs: 1_000 },
    thresholds: [
      threshold('si', 'low', 3, 12.7, { effect: 'trip', priority: 'alarm', consequence: 'SI', when: 'SI-BLOCKED off' }),
      threshold('rx-lo', 'low', 2, 13.8, { effect: 'trip', priority: 'alarm', consequence: 'RX TRIP', when: 'Power operation or Startup' }),
      threshold('alm-lo', 'low', 1, 14.8, { consequence: 'ALM' }),
      threshold('heaters', 'low', 2, 15.35, { effect: 'control', priority: 'notice', consequence: 'CTL' }),
      threshold('spray-off', 'high', 1, 15.65, { effect: 'control', priority: 'notice', consequence: 'CTL' }),
      threshold('alm-hi', 'high', 1, 16, { consequence: 'ALM' }),
      threshold('porv', 'high', 2, 16.18, { effect: 'control', priority: 'notice', consequence: 'CTL' }),
      threshold('rx-hi', 'high', 2, 16.55, { effect: 'trip', priority: 'alarm', consequence: 'RX TRIP' }),
    ],
  }
  const tripped = (height: number, extra: Partial<Observation> = {}, setPoints = false) => stripDrawing({
    pens: [pressure], series: new Map([[pressure.ref, { holdMs: 90_000, points: [{ t: 0, v: 15.5 }, { t: 360_000, v: 13.9 }, { t: 420_000, v: 13.66 }, { t: 600_000, v: 13.66 }] }]]),
    observations: [observation(pressure.ref, 13.66, { priority: 'warning', past: 'alm-lo', idle: ['rx-lo'], ...extra })], now: 600_000, horizonMs: 600_000, width: 240, height, ...laid, setPoints,
  })!
  const heads = (drawing: NonNullable<ReturnType<typeof tripped>>) => drawing.labels.map(label => label.rows[0]!.filter(run => run.mark !== true)[0]!.text)

  test('the pressurizer strip names its alarm and trip limits in value order, outside the plot, with their consequence, and no two names touch (W5.3)', () => {
    const drawing = tripped(120)
    expect(drawing.labels.map(label => label.rows.map(row => row.map(run => run.text).join('')).join(' / ')))
      .toEqual(['HI-HI 16.55 · RX TRIP', 'HI 16.00 · ALM', '■ LO 14.80 · ALM', 'LO-LO 13.80 · RX TRIP', 'LO-LO-LO 12.70 · SI'])
    expect(drawing.labels.map(label => label.y)).toEqual([...drawing.labels.map(label => label.y)].sort((left, right) => left - right))
    drawing.labels.slice(1).forEach((label, index) => expect(label.y - drawing.labels[index]!.y).toBeGreaterThanOrEqual(LABEL_LINE))
    // No set point is a limit: five lines, none of them a control set point, unless the element's own trend asks for them.
    expect([drawing.lines.length, drawing.setPoints]).toEqual([5, []])
    const marks = tripped(120, {}, true)
    expect(marks.setPoints.map(mark => mark.title)).toEqual(['CTL 15.35: control set point', 'CTL 15.65: control set point', 'CTL 16.18: control set point'])
    // Named faint only where no limit's name stands, and never moving one: the limits' names are where they were.
    expect(marks.labels).toEqual(drawing.labels)
    for (const mark of marks.setPoints.filter(entry => entry.labelY !== null)) for (const label of marks.labels) expect(Math.abs(mark.labelY! - label.y)).toBeGreaterThanOrEqual(LABEL_LINE)
  })

  test('a limit is a neutral dash, coloured only while a value is past it where it acts now; one that does not act now is faint', () => {
    const lines = (drawing: NonNullable<ReturnType<typeof tripped>>) => Object.fromEntries(drawing.lines.map(line => [line.key, [line.tone, line.idle]]))
    // Past LO 14.80, which acts: its alarm's colour. Past LO-LO 13.80 too, but the reactor trip does not act in hot standby: faint, never coloured.
    expect(lines(tripped(120))).toMatchObject({ 'low 14.8': ['warning', false], 'low 13.8': [null, true], 'low 12.7': [null, false], 'high 16.55': [null, false] })
    // An alarm expected after a first-out leaves the value uncoloured: so is its limit.
    expect(lines(tripped(120, { priority: 'none' }))['low 14.8']).toEqual([null, false])
    // Its name says why it is faint.
    expect(tripped(120).lines.find(line => line.key === 'low 13.8')!.title).toBe('LO-LO 13.80 · RX TRIP (Power operation or Startup) · does not act now')
  })

  test('where names do not all fit, the least telling give way: never the one a value is past, nor the one it heads for', () => {
    // Room for two names: the limit the value is past, and the one it heads for (held steady, the nearest), though that one does not act now.
    expect(heads(tripped(2 * LABEL_LINE))).toEqual(['LO 14.80', 'LO-LO 13.80'])
    // Falling, it heads below.
    const falling = stripDrawing({
      pens: [pressure], series: new Map([[pressure.ref, { holdMs: 90_000, points: [{ t: 0, v: 15.5 }, { t: 470_000, v: 15.2 }, { t: 560_000, v: 14.9 }, { t: 600_000, v: 14.7 }] }]]),
      observations: [observation(pressure.ref, 14.7, { priority: 'warning', past: 'alm-lo' })], now: 600_000, horizonMs: 600_000, width: 240, height: 2 * LABEL_LINE, ...laid,
    })!
    expect(heads(falling)).toEqual(['LO 14.80', 'LO-LO 13.80'])
    // Ported from OLD's stackLabels: at their lines, pushed clear of each other, inside the room; the most telling kept in a room too short for any.
    const slot = (key: string, want: number, rank: number, size = 12) => ({ key, want, size, rank })
    expect(stackLabels([slot('trip', 20, 1), slot('alarm', 28, 0)], { min: 0, max: 120 })).toEqual([{ key: 'trip', start: 20 }, { key: 'alarm', start: 32 }])
    expect(stackLabels([slot('a', 100, 0), slot('b', 104, 1), slot('c', 108, 2)], { min: 0, max: 120 }).map(label => label.start)).toEqual([84, 96, 108])
    expect(stackLabels([slot('hi-trip', 10, 3), slot('hi-alarm', 14, 1), slot('lo-alarm', 30, 0), slot('lo-trip', 34, 2)], { min: 0, max: 36 }).map(label => label.key)).toEqual(['hi-alarm', 'lo-alarm', 'lo-trip'])
    expect(stackLabels([slot('a', 0, 1), slot('b', 0, 0)], { min: 0, max: 8 })).toEqual([{ key: 'b', start: -4 }])
  })

  test('limits at one value are one line, each consequence once, those acting first; a narrow margin wraps them by whole parts', () => {
    const level4: VignetteValue = { ...level, thresholds: [threshold('afw', 'low', 2, 20, { effect: 'trip', priority: 'alarm', consequence: 'AFW START' }), threshold('rx', 'low', 2, 20, { effect: 'trip', priority: 'alarm', consequence: 'RX TRIP' })] }
    const drawn = (idle: ReadonlyArray<string>, room: number) => stripDrawing({
      pens: [level4], series: new Map([[level4.ref, { holdMs: 90_000, points: [{ t: 0, v: 24 }] }]]), observations: [observation(level4.ref, 24, idle.length === 0 ? {} : { idle: [...idle] })],
      now: 60_000, horizonMs: 600_000, width: 200, height: 120, ...laid, room,
    })!.labels[0]!.rows.map(row => row.map(run => `${run.idle ? '(' : ''}${run.text}${run.idle ? ')' : ''}`).join(''))
    expect(drawn([], 400)).toEqual(['LO-LO 20.0 · AFW START + RX TRIP'])
    expect(drawn(['rx'], 400)).toEqual(['LO-LO 20.0 · AFW START( + RX TRIP)'])
    expect(drawn([], 170)).toEqual(['LO-LO 20.0 · AFW START', '+ RX TRIP'])
    expect(labelRows([{ text: 'LONGER THAN THE ROOM', idle: false, tone: null }], 50, text => text.length * 7)).toHaveLength(1)
    expect(labelWidth({ pens: [level4], series: new Map([[level4.ref, { holdMs: 90_000, points: [{ t: 0, v: 24 }] }]]), observations: [], now: 60_000, horizonMs: 600_000, height: 120, setPoints: false }, text => text.length)).toBe('LO-LO 20.0 · AFW START + RX TRIP'.length)
  })

  test('a gridline\'s value never leaves the plot: the top one is written under its line and names the unit (W5.4)', () => {
    const drawing = tripped(120)
    expect(drawing.values.every(tick => tick.labelY >= 14 && tick.labelY <= 120)).toBe(true)
    expect(drawing.values.filter(tick => tick.label.endsWith(' MPa'))).toHaveLength(1)
    expect(drawing.values.find(tick => tick.label.endsWith(' MPa'))!.y).toBe(Math.min(...drawing.values.map(tick => tick.y)))
  })

  test('a rate is read where the last 30 s and 2 min agree in direction, each at least a step; a state reads as a band', () => {
    const series = (values: ReadonlyArray<[number, number]>) => ({ holdMs: 90_000, points: values.map(([t, v]) => ({ t, v })) })
    expect(rateNow(series([[0, 15], [480_000, 14.9], [570_000, 14.8], [600_000, 14.7]]), 600_000, 0.01)).toBeCloseTo(-0.2, 6)
    // Turned within the last 30 s: the two disagree, no rate.
    expect(rateNow(series([[0, 15], [480_000, 14.9], [570_000, 14.5], [600_000, 14.7]]), 600_000, 0.01)).toBeNull()
    // Below a step of its decimals, or a record shorter than 2 min: none.
    expect(rateNow(series([[0, 15], [600_000, 15.001]]), 600_000, 0.01)).toBeNull()
    expect(rateNow(series([[540_000, 15], [600_000, 14]]), 600_000, 0.01)).toBeNull()
    expect([rateText(-0.2, 'MPa', 'pressure'), rateText(1.25, '%', 'level')]).toEqual(['▼ 0.20/min', '▲ 1.3/min'])
    expect(bandStretches([{ t: 0, v: 1 }, { t: 4_000, v: 0 }], x, window, 90_000)).toEqual([{ x: 0, width: 40, on: true }, { x: 40, width: 60, on: false }])
  })

  test('time ticks count back from now in round steps', () => {
    expect(timeTicks(600_000, 600_000).map(tick => tick.label)).toEqual(['−10 min', '−8 min', '−6 min', '−4 min', '−2 min', 'now'])
    expect(timeTicks(120_000, 120_000).map(tick => tick.label)).toEqual(['−2 min', '−90 s', '−1 min', '−30 s', 'now'])
  })
})

describe('alerts', () => {
  const row = (id: string, objectId: string, priority: AlertRow['priority'], extra: Partial<AlertState> = {}): AlertRow => ({
    key: `${objectId}|${id}`, objectId: objectId as ObjectId, objectLabel: objectId, packId: 'fixture', categoryId: 'thing', group: { objectId: objectId as ObjectId },
    alert: { id, kind: 'alarm', severity: priority === 'alarm' ? 'critical' : 'warning', message: id, raisedAt: at as never, acknowledged: false, ...(priority === null ? {} : { priority }), ...extra },
    priority, state: 'active-unack', raised: { at: at as never, clock: 'simulation' },
  })

  test('"priority not declared": an alert without a priority never ranks as one; alone it shows its severity word', () => {
    expect(worstChip([], [row('a', 'one', null)])).toEqual({ kind: 'undeclared', severity: 'warning' })
    expect(worstChip([{ priority: 'caution' }], [row('a', 'one', null)])).toEqual({ kind: 'priority', priority: 'caution' })
    expect(worstChip([{ priority: 'notice' }], [])).toBeNull()
  })

  test('each row takes OpenBridge\'s alert icon as its record stands, so only unacknowledged news flashes; what asks no attention shows its priority steady; notice and an undeclared priority read as words', () => {
    // People acknowledge in the display window (W2.7): an unacknowledged alarm flashes until they do (H11, F18).
    expect(alertIcon(row('a', 'one', 'emergency'))).toEqual({ kind: 'icon', type: 'level-critical', acknowledged: false, active: true })
    expect(alertIcon({ ...row('a', 'one', 'warning'), state: 'active-ack' })).toEqual({ kind: 'icon', type: 'warning', acknowledged: true, active: true })
    expect(alertIcon({ ...row('a', 'one', 'alarm'), state: 'returned-unack' })).toEqual({ kind: 'icon', type: 'alarm', acknowledged: false, active: false })
    // Expected after a first-out, standing, advisory: unacknowledged, steady, its priority alone.
    expect(alertIcon({ ...row('a', 'one', 'alarm'), expected: { after: 'RX TRIP' } })).toEqual({ kind: 'badge', type: 'alarm' })
    expect(alertIcon(row('a', 'one', 'caution', { standing: true }))).toEqual({ kind: 'badge', type: 'caution' })
    expect(alertIcon({ ...row('a', 'one', 'alarm', { firstOut: { group: 'g', rank: 1 } }), expected: { after: 'RX TRIP' } })).toEqual({ kind: 'icon', type: 'alarm', acknowledged: false, active: true })
    expect(alertIcon(row('a', 'one', 'notice'))).toEqual({ kind: 'word', word: 'Notice' })
    expect(alertIcon(row('a', 'one', null))).toEqual({ kind: 'word', word: 'Warning · priority not declared' })
    // Before a sample's time is known a row says its clock time; then its age in Run time.
    expect(alertDetail({ ...row('a', 'one', 'caution', { standing: true, acknowledged: true, acknowledgedBy: 'ai' }), state: 'active-ack' }, Number.NaN)).toBe('standing · acknowledged by Assistant · 10:00:00 UTC')
    expect(alertDetail(row('a', 'one', 'caution'), Date.parse(at) + 179_000)).toBe('2:59')
  })

  test('the word UNACK carries what the steady icon does not: on each unacknowledged row and in the section\'s counts; standing alarms and advisories never count (R43)', () => {
    const rows = [
      row('a', 'one', 'alarm'), { ...row('r', 'one', 'warning'), state: 'returned-unack' as const }, { ...row('k', 'one', 'alarm', { acknowledged: true }), state: 'active-ack' as const },
      row('s', 'one', 'caution', { standing: true }), row('x', 'one', 'warning'),
    ]
    expect(rows.map(entry => [entry.alert.id, unacknowledged(entry), alertDetail(entry, Number.NaN)])).toEqual([
      ['a', true, '10:00:00 UTC'], ['r', true, 'returned · 10:00:00 UTC'], ['k', false, 'acknowledged · 10:00:00 UTC'], ['s', false, 'standing · 10:00:00 UTC'], ['x', true, '10:00:00 UTC'],
    ])
    expect(UNACK_WORD).toBe('UNACK')
    expect(rows.filter(unacknowledged)).toHaveLength(3)
  })

  test('a row says its tag and what it is expected after; a first-out\'s tag that only names its group is left to its mark', () => {
    const now = Date.parse(at) + 65_000
    expect(alertDetail({ ...row('ll', 'one', 'alarm'), tag: 'LO-LO · AFW START', expected: { after: 'RX TRIP' } }, now)).toBe('LO-LO · AFW START · after RX TRIP · 1:05')
    const first = { ...row('t', 'one', 'alarm', { firstOut: { group: 'turbine-trip', rank: 1 } }), tag: 'TURB TRIP', action: { label: 'TURB TRIP' } }
    expect(alertDetail(first, now)).toBe('1:05')
    expect(alertTitle(first, now)).toBe('one: UNACK · 1st TURB TRIP: t · 1:05 · 10:00:00 UTC')
  })

  test('a row\'s message gives way by whole words before any ellipsis, a lone word too long cut last; what fits stays whole', () => {
    const within = (characters: number) => (shown: string): boolean => shown.length <= characters
    const message = 'Steam generator A low-low level'
    expect(wordsThatFit(message, within(40))).toBe(message)
    expect(wordsThatFit(message, within(18))).toBe('Steam generator A…')
    expect(wordsThatFit(message, within(17))).toBe('Steam generator…')
    // A comma before the cut is left out with the words after it.
    expect(wordsThatFit('Feedwater isolation on reactor trip, low Tavg', within(37))).toBe('Feedwater isolation on reactor trip…')
    expect(wordsThatFit('Feedwater isolation', within(5))).toBe('Feed…')
    expect(wordsThatFit('Feedwater', within(0))).toBe('…')
    // It tries whole words first, and cuts within the first word only after every whole-word start failed.
    const tried: string[] = []
    expect(wordsThatFit(message, shown => { tried.push(shown); return shown.length <= 4 })).toBe('Ste…')
    const wholeWords = (shown: string): boolean => shown === message || (message.startsWith(shown.slice(0, -1)) && message[shown.length - 1] === ' ')
    const inFirstWord = (shown: string): boolean => shown.length - 1 < 'Steam'.length
    expect(tried.filter(shown => !wholeWords(shown) && !inFirstWord(shown))).toEqual([])
    expect(tried.slice(tried.findIndex(inFirstWord)).filter(wholeWords)).toEqual([])
  })

  test('in an alert row only the message gives way: the icon, UNACK, a first-out mark, a heading, the tag and the age never shrink', () => {
    const source = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/AlertRowLine.svelte'), 'utf8')
    const rule = (selector: string): string => source.match(new RegExp(`\\n\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    expect(rule('.message')).toContain('flex: 1 1 0;')
    expect(rule('.message')).toContain('min-width: 0;')
    expect(rule('.detail')).toContain('flex: none;')
    expect(rule('.icon')).toContain('flex: none;')
    expect(source).toMatch(/strong, \.mark, \.unack \{ flex: none;/)
    expect(source).toContain('use:wholeWords={parts.message}')
  })

  test('a row stands on one line: its notes give way before its message, its message by whole words, then its tag; the icon, UNACK, the mark and the age stand', () => {
    const now = Date.parse(at) + 1_000
    // A character 6 px wide.
    const measure = (text: string): number => text.length * 6
    const first = rowParts({ ...row('Reactor trip on turbine trip', 'one', 'alarm', { firstOut: { group: 'g', rank: 1 } }), action: { label: 'RX TRIP' }, tag: 'LO · RX TRIP' }, now)
    // Its mark names its group, so its tag keeps only its limit.
    expect(first).toMatchObject({ unack: true, mark: '1st RX TRIP', message: 'Reactor trip on turbine trip', detail: { tag: 'LO', notes: [], age: '0:01' } })
    // Icon 20, UNACK 30, "1st RX TRIP:" 72, the message 168, "LO · 0:01" 54, four gaps of 6.
    expect(rowWidth(first, measure)).toBe(20 + 30 + 72 + 168 + 54 + 4 * 6)
    expect(fitRow(first, 400, measure)).toBe(first)
    // Narrower, the message gives way on the row itself (wholeWords): it has no notes, and its tag stands while its first word fits.
    expect(fitRow(first, 260, measure)).toEqual(first)
    const expected = rowParts({ ...row('SG A level low-low', 'one', 'alarm', { acknowledged: true }), state: 'active-ack', tag: 'LO-LO · AFW START', expected: { after: 'RX TRIP' } }, now)
    expect(detailText(expected.detail)).toBe('LO-LO · AFW START · after RX TRIP · acknowledged · 0:01')
    expect(fitRow(expected, 500, measure)).toBe(expected)
    // To keep its message whole, the notes go, the last first; then the message gives way ("SG…", then nothing); then the tag; the age stands.
    expect(detailText(fitRow(expected, 440, measure).detail)).toBe('LO-LO · AFW START · after RX TRIP · 0:01')
    expect(detailText(fitRow(expected, 300, measure).detail)).toBe('LO-LO · AFW START · 0:01')
    expect(detailText(fitRow(expected, 200, measure).detail)).toBe('LO-LO · AFW START · 0:01')
    expect(detailText(fitRow(expected, 150, measure).detail)).toBe('0:01')
    // An object's name in a list of several goes last.
    const named = rowParts(row('Loss of offsite power', 'one', 'alarm'), now, 'Halden Unit 1')
    expect(fitRow(named, 120, measure)).toMatchObject({ unack: true, mark: null, detail: { notes: [], age: '0:01' } })
    expect(fitRow(named, 120, measure).heading).toBeUndefined()
    expect(fitRow(named, 240, measure).heading).toBe('Halden Unit 1')
  })

  test('people acknowledge in the display window only (D-B1, Q19): no ACK in a chat answer or a dialog, each through its row\'s command', () => {
    const source = (file: string): string => readFileSync(join(import.meta.dir, `../src/ui/embed/vignette/${file}`), 'utf8')
    const opening = source('opening.svelte.ts')
    expect(opening).toContain("get acknowledges() { return where === 'window' }")
    expect(opening).toContain("if (where !== 'window') return 'alerts are acknowledged in the display window'")
    expect(opening).toContain('invokeSimulationRunCapability(config.runId(), { capabilityId: row.acknowledge.capabilityId, input: row.acknowledge.input })')
    for (const file of ['AlertsSection.svelte', 'AlertsView.svelte']) expect(source(file)).toContain('const acks = $derived(opening?.acknowledges === true)')
    expect(source('acknowledging.svelte.ts')).toContain('if (by === undefined || !by.acknowledges || asked.length === 0) return')
    expect(source('AlertRowLine.svelte')).toContain('{#if parts.ack === true && onack !== undefined}')
    // The column's rows open their element; its aggregates and an element's own rows (its faceplate) acknowledge.
    expect(source('AlertsSection.svelte')).toContain('acks && !whole && row.acknowledge !== undefined')
  })

  test('a section narrowed to elements or observables shows only the alerts on them', () => {
    const rows = [
      row('on-pump', 'one', 'warning', { subject: { element: 'pump-a' } }), row('on-level', 'one', 'alarm', { observable: 'one#level' }),
      row('elsewhere', 'one', 'caution', { subject: { element: 'pump-b' } }), row('other-object', 'two', 'alarm', { subject: { element: 'pump-a' } }),
    ]
    const ids = (section: Parameters<typeof inSection>[0]) => rows.filter(inSection(section)).map(entry => entry.alert.id)
    expect(ids({ objectIds: ['one'], elements: ['pump-a'] })).toEqual(['on-pump'])
    expect(ids({ objectIds: ['one'], refs: ['one#level'] })).toEqual(['on-level'])
    expect(ids({ objectIds: ['one'], elements: ['pump-a'], refs: ['one#level'] })).toEqual(['on-pump', 'on-level'])
    expect(ids({ objectIds: 'run' })).toEqual(['on-pump', 'on-level', 'elsewhere', 'other-object'])
  })

  test('the worst chip opens the full alerts view of what the vignette is about; the full view opens no other', () => {
    const alerts = { kind: 'alerts' as const, rows: 5, objectIds: ['one'] }
    expect(alertsTarget({ sections: [alerts] }, [row('a', 'one', 'alarm')])).toEqual({ objectIds: ['one'], title: 'Alerts · one' })
    expect(alertsTarget({ sections: [{ ...alerts, objectIds: 'run' }] }, [])).toEqual({ objectIds: 'run', title: 'Alerts in the Run' })
    expect(alertsTarget({ sections: [{ ...alerts, all: true }] }, [])).toBeNull()
    expect(alertsTarget({ sections: [{ kind: 'map', rows: 2 }] }, [])).toBeNull()
  })
})

describe('footer', () => {
  test('every vignette says it is not an operating display, and whether World generated it from the model or the Assistant composed it', () => {
    expect(provenanceMark({})).toBe('Generated from the model · not an operating display')
    expect(provenanceMark({ by: 'assistant' })).toBe('AI-composed view · not an operating display')
    // Before its view is read, it does not yet say who made it.
    expect(provenanceMark(undefined)).toBe('not an operating display')
    // A footer too narrow says the same shorter, never cut (a 360 px chat answer read "not an opera…").
    expect([provenanceMarks({}), provenanceMarks({ by: 'assistant' })].map(marks => marks[1])).toEqual(['Model view · not for operating', 'AI view · not for operating'])
    // The frame every host shows (the window, a chat answer inline, a procedure tag's dialog) writes it in its footer.
    const frame = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/Vignette.svelte'), 'utf8')
    expect(frame.slice(frame.indexOf('<footer'), frame.indexOf('</footer>'))).toContain('{provenanceMark(view)}')
  })
})
