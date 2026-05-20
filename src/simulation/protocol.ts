import type { CommandEnvelope, CommandResult, DomainEvent, InteractionSignal, OperationalObject, Provenance, ScenarioWorldDefinition, SimulationClockState, TelemetryState } from '../core/model/index.ts'
import type { IsoTimestamp, ObjectId, ControlInstanceId } from '../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../core/packs/protocol.ts'

export interface SimulationSnapshot {
  readonly controlInstanceId: ControlInstanceId
  readonly objects: ReadonlyArray<OperationalObject>
  readonly capturedAt: IsoTimestamp
}

export type SimulationEvent =
  | {
      readonly type: 'object.upserted'
      readonly object: OperationalObject
      readonly at: IsoTimestamp
      readonly provenance: Provenance
    }
  | {
      readonly type: 'object.deleted'
      readonly objectId: ObjectId
      readonly at: IsoTimestamp
      readonly provenance: Provenance
    }
  | {
      readonly type: 'telemetry.sampled'
      readonly objectId: ObjectId
      readonly telemetry: TelemetryState
      readonly at: IsoTimestamp
      readonly provenance: Provenance
    }
  | {
      readonly type: 'interaction.signal'
      readonly signal: InteractionSignal
      readonly at: IsoTimestamp
      readonly provenance: Provenance
    }

export interface SimulationEmission {
  readonly type: 'event.emission'
  readonly events: ReadonlyArray<SimulationEvent>
  readonly emittedAt: IsoTimestamp
  readonly providerId: string
}

export type SimulationEventHandler = (emission: SimulationEmission) => void

export interface SimulationConnection {
  readonly getSnapshot: () => Promise<SimulationSnapshot>
  readonly subscribe: (handler: SimulationEventHandler) => () => void
  readonly sendCommand: (command: CommandEnvelope) => Promise<CommandResult>
  readonly query: (request: PackQueryRequest) => Promise<PackQueryResponse>
  readonly observeCommittedEvents: (events: ReadonlyArray<DomainEvent>) => Promise<void>
  readonly setClock: (clock: SimulationClockState) => Promise<void>
  readonly close: () => Promise<void>
}

export interface SimulationAdapter {
  readonly id: string
  readonly packId: string
  readonly domain: string
  readonly acceptedCommandKinds: ReadonlyArray<string>
  readonly connect: (config: SimulationConnectionConfig) => Promise<SimulationConnection>
}

export interface SimulationScenarioRuntimeConfig {
  readonly scenarioId: string
  readonly providerIds: ReadonlyArray<string>
  readonly world: ScenarioWorldDefinition
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly providerConfigs: Record<string, unknown>
  readonly providerConfig: unknown
}

export interface SimulationConnectionConfig {
  readonly controlInstanceId: ControlInstanceId
  readonly scenario?: SimulationScenarioRuntimeConfig
  readonly initialObjects?: ReadonlyArray<OperationalObject>
}
