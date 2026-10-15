/** The passive injection and heat-removal section (capability C11) of the
 * LD-01 operating packet: the two CMTs as six stratified layers each with
 * their balance lines, outlets and DVI manifolds, the two accumulators, the
 * ADS stages, the GIV/RECIRC columns, the PRHR bank, and their valve/spring
 * states. Every value comes from its owner's strict wiki block, unchanged,
 * converted to SI or derived by stated arithmetic; the cold/fine apparatus's
 * `reference-*` blocks are read only through their own compilers. Rust owns
 * every law; this compiler reads, checks and composes. It is a Gate-1
 * design-lane compiler: nothing here is registered or built into the joined
 * unit; test-only standalone prototypes parse the packet.
 *
 * Reads, under "Compact operating allocation (15 October 2026)" of
 * injection-and-depressurization.md: `ld01-c11-cmt`, `-dvi`, `-acc`, `-ads`,
 * `-gravity`, `-prhr`, `-sequence`, `-boundary`; and, through their
 * compilers, `reference-cmt-geometry` and `reference-cmt-balance-path`
 * (cmt-receiving-geometry.md), `reference-cmt-delivery` and
 * `reference-gravity-intakes` (injection-and-depressurization.md),
 * `reference-cmt-submerged` (cmt-transport.md, its cold-header witness) and
 * the PRHR blocks (residual-heat-exchanger.md) through the PRHR operating
 * compiler.
 *
 * Usage: bun reference-design-operating-passive.ts <wiki root> */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { ownedBlock } from './reference-design-operating-pzr'
import { parseGeometryBasis, tankGeometry, ringArea } from './reference-design-cmt-geometry'
import { parseBalancePathBasis } from './reference-design-cmt-balance-path'
import { deliveryBasis } from './reference-design-cmt-delivery'
import { parseGravityIntakes } from './reference-design-gravity-intakes'
import { compilePrhrOperatingGeometry } from './reference-design-prhr-operating'

const injection = 'systems/passive-cooling/injection-and-depressurization.md', allocation = 'Compact operating allocation (15 October 2026)'
const own = (fence: string) => ({ page: injection, heading: allocation, fence })
export const passiveOwners = {
  cmt: own('ld01-c11-cmt'), dvi: own('ld01-c11-dvi'), acc: own('ld01-c11-acc'), ads: own('ld01-c11-ads'),
  gravity: own('ld01-c11-gravity'), prhr: own('ld01-c11-prhr'), sequence: own('ld01-c11-sequence'), boundary: own('ld01-c11-boundary'),
} as const
/** Pages read whole by the apparatus compilers (their `reference-*` blocks). */
export const referencePages = {
  geometry: 'systems/passive-cooling/cmt-receiving-geometry.md',
  transport: 'systems/passive-cooling/cmt-transport.md',
  injection,
  exchanger: 'systems/passive-cooling/residual-heat-exchanger.md',
} as const

const positive = z.number().finite().positive()
const finite = z.number().finite()
const count = z.number().int().positive()
const celsius = z.number().finite().gt(-273.15)
const fraction = z.number().finite().gt(0).lte(1)
const cmtSchema = z.object({ waterTemperature_C: celsius, tracer_ppm: z.number().finite().nonnegative(), barrelLayers: count,
  receivingCut: z.literal('bodyBottom'), referencePressure_MPa: positive,
  outlet: z.object({ length_m: positive, bore_m: positive, referenceFlow_kg_s: positive, pipeLoss_Pa: positive, dischargeLoss_Pa: positive,
    meterLoss_Pa: positive, openCheckLoss_Pa: positive, isolationLoss_Pa: positive, checkCrack_Pa: positive, isolations: count,
    isolationArea_m2: positive, checkArea_m2: positive, meterArea_m2: positive, opening_s: positive, closing_s: positive,
    holdPower_W: positive, closingPower_W: positive, springStock_J: positive }).strict(),
  balance: z.object({ isolationLoss_Pa: positive, isolationArea_m2: positive, mainLength_m: positive, riserLength_m: positive,
    roofLength_m: positive, feedLength_m: positive, riserCells: count, travel_s: positive, motionPower_W: positive }).strict() }).strict()
const dviSchema = z.object({ volume_m3: positive, bottom_m: finite, top_m: finite, area_m2: positive, port_m: finite,
  neckVolume_m3: positive, neckMeterLoss_Pa: positive, neckMeterArea_m2: positive, neckSideEntryLoss_Pa: positive, neckFormLoss_Pa: positive }).strict()
const accSchema = z.object({ totalVolume_m3: positive, water_m3: positive, gas_m3: positive, temperature_C: celsius, interfacePressure_MPa: positive,
  interface_m: finite, bottom_m: finite, roof_m: finite, area_m2: positive, tracer_ppm: z.number().finite().nonnegative(),
  nitrogenGasConstant_J_kgK: positive, nitrogenCv_J_kgK: positive, referenceFlow_kg_s: positive, referenceLoss_MPa: positive, meterLoss_kPa: positive,
  variableArea_m2: positive, meterArea_m2: positive, bore_m: positive, checks: count, checkCrack_Pa: positive, isolationTravel_s: positive,
  motionPower_W: positive, vent: z.object({ elevation_m: finite, bore_m: positive, area_m2: positive, travel_s: positive, motionPower_W: positive }).strict(),
  entrainmentReview_m: positive, selectedLiquidMass_kg: positive, selectedNitrogenMass_kg: positive }).strict()
const adsSchema = z.object({ stages: z.array(z.object({ stage: z.number().int().min(1).max(4), area_m2: positive,
  receiver: z.enum(['WST.SPARGER', 'CNV']) }).strict()).length(4), paths: count, sparger_m: finite, chamberVolume_m3: positive,
  chamberElevation_m: finite, portBore_m: positive, portElevation_m: finite, poweredTravel_s: positive, poweredMotion_W: positive,
  stage4: z.object({ source: z.literal('HOT'), pulse_W: positive, pulse_s: positive, travel_s: positive, springStock_J: positive }).strict() }).strict()
const oneShotSchema = z.object({ pulse_W: positive, pulse_s: positive, travel_s: positive, springStock_J: positive }).strict()
const gravitySchema = z.object({ oneShot: oneShotSchema,
  giv: z.object({ fill: z.literal('WST'), fillTemperature_C: celsius, tracer_ppm: z.number().finite().nonnegative() }).strict(),
  recirc: z.object({ fill: z.literal('dry-air'), fillTemperature_C: celsius, airGasConstant_J_kgK: positive, airCv_J_kgK: positive }).strict(),
  screenFraction: fraction }).strict()
const prhrSchema = z.object({ travel_s: positive, holdPower_W: positive, closingPower_W: positive, springStock_J: positive,
  actuator: z.literal('ACT.A'), room: z.literal('ROOM.A'), insulation_m: positive, insulationConductivity_W_mK: positive,
  exteriorCoefficient_W_m2K: positive, tubeEntranceLoss: positive, tubeDischargeLoss: positive, preparedBank_C: celsius }).strict()
const sequenceSchema = z.object({ cmtLowLevel_m: positive, cmtLowLowLevel_m: positive, levelQualification_s: positive, stage2Delay_s: positive,
  stage3Delay_s: positive, stage4Delay_s: positive, levelUnavailable_s: positive, pzrLowPressure_MPa: positive, pzrLowLevel_m: positive,
  pzrQualification_s: positive, lt: z.object({ span_m: z.tuple([z.number().finite(), positive]), lag_s: positive, resolution_m: positive,
    fullCold_m: positive, datum_m: finite, upperTap_m: finite }).strict() }).strict()
const stateSchema = z.object({ pressure_MPa: positive, temperature_K: positive, elevation_m: finite }).strict()
const boundarySchema = z.object({ hotAfter: stateSchema, sgOutlet: stateSchema, sgOutletVelocity_m_s: finite, pzrRoof_Pa: positive, pzrRoof_m: finite }).strict()
const witnessSchema = z.object({ coldWitness: z.object({ pressure_Pa: positive, enthalpy_J_kg: positive, elevation_m: finite }).passthrough() }).passthrough()

export type PassivePages = Record<keyof typeof passiveOwners | keyof typeof referencePages, string>

const kelvin = (c: number) => c + 273.15, mega = (x: number) => x * 1e6, ppm = (x: number) => x / 1e6
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance
const pipeArea = (d: number) => Math.PI * d * d / 4

/** Volume, first moment and axial wetted measure of the free tank between z0 and z1 (two-point Gauss per cut interval: exact for the quadratic area). */
function layerIntegrals(g: ReturnType<typeof tankGeometry>, z0: number, z1: number) {
  const b = g.b, rb = b.bodyOuterDiameter_m / 2, rf = b.feedOuterDiameter_m / 2
  const cuts = [...new Set([z0, z1, ...g.breaks([0, g.R, rb, rf])].filter(z => z >= z0 && z <= z1))].sort((a, c) => a - c)
  // Solid perimeter in contact with the free water at elevation z: shell wall plus body/feed obstruction.
  const perimeter = (z: number) => {
    const shell = Math.sqrt(g.shellR2(z))
    const obstruction = z >= b.bodyBottom_m && z <= b.bodyTop_m ? rb : z > b.bodyTop_m ? rf : 0
    return g.area(z) > 0 ? 2 * Math.PI * (shell + obstruction) : 0
  }
  let v = 0, moment = 0, wetted = 0
  for (let i = 1; i < cuts.length; i++) {
    const m = (cuts[i]! + cuts[i - 1]!) / 2, h = (cuts[i]! - cuts[i - 1]!) / 2
    for (const s of [-1, 1]) {
      const z = m + s * h / Math.sqrt(3)
      v += h * g.area(z); moment += h * g.area(z) * z; wetted += h * perimeter(z)
    }
  }
  return { volume_m3: v, centroid_m: moment / v, axialWetted_m2: wetted, hydraulicDiameter_m: 4 * v / wetted }
}

/** The passive section from the owners' page texts. */
export function compileOperatingPassive(pages: PassivePages) {
  const o = passiveOwners
  const read = <T>(key: keyof typeof passiveOwners, schema: z.ZodType<T>) => schema.parse(ownedBlock(pages[key], o[key].heading, o[key].fence))
  const cmt = read('cmt', cmtSchema), dvi = read('dvi', dviSchema), acc = read('acc', accSchema), ads = read('ads', adsSchema)
  const gravity = read('gravity', gravitySchema), prhrB = read('prhr', prhrSchema), sequence = read('sequence', sequenceSchema)
  const boundary = read('boundary', boundarySchema)
  const gb = parseGeometryBasis(pages.geometry), bal = parseBalancePathBasis(pages.geometry), delivery = deliveryBasis(pages.injection)
  const intakes = parseGravityIntakes(pages.injection), prhr = compilePrhrOperatingGeometry(pages.exchanger)
  const submerged = [...pages.transport.matchAll(/^```reference-cmt-submerged\s*\n([\s\S]*?)^```\s*$/gm)]
  if (submerged.length !== 1) throw Error('Expected one reference-cmt-submerged block')
  const witness = witnessSchema.parse(JSON.parse(submerged[0]![1]!)).coldWitness

  // ---- CMT tank: six layers from the geometry (C11-D1).
  const g = tankGeometry(gb), a = g.a
  const lowerJoin = gb.bottomDatum_m + a, upperJoin = gb.top_m - a
  if (!near(lowerJoin, 6.943094037, 5e-10) || !near(upperJoin, 11.056905963, 5e-10))
    throw Error(`The head joins ${lowerJoin}/${upperJoin} m are not the owner's +6.943094/+11.056906 m`)
  const roof = g.roof(gb.feedOuterDiameter_m / 2)
  if (!near(roof, 11.998394870, 5e-10)) throw Error(`The free-water roof ${roof} m is not the owner's +11.998394870 m`)
  const barrel = (upperJoin - lowerJoin) / cmt.barrelLayers
  const cuts = [g.mouth, lowerJoin, ...Array.from({ length: cmt.barrelLayers - 1 }, (_, i) => lowerJoin + (i + 1) * barrel), upperJoin, gb.bodyBottom_m, roof]
  if (!cuts.every((z, i) => i === 0 || z > cuts[i - 1]!)) throw Error('CMT layer cuts are not increasing')
  const layers = cuts.slice(1).map((top, i) => ({ id: `L${i + 1}`, bottom_m: cuts[i]!, top_m: top, ...layerIntegrals(g, cuts[i]!, top) }))
  const tankVolume = layers.reduce((s, l) => s + l.volume_m3, 0)
  if (!near(tankVolume, gb.freeWater_m3, 1e-9)) throw Error(`The layers hold ${tankVolume} m3, not the ${gb.freeWater_m3} m3 free water`)
  const interfaces = layers.slice(1).map((upper, i) => {
    const lower = layers[i]!, z = upper.bottom_m
    return { from: lower.id, to: upper.id, elevation_m: z, area_m2: g.area(z), length_m: upper.centroid_m - lower.centroid_m,
      hydraulicDiameter_m: 4 * (lower.volume_m3 + upper.volume_m3) / (lower.axialWetted_m2 + upper.axialWetted_m2) }
  })
  const receiving = layers.at(-1)!
  const rings = gb.ringElevations_m.map((z, i) => {
    if (!(z > receiving.bottom_m && z < receiving.top_m)) throw Error(`Ring ${i + 1} at ${z} m is not in the receiving layer`)
    return { id: `RING.${i + 1}`, elevation_m: z, area_m2: ringArea(gb, z, z - gb.holeDiameter_m, z + gb.holeDiameter_m) }
  })
  const ringTotal = rings.reduce((s, r) => s + r.area_m2, 0)
  if (!near(ringTotal, gb.holesPerRing * 3 * pipeArea(gb.holeDiameter_m), 1e-12)) throw Error('The ring areas do not make up the thirty holes')

  // ---- Balance line: RUN, RISER.1..n, DIST (roof + internal BAL group).
  if (bal.bore_m !== delivery.bore_m) throw Error('BAL and outlet bores differ from the selected 0.20 m')
  const A = pipeArea(bal.bore_m), inv = g.inventories
  // External BAL = the main run, riser and roof connector plus the feed's part above the tank (its full 0.025 m less the inside intrusion).
  const route = cmt.balance.mainLength_m + cmt.balance.riserLength_m + cmt.balance.roofLength_m, feed = A * cmt.balance.feedLength_m
  const external = A * route + feed - inv.feedWater_m3
  // Tolerance: the printed route lengths carry 1e-6 m rounding (2 x 5e-7 m x 0.0314 m2).
  if (!near(external, inv.externalBAL_m3, 5e-8)) throw Error(`The BAL route holds ${external} m3, the geometry's external BAL is ${inv.externalBAL_m3} m3`)
  const riserTop = bal.headerElevation_m + cmt.balance.riserLength_m
  if (!near(riserTop, gb.top_m, 1e-12)) throw Error(`The riser ends at ${riserTop} m, not the +${gb.top_m} m roof connector`)
  const riserCell = cmt.balance.riserLength_m / cmt.balance.riserCells
  // DIST: roof connector, the whole feed and the distributor body water (the 0.05 m3 group's neighbourhood).
  const roofWater = A * cmt.balance.roofLength_m, distVolume = roofWater + feed + inv.effectiveBodyWater_m3
  const distCentroid = (roofWater * gb.top_m + feed * (gb.bodyTop_m + gb.top_m) / 2
    + inv.effectiveBodyWater_m3 * (gb.bodyBottom_m + gb.bodyTop_m) / 2) / distVolume
  const balanceCells = [
    { id: 'BAL.RUN', volume_m3: A * cmt.balance.mainLength_m, centroid_m: bal.headerElevation_m, length_m: cmt.balance.mainLength_m, rise_m: 0 },
    ...Array.from({ length: cmt.balance.riserCells }, (_, i) => ({ id: `BAL.RISER.${i + 1}`, volume_m3: A * riserCell,
      centroid_m: bal.headerElevation_m + (i + 0.5) * riserCell, length_m: riserCell, rise_m: riserCell })),
    { id: 'BAL.DIST', volume_m3: distVolume, centroid_m: distCentroid, length_m: cmt.balance.roofLength_m, rise_m: 0 },
  ]
  const balVolume = balanceCells.reduce((s, c) => s + c.volume_m3, 0)
  if (!near(balVolume, gb.balanceWater_m3, 5e-8)) throw Error(`The BAL cells hold ${balVolume} m3, not ${gb.balanceWater_m3} m3`)
  // Paths with their physical joint elevation: tap->RUN at the tap, RUN->RISER.1 at the riser foot, between riser cells, RISER->DIST at the roof connector.
  const joints = [bal.headerElevation_m, ...Array.from({ length: cmt.balance.riserCells - 1 }, (_, i) => bal.headerElevation_m + (i + 1) * riserCell), gb.top_m]
  const balancePaths = [{ from: 'COLD.TAP', to: 'BAL.RUN', length_m: cmt.balance.mainLength_m / 2, junction_m: bal.headerElevation_m, isolation: true },
    ...balanceCells.slice(1).map((to, i) => ({ from: balanceCells[i]!.id, to: to.id, length_m: (balanceCells[i]!.length_m + to.length_m) / 2,
      junction_m: joints[i]!, isolation: false }))].map(p => ({ ...p, area_m2: A, bore_m: bal.bore_m, roughness_m: bal.roughness_m }))

  // ---- Outlet: isolations at the mouth, one passage cell, path to DVI with meter, open check and discharge.
  const out = cmt.outlet
  if (out.length_m !== delivery.length_m || out.bore_m !== delivery.bore_m || out.referenceFlow_kg_s !== delivery.referenceFlow_kg_s
    || out.checkCrack_Pa !== delivery.checkCrack_Pa || out.opening_s !== delivery.opening_s || out.closing_s !== delivery.closing_s)
    throw Error('The outlet block disagrees with reference-cmt-delivery')
  const outletTotal = out.pipeLoss_Pa + out.dischargeLoss_Pa + out.meterLoss_Pa + out.openCheckLoss_Pa + out.isolationLoss_Pa
  if (!near(outletTotal, delivery.totalLoss_Pa, 1e-6)) throw Error(`The outlet losses sum to ${outletTotal} Pa, not ${delivery.totalLoss_Pa} Pa`)
  for (const a_ of [out.isolationArea_m2, out.checkArea_m2, out.meterArea_m2, cmt.balance.isolationArea_m2])
    if (!(a_ < A)) throw Error(`An effective area ${a_} m2 is not below the ${A} m2 bore`)
  const outletCell = { id: 'OUT', volume_m3: A * out.length_m, centroid_m: (g.mouth + delivery.dviPort_m) / 2, length_m: out.length_m }
  // Tank->OUT carries the mouth isolations over the upper half pipe; OUT->DVI the lower half with meter, check body, discharge and check.
  const outletPaths = [{ from: 'L1', to: 'OUT', length_m: out.length_m / 2, junction_m: g.mouth, losses: ['pipe', 'isolation'] },
    { from: 'OUT', to: 'DVI', length_m: out.length_m / 2, junction_m: delivery.dviPort_m, losses: ['pipe', 'meter', 'openCheck', 'discharge', 'check'] }]

  // ---- DVI with the neck water.
  if (dvi.volume_m3 !== delivery.dviVolume_m3 || dvi.bottom_m !== delivery.dviBottom_m || dvi.top_m !== delivery.dviTop_m || dvi.port_m !== delivery.dviPort_m)
    throw Error('The DVI block disagrees with reference-cmt-delivery')
  if (!near(dvi.area_m2 * (dvi.top_m - dvi.bottom_m), dvi.volume_m3, 1e-12)) throw Error('The DVI envelope is not its volume')
  const neck = pipeArea(bal.dviNeckBore_m) * bal.dviNeckLength_m
  if (!near(neck, dvi.neckVolume_m3, 1e-9)) throw Error(`The DVI neck holds ${neck} m3, the block prints ${dvi.neckVolume_m3} m3`)

  // ---- Accumulator.
  if (!near(acc.water_m3 + acc.gas_m3, acc.totalVolume_m3, 1e-12) || !near(acc.area_m2 * (acc.roof_m - acc.bottom_m), acc.totalVolume_m3, 1e-12))
    throw Error('The ACC volumes do not close on its cylinder')
  if (!near(acc.area_m2 * (acc.interface_m - acc.bottom_m), acc.water_m3, 1e-12)) throw Error('The ACC interface does not hold its water volume')
  if (!(acc.meterLoss_kPa * 1e3 < mega(acc.referenceLoss_MPa))) throw Error('The ACC meter loss exceeds its branch sizing loss')
  for (const a_ of [acc.variableArea_m2, acc.meterArea_m2]) if (!(a_ < pipeArea(acc.bore_m))) throw Error('An ACC effective area is not below its bore')
  if (!(acc.vent.area_m2 < pipeArea(acc.vent.bore_m))) throw Error('The ACC vent CdA is not below its bore area')

  // ---- ADS.
  if (ads.stages.map(s => s.stage).join() !== '1,2,3,4') throw Error('ADS stages must be 1..4 in order')
  if (ads.stages.slice(0, 3).some(s => s.receiver !== 'WST.SPARGER') || ads.stages[3]!.receiver !== 'CNV') throw Error('ADS receivers misassigned')
  // Stages 1-3 draw through the 0.08 m PZR mouths; stage 4's HOT takeoff bore is not selected (wiki engineering item).
  for (const s of ads.stages.slice(0, 3)) if (!(s.area_m2 < pipeArea(ads.portBore_m))) throw Error(`ADS stage ${s.stage} CdA is not below its port bore area`)
  const oneShot = gravity.oneShot
  if (JSON.stringify(oneShot) !== JSON.stringify({ pulse_W: ads.stage4.pulse_W, pulse_s: ads.stage4.pulse_s, travel_s: ads.stage4.travel_s, springStock_J: ads.stage4.springStock_J }))
    throw Error('The ADS4 and GIV/RECIRC one-shot mechanisms differ')
  const chambers = ads.stages.slice(0, 3).flatMap(s => Array.from({ length: ads.paths }, (_, p) => ({ id: `ADS.${s.stage}.${'AB'[p]}.CHAMBER`,
    stage: s.stage, path: 'AB'[p]!, volume_m3: ads.chamberVolume_m3, elevation_m: ads.chamberElevation_m, area_m2: s.area_m2 })))

  // ---- Gravity columns.
  // Effective areas are frozen from each element's own liquid sizing point (60 kg/s, 25 C donor, receiver 101325 Pa):
  // the prototype evaluates them through the property boundary, not this compiler.
  const columns = intakes.branches.map(br => ({ id: br.name, length_m: br.length_m, bore_m: intakes.diameter_m,
    volume_m3: pipeArea(intakes.diameter_m) * br.length_m, mouth_m: br.intake_m, terminal_m: intakes.terminal_m,
    centroid_m: (br.intake_m + intakes.terminal_m) / 2, sourceDrop_Pa: br.variableDrop_Pa, meterDrop_Pa: br.meterDrop_Pa }))

  // ---- Sequence and LT.
  if (!(sequence.cmtLowLowLevel_m < sequence.cmtLowLevel_m && sequence.cmtLowLevel_m < sequence.lt.fullCold_m && sequence.lt.fullCold_m <= sequence.lt.span_m[1]))
    throw Error('The CMT level settings are not ordered inside the LT span')
  if (sequence.lt.upperTap_m !== gb.upperTap_m) throw Error('The LT upper tap is not the geometry tap')
  if (!near(sequence.lt.fullCold_m, sequence.lt.upperTap_m - sequence.lt.datum_m, 1e-12)) throw Error('Full cold water does not read the upper tap above the datum')

  // ---- PRHR: the cold-join partition, with its actuation.
  if (prhrB.tubeEntranceLoss + prhrB.tubeDischargeLoss !== prhr.geometry.tubes.entryExitLoss_K) throw Error('The tube entrance/discharge split does not make up entryExitLoss_K')
  if (!(prhrB.preparedBank_C === prhr.mixing.preparedBank_C[0] || prhrB.preparedBank_C === prhr.mixing.preparedBank_C[1]))
    throw Error('The prepared bank temperature is not one of the selected preparations')

  // ---- Census from the compiled owners (C11-D1..D7).
  type Owner = { owner: string, differential: number, algebraic: number }
  const cell = (id: string, nc = false): Owner => ({ owner: id, differential: 5 + (nc ? 2 : 0), algebraic: 1 })
  const paths = (id: string, n: number): Owner => ({ owner: id, differential: 2 * n, algebraic: 0 })
  const links = (id: string, n: number): Owner => ({ owner: id, differential: 0, algebraic: 2 * n })
  const train = (t: string): Owner[] => [
    ...layers.map(l => cell(`CMT.${t}.${l.id}`)), paths(`CMT.${t}.INTERLAYER`, interfaces.length),
    ...balanceCells.map(c => cell(`CMT.${t}.${c.id}`)), paths(`CMT.${t}.BAL.PATHS`, balancePaths.length),
    links(`CMT.${t}.RINGS`, rings.length), cell(`CMT.${t}.OUT`), paths(`CMT.${t}.OUTLET.PATHS`, outletPaths.length),
    cell(`DVI.${t}`, true), paths(`DVI.${t}.NECK`, 1),
    { owner: `ACC.${t}`, differential: 7, algebraic: 4 }, links(`ACC.${t}.OUTLET`, 1), links(`ACC.${t}.VENT`, 1),
    // S4-D13: the GIV/RECIRC source and terminal devices sit on inertance paths over half the column each.
    ...['GIV', 'RECIRC'].flatMap(c => [{ owner: `${c}.${t}`, differential: 5, algebraic: 2 }, paths(`${c}.${t}.SOURCE`, 1), paths(`${c}.${t}.TERMINAL`, 1)]),
  ]
  const owners: Owner[] = [...train('A'), ...train('B'),
    ...chambers.map(c => ({ owner: c.id, differential: 5, algebraic: 2 })), links('ADS.1-3.DEVICES', 2 * chambers.length), links('ADS.4', ads.paths),
    ...prhr.parts.map(p => cell(p.id)), { owner: 'PRHR.STEEL', differential: prhr.steel.length + prhr.disc.length, algebraic: 0 },
    paths('PRHR.LINKS', prhr.links.filter(l => !l.seat).length), links('PRHR.SEAT', 1),
    // The selected series film law shares one surface temperature per contact: every region's inner contact,
    // the two disc faces and every immersed region's pool contact (algebraic).
    { owner: 'PRHR.SURFACES', differential: 0, algebraic: prhr.parts.length + prhr.disc.length + prhr.parts.filter(p => p.immersed).length }]
  const differential = owners.reduce((n, x) => n + x.differential, 0), algebraic = owners.reduce((n, x) => n + x.algebraic, 0)

  return {
    cmt: { temperature_K: kelvin(cmt.waterTemperature_C), tracer_kg_kg: ppm(cmt.tracer_ppm), referencePressure_Pa: mega(cmt.referencePressure_MPa),
      mouth_m: g.mouth, roof_m: roof, radius_m: g.R, upperTap_m: gb.upperTap_m,
      // The free-area law A(z) inputs (cmt-receiving-geometry.md): shell radius and head depth, virtual tips,
      // body and feed obstruction radii and their interval; the draindown probe integrates A(z) from these.
      geometry: { shellRadius_m: g.R, headDepth_m: a, bottomTip_m: gb.bottomDatum_m, topTip_m: gb.top_m,
        bodyBottom_m: gb.bodyBottom_m, bodyTop_m: gb.bodyTop_m, bodyRadius_m: gb.bodyOuterDiameter_m / 2, feedRadius_m: gb.feedOuterDiameter_m / 2 }, probes: g.probes.map(p => ({ id: p.name, elevation_m: p.elevation_m })),
      layers, interfaces, rings: { holeDiameter_m: gb.holeDiameter_m, Cd: bal.Cd, Cv: bal.Cv, list: rings },
      balance: { tap_m: bal.headerElevation_m, bore_m: bal.bore_m, roughness_m: bal.roughness_m, cells: balanceCells, paths: balancePaths,
        isolation: { area_m2: cmt.balance.isolationArea_m2, referenceLoss_Pa: cmt.balance.isolationLoss_Pa, travel_s: cmt.balance.travel_s, motionPower_W: cmt.balance.motionPower_W } },
      outlet: { cell: outletCell, paths: outletPaths, bore_m: out.bore_m, roughness_m: delivery.roughness_m, referenceFlow_kg_s: out.referenceFlow_kg_s,
        isolation: { count: out.isolations, area_m2: out.isolationArea_m2, opening_s: out.opening_s, closing_s: out.closing_s,
          holdPower_W: out.holdPower_W, closingPower_W: out.closingPower_W, springStock_J: out.springStock_J },
        check: { crack_Pa: out.checkCrack_Pa, area_m2: out.checkArea_m2 }, meter: { area_m2: out.meterArea_m2, referenceLoss_Pa: out.meterLoss_Pa },
        losses_Pa: { pipe: out.pipeLoss_Pa, discharge: out.dischargeLoss_Pa, meter: out.meterLoss_Pa, openCheck: out.openCheckLoss_Pa, isolation: out.isolationLoss_Pa } } },
    dvi: { volume_m3: dvi.volume_m3 + dvi.neckVolume_m3, manifold_m3: dvi.volume_m3, neck_m3: dvi.neckVolume_m3, elevation_m: dvi.port_m,
      neck: { length_m: bal.dviNeckLength_m, bore_m: bal.dviNeckBore_m, roughness_m: bal.roughness_m, referenceFlow_kg_s: bal.dviReferenceFlow_kg_s,
        referenceLoss_Pa: bal.dviReferenceLoss_Pa, meterArea_m2: dvi.neckMeterArea_m2, meterLoss_Pa: dvi.neckMeterLoss_Pa,
        sideEntryLoss_Pa: dvi.neckSideEntryLoss_Pa, formLoss_Pa: dvi.neckFormLoss_Pa, formVelocityHeads: dvi.neckFormLoss_Pa / dvi.neckSideEntryLoss_Pa,
        referenceDensity_kg_m3: bal.coldDensity_kg_m3 } },
    acc: { area_m2: acc.area_m2, bottom_m: acc.bottom_m, roof_m: acc.roof_m, interface_m: acc.interface_m, interfacePressure_Pa: mega(acc.interfacePressure_MPa),
      temperature_K: kelvin(acc.temperature_C), tracer_kg_kg: ppm(acc.tracer_ppm), nitrogen: { R_J_kgK: acc.nitrogenGasConstant_J_kgK, cv_J_kgK: acc.nitrogenCv_J_kgK },
      outlet: { variableArea_m2: acc.variableArea_m2, meterArea_m2: acc.meterArea_m2, bore_m: acc.bore_m, checks: acc.checks, checkCrack_Pa: acc.checkCrack_Pa,
        travel_s: acc.isolationTravel_s, motionPower_W: acc.motionPower_W }, vent: acc.vent, entrainmentReview_m: acc.entrainmentReview_m,
      selected: { liquid_kg: acc.selectedLiquidMass_kg, nitrogen_kg: acc.selectedNitrogenMass_kg } },
    ads: { stages: ads.stages, paths: ads.paths, sparger_m: ads.sparger_m, chambers, portBore_m: ads.portBore_m, portElevation_m: ads.portElevation_m,
      poweredTravel_s: ads.poweredTravel_s, poweredMotion_W: ads.poweredMotion_W, stage4: ads.stage4 },
    gravity: { oneShot, screenFraction: gravity.screenFraction, checkCrack_Pa: intakes.checkCrack_Pa,
      calibration: { flow_kg_s: intakes.referenceFlow_kg_s, temperature_K: intakes.referenceTemperature_K, pressure_Pa: intakes.referencePressure_Pa },
      columns: columns.map(c => ({ ...c, fill: c.id === 'GIV'
        ? { kind: 'WST', temperature_K: kelvin(gravity.giv.fillTemperature_C), tracer_kg_kg: ppm(gravity.giv.tracer_ppm) }
        : { kind: 'dry-air', temperature_K: kelvin(gravity.recirc.fillTemperature_C), R_J_kgK: gravity.recirc.airGasConstant_J_kgK, cv_J_kgK: gravity.recirc.airCv_J_kgK } })) },
    prhr: { parts: prhr.parts, links: prhr.links, steel: prhr.steel, disc: prhr.disc, valveK: prhr.valveK,
      discCenterConductance_W_K: prhr.discCenterConductance_W_K, shellCenterConductance_W_K: prhr.shellCenterConductance_W_K,
      geometry: prhr.geometry, mixing: prhr.mixing, contact: prhr.contact, pool: prhr.pool, totals: prhr.totals,
      actuation: { travel_s: prhrB.travel_s, holdPower_W: prhrB.holdPower_W, closingPower_W: prhrB.closingPower_W, springStock_J: prhrB.springStock_J,
        actuator: prhrB.actuator, room: prhrB.room },
      connectors: { insulation_m: prhrB.insulation_m, insulationConductivity_W_mK: prhrB.insulationConductivity_W_mK, exteriorCoefficient_W_m2K: prhrB.exteriorCoefficient_W_m2K },
      tubeLosses: { entrance: prhrB.tubeEntranceLoss, discharge: prhrB.tubeDischargeLoss }, preparedBank_K: kelvin(prhrB.preparedBank_C) },
    sequence,
    boundary: { coldWitness: { pressure_Pa: witness.pressure_Pa, enthalpy_J_kg: witness.enthalpy_J_kg, elevation_m: witness.elevation_m },
      hotAfter: { pressure_Pa: mega(boundary.hotAfter.pressure_MPa), temperature_K: boundary.hotAfter.temperature_K, elevation_m: boundary.hotAfter.elevation_m },
      sgOutlet: { pressure_Pa: mega(boundary.sgOutlet.pressure_MPa), temperature_K: boundary.sgOutlet.temperature_K, elevation_m: boundary.sgOutlet.elevation_m },
      sgOutletVelocity_m_s: boundary.sgOutletVelocity_m_s, pzrRoof: { pressure_Pa: boundary.pzrRoof_Pa, elevation_m: boundary.pzrRoof_m } },
    census: { differential, algebraic, total: differential + algebraic, owners },
  }
}

export async function prepareOperatingPassive(wiki: string) {
  const base = join(wiki, 'world/packs/process-plant/reference-designs/ld-01')
  const text = async (page: string) => Bun.file(join(base, page)).text()
  const owned = Object.entries(passiveOwners) as [keyof typeof passiveOwners, { page: string, fence: string }][]
  const references = Object.entries(referencePages) as [keyof typeof referencePages, string][]
  const pages = Object.fromEntries([
    ...await Promise.all(owned.map(async ([k, o]) => [k, await text(o.page)] as const)),
    ...await Promise.all(references.map(async ([k, p]) => [k, await text(p)] as const)),
  ]) as PassivePages
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  return { ...compileOperatingPassive(pages), provenance: {
    consumed: [...new Set([...owned.map(([, o]) => o.page), ...references.map(([, p]) => p)])].map(page => ({ page, sha256: hash(pages[(owned.find(([, o]) => o.page === page)?.[0]
      ?? references.find(([, p]) => p === page)![0]) as keyof PassivePages]) })),
    sourceSha256: hash(await Bun.file(import.meta.path).text()) } }
}

if (import.meta.main) {
  const [wiki] = Bun.argv.slice(2)
  if (!wiki || Bun.argv.length !== 3) throw Error('Usage: operating-passive <wiki root>')
  console.log(JSON.stringify(await prepareOperatingPassive(wiki)))
}
