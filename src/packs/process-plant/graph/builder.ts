import type {
  ComponentId,
  ComponentKind,
  ComponentVariableBindingOverride,
  ComponentInstanceSpec,
  ConnectionId,
  ConnectionKind,
  ConnectionPhysicalSpec,
  ConnectionService,
  DesignPhase,
  FluidKind,
  FluidSolverModel,
  ProcessLinkVariableDescriptor,
  PlantGraphId,
  PlantGraphSpec,
  PortRef,
  VariablePath,
} from './model.ts'
import { plantGraphSpecSchema } from './model.ts'

export const component = (
  id: string,
  kind: string,
  label: string,
  parameters: unknown,
  variables: ReadonlyArray<ComponentVariableBindingOverride> = [],
): ComponentInstanceSpec => ({
  id: id as ComponentId,
  kind: kind as ComponentKind,
  label,
  parameters,
  variables: [...variables],
})

export const connect = (
  id: string,
  from: string,
  to: string,
  options: {
    readonly connectionKind?: ConnectionKind
    readonly service?: string
    readonly nominalFluid?: FluidKind
    readonly designPhase?: DesignPhase
    readonly solverModel?: FluidSolverModel
    readonly physical?: ConnectionPhysicalSpec
    readonly variables?: ReadonlyArray<ProcessLinkVariableDescriptor>
  } = {},
) => ({
  id: id as ConnectionId,
  from: from as PortRef,
  to: to as PortRef,
  connectionKind: options.connectionKind,
  ...(options.service === undefined ? {} : { service: options.service as ConnectionService }),
  ...(options.nominalFluid === undefined ? {} : { nominalFluid: options.nominalFluid }),
  ...(options.designPhase === undefined ? {} : { designPhase: options.designPhase }),
  ...(options.solverModel === undefined ? {} : { solverModel: options.solverModel }),
  ...(options.physical === undefined ? {} : { physical: options.physical }),
  ...(options.variables === undefined ? {} : { variables: options.variables }),
})

export const plantGraph = (spec: {
  readonly id: string
  readonly title: string
  readonly fixedStepMs: number
  readonly components: ReadonlyArray<ComponentInstanceSpec>
  readonly connections: ReadonlyArray<ReturnType<typeof connect>>
  readonly publishedVariables?: ReadonlyArray<string>
}): PlantGraphSpec =>
  plantGraphSpecSchema.parse({
    schemaVersion: 1,
    id: spec.id as PlantGraphId,
    title: spec.title,
    timestep: { fixedStepMs: spec.fixedStepMs },
    components: spec.components,
    connections: spec.connections,
    publishedVariables: (spec.publishedVariables ?? []).map(path => path as VariablePath),
  })
