import { z } from 'zod'
import { defineComponent, headerVariables, valveVariables } from './component-definition-helpers.ts'
import { type ComponentDefinition, type ComponentKind, variablePathSchema } from './model.ts'

const valvePositionControllerSchema = z.object({
  kind: z.literal('proportionalPosition'),
  measuredPath: variablePathSchema,
  setpoint: z.number().finite(),
  biasPositionFraction: z.number().finite().min(0).max(1),
  gainPerUnit: z.number().finite().nonnegative(),
  direction: z.enum(['direct', 'reverse']).default('reverse'),
  deadband: z.number().finite().nonnegative().optional(),
  minPositionFraction: z.number().finite().min(0).max(1).optional(),
  maxPositionFraction: z.number().finite().min(0).max(1).optional(),
  timeConstantS: z.number().finite().positive().optional(),
}).strict().superRefine((controller, ctx) => {
  if (
    controller.minPositionFraction !== undefined
    && controller.maxPositionFraction !== undefined
    && controller.minPositionFraction > controller.maxPositionFraction
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minPositionFraction'],
      message: 'valve controller minPositionFraction cannot exceed maxPositionFraction',
    })
  }
})

export const junctionComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'processHeader' as ComponentKind,
    label: 'Process Header',
    ports: {
      inletA: { kind: 'hydraulicThermal', direction: 'in' },
      inletB: { kind: 'hydraulicThermal', direction: 'in' },
      inletC: { kind: 'hydraulicThermal', direction: 'in' },
      inletD: { kind: 'hydraulicThermal', direction: 'in' },
      inletE: { kind: 'hydraulicThermal', direction: 'in' },
      inletF: { kind: 'hydraulicThermal', direction: 'in' },
      outletA: { kind: 'hydraulicThermal', direction: 'out' },
      outletB: { kind: 'hydraulicThermal', direction: 'out' },
      outletC: { kind: 'hydraulicThermal', direction: 'out' },
      outletD: { kind: 'hydraulicThermal', direction: 'out' },
      outletE: { kind: 'hydraulicThermal', direction: 'out' },
      outletF: { kind: 'hydraulicThermal', direction: 'out' },
    },
    parametersSchema: z.object({
      initialTemperatureC: z.number().finite().optional(),
      initialPressureMPa: z.number().finite().positive().optional(),
      headerVolumeM3: z.number().finite().positive().optional(),
      nominalDensityKgPerM3: z.number().finite().positive().optional(),
      mixingTimeConstantS: z.number().finite().positive().optional(),
      pressureTimeConstantS: z.number().finite().positive().optional(),
      distributionMode: z.enum(['demandWeighted', 'pressureWeighted']).optional(),
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
      strokeOpenTimeS: z.number().finite().positive().optional(),
      strokeCloseTimeS: z.number().finite().positive().optional(),
      valveMode: z.enum(['control', 'isolation', 'check', 'relief', 'safety', 'throttle', 'bypass']).optional(),
      cvKgPerSPerSqrtMPa: z.number().finite().nonnegative().optional(),
      failPositionFraction: z.number().finite().min(0).max(1).optional(),
      leakageFractionClosed: z.number().finite().min(0).max(1).optional(),
      reverseFlowAllowed: z.boolean().optional(),
      setpointMPa: z.number().finite().positive().optional(),
      reseatMPa: z.number().finite().positive().optional(),
      controller: valvePositionControllerSchema.optional(),
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
      inletE: { kind: 'steam', direction: 'in' },
      inletF: { kind: 'steam', direction: 'in' },
      outletA: { kind: 'steam', direction: 'out' },
      outletB: { kind: 'steam', direction: 'out' },
      outletC: { kind: 'steam', direction: 'out' },
      outletD: { kind: 'steam', direction: 'out' },
      outletE: { kind: 'steam', direction: 'out' },
      outletF: { kind: 'steam', direction: 'out' },
    },
    parametersSchema: z.object({
      initialTemperatureC: z.number().finite().optional(),
      initialPressureMPa: z.number().finite().positive().optional(),
      headerVolumeM3: z.number().finite().positive().optional(),
      nominalDensityKgPerM3: z.number().finite().positive().optional(),
      mixingTimeConstantS: z.number().finite().positive().optional(),
      pressureTimeConstantS: z.number().finite().positive().optional(),
      distributionMode: z.enum(['demandWeighted', 'pressureWeighted']).optional(),
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
      strokeOpenTimeS: z.number().finite().positive().optional(),
      strokeCloseTimeS: z.number().finite().positive().optional(),
      valveMode: z.enum(['control', 'isolation', 'check', 'relief', 'safety', 'throttle', 'bypass']).optional(),
      cvKgPerSPerSqrtMPa: z.number().finite().nonnegative().optional(),
      failPositionFraction: z.number().finite().min(0).max(1).optional(),
      leakageFractionClosed: z.number().finite().min(0).max(1).optional(),
      reverseFlowAllowed: z.boolean().optional(),
      setpointMPa: z.number().finite().positive().optional(),
      reseatMPa: z.number().finite().positive().optional(),
      controller: valvePositionControllerSchema.optional(),
    }).strict(),
    variables: valveVariables('Steam valve'),
  }),
]
