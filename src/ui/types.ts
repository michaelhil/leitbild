import type { ControlInstanceId, OperationalObject, ScenarioDefinition, ScenarioInstanceState, SimulationClockState } from '../core/model/index.ts'
import type { PackCreateObjectType, PackCreationGeometry, PackObjectCategory } from '../core/packs/protocol.ts'

export interface ControlInstanceSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
  readonly scenario?: ScenarioInstanceState
  readonly clock?: SimulationClockState
}

export interface ControlInstanceResponse {
  readonly id: ControlInstanceId
  readonly snapshot: ControlInstanceSnapshot
}

export interface ControlInstanceSummary {
  readonly id: ControlInstanceId
  readonly scenarioId: string | null
  readonly runId: string | null
  readonly loaded: boolean
  readonly snapshotSeq: number | null
  readonly objectCount: number | null
  readonly websocketClientCount: number
}

export interface ControlInstanceListResponse {
  readonly controlInstances: ReadonlyArray<ControlInstanceSummary>
}

export interface ScenarioResponse {
  readonly scenario: ScenarioDefinition
}

export interface ScenarioListItem {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly missionId?: string
}

export interface ScenarioListResponse {
  readonly scenarios: ReadonlyArray<ScenarioListItem>
  readonly defaultScenarioId: string
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
