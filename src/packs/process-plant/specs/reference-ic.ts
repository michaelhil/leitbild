import { processPlantSignalReferenceSchema, type ProcessPlantSignalReference } from '../signals.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcConfig, ProcessPlantIcRule } from '../runtime/index.ts'

export const processPlantPressurizedWaterReactorIcRef = 'process-plant.pressurized-water-reactor.ic.v1'

type SignalRef = { readonly tagId: string } | { readonly path: string }
type ReferenceIcEffect = ProcessPlantIcRule['effects'][number]

const signalReference = (reference: SignalRef): ProcessPlantSignalReference =>
  processPlantSignalReferenceSchema.parse(reference)

const comparison = (
  signal: SignalRef,
  operator: '<' | '<=' | '>' | '>=' | '==' | '!=',
  value: number | boolean,
): ProcessPlantIcCondition => ({
  type: 'comparison',
  signal: signalReference(signal),
  operator,
  value,
})

const all = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({
  type: 'all',
  conditions,
})

const any = (conditions: ReadonlyArray<ProcessPlantIcCondition>): ProcessPlantIcCondition => ({
  type: 'any',
  conditions,
})

const alarm = (config: {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
}): ReferenceIcEffect => ({
  type: 'alarm.enter',
  id: config.id,
  title: config.title,
  message: config.message,
  severity: config.severity ?? 'warning',
})

const trip = (config: {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly severity?: 'info' | 'notice' | 'warning' | 'critical'
}): ReferenceIcEffect => ({
  type: 'trip.enter',
  id: config.id,
  title: config.title,
  message: config.message,
  severity: config.severity ?? 'critical',
})

const write = (id: string, signal: SignalRef, value: number | boolean): ReferenceIcEffect => ({
  type: 'writeSignal',
  id,
  signal: signalReference(signal),
  value,
})

const rule = (config: {
  readonly id: string
  readonly label?: string
  readonly ruleClass?: ProcessPlantIcRule['ruleClass']
  readonly condition: ProcessPlantIcCondition
  readonly delayMs?: number
  readonly latch?: boolean
  readonly resetWhenClear?: boolean
  readonly effects: ReadonlyArray<ReferenceIcEffect>
}): ProcessPlantIcRule => ({
  id: config.id,
  ...(config.label === undefined ? {} : { label: config.label }),
  enabled: true,
  ruleClass: config.ruleClass ?? 'alarm',
  condition: config.condition,
  delayMs: config.delayMs ?? 0,
  latch: config.latch ?? true,
  resetWhenClear: config.resetWhenClear ?? false,
  effects: [...config.effects],
})

const steamGeneratorRules = (loop: 'A' | 'B' | 'C' | 'D'): ReadonlyArray<ProcessPlantIcRule> => {
  const lower = loop.toLowerCase()
  const sg = `sg${loop}`
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
      })],
    }),
  ]
}

const rcpRules = (loop: 'A' | 'B' | 'C' | 'D'): ReadonlyArray<ProcessPlantIcRule> => {
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

export const pressurizedWaterReactorReferenceIc: ProcessPlantIcConfig = {
  rules: [
    rule({
      id: 'pzr-pressure-low',
      label: 'Pressurizer pressure low',
      ruleClass: 'alarm',
      condition: comparison({ tagId: 'PT-455' }, '<', 14.8),
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'pressure-low',
        title: 'Pressurizer pressure low',
        message: 'Pressurizer pressure is below the reference low-pressure threshold.',
        severity: 'warning',
      })],
    }),
    rule({
      id: 'pzr-pressure-high',
      label: 'Pressurizer pressure high',
      ruleClass: 'alarm',
      condition: comparison({ tagId: 'PT-455' }, '>', 16.0),
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'pressure-high',
        title: 'Pressurizer pressure high',
        message: 'Pressurizer pressure is above the reference high-pressure threshold.',
        severity: 'warning',
      })],
    }),
    rule({
      id: 'pzr-pressure-high-relief',
      label: 'Pressurizer high pressure relief actuation',
      ruleClass: 'protection',
      condition: comparison({ tagId: 'PT-455' }, '>', 16.18),
      delayMs: 1_000,
      effects: [
        trip({
          id: 'relief-actuation',
          title: 'Pressurizer relief actuation',
          message: 'Pressurizer pressure is above the reference relief actuation threshold.',
        }),
        write('open-porv', { tagId: 'PORV-456A' }, 1),
      ],
    }),
    rule({
      id: 'pzr-pressure-relief-reset',
      label: 'Pressurizer relief reset',
      ruleClass: 'normalControl',
      condition: comparison({ tagId: 'PT-455' }, '<', 15.85),
      latch: false,
      resetWhenClear: true,
      effects: [write('close-porv', { tagId: 'PORV-456A' }, 0)],
    }),
    rule({
      id: 'pzr-pressure-heater-demand',
      label: 'Pressurizer heater demand',
      ruleClass: 'normalControl',
      condition: comparison({ tagId: 'PT-455' }, '<', 15.35),
      latch: false,
      resetWhenClear: true,
      effects: [
        write('energize-heaters', { tagId: 'PZR-HTR' }, 12),
        write('stop-spray', { tagId: 'PZR-SPRAY' }, 0),
      ],
    }),
    rule({
      id: 'pzr-pressure-spray-demand',
      label: 'Pressurizer spray demand',
      ruleClass: 'normalControl',
      condition: comparison({ tagId: 'PT-455' }, '>', 15.65),
      latch: false,
      resetWhenClear: true,
      effects: [
        write('deenergize-heaters', { tagId: 'PZR-HTR' }, 0),
        write('start-spray', { tagId: 'PZR-SPRAY' }, 120),
      ],
    }),
    rule({
      id: 'pzr-pressure-normal-band',
      label: 'Pressurizer normal pressure band',
      ruleClass: 'normalControl',
      condition: all([
        comparison({ tagId: 'PT-455' }, '>=', 15.4),
        comparison({ tagId: 'PT-455' }, '<=', 15.6),
      ]),
      latch: false,
      resetWhenClear: true,
      effects: [
        write('deenergize-heaters-normal', { tagId: 'PZR-HTR' }, 0),
        write('stop-spray-normal', { tagId: 'PZR-SPRAY' }, 0),
      ],
    }),
    rule({
      id: 'pzr-level-low',
      label: 'Pressurizer level low',
      ruleClass: 'alarm',
      condition: comparison({ tagId: 'PZR-LVL' }, '<', 35),
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'level-low',
        title: 'Pressurizer level low',
        message: 'Pressurizer level is below the reference low-level threshold.',
        severity: 'warning',
      })],
    }),
    rule({
      id: 'pzr-level-high',
      label: 'Pressurizer level high',
      ruleClass: 'alarm',
      condition: comparison({ tagId: 'PZR-LVL' }, '>', 75),
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'level-high',
        title: 'Pressurizer level high',
        message: 'Pressurizer level is above the reference high-level threshold.',
        severity: 'warning',
      })],
    }),
    ...steamGeneratorRules('A'),
    ...steamGeneratorRules('B'),
    ...steamGeneratorRules('C'),
    ...steamGeneratorRules('D'),
    ...rcpRules('A'),
    ...rcpRules('B'),
    ...rcpRules('C'),
    ...rcpRules('D'),
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
  ],
}

const builtInProcessPlantIcConfigs = new Map<string, ProcessPlantIcConfig>([
  [processPlantPressurizedWaterReactorIcRef, pressurizedWaterReactorReferenceIc],
])

export const resolveProcessPlantIcConfig = (icRef: string): ProcessPlantIcConfig => {
  const config = builtInProcessPlantIcConfigs.get(icRef)
  if (!config) throw new Error(`unknown process plant icRef: ${icRef}`)
  return config
}

export const listProcessPlantIcRefs = (): ReadonlyArray<string> =>
  [...builtInProcessPlantIcConfigs.keys()]
