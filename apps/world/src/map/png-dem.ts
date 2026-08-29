import { inflateSync } from 'node:zlib'
import { decodeDemElevationM, type TerrainDemEncoding } from './dem-encoding.ts'

export interface DecodedPngRgbImage {
  readonly width: number
  readonly height: number
  readonly channels: 3 | 4
  readonly data: Uint8Array
}

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10] as const

const readUint32 = (
  bytes: Uint8Array,
  offset: number,
): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
  return view.getUint32(0, false)
}

const chunkType = (
  bytes: Uint8Array,
  offset: number,
): string =>
  String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  )

const paeth = (
  left: number,
  up: number,
  upLeft: number,
): number => {
  const p = left + up - upLeft
  const pa = Math.abs(p - left)
  const pb = Math.abs(p - up)
  const pc = Math.abs(p - upLeft)
  if (pa <= pb && pa <= pc) return left
  return pb <= pc ? up : upLeft
}

const reconstructScanlines = (config: {
  readonly inflated: Uint8Array
  readonly width: number
  readonly height: number
  readonly channels: 3 | 4
}): Uint8Array => {
  const stride = config.width * config.channels
  const expectedLength = config.height * (stride + 1)
  if (config.inflated.length < expectedLength) {
    throw new Error(`PNG DEM payload is truncated: expected at least ${expectedLength} bytes, found ${config.inflated.length}`)
  }

  const output = new Uint8Array(config.height * stride)
  for (let row = 0; row < config.height; row += 1) {
    const filter = config.inflated[row * (stride + 1)]
    if (filter === undefined || filter > 4) throw new Error(`unsupported PNG DEM filter type ${filter ?? 'missing'}`)
    const rowInputOffset = row * (stride + 1) + 1
    const rowOutputOffset = row * stride
    const previousOutputOffset = rowOutputOffset - stride
    for (let columnByte = 0; columnByte < stride; columnByte += 1) {
      const raw = config.inflated[rowInputOffset + columnByte] ?? 0
      const left = columnByte >= config.channels ? output[rowOutputOffset + columnByte - config.channels] ?? 0 : 0
      const up = row > 0 ? output[previousOutputOffset + columnByte] ?? 0 : 0
      const upLeft = row > 0 && columnByte >= config.channels
        ? output[previousOutputOffset + columnByte - config.channels] ?? 0
        : 0
      const predicted = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : paeth(left, up, upLeft)
      output[rowOutputOffset + columnByte] = (raw + predicted) & 0xff
    }
  }
  return output
}

export const decodePngRgbImage = (
  bytes: Uint8Array,
): DecodedPngRgbImage => {
  if (bytes.length < pngSignature.length || pngSignature.some((value, index) => bytes[index] !== value)) {
    throw new Error('PNG DEM tile does not have a valid PNG signature')
  }

  let offset: number = pngSignature.length
  let width = 0
  let height = 0
  let channels: 3 | 4 | null = null
  const idatParts: Uint8Array[] = []

  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const nextOffset = dataOffset + length + 4
    if (nextOffset > bytes.length) throw new Error('PNG DEM tile contains a truncated chunk')
    const type = chunkType(bytes, typeOffset)
    const data = bytes.slice(dataOffset, dataOffset + length)

    if (type === 'IHDR') {
      width = readUint32(data, 0)
      height = readUint32(data, 4)
      const bitDepth = data[8]
      const colorType = data[9]
      const compression = data[10]
      const filter = data[11]
      const interlace = data[12]
      if (bitDepth !== 8) throw new Error(`PNG DEM tile must use 8-bit channels; found ${bitDepth}`)
      if (colorType !== 2 && colorType !== 6) throw new Error(`PNG DEM tile must be RGB or RGBA; found color type ${colorType}`)
      if (compression !== 0 || filter !== 0) throw new Error('PNG DEM tile uses unsupported compression/filter method')
      if (interlace !== 0) throw new Error('PNG DEM tile uses unsupported interlacing')
      channels = colorType === 2 ? 3 : 4
    } else if (type === 'IDAT') {
      idatParts.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset = nextOffset
  }

  if (width <= 0 || height <= 0 || channels === null) throw new Error('PNG DEM tile is missing a valid IHDR chunk')
  if (idatParts.length === 0) throw new Error('PNG DEM tile is missing image data')

  const compressed = new Uint8Array(idatParts.reduce((sum, part) => sum + part.length, 0))
  let compressedOffset = 0
  for (const part of idatParts) {
    compressed.set(part, compressedOffset)
    compressedOffset += part.length
  }
  const inflated = inflateSync(compressed)
  return {
    width,
    height,
    channels,
    data: reconstructScanlines({
      inflated,
      width,
      height,
      channels,
    }),
  }
}

const pixelElevationM = (
  image: DecodedPngRgbImage,
  x: number,
  y: number,
  encoding: TerrainDemEncoding,
): number => {
  const clampedX = Math.max(0, Math.min(image.width - 1, x))
  const clampedY = Math.max(0, Math.min(image.height - 1, y))
  const index = (clampedY * image.width + clampedX) * image.channels
  const red = image.data[index] ?? 0
  const green = image.data[index + 1] ?? 0
  const blue = image.data[index + 2] ?? 0
  return decodeDemElevationM(red, green, blue, encoding)
}

export const samplePngDemElevationM = (config: {
  readonly image: DecodedPngRgbImage
  readonly x: number
  readonly y: number
  readonly encoding: TerrainDemEncoding
}): number => {
  const x0 = Math.max(0, Math.min(config.image.width - 1, Math.floor(config.x)))
  const y0 = Math.max(0, Math.min(config.image.height - 1, Math.floor(config.y)))
  const x1 = Math.min(config.image.width - 1, x0 + 1)
  const y1 = Math.min(config.image.height - 1, y0 + 1)
  const tx = Math.max(0, Math.min(1, config.x - x0))
  const ty = Math.max(0, Math.min(1, config.y - y0))
  const h00 = pixelElevationM(config.image, x0, y0, config.encoding)
  const h10 = pixelElevationM(config.image, x1, y0, config.encoding)
  const h01 = pixelElevationM(config.image, x0, y1, config.encoding)
  const h11 = pixelElevationM(config.image, x1, y1, config.encoding)
  const top = h00 + (h10 - h00) * tx
  const bottom = h01 + (h11 - h01) * tx
  return top + (bottom - top) * ty
}
