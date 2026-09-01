import { z } from 'zod'
import type { GridDefinition } from './config.ts'
import type {
  CompiledGridDefinition,
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

const busIdFor = (name: string, nominalKv: number): string =>
  `NO-${objectIdToken(name).toUpperCase()}-${Math.round(nominalKv)}`

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
    busIdFor(substation.name, substation.maxVoltageKv),
  ]))
  const substationByExternalId = new Map(norwayGridSourceData.substations.map(substation => [substation.externalId, substation]))
  const sourceBuses = norwayGridSourceData.substations.map(substation => ({
    id: busByExternalId.get(substation.externalId)!,
    label: substation.name,
    nominalKv: substation.maxVoltageKv,
    location: [substation.lon, substation.lat] as const,
    sourceId: substation.sourceId,
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
    }
  })
  const osloBusId = loads.find(load => load.id === 'load:oslo-north-urban')?.busId ?? buses[0]!.id
  return {
    ...catalogEntry,
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
  generationScale: 1,
  storageStateOfCharge: 0.58,
}]])
const automations = new Map<string, GridAutomationDefinition>([[norwayStandardAutomationRef, {
  id: norwayStandardAutomationRef,
  title: electricGridDefinitionCatalog.automations.find(candidate => candidate.id === norwayStandardAutomationRef)!.title,
  loadProfiles: true,
  storageFrequencyResponse: true,
  underFrequencyLoadShedding: true,
}]])

const operatingPointOverridesSchema = z.object({
  loadScale: z.number().finite().positive().optional(),
  generationScale: z.number().finite().nonnegative().optional(),
  storageStateOfCharge: z.number().finite().min(0).max(1).optional(),
}).strict()

const expectEmptyRecord = (value: Record<string, unknown>, subject: string): void => {
  if (Object.keys(value).length > 0) throw new Error(`${subject} does not accept parameters`)
}

export const gridDefinitionCatalog = electricGridDefinitionCatalog

export const compileGridDefinition = (definition: GridDefinition): CompiledGridDefinition => {
  expectEmptyRecord(definition.model.parameters, `Grid Model ${definition.model.ref}`)
  const model = models.get(definition.model.ref)
  if (!model) throw new Error(`unknown Grid Model: ${definition.model.ref}`)
  const operatingPoint = operatingPoints.get(definition.operatingPoint.ref)
  if (!operatingPoint) throw new Error(`unknown Grid Operating Point: ${definition.operatingPoint.ref}`)
  const automation = automations.get(definition.automation.ref)
  if (!automation) throw new Error(`unknown Grid Automation: ${definition.automation.ref}`)
  const parameterOverrides = operatingPointOverridesSchema.parse(definition.operatingPoint.parameterOverrides ?? {})
  const valueOverrides = definition.operatingPoint.valueOverrides ?? {}
  expectEmptyRecord(valueOverrides, `Grid Operating Point ${definition.operatingPoint.ref} value overrides`)
  return {
    gridId: definition.id,
    model,
    operatingPoint: {
      ...operatingPoint,
      ...(parameterOverrides.loadScale === undefined ? {} : { loadScale: parameterOverrides.loadScale }),
      ...(parameterOverrides.generationScale === undefined ? {} : { generationScale: parameterOverrides.generationScale }),
      ...(parameterOverrides.storageStateOfCharge === undefined ? {} : { storageStateOfCharge: parameterOverrides.storageStateOfCharge }),
    },
    automation,
  }
}
