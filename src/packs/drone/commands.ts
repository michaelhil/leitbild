import { z } from 'zod'
import { geoJsonPointSchema, geoJsonPolygonSchema, objectIdSchema } from '../../core/model/index.ts'
import {
  droneGuidedTargetSchema,
  droneInputSourceSchema,
  droneManualAxesSchema,
  droneVehicleModelSchema,
} from './model.ts'

export const createDroneCommandKind = 'drone.create_vehicle'
export const armDroneCommandKind = 'drone.arm'
export const manualControlCommandKind = 'drone.manual_control'
export const navigateDroneCommandKind = 'drone.goto'
export const takeoffDroneCommandKind = 'drone.takeoff'
export const landDroneCommandKind = 'drone.land'
export const returnToLaunchDroneCommandKind = 'drone.return_to_launch'
export const holdDroneCommandKind = 'drone.hold'
export const uploadDroneMissionCommandKind = 'drone.upload_mission'
export const startDroneMissionCommandKind = 'drone.start_mission'
export const pauseDroneMissionCommandKind = 'drone.pause_mission'
export const clearDroneMissionCommandKind = 'drone.clear_mission'
export const uploadDroneGeofenceCommandKind = 'drone.upload_geofence'
export const clearDroneGeofenceCommandKind = 'drone.clear_geofence'
export const setDroneParameterCommandKind = 'drone.set_parameter'
export const setDroneGimbalCommandKind = 'drone.set_gimbal'
export const configureDroneVehicleModelCommandKind = 'drone.configure_vehicle_model'
export const configureDroneProfileCommandKind = configureDroneVehicleModelCommandKind
export const swarmCommandKind = 'drone.swarm_command'
export const attackCommandKind = 'drone.attack'

export const creatableDroneObjectTypeSchema = z.enum(['drone'])
export type CreatableDroneObjectType = z.infer<typeof creatableDroneObjectTypeSchema>

export const createDronePayloadSchema = z.object({
  objectType: creatableDroneObjectTypeSchema,
  label: z.string().min(1).max(80),
  point: geoJsonPointSchema,
  modelId: z.string().min(1).max(128).default('px4-x500-depth'),
  altitudeM: z.number().finite().min(-1_000).max(100_000).default(35),
  headingDeg: z.number().finite().min(0).max(360).default(0),
  systemId: z.number().int().min(1).max(255).optional(),
}).strict()
export type CreateDronePayload = z.infer<typeof createDronePayloadSchema>

export const armDronePayloadSchema = z.object({
  droneId: objectIdSchema,
  armed: z.boolean(),
}).strict()
export type ArmDronePayload = z.infer<typeof armDronePayloadSchema>

export const manualControlPayloadSchema = z.object({
  droneId: objectIdSchema,
  axes: droneManualAxesSchema,
  inputSource: droneInputSourceSchema,
  commandTtlMs: z.number().int().positive().max(5_000).default(650),
}).strict()
export type ManualControlPayload = z.infer<typeof manualControlPayloadSchema>

export const navigateDronePayloadSchema = z.object({
  droneId: objectIdSchema,
  target: droneGuidedTargetSchema,
}).strict()
export type NavigateDronePayload = z.infer<typeof navigateDronePayloadSchema>

export const takeoffDronePayloadSchema = z.object({
  droneId: objectIdSchema,
  altitudeM: z.number().finite().min(0).max(20_000),
}).strict()
export type TakeoffDronePayload = z.infer<typeof takeoffDronePayloadSchema>

export const singleDronePayloadSchema = z.object({
  droneId: objectIdSchema,
}).strict()
export type SingleDronePayload = z.infer<typeof singleDronePayloadSchema>

export const missionFrameSchema = z.enum(['global', 'global_relative_alt', 'mission'])

export const droneMissionItemSchema = z.object({
  seq: z.number().int().nonnegative().max(65_535),
  command: z.number().int().nonnegative().max(65_535),
  frame: missionFrameSchema.default('global_relative_alt'),
  point: geoJsonPointSchema.optional(),
  altitudeM: z.number().finite().min(-1_000).max(100_000).optional(),
  param1: z.number().finite().default(0),
  param2: z.number().finite().default(0),
  param3: z.number().finite().default(0),
  param4: z.number().finite().default(0),
  autocontinue: z.boolean().default(true),
}).strict()
export type DroneMissionItem = z.infer<typeof droneMissionItemSchema>

export const uploadDroneMissionPayloadSchema = z.object({
  droneId: objectIdSchema,
  planId: z.string().min(1).max(128).optional(),
  items: z.array(droneMissionItemSchema).min(1).max(1_000),
}).strict()
export type UploadDroneMissionPayload = z.infer<typeof uploadDroneMissionPayloadSchema>

export const droneGeofencePayloadSchema = z.object({
  droneId: objectIdSchema,
  polygons: z.array(geoJsonPolygonSchema).min(1).max(64),
}).strict()
export type DroneGeofencePayload = z.infer<typeof droneGeofencePayloadSchema>

export const uploadDroneGeofencePayloadSchema = droneGeofencePayloadSchema

export const setDroneParameterPayloadSchema = z.object({
  droneId: objectIdSchema,
  name: z.string().min(1).max(16),
  value: z.number().finite(),
  valueType: z.enum(['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'real32']).default('real32'),
}).strict()
export type SetDroneParameterPayload = z.infer<typeof setDroneParameterPayloadSchema>

export const setDroneGimbalPayloadSchema = z.object({
  droneId: objectIdSchema,
  pitchDeg: z.number().finite().min(-180).max(180),
  yawDeg: z.number().finite().min(-180).max(180),
}).strict()
export type SetDroneGimbalPayload = z.infer<typeof setDroneGimbalPayloadSchema>

export const configureDroneVehicleModelPayloadSchema = z.object({
  droneId: objectIdSchema,
  model: droneVehicleModelSchema,
}).strict()
export type ConfigureDroneVehicleModelPayload = z.infer<typeof configureDroneVehicleModelPayloadSchema>

export const configureDroneProfilePayloadSchema = configureDroneVehicleModelPayloadSchema
export type ConfigureDroneProfilePayload = ConfigureDroneVehicleModelPayload

export const swarmFormationSchema = z.object({
  kind: z.string().min(1).max(64),
  spacingM: z.number().finite().positive().max(1_000).default(18),
  altitudeStepM: z.number().finite().min(0).max(500).default(0),
}).strict()
export type SwarmFormation = z.infer<typeof swarmFormationSchema>

export const swarmCommandPayloadSchema = z.object({
  swarmId: z.string().min(1).max(128).optional(),
  droneIds: z.array(objectIdSchema).default([]),
  command: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('hold') }).strict(),
    z.object({ kind: z.literal('land') }).strict(),
    z.object({
      kind: z.literal('navigate'),
      target: droneGuidedTargetSchema,
      formation: swarmFormationSchema.default({ kind: 'grid', spacingM: 18, altitudeStepM: 0 }),
    }).strict(),
    z.object({
      kind: z.literal('search_area'),
      center: geoJsonPointSchema,
      radiusM: z.number().finite().positive().max(100_000),
      altitudeM: z.number().finite().min(0).max(20_000),
      formation: swarmFormationSchema.default({ kind: 'grid', spacingM: 18, altitudeStepM: 0 }),
    }).strict(),
    z.object({
      kind: z.literal('disperse'),
      radiusM: z.number().finite().positive().max(10_000).default(80),
    }).strict(),
  ]),
}).strict().superRefine((payload, ctx) => {
  if (payload.swarmId === undefined && payload.droneIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'swarm command requires swarmId or droneIds',
      path: ['droneIds'],
    })
  }
})
export type SwarmCommandPayload = z.infer<typeof swarmCommandPayloadSchema>

export const attackPayloadSchema = z.object({
  attackerId: objectIdSchema,
  targetId: objectIdSchema,
  payloadId: z.string().min(1).max(128).optional(),
}).strict()
export type AttackPayload = z.infer<typeof attackPayloadSchema>

export const droneCommandKinds = [
  createDroneCommandKind,
  armDroneCommandKind,
  manualControlCommandKind,
  navigateDroneCommandKind,
  takeoffDroneCommandKind,
  landDroneCommandKind,
  returnToLaunchDroneCommandKind,
  holdDroneCommandKind,
  uploadDroneMissionCommandKind,
  startDroneMissionCommandKind,
  pauseDroneMissionCommandKind,
  clearDroneMissionCommandKind,
  uploadDroneGeofenceCommandKind,
  clearDroneGeofenceCommandKind,
  setDroneParameterCommandKind,
  setDroneGimbalCommandKind,
  configureDroneVehicleModelCommandKind,
  swarmCommandKind,
  attackCommandKind,
] as const
