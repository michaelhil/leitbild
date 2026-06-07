import type { GeoJsonPoint, OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectField, PackObjectPresentation, PackObjectStatusPresentation } from '../../core/packs/protocol.ts'
import {
  createDroneCommandKind,
  navigateDroneCommandKind,
  setDroneModeCommandKind,
  type CreatableDroneObjectType,
} from './commands.ts'
import { createDroneAttackInteractionHandler } from './interactions.ts'
import { defaultDroneProfiles, droneHasCapability, droneHorizontalSpeedMps, dronePackDataSchema, dronePackId, type DronePackData } from './model.ts'
import { droneScenarioSupport } from './scenario.ts'
import { droneSimRuntimeId } from './sim/constants.ts'

const parseDroneData = (object: OperationalObject): DronePackData | null => {
  if (object.packId !== dronePackId) return null
  const parsed = dronePackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

const oneDecimal = (value: number): string => `${Math.round(value * 10) / 10}`

const batteryPercent = (data: DronePackData): number =>
  data.energy.remainingWh / data.profile.energy.capacityWh * 100

const capabilityText = (data: DronePackData): string =>
  data.profile.capabilities.length === 0
    ? 'none'
    : data.profile.capabilities.map(capability => capability.label).join(', ')

const payloadText = (data: DronePackData): string =>
  data.profile.payloads.length === 0
    ? 'none'
    : data.profile.payloads.map(payload => `${payload.label} x${payload.quantity}`).join(', ')

const droneFields = (data: DronePackData): ReadonlyArray<PackObjectField> => [
  packField('profile', 'Profile', data.profile.label),
  packField('mode', 'Mode', data.control.mode.replaceAll('_', ' ')),
  packField('altitude', 'Altitude', `${oneDecimal(data.kinematics.altitudeM)} m`),
  packField('speed', 'Speed', `${oneDecimal(droneHorizontalSpeedMps(data.kinematics))} m/s`),
  packField('battery', 'Battery', `${Math.round(batteryPercent(data))}%`),
  packField('health', 'Health', `${data.health.state} · ${Math.round(data.health.integrity * 100)}%`),
  packField('capabilities', 'Capabilities', capabilityText(data)),
  packField('payloads', 'Payloads', payloadText(data)),
  ...(data.swarm ? [packField('swarm', 'Swarm', `${data.swarm.swarmId} · ${data.swarm.role}`)] : []),
]

const droneStatus = (data: DronePackData): PackObjectStatusPresentation => {
  if (data.health.state === 'destroyed') return packStatus('error', 'Destroyed')
  if (data.health.state === 'disabled') return packStatus('error', 'Disabled')
  if (batteryPercent(data) <= 15) return packStatus('error', 'Battery critical', { shape: 'dot', pulse: true })
  if (batteryPercent(data) <= 30) return packStatus('working', 'Battery low', { shape: 'dot', pulse: true })
  if (data.control.mode === 'manual') return packStatus('working', 'Manual control', { shape: 'arrow', direction: 'up', pulse: true })
  if (data.control.mode === 'guided' || data.control.mode === 'swarm' || data.control.mode === 'mission') return packStatus('working', data.control.mode.replaceAll('_', ' '), { shape: 'dot', pulse: true })
  return packStatus('ready', data.control.mode.replaceAll('_', ' '))
}

const droneSummary = (data: DronePackData): string =>
  `${data.profile.label} · ${data.control.mode.replaceAll('_', ' ')} · ${Math.round(batteryPercent(data))}% battery · ${oneDecimal(data.kinematics.altitudeM)} m`

const assertCreatableType = (typeId: string): CreatableDroneObjectType => {
  if (typeId === 'drone') return typeId
  throw new Error(`unsupported drone create type: ${typeId}`)
}

const assertPointGeometry = (geometry: PackCreationGeometry): GeoJsonPoint => {
  if (geometry.kind !== 'point') throw new Error(`drone object creation requires point geometry, got ${geometry.kind}`)
  return geometry.point
}

const pointForTarget = (target: OperationalObject): GeoJsonPoint => {
  const point = target.spatial.position?.point ?? (target.spatial.geometry?.type === 'Point' ? target.spatial.geometry : null)
  if (!point) throw new Error(`target ${target.id} has no point position`)
  return point
}

export const dronePack: LeitbildPack = {
  id: dronePackId,
  name: 'Drone Operations',
  runtimes: [
    { id: droneSimRuntimeId, label: 'Local drone runtime', kind: 'local' },
  ],
  defaultRuntimeId: droneSimRuntimeId,
  wikiRefs: [
    { name: 'Drone operations', url: '/docs/wiki/drone-ops.md' },
  ],
  scenario: droneScenarioSupport,
  categories: [
    {
      id: 'drones',
      label: 'Drones',
      emptyLabel: 'No drones',
      matches: (object: OperationalObject): boolean => parseDroneData(object) !== null,
    },
  ],
  createObjectTypes: [
    {
      id: 'drone',
      label: 'Drone',
      categoryId: 'drones',
      icon: 'drone',
      color: '#2563eb',
      placementKind: 'point',
      parameters: [
        {
          key: 'profileId',
          label: 'Profile',
          kind: 'select',
          defaultValue: 'quad-surveillance',
          options: defaultDroneProfiles.map(profile => ({ value: profile.id, label: profile.label })),
        },
        { key: 'altitudeM', label: 'Altitude m', kind: 'number', defaultValue: 35, min: 0, max: 500, step: 5 },
      ],
    },
  ],
  interactionHandlers: [
    createDroneAttackInteractionHandler(),
  ],
  mapAreaFeatureLayers: ['objects'],
  mapAreaFeatureSourcePackIds: [dronePackId],
  mapAreaFeatureQueries: (context) => context.map
    ? [{
        packId: dronePackId,
        kind: 'drone.mapFeatures',
        payload: {
          viewport: context.map.viewport,
          zoom: context.map.zoom,
          layers: ['sensor-footprints', 'effect-ranges', 'swarm-envelopes'],
        },
      }]
    : [],
  presentObject: (object): PackObjectPresentation => {
    const data = parseDroneData(object)
    return {
      categoryId: 'drones',
      icon: 'drone',
      color: data?.profile.visual.color ?? '#2563eb',
      summary: data ? droneSummary(data) : object.operational.status,
      status: data ? droneStatus(data) : packStatus('error', 'Invalid drone data'),
      fields: data ? droneFields(data) : [packField('error', 'Error', 'Invalid drone pack data')],
      mapIconSizePx: data ? Math.max(22, Math.round(24 * data.profile.visual.scale)) : 24,
      noteworthyUpdates: data?.health.state === 'degraded' || data?.health.state === 'disabled' || data?.health.state === 'destroyed',
    }
  },
  contextualFields: (object, context): ReadonlyArray<PackObjectField> => {
    if (object.packId === dronePackId) return []
    const point = object.spatial.position?.point ?? (object.spatial.geometry?.type === 'Point' ? object.spatial.geometry : null)
    if (!point) return []
    const nearby = context.objects
      .flatMap(candidate => {
        const data = parseDroneData(candidate)
        const candidatePoint = candidate.spatial.position?.point
        if (!data || !candidatePoint) return []
        const lonDelta = (candidatePoint.coordinates[0] - point.coordinates[0]) * 111_320
        const latDelta = (candidatePoint.coordinates[1] - point.coordinates[1]) * 111_320
        const distanceM = Math.hypot(lonDelta, latDelta)
        return distanceM < 1_500 ? [{ label: candidate.label, distanceM, mode: data.control.mode }] : []
      })
      .sort((left, right) => left.distanceM - right.distanceM)
      .slice(0, 3)
    if (nearby.length === 0) return []
    return [packField('nearby-drones', 'Nearby drones', nearby.map(item => `${item.label} ${Math.round(item.distanceM)} m ${item.mode}`).join(', '))]
  },
  defaultObjectLabel: (typeId, context): string => {
    assertCreatableType(typeId)
    const count = context.objects.filter(object => parseDroneData(object) !== null).length + 1
    return `Drone ${count}`
  },
  buildCreateObjectCommand: (typeId: string, label: string, geometry: PackCreationGeometry, parameters?: unknown): PackCommandRequest => {
    assertCreatableType(typeId)
    const record = typeof parameters === 'object' && parameters !== null ? parameters as Record<string, unknown> : {}
    return {
      kind: createDroneCommandKind,
      targetObjectIds: [],
      payload: {
        objectType: 'drone',
        label,
        point: assertPointGeometry(geometry),
        profileId: typeof record.profileId === 'string' ? record.profileId : 'quad-surveillance',
        altitudeM: typeof record.altitudeM === 'number' ? record.altitudeM : 35,
      },
    }
  },
  isController: (object): boolean => {
    const data = parseDroneData(object)
    return data !== null && data.health.state !== 'destroyed' && data.health.state !== 'disabled'
  },
  isTarget: (controller, candidate): boolean => {
    if (controller.id === candidate.id) return false
    const data = parseDroneData(controller)
    if (!data) return false
    if (candidate.spatial.position?.point === undefined && candidate.spatial.geometry?.type !== 'Point') return false
    return droneHasCapability(data.profile, 'guided_navigation')
  },
  buildSetTargetCommand: (controller, target): PackCommandRequest => {
    const data = parseDroneData(controller)
    if (!data) throw new Error(`controller is not a drone: ${controller.id}`)
    return {
      kind: navigateDroneCommandKind,
      targetObjectIds: [controller.id],
      payload: {
        droneId: controller.id,
        target: {
          point: pointForTarget(target),
          altitudeM: Math.max(10, data.kinematics.altitudeM),
          targetObjectId: target.id,
        },
      },
    }
  },
  buildCancelTargetCommand: (controller): PackCommandRequest => ({
    kind: setDroneModeCommandKind,
    targetObjectIds: [controller.id],
    payload: {
      droneId: controller.id,
      mode: 'hold',
    },
  }),
}
