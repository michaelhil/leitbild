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
import { resolveProcessPlantGraphFragmentSpec } from './graph-fragment-catalog.ts'

export const processPlantModularGraphAssemblyRef = 'process-plant.graph.compose.v1'

const namedGraphFragmentSchema = z.object({
  id: z.string().min(1),
  fragment: graphFragmentSpecSchema.optional(),
  fragmentRef: z.string().min(1).optional(),
}).strict().superRefine((fragment, ctx) => {
  const sourceCount = [fragment.fragment !== undefined, fragment.fragmentRef !== undefined].filter(Boolean).length
  if (sourceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: sourceCount > 1 ? ['fragmentRef'] : ['fragment'],
      message: 'modular graph fragment must define exactly one of fragment or fragmentRef',
    })
  }
})

const graphFragmentInstanceConfigSchema = graphFragmentInstanceSchema.extend({
  fragmentRef: z.string().min(1),
}).strict()

const modularGraphAssemblyConfigSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  fixedStepMs: z.number().int().positive().max(10_000).optional(),
  baseGraph: plantGraphSpecSchema.optional(),
  baseGraphRef: z.string().min(1).optional(),
  baseFragment: graphFragmentSpecSchema.optional(),
  baseFragmentRef: z.string().min(1).optional(),
  baseOverlays: graphFragmentInstanceSchema.optional(),
  fragments: z.array(namedGraphFragmentSchema).default([]),
  instances: z.array(graphFragmentInstanceConfigSchema).default([]),
  publishedVariables: z.array(variablePathSchema).optional(),
  displayProfiles: z.array(processPlantDisplayProfileSchema).optional(),
}).strict().superRefine((config, ctx) => {
  const baseSourceCount = [
    config.baseGraph !== undefined,
    config.baseGraphRef !== undefined,
    config.baseFragment !== undefined,
    config.baseFragmentRef !== undefined,
  ].filter(Boolean).length
  if (baseSourceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: baseSourceCount > 1 ? ['baseGraphRef'] : ['baseGraph'],
      message: 'modular graph assembly must define exactly one of baseGraph, baseGraphRef, baseFragment, or baseFragmentRef',
    })
  }
  const usesBaseFragment = config.baseFragment !== undefined || config.baseFragmentRef !== undefined
  if (usesBaseFragment && config.fixedStepMs === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fixedStepMs'],
      message: 'modular graph assembly fixedStepMs is required when base source is a fragment',
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

const graphFromBaseFragment = (
  config: ModularGraphAssemblyConfig,
  fragment: GraphFragmentSpec,
): PlantGraphSpec =>
  plantGraphSpecSchema.parse({
    schemaVersion: 1,
    id: config.id,
    title: config.title,
    timestep: {
      fixedStepMs: config.fixedStepMs,
    },
    components: fragment.components,
    connections: fragment.connections,
    publishedVariables: fragment.publishedVariables ?? [],
    displayProfiles: fragment.displayProfiles ?? [],
  })

const graphSourceFor = (config: ModularGraphAssemblyConfig): PlantGraphSpec => {
  if (config.baseGraphRef !== undefined) return resolveProcessPlantGraphSpec(config.baseGraphRef)
  if (config.baseFragment !== undefined) return graphFromBaseFragment(config, parseGraphFragmentSpec(config.baseFragment))
  if (config.baseFragmentRef !== undefined) return graphFromBaseFragment(config, resolveProcessPlantGraphFragmentSpec(config.baseFragmentRef))
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
  new Map(fragments.map(fragment => [
    fragment.id,
    fragment.fragmentRef === undefined
      ? parseGraphFragmentSpec(fragment.fragment)
      : resolveProcessPlantGraphFragmentSpec(fragment.fragmentRef),
  ]))

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
