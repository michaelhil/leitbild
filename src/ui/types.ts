import type { ControlInstanceId, OperationalObject, ScenarioDefinition, ScenarioInstanceState } from '../core/model/index.ts'
import type { PackCreateObjectType, PackCreationGeometry, PackObjectCategory } from '../core/packs/protocol.ts'
import type { TrafficSeverity } from '../packs/traffic/model.ts'

export interface ControlInstanceSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
  readonly scenario?: ScenarioInstanceState
}

export interface ControlInstanceResponse {
  readonly id: ControlInstanceId
  readonly snapshot: ControlInstanceSnapshot
}

export interface ControlInstanceSummary {
  readonly id: ControlInstanceId
  readonly loaded: boolean
  readonly snapshotSeq: number | null
  readonly objectCount: number | null
}

export interface ControlInstanceListResponse {
  readonly controlInstances: ReadonlyArray<ControlInstanceSummary>
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

export interface CreateDraft {
  readonly objectType: PackCreateObjectType
  readonly geometry: PackCreationGeometry
  label: string
  trafficSeverity?: TrafficSeverity
  trafficSpeedFactor?: number
  trafficReason?: string
}

export interface CategoryRow {
  readonly category: PackObjectCategory
  readonly objects: ReadonlyArray<OperationalObject>
  readonly createType?: PackCreateObjectType
}
