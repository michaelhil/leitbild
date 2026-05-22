import { z } from 'zod'
import type { ComponentDefinition, ComponentVariableDescriptor, LocalVariablePath } from './model.ts'
import { componentVariableDescriptorSchema } from './model.ts'

export const normalized = z.number().finite().min(0).max(1)

type ComponentVariableInput = Omit<ComponentVariableDescriptor, 'path'> & {
  readonly path: string
}

export const variable = (descriptor: ComponentVariableInput): ComponentVariableDescriptor => ({
  ...componentVariableDescriptorSchema.parse(descriptor),
  path: descriptor.path as LocalVariablePath,
})

export const defineComponent = (definition: ComponentDefinition): ComponentDefinition => definition

export const headerVariables = (labelPrefix: string): ReadonlyArray<ComponentVariableDescriptor> => [
  variable({ path: 'inletFlowKgPerS', label: `${labelPrefix} inlet flow`, kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'outletFlowKgPerS', label: `${labelPrefix} outlet flow`, kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'flowBalanceResidualKgPerS', label: `${labelPrefix} flow balance residual`, kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s' }),
  variable({ path: 'mixedTemperatureC', label: `${labelPrefix} mixed temperature`, kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
  variable({ path: 'mixedPressureMPa', label: `${labelPrefix} mixed pressure`, kind: 'derived', domain: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
]

export const valveVariables = (labelPrefix: string): ReadonlyArray<ComponentVariableDescriptor> => [
  variable({ path: 'positionFraction', label: `${labelPrefix} position`, kind: 'control', domain: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
  variable({ path: 'effectivePositionFraction', label: `${labelPrefix} effective position`, kind: 'derived', domain: 'control', writable: false, publish: 'telemetry', quantity: 'ratio', unit: 'fraction' }),
  variable({ path: 'inletFlowKgPerS', label: `${labelPrefix} inlet flow`, kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'outletFlowKgPerS', label: `${labelPrefix} outlet flow`, kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
  variable({ path: 'flowBalanceResidualKgPerS', label: `${labelPrefix} flow balance residual`, kind: 'derived', domain: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s' }),
]
