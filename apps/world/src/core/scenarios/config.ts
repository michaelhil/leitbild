import { z } from 'zod'
import {
  geoPointFromLonLat,
  idSchema,
  interactionEndpointSchema,
  objectIdSchema,
  scenarioDefinitionSchema,
  scenarioTimelineCommandRequestSchema,
  signalIdSchema,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
  type ScenarioDefinition,
  type ScenarioTimelineAction,
  type ScenarioTimelineCue,
  type SurfaceDefinition,
  type SurfaceRegionDefinition,
} from '../model/index.ts'
import type { WorldPack, PackScenarioItemSpec, PackScenarioOperationSpec, PackScenarioItemContribution } from '../packs/protocol.ts'
import type { RoutingAdapter } from '../../routing/protocol.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const scenarioItemDraftSchema = z.object({
  pack: idSchema,
  type: z.string().min(1),
  id: objectIdSchema,
  label: z.string().min(1),
}).passthrough()

const scenarioOperationConfigSchema = z.object({
  pack: idSchema,
  type: z.string().min(1),
}).passthrough()

const scenarioGuidanceConfigSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  message: z.string().min(1),
  objectIds: z.array(objectIdSchema).default([]),
  dismissible: z.boolean().default(true),
  tone: z.enum(['default', 'update']).default('default'),
})

const scenarioTimelineActionConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('show_guidance'),
    guidance: scenarioGuidanceConfigSchema,
  }),
  z.object({
    type: z.literal('hide_guidance'),
    guidanceId: idSchema.optional(),
  }),
  z.object({
    type: z.literal('highlight_objects'),
    objectIds: z.array(objectIdSchema).min(1),
  }),
  z.object({
    type: z.literal('clear_highlights'),
    objectIds: z.array(objectIdSchema).optional(),
  }),
  z.object({
    type: z.literal('create_object'),
    object: scenarioItemDraftSchema,
  }),
  z.object({
    type: z.literal('update_object'),
    objectId: objectIdSchema,
    operation: scenarioOperationConfigSchema,
  }),
  z.object({
    type: z.literal('delete_object'),
    objectId: objectIdSchema,
  }),
  z.object({
    type: z.literal('emit_signal'),
    signal: z.object({
      id: signalIdSchema,
      source: interactionEndpointSchema,
      targets: z.array(interactionEndpointSchema),
      signalType: idSchema,
      payload: z.unknown(),
      severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
      correlationId: idSchema.optional(),
      causationId: idSchema.optional(),
      ttlMs: z.number().finite().positive().optional(),
    }).strict(),
  }),
  z.object({
    type: z.literal('issue_command'),
    command: scenarioTimelineCommandRequestSchema,
  }),
])

const scenarioTimelineCueConfigSchema = z.object({
  id: idSchema,
  at: z.object({
    kind: z.literal('after_scenario_start'),
    seconds: z.number().finite().nonnegative(),
  }),
  title: z.string().min(1).optional(),
  actions: z.array(scenarioTimelineActionConfigSchema).min(1),
})

const scenarioTimelineConfigSchema = z.object({
  cues: z.array(scenarioTimelineCueConfigSchema).default([]),
})

const surfaceMapRegionConfigSchema = z.object({
  center: lonLatSchema,
  zoom: z.number().finite().min(0).max(24),
  layers: z.array(z.enum(['objects', 'routes', 'traffic', 'weather', 'grid', 'highlights'])).default(['objects', 'routes', 'traffic', 'weather', 'grid', 'highlights']),
})

const surfaceObjectRailSectionConfigSchema = z.object({
  categoryId: idSchema,
  visible: z.boolean().default(true),
  collapsed: z.boolean().default(false),
  visibleFields: z.array(idSchema).default([]),
})

const surfaceObjectRailRegionConfigSchema = z.object({
  width: z.number().finite().min(0).max(900).optional(),
  sections: z.array(surfaceObjectRailSectionConfigSchema).default([]),
})

const surfaceRegionConfigSchema = z.discriminatedUnion('primitive', [
  z.object({
    id: idSchema,
    primitive: z.literal('map'),
    visible: z.boolean().default(true),
    config: surfaceMapRegionConfigSchema,
  }),
  z.object({
    id: idSchema,
    primitive: z.literal('objectRail'),
    visible: z.boolean().default(true),
    config: surfaceObjectRailRegionConfigSchema,
  }),
  z.object({
    id: idSchema,
    primitive: z.literal('systemFooter'),
    visible: z.boolean().default(true),
    config: z.record(z.string(), z.never()).default({}),
  }),
  z.object({
    id: idSchema,
    primitive: z.literal('guidanceOverlay'),
    visible: z.boolean().default(true),
    config: z.record(z.string(), z.never()).default({}),
  }),
])

const surfaceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  regions: z.array(surfaceRegionConfigSchema).default([]),
})

export const scenarioDraftSchema = z.object({
  id: idSchema,
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  objectives: z.array(z.string().min(1)).default([]),
  packs: z.array(idSchema).min(1),
  runtimeOverrides: z.record(z.string(), idSchema).default({}),
  world: z.object({
    startsAt: z.string().datetime(),
    environment: z.record(z.string(), z.unknown()).default({}),
  }),
  items: z.array(scenarioItemDraftSchema).default([]),
  initialContexts: z.array(z.object({
    objectId: idSchema,
    context: z.unknown(),
  })).default([]),
  processSystems: z.array(z.object({
    id: idSchema,
    pack: idSchema,
    componentLibrary: idSchema,
    graph: z.unknown().optional(),
    graphRef: idSchema.optional(),
    assemblyRef: idSchema.optional(),
    assemblyConfig: z.record(z.string(), z.unknown()).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    initialState: z.record(z.string(), z.unknown()).optional(),
  }).superRefine((definition, ctx) => {
    const sourceCount = [definition.graph, definition.graphRef, definition.assemblyRef]
      .filter(value => value !== undefined).length
    if (sourceCount !== 1) {
      ctx.addIssue({ code: 'custom', message: 'process system must define exactly one graph source' })
    }
    if (definition.assemblyConfig !== undefined && definition.assemblyRef === undefined) {
      ctx.addIssue({ code: 'custom', path: ['assemblyConfig'], message: 'assemblyConfig requires assemblyRef' })
    }
  })).default([]),
  runtimeConfigs: z.record(z.string(), z.unknown()).default({}),
  surface: surfaceConfigSchema,
  timeline: scenarioTimelineConfigSchema.optional(),
}).superRefine((draft, ctx) => {
  const packs = new Set<string>()
  draft.packs.forEach((pack, index) => {
    if (packs.has(pack)) ctx.addIssue({ code: 'custom', path: ['packs', index], message: `duplicate Pack: ${pack}` })
    packs.add(pack)
  })
  draft.items.forEach((item, index) => {
    if (!packs.has(item.pack)) ctx.addIssue({ code: 'custom', path: ['items', index, 'pack'], message: `inactive Pack: ${item.pack}` })
  })
  draft.processSystems.forEach((system, index) => {
    if (!packs.has(system.pack)) ctx.addIssue({ code: 'custom', path: ['processSystems', index, 'pack'], message: `inactive Pack: ${system.pack}` })
  })
  for (const pack of Object.keys(draft.runtimeOverrides)) {
    if (!packs.has(pack)) ctx.addIssue({ code: 'custom', path: ['runtimeOverrides', pack], message: `inactive Pack: ${pack}` })
  }
  for (const pack of Object.keys(draft.runtimeConfigs)) {
    if (!packs.has(pack)) ctx.addIssue({ code: 'custom', path: ['runtimeConfigs', pack], message: `inactive Pack: ${pack}` })
  }
  if (draft.surface.regions.filter(region => region.primitive === 'map' && region.visible).length !== 1) {
    ctx.addIssue({ code: 'custom', path: ['surface', 'regions'], message: 'Scenario Draft requires exactly one visible map region' })
  }
})

export type ScenarioDraft = z.infer<typeof scenarioDraftSchema>
export interface ScenarioTemplate {
  readonly draft: ScenarioDraft
  readonly definition: ScenarioDefinition
}
type ScenarioTimelineActionConfig = z.infer<typeof scenarioTimelineActionConfigSchema>

const scenarioTime = (startsAt: IsoTimestamp, seconds: number): IsoTimestamp =>
  new Date(Date.parse(startsAt) + seconds * 1000).toISOString() as IsoTimestamp

const pointFromLonLat = (value: readonly [number, number]): GeoJsonPoint =>
  geoPointFromLonLat(value[0], value[1])

const packFor = (packs: ReadonlyMap<string, WorldPack>, packId: string): WorldPack => {
  const pack = packs.get(packId)
  if (!pack) throw new Error(`scenario references unknown pack: ${packId}`)
  if (!pack.scenario) throw new Error(`pack ${packId} does not support scenario config expansion`)
  return pack
}

const expandItem = async (
  spec: PackScenarioItemSpec,
  context: {
    readonly at: IsoTimestamp
    readonly packs: ReadonlyMap<string, WorldPack>
    readonly objectMap: Map<ObjectId, OperationalObject>
    readonly routing: RoutingAdapter
    readonly runtimeConfigs: Record<string, unknown>
  },
): Promise<PackScenarioItemContribution> => {
  const pack = packFor(context.packs, spec.pack)
  const expansionContext = {
    at: context.at,
    objects: [...context.objectMap.values()],
    objectById: (id: ObjectId) => context.objectMap.get(id),
    routing: context.routing,
    runtimeConfigs: context.runtimeConfigs,
  }
  return await pack.scenario!.expandItem(spec, expansionContext)
}

const expandTimelineAction = async (
  action: ScenarioTimelineActionConfig,
  context: {
    readonly at: IsoTimestamp
    readonly packs: ReadonlyMap<string, WorldPack>
    readonly objectMap: Map<ObjectId, OperationalObject>
    readonly routing: RoutingAdapter
    readonly runtimeConfigs: Record<string, unknown>
  },
): Promise<ScenarioTimelineAction> => {
  if (action.type === 'show_guidance' || action.type === 'highlight_objects') {
    return action
  }
  if (action.type === 'emit_signal' || action.type === 'issue_command') {
    return action as ScenarioTimelineAction
  }
  if (action.type === 'hide_guidance') {
    return action.guidanceId === undefined
      ? { type: 'hide_guidance' }
      : { type: 'hide_guidance', guidanceId: action.guidanceId }
  }
  if (action.type === 'clear_highlights') {
    return action.objectIds === undefined
      ? { type: 'clear_highlights' }
      : { type: 'clear_highlights', objectIds: action.objectIds }
  }
  if (action.type === 'delete_object') {
    context.objectMap.delete(action.objectId)
    return action
  }
  if (action.type === 'create_object') {
    const contribution = await expandItem(action.object, context)
    if (contribution.objects.length !== 1 || (contribution.processSystems?.length ?? 0) !== 0) {
      throw new Error('scenario timeline create_object requires one object and no process systems')
    }
    const object = contribution.objects[0]!
    if (context.objectMap.has(object.id)) throw new Error(`scenario timeline creates duplicate object id: ${object.id}`)
    context.objectMap.set(object.id, object)
    return { type: 'upsert_object', object }
  }
  const object = context.objectMap.get(action.objectId)
  if (!object) throw new Error(`scenario timeline operation references unknown object: ${action.objectId}`)
  const pack = packFor(context.packs, action.operation.pack)
  const updated = await pack.scenario!.applyOperation(action.operation as PackScenarioOperationSpec, {
    at: context.at,
    object,
    objects: [...context.objectMap.values()],
    objectById: (id) => context.objectMap.get(id),
    routing: context.routing,
    runtimeConfigs: context.runtimeConfigs,
  })
  context.objectMap.set(updated.id, updated)
  return { type: 'upsert_object', object: updated }
}

const expandSurfaceRegion = (region: z.infer<typeof surfaceRegionConfigSchema>): SurfaceRegionDefinition => {
  if (region.primitive === 'map') {
    return {
      ...region,
      config: {
        center: pointFromLonLat(region.config.center),
        zoom: region.config.zoom,
        layers: region.config.layers,
      },
    }
  }
  if (region.primitive === 'objectRail') {
    return {
      ...region,
      config: {
        ...(region.config.width === undefined ? {} : { width: region.config.width }),
        sections: region.config.sections,
      },
    }
  }
  return region
}

const expandSurface = (surface: z.infer<typeof surfaceConfigSchema>): SurfaceDefinition => ({
  schemaVersion: surface.schemaVersion,
  regions: surface.regions.map(expandSurfaceRegion),
})

export const scenarioDefinitionFromDraft = async (
  rawDraft: unknown,
  packs: ReadonlyArray<WorldPack>,
  options: { readonly routing: RoutingAdapter },
): Promise<ScenarioDefinition> => {
  const draft = scenarioDraftSchema.parse(rawDraft)
  const packsById = new Map(packs.map(pack => [pack.descriptor.id, pack]))
  const startsAt = draft.world.startsAt as IsoTimestamp
  const objectMap = new Map<ObjectId, OperationalObject>()
  const initialObjects: OperationalObject[] = []
  const processSystems = scenarioDefinitionSchema.shape.processSystems.parse(draft.processSystems)
  for (const item of draft.items) {
    const contribution = await expandItem(item as PackScenarioItemSpec, {
      at: startsAt,
      packs: packsById,
      objectMap,
      routing: options.routing,
      runtimeConfigs: draft.runtimeConfigs,
    })
    for (const object of contribution.objects) {
      if (objectMap.has(object.id)) throw new Error(`scenario ${draft.id} has duplicate object id: ${object.id}`)
      objectMap.set(object.id, object)
      initialObjects.push(object)
    }
    processSystems.push(...(contribution.processSystems ?? []))
  }
  let timeline: ScenarioDefinition['timeline'] | undefined
  if (draft.timeline) {
    const cues: ScenarioTimelineCue[] = []
    for (const cue of draft.timeline.cues) {
      const actions: ScenarioTimelineAction[] = []
      for (const action of cue.actions) {
        actions.push(await expandTimelineAction(action, {
          at: scenarioTime(startsAt, cue.at.seconds),
          packs: packsById,
          objectMap,
          routing: options.routing,
          runtimeConfigs: draft.runtimeConfigs,
        }))
      }
      cues.push({
        id: cue.id,
        at: cue.at,
        ...(cue.title === undefined ? {} : { title: cue.title }),
        actions,
      })
    }
    timeline = { cues }
  }

  return scenarioDefinitionSchema.parse({
    id: draft.id,
    schemaVersion: draft.schemaVersion,
    title: draft.title,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    objectives: draft.objectives,
    packs: draft.packs,
    runtimeOverrides: draft.runtimeOverrides,
    world: {
      startsAt,
      environment: draft.world.environment,
    },
    initialObjects,
    initialContexts: draft.initialContexts,
    processSystems,
    runtimeConfigs: draft.runtimeConfigs,
    surface: expandSurface(draft.surface),
    ...(timeline === undefined ? {} : { timeline }),
  }) as ScenarioDefinition
}

export const scenarioTemplateFromDraft = async (
  rawDraft: unknown,
  packs: ReadonlyArray<WorldPack>,
  options: { readonly routing: RoutingAdapter },
): Promise<ScenarioTemplate> => {
  const draft = scenarioDraftSchema.parse(rawDraft)
  return {
    draft,
    definition: await scenarioDefinitionFromDraft(draft, packs, options),
  }
}
