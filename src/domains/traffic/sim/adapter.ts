import { randomUUID } from 'node:crypto'
import type { AdapterId, CommandEnvelope, CommandResult, DomainEvent, DomainId, GeoJsonLineString, GeoJsonPolygon, IsoTimestamp, ObjectId, OperationalObject } from '../../../core/model/index.ts'
import { confirmedFact, interactionSignalSchema, nowIso, type InteractionSignal, type SignalId } from '../../../core/model/index.ts'
import type { SimulationAdapter, SimulationConnection, SimulationConnectionConfig, SimulationEvent, SimulationEventHandler } from '../../../simulation/protocol.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import { createTrafficConditionCommandKind } from '../commands.ts'
import { createTrafficConditionPayloadSchema, trafficDomainDataSchema, trafficDomainId, type TrafficDomainData, type TrafficGeometryMode } from '../model.ts'
import { createOsloTrafficScenario } from '../scenario.ts'
import { trafficConditionChangedSignalType } from '../interactions.ts'

const providerId = 'traffic-local'
const adapterId = 'adapter:traffic-local' as AdapterId
const domain = trafficDomainId as DomainId
const defaultSpeedFactor = 0.55

const createTrafficConditionObject = (
  config: {
    readonly id: ObjectId
    readonly label: string
    readonly geometryMode: TrafficGeometryMode
    readonly geometry: GeoJsonLineString | GeoJsonPolygon
    readonly condition: TrafficDomainData['condition']
    readonly severity: TrafficDomainData['severity']
    readonly speedFactor?: number
    readonly delaySecondsEstimate?: number
    readonly reason: string
    readonly at: IsoTimestamp
    readonly causedByCommandId?: CommandEnvelope['id']
  },
): OperationalObject => ({
  id: config.id,
  kind: 'zone',
  domain,
  label: config.label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    geometry: config.geometry,
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: config.condition,
    priority: config.severity === 'blocked' ? 'critical' : config.severity === 'high' ? 'high' : 'normal',
    mode: 'simulated',
  },
  alerts: config.severity === 'blocked' || config.severity === 'high'
    ? [{
        id: `${config.id}:traffic`,
        kind: 'traffic_condition',
        severity: config.severity === 'blocked' ? 'critical' : 'warning',
        message: config.reason,
        raisedAt: config.at,
        acknowledged: false,
      }]
    : [],
  provenance: {
    source: config.causedByCommandId ? 'operator' : 'simulator',
    adapterId,
    externalId: config.id,
    ...(config.causedByCommandId ? { causedByCommandId: config.causedByCommandId } : {}),
  },
  timestamps: {
    createdAt: config.at,
    updatedAt: config.at,
  },
  domainData: {
    type: 'traffic_condition',
    schemaVersion: 2,
    geometryMode: config.geometryMode,
    condition: config.condition,
    severity: config.severity,
    affectedModes: ['road_vehicle', 'emergency_vehicle'],
    speedFactor: config.speedFactor,
    ...(config.delaySecondsEstimate === undefined ? {} : { delaySecondsEstimate: confirmedFact(config.delaySecondsEstimate, config.at, 'simulation', 1) }),
    reason: confirmedFact(config.reason, config.at, config.causedByCommandId ? 'operator' : 'simulation', 1),
    startsAt: config.at,
    sourceKind: config.causedByCommandId ? 'operator' : 'scenario',
    confidence: 1,
  } satisfies TrafficDomainData,
})

const restoreTrafficObject = (object: OperationalObject): OperationalObject => {
  const parsed = trafficDomainDataSchema.safeParse(object.domainData)
  if (!parsed.success) throw new Error(`invalid restored traffic object domain data for ${object.id}: ${parsed.error.message}`)
  return { ...object, domainData: parsed.data }
}

const nextNumberAfter = (objects: Iterable<OperationalObject>): number => {
  let highest = 0
  for (const object of objects) {
    const match = object.id.match(/^traffic:condition-(\d+)$/)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isInteger(value) && value > highest) highest = value
  }
  return highest + 1
}

const emit = (
  handlers: ReadonlySet<SimulationEventHandler>,
  events: ReadonlyArray<SimulationEvent>,
  at: IsoTimestamp,
): void => {
  if (events.length === 0) return
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      providerId,
      emittedAt: at,
      events,
    })
  }
}

const trafficChangedSignalEvent = (
  command: CommandEnvelope,
  object: OperationalObject,
  at: IsoTimestamp,
): SimulationEvent => {
  const signal = interactionSignalSchema.parse({
    id: `signal:${randomUUID()}` as SignalId,
    controlInstanceId: command.controlInstanceId,
    at,
    source: { kind: 'object', id: object.id, providerId },
    targets: [{ kind: 'broadcast' }],
    type: trafficConditionChangedSignalType,
    severity: 'notice',
    payload: { objectId: object.id },
    causationId: command.id,
  }) as InteractionSignal
  return {
    type: 'interaction.signal',
    signal,
    at,
    provenance: {
      source: 'simulator',
      adapterId,
      externalId: object.id,
      causedByCommandId: command.id,
    },
  }
}

export const createLocalTrafficSimulationAdapter = (adapterConfig: {
  readonly routing?: RoutingAdapter
} = {}): SimulationAdapter => ({
  id: providerId,
  domain: trafficDomainId,
  acceptedCommandKinds: [createTrafficConditionCommandKind],
  connect: async (config: SimulationConnectionConfig): Promise<SimulationConnection> => {
    const at = nowIso()
    const routing = adapterConfig.routing ?? createDirectRoutingAdapter()
    const objects = new Map<string, OperationalObject>()
    if (config.initialObjects) {
      for (const object of config.initialObjects) objects.set(object.id, restoreTrafficObject(object))
    } else {
      for (const condition of createOsloTrafficScenario().conditions) {
        const object = createTrafficConditionObject({
          id: condition.id,
          label: condition.label,
          geometryMode: condition.geometryMode,
          geometry: condition.geometry,
          condition: condition.condition,
          severity: condition.severity,
          speedFactor: condition.speedFactor,
          delaySecondsEstimate: condition.delaySecondsEstimate,
          reason: condition.reason,
          at,
        })
        objects.set(object.id, object)
      }
    }
    let nextConditionNumber = nextNumberAfter(objects.values())
    const handlers = new Set<SimulationEventHandler>()

    return {
      getSnapshot: async () => ({
        controlInstanceId: config.controlInstanceId,
        objects: [...objects.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: SimulationEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        const acceptedAt = nowIso()
        if (command.kind !== createTrafficConditionCommandKind) {
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: acceptedAt,
            reason: `traffic provider does not accept command kind: ${command.kind}`,
          }
        }
        const payload = createTrafficConditionPayloadSchema.safeParse(command.payload)
        if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
        let geometry: GeoJsonLineString | GeoJsonPolygon
        let geometryMode: TrafficGeometryMode
        if (payload.data.objectType === 'traffic_road_segment') {
          const route = await routing.route({ from: payload.data.from, to: payload.data.to })
          geometry = route.geometry
          geometryMode = 'road_segment'
        } else {
          geometry = payload.data.polygon
          geometryMode = 'area'
        }
        const object = createTrafficConditionObject({
          id: `traffic:condition-${nextConditionNumber++}` as ObjectId,
          label: payload.data.label,
          geometryMode,
          geometry,
          condition: payload.data.condition,
          severity: payload.data.severity,
          speedFactor: payload.data.speedFactor ?? defaultSpeedFactor,
          reason: payload.data.reason,
          at: acceptedAt,
          causedByCommandId: command.id,
        })
        objects.set(object.id, object)
        emit(handlers, [
          {
            type: 'object.upserted',
            object,
            at: acceptedAt,
            provenance: object.provenance,
          },
          trafficChangedSignalEvent(command, object, acceptedAt),
        ], acceptedAt)
        return { ok: true, commandId: command.id, acceptedAt }
      },
      observeCommittedEvents: async (events: ReadonlyArray<DomainEvent>): Promise<void> => {
        for (const event of events) {
          if (event.type === 'object.upserted' && event.object.domain === trafficDomainId) objects.set(event.object.id, event.object)
          if (event.type === 'object.deleted') objects.delete(event.objectId)
        }
      },
      close: async (): Promise<void> => {
        handlers.clear()
      },
    }
  },
})
