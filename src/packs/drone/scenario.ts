import { z } from 'zod'
import {
  geoPointFromLonLat,
  objectIdSchema,
  type GeoJsonPoint,
  type OperationalObject,
} from '../../core/model/index.ts'
import type { PackScenarioObjectSpec, PackScenarioOperationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import {
  defaultDroneEnvironment,
  defaultDroneProfiles,
  droneEnvironmentSchema,
  droneProfileCatalogSchema,
  droneProfileSchema,
  droneSwarmMembershipSchema,
  requireDroneProfile,
  type DroneEnvironment,
  type DroneProfile,
} from './model.ts'
import { createScenarioDroneObject, parseDroneObject, withDronePackData } from './sim/object-state.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const droneRuntimeConfigSchema = z.object({
  profiles: z.array(droneProfileSchema).default([]),
  environment: droneEnvironmentSchema.default(defaultDroneEnvironment),
}).strict()

const droneSpecSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('drone'),
  id: objectIdSchema,
  label: z.string().min(1),
  position: lonLatSchema,
  profileId: z.string().min(1).max(128).default('quad-surveillance'),
  profile: droneProfileSchema.optional(),
  altitudeM: z.number().finite().min(0).max(20_000).default(35),
  headingDeg: z.number().finite().min(0).max(360).default(0),
  mode: z.enum(['manual', 'guided', 'swarm', 'mission', 'hold', 'land', 'return_to_launch', 'disabled', 'destroyed']).default('hold'),
  swarm: droneSwarmMembershipSchema.optional(),
}).strict()

const setDroneProfileOperationSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('set_profile'),
  profile: droneProfileSchema,
}).strict()

const setDroneSwarmOperationSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('set_swarm'),
  swarm: droneSwarmMembershipSchema.optional(),
}).strict()

const pointFromLonLat = (value: readonly [number, number]): GeoJsonPoint =>
  geoPointFromLonLat(value[0], value[1])

export const droneProfilesFromRuntimeConfigs = (
  runtimeConfigs: Record<string, unknown>,
): ReadonlyArray<DroneProfile> => {
  const rawConfig = runtimeConfigs.drone
  return droneProfilesFromRuntimeConfigValue(rawConfig)
}

export const droneProfilesFromRuntimeConfigValue = (
  rawConfig: unknown,
): ReadonlyArray<DroneProfile> => {
  if (rawConfig === undefined) return defaultDroneProfiles
  const parsed = droneRuntimeConfigSchema.parse(rawConfig)
  const profileById = new Map(defaultDroneProfiles.map(profile => [profile.id, profile]))
  for (const profile of droneProfileCatalogSchema.parse({ profiles: parsed.profiles }).profiles) {
    profileById.set(profile.id, profile)
  }
  return [...profileById.values()]
}

export const droneEnvironmentFromRuntimeConfigValue = (
  rawConfig: unknown,
): DroneEnvironment => {
  if (rawConfig === undefined) return defaultDroneEnvironment
  return droneRuntimeConfigSchema.parse(rawConfig).environment
}

export const droneScenarioSupport: PackScenarioSupport = {
  expandObject: (rawSpec: PackScenarioObjectSpec, context): OperationalObject => {
    if (rawSpec.type !== 'drone') throw new Error(`unsupported drone scenario object type: ${rawSpec.type}`)
    const spec = droneSpecSchema.parse(rawSpec)
    const profiles = spec.profile === undefined
      ? droneProfilesFromRuntimeConfigs(context.runtimeConfigs)
      : [...droneProfilesFromRuntimeConfigs(context.runtimeConfigs), spec.profile]
    const profile = spec.profile ?? requireDroneProfile(spec.profileId, profiles)
    return createScenarioDroneObject({
      id: spec.id,
      label: spec.label,
      point: pointFromLonLat(spec.position),
      profile,
      altitudeM: spec.altitudeM,
      headingDeg: spec.headingDeg,
      at: context.at,
      mode: spec.mode,
      ...(spec.swarm === undefined ? {} : { swarm: spec.swarm }),
    })
  },
  applyOperation: (rawOperation: PackScenarioOperationSpec, context): OperationalObject => {
    if (rawOperation.type === 'set_profile') {
      const operation = setDroneProfileOperationSchema.parse(rawOperation)
      const data = parseDroneObject(context.object)
      if (!data) throw new Error(`set_profile requires drone object: ${context.object.id}`)
      return withDronePackData(context.object, {
        ...data,
        profile: operation.profile,
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
