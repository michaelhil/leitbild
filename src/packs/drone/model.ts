import { z } from 'zod'
import {
  actorIdSchema,
  clientIdSchema,
  geoJsonPointSchema,
  idSchema,
  isoTimestampSchema,
  objectIdSchema,
  type ActorId,
  type ClientId,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
} from '../../core/model/index.ts'

export const dronePackId = 'drone' as const

export const droneAutopilotSchema = z.enum(['px4', 'ardupilot'])
export type DroneAutopilot = z.infer<typeof droneAutopilotSchema>

export const droneLinkStateSchema = z.enum(['connecting', 'connected', 'degraded', 'lost'])
export type DroneLinkState = z.infer<typeof droneLinkStateSchema>

export const droneArmingStateSchema = z.enum(['armed', 'disarmed', 'unknown'])
export type DroneArmingState = z.infer<typeof droneArmingStateSchema>

export const droneNavigationKindSchema = z.enum([
  'manual',
  'hold',
  'mission',
  'guided',
  'offboard',
  'land',
  'return_to_launch',
  'takeoff',
  'failsafe',
  'unknown',
])
export type DroneNavigationKind = z.infer<typeof droneNavigationKindSchema>

export const droneHealthStateSchema = z.enum(['nominal', 'degraded', 'critical', 'failed', 'destroyed', 'unknown'])
export type DroneHealthState = z.infer<typeof droneHealthStateSchema>

export const droneMissionExecutionStateSchema = z.enum(['idle', 'uploading', 'ready', 'running', 'paused', 'complete', 'failed', 'unknown'])
export type DroneMissionExecutionState = z.infer<typeof droneMissionExecutionStateSchema>

export const droneFlightModeSchema = droneNavigationKindSchema
export type DroneFlightMode = DroneNavigationKind

export const droneAirframeSchema = z.object({
  kind: z.string().min(1).max(64),
  rotorCount: z.number().int().nonnegative().max(32),
  massKg: z.number().finite().positive().max(500).optional(),
  diagonalSizeM: z.number().finite().positive().max(10).optional(),
}).strict()
export type DroneAirframe = z.infer<typeof droneAirframeSchema>

export const droneSensorSchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  rangeM: z.number().finite().positive().max(100_000),
  fovDeg: z.number().finite().positive().max(360).default(90),
  updateIntervalMs: z.number().int().positive().max(60_000).default(1_000),
  source: z.enum(['gazebo', 'autopilot', 'payload', 'operator_declared']).default('operator_declared'),
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
  source: z.enum(['gazebo', 'autopilot', 'payload', 'operator_declared']).default('operator_declared'),
  tags: z.array(z.string().min(1).max(48)).default([]),
}).strict()
export type DronePayload = z.infer<typeof dronePayloadSchema>

export const droneCapabilitySchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  level: z.number().finite().min(0).max(10).default(1),
  source: z.enum(['gazebo', 'autopilot', 'payload', 'operator_declared']).default('operator_declared'),
  tags: z.array(z.string().min(1).max(48)).default([]),
}).strict()
export type DroneCapability = z.infer<typeof droneCapabilitySchema>

export const droneVisualProfileSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563eb'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f8fafc'),
  scale: z.number().finite().positive().max(10).default(1),
  meshRef: z.string().min(1).max(240).optional(),
}).strict()
export type DroneVisualProfile = z.infer<typeof droneVisualProfileSchema>

export const droneVehicleModelSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(96),
  description: z.string().min(1).max(500).optional(),
  autopilotModel: z.string().min(1).max(128),
  gazeboModel: z.string().min(1).max(128),
  airframe: droneAirframeSchema,
  capabilities: z.array(droneCapabilitySchema).default([]),
  sensors: z.array(droneSensorSchema).default([]),
  payloads: z.array(dronePayloadSchema).default([]),
  visual: droneVisualProfileSchema.default({
    color: '#2563eb',
    accentColor: '#f8fafc',
    scale: 1,
  }),
}).strict()
export type DroneVehicleModel = z.infer<typeof droneVehicleModelSchema>

export const droneProfileSchema = droneVehicleModelSchema
export type DroneProfile = DroneVehicleModel

export const dronePoseSchema = z.object({
  point: geoJsonPointSchema,
  altitudeM: z.number().finite().min(-1_000).max(100_000),
  relativeAltitudeM: z.number().finite().min(-1_000).max(100_000).optional(),
  headingDeg: z.number().finite().min(0).max(360).default(0),
  accuracyM: z.number().finite().nonnegative().max(100_000).optional(),
  observedAt: isoTimestampSchema,
}).strict()
export type DronePose = z.infer<typeof dronePoseSchema>

export const droneVelocitySchema = z.object({
  eastMps: z.number().finite().min(-500).max(500).default(0),
  northMps: z.number().finite().min(-500).max(500).default(0),
  downMps: z.number().finite().min(-500).max(500).default(0),
  groundSpeedMps: z.number().finite().nonnegative().max(500).default(0),
  verticalSpeedMps: z.number().finite().min(-500).max(500).default(0),
}).strict()
export type DroneVelocity = z.infer<typeof droneVelocitySchema>

export const droneAttitudeSchema = z.object({
  rollDeg: z.number().finite().min(-180).max(180).default(0),
  pitchDeg: z.number().finite().min(-180).max(180).default(0),
  yawDeg: z.number().finite().min(0).max(360).default(0),
  rollRateDegPerSec: z.number().finite().min(-1_500).max(1_500).optional(),
  pitchRateDegPerSec: z.number().finite().min(-1_500).max(1_500).optional(),
  yawRateDegPerSec: z.number().finite().min(-1_500).max(1_500).optional(),
}).strict()
export type DroneAttitude = z.infer<typeof droneAttitudeSchema>

export const droneBatteryStateSchema = z.object({
  remainingPercent: z.number().finite().min(0).max(100).optional(),
  voltageV: z.number().finite().nonnegative().max(1_000).optional(),
  currentA: z.number().finite().min(-1_000).max(1_000).optional(),
  consumedMah: z.number().finite().nonnegative().max(10_000_000).optional(),
}).strict()
export type DroneBatteryState = z.infer<typeof droneBatteryStateSchema>

export const droneManualAxesSchema = z.object({
  forward: z.number().finite().min(-1).max(1).default(0),
  right: z.number().finite().min(-1).max(1).default(0),
  vertical: z.number().finite().min(-1).max(1).default(0),
  yaw: z.number().finite().min(-1).max(1).default(0),
}).strict()
export type DroneManualAxes = z.infer<typeof droneManualAxesSchema>

export const droneInputSourceSchema = z.object({
  kind: z.enum(['keyboard', 'mouse', 'gamepad', 'map', 'scenario', 'ai', 'operator']),
  label: z.string().min(1).max(120).optional(),
  gamepadIndex: z.number().int().nonnegative().max(16).optional(),
  clientId: clientIdSchema.optional(),
}).strict()
export type DroneInputSource = z.infer<typeof droneInputSourceSchema>

export const droneGuidedTargetSchema = z.object({
  point: geoJsonPointSchema,
  altitudeM: z.number().finite().min(-1_000).max(100_000),
  speedMps: z.number().finite().positive().max(160).optional(),
  targetObjectId: objectIdSchema.optional(),
}).strict()
export type DroneGuidedTarget = z.infer<typeof droneGuidedTargetSchema>

export const droneControlStateSchema = z.object({
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

export const droneAutopilotHealthSchema = z.object({
  state: droneHealthStateSchema,
  ekfOk: z.boolean().optional(),
  gpsOk: z.boolean().optional(),
  batteryOk: z.boolean().optional(),
  localPositionOk: z.boolean().optional(),
  globalPositionOk: z.boolean().optional(),
  lastStatusText: z.string().min(1).max(240).optional(),
  damage: z.array(droneDamageRecordSchema).default([]),
}).strict()
export type DroneAutopilotHealth = z.infer<typeof droneAutopilotHealthSchema>

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
  state: droneMissionExecutionStateSchema,
  currentSeq: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  planId: idSchema.optional(),
  updatedAt: isoTimestampSchema.optional(),
}).strict()
export type DroneMissionState = z.infer<typeof droneMissionStateSchema>

export const droneGeofenceStateSchema = z.object({
  loaded: z.boolean().default(false),
  breachStatus: z.enum(['clear', 'breached', 'unknown']).default('unknown'),
  updatedAt: isoTimestampSchema.optional(),
}).strict()
export type DroneGeofenceState = z.infer<typeof droneGeofenceStateSchema>

export const dronePayloadRuntimeStateSchema = z.object({
  gimbalPitchDeg: z.number().finite().min(-180).max(180).optional(),
  gimbalYawDeg: z.number().finite().min(-180).max(180).optional(),
  cameraMode: z.string().min(1).max(64).optional(),
  activeSensorId: idSchema.optional(),
}).strict()
export type DronePayloadRuntimeState = z.infer<typeof dronePayloadRuntimeStateSchema>

export const droneVehicleIdentitySchema = z.object({
  modelId: idSchema,
  modelLabel: z.string().min(1).max(96),
  autopilotModel: z.string().min(1).max(128),
  gazeboModel: z.string().min(1).max(128),
  systemId: z.number().int().min(1).max(255),
  componentId: z.number().int().min(1).max(255).default(1),
  airframe: droneAirframeSchema,
  capabilities: z.array(droneCapabilitySchema).default([]),
  sensors: z.array(droneSensorSchema).default([]),
  payloads: z.array(dronePayloadSchema).default([]),
  visual: droneVisualProfileSchema.default({
    color: '#2563eb',
    accentColor: '#f8fafc',
    scale: 1,
  }),
}).strict()
export type DroneVehicleIdentity = z.infer<typeof droneVehicleIdentitySchema>

export const dronePackDataSchema = z.object({
  type: z.literal('drone'),
  schemaVersion: z.literal(2),
  autopilot: droneAutopilotSchema,
  vehicle: droneVehicleIdentitySchema,
  link: z.object({
    state: droneLinkStateSchema,
    endpoint: z.string().min(1).max(240).optional(),
    lastHeartbeatAt: isoTimestampSchema.optional(),
    lastMessageAt: isoTimestampSchema.optional(),
  }).strict(),
  arming: z.object({
    state: droneArmingStateSchema,
    armed: z.boolean(),
    updatedAt: isoTimestampSchema.optional(),
  }).strict(),
  navigation: z.object({
    kind: droneNavigationKindSchema,
    mode: z.string().min(1).max(96),
    customMode: z.number().int().nonnegative().optional(),
    updatedAt: isoTimestampSchema.optional(),
  }).strict(),
  pose: dronePoseSchema,
  velocity: droneVelocitySchema.default({
    eastMps: 0,
    northMps: 0,
    downMps: 0,
    groundSpeedMps: 0,
    verticalSpeedMps: 0,
  }),
  attitude: droneAttitudeSchema.default({
    rollDeg: 0,
    pitchDeg: 0,
    yawDeg: 0,
  }),
  battery: droneBatteryStateSchema.default({}),
  health: droneAutopilotHealthSchema,
  control: droneControlStateSchema.default({}),
  mission: droneMissionStateSchema.default({ state: 'unknown' }),
  geofence: droneGeofenceStateSchema.default({ loaded: false, breachStatus: 'unknown' }),
  payload: dronePayloadRuntimeStateSchema.default({}),
  swarm: droneSwarmMembershipSchema.optional(),
}).strict()
export type DronePackData = z.infer<typeof dronePackDataSchema>

export const droneVehicleModelCatalogSchema = z.object({
  models: z.array(droneVehicleModelSchema).default([]),
}).strict()
export type DroneVehicleModelCatalog = z.infer<typeof droneVehicleModelCatalogSchema>

export const droneProfileCatalogSchema = z.object({
  profiles: z.array(droneVehicleModelSchema).default([]),
}).strict()
export type DroneProfileCatalog = z.infer<typeof droneProfileCatalogSchema>

export const defaultDroneVehicleModels: ReadonlyArray<DroneVehicleModel> = [
  droneVehicleModelSchema.parse({
    id: 'px4-x500-depth',
    label: 'PX4 X500 Depth',
    description: 'PX4 Gazebo X500 quadrotor with depth camera support.',
    autopilotModel: 'x500_depth',
    gazeboModel: 'x500_depth',
    airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 2.4, diagonalSizeM: 0.46 },
    capabilities: [
      { id: 'manual-control', kind: 'manual_control', label: 'Manual control', source: 'autopilot' },
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'autopilot' },
      { id: 'mission', kind: 'mission', label: 'Mission upload', source: 'autopilot' },
      { id: 'geofence', kind: 'geofence', label: 'Geofence', source: 'autopilot' },
      { id: 'depth-camera', kind: 'depth_camera', label: 'Depth camera', source: 'gazebo' },
    ],
    sensors: [
      { id: 'depth-camera', kind: 'depth_camera', label: 'Depth camera', rangeM: 80, fovDeg: 70, updateIntervalMs: 100, source: 'gazebo' },
      { id: 'mavlink-global-position', kind: 'global_position', label: 'Autopilot global position', rangeM: 1, fovDeg: 360, source: 'autopilot' },
    ],
    visual: { color: '#2563eb', accentColor: '#f8fafc', scale: 1 },
  }),
  droneVehicleModelSchema.parse({
    id: 'px4-x500-gimbal',
    label: 'PX4 X500 Gimbal',
    description: 'PX4 Gazebo X500 quadrotor with camera gimbal payload.',
    autopilotModel: 'x500_gimbal',
    gazeboModel: 'x500_gimbal',
    airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 2.7, diagonalSizeM: 0.5 },
    capabilities: [
      { id: 'manual-control', kind: 'manual_control', label: 'Manual control', source: 'autopilot' },
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'autopilot' },
      { id: 'mission', kind: 'mission', label: 'Mission upload', source: 'autopilot' },
      { id: 'camera-gimbal', kind: 'camera_gimbal', label: 'Camera gimbal', source: 'gazebo' },
    ],
    sensors: [
      { id: 'eo-gimbal-camera', kind: 'electro_optical', label: 'EO gimbal camera', rangeM: 1_200, fovDeg: 60, updateIntervalMs: 100, source: 'gazebo' },
    ],
    payloads: [
      { id: 'eo-gimbal', kind: 'camera_gimbal', label: 'EO gimbal', quantity: 1, source: 'gazebo' },
    ],
    visual: { color: '#0f766e', accentColor: '#ecfeff', scale: 1.08 },
  }),
  droneVehicleModelSchema.parse({
    id: 'ardupilot-iris',
    label: 'ArduPilot Iris',
    description: 'ArduPilot Copter Iris model for Gazebo SITL.',
    autopilotModel: 'iris',
    gazeboModel: 'iris',
    airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 1.5, diagonalSizeM: 0.55 },
    capabilities: [
      { id: 'manual-control', kind: 'manual_control', label: 'Manual control', source: 'autopilot' },
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'autopilot' },
      { id: 'mission', kind: 'mission', label: 'Mission upload', source: 'autopilot' },
      { id: 'geofence', kind: 'geofence', label: 'Geofence', source: 'autopilot' },
    ],
    sensors: [
      { id: 'ardupilot-gps', kind: 'global_position', label: 'Autopilot global position', rangeM: 1, fovDeg: 360, source: 'autopilot' },
    ],
    visual: { color: '#b91c1c', accentColor: '#fee2e2', scale: 1.02 },
  }),
]

export const defaultDroneProfiles = defaultDroneVehicleModels

export const droneVehicleModelMap = (
  models: ReadonlyArray<DroneVehicleModel> = defaultDroneVehicleModels,
): ReadonlyMap<string, DroneVehicleModel> =>
  new Map(models.map(model => [model.id, model]))

export const requireDroneVehicleModel = (
  modelId: string,
  models: ReadonlyArray<DroneVehicleModel> = defaultDroneVehicleModels,
): DroneVehicleModel => {
  const model = droneVehicleModelMap(models).get(modelId)
  if (!model) throw new Error(`unknown drone vehicle model: ${modelId}`)
  return model
}

export const requireDroneProfile = requireDroneVehicleModel

export const isDronePackData = (value: unknown): value is DronePackData =>
  dronePackDataSchema.safeParse(value).success

export const droneHasCapability = (
  model: {
    readonly capabilities: ReadonlyArray<DroneCapability>
  },
  kind: string,
): boolean =>
  model.capabilities.some(capability => capability.kind === kind)

export const droneHorizontalSpeedMps = (velocity: DroneVelocity): number =>
  Math.hypot(velocity.eastMps, velocity.northMps)

export interface DroneSceneObject {
  readonly id: ObjectId
  readonly label: string
  readonly point: GeoJsonPoint
  readonly altitudeM: number
  readonly headingDeg: number
  readonly mode: DroneNavigationKind
  readonly health: DroneHealthState
  readonly modelId: string
  readonly color: string
  readonly link: DroneLinkState
  readonly armed: boolean
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

export interface DroneSensorContact {
  readonly droneId: ObjectId
  readonly sensorId: string
  readonly targetId: ObjectId
  readonly targetLabel: string
  readonly distanceM: number
  readonly bearingDeg: number
  readonly confidence: number
  readonly source: 'gazebo' | 'autopilot' | 'payload'
}
