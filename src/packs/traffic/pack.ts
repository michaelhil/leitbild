import type { KnowledgeFact, OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectField, PackObjectPresentation } from '../../core/packs/protocol.ts'
import { createTrafficConditionCommandKind } from './commands.ts'
import { trafficDomainDataSchema, trafficDomainId, type TrafficDomainData, type TrafficSeverity } from './model.ts'
import { createTrafficRouteImpactHandler } from './interactions.ts'
import { trafficSimProviderId } from './sim/constants.ts'

const factText = <T>(fact: KnowledgeFact<T> | undefined, formatter: (value: T) => string = String): string =>
  !fact || fact.state === 'unknown' ? 'unknown' : formatter(fact.value)

const parseTrafficData = (object: OperationalObject): TrafficDomainData | null => {
  const parsed = trafficDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const trafficDetails = (data: TrafficDomainData): ReadonlyArray<PackObjectField> => [
  packField('geometry', 'Geometry', data.geometryMode.replaceAll('_', ' ')),
  packField('condition', 'Condition', data.condition.replaceAll('_', ' ')),
  packField('severity', 'Severity', data.severity),
  packField('reason', 'Reason', factText(data.reason)),
  packField('affected', 'Affected', data.affectedModes.map(mode => mode.replaceAll('_', ' ')).join(', ')),
  ...(data.speedFactor === undefined ? [] : [packField('speed-factor', 'Speed factor', `${Math.round(data.speedFactor * 100)}%`)]),
  ...(data.delaySecondsEstimate === undefined ? [] : [packField('estimated-delay', 'Estimated delay', factText(data.delaySecondsEstimate, value => `${Math.round(value)}s`))]),
]

const trafficColor = (severity: TrafficSeverity | undefined): string => {
  if (severity === 'blocked') return '#7f1d1d'
  if (severity === 'high') return '#dc2626'
  if (severity === 'moderate') return '#f59e0b'
  return '#eab308'
}

interface TrafficCreationParameters {
  readonly severity?: TrafficSeverity
  readonly speedFactor?: number
  readonly reason?: string
}

const unsupportedCommand = (): PackCommandRequest => {
  throw new Error('traffic pack does not support object creation or target commands yet')
}

const trafficCreationParameters = (parameters: unknown): Required<TrafficCreationParameters> => {
  if (typeof parameters !== 'object' || parameters === null) {
    return { severity: 'high', speedFactor: 0.55, reason: 'Operator-created traffic condition' }
  }
  const raw = parameters as TrafficCreationParameters
  return {
    severity: raw.severity ?? 'high',
    speedFactor: raw.speedFactor ?? 0.55,
    reason: raw.reason?.trim() || 'Operator-created traffic condition',
  }
}

const buildTrafficCreatePayload = (
  typeId: string,
  label: string,
  geometry: PackCreationGeometry,
  parameters: unknown,
): unknown => {
  const trafficParameters = trafficCreationParameters(parameters)
  if (typeId === 'traffic_road_segment') {
    if (geometry.kind !== 'route') throw new Error(`traffic road segment creation requires route geometry, got ${geometry.kind}`)
    return {
      objectType: 'traffic_road_segment',
      label,
      from: geometry.from,
      to: geometry.to,
      condition: trafficParameters.severity === 'blocked' ? 'closure' : 'slowdown',
      severity: trafficParameters.severity,
      speedFactor: trafficParameters.speedFactor,
      reason: trafficParameters.reason,
    }
  }
  if (typeId === 'traffic_area') {
    if (geometry.kind !== 'polygon') throw new Error(`traffic area creation requires polygon geometry, got ${geometry.kind}`)
    return {
      objectType: 'traffic_area',
      label,
      polygon: geometry.polygon,
      condition: trafficParameters.severity === 'blocked' ? 'closure' : 'slowdown',
      severity: trafficParameters.severity,
      speedFactor: trafficParameters.speedFactor,
      reason: trafficParameters.reason,
    }
  }
  throw new Error(`unsupported traffic create type: ${typeId}`)
}

export const trafficPack: LeitbildPack = {
  id: 'traffic',
  name: 'Traffic Conditions',
  domain: trafficDomainId,
  simulationProviders: [
    { id: trafficSimProviderId, label: 'Local traffic simulator', kind: 'local' },
  ],
  defaultSimulationProviderId: trafficSimProviderId,
  categories: [
    {
      id: 'traffic',
      label: 'Traffic',
      emptyLabel: 'No traffic conditions',
      matches: (object: OperationalObject): boolean => parseTrafficData(object) !== null,
    },
  ],
  createObjectTypes: [
    { id: 'traffic_road_segment', label: 'Road traffic', categoryId: 'traffic', icon: 'traffic', color: '#c2410c', placementKind: 'route' },
    { id: 'traffic_area', label: 'Traffic area', categoryId: 'traffic', icon: 'traffic', color: '#c2410c', placementKind: 'polygon' },
  ],
  interactionHandlers: [
    createTrafficRouteImpactHandler(),
  ],
  presentObject: (object): PackObjectPresentation => {
    const data = parseTrafficData(object)
    return {
      categoryId: 'traffic',
      icon: 'traffic',
      color: trafficColor(data?.severity),
      summary: data ? `${data.geometryMode.replaceAll('_', ' ')} · ${data.severity}` : object.operational.status,
      status: packStatus(data?.severity === 'blocked' || data?.severity === 'high' ? 'error' : 'working', data ? `${data.condition.replaceAll('_', ' ')} · ${data.severity}` : object.operational.status),
      fields: data ? trafficDetails(data) : [packField('error', 'Error', 'Invalid traffic domain data')],
    }
  },
  defaultObjectLabel: (typeId, context): string => {
    const count = context.objects.filter(object => parseTrafficData(object) !== null).length + 1
    if (typeId === 'traffic_road_segment') return `Road traffic ${count}`
    if (typeId === 'traffic_area') return `Traffic area ${count}`
    throw new Error(`unsupported traffic create type: ${typeId}`)
  },
  buildCreateObjectCommand: (typeId: string, label: string, geometry: PackCreationGeometry, parameters?: unknown): PackCommandRequest => {
    return {
      kind: createTrafficConditionCommandKind,
      targetObjectIds: [],
      payload: buildTrafficCreatePayload(typeId, label, geometry, parameters),
    }
  },
  isController: () => false,
  isTarget: () => false,
  buildSetTargetCommand: (): PackCommandRequest => unsupportedCommand(),
  buildCancelTargetCommand: (): PackCommandRequest => unsupportedCommand(),
}
