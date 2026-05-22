import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, headerVariables, valveVariables } from './component-definition-helpers.ts'

export const junctionComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'processHeader' as ComponentKind,
    label: 'Process Header',
    ports: {
      inletA: { kind: 'hydraulicThermal', direction: 'in' },
      inletB: { kind: 'hydraulicThermal', direction: 'in' },
      inletC: { kind: 'hydraulicThermal', direction: 'in' },
      inletD: { kind: 'hydraulicThermal', direction: 'in' },
      outletA: { kind: 'hydraulicThermal', direction: 'out' },
      outletB: { kind: 'hydraulicThermal', direction: 'out' },
      outletC: { kind: 'hydraulicThermal', direction: 'out' },
      outletD: { kind: 'hydraulicThermal', direction: 'out' },
    },
    parametersSchema: z.object({
      initialTemperatureC: z.number().finite().optional(),
      initialPressureMPa: z.number().finite().positive().optional(),
    }).strict(),
    variables: headerVariables('Process header'),
  }),
  defineComponent({
    kind: 'processValve' as ComponentKind,
    label: 'Process Valve',
    ports: {
      inlet: { kind: 'hydraulicThermal', direction: 'in' },
      outlet: { kind: 'hydraulicThermal', direction: 'out' },
      demand: { kind: 'controlSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      initialPositionFraction: z.number().finite().min(0).max(1).optional(),
      strokeTimeConstantS: z.number().finite().positive().optional(),
    }).strict(),
    variables: valveVariables('Process valve'),
  }),
  defineComponent({
    kind: 'steamHeader' as ComponentKind,
    label: 'Steam Header',
    ports: {
      inletA: { kind: 'steam', direction: 'in' },
      inletB: { kind: 'steam', direction: 'in' },
      inletC: { kind: 'steam', direction: 'in' },
      inletD: { kind: 'steam', direction: 'in' },
      outletA: { kind: 'steam', direction: 'out' },
      outletB: { kind: 'steam', direction: 'out' },
      outletC: { kind: 'steam', direction: 'out' },
      outletD: { kind: 'steam', direction: 'out' },
    },
    parametersSchema: z.object({
      initialTemperatureC: z.number().finite().optional(),
      initialPressureMPa: z.number().finite().positive().optional(),
    }).strict(),
    variables: headerVariables('Steam header'),
  }),
  defineComponent({
    kind: 'steamValve' as ComponentKind,
    label: 'Steam Valve',
    ports: {
      inlet: { kind: 'steam', direction: 'in' },
      outlet: { kind: 'steam', direction: 'out' },
      demand: { kind: 'controlSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      initialPositionFraction: z.number().finite().min(0).max(1).optional(),
      strokeTimeConstantS: z.number().finite().positive().optional(),
    }).strict(),
    variables: valveVariables('Steam valve'),
  }),
]
