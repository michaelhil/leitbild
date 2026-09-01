import { z } from 'zod'
import {
  geoPointFromLonLat,
  electricalConnectionSpecSchema,
  electricalPortFromObject,
  idSchema,
  interactionEndpointSchema,
  objectContextSchema,
  objectIdSchema,
  scenarioDefinitionSchema,
  scenarioTimelineCommandRequestSchema,
  signalIdSchema,
  scenarioRecordingSelectionSchema,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
  type ScenarioDefinition,
  type ElectricalConnectionDefinition,
  type ScenarioTimelineAction,
  type ScenarioTimelineCue,
  type SurfaceDefinition,
} from '../model/index.ts'
import type { WorldPack, PackScenarioItemSpec, PackScenarioOperationSpec, PackScenarioItemContribution } from '../packs/protocol.ts'
import type { RoutingAdapter } from '../../routing/protocol.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const scenarioItemSchema = z.object({
  type: z.string().min(1),
  id: objectIdSchema,
  label: z.string().min(1),
  context: objectContextSchema.optional(),
}).passthrough()

const timelineScenarioItemSchema = scenarioItemSchema.extend({ pack: idSchema })

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
    object: timelineScenarioItemSchema,
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

const scenarioViewSchema = z.object({
  map: surfaceMapRegionConfigSchema,
  rail: surfaceObjectRailRegionConfigSchema.optional(),
}).strict()

const scenarioPackSelectionSchema = z.object({
  id: idSchema,
  runtime: idSchema.optional(),
  config: z.unknown().default({}),
  items: z.array(scenarioItemSchema).default([]),
}).strict()

export const scenarioSourceSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  objectives: z.array(z.string().min(1)).default([]),
  packs: z.array(scenarioPackSelectionSchema).min(1),
  world: z.object({
    startsAt: z.string().datetime(),
    environment: z.record(z.string(), z.unknown()).default({}),
  }),
  view: scenarioViewSchema,
  recording: z.array(scenarioRecordingSelectionSchema).default([]),
  connections: z.array(electricalConnectionSpecSchema).default([]),
  timeline: scenarioTimelineConfigSchema.optional(),
}).strict().superRefine((source, ctx) => {
  const packs = new Set<string>()
  source.packs.forEach((selection, index) => {
    if (packs.has(selection.id)) ctx.addIssue({ code: 'custom', path: ['packs', index, 'id'], message: `duplicate Pack: ${selection.id}` })
    packs.add(selection.id)
  })
  const recordedPacks = new Set<string>()
  source.recording.forEach((selection, index) => {
    if (!packs.has(selection.packId)) ctx.addIssue({ code: 'custom', path: ['recording', index, 'packId'], message: `recording selects inactive Pack: ${selection.packId}` })
    if (recordedPacks.has(selection.packId)) ctx.addIssue({ code: 'custom', path: ['recording', index, 'packId'], message: `duplicate recording selection for Pack: ${selection.packId}` })
    recordedPacks.add(selection.packId)
  })
})

export type ScenarioSource = z.infer<typeof scenarioSourceSchema>
type ScenarioTimelineActionConfig = z.infer<typeof scenarioTimelineActionConfigSchema>

const scenarioTime = (startsAt: IsoTimestamp, seconds: number): IsoTimestamp =>
  new Date(Date.parse(startsAt) + seconds * 1000).toISOString() as IsoTimestamp

const pointFromLonLat = (value: readonly [number, number]): GeoJsonPoint =>
  geoPointFromLonLat(value[0], value[1])

const compileElectricalConnections = (
  specs: ScenarioSource['connections'],
  objects: ReadonlyMap<ObjectId, OperationalObject>,
): ReadonlyArray<ElectricalConnectionDefinition> => specs.map(spec => {
  const systemObject = objects.get(spec.system.objectId)
  if (!systemObject) throw new Error(`electrical connection ${spec.id} references unknown system object: ${spec.system.objectId}`)
  const networkObject = objects.get(spec.network.objectId)
  if (!networkObject) throw new Error(`electrical connection ${spec.id} references unknown network object: ${spec.network.objectId}`)
  const systemPort = electricalPortFromObject(systemObject, spec.system.portId)
  if (!systemPort) throw new Error(`electrical connection ${spec.id} references unknown system port: ${spec.system.objectId}:${spec.system.portId}`)
  const networkPort = electricalPortFromObject(networkObject, spec.network.portId)
  if (!networkPort) throw new Error(`electrical connection ${spec.id} references unknown network port: ${spec.network.objectId}:${spec.network.portId}`)
  if (Math.abs(systemPort.nominalKv - networkPort.nominalKv) > 0.001) {
    throw new Error(`electrical connection ${spec.id} voltage mismatch: ${systemPort.nominalKv} kV and ${networkPort.nominalKv} kV`)
  }
  return {
    ...spec,
    nominalKv: systemPort.nominalKv,
    maximumSystemExportMw: Math.min(systemPort.maximumExportMw, networkPort.maximumImportMw),
    maximumSystemImportMw: Math.min(systemPort.maximumImportMw, networkPort.maximumExportMw),
    ...(systemPort.inertiaSeconds === undefined ? {} : { systemInertiaSeconds: systemPort.inertiaSeconds }),
  }
})

const packFor = (packs: ReadonlyMap<string, WorldPack>, packId: string): WorldPack => {
  const pack = packs.get(packId)
  if (!pack) throw new Error(`scenario references unknown pack: ${packId}`)
  if (!pack.scenario) throw new Error(`pack ${packId} does not support scenario config expansion`)
  return pack
}

const registeredPackFor = (packs: ReadonlyMap<string, WorldPack>, packId: string): WorldPack => {
  const pack = packs.get(packId)
  if (!pack) throw new Error(`scenario references unknown pack: ${packId}`)
  return pack
}

const expandItem = async (
  spec: PackScenarioItemSpec,
  context: {
    readonly at: IsoTimestamp
    readonly packs: ReadonlyMap<string, WorldPack>
    readonly objectMap: Map<ObjectId, OperationalObject>
    readonly routing: RoutingAdapter
    readonly packConfigs: Record<string, unknown>
  },
): Promise<PackScenarioItemContribution> => {
  const pack = packFor(context.packs, spec.pack)
  const expansionContext = {
    at: context.at,
    objects: [...context.objectMap.values()],
    objectById: (id: ObjectId) => context.objectMap.get(id),
    routing: context.routing,
    packConfigs: context.packConfigs,
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
    readonly packConfigs: Record<string, unknown>
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
    if (contribution.objects.length !== 1) throw new Error('scenario timeline create_object requires one object')
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
    packConfigs: context.packConfigs,
  })
  context.objectMap.set(updated.id, updated)
  return { type: 'upsert_object', object: updated }
}

const surfaceFromView = (
  view: z.infer<typeof scenarioViewSchema>,
  packs: ReadonlyArray<WorldPack>,
): SurfaceDefinition => ({
  schemaVersion: 1,
  regions: [{
    id: 'main-map',
    primitive: 'map',
    visible: true,
    config: {
      center: pointFromLonLat(view.map.center),
      zoom: view.map.zoom,
      layers: view.map.layers,
    },
  }, {
    id: 'object-rail',
    primitive: 'objectRail',
    visible: true,
    config: {
      ...(view.rail?.width === undefined ? {} : { width: view.rail.width }),
      sections: view.rail?.sections ?? packs.flatMap(pack =>
        pack.presentation.categories.map(category => ({
          categoryId: category.id,
          visible: true,
          collapsed: false,
          visibleFields: [],
        }))),
    },
  }, {
    id: 'system-footer', primitive: 'systemFooter', visible: true, config: {},
  }, {
    id: 'guidance-overlay', primitive: 'guidanceOverlay', visible: true, config: {},
  }],
})

export const compileScenarioSource = async (
  rawSource: unknown,
  packs: ReadonlyArray<WorldPack>,
  options: { readonly routing: RoutingAdapter },
): Promise<ScenarioDefinition> => {
  const source = scenarioSourceSchema.parse(rawSource)
  const packsById = new Map(packs.map(pack => [pack.descriptor.id, pack]))
  const startsAt = source.world.startsAt as IsoTimestamp
  const activePacks = source.packs.map(selection => registeredPackFor(packsById, selection.id))
  const packConfigs = Object.fromEntries(source.packs.map(selection => {
    const pack = registeredPackFor(packsById, selection.id)
    return [selection.id, pack.scenarioConfigSchema.parse(selection.config)]
  }))
  const objectMap = new Map<ObjectId, OperationalObject>()
  const initialObjects: OperationalObject[] = []
  for (const selection of source.packs) {
    for (const item of selection.items) {
      const contribution = await expandItem({ ...item, pack: selection.id } as PackScenarioItemSpec, {
        at: startsAt,
        packs: packsById,
        objectMap,
        routing: options.routing,
        packConfigs,
      })
      for (const expandedObject of contribution.objects) {
        if (objectMap.has(expandedObject.id)) throw new Error(`scenario ${source.id} has duplicate object id: ${expandedObject.id}`)
        const object = (item.context === undefined ? expandedObject : { ...expandedObject, context: item.context }) as OperationalObject
        objectMap.set(object.id, object)
        initialObjects.push(object)
      }
    }
  }
  // Connections describe the initial physical topology. Timeline expansion may
  // create or delete later objects, but it must not rewrite that topology.
  const connections = compileElectricalConnections(source.connections, objectMap)
  let timeline: ScenarioDefinition['timeline'] | undefined
  if (source.timeline) {
    const cues: ScenarioTimelineCue[] = []
    for (const cue of source.timeline.cues) {
      const actions: ScenarioTimelineAction[] = []
      for (const action of cue.actions) {
        actions.push(await expandTimelineAction(action, {
          at: scenarioTime(startsAt, cue.at.seconds),
          packs: packsById,
          objectMap,
          routing: options.routing,
          packConfigs,
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
    id: source.id,
    schemaVersion: 1,
    title: source.title,
    ...(source.description === undefined ? {} : { description: source.description }),
    objectives: source.objectives,
    packs: source.packs.map(selection => selection.id),
    packRuntimes: Object.fromEntries(source.packs.flatMap(selection =>
      selection.runtime === undefined ? [] : [[selection.id, selection.runtime]])),
    packConfigs,
    connections,
    world: {
      startsAt,
      environment: source.world.environment,
    },
    initialObjects,
    surface: surfaceFromView(source.view, activePacks),
    recording: source.recording,
    ...(timeline === undefined ? {} : { timeline }),
  }) as ScenarioDefinition
}
