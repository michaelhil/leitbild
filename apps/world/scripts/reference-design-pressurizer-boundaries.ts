/** Offline audit of a published analysis prescription, not a transient solver or measured-state reconstruction. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const finite = z.number().finite()
const positive = finite.positive()
const series = z.array(z.tuple([finite.nonnegative(), finite])).min(2).superRefine((rows, ctx) => {
  for (let i = 1; i < rows.length; i++) if (rows[i]![0] <= rows[i - 1]![0])
    ctx.addIssue({ code: 'custom', message: 'Times must strictly increase' })
})
const schema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  height_m: positive,
  innerRadius_m: positive,
  outerRadius_m: positive,
  cellCount: positive.int(),
  cellLength_m: positive,
  cellVolume_m3: positive,
  liquidCellEquivalents: positive,
  statedLevel_m: positive,
  fluidTemperature_K: positive,
  wallTemperature_K: positive,
  ambientTemperature_K: positive,
  outerHeatTransfer_W_m2K: positive,
  surgeMassFlow_kg_s: series,
  heaterPower_W: series,
}).strict().superRefine((x, ctx) => {
  if (x.outerRadius_m <= x.innerRadius_m || x.liquidCellEquivalents >= x.cellCount)
    ctx.addIssue({ code: 'custom', message: 'Invalid shell or partially filled vessel geometry' })
  if (x.heaterPower_W.some(([, power]) => power < 0))
    ctx.addIssue({ code: 'custom', message: 'Heater power cannot be negative' })
})

export function parsePressurizerBoundaries(document: string) {
  const blocks = [...document.matchAll(/^```reference-pressurizer-boundaries\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-pressurizer-boundaries block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

/** Integrate linear segments, splitting at zero so opposing amounts never cancel prematurely. */
export function integrateSignedSchedule(value: unknown) {
  const rows = series.parse(value)
  let incoming = 0, outgoing = 0
  for (let i = 1; i < rows.length; i++) {
    const [t0, a] = rows[i - 1]!, [t1, b] = rows[i]!, dt = t1 - t0
    if (a * b < 0) {
      const firstDuration = dt * Math.abs(a) / (Math.abs(a) + Math.abs(b))
      const first = a * firstDuration / 2, second = b * (dt - firstDuration) / 2
      incoming += Math.max(first, 0) + Math.max(second, 0)
      outgoing += Math.max(-first, 0) + Math.max(-second, 0)
    } else {
      const amount = (a + b) * dt / 2
      incoming += Math.max(amount, 0)
      outgoing += Math.max(-amount, 0)
    }
  }
  return { incoming, outgoing, net: incoming - outgoing, from_s: rows[0]![0], through_s: rows.at(-1)![0] }
}

export function auditPressurizerBoundaries(value: unknown) {
  const x = schema.parse(value)
  const area = Math.PI * x.innerRadius_m ** 2
  const outerArea = 2 * Math.PI * x.outerRadius_m * x.height_m
  const cylinderVolume = area * x.height_m
  const initialShellLoss = outerArea * x.outerHeatTransfer_W_m2K * (x.wallTemperature_K - x.ambientTemperature_K)
  return {
    scope: 'Published prescribed analysis inputs; no claim of measured initial field or qualified transient',
    input: x,
    inputHash: createHash('sha256').update(JSON.stringify(x)).digest('hex'),
    cylinderVolume_m3: cylinderVolume,
    deckVolume_m3: x.cellCount * x.cellVolume_m3,
    relativeVolumeRoundingDifference: (x.cellCount * x.cellVolume_m3 - cylinderVolume) / cylinderVolume,
    heightRoundingDifference_m: x.cellCount * x.cellLength_m - x.height_m,
    initialLevelFromDeck_m: x.liquidCellEquivalents * x.cellLength_m,
    levelRoundingDifference_m: x.liquidCellEquivalents * x.cellLength_m - x.statedLevel_m,
    shellThickness_m: x.outerRadius_m - x.innerRadius_m,
    outerLateralArea_m2: outerArea,
    initialLateralShellLoss_W: initialShellLoss,
    initialHeaterMinusLateralLoss_W: x.heaterPower_W[0]![1] - initialShellLoss,
    surgeMass_kg: integrateSignedSchedule(x.surgeMassFlow_kg_s),
    heaterEnergy_J: integrateSignedSchedule(x.heaterPower_W),
  }
}

if (import.meta.main) {
  const [page] = process.argv.slice(2)
  if (!page) throw new Error('Usage: reference-design-pressurizer-boundaries.ts <wiki-source-page>')
  console.log(JSON.stringify(auditPressurizerBoundaries(parsePressurizerBoundaries(await Bun.file(page).text())), null, 2))
}
