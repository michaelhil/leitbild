/** Compose the controlled-spray path into a compiled joined packet: the
 * line region SPRAY (inserted before the PZR, which moves from index 28 to
 * 29), its two half-line phase paths `COLD.A->SPRAY` and `SPRAY->PZR.SPRAY`
 * (appended after the 35 faces), their two face-loss sections (appended
 * after the sections) and the PZR spray port's face. Every value comes from
 * the `pzrSpray` section (`reference-design-operating-pzr-spray.ts`, strict
 * blocks only) and from the packet itself; nothing else in the packet
 * changes, so the composed packet differs from its input only by the
 * intended addition (the test compares them field by field).
 *
 * The line's initial stock is declared by pressure and temperature only:
 * COLD.A's prepared temperature and boron concentration, and the
 * hydrostatic pressure at the line's centroid below the declared PZR roof
 * operating point with COLD.A's prepared density. The network owner
 * prepares mass and energy from them with its own property forward.
 *
 * Usage: bun reference-design-operating-spray-path.ts <joined packet> <wiki root> */
import { createHash } from 'node:crypto'
import { prepareOperatingPzrSpray } from './reference-design-operating-pzr-spray'

type Json = Record<string, any>
type Spray = ReturnType<typeof import('./reference-design-operating-pzr-spray').compileOperatingPzrSpray>

export function composeSprayPath(packet: Json, spray: Spray & { provenance?: unknown }) {
  const m = packet.mechanics, regions = m.regions as Json[], faces = m.faces as Json[]
  const pzr = regions.length - 1, index = (id: string) => regions.findIndex(r => r.id === id)
  if (regions[pzr]!.id !== 'PZR' || pzr !== packet.pzr.cell.index) throw Error('The PZR must be the last region')
  if (index('SPRAY') >= 0 || packet.pzrSpray || packet.external_ports.spray_stock) throw Error('The packet already composes a spray path')
  if (regions[pzr - 1]!.id !== 'SURGE') throw Error('SURGE must precede the PZR')
  const source = index(spray.source)
  if (source < 0 || source >= pzr - 1) throw Error(`Unknown primary source ${spray.source}`)
  const port = (packet.pzr.cell.ports as Json[]).findIndex(p => p.kind === 'spray')
  if (port < 0 || packet.pzr.cell.ports[port].face !== null) throw Error('The PZR needs one spray port without a face')
  if (packet.pzr.cell.ports[port].elevation_m !== spray.line.outletElevation_m) throw Error('The spray port is not at the line outlet')
  if (regions[source]!.elevation_m !== spray.line.inletElevation_m) throw Error(`${spray.source} is not at the line inlet elevation`)
  const out: Json = structuredClone(packet)
  const line = pzr, movedPzr = pzr + 1
  const mo = out.mechanics
  mo.regions.splice(line, 0, { id: 'SPRAY', volume_m3: spray.line.volume_m3, elevation_m: spray.line.centroidElevation_m })
  // The PZR's three index references move with it.
  for (const f of mo.faces as Json[]) {
    if (f.from === pzr || f.supports.some((s: Json) => s.region >= pzr) || f.pressure_segments.some((s: Json) => s.region >= pzr))
      throw Error(`Face ${f.id} touches the PZR other than as its receiver`)
    if (f.to === pzr) f.to = movedPzr
  }
  out.pzr.cell.index = movedPzr
  if (out.external_ports.surge_to_pzr.pzr_cell !== pzr) throw Error('The surge port names another PZR cell')
  out.external_ports.surge_to_pzr.pzr_cell = movedPzr
  // Two half-line paths: each carries half the line's support and rises
  // half its elevation; the PZR side of the second is its port view.
  const [first, second] = spray.halves
  if (!first || !second || first.from !== spray.source || second.to !== 'PZR.SPRAY') throw Error('Unexpected spray halves')
  const half = (h: typeof first) => ({ region: line, path_length_m: h.length_m, inverse_area_length_per_m: h.inverseAreaLength_per_m, volume_m3: h.volume_m3 })
  const valveFace = mo.faces.length, portFace = valveFace + 1
  mo.faces.push(
    { id: first.face, from: source, to: line, flow_area_m2: spray.line.area_m2, supports: [half(first)],
      pressure_segments: [{ region: line, path_length_m: first.length_m, elevation_change_m: first.elevationChange_m }] },
    { id: second.face, from: line, to: movedPzr, flow_area_m2: spray.line.area_m2, supports: [half(second)],
      pressure_segments: [{ region: line, path_length_m: second.length_m, elevation_change_m: second.elevationChange_m }] })
  out.pzr.cell.ports[port].face = portFace
  // Face-loss sections: the line wall on each half; the valve's held-input
  // loss is the network's (zero compiled form loss), the distributor's is
  // fixed on the second half.
  const sections = out.hydraulics.sections as Json[], gravity = out.hydraulics.gravity_m_s2
  const section = (h: typeof first, terms: Json[]) => ({ id: h.face, kind: 'face_loss', face: h.face, region: line, terms,
    parameters: { length_m: h.length_m, area_m2: spray.line.area_m2, hydraulic_diameter_m: spray.line.insideDiameter_m,
      elevation_change_m: h.elevationChange_m, gravity_m_s2: gravity, wall: spray.line.wall, form_loss: h.formLoss,
      grid_count: 0, grid_factor: 0, blockage_fraction: 0, pump: null } })
  const valveSection = sections.length
  sections.push(
    section(first, [{ id: 'SPRAY.VALVE', loss: 0, law: 'held-input form loss (A/(x CdA_full))^2 of the open stem x; the closed stem locks the path' }]),
    section(second, [{ id: 'SPRAY.DISTRIBUTOR', loss: second.formLoss, law: '(A/CdA_d)^2 of the 16-exit distributor on the line area' }]))
  mo.section_force_projection.push({ face: valveFace, section: valveSection, coefficient: 1 },
    { face: portFace, section: valveSection + 1, coefficient: 1 })
  mo.lossScope.faceLossFaces.push(first.face, second.face)
  out.hydraulics.passiveLossScope.faceLossSections.push(...[first, second].map((h, k) => ({ face: h.face,
    sections: [{ id: h.face, wall: spray.line.wall, terms: [sections[valveSection + k]!.terms[0]].map((t: Json) => ({ id: t.id, loss: t.loss })) }] })))
  // The line's initial stock by (p, T): COLD.A's prepared temperature and
  // boron concentration, hydrostatic below the declared roof operating point.
  const water = packet.thermal.water[source] as Json, rho = water.mass_kg / water.volume_m3
  const point = packet.preparation.operatingPoint
  const head = rho * gravity * (point.pzrRoofElevation_m - spray.line.centroidElevation_m)
  out.external_ports.spray_stock = { id: 'SPRAY', volume_m3: spray.line.volume_m3, elevation_m: spray.line.centroidElevation_m,
    pressure_Pa: point.pzrRoofPressure_Pa + head, temperature_K: water.temperature_k,
    absorberMassFraction: packet.water_boron_amount_kg_eq[source] / water.mass_kg,
    basis: `COLD.A's prepared temperature and boron fraction; pressure = roof operating point + rho_COLD.A g (${point.pzrRoofElevation_m} - ${spray.line.centroidElevation_m}) m` }
  out.external_ports.spray_path = { region: line, valve_face: valveFace, port_face: portFace,
    valve_section: valveSection, distributor_section: valveSection + 1 }
  out.pzrSpray = spray
  out.scope = String(packet.scope) + ' With the controlled-spray path (line SPRAY, valve and distributor) composed.'
  return out
}

if (import.meta.main) {
  const [packetPath, wiki] = Bun.argv.slice(2)
  if (!packetPath || !wiki || Bun.argv.length !== 4) throw Error('Usage: operating-spray-path <joined packet> <wiki root>')
  const text = await Bun.file(packetPath).text()
  const composed = composeSprayPath(JSON.parse(text), await prepareOperatingPzrSpray(wiki))
  composed.provenance = { ...composed.provenance, sprayPath: { inputPacketSha256: createHash('sha256').update(text).digest('hex'),
    sourceSha256: createHash('sha256').update(await Bun.file(import.meta.path).text()).digest('hex') } }
  console.log(JSON.stringify(composed))
}
