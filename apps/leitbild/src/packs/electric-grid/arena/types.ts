import type { PackScenarioObjectSpec } from '../../../core/packs/protocol.ts'

export interface SourceDerivedSubstation {
  readonly externalId: string
  readonly name: string
  readonly lon: number
  readonly lat: number
  readonly voltageKv: ReadonlyArray<number>
  readonly maxVoltageKv: number
  readonly operator: string | null
  readonly sourceId: string
}

export interface SourceDerivedBranch {
  readonly externalId: string
  readonly name: string
  readonly category: 'line' | 'cable'
  readonly fromExternalId: string
  readonly toExternalId: string
  readonly nominalKv: number
  readonly lengthKm: number
  readonly operator: string | null
  readonly path: ReadonlyArray<readonly [number, number]>
  readonly sourceId: string
}

export interface SourceDerivedGenerator {
  readonly externalId: string
  readonly name: string
  readonly generationKind: 'hydro' | 'wind' | 'solar' | 'thermal' | 'nuclear' | 'battery' | 'import'
  readonly lon: number
  readonly lat: number
  readonly capacityMw: number
  readonly annualProductionGwh: number | null
  readonly operator: string | null
  readonly priceArea: string | null
  readonly sourceId: string
  readonly augmentationSourceId: string | null
}

export interface InferredLoadZone {
  readonly id: string
  readonly label: string
  readonly loadKind: 'residential' | 'commercial' | 'hospital' | 'airport' | 'industry' | 'data_center' | 'ev_charging' | 'process_plant'
  readonly busExternalId: string
  readonly lon: number
  readonly lat: number
  readonly demandMw: number
  readonly criticalMw: number
  readonly reactiveDemandMvar: number
  readonly priority: 'critical' | 'high' | 'normal' | 'low'
  readonly controllable?: boolean
}

export interface SourceDerivedGridArenaData {
  readonly sourceBuild: {
    readonly id: string
    readonly generatedAt: string
    readonly sourceIds: ReadonlyArray<string>
    readonly notes: ReadonlyArray<string>
  }
  readonly substations: ReadonlyArray<SourceDerivedSubstation>
  readonly branches: ReadonlyArray<SourceDerivedBranch>
  readonly generators: ReadonlyArray<SourceDerivedGenerator>
  readonly loads: ReadonlyArray<InferredLoadZone>
}

export type GridArenaScenarioObjectSpec = PackScenarioObjectSpec & {
  readonly pack: 'electric-grid'
}
