import type { SimulationRunId, OperationalObject, ScenarioDefinition, ScenarioExecutionState, SimulationClockState } from '../core/model/index.ts'
import type { PackCreateObjectType, PackCreationGeometry, PackObjectCategory, PackQueryResponse } from '../core/packs/protocol.ts'

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

export interface CommandResponse {
  readonly result: {
    readonly ok: boolean
    readonly reason?: string
  }
}

export interface ClockResponse {
  readonly clock: SimulationClockState
}

export interface PackQueryApiResponse {
  readonly response: PackQueryResponse
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
