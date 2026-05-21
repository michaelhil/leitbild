import { z } from 'zod'
import type { Brand } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'

export type PlantGraphId = Brand<string, 'PlantGraphId'>
export type ComponentId = Brand<string, 'ProcessPlantComponentId'>
export type ComponentKind = Brand<string, 'ProcessPlantComponentKind'>
export type ConnectionId = Brand<string, 'ProcessPlantConnectionId'>
export type PortName = Brand<string, 'ProcessPlantPortName'>
export type PortRef = Brand<string, 'ProcessPlantPortRef'>
export type LocalVariablePath = Brand<string, 'ProcessPlantLocalVariablePath'>
export type VariablePath = Brand<string, 'ProcessPlantVariablePath'>

export const plantGraphIdSchema = idSchema.transform(value => value as PlantGraphId)
export const componentIdSchema = idSchema.transform(value => value as ComponentId)
export const componentKindSchema = idSchema.transform(value => value as ComponentKind)
export const connectionIdSchema = idSchema.transform(value => value as ConnectionId)
export const portNameSchema = idSchema.transform(value => value as PortName)
export const portRefSchema = z.string()
  .min(3)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*\.[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .transform(value => value as PortRef)
export const variablePathSchema = z.string()
  .min(3)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*(\.[a-zA-Z0-9][a-zA-Z0-9._:-]*)+$/)
  .transform(value => value as VariablePath)
export const localVariablePathSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .transform(value => value as LocalVariablePath)

export const portKindSchema = z.enum([
  'hydraulic',
  'thermal',
  'hydraulicThermal',
  'steam',
  'electricalAc',
  'mechanicalShaft',
  'controlSignal',
  'logicSignal',
])
export type PortKind = z.infer<typeof portKindSchema>

export const portDirectionSchema = z.enum(['in', 'out', 'bidirectional'])
export type PortDirection = z.infer<typeof portDirectionSchema>

export const edgeKindSchema = z.enum([
  'hydraulicFlow',
  'thermalContact',
  'steamFlow',
  'electricalPower',
  'mechanicalTorque',
  'controlSignal',
  'logicSignal',
])
export type EdgeKind = z.infer<typeof edgeKindSchema>

export const variableKindSchema = z.enum(['state', 'derived', 'control', 'parameter', 'alarm', 'discrete'])
export type VariableKind = z.infer<typeof variableKindSchema>

export const variableDomainSchema = z.enum(['hydraulic', 'thermal', 'nuclear', 'electrical', 'control', 'operator'])
export type VariableDomain = z.infer<typeof variableDomainSchema>

export const variablePublishPolicySchema = z.enum(['internal', 'telemetry', 'alarm', 'leitbild'])
export type VariablePublishPolicy = z.infer<typeof variablePublishPolicySchema>

export const portDefinitionSchema = z.object({
  kind: portKindSchema,
  direction: portDirectionSchema,
})
export type PortDefinition = z.infer<typeof portDefinitionSchema>

export const variableDescriptorSchema = z.object({
  path: variablePathSchema,
  label: z.string().min(1),
  kind: variableKindSchema,
  domain: variableDomainSchema,
  writable: z.boolean(),
  publish: variablePublishPolicySchema,
  unit: z.string().min(1).optional(),
})
export type VariableDescriptor = z.infer<typeof variableDescriptorSchema>

export const componentVariableDescriptorSchema = variableDescriptorSchema.extend({
  path: localVariablePathSchema,
})
export type ComponentVariableDescriptor = z.infer<typeof componentVariableDescriptorSchema>

export const timestepSpecSchema = z.object({
  fixedStepMs: z.number().int().positive().max(10_000),
})
export type TimestepSpec = z.infer<typeof timestepSpecSchema>

export const componentInstanceSpecSchema = z.object({
  id: componentIdSchema,
  kind: componentKindSchema,
  label: z.string().min(1),
  parameters: z.unknown(),
  initialState: z.unknown().optional(),
})
export type ComponentInstanceSpec = z.infer<typeof componentInstanceSpecSchema>

export const connectionSpecSchema = z.object({
  id: connectionIdSchema,
  from: portRefSchema,
  to: portRefSchema,
  edgeKind: edgeKindSchema.optional(),
  medium: z.string().min(1).optional(),
})
export type ConnectionSpec = z.infer<typeof connectionSpecSchema>

export const plantGraphSpecSchema = z.object({
  schemaVersion: z.literal(1),
  id: plantGraphIdSchema,
  title: z.string().min(1),
  timestep: timestepSpecSchema,
  components: z.array(componentInstanceSpecSchema).min(1),
  connections: z.array(connectionSpecSchema),
  publishedVariables: z.array(variablePathSchema).default([]),
})
export type PlantGraphSpec = z.infer<typeof plantGraphSpecSchema>

export interface ComponentDefinition {
  readonly kind: ComponentKind
  readonly label: string
  readonly ports: Readonly<Record<string, PortDefinition>>
  readonly parametersSchema: z.ZodType<unknown>
  readonly initialStateSchema?: z.ZodType<unknown>
  readonly variables: ReadonlyArray<ComponentVariableDescriptor>
}

export interface CompiledPort {
  readonly index: number
  readonly name: PortName
  readonly kind: PortKind
  readonly direction: PortDirection
}

export interface CompiledComponent {
  readonly index: number
  readonly id: ComponentId
  readonly kind: ComponentKind
  readonly label: string
  readonly parameters: unknown
  readonly initialState?: unknown
  readonly ports: Readonly<Record<string, CompiledPort>>
  readonly variables: ReadonlyArray<VariableDescriptor>
}

export interface CompiledEdge {
  readonly index: number
  readonly id: ConnectionId
  readonly kind: EdgeKind
  readonly fromComponentIndex: number
  readonly fromPortIndex: number
  readonly toComponentIndex: number
  readonly toPortIndex: number
  readonly medium?: string
}

export interface CompiledVariable {
  readonly path: VariablePath
  readonly componentIndex: number
  readonly descriptor: VariableDescriptor
  readonly published: boolean
}

export interface CompiledPlantGraph {
  readonly specId: PlantGraphId
  readonly title: string
  readonly timestep: TimestepSpec
  readonly components: ReadonlyArray<CompiledComponent>
  readonly componentIndexById: ReadonlyMap<ComponentId, number>
  readonly edges: ReadonlyArray<CompiledEdge>
  readonly edgesByKind: Readonly<Record<EdgeKind, ReadonlyArray<number>>>
  readonly variables: ReadonlyArray<CompiledVariable>
}
