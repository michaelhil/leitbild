import { describe, expect, test } from 'bun:test'
import { parsePruneArgs } from './prune.ts'

describe('reference prune arguments', () => {
  test('is a three-build dry run by default', () => {
    expect(parsePruneArgs([])).toEqual({ dataset: null, retain: 3, yes: false })
  })

  test('accepts an explicit dataset, count, and confirmation', () => {
    expect(parsePruneArgs(['--dataset', 'grid-norway', '--retain', '5', '--yes'])).toEqual({
      dataset: 'grid-norway',
      retain: 5,
      yes: true,
    })
  })

  test('rejects zero and unknown flags', () => {
    expect(() => parsePruneArgs(['--retain', '0'])).toThrow('positive integer')
    expect(() => parsePruneArgs(['--surprise'])).toThrow('Unknown argument')
  })
})
