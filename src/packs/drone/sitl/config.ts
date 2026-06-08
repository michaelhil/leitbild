import { z } from 'zod'
import {
  defaultDroneVehicleModels,
  droneAutopilotSchema,
  droneVehicleModelCatalogSchema,
  droneVehicleModelSchema,
  type DroneAutopilot,
  type DroneVehicleModel,
} from '../model.ts'
import { parseMavlinkEndpoint, type MavlinkEndpoint } from './mavlink.ts'

const optionalIntEnv = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`expected integer environment value, got ${value}`)
  return parsed
}

const positiveIntEnv = (value: string | undefined, fallback: number): number => {
  const parsed = optionalIntEnv(value)
  if (parsed === undefined) return fallback
  if (parsed <= 0) throw new Error(`expected positive integer environment value, got ${value}`)
  return parsed
}

const runtimeConfigSchema = z.object({
  autopilot: droneAutopilotSchema.default('px4'),
  world: z.string().min(1).max(128).default('default'),
  mavlink: z.object({
    endpoint: z.string().min(1).max(240).optional(),
    linkCount: z.number().int().positive().max(10).optional(),
    systemIdBase: z.number().int().min(1).max(240).optional(),
    sourceSystemId: z.number().int().min(1).max(255).optional(),
    sourceComponentId: z.number().int().min(1).max(255).optional(),
    heartbeatTimeoutMs: z.number().int().positive().max(120_000).optional(),
    commandTimeoutMs: z.number().int().positive().max(120_000).optional(),
  }).strict().default({}),
  models: z.array(droneVehicleModelSchema).default([]),
}).strict()

export interface DroneSitlRuntimeConfig {
  readonly autopilot: DroneAutopilot
  readonly world: string
  readonly endpoint: MavlinkEndpoint
  readonly endpoints: ReadonlyArray<MavlinkEndpoint>
  readonly endpointText: string
  readonly endpointTexts: ReadonlyArray<string>
  readonly systemIdBase: number
  readonly sourceSystemId: number
  readonly sourceComponentId: number
  readonly heartbeatTimeoutMs: number
  readonly commandTimeoutMs: number
  readonly models: ReadonlyArray<DroneVehicleModel>
}

const endpointTextWithOffset = (endpoint: MavlinkEndpoint, offset: number): string =>
  `udp://${endpoint.host}:${endpoint.port + offset}?localPort=${endpoint.localPort + offset}`

export const parseDroneSitlRuntimeConfig = (
  rawConfig: unknown,
  env: Record<string, string | undefined> = process.env,
): DroneSitlRuntimeConfig => {
  const parsed = runtimeConfigSchema.parse(rawConfig ?? {})
  const endpointText = parsed.mavlink.endpoint
    ?? env.LEITBILD_DRONE_MAVLINK_ENDPOINT
    ?? 'udp://127.0.0.1:14580?localPort=14540'
  const endpoint = parseMavlinkEndpoint(endpointText)
  const linkCount = parsed.mavlink.linkCount
    ?? positiveIntEnv(env.LEITBILD_DRONE_MAVLINK_LINK_COUNT, 1)
  if (endpoint.port + linkCount - 1 > 65_535 || endpoint.localPort + linkCount - 1 > 65_535) {
    throw new Error(`MAVLink link count ${linkCount} overflows UDP port range from ${endpointText}`)
  }
  const endpointTexts = Array.from({ length: linkCount }, (_value, offset) => endpointTextWithOffset(endpoint, offset))
  const endpoints = endpointTexts.map(parseMavlinkEndpoint)
  const modelById = new Map(defaultDroneVehicleModels.map(model => [model.id, model]))
  for (const model of droneVehicleModelCatalogSchema.parse({ models: parsed.models }).models) {
    modelById.set(model.id, model)
  }
  return {
    autopilot: parsed.autopilot,
    world: parsed.world,
    endpoint,
    endpoints,
    endpointText,
    endpointTexts,
    systemIdBase: parsed.mavlink.systemIdBase ?? optionalIntEnv(env.LEITBILD_DRONE_MAVLINK_SYSTEM_ID_BASE) ?? 1,
    sourceSystemId: parsed.mavlink.sourceSystemId ?? optionalIntEnv(env.LEITBILD_DRONE_MAVLINK_SOURCE_SYSTEM_ID) ?? 245,
    sourceComponentId: parsed.mavlink.sourceComponentId ?? optionalIntEnv(env.LEITBILD_DRONE_MAVLINK_SOURCE_COMPONENT_ID) ?? 190,
    heartbeatTimeoutMs: parsed.mavlink.heartbeatTimeoutMs ?? optionalIntEnv(env.LEITBILD_DRONE_MAVLINK_HEARTBEAT_TIMEOUT_MS) ?? 5_000,
    commandTimeoutMs: parsed.mavlink.commandTimeoutMs ?? optionalIntEnv(env.LEITBILD_DRONE_MAVLINK_COMMAND_TIMEOUT_MS) ?? 4_000,
    models: [...modelById.values()],
  }
}
