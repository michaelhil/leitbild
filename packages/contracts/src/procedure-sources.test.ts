import { describe, expect, test } from 'bun:test'
import { wikiManifestSchema } from './procedure-sources.ts'

const revision = 'c'.repeat(40)
const procedure = {
  id: 'E-0',
  title: 'Reactor Trip',
  file: 'wiki/procedures/E-0.md',
  csfsMonitored: [],
  entryTriggers: [],
  coverage: 'developed',
  stepCount: 18,
  tagDefinitionCount: 33,
}

describe('procedure source manifest contract', () => {
  test('accepts one revisioned, self-describing procedure index', () => {
    const manifest = wikiManifestSchema.parse({
      version: 1,
      wiki: 'pwr-ops',
      revision,
      procmdVersion: '0.7',
      procedures: [procedure],
      pages: [],
    })
    expect(manifest.revision).toBe(revision)
    expect(manifest.procedures[0]?.file).toBe('wiki/procedures/E-0.md')
  })

  test('rejects missing revisions, unsafe paths, and duplicate procedure identities', () => {
    expect(() => wikiManifestSchema.parse({
      version: 1,
      wiki: 'pwr-ops',
      procmdVersion: '0.7',
      procedures: [procedure],
      pages: [],
    })).toThrow()
    expect(() => wikiManifestSchema.parse({
      version: 1,
      wiki: 'pwr-ops',
      revision,
      procmdVersion: '0.7',
      procedures: [{ ...procedure, file: '../E-0.md' }],
      pages: [],
    })).toThrow()
    expect(() => wikiManifestSchema.parse({
      version: 1,
      wiki: 'pwr-ops',
      revision,
      procmdVersion: '0.7',
      procedures: [procedure, { ...procedure, file: 'wiki/procedures/copy.md' }],
      pages: [],
    })).toThrow(/duplicate procedure id/)
  })
})
