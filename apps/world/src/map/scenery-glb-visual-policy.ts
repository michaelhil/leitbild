import type { MaterialSpec, SceneryDetailBudget, SceneryGlbLodProfile } from './scenery-glb-types.ts'

export const defaultMaxScreenSpaceError = 16
export const facadeTrimReliefM = 0.055
export const facadeWindowReliefM = 0.085
export const ribbonJoinLiftM = 0.065
export const ribbonSelfLaneStepM = 0.07

export const horizontalDepth = {
  landcoverBaseY: 0.04,
  landuseBaseY: 0.18,
  waterSurfaceY: 0.38,
  wetlandBaseY: 0.48,
  urbanBaseY: 0.60,
  woodlandBaseY: 0.72,
  aerowaySurfaceY: 0.78,
  waterwayY: 0.84,
  railCasingY: 0.98,
  railSteelY: 1.12,
  aerowayShoulderY: 1.26,
  aerowayFillY: 1.34,
  roofMaterialLiftStepM: 0.075,
} as const

export const lodProfileForZoom = (
  zoom: number,
): SceneryGlbLodProfile => {
  if (zoom <= 12) {
    return {
      lineSimplifyDistanceM: 2.2,
      minBuildingAreaM2: 120,
      minRoadPriority: 50,
      includeFacadeTrim: false,
      includeFacadeWindows: false,
      includeRoofParapets: false,
      includeRoofFixtures: false,
      includeStreetLights: false,
      includePoiBeacons: false,
      facadeWindowCellBudget: 0,
      facadeTrimBandBudget: 0,
      roofParapetSegmentBudget: 0,
      roofFixtureBudget: 0,
      streetLightBudget: 0,
      poiBeaconBudget: 0,
      vegetationMaxPerTile: 0,
      vegetationNaturalAreaM2: 20_000,
      vegetationResidentialAreaM2: 40_000,
    }
  }
  if (zoom === 13) {
    return {
      lineSimplifyDistanceM: 0.9,
      minBuildingAreaM2: 32,
      minRoadPriority: 40,
      includeFacadeTrim: false,
      includeFacadeWindows: false,
      includeRoofParapets: false,
      includeRoofFixtures: false,
      includeStreetLights: false,
      includePoiBeacons: false,
      facadeWindowCellBudget: 0,
      facadeTrimBandBudget: 0,
      roofParapetSegmentBudget: 0,
      roofFixtureBudget: 0,
      streetLightBudget: 0,
      poiBeaconBudget: 0,
      vegetationMaxPerTile: 48,
      vegetationNaturalAreaM2: 14_000,
      vegetationResidentialAreaM2: 32_000,
    }
  }
  return {
    lineSimplifyDistanceM: 0.35,
    minBuildingAreaM2: 0,
    minRoadPriority: 30,
    includeFacadeTrim: true,
    includeFacadeWindows: true,
    includeRoofParapets: true,
    includeRoofFixtures: true,
    includeStreetLights: true,
    includePoiBeacons: true,
    facadeWindowCellBudget: 11_000,
    facadeTrimBandBudget: 2_200,
    roofParapetSegmentBudget: 2_400,
    roofFixtureBudget: 240,
    streetLightBudget: 520,
    poiBeaconBudget: 48,
    vegetationMaxPerTile: 160,
    vegetationNaturalAreaM2: 5_400,
    vegetationResidentialAreaM2: 16_000,
  }
}

export const detailBudgetForProfile = (
  profile: SceneryGlbLodProfile,
): SceneryDetailBudget => ({
  facadeWindowCellsRemaining: profile.facadeWindowCellBudget,
  facadeTrimBandsRemaining: profile.facadeTrimBandBudget,
  roofParapetSegmentsRemaining: profile.roofParapetSegmentBudget,
  roofFixturesRemaining: profile.roofFixtureBudget,
  streetLightsRemaining: profile.streetLightBudget,
  poiBeaconsRemaining: profile.poiBeaconBudget,
})

export const materials: ReadonlyArray<MaterialSpec> = [
  { key: 'ground-grass', name: 'ground grass varied', color: [0.34, 0.49, 0.29, 1], depthPolicy: 'base-surface', roughnessFactor: 0.94, doubleSided: true },
  { key: 'ground-park', name: 'managed park grass', color: [0.28, 0.55, 0.25, 1], depthPolicy: 'base-surface', roughnessFactor: 0.96, doubleSided: true },
  { key: 'ground-field', name: 'field and farmland ground', color: [0.48, 0.54, 0.30, 1], depthPolicy: 'base-surface', roughnessFactor: 0.96, doubleSided: true },
  { key: 'ground-wetland', name: 'wetland ground', color: [0.26, 0.42, 0.35, 1], depthPolicy: 'base-surface', roughnessFactor: 0.98, doubleSided: true },
  { key: 'ground-urban', name: 'urban ground', color: [0.58, 0.60, 0.55, 1], depthPolicy: 'base-surface', roughnessFactor: 0.9, doubleSided: true },
  { key: 'ground-wood', name: 'woodland floor', color: [0.18, 0.42, 0.22, 1], depthPolicy: 'base-surface', roughnessFactor: 0.96, doubleSided: true },
  { key: 'water', name: 'water surface', color: [0.08, 0.49, 0.72, 1], depthPolicy: 'base-surface', roughnessFactor: 0.36, metallicFactor: 0.02, doubleSided: true },
  { key: 'aeroway-shoulder', name: 'aeroway shoulder', color: [0.70, 0.67, 0.58, 1], depthPolicy: 'base-surface', roughnessFactor: 0.82, doubleSided: true },
  { key: 'aeroway-fill', name: 'aeroway pavement', color: [0.38, 0.41, 0.42, 1], depthPolicy: 'base-surface', roughnessFactor: 0.72, doubleSided: true },
  { key: 'rail-casing', name: 'rail dark casing', color: [0.12, 0.14, 0.17, 1], depthPolicy: 'base-surface', roughnessFactor: 0.78, doubleSided: true },
  { key: 'rail', name: 'rail steel', color: [0.55, 0.61, 0.68, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.42, metallicFactor: 0.45, doubleSided: true },
  { key: 'building-wall', name: 'building wall', color: [0.73, 0.72, 0.67, 1], depthPolicy: 'base-surface', roughnessFactor: 0.72, doubleSided: true },
  { key: 'building-wall-warm', name: 'warm building wall', color: [0.76, 0.66, 0.55, 1], depthPolicy: 'base-surface', roughnessFactor: 0.74, doubleSided: true },
  { key: 'building-wall-cool', name: 'cool building wall', color: [0.67, 0.71, 0.73, 1], depthPolicy: 'base-surface', roughnessFactor: 0.68, doubleSided: true },
  { key: 'building-wall-brick', name: 'brick building wall', color: [0.64, 0.36, 0.28, 1], depthPolicy: 'base-surface', roughnessFactor: 0.78, doubleSided: true },
  { key: 'building-wall-stone', name: 'stone building wall', color: [0.61, 0.57, 0.51, 1], depthPolicy: 'base-surface', roughnessFactor: 0.82, doubleSided: true },
  { key: 'building-wall-dark', name: 'dark glass building wall', color: [0.36, 0.41, 0.45, 1], depthPolicy: 'base-surface', roughnessFactor: 0.52, metallicFactor: 0.02, doubleSided: true },
  { key: 'building-roof', name: 'building roof', color: [0.40, 0.44, 0.49, 1], depthPolicy: 'base-surface', roughnessFactor: 0.78, doubleSided: true },
  { key: 'building-roof-light', name: 'light building roof', color: [0.64, 0.65, 0.61, 1], depthPolicy: 'base-surface', roughnessFactor: 0.82, doubleSided: true },
  { key: 'building-roof-green', name: 'green copper roof', color: [0.37, 0.57, 0.50, 1], depthPolicy: 'base-surface', roughnessFactor: 0.7, metallicFactor: 0.08, doubleSided: true },
  { key: 'building-roof-red', name: 'red tile roof', color: [0.57, 0.25, 0.18, 1], depthPolicy: 'base-surface', roughnessFactor: 0.82, doubleSided: true },
  { key: 'building-roof-dark', name: 'dark roof membrane', color: [0.22, 0.25, 0.29, 1], depthPolicy: 'base-surface', roughnessFactor: 0.74, doubleSided: true },
  { key: 'roof-parapet', name: 'roof parapets', color: [0.58, 0.60, 0.58, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.8, doubleSided: true },
  { key: 'roof-fixture', name: 'rooftop fixtures', color: [0.50, 0.53, 0.55, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.62, metallicFactor: 0.05 },
  { key: 'building-window', name: 'building windows', color: [0.34, 0.58, 0.76, 1], depthPolicy: 'integrated-facade', roughnessFactor: 0.2, metallicFactor: 0.02, emissiveFactor: [0.015, 0.035, 0.055], doubleSided: true },
  { key: 'building-trim', name: 'building facade trim', color: [0.55, 0.58, 0.57, 1], depthPolicy: 'integrated-facade', roughnessFactor: 0.76, doubleSided: true },
  { key: 'tree-trunk', name: 'tree trunks', color: [0.38, 0.22, 0.12, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.92 },
  { key: 'tree-canopy', name: 'tree canopy', color: [0.16, 0.48, 0.22, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.98 },
  { key: 'tree-canopy-light', name: 'tree canopy light', color: [0.25, 0.58, 0.28, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.98 },
  { key: 'street-light', name: 'street light poles', color: [0.36, 0.40, 0.45, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.64, metallicFactor: 0.2 },
  { key: 'street-lamp', name: 'street lamp glass', color: [1.0, 0.82, 0.36, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.3, emissiveFactor: [0.45, 0.32, 0.08] },
  { key: 'poi', name: 'poi beacon', color: [0.16, 0.69, 0.95, 1], depthPolicy: 'raised-geometry', roughnessFactor: 0.36, emissiveFactor: [0.02, 0.18, 0.32] },
]
