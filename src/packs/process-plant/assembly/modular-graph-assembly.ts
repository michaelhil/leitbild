import { z } from 'zod'
import {
  plantGraphSpecSchema,
  processPlantDisplayProfileSchema,
  variablePathSchema,
  type PlantGraphSpec,
} from '../graph/index.ts'
import { resolveProcessPlantGraphSpec } from '../specs/index.ts'
import {
  composePlantGraph,
  graphFragmentInstanceSchema,
  graphFragmentSpecSchema,
  instantiateGraphFragment,
  parseGraphFragmentInstance,
  parseGraphFragmentSpec,
  type GraphFragmentInstance,
  type GraphFragmentSpec,
} from './graph-fragment.ts'

export const processPlantModularGraphAssemblyRef = 'process-plant.graph.compose.v1'

const namedGraphFragmentSchema = z.object({
  id: z.string().min(1),
  fragment: graphFragmentSpecSchema,
}).strict()

const graphFragmentInstanceConfigSchema = graphFragmentInstanceSchema.extend({
  fragmentRef: z.string().min(1),
}).strict()

const modularGraphAssemblyConfigSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  baseGraph: plantGraphSpecSchema.optional(),
  baseGraphRef: z.string().min(1).optional(),
  baseOverlays: graphFragmentInstanceSchema.optional(),
  fragments: z.array(namedGraphFragmentSchema).default([]),
  instances: z.array(graphFragmentInstanceConfigSchema).default([]),
  publishedVariables: z.array(variablePathSchema).optional(),
  displayProfiles: z.array(processPlantDisplayProfileSchema).optional(),
}).strict().superRefine((config, ctx) => {
  const baseSourceCount = [config.baseGraph !== undefined, config.baseGraphRef !== undefined].filter(Boolean).length
  if (baseSourceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: baseSourceCount > 1 ? ['baseGraphRef'] : ['baseGraph'],
      message: 'modular graph assembly must define exactly one of baseGraph or baseGraphRef',
    })
  }
  const fragmentIds = new Set<string>()
  for (const fragment of config.fragments) {
    if (fragmentIds.has(fragment.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fragments'],
        message: `duplicate modular graph fragment id: ${fragment.id}`,
      })
    }
    fragmentIds.add(fragment.id)
  }
  for (const instance of config.instances) {
    if (!fragmentIds.has(instance.fragmentRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instances'],
        message: `modular graph instance references unknown fragment: ${instance.fragmentRef}`,
      })
    }
  }
})

type ModularGraphAssemblyConfig = z.infer<typeof modularGraphAssemblyConfigSchema>

const graphSourceFor = (config: ModularGraphAssemblyConfig): PlantGraphSpec => {
  if (config.baseGraphRef !== undefined) return resolveProcessPlantGraphSpec(config.baseGraphRef)
  return plantGraphSpecSchema.parse(config.baseGraph)
}

const asFragment = (graph: PlantGraphSpec): Required<GraphFragmentSpec> => ({
  components: graph.components,
  connections: graph.connections,
  publishedVariables: graph.publishedVariables,
  displayProfiles: graph.displayProfiles,
})

const applyBaseOverlays = (
  graph: PlantGraphSpec,
  overlays: GraphFragmentInstance | undefined,
): PlantGraphSpec => {
  if (overlays === undefined) return graph
  const fragment = instantiateGraphFragment(asFragment(graph), overlays)
  return plantGraphSpecSchema.parse({
    ...graph,
    components: fragment.components,
    connections: fragment.connections,
    publishedVariables: fragment.publishedVariables,
    displayProfiles: fragment.displayProfiles,
  })
}

const fragmentById = (
  fragments: ReadonlyArray<ModularGraphAssemblyConfig['fragments'][number]>,
): ReadonlyMap<string, GraphFragmentSpec> =>
  new Map(fragments.map(fragment => [fragment.id, parseGraphFragmentSpec(fragment.fragment)]))

const instantiateFragments = (
  config: ModularGraphAssemblyConfig,
): ReadonlyArray<Required<GraphFragmentSpec>> => {
  const fragments = fragmentById(config.fragments)
  return config.instances.map(instance => {
    const fragment = fragments.get(instance.fragmentRef)
    if (fragment === undefined) throw new Error(`modular graph instance references unknown fragment: ${instance.fragmentRef}`)
    const { fragmentRef: _fragmentRef, ...fragmentInstance } = instance
    return instantiateGraphFragment(fragment, parseGraphFragmentInstance(fragmentInstance))
  })
}

export const assembleModularPlantGraph = (input: unknown): PlantGraphSpec => {
  const config = modularGraphAssemblyConfigSchema.parse(input)
  const base = applyBaseOverlays(
    graphSourceFor(config),
    config.baseOverlays === undefined ? undefined : parseGraphFragmentInstance(config.baseOverlays),
  )
  const fragments = instantiateFragments(config)
  return composePlantGraph({
    base,
    id: config.id,
    title: config.title,
    fragments,
    ...(config.publishedVariables === undefined ? {} : { publishedVariables: config.publishedVariables }),
    ...(config.displayProfiles === undefined ? {} : { displayProfiles: config.displayProfiles }),
  })
}
