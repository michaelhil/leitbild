import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, any, comparison, rule } from './reference-ic-helpers.ts'

const feedwaterAlarm = annunciator({
  system: 'feedwater',
  equipmentId: 'mainFeedwaterHeader',
  group: 'feedwater',
  priority: 'high',
  role: 'symptom',
})

const turbineAlarm = annunciator({
  system: 'balance of plant',
  equipmentId: 'turbine',
  group: 'turbine-generator',
  priority: 'medium',
  role: 'status',
})

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
      annunciator: feedwaterAlarm,
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
      annunciator: turbineAlarm,
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
      annunciator: turbineAlarm,
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
      annunciator: annunciator({ ...turbineAlarm, equipmentId: 'condenser', priority: 'high', role: 'symptom' }),
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
      annunciator: annunciator({ system: 'main steam', equipmentId: 'mainSteamSafetyValve', group: 'main-steam', priority: 'high', role: 'status' }),
    })],
  }),
]
