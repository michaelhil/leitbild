import type { AdapterId, CommandEnvelope, CommandResult, DomainEvent, DomainId, IsoTimestamp, OperationalObject } from '../../../core/model/index.ts'
import { confirmedFact, nowIso } from '../../../core/model/index.ts'
import type { SimulationAdapter, SimulationConnection, SimulationConnectionConfig, SimulationEventHandler } from '../../../simulation/protocol.ts'
import { trafficDomainId, type TrafficDomainData } from '../model.ts'
import { createOsloTrafficScenario } from '../scenario.ts'

const providerId = 'traffic-local'
const adapterId = 'adapter:traffic-local' as AdapterId
const domain = trafficDomainId as DomainId

const createTrafficConditionObject = (
  seed: ReturnType<typeof createOsloTrafficScenario>['conditions'][number],
  at: IsoTimestamp,
): OperationalObject => ({
  id: seed.id,
  kind: 'zone',
  domain,
  label: seed.label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    geometry: seed.geometry,
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: seed.condition,
    priority: seed.severity === 'blocked' ? 'critical' : seed.severity === 'high' ? 'high' : 'normal',
    mode: 'simulated',
  },
  alerts: seed.severity === 'blocked' || seed.severity === 'high'
    ? [{
        id: `${seed.id}:traffic`,
        kind: 'traffic_condition',
        severity: seed.severity === 'blocked' ? 'critical' : 'warning',
        message: seed.reason,
        raisedAt: at,
        acknowledged: false,
      }]
    : [],
  provenance: {
    source: 'simulator',
    adapterId,
    externalId: seed.id,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  domainData: {
    type: 'traffic_condition',
    schemaVersion: 1,
    condition: seed.condition,
    severity: seed.severity,
    affectedModes: ['road_vehicle', 'emergency_vehicle'],
    speedFactor: seed.speedFactor,
    delaySecondsEstimate: confirmedFact(seed.delaySecondsEstimate, at, 'simulation', 1),
    reason: confirmedFact(seed.reason, at, 'simulation', 1),
    startsAt: at,
  } satisfies TrafficDomainData,
})

export const createLocalTrafficSimulationAdapter = (): SimulationAdapter => ({
  id: providerId,
  domain: trafficDomainId,
  acceptedCommandKinds: [],
  connect: async (config: SimulationConnectionConfig): Promise<SimulationConnection> => {
    const at = nowIso()
    const objects = new Map<string, OperationalObject>()
    if (config.initialObjects) {
      for (const object of config.initialObjects) objects.set(object.id, object)
    } else {
      for (const condition of createOsloTrafficScenario().conditions) {
        const object = createTrafficConditionObject(condition, at)
        objects.set(object.id, object)
      }
    }
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
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => ({
        ok: false,
        commandId: command.id,
        rejectedAt: nowIso(),
        reason: `traffic provider does not accept command kind: ${command.kind}`,
      }),
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
