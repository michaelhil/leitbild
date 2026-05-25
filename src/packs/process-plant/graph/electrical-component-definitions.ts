import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'

const positivePower = z.number().finite().positive()
const nonnegativePower = z.number().finite().nonnegative()

const energizedVariables = (labelPrefix: string) => [
  variable({ path: 'energized', label: `${labelPrefix} energized`, kind: 'state', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
  variable({ path: 'availablePowerMw', label: `${labelPrefix} available power`, kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
]

export const electricalComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'electricalGridSource' as ComponentKind,
    label: 'Electrical Grid Source',
    ports: {
      outlet: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      initialAvailable: z.boolean().optional(),
    }).strict(),
    variables: [
      variable({ path: 'available', label: 'Grid source available', kind: 'control', domain: 'electrical', writable: true, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      ...energizedVariables('Grid source'),
    ],
  }),
  defineComponent({
    kind: 'electricalBus' as ComponentKind,
    label: 'Electrical Bus',
    ports: {
      inlet: { kind: 'electricalAc', direction: 'in' },
      outlet: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      initialEnergized: z.boolean().optional(),
    }).strict(),
    variables: [
      ...energizedVariables('Electrical bus'),
      variable({ path: 'servedLoadMw', label: 'Bus served load', kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'marginMw', label: 'Bus power margin', kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'powerDelta', unit: 'MW' }),
    ],
  }),
  defineComponent({
    kind: 'electricalBreaker' as ComponentKind,
    label: 'Electrical Breaker',
    ports: {
      inlet: { kind: 'electricalAc', direction: 'in' },
      outlet: { kind: 'electricalAc', direction: 'out' },
      tripSignal: { kind: 'logicSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      initialClosed: z.boolean().optional(),
      initialTripped: z.boolean().optional(),
    }).strict(),
    variables: [
      variable({ path: 'closed', label: 'Breaker closed', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'tripped', label: 'Breaker tripped', kind: 'discrete', domain: 'control', writable: true, publish: 'alarm', quantity: 'boolean', unit: 'boolean' }),
      ...energizedVariables('Breaker outlet'),
    ],
  }),
  defineComponent({
    kind: 'electricalTransformer' as ComponentKind,
    label: 'Electrical Transformer',
    ports: {
      primary: { kind: 'electricalAc', direction: 'in' },
      secondary: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      efficiencyFraction: normalized.optional(),
    }).strict(),
    variables: [
      ...energizedVariables('Transformer secondary'),
      variable({ path: 'loadMw', label: 'Transformer load', kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
    ],
  }),
  defineComponent({
    kind: 'dieselGenerator' as ComponentKind,
    label: 'Diesel Generator',
    ports: {
      outlet: { kind: 'electricalAc', direction: 'out' },
      startSignal: { kind: 'logicSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      startDelayS: z.number().finite().nonnegative().optional(),
      initialRunning: z.boolean().optional(),
      initialAvailable: z.boolean().optional(),
    }).strict(),
    variables: [
      variable({ path: 'startCommand', label: 'Diesel start command', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'available', label: 'Diesel available', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'running', label: 'Diesel running', kind: 'state', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'startElapsedS', label: 'Diesel start elapsed time', kind: 'state', domain: 'control', writable: false, publish: 'internal', quantity: 'time', unit: 's' }),
      ...energizedVariables('Diesel generator'),
    ],
  }),
  defineComponent({
    kind: 'battery' as ComponentKind,
    label: 'Battery',
    ports: {
      outlet: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      dischargeTimeS: z.number().finite().positive(),
      initialStateOfChargeFraction: normalized.optional(),
    }).strict(),
    variables: [
      variable({ path: 'stateOfChargeFraction', label: 'Battery state of charge', kind: 'state', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      ...energizedVariables('Battery'),
    ],
  }),
  defineComponent({
    kind: 'inverter' as ComponentKind,
    label: 'Inverter',
    ports: {
      dcInlet: { kind: 'electricalAc', direction: 'in' },
      acOutlet: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      efficiencyFraction: normalized.optional(),
    }).strict(),
    variables: [
      ...energizedVariables('Inverter output'),
    ],
  }),
  defineComponent({
    kind: 'electricalLoad' as ComponentKind,
    label: 'Electrical Load',
    ports: {
      power: { kind: 'electricalAc', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalLoadMw: nonnegativePower,
      essential: z.boolean().optional(),
    }).strict(),
    variables: [
      variable({ path: 'demandMw', label: 'Load demand', kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'servedMw', label: 'Load served', kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'servedFraction', label: 'Load served fraction', kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'energized', label: 'Load energized', kind: 'state', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
    ],
  }),
]
