import { z } from 'zod'
import { actorIdSchema, clientIdSchema, geoJsonPointSchema, idSchema, isoTimestampSchema, objectIdSchema, type ActorId, type ClientId, type GeoJsonPoint, type IsoTimestamp, type ObjectId } from '../../core/model/index.ts'

export const dronePackId = 'drone' as const

export const droneFlightModeSchema = z.enum([
  'manual',
  'guided',
  'swarm',
  'mission',
  'hold',
  'land',
  'return_to_launch',
  'disabled',
  'destroyed',
])
export type DroneFlightMode = z.infer<typeof droneFlightModeSchema>

export const droneHealthStateSchema = z.enum(['nominal', 'degraded', 'disabled', 'destroyed'])
export type DroneHealthState = z.infer<typeof droneHealthStateSchema>

export const droneAirframeSchema = z.object({
  kind: z.string().min(1).max(64),
  rotorCount: z.number().int().nonnegative().max(32),
  massKg: z.number().finite().positive().max(500),
  diagonalSizeM: z.number().finite().positive().max(10),
  dragAreaM2: z.number().finite().nonnegative().max(20).default(0.08),
}).strict()
export type DroneAirframe = z.infer<typeof droneAirframeSchema>

export const droneControllerGainsSchema = z.object({
  velocityP: z.number().finite().positive().max(10).default(1.8),
  altitudeP: z.number().finite().positive().max(10).default(1.4),
  yawP: z.number().finite().positive().max(10).default(2.5),
  damping: z.number().finite().min(0).max(1).default(0.18),
}).strict()
export type DroneControllerGains = z.infer<typeof droneControllerGainsSchema>

export const droneDynamicsSchema = z.object({
  maxHorizontalSpeedMps: z.number().finite().positive().max(160),
  maxVerticalSpeedMps: z.number().finite().positive().max(60),
  maxAccelerationMps2: z.number().finite().positive().max(80),
  maxYawRateDegPerSec: z.number().finite().positive().max(720),
  maxTiltDeg: z.number().finite().positive().max(89),
  minAltitudeM: z.number().finite().min(0).max(10_000).default(0),
  serviceCeilingM: z.number().finite().positive().max(20_000),
  controller: droneControllerGainsSchema.default({
    velocityP: 1.8,
    altitudeP: 1.4,
    yawP: 2.5,
    damping: 0.18,
  }),
}).strict()
export type DroneDynamics = z.infer<typeof droneDynamicsSchema>

export const droneEnergyModelSchema = z.object({
  capacityWh: z.number().finite().positive().max(100_000),
  reserveWh: z.number().finite().nonnegative().max(100_000),
  nominalVoltageV: z.number().finite().positive().max(1_000),
  hoverPowerW: z.number().finite().positive().max(100_000),
  cruisePowerW: z.number().finite().positive().max(150_000),
  payloadPowerW: z.number().finite().nonnegative().max(50_000).default(0),
}).strict().superRefine((energy, ctx) => {
  if (energy.reserveWh >= energy.capacityWh) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'reserveWh must be lower than capacityWh',
      path: ['reserveWh'],
    })
  }
})
export type DroneEnergyModel = z.infer<typeof droneEnergyModelSchema>

export const droneSensorSchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  rangeM: z.number().finite().positive().max(100_000),
  fovDeg: z.number().finite().positive().max(360).default(90),
  updateIntervalMs: z.number().int().positive().max(60_000).default(1_000),
  tags: z.array(z.string().min(1).max(48)).default([]),
}).strict()
export type DroneSensor = z.infer<typeof droneSensorSchema>

export const dronePayloadEffectSchema = z.object({
  kind: z.string().min(1).max(64),
  damage: z.number().finite().min(0).max(1),
  radiusM: z.number().finite().nonnegative().max(5_000).default(0),
  cooldownSeconds: z.number().finite().nonnegative().max(3_600).default(0),
}).strict()
export type DronePayloadEffect = z.infer<typeof dronePayloadEffectSchema>

export const dronePayloadSchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  massKg: z.number().finite().nonnegative().max(500).default(0),
  quantity: z.number().int().nonnegative().max(10_000).default(1),
  rangeM: z.number().finite().positive().max(100_000).optional(),
  effect: dronePayloadEffectSchema.optional(),
  tags: z.array(z.string().min(1).max(48)).default([]),
}).strict()
export type DronePayload = z.infer<typeof dronePayloadSchema>

export const droneCapabilitySchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  level: z.number().finite().min(0).max(10).default(1),
  tags: z.array(z.string().min(1).max(48)).default([]),
}).strict()
export type DroneCapability = z.infer<typeof droneCapabilitySchema>

export const droneVisualProfileSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563eb'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f8fafc'),
  scale: z.number().finite().positive().max(10).default(1),
}).strict()
export type DroneVisualProfile = z.infer<typeof droneVisualProfileSchema>

export const droneProfileSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(96),
  description: z.string().min(1).max(500).optional(),
  airframe: droneAirframeSchema,
  dynamics: droneDynamicsSchema,
  energy: droneEnergyModelSchema,
  capabilities: z.array(droneCapabilitySchema).default([]),
  sensors: z.array(droneSensorSchema).default([]),
  payloads: z.array(dronePayloadSchema).default([]),
  visual: droneVisualProfileSchema.default({
    color: '#2563eb',
    accentColor: '#f8fafc',
    scale: 1,
  }),
}).strict()
export type DroneProfile = z.infer<typeof droneProfileSchema>

export const droneKinematicsSchema = z.object({
  altitudeM: z.number().finite().min(0).max(20_000),
  verticalSpeedMps: z.number().finite().min(-100).max(100).default(0),
  velocityEastMps: z.number().finite().min(-300).max(300).default(0),
  velocityNorthMps: z.number().finite().min(-300).max(300).default(0),
  yawDeg: z.number().finite().min(0).max(360).default(0),
  pitchDeg: z.number().finite().min(-89).max(89).default(0),
  rollDeg: z.number().finite().min(-89).max(89).default(0),
}).strict()
export type DroneKinematics = z.infer<typeof droneKinematicsSchema>

export const droneEnergyStateSchema = z.object({
  remainingWh: z.number().finite().nonnegative(),
  consumedWh: z.number().finite().nonnegative().default(0),
  voltageV: z.number().finite().positive(),
}).strict()
export type DroneEnergyState = z.infer<typeof droneEnergyStateSchema>

export const droneManualAxesSchema = z.object({
  forward: z.number().finite().min(-1).max(1).default(0),
  right: z.number().finite().min(-1).max(1).default(0),
  vertical: z.number().finite().min(-1).max(1).default(0),
  yaw: z.number().finite().min(-1).max(1).default(0),
}).strict()
export type DroneManualAxes = z.infer<typeof droneManualAxesSchema>

export const droneInputSourceSchema = z.object({
  kind: z.enum(['keyboard', 'gamepad', 'map', 'scenario', 'ai', 'operator']),
  label: z.string().min(1).max(120).optional(),
  gamepadIndex: z.number().int().nonnegative().max(16).optional(),
  clientId: clientIdSchema.optional(),
}).strict()
export type DroneInputSource = z.infer<typeof droneInputSourceSchema>

export const droneGuidedTargetSchema = z.object({
  point: geoJsonPointSchema,
  altitudeM: z.number().finite().min(0).max(20_000),
  speedMps: z.number().finite().positive().max(160).optional(),
  targetObjectId: objectIdSchema.optional(),
}).strict()
export type DroneGuidedTarget = z.infer<typeof droneGuidedTargetSchema>

export const droneControlStateSchema = z.object({
  mode: droneFlightModeSchema,
  pilotActorId: actorIdSchema.optional(),
  inputSource: droneInputSourceSchema.optional(),
  manualAxes: droneManualAxesSchema.optional(),
  guidedTarget: droneGuidedTargetSchema.optional(),
  lastCommandAt: isoTimestampSchema.optional(),
  inputExpiresAt: isoTimestampSchema.optional(),
}).strict()
export type DroneControlState = z.infer<typeof droneControlStateSchema>

export const droneDamageRecordSchema = z.object({
  id: idSchema,
  sourceObjectId: objectIdSchema.optional(),
  kind: z.string().min(1).max(64),
  severity: z.number().finite().min(0).max(1),
  occurredAt: isoTimestampSchema,
  description: z.string().min(1).max(240),
}).strict()
export type DroneDamageRecord = z.infer<typeof droneDamageRecordSchema>

export const droneHealthStateDataSchema = z.object({
  state: droneHealthStateSchema,
  integrity: z.number().finite().min(0).max(1),
  damage: z.array(droneDamageRecordSchema).default([]),
}).strict()
export type DroneHealthStateData = z.infer<typeof droneHealthStateDataSchema>

export const droneSwarmMembershipSchema = z.object({
  swarmId: idSchema,
  role: z.string().min(1).max(64).default('member'),
  slot: z.tuple([
    z.number().finite().min(-10_000).max(10_000),
    z.number().finite().min(-10_000).max(10_000),
    z.number().finite().min(-5_000).max(5_000),
  ]).default([0, 0, 0]),
  separationRadiusM: z.number().finite().positive().max(1_000).default(8),
}).strict()
export type DroneSwarmMembership = z.infer<typeof droneSwarmMembershipSchema>

export const droneMissionStateSchema = z.object({
  taskId: idSchema.optional(),
  objective: z.string().min(1).max(120).optional(),
  phase: z.string().min(1).max(64).optional(),
}).strict()
export type DroneMissionState = z.infer<typeof droneMissionStateSchema>

export const dronePackDataSchema = z.object({
  type: z.literal('drone'),
  schemaVersion: z.literal(1),
  profile: droneProfileSchema,
  kinematics: droneKinematicsSchema,
  energy: droneEnergyStateSchema,
  control: droneControlStateSchema,
  health: droneHealthStateDataSchema,
  swarm: droneSwarmMembershipSchema.optional(),
  mission: droneMissionStateSchema.optional(),
}).strict()
export type DronePackData = z.infer<typeof dronePackDataSchema>

export const droneProfileCatalogSchema = z.object({
  profiles: z.array(droneProfileSchema).default([]),
}).strict()
export type DroneProfileCatalog = z.infer<typeof droneProfileCatalogSchema>

export const defaultDroneProfiles: ReadonlyArray<DroneProfile> = [
  droneProfileSchema.parse({
    id: 'quad-surveillance',
    label: 'Quad Surveillance',
    description: 'Stable multirotor with optical and thermal sensing.',
    airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 2.4, diagonalSizeM: 0.46, dragAreaM2: 0.08 },
    dynamics: {
      maxHorizontalSpeedMps: 18,
      maxVerticalSpeedMps: 5,
      maxAccelerationMps2: 7,
      maxYawRateDegPerSec: 160,
      maxTiltDeg: 35,
      serviceCeilingM: 500,
    },
    energy: {
      capacityWh: 95,
      reserveWh: 18,
      nominalVoltageV: 22.2,
      hoverPowerW: 390,
      cruisePowerW: 520,
      payloadPowerW: 18,
    },
    capabilities: [
      { id: 'manual-control', kind: 'manual_control', label: 'Manual control' },
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation' },
      { id: 'swarm-member', kind: 'swarm_member', label: 'Swarm member' },
      { id: 'surveillance', kind: 'surveillance', label: 'Surveillance' },
    ],
    sensors: [
      { id: 'eo-camera', kind: 'electro_optical', label: 'EO camera', rangeM: 1_200, fovDeg: 70, updateIntervalMs: 500 },
      { id: 'thermal-camera', kind: 'thermal', label: 'Thermal camera', rangeM: 700, fovDeg: 55, updateIntervalMs: 800 },
    ],
    visual: { color: '#2563eb', accentColor: '#f8fafc', scale: 1 },
  }),
  droneProfileSchema.parse({
    id: 'heavy-supply',
    label: 'Heavy Supply',
    description: 'Cargo multirotor with slower handling and higher payload power.',
    airframe: { kind: 'hexacopter', rotorCount: 6, massKg: 9.5, diagonalSizeM: 1.1, dragAreaM2: 0.24 },
    dynamics: {
      maxHorizontalSpeedMps: 13,
      maxVerticalSpeedMps: 3,
      maxAccelerationMps2: 4.2,
      maxYawRateDegPerSec: 90,
      maxTiltDeg: 28,
      serviceCeilingM: 300,
    },
    energy: {
      capacityWh: 430,
      reserveWh: 70,
      nominalVoltageV: 44.4,
      hoverPowerW: 1_550,
      cruisePowerW: 1_900,
      payloadPowerW: 80,
    },
    capabilities: [
      { id: 'manual-control', kind: 'manual_control', label: 'Manual control' },
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation' },
      { id: 'payload-delivery', kind: 'payload_delivery', label: 'Payload delivery' },
      { id: 'swarm-member', kind: 'swarm_member', label: 'Swarm member' },
    ],
    payloads: [
      { id: 'medical-drop', kind: 'cargo', label: 'Medical supply drop', massKg: 3.5, quantity: 2, tags: ['medical', 'supply'] },
    ],
    sensors: [
      { id: 'navigation-camera', kind: 'navigation_camera', label: 'Navigation camera', rangeM: 500, fovDeg: 90, updateIntervalMs: 1_000 },
    ],
    visual: { color: '#0f766e', accentColor: '#ecfeff', scale: 1.35 },
  }),
  droneProfileSchema.parse({
    id: 'interceptor-effect',
    label: 'Interceptor Effect',
    description: 'Fast drone with a configurable kinetic effect payload.',
    airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 3.2, diagonalSizeM: 0.52, dragAreaM2: 0.1 },
    dynamics: {
      maxHorizontalSpeedMps: 28,
      maxVerticalSpeedMps: 7,
      maxAccelerationMps2: 11,
      maxYawRateDegPerSec: 220,
      maxTiltDeg: 48,
      serviceCeilingM: 700,
    },
    energy: {
      capacityWh: 120,
      reserveWh: 20,
      nominalVoltageV: 22.2,
      hoverPowerW: 520,
      cruisePowerW: 760,
      payloadPowerW: 30,
    },
    capabilities: [
      { id: 'manual-control', kind: 'manual_control', label: 'Manual control' },
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation' },
      { id: 'effect-delivery', kind: 'effect_delivery', label: 'Effect delivery' },
      { id: 'swarm-member', kind: 'swarm_member', label: 'Swarm member' },
    ],
    payloads: [
      {
        id: 'kinetic-effect',
        kind: 'kinetic',
        label: 'Kinetic effect',
        massKg: 0.7,
        quantity: 1,
        rangeM: 75,
        effect: { kind: 'kinetic', damage: 0.65, radiusM: 3, cooldownSeconds: 8 },
      },
    ],
    sensors: [
      { id: 'tracking-camera', kind: 'tracking_camera', label: 'Tracking camera', rangeM: 900, fovDeg: 50, updateIntervalMs: 300 },
    ],
    visual: { color: '#b91c1c', accentColor: '#fee2e2', scale: 1.08 },
  }),
]

export const droneProfileMap = (profiles: ReadonlyArray<DroneProfile> = defaultDroneProfiles): ReadonlyMap<string, DroneProfile> =>
  new Map(profiles.map(profile => [profile.id, profile]))

export const requireDroneProfile = (
  profileId: string,
  profiles: ReadonlyArray<DroneProfile> = defaultDroneProfiles,
): DroneProfile => {
  const profile = droneProfileMap(profiles).get(profileId)
  if (!profile) throw new Error(`unknown drone profile: ${profileId}`)
  return profile
}

export const isDronePackData = (value: unknown): value is DronePackData =>
  dronePackDataSchema.safeParse(value).success

export const droneHasCapability = (profile: DroneProfile, kind: string): boolean =>
  profile.capabilities.some(capability => capability.kind === kind)

export const droneHorizontalSpeedMps = (kinematics: DroneKinematics): number =>
  Math.hypot(kinematics.velocityEastMps, kinematics.velocityNorthMps)

export interface DroneSceneObject {
  readonly id: ObjectId
  readonly label: string
  readonly point: GeoJsonPoint
  readonly altitudeM: number
  readonly headingDeg: number
  readonly mode: DroneFlightMode
  readonly health: DroneHealthState
  readonly profileId: string
  readonly color: string
  readonly swarmId?: string
}

export interface DroneControllerBinding {
  readonly droneId: ObjectId
  readonly actorId?: ActorId
  readonly clientId?: ClientId
  readonly inputKind?: DroneInputSource['kind']
  readonly label?: string
  readonly inputExpiresAt?: IsoTimestamp
}
