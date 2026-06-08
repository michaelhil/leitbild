import { z } from 'zod'
import {
  geoPointFromLonLat,
  objectIdSchema,
  type GeoJsonPoint,
  type OperationalObject,
} from '../../core/model/index.ts'
import type { PackScenarioObjectSpec, PackScenarioOperationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import {
  defaultDroneVehicleModels,
  droneAutopilotSchema,
  droneSwarmMembershipSchema,
  droneVehicleModelCatalogSchema,
  droneVehicleModelSchema,
  requireDroneVehicleModel,
  type DroneAutopilot,
  type DroneVehicleModel,
} from './model.ts'
import { createScenarioDroneObject, parseDroneObject, withDronePackData } from './sitl/object-state.ts'
import { parseMavlinkEndpoint } from './sitl/mavlink.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const mavlinkScenarioConfigSchema = z.object({
  endpoint: z.string().min(1).max(240).optional(),
  linkCount: z.number().int().positive().max(10).optional(),
  systemIdBase: z.number().int().min(1).max(240).default(1),
}).strict().default({
  systemIdBase: 1,
})

const droneRuntimeConfigSchema = z.object({
  autopilot: droneAutopilotSchema.default('px4'),
  world: z.string().min(1).max(128).default('default'),
  mavlink: mavlinkScenarioConfigSchema,
  models: z.array(droneVehicleModelSchema).default([]),
}).strict()

const droneSpecSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('drone'),
  id: objectIdSchema,
  label: z.string().min(1),
  position: lonLatSchema,
  modelId: z.string().min(1).max(128).default('px4-x500-depth'),
  model: droneVehicleModelSchema.optional(),
  autopilot: droneAutopilotSchema.optional(),
  systemId: z.number().int().min(1).max(255).optional(),
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

const scenarioEndpointForSystemId = (
  runtimeConfig: z.infer<typeof droneRuntimeConfigSchema>,
  systemId: number,
): string | undefined => {
  const endpointText = runtimeConfig.mavlink.endpoint
  if (endpointText === undefined) return undefined
  const endpoint = parseMavlinkEndpoint(endpointText)
  const offset = systemId - runtimeConfig.mavlink.systemIdBase
  if (offset < 0 || offset >= (runtimeConfig.mavlink.linkCount ?? 1)) return endpointText
  return `udp://${endpoint.host}:${endpoint.port + offset}?localPort=${endpoint.localPort + offset}`
}

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

export const droneAutopilotFromRuntimeConfigs = (
  runtimeConfigs: Record<string, unknown>,
): DroneAutopilot =>
  droneRuntimeConfigFromRuntimeConfigs(runtimeConfigs).autopilot

const nextScenarioSystemId = (
  objects: ReadonlyArray<OperationalObject>,
  systemIdBase: number,
): number => {
  const used = new Set<number>()
  for (const object of objects) {
    const data = parseDroneObject(object)
    if (data) used.add(data.vehicle.systemId)
  }
  let candidate = systemIdBase
  while (used.has(candidate) && candidate < 255) candidate += 1
  if (candidate > 255) throw new Error('no MAVLink system ids remain for drone scenario objects')
  return candidate
}

export const droneScenarioSupport: PackScenarioSupport = {
  expandObject: (rawSpec: PackScenarioObjectSpec, context): OperationalObject => {
    if (rawSpec.type !== 'drone') throw new Error(`unsupported drone scenario object type: ${rawSpec.type}`)
    const runtimeConfig = droneRuntimeConfigFromRuntimeConfigs(context.runtimeConfigs)
    const spec = droneSpecSchema.parse(rawSpec)
    const models = spec.model === undefined
      ? droneVehicleModelsFromRuntimeConfigs(context.runtimeConfigs)
      : [...droneVehicleModelsFromRuntimeConfigs(context.runtimeConfigs), spec.model]
    const model = spec.model ?? requireDroneVehicleModel(spec.modelId, models)
    const systemId = spec.systemId ?? nextScenarioSystemId(context.objects, runtimeConfig.mavlink.systemIdBase)
    const endpoint = scenarioEndpointForSystemId(runtimeConfig, systemId)
    return createScenarioDroneObject({
      id: spec.id,
      label: spec.label,
      autopilot: spec.autopilot ?? runtimeConfig.autopilot,
      model,
      point: pointFromLonLat(spec.position),
      altitudeM: spec.altitudeM,
      headingDeg: spec.headingDeg,
      at: context.at,
      systemId,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(spec.swarm === undefined ? {} : { swarm: spec.swarm }),
    })
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
          autopilotModel: operation.model.autopilotModel,
          gazeboModel: operation.model.gazeboModel,
          airframe: operation.model.airframe,
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
