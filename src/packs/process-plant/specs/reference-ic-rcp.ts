import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, comparison, rule } from './reference-ic-helpers.ts'

export const reactorCoolantPumpReferenceIcRules = (loop: 'A' | 'B' | 'C' | 'D'): ReadonlyArray<ProcessPlantIcRule> => {
  const lower = loop.toLowerCase()
  return [
    rule({
      id: `rcp-${lower}-trip`,
      label: `RCP ${loop} not running`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `RCP-${loop}-RUN` }, '==', false),
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'not-running',
        title: `RCP ${loop} not running`,
        message: `Reactor coolant pump ${loop} is not running.`,
        severity: 'warning',
      })],
    }),
    rule({
      id: `rcp-${lower}-loop-flow-low`,
      label: `RCP ${loop} loop flow low`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `RCP-${loop}-FLOW` }, '<', 2_500),
      delayMs: 2_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'loop-flow-low',
        title: `RCP ${loop} loop flow low`,
        message: `Reactor coolant pump ${loop} loop flow is below the reference low-flow threshold.`,
        severity: 'warning',
      })],
    }),
  ]
}
