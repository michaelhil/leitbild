import type { GeoJsonPoint, KnowledgeFact, OperationalObject } from '../../core/model/index.ts'
import type { LeitbildPack, PackCommandRequest, PackObjectPresentation } from '../../core/packs/protocol.ts'
import { trafficDomainDataSchema, trafficDomainId, type TrafficDomainData } from './model.ts'
import { createTrafficRouteImpactHandler } from './interactions.ts'

const factText = <T>(fact: KnowledgeFact<T> | undefined, formatter: (value: T) => string = String): string =>
  !fact || fact.state === 'unknown' ? 'unknown' : formatter(fact.value)

const parseTrafficData = (object: OperationalObject): TrafficDomainData | null => {
  const parsed = trafficDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const trafficDetails = (data: TrafficDomainData): ReadonlyArray<string> => [
  `Condition: ${data.condition.replaceAll('_', ' ')}`,
  `Severity: ${data.severity}`,
  `Reason: ${factText(data.reason)}`,
  `Affected: ${data.affectedModes.map(mode => mode.replaceAll('_', ' ')).join(', ')}`,
  ...(data.speedFactor === undefined ? [] : [`Speed factor: ${Math.round(data.speedFactor * 100)}%`]),
  ...(data.delaySecondsEstimate === undefined ? [] : [`Estimated delay: ${factText(data.delaySecondsEstimate, value => `${Math.round(value)}s`)}`]),
]

const unsupportedCommand = (): PackCommandRequest => {
  throw new Error('traffic pack does not support object creation or target commands yet')
}

export const trafficPack: LeitbildPack = {
  id: 'traffic',
  name: 'Traffic Conditions',
  domain: trafficDomainId,
  categories: [
    {
      id: 'traffic',
      label: 'Traffic',
      emptyLabel: 'No traffic conditions',
      matches: (object: OperationalObject): boolean => parseTrafficData(object) !== null,
    },
  ],
  createObjectTypes: [],
  interactionHandlers: [
    createTrafficRouteImpactHandler(),
  ],
  presentObject: (object): PackObjectPresentation => {
    const data = parseTrafficData(object)
    return {
      categoryId: 'traffic',
      icon: 'traffic',
      color: data?.severity === 'blocked' ? '#991b1b' : data?.severity === 'high' ? '#c2410c' : '#d97706',
      summary: data ? `${data.condition.replaceAll('_', ' ')} · ${data.severity}` : object.operational.status,
      detailLines: data ? trafficDetails(data) : ['Invalid traffic domain data'],
    }
  },
  defaultObjectLabel: () => {
    throw new Error('traffic pack does not support object creation yet')
  },
  buildCreateObjectCommand: (_typeId: string, _label: string, _point: GeoJsonPoint): PackCommandRequest => unsupportedCommand(),
  isController: () => false,
  isTarget: () => false,
  buildSetTargetCommand: (): PackCommandRequest => unsupportedCommand(),
  buildCancelTargetCommand: (): PackCommandRequest => unsupportedCommand(),
}
