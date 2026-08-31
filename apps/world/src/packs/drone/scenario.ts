import { z } from 'zod'
import {
  geoPointFromLonLat,
  objectIdSchema,
  type GeoJsonPoint,
  type OperationalObject,
} from '../../core/model/index.ts'
import type { PackScenarioItemSpec, PackScenarioOperationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
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

const droneRuntimeConfigSchema = z.object({
  maxDrones: z.number().int().positive().max(500).default(10),
  stepIntervalMs: z.number().int().min(5).max(100).default(20),
  projectionIntervalMs: z.number().int().min(10).max(250).default(33),
  batteryDrainPercentPerHour: z.number().finite().nonnegative().max(100).default(8),
  models: z.array(droneVehicleModelSchema).default([]),
}).strict()

const droneSpecSchema = z.object({
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

const setDroneModelOperationSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('set_vehicle_model'),
  model: droneVehicleModelSchema,
}).strict()

const setDroneSwarmOperationSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('set_swarm'),
  swarm: droneSwarmMembershipSchema.optional(),
}).strict()

const pointFromLonLat = (value: readonly [number, number]): GeoJsonPoint =>
  geoPointFromLonLat(value[0], value[1])

export const droneRuntimeConfigFromRuntimeConfigs = (
  runtimeConfigs: Record<string, unknown>,
): z.infer<typeof droneRuntimeConfigSchema> =>
  droneRuntimeConfigSchema.parse(runtimeConfigs.drone ?? {})

export const droneVehicleModelsFromRuntimeConfigs = (
  runtimeConfigs: Record<string, unknown>,
): ReadonlyArray<DroneVehicleModel> => {
  const parsed = droneRuntimeConfigFromRuntimeConfigs(runtimeConfigs)
  const modelById = new Map(defaultDroneVehicleModels.map(model => [model.id, model]))
  for (const model of droneVehicleModelCatalogSchema.parse({ models: parsed.models }).models) {
    modelById.set(model.id, model)
  }
  return [...modelById.values()]
}

export const droneProfilesFromRuntimeConfigs = droneVehicleModelsFromRuntimeConfigs

export const droneScenarioSupport: PackScenarioSupport = {
  expandItem: (rawSpec: PackScenarioItemSpec, context) => {
    if (rawSpec.type !== 'drone') throw new Error(`unsupported drone scenario object type: ${rawSpec.type}`)
    const spec = droneSpecSchema.parse(rawSpec)
    const models = spec.model === undefined
      ? droneVehicleModelsFromRuntimeConfigs(context.runtimeConfigs)
      : [...droneVehicleModelsFromRuntimeConfigs(context.runtimeConfigs), spec.model]
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
  applyOperation: (rawOperation: PackScenarioOperationSpec, context): OperationalObject => {
    if (rawOperation.type === 'set_vehicle_model') {
      const operation = setDroneModelOperationSchema.parse(rawOperation)
      const data = parseDroneObject(context.object)
      if (!data) throw new Error(`set_vehicle_model requires drone object: ${context.object.id}`)
      return withDronePackData(context.object, {
        ...data,
        vehicle: {
          ...data.vehicle,
          modelId: operation.model.id,
          modelLabel: operation.model.label,
          airframe: operation.model.airframe,
          flightEnvelope: operation.model.flightEnvelope,
          capabilities: operation.model.capabilities,
          sensors: operation.model.sensors,
          payloads: operation.model.payloads,
          visual: operation.model.visual,
        },
      }, context.at)
    }
    if (rawOperation.type === 'set_swarm') {
      const operation = setDroneSwarmOperationSchema.parse(rawOperation)
      const data = parseDroneObject(context.object)
      if (!data) throw new Error(`set_swarm requires drone object: ${context.object.id}`)
      const nextData = operation.swarm === undefined
        ? (() => {
            const { swarm: _swarm, ...withoutSwarm } = data
            return withoutSwarm
          })()
        : { ...data, swarm: operation.swarm }
      return withDronePackData(context.object, nextData, context.at)
    }
    throw new Error(`unsupported drone scenario operation type: ${rawOperation.type}`)
  },
}
