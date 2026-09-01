export interface SourceGridSubstation {
  readonly externalId: string
  readonly name: string
  readonly lon: number
  readonly lat: number
  readonly maxVoltageKv: number
  readonly sourceId: string
}

export interface SourceGridBranch {
  readonly externalId: string
  readonly name: string
  readonly category: 'line' | 'cable'
  readonly fromExternalId: string
  readonly toExternalId: string
  readonly nominalKv: number
  readonly lengthKm: number
  readonly sourceId: string
}

export interface SourceGridGenerator {
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

export interface SourceGridLoadZone {
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

export interface SourceGridModelData {
  readonly sourceBuild: {
    readonly id: string
    readonly generatedAt: string
    readonly sourceIds: ReadonlyArray<string>
    readonly notes: ReadonlyArray<string>
  }
  readonly substations: ReadonlyArray<SourceGridSubstation>
  readonly branches: ReadonlyArray<SourceGridBranch>
  readonly generators: ReadonlyArray<SourceGridGenerator>
  readonly loads: ReadonlyArray<SourceGridLoadZone>
}
