import { access, mkdir, open, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { inflateSync } from 'node:zlib'
import { PbfReader } from 'pbf'
import {
  asSourceId,
  type DatasetSource,
  type FetchCache,
  type GeoJsonGeometry,
  type GeoJsonPosition,
  type NormalizedFeature,
} from '../../../reference-data/types.ts'
import { buildOsmPowerFeature, categoryForPower } from './osm-power-normalization.ts'

export interface OsmPbfPowerSourceConfig {
  readonly id?: string
  readonly path: string
  readonly downloadUrl?: string
  readonly userAgent?: string
  readonly fetchFn?: typeof fetch
}

type OsmElementType = 'node' | 'way' | 'relation'

interface BlobHeader {
  readonly type: string
  readonly datasize: number
}

interface BlobPayload {
  readonly raw: Uint8Array | null
  readonly zlibData: Uint8Array | null
}

interface PrimitiveBlock {
  readonly strings: ReadonlyArray<string>
  readonly groups: ReadonlyArray<PrimitiveGroup>
  readonly granularity: number
  readonly latOffset: number
  readonly lonOffset: number
}

interface PrimitiveGroup {
  readonly dense: DenseNodes | null
  readonly nodes: ReadonlyArray<PbfNode>
  readonly ways: ReadonlyArray<PbfWay>
  readonly relations: ReadonlyArray<PbfRelation>
}

interface DenseNodes {
  readonly ids: ReadonlyArray<number>
  readonly lats: ReadonlyArray<number>
  readonly lons: ReadonlyArray<number>
  readonly keysVals: ReadonlyArray<number>
}

interface PbfNode {
  readonly id: number
  readonly keys: ReadonlyArray<number>
  readonly vals: ReadonlyArray<number>
  readonly lat: number
  readonly lon: number
}

interface PbfWay {
  readonly id: number
  readonly keys: ReadonlyArray<number>
  readonly vals: ReadonlyArray<number>
  readonly refs: ReadonlyArray<number>
}

interface PbfRelation {
  readonly id: number
  readonly keys: ReadonlyArray<number>
  readonly vals: ReadonlyArray<number>
  readonly rolesSid: ReadonlyArray<number>
  readonly memids: ReadonlyArray<number>
  readonly types: ReadonlyArray<number>
}

interface PointRecord {
  readonly id: number
  readonly type: 'node'
  readonly tags: Readonly<Record<string, string>>
}

interface WayRecord {
  readonly id: number
  readonly type: 'way'
  readonly tags: Readonly<Record<string, string>>
  readonly refs: ReadonlyArray<number>
}

interface RelationMemberRef {
  readonly role: string
  readonly type: OsmElementType
  readonly ref: number
}

interface RelationRecord {
  readonly id: number
  readonly type: 'relation'
  readonly tags: Readonly<Record<string, string>>
  readonly members: ReadonlyArray<RelationMemberRef>
}

interface RawExtraction {
  readonly pointRecords: ReadonlyArray<PointRecord>
  readonly wayRecords: ReadonlyArray<WayRecord>
  readonly relationRecords: ReadonlyArray<RelationRecord>
  readonly nodeCoordinates: ReadonlyMap<number, GeoJsonPosition>
}

const DEFAULT_USER_AGENT = 'Leitbild/0.1 (https://leitbild.samsinn.app)'
const HEADER_LENGTH_BYTES = 4
const MAX_BLOB_HEADER_BYTES = 64 * 1024

const hasFile = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const ensureLocalPbf = async (config: OsmPbfPowerSourceConfig): Promise<void> => {
  if (await hasFile(config.path)) return
  if (!config.downloadUrl) {
    throw new Error(`osm-pbf-power: source file does not exist and no downloadUrl was configured: ${config.path}`)
  }
  await mkdir(dirname(config.path), { recursive: true })
  const fetchFn = config.fetchFn ?? fetch
  const response = await fetchFn(config.downloadUrl, {
    headers: { 'user-agent': config.userAgent ?? DEFAULT_USER_AGENT },
  })
  if (!response.ok || !response.body) {
    throw new Error(`osm-pbf-power: failed to download ${config.downloadUrl}: HTTP ${response.status}`)
  }
  const tmpPath = `${config.path}.download`
  const file = Bun.file(tmpPath)
  await Bun.write(file, response)
  await rename(tmpPath, config.path)
}

const readExactly = async (
  file: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): Promise<Uint8Array | null> => {
  const buffer = new Uint8Array(length)
  const { bytesRead } = await file.read(buffer, 0, length, offset)
  if (bytesRead === 0) return null
  if (bytesRead !== length) throw new Error(`osm-pbf-power: truncated PBF at byte ${offset}`)
  return buffer
}

const readUInt32BE = (bytes: Uint8Array): number =>
  ((bytes[0] ?? 0) << 24) + ((bytes[1] ?? 0) << 16) + ((bytes[2] ?? 0) << 8) + (bytes[3] ?? 0)

const readBlobHeader = (pbf: PbfReader): BlobHeader =>
  pbf.readFields((tag, header, field) => {
    if (tag === 1) header.type = field.readString()
    else if (tag === 3) header.datasize = field.readVarint()
    else field.skip(field.type)
  }, { type: '', datasize: 0 })

const readBlobPayload = (pbf: PbfReader): BlobPayload =>
  pbf.readFields((tag, payload, field) => {
    if (tag === 1) payload.raw = field.readBytes()
    else if (tag === 3) payload.zlibData = field.readBytes()
    else field.skip(field.type)
  }, { raw: null, zlibData: null } as { raw: Uint8Array | null; zlibData: Uint8Array | null })

const inflateBlob = (payload: BlobPayload): Uint8Array => {
  if (payload.raw) return payload.raw
  if (payload.zlibData) return inflateSync(payload.zlibData)
  throw new Error('osm-pbf-power: unsupported PBF blob compression')
}

const readStringTable = (pbf: PbfReader): string[] =>
  pbf.readMessage((tag, strings, field) => {
    if (tag === 1) strings.push(field.readString())
    else field.skip(field.type)
  }, [] as string[])

const readDenseNodes = (pbf: PbfReader): DenseNodes =>
  pbf.readMessage((tag, dense, field) => {
    if (tag === 1) dense.ids.push(...field.readPackedSVarint())
    else if (tag === 8) dense.lats.push(...field.readPackedSVarint())
    else if (tag === 9) dense.lons.push(...field.readPackedSVarint())
    else if (tag === 10) dense.keysVals.push(...field.readPackedVarint())
    else field.skip(field.type)
  }, { ids: [], lats: [], lons: [], keysVals: [] } as {
    ids: number[]
    lats: number[]
    lons: number[]
    keysVals: number[]
  })

const readNode = (pbf: PbfReader): PbfNode =>
  pbf.readMessage((tag, node, field) => {
    if (tag === 1) node.id = field.readVarint()
    else if (tag === 2) node.keys.push(...field.readPackedVarint())
    else if (tag === 3) node.vals.push(...field.readPackedVarint())
    else if (tag === 8) node.lat = field.readSVarint()
    else if (tag === 9) node.lon = field.readSVarint()
    else field.skip(field.type)
  }, { id: 0, keys: [], vals: [], lat: 0, lon: 0 } as {
    id: number
    keys: number[]
    vals: number[]
    lat: number
    lon: number
  })

const readWay = (pbf: PbfReader): PbfWay =>
  pbf.readMessage((tag, way, field) => {
    if (tag === 1) way.id = field.readVarint()
    else if (tag === 2) way.keys.push(...field.readPackedVarint())
    else if (tag === 3) way.vals.push(...field.readPackedVarint())
    else if (tag === 8) way.refs.push(...field.readPackedSVarint())
    else field.skip(field.type)
  }, { id: 0, keys: [], vals: [], refs: [] } as {
    id: number
    keys: number[]
    vals: number[]
    refs: number[]
  })

const readRelation = (pbf: PbfReader): PbfRelation =>
  pbf.readMessage((tag, relation, field) => {
    if (tag === 1) relation.id = field.readVarint()
    else if (tag === 2) relation.keys.push(...field.readPackedVarint())
    else if (tag === 3) relation.vals.push(...field.readPackedVarint())
    else if (tag === 8) relation.rolesSid.push(...field.readPackedVarint())
    else if (tag === 9) relation.memids.push(...field.readPackedSVarint())
    else if (tag === 10) relation.types.push(...field.readPackedVarint())
    else field.skip(field.type)
  }, { id: 0, keys: [], vals: [], rolesSid: [], memids: [], types: [] } as {
    id: number
    keys: number[]
    vals: number[]
    rolesSid: number[]
    memids: number[]
    types: number[]
  })

const readPrimitiveGroup = (pbf: PbfReader): PrimitiveGroup =>
  pbf.readMessage((tag, group, field) => {
    if (tag === 1) group.nodes.push(readNode(field))
    else if (tag === 2) group.dense = readDenseNodes(field)
    else if (tag === 3) group.ways.push(readWay(field))
    else if (tag === 4) group.relations.push(readRelation(field))
    else field.skip(field.type)
  }, { dense: null, nodes: [], ways: [], relations: [] } as {
    dense: DenseNodes | null
    nodes: PbfNode[]
    ways: PbfWay[]
    relations: PbfRelation[]
  })

const readPrimitiveBlock = (bytes: Uint8Array): PrimitiveBlock => {
  const pbf = new PbfReader(bytes)
  return pbf.readFields((tag, block, field) => {
    if (tag === 1) block.strings = readStringTable(field)
    else if (tag === 2) block.groups.push(readPrimitiveGroup(field))
    else if (tag === 17) block.granularity = field.readVarint()
    else if (tag === 19) block.latOffset = field.readSVarint()
    else if (tag === 20) block.lonOffset = field.readSVarint()
    else field.skip(field.type)
  }, {
    strings: [],
    groups: [],
    granularity: 100,
    latOffset: 0,
    lonOffset: 0,
  } as {
    strings: string[]
    groups: PrimitiveGroup[]
    granularity: number
    latOffset: number
    lonOffset: number
  })
}

const expandDeltas = (values: ReadonlyArray<number>): ReadonlyArray<number> => {
  const out: number[] = []
  let current = 0
  for (const value of values) {
    current += value
    out.push(current)
  }
  return out
}

const coordinateOf = (
  block: PrimitiveBlock,
  lonRaw: number,
  latRaw: number,
): GeoJsonPosition => [
  (block.lonOffset + block.granularity * lonRaw) / 1_000_000_000,
  (block.latOffset + block.granularity * latRaw) / 1_000_000_000,
]

const tagsOf = (
  strings: ReadonlyArray<string>,
  keys: ReadonlyArray<number>,
  vals: ReadonlyArray<number>,
): Record<string, string> => {
  const tags: Record<string, string> = {}
  for (let i = 0; i < keys.length; i += 1) {
    const key = strings[keys[i] ?? -1]
    const value = strings[vals[i] ?? -1]
    if (key && value !== undefined) tags[key] = value
  }
  return tags
}

const denseTagsByIndex = (
  strings: ReadonlyArray<string>,
  dense: DenseNodes,
): ReadonlyArray<Record<string, string>> => {
  const out: Record<string, string>[] = []
  let cursor = 0
  for (let index = 0; index < dense.ids.length; index += 1) {
    const tags: Record<string, string> = {}
    while (cursor < dense.keysVals.length) {
      const keyIndex = dense.keysVals[cursor++] ?? 0
      if (keyIndex === 0) break
      const valIndex = dense.keysVals[cursor++] ?? 0
      const key = strings[keyIndex]
      const value = strings[valIndex]
      if (key && value !== undefined) tags[key] = value
    }
    out.push(tags)
  }
  return out
}

const isSupportedPower = (tags: Readonly<Record<string, string>>): boolean =>
  categoryForPower(tags.power) !== 'unknown'

const visitPrimitiveBlocks = async (
  path: string,
  visitor: (block: PrimitiveBlock) => void,
): Promise<void> => {
  const size = (await stat(path)).size
  const file = await open(path, 'r')
  try {
    let offset = 0
    while (offset < size) {
      const headerLengthBytes = await readExactly(file, offset, HEADER_LENGTH_BYTES)
      if (!headerLengthBytes) break
      offset += HEADER_LENGTH_BYTES
      const headerLength = readUInt32BE(headerLengthBytes)
      if (headerLength <= 0 || headerLength > MAX_BLOB_HEADER_BYTES) {
        throw new Error(`osm-pbf-power: invalid blob header length ${headerLength} at byte ${offset}`)
      }
      const headerBytes = await readExactly(file, offset, headerLength)
      if (!headerBytes) break
      offset += headerLength
      const header = readBlobHeader(new PbfReader(headerBytes))
      const blobBytes = await readExactly(file, offset, header.datasize)
      if (!blobBytes) break
      offset += header.datasize
      if (header.type !== 'OSMData') continue
      const payload = readBlobPayload(new PbfReader(blobBytes))
      visitor(readPrimitiveBlock(inflateBlob(payload)))
    }
  } finally {
    await file.close()
  }
}

const firstPass = async (path: string): Promise<{
  readonly pointRecords: ReadonlyArray<PointRecord>
  readonly relationRecords: ReadonlyArray<RelationRecord>
  readonly relationMemberWayIds: ReadonlySet<number>
}> => {
  const pointRecords: PointRecord[] = []
  const relationRecords: RelationRecord[] = []
  const relationMemberWayIds = new Set<number>()
  await visitPrimitiveBlocks(path, block => {
    for (const group of block.groups) {
      if (group.dense) {
        const ids = expandDeltas(group.dense.ids)
        const tags = denseTagsByIndex(block.strings, group.dense)
        for (let i = 0; i < ids.length; i += 1) {
          const itemTags = tags[i] ?? {}
          if (isSupportedPower(itemTags)) pointRecords.push({ id: ids[i]!, type: 'node', tags: itemTags })
        }
      }
      for (const node of group.nodes) {
        const tags = tagsOf(block.strings, node.keys, node.vals)
        if (isSupportedPower(tags)) pointRecords.push({ id: node.id, type: 'node', tags })
      }
      for (const relation of group.relations) {
        const tags = tagsOf(block.strings, relation.keys, relation.vals)
        if (!isSupportedPower(tags)) continue
        const refs = expandDeltas(relation.memids)
        const members = refs.map((ref, index): RelationMemberRef => {
          const rawType = relation.types[index] ?? 2
          const type: OsmElementType = rawType === 0 ? 'node' : rawType === 1 ? 'way' : 'relation'
          const role = block.strings[relation.rolesSid[index] ?? -1] ?? ''
          if (type === 'way') relationMemberWayIds.add(ref)
          return { role, type, ref }
        })
        relationRecords.push({ id: relation.id, type: 'relation', tags, members })
      }
    }
  })
  return { pointRecords, relationRecords, relationMemberWayIds }
}

const secondPass = async (
  path: string,
  relationMemberWayIds: ReadonlySet<number>,
): Promise<{
  readonly wayRecords: ReadonlyArray<WayRecord>
  readonly neededNodeIds: ReadonlySet<number>
}> => {
  const wayRecords: WayRecord[] = []
  const neededNodeIds = new Set<number>()
  await visitPrimitiveBlocks(path, block => {
    for (const group of block.groups) {
      for (const way of group.ways) {
        const tags = tagsOf(block.strings, way.keys, way.vals)
        const include = isSupportedPower(tags) || relationMemberWayIds.has(way.id)
        if (!include) continue
        const refs = expandDeltas(way.refs)
        wayRecords.push({ id: way.id, type: 'way', tags, refs })
        for (const ref of refs) neededNodeIds.add(ref)
      }
    }
  })
  return { wayRecords, neededNodeIds }
}

const thirdPass = async (
  path: string,
  neededNodeIds: ReadonlySet<number>,
): Promise<ReadonlyMap<number, GeoJsonPosition>> => {
  const nodeCoordinates = new Map<number, GeoJsonPosition>()
  await visitPrimitiveBlocks(path, block => {
    for (const group of block.groups) {
      if (group.dense) {
        const ids = expandDeltas(group.dense.ids)
        const lats = expandDeltas(group.dense.lats)
        const lons = expandDeltas(group.dense.lons)
        for (let i = 0; i < ids.length; i += 1) {
          const id = ids[i]!
          if (neededNodeIds.has(id)) nodeCoordinates.set(id, coordinateOf(block, lons[i] ?? 0, lats[i] ?? 0))
        }
      }
      for (const node of group.nodes) {
        if (neededNodeIds.has(node.id)) nodeCoordinates.set(node.id, coordinateOf(block, node.lon, node.lat))
      }
    }
  })
  return nodeCoordinates
}

const extractRawPower = async (path: string): Promise<RawExtraction> => {
  const pass1 = await firstPass(path)
  const pass2 = await secondPass(path, pass1.relationMemberWayIds)
  const neededNodeIds = new Set<number>(pass2.neededNodeIds)
  for (const record of pass1.pointRecords) neededNodeIds.add(record.id)
  const nodeCoordinates = await thirdPass(path, neededNodeIds)
  return {
    pointRecords: pass1.pointRecords,
    relationRecords: pass1.relationRecords,
    wayRecords: pass2.wayRecords,
    nodeCoordinates,
  }
}

const lineGeometryForWay = (
  way: WayRecord,
  nodeCoordinates: ReadonlyMap<number, GeoJsonPosition>,
): ReadonlyArray<GeoJsonPosition> =>
  way.refs.flatMap(ref => {
    const coordinate = nodeCoordinates.get(ref)
    return coordinate ? [coordinate] : []
  })

const isClosed = (coordinates: ReadonlyArray<GeoJsonPosition>): boolean => {
  const first = coordinates[0]
  const last = coordinates[coordinates.length - 1]
  return first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]
}

const geometryForWay = (
  way: WayRecord,
  nodeCoordinates: ReadonlyMap<number, GeoJsonPosition>,
): GeoJsonGeometry | null => {
  const coordinates = lineGeometryForWay(way, nodeCoordinates)
  if (coordinates.length < 2) return null
  const category = categoryForPower(way.tags.power)
  if (isClosed(coordinates) && (category === 'substation' || category === 'plant')) {
    return { type: 'Polygon', coordinates: [coordinates] }
  }
  return { type: 'LineString', coordinates }
}

const joinWayRings = (
  ways: ReadonlyArray<WayRecord>,
  nodeCoordinates: ReadonlyMap<number, GeoJsonPosition>,
): ReadonlyArray<ReadonlyArray<GeoJsonPosition>> => {
  const segments = ways
    .map(way => lineGeometryForWay(way, nodeCoordinates))
    .filter(coords => coords.length >= 2)
  const rings: GeoJsonPosition[][] = []
  const open = segments.map(segment => [...segment])
  while (open.length > 0) {
    const ring = open.shift()!
    let changed = true
    while (changed && !isClosed(ring)) {
      changed = false
      const end = ring[ring.length - 1]!
      for (let i = 0; i < open.length; i += 1) {
        const candidate = open[i]!
        const first = candidate[0]!
        const last = candidate[candidate.length - 1]!
        if (end[0] === first[0] && end[1] === first[1]) {
          ring.push(...candidate.slice(1))
          open.splice(i, 1)
          changed = true
          break
        }
        if (end[0] === last[0] && end[1] === last[1]) {
          ring.push(...candidate.slice(0, -1).reverse())
          open.splice(i, 1)
          changed = true
          break
        }
      }
    }
    if (isClosed(ring) && ring.length >= 4) rings.push(ring)
  }
  return rings
}

const geometryForRelation = (
  relation: RelationRecord,
  wayById: ReadonlyMap<number, WayRecord>,
  nodeCoordinates: ReadonlyMap<number, GeoJsonPosition>,
): GeoJsonGeometry | null => {
  const outerWays = relation.members.flatMap(member => {
    if (member.type !== 'way') return []
    if (member.role && member.role !== 'outer') return []
    const way = wayById.get(member.ref)
    return way ? [way] : []
  })
  const rings = joinWayRings(outerWays, nodeCoordinates)
  if (rings.length === 0) return null
  return { type: 'MultiPolygon', coordinates: rings.map(ring => [ring]) }
}

const coordinateKey = (coordinate: GeoJsonPosition): string =>
  `${coordinate[0].toFixed(7)},${coordinate[1].toFixed(7)}`

const mergeKeyForFeature = (feature: NormalizedFeature): string | null => {
  if (feature.geometry.type !== 'LineString') return null
  const category = feature.properties.category
  if (category !== 'line' && category !== 'cable') return null
  const voltage = feature.properties.maxVoltageKv ?? 'unknown'
  const operator = feature.properties.operator ?? ''
  const name = feature.properties.name ?? ''
  const power = feature.properties.power ?? ''
  return [category, voltage, operator, name, power].join('|')
}

const reverseCoordinates = (
  coordinates: ReadonlyArray<GeoJsonPosition>,
): ReadonlyArray<GeoJsonPosition> => [...coordinates].reverse()

const mergeLineGroup = (
  features: ReadonlyArray<NormalizedFeature>,
  key: string,
): ReadonlyArray<NormalizedFeature> => {
  const endpointIndex = new Map<string, Set<number>>()
  const coordinatesByIndex = features.map(feature =>
    feature.geometry.type === 'LineString' ? feature.geometry.coordinates : [])
  for (let i = 0; i < coordinatesByIndex.length; i += 1) {
    const coordinates = coordinatesByIndex[i]!
    const first = coordinates[0]
    const last = coordinates[coordinates.length - 1]
    if (!first || !last) continue
    for (const endpoint of [first, last]) {
      const pointKey = coordinateKey(endpoint)
      const existing = endpointIndex.get(pointKey) ?? new Set<number>()
      existing.add(i)
      endpointIndex.set(pointKey, existing)
    }
  }

  const visited = new Set<number>()
  const merged: NormalizedFeature[] = []
  const nextAtEndpoint = (endpoint: GeoJsonPosition): number | null => {
    const candidates = endpointIndex.get(coordinateKey(endpoint))
    if (!candidates || candidates.size !== 2) return null
    for (const candidate of candidates) {
      if (!visited.has(candidate)) return candidate
    }
    return null
  }

  for (let i = 0; i < features.length; i += 1) {
    if (visited.has(i)) continue
    visited.add(i)
    const sourceFeature = features[i]!
    const sourceCoordinates = coordinatesByIndex[i]!
    let line = [...sourceCoordinates]
    const sourceIds = [String(sourceFeature.properties.externalId)]

    let extended = true
    while (extended) {
      extended = false
      const end = line[line.length - 1]
      if (end) {
        const candidate = nextAtEndpoint(end)
        if (candidate !== null) {
          visited.add(candidate)
          const candidateCoordinates = coordinatesByIndex[candidate]!
          const oriented = coordinateKey(candidateCoordinates[0]!) === coordinateKey(end)
            ? candidateCoordinates
            : reverseCoordinates(candidateCoordinates)
          line.push(...oriented.slice(1))
          sourceIds.push(String(features[candidate]!.properties.externalId))
          extended = true
        }
      }
      const start = line[0]
      if (start) {
        const candidate = nextAtEndpoint(start)
        if (candidate !== null) {
          visited.add(candidate)
          const candidateCoordinates = coordinatesByIndex[candidate]!
          const oriented = coordinateKey(candidateCoordinates[candidateCoordinates.length - 1]!) === coordinateKey(start)
            ? candidateCoordinates
            : reverseCoordinates(candidateCoordinates)
          line = [...oriented.slice(0, -1), ...line]
          sourceIds.push(String(features[candidate]!.properties.externalId))
          extended = true
        }
      }
    }

    merged.push({
      ...sourceFeature,
      id: `${sourceFeature.properties.source}:merged:${key}:${merged.length}`,
      geometry: { type: 'LineString', coordinates: line },
      properties: {
        ...sourceFeature.properties,
        externalId: `merged/${sourceFeature.properties.category}/${key}/${merged.length}`,
        tags: {
          ...(sourceFeature.properties.tags as Readonly<Record<string, string>>),
          'leitbild:merged_source_ids': sourceIds.join(';'),
          'leitbild:merged_source_count': String(sourceIds.length),
        },
      },
    })
  }
  return merged
}

const mergeCompatibleLineFeatures = (
  features: ReadonlyArray<NormalizedFeature>,
): ReadonlyArray<NormalizedFeature> => {
  const groups = new Map<string, NormalizedFeature[]>()
  const passthrough: NormalizedFeature[] = []
  for (const feature of features) {
    const key = mergeKeyForFeature(feature)
    if (!key) {
      passthrough.push(feature)
      continue
    }
    const group = groups.get(key) ?? []
    group.push(feature)
    groups.set(key, group)
  }
  const merged: NormalizedFeature[] = [...passthrough]
  for (const [key, group] of groups.entries()) {
    merged.push(...mergeLineGroup(group, key))
  }
  return merged
}

export const normaliseOsmPbfPowerFile = async (
  path: string,
  source = 'osm:pbf-power:NO',
): Promise<ReadonlyArray<NormalizedFeature>> => {
  const raw = await extractRawPower(path)
  const wayById = new Map(raw.wayRecords.map(way => [way.id, way]))
  const features: NormalizedFeature[] = []
  for (const point of raw.pointRecords) {
    const coordinate = raw.nodeCoordinates.get(point.id)
    if (!coordinate) continue
    const feature = buildOsmPowerFeature({
      source,
      elementType: 'node',
      id: point.id,
      tags: point.tags,
      geometry: { type: 'Point', coordinates: coordinate },
      geometrySource: 'osm-node',
    })
    if (feature) features.push(feature)
  }
  for (const way of raw.wayRecords) {
    if (!isSupportedPower(way.tags)) continue
    const geometry = geometryForWay(way, raw.nodeCoordinates)
    if (!geometry) continue
    const feature = buildOsmPowerFeature({
      source,
      elementType: 'way',
      id: way.id,
      tags: way.tags,
      geometry,
      geometrySource: 'osm-geometry',
    })
    if (feature) features.push(feature)
  }
  for (const relation of raw.relationRecords) {
    const geometry = geometryForRelation(relation, wayById, raw.nodeCoordinates)
    if (!geometry) continue
    const feature = buildOsmPowerFeature({
      source,
      elementType: 'relation',
      id: relation.id,
      tags: relation.tags,
      geometry,
      geometrySource: 'osm-geometry',
    })
    if (feature) features.push(feature)
  }
  return mergeCompatibleLineFeatures(features)
}

export const osmPbfPowerSource = (config: OsmPbfPowerSourceConfig): DatasetSource => {
  const id = config.id ?? 'osm:pbf-power:NO'
  return {
    kind: 'local',
    id: asSourceId(id),
    load: async (_cache: FetchCache): Promise<ReadonlyArray<NormalizedFeature>> => {
      await ensureLocalPbf(config)
      return normaliseOsmPbfPowerFile(config.path, id)
    },
  }
}
