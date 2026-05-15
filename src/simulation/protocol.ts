import type { CommandEnvelope, CommandResult, OperationalObject, Provenance, TelemetryState } from '../core/model/index.ts'
import type { IsoTimestamp, ObjectId, SessionId } from '../core/model/index.ts'

export interface SimulationSnapshot {
  readonly sessionId: SessionId
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

export type SimulationEventHandler = (event: SimulationEvent) => void

export interface SimulationConnection {
  readonly getSnapshot: () => Promise<SimulationSnapshot>
  readonly subscribe: (handler: SimulationEventHandler) => () => void
  readonly sendCommand: (command: CommandEnvelope) => Promise<CommandResult>
  readonly close: () => Promise<void>
}

export interface SimulationAdapter {
  readonly id: string
  readonly domain: string
  readonly connect: (config: SimulationConnectionConfig) => Promise<SimulationConnection>
}

export interface SimulationConnectionConfig {
  readonly sessionId: SessionId
}
