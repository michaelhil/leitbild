import { Compression, TileType, zxyToTileId } from 'pmtiles'

export interface PmtilesWriterBounds {
  readonly minLon: number
  readonly minLat: number
  readonly maxLon: number
  readonly maxLat: number
}

export interface PmtilesWriterCenter {
  readonly lon: number
  readonly lat: number
  readonly zoom: number
}

export interface PmtilesWriterTile {
  readonly z: number
  readonly x: number
  readonly y: number
  readonly data: Uint8Array
}

export interface PmtilesWriterConfig {
  readonly tiles: ReadonlyArray<PmtilesWriterTile>
  readonly tileType: TileType
  readonly bounds: PmtilesWriterBounds
  readonly center: PmtilesWriterCenter
  readonly metadata?: Record<string, unknown>
}

interface DirectoryEntry {
  readonly tileId: number
  readonly offset: number
  readonly length: number
  readonly runLength: number
}

const headerSizeBytes = 127
const coordinateScale = 10_000_000

const assertSafeUint = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe unsigned integer`)
}

const assertByte = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`${label} must fit in one byte`)
}

const setUint64 = (
  view: DataView,
  offset: number,
  value: number,
): void => {
  assertSafeUint(value, `uint64 at ${offset}`)
  view.setUint32(offset, value % 2 ** 32, true)
  view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true)
}

const scaledCoordinate = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  const scaled = Math.round(value * coordinateScale)
  if (scaled < -2147483648 || scaled > 2147483647) throw new Error(`${label} is outside PMTiles coordinate range`)
  return scaled
}

const writeVarint = (
  target: number[],
  value: number,
): void => {
  assertSafeUint(value, 'varint')
  let remaining = value
  while (remaining >= 0x80) {
    target.push((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  target.push(remaining)
}

const serializeDirectory = (
  entries: ReadonlyArray<DirectoryEntry>,
): Uint8Array => {
  if (entries.length === 0) throw new Error('PMTiles directory cannot be empty')
  const bytes: number[] = []
  writeVarint(bytes, entries.length)

  let lastTileId = 0
  for (const entry of entries) {
    if (entry.tileId < lastTileId) throw new Error('PMTiles directory entries must be sorted by tile id')
    writeVarint(bytes, entry.tileId - lastTileId)
    lastTileId = entry.tileId
  }
  for (const entry of entries) writeVarint(bytes, entry.runLength)
  for (const entry of entries) writeVarint(bytes, entry.length)
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) throw new Error(`missing PMTiles directory entry at index ${index}`)
    const previous = entries[index - 1]
    if (previous && entry.offset === previous.offset + previous.length) {
      writeVarint(bytes, 0)
    } else {
      writeVarint(bytes, entry.offset + 1)
    }
  }

  return Uint8Array.from(bytes)
}

const sortedUniqueTiles = (
  tiles: ReadonlyArray<PmtilesWriterTile>,
): ReadonlyArray<PmtilesWriterTile & { readonly tileId: number }> => {
  if (tiles.length === 0) throw new Error('cannot write a PMTiles archive without tiles')
  const seen = new Set<number>()
  return tiles
    .map(tile => {
      const tileId = zxyToTileId(tile.z, tile.x, tile.y)
      if (seen.has(tileId)) throw new Error(`duplicate tile in PMTiles archive: ${tile.z}/${tile.x}/${tile.y}`)
      if (tile.data.byteLength <= 0) throw new Error(`empty tile in PMTiles archive: ${tile.z}/${tile.x}/${tile.y}`)
      seen.add(tileId)
      return { ...tile, tileId }
    })
    .sort((left, right) => left.tileId - right.tileId)
}

export const writePmtilesArchive = (
  config: PmtilesWriterConfig,
): Uint8Array => {
  const tiles = sortedUniqueTiles(config.tiles)
  const minZoom = Math.min(...tiles.map(tile => tile.z))
  const maxZoom = Math.max(...tiles.map(tile => tile.z))
  assertByte(minZoom, 'min zoom')
  assertByte(maxZoom, 'max zoom')
  assertByte(config.center.zoom, 'center zoom')

  const entries: DirectoryEntry[] = []
  const tileDataParts: Uint8Array[] = []
  let tileDataLength = 0
  for (const tile of tiles) {
    entries.push({
      tileId: tile.tileId,
      offset: tileDataLength,
      length: tile.data.byteLength,
      runLength: 1,
    })
    tileDataParts.push(tile.data)
    tileDataLength += tile.data.byteLength
  }

  const rootDirectory = serializeDirectory(entries)
  const metadata = new TextEncoder().encode(JSON.stringify(config.metadata ?? {}))
  const rootDirectoryOffset = headerSizeBytes
  const jsonMetadataOffset = rootDirectoryOffset + rootDirectory.byteLength
  const tileDataOffset = jsonMetadataOffset + metadata.byteLength
  const archiveLength = tileDataOffset + tileDataLength

  const output = new Uint8Array(archiveLength)
  output.set(new TextEncoder().encode('PMTiles'), 0)
  const view = new DataView(output.buffer)
  view.setUint8(7, 3)
  setUint64(view, 8, rootDirectoryOffset)
  setUint64(view, 16, rootDirectory.byteLength)
  setUint64(view, 24, jsonMetadataOffset)
  setUint64(view, 32, metadata.byteLength)
  setUint64(view, 40, 0)
  setUint64(view, 48, 0)
  setUint64(view, 56, tileDataOffset)
  setUint64(view, 64, tileDataLength)
  setUint64(view, 72, entries.length)
  setUint64(view, 80, entries.length)
  setUint64(view, 88, entries.length)
  view.setUint8(96, 1)
  view.setUint8(97, Compression.None)
  view.setUint8(98, Compression.None)
  view.setUint8(99, config.tileType)
  view.setUint8(100, minZoom)
  view.setUint8(101, maxZoom)
  view.setInt32(102, scaledCoordinate(config.bounds.minLon, 'minLon'), true)
  view.setInt32(106, scaledCoordinate(config.bounds.minLat, 'minLat'), true)
  view.setInt32(110, scaledCoordinate(config.bounds.maxLon, 'maxLon'), true)
  view.setInt32(114, scaledCoordinate(config.bounds.maxLat, 'maxLat'), true)
  view.setUint8(118, config.center.zoom)
  view.setInt32(119, scaledCoordinate(config.center.lon, 'centerLon'), true)
  view.setInt32(123, scaledCoordinate(config.center.lat, 'centerLat'), true)

  output.set(rootDirectory, rootDirectoryOffset)
  output.set(metadata, jsonMetadataOffset)
  let writeOffset = tileDataOffset
  for (const part of tileDataParts) {
    output.set(part, writeOffset)
    writeOffset += part.byteLength
  }
  return output
}
