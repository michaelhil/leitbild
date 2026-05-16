import type { ControlInstanceId, GeoJsonPoint, OperationalObject } from '../core/model/index.ts'
import type { PackCreateObjectType, PackObjectCategory } from '../core/packs/protocol.ts'

export interface ControlInstanceSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
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

export interface CommandResponse {
  readonly result: {
    readonly ok: boolean
    readonly reason?: string
  }
}

export interface CreateDraft {
  readonly objectType: PackCreateObjectType
  readonly point: GeoJsonPoint
  label: string
}

export interface CategoryRow {
  readonly category: PackObjectCategory
  readonly objects: ReadonlyArray<OperationalObject>
  readonly createType?: PackCreateObjectType
}
