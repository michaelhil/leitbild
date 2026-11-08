import { z } from 'zod'
import { calculateSampleChanges } from './sample-changes'

const nameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(name => !['constructor', 'prototype', '__proto__'].includes(name), 'Reserved name')
const timestampSchema = z.iso.datetime({ offset: true, precision: 3 })
const labelSchema = z.string().trim().min(1).max(160)

/** A scalar with a semantic quantity, not merely a dimensional unit label. */
export const engineeringDatumSchema = z.object({
  name: nameSchema,
  value: z.number().finite(),
  quantity: labelSchema,
  unit: labelSchema,
  simulationAt: timestampSchema.optional(),
  quality: z.enum(['good', 'unknown']),
  origin: z.enum(['observation', 'assumption']),
}).strict()
export type EngineeringDatum = z.infer<typeof engineeringDatumSchema>

export const engineeringMethodInputSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('sample_changes'), samples: z.array(nameSchema).min(2).max(256) }).strict(),
  z.object({
    method: z.literal('reservoir_balance'),
    initial: nameSchema,
    streams: z.array(z.object({
      name: nameSchema,
      direction: z.enum(['in', 'out']),
      samples: z.array(nameSchema).min(2).max(256),
    }).strict()).min(1).max(32),
    interpolation: z.enum(['hold-left', 'linear']),
    maxGapSeconds: z.number().positive().finite(),
    from: timestampSchema,
    to: timestampSchema,
    boundary: z.string().trim().min(1).max(1000),
    omittedTerms: z.array(z.string().trim().min(1).max(300)).max(32),
  }).strict(),
])
export type EngineeringMethodInput = z.infer<typeof engineeringMethodInputSchema>

export type EngineeringCalculationError = Error & { code: string }
export const calculationError = (code: string, message: string): EngineeringCalculationError =>
  Object.assign(new Error(message), { code })
const refuse = (code: string, message: string): never => { throw calculationError(code, message) }
const finite = (value: number): number => Number.isFinite(value) ? value : refuse('nonfinite_result', 'Arithmetic overflow or nonfinite result')
const instant = (datum: EngineeringDatum): number => {
  if (datum.simulationAt === undefined) return refuse('missing_time', `${datum.name} needs an explicit simulationAt`)
  return Date.parse(datum.simulationAt)
}

// Deliberately small, exact semantic families. No guesses from unit spelling,
// percent/fraction conversion, gauge/absolute pressure conversion, or affine offsets.
const storageUnits: Record<string, Record<string, number>> = {
  mass: { kg: 1, g: 0.001, t: 1000 },
  energy: { J: 1, kJ: 1000, MJ: 1e6, kWh: 3.6e6, MWh: 3.6e9 },
}
const rateUnits: Record<string, Record<string, number>> = {
  'mass-flow': { 'kg/s': 1, 'g/s': 0.001, 'kg/h': 1 / 3600 },
  power: { W: 1, kW: 1000, MW: 1e6 },
}
const own = (object: Record<string, number> | undefined, key: string): number | undefined =>
  object && Object.hasOwn(object, key) ? object[key] : undefined

/** Arithmetic only. Input provenance and physical applicability remain owner concerns. */
export const calculateEngineeringMethod = (raw: unknown, rawDatums: unknown) => {
  const parsed = engineeringMethodInputSchema.safeParse(raw)
  const data = z.array(engineeringDatumSchema).min(1).max(2048).safeParse(rawDatums)
  if (!parsed.success || !data.success) return refuse('invalid_input', !parsed.success ? parsed.error.message : !data.success ? data.error.message : 'Invalid input')
  const request = parsed.data
  const byName = new Map<string, EngineeringDatum>()
  for (const datum of data.data) {
    if (byName.has(datum.name)) return refuse('duplicate_name', `Duplicate datum ${datum.name}`)
    byName.set(datum.name, datum)
  }
  const select = (name: string): EngineeringDatum => {
    const datum = byName.get(name)
    if (!datum) return refuse('missing_datum', `Missing datum ${name}`)
    if (datum.quality !== 'good') return refuse('unknown_quality', `${name} does not have good quality`)
    return datum
  }
  const samples = (names: string[]): EngineeringDatum[] => {
    const selected = names.map(select)
    const first = selected[0]!
    for (const [index, datum] of selected.entries()) {
      if (datum.quantity !== first.quantity || datum.unit !== first.unit) return refuse('quantity_unit_mismatch', 'Samples must use the same semantic quantity and exact unit')
      const time = instant(datum)
      if (index > 0 && time <= instant(selected[index - 1]!)) return refuse('time_order', 'Samples must be strictly increasing; samples are not sorted or repaired')
    }
    return selected
  }
  if (request.method === 'sample_changes') {
    const selected = samples(request.samples)
    const first = selected[0]!
    let arithmetic: ReturnType<typeof calculateSampleChanges>
    try {
      arithmetic = calculateSampleChanges({ timestamps: selected.map(datum => datum.simulationAt), series: [{ key: first.quantity, unit: first.unit, values: selected.map(datum => datum.value) }] })
    } catch (error) {
      return refuse('nonfinite_result', error instanceof Error ? error.message : 'Sample arithmetic failed')
    }
    return {
      method: request.method,
      qualification: 'arithmetic-only' as const,
      selectedNames: request.samples,
      quantity: first.quantity,
      // Differences of absolute Celsius temperatures are kelvin intervals.
      changeQuantity: first.quantity === 'temperature' ? 'temperature-difference' : first.quantity,
      changeUnit: first.quantity === 'temperature' && ['°C', 'degC', 'C'].includes(first.unit) ? 'K' : first.unit,
      arithmetic,
    }
  }
  const initial = select(request.initial)
  const storageScale = own(storageUnits[initial.quantity], initial.unit)
  if (storageScale === undefined) return refuse('unsupported_storage', 'Reservoir storage must be mass (kg, g, t) or energy (J, kJ, MJ, kWh, MWh)')
  const rateQuantity = initial.quantity === 'mass' ? 'mass-flow' : 'power'
  const from = Date.parse(request.from)
  const to = Date.parse(request.to)
  if (to <= from) return refuse('time_order', 'to must be after from')
  if (instant(initial) !== from) return refuse('initial_time_mismatch', 'Initial storage must be timestamped at from')
  const streamNames = new Set<string>()
  const streams = request.streams.map(stream => {
    if (streamNames.has(stream.name)) return refuse('duplicate_stream', `Duplicate stream ${stream.name}`)
    streamNames.add(stream.name)
    const selected = samples(stream.samples)
    const first = selected[0]!
    const scale = own(rateUnits[rateQuantity], first.unit)
    if (first.quantity !== rateQuantity || scale === undefined) return refuse('quantity_unit_mismatch', `Expected ${rateQuantity} with a supported rate unit`)
    if (instant(first) !== from || instant(selected.at(-1)!) !== to) return refuse('coverage_mismatch', 'Every stream must exactly cover from and to; no extrapolation')
    return { ...stream, selected, scale }
  })
  const grid = streams[0]!.selected.map(instant)
  for (const stream of streams) {
    if (stream.selected.length !== grid.length || stream.selected.some((datum, index) => instant(datum) !== grid[index])) return refuse('grid_mismatch', 'Every stream must use the same explicit sample instants')
  }
  let storage = initial.value
  const intervals = grid.slice(1).map((at, index) => {
    const elapsedSeconds = (at - grid[index]!) / 1000
    if (elapsedSeconds > request.maxGapSeconds) return refuse('sample_gap', 'A sample interval exceeds maxGapSeconds; no gap repair')
    const transfers = streams.map(stream => {
      const left = stream.selected[index]!.value
      const right = stream.selected[index + 1]!.value
      // Halving before addition avoids gratuitous overflow in a finite mean.
      const rate = request.interpolation === 'hold-left' ? left : left / 2 + right / 2
      const signedAmount = finite(rate * stream.scale * elapsedSeconds / storageScale * (stream.direction === 'in' ? 1 : -1))
      return { stream: stream.name, signedAmount }
    })
    const netAmount = transfers.reduce((total, transfer) => finite(total + transfer.signedAmount), 0)
    storage = finite(storage + netAmount)
    return { from: streams[0]!.selected[index]!.simulationAt!, to: streams[0]!.selected[index + 1]!.simulationAt!, elapsedSeconds, transfers, netAmount, accountedStorage: storage }
  })
  return {
    method: request.method,
    qualification: 'arithmetic-only' as const,
    arithmetic: 'IEEE-754 binary64' as const,
    quantity: initial.quantity,
    unit: initial.unit,
    initialStorage: initial.value,
    finalAccountedStorage: storage,
    minimumSampledAccountedStorage: Math.min(initial.value, ...intervals.map(interval => interval.accountedStorage)),
    negativeAccountedStorage: initial.value < 0 || intervals.some(interval => interval.accountedStorage < 0),
    interpolation: request.interpolation,
    maxGapSeconds: request.maxGapSeconds,
    boundary: request.boundary,
    omittedTerms: request.omittedTerms,
    coverage: 'supplied-streams-only' as const,
    // This checks sample boundaries only; signed linear rates can have interior extrema.
    extremaCoverage: 'sample-boundaries-only' as const,
    intervals,
  }
}
