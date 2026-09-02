import { z } from 'zod'
import {
  geoPointFromLonLat,
  objectIdSchema,
  type GeoJsonPoint,
  type OperationalObject,
} from '../../core/model/index.ts'
import type { PackScenarioItemSpec, PackScenarioMutationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import {
  defaultDroneVehicleModels,
  droneSwarmMembershipSchema,
  droneVehicleModelCatalogSchema,
  droneVehicleModelSchema,
  requireDroneVehicleModel,
  type DroneVehicleModel,
} from './model.ts'
import { createScenarioDroneObject, parseDroneObject, withDronePackData } from './native/object-state.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

export const dronePackConfigSchema = z.object({
  maxDrones: z.number().int().positive().max(500).default(10),
  stepIntervalMs: z.number().int().min(5).max(100).default(20),
  projectionIntervalMs: z.number().int().min(10).max(250).default(33),
  batteryDrainPercentPerHour: z.number().finite().nonnegative().max(100).default(8),
  models: z.array(droneVehicleModelSchema).default([]),
}).strict()

export const droneSpecSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('drone'),
  id: objectIdSchema,
  label: z.string().min(1),
  position: lonLatSchema,
  modelId: z.string().min(1).max(128).default('native-survey-quad'),
  model: droneVehicleModelSchema.optional(),
  altitudeM: z.number().finite().min(-1_000).max(100_000).default(35),
  headingDeg: z.number().finite().min(0).max(360).default(0),
  swarm: droneSwarmMembershipSchema.optional(),
}).strict()

const setDroneModelMutationSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('set_vehicle_model'),
  model: droneVehicleModelSchema,
}).strict()

const setDroneSwarmMutationSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('set_swarm'),
  swarm: droneSwarmMembershipSchema.optional(),
}).strict()

const pointFromLonLat = (value: readonly [number, number]): GeoJsonPoint =>
  geoPointFromLonLat(value[0], value[1])

export const dronePackConfigFromSelections = (
  packConfigs: Record<string, unknown>,
): z.infer<typeof dronePackConfigSchema> =>
  dronePackConfigSchema.parse(packConfigs.drone ?? {})

export const droneVehicleModelsFromPackConfigs = (
  packConfigs: Record<string, unknown>,
): ReadonlyArray<DroneVehicleModel> => {
  const parsed = dronePackConfigFromSelections(packConfigs)
  const modelById = new Map(defaultDroneVehicleModels.map(model => [model.id, model]))
  for (const model of droneVehicleModelCatalogSchema.parse({ models: parsed.models }).models) {
    modelById.set(model.id, model)
  }
  return [...modelById.values()]
}

export const droneScenarioSupport: PackScenarioSupport = {
  itemSchemas: { drone: droneSpecSchema },
  mutationSchemas: {
    set_vehicle_model: setDroneModelMutationSchema,
    set_swarm: setDroneSwarmMutationSchema,
  },
  expandItem: (rawSpec: PackScenarioItemSpec, context) => {
    if (rawSpec.type !== 'drone') throw new Error(`unsupported drone scenario object type: ${rawSpec.type}`)
    const spec = droneSpecSchema.parse(rawSpec)
    const models = spec.model === undefined
      ? droneVehicleModelsFromPackConfigs(context.packConfigs)
      : [...droneVehicleModelsFromPackConfigs(context.packConfigs), spec.model]
    const model = spec.model ?? requireDroneVehicleModel(spec.modelId, models)
    return { objects: [createScenarioDroneObject({
      id: spec.id,
      label: spec.label,
      model,
      point: pointFromLonLat(spec.position),
      altitudeM: spec.altitudeM,
      headingDeg: spec.headingDeg,
      at: context.at,
      ...(spec.swarm === undefined ? {} : { swarm: spec.swarm }),
    })] }
  },
  applyMutation: (rawMutation: PackScenarioMutationSpec, context): OperationalObject => {
    if (rawMutation.type === 'set_vehicle_model') {
      const mutation = setDroneModelMutationSchema.parse(rawMutation)
      const data = parseDroneObject(context.object)
      if (!data) throw new Error(`set_vehicle_model requires drone object: ${context.object.id}`)
      return withDronePackData(context.object, {
        ...data,
        vehicle: {
          ...data.vehicle,
          modelId: mutation.model.id,
          modelLabel: mutation.model.label,
          airframe: mutation.model.airframe,
          flightEnvelope: mutation.model.flightEnvelope,
          capabilities: mutation.model.capabilities,
          sensors: mutation.model.sensors,
          payloads: mutation.model.payloads,
          visual: mutation.model.visual,
        },
      }, context.at)
    }
    if (rawMutation.type === 'set_swarm') {
      const mutation = setDroneSwarmMutationSchema.parse(rawMutation)
      const data = parseDroneObject(context.object)
      if (!data) throw new Error(`set_swarm requires drone object: ${context.object.id}`)
      const nextData = mutation.swarm === undefined
        ? (() => {
            const { swarm: _swarm, ...withoutSwarm } = data
            return withoutSwarm
          })()
        : { ...data, swarm: mutation.swarm }
      return withDronePackData(context.object, nextData, context.at)
    }
    throw new Error(`unsupported drone Scenario mutation type: ${rawMutation.type}`)
  },
}
