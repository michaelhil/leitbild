import { createHash } from 'node:crypto'
import { gridOperatingPointOverridesSchema, type GridDefinition } from './config.ts'
import type {
  CompiledGridModelIndex,
  CompiledGridDefinition,
  GridAssetIndexEntry,
  GridAutomationDefinition,
  GridBranchKind,
  GridModelDefinition,
  GridOperatingPointDefinition,
} from './grid-model.ts'
import {
  norwayGridModelRef,
  norwayNormalOperatingPointRef,
  norwayStandardAutomationRef,
  electricGridDefinitionCatalog,
} from './definition-refs.ts'
import { generatorDefaults, inferBranchElectricalParameters } from './models/electrical-parameters.ts'
import { norwayGridSourceData } from './models/norway-source-data.generated.ts'

const objectIdToken = (value: string): string => value
  .replace(/[æÆ]/g, 'ae')
  .replace(/[øØ]/g, 'oe')
  .replace(/[åÅ]/g, 'aa')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80)

const busIdFor = (name: string, nominalKv: number, externalId: string): string =>
  `NO-${objectIdToken(name).toUpperCase()}-${Math.round(nominalKv)}-${objectIdToken(externalId).toUpperCase()}`

const branchKindFor = (category: 'line' | 'cable', name: string): GridBranchKind => {
  const normalized = name.toLowerCase()
  if (normalized.includes('nordlink') || normalized.includes('north sea link') || normalized.includes('skagerrak')) return 'hvdc_link'
  return category === 'cable' ? 'cable' : 'ac_line'
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

const norwayGridModel = (): GridModelDefinition => {
  const catalogEntry = electricGridDefinitionCatalog.models.find(candidate => candidate.id === norwayGridModelRef)!
  const busByExternalId = new Map(norwayGridSourceData.substations.map(substation => [
    substation.externalId,
    busIdFor(substation.name, substation.maxVoltageKv, substation.externalId),
  ]))
  const substationByExternalId = new Map(norwayGridSourceData.substations.map(substation => [substation.externalId, substation]))
  const sourceBuses = norwayGridSourceData.substations.map(substation => ({
    id: busByExternalId.get(substation.externalId)!,
    label: substation.name,
    nominalKv: substation.maxVoltageKv,
    location: [substation.lon, substation.lat] as const,
    sourceId: substation.sourceId,
    sourceFeatureId: substation.externalId,
  }))
  const branchIds = new Set<string>()
  const branches = norwayGridSourceData.branches.flatMap(branch => {
    const from = substationByExternalId.get(branch.fromExternalId)
    const to = substationByExternalId.get(branch.toExternalId)
    const fromBusId = busByExternalId.get(branch.fromExternalId)
    const toBusId = busByExternalId.get(branch.toExternalId)
    if (!from || !to || !fromBusId || !toBusId) return []
    const id = `branch:${objectIdToken(`${from.name}-${to.name}-${branch.nominalKv}-${branch.externalId}`)}`
    if (branchIds.has(id)) return []
    branchIds.add(id)
    const electrical = inferBranchElectricalParameters(branch)
    return [{
      id,
      label: branch.name,
      kind: branchKindFor(branch.category, branch.name),
      fromBusId,
      toBusId,
      nominalKv: branch.nominalKv,
      ...electrical,
      sourceId: branch.sourceId,
      sourceFeatureId: branch.externalId,
    }]
  })
  const connectedBusIds = new Set(branches.flatMap(branch => [branch.fromBusId, branch.toBusId]))
  const buses = sourceBuses.filter(bus => connectedBusIds.has(bus.id))
  const nearestBusId = (location: readonly [number, number]): string => {
    let nearest = buses[0]
    let distance = Number.POSITIVE_INFINITY
    for (const bus of buses) {
      const nextDistance = haversineKm(location, bus.location)
      if (nextDistance < distance) {
        nearest = bus
        distance = nextDistance
      }
    }
    if (!nearest) throw new Error('Norway Grid Model has no buses')
    return nearest.id
  }
  const generators = norwayGridSourceData.generators.map(generator => {
    const defaults = generatorDefaults(generator.generationKind, generator.capacityMw)
    return {
      id: `generator:${objectIdToken(generator.name)}-${objectIdToken(generator.externalId)}`,
      label: generator.name,
      kind: generator.generationKind,
      busId: nearestBusId([generator.lon, generator.lat]),
      location: [generator.lon, generator.lat] as const,
      capacityMw: generator.capacityMw,
      availableMw: defaults.availableMw,
      reserveMw: defaults.reserveMw,
      rampRateMwPerMinute: defaults.rampRateMwPerMinute,
      inertiaSeconds: defaults.inertiaSeconds,
      ...(generator.annualProductionGwh === null ? {} : { annualProductionGwh: generator.annualProductionGwh }),
      ...(generator.operator === null ? {} : { operator: generator.operator }),
      ...(generator.priceArea === null ? {} : { priceArea: `NO${generator.priceArea}` }),
      sourceId: generator.augmentationSourceId ?? generator.sourceId,
      sourceFeatureId: generator.externalId,
    }
  })
  const loads = norwayGridSourceData.loads.map(load => {
    const preferredBusId = busByExternalId.get(load.busExternalId)
    return {
      id: `load:${objectIdToken(load.id)}`,
      label: load.label,
      kind: load.loadKind,
      busId: preferredBusId !== undefined && connectedBusIds.has(preferredBusId) ? preferredBusId : nearestBusId([load.lon, load.lat]),
      location: [load.lon, load.lat] as const,
      demandMw: load.demandMw,
      criticalMw: load.criticalMw,
      reactiveDemandMvar: load.reactiveDemandMvar,
      priority: load.priority,
      controllable: load.controllable ?? false,
      sourceId: 'leitbild:inferred-consumer-supply-zones',
      sourceFeatureId: load.id,
    }
  })
  const osloBusId = loads.find(load => load.id === 'load:oslo-north-urban')?.busId ?? buses[0]!.id
  return {
    ...catalogEntry,
    sourceBuild: {
      id: norwayGridSourceData.sourceBuild.id,
      generatedAt: norwayGridSourceData.sourceBuild.generatedAt,
    },
    sourceIds: norwayGridSourceData.sourceBuild.sourceIds,
    buses,
    branches,
    generators,
    loads,
    storage: [{
      id: 'storage:oslo-battery',
      label: 'Oslo flexibility battery',
      busId: osloBusId,
      location: [10.82, 59.92],
      capacityMwh: 650,
      maxChargeMw: 180,
      maxDischargeMw: 220,
      sourceId: 'leitbild:grid-flexibility-model',
      sourceFeatureId: 'oslo-battery',
    }],
    connectionPoints: loads
      .filter(load => load.kind === 'industry' || load.kind === 'data_center' || load.kind === 'process_plant')
      .map(load => ({
        id: `connection:${load.id.slice('load:'.length)}`,
        label: `${load.label} connection`,
        busId: load.busId,
        assetId: load.id,
        role: 'demand' as const,
        nominalKv: buses.find(bus => bus.id === load.busId)?.nominalKv ?? 132,
        maximumMw: load.demandMw,
      })),
  }
}

const models = new Map<string, GridModelDefinition>([[norwayGridModelRef, norwayGridModel()]])
const operatingPoints = new Map<string, GridOperatingPointDefinition>([[norwayNormalOperatingPointRef, {
  id: norwayNormalOperatingPointRef,
  title: electricGridDefinitionCatalog.operatingPoints.find(candidate => candidate.id === norwayNormalOperatingPointRef)!.title,
  loadScale: 1.03,
  generationAvailabilityScale: 1,
  storageStateOfCharge: 0.58,
}]])
const automations = new Map<string, GridAutomationDefinition>([[norwayStandardAutomationRef, {
  id: norwayStandardAutomationRef,
  title: electricGridDefinitionCatalog.automations.find(candidate => candidate.id === norwayStandardAutomationRef)!.title,
  loadProfiles: true,
  storageFrequencyResponse: true,
  underFrequencyLoadShedding: true,
}]])

const failModel = (model: GridModelDefinition, message: string): never => {
  throw new Error(`Grid Model ${model.id}: ${message}`)
}

const requireFinite = (model: GridModelDefinition, value: number, subject: string, minimum?: number): void => {
  if (!Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    failModel(model, `${subject} must be finite${minimum === undefined ? '' : ` and at least ${minimum}`}`)
  }
}

const addGrouped = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

const readonlyGroups = <T>(map: Map<string, T[]>): ReadonlyMap<string, ReadonlyArray<T>> =>
  new Map([...map].map(([key, values]) => [key, Object.freeze(values.slice())]))

export const compileGridModelIndex = (model: GridModelDefinition): CompiledGridModelIndex => {
  requireFinite(model, model.nominalFrequencyHz, 'nominal frequency', 1)
  if (model.buses.length === 0) failModel(model, 'must contain at least one bus')
  const assets: GridAssetIndexEntry[] = []
  const assetById = new Map<string, GridAssetIndexEntry>()
  const register = (entry: GridAssetIndexEntry): void => {
    if (assetById.has(entry.id)) failModel(model, `duplicate Grid Asset id ${entry.id}`)
    if (entry.id.trim().length === 0 || entry.label.trim().length === 0) failModel(model, 'asset ids and labels must be non-empty')
    assets.push(entry)
    assetById.set(entry.id, entry)
  }
  const busById = new Map(model.buses.map(bus => [bus.id, bus]))
  if (busById.size !== model.buses.length) failModel(model, 'contains duplicate bus ids')
  const branchesByBus = new Map<string, typeof model.branches[number][]>()
  const generatorsByBus = new Map<string, typeof model.generators[number][]>()
  const loadsByBus = new Map<string, typeof model.loads[number][]>()
  const storageByBus = new Map<string, typeof model.storage[number][]>()
  for (const bus of model.buses) {
    requireFinite(model, bus.nominalKv, `${bus.id} nominalKv`, 0.001)
    requireFinite(model, bus.location[0], `${bus.id} longitude`)
    requireFinite(model, bus.location[1], `${bus.id} latitude`)
    if (Math.abs(bus.location[0]) > 180 || Math.abs(bus.location[1]) > 90) failModel(model, `${bus.id} has an invalid location`)
    register({ id: bus.id, label: bus.label, kind: 'bus', definition: bus })
  }
  const requireBus = (busId: string, subject: string): void => {
    if (!busById.has(busId)) failModel(model, `${subject} references unknown bus ${busId}`)
  }
  for (const branch of model.branches) {
    requireBus(branch.fromBusId, branch.id)
    requireBus(branch.toBusId, branch.id)
    if (branch.fromBusId === branch.toBusId) failModel(model, `${branch.id} connects a bus to itself`)
    requireFinite(model, branch.nominalKv, `${branch.id} nominalKv`, 0.001)
    requireFinite(model, branch.ratingMw, `${branch.id} ratingMw`, 0.001)
    requireFinite(model, branch.emergencyRatingMw, `${branch.id} emergencyRatingMw`, branch.ratingMw)
    requireFinite(model, branch.reactancePu, `${branch.id} reactancePu`, 0.000001)
    requireFinite(model, branch.resistancePu, `${branch.id} resistancePu`, 0)
    addGrouped(branchesByBus, branch.fromBusId, branch)
    addGrouped(branchesByBus, branch.toBusId, branch)
    register({ id: branch.id, label: branch.label, kind: 'branch', definition: branch })
  }
  for (const generator of model.generators) {
    requireBus(generator.busId, generator.id)
    requireFinite(model, generator.capacityMw, `${generator.id} capacityMw`, 0.001)
    requireFinite(model, generator.availableMw, `${generator.id} availableMw`, 0)
    requireFinite(model, generator.reserveMw, `${generator.id} reserveMw`, 0)
    requireFinite(model, generator.rampRateMwPerMinute, `${generator.id} rampRateMwPerMinute`, 0)
    requireFinite(model, generator.inertiaSeconds, `${generator.id} inertiaSeconds`, 0)
    requireFinite(model, generator.location[0], `${generator.id} longitude`)
    requireFinite(model, generator.location[1], `${generator.id} latitude`)
    if (Math.abs(generator.location[0]) > 180 || Math.abs(generator.location[1]) > 90) failModel(model, `${generator.id} has an invalid location`)
    if (generator.availableMw > generator.capacityMw) failModel(model, `${generator.id} availableMw exceeds capacityMw`)
    if (generator.reserveMw > generator.availableMw) failModel(model, `${generator.id} reserveMw exceeds availableMw`)
    addGrouped(generatorsByBus, generator.busId, generator)
    register({ id: generator.id, label: generator.label, kind: 'generator', definition: generator })
  }
  for (const load of model.loads) {
    requireBus(load.busId, load.id)
    requireFinite(model, load.demandMw, `${load.id} demandMw`, 0)
    requireFinite(model, load.criticalMw, `${load.id} criticalMw`, 0)
    requireFinite(model, load.reactiveDemandMvar, `${load.id} reactiveDemandMvar`, 0)
    requireFinite(model, load.location[0], `${load.id} longitude`)
    requireFinite(model, load.location[1], `${load.id} latitude`)
    if (Math.abs(load.location[0]) > 180 || Math.abs(load.location[1]) > 90) failModel(model, `${load.id} has an invalid location`)
    if (load.criticalMw > load.demandMw) failModel(model, `${load.id} criticalMw exceeds demandMw`)
    addGrouped(loadsByBus, load.busId, load)
    register({ id: load.id, label: load.label, kind: 'load', definition: load })
  }
  for (const item of model.storage) {
    requireBus(item.busId, item.id)
    requireFinite(model, item.capacityMwh, `${item.id} capacityMwh`, 0.001)
    requireFinite(model, item.maxChargeMw, `${item.id} maxChargeMw`, 0)
    requireFinite(model, item.maxDischargeMw, `${item.id} maxDischargeMw`, 0)
    requireFinite(model, item.location[0], `${item.id} longitude`)
    requireFinite(model, item.location[1], `${item.id} latitude`)
    if (Math.abs(item.location[0]) > 180 || Math.abs(item.location[1]) > 90) failModel(model, `${item.id} has an invalid location`)
    addGrouped(storageByBus, item.busId, item)
    register({ id: item.id, label: item.label, kind: 'storage', definition: item })
  }
  const connectionPointIds = new Set<string>()
  for (const point of model.connectionPoints) {
    if (connectionPointIds.has(point.id)) failModel(model, `duplicate connection point id ${point.id}`)
    connectionPointIds.add(point.id)
    requireBus(point.busId, point.id)
    if (!assetById.has(point.assetId)) failModel(model, `${point.id} references unknown asset ${point.assetId}`)
    requireFinite(model, point.nominalKv, `${point.id} nominalKv`, 0.001)
    requireFinite(model, point.maximumMw, `${point.id} maximumMw`, 0)
  }
  const staticComponentByBus = new Map<string, string>()
  for (const bus of model.buses) {
    if (staticComponentByBus.has(bus.id)) continue
    const componentId = bus.id
    const queue = [bus.id]
    staticComponentByBus.set(bus.id, componentId)
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const branch of branchesByBus.get(current) ?? []) {
        const next = branch.fromBusId === current ? branch.toBusId : branch.fromBusId
        if (staticComponentByBus.has(next)) continue
        staticComponentByBus.set(next, componentId)
        queue.push(next)
      }
    }
  }
  return {
    assets: Object.freeze(assets),
    assetById,
    busById,
    branchesByBus: readonlyGroups(branchesByBus),
    generatorsByBus: readonlyGroups(generatorsByBus),
    loadsByBus: readonlyGroups(loadsByBus),
    storageByBus: readonlyGroups(storageByBus),
    staticComponentByBus,
    diagnostics: {
      assetCount: assets.length,
      topologyComponentCount: new Set(staticComponentByBus.values()).size,
      isolatedBusCount: model.buses.filter(bus => (branchesByBus.get(bus.id)?.length ?? 0) === 0).length,
    },
  }
}

interface CompiledModelEntry {
  readonly model: GridModelDefinition
  readonly index: CompiledGridModelIndex
  readonly digest: string
}

const compiledModels = new Map([...models].map(([id, model]): [string, CompiledModelEntry] => [id, {
  model,
  index: compileGridModelIndex(model),
  digest: createHash('sha256').update(JSON.stringify(model)).digest('hex'),
}]))

export const gridDefinitionCatalog = electricGridDefinitionCatalog

export const compileGridDefinition = (definition: GridDefinition): CompiledGridDefinition => {
  const compiledModel = compiledModels.get(definition.model.ref)
  if (!compiledModel) throw new Error(`unknown Grid Model: ${definition.model.ref}`)
  const operatingPoint = operatingPoints.get(definition.operatingPoint.ref)
  if (!operatingPoint) throw new Error(`unknown Grid Operating Point: ${definition.operatingPoint.ref}`)
  const automation = automations.get(definition.automation.ref)
  if (!automation) throw new Error(`unknown Grid Automation: ${definition.automation.ref}`)
  const operatingPointCatalogEntry = electricGridDefinitionCatalog.operatingPoints.find(candidate => candidate.id === definition.operatingPoint.ref)!
  const automationCatalogEntry = electricGridDefinitionCatalog.automations.find(candidate => candidate.id === definition.automation.ref)!
  if (!(operatingPointCatalogEntry.compatibleModelRefs as readonly string[]).includes(definition.model.ref)) {
    throw new Error(`Grid Operating Point ${definition.operatingPoint.ref} is not compatible with Model ${definition.model.ref}`)
  }
  if (!(automationCatalogEntry.compatibleModelRefs as readonly string[]).includes(definition.model.ref)) {
    throw new Error(`Grid Automation ${definition.automation.ref} is not compatible with Model ${definition.model.ref}`)
  }
  const overrides = gridOperatingPointOverridesSchema.parse(definition.operatingPoint.overrides ?? {})
  const resolvedOperatingPoint = {
    ...operatingPoint,
    ...(overrides.loadScale === undefined ? {} : { loadScale: overrides.loadScale }),
    ...(overrides.generationAvailabilityScale === undefined ? {} : { generationAvailabilityScale: overrides.generationAvailabilityScale }),
    ...(overrides.storageStateOfCharge === undefined ? {} : { storageStateOfCharge: overrides.storageStateOfCharge }),
  }
  const definitionDigest = createHash('sha256')
    .update(compiledModel.digest)
    .update(JSON.stringify(resolvedOperatingPoint))
    .update(JSON.stringify(automation))
    .digest('hex')
  return {
    gridId: definition.id,
    model: compiledModel.model,
    index: compiledModel.index,
    operatingPoint: resolvedOperatingPoint,
    automation,
    definitionDigest,
  }
}
