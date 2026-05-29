import { z } from 'zod'
import {
  geoPointFromLonLat,
  objectIdSchema,
  type AdapterId,
  type GeoJsonLineString,
  type IsoTimestamp,
  type OperationalObject,
  type PackId,
} from '../../core/model/index.ts'
import type { PackScenarioObjectSpec, PackScenarioOperationSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import {
  electricGridPackDataSchema,
  gridBranchKindSchema,
  gridGenerationKindSchema,
  gridLoadKindSchema,
  type ElectricGridPackData,
  type GridPropertyProvenance,
} from './model.ts'
import { norwayGridArenaObjectSpecs } from './arena/norway-grid-arena.ts'
import { electricGridAdapterId, electricGridRuntimePackId } from './sim/constants.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])

const provenanceSchema = z.object({
  method: z.enum(['observed', 'converted', 'inferred', 'configured', 'defaulted', 'unknown']).default('configured'),
  sourceId: z.string().min(1).default('scenario'),
  sourceUrl: z.string().url().optional(),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
}).default({ method: 'configured', sourceId: 'scenario', confidence: 'medium' })

const baseSpecSchema = z.object({
  pack: z.literal('electric-grid'),
  id: objectIdSchema,
  label: z.string().min(1),
  position: lonLatSchema.optional(),
  provenance: provenanceSchema,
})

const systemSpecSchema = baseSpecSchema.extend({
  type: z.literal('grid_system'),
})

const regionalGridSpecSchema = baseSpecSchema.extend({
  type: z.literal('regional_grid'),
  arenaId: z.literal('source-derived-oslofjord-grid').default('source-derived-oslofjord-grid'),
})

const substationSpecSchema = baseSpecSchema.extend({
  type: z.literal('substation'),
  busId: z.string().min(1),
  nominalKv: z.number().finite().positive(),
  transformerCapacityMw: z.number().finite().nonnegative().default(0),
})

const branchSpecSchema = baseSpecSchema.extend({
  type: z.literal('branch'),
  branchKind: gridBranchKindSchema.default('ac_line'),
  fromBusId: z.string().min(1),
  toBusId: z.string().min(1),
  nominalKv: z.number().finite().positive(),
  ratingMw: z.number().finite().positive(),
  emergencyRatingMw: z.number().finite().positive().optional(),
  reactancePu: z.number().finite().positive().default(0.08),
  resistancePu: z.number().finite().nonnegative().default(0.015),
  state: z.enum(['closed', 'open', 'faulted', 'derated']).default('closed'),
  availability: z.number().finite().min(0).max(1).default(1),
  weatherExposure: z.enum(['low', 'medium', 'high']).default('medium'),
  path: z.array(lonLatSchema).min(2),
})

const generatorSpecSchema = baseSpecSchema.extend({
  type: z.literal('generator'),
  generationKind: gridGenerationKindSchema,
  busId: z.string().min(1),
  capacityMw: z.number().finite().positive(),
  availableMw: z.number().finite().nonnegative().optional(),
  dispatchMw: z.number().finite().nonnegative().optional(),
  targetMw: z.number().finite().nonnegative().optional(),
  reserveMw: z.number().finite().nonnegative().default(0),
  rampRateMwPerMinute: z.number().finite().positive().default(120),
  inertiaSeconds: z.number().finite().nonnegative().default(4),
  voltageSetpointPu: z.number().finite().positive().default(1.01),
  state: z.enum(['online', 'offline', 'tripped', 'derated']).default('online'),
  resourceFraction: z.number().finite().min(0).max(1).optional(),
  annualProductionGwh: z.number().finite().nonnegative().optional(),
  operator: z.string().min(1).optional(),
  priceArea: z.string().min(1).optional(),
})

const loadSpecSchema = baseSpecSchema.extend({
  type: z.enum(['load', 'ev_charging']),
  loadKind: gridLoadKindSchema,
  busId: z.string().min(1),
  demandMw: z.number().finite().nonnegative(),
  criticalMw: z.number().finite().nonnegative().default(0),
  interruptibleMw: z.number().finite().nonnegative().optional(),
  reactiveDemandMvar: z.number().finite().nonnegative().default(0),
  priority: z.enum(['critical', 'high', 'normal', 'low']).default('normal'),
  controllable: z.boolean().default(false),
})

const storageSpecSchema = baseSpecSchema.extend({
  type: z.literal('storage'),
  busId: z.string().min(1),
  capacityMwh: z.number().finite().positive(),
  stateOfChargeFraction: z.number().finite().min(0).max(1).default(0.55),
  maxChargeMw: z.number().finite().nonnegative(),
  maxDischargeMw: z.number().finite().nonnegative(),
})

const marketAreaSpecSchema = baseSpecSchema.extend({
  type: z.literal('market_area'),
  areaId: z.string().min(1),
  priceNokPerMwh: z.number().finite().nonnegative(),
})

const gridObjectSpecSchema = z.discriminatedUnion('type', [
  systemSpecSchema,
  substationSpecSchema,
  branchSpecSchema,
  generatorSpecSchema,
  loadSpecSchema,
  storageSpecSchema,
  marketAreaSpecSchema,
])

const lineStringFromPath = (path: ReadonlyArray<readonly [number, number]>): GeoJsonLineString => ({
  type: 'LineString',
  coordinates: path.map(([lon, lat]) => geoPointFromLonLat(lon, lat).coordinates),
})

const pointSpatial = (
  position: readonly [number, number] | undefined,
  at: IsoTimestamp,
): OperationalObject['spatial'] => ({
  ...(position ? {
    position: {
      point: geoPointFromLonLat(position[0], position[1]),
      observedAt: at,
      staleAfterMs: 600000,
    },
  } : {}),
  frame: { kind: 'wgs84' },
})

const lineSpatial = (path: ReadonlyArray<readonly [number, number]>): OperationalObject['spatial'] => ({
  geometry: lineStringFromPath(path),
  frame: { kind: 'wgs84' },
})

const baseObject = (config: {
  readonly spec: z.infer<typeof gridObjectSpecSchema>
  readonly at: IsoTimestamp
  readonly data: ElectricGridPackData
  readonly spatial: OperationalObject['spatial']
  readonly kind?: OperationalObject['kind']
}): OperationalObject => ({
  id: config.spec.id,
  kind: config.kind ?? 'facility',
  packId: electricGridRuntimePackId as PackId,
  label: config.spec.label,
  lifecycle: 'active',
  revision: 0,
  spatial: config.spatial,
  operational: {
    status: 'initializing',
    priority: 'normal',
    mode: 'simulated',
  },
  alerts: [],
  provenance: {
    source: 'simulator',
    adapterId: electricGridAdapterId as AdapterId,
    externalId: config.spec.id,
  },
  timestamps: {
    createdAt: config.at,
    updatedAt: config.at,
  },
  packData: config.data,
})

const systemData = (at: IsoTimestamp, provenance: GridPropertyProvenance): ElectricGridPackData => ({
  type: 'grid_system',
  schemaVersion: 1,
  assetKind: 'system',
  nominalFrequencyHz: 50,
  frequencyHz: 50,
  totalGenerationMw: 0,
  totalLoadMw: 0,
  servedLoadMw: 0,
  unservedLoadMw: 0,
  reserveMarginMw: 0,
  highestBranchLoadingPercent: 0,
  lowestVoltagePu: 1,
  activeIslandCount: 1,
  activeAlarmCount: 0,
  tick: 0,
  updatedAt: at,
  busStates: [],
  provenance,
})

const dataForSpec = (spec: z.infer<typeof gridObjectSpecSchema>, at: IsoTimestamp): ElectricGridPackData => {
  const provenance = spec.provenance
  switch (spec.type) {
    case 'grid_system':
      return systemData(at, provenance)
    case 'substation':
      return {
        type: 'grid_substation',
        schemaVersion: 1,
        assetKind: 'substation',
        busId: spec.busId,
        nominalKv: spec.nominalKv,
        voltagePu: 1,
        frequencyHz: 50,
        connectedBranchCount: 0,
        transformerCapacityMw: spec.transformerCapacityMw,
        loadingPercent: 0,
        reactiveMarginMvar: 0,
        state: 'normal',
        provenance,
      }
    case 'branch':
      return {
        type: 'grid_branch',
        schemaVersion: 1,
        assetKind: 'branch',
        branchKind: spec.branchKind,
        fromBusId: spec.fromBusId,
        toBusId: spec.toBusId,
        nominalKv: spec.nominalKv,
        ratingMw: spec.ratingMw,
        emergencyRatingMw: spec.emergencyRatingMw ?? spec.ratingMw * 1.18,
        reactancePu: spec.reactancePu,
        resistancePu: spec.resistancePu,
        state: spec.state,
        availability: spec.availability,
        flowMw: 0,
        loadingPercent: 0,
        voltageFromPu: 1,
        voltageToPu: 1,
        frequencyHz: 50,
        lossesMw: 0,
        weatherExposure: spec.weatherExposure,
        provenance,
      }
    case 'generator': {
      const availableMw = spec.availableMw ?? spec.capacityMw
      return {
        type: 'grid_generator',
        schemaVersion: 1,
        assetKind: 'generator',
        generationKind: spec.generationKind,
        busId: spec.busId,
        capacityMw: spec.capacityMw,
        availableMw,
        dispatchMw: spec.dispatchMw ?? Math.min(availableMw, spec.targetMw ?? availableMw * 0.72),
        targetMw: spec.targetMw ?? Math.min(availableMw, spec.capacityMw * 0.72),
        reserveMw: spec.reserveMw,
        rampRateMwPerMinute: spec.rampRateMwPerMinute,
        inertiaSeconds: spec.inertiaSeconds,
        voltageSetpointPu: spec.voltageSetpointPu,
        state: spec.state,
        ...(spec.resourceFraction === undefined ? {} : { resourceFraction: spec.resourceFraction }),
        ...(spec.annualProductionGwh === undefined ? {} : { annualProductionGwh: spec.annualProductionGwh }),
        ...(spec.operator === undefined ? {} : { operator: spec.operator }),
        ...(spec.priceArea === undefined ? {} : { priceArea: spec.priceArea }),
        provenance,
      }
    }
    case 'load':
    case 'ev_charging': {
      const interruptibleMw = spec.interruptibleMw ?? Math.max(0, spec.demandMw - spec.criticalMw)
      return {
        type: 'grid_load',
        schemaVersion: 1,
        assetKind: spec.type === 'ev_charging' ? 'ev_charging' : 'load',
        loadKind: spec.loadKind,
        busId: spec.busId,
        demandMw: spec.demandMw,
        servedMw: spec.demandMw,
        shedMw: 0,
        criticalMw: spec.criticalMw,
        interruptibleMw,
        reactiveDemandMvar: spec.reactiveDemandMvar,
        voltagePu: 1,
        frequencyHz: 50,
        priority: spec.priority,
        serviceState: 'normal',
        controllable: spec.controllable,
        provenance,
      }
    }
    case 'storage':
      return {
        type: 'grid_storage',
        schemaVersion: 1,
        assetKind: 'storage',
        busId: spec.busId,
        capacityMwh: spec.capacityMwh,
        stateOfChargeFraction: spec.stateOfChargeFraction,
        maxChargeMw: spec.maxChargeMw,
        maxDischargeMw: spec.maxDischargeMw,
        dispatchMw: 0,
        voltagePu: 1,
        frequencyHz: 50,
        state: 'idle',
        provenance,
      }
    case 'market_area':
      return {
        type: 'grid_market_area',
        schemaVersion: 1,
        assetKind: 'market_area',
        areaId: spec.areaId,
        priceNokPerMwh: spec.priceNokPerMwh,
        generationMw: 0,
        loadMw: 0,
        netExportMw: 0,
        constrained: false,
        provenance,
      }
  }
}

const expandGridObject = (rawSpec: PackScenarioObjectSpec, at: IsoTimestamp): OperationalObject => {
  const spec = gridObjectSpecSchema.parse(rawSpec)
  const data = electricGridPackDataSchema.parse(dataForSpec(spec, at))
  return baseObject({
    spec,
    at,
    data,
    spatial: spec.type === 'branch' ? lineSpatial(spec.path) : pointSpatial(spec.position, at),
    kind: 'facility',
  })
}

export const electricGridScenarioSupport: PackScenarioSupport = {
  expandObject: (rawSpec: PackScenarioObjectSpec, context): OperationalObject => {
    if (rawSpec.type === 'regional_grid') {
      throw new Error('electric-grid regional_grid expands to multiple objects and must be expanded through scenario config')
    }
    return expandGridObject(rawSpec, context.at)
  },
  expandObjects: (rawSpec: PackScenarioObjectSpec, context): ReadonlyArray<OperationalObject> => {
    if (rawSpec.type === 'regional_grid') {
      regionalGridSpecSchema.parse(rawSpec)
      return norwayGridArenaObjectSpecs().map(spec => expandGridObject(spec, context.at))
    }
    return [expandGridObject(rawSpec, context.at)]
  },
  applyOperation: (rawOperation: PackScenarioOperationSpec): OperationalObject => {
    throw new Error(`electric-grid scenario operation is not supported yet: ${rawOperation.type}`)
  },
}
