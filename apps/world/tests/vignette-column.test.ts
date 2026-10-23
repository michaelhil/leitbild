import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SimulationRunId } from '../src/core/model/ids.ts'
import type { Observable, Observation } from '../src/core/observation/model.ts'
import type { SeriesPoint, VignetteSample, VignetteValue, VignetteView } from '../src/features/displays/compose/model.ts'
import { partsThatFit } from '../src/ui/embed/vignette/fit-words.ts'
import { keptAfter, shownSeries, unkept } from '../src/ui/embed/vignette/kept-series.ts'
import { marginOf, slopePerMinute, tendencyOf } from '../src/ui/embed/vignette/margin.ts'
import { rateNow, rateText } from '../src/ui/embed/vignette/trend.ts'
import { SPARK_WINDOW_MS, sparkline } from '../src/ui/embed/vignette/sparkline.ts'
import { marginLines, valueRows } from '../src/ui/embed/vignette/value-rows.ts'
import { createVignetteSession, type VignetteSnapshot } from '../src/ui/embed/vignette/vignette-client.ts'
import { valueLook } from '../src/ui/embed/vignette/readout.ts'
import { recordingSeriesIdFor, type ObjectId } from '../src/core/model/index.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { recordedPlantVariables } from '../src/packs/process-plant/recording.ts'

// The window's column (plan v5 W4.2, W8.5; owner finding 1; #47, #48): each
// lead row its short label, value and unit, its 10-min sparkline (the
// registered shape, D-C), its rate where the 30 s and 2 min slopes agree and,
// near or past a limit in force, a margin line. The sparkline geometry is
// OLD's composed-display-sparkline test re-expressed (plan §5.6) for the one
// geometry the vignette and the Plant's cards share.

const now = 1_000_000_000
const windowMs = SPARK_WINDOW_MS
const start = now - windowMs
const size = { width: 56, height: 20 }
const HOLD = 90_000
const every = (stepMs: number, from: number, to: number, value: (t: number) => number): ReadonlyArray<SeriesPoint> =>
  Array.from({ length: Math.floor((to - from) / stepMs) + 1 }, (_, index) => from + index * stepMs).map(t => ({ t, v: value(t) }))
/** The y of every vertex of a path. */
const ys = (path: string): ReadonlyArray<number> => [...path.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(match => Number(match[1]))

type Threshold = Observable['thresholds'][number]
// The pressurizer's pressure limits as the reference PWR declares them: an alarm with no condition, a trip at power only, a control set point.
const pressure: Array<Threshold> = [
  { id: 'trip-low', direction: 'low', value: 13.8, order: 2, effect: 'trip', priority: 'alarm', consequence: 'RX TRIP', when: 'Power operation' },
  { id: 'alarm-low', direction: 'low', value: 14.8, order: 1, effect: 'alarm', priority: 'warning', consequence: 'ALM' },
  { id: 'spray', direction: 'high', value: 15.65, order: 1, effect: 'control', priority: 'notice', consequence: 'CTL' },
  { id: 'alarm-high', direction: 'high', value: 16, order: 1, effect: 'alarm', priority: 'warning', consequence: 'ALM' },
]
const mpa = { unit: 'MPa', quantity: 'pressure' as const }

describe('the registered sparkline (OLD composed-display-sparkline, re-expressed)', () => {
  test('draws only what is recorded in the window: a gap stays a gap, older values neither draw nor scale', () => {
    const line = sparkline([
      // Its hold ends before the window opens.
      { t: start - 120_000, v: 20 },
      { t: start + 50_000, v: 15.6 },
      { t: start + 100_000, v: 15.6 },
      // Over three minutes with nothing recorded, then a value re-recorded each minute.
      ...every(60_000, start + 300_000, now - 60_000, () => 15.4),
      { t: now, v: 15.45 },
    ], now, windowMs, size, HOLD)!
    expect(line.range).toEqual({ min: 15.4, max: 15.6 })
    expect(line.path.match(/M/g)).toHaveLength(2)
    expect(line.broken).toBe(true)
    expect(line.path.startsWith(`M${((50_000 / windowMs) * (size.width - 4)).toFixed(1)} `)).toBe(true)
    expect(line.end?.x).toBe(size.width - 4)
  })

  test('a value held from before the window draws from its start; a line whose last value no longer holds has no end; nothing recorded, no line', () => {
    const held = sparkline([{ t: start - 60_000, v: 3400 }, { t: start + 60_000, v: 3400 }], now, windowMs, size, HOLD)!
    expect(held.path.startsWith('M0.0 ')).toBe(true)
    expect(held.end).toBeNull()
    expect(sparkline([], now, windowMs, size, HOLD)).toBeNull()
  })

  test('a steady value is a flat line in the middle, a small wobble stays small, a ramp fills the height', () => {
    const flat = sparkline(every(60_000, start, now, () => 15.5), now, windowMs, size, HOLD)!
    expect(new Set(ys(flat.path))).toEqual(new Set([size.height / 2]))
    expect([flat.path.match(/M/g)?.length, flat.broken]).toEqual([1, false])
    const wobble = ys(sparkline(every(1_000, now - 60_000, now, t => ((t / 1_000) % 2 === 0 ? 15.5 : 15.52)), now, windowMs, size, HOLD)!.path)
    expect(Math.max(...wobble) - Math.min(...wobble)).toBeLessThan(1)
    const ramp = sparkline(every(10_000, start, now, t => 3400 - (200 * (t - start)) / windowMs), now, windowMs, size, HOLD)!
    expect(ys(ramp.path)[0]).toBeLessThan(5)
    expect(ramp.end!.y).toBeGreaterThan(size.height - 5)
  })

  test('a reading gone silent (outside its validity) holds no further than when it went silent', () => {
    const line = sparkline(every(10_000, start, now - 120_000, () => 5), now, windowMs, size, HOLD, now - 110_000)!
    expect(line.end).toBeNull()
    expect(Math.max(...[...line.path.matchAll(/L([\d.]+) /g)].map(match => Number(match[1])))).toBeLessThan(((windowMs - 100_000) / windowMs) * (size.width - 4))
  })

  test('a scale over values whose share underflows still has height, and no reading is NaN', () => {
    const output = sparkline([{ t: now - 300_000, v: 1e-320 }, { t: now - 200_000, v: Number.NaN }, { t: now - 100_000, v: 5e-324 }], now, windowMs, size, HOLD)!
    expect(output.path).not.toContain('NaN')
    expect(output.end === null || Number.isFinite(output.end.y)).toBe(true)
  })
})

describe('rate and margin (#47, #48)', () => {
  // Falling 0.3 MPa/min for three minutes, recorded each second, as exception recording stores a moving value.
  const falling = every(1_000, now - 180_000, now, t => 15.4 - (0.3 * (t - (now - 180_000))) / 60_000)

  test('slopes read the record as held: a steady value recorded only by its 30 s heartbeat is steady, not unknown', () => {
    const steady = [{ t: now - 200_000, v: 15.5 }, { t: now - 170_000, v: 15.5 }, { t: now - 140_000, v: 15.5 }, { t: now - 110_000, v: 15.5 }, { t: now - 80_000, v: 15.5 }, { t: now - 50_000, v: 15.5 }, { t: now - 20_000, v: 15.5 }]
    expect(slopePerMinute(steady, now, 30_000, HOLD)).toBe(0)
    expect(slopePerMinute(steady, now, 120_000, HOLD)).toBe(0)
    // A record shorter than most of the window gives no slope.
    expect(slopePerMinute([{ t: now - 40_000, v: 1 }, { t: now, v: 2 }], now, 120_000, HOLD)).toBeNull()
    expect(slopePerMinute(falling, now, 30_000, HOLD)).toBeCloseTo(-0.3, 2)
  })

  test('a row states the trends\' rate (trend.ts rateNow): only where the 30 s and the 2 min changes agree, at the value\'s decimals', () => {
    const rate = (points: ReadonlyArray<SeriesPoint>) => tendencyOf(points, now, HOLD, 0.01).rate
    expect(rateText(rate(falling)!, 'MPa', 'pressure')).toBe('▼ 0.30/min')
    expect(rate(falling)).toBe(rateNow({ points: falling, holdMs: HOLD }, now, 0.01))
    // Just turned: 2 min falling, the last 30 s rising.
    const turned = [...every(1_000, now - 180_000, now - 30_000, t => 15.4 - (0.3 * (t - (now - 180_000))) / 60_000), ...every(1_000, now - 29_000, now, t => 14.65 + (0.2 * (t - (now - 30_000))) / 60_000)]
    expect(rate(turned)).toBeNull()
    // Too steady to read at its decimals.
    expect(rate(every(1_000, now - 180_000, now, () => 15.5))).toBeNull()
    // Two minutes not yet recorded (a Run 90 s old): no rate.
    expect(rate(every(1_000, now - 60_000, now, t => 15 - (t - now) / 60_000))).toBeNull()
  })

  test('the margin test: approaching a limit in force, how far, what it does, which way, and the time only where the trend is established', () => {
    // 15.46 MPa falling 0.3 MPa/min: 0.66 above LO 14.80 MPa · ALM, about 2 min off.
    const value = falling.at(-1)!.v + 0.96
    const shifted = falling.map(point => ({ t: point.t, v: point.v + 0.96 }))
    const margin = marginOf(value, pressure, undefined, tendencyOf(shifted, now, HOLD, 0.01), mpa)!
    expect(margin.text).toBe('0.66 above LO 14.80 MPa · ALM · falling · ≈2 min')
    expect(margin.past).toBe(false)
    // The trip at power only is not named: World reads no condition, so a limit with one is in force only where the Pack says it is past it.
    expect(margin.text).not.toContain('RX TRIP')
    // Slowing: the last 30 s fall at half the 2 min rate or less.
    const slowing = [...every(1_000, now - 180_000, now - 30_000, t => 16.9 - (0.6 * (t - (now - 180_000))) / 60_000), ...every(1_000, now - 29_000, now, t => 15.4 - (0.1 * (t - (now - 30_000))) / 60_000)]
    expect(marginOf(slowing.at(-1)!.v, pressure, undefined, tendencyOf(slowing, now, HOLD, 0.01), mpa)!.text).toBe('0.55 above LO 14.80 MPa · ALM · falling, slowing · ≈6 min')
    // Steady at power, 0.5 MPa under the high alarm: not near.
    expect(marginOf(15.5, pressure, undefined, tendencyOf(every(1_000, now - 180_000, now, () => 15.5), now, HOLD, 0.01), mpa)).toBeNull()
    // Within a hundredth of the limit while steady, no time: near.
    expect(marginOf(14.9, pressure, undefined, { short: 0, long: 0, rate: null }, mpa)!.text).toBe('0.10 above LO 14.80 MPa · ALM · steady')
  })

  test('past a limit: how far below, and back above in the time the established trend gives', () => {
    const rising = every(1_000, now - 180_000, now, t => 13.5 + (0.3 * (t - (now - 180_000))) / 60_000)
    const value = rising.at(-1)!.v
    const margin = marginOf(value, pressure, 'alarm-low', tendencyOf(rising, now, HOLD, 0.01), mpa)!
    expect(margin).toMatchObject({ past: true, text: '0.40 below LO 14.80 MPa · ALM · rising · back above in ≈80 s' })
    // Without a record, only how far and what it does.
    expect(marginOf(value, pressure, 'alarm-low', { short: null, long: null, rate: null }, mpa)!.text).toBe('0.40 below LO 14.80 MPa · ALM')
  })

  test('a margin line gives way by whole parts where room is short: which way it goes first, then what the limit does, then the time', () => {
    const margin = marginOf(14.4, pressure, 'alarm-low', { short: 0.3, long: 0.3, rate: 0.3 }, mpa)!
    expect(margin.parts).toEqual(['0.40 below LO 14.80 MPa', 'ALM', 'rising', 'back above in ≈80 s'])
    const fitting = (room: number) => partsThatFit(margin.parts, margin.giving, shown => shown.length <= room)
    expect(fitting(80)).toBe(margin.text)
    expect(fitting(52)).toBe('0.40 below LO 14.80 MPa · ALM · back above in ≈80 s')
    expect(fitting(46)).toBe('0.40 below LO 14.80 MPa · back above in ≈80 s')
    expect(fitting(30)).toBe('0.40 below LO 14.80 MPa')
  })
})

describe('a values section\'s rows', () => {
  const value = (ref: string, extra: Partial<VignetteValue> = {}): VignetteValue => ({
    ref, label: `Unit 1 · ${ref.split('#')[1]}`, quantity: 'pressure', unit: 'MPa', valueType: 'number', thresholds: pressure, series: { seriesId: ref.replace('#', '.'), intervalMs: 1_000 }, ...extra,
  })
  const observation = (ref: string, v: number, extra: Partial<Observation> = {}): Observation => ({ ref, value: v, quality: 'good', priority: 'none', at: new Date(now).toISOString(), clock: 'simulation', ...extra })
  const rising = every(1_000, now - 180_000, now, t => 13.5 + (0.3 * (t - (now - 180_000))) / 60_000)

  test('each row its short label, a sparkline where its reading is recorded, its rate, and the most urgent margins first', () => {
    const values = [value('u#pzr', { shortLabel: 'PZR pressure' }), value('u#prt', { series: null }), value('u#far')]
    const rows = valueRows({
      values,
      observations: [observation('u#pzr', rising.at(-1)!.v, { past: 'alarm-low', priority: 'warning' }), observation('u#prt', 14.85), observation('u#far', 15.5)],
      series: new Map([['u#pzr', { holdMs: HOLD, points: rising }]]),
      now, title: 'Unit 1', frozen: false,
    })
    expect(rows.map(row => [row.label, row.recorded, row.rate])).toEqual([['PZR pressure', true, '▲ 0.30/min'], ['prt', false, null], ['far', true, null]])
    expect(rows[0]!.look.chip?.word).toBe('LO')
    expect(marginLines(rows, 3).map(row => row.label)).toEqual(['PZR pressure', 'prt'])
    // Frozen: no rate, no margin, every value doubtful.
    const frozen = valueRows({ values, observations: [observation('u#pzr', 14.4, { past: 'alarm-low' })], series: new Map([['u#pzr', { holdMs: HOLD, points: rising }]]), now, title: 'Unit 1', frozen: true })
    expect(frozen.map(row => [row.look.doubtful, row.rate, row.margin])).toEqual([[true, null, null], [true, null, null], [true, null, null]])
  })
})

describe('kept series (W8.5)', () => {
  const section = (refs: ReadonlyArray<string>): VignetteView => ({
    title: 'Unit 1',
    sections: [{ kind: 'values', rows: 13, lead: 0, zones: true, values: refs.map(ref => ({ ref, label: ref, quantity: 'pressure', unit: 'MPa', valueType: 'number', thresholds: [], series: { seriesId: ref.replace('#', '.'), intervalMs: 1_000 } })) }],
  })
  const sampleAt = (t: number, values: Readonly<Record<string, number>>, series?: VignetteSample['series'], leads?: ReadonlyArray<string>): VignetteSample => ({
    at: { at: new Date(t).toISOString(), clock: 'simulation', paused: false },
    observations: Object.entries(values).map(([ref, v]) => ({ ref, value: v, quality: 'good', priority: 'none', at: new Date(t).toISOString(), clock: 'simulation' })),
    alerts: [], entities: {}, slots: {}, maps: {},
    ...(series === undefined ? {} : { series }),
    ...(leads === undefined ? {} : { leads: { 0: leads.map(ref => ({ ref, label: ref, quantity: 'pressure', unit: 'MPa', valueType: 'number', thresholds: [], series: { seriesId: ref.replace('#', '.'), intervalMs: 1_000 } })) } }),
  })

  test('every values row with a series is shown; a record served replaces, every other is extended, one no longer shown is dropped', () => {
    const view = section(['u#a', 'u#b'])
    expect(shownSeries(view).map(entry => [entry.ref, entry.horizonMs])).toEqual([['u#a', SPARK_WINDOW_MS], ['u#b', SPARK_WINDOW_MS]])
    const first = keptAfter(new Map(), shownSeries(view), sampleAt(now, { 'u#a': 1, 'u#b': 2 }, { 'u.a': { holdMs: HOLD, points: [{ t: now - 5_000, v: 0.5 }] }, 'u.b': { holdMs: HOLD, points: [] } }), true)
    expect(first.get('u#a')!.points).toEqual([{ t: now - 5_000, v: 0.5 }, { t: now, v: 1 }])
    const next = keptAfter(first, shownSeries(section(['u#a', 'u#c'])), sampleAt(now + 1_000, { 'u#a': 1.5, 'u#c': 3 }), false)
    expect([...next.keys()]).toEqual(['u#a'])
    expect(next.get('u#a')!.points.at(-1)).toEqual({ t: now + 1_000, v: 1.5 })
    expect(unkept(shownSeries(section(['u#a', 'u#c'])), next)).toEqual(['u#c'])
  })

  test('a lead row that appears after a mode change has its record read once, with the next sample, and only its', async () => {
    let runMs = now
    let leads: ReadonlyArray<string> = ['u#a']
    const asked: Array<string> = []
    const snapshots: VignetteSnapshot[] = []
    const timers: Array<() => void> = []
    const session = createVignetteSession({
      runId: 'run-1' as SimulationRunId,
      state: '{}',
      routes: {
        presence: async () => ({ loaded: true, at: new Date(runMs).toISOString() }),
        view: async () => section(['u#a']),
        sample: async (_run, _state, history) => {
          asked.push(history === undefined ? 'none' : history.refs === undefined ? `all ${runMs - history.fromMs}` : `refs ${history.refs.join(',')}`)
          const served = history === undefined ? undefined : Object.fromEntries(leads.filter(ref => history.refs === undefined || history.refs.includes(ref)).map(ref => [ref.replace('#', '.'), { holdMs: HOLD, points: [{ t: runMs - 60_000, v: 9 }] }]))
          return sampleAt(runMs, Object.fromEntries(leads.map(ref => [ref, 1])), served, leads)
        },
      },
      onChange: snapshot => { snapshots.push(snapshot) },
      wallNow: () => runMs,
      schedule: (run) => { timers.push(run); return () => {} },
    })
    const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve() }
    const tick = async (): Promise<void> => { runMs += 1_000; timers.shift()?.(); await settle() }
    session.start()
    await settle()
    await tick()
    // The trip: the Pack now leads with another value too.
    leads = ['u#a', 'u#b']
    await tick()
    await tick()
    await tick()
    session.close()
    expect(asked).toEqual([`all ${SPARK_WINDOW_MS}`, 'none', 'none', 'refs u#b', 'none'])
    const last = snapshots.at(-1)!
    expect(last.series.get('u#b')!.points[0]).toEqual({ t: now + 3_000 - 60_000, v: 9 })
  })
})

describe('value words (W4.4)', () => {
  const look = (extra: Partial<Parameters<typeof valueLook>[0]>, observation: Partial<Observation> & { readonly value: Observation['value'] }, others: ReadonlyArray<Observation> = []) =>
    valueLook({ label: 'Unit 1 · reading', valueType: 'number', unit: '%', quantity: 'level', thresholds: [], ...extra } as Parameters<typeof valueLook>[0],
      [{ ref: 'u#r', quality: 'good', priority: 'none', at: new Date(now).toISOString(), clock: 'simulation', ...observation }, ...others], 'u#r')
  const travel = { below: 0.05, above: 0.95, low: 'SHUT', high: 'OPEN' }

  test('a valve\'s travel reads SHUT and OPEN at its ends, its opening in percent between them', () => {
    expect([look({ unit: '1', quantity: 'fraction', travel }, { value: 0.02 }), look({ unit: '1', quantity: 'fraction', travel }, { value: 0.99 })].map(entry => [entry.text, entry.value, entry.unit])).toEqual([['SHUT', 'SHUT', ''], ['OPEN', 'OPEN', '']])
    expect(look({ unit: '1', quantity: 'fraction', travel }, { value: 0.5 })).toMatchObject({ text: '50.0', value: 50, unit: '%', decimals: 1 })
  })

  test('an on/off signal reads its declared words', () => {
    const states = [{ value: 'true', label: 'Source-range HV on', active: true as const }, { value: 'false', label: 'Source-range HV off' }]
    expect(look({ valueType: 'boolean', unit: '', quantity: 'state', states }, { value: false })).toMatchObject({ kind: 'state', text: 'Source-range HV off', fill: 'hollow' })
    expect(look({ valueType: 'boolean', unit: '', quantity: 'state', states }, { value: true })).toMatchObject({ text: 'Source-range HV on', fill: 'filled' })
  })

  test('pascals read in kilopascals', () => {
    expect(look({ unit: 'Pa', quantity: 'pressure' }, { value: 7534 })).toMatchObject({ text: '7.5', value: 7.5, unit: 'kPa', decimals: 1 })
  })

  test('at an end of its span a reading reads only that it is there, in the low-integrity style; its wider range stands in where it has one', () => {
    const span = { min: 0, max: 100 }
    expect(look({ span }, { value: 0 })).toMatchObject({ text: '<0', value: '<0', unit: '%', doubtful: true, offSpan: 'below' })
    expect(look({ span }, { value: 100 })).toMatchObject({ text: '>100', offSpan: 'above', doubtful: true })
    expect(look({ span }, { value: 37.2 })).toMatchObject({ text: '37.2', offSpan: null, doubtful: false })
    const wide: Observation = { ref: 'u#wr', value: 24.04, quality: 'good', priority: 'none', at: new Date(now).toISOString(), clock: 'simulation' }
    expect(look({ span, wider: { ref: 'u#wr', word: 'WR' } }, { value: 0 }, [wide])).toMatchObject({ text: 'WR 24.0', value: 'WR 24.0', unit: '%', doubtful: false, offSpan: 'wider' })
    // A wider range not read, or not good, leaves the pinned end.
    expect(look({ span, wider: { ref: 'u#wr', word: 'WR' } }, { value: 0 }, [{ ...wide, quality: 'bad' }]).text).toBe('<0')
  })

  test('outside its validity a reading names what it waits for; a value only the simulator computes reads SIM', () => {
    expect(look({ invalidWhile: 'Source-range HV off' }, { value: null, quality: 'not-applicable' })).toMatchObject({ text: '—', reason: 'Source-range HV off', value: null, unit: '' })
    expect(look({}, { value: null, quality: 'not-applicable' })).toMatchObject({ text: '—', reason: null })
    expect(look({ simulated: true }, { value: 3 }).sim).toBe(true)
    expect(look({}, { value: 3 }).sim).toBe(false)
  })

  test('the Plant declares them: span and wider range of a narrow range, a valve\'s travel, on/off words, what a reading waits for', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:words', loopCount: 4 }))
    const recording = { seriesIds: new Set(recordedPlantVariables(plant, 'operations').map(variable => recordingSeriesIdFor(plant.id, variable.path))), intervalMs: 1_000 }
    const declared = plantDeclaration('plant:words' as ObjectId, plant, recording)
    const observable = (path: string) => declared.observables.find(entry => entry.ref === `plant:words#${path}`)!
    expect(observable('sgA.levelPercent')).toMatchObject({ span: { min: 0, max: 100 }, wider: { ref: 'plant:words#sgA.wideRangeLevelPercent', word: 'WR' } })
    expect(observable('turbineStopValve.effectivePositionFraction').travel).toEqual({ below: 0.05, above: 0.95, low: 'SHUT', high: 'OPEN' })
    expect(observable('core.rodsOnBottom').states).toEqual([{ value: 'true', label: 'Rods on bottom', active: true }, { value: 'false', label: 'Rods off bottom' }])
    expect(observable('core.sourceRangeCountRateCps')).toMatchObject({ meaningfulWhile: 'while Source-range HV on', invalidWhile: 'Source-range HV off' })
    // Read over decades, the intermediate range declares no span to pin to.
    expect(observable('core.intermediateRangeCurrentAmps').span).toBeUndefined()
  })
})

describe('the column moves nothing (W8.4)', () => {
  test('its rows, sparklines and margins neither animate nor transition, so reduced motion has nothing to stop', () => {
    const dir = join(import.meta.dir, '../src/ui/embed/vignette')
    for (const file of ['ValueRows.svelte', 'Sparkline.svelte', 'Sections.svelte']) {
      const style = readFileSync(join(dir, file), 'utf8').match(/<style>([\s\S]*)<\/style>/)?.[1] ?? ''
      expect(style, file).not.toMatch(/\b(animation|transition)\s*:/)
    }
  })
})
