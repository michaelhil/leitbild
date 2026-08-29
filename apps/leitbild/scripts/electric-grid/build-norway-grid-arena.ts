import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface GeoJsonFeature {
  readonly id?: string
  readonly geometry: {
    readonly type: string
    readonly coordinates: unknown
  }
  readonly properties: Record<string, unknown>
}

interface GeoJsonCollection {
  readonly features: ReadonlyArray<GeoJsonFeature>
}

interface CandidateSubstation {
  readonly externalId: string
  readonly name: string
  readonly lon: number
  readonly lat: number
  readonly voltageKv: ReadonlyArray<number>
  readonly maxVoltageKv: number
  readonly operator: string | null
  readonly sourceId: string
}

interface CandidateBranch {
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

interface CandidateGenerator {
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

interface NveGenerationAugmentation {
  readonly sourceId: string
  readonly capacityMw: number | null
  readonly annualProductionGwh: number | null
  readonly operator: string | null
  readonly priceArea: string | null
}

interface ExistingArenaDataModule {
  readonly norwayGridArenaData?: {
    readonly generators?: ReadonlyArray<{
      readonly name: string
      readonly capacityMw: number
      readonly annualProductionGwh: number | null
      readonly operator: string | null
      readonly priceArea: string | null
      readonly augmentationSourceId: string | null
    }>
  }
}

const inputPath = resolve(process.argv[2] ?? 'data/reference-local/builds/grid-norway/20260528-225211/grid-norway.features.geojson')
const outputPath = resolve(process.argv[3] ?? 'src/packs/electric-grid/arena/norway-grid-arena-data.ts')

const toRad = (value: number): number => value * Math.PI / 180

const haversineKm = (a: readonly [number, number], b: readonly [number, number]): number => {
  const radiusKm = 6371
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)))
}

const numberArray = (value: unknown): ReadonlyArray<number> =>
  Array.isArray(value) ? value.filter((item): item is number => Number.isFinite(item)) : []

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const pointOf = (geometry: GeoJsonFeature['geometry']): readonly [number, number] | null => {
  if (geometry.type === 'Point') {
    const coordinates = geometry.coordinates as readonly [number, number]
    return [coordinates[0], coordinates[1]]
  }
  if (geometry.type === 'Polygon') {
    const ring = (geometry.coordinates as ReadonlyArray<ReadonlyArray<readonly [number, number]>>)[0] ?? []
    if (ring.length === 0) return null
    const sum = ring.reduce((acc, coordinate) => [acc[0] + coordinate[0], acc[1] + coordinate[1]] as const, [0, 0] as const)
    return [sum[0] / ring.length, sum[1] / ring.length]
  }
  if (geometry.type === 'MultiPolygon') {
    const ring = (geometry.coordinates as ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly [number, number]>>>)[0]?.[0] ?? []
    if (ring.length === 0) return null
    const sum = ring.reduce((acc, coordinate) => [acc[0] + coordinate[0], acc[1] + coordinate[1]] as const, [0, 0] as const)
    return [sum[0] / ring.length, sum[1] / ring.length]
  }
  return null
}

const lineCoordinates = (geometry: GeoJsonFeature['geometry']): ReadonlyArray<readonly [number, number]> =>
  geometry.type === 'LineString'
    ? (geometry.coordinates as ReadonlyArray<readonly [number, number]>)
    : []

const lineLengthKm = (coordinates: ReadonlyArray<readonly [number, number]>): number => {
  let length = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    length += haversineKm(coordinates[index - 1]!, coordinates[index]!)
  }
  return length
}

const inArenaRegion = (coordinate: readonly [number, number]): boolean =>
  coordinate[0] >= 4.0 && coordinate[0] <= 31.5 && coordinate[1] >= 57.5 && coordinate[1] <= 71.5

const backboneVoltageThresholdKv = 300
const regionalNorthVoltageThresholdKv = 132
const regionalEastVoltageThresholdKv = 220
const northCoverageLatitude = 66
const eastCoverageLongitude = 12
const endpointSnapDistanceKm = 14

const hasOperatorLabel = (name: string): boolean =>
  !/^(node|way|relation)\//.test(name)

const sourceIdOf = (feature: GeoJsonFeature): string =>
  stringOrNull(feature.properties.source) ?? 'unknown'

const propertyName = (feature: GeoJsonFeature): string =>
  stringOrNull(feature.properties.name) ?? stringOrNull(feature.properties.externalId) ?? String(feature.id ?? 'unknown')

const voltageCompatible = (branchVoltage: ReadonlyArray<number>, substation: CandidateSubstation): boolean =>
  branchVoltage.length === 0 ||
  substation.voltageKv.length === 0 ||
  branchVoltage.some(value => substation.voltageKv.some(candidate => Math.abs(value - candidate) < 1))

const eligibleOperationalVoltage = (
  maxVoltageKv: number,
  coordinate: readonly [number, number],
): boolean =>
  maxVoltageKv >= backboneVoltageThresholdKv ||
  (maxVoltageKv >= regionalNorthVoltageThresholdKv && coordinate[1] >= northCoverageLatitude) ||
  (maxVoltageKv >= regionalEastVoltageThresholdKv && coordinate[0] >= eastCoverageLongitude)

const simplifyPath = (
  coordinates: ReadonlyArray<readonly [number, number]>,
  maxPoints: number,
): ReadonlyArray<readonly [number, number]> => {
  if (coordinates.length <= maxPoints) return coordinates.map(roundPoint)
  const simplified: Array<readonly [number, number]> = []
  const last = coordinates.length - 1
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round(index * last / (maxPoints - 1))
    simplified.push(roundPoint(coordinates[sourceIndex]!))
  }
  return simplified
}

const roundPoint = (point: readonly [number, number]): readonly [number, number] => [
  Number(point[0].toFixed(6)),
  Number(point[1].toFixed(6)),
]

const sourceKey = (value: string): string =>
  value
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'oe')
    .replace(/[åÅ]/g, 'aa')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(kraftverk|kraftstasjon|trafostasjon|transformatorstasjon|koblingsstasjon|trafo)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const romanNumeralValues: ReadonlyMap<string, string> = new Map([
  ['i', '1'],
  ['ii', '2'],
  ['iii', '3'],
  ['iv', '4'],
  ['v', '5'],
  ['vi', '6'],
  ['vii', '7'],
  ['viii', '8'],
  ['ix', '9'],
  ['x', '10'],
] as const)

const replaceRomanNumerals = (value: string): string =>
  value.replace(/\b(i{1,3}|iv|v|vi{0,3}|ix|x)\b/gi, token => romanNumeralValues.get(token.toLowerCase()) ?? token)

const generationLookupKeys = (name: string): ReadonlyArray<string> => {
  const exact = sourceKey(name)
  const numeric = sourceKey(replaceRomanNumerals(name))
  return [...new Set([exact, numeric].filter(key => key.length > 0))]
}

const generatorDedupeKeys = (name: string): ReadonlyArray<string> =>
  generationLookupKeys(name).map(key => key.replace(/\b(?:kraftverk|kraftstasjon)\b/g, '').trim())

const looksLikeSamePlantFamily = (selected: CandidateGenerator, candidate: CandidateGenerator): boolean => {
  const selectedKeys = generatorDedupeKeys(selected.name)
  const candidateKeys = generatorDedupeKeys(candidate.name)
  return selectedKeys.some(selectedKey =>
    candidateKeys.some(candidateKey =>
      selectedKey.length >= 4 &&
      candidateKey.length >= 4 &&
      (candidateKey.startsWith(`${selectedKey} `) || selectedKey.startsWith(`${candidateKey} `) || candidateKey === selectedKey)))
}

const dedupeGenerators = (candidates: ReadonlyArray<CandidateGenerator>): ReadonlyArray<CandidateGenerator> => {
  const selected: CandidateGenerator[] = []
  const sorted = [...candidates].sort((left, right) => right.capacityMw - left.capacityMw)
  for (const candidate of sorted) {
    const duplicate = selected.some(existing => {
      if (candidate.augmentationSourceId !== null && existing.augmentationSourceId === candidate.augmentationSourceId) return true
      const distanceKm = haversineKm([existing.lon, existing.lat], [candidate.lon, candidate.lat])
      if (distanceKm > 2) return false
      if (!looksLikeSamePlantFamily(existing, candidate)) return false
      return Math.max(existing.capacityMw, candidate.capacityMw) >= Math.min(existing.capacityMw, candidate.capacityMw) * 1.25
    })
    if (!duplicate) selected.push(candidate)
  }
  return selected
}

const generationKindFor = (value: string | null): CandidateGenerator['generationKind'] => {
  if (value === 'wind') return 'wind'
  if (value === 'solar') return 'solar'
  if (value === 'waste' || value === 'gas' || value === 'coal') return 'thermal'
  return 'hydro'
}

const fetchNveGenerationIndex = async (): Promise<ReadonlyMap<string, NveGenerationAugmentation>> => {
  const endpoints = [
    ['nve:vannkraftdatabase', 'https://api.nve.no/web/Powerplant/GetHydroPowerPlantsInOperation'],
    ['nve:vindkraftdatabase', 'https://api.nve.no/web/WindPowerplant/GetWindPowerPlantsInOperation'],
  ] as const
  const index = new Map<string, NveGenerationAugmentation>()
  for (const [sourceId, url] of endpoints) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) continue
      const records = await response.json() as ReadonlyArray<Record<string, unknown>>
      for (const record of records) {
        const name = stringOrNull(record.Navn)
        if (!name) continue
        const augmentation: NveGenerationAugmentation = {
          sourceId: `${sourceId}:${name}`,
          capacityMw: sourceId === 'nve:vannkraftdatabase'
            ? numberOrNull(record.MaksYtelse)
            : numberOrNull(record.InstallertEffekt_MW),
          annualProductionGwh: sourceId === 'nve:vannkraftdatabase'
            ? numberOrNull(record.MidProd_91_20)
            : numberOrNull(record.NormalAArsproduksjon_GWh),
          operator: stringOrNull(record.HovedEier) ?? stringOrNull(record.HovedEierNavn),
          priceArea: stringOrNull(record.ElspotomraadeNummer),
        }
        for (const key of generationLookupKeys(name)) {
          const existing = index.get(key)
          if (!existing || (augmentation.capacityMw ?? 0) > (existing.capacityMw ?? 0)) index.set(key, augmentation)
        }
      }
    } catch (error) {
      console.warn(`warning: could not augment generation provenance from ${sourceId}: ${String(error)}`)
    }
  }
  return index
}

const cachedGenerationIndex = async (): Promise<ReadonlyMap<string, NveGenerationAugmentation>> => {
  try {
    const module = await import(pathToFileURL(outputPath).href) as ExistingArenaDataModule
    const index = new Map<string, NveGenerationAugmentation>()
    for (const generator of module.norwayGridArenaData?.generators ?? []) {
      if (generator.augmentationSourceId === null) continue
      const augmentation: NveGenerationAugmentation = {
        sourceId: generator.augmentationSourceId,
        capacityMw: generator.capacityMw,
        annualProductionGwh: generator.annualProductionGwh,
        operator: generator.operator,
        priceArea: generator.priceArea,
      }
      for (const key of generationLookupKeys(generator.name)) {
        index.set(key, augmentation)
      }
    }
    return index
  } catch {
    // The generated arena file may not exist yet; live NVE fetch remains the authoritative path.
    return new Map()
  }
}

const generationAugmentationIndex = async (): Promise<ReadonlyMap<string, NveGenerationAugmentation>> => {
  const cached = await cachedGenerationIndex()
  const fetched = await fetchNveGenerationIndex()
  return new Map([...cached, ...fetched])
}

const branchEndpointIsKnown = (
  branch: CandidateBranch,
  substations: ReadonlySet<string>,
): boolean =>
  substations.has(branch.fromExternalId) && substations.has(branch.toExternalId)

const nearestSubstation = (
  substations: ReadonlyArray<CandidateSubstation>,
  coordinate: readonly [number, number],
): CandidateSubstation | null => {
  let best: { readonly substation: CandidateSubstation; readonly distanceKm: number } | null = null
  for (const substation of substations) {
    const distanceKm = haversineKm(coordinate, [substation.lon, substation.lat])
    if (!best || distanceKm < best.distanceKm) best = { substation, distanceKm }
  }
  return best?.substation ?? null
}

const loadZones = (substations: ReadonlyArray<CandidateSubstation>) => {
  const templates = [
    { id: 'oslo-west-urban', label: 'Oslo west urban load', loadKind: 'residential', lon: 10.68, lat: 59.94, demandMw: 280, criticalMw: 105, reactiveDemandMvar: 60, priority: 'normal' },
    { id: 'oslo-north-urban', label: 'Oslo north urban load', loadKind: 'residential', lon: 10.75, lat: 59.96, demandMw: 320, criticalMw: 120, reactiveDemandMvar: 70, priority: 'normal' },
    { id: 'oslo-east-urban', label: 'Oslo east urban load', loadKind: 'residential', lon: 10.84, lat: 59.93, demandMw: 320, criticalMw: 115, reactiveDemandMvar: 70, priority: 'normal' },
    { id: 'oslo-hospital', label: 'Oslo hospital critical load', loadKind: 'hospital', lon: 10.7387, lat: 59.9369, demandMw: 85, criticalMw: 70, reactiveDemandMvar: 22, priority: 'critical' },
    { id: 'gardermoen-airport', label: 'Oslo airport load', loadKind: 'airport', lon: 11.1004, lat: 60.1939, demandMw: 120, criticalMw: 55, reactiveDemandMvar: 34, priority: 'high' },
    { id: 'bergen-urban', label: 'Bergen urban load', loadKind: 'residential', lon: 5.3221, lat: 60.3913, demandMw: 360, criticalMw: 135, reactiveDemandMvar: 82, priority: 'normal' },
    { id: 'stavanger-urban', label: 'Stavanger urban load', loadKind: 'residential', lon: 5.7331, lat: 58.9701, demandMw: 310, criticalMw: 118, reactiveDemandMvar: 72, priority: 'normal' },
    { id: 'trondheim-urban', label: 'Trondheim urban load', loadKind: 'residential', lon: 10.3951, lat: 63.4305, demandMw: 330, criticalMw: 130, reactiveDemandMvar: 76, priority: 'normal' },
    { id: 'tromso-urban', label: 'Tromsø urban load', loadKind: 'residential', lon: 18.9553, lat: 69.6492, demandMw: 150, criticalMw: 65, reactiveDemandMvar: 36, priority: 'normal' },
    { id: 'bodo-urban', label: 'Bodø urban load', loadKind: 'residential', lon: 14.4049, lat: 67.2804, demandMw: 125, criticalMw: 52, reactiveDemandMvar: 30, priority: 'normal' },
    { id: 'kristiansand-urban', label: 'Kristiansand urban load', loadKind: 'residential', lon: 7.9956, lat: 58.1467, demandMw: 190, criticalMw: 72, reactiveDemandMvar: 44, priority: 'normal' },
    { id: 'alesund-urban', label: 'Ålesund urban load', loadKind: 'residential', lon: 6.1495, lat: 62.4722, demandMw: 135, criticalMw: 58, reactiveDemandMvar: 32, priority: 'normal' },
    { id: 'grenland-industry', label: 'Grenland process industry', loadKind: 'industry', lon: 9.66, lat: 59.12, demandMw: 650, criticalMw: 330, reactiveDemandMvar: 220, priority: 'high' },
    { id: 'mo-rana-industry', label: 'Mo i Rana process industry', loadKind: 'industry', lon: 14.1428, lat: 66.3128, demandMw: 420, criticalMw: 230, reactiveDemandMvar: 126, priority: 'high' },
    { id: 'narvik-industry', label: 'Narvik rail and industry load', loadKind: 'industry', lon: 17.4272, lat: 68.4385, demandMw: 260, criticalMw: 132, reactiveDemandMvar: 78, priority: 'high' },
    { id: 'hammerfest-lng', label: 'Hammerfest LNG and port load', loadKind: 'industry', lon: 23.6821, lat: 70.6634, demandMw: 230, criticalMw: 150, reactiveDemandMvar: 70, priority: 'high' },
    { id: 'oslo-ev', label: 'Oslo EV fast-charging cluster', loadKind: 'ev_charging', lon: 10.85, lat: 59.94, demandMw: 145, criticalMw: 20, reactiveDemandMvar: 28, priority: 'low', controllable: true },
    { id: 'e18-truck-depot', label: 'E18 truck charging depot', loadKind: 'ev_charging', lon: 10.49, lat: 59.9, demandMw: 95, criticalMw: 10, reactiveDemandMvar: 16, priority: 'low', controllable: true },
    { id: 'e39-west-charging', label: 'E39 west coast charging corridor', loadKind: 'ev_charging', lon: 5.95, lat: 60.55, demandMw: 105, criticalMw: 12, reactiveDemandMvar: 18, priority: 'low', controllable: true },
    { id: 'e6-north-charging', label: 'E6 northern truck charging corridor', loadKind: 'ev_charging', lon: 15.4, lat: 67.15, demandMw: 80, criticalMw: 10, reactiveDemandMvar: 14, priority: 'low', controllable: true },
    { id: 'oslo-data-center', label: 'Oslo data-center load', loadKind: 'data_center', lon: 10.98, lat: 59.96, demandMw: 230, criticalMw: 165, reactiveDemandMvar: 56, priority: 'high' },
    { id: 'trondheim-data-center', label: 'Trondheim data-center load', loadKind: 'data_center', lon: 10.46, lat: 63.43, demandMw: 135, criticalMw: 95, reactiveDemandMvar: 32, priority: 'high' },
  ] as const
  return templates.flatMap(template => {
    const substation = nearestSubstation(substations, [template.lon, template.lat])
    if (!substation) return []
    return [{ ...template, busExternalId: substation.externalId }]
  })
}

const main = async (): Promise<void> => {
  const raw = JSON.parse(await readFile(inputPath, 'utf8')) as GeoJsonCollection
  const nveGeneration = await generationAugmentationIndex()
  const substations = raw.features.flatMap((feature): ReadonlyArray<CandidateSubstation> => {
    if (feature.properties.category !== 'substation') return []
    const maxVoltageKv = numberOrNull(feature.properties.maxVoltageKv) ?? 0
    const coordinate = pointOf(feature.geometry)
    if (!coordinate || !inArenaRegion(coordinate)) return []
    if (!eligibleOperationalVoltage(maxVoltageKv, coordinate)) return []
    const name = propertyName(feature)
    if (!hasOperatorLabel(name)) return []
    return [{
      externalId: String(feature.properties.externalId),
      name,
      lon: Number(coordinate[0].toFixed(6)),
      lat: Number(coordinate[1].toFixed(6)),
      voltageKv: numberArray(feature.properties.voltageKv),
      maxVoltageKv,
      operator: stringOrNull(feature.properties.operator),
      sourceId: sourceIdOf(feature),
    }]
  })

  const branches = raw.features.flatMap((feature): ReadonlyArray<CandidateBranch> => {
    if (feature.properties.category !== 'line' && feature.properties.category !== 'cable') return []
    const nominalKv = numberOrNull(feature.properties.maxVoltageKv) ?? 0
    const coordinates = lineCoordinates(feature.geometry)
    if (coordinates.length < 2) return []
    const mid = coordinates[Math.floor(coordinates.length / 2)]!
    if (!inArenaRegion(mid)) return []
    if (!eligibleOperationalVoltage(nominalKv, mid)) return []
    const voltageKv = numberArray(feature.properties.voltageKv)
    const nearest = (coordinate: readonly [number, number]): { readonly substation: CandidateSubstation; readonly distanceKm: number } | null => {
      let best: { readonly substation: CandidateSubstation; readonly distanceKm: number } | null = null
      for (const substation of substations) {
        if (!voltageCompatible(voltageKv, substation)) continue
        const distanceKm = haversineKm(coordinate, [substation.lon, substation.lat])
        if (distanceKm > endpointSnapDistanceKm) continue
        if (!best || distanceKm < best.distanceKm) best = { substation, distanceKm }
      }
      return best
    }
    const from = nearest(coordinates[0]!)
    const to = nearest(coordinates[coordinates.length - 1]!)
    if (!from || !to || from.substation.externalId === to.substation.externalId) return []
    const lengthKm = lineLengthKm(coordinates)
    if (lengthKm < 2) return []
    return [{
      externalId: String(feature.properties.externalId),
      name: propertyName(feature),
      category: feature.properties.category as 'line' | 'cable',
      fromExternalId: from.substation.externalId,
      toExternalId: to.substation.externalId,
      nominalKv,
      lengthKm: Number(lengthKm.toFixed(2)),
      operator: stringOrNull(feature.properties.operator),
      path: simplifyPath(coordinates, 18),
      sourceId: sourceIdOf(feature),
    }]
  })

  const arenaSubstations = substations
    .sort((left, right) => left.name.localeCompare(right.name))
  const arenaSubstationIds = new Set(arenaSubstations.map(substation => substation.externalId))
  const arenaBranches = branches
    .filter(branch => branchEndpointIsKnown(branch, arenaSubstationIds))
    .sort((left, right) => right.nominalKv - left.nominalKv || right.lengthKm - left.lengthKm)

  const candidateGenerators = raw.features
    .flatMap((feature): ReadonlyArray<CandidateGenerator> => {
      if (feature.properties.category !== 'plant' && feature.properties.category !== 'generator') return []
      const capacityMw = numberOrNull(feature.properties.outputMw) ?? 0
      if (capacityMw < 14) return []
      const coordinate = pointOf(feature.geometry)
      if (!coordinate || !inArenaRegion(coordinate)) return []
      const name = propertyName(feature)
      if (!hasOperatorLabel(name)) return []
      const generationKind = generationKindFor(stringOrNull(feature.properties.plantSource))
      const augmentation = generationLookupKeys(name).flatMap(key => {
        const match = nveGeneration.get(key)
        return match ? [match] : []
      })[0]
      const nveCapacityMw = augmentation?.capacityMw ?? null
      return [{
        externalId: String(feature.properties.externalId),
        name,
        generationKind,
        lon: Number(coordinate[0].toFixed(6)),
        lat: Number(coordinate[1].toFixed(6)),
        capacityMw: nveCapacityMw !== null ? Number(nveCapacityMw.toFixed(2)) : capacityMw,
        annualProductionGwh: augmentation?.annualProductionGwh === undefined || augmentation.annualProductionGwh === null
          ? null
          : Number(augmentation.annualProductionGwh.toFixed(3)),
        operator: augmentation?.operator ?? stringOrNull(feature.properties.operator),
        priceArea: augmentation?.priceArea ?? null,
        sourceId: sourceIdOf(feature),
        augmentationSourceId: augmentation?.sourceId ?? null,
      }]
    })

  const arenaGenerators = [...dedupeGenerators(candidateGenerators)]
    .sort((left, right) => right.capacityMw - left.capacityMw)
    .slice(0, 70)

  const moduleText = `import type { SourceDerivedGridArenaData } from './types.ts'

export const norwayGridArenaData: SourceDerivedGridArenaData = ${JSON.stringify({
    sourceBuild: {
      id: 'source-derived-norway-grid-arena-v1',
      generatedAt: new Date().toISOString(),
      sourceIds: ['osm:pbf-power:NO', 'nve:vannkraftdatabase', 'nve:vindkraftdatabase'],
      notes: [
        'Operational arena generated from the grid-norway OSM PBF reference sidecar at national Norway scope.',
        'The operational graph is transmission-focused: dense OSM reference segments remain reference map geometry, while the runtime arena keeps national 300 kV+ backbone assets, northern 132 kV+ regional assets, eastern 220 kV+ regional assets, major generation, and aggregate consumer zones.',
        'NVE hydropower and wind APIs are used to augment generator capacity, annual production, operator, and price-area provenance where names match.',
        'Co-located OSM plant/generator duplicates are collapsed when a larger plant-level feature covers smaller same-family unit nodes.',
        'Consumer load zones are inferred operational demand aggregates attached to real high-voltage buses.',
      ],
    },
    substations: arenaSubstations,
    branches: arenaBranches,
    generators: arenaGenerators,
    loads: loadZones(arenaSubstations),
  }, null, 2)} as const
`
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, moduleText)
  console.log(`wrote ${outputPath}`)
  console.log(`${arenaSubstations.length} substations, ${arenaBranches.length} branches, ${arenaGenerators.length} generators`)
}

await main()
