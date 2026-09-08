/** Offline source-observation admission; neither a pressurizer solver nor a calibration. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const finite = z.number().finite()
const positive = finite.positive()
const band = z.tuple([finite, finite]).refine(([lo, hi]) => lo <= hi, 'Reversed reading band')
const schema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  initialPressure_psia: positive,
  initialLevel_in: positive,
  finalLevel_in: positive,
  finalLevelReadingAllowance_in: positive,
  inletTemperature_F: finite,
  feedEndTime_s: band,
  observationTime_s: band,
  thermocouples: z.array(z.object({
    channel: z.number().int().positive(),
    height_in: positive,
    figure: z.string().min(1),
    pdfPage: z.number().int().positive(),
    temperature_F: band,
  }).strict()).min(2),
}).strict()

export function parsePressurizerObservations(document: string) {
  const blocks = [...document.matchAll(/^```reference-pressurizer-observations\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-pressurizer-observations block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

export function assessPressurizerObservations(value: unknown) {
  const input = schema.parse(value)
  if (input.observationTime_s[0] <= input.feedEndTime_s[1])
    throw new Error('Final-level classification requires a post-feed observation')
  const minimumLevel = input.finalLevel_in - input.finalLevelReadingAllowance_in
  if (minimumLevel <= 0 || input.thermocouples.some(tc => tc.height_in >= minimumLevel))
    throw new Error('Observation is not demonstrably below the admitted final level')
  if (new Set(input.thermocouples.map(tc => tc.channel)).size !== input.thermocouples.length ||
      new Set(input.thermocouples.map(tc => tc.height_in)).size !== input.thermocouples.length)
    throw new Error('Repeated thermocouple channel or location')
  // A common temperature must belong to EVERY observed reading band.
  const lower = Math.max(...input.thermocouples.map(tc => tc.temperature_F[0]))
  const upper = Math.min(...input.thermocouples.map(tc => tc.temperature_F[1]))
  const gap = Math.max(0, lower - upper)
  return {
    scope: 'Measured common-time liquid-temperature separation; no transient-model validation',
    input,
    inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    initialPressure_Pa: input.initialPressure_psia * 6894.757293168,
    initialLevel_m: input.initialLevel_in * 0.0254,
    finalLevel_m: input.finalLevel_in * 0.0254,
    inletTemperature_C: (input.inletTemperature_F - 32) * 5 / 9,
    minimumSeparation_F: gap,
    minimumSeparation_K: gap * 5 / 9,
    commonLiquidTemperatureExcludedByReadingBands: gap > 0,
    // These limits cannot be promoted by widening/narrowing the digitized input bands.
    totalInstrumentUncertaintyEstablished: false,
    replacementTransientModelQualified: false,
    initialEnergyReconstructed: false,
  }
}

if (import.meta.main) {
  const [page] = process.argv.slice(2)
  if (!page) throw new Error('Usage: reference-design-pressurizer-observations.ts <wiki-source-page>')
  console.log(JSON.stringify(assessPressurizerObservations(
    parsePressurizerObservations(await Bun.file(page).text())), null, 2))
}
