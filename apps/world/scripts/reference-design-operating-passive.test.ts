import { describe, expect, test } from 'bun:test'
import { ZodError } from 'zod'
import { compileOperatingPassive, type PassivePages } from './reference-design-operating-passive'

// Test-only owner texts in the shapes the compiler reads; not plant evidence. The block bodies are copied
// unchanged from the wiki's passive-cooling pages: the eight `ld01-c11-*` blocks of "Compact operating
// allocation (15 October 2026)" and the `reference-*` blocks the apparatus compilers read.
const fence = (name: string, body: unknown) => '```' + name + '\n' + JSON.stringify(body) + '\n```\n'

const cmt = {"waterTemperature_C":40,"tracer_ppm":2000,"barrelLayers":3,"receivingCut":"bodyBottom","referencePressure_MPa":15.2,
  "outlet":{"length_m":8,"bore_m":0.2,"referenceFlow_kg_s":25,"pipeLoss_Pa":213.584,"dischargeLoss_Pa":317.029,"meterLoss_Pa":2000,"openCheckLoss_Pa":250,
    "isolationLoss_Pa":17219.387,"checkCrack_Pa":1000,"isolations":2,"isolationArea_m2":0.004224072,"checkArea_m2":0.02349074,"meterArea_m2":0.01162074,
    "opening_s":2,"closing_s":5,"holdPower_W":20,"closingPower_W":1000,"springStock_J":2500},
  "balance":{"isolationLoss_Pa":899.783101,"isolationArea_m2":0.017788217,"mainLength_m":21.239439,"riserLength_m":9,"roofLength_m":0.800924,
    "feedLength_m":0.025,"riserCells":2,"travel_s":2,"motionPower_W":100}}
const dvi = {"volume_m3":0.5,"bottom_m":2.5,"top_m":3.5,"area_m2":0.5,"port_m":3,"neckVolume_m3":0.031415927,"neckMeterLoss_Pa":1000,"neckMeterArea_m2":0.02871290,"neckSideEntryLoss_Pa":5072.464,"neckFormLoss_Pa":3547.879}
const acc = {"totalVolume_m3":50,"water_m3":35,"gas_m3":15,"temperature_C":25,"interfacePressure_MPa":5,"interface_m":6.5,"bottom_m":3,"roof_m":8,"area_m2":10,
  "tracer_ppm":2000,"nitrogenGasConstant_J_kgK":296.8,"nitrogenCv_J_kgK":742,"referenceFlow_kg_s":100,"referenceLoss_MPa":1,"meterLoss_kPa":100,
  "variableArea_m2":0.00235200096,"meterArea_m2":0.00690268898,"bore_m":0.2,"checks":2,"checkCrack_Pa":1000,"isolationTravel_s":2,"motionPower_W":100,
  "vent":{"elevation_m":8,"bore_m":0.02,"area_m2":0.0001,"travel_s":2,"motionPower_W":100},"entrainmentReview_m":0.2,"selectedLiquidMass_kg":34973.883635,
  "selectedNitrogenMass_kg":847.474144}
const ads = {"stages":[{"stage":1,"area_m2":0.0002,"receiver":"WST.SPARGER"},{"stage":2,"area_m2":0.0008,"receiver":"WST.SPARGER"},
  {"stage":3,"area_m2":0.0015,"receiver":"WST.SPARGER"},{"stage":4,"area_m2":0.006,"receiver":"CNV"}],"paths":2,"sparger_m":9,"chamberVolume_m3":0.02,
  "chamberElevation_m":18.5,"portBore_m":0.08,"portElevation_m":18.5,"poweredTravel_s":2,"poweredMotion_W":2000,
  "stage4":{"source":"HOT","pulse_W":2000,"pulse_s":0.5,"travel_s":0.5,"springStock_J":500}}
const gravity = {"oneShot":{"pulse_W":2000,"pulse_s":0.5,"travel_s":0.5,"springStock_J":500},"giv":{"fill":"WST","fillTemperature_C":25,"tracer_ppm":2000},
  "recirc":{"fill":"dry-air","fillTemperature_C":25,"airGasConstant_J_kgK":287,"airCv_J_kgK":718},"screenFraction":1}
const prhr = {"travel_s":5,"holdPower_W":20,"closingPower_W":1000,"springStock_J":2500,"actuator":"ACT.A","room":"ROOM.A","insulation_m":0.1,
  "insulationConductivity_W_mK":0.06,"exteriorCoefficient_W_m2K":8,"tubeEntranceLoss":0.5,"tubeDischargeLoss":1,"preparedBank_C":25}
const sequence = {"cmtLowLevel_m":2,"cmtLowLowLevel_m":1,"levelQualification_s":0.5,"stage2Delay_s":10,"stage3Delay_s":10,"stage4Delay_s":20,
  "levelUnavailable_s":1,"pzrLowPressure_MPa":13,"pzrLowLevel_m":3,"pzrQualification_s":0.5,
  "lt":{"span_m":[0,6],"lag_s":1,"resolution_m":0.01,"fullCold_m":5.95,"datum_m":6,"upperTap_m":11.95}}
const boundary = {"hotAfter":{"pressure_MPa":14.9019331315,"temperature_K":592.408112050,"elevation_m":2.5},
  "sgOutlet":{"pressure_MPa":14.6886310476,"temperature_K":563.207816432,"elevation_m":3},"sgOutletVelocity_m_s":9.847249623,
  "pzrRoof_Pa":14864186.8055,"pzrRoof_m":18.5}

// reference-cmt-geometry and reference-cmt-balance-path (cmt-receiving-geometry.md)
const geometry = {"freeWater_m3":60,"bottomDatum_m":6,"top_m":12,"bodyBottom_m":11.725,"bodyTop_m":11.975,"bodyOuterDiameter_m":0.41,
  "bodyEffectiveInnerDiameter_m":0.35,"feedOuterDiameter_m":0.22,"feedInnerDiameter_m":0.20,"mouthDiameter_m":0.20,"balanceWater_m3":1,
  "distributorGroupWater_m3":0.05,"hardwareSolid_m3":0.02,"holeDiameter_m":0.06153846153846154,"holesPerRing":10,"ringElevations_m":[11.925,11.850,11.775],
  "upperTap_m":11.95,"topProbe_m":11.25,"bottomProbe_m":6.75,"probeRadialInset_m":0.15,"probeAzimuth_deg":18}
const balancePath = {"headerElevation_m":3,"bore_m":0.20,"roughness_m":0.000045,"balanceReferenceFlow_kg_s":25,"balanceReferenceLoss_Pa":2000,"Cd":0.62,"Cv":0.98,
  "hotDensity_kg_m3":745.7158573797482,"hotViscosity_Pa_s":0.00009238956797398296,"coldDensity_kg_m3":998.7373535000849,
  "coldViscosity_Pa_s":0.0006547658656041072,"dviNeckLength_m":1,"dviNeckBore_m":0.20,"dviReferenceFlow_kg_s":100,"dviReferenceLoss_Pa":10000}
// reference-cmt-submerged (cmt-transport.md)
const submerged = {"pressure_Pa":5000000,"staticPressures_Pa":[1000000,15000000],"contactVolume_m3":0.01,"duration_s":0.1,"initialVoids":[0.1,0.4,0.9],
  "subcoolings_K":[50,2],"sizeFactors":[0.5,1,2],"coldWitness":{"pressure_Pa":15202734.919352943,"enthalpy_J_kg":1286155.0442236066,"elevation_m":3,
  "parentSha256":"ad606e4d156cb9b635bfbd3fbdeb8e6eaf21bd53e60b510ad57dcabe82136ca6"},"boronFraction":0.002,"residualVaporFraction":0.000001,
  "coldHeaderPlanArea_m2":4}
// reference-cmt-delivery and reference-gravity-intakes (injection-and-depressurization.md)
const delivery = {"length_m":8,"bore_m":0.2,"roughness_m":0.000045,"valveZoneLength_m":0.2,"dviBottom_m":2.5,"dviTop_m":3.5,"dviPort_m":3,"dviVolume_m3":0.5,
  "referenceFlow_kg_s":25,"totalLoss_Pa":20000,"checkCrack_Pa":1000,"opening_s":2,"closing_s":5}
const intakes = {"diameter_m":0.2,"terminal_m":3,"reviewSubmergence_m":0.2,"referenceTemperature_K":298.15,"referencePressure_Pa":101325,"referenceFlow_kg_s":60,
  "checkCrack_Pa":1000,"wstInitialSurface_m":14.148275,"branches":[{"name":"GIV","length_m":8,"intake_m":8.2,"variableDrop_Pa":45000,"meterDrop_Pa":5000},
  {"name":"RECIRC","length_m":6,"intake_m":-1.8,"variableDrop_Pa":18000,"meterDrop_Pa":2000}]}
// reference-prhr-geometry, -isolation, -mixing, -phase-contact (residual-heat-exchanger.md)
const prhrGeometry = {"tubes":{"count":300,"id_m":0.05,"od_m":0.06,"straightLeg_m":5,"bendRadius_m":0.25,"pitch_m":0.1,"top_m":12.96,"bottom_m":11.04,
  "bendLoss_K":0.2,"entryExitLoss_K":1.5},"header":{"id_m":0.6,"od_m":0.64,"length_m":30},"hotConnector":{"id_m":0.5,"od_m":0.54,"length_m":13.5},
  "coldConnector":{"id_m":0.5,"od_m":0.54,"length_m":11},"connectorLoss_K":4,"roughness_m":0.000015,"steelDensity_kg_m3":8000,"steelCp_J_kgK":500,
  "steelConductivity_W_mK":15,"pool":{"width_m":32,"length_m":6.25,"floor_m":8,"initialWater_m3":1200,"initialGas_m3":60000},"hotTerminal_m":2.5,
  "coldTerminal_m":3,"calibration":{"flow_kg_s":350,"density_kg_m3":857.2005075123872,"viscosity_Pas":0.00012808820555927655,"meterDrop_Pa":2000,
  "totalDrop_Pa":20000}}
const prhrIsolation = {"spoolLength_m":0.6,"discDiameter_m":0.499,"discThickness_m":0.025}
const prhrMixing = {"coefficient":0.01,"turbulentPrandtl":0.85,"turbulentSchmidt":1,"penetrationBores":1,"preparedBank_C":[25,150]}
const prhrContact = {"gasSensible_W_m2K":5,"condensationVelocity_m_s":0.01,"effectiveEmissivity":0.3,"bankFactor":0.5}

const blocks = { cmt, dvi, acc, ads, gravity, prhr, sequence, boundary }
type Block = keyof typeof blocks
const references = { geometry, balancePath, submerged, delivery, intakes, prhrGeometry, prhrIsolation, prhrMixing, prhrContact }
type Reference = keyof typeof references
type Key = Block | Reference
const all: Record<Key, unknown> = { ...blocks, ...references }
const fences: Record<Key, string> = { cmt: 'ld01-c11-cmt', dvi: 'ld01-c11-dvi', acc: 'ld01-c11-acc', ads: 'ld01-c11-ads', gravity: 'ld01-c11-gravity',
  prhr: 'ld01-c11-prhr', sequence: 'ld01-c11-sequence', boundary: 'ld01-c11-boundary', geometry: 'reference-cmt-geometry',
  balancePath: 'reference-cmt-balance-path', submerged: 'reference-cmt-submerged', delivery: 'reference-cmt-delivery', intakes: 'reference-gravity-intakes',
  prhrGeometry: 'reference-prhr-geometry', prhrIsolation: 'reference-prhr-isolation', prhrMixing: 'reference-prhr-mixing',
  prhrContact: 'reference-prhr-phase-contact' }
const heading = '## Compact operating allocation (15 October 2026)'

type Texts = { injection: string, geometry: string, transport: string, exchanger: string }
/** The four page texts, with blocks replaced by `over` and left out by `omit`. */
function texts(over: Partial<Record<Key, unknown>> = {}, omit: Key[] = []): Texts {
  const b = (k: Key) => omit.includes(k) ? '' : fence(fences[k], over[k] ?? all[k])
  const strict = (Object.keys(blocks) as Block[]).map(b).join('\n')
  return {
    injection: '# Emergency inventory, depressurization and return flow\n\n## Common datums and installed supply paths\n\nProse.\n\n'
      + '### Gravity and recirculation intake and phase path\n\n' + b('intakes') + '\n### Finite CMT outlet passage and effective valve mechanics\n\n'
      + b('delivery') + '\n' + heading + '\n\nProse.\n\n### Strict blocks\n\n' + strict + '\n### Compact owners, coordinates and modes\n\nProse.\n',
    geometry: '# CMT receiving geometry\n\n' + b('geometry') + '\n## Single loss allocation and bounded checks\n\n' + b('balancePath'),
    transport: '# CMT transport\n\n## Bounded constitutive and source-off contact check\n\n' + b('submerged'),
    exchanger: '# Residual heat exchanger\n\n' + b('prhrGeometry') + '\n' + b('prhrIsolation') + '\n' + b('prhrMixing') + '\n' + b('prhrContact'),
  }
}
/** Every owner reads the one injection page; the reference pages are read whole. */
const assemble = (t: Texts): PassivePages => ({ cmt: t.injection, dvi: t.injection, acc: t.injection, ads: t.injection, gravity: t.injection,
  prhr: t.injection, sequence: t.injection, boundary: t.injection, injection: t.injection, geometry: t.geometry, transport: t.transport, exchanger: t.exchanger })
const pages = (over: Partial<Record<Key, unknown>> = {}, omit: Key[] = []) => assemble(texts(over, omit))

/** Every object key path in a block, nested objects and array elements included. */
const keyPaths = (v: unknown, prefix: (string | number)[] = []): (string | number)[][] =>
  Array.isArray(v) ? v.flatMap((x, i) => keyPaths(x, [...prefix, i]))
    : v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [[...prefix, k], ...keyPaths(x, [...prefix, k])]) : []
/** Every object (not array) in a block, the block itself first. */
const objectPaths = (v: unknown, prefix: (string | number)[] = []): (string | number)[][] =>
  Array.isArray(v) ? v.flatMap((x, i) => objectPaths(x, [...prefix, i]))
    : v !== null && typeof v === 'object' ? [prefix, ...Object.entries(v).flatMap(([k, x]) => objectPaths(x, [...prefix, k]))] : []
function edit<T>(block: T, path: (string | number)[], change: (parent: Record<string | number, unknown>, key: string | number) => void): T {
  const copy = structuredClone(block) as Record<string | number, unknown>
  const parent = path.slice(0, -1).reduce<Record<string | number, unknown>>((o, k) => o[k] as Record<string | number, unknown>, copy)
  change(parent, path.at(-1)!)
  return copy as T
}
const without = <T>(block: T, path: (string | number)[]) => edit(block, path, (o, k) => { delete o[k] })
const replaced = <T>(block: T, path: (string | number)[], value: unknown) => edit(block, path, (o, k) => { o[k] = value })

test('compiles the passive owners: 425 + 156 coordinates, six CMT layers, three receiving rings, four BAL cells, 19 PRHR regions', () => {
  const c = compileOperatingPassive(pages())
  expect(c.census).toMatchObject({ differential: 425, algebraic: 156, total: 581 })
  expect(c.cmt.layers.map(l => l.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6'])
  expect(Math.abs(c.cmt.layers.reduce((s, l) => s + l.volume_m3, 0) - geometry.freeWater_m3)).toBeLessThanOrEqual(1e-9)
  expect(c.cmt.layers.every((l, i) => i === 0 || l.bottom_m === c.cmt.layers[i - 1]!.top_m)).toBe(true)
  expect(c.cmt.interfaces).toHaveLength(5)
  const receiving = c.cmt.layers.at(-1)!
  expect(receiving.bottom_m).toBe(geometry.bodyBottom_m)
  expect(c.cmt.rings.list.map(r => [r.id, r.elevation_m])).toEqual([['RING.1', 11.925], ['RING.2', 11.85], ['RING.3', 11.775]])
  expect(c.cmt.rings.list.every(r => r.elevation_m > receiving.bottom_m && r.elevation_m < receiving.top_m)).toBe(true)
  expect(c.cmt.balance.cells.map(x => x.id)).toEqual(['BAL.RUN', 'BAL.RISER.1', 'BAL.RISER.2', 'BAL.DIST'])
  expect(Math.abs(c.cmt.balance.cells.reduce((s, x) => s + x.volume_m3, 0) - geometry.balanceWater_m3)).toBeLessThanOrEqual(5e-8)
  expect(c.cmt.balance.paths.map(x => [x.from, x.to, x.junction_m])).toEqual([["COLD.TAP", "BAL.RUN", 3], ["BAL.RUN", "BAL.RISER.1", 3], ["BAL.RISER.1", "BAL.RISER.2", 7.5], ["BAL.RISER.2", "BAL.DIST", 12]])
  expect(c.cmt.outlet.paths.map(x => [x.from, x.to])).toEqual([["L1", "OUT"], ["OUT", "DVI"]])
  expect(c.prhr.parts).toHaveLength(19)
  expect(c.cmt.temperature_K).toBeCloseTo(313.15, 12)
  expect(c.cmt.referencePressure_Pa).toBeCloseTo(15.2e6, 6)
  expect(c.dvi).toMatchObject({ manifold_m3: 0.5, neck_m3: 0.031415927, elevation_m: 3 })
  expect(c.acc).toMatchObject({ interfacePressure_Pa: 5e6, temperature_K: 298.15, interface_m: 6.5, selected: { liquid_kg: 34973.883635, nitrogen_kg: 847.474144 } })
  expect(c.ads.chambers.map(x => x.id)).toEqual(['ADS.1.A.CHAMBER', 'ADS.1.B.CHAMBER', 'ADS.2.A.CHAMBER', 'ADS.2.B.CHAMBER', 'ADS.3.A.CHAMBER', 'ADS.3.B.CHAMBER'])
  expect(c.gravity.columns.map(x => [x.id, x.fill.kind])).toEqual([['GIV', 'WST'], ['RECIRC', 'dry-air']])
  expect(c.gravity.oneShot).toEqual(gravity.oneShot)
  expect(c.prhr.tubeLosses).toEqual({ entrance: 0.5, discharge: 1 })
  expect(c.prhr.preparedBank_K).toBeCloseTo(298.15, 12)
  expect(c.boundary.coldWitness).toEqual({ pressure_Pa: 15202734.919352943, enthalpy_J_kg: 1286155.0442236066, elevation_m: 3 })
  expect(c.boundary.hotAfter.pressure_Pa).toBeCloseTo(14901933.1315, 6)
  expect(c.boundary.pzrRoof).toEqual({ pressure_Pa: 14864186.8055, elevation_m: 18.5 })
})

test('accepts the other selected bank preparation, 150 C', () => {
  expect(compileOperatingPassive(pages({ prhr: { ...prhr, preparedBank_C: 150 } })).prhr.preparedBank_K).toBeCloseTo(423.15, 12)
})

describe('refuses a missing value: every key of every ld01-c11 block', () => {
  for (const block of Object.keys(blocks) as Block[])
    for (const path of keyPaths(blocks[block]))
      test(`${block}.${path.join('.')}`, () => {
        expect(() => compileOperatingPassive(pages({ [block]: without(blocks[block], path) }))).toThrow(ZodError)
      })
})

describe('refuses an extra key in every object of every ld01-c11 block', () => {
  for (const block of Object.keys(blocks) as Block[])
    for (const path of objectPaths(blocks[block]))
      test(`${[block, ...path].join('.')}.extra`, () => {
        expect(() => compileOperatingPassive(pages({ [block]: replaced(blocks[block], [...path, 'extra'], 1) }))).toThrow(ZodError)
      })
})

test('refuses wrong literals, enums, counts and ranges', () => {
  const zod = (over: Partial<Record<Block, unknown>>) => expect(() => compileOperatingPassive(pages(over))).toThrow(ZodError)
  zod({ cmt: { ...cmt, receivingCut: 'roof' } })
  zod({ cmt: replaced(cmt, ['outlet', 'isolations'], 1.5) })
  zod({ ads: replaced(ads, ['stage4', 'source'], 'COLD') })
  zod({ ads: replaced(ads, ['stages', 0, 'receiver'], 'FLOOR') })
  zod({ ads: replaced(ads, ['stages', 3, 'stage'], 5) })
  zod({ ads: { ...ads, stages: ads.stages.slice(0, 3) } })
  zod({ gravity: replaced(gravity, ['giv', 'fill'], 'CNV') })
  zod({ gravity: replaced(gravity, ['recirc', 'fill'], 'nitrogen') })
  zod({ gravity: { ...gravity, screenFraction: 1.5 } })
  zod({ prhr: { ...prhr, actuator: 'ACT.B' } })
  zod({ prhr: { ...prhr, room: 'ROOM.B' } })
  zod({ sequence: replaced(sequence, ['lt', 'span_m'], [0]) })
  zod({ boundary: replaced(boundary, ['hotAfter', 'temperature_K'], -1) })
})

test('refuses values that break their identities', () => {
  const refuses = (over: Partial<Record<Block, unknown>>, message: RegExp) => expect(() => compileOperatingPassive(pages(over))).toThrow(message)
  refuses({ cmt: replaced(cmt, ['outlet', 'pipeLoss_Pa'], 213.585) }, /outlet losses sum to .* not 20000 Pa/)
  refuses({ cmt: replaced(cmt, ['outlet', 'isolationArea_m2'], 0.04) }, /effective area 0.04 m2 is not below/)
  refuses({ cmt: replaced(cmt, ['outlet', 'meterArea_m2'], 0.04) }, /effective area 0.04 m2 is not below/)
  refuses({ cmt: replaced(cmt, ['balance', 'isolationArea_m2'], 0.04) }, /effective area 0.04 m2 is not below/)
  refuses({ cmt: replaced(cmt, ['outlet', 'length_m'], 9) }, /outlet block disagrees with reference-cmt-delivery/)
  refuses({ cmt: replaced(cmt, ['outlet', 'closing_s'], 4) }, /outlet block disagrees with reference-cmt-delivery/)
  refuses({ cmt: replaced(cmt, ['balance', 'mainLength_m'], 21.24) }, /BAL route holds/)
  refuses({ dvi: { ...dvi, volume_m3: 0.6 } }, /DVI block disagrees with reference-cmt-delivery/)
  refuses({ dvi: { ...dvi, area_m2: 0.4 } }, /DVI envelope/)
  refuses({ dvi: { ...dvi, neckVolume_m3: 0.0314 } }, /DVI neck holds/)
  refuses({ acc: { ...acc, gas_m3: 14 } }, /ACC volumes do not close/)
  refuses({ acc: { ...acc, roof_m: 9 } }, /ACC volumes do not close/)
  refuses({ acc: { ...acc, interface_m: 6.4 } }, /ACC interface does not hold its water/)
  refuses({ acc: { ...acc, meterLoss_kPa: 1000 } }, /ACC meter loss exceeds/)
  refuses({ acc: { ...acc, variableArea_m2: 0.04 } }, /ACC effective area/)
  refuses({ acc: replaced(acc, ['vent', 'area_m2'], 0.001) }, /ACC vent CdA/)
  refuses({ ads: edit(ads, ['stages'], (o, k) => { o[k] = [ads.stages[1], ads.stages[0], ads.stages[2], ads.stages[3]] }) }, /ADS stages must be 1..4 in order/)
  refuses({ ads: replaced(ads, ['stages', 2, 'receiver'], 'CNV') }, /ADS receivers misassigned/)
  refuses({ ads: replaced(ads, ['stages', 0, 'area_m2'], 0.006) }, /ADS stage 1 CdA/)
  refuses({ ads: replaced(ads, ['stage4', 'pulse_s'], 1) }, /one-shot mechanisms differ/)
  refuses({ gravity: replaced(gravity, ['oneShot', 'springStock_J'], 400) }, /one-shot mechanisms differ/)
  refuses({ sequence: replaced(sequence, ['lt', 'upperTap_m'], 11.9) }, /LT upper tap is not the geometry tap/)
  refuses({ sequence: replaced(sequence, ['lt', 'fullCold_m'], 5.9) }, /Full cold water does not read the upper tap/)
  refuses({ sequence: { ...sequence, cmtLowLowLevel_m: 2 } }, /not ordered inside the LT span/)
  refuses({ sequence: { ...sequence, cmtLowLowLevel_m: 2.5 } }, /not ordered inside the LT span/)
  refuses({ sequence: replaced(sequence, ['lt', 'span_m'], [0, 5.9]) }, /not ordered inside the LT span/)
  refuses({ prhr: { ...prhr, tubeDischargeLoss: 1.1 } }, /tube entrance\/discharge split/)
  refuses({ prhr: { ...prhr, preparedBank_C: 100 } }, /prepared bank temperature is not one of the selected preparations/)
})

describe('refuses a missing ld01-c11 block', () => {
  for (const block of Object.keys(blocks) as Block[])
    test(fences[block], () => {
      expect(() => compileOperatingPassive(pages({}, [block]))).toThrow(new RegExp(`Expected one ${fences[block]} block`))
    })
})

describe('refuses a missing reference block through its own compiler', () => {
  const refusals: Record<Reference, RegExp> = { geometry: /Expected one reference-cmt-geometry block/, balancePath: /Expected one reference-cmt-balance-path block/,
    submerged: /Expected one reference-cmt-submerged block/, delivery: /Expected one reference-cmt-delivery block/,
    intakes: /Expected one current gravity-intake record/, prhrGeometry: /Exactly one PRHR geometry basis required/,
    prhrIsolation: /Exactly one PRHR isolation basis required/, prhrMixing: /Exactly one PRHR scalar-mixing basis required/,
    prhrContact: /Exactly one PRHR contact basis required/ }
  for (const reference of Object.keys(references) as Reference[])
    test(fences[reference], () => {
      expect(() => compileOperatingPassive(pages({}, [reference]))).toThrow(refusals[reference])
    })
})

test('refuses a duplicated heading, a block outside its heading and a block written twice', () => {
  const t = texts()
  expect(() => compileOperatingPassive(assemble({ ...t, injection: t.injection + '\n' + heading + '\n\nAgain.\n' }))).toThrow(/Expected exactly one heading/)
  const moved = texts({}, ['cmt'])
  expect(() => compileOperatingPassive(assemble({ ...moved,
    injection: moved.injection.replace('## Common datums and installed supply paths\n\nProse.\n\n',
      '## Common datums and installed supply paths\n\nProse.\n\n' + fence(fences.cmt, cmt)) }))).toThrow(/Expected one ld01-c11-cmt block/)
  expect(() => compileOperatingPassive(assemble({ ...t, injection: t.injection + '\n## Later\n\n' + fence(fences.dvi, dvi) })))
    .toThrow(/Expected one ld01-c11-dvi block/)
  expect(() => compileOperatingPassive(assemble({ ...t, geometry: t.geometry + '\n' + fence(fences.geometry, geometry) })))
    .toThrow(/Expected one reference-cmt-geometry block/)
})
