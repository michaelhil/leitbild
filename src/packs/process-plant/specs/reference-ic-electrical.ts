import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, any, comparison, rule, write } from './reference-ic-helpers.ts'

const electricalAlarm = annunciator({
  system: 'electrical',
  group: 'electrical-power',
  priority: 'high',
  role: 'automaticAction',
})

export const electricalReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'safety-bus-a-loss-alarm',
    label: 'Safety bus A loss of power',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'BUS-A-ENERGIZED' }, '==', false),
    clearCondition: comparison({ tagId: 'BUS-A-ENERGIZED' }, '==', true),
    clearDelayMs: 2_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [
      alarm({
        id: 'safety-bus-a-loss',
        title: 'Safety bus A de-energized',
        message: 'Safety bus A is de-energized; emergency diesel generator A start is demanded.',
        severity: 'critical',
        annunciator: annunciator({ ...electricalAlarm, equipmentId: 'safetyBusA', firstOutGroup: 'electrical-power-loss' }),
      }),
    ],
  }),
  rule({
    id: 'safety-bus-a-loss-diesel-start',
    label: 'Safety bus A loss of power diesel start',
    ruleClass: 'normalControl',
    condition: comparison({ tagId: 'BUS-A-ENERGIZED' }, '==', false),
    clearCondition: comparison({ tagId: 'BUS-A-ENERGIZED' }, '==', true),
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [
      write('start-diesel-generator-a', { tagId: 'EDG-A-START' }, true),
    ],
  }),
  rule({
    id: 'safety-bus-b-loss-alarm',
    label: 'Safety bus B loss of power',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'BUS-B-ENERGIZED' }, '==', false),
    clearCondition: comparison({ tagId: 'BUS-B-ENERGIZED' }, '==', true),
    clearDelayMs: 2_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [
      alarm({
        id: 'safety-bus-b-loss',
        title: 'Safety bus B de-energized',
        message: 'Safety bus B is de-energized; emergency diesel generator B start is demanded.',
        severity: 'critical',
        annunciator: annunciator({ ...electricalAlarm, equipmentId: 'safetyBusB', firstOutGroup: 'electrical-power-loss' }),
      }),
    ],
  }),
  rule({
    id: 'safety-bus-b-loss-diesel-start',
    label: 'Safety bus B loss of power diesel start',
    ruleClass: 'normalControl',
    condition: comparison({ tagId: 'BUS-B-ENERGIZED' }, '==', false),
    clearCondition: comparison({ tagId: 'BUS-B-ENERGIZED' }, '==', true),
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [
      write('start-diesel-generator-b', { tagId: 'EDG-B-START' }, true),
    ],
  }),
  rule({
    id: 'loss-of-offsite-power',
    label: 'Loss of offsite power',
    ruleClass: 'alarm',
    condition: any([
      comparison({ tagId: 'GRID-AVAIL' }, '==', false),
      comparison({ tagId: 'GRID-MW' }, '<', 1),
    ]),
    clearCondition: comparison({ tagId: 'GRID-AVAIL' }, '==', true),
    clearDelayMs: 2_000,
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'loss-of-offsite-power',
      title: 'Loss of offsite power',
      message: 'The offsite grid source is unavailable or providing no usable power.',
      severity: 'critical',
      annunciator: annunciator({ ...electricalAlarm, equipmentId: 'offsiteGrid', role: 'cause' }),
    })],
  }),
]
