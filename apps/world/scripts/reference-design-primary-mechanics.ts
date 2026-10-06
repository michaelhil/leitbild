/** Offline geometry/energy selection audit; no new nominal state or time integrator. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { parseConnectedFuel } from './reference-design-connected-fuel'
import { primaryReferencePython, resolveInitializationInput } from './reference-design-initialization'
import { parseSurgeRoute, resolveSurgeRoute } from './reference-design-surge-route'

const positive = z.number().finite().positive()
const schema = z.object({ design: z.literal('LD-01'), hotInsideDiameter_m: positive,
  pumpPassageInsideDiameter_m: positive, pumpPassageVolume_m3: positive,
  coldHeaderVolume_m3: positive, coldHeaderHeight_m: positive, sgDevelopedLength_m: positive,
  coldReturnLength_m: positive,
  downcomerBottom_m: z.number().finite(), downcomerTop_m: z.number().finite(),
}).strict().refine(v => v.downcomerTop_m > v.downcomerBottom_m, 'Invalid downcomer extent')

export function parsePrimaryMechanics(document: string) {
  const blocks = [...document.matchAll(/^```reference-primary-mechanics\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-primary-mechanics block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
}

const barrelSchema = z.object({ innerRadius_m: positive, outerRadius_m: positive }).strict()
  .refine(v => v.outerRadius_m > v.innerRadius_m, 'Barrel outer radius must exceed inner radius')

export function parsePrimaryBarrelGeometry(document: string) {
  const blocks = [...document.matchAll(/^```reference-primary-barrel-geometry\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-primary-barrel-geometry block')
  return barrelSchema.parse(JSON.parse(blocks[0]![1]!))
}

/** Original finite return geometry only; neither a loss calibration nor a flow solution. */
export function coldReturnGeometry(selection: ReturnType<typeof parsePrimaryMechanics>,
  barrel: ReturnType<typeof parsePrimaryBarrelGeometry>, downcomerVolume_m3: number) {
  if (!Number.isFinite(downcomerVolume_m3) || downcomerVolume_m3 <= 0)
    throw Error('Invalid downcomer volume')
  const annularArea = downcomerVolume_m3 / (selection.downcomerTop_m - selection.downcomerBottom_m)
  const innerRadius = barrel.outerRadius_m
  const outerRadius = Math.sqrt(innerRadius ** 2 + annularArea / Math.PI)
  const area = 2 * Math.PI * selection.pumpPassageInsideDiameter_m ** 2 / 4
  const diameter = Math.sqrt(4 * area / Math.PI)
  const angle = 2 * area / (outerRadius ** 2 - innerRadius ** 2)
  if (!(angle > 0 && angle < Math.PI) || diameter > selection.coldHeaderHeight_m)
    throw Error('Return mouths cannot fit the selected annulus/header envelope')
  return { area_m2: area, insideDiameter_m: diameter, wettedPerimeter_m: Math.PI * diameter,
    developedLength_m: selection.coldReturnLength_m, volumePerTrain_m3: area * selection.coldReturnLength_m,
    addedMainVolume_m3: 2 * area * selection.coldReturnLength_m, meanElevation_m: selection.downcomerTop_m,
    annularArea_m2: annularArea, annularInnerRadius_m: innerRadius, annularOuterRadius_m: outerRadius,
    mouthSectorAngle_rad: angle, mouthCentres_rad: [0, Math.PI] as const,
    smoothWallRoughness_m: 0, turningFormLoss: 0,
    scope: 'One equivalent round duct per train, disjoint annular-sector top mouths, ideal stationary turn; no flow, phase-pickup or quantitative bend-loss admission' }
}

export function foldedGeometry(length: number, inlet: number, crest: number, outlet: number) {
  const rise = crest - inlet, descent = crest - outlet
  const radius = (length - rise - descent) / (Math.PI - 2)
  if (![length, inlet, crest, outlet].every(Number.isFinite) || radius <= 0 || radius >= Math.min(rise, descent))
    throw Error('Folded length cannot realize its selected straight legs and semicircular crown')
  const up = rise - radius, down = descent - radius, crown = Math.PI * radius
  const moment = up * (inlet + crest - radius) / 2 + down * (outlet + crest - radius) / 2
    + crown * (crest - radius) + 2 * radius ** 2
  return { radius_m: radius, riseLength_m: up, crownLength_m: crown, descentLength_m: down,
    meanElevation_m: moment / length }
}

export function sectionMechanics(volume: number, area: number, rho: number, massflow: number) {
  if (![volume, area, rho].every(v => Number.isFinite(v) && v > 0) || !Number.isFinite(massflow))
    throw Error('Invalid finite channel')
  const length = volume / area, velocity = massflow / (rho * area)
  return { volume_m3: volume, area_m2: area, length_m: length, velocity_m_s: velocity,
    dynamicPressure_Pa: .5 * rho * velocity ** 2, fluidKineticEnergy_J: .5 * rho * volume * velocity ** 2,
    massFlowInertance_per_m: length / area, residenceTime_s: massflow ? rho * volume / Math.abs(massflow) : null }
}

export function checkColdPartition(oldVolume: number, passage: number, header: number) {
  if (![oldVolume, passage, header].every(v => Number.isFinite(v) && v > 0) || 2 * passage + header !== oldVolume)
    throw Error('Cold passage/header partition must own existing loop volume exactly once')
}

export const currentPrimaryBaseIds = ['DOWNCOMER', 'LOWER', 'CORE.1', 'CORE.2', 'UPPER',
  'HOT.A', 'HOT.B', 'SG.A.PRIMARY', 'SG.B.PRIMARY', 'COLD.A', 'COLD.B', 'PZR'] as const
export type CurrentPrimaryBaseId = typeof currentPrimaryBaseIds[number]
/** Supplied from CURRENT water/displacement owners, never the old steady solve.
 * CORE.1/.2 and LOWER/UPPER are EXTERNAL free water ONLY: all internal guide
 * bore/end water is supplied separately in the open guide cohorts below.
 * Inlet/outlet elevations are physical mouths, not volume-centre datums. */
export type CurrentPrimarySupportGeometry = {
  volume_m3: number; meanElevation_m: number; sourceIdentity: string;
  area_m2?: number; inletElevation_m?: number; outletElevation_m?: number
}
export type CurrentPrimaryMass = {
  mass_kg: number; massRate_kg_s: number; density_kg_m3: number; densityRate_kg_m3_s: number
}
export type CurrentPrimaryGraphInput = {
  selection: ReturnType<typeof parsePrimaryMechanics>;
  barrel: ReturnType<typeof parsePrimaryBarrelGeometry>;
  surge: ReturnType<typeof resolveSurgeRoute>;
  snapshotIdentity: string;
  geometry: Record<CurrentPrimaryBaseId, CurrentPrimarySupportGeometry>;
  hotATee: { length_m: number; meanElevation_m: number; sourceIdentity: string };
  guideCohorts: {
    mode: 'stationary-fully-inserted-homogeneous-cold'; sourceIdentity: string;
    population: { total: number; body: number; thimble: number };
    cohorts: Array<{ id: 'EMPTY' | 'BODY' | 'THIMBLE'; count: number; singleArea_m2: number;
      singleVolume_m3: number; bottom_m: number; top_m: number; meanElevation_m: number }>
  };
  housingPopulation: number;
  housings: Array<{ id: string; volume_m3: number; meanElevation_m: number;
    openingElevation_m: number; sourceIdentity: string }>;
  masses: Record<string, CurrentPrimaryMass>
}
export type CurrentPrimaryGraph = {
  snapshotIdentity: string;
  nodes: Array<CurrentPrimarySupportGeometry & CurrentPrimaryMass & { id: string }>;
  edges: Array<{ id: string; from: number; to: number; fromElevation_m: number;
    toElevation_m: number; forceOwner: string }>;
  carriers: Array<{ supportIndex: number; edgeIndex: number; mass: number; massRate: number;
    area_m2: number; velocityPerMassFlow: number; velocityPerMassFlowRate: number }>;
  unassignedMomentumSupports: number[];
  physicalManifoldAdmitted: false; metricCoverageComplete: false;
  totalVolume_m3: number; totalMass_kg: number;
  omittedPhysicalPorts: string[]; requiredClosures: string[]; scope: string
}

/** Physical-record compiler only. Rust owns incidence/rank/tree/cycle algebra.
 * Every finite water support gets a local mass-incidence row, including open
 * dead-end housings and the finite PZR boundary. A carrier's one-edge velocity
 * map is an expressly partial mean-throughflow snapshot reduction: it is NOT
 * an expansion/unequal-donor kinetic law or a heated low-Mach manifold. */
export function compileCurrentPrimaryGraph(d: CurrentPrimaryGraphInput): CurrentPrimaryGraph {
  const finite = (x: number, what: string) => {
    if (!Number.isFinite(x)) throw Error('Invalid ' + what)
    return x
  }
  const pos = (x: number, what: string) => {
    if (!(finite(x, what) > 0)) throw Error('Nonpositive ' + what)
    return x
  }
  const identity = (x: string, what: string) => {
    if (typeof x !== 'string' || !x.trim()) throw Error('Missing ' + what)
  }
  const close = (a: number, b: number, what: string) => {
    if (!Number.isFinite(a + b) || Math.abs(a - b) > 1e-10 * Math.max(Math.abs(a), Math.abs(b), 1e-12))
      throw Error('Current geometry mismatch: ' + what)
  }
  identity(d.snapshotIdentity, 'snapshot identity')
  if (Object.keys(d.geometry).length !== currentPrimaryBaseIds.length
    || currentPrimaryBaseIds.some(id => !Object.hasOwn(d.geometry, id))) throw Error('Current base support coverage mismatch')
  for (const id of currentPrimaryBaseIds) {
    const q = d.geometry[id]
    pos(q.volume_m3, id + ' volume'); finite(q.meanElevation_m, id + ' datum'); identity(q.sourceIdentity, id + ' source')
    if (q.area_m2 !== undefined) pos(q.area_m2, id + ' area')
    if (q.inletElevation_m !== undefined) finite(q.inletElevation_m, id + ' inlet')
    if (q.outletElevation_m !== undefined) finite(q.outletElevation_m, id + ' outlet')
  }
  const s = schema.parse(d.selection), barrel = barrelSchema.parse(d.barrel), r = d.surge
  const area = (id: CurrentPrimaryBaseId) => pos(d.geometry[id].area_m2!, id + ' area')
  const mouth = (id: CurrentPrimaryBaseId, which: 'inletElevation_m' | 'outletElevation_m') =>
    finite(d.geometry[id][which]!, id + ' ' + which)
  const hotArea = Math.PI * s.hotInsideDiameter_m ** 2 / 4
  for (const id of ['HOT.A', 'HOT.B'] as const) close(area(id), hotArea, id + ' bore')
  close(area('DOWNCOMER'), d.geometry.DOWNCOMER.volume_m3 / (s.downcomerTop_m - s.downcomerBottom_m), 'DOWN area')
  close(mouth('DOWNCOMER', 'inletElevation_m'), s.downcomerTop_m, 'DOWN inlet')
  close(mouth('DOWNCOMER', 'outletElevation_m'), s.downcomerBottom_m, 'DOWN outlet')
  close(mouth('CORE.1', 'outletElevation_m'), mouth('CORE.2', 'inletElevation_m'), 'serial core interface')
  for (const loop of ['A', 'B'] as const) {
    close(d.geometry['COLD.' + loop as CurrentPrimaryBaseId].volume_m3, s.coldHeaderVolume_m3, 'current COLD header ' + loop)
    const id = 'SG.' + loop + '.PRIMARY' as CurrentPrimaryBaseId
    close(area(id), d.geometry[id].volume_m3 / s.sgDevelopedLength_m, id + ' developed section')
  }
  const ret = coldReturnGeometry(s, barrel, d.geometry.DOWNCOMER.volume_m3)
  identity(d.hotATee.sourceIdentity, 'HOT.A tee source')
  pos(d.hotATee.length_m, 'HOT.A tee length'); finite(d.hotATee.meanElevation_m, 'HOT.A tee datum')
  close(d.hotATee.meanElevation_m, d.geometry['HOT.A'].meanElevation_m, 'horizontal HOT.A tee datum')
  const teeVolume = hotArea * d.hotATee.length_m, remainingHot = d.geometry['HOT.A'].volume_m3 - teeVolume
  pos(remainingHot, 'HOT.A remaining inventory')
  // Midpoint attachment, with the SAME finite one-metre water carved out.
  close(r.sourceElevation_m, d.hotATee.meanElevation_m, 'surge source at HOT.A midpoint')
  pos(r.area_m2, 'surge area'); pos(r.liquidVolume_m3, 'surge volume')
  close(r.liquidVolume_m3, r.area_m2 * r.developedLength_m, 'surge finite length')
  finite(r.volumeMeanElevation_m, 'surge datum'); finite(r.receiverElevation_m, 'surge PZR mouth')
  const nodes: CurrentPrimaryGraph['nodes'] = [], edges: CurrentPrimaryGraph['edges'] = [],
    carriers: CurrentPrimaryGraph['carriers'] = [], indexes = new Map<string, number>(),
    mapped = new Set<number>()
  const add = (id: string, q: CurrentPrimarySupportGeometry) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(id) || indexes.has(id)) throw Error('Duplicate/invalid water support ' + id)
    pos(q.volume_m3, id + ' volume'); finite(q.meanElevation_m, id + ' datum'); identity(q.sourceIdentity, id + ' source')
    if (!Object.hasOwn(d.masses, id)) throw Error('Missing finite water snapshot ' + id)
    const m = d.masses[id]!
    pos(m.mass_kg, id + ' mass'); pos(m.density_kg_m3, id + ' density')
    finite(m.massRate_kg_s, id + ' mass rate'); finite(m.densityRate_kg_m3_s, id + ' density rate')
    close(m.mass_kg, m.density_kg_m3 * q.volume_m3, id + ' mass/volume snapshot')
    indexes.set(id, nodes.length); nodes.push({ ...q, ...m, id })
  }
  const copy = (id: CurrentPrimaryBaseId) => add(id, d.geometry[id])
  for (const id of ['DOWNCOMER', 'LOWER', 'CORE.1', 'CORE.2', 'UPPER'] as const) copy(id)
  for (const id of ['HOT.A.BEFORE', 'HOT.A.J', 'HOT.A.AFTER']) add(id, { ...d.geometry['HOT.A'],
    volume_m3: id === 'HOT.A.J' ? teeVolume : remainingHot / 2,
    sourceIdentity: id === 'HOT.A.J' ? d.hotATee.sourceIdentity : d.geometry['HOT.A'].sourceIdentity })
  copy('HOT.B'); copy('SG.A.PRIMARY'); copy('SG.B.PRIMARY')
  for (const loop of ['A', 'B'] as const) for (const ordinal of [1, 2]) add(`P.${loop}${ordinal}.PASSAGE`, {
    volume_m3: s.pumpPassageVolume_m3, area_m2: Math.PI * s.pumpPassageInsideDiameter_m ** 2 / 4,
    meanElevation_m: mouth(`SG.${loop}.PRIMARY`, 'outletElevation_m'),
    sourceIdentity: 'reference-primary-mechanics pump passage; ' + d.geometry[`SG.${loop}.PRIMARY`].sourceIdentity })
  copy('COLD.A'); copy('COLD.B')
  for (const loop of ['A', 'B']) add('RETURN.' + loop, { volume_m3: ret.volumePerTrain_m3,
    area_m2: ret.area_m2, meanElevation_m: ret.meanElevation_m,
    sourceIdentity: 'reference-primary-mechanics + reference-primary-barrel-geometry' })
  const node = (id: string) => {
    const n = indexes.get(id)
    if (n === undefined) throw Error('Unknown connection endpoint ' + id)
    return n
  }
  const connect = (from: string, to: string, elevation: number, forceOwner: string) => {
    finite(elevation, 'connection elevation')
    const id = from + '->' + to, i = edges.length
    edges.push({ id, from: node(from), to: node(to), fromElevation_m: elevation, toElevation_m: elevation, forceOwner })
    return i
  }
  const map = (id: string, edgeIndex: number) => {
    const supportIndex = node(id), q = nodes[supportIndex]!, A = pos(q.area_m2!, id + ' moving area')
    if (mapped.has(supportIndex)) throw Error('Duplicated kinetic inventory ' + id)
    mapped.add(supportIndex)
    const inverse = 1 / (q.density_kg_m3 * A)
    carriers.push({ supportIndex, edgeIndex, mass: q.mass_kg, massRate: q.massRate_kg_s, area_m2: A,
      velocityPerMassFlow: inverse, velocityPerMassFlowRate: -inverse * q.densityRate_kg_m3_s / q.density_kg_m3 })
  }
  map('DOWNCOMER', connect('DOWNCOMER', 'LOWER', s.downcomerBottom_m, 'DOWN smooth wall; LOWER discharge'))
  map('CORE.1', connect('LOWER', 'CORE.1', mouth('CORE.1', 'inletElevation_m'), 'CORE external bundle'))
  map('CORE.2', connect('CORE.1', 'CORE.2', mouth('CORE.1', 'outletElevation_m'), 'CORE external bundle'))
  connect('CORE.2', 'UPPER', mouth('CORE.2', 'outletElevation_m'), 'UPPER discharge mixing')
  map('HOT.A.BEFORE', connect('UPPER', 'HOT.A.BEFORE', mouth('HOT.A', 'inletElevation_m'), 'HOT.A wall'))
  connect('HOT.A.BEFORE', 'HOT.A.J', r.sourceElevation_m, 'HOT.A directional intersection')
  connect('HOT.A.J', 'HOT.A.AFTER', r.sourceElevation_m, 'HOT.A directional intersection')
  map('HOT.A.AFTER', connect('HOT.A.AFTER', 'SG.A.PRIMARY', mouth('HOT.A', 'outletElevation_m'), 'HOT.A wall'))
  map('HOT.B', connect('UPPER', 'HOT.B', mouth('HOT.B', 'inletElevation_m'), 'HOT.B wall'))
  connect('HOT.B', 'SG.B.PRIMARY', mouth('HOT.B', 'outletElevation_m'), 'SG.B entrance')
  for (const loop of ['A', 'B'] as const) {
    const sg = `SG.${loop}.PRIMARY` as const, z = mouth(sg, 'outletElevation_m')
    for (const ordinal of [1, 2]) {
      const pump = `P.${loop}${ordinal}.PASSAGE`
      const inlet = connect(sg, pump, z, `LD01.RCP.${loop}${ordinal} shaft + passage loss`)
      map(pump, inlet)
      connect(pump, 'COLD.' + loop, z, 'COLD header reciprocal discharge')
    }
    const incoming = connect('COLD.' + loop, 'RETURN.' + loop, z, 'RETURN round entrance')
    map('RETURN.' + loop, incoming)
    connect('RETURN.' + loop, 'DOWNCOMER', s.downcomerTop_m, 'RETURN sector stationary turn + moving DOWN join')
  }
  // SG has two outlet branches. Use its SINGLE entrance flow, not one pump.
  for (const loop of ['A', 'B'] as const) {
    const id = `SG.${loop}.PRIMARY`, supportIndex = node(id)
    map(id, edges.findIndex(e => e.to === supportIndex))
  }
  const guides = d.guideCohorts
  identity(guides.sourceIdentity, 'guide population source')
  if (guides.mode !== 'stationary-fully-inserted-homogeneous-cold' || guides.cohorts.length !== 3)
    throw Error('Guide cohort reduction requires explicit stationary homogeneous cold scope')
  const integer = (x: number, what: string) => {
    if (!Number.isSafeInteger(x) || x <= 0) throw Error('Invalid ' + what)
  }
  for (const [name, n] of Object.entries(guides.population)) integer(n, 'guide population ' + name)
  const expected = { EMPTY: guides.population.total - guides.population.body - guides.population.thimble,
    BODY: guides.population.body, THIMBLE: guides.population.thimble }
  const guideIds = new Set<string>()
  for (const g of guides.cohorts) {
    if (!Object.hasOwn(expected, g.id) || guideIds.has(g.id)) throw Error('Duplicate/unknown guide cohort')
    guideIds.add(g.id); integer(g.count, 'guide count'); close(g.count, expected[g.id], 'guide population ' + g.id)
    pos(g.singleArea_m2, 'guide area'); pos(g.singleVolume_m3, 'guide volume')
    finite(g.bottom_m, 'guide bottom'); finite(g.top_m, 'guide top'); finite(g.meanElevation_m, 'guide datum')
    if (!(g.top_m > g.bottom_m)) throw Error('Invalid open guide extent')
    close(g.singleVolume_m3, g.singleArea_m2 * (g.top_m - g.bottom_m), 'constant-section guide cohort')
    close(g.meanElevation_m, (g.bottom_m + g.top_m) / 2, 'constant-section guide datum')
    const id = 'GUIDE.' + g.id
    add(id, { volume_m3: g.count * g.singleVolume_m3, area_m2: g.count * g.singleArea_m2,
      meanElevation_m: g.meanElevation_m, sourceIdentity: guides.sourceIdentity })
    map(id, connect('LOWER', id, g.bottom_m, 'open guide lower mouth + stationary wall law'))
    connect(id, 'UPPER', g.top_m, 'open guide upper mouth + stationary wall law')
  }
  add('SURGE', { volume_m3: r.liquidVolume_m3, area_m2: r.area_m2, meanElevation_m: r.volumeMeanElevation_m,
    sourceIdentity: 'reference-surge-route' }); copy('PZR')
  map('SURGE', connect('HOT.A.J', 'SURGE', r.sourceElevation_m, 'HOT.A surge intersection; surge wall'))
  connect('SURGE', 'PZR', r.receiverElevation_m, 'PZR bottom outer surge receiver')
  integer(d.housingPopulation, 'housing population')
  if (d.housings.length !== d.housingPopulation) throw Error('Current finite housing coverage mismatch')
  for (const h of d.housings) {
    if (!h.id.startsWith('HOUSING.')) throw Error('Housing support id must identify its finite water owner')
    add(h.id, h)
    connect('UPPER', h.id, h.openingElevation_m, 'open-bottom sealed-cap housing expansion')
  }
  if (Object.keys(d.masses).length !== nodes.length || Object.keys(d.masses).some(id => !indexes.has(id)))
    throw Error('Unused/duplicate finite water snapshot')
  return { snapshotIdentity: d.snapshotIdentity, nodes, edges, carriers,
    unassignedMomentumSupports: nodes.flatMap((_, n) => mapped.has(n) ? [] : [n]),
    totalVolume_m3: nodes.reduce((a, n) => a + n.volume_m3, 0),
    totalMass_kg: nodes.reduce((a, n) => a + n.mass_kg, 0),
    metricCoverageComplete: false, physicalManifoldAdmitted: false,
    omittedPhysicalPorts: ['COLD BAL/CMT/spray/charging/letdown/instrument/break connections',
      'DOWN DVI/neck/break connections', 'HOT.A downstream RHR/PRHR takeoffs',
      'UPPER head/WELL/refueling connections', 'SG primary-secondary leakage/break paths',
      'PZR internal ten-region phase and heater/relief/spray connections'],
    requiredClosures: ['current support mean-motion/expansion maps (including mixed junctions and all housings)',
      'HOT.A directional midpoint vector momentum and reciprocal work',
      'moving RETURN/DOWN turning and gravity/pressure work',
      'actual pump rotor/shaft, passive loss and guide wall force-work projections',
      'heated dynamic thermodynamic-pressure/PZR phase manifold and reciprocal entropy work',
      'energy-row flow elimination, pressure gauge and differential/algebraic index proof'],
    scope: 'Current-owner finite-water connection graph and partial mean-throughflow snapshot map only; no thermal law, EOS preparation, physical manifold, full kinetic coverage, trajectory or live runtime admission' }
}

export type PrimaryConstraintSnapshot = {
  gaugeNode: number; massRates: number[]; cycleFlows: number[];
  edgeMassFlowRates: number[]; nodePressure_Pa: number[]; faceDonorDensity_kg_m3: number[]
}
/** Existing native numeric-stdin convention; NOT a graph or matrix solver.
 * k=e-n+1 is only the connected-graph candidate count. Native Network::new
 * must independently reject disconnected/rank-defective physical incidence. */
export function serializePrimaryConstraintSnapshot(g: CurrentPrimaryGraph, d: PrimaryConstraintSnapshot): string {
  const n = g.nodes.length, e = g.edges.length, k = e - n + 1
  if (!Number.isSafeInteger(d.gaugeNode) || d.gaugeNode < 0 || d.gaugeNode >= n || k < 0)
    throw Error('Invalid native gauge or candidate circulation count')
  const vector = (x: number[], count: number, name: string, positiveOnly = false) => {
    if (x.length !== count || x.some(v => !Number.isFinite(v) || (positiveOnly && v <= 0)))
      throw Error('Invalid native ' + name)
    return x.map(String)
  }
  const tokens = [n, e, g.carriers.length, g.unassignedMomentumSupports.length, d.gaugeNode].map(String)
  for (const edge of g.edges) {
    if (![edge.from, edge.to].every(x => Number.isSafeInteger(x) && x >= 0 && x < n) || edge.from === edge.to)
      throw Error('Invalid native physical contact')
    tokens.push(String(edge.from), String(edge.to))
  }
  const owned = new Set<number>()
  for (const c of g.carriers) {
    if (!Number.isSafeInteger(c.supportIndex) || !g.nodes[c.supportIndex] || owned.has(c.supportIndex)
      || !Number.isSafeInteger(c.edgeIndex) || c.edgeIndex < 0 || c.edgeIndex >= e
      || ![c.mass, c.massRate, c.velocityPerMassFlow, c.velocityPerMassFlowRate].every(Number.isFinite)
      || c.mass <= 0 || c.velocityPerMassFlow <= 0) throw Error('Invalid native once-owned velocity carrier')
    owned.add(c.supportIndex)
    const id = g.nodes[c.supportIndex]!.id
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw Error('Invalid native carrier token')
    const weights = Array<number>(e).fill(0), rates = Array<number>(e).fill(0)
    weights[c.edgeIndex] = c.velocityPerMassFlow; rates[c.edgeIndex] = c.velocityPerMassFlowRate
    tokens.push(id, String(c.mass), String(c.massRate), ...weights.map(String), ...rates.map(String))
  }
  tokens.push(...vector(d.massRates, n, 'mass-rate vector'), ...vector(d.cycleFlows, k, 'cycle vector'),
    ...vector(d.edgeMassFlowRates, e, 'flow-rate vector'), ...vector(d.nodePressure_Pa, n, 'pressure vector', true),
    ...vector(d.faceDonorDensity_kg_m3, e, 'donor-density vector', true))
  return tokens.join('\n') + '\n'
}

const nominalCalculation = primaryReferencePython + String.raw`
x,_=solve(steady,xseed,'retained nominal diagnostic');e=evaluate(x)
rho,h,u=properties(e['p'],e['T'])
print(json.dumps(dict(names=names,volume_m3=V.tolist(),pressure_MPa=e['p'].tolist(),temperature_C=e['T'].tolist(),
    rho_kg_m3=rho.tolist(),enthalpy_J_kg=h.tolist(),flows_kg_s=e['m'].tolist(),
    rotorEnergy_J=float(.5*J*sum(e['omega']**2)),gravity_m_s2=g)))
`

export async function auditPrimaryMechanics(wiki: string, python: string) {
  const files = ['systems/primary-coolant/mechanical-energy-and-geometry.md',
    'model/connected-primary-initialization.md', 'model/primary-hydraulic-basis.md',
    'systems/steam-power/cycle-basis.md', 'systems/reactor/fuel-construction.md',
    'systems/primary-coolant/surge-route.md', 'systems/reactor/core-coolant-delivery.md']
  const docs = await Promise.all(files.map(p => Bun.file(join(wiki, p)).text()))
  const selection = parsePrimaryMechanics(docs[0]!)
  const input = await resolveInitializationInput(docs[1]!, docs[2]!, docs[3]!, python, parseConnectedFuel(docs[1]!, docs[4]!))
  const route = resolveSurgeRoute(parseSurgeRoute(docs[5]!))
  const barrel = parsePrimaryBarrelGeometry(docs[6]!)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { sourceSha256: hash(await Bun.file(import.meta.path).text()),
    calculationSha256: hash(nominalCalculation), inputSha256: hash(JSON.stringify({ selection, input, route, barrel })) }
  const child = Bun.spawn([python, '-c', 'import json,sys\nd=json.load(sys.stdin)\n' + nominalCalculation],
    { stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw Error(err)
  const nominal = JSON.parse(out) as { names: string[]; volume_m3: number[]; rho_kg_m3: number[];
    flows_kg_s: number[]; enthalpy_J_kg: number[]; rotorEnergy_J: number; gravity_m_s2: number }
  const cell = (name: string) => {
    const i = nominal.names.indexOf(name)
    if (i < 0) throw Error('Missing nominal owner ' + name)
    return { volume: nominal.volume_m3[i]!, rho: nominal.rho_kg_m3[i]!, h: nominal.enthalpy_J_kg[i]! }
  }
  const hb = input.hydraulics.basis, Vcold = cell('COLD.A').volume
  checkColdPartition(Vcold, selection.pumpPassageVolume_m3, selection.coldHeaderVolume_m3)
  checkColdPartition(cell('COLD.B').volume, selection.pumpPassageVolume_m3, selection.coldHeaderVolume_m3)
  const sg = foldedGeometry(selection.sgDevelopedLength_m, hb.hotPort_m, hb.SGturn_m, hb.coldPort_m)
  const channels: Array<ReturnType<typeof sectionMechanics> & { owner: string; meanElevation_m: number }> = []
  const add = (owner: string, volume: number, area: number, rho: number, flow: number, elevation: number) =>
    channels.push({ owner, meanElevation_m: elevation, ...sectionMechanics(volume, area, rho, flow) })
  const core = input.physicalCore!
  for (const [name, edge, elevation] of [['CORE.1', 1, -1], ['CORE.2', 2, 1]] as const)
    add(name, cell(name).volume, core.geometry.flowArea_m2, cell(name).rho, nominal.flows_kg_s[edge]!, elevation)
  const dc = cell('DOWNCOMER')
  add('DOWNCOMER', dc.volume, dc.volume / (selection.downcomerTop_m - selection.downcomerBottom_m),
    dc.rho, nominal.flows_kg_s[0]!, (selection.downcomerTop_m + selection.downcomerBottom_m) / 2)
  for (const [loop, hotEdge, pumpEdges] of [['A', 6, [8, 9]], ['B', 7, [10, 11]]] as const) {
    const hot = cell('HOT.' + loop), steam = cell('SG.' + loop + '.PRIMARY'), cold = cell('COLD.' + loop)
    add('HOT.' + loop, hot.volume, Math.PI * selection.hotInsideDiameter_m ** 2 / 4,
      hot.rho, nominal.flows_kg_s[hotEdge]!, hb.hotPort_m)
    add('SG.' + loop + '.PRIMARY', steam.volume, steam.volume / selection.sgDevelopedLength_m,
      steam.rho, nominal.flows_kg_s[hotEdge]!, sg.meanElevation_m)
    pumpEdges.forEach((edge, j) => add('P.' + loop + (j + 1) + '.PASSAGE', selection.pumpPassageVolume_m3,
      Math.PI * selection.pumpPassageInsideDiameter_m ** 2 / 4, cold.rho, nominal.flows_kg_s[edge]!, hb.coldPort_m))
  }
  const mixed = ['LOWER', 'UPPER'].map(name => ({ owner: name, volume_m3: cell(name).volume }))
  for (const loop of ['A', 'B']) mixed.push({ owner: 'COLD.' + loop, volume_m3: selection.coldHeaderVolume_m3 })
  const originalVolume = nominal.volume_m3.reduce((a, b) => a + b, 0)
  const previousPartitionVolume = [...channels, ...mixed].reduce((a, b) => a + b.volume_m3, 0)
  if (Math.abs(originalVolume - previousPartitionVolume) > 1e-10) throw Error('Historical primary partition duplicated or lost')
  const returnGeometry = coldReturnGeometry(selection, barrel, dc.volume)
  for (const [loop, edge] of [['A', 12], ['B', 13]] as const)
    add('RETURN.' + loop, returnGeometry.volumePerTrain_m3, returnGeometry.area_m2,
      cell('COLD.' + loop).rho, nominal.flows_kg_s[edge]!, returnGeometry.meanElevation_m)
  const partitionVolume = [...channels, ...mixed].reduce((a, b) => a + b.volume_m3, 0)
  if (Math.abs(partitionVolume - originalVolume - returnGeometry.addedMainVolume_m3) > 1e-10)
    throw Error('New return volume duplicated or lost')
  const orientationArithmetic = []
  const donor = cell('HOT.A'), g = nominal.gravity_m_s2
  for (const m of [-100, 0, 100]) for (const datum of [0, 100]) {
    const sourceZ = route.sourceElevation_m + datum, faceZ = route.receiverElevation_m + datum
    const velocity = m / (donor.rho * route.area_m2)
    const stagnation = donor.h + g * sourceZ
    const faceH = stagnation - g * faceZ - velocity ** 2 / 2
    const flux = m * (faceH + g * faceZ + velocity ** 2 / 2)
    orientationArithmetic.push({ massflow_kg_s: m, datum_m: datum, faceStaticEnthalpy_J_kg: faceH,
      conservedTotalEnthalpy_J_kg: stagnation, recoveryResidual_W: flux - m * stagnation,
      oldCenterEnthalpyAtNewFaceError_W: m * (g * (faceZ - sourceZ) + velocity ** 2 / 2),
      reciprocalPairSum_W: -flux + flux })
  }
  return { ...identity, scope: 'Geometry and mechanical ownership; retained nominal diagnostic, not new plant initialization',
    selection, barrel, returnGeometry, sgFold: sg, coldHeaderEnvelope: { bottom_m: hb.coldPort_m - selection.coldHeaderHeight_m / 2,
      top_m: hb.coldPort_m + selection.coldHeaderHeight_m / 2,
      area_m2: selection.coldHeaderVolume_m3 / selection.coldHeaderHeight_m },
    originalVolume_m3: originalVolume, previousPartitionVolume_m3: previousPartitionVolume, partitionVolume_m3: partitionVolume,
    channels, mixed, totalResolvedChannelKineticEnergy_J: channels.reduce((a, b) => a + b.fluidKineticEnergy_J, 0),
    separateRotorEnergy_J: nominal.rotorEnergy_J, orientationArithmetic,
    arithmeticScope: 'Same HOT diagnostic donor under sign/datum reversal; no actual reverse-donor or EOS port recovery validation',
    lossScale: channels.filter(v => v.owner.startsWith('SG.') || v.owner.startsWith('P.')).map(v => {
      const budget = input.hydraulics.friction_Pa[v.owner.startsWith('SG.') ? 'SG' : 'pump_outlet']
      return { owner: v.owner, retainedCalibrationPressureLoss_Pa: budget, diagnosticDynamicPressure_Pa: v.dynamicPressure_Pa,
        calibrationLossOverDynamicHead: budget / v.dynamicPressure_Pa }
    }),
    surgeMassFlowInertance_per_m: route.developedLength_m / route.area_m2,
    nominal, dynamicTrajectoryQualified: false, liveRuntime: false }
}

if (import.meta.main) {
  const [wiki, python, ...extra] = Bun.argv.slice(2)
  if (!wiki || !python || extra.length) throw Error('Usage: primary-mechanics.ts <LD-01-directory> <research-python>')
  console.log(JSON.stringify(await auditPrimaryMechanics(wiki, python), null, 2))
}
