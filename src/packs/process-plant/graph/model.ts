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
export type ConnectionService = Brand<string, 'ProcessPlantConnectionService'>
export type ProcessVariableValue = number | boolean

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

export const connectionKindSchema = z.enum([
  'fluidFlow',
  'thermalContact',
  'electricalPower',
  'mechanicalTorque',
  'controlSignal',
  'logicSignal',
])
export type ConnectionKind = z.infer<typeof connectionKindSchema>

export const fluidKindSchema = z.enum(['water', 'steam', 'air', 'oil', 'generic'])
export type FluidKind = z.infer<typeof fluidKindSchema>

export const designPhaseSchema = z.enum(['liquid', 'steam', 'gas', 'twoPhase'])
export type DesignPhase = z.infer<typeof designPhaseSchema>

export const fluidSolverModelSchema = z.enum(['incompressibleLiquid', 'compressibleSteam', 'twoPhaseApprox', 'sourceSink'])
export type FluidSolverModel = z.infer<typeof fluidSolverModelSchema>

export const connectionServiceSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .transform(value => value as ConnectionService)

export const variableKindSchema = z.enum(['state', 'derived', 'control', 'parameter', 'alarm', 'discrete'])
export type VariableKind = z.infer<typeof variableKindSchema>

export const variableDomainSchema = z.enum(['hydraulic', 'thermal', 'nuclear', 'electrical', 'control', 'operator', 'radiological'])
export type VariableDomain = z.infer<typeof variableDomainSchema>

export const variablePublishPolicySchema = z.enum(['internal', 'telemetry', 'alarm', 'leitbild'])
export type VariablePublishPolicy = z.infer<typeof variablePublishPolicySchema>

export const processQuantitySchema = z.enum([
  'boolean',
  'energyPerMass',
  'flowRate',
  'head',
  'mass',
  'massDelta',
  'power',
  'pressure',
  'pressureDelta',
  'radiationDoseRate',
  'ratio',
  'reactivity',
  'temperature',
])
export type ProcessQuantity = z.infer<typeof processQuantitySchema>

export const processUnitSchema = z.enum([
  'boolean',
  'degC',
  'fraction',
  'kg',
  'kJ/kg',
  'kg/s',
  'MPa',
  'mSv/h',
  'MW',
  'Pa',
  'pcm',
  'percent',
])
export type ProcessUnit = z.infer<typeof processUnitSchema>

const allowedUnitsByQuantity: Readonly<Record<ProcessQuantity, ReadonlySet<ProcessUnit>>> = {
  boolean: new Set(['boolean']),
  energyPerMass: new Set(['kJ/kg']),
  flowRate: new Set(['kg/s']),
  head: new Set(['Pa']),
  mass: new Set(['kg']),
  massDelta: new Set(['kg']),
  power: new Set(['MW']),
  pressure: new Set(['MPa', 'Pa']),
  pressureDelta: new Set(['MPa', 'Pa']),
  radiationDoseRate: new Set(['mSv/h']),
  ratio: new Set(['fraction', 'percent']),
  reactivity: new Set(['pcm']),
  temperature: new Set(['degC']),
}

export const processVariableValueSchema = z.union([z.number().finite(), z.boolean()])

export const portDefinitionSchema = z.object({
  kind: portKindSchema,
  direction: portDirectionSchema,
})
export type PortDefinition = z.infer<typeof portDefinitionSchema>

const validateQuantityUnit = (
  descriptor: { readonly quantity: ProcessQuantity; readonly unit: ProcessUnit },
  ctx: z.RefinementCtx,
): void => {
  if (!allowedUnitsByQuantity[descriptor.quantity].has(descriptor.unit)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unit'],
      message: `unit ${descriptor.unit} is not valid for quantity ${descriptor.quantity}`,
    })
  }
}

const validateInitialValueType = (
  descriptor: { readonly quantity: ProcessQuantity; readonly initialValue: ProcessVariableValue },
  ctx: z.RefinementCtx,
): void => {
  if (descriptor.quantity === 'boolean') {
    if (typeof descriptor.initialValue !== 'boolean') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['initialValue'],
        message: 'boolean quantity requires a boolean initialValue',
      })
    }
    return
  }
  if (typeof descriptor.initialValue !== 'number') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialValue'],
      message: `${descriptor.quantity} quantity requires a numeric initialValue`,
    })
  }
}

const validateInitialValueBounds = (
  descriptor: { readonly quantity: ProcessQuantity; readonly unit: ProcessUnit; readonly initialValue: ProcessVariableValue },
  ctx: z.RefinementCtx,
): void => {
  if (typeof descriptor.initialValue !== 'number') return
  if (descriptor.quantity === 'ratio' && descriptor.unit === 'fraction' && (descriptor.initialValue < 0 || descriptor.initialValue > 1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialValue'],
      message: 'fraction initialValue must be between 0 and 1',
    })
  }
  if (descriptor.quantity === 'ratio' && descriptor.unit === 'percent' && (descriptor.initialValue < 0 || descriptor.initialValue > 100)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialValue'],
      message: 'percent initialValue must be between 0 and 100',
    })
  }
  if (
    (descriptor.quantity === 'flowRate'
      || descriptor.quantity === 'head'
      || descriptor.quantity === 'mass'
      || descriptor.quantity === 'power'
      || descriptor.quantity === 'pressure'
      || descriptor.quantity === 'radiationDoseRate')
    && descriptor.initialValue < 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialValue'],
      message: `${descriptor.quantity} initialValue must be non-negative`,
    })
  }
}

const variableDescriptorBaseSchema = z.object({
  path: variablePathSchema,
  label: z.string().min(1),
  kind: variableKindSchema,
  domain: variableDomainSchema,
  writable: z.boolean(),
  publish: variablePublishPolicySchema,
  quantity: processQuantitySchema,
  unit: processUnitSchema,
})
export const variableDescriptorSchema = variableDescriptorBaseSchema.superRefine(validateQuantityUnit)
export type VariableDescriptor = z.infer<typeof variableDescriptorSchema>

export const componentVariableDescriptorSchema = variableDescriptorBaseSchema.extend({
  path: localVariablePathSchema,
}).superRefine(validateQuantityUnit)
export type ComponentVariableDescriptor = z.infer<typeof componentVariableDescriptorSchema>

export const connectionPhysicalSpecSchema = z.object({
  lengthM: z.number().finite().positive().optional(),
  diameterM: z.number().finite().positive().optional(),
  roughnessM: z.number().finite().nonnegative().optional(),
  volumeM3: z.number().finite().positive().optional(),
  nominalResistance: z.number().finite().nonnegative().optional(),
  nominalFlowKgPerS: z.number().finite().positive().optional(),
  leakCoefficientKgPerSPerSqrtMPa: z.number().finite().nonnegative().optional(),
}).strict()
export type ConnectionPhysicalSpec = z.infer<typeof connectionPhysicalSpecSchema>

export const processLinkVariableDescriptorSchema = variableDescriptorBaseSchema.extend({
  path: localVariablePathSchema,
  initialValue: processVariableValueSchema,
  sensorId: idSchema.optional(),
  actuatorId: idSchema.optional(),
}).superRefine((descriptor, ctx) => {
  validateQuantityUnit(descriptor, ctx)
  validateInitialValueType(descriptor, ctx)
  validateInitialValueBounds(descriptor, ctx)
  if (descriptor.sensorId !== undefined && descriptor.actuatorId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actuatorId'],
      message: 'process link variable cannot declare both sensorId and actuatorId',
    })
  }
  if (!descriptor.writable && descriptor.actuatorId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actuatorId'],
      message: 'actuatorId requires a writable process link variable',
    })
  }
})
export type ProcessLinkVariableDescriptor = z.infer<typeof processLinkVariableDescriptorSchema>

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
  connectionKind: connectionKindSchema,
  service: connectionServiceSchema.optional(),
  nominalFluid: fluidKindSchema.optional(),
  designPhase: designPhaseSchema.optional(),
  solverModel: fluidSolverModelSchema.optional(),
  physical: connectionPhysicalSpecSchema.optional(),
  variables: z.array(processLinkVariableDescriptorSchema).default([]),
}).strict().superRefine((connection, ctx) => {
  const fluidMetadata = connection.service !== undefined
    || connection.nominalFluid !== undefined
    || connection.designPhase !== undefined
    || connection.solverModel !== undefined
  if (connection.connectionKind !== 'fluidFlow' && fluidMetadata) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connectionKind'],
      message: 'fluid metadata requires connectionKind fluidFlow',
    })
  }
  if (connection.connectionKind === 'fluidFlow' && connection.service === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['service'],
      message: 'fluidFlow connections require service',
    })
  }
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
}).strict()
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

export interface CompiledProcessLink {
  readonly index: number
  readonly id: ConnectionId
  readonly kind: ConnectionKind
  readonly fromComponentIndex: number
  readonly fromPortIndex: number
  readonly fromPortName: PortName
  readonly toComponentIndex: number
  readonly toPortIndex: number
  readonly toPortName: PortName
  readonly service?: ConnectionService
  readonly nominalFluid?: FluidKind
  readonly designPhase?: DesignPhase
  readonly solverModel?: FluidSolverModel
  readonly physical?: ConnectionPhysicalSpec
  readonly variables: ReadonlyArray<VariableDescriptor>
}

export interface CompiledVariable {
  readonly path: VariablePath
  readonly owner:
    | { readonly type: 'component'; readonly componentIndex: number }
    | { readonly type: 'link'; readonly linkIndex: number }
  readonly descriptor: VariableDescriptor
  readonly published: boolean
  readonly initialValue?: ProcessVariableValue
}

export interface CompiledPlantGraph {
  readonly specId: PlantGraphId
  readonly title: string
  readonly timestep: TimestepSpec
  readonly components: ReadonlyArray<CompiledComponent>
  readonly componentIndexById: ReadonlyMap<ComponentId, number>
  readonly links: ReadonlyArray<CompiledProcessLink>
  readonly linksByKind: Readonly<Record<ConnectionKind, ReadonlyArray<number>>>
  readonly incomingLinksByComponent: ReadonlyArray<ReadonlyArray<number>>
  readonly outgoingLinksByComponent: ReadonlyArray<ReadonlyArray<number>>
  readonly linksByService: ReadonlyMap<ConnectionService, ReadonlyArray<number>>
  readonly variables: ReadonlyArray<CompiledVariable>
}
