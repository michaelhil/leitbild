import { describe, expect, test } from 'bun:test'
import { literalSearchTerms, matchesLiteralSearch } from '../src/core/model/index.ts'

describe('literal World discovery search', () => {
  test('is case and punctuation insensitive while requiring every supplied term', () => {
    expect(literalSearchTerms('RCP running / Unit-2')).toEqual(['rcp', 'running', 'unit', '2'])
    expect(matchesLiteralSearch('RCP running', ['rcpA.running', 'Reactor coolant pump A status'])).toBe(true)
    expect(matchesLiteralSearch('Unit power', ['Halden Unit 2', 'thermal output'])).toBe(false)
  })
})
