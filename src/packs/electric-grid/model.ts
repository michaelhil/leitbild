import { z } from 'zod'

export const electricGridPackId = 'electric-grid' as const

export const gridAssetKindSchema = z.enum([
  'system',
  'substation',
  'branch',
  'generator',
  'load',
  'storage',
  'ev_charging',
  'market_area',
])

export type GridAssetKind = z.infer<typeof gridAssetKindSchema>

export const gridBranchKindSchema = z.enum(['ac_line', 'transformer', 'hvdc_link', 'switch'])
export type GridBranchKind = z.infer<typeof gridBranchKindSchema>

export const gridGenerationKindSchema = z.enum(['hydro', 'wind', 'solar', 'thermal', 'nuclear', 'battery', 'import'])
export type GridGenerationKind = z.infer<typeof gridGenerationKindSchema>

export const gridLoadKindSchema = z.enum([
  'residential',
  'commercial',
  'hospital',
  'airport',
  'industry',
  'data_center',
  'ev_charging',
  'process_plant',
])

export type GridLoadKind = z.infer<typeof gridLoadKindSchema>

export const gridProvenanceMethodSchema = z.enum(['observed', 'converted', 'inferred', 'configured', 'defaulted', 'unknown'])
export type GridProvenanceMethod = z.infer<typeof gridProvenanceMethodSchema>

export const gridPropertyProvenanceSchema = z.object({
  method: gridProvenanceMethodSchema,
  sourceId: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
})

export type GridPropertyProvenance = z.infer<typeof gridPropertyProvenanceSchema>

const finiteNumber = z.number().finite()
const fraction = finiteNumber.min(0).max(1)

export const gridBusStateSchema = z.object({
  busId: z.string().min(1),
  nominalKv: finiteNumber.positive(),
  voltagePu: finiteNumber.positive(),
  frequencyHz: finiteNumber.positive(),
  angleRad: finiteNumber,
  islandId: z.string().min(1),
  netInjectionMw: finiteNumber,
})

export type GridBusState = z.infer<typeof gridBusStateSchema>

export const gridSystemDataSchema = z.object({
  type: z.literal('grid_system'),
  schemaVersion: z.literal(1),
  assetKind: z.literal('system'),
  nominalFrequencyHz: finiteNumber.positive(),
  frequencyHz: finiteNumber.positive(),
  totalGenerationMw: finiteNumber.nonnegative(),
  totalLoadMw: finiteNumber.nonnegative(),
  servedLoadMw: finiteNumber.nonnegative(),
  unservedLoadMw: finiteNumber.nonnegative(),
  reserveMarginMw: finiteNumber,
  highestBranchLoadingPercent: finiteNumber.nonnegative(),
  lowestVoltagePu: finiteNumber.positive(),
  activeIslandCount: z.number().int().positive(),
  activeAlarmCount: z.number().int().nonnegative(),
  tick: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  busStates: z.array(gridBusStateSchema),
  provenance: gridPropertyProvenanceSchema,
})

export type GridSystemData = z.infer<typeof gridSystemDataSchema>

export const gridBranchDataSchema = z.object({
  type: z.literal('grid_branch'),
  schemaVersion: z.literal(1),
  assetKind: z.literal('branch'),
  branchKind: gridBranchKindSchema,
  fromBusId: z.string().min(1),
  toBusId: z.string().min(1),
  nominalKv: finiteNumber.positive(),
  ratingMw: finiteNumber.positive(),
  emergencyRatingMw: finiteNumber.positive(),
  reactancePu: finiteNumber.positive(),
  resistancePu: finiteNumber.nonnegative(),
  state: z.enum(['closed', 'open', 'faulted', 'derated']),
  availability: fraction,
  flowMw: finiteNumber,
  loadingPercent: finiteNumber.nonnegative(),
  voltageFromPu: finiteNumber.positive(),
  voltageToPu: finiteNumber.positive(),
  frequencyHz: finiteNumber.positive(),
  lossesMw: finiteNumber.nonnegative(),
  weatherExposure: z.enum(['low', 'medium', 'high']),
  provenance: gridPropertyProvenanceSchema,
})

export type GridBranchData = z.infer<typeof gridBranchDataSchema>

export const gridGeneratorDataSchema = z.object({
  type: z.literal('grid_generator'),
  schemaVersion: z.literal(1),
  assetKind: z.literal('generator'),
  generationKind: gridGenerationKindSchema,
  busId: z.string().min(1),
  capacityMw: finiteNumber.positive(),
  availableMw: finiteNumber.nonnegative(),
  dispatchMw: finiteNumber.nonnegative(),
  targetMw: finiteNumber.nonnegative(),
  reserveMw: finiteNumber.nonnegative(),
  rampRateMwPerMinute: finiteNumber.positive(),
  inertiaSeconds: finiteNumber.nonnegative(),
  voltageSetpointPu: finiteNumber.positive(),
  state: z.enum(['online', 'offline', 'tripped', 'derated']),
  resourceFraction: fraction.optional(),
  provenance: gridPropertyProvenanceSchema,
})

export type GridGeneratorData = z.infer<typeof gridGeneratorDataSchema>

export const gridLoadDataSchema = z.object({
  type: z.literal('grid_load'),
  schemaVersion: z.literal(1),
  assetKind: z.union([z.literal('load'), z.literal('ev_charging')]),
  loadKind: gridLoadKindSchema,
  busId: z.string().min(1),
  demandMw: finiteNumber.nonnegative(),
  servedMw: finiteNumber.nonnegative(),
  shedMw: finiteNumber.nonnegative(),
  criticalMw: finiteNumber.nonnegative(),
  interruptibleMw: finiteNumber.nonnegative(),
  reactiveDemandMvar: finiteNumber.nonnegative(),
  voltagePu: finiteNumber.positive(),
  frequencyHz: finiteNumber.positive(),
  priority: z.enum(['critical', 'high', 'normal', 'low']),
  serviceState: z.enum(['normal', 'constrained', 'shed', 'outage']),
  controllable: z.boolean(),
  provenance: gridPropertyProvenanceSchema,
})

export type GridLoadData = z.infer<typeof gridLoadDataSchema>

export const gridSubstationDataSchema = z.object({
  type: z.literal('grid_substation'),
  schemaVersion: z.literal(1),
  assetKind: z.literal('substation'),
  busId: z.string().min(1),
  nominalKv: finiteNumber.positive(),
  voltagePu: finiteNumber.positive(),
  frequencyHz: finiteNumber.positive(),
  connectedBranchCount: z.number().int().nonnegative(),
  transformerCapacityMw: finiteNumber.nonnegative(),
  loadingPercent: finiteNumber.nonnegative(),
  reactiveMarginMvar: finiteNumber,
  state: z.enum(['normal', 'voltage_watch', 'constrained', 'islanded', 'outage']),
  provenance: gridPropertyProvenanceSchema,
})

export type GridSubstationData = z.infer<typeof gridSubstationDataSchema>

export const gridStorageDataSchema = z.object({
  type: z.literal('grid_storage'),
  schemaVersion: z.literal(1),
  assetKind: z.literal('storage'),
  busId: z.string().min(1),
  capacityMwh: finiteNumber.positive(),
  stateOfChargeFraction: fraction,
  maxChargeMw: finiteNumber.nonnegative(),
  maxDischargeMw: finiteNumber.nonnegative(),
  dispatchMw: finiteNumber,
  voltagePu: finiteNumber.positive(),
  frequencyHz: finiteNumber.positive(),
  state: z.enum(['idle', 'charging', 'discharging', 'unavailable']),
  provenance: gridPropertyProvenanceSchema,
})

export type GridStorageData = z.infer<typeof gridStorageDataSchema>

export const gridMarketAreaDataSchema = z.object({
  type: z.literal('grid_market_area'),
  schemaVersion: z.literal(1),
  assetKind: z.literal('market_area'),
  areaId: z.string().min(1),
  priceNokPerMwh: finiteNumber.nonnegative(),
  generationMw: finiteNumber.nonnegative(),
  loadMw: finiteNumber.nonnegative(),
  netExportMw: finiteNumber,
  constrained: z.boolean(),
  provenance: gridPropertyProvenanceSchema,
})

export type GridMarketAreaData = z.infer<typeof gridMarketAreaDataSchema>

export const electricGridPackDataSchema = z.discriminatedUnion('type', [
  gridSystemDataSchema,
  gridSubstationDataSchema,
  gridBranchDataSchema,
  gridGeneratorDataSchema,
  gridLoadDataSchema,
  gridStorageDataSchema,
  gridMarketAreaDataSchema,
])

export type ElectricGridPackData = z.infer<typeof electricGridPackDataSchema>

export const isElectricGridPackData = (value: unknown): value is ElectricGridPackData =>
  electricGridPackDataSchema.safeParse(value).success
