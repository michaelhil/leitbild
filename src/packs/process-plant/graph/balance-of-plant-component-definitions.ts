import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'

export const balanceOfPlantComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'processTank' as ComponentKind,
    label: 'Process Tank',
    ports: {
      inlet: { kind: 'hydraulicThermal', direction: 'in' },
      outlet: { kind: 'hydraulicThermal', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalInventoryKg: z.number().finite().positive(),
      initialInventoryFraction: normalized,
      initialTemperatureC: z.number().finite(),
      initialSoluteConcentrationPpm: z.number().finite().nonnegative().optional(),
      makeupFlowKgPerS: z.number().finite().nonnegative(),
      maxOutletFlowKgPerS: z.number().finite().nonnegative(),
      thermalTimeConstantS: z.number().finite().positive().optional(),
    }).strict(),
    variables: [
      variable({ path: 'inventoryKg', label: 'Tank inventory', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'levelPercent', label: 'Tank level', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'temperatureC', label: 'Tank temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'soluteConcentrationPpm', label: 'Tank solute concentration', kind: 'state', domain: 'chemical', writable: false, publish: 'telemetry', quantity: 'concentration', unit: 'ppm' }),
      variable({ path: 'makeupFlowKgPerS', label: 'Tank makeup flow', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'availableOutletFlowKgPerS', label: 'Available outlet flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
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
      exhaustTemperatureAtFullLoadC: z.number().finite().optional(),
      exhaustTemperatureAtNoLoadC: z.number().finite().optional(),
    }),
    variables: [
      variable({ path: 'electricMw', label: 'Electrical output', kind: 'derived', domain: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'loadFraction', label: 'Load demand', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'steamFlowKgPerS', label: 'Turbine steam flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'steamDemandKgPerS', label: 'Turbine steam demand', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'steamAvailabilityFraction', label: 'Turbine steam availability', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'exhaustTemperatureC', label: 'Turbine exhaust temperature', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
    ],
  }),
  defineComponent({
    kind: 'condenserSink' as ComponentKind,
    label: 'Condenser Sink',
    ports: {
      steamInlet: { kind: 'steam', direction: 'in' },
      condensateOutlet: { kind: 'hydraulicThermal', direction: 'out' },
      coolingWater: { kind: 'hydraulicThermal', direction: 'in' },
      coolingWaterOutlet: { kind: 'hydraulicThermal', direction: 'out' },
    },
    parametersSchema: z.object({
      coolingWaterTemperatureC: z.number().finite(),
      nominalCoolingWaterFlowKgPerS: z.number().finite().positive(),
      coolingWaterDesignDeltaTK: z.number().finite().positive(),
      nominalSteamFlowKgPerS: z.number().finite().positive(),
      condensateApproachTemperatureK: z.number().finite().nonnegative(),
      nominalCondensateInventoryKg: z.number().finite().positive(),
      initialCondensateInventoryFraction: normalized,
      maxCondensateOutletFlowKgPerS: z.number().finite().nonnegative(),
      condenserThermalTimeConstantS: z.number().finite().positive().optional(),
      exhaustCondensationTemperatureC: z.number().finite().optional(),
    }),
    variables: [
      variable({ path: 'steamFlowKgPerS', label: 'Condenser steam flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'condensateProductionKgPerS', label: 'Condensate production', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'heatRejectedMw', label: 'Condenser heat rejected', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'condensateInventoryKg', label: 'Condensate inventory', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'condensateLevelPercent', label: 'Condensate level', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'availableCondensateOutletFlowKgPerS', label: 'Available condensate outlet flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'condensateTemperatureC', label: 'Condensate temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'backPressurePa', label: 'Condenser back pressure', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'Pa' }),
      variable({ path: 'coolingWaterFlowKgPerS', label: 'Condenser cooling-water flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'coolingWaterInletTemperatureC', label: 'Condenser cooling-water inlet temperature', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coolingWaterOutletTemperatureC', label: 'Condenser cooling-water outlet temperature', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coolingWaterHeatCapacityMw', label: 'Condenser cooling-water heat capacity', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'coolingWaterAvailabilityFraction', label: 'Condenser cooling-water availability', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
    ],
  }),
]
