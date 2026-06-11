import type { SceneryAssetTileSummary } from './scenery.ts'

export type SceneryDepthPolicy = 'base-surface' | 'integrated-facade' | 'raised-geometry'

export interface MaterialSpec {
  readonly key: string
  readonly name: string
  readonly color: readonly [number, number, number, number]
  readonly depthPolicy: SceneryDepthPolicy
  readonly metallicFactor?: number
  readonly roughnessFactor?: number
  readonly doubleSided?: boolean
  readonly emissiveFactor?: readonly [number, number, number]
}

export interface PrimitiveSpec {
  readonly name: string
  readonly materialKey: string
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly indices: Uint32Array
}

export interface SceneryGlbBuildResult {
  readonly bytes: Uint8Array
  readonly summary: Omit<SceneryAssetTileSummary, 'byteLength'>
}

export interface SceneryGlbLodProfile {
  readonly lineSimplifyDistanceM: number
  readonly minBuildingAreaM2: number
  readonly minRoadPriority: number
  readonly includeFacadeTrim: boolean
  readonly includeFacadeWindows: boolean
  readonly includeRoofParapets: boolean
  readonly includeRoofFixtures: boolean
  readonly includeStreetLights: boolean
  readonly includePoiBeacons: boolean
  readonly facadeWindowCellBudget: number
  readonly facadeTrimBandBudget: number
  readonly roofParapetSegmentBudget: number
  readonly roofFixtureBudget: number
  readonly streetLightBudget: number
  readonly poiBeaconBudget: number
  readonly vegetationMaxPerTile: number
  readonly vegetationNaturalAreaM2: number
  readonly vegetationResidentialAreaM2: number
}

export interface SceneryDetailBudget {
  facadeWindowCellsRemaining: number
  facadeTrimBandsRemaining: number
  roofParapetSegmentsRemaining: number
  roofFixturesRemaining: number
  streetLightsRemaining: number
  poiBeaconsRemaining: number
}
