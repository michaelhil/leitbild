import { expect, test } from 'bun:test'
import { PbfWriter } from 'pbf'
import { validateGlyphRange } from '../scripts/maps/glyph-validation.ts'

test('font downloads reject successful HTML responses and mismatched protobuf ranges', () => {
  expect(() => validateGlyphRange(new TextEncoder().encode('<!DOCTYPE html><html>Moved</html>'), 'Noto Sans Regular', '0-255')).toThrow()
  const writer = new PbfWriter()
  writer.writeMessage(1, (_value, stack) => {
    stack.writeStringField(1, 'Noto Sans Regular')
    stack.writeStringField(2, '0-255')
  }, {})
  const bytes = writer.finish()
  expect(() => validateGlyphRange(bytes, 'Noto Sans Regular', '0-255')).not.toThrow()
  expect(() => validateGlyphRange(bytes, 'Other Font', '0-255')).toThrow()
  expect(() => validateGlyphRange(bytes, 'Noto Sans Regular', '256-511')).toThrow()
  expect(() => validateGlyphRange(new Uint8Array(), 'Noto Sans Regular', '0-255')).toThrow()
})
