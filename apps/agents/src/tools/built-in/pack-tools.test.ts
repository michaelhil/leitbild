// Integration tests for pack-tools — install / update / uninstall / list.
// Uses a real local git repo as the source and file:// as the transport,
// so nothing leaves the machine.

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import {
  createInstallPackTool, createUpdatePackTool,
  createUninstallPackTool, createListPacksTool,
  type PackToolsDeps,
} from './pack-tools.ts'
import { createToolRegistry } from '../../core/tool-registry.ts'
import { createSkillStore } from '../../skills/loader.ts'
import type { ToolContext } from '../../core/types/tool.ts'
import { createAgentPackDescriptor } from '../../packs/manifest.ts'

const CTX: ToolContext = { callerId: 'test', callerName: 'test' }

const TOOL_SRC = (name: string) => `
export default {
  name: '${name}',
  description: 'test tool ${name}',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ success: true, data: '${name}' }),
}
`

const SKILL_MD = (name: string) => `---
name: ${name}
description: test skill ${name}
---

Body.
`

const PACK_MANIFEST = (id: string, contributionKinds: ReadonlyArray<string>) => ({
  descriptor: createAgentPackDescriptor({
    id,
    version: '1.0.0',
    name: id.toUpperCase(),
    description: `Test Pack ${id}`,
    contributions: contributionKinds.map(kind => ({ kind })),
  }),
  wikis: [],
  uiExtensions: [],
})

// Build a bare git repo with one tool + one skill. Returns the file:// URL
// pointing at the repo; clients clone from there.
const buildRepo = async (parent: string, name: string): Promise<string> => {
  const repoDir = join(parent, `${name}-src`)
  await mkdir(join(repoDir, 'tools'), { recursive: true })
  await mkdir(join(repoDir, 'skills', 'demo'), { recursive: true })
  await writeFile(join(repoDir, 'tools', 'ping.ts'), TOOL_SRC('ping'))
  await writeFile(join(repoDir, 'skills', 'demo', 'SKILL.md'), SKILL_MD('demo'))
  await writeFile(join(repoDir, 'pack.json'), JSON.stringify({
    ...PACK_MANIFEST(name, ['tool', 'skill']),
  }))
  await $`git -C ${repoDir} init -q`.quiet()
  await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
  await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet()
  return `file://${repoDir}`
}

const makeDeps = async (): Promise<{
  deps: PackToolsDeps
  parent: string
  refreshCount: { n: number }
  catalogRefreshCount: { geodata: number; scripts: number }
}> => {
  const parent = await mkdtemp(join(tmpdir(), 'pack-tools-'))
  const packsDir = join(parent, 'packs')
  await mkdir(packsDir, { recursive: true })
  const refreshCount = { n: 0 }
  const catalogRefreshCount = { geodata: 0, scripts: 0 }
  const deps: PackToolsDeps = {
    packsDir,
    toolRegistry: createToolRegistry(),
    skillStore: createSkillStore(),
    refreshAllAgentTools: async () => { refreshCount.n += 1 },
    refreshPackGeodata: async () => { catalogRefreshCount.geodata += 1 },
    refreshPackScripts: async () => { catalogRefreshCount.scripts += 1 },
  }
  return { deps, parent, refreshCount, catalogRefreshCount }
}

describe('install_pack', () => {
  let parent: string

  afterEach(async () => {
    if (parent) await rm(parent, { recursive: true, force: true })
  })

  it('uses the descriptor id as its canonical id and registers atomically', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')

    const install = createInstallPackTool(env.deps)
    const result = await install.execute({ source: url }, CTX)

    expect(result.success).toBe(true)
    const data = result.data as { id: string; tools: string[]; skills: string[] }
    expect(data.id).toBe('atc')
    expect(data.tools).toEqual(['atc_ping'])
    expect(data.skills).toEqual(['atc/demo'])
    expect(env.deps.toolRegistry.has('atc_ping')).toBe(true)
    expect(env.deps.skillStore.get('atc/demo')).toBeDefined()
    expect(env.refreshCount.n).toBe(1)
    expect(env.catalogRefreshCount).toEqual({ geodata: 1, scripts: 1 })
  })

  it('refreshes Pack contribution catalogs even when rebuilding live Agent tools fails', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')
    const deps: PackToolsDeps = {
      ...env.deps,
      refreshAllAgentTools: async () => { throw new Error('agent refresh failed') },
    }

    const result = await createInstallPackTool(deps).execute({ source: url }, CTX)

    expect(result.success).toBe(true)
    expect(env.catalogRefreshCount).toEqual({ geodata: 1, scripts: 1 })
  })

  it('rejects a repository without the required descriptor manifest', async () => {
    const env = await makeDeps()
    parent = env.parent
    const repoDir = join(env.parent, 'missing-manifest')
    await mkdir(repoDir)
    await $`git -C ${repoDir} init -q`.quiet()
    await writeFile(join(repoDir, 'README.md'), 'missing manifest')
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet()

    const install = createInstallPackTool(env.deps)
    const result = await install.execute({ source: `file://${repoDir}` }, CTX)

    expect(result.success).toBe(false)
    expect(result.error).toContain('required Pack manifest')
  })

  it('refuses to overwrite existing install', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')

    const install = createInstallPackTool(env.deps)
    await install.execute({ source: url }, CTX)
    const second = await install.execute({ source: url }, CTX)
    expect(second.success).toBe(false)
    expect(second.error).toContain('already installed')
  })

  it('reports a clear error for invalid source', async () => {
    const env = await makeDeps()
    parent = env.parent
    const install = createInstallPackTool(env.deps)
    const result = await install.execute({ source: 'has.dots' }, CTX)
    expect(result.success).toBe(false)
  })

  it('refuses to install the reserved built-in core namespace', async () => {
    const env = await makeDeps()
    parent = env.parent
    const install = createInstallPackTool(env.deps)

    // Bare-name attempt
    const bare = await install.execute({ source: 'core' }, CTX)
    expect(bare.success).toBe(false)
    expect(bare.error).toContain('reserved')

    // Owner/repo attempt against the public mirror
    const ownerRepo = await install.execute({ source: 'michaelhil/leitbild-core' }, CTX)
    expect(ownerRepo.success).toBe(false)
    expect(ownerRepo.error).toContain('reserved')

    // Full URL attempt
    const url = await install.execute({ source: 'https://github.com/michaelhil/leitbild-core.git' }, CTX)
    expect(url.success).toBe(false)
    expect(url.error).toContain('reserved')

  })

  it('reports git failure without leaving a stray directory', async () => {
    const env = await makeDeps()
    parent = env.parent
    const install = createInstallPackTool(env.deps)
    // file:// to a non-existent repo
    const result = await install.execute({
      source: `file://${env.parent}/does-not-exist`,
    }, CTX)
    expect(result.success).toBe(false)

    const { stat } = await import('node:fs/promises')
    let stillThere = false
    try {
      await stat(join(env.deps.packsDir, 'ghost'))
      stillThere = true
    } catch { /* expected */ }
    expect(stillThere).toBe(false)
  })
})

describe('uninstall_pack', () => {
  let parent: string
  afterEach(async () => { if (parent) await rm(parent, { recursive: true, force: true }) })

  it('unregisters tools + skills and removes the directory', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')

    const install = createInstallPackTool(env.deps)
    const uninstall = createUninstallPackTool(env.deps)
    await install.execute({ source: url }, CTX)
    expect(env.deps.toolRegistry.has('atc_ping')).toBe(true)

    const result = await uninstall.execute({ id: 'atc' }, CTX)
    expect(result.success).toBe(true)
    expect(env.deps.toolRegistry.has('atc_ping')).toBe(false)
    expect(env.deps.skillStore.get('atc/demo')).toBeUndefined()
    expect(env.refreshCount.n).toBe(2) // install + uninstall

    const { stat } = await import('node:fs/promises')
    let stillThere = false
    try { await stat(join(env.deps.packsDir, 'atc')); stillThere = true } catch { /* expected */ }
    expect(stillThere).toBe(false)
  })

  it('refuses when pack is not installed', async () => {
    const env = await makeDeps()
    parent = env.parent
    const uninstall = createUninstallPackTool(env.deps)
    const result = await uninstall.execute({ id: 'nope' }, CTX)
    expect(result.success).toBe(false)
  })

  it('scrubs pack from rooms.activePacks atomically before tearing down registry', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')

    // Track scrubbed rooms via the wired callback. Mirrors what
    // bootstrap.ts plumbs as crossWorkspaceScrubActivePacks.
    const fakeRooms = new Map<string, string[]>([
      ['room-a', ['atc', 'cafes']],
      ['room-b', ['atc']],
      ['room-c', ['cafes']],            // doesn't have atc — should NOT appear in scrub list
    ])
    const scrubbed: { roomId: string; activePacks: ReadonlyArray<string> }[] = []
    const depsWithScrub: PackToolsDeps = {
      ...env.deps,
      scrubActivePacks: (ns: string) => {
        for (const [roomId, packs] of fakeRooms) {
          if (!packs.includes(ns)) continue
          const next = packs.filter(p => p !== ns)
          fakeRooms.set(roomId, next)
          scrubbed.push({ roomId, activePacks: next })
        }
        return scrubbed
      },
    }

    const install = createInstallPackTool(depsWithScrub)
    const uninstall = createUninstallPackTool(depsWithScrub)
    await install.execute({ source: url }, CTX)

    const result = await uninstall.execute({ id: 'atc' }, CTX)
    expect(result.success).toBe(true)
    // Two rooms had atc active; one didn't — only the affected two
    // are reported.
    expect(scrubbed.map(s => s.roomId).sort()).toEqual(['room-a', 'room-b'])
    expect(fakeRooms.get('room-a')).toEqual(['cafes'])
    expect(fakeRooms.get('room-b')).toEqual([])
    expect(fakeRooms.get('room-c')).toEqual(['cafes']) // untouched
    // Result body carries the audit list for the WS broadcast layer.
    expect((result.data as { scrubbedRooms: unknown }).scrubbedRooms).toEqual(scrubbed)
  })
})

describe('update_pack', () => {
  let parent: string
  afterEach(async () => { if (parent) await rm(parent, { recursive: true, force: true }) })

  it('pulls new commits and re-registers pack contents', async () => {
    const env = await makeDeps()
    parent = env.parent
    const repoDir = join(env.parent, 'atc-source')
    await mkdir(join(repoDir, 'tools'), { recursive: true })
    await writeFile(join(repoDir, 'tools', 'a.ts'), TOOL_SRC('a'))
    await writeFile(join(repoDir, 'pack.json'), JSON.stringify(PACK_MANIFEST('atc', ['tool'])))
    await $`git -C ${repoDir} init -q`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet()
    // Ensure branch name is predictable.
    await $`git -C ${repoDir} branch -M main`.quiet().nothrow()

    const install = createInstallPackTool(env.deps)
    await install.execute({ source: `file://${repoDir}` }, CTX)
    expect(env.deps.toolRegistry.has('atc_a')).toBe(true)

    // Add a new tool upstream.
    await writeFile(join(repoDir, 'tools', 'b.ts'), TOOL_SRC('b'))
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m add-b`.quiet()

    const update = createUpdatePackTool(env.deps)
    const result = await update.execute({ id: 'atc' }, CTX)
    expect(result.success).toBe(true)
    expect(env.deps.toolRegistry.has('atc_a')).toBe(true)
    expect(env.deps.toolRegistry.has('atc_b')).toBe(true)
  })

  it('rolls back to the previous version when the new revision has a broken tool', async () => {
    const env = await makeDeps()
    parent = env.parent
    const repoDir = join(env.parent, 'atc-source')
    await mkdir(join(repoDir, 'tools'), { recursive: true })
    await writeFile(join(repoDir, 'tools', 'good.ts'), TOOL_SRC('good'))
    await writeFile(join(repoDir, 'pack.json'), JSON.stringify(PACK_MANIFEST('atc', ['tool'])))
    await $`git -C ${repoDir} init -q`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet()
    await $`git -C ${repoDir} branch -M main`.quiet().nothrow()

    const install = createInstallPackTool(env.deps)
    await install.execute({ source: `file://${repoDir}` }, CTX)
    expect(env.deps.toolRegistry.has('atc_good')).toBe(true)

    // Push a broken commit upstream — syntax error makes the new tool
    // unparseable, so loadPack returns errors after the pull.
    await writeFile(join(repoDir, 'tools', 'bad.ts'), 'export default { this is not valid typescript')
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m bad`.quiet()

    const update = createUpdatePackTool(env.deps)
    const result = await update.execute({ id: 'atc' }, CTX)

    // Rollback contract:
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('rolled back')
    // Pack still installed, original tool still present.
    expect(env.deps.toolRegistry.has('atc_good')).toBe(true)
    // .prev sibling cleaned.
    const { stat } = await import('node:fs/promises')
    let prevExists = false
    try { await stat(join(env.deps.packsDir, 'atc.prev')); prevExists = true } catch { /* expected */ }
    expect(prevExists).toBe(false)
  })

  it('refuses to run when an orphan .prev sibling already exists', async () => {
    const env = await makeDeps()
    parent = env.parent
    const repoDir = join(env.parent, 'atc-source')
    await mkdir(join(repoDir, 'tools'), { recursive: true })
    await writeFile(join(repoDir, 'tools', 'a.ts'), TOOL_SRC('a'))
    await writeFile(join(repoDir, 'pack.json'), JSON.stringify(PACK_MANIFEST('atc', ['tool'])))
    await $`git -C ${repoDir} init -q`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet()
    await $`git -C ${repoDir} branch -M main`.quiet().nothrow()

    const install = createInstallPackTool(env.deps)
    await install.execute({ source: `file://${repoDir}` }, CTX)

    // Simulate orphan from a previous crashed update.
    await mkdir(join(env.deps.packsDir, 'atc.prev'), { recursive: true })

    const update = createUpdatePackTool(env.deps)
    const result = await update.execute({ id: 'atc' }, CTX)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('orphan .prev sibling')
  })

  it('B2: concurrent update_pack on the same namespace serialise — no .prev clash', async () => {
    const env = await makeDeps()
    parent = env.parent
    const repoDir = join(env.parent, 'atc-source')
    await mkdir(join(repoDir, 'tools'), { recursive: true })
    await writeFile(join(repoDir, 'tools', 'a.ts'), TOOL_SRC('a'))
    await writeFile(join(repoDir, 'pack.json'), JSON.stringify(PACK_MANIFEST('atc', ['tool'])))
    await $`git -C ${repoDir} init -q`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet()
    await $`git -C ${repoDir} branch -M main`.quiet().nothrow()

    const install = createInstallPackTool(env.deps)
    await install.execute({ source: `file://${repoDir}` }, CTX)

    // Add upstream commits between updates so each pull does meaningful work.
    await writeFile(join(repoDir, 'tools', 'b.ts'), TOOL_SRC('b'))
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m add-b`.quiet()

    const update = createUpdatePackTool(env.deps)
    // Three concurrent updates on the same namespace. With per-namespace
    // chains, they serialise: first does the actual pull + reload, the
    // next two pull-no-op (already up to date) but never collide on .prev.
    const results = await Promise.all([
      update.execute({ id: 'atc' }, CTX),
      update.execute({ id: 'atc' }, CTX),
      update.execute({ id: 'atc' }, CTX),
    ])
    for (const r of results) {
      expect(r.success).toBe(true)
    }
    // No orphan .prev left behind.
    const { stat } = await import('node:fs/promises')
    let prevExists = false
    try { await stat(join(env.deps.packsDir, 'atc.prev')); prevExists = true } catch { /* expected */ }
    expect(prevExists).toBe(false)
    // Both tools registered (the upstream b.ts landed).
    expect(env.deps.toolRegistry.has('atc_a')).toBe(true)
    expect(env.deps.toolRegistry.has('atc_b')).toBe(true)
  })
})

describe('list_packs', () => {
  let parent: string
  afterEach(async () => { if (parent) await rm(parent, { recursive: true, force: true }) })

  it('returns real bundled Packs followed by filesystem-installed Packs', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')
    await createInstallPackTool(env.deps).execute({ source: url }, CTX)

    const list = createListPacksTool(env.deps)
    const result = await list.execute({}, CTX)
    expect(result.success).toBe(true)
    const data = result.data as Array<{
      id: string
      deployment: 'bundled' | 'installed'
      tools: string[]
      skills: string[]
    }>

    expect(data.map(pack => pack.id)).toEqual(['demos', 'pwr-ops', 'atc'])
    expect(data.map(pack => pack.deployment)).toEqual(['bundled', 'bundled', 'installed'])

    // The installed pack reports its own tools/skills correctly.
    const atc = data.find(pack => pack.id === 'atc')!
    expect(atc.tools).toEqual(['atc_ping'])
    expect(atc.skills).toEqual(['atc/demo'])

  })
})
