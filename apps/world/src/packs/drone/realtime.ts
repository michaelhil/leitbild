import { z } from 'zod'
import { isoTimestampSchema, objectIdSchema, type IsoTimestamp, type ObjectId } from '../../core/model/index.ts'
import type { PackRuntimeRealtimeMessage } from '../../simulation/protocol.ts'
import { droneInputSourceSchema, droneManualAxesSchema } from './model.ts'

export const droneMotionFramesRealtimeType = 'drone.motion.frames'
export const droneManualIntentRealtimeInputType = 'drone.manual.intent'
export const droneManualIntentTtlMs = 450

export const droneManualIntentPayloadSchema = z.object({
  droneId: objectIdSchema,
  axes: droneManualAxesSchema,
  inputSource: droneInputSourceSchema.omit({ clientId: true }).extend({
    kind: z.enum(['keyboard', 'mouse', 'gamepad']),
  }),
}).strict()

export const droneMotionFrameSchema = z.object({
  objectId: objectIdSchema,
  sequence: z.number().int().nonnegative(),
  observedAt: isoTimestampSchema,
  lon: z.number().finite(),
  lat: z.number().finite(),
  altitudeM: z.number().finite(),
  headingDeg: z.number().finite(),
  pitchDeg: z.number().finite(),
  rollDeg: z.number().finite(),
  yawRateDegPerSec: z.number().finite(),
  eastMps: z.number().finite(),
  northMps: z.number().finite(),
  verticalSpeedMps: z.number().finite(),
}).strict()

export type DroneMotionFrame = z.infer<typeof droneMotionFrameSchema> & {
  readonly objectId: ObjectId
  readonly observedAt: IsoTimestamp
}

export const droneMotionFrameBatchPayloadSchema = z.object({
  frames: z.array(droneMotionFrameSchema),
}).strict()

export interface DroneMotionFrameBatchPayload {
  readonly frames: ReadonlyArray<DroneMotionFrame>
}

export type DroneMotionFramesRealtimeMessage = PackRuntimeRealtimeMessage & {
  readonly type: typeof droneMotionFramesRealtimeType
  readonly payload: DroneMotionFrameBatchPayload
}

export const droneMotionFramesRealtimeMessage = (config: {
  readonly at: IsoTimestamp
  readonly frames: ReadonlyArray<DroneMotionFrame>
}): DroneMotionFramesRealtimeMessage => ({
  type: droneMotionFramesRealtimeType,
  at: config.at,
  payload: droneMotionFrameBatchPayloadSchema.parse({ frames: config.frames }),
})

export const parseDroneMotionFramesRealtimeMessage = (
  message: PackRuntimeRealtimeMessage,
): DroneMotionFramesRealtimeMessage | null => {
  if (message.type !== droneMotionFramesRealtimeType) return null
  return {
    type: droneMotionFramesRealtimeType,
    at: isoTimestampSchema.parse(message.at),
    payload: droneMotionFrameBatchPayloadSchema.parse(message.payload),
  }
}
