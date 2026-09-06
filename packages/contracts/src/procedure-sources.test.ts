import { describe, expect, test } from 'bun:test'
import { sourceDocumentPathSchema, wikiManifestSchema } from './procedure-sources.ts'

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
  test('generic reference manifests need no procedure version; procedures still do', () => {
    const generic = { version: 1, wiki: 'engineering', revision, procedures: [], pages: [
      { id: 'cooling', type: 'new-engineering-kind', title: 'Cooling', file: 'notes/kjøling.md', referencePlant: 'example only', review: 'unvalidated' },
    ] }
    expect(wikiManifestSchema.parse(generic).pages[0]?.review).toBe('unvalidated')
    expect(wikiManifestSchema.parse(generic).procmdVersion).toBeUndefined()
    expect(() => wikiManifestSchema.parse({ ...generic, procedures: [procedure] })).toThrow('procmdVersion is required')
  })

  test('rejects duplicate reference identities and paths but not ids in different types', () => {
    const page = { id: 'cooling', type: 'system', title: 'Cooling', file: 'notes/cooling.md' }
    const generic = { version: 1, wiki: 'engineering', revision, procedures: [], pages: [page] }
    expect(() => wikiManifestSchema.parse({ ...generic, pages: [page, { ...page, file: 'notes/another.md' }] })).toThrow('duplicate page identity')
    expect(() => wikiManifestSchema.parse({ ...generic, pages: [page, { ...page, id: 'other' }] })).toThrow('duplicate page file')
    expect(wikiManifestSchema.parse({ ...generic, pages: [page, { ...page, type: 'theory', file: 'notes/theory.md' }] }).pages).toHaveLength(2)
  })

  test('paths are literal filenames, not pre-encoded URL syntax', () => {
    for (const path of ['../file.md', '/file.md', 'a/../file.md', 'a/./file.md', 'a//file.md', 'a/\u0000.md']) {
      expect(sourceDocumentPathSchema.safeParse(path).success).toBe(false)
    }
    for (const path of ['wiki/kjøling Δ.md', '%2e%2e/main/wiki/x.md', 'wiki/name?query#fragment.md', 'wiki/back\\slash.md']) {
      expect(sourceDocumentPathSchema.parse(path)).toBe(path)
    }
  })

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
