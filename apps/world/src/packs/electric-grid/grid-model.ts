export type GridAssetKind = 'bus' | 'branch' | 'generator' | 'load' | 'storage'
export type GridBranchKind = 'ac_line' | 'cable' | 'transformer' | 'hvdc_link' | 'switch'
export type GridGenerationKind = 'hydro' | 'wind' | 'solar' | 'thermal' | 'nuclear' | 'battery' | 'import'
export type GridLoadKind = 'residential' | 'commercial' | 'hospital' | 'airport' | 'industry' | 'data_center' | 'ev_charging' | 'process_plant'
export type GridAssetLocation = readonly [number, number]

export interface GridBusDefinition {
  readonly id: string
  readonly label: string
  readonly nominalKv: number
  readonly location: GridAssetLocation
  readonly sourceId?: string
}

export interface GridBranchDefinition {
  readonly id: string
  readonly label: string
  readonly kind: GridBranchKind
  readonly fromBusId: string
  readonly toBusId: string
  readonly nominalKv: number
  readonly ratingMw: number
  readonly emergencyRatingMw: number
  readonly reactancePu: number
  readonly resistancePu: number
  readonly weatherExposure: 'low' | 'medium' | 'high'
  readonly sourceId?: string
}

export interface GridGeneratorDefinition {
  readonly id: string
  readonly label: string
  readonly kind: GridGenerationKind
  readonly busId: string
  readonly location: GridAssetLocation
  readonly capacityMw: number
  readonly availableMw: number
  readonly reserveMw: number
  readonly rampRateMwPerMinute: number
  readonly inertiaSeconds: number
  readonly annualProductionGwh?: number
  readonly operator?: string
  readonly priceArea?: string
  readonly sourceId?: string
}

export interface GridLoadDefinition {
  readonly id: string
  readonly label: string
  readonly kind: GridLoadKind
  readonly busId: string
  readonly location: GridAssetLocation
  readonly demandMw: number
  readonly criticalMw: number
  readonly reactiveDemandMvar: number
  readonly priority: 'critical' | 'high' | 'normal' | 'low'
  readonly controllable: boolean
  readonly sourceId?: string
}

export interface GridStorageDefinition {
  readonly id: string
  readonly label: string
  readonly busId: string
  readonly location: GridAssetLocation
  readonly capacityMwh: number
  readonly maxChargeMw: number
  readonly maxDischargeMw: number
  readonly sourceId?: string
}

export interface GridConnectionPointDefinition {
  readonly id: string
  readonly label: string
  readonly busId: string
  readonly assetId: string
  readonly role: 'supply' | 'demand' | 'bidirectional'
  readonly nominalKv: number
  readonly maximumMw: number
}

export interface GridModelDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly nominalFrequencyHz: number
  readonly sourceIds: ReadonlyArray<string>
  readonly buses: ReadonlyArray<GridBusDefinition>
  readonly branches: ReadonlyArray<GridBranchDefinition>
  readonly generators: ReadonlyArray<GridGeneratorDefinition>
  readonly loads: ReadonlyArray<GridLoadDefinition>
  readonly storage: ReadonlyArray<GridStorageDefinition>
  readonly connectionPoints: ReadonlyArray<GridConnectionPointDefinition>
}

export interface GridOperatingPointDefinition {
  readonly id: string
  readonly title: string
  readonly loadScale: number
  readonly generationScale: number
  readonly storageStateOfCharge: number
}

export interface GridAutomationDefinition {
  readonly id: string
  readonly title: string
  readonly loadProfiles: boolean
  readonly storageFrequencyResponse: boolean
  readonly underFrequencyLoadShedding: boolean
}

export interface CompiledGridDefinition {
  readonly gridId: string
  readonly model: GridModelDefinition
  readonly operatingPoint: GridOperatingPointDefinition
  readonly automation: GridAutomationDefinition
}
