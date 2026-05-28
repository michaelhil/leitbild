import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'

export const containmentComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'containmentVolume' as ComponentKind,
    label: 'Containment Volume',
    ports: {
      massEnergyIn: { kind: 'hydraulicThermal', direction: 'in' },
      steamIn: { kind: 'steam', direction: 'in' },
      sprayIn: { kind: 'hydraulicThermal', direction: 'in' },
      sumpOut: { kind: 'hydraulicThermal', direction: 'out' },
      ventOut: { kind: 'steam', direction: 'out' },
    },
    parametersSchema: z.object({
      freeVolumeM3: z.number().finite().positive(),
      initialPressureMPa: z.number().finite().positive().optional(),
      initialTemperatureC: z.number().finite().optional(),
      initialHumidityFraction: z.number().finite().min(0).max(1).optional(),
      initialSumpInventoryKg: z.number().finite().nonnegative().optional(),
      heatLossMwPerC: z.number().finite().nonnegative().optional(),
      designPressureMPa: z.number().finite().positive().optional(),
      maxSumpOutflowKgPerS: z.number().finite().nonnegative().optional(),
      ventSetpointMPa: z.number().finite().positive().optional(),
      ventCapacityKgPerS: z.number().finite().nonnegative().optional(),
    }).strict(),
    variables: [
      variable({ path: 'atmosphereMassKg', label: 'Containment atmosphere mass', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'airMassKg', label: 'Containment air mass', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'steamMassKg', label: 'Containment steam mass', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'sumpInventoryKg', label: 'Containment sump inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'pressureMPa', label: 'Containment pressure', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'temperatureC', label: 'Containment temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'humidityFraction', label: 'Containment humidity', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'incomingMassKgPerS', label: 'Containment incoming mass', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'sprayFlowKgPerS', label: 'Containment spray flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'releaseFlowKgPerS', label: 'Containment vent release flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'sumpOutflowKgPerS', label: 'Containment sump outflow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'heatRemovalMw', label: 'Containment heat removal', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'radiationSourceTermMSvPerH', label: 'Containment radiation source term', kind: 'state', discipline: 'radiological', writable: false, publish: 'telemetry', quantity: 'radiationDoseRate', unit: 'mSv/h' }),
      variable({ path: 'contaminationInventory', label: 'Containment contamination inventory', kind: 'state', discipline: 'radiological', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
    ],
  }),
]
