import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, any, comparison, rule } from './reference-ic-helpers.ts'

export const balanceOfPlantReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'main-feedwater-pump-trip',
    label: 'Main feedwater pump unavailable',
    ruleClass: 'alarm',
    condition: any([
      comparison({ tagId: 'MFW-PUMP-A-RUN' }, '==', false),
      comparison({ tagId: 'MFW-PUMP-B-RUN' }, '==', false),
    ]),
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'main-feedwater-pump-unavailable',
      title: 'Main feedwater pump unavailable',
      message: 'At least one main feedwater pump is not running.',
      severity: 'warning',
    })],
  }),
  rule({
    id: 'turbine-load-low',
    label: 'Turbine load low',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'TURB-LOAD' }, '<', 0.5),
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'load-low',
      title: 'Turbine load low',
      message: 'Turbine load demand is below the reference low-load threshold.',
      severity: 'notice',
    })],
  }),
  rule({
    id: 'generator-output-low',
    label: 'Generator output low',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'GEN-MW' }, '<', 450),
    delayMs: 5_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'generator-output-low',
      title: 'Generator output low',
      message: 'Generator electrical output is below the reference low-output threshold.',
      severity: 'notice',
    })],
  }),
  rule({
    id: 'condenser-backpressure-high',
    label: 'Condenser backpressure high',
    ruleClass: 'alarm',
    condition: comparison({ path: 'condenser.backPressurePa' }, '>', 35_000),
    delayMs: 2_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'backpressure-high',
      title: 'Condenser backpressure high',
      message: 'Condenser backpressure is above the reference operating threshold.',
      severity: 'warning',
    })],
  }),
  rule({
    id: 'main-steam-safety-valve-open',
    label: 'Main steam safety valve open',
    ruleClass: 'alarm',
    condition: comparison({ path: 'mainSteamSafetyValve.effectivePositionFraction' }, '>', 0.1),
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'safety-valve-open',
      title: 'Main steam safety valve open',
      message: 'Main steam safety valve effective position is above the reference open threshold.',
      severity: 'warning',
    })],
  }),
]
