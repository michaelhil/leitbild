import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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
  coordinate[0] >= 7.5 && coordinate[0] <= 12.1 && coordinate[1] >= 58.7 && coordinate[1] <= 60.7

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

const largestConnectedComponent = (
  nodes: ReadonlyArray<CandidateSubstation>,
  branches: ReadonlyArray<CandidateBranch>,
): ReadonlySet<string> => {
  const adjacency = new Map(nodes.map(node => [node.externalId, new Set<string>()]))
  for (const branch of branches) {
    adjacency.get(branch.fromExternalId)?.add(branch.toExternalId)
    adjacency.get(branch.toExternalId)?.add(branch.fromExternalId)
  }
  const seen = new Set<string>()
  let largest = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.externalId)) continue
    const queue = [node.externalId]
    const component = new Set<string>([node.externalId])
    seen.add(node.externalId)
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        component.add(next)
        queue.push(next)
      }
    }
    if (component.size > largest.size) largest = component
  }
  return largest
}

const loadZones = (substations: ReadonlyArray<CandidateSubstation>) => {
  const byName = new Map(substations.map(substation => [substation.name, substation.externalId]))
  const at = (name: string): string => {
    const externalId = byName.get(name)
    if (!externalId) throw new Error(`arena load references missing substation: ${name}`)
    return externalId
  }
  return [
    { id: 'oslo-west-urban', label: 'Oslo west urban load', loadKind: 'residential', busExternalId: at('Smestad trafostasjon'), lon: 10.68, lat: 59.94, demandMw: 280, criticalMw: 105, reactiveDemandMvar: 60, priority: 'normal' },
    { id: 'oslo-north-urban', label: 'Oslo north urban load', loadKind: 'residential', busExternalId: at('Sogn trafostasjon'), lon: 10.75, lat: 59.96, demandMw: 320, criticalMw: 120, reactiveDemandMvar: 70, priority: 'normal' },
    { id: 'oslo-east-urban', label: 'Oslo east urban load', loadKind: 'residential', busExternalId: at('Ulven trafostasjon'), lon: 10.84, lat: 59.93, demandMw: 320, criticalMw: 115, reactiveDemandMvar: 70, priority: 'normal' },
    { id: 'oslo-hospital', label: 'Oslo hospital critical load', loadKind: 'hospital', busExternalId: at('Ullevål trafostasjon'), lon: 10.7387, lat: 59.9369, demandMw: 85, criticalMw: 70, reactiveDemandMvar: 22, priority: 'critical' },
    { id: 'gardermoen-airport', label: 'Oslo airport load', loadKind: 'airport', busExternalId: at('Minne transformatorstasjon'), lon: 11.1004, lat: 60.1939, demandMw: 120, criticalMw: 55, reactiveDemandMvar: 34, priority: 'high' },
    { id: 'grenland-industry', label: 'Grenland process industry', loadKind: 'industry', busExternalId: at('Rød transformatorstasjon'), lon: 9.66, lat: 59.12, demandMw: 650, criticalMw: 330, reactiveDemandMvar: 220, priority: 'high' },
    { id: 'ostfold-industry', label: 'Østfold process industry', loadKind: 'industry', busExternalId: at('Vammafossen trafostasjon'), lon: 11.12, lat: 59.28, demandMw: 390, criticalMw: 210, reactiveDemandMvar: 120, priority: 'high' },
    { id: 'drammen-urban', label: 'Drammen urban load', loadKind: 'residential', busExternalId: at('Hamang transformatorstasjon'), lon: 10.2, lat: 59.74, demandMw: 300, criticalMw: 110, reactiveDemandMvar: 65, priority: 'normal' },
    { id: 'vestfold-consumer', label: 'Vestfold consumer supply', loadKind: 'commercial', busExternalId: at('Tveiten trafostasjon'), lon: 10.25, lat: 59.18, demandMw: 260, criticalMw: 95, reactiveDemandMvar: 60, priority: 'normal' },
    { id: 'telemark-industry', label: 'Telemark industrial load', loadKind: 'industry', busExternalId: at('Flesaker koblingsstasjon'), lon: 9.65, lat: 59.65, demandMw: 330, criticalMw: 160, reactiveDemandMvar: 105, priority: 'high' },
    { id: 'ringerike-consumer', label: 'Ringerike consumer supply', loadKind: 'commercial', busExternalId: at('Ringerike trafostasjon'), lon: 10.25, lat: 60.15, demandMw: 190, criticalMw: 70, reactiveDemandMvar: 44, priority: 'normal' },
    { id: 'oslo-ev', label: 'Oslo EV fast-charging cluster', loadKind: 'ev_charging', busExternalId: at('Ulven trafostasjon'), lon: 10.85, lat: 59.94, demandMw: 145, criticalMw: 20, reactiveDemandMvar: 28, priority: 'low', controllable: true },
    { id: 'e18-truck-depot', label: 'E18 truck charging depot', loadKind: 'ev_charging', busExternalId: at('Bærum trafostasjon'), lon: 10.49, lat: 59.9, demandMw: 95, criticalMw: 10, reactiveDemandMvar: 16, priority: 'low', controllable: true },
    { id: 'oslo-data-center', label: 'Oslo data-center load', loadKind: 'data_center', busExternalId: at('Røykås trafostasjon'), lon: 10.98, lat: 59.96, demandMw: 230, criticalMw: 165, reactiveDemandMvar: 56, priority: 'high' },
  ]
}

const main = async (): Promise<void> => {
  const raw = JSON.parse(await readFile(inputPath, 'utf8')) as GeoJsonCollection
  const nveGeneration = await fetchNveGenerationIndex()
  const substations = raw.features.flatMap((feature): ReadonlyArray<CandidateSubstation> => {
    if (feature.properties.category !== 'substation') return []
    const maxVoltageKv = numberOrNull(feature.properties.maxVoltageKv) ?? 0
    if (maxVoltageKv < 132) return []
    const coordinate = pointOf(feature.geometry)
    if (!coordinate || !inArenaRegion(coordinate)) return []
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
    if (nominalKv < 132) return []
    const coordinates = lineCoordinates(feature.geometry)
    if (coordinates.length < 2) return []
    const mid = coordinates[Math.floor(coordinates.length / 2)]!
    if (!inArenaRegion(mid)) return []
    const voltageKv = numberArray(feature.properties.voltageKv)
    const nearest = (coordinate: readonly [number, number]): { readonly substation: CandidateSubstation; readonly distanceKm: number } | null => {
      let best: { readonly substation: CandidateSubstation; readonly distanceKm: number } | null = null
      for (const substation of substations) {
        if (!voltageCompatible(voltageKv, substation)) continue
        const distanceKm = haversineKm(coordinate, [substation.lon, substation.lat])
        if (distanceKm > 8) continue
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

  const largest = largestConnectedComponent(substations, branches)
  const arenaSubstations = substations
    .filter(substation => largest.has(substation.externalId))
    .sort((left, right) => left.name.localeCompare(right.name))
  const arenaSubstationIds = new Set(arenaSubstations.map(substation => substation.externalId))
  const arenaBranches = branches
    .filter(branch => arenaSubstationIds.has(branch.fromExternalId) && arenaSubstationIds.has(branch.toExternalId))
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
    .slice(0, 34)

  const moduleText = `import type { SourceDerivedGridArenaData } from './types.ts'

export const norwayGridArenaData: SourceDerivedGridArenaData = ${JSON.stringify({
    sourceBuild: {
      id: 'source-derived-oslofjord-grid-arena-v1',
      generatedAt: new Date().toISOString(),
      sourceIds: ['osm:pbf-power:NO', 'nve:vannkraftdatabase', 'nve:vindkraftdatabase'],
      notes: [
        'Operational arena generated from the grid-norway OSM PBF reference sidecar.',
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
