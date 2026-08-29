import type { ActorId, ClientId, CommandEnvelope, CommandResult, SimulationRunEvent, InteractionSignal, OperationalObject, Provenance, ScenarioProcessSystemDefinition, ScenarioWorldDefinition, SimulationClockState, TelemetryState } from '../core/model/index.ts'
import type { IsoTimestamp, ObjectId, SimulationRunId } from '../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../core/packs/protocol.ts'

export interface PackRuntimeSnapshot {
  readonly simulationRunId: SimulationRunId
  readonly objects: ReadonlyArray<OperationalObject>
  readonly capturedAt: IsoTimestamp
}

export type PackRuntimeEventPersistence = 'durable' | 'projected'

interface PackRuntimeEventBase {
  readonly at: IsoTimestamp
  readonly provenance: Provenance
  readonly persistence?: PackRuntimeEventPersistence
}

export type PackRuntimeEvent =
  | (PackRuntimeEventBase & {
      readonly type: 'object.upserted'
      readonly object: OperationalObject
    })
  | (PackRuntimeEventBase & {
      readonly type: 'object.deleted'
      readonly objectId: ObjectId
    })
  | (PackRuntimeEventBase & {
      readonly type: 'telemetry.sampled'
      readonly objectId: ObjectId
      readonly telemetry: TelemetryState
    })
  | (PackRuntimeEventBase & {
      readonly type: 'interaction.signal'
      readonly signal: InteractionSignal
    })

export interface PackRuntimeRealtimeMessage {
  readonly type: string
  readonly at: IsoTimestamp
  readonly payload: unknown
}

export interface PackRuntimeRealtimeInput {
  readonly type: string
  readonly at: IsoTimestamp
  readonly actorId?: ActorId
  readonly clientId?: ClientId
  readonly payload: unknown
}

export interface PackRuntimeEmission {
  readonly type: 'event.emission'
  readonly events: ReadonlyArray<PackRuntimeEvent>
  readonly realtimeMessages?: ReadonlyArray<PackRuntimeRealtimeMessage>
  readonly emittedAt: IsoTimestamp
  readonly runtimeId: string
}

export type PackRuntimeEventHandler = (emission: PackRuntimeEmission) => void

export interface PackRuntimeConnection {
  readonly getSnapshot: () => Promise<PackRuntimeSnapshot>
  readonly subscribe: (handler: PackRuntimeEventHandler) => () => void
  readonly sendCommand: (command: CommandEnvelope) => Promise<CommandResult>
  readonly receiveRealtimeInput?: (input: PackRuntimeRealtimeInput) => Promise<void>
  readonly commandEventPersistence?: (command: CommandEnvelope) => PackRuntimeEventPersistence
  readonly query: (request: PackQueryRequest) => Promise<PackQueryResponse>
  readonly observeCommittedEvents: (events: ReadonlyArray<SimulationRunEvent>) => Promise<void>
  readonly setClock: (clock: SimulationClockState) => Promise<void>
  readonly close: () => Promise<void>
}

export interface PackRuntimeStateStore {
  readonly load: () => Promise<unknown | null>
  readonly save: (state: unknown) => Promise<void>
}

export interface PackRuntimeAdapter {
  readonly id: string
  readonly version: string
  readonly packId: string
  readonly acceptedCommandKinds: ReadonlyArray<string>
  readonly acceptedRealtimeInputTypes?: ReadonlyArray<string>
  readonly commandEventPersistence?: Readonly<Record<string, PackRuntimeEventPersistence>>
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
  readonly simulationRunId: SimulationRunId
  readonly scenario?: PackScenarioRuntimeConfig
  readonly initialObjects?: ReadonlyArray<OperationalObject>
  readonly runtimeStateStore?: PackRuntimeStateStore
  readonly runtimeStateStores?: Readonly<Record<string, PackRuntimeStateStore>>
}
