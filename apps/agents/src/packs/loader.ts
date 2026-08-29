// Pack loader — orchestrates loading one or many packs under ~/.leitbild/packs.
//
// A pack is a directory that may contain:
//   - pack.json              (optional manifest; name + description)
//   - tools/*.ts             (tools, namespaced as `<pack>_<name>`)
//   - skills/<name>/SKILL.md (skills, namespaced as `<pack>/<name>`)
//
// Tool conflicts across packs are physically impossible thanks to the
// namespace prefix. A pack tool cannot shadow a built-in (built-ins stay
// unprefixed).

import type { Pack } from './types.ts'
import type { ToolRegistry } from '../core/types/tool.ts'
import type { SkillStore } from '../skills/loader.ts'
import { loadToolDirectory } from '../tools/loader.ts'
import { loadSkills } from '../skills/loader.ts'
import { scanPacks } from './scanner.ts'
import { resolvePackLoadOrder } from './catalog.ts'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'

export interface PackLoadResult {
  readonly pack: Pack
  readonly tools: ReadonlyArray<string>   // registry keys (prefixed)
  readonly skills: ReadonlyArray<string>  // registry keys (prefixed)
  readonly errors: ReadonlyArray<string>
}

const directoryContributions = {
  tool: 'tools',
  skill: 'skills',
  script: 'scripts',
  geodata: 'geodata',
} as const

const isDirectory = async (path: string): Promise<boolean> => {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

/** Rejects undeclared contribution directories and declarations with no implementation. */
export const validatePackLayout = async (pack: Pack): Promise<void> => {
  const declaredKinds = new Set(pack.manifest.descriptor.contributions.map(contribution => contribution.kind))
  for (const [kind, directory] of Object.entries(directoryContributions)) {
    const present = await isDirectory(join(pack.dirPath, directory))
    const declared = declaredKinds.has(kind)
    if (present !== declared) {
      throw new Error(
        `Pack ${pack.id} ${present ? 'contains' : 'declares'} ${kind} contributions but `
        + `${present ? 'does not declare them' : `has no ${directory}/ directory`}`,
      )
    }
  }
}

export const loadPack = async (
  pack: Pack,
  toolRegistry: ToolRegistry,
  skillStore: SkillStore,
): Promise<PackLoadResult> => {
  const errors: string[] = []

  try {
    await validatePackLayout(pack)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    return { pack, tools: [], skills: [], errors }
  }

  const toolResult = await loadToolDirectory(join(pack.dirPath, 'tools'), toolRegistry, {
    kind: 'pack-bundled',
    pack: pack.id,
    namespacePrefix: pack.id,
  })
  for (const e of toolResult.errors) errors.push(`${pack.id}/tools: ${e}`)

  const skillResult = await loadSkills(join(pack.dirPath, 'skills'), skillStore, toolRegistry, {
    namespacePrefix: pack.id,
    pack: pack.id,
  })
  for (const e of skillResult.errors) errors.push(`${pack.id}/skills: ${e}`)

  if (errors.length > 0) {
    toolRegistry.unregisterByPack(pack.id)
    skillStore.removeByPack(pack.id)
  }

  return {
    pack,
    tools: toolResult.loaded,
    skills: skillResult.loaded,
    errors,
  }
}

export const loadAllPacks = async (
  packsRoot: string,
  toolRegistry: ToolRegistry,
  skillStore: SkillStore,
): Promise<ReadonlyArray<PackLoadResult>> => {
  const packs = resolvePackLoadOrder(await scanPacks(packsRoot))
  await Promise.all(packs.map(validatePackLayout))
  const results: PackLoadResult[] = []
  for (const pack of packs) {
    const result = await loadPack(pack, toolRegistry, skillStore)
    results.push(result)
    if (result.errors.length > 0) {
      for (const loaded of results) {
        toolRegistry.unregisterByPack(loaded.pack.id)
        skillStore.removeByPack(loaded.pack.id)
      }
      throw new Error(`Pack ${pack.id} failed to load: ${result.errors.join('; ')}`)
    }
  }
  if (results.length > 0) {
    const totals = results.reduce(
      (acc, r) => ({
        packs: acc.packs + 1,
        tools: acc.tools + r.tools.length,
        skills: acc.skills + r.skills.length,
      }),
      { packs: 0, tools: 0, skills: 0 },
    )
    console.log(`[packs] ${totals.packs} packs loaded (${totals.tools} tools, ${totals.skills} skills)`)
  }
  return results
}
