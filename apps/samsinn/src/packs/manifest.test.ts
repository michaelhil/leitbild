import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentPackDescriptor,
  parsePackManifest,
  readManifest,
} from './manifest.ts'

const validManifest = (overrides: Record<string, unknown> = {}) => ({
  descriptor: createAgentPackDescriptor({
    id: 'atc',
    version: '1.2.3',
    name: 'ATC Pack',
    description: 'Air traffic control bundle',
    contributions: [{ kind: 'tool' }],
  }),
  wikis: [],
  uiExtensions: [],
  ...overrides,
})

describe('Agent Pack manifest', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'packs-manifest-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('requires pack.json', async () => {
    await expect(readManifest(dir)).rejects.toMatchObject({ name: 'PackManifestError' })
  })

  it('parses the shared descriptor envelope and application metadata', async () => {
    const manifest = validManifest()
    await writeFile(join(dir, 'pack.json'), JSON.stringify(manifest))
    expect(await readManifest(dir)).toEqual(manifest)
  })

  it('rejects invalid JSON, unknown fields, and partial descriptors', async () => {
    await writeFile(join(dir, 'pack.json'), '{not json')
    await expect(readManifest(dir)).rejects.toThrow('invalid JSON')

    expect(() => parsePackManifest({ ...validManifest(), legacyName: 'atc' })).toThrow('Unrecognized key')
    expect(() => parsePackManifest({ descriptor: { id: 'atc' } })).toThrow()
  })

  it('rejects Packs for other Modules and incompatible contract versions', () => {
    const base = validManifest()
    expect(() => parsePackManifest({
      ...base,
      descriptor: { ...base.descriptor, moduleId: 'microworld' },
    })).toThrow('moduleId is agents')
    expect(() => parsePackManifest({
      ...base,
      descriptor: { ...base.descriptor, platformVersionRange: '^2.0.0' },
    })).toThrow('unsupported platform version range')
  })

  it('validates wiki metadata as an atomic contribution', () => {
    const descriptor = createAgentPackDescriptor({
      id: 'procedures',
      version: '1.0.0',
      name: 'Procedures',
      contributions: [{ kind: 'wiki' }],
    })
    const manifest = parsePackManifest({
      descriptor,
      wikis: [{ name: 'Procedures', url: 'https://example.com/wiki' }],
      uiExtensions: [],
    })
    expect(manifest.wikis[0]?.name).toBe('Procedures')
    expect(() => parsePackManifest({ descriptor, wikis: [], uiExtensions: [] })).toThrow('both be present')
    expect(() => parsePackManifest({
      descriptor,
      wikis: [{ name: 'Unsafe', url: 'file:///etc/passwd' }],
      uiExtensions: [],
    })).toThrow('must use http or https')
  })

  it('requires UI extension metadata and contribution ids to match exactly', () => {
    const descriptor = createAgentPackDescriptor({
      id: 'biometrics',
      version: '1.0.0',
      name: 'Biometrics',
      contributions: [{ kind: 'ui-extension', id: 'biometrics' }],
    })
    expect(parsePackManifest({ descriptor, uiExtensions: ['biometrics'], wikis: [] }).uiExtensions).toEqual(['biometrics'])
    expect(() => parsePackManifest({ descriptor, uiExtensions: [], wikis: [] })).toThrow('exactly match')
  })
})
