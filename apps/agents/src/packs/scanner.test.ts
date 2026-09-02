import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentPackDescriptor } from './manifest.ts'
import { __resetScannerWarnings, scanPacks } from './scanner.ts'

const writePack = async (root: string, id: string): Promise<void> => {
  const dir = join(root, id)
  await mkdir(dir)
  await writeFile(join(dir, 'pack.json'), JSON.stringify({
    descriptor: createAgentPackDescriptor({
      id,
      version: '1.0.0',
      name: id,
      description: `Test Pack ${id}`,
      contributions: [{ kind: 'tool' }],
    }),
    wikis: [],
    uiExtensions: [],
  }))
}

describe('scanPacks', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'packs-scanner-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns [] when root is missing or empty', async () => {
    expect(await scanPacks(join(root, 'nope'))).toEqual([])
    expect(await scanPacks(root)).toEqual([])
  })

  it('finds only Packs with strict manifests and canonical directory ids', async () => {
    await writePack(root, 'atc')
    await writePack(root, 'driving')

    const packs = await scanPacks(root)
    expect(packs.map(pack => pack.id)).toEqual(['atc', 'driving'])
    expect(packs[0]?.manifest.descriptor.name).toBe('atc')
  })

  it('skips hidden directories and files at the root', async () => {
    await mkdir(join(root, '.git'))
    await mkdir(join(root, '_scratch'))
    await writeFile(join(root, 'not-a-pack.txt'), 'x')
    await writePack(root, 'real')

    expect((await scanPacks(root)).map(pack => pack.id)).toEqual(['real'])
  })

  it('fails visibly for a missing manifest or a directory/id mismatch', async () => {
    await mkdir(join(root, 'missing'))
    await expect(scanPacks(root)).rejects.toThrow('required Pack manifest')
    await rm(join(root, 'missing'), { recursive: true, force: true })

    const wrongDir = join(root, 'wrong')
    await mkdir(wrongDir)
    await writeFile(join(wrongDir, 'pack.json'), JSON.stringify({
      descriptor: createAgentPackDescriptor({
        id: 'actual', version: '1.0.0', name: 'Actual', description: 'Test Pack actual', contributions: [{ kind: 'tool' }],
      }),
      wikis: [],
      uiExtensions: [],
    }))
    await expect(scanPacks(root)).rejects.toThrow('must match Pack directory name')
  })

  it('orphan .prev warning fires once per path across many scans', async () => {
    __resetScannerWarnings()
    await mkdir(join(root, 'site-survey.prev'))
    await writePack(root, 'site-survey')

    let warnings = 0
    const origWarn = console.warn
    console.warn = (msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('orphan rollback snapshot')) warnings++
    }
    try {
      await scanPacks(root)
      await scanPacks(root)
      await scanPacks(root)
      expect(warnings).toBe(1)
    } finally {
      console.warn = origWarn
      __resetScannerWarnings()
    }
  })
})
