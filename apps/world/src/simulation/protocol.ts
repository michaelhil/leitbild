import type { ActorId, ClientId, CommandEnvelope, CommandResult, ElectricalConnectionDefinition, SimulationRunEvent, InteractionSignal, OperationalObject, PackRuntimeRecordingBatch, Provenance, ScenarioRecordingSelection, ScenarioWorldDefinition, SimulationClockState, TelemetryState } from '../core/model/index.ts'
import type { IsoTimestamp, ObjectId, SimulationRunId } from '../core/model/index.ts'
import type { PackRuntimeClock } from '../core/packs/protocol.ts'
import type { z } from 'zod'

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
  readonly recording?: PackRuntimeRecordingBatch
  readonly emittedAt: IsoTimestamp
  readonly runtimeId: string
}

export interface PackRuntimeHealth {
  readonly runtimeId: string
  readonly state: 'ready' | 'degraded'
  readonly failureCount: number
  readonly lastSuccessfulInteractionAt: IsoTimestamp
  readonly lastFailure?: {
    readonly at: IsoTimestamp
    readonly operation: string
    readonly message: string
  }
}

export type PackRuntimeEventHandler = (emission: PackRuntimeEmission) => void

export interface PackRuntimeConnection {
  readonly getSnapshot: () => Promise<PackRuntimeSnapshot>
  readonly subscribe: (handler: PackRuntimeEventHandler) => () => void
  readonly sendCommand: (command: CommandEnvelope) => Promise<CommandResult>
  readonly receiveRealtimeInput?: (input: PackRuntimeRealtimeInput) => Promise<void>
  readonly commandEventHistory?: (command: CommandEnvelope) => PackRuntimeEventHistory
  readonly invokeQuery: (query: PackRuntimeQuery) => Promise<unknown>
  readonly observeCommittedEvents: (events: ReadonlyArray<SimulationRunEvent>) => Promise<void>
  readonly observeInitialSnapshot?: (objects: ReadonlyArray<OperationalObject>) => Promise<void>
  readonly setClock: (clock: SimulationClockState) => Promise<void>
  readonly health?: () => ReadonlyArray<PackRuntimeHealth>
  readonly close: () => Promise<void>
}

/** Private runtime invocation. Public callers use the same Capability id and
 * schemas through the Workspace Capability Broker. */
export interface PackRuntimeQuery {
  readonly capabilityId: string
  readonly input: unknown
}

export interface PackRuntimeStateStore {
  readonly load: () => Promise<unknown | null>
  readonly save: (state: unknown) => Promise<void>
}

export type SimulationCapabilityKind = 'command' | 'query'

/** Canonical callable surface contributed by a World Pack Runtime. The same
 * id and schemas are used by the runtime router, Scenario timeline, UI, and
 * Workspace Capability Broker. */
export interface SimulationCapability {
  readonly id: string
  readonly kind: SimulationCapabilityKind
  readonly title: string
  readonly description: string
  readonly risk: 'read' | 'write' | 'destructive'
  readonly idempotent: boolean
  readonly input: z.ZodType
  readonly output: z.ZodType
  readonly schedulable?: boolean
  readonly buildCommand?: (input: unknown) => {
    readonly targetObjectIds: ReadonlyArray<ObjectId>
    readonly payload: unknown
  }
}

export interface PackRuntimeAdapter {
  readonly id: string
  readonly version: string
  readonly packId: string
  readonly clock: PackRuntimeClock
  readonly capabilities: ReadonlyArray<SimulationCapability>
  readonly realtimeInputTypes?: ReadonlyArray<string>
  readonly commandEventHistory?: Readonly<Record<string, PackRuntimeEventHistory>>
  readonly connect: (config: PackRuntimeConnectionConfig) => Promise<PackRuntimeConnection>
}

export interface PackScenarioRuntimeConfig {
  readonly scenarioId: string
  readonly runtimeIds: ReadonlyArray<string>
  readonly world: ScenarioWorldDefinition
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly connections: ReadonlyArray<ElectricalConnectionDefinition>
  readonly runtimeConfigByRuntimeId?: Readonly<Record<string, unknown>>
  readonly runtimeConfig: unknown
}

export interface PackRuntimeConnectionConfig {
  readonly simulationRunId: SimulationRunId
  readonly scenario: PackScenarioRuntimeConfig
  /** Restored Pack objects when resuming a run. Fresh runs use the compiled
   * Scenario objects in `scenario.initialObjects`. */
  readonly initialObjects?: ReadonlyArray<OperationalObject>
  readonly runtimeStateStore?: PackRuntimeStateStore
  readonly runtimeStateStores?: Readonly<Record<string, PackRuntimeStateStore>>
  readonly recording?: ScenarioRecordingSelection
  readonly recordingByRuntimeId?: Readonly<Record<string, ScenarioRecordingSelection>>
}
