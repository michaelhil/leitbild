import { z } from 'zod'
import type { ComponentDefinition, ComponentKind, ComponentVariableDescriptor, LocalVariablePath } from './model.ts'
import { componentVariableDescriptorSchema } from './model.ts'

const normalized = z.number().finite().min(0).max(1)

type ComponentVariableInput = Omit<ComponentVariableDescriptor, 'path'> & {
  readonly path: string
}

const variable = (descriptor: ComponentVariableInput): ComponentVariableDescriptor => ({
  ...componentVariableDescriptorSchema.parse(descriptor),
  path: descriptor.path as LocalVariablePath,
})

export const defineComponent = (definition: ComponentDefinition): ComponentDefinition => definition

const processPlantComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'reactorCore' as ComponentKind,
    label: 'Reactor Core',
    ports: {
      hotLegA: { kind: 'hydraulicThermal', direction: 'out' },
      coldLegA: { kind: 'hydraulicThermal', direction: 'in' },
      rodDemand: { kind: 'controlSignal', direction: 'in' },
      tripSignal: { kind: 'logicSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      ratedPowerMw: z.number().finite().positive(),
      initialPowerFraction: normalized,
    }),
    variables: [
      variable({ path: 'powerMw', label: 'Core power', kind: 'state', domain: 'nuclear', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'reactivityPcm', label: 'Reactivity', kind: 'state', domain: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm' }),
      variable({ path: 'rodInsertionFraction', label: 'Rod insertion', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
    ],
  }),
  defineComponent({
    kind: 'steamGenerator' as ComponentKind,
    label: 'Steam Generator',
    ports: {
      primaryInlet: { kind: 'hydraulicThermal', direction: 'in' },
      primaryOutlet: { kind: 'hydraulicThermal', direction: 'out' },
      feedwaterInlet: { kind: 'hydraulicThermal', direction: 'in' },
      steamOutlet: { kind: 'steam', direction: 'out' },
      isolationSignal: { kind: 'logicSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalPressureMPa: z.number().finite().positive(),
      nominalLevelPercent: normalized,
      heatTransferCoefficientMwPerK: z.number().finite().positive(),
    }),
    variables: [
      variable({ path: 'levelPercent', label: 'Steam generator level', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'pressureMPa', label: 'Steam generator pressure', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'heatTransferMw', label: 'Heat transfer', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
    ],
  }),
  defineComponent({
    kind: 'centrifugalPump' as ComponentKind,
    label: 'Centrifugal Pump',
    ports: {
      inlet: { kind: 'hydraulicThermal', direction: 'in' },
      outlet: { kind: 'hydraulicThermal', direction: 'out' },
      speedDemand: { kind: 'controlSignal', direction: 'in' },
      power: { kind: 'electricalAc', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalFlowKgPerS: z.number().finite().positive(),
      nominalHeadPa: z.number().finite().positive(),
    }),
    variables: [
      variable({ path: 'running', label: 'Running', kind: 'discrete', domain: 'control', writable: true, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'speedFraction', label: 'Speed', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'flowKgPerS', label: 'Flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
    ],
  }),
  defineComponent({
    kind: 'feedwaterSource' as ComponentKind,
    label: 'Feedwater Source',
    ports: {
      outlet: { kind: 'hydraulicThermal', direction: 'out' },
      flowDemand: { kind: 'controlSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalFlowKgPerS: z.number().finite().positive(),
      temperatureC: z.number().finite(),
    }),
    variables: [
      variable({ path: 'flowKgPerS', label: 'Feedwater flow', kind: 'state', domain: 'hydraulic', writable: true, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
    ],
  }),
  defineComponent({
    kind: 'turbineLoadSink' as ComponentKind,
    label: 'Turbine Load Sink',
    ports: {
      steamInlet: { kind: 'steam', direction: 'in' },
      loadDemand: { kind: 'controlSignal', direction: 'in' },
      generatorOutput: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalElectricMw: z.number().finite().positive(),
      initialLoadFraction: normalized,
    }),
    variables: [
      variable({ path: 'electricMw', label: 'Electrical output', kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'loadFraction', label: 'Load demand', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
    ],
  }),
]

export const processPlantComponentRegistry: ReadonlyMap<ComponentKind, ComponentDefinition> = new Map(
  processPlantComponentDefinitions.map(definition => [definition.kind, definition]),
)
