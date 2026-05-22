import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'

export const pressurizerComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
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
      nominalSteamMassKg: z.number().finite().positive().optional(),
      initialWaterTemperatureC: z.number().finite().optional(),
      initialSteamTemperatureC: z.number().finite().optional(),
      pressureTimeConstantS: z.number().finite().positive().optional(),
      thermalTimeConstantS: z.number().finite().positive().optional(),
      reliefSetpointMPa: z.number().finite().positive().optional(),
      reliefCapacityKgPerS: z.number().finite().nonnegative().optional(),
      sprayCondensationKgPerKg: z.number().finite().nonnegative().optional(),
      nominalWaterDensityKgPerM3: z.number().finite().positive().optional(),
    }),
    variables: [
      variable({ path: 'pressureMPa', label: 'Pressurizer pressure', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'levelPercent', label: 'Pressurizer level', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'waterInventoryKg', label: 'Pressurizer water inventory', kind: 'state', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'steamMassKg', label: 'Pressurizer steam mass', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'steamMassFlowKgPerS', label: 'Pressurizer steam net mass flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s' }),
      variable({ path: 'steamVolumeM3', label: 'Pressurizer steam volume', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'volume', unit: 'm3' }),
      variable({ path: 'steamPressureMPa', label: 'Pressurizer steam pressure proxy', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'pressureTargetMPa', label: 'Pressurizer pressure target', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'waterInventoryBalanceResidualKg', label: 'Pressurizer water inventory balance residual', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg' }),
      variable({ path: 'steamMassBalanceResidualKg', label: 'Pressurizer steam mass balance residual', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg' }),
      variable({ path: 'waterTemperatureC', label: 'Pressurizer water temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'steamTemperatureC', label: 'Pressurizer steam temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'heaterPowerMw', label: 'Pressurizer heater power', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'sprayFlowKgPerS', label: 'Pressurizer spray flow', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'reliefValvePositionFraction', label: 'Pressurizer relief valve position', kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'reliefFlowKgPerS', label: 'Pressurizer relief flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
    ],
  }),
]
