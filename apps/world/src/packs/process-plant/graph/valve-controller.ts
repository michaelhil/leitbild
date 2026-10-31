import { z } from 'zod'
import { numericRangeSchema, processQuantitySchema, processUnitSchema, variablePathSchema, type CompiledComponent, type ComponentVariableDescriptor, type VariablePath } from './model.ts'
import { ratioMeasurandSchema } from './semantics.ts'
import { variable } from './component-definition-helpers.ts'

export const valvePositionControllerSchema = z.object({
  kind: z.literal('proportionalPosition'),
  measuredPath: variablePathSchema,
  setpoint: z.number().finite(),
  biasPositionFraction: z.number().finite().min(0).max(1),
  gainPerUnit: z.number().finite().nonnegative(),
  direction: z.enum(['direct', 'reverse']).default('reverse'),
  deadband: z.number().finite().nonnegative().default(0),
  minPositionFraction: z.number().finite().min(0).max(1).default(0),
  maxPositionFraction: z.number().finite().min(0).max(1).default(1),
  timeConstantS: z.number().finite().positive().default(1),
  permissive: z.object({ path: variablePathSchema, minimum: z.number().finite() }).strict().optional(),
  operator: z.object({
    initialAutomatic: z.boolean(),
    setpoint: z.object({
      quantity: processQuantitySchema.exclude(['boolean']), unit: processUnitSchema,
      measurand: ratioMeasurandSchema.optional(), step: z.number().finite().positive(),
      limits: numericRangeSchema.optional(),
    }).strict(),
  }).strict().optional(),
}).strict().superRefine((controller, context) => {
  if (controller.minPositionFraction > controller.maxPositionFraction) context.addIssue({ code: 'custom', path: ['minPositionFraction'], message: 'valve controller minPositionFraction cannot exceed maxPositionFraction' })
  const limits = controller.operator?.setpoint.limits
  if (limits && (controller.setpoint < limits.min || controller.setpoint > limits.max)) context.addIssue({ code: 'custom', path: ['setpoint'], message: 'initial controller setpoint is outside its authored limits' })
})
export type ValvePositionController = z.infer<typeof valvePositionControllerSchema>

const parsedControllers = new WeakMap<CompiledComponent, ValvePositionController | null>()
export const valvePositionController = (component: CompiledComponent): ValvePositionController | null => {
  if (component.kind !== 'processValve' && component.kind !== 'steamValve') return null
  const cached = parsedControllers.get(component)
  if (cached !== undefined) return cached
  const declared = (component.parameters as { readonly controller?: unknown }).controller
  const controller = declared === undefined ? null : valvePositionControllerSchema.parse(declared)
  parsedControllers.set(component, controller)
  return controller
}

type OperatorControllerBindings = {
  readonly automatic: VariablePath; readonly setpoint: VariablePath
}
const operatorBindings = new WeakMap<CompiledComponent, OperatorControllerBindings | null>()
export const operatorControllerBindings = (component: CompiledComponent): OperatorControllerBindings | null => {
  const cached = operatorBindings.get(component)
  if (cached !== undefined) return cached
  const bindings = valvePositionController(component)?.operator === undefined ? null : {
    automatic: `${component.id}.controllerAutomatic` as VariablePath,
    setpoint: `${component.id}.controllerSetpoint` as VariablePath,
  }
  operatorBindings.set(component, bindings)
  return bindings
}

/** Only an explicitly operator-configurable controller contributes these variables. */
export const valveControllerVariables = (parameters: unknown): ReadonlyArray<ComponentVariableDescriptor> => {
  const controller = (parameters as { readonly controller?: ValvePositionController }).controller
  const operator = controller?.operator
  if (operator === undefined) return []
  const setpoint = operator.setpoint
  return [
    variable({ path: 'controllerAutomatic', label: 'Controller automatic mode demand', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
    variable({ path: 'controllerSetpoint', label: 'Controller setpoint', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: setpoint.quantity, unit: setpoint.unit,
      ...(setpoint.measurand === undefined ? {} : { measurand: setpoint.measurand }), ...(setpoint.limits === undefined ? {} : { limits: { hardRange: setpoint.limits } }) }),
  ]
}
