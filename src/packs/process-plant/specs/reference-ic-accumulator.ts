import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, comparison, rule } from './reference-ic-helpers.ts'

export const accumulatorReferenceIcRules = (loop: 'A' | 'B' | 'C' | 'D'): ReadonlyArray<ProcessPlantIcRule> => {
  const lower = loop.toLowerCase()
  const id = `safetyAccumulator${loop}`
  const accumulatorAlarm = annunciator({
    system: 'safety injection',
    equipmentId: id,
    group: `accumulator-${lower}`,
    priority: 'high',
    role: 'status',
  })
  return [
    rule({
      id: `accumulator-${lower}-injecting`,
      label: `Accumulator ${loop} injecting`,
      ruleClass: 'alarm',
      condition: comparison({ path: `${id}.outletFlowKgPerS` }, '>', 1),
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'injecting',
        title: `Accumulator ${loop} injecting`,
        message: `Safety injection accumulator ${loop} is injecting into the primary system.`,
        severity: 'notice',
        annunciator: accumulatorAlarm,
      })],
    }),
    rule({
      id: `accumulator-${lower}-depleted`,
      label: `Accumulator ${loop} depleted`,
      ruleClass: 'alarm',
      condition: comparison({ path: `${id}.depletedFraction` }, '>', 0.9),
      delayMs: 1_000,
      effects: [alarm({
        id: 'depleted',
        title: `Accumulator ${loop} depleted`,
        message: `Safety injection accumulator ${loop} is above the reference depletion threshold.`,
        severity: 'warning',
        annunciator: accumulatorAlarm,
      })],
    }),
  ]
}
