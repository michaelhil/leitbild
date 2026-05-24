import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, comparison, rule, trip, write } from './reference-ic-helpers.ts'

export const steamGeneratorReferenceIcRules = (loop: 'A' | 'B' | 'C' | 'D'): ReadonlyArray<ProcessPlantIcRule> => {
  const lower = loop.toLowerCase()
  const sg = `sg${loop}`
  const sgAlarm = annunciator({
    system: 'steam generators',
    equipmentId: sg,
    group: `steam-generator-${lower}`,
    priority: 'high',
    role: 'symptom',
  })
  const sgAction = annunciator({
    system: 'steam generators',
    equipmentId: sg,
    group: `steam-generator-${lower}`,
    priority: 'urgent',
    role: 'automaticAction',
  })
  return [
    rule({
      id: `sg-${lower}-tube-leak-indication`,
      label: `Steam generator ${loop} tube leak indication`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-TUBE-LEAK` }, '>', 0.002),
      effects: [alarm({
        id: 'tube-leak',
        title: `Steam generator ${loop} tube leak indicated`,
        message: `Steam generator ${loop} tube leak fraction is above the reference indication threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-secondary-radiation-high`,
      label: `Steam generator ${loop} secondary radiation high`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-N16` }, '>', 0.5),
      delayMs: 1_000,
      effects: [alarm({
        id: 'secondary-radiation-high',
        title: `Steam generator ${loop} secondary radiation high`,
        message: `Steam generator ${loop} secondary radiation is above the reference alarm threshold.`,
        severity: 'critical',
        annunciator: annunciator({ ...sgAlarm, priority: 'urgent', role: 'cause' }),
      })],
    }),
    rule({
      id: `sg-${lower}-level-low`,
      label: `Steam generator ${loop} narrow-range level low`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', 30),
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'level-low',
        title: `Steam generator ${loop} level low`,
        message: `Steam generator ${loop} narrow-range level is below the reference low-level threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-level-low-low-afw-actuation`,
      label: `Steam generator ${loop} low-low level auxiliary feedwater actuation`,
      ruleClass: 'protection',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', 20),
      delayMs: 1_000,
      effects: [
        trip({
          id: 'afw-actuation',
          title: `Steam generator ${loop} low-low level`,
          message: `Steam generator ${loop} low-low level actuates the reference auxiliary feedwater response.`,
          annunciator: sgAction,
        }),
        write('start-motor-afw', { path: 'auxFeedwaterPumpMotor.running' }, true),
        write('start-turbine-afw', { path: 'auxFeedwaterPumpTurbine.running' }, true),
        write(`open-afw-valve-${lower}`, { path: `auxFeedwaterValve${loop}.positionFraction` }, 1),
      ],
    }),
    rule({
      id: `sg-${lower}-pressure-high`,
      label: `Steam generator ${loop} pressure high`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-PRESS` }, '>', 7.6),
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'pressure-high',
        title: `Steam generator ${loop} pressure high`,
        message: `Steam generator ${loop} pressure is above the reference high-pressure threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-feedwater-low`,
      label: `Steam generator ${loop} feedwater flow low`,
      ruleClass: 'alarm',
      condition: all([
        comparison({ path: `${sg}.levelPercent` }, '<', 40),
        comparison({ path: `${sg}.feedwaterFlowKgPerS` }, '<', 150),
      ]),
      delayMs: 3_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'feedwater-low',
        title: `Steam generator ${loop} feedwater low`,
        message: `Steam generator ${loop} feedwater flow is low while level is below the reference operating band.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
  ]
}
