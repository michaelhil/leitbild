/** Offline equivalent impulse-torque selection; not a running turbine or generator. */
import { createHash } from 'node:crypto'
import { runCycle } from './reference-design-cycle'

export function turbineIntervalTorque(massFlow: number, isentropicDrop: number, speed: number, radius: number, efficiency: number) {
  if (![massFlow, isentropicDrop, speed, radius, efficiency].every(Number.isFinite)
    || massFlow < 0 || isentropicDrop < 0 || radius <= 0 || efficiency <= 0 || efficiency > 1)
    throw new Error('Invalid forward equivalent turbine interval')
  const jetSpeed = Math.sqrt(2 * isentropicDrop)
  const torque = 2 * efficiency * massFlow * radius * (jetSpeed - radius * speed)
  return { torque, work: torque * speed, jetSpeed }
}

/** The existing loss fraction consumes actual aerodynamic torque, not finite power/zero speed. */
export function turbineShaftLoads(torque: number, speed: number, referenceSpeed: number, loadLossFraction: number) {
  if (![torque, speed, referenceSpeed, loadLossFraction].every(Number.isFinite)
    || referenceSpeed <= 0 || loadLossFraction < 0 || loadLossFraction >= 1)
    throw new Error('Invalid shaft loss selection')
  const loadLossTorque = torque * speed >= 0 ? loadLossFraction * torque : 0
  const dragTorque = 500000 * speed / (referenceSpeed * referenceSpeed)
  return { loadLossTorque, dragTorque, oilHeat: loadLossTorque * speed + dragTorque * speed,
    netTorque: torque - loadLossTorque - dragTorque }
}

if (import.meta.main) {
  const [owner, python, target, ...extra] = Bun.argv.slice(2)
  if (!owner || !python || !target || extra.length) throw new Error('Usage: turbine-torque <cycle-basis.md> <research-python> <receipt.json>')
  const cycle = await runCycle(await Bun.file(owner).text(), python)
  const omega0 = 1500 * 2 * Math.PI / 60
  const eta = [cycle.basis.HPTurbineEfficiency, cycle.basis.HPTurbineEfficiency,
    cycle.basis.LPTurbineEfficiency, cycle.basis.LPTurbineEfficiency, cycle.basis.LPTurbineEfficiency]
  const pairs = [['main_steam', 'HP_bleed'], ['HP_bleed', 'HP_separator_inlet'],
    ['LP_reheat_inlet', 'LP_bleed'], ['LP_bleed', 'LP_lowest_bleed'], ['LP_lowest_bleed', 'LP_exhaust']]
  const intervals = pairs.map(([inlet, outlet], i) => {
    const actualDrop = 1000 * (cycle.points[inlet!].h_kJ_kg - cycle.points[outlet!].h_kJ_kg)
    const isentropicDrop = actualDrop / eta[i]!
    return { inlet, outlet, efficiency: eta[i]!, referenceDrop_J_kg: isentropicDrop,
      radius_m: Math.sqrt(2 * isentropicDrop) / (2 * omega0) }
  })
  const loss = .005 - .5 / 1030.662217
  const samples = intervals.flatMap(s => [.8, 1, 1.2].flatMap(radiusRatio => [0, .25, 1, 4].flatMap(dropRatio =>
    [-.1, 0, .1, .5, 1, 1.1, 1.15, 2, 3].map(speedRatio => {
      const radius = s.radius_m * radiusRatio, drop = s.referenceDrop_J_kg * dropRatio, speed = omega0 * speedRatio
      const aero = turbineIntervalTorque(1, drop, speed, radius, s.efficiency)
      const shaft = turbineShaftLoads(aero.torque, speed, omega0, loss)
      const bound = s.efficiency * drop
      const ledgerDefect = aero.work - shaft.netTorque * speed - shaft.oilHeat
      if (aero.work > bound + 1e-7 || shaft.oilHeat < 0 || Math.abs(ledgerDefect) > 1e-7)
        throw new Error('Equivalent interval work bound or shaft/oil ledger failed')
      return { inlet: s.inlet, radiusRatio, dropRatio, speedRatio, ...aero, ...shaft, ledgerDefect }
    }))))
  const result = { scope: 'Forward equivalent impulse law and shaft/oil limiting sweep, not connected rolling, blading calibration, wet damage or synchronization',
    cycleInputSha256: cycle.inputSha256, cycleCalculationSha256: cycle.calculationSha256,
    sourceSha256: createHash('sha256').update(await Bun.file(import.meta.path).text()).digest('hex'),
    referenceSpeed_rad_s: omega0, intervals, samples, accepted: true }
  await Bun.write(target, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ target, intervals, checks: samples.length, accepted: true }))
}
