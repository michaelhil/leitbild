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

const topologyComponent = (
  kind: string,
  label: string,
  ports: ComponentDefinition['ports'],
): ComponentDefinition => defineComponent({
  kind: kind as ComponentKind,
  label,
  ports,
  parametersSchema: z.object({}).strict(),
  variables: [],
})

const processPlantComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'reactorCore' as ComponentKind,
    label: 'Reactor Core',
    ports: {
      hotLegA: { kind: 'hydraulicThermal', direction: 'out' },
      hotLegB: { kind: 'hydraulicThermal', direction: 'out' },
      hotLegC: { kind: 'hydraulicThermal', direction: 'out' },
      hotLegD: { kind: 'hydraulicThermal', direction: 'out' },
      coldLegA: { kind: 'hydraulicThermal', direction: 'in' },
      coldLegB: { kind: 'hydraulicThermal', direction: 'in' },
      coldLegC: { kind: 'hydraulicThermal', direction: 'in' },
      coldLegD: { kind: 'hydraulicThermal', direction: 'in' },
      vesselThermal: { kind: 'thermal', direction: 'out' },
      rodDemand: { kind: 'controlSignal', direction: 'in' },
      tripSignal: { kind: 'logicSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      ratedPowerMw: z.number().finite().positive(),
      initialPowerFraction: normalized,
      initialCoolantInletTemperatureC: z.number().finite().optional(),
      coolantThermalTimeConstantS: z.number().finite().positive().optional(),
      fuelThermalTimeConstantS: z.number().finite().positive().optional(),
      fuelTemperatureRiseAtRatedPowerC: z.number().finite().positive().optional(),
      decayHeatFractionAtPower: z.number().finite().min(0).max(0.2).optional(),
      decayHeatTimeConstantS: z.number().finite().positive().optional(),
    }),
    variables: [
      variable({ path: 'powerMw', label: 'Core power', kind: 'state', domain: 'nuclear', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'reactivityPcm', label: 'Reactivity', kind: 'state', domain: 'nuclear', writable: false, publish: 'telemetry', quantity: 'reactivity', unit: 'pcm' }),
      variable({ path: 'rodInsertionFraction', label: 'Rod insertion', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'coolantInletTemperatureC', label: 'Core coolant inlet temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coolantOutletTemperatureC', label: 'Core coolant outlet temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'fuelTemperatureC', label: 'Core fuel temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'decayHeatMw', label: 'Decay heat', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'heatToCoolantMw', label: 'Heat to coolant', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
    ],
  }),
  topologyComponent('reactorVessel', 'Reactor Vessel', {
    coreThermal: { kind: 'thermal', direction: 'in' },
    lowerPlenum: { kind: 'hydraulicThermal', direction: 'out' },
    upperPlenum: { kind: 'hydraulicThermal', direction: 'in' },
    pressurizerSurge: { kind: 'hydraulicThermal', direction: 'bidirectional' },
  }),
  topologyComponent('processHeader', 'Process Header', {
    inletA: { kind: 'hydraulicThermal', direction: 'in' },
    inletB: { kind: 'hydraulicThermal', direction: 'in' },
    inletC: { kind: 'hydraulicThermal', direction: 'in' },
    inletD: { kind: 'hydraulicThermal', direction: 'in' },
    outletA: { kind: 'hydraulicThermal', direction: 'out' },
    outletB: { kind: 'hydraulicThermal', direction: 'out' },
    outletC: { kind: 'hydraulicThermal', direction: 'out' },
    outletD: { kind: 'hydraulicThermal', direction: 'out' },
  }),
  topologyComponent('processTank', 'Process Tank', {
    inlet: { kind: 'hydraulicThermal', direction: 'in' },
    outlet: { kind: 'hydraulicThermal', direction: 'out' },
  }),
  topologyComponent('processValve', 'Process Valve', {
    inlet: { kind: 'hydraulicThermal', direction: 'in' },
    outlet: { kind: 'hydraulicThermal', direction: 'out' },
    demand: { kind: 'controlSignal', direction: 'in' },
  }),
  topologyComponent('steamHeader', 'Steam Header', {
    inletA: { kind: 'steam', direction: 'in' },
    inletB: { kind: 'steam', direction: 'in' },
    inletC: { kind: 'steam', direction: 'in' },
    inletD: { kind: 'steam', direction: 'in' },
    outletA: { kind: 'steam', direction: 'out' },
    outletB: { kind: 'steam', direction: 'out' },
    outletC: { kind: 'steam', direction: 'out' },
    outletD: { kind: 'steam', direction: 'out' },
  }),
  topologyComponent('steamValve', 'Steam Valve', {
    inlet: { kind: 'steam', direction: 'in' },
    outlet: { kind: 'steam', direction: 'out' },
    demand: { kind: 'controlSignal', direction: 'in' },
  }),
  defineComponent({
    kind: 'pressurizer' as ComponentKind,
    label: 'Pressurizer',
    ports: {
      surgeLine: { kind: 'hydraulicThermal', direction: 'bidirectional' },
      sprayInlet: { kind: 'hydraulicThermal', direction: 'in' },
      reliefOutlet: { kind: 'hydraulicThermal', direction: 'out' },
      heaterPower: { kind: 'electricalAc', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalPressureMPa: z.number().finite().positive(),
      nominalLevelPercent: normalized,
      nominalWaterInventoryKg: z.number().finite().positive(),
      initialWaterTemperatureC: z.number().finite().optional(),
      initialSteamTemperatureC: z.number().finite().optional(),
      pressureTimeConstantS: z.number().finite().positive().optional(),
      thermalTimeConstantS: z.number().finite().positive().optional(),
      reliefSetpointMPa: z.number().finite().positive().optional(),
      reliefCapacityKgPerS: z.number().finite().nonnegative().optional(),
      heaterPressureRampMPaPerMwS: z.number().finite().nonnegative().optional(),
      sprayPressureRampMPaPerKgS: z.number().finite().nonnegative().optional(),
      reliefPressureRampMPaPerKgS: z.number().finite().nonnegative().optional(),
    }),
    variables: [
      variable({ path: 'pressureMPa', label: 'Pressurizer pressure', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'levelPercent', label: 'Pressurizer level', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'waterInventoryKg', label: 'Pressurizer water inventory', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'waterTemperatureC', label: 'Pressurizer water temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'steamTemperatureC', label: 'Pressurizer steam temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'heaterPowerMw', label: 'Pressurizer heater power', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'sprayFlowKgPerS', label: 'Pressurizer spray flow', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'reliefValvePositionFraction', label: 'Pressurizer relief valve position', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'reliefFlowKgPerS', label: 'Pressurizer relief flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
    ],
  }),
  topologyComponent('pressurizerHeaters', 'Pressurizer Heaters', {
    powerInlet: { kind: 'electricalAc', direction: 'in' },
    heatOutput: { kind: 'thermal', direction: 'out' },
  }),
  topologyComponent('generatorSink', 'Generator Sink', {
    electricalInput: { kind: 'electricalAc', direction: 'in' },
    electricalOutput: { kind: 'electricalAc', direction: 'out' },
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
      initialPrimaryInletTemperatureC: z.number().finite().optional(),
      initialSecondaryTemperatureC: z.number().finite().optional(),
      nominalSecondaryInventoryKg: z.number().finite().positive().optional(),
      primaryThermalTimeConstantS: z.number().finite().positive().optional(),
      secondaryThermalTimeConstantS: z.number().finite().positive().optional(),
      inventoryTimeConstantS: z.number().finite().positive().optional(),
      tubeMetalThermalCapacityMjPerK: z.number().finite().positive().optional(),
      tubeMetalInitialTemperatureC: z.number().finite().optional(),
    }),
    variables: [
      variable({ path: 'levelPercent', label: 'Steam generator level', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'pressureMPa', label: 'Steam generator pressure', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'heatTransferMw', label: 'Heat transfer', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'primaryInletTemperatureC', label: 'Primary inlet temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'primaryOutletTemperatureC', label: 'Primary outlet temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'tubeMetalTemperatureC', label: 'Tube metal temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'secondaryTemperatureC', label: 'Secondary temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'steamFlowKgPerS', label: 'Steam production', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'secondaryInventoryKg', label: 'Secondary inventory', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
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
      variable({ path: 'temperatureC', label: 'Feedwater temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
    ],
  }),
  defineComponent({
    kind: 'turbineLoadSink' as ComponentKind,
    label: 'Turbine Load Sink',
    ports: {
      steamInlet: { kind: 'steam', direction: 'in' },
      exhaustSteamOutlet: { kind: 'steam', direction: 'out' },
      loadDemand: { kind: 'controlSignal', direction: 'in' },
      generatorOutput: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalElectricMw: z.number().finite().positive(),
      initialLoadFraction: normalized,
      nominalSteamFlowKgPerS: z.number().finite().positive(),
      electricalTimeConstantS: z.number().finite().positive().optional(),
    }),
    variables: [
      variable({ path: 'electricMw', label: 'Electrical output', kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'loadFraction', label: 'Load demand', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'steamFlowKgPerS', label: 'Turbine steam flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
    ],
  }),
  defineComponent({
    kind: 'condenserSink' as ComponentKind,
    label: 'Condenser Sink',
    ports: {
      steamInlet: { kind: 'steam', direction: 'in' },
      condensateOutlet: { kind: 'hydraulicThermal', direction: 'out' },
      coolingWater: { kind: 'hydraulicThermal', direction: 'in' },
    },
    parametersSchema: z.object({
      coolingWaterTemperatureC: z.number().finite(),
      nominalSteamFlowKgPerS: z.number().finite().positive(),
      condensateApproachTemperatureK: z.number().finite().nonnegative(),
      condenserThermalTimeConstantS: z.number().finite().positive().optional(),
    }),
    variables: [
      variable({ path: 'steamFlowKgPerS', label: 'Condenser steam flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'condensateTemperatureC', label: 'Condensate temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'backPressurePa', label: 'Condenser back pressure', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'Pa' }),
    ],
  }),
]

export const processPlantComponentRegistry: ReadonlyMap<ComponentKind, ComponentDefinition> = new Map(
  processPlantComponentDefinitions.map(definition => [definition.kind, definition]),
)
