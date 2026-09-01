import type { ActorId, ClientId, CommandEnvelope, CommandResult, SimulationRunEvent, InteractionSignal, OperationalObject, Provenance, ScenarioWorldDefinition, SimulationClockState, TelemetryState } from '../core/model/index.ts'
import type { IsoTimestamp, ObjectId, SimulationRunId } from '../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse, PackRuntimeClock } from '../core/packs/protocol.ts'

export interface PackRuntimeSnapshot {
  readonly simulationRunId: SimulationRunId
  readonly objects: ReadonlyArray<OperationalObject>
  readonly capturedAt: IsoTimestamp
}

export type PackRuntimeEventHistory = 'record' | 'snapshot-only'

interface PackRuntimeEventBase {
  readonly at: IsoTimestamp
  readonly provenance: Provenance
}

export type PackRuntimeEvent =
  | (PackRuntimeEventBase & {
      readonly type: 'object.upserted'
      readonly object: OperationalObject
      readonly history: PackRuntimeEventHistory
    })
  | (PackRuntimeEventBase & {
      readonly type: 'object.deleted'
      readonly objectId: ObjectId
      readonly history: PackRuntimeEventHistory
    })
  | (PackRuntimeEventBase & {
      readonly type: 'telemetry.sampled'
      readonly objectId: ObjectId
      readonly telemetry: TelemetryState
      readonly history: 'snapshot-only'
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
  readonly commandEventHistory?: (command: CommandEnvelope) => PackRuntimeEventHistory
  readonly query: (request: PackQueryRequest) => Promise<PackQueryResponse>
  readonly observeCommittedEvents: (events: ReadonlyArray<SimulationRunEvent>) => Promise<void>
  readonly setClock: (clock: SimulationClockState) => Promise<void>
  readonly close: () => Promise<void>
}

export interface PackRuntimeStateStore {
  readonly load: () => Promise<unknown | null>
  readonly save: (state: unknown) => Promise<void>
}

export type PackRuntimeOperationType = 'command' | 'query' | 'realtime-input'

export interface PackRuntimeOperationDescriptor {
  readonly id: string
  readonly type: PackRuntimeOperationType
  readonly title: string
  readonly description: string
  readonly inputSchema?: Readonly<Record<string, unknown>>
}

export interface PackRuntimeAdapter {
  readonly id: string
  readonly version: string
  readonly packId: string
  readonly clock: PackRuntimeClock
  readonly operations: ReadonlyArray<PackRuntimeOperationDescriptor>
  readonly commandEventHistory?: Readonly<Record<string, PackRuntimeEventHistory>>
  readonly connect: (config: PackRuntimeConnectionConfig) => Promise<PackRuntimeConnection>
}

export interface PackScenarioRuntimeConfig {
  readonly scenarioId: string
  readonly runtimeIds: ReadonlyArray<string>
  readonly world: ScenarioWorldDefinition
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly runtimeConfigByRuntimeId?: Readonly<Record<string, unknown>>
  readonly runtimeConfig: unknown
}

export interface PackRuntimeConnectionConfig {
  readonly simulationRunId: SimulationRunId
  readonly scenario?: PackScenarioRuntimeConfig
  readonly initialObjects?: ReadonlyArray<OperationalObject>
  readonly runtimeStateStore?: PackRuntimeStateStore
  readonly runtimeStateStores?: Readonly<Record<string, PackRuntimeStateStore>>
}
