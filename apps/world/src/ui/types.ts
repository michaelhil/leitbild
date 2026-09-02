import type { CommandResult, SimulationRunId, OperationalObject, ScenarioDefinition, ScenarioExecutionState, SimulationClockState } from '../core/model/index.ts'
import type { PackCreateObjectType, PackCreationGeometry, PackObjectCategory } from '../core/packs/protocol.ts'

export interface SimulationRunSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
  readonly scenario?: ScenarioExecutionState
  readonly clock?: SimulationClockState
}

export interface SimulationRunResponse {
  readonly id: SimulationRunId
  readonly snapshot: SimulationRunSnapshot
  readonly scenario?: ScenarioDefinition
}

export interface ScenarioResponse {
  readonly scenario: ScenarioDefinition
}

export type CapabilityInvocationResponse =
  | { readonly kind: 'command'; readonly result: CommandResult; readonly replayed: boolean }
  | { readonly kind: 'query'; readonly result: unknown }

export interface ClockResponse {
  readonly clock: SimulationClockState
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
