/** The containment section (capability C13) of the LD-01 operating packet:
 * one finite containment atmosphere, the shell remainder host and its two
 * catchments, sixteen local bay hosts, the four open pools with their crests
 * and drains, the bulk droplet selection and the exterior PCC path. Every
 * value comes from its owner's strict wiki block, unchanged, converted to SI
 * or derived by stated arithmetic. Rust owns every law; this compiler reads,
 * checks and composes. It is a Gate-1 design-lane compiler: nothing here is
 * registered or built into the joined unit; a test-only standalone prototype
 * parses the packet.
 *
 * Reads, under "Compact operating allocation (15 October 2026)" of
 * reservoir-and-containment.md:
 * - `ld01-cnv-atmosphere`: gas space, modeled enclosure, PRHR envelope,
 *   initial state, air/vapor/nitrogen ideal-gas constants, vapor reference,
 *   the +20 m origin and the applicability exits;
 * - `ld01-cnv-shell`: total area and capacity, contact budget, condensation
 *   velocity, the upper/lower catchments of the one remainder host, and the
 *   remainder/local partition;
 * - `ld01-cnv-local-hosts`: bay floors, the +14 m top and the sixteen patches
 *   (floor patches, and wall patches with their rectangles);
 * - `ld01-cnv-pools`: WST, gutter, SUMP, FLOOR, crest coefficient, surface
 *   transfer velocity;
 * - `ld01-cnv-droplets`: origin, diameter and sensitivity, drag law, the
 *   air/nitrogen viscosity laws and the native vapor viscosity;
 * - `ld01-pcc-exterior`: tank, feed, valve, film, dry path, ambient;
 * and `reference-prhr-geometry` (residual-heat-exchanger.md, "Geometry, finite
 * owners and actual height") for the PRHR external tube/header envelope.
 *
 * Checks: `cp_v = cv_v + R_v`; enclosure = gas + WST water + PRHR envelope;
 * the envelope of two headers and the C-tubes reproduces the block, and the
 * hardware span is the headers' outer surfaces; the WST initial surface and
 * first-exposure loss follow from `A*(h - floor) = water + envelope`; gutter
 * crest storage, FLOOR retained layer and the SUMP rim at the deck; the shell
 * partitions close in area and capacity; the PCC initial head, feed reference
 * head and film reference mass; droplet sensitivity brackets the diameter.
 * Derives the hardware first moment `V*(top + bottom)/2` (the bank is mirror
 * symmetric about +12.00 m) and counts the coordinate census from the
 * compiled owners.
 *
 * Usage: bun reference-design-operating-containment.ts <wiki root> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ownedBlock } from './reference-design-operating-pzr'

const reservoir = 'systems/passive-cooling/reservoir-and-containment.md', allocation = 'Compact operating allocation (15 October 2026)'
export const containmentOwners = {
  atmosphere: { page: reservoir, heading: allocation, fence: 'ld01-cnv-atmosphere' },
  shell: { page: reservoir, heading: allocation, fence: 'ld01-cnv-shell' },
  localHosts: { page: reservoir, heading: allocation, fence: 'ld01-cnv-local-hosts' },
  pools: { page: reservoir, heading: allocation, fence: 'ld01-cnv-pools' },
  droplets: { page: reservoir, heading: allocation, fence: 'ld01-cnv-droplets' },
  exterior: { page: reservoir, heading: allocation, fence: 'ld01-pcc-exterior' },
  prhr: { page: 'systems/passive-cooling/residual-heat-exchanger.md', heading: 'Geometry, finite owners and actual height', fence: 'reference-prhr-geometry' },
} as const

const positive = z.number().finite().positive()
const finite = z.number().finite()
const count = z.number().int().positive()
const celsius = z.number().finite().gt(-273.15)
const atmosphereSchema = z.object({ gasVolume_m3: positive, modeledEnclosure_m3: positive, prhrEnvelope_m3: positive,
  initialTemperature_C: celsius, initialTotalPressure_kPa: positive, initialVapor: z.literal('saturated'),
  airGasConstant_J_kgK: positive, airCv_J_kgK: positive, vaporGasConstant_J_kgK: positive, vaporCv_J_kgK: positive, vaporCp_J_kgK: positive,
  referenceTemperature_K: positive, vaporReference: z.literal('saturated-vapor-at-reference'),
  nitrogenGasConstant_J_kgK: positive, nitrogenCv_J_kgK: positive, originElevation_m: finite,
  maxTotalPressure_MPa: positive, maxGasTemperature_C: celsius }).strict()
const catchmentSchema = <R extends string>(receiver: R) => z.object({ area_m2: positive, formationElevation_m: finite, receiver: z.literal(receiver) }).strict()
const shellSchema = z.object({ totalArea_m2: positive, totalCapacity_MJ_K: positive, initialTemperature_C: celsius,
  dryContactTotal_MW_K: positive, condensationVelocity_m_s: positive, upper: catchmentSchema('GUTTER'), lower: catchmentSchema('FLOOR'),
  remainderArea_m2: positive, remainderCapacity_J_K: positive, localArea_m2: positive, localCapacity_J_K: positive,
  localCapacityPerArea_J_m2K: positive }).strict()
const baySchema = z.enum(['WELL', 'CANAL', 'POOL'])
const patchBase = { id: z.string().min(1), bays: z.array(baySchema).min(1).max(2), area_m2: positive, elevation_m: finite }
const localHostsSchema = z.object({ floors_m: z.object({ WELL: finite, CANAL: finite, POOL: finite }).strict(), top_m: finite,
  patches: z.array(z.discriminatedUnion('kind', [
    z.object({ ...patchBase, kind: z.literal('floor') }).strict(),
    z.object({ ...patchBase, kind: z.literal('wall'), rectangles_m: z.array(z.tuple([positive, finite, finite])).min(1) }).strict()])) }).strict()
const poolsSchema = z.object({
  wst: z.object({ water_m3: positive, initialTemperature_C: celsius, tracer_ppm: z.number().finite().nonnegative(), width_m: positive, length_m: positive,
    area_m2: positive, floor_m: finite, initialSurface_m: finite, hardwareBottom_m: finite, hardwareTop_m: finite, exposureLoss_m3: positive,
    spillRim_m: finite, spillWidth_m: positive, spillReceiver: z.literal('FLOOR') }).strict(),
  gutter: z.object({ area_m2: positive, floor_m: finite, returnChutes: count, chuteWidth_m: positive, chuteCrest_m: finite,
    chuteReceiver: z.literal('WST'), emergencyCrest_m: finite, emergencyWidth_m: positive, emergencyReceiver: z.literal('FLOOR'),
    crestStorage_m3: positive }).strict(),
  sump: z.object({ area_m2: positive, floor_m: finite, rim_m: finite, rimWidth_m: positive, rimReceiver: z.literal('FLOOR') }).strict(),
  floor: z.object({ area_m2: positive, deck_m: finite, drainMouth_m: finite, retainedLayer_m3: positive, drains: count,
    drainReference_kg_s: positive, drainReferenceHead_kPa: positive, drainReferenceTemperature_K: positive, drainReferencePressure_Pa: positive }).strict(),
  crestCoefficient: positive, surfaceTransferVelocity_m_s: positive }).strict()
const viscositySchema = z.object({ reference_Pa_s: positive, referenceTemperature_K: positive, exponent: finite }).strict()
const dropletsSchema = z.object({ origin_m: finite, diameter_mm: positive, sensitivityDiameters_mm: z.array(positive).min(2),
  dragStokes: positive, dragCorrection: positive, dragExponent: positive, dragReynoldsLimit: positive, newtonDrag: positive,
  receiver: z.literal('FLOOR'), airViscosity: viscositySchema, nitrogenViscosity: viscositySchema,
  vaporViscosity: z.literal('native-saturated-vapor') }).strict()
const exteriorSchema = z.object({ tank_m3: positive, tankTemperature_C: celsius, tankArea_m2: positive, tankBottom_m: finite,
  filmDatum_m: finite, initialHead_m: finite, fullOpenFeed_kg_s: positive, feedReferenceHead_m: positive,
  valveTravel_s: positive, valveActuator: z.literal('ACT.B'), valveRoom: z.literal('ROOM.B'), holdPower_W: positive,
  closingPower_W: positive, springStock_J: positive, filmReferenceMass_kg: positive, filmConductance_MW_K: positive,
  runoffResidence_s: positive, dryConductance_MW_K: positive, ambientTemperature_C: celsius, ambientPressure_kPa: positive }).strict()
const prhrSchema = z.object({
  tubes: z.object({ count, od_m: positive, straightLeg_m: positive, bendRadius_m: positive, top_m: finite, bottom_m: finite }).passthrough(),
  header: z.object({ od_m: positive, length_m: positive }).passthrough() }).passthrough()

export type ContainmentPages = Record<keyof typeof containmentOwners, string>

const kelvin = (c: number) => c + 273.15, kPa = (x: number) => x * 1000, mega = (x: number) => x * 1e6
const mm = (x: number) => x / 1000, ppm = (x: number) => x / 1e6
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance

/** The containment section from the owners' page texts. */
export function compileOperatingContainment(pages: ContainmentPages) {
  const o = containmentOwners
  const read = <T>(key: keyof typeof containmentOwners, schema: z.ZodType<T>) => schema.parse(ownedBlock(pages[key], o[key].heading, o[key].fence))
  const atm = read('atmosphere', atmosphereSchema), shell = read('shell', shellSchema), hosts = read('localHosts', localHostsSchema)
  const pools = read('pools', poolsSchema), drops = read('droplets', dropletsSchema), pcc = read('exterior', exteriorSchema), prhr = read('prhr', prhrSchema)
  const { wst, gutter, sump, floor } = pools

  // Atmosphere: the vapor convention and the enclosure.
  if (!near(atm.vaporCp_J_kgK, atm.vaporCv_J_kgK + atm.vaporGasConstant_J_kgK, 1e-12 * atm.vaporCp_J_kgK))
    throw Error(`Vapor cp ${atm.vaporCp_J_kgK} is not cv + R = ${atm.vaporCv_J_kgK + atm.vaporGasConstant_J_kgK} J/(kg K)`)
  const enclosure = atm.gasVolume_m3 + wst.water_m3 + atm.prhrEnvelope_m3
  if (!near(atm.modeledEnclosure_m3, enclosure, 1e-9))
    throw Error(`The modeled enclosure ${atm.modeledEnclosure_m3} m3 is not gas + WST water + PRHR envelope = ${enclosure} m3`)

  // PRHR external envelope: two headers and the C-tubes (two straight legs,
  // two quarter turns, the remaining vertical descent between the centrelines).
  const { tubes, header } = prhr
  const descent = tubes.top_m - tubes.bottom_m - 2 * tubes.bendRadius_m
  if (!(descent >= 0)) throw Error('The PRHR tube quarter turns overlap: no vertical descent remains')
  const tubeLength = 2 * tubes.straightLeg_m + 2 * (Math.PI / 2) * tubes.bendRadius_m + descent
  const envelope = 2 * Math.PI * (header.od_m / 2) ** 2 * header.length_m + tubes.count * Math.PI * (tubes.od_m / 2) ** 2 * tubeLength
  if (!near(envelope, atm.prhrEnvelope_m3, 5e-7))
    throw Error(`The PRHR geometry gives an envelope of ${envelope} m3, the atmosphere block prints ${atm.prhrEnvelope_m3} m3`)
  const hardwareBottom = tubes.bottom_m - header.od_m / 2, hardwareTop = tubes.top_m + header.od_m / 2
  if (!near(wst.hardwareBottom_m, hardwareBottom, 1e-12) || !near(wst.hardwareTop_m, hardwareTop, 1e-12))
    throw Error(`The WST hardware span ${wst.hardwareBottom_m}..${wst.hardwareTop_m} m is not the header outer surfaces ${hardwareBottom}..${hardwareTop} m`)
  // The bank is mirror symmetric about the mid elevation of its centrelines.
  const firstMoment = atm.prhrEnvelope_m3 * (tubes.top_m + tubes.bottom_m) / 2

  // WST level: A*(h - floor) = water + immersed envelope above the bank.
  if (!near(wst.area_m2, wst.width_m * wst.length_m, 1e-9)) throw Error(`The WST area ${wst.area_m2} m2 is not ${wst.width_m} x ${wst.length_m} m`)
  const surface = wst.floor_m + (wst.water_m3 + atm.prhrEnvelope_m3) / wst.area_m2
  if (!near(wst.initialSurface_m, surface, 5e-7)) throw Error(`The WST initial surface ${wst.initialSurface_m} m is not ${surface} m`)
  const exposureLoss = wst.water_m3 - (wst.area_m2 * (wst.hardwareTop_m - wst.floor_m) - atm.prhrEnvelope_m3)
  if (!near(wst.exposureLoss_m3, exposureLoss, 1e-6)) throw Error(`The WST first-exposure loss ${wst.exposureLoss_m3} m3 is not ${exposureLoss} m3`)

  // Gutter, FLOOR and SUMP.
  if (!near(gutter.crestStorage_m3, gutter.area_m2 * (gutter.emergencyCrest_m - gutter.floor_m), 1e-9))
    throw Error(`The gutter crest storage ${gutter.crestStorage_m3} m3 is not its area up to the emergency crest`)
  if (!(gutter.floor_m < gutter.chuteCrest_m && gutter.chuteCrest_m < gutter.emergencyCrest_m))
    throw Error(`The gutter return crest ${gutter.chuteCrest_m} m does not lie between its floor and its emergency crest`)
  if (!near(floor.retainedLayer_m3, floor.area_m2 * (floor.drainMouth_m - floor.deck_m), 1e-9))
    throw Error(`The FLOOR retained layer ${floor.retainedLayer_m3} m3 is not its area up to the drain mouths`)
  if (sump.rim_m !== floor.deck_m) throw Error(`The SUMP rim ${sump.rim_m} m is not the FLOOR deck ${floor.deck_m} m`)

  // Shell: one remainder host with two catchments, and sixteen local patches.
  const totalCapacity = mega(shell.totalCapacity_MJ_K)
  if (!near(shell.upper.area_m2 + shell.lower.area_m2, shell.remainderArea_m2, 1e-9))
    throw Error('The upper and lower catchments do not make up the shell remainder area')
  if (!near(shell.remainderArea_m2 + shell.localArea_m2, shell.totalArea_m2, 1e-9)) throw Error('The shell remainder and local areas do not make up the total area')
  if (!near(shell.remainderCapacity_J_K + shell.localCapacity_J_K, totalCapacity, 1e-3))
    throw Error('The shell remainder and local capacities do not make up the total capacity')
  if (!near(shell.localCapacityPerArea_J_m2K * shell.totalArea_m2, totalCapacity, 1e-12 * totalCapacity))
    throw Error('The local capacity per area is not the total capacity over the total area')
  const patches = hosts.patches, localArea = patches.reduce((a, p) => a + p.area_m2, 0)
  if (patches.length !== 16 || new Set(patches.map(p => p.id)).size !== 16) throw Error('Expected sixteen unique local patches')
  for (const p of patches) {
    const own = p.bays.length === 1 ? p.id.startsWith(`${p.bays[0]}.`) : p.bays[0] !== p.bays[1] && p.id === p.bays.join('-')
    if (!own) throw Error(`Patch ${p.id} does not name its bays ${p.bays.join(', ')}`)
    if (p.id.endsWith('.FLOOR') !== (p.kind === 'floor')) throw Error(`Patch ${p.id} is a ${p.kind} patch`)
    if (p.kind === 'floor') {
      if (p.elevation_m !== hosts.floors_m[p.bays[0]!]) throw Error(`Patch ${p.id} does not lie on its bay floor`)
      continue
    }
    // A wall patch's rectangles reproduce its area and centroid and lie in its bays' extent.
    const lowest = Math.min(...p.bays.map(b => hosts.floors_m[b]))
    let area = 0, moment = 0
    for (const [w, bottom, top] of p.rectangles_m) {
      if (!(bottom < top && top <= hosts.top_m && bottom >= lowest)) throw Error(`Patch ${p.id} has a rectangle outside ${lowest}..${hosts.top_m} m`)
      area += w * (top - bottom)
      moment += w * (top * top - bottom * bottom) / 2
    }
    if (!near(area, p.area_m2, 1e-9)) throw Error(`Patch ${p.id}: its rectangles give ${area} m2, the block prints ${p.area_m2} m2`)
    if (!near(moment / area, p.elevation_m, 1e-9)) throw Error(`Patch ${p.id}: its rectangles' centroid ${moment / area} m is not ${p.elevation_m} m`)
  }
  if (!near(localArea, shell.localArea_m2, 1e-9)) throw Error(`The local patch areas sum to ${localArea} m2, the shell block prints ${shell.localArea_m2} m2`)
  if (!near(localArea * shell.localCapacityPerArea_J_m2K, shell.localCapacity_J_K, 1e-3))
    throw Error('The local patch capacities do not make up the local capacity')

  // Exterior: head, feed reference and film reference mass.
  const head = pcc.tankBottom_m + pcc.tank_m3 / pcc.tankArea_m2 - pcc.filmDatum_m
  if (!near(pcc.initialHead_m, head, 1e-9)) throw Error(`The PCC initial head ${pcc.initialHead_m} m is not ${head} m`)
  if (pcc.feedReferenceHead_m !== pcc.initialHead_m) throw Error('The PCC feed reference head is not the initial head')
  if (!near(pcc.filmReferenceMass_kg, pcc.fullOpenFeed_kg_s * pcc.runoffResidence_s, 1e-9))
    throw Error(`The film reference mass ${pcc.filmReferenceMass_kg} kg is not full-open feed x runoff residence`)

  // Droplets: one origin with the bulk gas; sensitivity on both sides.
  if (drops.origin_m !== atm.originElevation_m) throw Error('The droplet origin is not the bulk gas origin')
  if (!(Math.min(...drops.sensitivityDiameters_mm) < drops.diameter_mm && drops.diameter_mm < Math.max(...drops.sensitivityDiameters_mm)))
    throw Error('The droplet sensitivity diameters do not bracket the maintained diameter')

  const emptyPool = (id: 'GUTTER' | 'FLOOR' | 'SUMP', area_m2: number, floor_m: number) =>
    ({ id, area_m2, floor_m, initialWater_m3: 0, initialTemperature_K: null, initialTracer_kg_kg: 0, initialSurface_m: floor_m, hardware: null })
  const poolEntries = [
    { id: 'WST' as const, area_m2: wst.area_m2, floor_m: wst.floor_m, initialWater_m3: wst.water_m3, initialTemperature_K: kelvin(wst.initialTemperature_C),
      initialTracer_kg_kg: ppm(wst.tracer_ppm), initialSurface_m: wst.initialSurface_m,
      hardware: { volume_m3: atm.prhrEnvelope_m3, firstMoment_m4: firstMoment, bottom_m: wst.hardwareBottom_m, top_m: wst.hardwareTop_m } },
    emptyPool('GUTTER', gutter.area_m2, gutter.floor_m), emptyPool('FLOOR', floor.area_m2, floor.deck_m), emptyPool('SUMP', sump.area_m2, sump.floor_m),
  ]
  const local = patches.map(p => ({ id: p.id, bays: p.bays, kind: p.kind, area_m2: p.area_m2, elevation_m: p.elevation_m,
    rectangles_m: p.kind === 'wall' ? p.rectangles_m : [], capacity_J_K: p.area_m2 * shell.localCapacityPerArea_J_m2K }))

  // Census from the compiled owners; the pool template recurs in each bay.
  const poolDifferential = ['M', 'E', 'B'], poolAlgebraic = ['T', 'V', 'h', 'm_b']
  const owners = [
    { owner: 'CNV', differential: ['M_air', 'M_N2', 'M_w', 'E_mix'], algebraic: ['p', 'T', 'V_mix', 'M_d', 'v_t'] },
    { owner: 'SHELL.REMAINDER', differential: ['U'], algebraic: [] as string[] },
    ...local.map(p => ({ owner: p.id, differential: ['U'], algebraic: [] as string[] })),
    ...poolEntries.map(p => ({ owner: p.id, differential: [...poolDifferential], algebraic: [...poolAlgebraic] })),
    // S4-D13: each FLOOR→SUMP drain channel carries its mass flow (path
    // inertance); the channels' inertance has no wiki value yet.
    { owner: 'FLOOR-SUMP.DRAINS', differential: Array.from({ length: floor.drains }, (_, i) => `m_${i + 1}`), algebraic: [] as string[] },
    { owner: 'PCC.TANK', differential: ['M'], algebraic: [] as string[] },
    { owner: 'PCC.FILM', differential: ['M', 'H'], algebraic: ['T', 'm_evap'] },
  ]
  const differential = owners.reduce((n, x) => n + x.differential.length, 0), algebraic = owners.reduce((n, x) => n + x.algebraic.length, 0)
  const bays = Object.keys(hosts.floors_m).length

  return {
    atmosphere: { gasVolume_m3: atm.gasVolume_m3, enclosure_m3: atm.modeledEnclosure_m3, prhrEnvelope_m3: atm.prhrEnvelope_m3,
      initialTemperature_K: kelvin(atm.initialTemperature_C), initialPressure_Pa: kPa(atm.initialTotalPressure_kPa),
      airGasConstant_J_kgK: atm.airGasConstant_J_kgK, airCv_J_kgK: atm.airCv_J_kgK,
      vaporGasConstant_J_kgK: atm.vaporGasConstant_J_kgK, vaporCv_J_kgK: atm.vaporCv_J_kgK, vaporCp_J_kgK: atm.vaporCp_J_kgK,
      referenceTemperature_K: atm.referenceTemperature_K, nitrogenGasConstant_J_kgK: atm.nitrogenGasConstant_J_kgK, nitrogenCv_J_kgK: atm.nitrogenCv_J_kgK,
      origin_m: atm.originElevation_m, maxPressure_Pa: mega(atm.maxTotalPressure_MPa), maxTemperature_K: kelvin(atm.maxGasTemperature_C) },
    shell: { initialTemperature_K: kelvin(shell.initialTemperature_C), dryContactTotal_W_K: mega(shell.dryContactTotal_MW_K),
      condensationVelocity_m_s: shell.condensationVelocity_m_s, totalArea_m2: shell.totalArea_m2,
      remainder: { area_m2: shell.remainderArea_m2, capacity_J_K: shell.remainderCapacity_J_K, catchments: [
        { id: 'UPPER' as const, area_m2: shell.upper.area_m2, elevation_m: shell.upper.formationElevation_m, receiver: shell.upper.receiver },
        { id: 'LOWER' as const, area_m2: shell.lower.area_m2, elevation_m: shell.lower.formationElevation_m, receiver: shell.lower.receiver }] },
      local },
    pools: poolEntries,
    paths: { crestCoefficient: pools.crestCoefficient, surfaceTransferVelocity_m_s: pools.surfaceTransferVelocity_m_s,
      crests: [
        ...Array.from({ length: gutter.returnChutes }, (_, i) => ({ id: `GUTTER.RETURN.${i + 1}`, from: 'GUTTER', to: gutter.chuteReceiver,
          width_m: gutter.chuteWidth_m, crest_m: gutter.chuteCrest_m, law: 'backwater' as const })),
        { id: 'GUTTER.SPILL', from: 'GUTTER', to: gutter.emergencyReceiver, width_m: gutter.emergencyWidth_m, crest_m: gutter.emergencyCrest_m,
          law: 'backwater' as const },
        { id: 'WST.SPILL', from: 'WST', to: wst.spillReceiver, width_m: wst.spillWidth_m, crest_m: wst.spillRim_m, law: 'backwater' as const },
        // The rim's own law: head over the higher of the rim and the receiving
        // surface, signed by donor; it acts only while the SUMP surface is at or
        // above the rim (S4-D15), else deck water reaches the pit by the drains.
        { id: 'SUMP.RIM', from: 'SUMP', to: sump.rimReceiver, width_m: sump.rimWidth_m, crest_m: sump.rim_m, law: 'receiving-surface' as const },
      ],
      drains: { from: 'FLOOR' as const, to: 'SUMP' as const, count: floor.drains, face_m: floor.drainMouth_m, reference_kg_s: floor.drainReference_kg_s,
        referenceHead_Pa: kPa(floor.drainReferenceHead_kPa), referenceTemperature_K: floor.drainReferenceTemperature_K,
        referencePressure_Pa: floor.drainReferencePressure_Pa } },
    droplets: { origin_m: drops.origin_m, diameter_m: mm(drops.diameter_mm), sensitivityDiameters_m: drops.sensitivityDiameters_mm.map(mm),
      dragStokes: drops.dragStokes, dragCorrection: drops.dragCorrection, dragExponent: drops.dragExponent,
      dragReynoldsLimit: drops.dragReynoldsLimit, newtonDrag: drops.newtonDrag, receiver: drops.receiver,
      airViscosity: drops.airViscosity, nitrogenViscosity: drops.nitrogenViscosity, vaporViscosity: drops.vaporViscosity },
    exterior: { tank: { volume_m3: pcc.tank_m3, temperature_K: kelvin(pcc.tankTemperature_C), area_m2: pcc.tankArea_m2, bottom_m: pcc.tankBottom_m },
      filmDatum_m: pcc.filmDatum_m, fullOpenFeed_kg_s: pcc.fullOpenFeed_kg_s, feedReferenceHead_m: pcc.feedReferenceHead_m,
      valve: { travel_s: pcc.valveTravel_s, actuator: pcc.valveActuator, room: pcc.valveRoom, holdPower_W: pcc.holdPower_W,
        closingPower_W: pcc.closingPower_W, springStock_J: pcc.springStock_J },
      film: { referenceMass_kg: pcc.filmReferenceMass_kg, conductance_W_K: mega(pcc.filmConductance_MW_K), runoffResidence_s: pcc.runoffResidence_s },
      dryConductance_W_K: mega(pcc.dryConductance_MW_K),
      ambient: { temperature_K: kelvin(pcc.ambientTemperature_C), pressure_Pa: kPa(pcc.ambientPressure_kPa) } },
    census: { differential, algebraic, total: differential + algebraic, owners,
      bayTemplate: { perBay: { differential: poolDifferential.length, algebraic: poolAlgebraic.length }, bays,
        total: bays * (poolDifferential.length + poolAlgebraic.length) } },
  }
}

export async function prepareOperatingContainment(wiki: string) {
  const base = join(wiki, 'world/packs/process-plant/reference-designs/ld-01')
  const names = Object.entries(containmentOwners) as [keyof typeof containmentOwners, { page: string, fence: string }][]
  const pages = Object.fromEntries(await Promise.all(names.map(async ([k, o]) => [k, await Bun.file(join(base, o.page)).text()]))) as ContainmentPages
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...compileOperatingContainment(pages), provenance: {
    consumed: names.map(([k, o]) => ({ page: o.page, fence: o.fence, sha256: hash(pages[k]) })),
    sourceSha256: hash(await Bun.file(import.meta.path).text()) } }
}

if (import.meta.main) {
  const [wiki] = Bun.argv.slice(2)
  if (!wiki || Bun.argv.length !== 3) throw Error('Usage: operating-containment <wiki root>')
  console.log(JSON.stringify(await prepareOperatingContainment(wiki)))
}
