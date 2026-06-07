import { z } from 'zod'
import { geoJsonPointSchema, objectIdSchema } from '../../core/model/index.ts'
import {
  droneFlightModeSchema,
  droneGuidedTargetSchema,
  droneInputSourceSchema,
  droneManualAxesSchema,
  droneProfileSchema,
} from './model.ts'

export const createDroneCommandKind = 'drone.create_object'
export const manualControlCommandKind = 'drone.manual_control'
export const navigateDroneCommandKind = 'drone.navigate_to'
export const setDroneModeCommandKind = 'drone.set_mode'
export const configureDroneProfileCommandKind = 'drone.configure_profile'
export const swarmCommandKind = 'drone.swarm_command'
export const attackCommandKind = 'drone.attack'

export const creatableDroneObjectTypeSchema = z.enum(['drone'])
export type CreatableDroneObjectType = z.infer<typeof creatableDroneObjectTypeSchema>

export const createDronePayloadSchema = z.object({
  objectType: creatableDroneObjectTypeSchema,
  label: z.string().min(1).max(80),
  point: geoJsonPointSchema,
  profileId: z.string().min(1).max(128).default('quad-surveillance'),
  altitudeM: z.number().finite().min(0).max(20_000).default(35),
  headingDeg: z.number().finite().min(0).max(360).default(0),
}).strict()
export type CreateDronePayload = z.infer<typeof createDronePayloadSchema>

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

export const setDroneModePayloadSchema = z.object({
  droneId: objectIdSchema,
  mode: z.enum(['hold', 'land', 'return_to_launch']),
}).strict()
export type SetDroneModePayload = z.infer<typeof setDroneModePayloadSchema>

export const configureDroneProfilePayloadSchema = z.object({
  droneId: objectIdSchema,
  profile: droneProfileSchema,
}).strict()
export type ConfigureDroneProfilePayload = z.infer<typeof configureDroneProfilePayloadSchema>

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
    z.object({
      kind: z.literal('hold'),
    }).strict(),
    z.object({
      kind: z.literal('land'),
    }).strict(),
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
  manualControlCommandKind,
  navigateDroneCommandKind,
  setDroneModeCommandKind,
  configureDroneProfileCommandKind,
  swarmCommandKind,
  attackCommandKind,
] as const
