import type { PackScenarioObjectSpec } from '../../../core/packs/protocol.ts'
import { generatorDefaults, inferBranchElectricalParameters } from './electrical-parameters.ts'
import { norwayGridArenaData } from './norway-grid-arena-data.ts'
import type { GridArenaScenarioObjectSpec, SourceDerivedGridArenaData } from './types.ts'

export interface GridArenaTopologyBranch {
  readonly objectId: string
  readonly label: string
  readonly fromBusId: string
  readonly toBusId: string
  readonly nominalKv: number
  readonly ratingMw: number
  readonly emergencyRatingMw: number
  readonly reactancePu: number
  readonly resistancePu: number
  readonly state: 'closed' | 'open' | 'faulted' | 'derated'
  readonly availability: number
  readonly weatherExposure: 'low' | 'medium' | 'high'
}

export interface GridArenaTopologyBus {
  readonly busId: string
  readonly label: string
  readonly nominalKv: number
}

export interface GridArenaTopology {
  readonly buses: ReadonlyArray<GridArenaTopologyBus>
  readonly branches: ReadonlyArray<GridArenaTopologyBranch>
}

const objectIdToken = (value: string): string =>
  value
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'oe')
    .replace(/[åÅ]/g, 'aa')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

const busIdFor = (name: string, nominalKv: number): string =>
  `NO1-${objectIdToken(name).toUpperCase()}-${Math.round(nominalKv)}`

const substationObjectIdFor = (substation: SourceDerivedGridArenaData['substations'][number]): string =>
  `grid:ss-${objectIdToken(substation.name)}-${Math.round(substation.maxVoltageKv)}-${objectIdToken(substation.externalId)}`

const branchObjectIdFor = (
  branch: SourceDerivedGridArenaData['branches'][number],
  from: SourceDerivedGridArenaData['substations'][number],
  to: SourceDerivedGridArenaData['substations'][number],
): string =>
  `grid:branch-${objectIdToken(`${from.name}-${to.name}-${branch.nominalKv}-${branch.externalId}`)}`

const provenance = (config: {
  readonly method: 'observed' | 'converted' | 'inferred' | 'configured' | 'defaulted' | 'unknown'
  readonly sourceId: string
  readonly confidence: 'high' | 'medium' | 'low'
  readonly sourceUrl?: string
}): Record<string, unknown> => ({
  method: config.method,
  sourceId: config.sourceId,
  confidence: config.confidence,
  ...(config.sourceUrl === undefined ? {} : { sourceUrl: config.sourceUrl }),
})

export const norwayGridArenaSourceNotes = (): ReadonlyArray<string> =>
  norwayGridArenaData.sourceBuild.notes

export const norwayGridArenaObjectSpecs = (
  data: SourceDerivedGridArenaData = norwayGridArenaData,
): ReadonlyArray<GridArenaScenarioObjectSpec> => {
  const substationByExternalId = new Map(data.substations.map(substation => [substation.externalId, substation]))
  const busByExternalId = new Map(data.substations.map(substation => [
    substation.externalId,
    busIdFor(substation.name, substation.maxVoltageKv),
  ]))
  const specs: PackScenarioObjectSpec[] = [
    {
      pack: 'electric-grid',
      type: 'grid_system',
      id: 'grid:norway-system',
      label: 'Norway grid overview',
      position: [10.75, 59.9],
      provenance: provenance({
        method: 'converted',
        sourceId: data.sourceBuild.id,
        confidence: 'medium',
      }),
    },
    {
      pack: 'electric-grid',
      type: 'market_area',
      id: 'grid:market-no1',
      label: 'NO1 system area',
      areaId: 'NO1',
      position: [10.75, 59.9],
      priceNokPerMwh: 820,
      provenance: provenance({
        method: 'configured',
        sourceId: 'entso-e:NO1:demo-price-profile',
        confidence: 'medium',
      }),
    },
  ]

  for (const substation of data.substations) {
    specs.push({
      pack: 'electric-grid',
      type: 'substation',
      id: substationObjectIdFor(substation),
      label: substation.name,
      busId: busByExternalId.get(substation.externalId) ?? busIdFor(substation.name, substation.maxVoltageKv),
      nominalKv: substation.maxVoltageKv,
      transformerCapacityMw: Math.round(Math.max(250, substation.maxVoltageKv * 8)),
      position: [substation.lon, substation.lat],
      provenance: provenance({
        method: 'converted',
        sourceId: substation.sourceId,
        confidence: 'high',
      }),
    })
  }

  const branchIds = new Set<string>()
  for (const branch of data.branches) {
    const from = substationByExternalId.get(branch.fromExternalId)
    const to = substationByExternalId.get(branch.toExternalId)
    const fromBusId = busByExternalId.get(branch.fromExternalId)
    const toBusId = busByExternalId.get(branch.toExternalId)
    if (!from || !to || !fromBusId || !toBusId) continue
    const params = inferBranchElectricalParameters({
      nominalKv: branch.nominalKv,
      lengthKm: branch.lengthKm,
      category: branch.category,
      name: branch.name,
    })
    const id = branchObjectIdFor(branch, from, to)
    if (branchIds.has(id)) continue
    branchIds.add(id)
    specs.push({
      pack: 'electric-grid',
      type: 'branch',
      id,
      label: branch.name,
      branchKind: 'ac_line',
      fromBusId,
      toBusId,
      nominalKv: branch.nominalKv,
      ratingMw: params.ratingMw,
      emergencyRatingMw: params.emergencyRatingMw,
      reactancePu: params.reactancePu,
      resistancePu: params.resistancePu,
      weatherExposure: params.weatherExposure,
      provenance: provenance({
        method: 'converted',
        sourceId: branch.sourceId,
        confidence: 'high',
      }),
    })
  }

  for (const generator of data.generators) {
    const nearest = nearestSubstation(data.substations, [generator.lon, generator.lat])
    if (!nearest) continue
    const defaults = generatorDefaults(generator.generationKind, generator.capacityMw)
    specs.push({
      pack: 'electric-grid',
      type: 'generator',
      id: `grid:gen-${objectIdToken(generator.name)}-${objectIdToken(generator.externalId)}`,
      label: generator.name,
      generationKind: generator.generationKind,
      busId: busByExternalId.get(nearest.externalId) ?? busIdFor(nearest.name, nearest.maxVoltageKv),
      capacityMw: generator.capacityMw,
      availableMw: defaults.availableMw,
      dispatchMw: defaults.dispatchMw,
      targetMw: defaults.targetMw,
      reserveMw: defaults.reserveMw,
      rampRateMwPerMinute: defaults.rampRateMwPerMinute,
      inertiaSeconds: defaults.inertiaSeconds,
      resourceFraction: defaults.resourceFraction,
      ...(generator.annualProductionGwh === null ? {} : { annualProductionGwh: generator.annualProductionGwh }),
      ...(generator.operator === null ? {} : { operator: generator.operator }),
      ...(generator.priceArea === null ? {} : { priceArea: `NO${generator.priceArea}` }),
      position: [generator.lon, generator.lat],
      provenance: provenance({
        method: generator.augmentationSourceId ? 'observed' : 'converted',
        sourceId: generator.augmentationSourceId ?? generator.sourceId,
        confidence: generator.augmentationSourceId ? 'high' : 'medium',
      }),
    })
  }

  for (const load of data.loads) {
    const substation = substationByExternalId.get(load.busExternalId)
    if (!substation) continue
    specs.push({
      pack: 'electric-grid',
      type: load.loadKind === 'ev_charging' ? 'ev_charging' : 'load',
      id: `grid:load-${objectIdToken(load.id)}`,
      label: load.label,
      loadKind: load.loadKind,
      busId: busByExternalId.get(substation.externalId) ?? busIdFor(substation.name, substation.maxVoltageKv),
      demandMw: load.demandMw,
      criticalMw: load.criticalMw,
      interruptibleMw: Math.max(0, load.demandMw - load.criticalMw),
      reactiveDemandMvar: load.reactiveDemandMvar,
      priority: load.priority,
      controllable: load.controllable ?? false,
      position: [load.lon, load.lat],
      provenance: provenance({
        method: 'inferred',
        sourceId: 'leitbild:inferred-consumer-supply-zones:v1',
        confidence: 'medium',
      }),
    })
  }

  specs.push({
    pack: 'electric-grid',
    type: 'storage',
    id: 'grid:storage-oslo-battery',
    label: 'Oslo flexibility battery',
    busId: busByExternalId.get(data.loads.find(load => load.id === 'oslo-north-urban')?.busExternalId ?? '') ?? 'NO1-SOGN-TRAFOSTASJON-300',
    capacityMwh: 650,
    stateOfChargeFraction: 0.58,
    maxChargeMw: 180,
    maxDischargeMw: 220,
    position: [10.82, 59.92],
    provenance: provenance({
      method: 'inferred',
      sourceId: 'leitbild:grid-flexibility-arena:v1',
      confidence: 'medium',
    }),
  })

  return specs as ReadonlyArray<GridArenaScenarioObjectSpec>
}

export const norwayGridArenaTopology = (
  data: SourceDerivedGridArenaData = norwayGridArenaData,
): GridArenaTopology => {
  const substationByExternalId = new Map(data.substations.map(substation => [substation.externalId, substation]))
  const busByExternalId = new Map(data.substations.map(substation => [
    substation.externalId,
    busIdFor(substation.name, substation.maxVoltageKv),
  ]))
  const buses = data.substations.map(substation => ({
    busId: busByExternalId.get(substation.externalId) ?? busIdFor(substation.name, substation.maxVoltageKv),
    label: substation.name,
    nominalKv: substation.maxVoltageKv,
  }))
  const branchIds = new Set<string>()
  const branches: GridArenaTopologyBranch[] = []
  for (const branch of data.branches) {
    const from = substationByExternalId.get(branch.fromExternalId)
    const to = substationByExternalId.get(branch.toExternalId)
    const fromBusId = busByExternalId.get(branch.fromExternalId)
    const toBusId = busByExternalId.get(branch.toExternalId)
    if (!from || !to || !fromBusId || !toBusId) continue
    const objectId = branchObjectIdFor(branch, from, to)
    if (branchIds.has(objectId)) continue
    branchIds.add(objectId)
    const params = inferBranchElectricalParameters({
      nominalKv: branch.nominalKv,
      lengthKm: branch.lengthKm,
      category: branch.category,
      name: branch.name,
    })
    branches.push({
      objectId,
      label: branch.name,
      fromBusId,
      toBusId,
      nominalKv: branch.nominalKv,
      ratingMw: params.ratingMw,
      emergencyRatingMw: params.emergencyRatingMw,
      reactancePu: params.reactancePu,
      resistancePu: params.resistancePu,
      state: 'closed',
      availability: 1,
      weatherExposure: params.weatherExposure,
    })
  }
  return { buses, branches }
}

const haversineKm = (a: readonly [number, number], b: readonly [number, number]): number => {
  const radiusKm = 6371
  const toRad = (value: number): number => value * Math.PI / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)))
}

const nearestSubstation = (
  substations: ReadonlyArray<SourceDerivedGridArenaData['substations'][number]>,
  coordinate: readonly [number, number],
): SourceDerivedGridArenaData['substations'][number] | null => {
  let best: { readonly substation: SourceDerivedGridArenaData['substations'][number]; readonly distanceKm: number } | null = null
  for (const substation of substations) {
    const distanceKm = haversineKm(coordinate, [substation.lon, substation.lat])
    if (!best || distanceKm < best.distanceKm) best = { substation, distanceKm }
  }
  return best?.substation ?? null
}
