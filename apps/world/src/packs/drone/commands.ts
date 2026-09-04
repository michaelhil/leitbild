import { z } from 'zod'
import { geoJsonPointSchema,geoJsonPolygonSchema,objectIdSchema } from '../../core/model/index.ts'
import {
  droneGuidedTargetSchema,
  droneInputSourceSchema,
  droneManualAxesSchema,
  droneSwarmMembershipSchema,
  droneVehicleModelSchema,
} from './model.ts'

export const createDroneCommandKind = 'world.drone.create-vehicle'
export const armDroneCommandKind = 'world.drone.arm'
export const manualControlCommandKind = 'world.drone.manual-control'
export const navigateDroneCommandKind = 'world.drone.navigate'
export const takeoffDroneCommandKind = 'world.drone.takeoff'
export const landDroneCommandKind = 'world.drone.land'
export const returnToLaunchDroneCommandKind = 'world.drone.return-to-launch'
export const holdDroneCommandKind = 'world.drone.hold'
export const uploadDroneMissionCommandKind = 'world.drone.upload-mission'
export const startDroneMissionCommandKind = 'world.drone.start-mission'
export const pauseDroneMissionCommandKind = 'world.drone.pause-mission'
export const clearDroneMissionCommandKind = 'world.drone.clear-mission'
export const uploadDroneGeofenceCommandKind = 'world.drone.upload-geofence'
export const clearDroneGeofenceCommandKind = 'world.drone.clear-geofence'
export const setDroneGimbalCommandKind = 'world.drone.set-gimbal'
export const configureDroneVehicleModelCommandKind = 'world.drone.configure-vehicle-model'
export const setDroneSwarmCommandKind = 'world.drone.set-swarm'
export const setDroneSwarmPayloadSchema = z.object({ droneId: objectIdSchema, swarm: droneSwarmMembershipSchema.nullable() }).strict()
export const swarmCommandKind = 'world.drone.swarm-command'
export const attackCommandKind = 'world.drone.attack'
export const observeTargetCommandKind = 'world.drone.observe-target'

export const creatableDroneObjectTypeSchema = z.enum(['drone'])
export type CreatableDroneObjectType = z.infer<typeof creatableDroneObjectTypeSchema>

export const createDronePayloadSchema = z.object({
  objectType: creatableDroneObjectTypeSchema,
  label: z.string().min(1).max(80),
  point: geoJsonPointSchema,
  modelId: z.string().min(1).max(128).default('native-survey-quad'),
  altitudeM: z.number().finite().min(-1_000).max(100_000).default(35),
  headingDeg: z.number().finite().min(0).max(360).default(0),
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

export const droneMissionItemSchema = z.object({
  seq: z.number().int().nonnegative().max(65_535),
  point: geoJsonPointSchema,
  altitudeM: z.number().finite().min(-1_000).max(100_000),
  speedMps: z.number().finite().positive().max(160).optional(),
  holdSeconds: z.number().finite().nonnegative().max(3_600).default(0),
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
export const observeTargetPayloadSchema = z.object({
  droneId: objectIdSchema,
  targetId: objectIdSchema,
  sensorId: z.string().min(1).max(128).optional(),
}).strict()
export type ObserveTargetPayload = z.infer<typeof observeTargetPayloadSchema>

export const droneCommandKinds = [
  setDroneSwarmCommandKind,
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
  setDroneGimbalCommandKind,
  configureDroneVehicleModelCommandKind,
  swarmCommandKind,
  attackCommandKind,
  observeTargetCommandKind,
] as const
