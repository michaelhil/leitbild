import { z } from 'zod'
import {
  compilePlantGraph,
  assertPrimaryLoopTopologyValid,
  plantGraphSpecSchema,
  processVariableValueSchema,
  type CompiledPlantGraph,
  type ComponentId,
  type PlantGraphSpec,
  type ProcessVariableValue,
  type VariablePath,
} from './graph/index.ts'
import { processPlantComponentRegistry } from './graph/index.ts'
import { resolveProcessPlantAssemblySpec } from './assembly/index.ts'
import { resolveProcessPlantGraphSpec } from './specs/index.ts'
import { assertProcessPlantVariableValueValid } from './runtime/variable-validation.ts'

export interface ProcessPlantInitialVariableValue {
  readonly path: VariablePath
  readonly value: ProcessVariableValue
}

export const processPlantSystemDefinitionSchema = z.object({
  id: z.string().min(1),
  graph: z.unknown().optional(),
  graphRef: z.string().min(1).optional(),
  assemblyRef: z.string().min(1).optional(),
  assemblyConfig: z.record(z.string(), z.unknown()).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  initialState: z.record(z.string(), z.unknown()).optional(),
  runtime: z.unknown().optional(),
}).strict().superRefine((definition, ctx) => {
  const sourceCount = [definition.graph, definition.graphRef, definition.assemblyRef]
    .filter(value => value !== undefined).length
  if (sourceCount !== 1) ctx.addIssue({ code: 'custom', message: 'process system must define exactly one of graph, graphRef, or assemblyRef' })
  if (definition.assemblyConfig !== undefined && definition.assemblyRef === undefined) {
    ctx.addIssue({ code: 'custom', path: ['assemblyConfig'], message: 'process system assemblyConfig requires assemblyRef' })
  }
})

export type ProcessPlantSystemDefinition = z.infer<typeof processPlantSystemDefinitionSchema>

export const processPlantPackConfigSchema = z.object({
  systems: z.array(processPlantSystemDefinitionSchema).default([]),
}).strict()
export type ProcessPlantPackConfig = z.infer<typeof processPlantPackConfigSchema>

export interface CompiledProcessPlantSystem {
  readonly id: string
  readonly componentLibrary: 'process-plant'
  readonly sourceGraph: PlantGraphSpec
  readonly graph: CompiledPlantGraph
  readonly initialState: ReadonlyArray<ProcessPlantInitialVariableValue>
}

const cloneGraphSpec = (input: unknown): PlantGraphSpec =>
  plantGraphSpecSchema.parse(input)

const assertObject = (value: unknown, context: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`)
  return value as Record<string, unknown>
}

const applyComponentParameterOverlays = (
  graph: PlantGraphSpec,
  overlays: Record<string, unknown> | undefined,
): PlantGraphSpec => {
  if (overlays === undefined) return graph
  const overlayEntries = Object.entries(overlays)
  const componentIds = new Set(graph.components.map(component => component.id))
  for (const [componentId, overlay] of overlayEntries) {
    if (!componentIds.has(componentId as ComponentId)) throw new Error(`process system parameter overlay references unknown component: ${componentId}`)
    assertObject(overlay, `process system parameter overlay for component ${componentId}`)
  }
  return {
    ...graph,
    components: graph.components.map(component => {
      const overlay = overlays[component.id]
      if (overlay === undefined) return component
      return {
        ...component,
        parameters: {
          ...assertObject(component.parameters, `component ${component.id} parameters`),
          ...assertObject(overlay, `process system parameter overlay for component ${component.id}`),
        },
      }
    }),
  }
}

const parseInitialState = (
  input: Record<string, unknown> | undefined,
): ReadonlyArray<ProcessPlantInitialVariableValue> => {
  if (input === undefined) return []
  return Object.entries(input).map(([path, value]) => ({
    path: path as VariablePath,
    value: processVariableValueSchema.parse(value),
  }))
}

const assertInitialStateTargetsDeclaredVariables = (
  graph: CompiledPlantGraph,
  initialState: ReadonlyArray<ProcessPlantInitialVariableValue>,
): void => {
  const variableByPath = new Map(graph.variables.map(variable => [variable.path, variable]))
  for (const initial of initialState) {
    const variable = variableByPath.get(initial.path)
    if (!variable) throw new Error(`process plant initialState references unknown variable: ${initial.path}`)
    try {
      assertProcessPlantVariableValueValid(variable, initial.value)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(message.replace(`process plant variable ${initial.path}`, `process plant initialState for ${initial.path}`))
    }
  }
}

const graphSourceFor = (definition: ProcessPlantSystemDefinition): unknown => {
  if (definition.assemblyRef !== undefined) {
    return resolveProcessPlantAssemblySpec(definition.assemblyRef, definition.assemblyConfig ?? {})
  }
  return definition.graphRef === undefined ? definition.graph : resolveProcessPlantGraphSpec(definition.graphRef)
}

export const compileProcessPlantSystem = (
  definition: ProcessPlantSystemDefinition,
): CompiledProcessPlantSystem => {
  const graph = applyComponentParameterOverlays(
    cloneGraphSpec(graphSourceFor(definition)),
    definition.parameters,
  )
  const compiledGraph = compilePlantGraph(graph, processPlantComponentRegistry)
  assertPrimaryLoopTopologyValid(compiledGraph)
  const initialState = parseInitialState(definition.initialState)
  assertInitialStateTargetsDeclaredVariables(compiledGraph, initialState)
  return {
    id: definition.id,
    componentLibrary: 'process-plant',
    sourceGraph: graph,
    graph: compiledGraph,
    initialState,
  }
}

export const compileProcessPlantSystems = (
  definitions: ReadonlyArray<ProcessPlantSystemDefinition>,
): ReadonlyArray<CompiledProcessPlantSystem> => {
  const systems = definitions.map(compileProcessPlantSystem)
  const ids = new Set<string>()
  for (const system of systems) {
    if (ids.has(system.id)) throw new Error(`duplicate process plant system id: ${system.id}`)
    ids.add(system.id)
  }
  return systems
}
