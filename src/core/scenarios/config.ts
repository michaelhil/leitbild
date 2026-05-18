import { z } from 'zod'
import {
  geoPointFromLonLat,
  idSchema,
  objectIdSchema,
  scenarioDefinitionSchema,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
  type ScenarioDefinition,
  type ScenarioScriptAction,
} from '../model/index.ts'
import type { LeitbildPack, PackScenarioObjectSpec, PackScenarioOperationSpec } from '../packs/protocol.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const scenarioObjectConfigSchema = z.object({
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
})

const scenarioScriptActionConfigSchema = z.discriminatedUnion('type', [
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
    object: scenarioObjectConfigSchema,
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
])

const scenarioScriptStepConfigSchema = z.object({
  id: idSchema,
  at: z.object({
    kind: z.literal('after_scenario_start'),
    seconds: z.number().finite().nonnegative(),
  }),
  title: z.string().min(1).optional(),
  actions: z.array(scenarioScriptActionConfigSchema).min(1),
})

const scenarioScriptConfigSchema = z.object({
  steps: z.array(scenarioScriptStepConfigSchema).default([]),
})

export const scenarioConfigSchema = z.object({
  id: idSchema,
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  packs: z.array(idSchema).min(1),
  providerOverrides: z.record(idSchema).default({}),
  world: z.object({
    startsAt: z.string().datetime(),
    mapCenter: lonLatSchema.optional(),
    environment: z.record(z.unknown()).default({}),
  }),
  objects: z.array(scenarioObjectConfigSchema),
  initialContexts: z.array(z.object({
    objectId: idSchema,
    context: z.unknown(),
  })).default([]),
  providerConfigs: z.record(z.unknown()).default({}),
  missionId: idSchema.optional(),
  script: scenarioScriptConfigSchema.optional(),
})

export type ScenarioConfig = z.infer<typeof scenarioConfigSchema>
type ScenarioScriptActionConfig = z.infer<typeof scenarioScriptActionConfigSchema>

const scenarioTime = (startsAt: IsoTimestamp, seconds: number): IsoTimestamp =>
  new Date(Date.parse(startsAt) + seconds * 1000).toISOString() as IsoTimestamp

const pointFromLonLat = (value: readonly [number, number]): GeoJsonPoint =>
  geoPointFromLonLat(value[0], value[1])

const packFor = (packs: ReadonlyMap<string, LeitbildPack>, packId: string): LeitbildPack => {
  const pack = packs.get(packId)
  if (!pack) throw new Error(`scenario references unknown pack: ${packId}`)
  if (!pack.scenario) throw new Error(`pack ${packId} does not support scenario config expansion`)
  return pack
}

const expandObject = (
  spec: PackScenarioObjectSpec,
  context: {
    readonly at: IsoTimestamp
    readonly packs: ReadonlyMap<string, LeitbildPack>
    readonly objectMap: Map<ObjectId, OperationalObject>
  },
): OperationalObject => {
  const pack = packFor(context.packs, spec.pack)
  return pack.scenario!.expandObject(spec, {
    at: context.at,
    objects: [...context.objectMap.values()],
    objectById: (id) => context.objectMap.get(id),
  })
}

const expandScriptAction = (
  action: ScenarioScriptActionConfig,
  context: {
    readonly at: IsoTimestamp
    readonly packs: ReadonlyMap<string, LeitbildPack>
    readonly objectMap: Map<ObjectId, OperationalObject>
  },
): ScenarioScriptAction => {
  if (action.type === 'show_guidance' || action.type === 'highlight_objects') {
    return action
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
    const object = expandObject(action.object, context)
    if (context.objectMap.has(object.id)) throw new Error(`scenario script creates duplicate object id: ${object.id}`)
    context.objectMap.set(object.id, object)
    return { type: 'upsert_object', object }
  }
  const object = context.objectMap.get(action.objectId)
  if (!object) throw new Error(`scenario script operation references unknown object: ${action.objectId}`)
  const pack = packFor(context.packs, action.operation.pack)
  const updated = pack.scenario!.applyOperation(action.operation as PackScenarioOperationSpec, {
    at: context.at,
    object,
    objects: [...context.objectMap.values()],
    objectById: (id) => context.objectMap.get(id),
  })
  context.objectMap.set(updated.id, updated)
  return { type: 'upsert_object', object: updated }
}

export const scenarioDefinitionFromConfig = (
  rawConfig: unknown,
  packs: ReadonlyArray<LeitbildPack>,
): ScenarioDefinition => {
  const config = scenarioConfigSchema.parse(rawConfig)
  const packsById = new Map(packs.map(pack => [pack.id, pack]))
  const startsAt = config.world.startsAt as IsoTimestamp
  const objectMap = new Map<ObjectId, OperationalObject>()
  const initialObjects = config.objects.map(objectConfig => {
    const object = expandObject(objectConfig as PackScenarioObjectSpec, {
      at: startsAt,
      packs: packsById,
      objectMap,
    })
    if (objectMap.has(object.id)) throw new Error(`scenario ${config.id} has duplicate object id: ${object.id}`)
    objectMap.set(object.id, object)
    return object
  })
  const script = config.script
    ? {
        steps: config.script.steps.map(step => ({
          id: step.id,
          at: step.at,
          ...(step.title === undefined ? {} : { title: step.title }),
          actions: step.actions.map(action => expandScriptAction(action, {
            at: scenarioTime(startsAt, step.at.seconds),
            packs: packsById,
            objectMap,
          })),
        })),
      }
    : undefined

  return scenarioDefinitionSchema.parse({
    id: config.id,
    schemaVersion: config.schemaVersion,
    title: config.title,
    ...(config.description === undefined ? {} : { description: config.description }),
    packs: config.packs,
    providerOverrides: config.providerOverrides,
    world: {
      startsAt,
      ...(config.world.mapCenter === undefined ? {} : { mapCenter: pointFromLonLat(config.world.mapCenter) }),
      environment: config.world.environment,
    },
    initialObjects,
    initialContexts: config.initialContexts,
    providerConfigs: config.providerConfigs,
    ...(config.missionId === undefined ? {} : { missionId: config.missionId }),
    ...(script === undefined ? {} : { script }),
  }) as ScenarioDefinition
}
