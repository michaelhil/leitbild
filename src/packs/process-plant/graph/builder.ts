import type { ComponentId, ComponentKind, ComponentInstanceSpec, ConnectionId, ConnectionPhysicalSpec, ConnectionVariableDescriptor, EdgeKind, PlantGraphId, PlantGraphSpec, PortRef, VariablePath } from './model.ts'
import { plantGraphSpecSchema } from './model.ts'

export const component = (
  id: string,
  kind: string,
  label: string,
  parameters: unknown,
): ComponentInstanceSpec => ({
  id: id as ComponentId,
  kind: kind as ComponentKind,
  label,
  parameters,
})

export const connect = (
  id: string,
  from: string,
  to: string,
  options: {
    readonly edgeKind?: EdgeKind
    readonly medium?: string
    readonly physical?: ConnectionPhysicalSpec
    readonly variables?: ReadonlyArray<ConnectionVariableDescriptor>
  } = {},
) => ({
  id: id as ConnectionId,
  from: from as PortRef,
  to: to as PortRef,
  ...(options.edgeKind === undefined ? {} : { edgeKind: options.edgeKind }),
  ...(options.medium === undefined ? {} : { medium: options.medium }),
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
