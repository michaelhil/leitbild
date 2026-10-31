import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'
import { fixedSemantics } from './semantics.ts'

export const heatExchangerComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'heatExchanger' as ComponentKind,
    label: 'Heat Exchanger',
    ports: {
      hotIn: { kind: 'hydraulicThermal', direction: 'in', circuit: 'hot' },
      hotOut: { kind: 'hydraulicThermal', direction: 'out', circuit: 'hot' },
      coldIn: { kind: 'hydraulicThermal', direction: 'in', circuit: 'cold' },
      coldOut: { kind: 'hydraulicThermal', direction: 'out', circuit: 'cold' },
      control: { kind: 'controlSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      uaMwPerC: z.number().finite().nonnegative(),
      hotSideDesignFlowKgPerS: z.number().finite().positive(),
      coldSideDesignFlowKgPerS: z.number().finite().positive(),
      effectivenessLimit: z.number().finite().min(0).max(1).optional(),
      foulingFactor: z.number().finite().min(0).max(1).optional(),
      bypassFraction: z.number().finite().min(0).max(1).optional(),
      hotSideNominalPressureDropMPa: z.number().finite().nonnegative().optional(),
      coldSideNominalPressureDropMPa: z.number().finite().nonnegative().optional(),
      initialHotTemperatureC: z.number().finite().optional(),
      initialColdTemperatureC: z.number().finite().optional(),
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['heatTransferMw', 'hotOutletTemperatureC', 'coldOutletTemperatureC'], energy: [{ role: 'transfer', from: 'hot', to: 'cold' }] }),
    variables: [
      variable({ path: 'hotInletTemperatureC', label: 'Heat exchanger hot inlet temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'hotOutletTemperatureC', label: 'Heat exchanger hot outlet temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coldInletTemperatureC', label: 'Heat exchanger cold inlet temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'coldOutletTemperatureC', label: 'Heat exchanger cold outlet temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'hotSideFlowKgPerS', label: 'Heat exchanger hot side flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'coldSideFlowKgPerS', label: 'Heat exchanger cold side flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'heatTransferMw', label: 'Heat exchanger signed heat transfer', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'powerDelta', unit: 'MW' }),
      variable({ path: 'heatTransferCapacityMw', label: 'Heat exchanger heat transfer capacity', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'approachTemperatureC', label: 'Heat exchanger approach temperature', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'effectivenessFraction', label: 'Heat exchanger effectiveness', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'effectiveness', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'coolingAvailabilityFraction', label: 'Heat exchanger cooling availability', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'availability', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'hotSidePressureDropMPa', label: 'Heat exchanger hot side pressure drop', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa' }),
      variable({ path: 'coldSidePressureDropMPa', label: 'Heat exchanger cold side pressure drop', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa' }),
      variable({ path: 'heatBalanceResidualMw', label: 'Heat exchanger heat balance residual', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'powerDelta', unit: 'MW', simulatorOnly: true }),
    ],
  }),
]
