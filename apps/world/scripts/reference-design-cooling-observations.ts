/** Offline accepted-interval flow/acquisition replay; no installed instruments or EOP execution. */
import { createHash } from 'node:crypto'
import { coolingDefinitions, parseCoolingRigBasis } from './reference-design-cooling-rig'
import { flowEvidence, parseObservationFixtureBasis } from './reference-design-observations'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
type Pair = [number, number]
export type Interval = [number, number, Pair, Pair, number[][], number, number, number, number]
type Physical = { name: string; step_s: number; end_s: number; gravity_onset_s: number | null;
  WST_delivered_kg: number[]; sump_delivered_kg: number[]; pool_gravity_transfer_MJ: number }
export type Capture = { result: Physical; intervals: Interval[] }
export type Meter = { name: string; referenceFlow_kg_s: number; meterDrop_Pa: number; span_Pa: number }
export type ReplayBasis = { flowLag_s: number; sample_s: number; rawDPZeroBound_Pa: number; rawDPQuantum_Pa: number }
export type Fault = 'none' | 'I1_outage' | 'A_transport_hold' | 'A_fresh_stuck_zero'
export const fixture = Object.freeze({ faultStart_s: 1100, faultEnd_s: 1250, freshness_s: 2,
  positivePersistence_s: 2, meterLossFraction: .1, biasSign: 1 })

export const captureCalculation = coolingDefinitions + String.raw`
props,gn=tables(300)
def capture(label,dt,**kwargs):
    rows=[]
    result=solve_case(label,dt,props,gn,observer=rows.append,**kwargs)
    return dict(result=result,intervals=rows)
cases=[capture('healthy',b['step_s']),capture('healthy half-step',b['step_s']/2),
    capture('ACT A unavailable before release',b['step_s'],failed_act=True),
    capture('prefilled sump only',b['step_s'],wst_fraction=0.,sump_volume=1180.),
    capture('prefilled sump with 0.5 MW heater',b['step_s'],wst_fraction=0.,sump_volume=1180.,heater=.5)]
print(json.dumps(dict(python=platform.python_version(),iapws=iapws.__version__,numpy=np.__version__,
    scipy=scipy.__version__,elapsed_s=time.monotonic()-started,rho_kg_m3=rho,hcold_J_kg=hc,cases=cases),allow_nan=False))
`

/** Bounds remain conditional on liquid calibration. Saturation is not a finite upper bound. */
export function reportedFlow(dp: number, meter: Meter, error: number) {
  if (!Number.isFinite(dp) || !Number.isFinite(meter.span_Pa) || meter.span_Pa <= 0) throw new Error('Invalid DP/span')
  const value = Math.max(-meter.span_Pa, Math.min(meter.span_Pa, dp))
  const range = dp > meter.span_Pa ? 'ABOVE_RANGE' : dp < -meter.span_Pa ? 'BELOW_RANGE' : 'IN_RANGE'
  const f = flowEvidence(value, meter.referenceFlow_kg_s, meter.meterDrop_Pa, error)
  return { ...f, range, lowerLiquidCalibration_kg_s: range === 'BELOW_RANGE' ? null : f.lowerLiquidCalibration_kg_s,
    upperLiquidCalibration_kg_s: range === 'ABOVE_RANGE' ? null : f.upperLiquidCalibration_kg_s }
}

function flows(row: Interval): number[] {
  return [row[2][0], row[2][1], row[3][0], row[3][1], row[2][0] + row[3][0], row[2][1] + row[3][1]]
}

/** Exact overlap integral of the rig's held mass flux and falling pool h+gz transfer. */
export function transfer(row: Interval, from: number, to: number, rho: number, hc: number,
  pools: { WSTFloor_m: number; WSTArea_m2: number; sumpFloor_m: number; sumpArea_m2: number }) {
  const a = from - row[0], b = to - row[0]
  if (a < -1e-8 || b > row[1] + 1e-8 || b < a) throw new Error('Transfer outside accepted interval')
  const mass = flows(row).map(q => q * (b - a)), energy: number[] = []
  for (let pool = 0; pool < 2; pool++) {
    const q = row[pool === 0 ? 2 : 3], total = q[0] + q[1]
    const area = pool === 0 ? pools.WSTArea_m2 : pools.sumpArea_m2
    const floor = pool === 0 ? pools.WSTFloor_m : pools.sumpFloor_m
    const z0 = floor + row[pool === 0 ? 7 : 8] / (rho * area)
    const specificIntegral = hc * (b - a) + 9.80665 * (z0 * (b - a) - total / (rho * area) * (b * b - a * a) / 2)
    energy.push(q[0] * specificIntegral, q[1] * specificIntegral)
  }
  energy.push(energy[0]! + energy[2]!, energy[1]! + energy[3]!)
  return { mass, energy }
}

export function replay(capture: Capture, meters: Meter[], basis: ReplayBasis, fault: Fault,
  rho: number, hc: number, pools: Parameters<typeof transfer>[5]) {
  if (meters.length !== 3 || basis.sample_s !== .1 || basis.flowLag_s !== .25) throw new Error('Selected replay clock/lag differs from owner')
  if (!capture.intervals.length) throw new Error('Missing accepted intervals')
  let clock = 0
  for (const row of capture.intervals) {
    if (Math.abs(row[0] - clock) > 1e-7 || row[1] <= 0 || ![row[0], row[1], ...flows(row), row[7], row[8]].every(Number.isFinite)) throw new Error('Invalid accepted interval')
    clock += row[1]
  }
  if (Math.abs(clock - capture.result.end_s) > 1e-7) throw new Error('Capture endpoint mismatch')
  const channels = meters.flatMap(m => ['A', 'B'].map(train => `LD01.${m.name}.${train}.FT.DP`))
  const lag = Array<number>(6).fill(0), acquired = Array<number | null>(6).fill(null)
  const known = Array<ReturnType<typeof reportedFlow> | null>(6).fill(null)
  const since = Array<number | null>(6).fill(null), qualified = Array<boolean>(6).fill(false)
  const firstCandidate = Array<number | null>(6).fill(null), firstQualified = Array<number | null>(6).fill(null)
  const firstActual = Array<[number, number] | null>(6).fill(null)
  const deliveredMass = Array<number>(6).fill(0), deliveredEnergy = Array<number>(6).fill(0)
  const allMass = Array<number>(6).fill(0), allEnergy = Array<number>(6).fill(0)
  const coverage = channels.map(() => ({ usable: 0, outsideStaticInterval: 0, maxOutside_kg_s: 0 }))
  const qualityCounts = channels.map(() => ({ AVAILABLE: 0, STALE: 0, UNAVAILABLE: 0 }))
  const events: unknown[] = [], selectedSamples: unknown[] = [], priorKey = Array<string>(6).fill('')
  const active = (t: number) => t >= fixture.faultStart_s - 1e-8 && t < fixture.faultEnd_s - 1e-8
  const powered = (i: number, t: number) => !(i % 2 === 0 && fault === 'I1_outage' && active(t))
  let intervalIndex = 0, cursor = 0
  const integrateTo = (end: number) => {
    while (cursor < end - 1e-8) {
      const row = capture.intervals[intervalIndex]!
      const stop = Math.min(end, row[0] + row[1])
      const dt = stop - cursor, q = flows(row)
      const moved = transfer(row, cursor, stop, rho, hc, pools)
      for (let i = 0; i < 6; i++) {
        allMass[i]! += moved.mass[i]!
        allEnergy[i]! += moved.energy[i]!
        if (qualified[i]) { deliveredMass[i]! += moved.mass[i]!; deliveredEnergy[i]! += moved.energy[i]! }
        if (firstActual[i] === null && q[i]! > .01) firstActual[i] = [Math.max(0, row[0] - capture.result.step_s), row[0]]
        if (powered(i, cursor)) {
          const m = meters[Math.floor(i / 2)]!
          const raw = i % 2 === 0 && fault === 'A_fresh_stuck_zero' && active(cursor) ? 0 : m.meterDrop_Pa * q[i]! * Math.abs(q[i]!) / m.referenceFlow_kg_s ** 2
          lag[i] = raw + (lag[i]! - raw) * Math.exp(-dt / basis.flowLag_s)
        }
      }
      cursor = stop
      if (stop >= row[0] + row[1] - 1e-8 && intervalIndex + 1 < capture.intervals.length) intervalIndex++
    }
  }
  for (let sample = 0; sample * basis.sample_s <= clock + 1e-8; sample++) {
    const t: number = sample * basis.sample_s
    integrateTo(t)
    const truth = flows(capture.intervals[intervalIndex]!)
    const rows = []
    for (let i = 0; i < 6; i++) {
      const power: boolean = powered(i, t), priorPower: boolean = sample > 0 && powered(i, t - basis.sample_s)
      const hold = i % 2 === 0 && fault === 'A_transport_hold' && active(t)
      if (sample > 0 && power && priorPower && !hold) {
        acquired[i] = t
        const quantized = Math.round((lag[i]! + fixture.biasSign * basis.rawDPZeroBound_Pa) / basis.rawDPQuantum_Pa) * basis.rawDPQuantum_Pa
        known[i] = reportedFlow(quantized, meters[Math.floor(i / 2)]!, basis.rawDPZeroBound_Pa + basis.rawDPQuantum_Pa / 2)
      }
      const age = acquired[i] === null ? null : t - acquired[i]!
      const quality = !power || !priorPower || acquired[i] === null ? 'UNAVAILABLE' : age! > fixture.freshness_s + 1e-8 ? 'STALE' : 'AVAILABLE'
      qualityCounts[i]![quality]++
      const current = quality === 'AVAILABLE' ? known[i] : null
      const positive = current?.condition === 'positive_established'
      since[i] = positive ? since[i] ?? t : null
      qualified[i] = since[i] !== null && t - since[i]! >= fixture.positivePersistence_s - 1e-8
      if (positive && firstCandidate[i] === null) firstCandidate[i] = t
      if (qualified[i] && firstQualified[i] === null) firstQualified[i] = t
      if (current) {
        const c = coverage[i]!, lower = current.lowerLiquidCalibration_kg_s, upper = current.upperLiquidCalibration_kg_s
        const outside = Math.max(0, lower === null ? 0 : lower - truth[i]!, upper === null ? 0 : truth[i]! - upper)
        c.usable++; if (outside > 1e-10) c.outsideStaticInterval++; c.maxOutside_kg_s = Math.max(c.maxOutside_kg_s, outside)
      }
      const state = { channel: channels[i], quality, reason: !power ? 'I_SUPPLY_OFF' : !priorPower ? 'REACQUIRING' : quality === 'STALE' ? 'AGE_EXCEEDED' : null,
        current, lastAcquiredAt_s: acquired[i], lastKnown: known[i], positiveQualified: qualified[i], heldActual_kg_s: truth[i] }
      const key = JSON.stringify([quality, current?.range, current?.condition, qualified[i]])
      if (key !== priorKey[i]) { events.push({ t_s: t, ...state }); priorKey[i] = key }
      rows.push(state)
    }
    // All acquisitions are evaluated; retain events, 10 s context, and onset/fault detail.
    const onset = capture.result.gravity_onset_s
    if (sample % 100 === 0 || (onset !== null && Math.abs(t - onset) <= 5)
      || [fixture.faultStart_s, fixture.faultEnd_s].some(f => Math.abs(t - f) <= .21)) selectedSamples.push({ t_s: t, channels: rows })
  }
  integrateTo(clock) // No extrapolated observation after the physical endpoint.
  const expected = [...capture.result.WST_delivered_kg, ...capture.result.sump_delivered_kg]
  const massError = Math.max(...expected.map((m, i) => Math.abs(m - allMass[i]!)))
  const expectedEnergy = expected.reduce((s, m) => s + m, 0) * hc + capture.result.pool_gravity_transfer_MJ * 1e6
  const energyError = Math.abs(allEnergy.slice(0, 4).reduce((s, e) => s + e, 0) - expectedEnergy)
  if (massError > 1e-5 || energyError > 1) throw new Error(`Capture transfer ledger failed: ${massError} kg / ${energyError} J`)
  return { case: capture.result.name, fault, channels, firstActualBracket_s: firstActual, firstPositiveCandidate_s: firstCandidate,
    firstPositiveQualified_s: firstQualified, qualityCounts, staticIntervalCoverageDiagnostic: coverage,
    actualMassDuringPriorQualifiedSignal_kg: deliveredMass, actualIncomingHplusPE_J: deliveredEnergy,
    fullCaptureMassResidual_kg: massError, fullCaptureEnergyResidual_J: energyError, events, selectedSamples }
}

export async function runCoolingObservations(rigDocument: string, observationDocument: string, python: string,
  baseline: { cases: Physical[]; basisSha256: string; calculationSha256: string }) {
  const rig = parseCoolingRigBasis(rigDocument), obs = parseObservationFixtureBasis(observationDocument)
  const meters = ['GIV', 'RECIRC', 'DVI'].map((name, i) => {
    const m = obs.meters.find(m => m.name === name)!
    const parent = [rig.sourceLoss_Pa, rig.recircLoss_Pa, rig.DVILoss_Pa][i]!
    const ref = i === 2 ? rig.DVIReferenceFlow_kg_s : rig.sourceReferenceFlow_kg_s
    if (m.totalReferenceDrop_Pa !== parent || m.referenceFlow_kg_s !== ref || m.meterDrop_Pa !== parent * fixture.meterLossFraction) throw new Error('Meter/rig loss ownership mismatch')
    return { ...m, span_Pa: [20000, 8000, 9000][i]! }
  })
  const input = JSON.stringify(rig)
  if (baseline.basisSha256 !== hash(input) || baseline.calculationSha256 !== 'b7ba6c5a202352042515f571d6534ae3f2142d0bf31ecc30d27b85f6c19b4b6f') throw new Error('Retained baseline identity differs')
  const child = Bun.spawn([python, '-c', captureCalculation], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Accepted-interval capture failed (${code}): ${stderr}`)
  const captured = JSON.parse(stdout) as { cases: Capture[]; rho_kg_m3: number; hcold_J_kg: number }
  for (const c of captured.cases.filter(c => c.result.name !== 'healthy half-step')) {
    if (JSON.stringify(c.result) !== JSON.stringify(baseline.cases.find(b => b.name === c.result.name))) throw new Error(`Observer changed physical result: ${c.result.name}`)
  }
  const replays = captured.cases.map(c => replay(c, meters, obs, 'none', captured.rho_kg_m3, captured.hcold_J_kg, rig))
  for (const fault of ['I1_outage', 'A_transport_hold', 'A_fresh_stuck_zero'] as const) replays.push(replay(captured.cases[0]!, meters, obs, fault, captured.rho_kg_m3, captured.hcold_J_kg, rig))
  const coarse = replays[0]!, fine = replays[1]!
  const timing = coarse.channels.map((channel, i) => ({ channel, coarseActualBracket_s: coarse.firstActualBracket_s[i], fineActualBracket_s: fine.firstActualBracket_s[i],
    candidateDifference_s: coarse.firstPositiveCandidate_s[i] === null || fine.firstPositiveCandidate_s[i] === null ? null : Math.abs(coarse.firstPositiveCandidate_s[i]! - fine.firstPositiveCandidate_s[i]!),
    qualifiedDifference_s: coarse.firstPositiveQualified_s[i] === null || fine.firstPositiveQualified_s[i] === null ? null : Math.abs(coarse.firstPositiveQualified_s[i]! - fine.firstPositiveQualified_s[i]!) }))
  return { evidenceClass: 'Offline reconstructed flow-channel evidence; apparatus truth separate; no EOP or plant succession qualification',
    sourceSha256: hash(await Bun.file(import.meta.path).text()), calculationSha256: hash(captureCalculation), rigBasisSha256: hash(input),
    importedSourceSha256: { coolingRig: hash(await Bun.file(new URL('./reference-design-cooling-rig.ts', import.meta.url)).text()),
      observations: hash(await Bun.file(new URL('./reference-design-observations.ts', import.meta.url)).text()) },
    retainedBaselineCalculationSha256: baseline.calculationSha256,
    observationBasisSha256: hash(JSON.stringify(obs)), fixture, meters, originalCasesExactlyReproduced: 4,
    captured, replays, healthyPhysicalStepTimingComparison: timing }
}

if (import.meta.main) {
  const [rig, observations, python, baseline] = Bun.argv.slice(2)
  if (!rig || !observations || !python || !baseline) throw new Error('Usage: bun reference-design-cooling-observations.ts <rig.md> <phase-dependent-measurements.md> <python> <original-baseline.json>')
  console.log(JSON.stringify(await runCoolingObservations(await Bun.file(rig).text(), await Bun.file(observations).text(), python, await Bun.file(baseline).json()), null, 2))
}
