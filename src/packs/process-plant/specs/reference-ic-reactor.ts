import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, comparison, rule, trip, write } from './reference-ic-helpers.ts'

const reactorAlarm = annunciator({
  system: 'reactor protection',
  equipmentId: 'core',
  group: 'reactor-protection',
  priority: 'urgent',
  role: 'symptom',
})

const reactorAction = annunciator({
  system: 'reactor protection',
  equipmentId: 'core',
  group: 'reactor-protection',
  firstOutGroup: 'reactor-trip',
  priority: 'urgent',
  role: 'automaticAction',
})

export const reactorReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'reactor-power-high',
    label: 'Reactor power high',
    ruleClass: 'alarm',
    condition: comparison({ path: 'core.powerMw' }, '>', 3_600),
    delayMs: 1_000,
    effects: [alarm({
      id: 'power-high',
      title: 'Reactor power high',
      message: 'Core fission power is above the reference high-power threshold.',
      severity: 'critical',
      annunciator: reactorAlarm,
    })],
  }),
  rule({
    id: 'reactor-high-power-trip',
    label: 'Reactor high-power trip',
    ruleClass: 'protection',
    condition: comparison({ path: 'core.powerMw' }, '>', 3_750),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'high-power-trip',
        title: 'Reactor high-power trip',
        message: 'Core fission power is above the reference trip threshold.',
        annunciator: reactorAction,
      }),
      write('insert-control-rods', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'reactor-low-primary-flow-trip',
    label: 'Reactor low primary flow trip',
    ruleClass: 'protection',
    modeLabel: 'power operation',
    modeCondition: comparison({ path: 'core.powerMw' }, '>', 100),
    condition: comparison({ path: 'vessel.netInventoryFlowKgPerS' }, '<', -250),
    delayMs: 2_000,
    effects: [
      trip({
        id: 'low-flow-trip',
        title: 'Reactor low-flow trip',
        message: 'Primary inventory loss exceeds the reference low-flow trip threshold.',
        annunciator: reactorAction,
      }),
      write('insert-control-rods-low-flow', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
]
