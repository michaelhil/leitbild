/** Offline cold connected primary/finite SG metal and wet secondary input.
 * Not LD-01 installation, hot shutdown, powered equipment or whole plant. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { currentPhysicalPrimaryGeometry } from './reference-design-primary-physical-geometry'
import { coldReturnGeometry, foldedGeometry } from './reference-design-primary-mechanics'
import { parseConnectedFuelSelection } from './reference-design-connected-fuel'
import { fuelGeometry } from './reference-design-fuel-construction'
import { compileSourcePartition } from './reference-design-source-partition'
import { parseOperatingFuelCohorts } from './reference-design-source-material'
import { compilePrimaryWaterGeometry, originalWaterMassRelativeScreen } from './reference-design-source-water'
import { compilePrhrOperatingGeometry } from './reference-design-prhr-operating'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const controlsSchema = z.object({ horizon_s: z.number().finite().min(60).max(300),
  remainingBudget_s: z.number().finite().positive().max(120) }).strict()
export type Water = { id: string; volume_m3: number; elevation_m: number; markerRatio: number; temperature_K: number; owners: string[] }
export type Solid = { id: string; capacity_J_K: number; temperature_K: number; owners: string[] }
export type HydraulicSegment = { kind: 0 | 1 | 2 | 3 | 4 | 5; length_m: number;
  area_m2: number; diameter_m: number; roughness_m: number; fixedLoss: number;
  gridMultiplierOrAnnularDarcyCoefficient: number }
export type Hydraulic = { id: string; from: number; to: number; from_elevation_m: number; to_elevation_m: number;
  segments: HydraulicSegment[]; basis: string }
export type Heat = { kind: 2; from: number; to: number; area_m2: number; thermalDiameter_m: number;
  flowArea_m2: number; hydraulicEdge: number; basis: string }
  | { kind: 0; from: number; to: number; conductance_W_K: number; basis: string }
type Secondary = { id: string; volume_m3: number; temperature_K: number; pressure_Pa: number;
  liquidVolume_m3: number; gasVolume_m3: number; nitrogenMass_kg: number; minimumWettedVolume_m3: number }
type SecondaryHeat = { solid: number; secondary: number; area_m2: number; diameter_m: number }

/** Read the CURRENT selected noncore table; old pressure calibration is not run. */
export function parseOperatingNoncoreLosses(document: string) {
  const selected = document.split('## Current nonnegative physical loss allocation')[1]?.split('## Retained prescribed-temperature reference')[0]
  if (!selected) throw Error('Missing current nonnegative loss allocation')
  const get = (name: string) => {
    const rows = selected.split('\n').filter(line => line.startsWith('| ' + name + ' |'))
    if (rows.length !== 1) throw Error('Missing/duplicate selected loss row: ' + name)
    const values = rows[0]!.split('|').map(v => v.trim())
    const total = Number(values[2])
    if (!(Number.isFinite(total) && total >= 0)) throw Error('Invalid selected loss: ' + name)
    return total
  }
  return { hot: get('HOT path'), sg: get('Folded SG primary'), pump: get('Each pump passage / COLD entry') }
}

export function parseOperatingSgColdContact(document: string) {
  const contact = document.split('### Primary coastdown and phase contact')[1]?.split('###')[0]
  const geometry = contact?.match(/selected \*\*([\d,]+) m²\*\* effective area and \*\*([\d.]+) m\*\* thermal diameter/)
  const cold = document.split('### Cold secondary and startup heat-receiving path')[1]?.split('###')[0]
  const initial = cold?.match(/Initialize the existing distributed SG metal uniformly at ([\d.]+)°C, retaining its \*\*([\d.]+) MJ\/K\*\* capacity/)
  if (!geometry || !initial || !contact?.includes('max(3.66, Nu_natural, Nu_turb)'))
    throw Error('Missing current SG sensible-film/cold-metal selection')
  const result = { area_m2: Number(geometry[1]!.replaceAll(',', '')), diameter_m: Number(geometry[2]),
    temperature_K: Number(initial[1]) + 273.15, capacity_J_K: Number(initial[2]) * 1e6 }
  if (!Object.values(result).every(v => Number.isFinite(v) && v > 0)) throw Error('Invalid current SG thermal geometry')
  return result
}

/** Consume the physical preparation, not historical property-formulation inventories. */
export function parseOperatingSgSecondary(document: string) {
  const cold = document.split('### Cold secondary and startup heat-receiving path')[1]?.split('###')[0]
  const initial = cold?.match(/Each SG starts at ([\d.]+)°C, ([\d.]+) Pa total absolute pressure, with its existing ([\d.]+) m³ envelope divided into ([\d.]+) m³ liquid and ([\d.]+) m³ shared gas/)
  const geometry = document.split('## Secondary exposure and local metal storage')[1]?.split('###')[0]
  const surface = geometry?.match(/horizontal area \*\*([\d.]+) m²\*\*, bottom \*\*\+([\d.]+) m\*\*/)
  const crest = geometry?.match(/crown at \+([\d.]+) m/)
  if (!initial || !surface || !crest || !cold?.includes('nitrogen is zero'))
    throw Error('Missing current SG cold material preparation/contact geometry')
  const result = { temperature_K: Number(initial[1]) + 273.15, pressure_Pa: Number(initial[2]),
    volume_m3: Number(initial[3]), liquidVolume_m3: Number(initial[4]), gasVolume_m3: Number(initial[5]),
    nitrogenMass_kg: 0, minimumWettedVolume_m3: (Number(crest[1]) - Number(surface[2])) * Number(surface[1]) }
  if (![result.temperature_K, result.pressure_Pa, result.volume_m3, result.liquidVolume_m3,
    result.gasVolume_m3, result.minimumWettedVolume_m3].every(v => Number.isFinite(v) && v > 0)
    || Math.abs(result.liquidVolume_m3 + result.gasVolume_m3 - result.volume_m3) > 1e-10 * result.volume_m3
    || result.liquidVolume_m3 < result.minimumWettedVolume_m3)
    throw Error('Invalid current SG cold volume/fully-wetted preparation')
  return result
}

/** Volume first moments for disjoint developed-length pieces of the actual fold. */
export function foldedPieceCentroid(length: number, inlet: number, crest: number, outlet: number, lo: number, hi: number) {
  const f = foldedGeometry(length, inlet, crest, outlet)
  if (!(Number.isFinite(lo + hi) && lo >= 0 && hi > lo && hi <= length)) throw Error('Invalid folded piece')
  const arcStart = f.riseLength_m, arcEnd = arcStart + f.crownLength_m, zc = crest - f.radius_m
  const primitive = (s: number) => {
    const up = Math.min(s, arcStart)
    let value = inlet * up + up * up / 2
    if (s > arcStart) {
      const a = Math.min(s - arcStart, f.crownLength_m)
      value += zc * a + f.radius_m ** 2 * (1 - Math.cos(a / f.radius_m))
    }
    if (s > arcEnd) { const down = s - arcEnd; value += zc * down - down * down / 2 }
    return value
  }
  return (primitive(hi) - primitive(lo)) / (hi - lo)
}

export function annularLaminarGeometry(length: number, outerRadius: number, innerRadius: number, parallel: number) {
  if (![length, outerRadius, parallel].every(v => Number.isFinite(v) && v > 0)
    || !Number.isFinite(innerRadius) || innerRadius < 0 || innerRadius >= outerRadius) throw Error('Invalid annular restriction')
  const r4 = innerRadius === 0 ? outerRadius ** 4 : outerRadius ** 4 - innerRadius ** 4
    - (outerRadius ** 2 - innerRadius ** 2) ** 2 / Math.log(outerRadius / innerRadius)
  const value = 8 * length / (Math.PI * r4 * parallel)
  if (!(value > 0 && Number.isFinite(value))) throw Error('Unresolved annular laminar resistance')
  return value
}

export function parseOperatingGuideDrag(document: string) {
  const selected = document.split('## Finite guide water, force and heat interfaces')[1]?.split('## Bank, source and head handoff')[0]
  const roughness = selected?.match(/The ([\d.]+) μm roughness/)
  const mouths = selected?.match(/two open mouths each have the selected dimensionless loss coefficient ([\d.]+)/)
  if (!roughness || !mouths || !selected?.includes('chi=max(1, fDarcy,Churchill')) throw Error('Missing current guide drag selection')
  const result = { roughness_m: Number(roughness[1]) * 1e-6, mouthLoss: Number(mouths[1]) }
  if (!Object.values(result).every(v => Number.isFinite(v) && v >= 0)) throw Error('Invalid guide drag selection')
  return result
}

/** Hash transitive local TypeScript consumers, not only this coordinator. */
export async function helperIdentities(entry: string) {
  const seen = new Set<string>(), rows: Array<{ path: string; sha256: string }> = []
  async function visit(path: string) {
    if (seen.has(path)) return
    seen.add(path)
    const text = await Bun.file(path).text()
    rows.push({ path, sha256: sha(text) })
    for (const match of text.matchAll(/(?:from\s*|import\s*)['"](\.\/?[^'"]+)['"]/g)) {
      const spec = match[1]!, dependency = resolve(dirname(path), spec.endsWith('.ts') ? spec : spec + '.ts')
      await visit(dependency)
    }
  }
  await visit(entry)
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

export async function compileOperatingNetwork(wikiDirectory: string, controls: z.infer<typeof controlsSchema>,
  currentPreparation?: { temperature_K: number }, features: { prhr: false } | { prhr: true; bankTemperature_K: number } = { prhr: false }) {
  if (typeof wikiDirectory !== 'string' || !wikiDirectory.trim()) throw Error('Explicit LD-01 owner directory required')
  const run = controlsSchema.parse(controls), wiki = resolve(wikiDirectory)
  if (features.prhr && !(Number.isFinite(features.bankTemperature_K) && features.bankTemperature_K > 0))
    throw Error('Explicit PRHR operating bank temperature required')
  const physical = await currentPhysicalPrimaryGeometry(wiki), d = physical.physicalInputs, g = physical.input.geometry, hb = physical.hydraulicBasis
  const preparation = currentPreparation === undefined ? undefined
    : z.object({temperature_K:z.number().finite().positive()}).strict().parse(currentPreparation),
    currentAnchor = {...d.anchor, temperature_K:preparation?.temperature_K ?? d.anchor.temperature_K}
  const extras = ['model/primary-hydraulic-basis.md', 'systems/steam-generation/thermodynamics.md',
    'systems/reactor/radial-energy-transient.md', 'model/connected-primary-initialization.md',
    'systems/reactor/control-absorber-and-guide-water.md', 'systems/reactor/core-coolant-delivery.md',
    'systems/primary-coolant/mechanical-energy-and-geometry.md',
    'systems/passive-cooling/residual-heat-exchanger.md']
  const docs = await Promise.all(extras.map(p => Bun.file(join(wiki, p)).text()))
  const losses = parseOperatingNoncoreLosses(docs[0]!), sg = parseOperatingSgColdContact(docs[1]!),
    secondaryPreparation = parseOperatingSgSecondary(docs[1]!),
    fuel = fuelGeometry(d.fuel), core = parseConnectedFuelSelection(docs[3]!), cohorts = parseOperatingFuelCohorts(docs[2]!),
    guideDrag = parseOperatingGuideDrag(docs[4]!), prhr = features.prhr ? compilePrhrOperatingGeometry(docs[7]!) : undefined,
    source = compileSourcePartition(d),
    originalPreparation = compilePrimaryWaterGeometry(source, d),
    water: Water[] = [], solids: Solid[] = [], hydraulic: Hydraulic[] = [], heat: Heat[] = [],
    secondaries: Secondary[] = [], secondaryHeat: SecondaryHeat[] = []
  const indexes = new Map<string, number>(), add = (id: string, V: number, z: number, owners: string[], temperature = currentAnchor.temperature_K) => {
    if (indexes.has(id) || !(V > 0 && Number.isFinite(V + z))) throw Error('Invalid/duplicate operating water owner: ' + id)
    indexes.set(id, water.length); water.push({ id, volume_m3: V, elevation_m: z, markerRatio: d.cold.primaryAbsorberRatio, temperature_K: temperature, owners })
  }
  for (const id of ['DOWNCOMER', 'LOWER', 'CORE.1', 'CORE.2'] as const)
    add(id, g[id].volume_m3, g[id].meanElevation_m, [id])
  const housingV = physical.expectedHousingVolume_m3
  const upperV = g.UPPER.volume_m3 + housingV
  const upperMoment = g.UPPER.volume_m3 * g.UPPER.meanElevation_m
    + physical.input.housings.reduce((s, h) => s + h.volume_m3 * h.meanElevation_m, 0)
  add('UPPER', upperV, upperMoment / upperV, ['UPPER', ...physical.input.housings.map(h => h.id)])
  for (const loop of ['A', 'B'] as const) {
    const secondary = secondaries.length
    secondaries.push({ id: `SG.${loop}.SECONDARY`, ...secondaryPreparation })
    if (loop === 'A' && prhr) for (const id of ['HOT.A.BEFORE', 'HOT.A.J', 'HOT.A.AFTER'])
      add(id, physical.volumes[id]!, g['HOT.A'].meanElevation_m, [id])
    else add(`HOT.${loop}`, g[`HOT.${loop}`].volume_m3, g[`HOT.${loop}`].meanElevation_m,
      loop === 'A' ? ['HOT.A.BEFORE', 'HOT.A.J', 'HOT.A.AFTER'] : ['HOT.B'])
    for (let piece = 0; piece < 4; piece++) {
      const id = `SG.${loop}.PRIMARY.${piece + 1}`, L = d.primary.sgDevelopedLength_m
      add(id, g[`SG.${loop}.PRIMARY`].volume_m3 / 4,
        foldedPieceCentroid(L, g[`SG.${loop}.PRIMARY`].inletElevation_m!, hb.SGturn_m,
          g[`SG.${loop}.PRIMARY`].outletElevation_m!, piece * L / 4, (piece + 1) * L / 4), [`SG.${loop}.PRIMARY`])
      solids.push({ id: `SG.${loop}.METAL.${piece + 1}`, capacity_J_K: sg.capacity_J_K / 4,
        temperature_K: sg.temperature_K, owners: [`SG.${loop}.METAL`] })
      secondaryHeat.push({ solid: solids.length - 1, secondary, area_m2: sg.area_m2 / 4, diameter_m: sg.diameter_m })
    }
    for (const ordinal of [1, 2]) add(`P.${loop}${ordinal}.PASSAGE`, d.primary.pumpPassageVolume_m3,
      g[`SG.${loop}.PRIMARY`].outletElevation_m!, [`P.${loop}${ordinal}.PASSAGE`])
    add(`COLD.${loop}`, g[`COLD.${loop}`].volume_m3, g[`COLD.${loop}`].meanElevation_m, [`COLD.${loop}`])
    const r = coldReturnGeometry(d.primary, d.barrel, g.DOWNCOMER.volume_m3)
    add('RETURN.' + loop, r.volumePerTrain_m3, r.meanElevation_m, ['RETURN.' + loop])
  }
  for (const c of physical.input.guideCohorts.cohorts)
    add('GUIDE.' + c.id, c.count * c.singleVolume_m3, c.meanElevation_m, ['GUIDE.' + c.id])
  if (prhr && features.prhr) {
    for (const p of prhr.parts) add(p.id, p.waterVolume_m3, p.elevation_m, [p.id],
      p.id === 'PRHR.SEAT.UP' ? currentAnchor.temperature_K : features.bankTemperature_K)
    for (const s of [...prhr.steel, ...prhr.disc]) solids.push({ id: s.id,
      capacity_J_K: s.capacity_J_K,
      temperature_K: s.id === 'PRHR.SEAT.UP.SHELL' || s.id === 'PRHR.DISC.1'
        ? currentAnchor.temperature_K : features.bankTemperature_K, owners: [s.id] })
  }
  const index = (id: string) => { const n = indexes.get(id); if (n === undefined) throw Error('Missing operating water: ' + id); return n }
  const connect = (kind: HydraulicSegment['kind'], from: string, to: string, L: number, A: number, D: number,
    roughness: number, K: number, multiplier: number, basis: string) => {
    if (![L, A, D].every(v => Number.isFinite(v) && v > 0)
      || ![roughness, K, multiplier].every(v => Number.isFinite(v) && v >= 0))
      throw Error('Invalid physical flow restriction: ' + from + '->' + to)
    const i = hydraulic.length
    hydraulic.push({ id: from + '->' + to, from: index(from), to: index(to),
      from_elevation_m: water[index(from)]!.elevation_m, to_elevation_m: water[index(to)]!.elevation_m,
      segments: [{ kind, length_m: L, area_m2: A, diameter_m: D, roughness_m: roughness,
        fixedLoss: K, gridMultiplierOrAnnularDarcyCoefficient: multiplier }], basis })
    return i
  }
  const pipe = (from: string, to: string, L: number, A: number, D: number, K: number, basis: string) =>
    connect(0, from, to, L, A, D, 0, K, 0, basis)
  const ret = coldReturnGeometry(d.primary, d.barrel, g.DOWNCOMER.volume_m3)
  const downD = 2 * (ret.annularOuterRadius_m - ret.annularInnerRadius_m), downA = g.DOWNCOMER.area_m2!
  connect(2, 'DOWNCOMER', 'LOWER', d.primary.downcomerTop_m - d.primary.downcomerBottom_m,
    downA, downD, 0, 1, 0, 'Current smooth modified Churchill annular wall Darcy96/Re plus once-only LOWER discharge K=1; old distributed down K omitted')
  const coreIds = ['LOWER', 'CORE.1', 'CORE.2', 'UPPER']
  for (let i = 0; i < 3; i++) {
    const bounds = [0, d.fuel.activeLength_m / 4, 3 * d.fuel.activeLength_m / 4, d.fuel.activeLength_m],
      lo = bounds[i]!, hi = bounds[i + 1]!
    const grids = core.gridPositions_m.filter(z => z > lo && z < hi).length
    const K = (i === 0 ? core.inletLoss : 0) + (i === 2 ? core.outletLoss : 0)
    connect(3, coreIds[i]!, coreIds[i + 1]!, hi - lo, fuel.flowArea_m2, fuel.hydraulicDiameter_m, 0, K,
      grids * core.gridLossFactor * core.blockageFraction ** 2,
      'Current bundle f=max(64/Re,1.691Re^-0.43,.117Re^-0.14), Re-dependent grid min(20,196Re^-0.333), actual inlet/outlet losses')
  }
  for (const loop of ['A', 'B'] as const) {
    const hot = g[`HOT.${loop}`], hotD = d.primary.hotInsideDiameter_m, sgA = g[`SG.${loop}.PRIMARY`].area_m2!,
      sgD = Math.sqrt(4 * sgA / Math.PI), partL = d.primary.sgDevelopedLength_m / 4
    let first: number
    if (loop === 'A' && prhr) {
      const ids = ['HOT.A.BEFORE', 'HOT.A.J', 'HOT.A.AFTER'], totalL = hot.volume_m3 / hot.area_m2!
      const half = (id: string): HydraulicSegment => { const length = water[index(id)]!.volume_m3 / hot.area_m2! / 2
        return { kind: 0, length_m: length, area_m2: hot.area_m2!, diameter_m: hotD,
          roughness_m: 0, fixedLoss: losses.hot * length / totalL, gridMultiplierOrAnnularDarcyCoefficient: 0 } }
      for (let i = 0; i < ids.length; i++) {
        const from = i === 0 ? 'UPPER' : ids[i - 1]!, to = ids[i]!
        const segments = i === 0 ? [half(to)] : [half(from), half(to)]
        // AFTER's hydraulic representative is explicitly at the physical
        // downstream takeoff, not the thermal-volume centroid. Its entire
        // developed length carries the common current before the branch.
        if (to === 'HOT.A.AFTER') { segments[1]!.length_m *= 2; segments[1]!.fixedLoss *= 2 }
        hydraulic.push({ id: from + '->' + to, from: index(from), to: index(to),
          from_elevation_m: water[index(from)]!.elevation_m, to_elevation_m: hot.meanElevation_m,
          segments,
          basis: 'Disjoint HOT.A tee; AFTER pressure at downstream takeoff, full AFTER resistance upstream of both outgoing currents' })
      }
      first = hydraulic.length
      hydraulic.push({ id: 'HOT.A.AFTER->SG.A.PRIMARY.1', from: index('HOT.A.AFTER'), to: index('SG.A.PRIMARY.1'),
        from_elevation_m: hot.meanElevation_m, to_elevation_m: water[index('SG.A.PRIMARY.1')]!.elevation_m,
        segments: [{ kind: 0, length_m: partL / 2, area_m2: sgA, diameter_m: sgD,
          roughness_m: 0, fixedLoss: losses.sg / 8, gridMultiplierOrAnnularDarcyCoefficient: 0 }],
        basis: 'Actual downstream HOT takeoff pressure representative to SG inlet half; HOT resistance already paid on common upstream current' })
    } else {
      pipe('UPPER', 'HOT.' + loop, hot.volume_m3 / hot.area_m2!, hot.area_m2!, hotD, losses.hot, 'Prospective max(molecular circular laminar floor,current TOTAL HOT quadratic budget); no added turbulent wall loss')
      first = pipe('HOT.' + loop, `SG.${loop}.PRIMARY.1`, partL / 2, sgA, sgD, losses.sg / 8,
        'Prospective equivalent circular SG molecular floor/current TOTAL quadratic budget maximum, length apportioned')
    }
    const flowEdges = [first]
    for (let piece = 1; piece < 4; piece++) flowEdges.push(pipe(`SG.${loop}.PRIMARY.${piece}`, `SG.${loop}.PRIMARY.${piece + 1}`,
      piece === 3 ? 1.5 * partL : partL, sgA, sgD, piece === 3 ? losses.sg * 3 / 8 : losses.sg / 4,
      'Prospective SG molecular floor/TOTAL quadratic budget maximum; final common edge includes outlet tail before pump bifurcation'))
    const pumpD = d.primary.pumpPassageInsideDiameter_m, pumpA = Math.PI * pumpD * pumpD / 4,
      pumpL = d.primary.pumpPassageVolume_m3 / pumpA
    for (const ordinal of [1, 2]) {
      const pump = `P.${loop}${ordinal}.PASSAGE`
      pipe(`SG.${loop}.PRIMARY.4`, pump, pumpL / 2, pumpA, pumpD, (losses.pump - 1) / 2,
        'Prospective max(molecular half-passage floor,half current distributed pump budget); no pump shaft/head/inertia')
      pipe(pump, 'COLD.' + loop, pumpL / 2, pumpA, pumpD, (losses.pump - 1) / 2 + 1,
        'Prospective max(half-passage molecular floor,half distributed pump budget plus COLD discharge1 inside TOTAL); low-flow floor does not separately add mixing')
    }
    for (const [from, to] of [['COLD.' + loop, 'RETURN.' + loop], ['RETURN.' + loop, 'DOWNCOMER']])
      connect(5, from!, to!, ret.developedLength_m / 2, ret.area_m2, ret.insideDiameter_m, 0, 0, 0,
        'Current smooth RETURN Darcy64/Re<=2300, Colebrook>=4000, linear transition; ideal stationary turn has no extra form K')
    for (let piece = 0; piece < 4; piece++) heat.push({ kind: 2, from: index(`SG.${loop}.PRIMARY.${piece + 1}`),
      to: water.length + (loop === 'A' ? 0 : 4) + piece, area_m2: sg.area_m2 / 4, thermalDiameter_m: sg.diameter_m,
      flowArea_m2: sgA, hydraulicEdge: flowEdges[piece]!, basis: 'Current primary sensible-film max(laminar,natural,forced) with finite local metal; no secondary/phase duty' })
  }
  const radius = d.handling.guideInnerDiameter_m / 2
  for (const c of physical.input.guideCohorts.cohorts) {
    const inner = c.id === 'BODY' ? d.control.bodyDiameter_m / 2 : c.id === 'THIMBLE' ? d.handling.sourceThimbleDiameter_m / 2 : 0,
      L = (c.top_m - c.bottom_m) / 2, lam = annularLaminarGeometry(L, radius, inner, c.count),
      A = c.count * c.singleArea_m2, D = 2 * (radius - inner), Cann = 2 * lam * A * D * D / L
    for (const [from, to] of [['LOWER', 'GUIDE.' + c.id], ['GUIDE.' + c.id, 'UPPER']])
      connect(4, from!, to!, L, A, D, guideDrag.roughness_m, guideDrag.mouthLoss, Cann,
        'Current stationary parallel guide exact annular molecular DarcyCann/Re, enhanced max(1,Churchill*Re/Cann), actual roughness/mouth losses; no rod motion')
  }
  if (prhr) {
    const boundary = (name: string) => name === 'HOT.A.after' ? 'HOT.A.AFTER'
      : name === 'SG.A.PRIMARY.outlet' ? 'SG.A.PRIMARY.4' : name
    for (const e of prhr.links) {
      const from = index(boundary(e.from)), to = index(boundary(e.to))
      hydraulic.push({ id: e.from + '->' + e.to, from, to,
        from_elevation_m: e.from === 'SG.A.PRIMARY.outlet' ? prhr.geometry.coldTerminal_m : water[from]!.elevation_m,
        to_elevation_m: e.to === 'SG.A.PRIMARY.outlet' ? prhr.geometry.coldTerminal_m : water[to]!.elevation_m,
        segments: e.segments.map(s => ({ kind: 1, length_m: s.length_m, area_m2: s.area_m2,
          diameter_m: s.diameter_m, roughness_m: s.roughness_m, fixedLoss: s.fixedLoss,
          gridMultiplierOrAnnularDarcyCoefficient: 0 })),
        basis: 'Actual PRHR serial half-passages; achieved seat restriction belongs to the explicit PRHR frame' })
    }
    const solid = (id: string) => { const i = solids.findIndex(s => s.id === id)
      if (i < 0) throw Error('Missing PRHR steel ' + id); return water.length + i }
    for (const p of prhr.parts.filter(p => !p.id.startsWith('PRHR.SEAT.'))) {
      const inner = prhr.steel.find(s => s.id === p.id + '.STEEL.1')!, outer = prhr.steel.find(s => s.id === p.id + '.STEEL.2')!
      heat.push({ kind: 0, from: solid(inner.id), to: solid(outer.id),
        conductance_W_K: 2 * Math.PI * prhr.geometry.steelConductivity_W_mK * p.length_m * p.parallel
          / Math.log(outer.radius_m / inner.radius_m), basis: 'Finite radial steel-center cylindrical conduction' })
    }
    heat.push({ kind: 0, from: solid('PRHR.DISC.1'), to: solid('PRHR.DISC.2'),
      conductance_W_K: prhr.discCenterConductance_W_K, basis: 'Actual finite disc through-thickness conduction' },
    { kind: 0, from: solid('PRHR.SEAT.UP.SHELL'), to: solid('PRHR.SEAT.DOWN.SHELL'),
      conductance_W_K: prhr.shellCenterConductance_W_K, basis: 'Actual spool shell axial conduction' })
  }
  const V = water.reduce((s, w) => s + w.volume_m3, 0), omittedV = g.PZR.volume_m3 + physical.input.surge.liquidVolume_m3
  if (Math.abs(V + omittedV - (prhr?.totals.waterVolume_m3 ?? 0) - physical.expectedTotalVolume_m3) > 1e-10 * physical.expectedTotalVolume_m3)
    throw Error('Operating partial/omitted physical inventory does not partition current primary')
  const nativeInput = [ [water.length, solids.length, hydraulic.length, heat.length, run.horizon_s, run.remainingBudget_s,
    currentAnchor.pressure_Pa, currentAnchor.temperature_K, currentAnchor.elevation_m,
    originalPreparation.minimumHSSpan_m, originalWaterMassRelativeScreen].join(' '),
    ...water.map(w => [w.volume_m3, w.elevation_m, w.markerRatio, w.temperature_K].join(' ')),
    ...solids.map(s => [s.capacity_J_K, s.temperature_K].join(' ')),
    ...hydraulic.map(e => [e.from, e.to, e.from_elevation_m, e.to_elevation_m, e.segments.length,
      ...e.segments.flatMap(s => [s.kind, s.length_m, s.area_m2, s.diameter_m, s.roughness_m, s.fixedLoss,
        s.gridMultiplierOrAnnularDarcyCoefficient])].join(' ')),
    ...heat.map(h => h.kind === 0 ? [h.kind, h.from, h.to, h.conductance_W_K].join(' ')
      : [h.kind, h.from, h.to, h.area_m2, h.thermalDiameter_m, h.flowArea_m2, h.hydraulicEdge].join(' ')),
    [secondaries.length, secondaryHeat.length].join(' '),
    ...secondaries.map(s => [s.volume_m3, s.temperature_K, s.pressure_Pa, s.liquidVolume_m3,
      s.nitrogenMass_kg, s.minimumWettedVolume_m3].join(' ')),
    ...secondaryHeat.map(h => [h.solid, h.secondary, h.area_m2, h.diameter_m].join(' ')) ].join('\n') + '\n'
  const identities = [...physical.identity, ...extras.map((name, i) => ({ name, sha256: sha(docs[i]!) }))]
  const observed = new Map<string, string>()
  for (const identity of identities) {
    if (observed.has(identity.name) && observed.get(identity.name) !== identity.sha256)
      throw Error('Owner changed during compilation: ' + identity.name)
    observed.set(identity.name, identity.sha256)
  }
  const uniqueIdentities = [...new Map(identities.map(i => [i.name, i])).values()]
  return { design: 'LD-01', preparation: features.prhr
    ? 'Fresh cold point-lumped primary/finite SG metal, closed wet secondaries and actual PRHR liquid/steel; explicit receiver and actuation preparation belongs to the PRHR cooling frame'
    : 'Fresh cold point-lumped primary/finite SG metal and closed wet water-steam-air secondaries, stationary fully inserted physical geometry',
    anchor: currentAnchor, referenceAnchor:d.anchor, controls: run, originalPreparation: { minimumSpan_m: originalPreparation.minimumHSSpan_m,
      relativeMassScreen: originalWaterMassRelativeScreen, scope: 'Original point initializer precision allocation only, not inherited quadrature inventory acceptance' },
    water, solids, hydraulic, heat, secondaries, secondaryHeat, prhr, includedWaterVolume_m3: V,
    omittedWaterSupports: [{ id: 'PZR', volume_m3: g.PZR.volume_m3 }, { id: 'SURGE', volume_m3: physical.input.surge.liquidVolume_m3 }],
    sourceResolution: { compiledGeometryRegions: source.regionCount, comparatorNeutronCoordinates: source.neutronCoordinates,
      assemblies: d.fuel.assemblies, materialHistorySegments: 2 * d.fuel.assemblies,
      comparatorFuelCladCoordinates: d.fuel.assemblies * cohorts.axialBands * (cohorts.fuelIntervals + cohorts.cladIntervals + 2),
      sharedHeliumOwners: d.fuel.assemblies, sourceOrHistoryAdvanced: false,
      scope: 'Actual consumed owner counts; nuclear populations, precursor/poison/decay histories and coupled source cost remain outside this advancing partial model' },
    limitations: ['No PZR/surge: their computational boundary is cut, not an achieved physical isolation',
      features.prhr
        ? 'This network compiler provides actual PRHR geometry and serial losses; source, WST, valve mechanics and external supports are joined only by the explicit cooling composition, not inferred here'
        : 'No source/fuel/clad/decay heating, PRHR/WST, electrical/I&C, sensing or actuator behavior',
      'SG secondary is closed, liquid-bearing, fully wetted and sub-boiling; no steam/feed/header/relief/tube-leak ports, gas-exposed contacts, dryout or phase-exhaustion continuation',
      'Cold secondary inventories are recomputed from the physical preparation using pinned IF97, not imported from historical HEOS receipts; engineering diagnostics are not acquired instrument readings',
      'Sound-filtered cold inventory pressure and quasi-steady hydraulic flows; no retained contact inertia, pump shaft/head/coastdown or acoustic/water-hammer fidelity claim',
      'Hold original finite energy/tracer/aggregate-mass/metal stocks and jointly initialize algebraic pressures/flows and differential rates; zero-flow guess is not an admitted rest state or advancing startup',
      'Reduced internal-plus-gravitational energy neglects fluid kinetic storage and convective velocity-change recovery; cold qualification screens their local scales, not full mechanical accuracy',
      'UPPER includes actual housing V and first moment; homogeneous thermal approximation omits housing residence/stratification',
      'Point-lumped fresh EOS preparation does not inherit quadrature/native original inventory admission',
      'HOT/SG/pump use a prospective molecular-floor/TOTAL-budget reduced loss law, not measured turbulent local correlations; SG aggregate hydraulic Dh is not its .020m thermal diameter',
      'Four SG water/metal regions use incoming local mass current for the sensible-film speed; point sampling and common outlet-tail resistance lumping are spatial reductions, not local temperature/velocity validation',
      'Finite cold SG metal and secondary can release stored heat while primary warms; no continuing SG cooling duty, ultimate sink or natural-circulation calibration is qualified'],
    ownerIdentities: uniqueIdentities, helperIdentities: await helperIdentities(import.meta.path), nativeInput,
    nativeInputSha256: sha(nativeInput), scope: features.prhr
      ? 'Reusable cold connected primary-metal-secondary-PRHR geometry; no hot shutdown, containment/endurance or whole-plant feasibility qualification'
      : 'Reusable cold connected primary-metal-secondary blocks; no hot shutdown or whole-plant feasibility qualification' }
}

if (import.meta.main) {
  const [wiki, output, horizon, budget, ...extra] = Bun.argv.slice(2)
  if (!wiki || !output || !horizon || !budget || extra.length)
    throw Error('Usage: bun reference-design-operating-network.ts <explicit-LD01-wiki-directory> <new-input.json> <horizon-seconds> <remaining-budget-seconds>')
  const result = await compileOperatingNetwork(wiki, { horizon_s: Number(horizon), remainingBudget_s: Number(budget) })
  await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ output: resolve(output), water: result.water.length, solids: result.solids.length,
    hydraulic: result.hydraulic.length, heat: result.heat.length, secondaries: result.secondaries.length,
    secondaryHeat: result.secondaryHeat.length, inputSha256: result.nativeInputSha256, scope: result.scope }))
}
