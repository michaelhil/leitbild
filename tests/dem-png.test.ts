import { describe, expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { decodePngRgbImage, samplePngDemElevationM } from '../src/map/png-dem.ts'

const uint32Bytes = (
  value: number,
): Uint8Array => {
  const bytes = new Uint8Array(4)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, value, false)
  return bytes
}

const asciiBytes = (
  value: string,
): Uint8Array => new TextEncoder().encode(value)

const concatBytes = (
  parts: ReadonlyArray<Uint8Array>,
): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

const pngChunk = (
  type: string,
  data: Uint8Array,
): Uint8Array => concatBytes([
  uint32Bytes(data.length),
  asciiBytes(type),
  data,
  new Uint8Array(4),
])

const rgbTerrariumPng = (): Uint8Array => {
  const ihdr = new Uint8Array([
    ...uint32Bytes(2),
    ...uint32Bytes(2),
    8,
    2,
    0,
    0,
    0,
  ])
  const scanlines = new Uint8Array([
    0, 128, 0, 0, 128, 10, 0,
    0, 128, 20, 0, 128, 30, 0,
  ])
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', new Uint8Array()),
  ])
}

describe('PNG DEM decoding', () => {
  test('decodes RGB Terrarium PNG tiles and bilinearly samples elevation', () => {
    const image = decodePngRgbImage(rgbTerrariumPng())

    expect(image.width).toBe(2)
    expect(image.height).toBe(2)
    expect(image.channels).toBe(3)
    expect(samplePngDemElevationM({ image, x: 0, y: 0, encoding: 'terrarium' })).toBe(0)
    expect(samplePngDemElevationM({ image, x: 1, y: 1, encoding: 'terrarium' })).toBe(30)
    expect(samplePngDemElevationM({ image, x: 0.5, y: 0.5, encoding: 'terrarium' })).toBe(15)
  })

  test('rejects unsupported PNG payloads visibly', () => {
    const invalid = new Uint8Array([1, 2, 3, 4])

    expect(() => decodePngRgbImage(invalid)).toThrow('valid PNG signature')
  })
})
