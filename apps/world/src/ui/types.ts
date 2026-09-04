import type { CommandResult,CompiledScenario,OperationalObject,ScenarioExecutionState,SimulationClockState,SimulationRunId } from '../core/model/index.ts'
import type { PackCreateObjectType,PackCreationGeometry,PackObjectCategory } from '../core/packs/protocol.ts'

export interface SimulationRunSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
  readonly scenario?: ScenarioExecutionState
  readonly clock?: SimulationClockState
}

export interface SimulationRunResponse {
  readonly id: SimulationRunId
  readonly snapshot: SimulationRunSnapshot
  readonly scenario?: CompiledScenario
}

export interface ScenarioResponse {
  readonly scenario: CompiledScenario
}

export type CapabilityInvocationResponse =
  | { readonly kind: 'command'; readonly result: CommandResult; readonly replayed: boolean }
  | { readonly kind: 'query'; readonly result: unknown }

export interface AccelerationState {
  readonly kind: 'continuous' | 'timed'
  readonly status: 'running' | 'paused' | 'stopped' | 'completed' | 'failed'
  readonly startedSimulationTime: string
  readonly targetSimulationTime?: string
  readonly currentSimulationTime: string
  readonly onComplete: 'pause' | 'play-realtime'
  readonly startedAt: string
  readonly updatedAt: string
  readonly activeWallMs: number
  readonly simulatedMs: number
  readonly measuredSpeed: number
  readonly error?: string
}

export interface RunExecutionState {
  readonly playback: 'playing' | 'paused'
  readonly pace: 'realtime' | 'maximum'
  readonly currentSimulationTime: string
  readonly updatedAt: string
  readonly maximumPace: { readonly available: boolean; readonly reason?: string }
  readonly acceleration: AccelerationState | null
}

export type CreateParameterValue = string | number | boolean

export interface CreateDraft {
  readonly objectType: PackCreateObjectType
  readonly geometry: PackCreationGeometry
  label: string
  parameters: Record<string, CreateParameterValue>
}

export interface CategoryRow {
  readonly category: PackObjectCategory
  readonly objects: ReadonlyArray<OperationalObject>
  readonly createType?: PackCreateObjectType
}
