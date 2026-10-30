import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { all, any, comparison, rule, write } from './reference-ic-helpers.ts'

/** Authored envelope of this reduced PWR's low-pressure shutdown-cooling
 * installation. Double suction barriers and pressure/temperature admission
 * follow the engineering arrangement described in NRC Issue 99 and the
 * Westinghouse RHR description (OSTI 7069527, section 2). These are model
 * design settings, not an imported procedure/technical-specification claim.
 * The reduced design holds both barriers shut outside the opening envelope;
 * it does not reproduce the reference's separate higher auto-close setpoint,
 * relief qualification, sensor channels, NPSH or reverse-pressure hazards. */
export const rhrShutdownCoolingAdmission = Object.freeze({
  maximumPressureMPa: 0.101325 + 425 * 0.006894757293168,
  maximumHotLegTemperatureC: (350 - 32) * 5 / 9,
})

export const shutdownCoolingReferenceIcRules = (): readonly ProcessPlantIcRule[] => {
  const safe = all([
    comparison({ tagId: 'PT-455' }, '<=', rhrShutdownCoolingAdmission.maximumPressureMPa),
    comparison({ path: 'core.coolantOutletTemperatureC' }, '<=', rhrShutdownCoolingAdmission.maximumHotLegTemperatureC),
  ])
  const unsafe = any([
    comparison({ tagId: 'PT-455' }, '>', rhrShutdownCoolingAdmission.maximumPressureMPa),
    comparison({ path: 'core.coolantOutletTemperatureC' }, '>', rhrShutdownCoolingAdmission.maximumHotLegTemperatureC),
  ])
  const barriers = ['A', 'B'].flatMap(train => [1, 2].map(barrier => `rhrShutdownSuctionValve${train}${barrier}`))
  return [
    rule({ id: 'rhr-shutdown-suction-envelope-hold', label: 'RHR shutdown suction pressure/temperature hold', ruleClass: 'normalControl',
      condition: unsafe, latch: false, resetWhenClear: true,
      effects: barriers.map(id => write(`hold-${id}`, { path: `${id}.isolationSignal` }, true)) }),
    rule({ id: 'rhr-shutdown-suction-envelope-release', label: 'RHR shutdown suction pressure/temperature release', ruleClass: 'normalControl',
      condition: safe, latch: false, resetWhenClear: true,
      effects: barriers.map(id => write(`release-${id}`, { path: `${id}.isolationSignal` }, false)) }),
  ]
}
