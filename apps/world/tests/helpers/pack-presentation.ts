import { expect } from 'bun:test'
import type { PackObjectPresentation, PackObjectStatusIndicator } from '../../src/core/packs/protocol.ts'

export const expectFieldKeys = (
  presentation: PackObjectPresentation,
  expectedKeys: ReadonlyArray<string>,
): void => {
  expect(presentation.fields.map(field => field.key)).toEqual(expect.arrayContaining([...expectedKeys]))
}

export const expectStatusIndicator = (
  presentation: PackObjectPresentation,
  expectedIndicator: PackObjectStatusIndicator,
): void => {
  expect(presentation.status?.indicator).toEqual(expectedIndicator)
}
