import type { CommandEnvelope, CommandResult, ControlInstanceEvent, InteractionSignal, OperationalObject, Provenance, ScenarioProcessSystemDefinition, ScenarioWorldDefinition, SimulationClockState, TelemetryState } from '../core/model/index.ts'
import type { IsoTimestamp, ObjectId, ControlInstanceId } from '../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../core/packs/protocol.ts'

export interface PackRuntimeSnapshot {
  readonly controlInstanceId: ControlInstanceId
  readonly objects: ReadonlyArray<OperationalObject>
  readonly capturedAt: IsoTimestamp
}

export type PackRuntimeEvent =
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

export interface PackRuntimeEmission {
  readonly type: 'event.emission'
  readonly events: ReadonlyArray<PackRuntimeEvent>
  readonly emittedAt: IsoTimestamp
  readonly runtimeId: string
}

export type PackRuntimeEventHandler = (emission: PackRuntimeEmission) => void

export interface PackRuntimeConnection {
  readonly getSnapshot: () => Promise<PackRuntimeSnapshot>
  readonly subscribe: (handler: PackRuntimeEventHandler) => () => void
  readonly sendCommand: (command: CommandEnvelope) => Promise<CommandResult>
  readonly query: (request: PackQueryRequest) => Promise<PackQueryResponse>
  readonly observeCommittedEvents: (events: ReadonlyArray<ControlInstanceEvent>) => Promise<void>
  readonly setClock: (clock: SimulationClockState) => Promise<void>
  readonly close: () => Promise<void>
}

export interface PackRuntimeStateStore {
  readonly load: () => Promise<unknown | null>
  readonly save: (state: unknown) => Promise<void>
}

export interface PackRuntimeAdapter {
  readonly id: string
  readonly packId: string
  readonly acceptedCommandKinds: ReadonlyArray<string>
  readonly queryKinds?: ReadonlyArray<string>
  readonly connect: (config: PackRuntimeConnectionConfig) => Promise<PackRuntimeConnection>
}

export interface PackScenarioRuntimeConfig {
  readonly scenarioId: string
  readonly runtimeIds: ReadonlyArray<string>
  readonly world: ScenarioWorldDefinition
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly processSystems?: ReadonlyArray<ScenarioProcessSystemDefinition>
  readonly runtimeConfigs: Record<string, unknown>
  readonly runtimeConfig: unknown
}

export interface PackRuntimeConnectionConfig {
  readonly controlInstanceId: ControlInstanceId
  readonly scenario?: PackScenarioRuntimeConfig
  readonly initialObjects?: ReadonlyArray<OperationalObject>
  readonly runtimeStateStore?: PackRuntimeStateStore
  readonly runtimeStateStores?: Readonly<Record<string, PackRuntimeStateStore>>
}
