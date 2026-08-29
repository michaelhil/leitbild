import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAllPacks, loadPack } from './loader.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createSkillStore } from '../skills/loader.ts'
import { createAgentPackDescriptor, parsePackManifest } from './manifest.ts'
import type { Pack, PackManifest } from './types.ts'

const TOOL_SRC = (name: string, body = `return { success: true, data: '${name}' }`) => `
export default {
  name: '${name}',
  description: 'test tool ${name}',
  parameters: { type: 'object', properties: {} },
  execute: async () => { ${body} },
}
`

const SKILL_MD = (name: string, desc: string) => `---
name: ${name}
description: ${desc}
---

Body for ${name}.
`

const manifestFor = (id: string, kinds: ReadonlyArray<string>): PackManifest => parsePackManifest({
  descriptor: createAgentPackDescriptor({
    id,
    version: '1.0.0',
    name: id,
    contributions: kinds.map(kind => ({ kind })),
  }),
  wikis: [],
  uiExtensions: [],
})

const packFor = (dirPath: string, id: string, kinds: ReadonlyArray<string>): Pack => ({
  id,
  dirPath,
  manifest: manifestFor(id, kinds),
})

const writeManifest = async (dirPath: string, id: string, kinds: ReadonlyArray<string>): Promise<void> => {
  await writeFile(join(dirPath, 'pack.json'), JSON.stringify(manifestFor(id, kinds)))
}

describe('loadPack', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'packs-loader-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('loads a pack with namespaced tools and skills', async () => {
    const packDir = join(root, 'atc')
    await mkdir(join(packDir, 'tools'), { recursive: true })
    await mkdir(join(packDir, 'skills', 'chart-reader'), { recursive: true })
    await writeFile(join(packDir, 'tools', 'vatsim.ts'), TOOL_SRC('vatsim'))
    await writeFile(
      join(packDir, 'skills', 'chart-reader', 'SKILL.md'),
      SKILL_MD('chart-reader', 'Read aviation charts'),
    )

    const registry = createToolRegistry()
    const store = createSkillStore()
    const result = await loadPack(
      packFor(packDir, 'atc', ['tool', 'skill']),
      registry,
      store,
    )

    expect(result.tools).toEqual(['atc_vatsim'])
    expect(result.skills).toEqual(['atc/chart-reader'])
    expect(registry.has('atc_vatsim')).toBe(true)
    expect(registry.has('vatsim')).toBe(false)
    expect(store.get('atc/chart-reader')).toBeDefined()
    expect(store.get('atc/chart-reader')?.pack).toBe('atc')
    expect(store.get('atc/chart-reader')?.displayName).toBe('chart-reader')
  })

  it('two packs can ship tools with the same raw name', async () => {
    for (const ns of ['atc', 'driving']) {
      const packDir = join(root, ns)
      await mkdir(join(packDir, 'tools'), { recursive: true })
      await writeFile(join(packDir, 'tools', 'plan.ts'), TOOL_SRC('plan'))
      await writeManifest(packDir, ns, ['tool'])
    }

    const registry = createToolRegistry()
    const store = createSkillStore()
    await loadAllPacks(root, registry, store)

    expect(registry.has('atc_plan')).toBe(true)
    expect(registry.has('driving_plan')).toBe(true)
    expect(registry.has('plan')).toBe(false) // unprefixed slot stays free for built-ins
  })

  it('registered tool name matches registry key (LLM-facing)', async () => {
    const packDir = join(root, 'atc')
    await mkdir(join(packDir, 'tools'), { recursive: true })
    await writeFile(join(packDir, 'tools', 'plan.ts'), TOOL_SRC('plan'))

    const registry = createToolRegistry()
    const store = createSkillStore()
    await loadPack(packFor(packDir, 'atc', ['tool']), registry, store)

    const tool = registry.get('atc_plan')
    expect(tool?.name).toBe('atc_plan')
  })

  it('source metadata carries pack + displayName', async () => {
    const packDir = join(root, 'atc')
    await mkdir(join(packDir, 'tools'), { recursive: true })
    await writeFile(join(packDir, 'tools', 'plan.ts'), TOOL_SRC('plan'))

    const registry = createToolRegistry()
    const store = createSkillStore()
    await loadPack(packFor(packDir, 'atc', ['tool']), registry, store)

    const entry = registry.getEntry('atc_plan')
    expect(entry?.source.kind).toBe('pack-bundled')
    expect(entry?.source.pack).toBe('atc')
    expect(entry?.source.displayName).toBe('plan')
  })

  it('unregisterByPack removes every pack-bundled tool in one go', async () => {
    const packDir = join(root, 'atc')
    await mkdir(join(packDir, 'tools'), { recursive: true })
    await writeFile(join(packDir, 'tools', 'a.ts'), TOOL_SRC('a'))
    await writeFile(join(packDir, 'tools', 'b.ts'), TOOL_SRC('b'))

    const registry = createToolRegistry()
    const store = createSkillStore()
    await loadPack(packFor(packDir, 'atc', ['tool']), registry, store)

    expect(registry.has('atc_a')).toBe(true)
    expect(registry.has('atc_b')).toBe(true)

    const removed = registry.unregisterByPack('atc')
    expect([...removed].sort()).toEqual(['atc_a', 'atc_b'])
    expect(registry.has('atc_a')).toBe(false)
    expect(registry.has('atc_b')).toBe(false)
  })

  it('removeByPack sweeps pack-scoped skills', async () => {
    const packDir = join(root, 'atc')
    await mkdir(join(packDir, 'skills', 's1'), { recursive: true })
    await mkdir(join(packDir, 'skills', 's2'), { recursive: true })
    await writeFile(join(packDir, 'skills', 's1', 'SKILL.md'), SKILL_MD('s1', 'one'))
    await writeFile(join(packDir, 'skills', 's2', 'SKILL.md'), SKILL_MD('s2', 'two'))

    const registry = createToolRegistry()
    const store = createSkillStore()
    await loadPack(packFor(packDir, 'atc', ['skill']), registry, store)

    const removed = store.removeByPack('atc')
    expect([...removed].sort()).toEqual(['atc/s1', 'atc/s2'])
    expect(store.get('atc/s1')).toBeUndefined()
  })

  it('rejects undeclared contribution directories before mutating registries', async () => {
    const packDir = join(root, 'atc')
    await mkdir(join(packDir, 'tools'), { recursive: true })
    await writeFile(join(packDir, 'tools', 'plan.ts'), TOOL_SRC('plan'))

    const registry = createToolRegistry()
    const store = createSkillStore()
    const result = await loadPack(packFor(packDir, 'atc', ['skill']), registry, store)

    expect(result.errors.join(' ')).toContain('contains tool contributions but does not declare them')
    expect(registry.has('atc_plan')).toBe(false)
  })
})
