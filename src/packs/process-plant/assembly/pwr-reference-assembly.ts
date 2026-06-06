import { z } from 'zod'
import {
  plantGraphSpecSchema,
  processPlantDisplayProfileSchema,
  type ComponentInstanceSpec,
  type ConnectionSpec,
  type PlantGraphSpec,
  type ProcessGraphMetadata,
  type ProcessPlantDisplayField,
  type ProcessPlantDisplayGroup,
  type ProcessPlantDisplayProfile,
  type VariablePath,
} from '../graph/index.ts'
import { pressurizedWaterReactorSixLoopPlantSpec } from '../specs/pressurized-water-reactor-6-loop.ts'
import {
  composePlantGraph,
  instantiateGraphFragment,
  type GraphFragmentInstance,
  type GraphFragmentSpec,
  type GraphFragmentSubstitution,
} from './graph-fragment.ts'

export const processPlantPwrReferenceAssemblyRef = 'process-plant.pwr.reference.v2'
export const processPlantPwrReferenceLoopTemplateFragmentRef = 'process-plant.pwr.reference.loop-template-fragment.v2'
export const processPlantPwrReferenceLoopInstancePresetRef = 'process-plant.pwr.reference.loop-instance.v2'
export const processPlantPwrReferenceBaseFragmentRefForLoopCount = (loopCount: number): string =>
  `process-plant.pwr.reference.${loopCount}-loop.base-fragment.v2`

const defaultLoopIds = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const templateLoopId = 'A'
const defaultDisplayLoopCount = 2
const safetyTrainIds = ['A', 'B'] as const

const loopIdSchema = z.string().regex(/^[A-Z]$/, 'PWR reference assembly loop ids must be single uppercase letters')
type SafetyTrainId = (typeof safetyTrainIds)[number]

const pwrReferenceAssemblyConfigSchema = z.object({
  loopCount: z.number().int().min(2).max(defaultLoopIds.length),
  loopIds: z.array(loopIdSchema).min(2).max(defaultLoopIds.length).optional(),
  title: z.string().min(1).optional(),
}).strict().superRefine((config, ctx) => {
  if (config.loopIds !== undefined && config.loopIds.length !== config.loopCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['loopIds'],
      message: 'loopIds length must match loopCount',
    })
  }
  const loopIds = config.loopIds ?? defaultLoopIds.slice(0, config.loopCount)
  if (new Set(loopIds).size !== loopIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['loopIds'],
      message: 'loopIds must be unique',
    })
  }
})

type PwrReferenceAssemblyConfig = z.infer<typeof pwrReferenceAssemblyConfigSchema>

const pwrReferenceLoopInstancePresetConfigSchema = z.object({
  loopId: loopIdSchema,
  loopIds: z.array(loopIdSchema).min(2).max(defaultLoopIds.length).optional(),
  loopCount: z.number().int().min(2).max(defaultLoopIds.length).optional(),
}).strict().superRefine((config, ctx) => {
  if (config.loopIds !== undefined && new Set(config.loopIds).size !== config.loopIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['loopIds'],
      message: 'loopIds must be unique',
    })
  }
  if (config.loopIds !== undefined && config.loopCount !== undefined && config.loopIds.length !== config.loopCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['loopIds'],
      message: 'loopIds length must match loopCount',
    })
  }
  const resolvedLoopIds = config.loopIds ?? defaultLoopIds.slice(0, config.loopCount ?? Math.max(2, defaultLoopIds.indexOf(config.loopId) + 1))
  if (!resolvedLoopIds.includes(config.loopId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['loopId'],
      message: 'loopId must be included in the resolved loopIds',
    })
  }
})

type PwrReferenceLoopInstancePresetConfig = z.infer<typeof pwrReferenceLoopInstancePresetConfigSchema>

const loopIdsForInstancePreset = (
  config: PwrReferenceLoopInstancePresetConfig,
): ReadonlyArray<string> =>
  config.loopIds ?? defaultLoopIds.slice(0, config.loopCount ?? Math.max(2, defaultLoopIds.indexOf(config.loopId) + 1))

const componentLoopId = (component: Pick<ComponentInstanceSpec, 'id'>): string | null => {
  const match = /^(sg|rcp|feedwaterControlValve|auxFeedwaterValve|mainSteamIsolationValve|safetyAccumulator)([A-Z])$/.exec(String(component.id))
  return match?.[2] ?? null
}

const componentIdFromPortRef = (ref: string): string => {
  const separatorIndex = ref.lastIndexOf('.')
  return separatorIndex < 0 ? ref : ref.slice(0, separatorIndex)
}

const idHasLoopToken = (id: string, loopId: string): boolean => {
  const lower = loopId.toLowerCase()
  return id.includes(`hot-leg-${lower}`) || id.includes(`cold-leg-${lower}`)
}

const buildComponentLoopMap = (components: ReadonlyArray<ComponentInstanceSpec>): ReadonlyMap<string, string> =>
  new Map(components.flatMap(component => {
    const loopId = componentLoopId(component)
    return loopId === null ? [] : [[String(component.id), loopId]]
  }))

const connectionLoopId = (
  connection: Pick<ConnectionSpec, 'id' | 'from' | 'to'>,
  componentLoopById: ReadonlyMap<string, string>,
): string | null => {
  const fromLoopId = componentLoopById.get(componentIdFromPortRef(String(connection.from)))
  if (fromLoopId !== undefined) return fromLoopId
  const toLoopId = componentLoopById.get(componentIdFromPortRef(String(connection.to)))
  if (toLoopId !== undefined) return toLoopId
  for (const loopId of defaultLoopIds) {
    if (idHasLoopToken(String(connection.id), loopId)) return loopId
  }
  return null
}

const loopMetadata = (
  loopIds: ReadonlyArray<string>,
  loopId: string,
  metadata: ProcessGraphMetadata | undefined,
): ProcessGraphMetadata => ({
  ...metadata,
  groupId: 'primary-loop',
  loopId,
  ordinal: loopIds.indexOf(loopId),
})

const componentMetadata = (
  loopIds: ReadonlyArray<string>,
  component: ComponentInstanceSpec,
  loopId: string,
): ProcessGraphMetadata => {
  const base = loopMetadata(loopIds, loopId, component.metadata)
  if (component.kind === 'steamGenerator') return { ...base, role: 'heat-sink', equipmentClass: 'steam-generator' }
  if (component.kind === 'centrifugalPump') return { ...base, role: 'primary-pump', equipmentClass: 'reactor-coolant-pump' }
  if (component.kind === 'steamValve') return { ...base, role: 'steam-isolation', equipmentClass: 'main-steam-isolation-valve' }
  if (component.kind === 'accumulator') return { ...base, role: 'safety-injection-source', equipmentClass: 'accumulator' }
  if (component.kind === 'processValve') return { ...base, role: 'loop-control-valve', equipmentClass: 'process-valve' }
  return base
}

const trainIdForLoop = (loopIds: ReadonlyArray<string>, loopId: string): SafetyTrainId =>
  loopIds.indexOf(loopId) % safetyTrainIds.length === 0 ? 'A' : 'B'

const loopSubstitutions = (
  loopIds: ReadonlyArray<string>,
  loopId: string,
): ReadonlyArray<GraphFragmentSubstitution> => {
  const lower = loopId.toLowerCase()
  const ordinal = String(loopIds.indexOf(loopId) + 1)
  return [
    { from: 'feedwaterControlValveA', to: `feedwaterControlValve${loopId}` },
    { from: 'auxFeedwaterValveA', to: `auxFeedwaterValve${loopId}` },
    { from: 'mainSteamIsolationValveA', to: `mainSteamIsolationValve${loopId}` },
    { from: 'safetyAccumulatorA', to: `safetyAccumulator${loopId}` },
    { from: 'sgA', to: `sg${loopId}` },
    { from: 'rcpA', to: `rcp${loopId}` },
    { from: 'hotLegA', to: `hotLeg${loopId}` },
    { from: 'coldLegA', to: `coldLeg${loopId}` },
    { from: 'inletA', to: `inlet${loopId}` },
    { from: 'outletA', to: `outlet${loopId}` },
    { from: 'SG-A', to: `SG-${loopId}` },
    { from: 'RCP-A', to: `RCP-${loopId}` },
    { from: 'MFW-A', to: `MFW-${loopId}` },
    { from: 'AFW-A', to: `AFW-${loopId}` },
    { from: 'MSIV-A', to: `MSIV-${loopId}` },
    { from: 'RCP-1', to: `RCP-${ordinal}` },
    { from: 'ACCUM-1', to: `ACCUM-${ordinal}` },
    { from: 'TE-411', to: `TE-4${ordinal}1` },
    { from: 'secondary.sg.a', to: `secondary.sg.${lower}` },
    { from: 'secondary.mfw.a', to: `secondary.mfw.${lower}` },
    { from: 'secondary.msiv.a', to: `secondary.msiv.${lower}` },
    { from: 'afw.a', to: `afw.${lower}` },
    { from: 'rcs.rcp.1', to: `rcs.rcp.${ordinal}` },
    { from: 'rcs.loop1', to: `rcs.loop${ordinal}` },
    { from: 'ess.accumulator.1', to: `ess.accumulator.${ordinal}` },
    { from: 'loop 1', to: `loop ${ordinal}` },
    { from: 'sg-a', to: `sg-${lower}` },
    { from: 'rcp-a', to: `rcp-${lower}` },
    { from: 'hot-leg-a', to: `hot-leg-${lower}` },
    { from: 'cold-leg-a', to: `cold-leg-${lower}` },
    { from: 'control-valve-a', to: `control-valve-${lower}` },
    { from: 'valve-a', to: `valve-${lower}` },
    { from: 'msiv-a', to: `msiv-${lower}` },
    { from: '.a.', to: `.${lower}.` },
    { from: ' A', to: ` ${loopId}` },
  ]
}

const addSharedLoopParameters = (component: ComponentInstanceSpec, loopIds: ReadonlyArray<string>): ComponentInstanceSpec => {
  const parameters = component.parameters && typeof component.parameters === 'object' && !Array.isArray(component.parameters)
    ? component.parameters as Record<string, unknown>
    : {}
  if (component.id === 'core') {
    return { ...component, parameters: { ...parameters, primaryLoopIds: loopIds } }
  }
  if (
    component.id === 'feedwaterHeader'
    || component.id === 'mainSteamHeader'
    || component.id === 'auxFeedwaterHeader'
    || component.id === 'safetyInjectionHeader'
  ) {
    return { ...component, parameters: { ...parameters, portIds: loopIds } }
  }
  return component
}

const buildConnectionLoopMap = (
  connections: ReadonlyArray<ConnectionSpec>,
  componentLoopById: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> =>
  new Map(connections.flatMap(connection => {
    const loopId = connectionLoopId(connection, componentLoopById)
    return loopId === null ? [] : [[String(connection.id), loopId] as const]
  }))

const publishedPathLoopId = (
  path: string,
  componentLoopById: ReadonlyMap<string, string>,
  connectionLoopById: ReadonlyMap<string, string>,
): string | null => {
  const ownerId = path.slice(0, path.indexOf('.'))
  return componentLoopById.get(ownerId) ?? connectionLoopById.get(ownerId) ?? null
}

const loopOwnedFragment = (
  graph: PlantGraphSpec,
  loopId: string,
): Required<GraphFragmentSpec> => {
  const componentLoopById = buildComponentLoopMap(graph.components)
  const connectionLoopById = buildConnectionLoopMap(graph.connections, componentLoopById)
  return {
    components: graph.components.filter(component => componentLoopId(component) === loopId),
    connections: graph.connections.filter(connection => connectionLoopById.get(String(connection.id)) === loopId),
    publishedVariables: graph.publishedVariables.filter(path => publishedPathLoopId(String(path), componentLoopById, connectionLoopById) === loopId),
    displayProfiles: [],
  }
}

const withLoopMetadata = (
  fragment: Required<GraphFragmentSpec>,
  loopIds: ReadonlyArray<string>,
  loopId: string,
): Required<GraphFragmentSpec> => ({
  ...fragment,
  components: fragment.components.map(component => ({
    ...component,
    parameters: component.parameters && typeof component.parameters === 'object' && !Array.isArray(component.parameters)
      ? {
          ...(component.parameters as Record<string, unknown>),
          ...((component.parameters as Record<string, unknown>).primaryLoopId === undefined ? {} : { primaryLoopId: loopId }),
        }
      : component.parameters,
    metadata: componentMetadata(loopIds, component, loopId),
  })),
  connections: fragment.connections.map(connection => ({
    ...connection,
    metadata: loopMetadata(loopIds, loopId, connection.metadata),
  })),
})

const safetyTrainConnectionOverlay = (
  loopIds: ReadonlyArray<string>,
  loopId: string,
) => {
  const trainId = trainIdForLoop(loopIds, loopId)
  const trainLower = trainId.toLowerCase()
  return {
    id: `safety-bus-a-to-rcp${loopId}`,
    nextId: `safety-bus-${trainLower}-to-rcp${loopId}`,
    from: `safetyBus${trainId}.outlet`,
  }
}

const pwrReferenceLoopInstancePreset = (input: unknown): GraphFragmentInstance => {
  const config = pwrReferenceLoopInstancePresetConfigSchema.parse(input)
  const loopIds = loopIdsForInstancePreset(config)
  return {
    substitutions: loopSubstitutions(loopIds, config.loopId),
    componentMetadata: loopMetadata(loopIds, config.loopId, undefined),
    connectionMetadata: loopMetadata(loopIds, config.loopId, undefined),
    componentOverlays: [{
      id: `rcp${config.loopId}`,
      parameters: {
        primaryLoopId: config.loopId,
      },
    }],
    connectionOverlays: [safetyTrainConnectionOverlay(loopIds, config.loopId)],
  }
}

const baseGraphWithoutLoopFragments = (
  sourceGraph: PlantGraphSpec,
): PlantGraphSpec => {
  const componentLoopById = buildComponentLoopMap(sourceGraph.components)
  const connectionLoopById = buildConnectionLoopMap(sourceGraph.connections, componentLoopById)
  return plantGraphSpecSchema.parse({
    ...sourceGraph,
    components: sourceGraph.components
      .filter(component => componentLoopId(component) === null),
    connections: sourceGraph.connections
      .filter(connection => connectionLoopById.get(String(connection.id)) === undefined),
    publishedVariables: sourceGraph.publishedVariables
      .filter(path => publishedPathLoopId(String(path), componentLoopById, connectionLoopById) === null),
    displayProfiles: [],
  })
}

const instantiateLoopFragment = (
  template: Required<GraphFragmentSpec>,
  loopIds: ReadonlyArray<string>,
  loopId: string,
): Required<GraphFragmentSpec> => {
  const instantiated = instantiateGraphFragment(template, {
    substitutions: loopSubstitutions(loopIds, loopId),
    connectionOverlays: [safetyTrainConnectionOverlay(loopIds, loopId)],
  })
  return withLoopMetadata(instantiated, loopIds, loopId)
}

const loopTemplateDisplayFields = (
  sourceGraph: PlantGraphSpec,
): ReadonlyMap<string, ReadonlyArray<ProcessPlantDisplayField>> => {
  const componentLoopById = buildComponentLoopMap(sourceGraph.components)
  const connectionLoopById = buildConnectionLoopMap(sourceGraph.connections, componentLoopById)
  const entries = sourceGraph.displayProfiles.flatMap(profile =>
    profile.groups.flatMap(group => {
      const fields = group.fields.filter(field => publishedPathLoopId(String(field.path), componentLoopById, connectionLoopById) === templateLoopId)
      return fields.length === 0 ? [] : [[`${profile.id}/${group.id}`, fields] as const]
    }),
  )
  return new Map(entries)
}

const instantiateDisplayField = (
  field: ProcessPlantDisplayField,
  loopIds: ReadonlyArray<string>,
  loopId: string,
): ProcessPlantDisplayField => {
  const profile = processPlantDisplayProfileSchema.parse({
    id: 'single-field-profile',
    label: 'Single field profile',
    groups: [{
      id: 'single-field-group',
      label: 'Single field group',
      fields: [field],
    }],
  })
  const instantiated = instantiateGraphFragment({
    components: [],
    connections: [],
    publishedVariables: [],
    displayProfiles: [profile],
  }, { substitutions: loopSubstitutions(loopIds, loopId) })
  return instantiated.displayProfiles[0]!.groups[0]!.fields[0]!
}

const displayProfilesFor = (
  sourceGraph: PlantGraphSpec,
  loopIds: ReadonlyArray<string>,
  displayLoopIds: ReadonlyArray<string>,
): ReadonlyArray<ProcessPlantDisplayProfile> => {
  const componentLoopById = buildComponentLoopMap(sourceGraph.components)
  const connectionLoopById = buildConnectionLoopMap(sourceGraph.connections, componentLoopById)
  const templateFieldsByGroup = loopTemplateDisplayFields(sourceGraph)
  return sourceGraph.displayProfiles.map((profile): ProcessPlantDisplayProfile => ({
    ...profile,
    groups: profile.groups.map((group): ProcessPlantDisplayGroup => {
      const baseFields = group.fields.filter(field => publishedPathLoopId(String(field.path), componentLoopById, connectionLoopById) === null)
      const templateFields = templateFieldsByGroup.get(`${profile.id}/${group.id}`) ?? []
      return {
        ...group,
        fields: [
          ...baseFields,
          ...displayLoopIds.flatMap(loopId => templateFields.map(field => instantiateDisplayField(field, loopIds, loopId))),
        ],
      }
    }).filter(group => group.fields.length > 0),
  })).filter(profile => profile.groups.length > 0)
}

const displayLoopIdsFor = (
  loopIds: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  loopIds.slice(0, Math.min(loopIds.length, defaultDisplayLoopCount))

const pwrReferenceSourceGraph = (): PlantGraphSpec =>
  structuredClone(pressurizedWaterReactorSixLoopPlantSpec) as PlantGraphSpec

const graphFragmentFromGraph = (graph: PlantGraphSpec): Required<GraphFragmentSpec> => ({
  components: graph.components,
  connections: graph.connections,
  publishedVariables: graph.publishedVariables,
  displayProfiles: graph.displayProfiles,
})

const pwrReferenceBaseFragmentForLoopIds = (
  loopIds: ReadonlyArray<string>,
): Required<GraphFragmentSpec> => {
  const base = baseGraphWithoutLoopFragments(pwrReferenceSourceGraph())
  return graphFragmentFromGraph(plantGraphSpecSchema.parse({
    ...base,
    components: base.components.map(component => addSharedLoopParameters(component, loopIds)),
  }))
}

const pwrReferenceLoopTemplateFragment = (): Required<GraphFragmentSpec> =>
  loopOwnedFragment(pwrReferenceSourceGraph(), templateLoopId)

const pwrReferenceBaseGraphForLoopIds = (
  sourceGraph: PlantGraphSpec,
  loopIds: ReadonlyArray<string>,
): PlantGraphSpec => {
  const fragment = pwrReferenceBaseFragmentForLoopIds(loopIds)
  return plantGraphSpecSchema.parse({
    ...sourceGraph,
    components: fragment.components,
    connections: fragment.connections,
    publishedVariables: fragment.publishedVariables,
    displayProfiles: fragment.displayProfiles,
  })
}

export const pwrReferenceGraphFragmentEntries: ReadonlyArray<{
  readonly ref: string
  readonly fragment: () => GraphFragmentSpec
}> = [
  {
    ref: processPlantPwrReferenceLoopTemplateFragmentRef,
    fragment: pwrReferenceLoopTemplateFragment,
  },
  ...defaultLoopIds.slice(1).map((_, index) => {
    const loopCount = index + 2
    return {
      ref: processPlantPwrReferenceBaseFragmentRefForLoopCount(loopCount),
      fragment: () => pwrReferenceBaseFragmentForLoopIds(defaultLoopIds.slice(0, loopCount)),
    }
  }),
]

export const pwrReferenceGraphFragmentInstancePresetEntries: ReadonlyArray<{
  readonly ref: string
  readonly instance: (config: unknown) => GraphFragmentInstance
}> = [{
  ref: processPlantPwrReferenceLoopInstancePresetRef,
  instance: pwrReferenceLoopInstancePreset,
}]

export const assemblePwrReferencePlantGraph = (input: unknown): PlantGraphSpec => {
  const config: PwrReferenceAssemblyConfig = pwrReferenceAssemblyConfigSchema.parse(input)
  const loopIds = config.loopIds ?? defaultLoopIds.slice(0, config.loopCount)
  const displayLoopIds = displayLoopIdsFor(loopIds)
  const sourceGraph = pwrReferenceSourceGraph()
  const baseGraph = pwrReferenceBaseGraphForLoopIds(sourceGraph, loopIds)
  const template = pwrReferenceLoopTemplateFragment()
  const loopFragments = loopIds.map(loopId => instantiateLoopFragment(template, loopIds, loopId))

  return composePlantGraph({
    base: baseGraph,
    id: `process-plant.pressurized-water-reactor-${loopIds.length}-loop.assembled.v2`,
    title: config.title ?? `Reference PWR ${loopIds.length}-loop plant`,
    fragments: loopFragments,
    displayProfiles: displayProfilesFor(sourceGraph, loopIds, displayLoopIds),
  })
}
