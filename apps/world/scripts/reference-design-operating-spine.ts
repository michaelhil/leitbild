/** One actual compact hot-spine package. This compiler only changes physical
 * ownership/incidence; Rust owns all current numerical residual laws. The
 * removed SURGE stock is exported, never discarded or used as a held boundary. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseFuelConstruction } from './reference-design-fuel-construction'
import { parseFuelHandling } from './reference-design-fuel-handling'
import { parseControlAbsorber } from './reference-design-control-absorber'
import { parseTransferThermal } from './reference-design-fuel-transfer-thermal'
import { parseOperatingFuelGap } from './reference-design-fuel-cooling'
import { prepareOperatingHot } from './reference-design-operating-hot'
import { compileOperatingThermal, parseOperatingThermal } from './reference-design-operating-thermal'
import { fluidTree, preparePressureContinuity } from './reference-design-operating-fluid'
import { loadOperatingHydraulics, operatingMainInertance, type Section } from './reference-design-operating-hydraulics'
import { prepareOperatingPzr } from './reference-design-operating-pzr'
import { operatingSourceNativeMetadata } from './reference-design-operating-source'
import { routeElevation } from './reference-design-surge-route'

type Edge = { id: string, from: number, to: number }
type Stock = { id: string, volume_m3: number, mass_kg: number, internalEnergy_J: number,
  massPAtEnergy_kg_Pa: number, massEnergyAtPressure_kg_J: number, absorberTracer_kgEq: number }
type Partition = Pick<Awaited<ReturnType<typeof prepareOperatingPzr>>['hotPartition'], 'sourceOwner' | 'totalVolume_m3' | 'parts' | 'area_m2'>
const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0)
const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2e-13 * Math.max(1, Math.abs(a), Math.abs(b))

/** Fixed physical carve, not a configurable graph rewrite. Specific properties
 * and dM/dU|p are intensive; M,U,dM/dp|U and all retained material amounts split
 * with volume. The original packet is not mutated. */
export function carveOperatingPrimary<T extends Stock>(original: readonly T[], edges: readonly Edge[], partition: Partition) {
  const hot = original.findIndex(r => r.id === 'HOT.A'), surge = original.findIndex(r => r.id === 'SURGE')
  if (original.length !== 26 || edges.length !== 32 || hot < 0 || surge < 0 || new Set(original.map(r => r.id)).size !== original.length)
    throw Error('Expected the actual uncarved26-owner primary graph')
  fluidTree(original, edges)
  const owner = original[hot]!, parts = partition.parts
  if (partition.sourceOwner !== owner.id || parts.length !== 3 || parts.some((p, i) => p.id !== ['HOT.A.UPSTREAM', 'HOT.A.JUNCTION', 'HOT.A.DOWNSTREAM'][i]
    || !Number.isFinite(p.volume_m3) || p.volume_m3 <= 0 || !Number.isFinite(p.length_m) || p.length_m <= 0)
    || !near(sum(parts.map(p => p.volume_m3)), owner.volume_m3) || !near(partition.totalVolume_m3, owner.volume_m3)
    || !near(parts[1]!.volume_m3, partition.area_m2) || !near(parts[1]!.length_m, 1)
    || parts.some(p => !near(p.volume_m3, p.length_m * partition.area_m2))) throw Error('HOT.A physical partition does not match its actual owner')
  const scale = (p: typeof parts[number]): T => {
    const f = p.volume_m3 / owner.volume_m3, r = { ...owner, id: p.id, volume_m3: p.volume_m3 }
    // These are the only extensive fields of the actual prepared water chart.
    for (const key of ['mass_kg', 'internalEnergy_J', 'massPAtEnergy_kg_Pa', 'absorberTracer_kgEq',
      'energyP_J_Pa', 'energyT_J_K', 'liquidMass_kg', 'steamMass_kg', 'airMass_kg', 'nitrogenMass_kg']) {
      if (key in owner) {
        const value = (owner as Record<string, unknown>)[key]
        if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Invalid extensive water stock ' + key)
        ;(r as Record<string, unknown>)[key] = value * f
      }
    }
    return r
  }
  const regions = original.flatMap((r, i) => i === surge ? [] : i === hot ? parts.map(scale) : [{ ...r }])
  const index = (id: string) => { const i = regions.findIndex(r => r.id === id); if (i < 0) throw Error('Removed or unknown primary owner ' + id); return i }
  const regionMap = original.map((r, i) => i === hot || i === surge ? -1 : index(r.id))
  const rebased: Edge[] = [], edgeMap: number[][] = edges.map(() => []), append = (old: number, a: string, b: string) => {
    edgeMap[old]!.push(rebased.length); rebased.push({ id: a + '->' + b, from: index(a), to: index(b) })
  }
  let inlet = -1, outlet = -1, external = -1
  for (const [e, edge] of edges.entries()) {
    const a = original[edge.from]!.id, b = original[edge.to]!.id
    if (a === 'HOT.A' && b === 'SURGE') { external = e; continue }
    if (a === 'UPPER' && b === 'HOT.A') {
      inlet = e; append(e, 'UPPER', parts[0]!.id); append(e, parts[0]!.id, parts[1]!.id); append(e, parts[1]!.id, parts[2]!.id)
    } else if (a === 'HOT.A' && b === 'SG.A.PRIMARY') { outlet = e; append(e, parts[2]!.id, b) }
    else {
      if (edge.from === hot || edge.to === hot || edge.from === surge || edge.to === surge) throw Error('Unexpected HOT.A/SURGE physical port')
      append(e, a, b)
    }
  }
  if ([inlet, outlet, external].some(i => i < 0) || regions.length !== 27 || rebased.length !== 33) throw Error('Incomplete physical HOT.A/SURGE carve')
  const tree = fluidTree(regions, rebased)
  if (tree.cycles.length !== 7) throw Error('Changed actual primary circulation dimension')
  for (const key of ['volume_m3', 'mass_kg', 'internalEnergy_J', 'absorberTracer_kgEq', 'massPAtEnergy_kg_Pa'] as const)
    if (!near(sum(regions.map(r => r[key])) + original[surge]![key], sum(original.map(r => r[key])))) throw Error('Nonconservative physical carve ' + key)
  return { regions, edges: rebased, regionMap, edgeMap, tree, hot, surge, inlet, outlet, external,
    surgeStock: { ...original[surge]! }, junction: index(parts[1]!.id), partition }
}

type Carved = ReturnType<typeof carveOperatingPrimary>
/** Rebase the actual19 supports to21 without changing numerical constitutive
 * laws. Distributed HOT.A loss is split by length exactly once. The separate
 * lateral junction/line force law is still an explicit external dependency. */
export function rebaseOperatingHydraulics(original: Awaited<ReturnType<typeof loadOperatingHydraulics>>, carved: Carved) {
  const mapRegion = (i: number) => { const r = carved.regionMap[i]; if (r === undefined || r < 0) throw Error('Hydraulic receipt refers to removed water owner'); return r }
  const mapEdge = (i: number) => { const e = carved.edgeMap[i]; if (!e?.length) throw Error('Hydraulic receipt refers to removed edge'); return e[0]! }
  const hot = original.sections.find(s => s.id === 'HOT.A')
  if (!hot || original.sections.length !== 19) throw Error('Expected actual19 hydraulic supports')
  const chain = [...carved.edgeMap[carved.inlet]!, ...carved.edgeMap[carved.outlet]!]
  const sections: Section[] = original.sections.flatMap(s => s.id !== 'HOT.A' ? [{ ...s, region: mapRegion(s.region),
    flow: s.flow.map(t => ({ ...t, edge: mapEdge(t.edge) })), force: s.force.map(t => ({ ...t, edge: mapEdge(t.edge) })),
    conversionRecipients: s.conversionRecipients.map(r => ({ ...r, region: mapRegion(r.region) })) }] : carved.partition.parts.map((p, i) => {
      const region = carved.regions.findIndex(r => r.id === p.id), flow = [{ edge: chain[i]!, weight: .5 }, { edge: chain[i + 1]!, weight: .5 }]
      return { ...s, id: p.id, region, flow, force: flow.map(t => ({ ...t })),
        parameters: { ...s.parameters, length_m: p.length_m, form_loss: s.parameters.form_loss * p.length_m / s.parameters.length_m },
        movingVolume_m3: p.volume_m3, retainedThermalVolume_m3: p.volume_m3,
        conversionRecipients: s.conversionRecipients.map(r => ({ ...r, region })) }
    }))
  const columns = original.cycles.columns.map(col => {
    const c = carved.edges.map(() => 0)
    for (const [old, targets] of carved.edgeMap.entries()) for (const e of targets) c[e] = col[old]!
    if (col[carved.external] !== 0 || col[carved.inlet] !== col[carved.outlet]) throw Error('Invalid original HOT.A/SURGE cycle support')
    const B = carved.regions.map(() => 0)
    for (const [e, w] of c.entries()) { B[carved.edges[e]!.from]! -= w; B[carved.edges[e]!.to]! += w }
    if (B.some(x => x !== 0)) throw Error('Rebased circulation is not in the incidence nullspace')
    return c
  })
  const cycles = { ids: [...original.cycles.ids], columns,
    incidence: columns.flatMap((col, cycle) => col.flatMap((weight, edge) => weight !== 0 ? [{ edge, cycle, weight }] : [])) }
  const forceIncidence = sections.flatMap((s, section) => s.force.map(t => ({ ...t, section })))
  const coveredEdges = [...new Set(forceIncidence.map(t => t.edge))].sort((a, b) => a - b)
  const gravityIncidence = original.gravityIncidence.map(g => ({ ...g, edge: mapEdge(g.edge), region: g.region === carved.hot
    ? carved.regions.findIndex(r => r.id === carved.partition.parts[g.edge === carved.outlet ? 2 : 0]!.id) : mapRegion(g.region) }))
  const main = operatingMainInertance(sections, cycles)
  if (sections.length !== 21 || coveredEdges.length !== 31 || !near(main.matrix.aa, original.mainInertance.aa)
    || !near(main.matrix.ab, original.mainInertance.ab) || !near(main.matrix.bb, original.mainInertance.bb)
    || !near(sum(sections.filter(s => s.id.startsWith('HOT.A.')).map(s => s.parameters.form_loss)), hot.parameters.form_loss))
    throw Error('Changed physical circulation geometry/loss in HOT.A carve')
  return { ...original, sections, forceIncidence, gravityIncidence, cycles, mainInertance: main.matrix, mainInertanceSupports: main.supports,
    coveredEdges, unclosedTreeEdges: carved.edges.flatMap((e, edge) => coveredEdges.includes(edge) ? [] : [{ edge, id: e.id }]),
    unclosedJunctions: ['HOT.A.JUNCTION finite directional lateral surge intersection (external port)'],
    kineticScope: '21 once-owned geometric supports; same two-main metric and five split force rows. Lateral surge/expansion acceleration and junction force are not admitted.' }
}

/** Actual route integration/ownership, not another hydraulic numerical law.
 * The two half-route supports are a selected mass-lumped geometric candidate;
 * force/convection/traction and its joint pressure chart need native admission.
 * In particular, actual first-moment Px contains expansion-tree flow that is
 * NOT automatically retained by the original two-main circulation metric. */
export function compileOperatingSurgeHydraulics(pzr: Pick<Awaited<ReturnType<typeof prepareOperatingPzr>>, 'surge' | 'hotPartition'>) {
  const r = pzr.surge.route, length = r.developedLength_m, middle = length / 2, area = r.area_m2
  const elevationIntegral = (s: number) => {
    if (!Number.isFinite(s) || s < 0 || s > length) throw Error('Surge integral outside actual route')
    if (s <= r.risingStart_m) return r.sourceElevation_m * s
    const arc = Math.PI * r.bendRadius_m / 2
    if (s <= r.verticalStart_m) {
      const d = s - r.risingStart_m
      return r.sourceElevation_m * s + r.bendRadius_m * d - r.bendRadius_m ** 2 * Math.sin(d / r.bendRadius_m)
    }
    const d = s - r.verticalStart_m
    return r.sourceElevation_m * s + r.bendRadius_m * arc - r.bendRadius_m ** 2 + r.bendRadius_m * d + d * d / 2
  }
  const halves = [0, 1].map(half => {
    const start = half * middle, end = start + middle
    const pieces = pzr.surge.pieces.flatMap(piece => {
      const lo = Math.max(start, piece.start_m), hi = Math.min(end, piece.end_m)
      if (lo >= hi) return []
      // The actual eight-metre cut is in a straight, not inside either elbow.
      if (piece.elbowLoss !== 0 && (lo !== piece.start_m || hi !== piece.end_m)) throw Error('A split elbow requires an explicit loss-location decision')
      return [{ id: piece.id + '.HALF.' + half, physical_piece_id: piece.id, start_m: lo, end_m: hi,
        length_m: hi - lo, area_m2: area, volume_m3: (hi - lo) * area,
        inletElevation_m: routeElevation(r, lo), outletElevation_m: routeElevation(r, hi),
        meanElevation_m: (elevationIntegral(hi) - elevationIntegral(lo)) / (hi - lo),
        roughness_m: piece.wallRoughness_m, elbowLoss: piece.elbowLoss }]
    })
    return { id: 'SURGE.HALF.' + half, start_m: start, end_m: end, length_m: middle, area_m2: area,
      volume_m3: middle * area, inletElevation_m: routeElevation(r, start), outletElevation_m: routeElevation(r, end),
      elevationChange_m: routeElevation(r, end) - routeElevation(r, start),
      meanElevation_m: (elevationIntegral(end) - elevationIntegral(start)) / middle,
      geometricInertance_per_m: middle / area, hydraulicDiameter_m: r.internalDiameter_m, roughness_m: r.roughness_m,
      elbowLoss: sum(pieces.map(p => p.elbowLoss)), pieces,
      forceRecipient: 'SURGE', additionalThermalPower: false as const }
  })
  if (!near(sum(halves.map(h => h.volume_m3)), r.liquidVolume_m3)
    || !near(sum(halves.map(h => h.length_m)), length)
    || !near(sum(halves.map(h => h.elbowLoss)), 2 * r.elbowLoss)
    || !near(sum(halves.map(h => h.meanElevation_m * h.length_m)) / length, r.volumeMeanElevation_m))
    throw Error('Nonconservative physical surge-half partition')
  const mainArea = pzr.hotPartition.area_m2, width = Math.sqrt(mainArea), lateralArm = width / 2,
    junctionLength = pzr.hotPartition.parts[1]!.length_m
  if (![area, mainArea, lateralArm, junctionLength].every(x => Number.isFinite(x) && x > 0)) throw Error('Invalid actual junction first moment')
  return { halves, momentumPlane: { distance_m: middle, elevation_m: routeElevation(r, middle) },
    inventoryMeanElevation_m: r.volumeMeanElevation_m,
    lossLaw: 'Reviewed circular Churchill Darcy64/Re continuation with actual roughness; NOT annular96/Re or smooth Colebrook',
    endpointLoss: { hotEntrance: 0, pzrReceipt: 0, pzrWithdrawalCdA_m2: area / Math.sqrt(1 + r.entryLoss),
      scope: 'No retired HOT entrance/tee or PZR exit loss; phase-weighted withdrawal area belongs to its separate endpoint receipt' },
    junctionFirstMoment: { status: 'PROJECTION_CANDIDATE' as const, owner: 'HOT.A.JUNCTION',
      mainAxisArm_m: junctionLength / 2, lateralArm_m: lateralArm,
      lateralInertance_per_m: lateralArm / area,
      mainMoment: 'Px=Lx/2*(qin_main+qout_main)', lateralMoment: 'Py=width/2*qout_surge',
      meanVelocity: 'Current vector first moment divided by actual junction mass; never qsurge/(rho*surgeArea) as whole-junction velocity',
      scope: 'Uniform retained-density continuity first moment. Actual open-face/wall traction and upwind vector convection are unadmitted. MAIN metric covers only its selected cycle contribution; expansion-tree Px inertia needs explicit ownership or an omission diagnostic.' },
    inertiaScope: 'Two diagonal Lhalf/A geometric supports are a mass-lumped low-Mach candidate, not exact affine-profile inertia, an acoustic face or admitted surge dynamics' }
}

export async function prepareOperatingSpine(wiki: string, if97: string) {
  const base = join(wiki, 'world/packs/process-plant/reference-designs/ld-01'), read = (p: string) => Bun.file(join(base, p)).text()
  const [hot, fuelDoc, handlingDoc, controlDoc, thermalDoc, gapDoc] = await Promise.all([
    prepareOperatingHot(wiki, if97), read('systems/reactor/fuel-construction.md'), read('systems/reactor/fuel-handling-and-pool.md'),
    read('systems/reactor/control-absorber-and-guide-water.md'), read('model/operating-thermal.md'), read('systems/reactor/phase-dependent-heat-transfer.md')])
  const originalThermal = compileOperatingThermal(parseFuelConstruction(fuelDoc), parseFuelHandling(handlingDoc), parseControlAbsorber(controlDoc),
    hot.fluid, hot.energy, parseOperatingThermal(thermalDoc), parseTransferThermal(handlingDoc), parseOperatingFuelGap(gapDoc))
  const hotOwner = hot.fluid.geometry.regions.find(r => r.id === 'HOT.A')!
  const [pzr, originalHydraulics] = await Promise.all([prepareOperatingPzr(wiki, if97, hotOwner), loadOperatingHydraulics(wiki, hot.fluid.geometry)])
  const carved = carveOperatingPrimary(hot.fluid.primary.regions, hot.fluid.primary.edges, pzr.hotPartition)
  const waterIndex = (old: number) => { const i = carved.regionMap[old]; if (i === undefined || i < 0) throw Error('Thermal/source contact requires an explicit physical repartition'); return i }
  const direct = carved.regions.map(() => 0)
  for (const [i, q] of originalThermal.direct_water_source_w.entries()) {
    if (q !== 0) direct[waterIndex(i)]! += q
  }
  const thermal = { ...originalThermal,
    core_contacts: originalThermal.core_contacts.map(c => ({ ...c, water: waterIndex(c.water) })),
    passive_contacts: originalThermal.passive_contacts.map(c => ({ ...c, water: waterIndex(c.water) })),
    sg_segments: originalThermal.sg_segments.map(c => ({ ...c, primary: waterIndex(c.primary) })),
    water: carved.regions.map(r => ({ id: r.id, pressure_pa: r.water.p, temperature_k: r.water.T,
      volume_m3: r.volume_m3, mass_kg: r.mass_kg, energy_j: r.internalEnergy_J })), direct_water_source_w: direct }
  const projection = preparePressureContinuity(carved.regions, carved.edges, direct, carved.regions.map(() => 0), Array(7).fill(0))
  const source_water = hot.nativeInput.fluid.source_band_to_region.map(waterIndex)
  const nativeFluid = { ...hot.nativeInput.fluid,
    primary_mass_kg: sum(carved.regions.map(r => r.mass_kg)), primary_energy_j: sum(carved.regions.map(r => r.internalEnergy_J)),
    primary_volume_m3: sum(carved.regions.map(r => r.volume_m3)), source_band_to_region: source_water,
    regions: carved.regions.map(r => ({ id: r.id, volume_m3: r.volume_m3, density_kg_m3: r.water.rho, pressure_pa: r.water.p,
      enthalpy_j_kg: r.water.h, specific_internal_energy_j_kg: r.water.u, mass_kg: r.mass_kg, energy_j: r.internalEnergy_J,
      mass_p_at_energy_kg_pa: r.massPAtEnergy_kg_Pa, mass_energy_at_pressure_kg_j: r.massEnergyAtPressure_kg_J })),
    direct_coolant_projection: { heat_w: direct, edges: carved.edges.map(e => ({ from: e.from, to: e.to })),
      donors: projection.donors, flows_kg_s: projection.flows_kg_s, pressure_rate_pa_s: projection.pressureRate_Pa_s } }
  const rebasedHydraulics = rebaseOperatingHydraulics(originalHydraulics, carved),
    hydraulics = { ...rebasedHydraulics, surge: { ...rebasedHydraulics.surge, ...compileOperatingSurgeHydraulics(pzr) } }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { identity: 'LD01-HOT-SPINE-1', thermal, hot: { ...hot.nativeInput, fluid: nativeFluid },
    feedback_metadata: operatingSourceNativeMetadata(hot.compiledSource), feedback_reference: hot.compiledSource.reference.conditions,
    edges: carved.edges, source_water, water_flow_area_m2: carved.regions.map(r => r.mainFlowArea_m2),
    water_boron_amount_kg_eq: carved.regions.map(r => r.absorberTracer_kgEq), hydraulics, pzr,
    external_ports: {
      surge_stock: carved.surgeStock,
      primary_to_surge: { id: 'HOT.A.JUNCTION->SURGE', primary_water: carved.junction, surge_id: carved.surgeStock.id,
        area_m2: pzr.hotPartition.surgeArea_m2, elevation_m: pzr.hotPartition.elevation_m,
        normal: pzr.hotPartition.junctionPorts[2]!.normal },
      surge_to_pzr: { id: 'SURGE->PZR.SURGE.MOUTH', surge_id: carved.surgeStock.id, pzr_water: pzr.mouth.region,
        area_m2: pzr.mouth.area_m2, elevation_m: pzr.mouth.elevation_m, normal: pzr.mouth.normal },
      receiptRule: 'Signed actual donor material/thermal enthalpy; no prescribed flow, pressure matching or zero-filled external equation',
      scope: 'Finite removed line stock and actual geometry/storage ports; native SURGE provides current signed M/H/B transport. Surge/junction forces, PZR pressure/kinematic/inertia and phase events, and complete unit F remain open.' },
    preparation: { direct_source_projection: projection,
      scope: 'Preparation-only pressure/enthalpy/continuity check with specified zero cycle currents and no external mass. It is not the joined current-flow solution.' },
    provenance: { sourceSha256: hash(await Bun.file(import.meta.path).text()), hot: hot.provenance, fluid: hot.fluid.provenance,
      hydraulics: originalHydraulics.provenance, pzr: pzr.provenance,
      thermalOwners: ['systems/reactor/fuel-construction.md', 'systems/reactor/fuel-handling-and-pool.md', 'systems/reactor/control-absorber-and-guide-water.md',
        'model/operating-thermal.md', 'systems/reactor/phase-dependent-heat-transfer.md'].map((name, i) => ({ name,
          sha256: hash([fuelDoc, handlingDoc, controlDoc, thermalDoc, gapDoc][i]!) })) },
    scope: 'Connected current source/finite-thermal/primary residual inputs, with explicit external surge/PZR dependencies. No held-pressure, complete mechanical, global-rank or trajectory admission.' }
}

if (import.meta.main) {
  const [wiki, if97] = Bun.argv.slice(2)
  if (!wiki || !if97 || Bun.argv.length !== 4) throw Error('Usage: operating-spine <wiki root> <pinned IF97 directory>')
  console.log(JSON.stringify(await prepareOperatingSpine(wiki, if97)))
}
