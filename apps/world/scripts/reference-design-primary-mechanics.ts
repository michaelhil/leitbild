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
  downcomerBottom_m: z.number().finite(), downcomerTop_m: z.number().finite(),
}).strict().refine(v => v.downcomerTop_m > v.downcomerBottom_m, 'Invalid downcomer extent')

export function parsePrimaryMechanics(document: string) {
  const blocks = [...document.matchAll(/^```reference-primary-mechanics\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw Error('Expected one reference-primary-mechanics block')
  return schema.parse(JSON.parse(blocks[0]![1]!))
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
    'systems/primary-coolant/surge-route.md']
  const docs = await Promise.all(files.map(p => Bun.file(join(wiki, p)).text()))
  const selection = parsePrimaryMechanics(docs[0]!)
  const input = await resolveInitializationInput(docs[1]!, docs[2]!, docs[3]!, python, parseConnectedFuel(docs[1]!, docs[4]!))
  const route = resolveSurgeRoute(parseSurgeRoute(docs[5]!))
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const identity = { sourceSha256: hash(await Bun.file(import.meta.path).text()),
    calculationSha256: hash(nominalCalculation), inputSha256: hash(JSON.stringify({ selection, input, route })) }
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
  const partitionVolume = [...channels, ...mixed].reduce((a, b) => a + b.volume_m3, 0)
  if (Math.abs(originalVolume - partitionVolume) > 1e-10) throw Error('Whole-primary water volume duplicated or lost')
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
    selection, sgFold: sg, coldHeaderEnvelope: { bottom_m: hb.coldPort_m - selection.coldHeaderHeight_m / 2,
      top_m: hb.coldPort_m + selection.coldHeaderHeight_m / 2,
      area_m2: selection.coldHeaderVolume_m3 / selection.coldHeaderHeight_m },
    originalVolume_m3: originalVolume, partitionVolume_m3: partitionVolume,
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
