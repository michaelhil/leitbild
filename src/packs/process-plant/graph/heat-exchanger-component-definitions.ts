import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'

export const heatExchangerComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'heatExchanger' as ComponentKind,
    label: 'Heat Exchanger',
    ports: {
      hotIn: { kind: 'hydraulicThermal', direction: 'in' },
      hotOut: { kind: 'hydraulicThermal', direction: 'out' },
      coldIn: { kind: 'hydraulicThermal', direction: 'in' },
      coldOut: { kind: 'hydraulicThermal', direction: 'out' },
      control: { kind: 'controlSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      uaMwPerC: z.number().finite().nonnegative(),
      hotSideDesignFlowKgPerS: z.number().finite().positive(),
      coldSideDesignFlowKgPerS: z.number().finite().positive(),
      hotSideVolumeM3: z.number().finite().positive().optional(),
      coldSideVolumeM3: z.number().finite().positive().optional(),
      hotSideDensityKgPerM3: z.number().finite().positive().optional(),
      coldSideDensityKgPerM3: z.number().finite().positive().optional(),
      effectivenessLimit: z.number().finite().min(0).max(1).optional(),
      thermalMassMJPerC: z.number().finite().nonnegative().optional(),
      foulingFactor: z.number().finite().min(0).max(1).optional(),
      bypassFraction: z.number().finite().min(0).max(1).optional(),
      hotSideNominalPressureDropMPa: z.number().finite().nonnegative().optional(),
      coldSideNominalPressureDropMPa: z.number().finite().nonnegative().optional(),
      initialHotTemperatureC: z.number().finite().optional(),
      initialColdTemperatureC: z.number().finite().optional(),
    }).strict(),
    variables: [
      variable({ path: 'hotInletTemperatureC', label: 'Heat exchanger hot inlet temperature', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'hotOutletTemperatureC', label: 'Heat exchanger hot outlet temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coldInletTemperatureC', label: 'Heat exchanger cold inlet temperature', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coldOutletTemperatureC', label: 'Heat exchanger cold outlet temperature', kind: 'state', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'hotSideFlowKgPerS', label: 'Heat exchanger hot side flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'coldSideFlowKgPerS', label: 'Heat exchanger cold side flow', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'heatTransferMw', label: 'Heat exchanger heat transfer', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'approachTemperatureC', label: 'Heat exchanger approach temperature', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'effectivenessFraction', label: 'Heat exchanger effectiveness', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'hotSidePressureDropMPa', label: 'Heat exchanger hot side pressure drop', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa' }),
      variable({ path: 'coldSidePressureDropMPa', label: 'Heat exchanger cold side pressure drop', kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa' }),
      variable({ path: 'heatBalanceResidualMw', label: 'Heat exchanger heat balance residual', kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'powerDelta', unit: 'MW' }),
    ],
  }),
]
