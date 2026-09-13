/** Offline capture-composition selection, NOT a solved intake or delivery model. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseGeometryBasis, tankGeometry } from './reference-design-cmt-geometry.ts'

const positive = z.number().finite().positive()
const schema = z.object({ onsetCoefficient: positive, coefficientFactors: z.array(positive).min(1),
  massFlows_kg_s: z.array(positive).min(1), normalizedHeights: z.array(z.number().finite().min(0).max(1)).min(1),
  densityCases: z.array(z.object({ pressure_Pa: positive, temperature_K: positive,
    liquid_kg_m3: positive, vapor_kg_m3: positive }).strict()).min(1) }).strict()
export function parseOfftakeBasis(doc: string) {
  const blocks = [...doc.matchAll(/^```reference-cmt-offtake\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-offtake block')
  const b = schema.parse(JSON.parse(blocks[0]![1]!))
  if (b.densityCases.some(q => q.liquid_kg_m3 <= q.vapor_kg_m3)) throw new Error('Separated density contrast required')
  return b
}
const gravity = 9.80665
export function onsetHeight(liquidFlow: number, rhoL: number, rhoV: number, coefficient = 1.5) {
  if (![liquidFlow, rhoL, rhoV, coefficient].every(Number.isFinite) || liquidFlow < 0 ||
      rhoV <= 0 || rhoL <= rhoV || coefficient <= 0) throw new Error('Invalid separated downward capture state')
  return coefficient * liquidFlow ** .4 / (gravity * rhoL * (rhoL - rhoV)) ** .2
}
export function downwardQuality(relativeHeight: number, rhoL: number, rhoV: number) {
  onsetHeight(0, rhoL, rhoV)
  if (!Number.isFinite(relativeHeight) || relativeHeight < 0) throw new Error('Negative/invalid submerged height')
  if (relativeHeight >= 1) return 0
  if (relativeHeight === 0) return 1
  const x0 = 1.15 / (1 + Math.sqrt(rhoL / rhoV))
  return x0 ** (2.5 * relativeHeight) * Math.sqrt(1 - .5 * relativeHeight * (1 + relativeHeight) * x0 ** (1 - relativeHeight))
}
export function captureAtFlow(flow: number, height: number, rhoL: number, rhoV: number, coefficient = 1.5) {
  const allLiquidOnset = onsetHeight(flow, rhoL, rhoV, coefficient)
  if (!Number.isFinite(height) || height < 0) throw new Error('Use actual exposed phase donor, not a negative-height extrapolation')
  if (flow === 0) return { captureQuality: null, liquid_kg_s: 0, vapor_kg_s: 0, onset_m: 0, residual: 0 }
  if (height === 0) return { captureQuality: 1, liquid_kg_s: 0, vapor_kg_s: flow, onset_m: 0, residual: 0 }
  const predicted = (x: number) => {
    const h = onsetHeight((1 - x) * flow, rhoL, rhoV, coefficient)
    return h === 0 ? 0 : downwardQuality(height / h, rhoL, rhoV)
  }
  let lo = 0, hi = 1
  if (height >= allLiquidOnset) hi = 0
  // Monotone scalar composition equation only; no hydraulic solver or old-step quality.
  for (let i = 0; i < 64 && lo < hi; i++) {
    const mid = (lo + hi) / 2
    if (mid === lo || mid === hi) break
    if (mid < predicted(mid)) lo = mid; else hi = mid
  }
  const x = (lo + hi) / 2, liquid = (1 - x) * flow
  return { captureQuality: x, liquid_kg_s: liquid, vapor_kg_s: x * flow,
    onset_m: onsetHeight(liquid, rhoL, rhoV, coefficient), residual: x - predicted(x) }
}
if (import.meta.main) {
  const [geometryPath, ownerPath, output] = process.argv.slice(2)
  if (!geometryPath || !ownerPath || !output) throw new Error('Usage: cmt-offtake.ts geometry.md owner.md receipt.json')
  const geometry = parseGeometryBasis(await Bun.file(geometryPath).text()), g = tankGeometry(geometry)
  const basis = parseOfftakeBasis(await Bun.file(ownerPath).text())
  const cases = basis.densityCases.flatMap(d => basis.massFlows_kg_s.flatMap(flow => {
    const nominalOnset = onsetHeight(flow, d.liquid_kg_m3, d.vapor_kg_m3, basis.onsetCoefficient)
    return basis.coefficientFactors.flatMap(factor => basis.normalizedHeights.map(relativeHeight => {
      const height = relativeHeight * nominalOnset
      if (height > geometry.top_m - g.mouth) throw new Error('Comparison level exceeds the physical tank height')
      return { pressure_Pa: d.pressure_Pa, totalFlow_kg_s: flow, coefficientFactor: factor,
        height_m: height, nominalOnset_m: nominalOnset,
        cleanSeparatedLiquid_m3: g.volume(g.mouth, g.mouth + height),
        ...captureAtFlow(flow, height, d.liquid_kg_m3, d.vapor_kg_m3, basis.onsetCoefficient * factor) }
    }))
  }))
  if (cases.some(c => Math.abs(c.residual) > 1e-12 || Math.abs(c.liquid_kg_s + c.vapor_kg_s - c.totalFlow_kg_s) > 1e-12))
    throw new Error('Capture composition closure failed')
  const input = { geometry, basis }, hash = (s: string) => createHash('sha256').update(s).digest('hex')
  await Bun.write(output, JSON.stringify({ sourceHash: hash(await Bun.file(import.meta.path).text()),
    geometrySourceHash: hash(await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()),
    inputHash: hash(JSON.stringify(input)), input, mouth_m: g.mouth, cases,
    compositionComparisonAdmitted: true, intakeMomentumPressureSelected: false, depletionQualified: false }, null, 2) + '\n')
}
