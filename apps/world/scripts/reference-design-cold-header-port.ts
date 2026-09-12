/** Exact phase intersection and prescribed signed-port ledger, not a header/flow solver. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ringArea } from './reference-design-cmt-geometry.ts'

const schema = z.object({ area_m2: z.literal(4), bottom_m: z.literal(2.5), top_m: z.literal(3.5),
  tap_m: z.literal(3), tapBore_m: z.literal(.2) }).strict()
export type ColdHeaderBasis = z.infer<typeof schema>
export function parseColdHeaderBasis(doc: string): ColdHeaderBasis {
  const blocks = [...doc.matchAll(/^```reference-cold-header\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-cold-header block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}
export function coldHeaderPort(b: ColdHeaderBasis, eta: number) {
  if (!Number.isFinite(eta) || eta < b.bottom_m || eta > b.top_m) throw Error('Interface outside finite header')
  const r = b.tapBore_m / 2
  const opening = { holeDiameter_m: b.tapBore_m, holesPerRing: 1 }
  const liquidArea = ringArea(opening, b.tap_m, b.tap_m - r, eta)
  const vaporArea = ringArea(opening, b.tap_m, eta, b.tap_m + r)
  return { eta_m: eta, liquidVolume_m3: b.area_m2 * (eta - b.bottom_m),
    vaporVolume_m3: b.area_m2 * (b.top_m - eta), liquidArea_m2: liquidArea,
    vaporArea_m2: vaporArea, liquidEligible: liquidArea > 0, vaporEligible: vaporArea > 0 }
}
export function checkColdHeaderPort(b: ColdHeaderBasis) {
  const rows = [b.bottom_m, 2.9, 2.95, 3, 3.05, 3.1, b.top_m].map(eta => coldHeaderPort(b, eta))
  const A = Math.PI * (b.tapBore_m / 2) ** 2
  for (const q of rows) {
    if (Math.abs(q.liquidArea_m2 + q.vaporArea_m2 - A) > 1e-14 ||
      Math.abs(q.liquidVolume_m3 + q.vaporVolume_m3 - 4) > 1e-14) throw Error('Phase partition mismatch')
  }
  // Prescribed physical face traces, NOT EOS states or hydraulically solved flows.
  // Equal gross exchange through the two half-port phases must not become zero heat/B transport.
  const traces = [{ phase: 'liquid', mass_kg: .01, staticH_J_kg: 1e6, speed_m_s: .1, boronFraction: .002 },
    { phase: 'vapor', mass_kg: -.01, staticH_J_kg: 2.8e6, speed_m_s: .5, boronFraction: 0 }]
  const strips = traces.map(q => ({ ...q, donor: q.mass_kg > 0 ? 'COLD header' : 'BAL passage',
    energy_J: q.mass_kg * (q.staticH_J_kg + q.speed_m_s ** 2 / 2 + 9.80665 * b.tap_m),
    boron_kg: q.mass_kg * q.boronFraction }))
  const m = strips.reduce((s, q) => s + q.mass_kg, 0), E = strips.reduce((s, q) => s + q.energy_J, 0)
  const B = strips.reduce((s, q) => s + q.boron_kg, 0)
  return { input: b, contacts: rows, prescribedOpposedExchange: { strips,
    headerChange: { M_kg: -m, E_J: -E, B_kg: -B }, passageChange: { M_kg: m, E_J: E, B_kg: B },
    netMass_kg: m, grossMass_kg: strips.reduce((s, q) => s + Math.abs(q.mass_kg), 0) },
    phasePortMappingChecked: true, sourceCreationOrFlowTimingQualified: false,
    scope: 'Existing finite separated-header geometry and actual signed phase donors; no EOS, phase-rate or flow solution' }
}
if (import.meta.main) {
  const [owner, output, ...extra] = Bun.argv.slice(2)
  if (!owner || !output || extra.length) throw Error('Usage: cold-header-port.ts <mechanical-owner.md> <output.json>')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const input = parseColdHeaderBasis(await Bun.file(owner).text())
  const identities = { sourceHash: hash(await Bun.file(import.meta.path).text()),
    geometrySourceHash: hash(await Bun.file(new URL('./reference-design-cmt-geometry.ts', import.meta.url)).text()),
    inputHash: hash(JSON.stringify(input)) }
  await Bun.write(output, JSON.stringify({ ...identities, ...checkColdHeaderPort(input) }, null, 2) + '\n')
}
