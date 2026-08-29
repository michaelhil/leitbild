import type { GeoJsonPoint, OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectField, PackObjectPresentation, PackObjectStatusPresentation } from '../../core/packs/protocol.ts'
import { createLeitbildPackDescriptor } from '../../core/packs/protocol.ts'
import {
  createDroneCommandKind,
  holdDroneCommandKind,
  navigateDroneCommandKind,
  type CreatableDroneObjectType,
} from './commands.ts'
import { createDroneAttackInteractionHandler } from './interactions.ts'
import {
  defaultDroneVehicleModels,
  droneHasCapability,
  droneHorizontalSpeedMps,
  dronePackDataSchema,
  dronePackId,
  type DronePackData,
} from './model.ts'
import { droneNativeRuntimeId } from './native/constants.ts'

const parseDroneData = (object: OperationalObject): DronePackData | null => {
  if (object.packId !== dronePackId) return null
  const parsed = dronePackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

const oneDecimal = (value: number): string => `${Math.round(value * 10) / 10}`

const maybePercent = (value: number | undefined): string =>
  value === undefined ? 'unknown' : `${Math.round(value)}%`

const capabilityText = (data: DronePackData): string =>
  data.vehicle.capabilities.length === 0
    ? 'none'
    : data.vehicle.capabilities.map(capability => capability.label).join(', ')

const payloadText = (data: DronePackData): string =>
  data.vehicle.payloads.length === 0
    ? 'none'
    : data.vehicle.payloads.map(payload => `${payload.label} x${payload.quantity}`).join(', ')

const droneFields = (data: DronePackData): ReadonlyArray<PackObjectField> => [
  packField('model', 'Model', data.vehicle.modelLabel),
  packField('link', 'Link', data.link.state),
  packField('arming', 'Arming', data.arming.state),
  packField('mode', 'Mode', data.navigation.mode),
  packField('altitude', 'Altitude', `${oneDecimal(data.pose.altitudeM)} m`),
  packField('speed', 'Speed', `${oneDecimal(droneHorizontalSpeedMps(data.velocity))} m/s`),
  packField('battery', 'Battery', maybePercent(data.battery.remainingPercent)),
  packField('health', 'Health', data.health.state),
  packField('mission', 'Mission', `${data.mission.state}${data.mission.currentSeq === undefined ? '' : ` ${data.mission.currentSeq}/${data.mission.total ?? '?'}`}`),
  packField('capabilities', 'Capabilities', capabilityText(data)),
  packField('payloads', 'Payloads', payloadText(data)),
  ...(data.swarm ? [packField('swarm', 'Swarm', `${data.swarm.swarmId} · ${data.swarm.role}`)] : []),
]

const droneStatus = (data: DronePackData): PackObjectStatusPresentation => {
  if (data.health.state === 'destroyed') return packStatus('error', 'Destroyed')
  if (data.link.state === 'lost') return packStatus('error', 'Link lost', { shape: 'dot', pulse: true })
  if (data.health.state === 'critical' || data.health.state === 'failed') return packStatus('error', data.health.state, { shape: 'dot', pulse: true })
  if (data.link.state === 'degraded') return packStatus('working', 'Link degraded', { shape: 'dot', pulse: true })
  if (data.link.state === 'connecting') return packStatus('idle', 'Connecting', { shape: 'dot', pulse: true })
  if (data.arming.armed) return packStatus('working', data.navigation.kind.replaceAll('_', ' '), { shape: 'arrow', direction: 'up', pulse: true })
  return packStatus('ready', 'Disarmed')
}

const droneSummary = (data: DronePackData): string =>
  `${data.vehicle.modelLabel} · ${data.link.state} · ${data.navigation.mode} · ${maybePercent(data.battery.remainingPercent)} battery`

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

export const droneUiPack: LeitbildPack = {
  descriptor: createLeitbildPackDescriptor({
    id: dronePackId, version: '1.0.0', name: 'Drone Operations',
    contributions: ['runtime', 'knowledge', 'presentation', 'commands', 'interactions'],
  }),
  runtime: {
    runtimes: [{ id: droneNativeRuntimeId, version: '1.0.0', label: 'Native drone runtime', kind: 'local' }],
    defaultRuntimeId: droneNativeRuntimeId,
  },
  knowledge: { wikiRefs: [{ name: 'Drone operations', url: '/docs/wiki/drone-ops.md' }] },
  presentation: {
    categories: [
    {
      id: 'drones',
      label: 'Drones',
      emptyLabel: 'No drones',
      matches: (object: OperationalObject): boolean => parseDroneData(object) !== null,
    },
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
        color: data?.vehicle.visual.color ?? '#2563eb',
        summary: data ? droneSummary(data) : object.operational.status,
        status: data ? droneStatus(data) : packStatus('error', 'Invalid drone data'),
        fields: data ? droneFields(data) : [packField('error', 'Error', 'Invalid drone pack data')],
        mapIconSizePx: data ? Math.max(22, Math.round(24 * data.vehicle.visual.scale)) : 24,
        noteworthyUpdates: data?.health.state === 'degraded' || data?.health.state === 'critical' || data?.health.state === 'failed' || data?.health.state === 'destroyed',
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
          return distanceM < 1_500 ? [{ label: candidate.label, distanceM, mode: data.navigation.kind }] : []
        })
        .sort((left, right) => left.distanceM - right.distanceM)
        .slice(0, 3)
      if (nearby.length === 0) return []
      return [packField('nearby-drones', 'Nearby drones', nearby.map(item => `${item.label} ${Math.round(item.distanceM)} m ${item.mode}`).join(', '))]
    },
  },
  commands: {
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
          key: 'modelId',
          label: 'Model',
          kind: 'select',
          defaultValue: 'native-survey-quad',
          options: defaultDroneVehicleModels.map(model => ({ value: model.id, label: model.label })),
        },
        { key: 'altitudeM', label: 'Altitude m', kind: 'number', defaultValue: 35, min: 0, max: 500, step: 5 },
      ],
    },
    ],
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
        modelId: typeof record.modelId === 'string' ? record.modelId : 'native-survey-quad',
        altitudeM: typeof record.altitudeM === 'number' ? record.altitudeM : 35,
      },
    }
  },
    isController: (object): boolean => {
    const data = parseDroneData(object)
    return data !== null && data.health.state !== 'destroyed' && data.link.state !== 'lost'
  },
    isTarget: (controller, candidate): boolean => {
    if (controller.id === candidate.id) return false
    const data = parseDroneData(controller)
    if (!data) return false
    if (candidate.spatial.position?.point === undefined && candidate.spatial.geometry?.type !== 'Point') return false
    return droneHasCapability(data.vehicle, 'guided_navigation')
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
          altitudeM: Math.max(10, data.pose.altitudeM),
          targetObjectId: target.id,
        },
      },
    }
  },
    buildCancelTargetCommand: (controller): PackCommandRequest => ({
      kind: holdDroneCommandKind,
      targetObjectIds: [controller.id],
      payload: { droneId: controller.id },
    }),
  },
  interactions: {
    handlers: [createDroneAttackInteractionHandler()],
  },
}
