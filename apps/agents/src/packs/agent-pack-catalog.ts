import type { ToolRegistry } from '../core/types/tool.ts'
import type { SkillStore } from '../skills/loader.ts'
import { getAvailablePacks } from './registry.ts'
import { BUNDLED_PACKS } from './bundled.ts'
import { scanPacks } from './scanner.ts'
import type { Pack, PackManifest } from './types.ts'

export interface AgentPackCatalogEntry {
  readonly id: string
  readonly deployment: 'bundled' | 'installed'
  readonly descriptor: PackManifest['descriptor']
  readonly wikis: PackManifest['wikis']
  readonly uiExtensions: PackManifest['uiExtensions']
  readonly tools: ReadonlyArray<string>
  readonly skills: ReadonlyArray<string>
}

export interface AvailableAgentPack {
  readonly name: string
  readonly repoName: string
  readonly source: string
  readonly repoUrl: string
  readonly description: string
  readonly installed: boolean
}

/** Deployment-scoped, authoritative inventory of Agent Packs and contributions. */
export interface AgentPackCatalog {
  readonly list: () => ReadonlyArray<AgentPackCatalogEntry>
  readonly has: (packId: string) => boolean
  readonly installed: () => ReadonlyArray<Pack>
  readonly replaceInstalled: (packs: ReadonlyArray<Pack>) => void
  readonly reload: () => Promise<ReadonlyArray<Pack>>
  readonly listAvailable: () => Promise<ReadonlyArray<AvailableAgentPack>>
}

export const createAgentPackCatalog = (deps: {
  readonly packsDir: string
  readonly toolRegistry: ToolRegistry
  readonly skillStore: SkillStore
}): AgentPackCatalog => {
  let installedPacks: ReadonlyArray<Pack> = []

  const replaceInstalled = (packs: ReadonlyArray<Pack>): void => {
    installedPacks = [...packs]
  }

  const list = (): ReadonlyArray<AgentPackCatalogEntry> => {
    const tools = deps.toolRegistry.listEntries()
    const skills = deps.skillStore.list()
    const entryFor = (
      manifest: PackManifest,
      deployment: AgentPackCatalogEntry['deployment'],
    ): AgentPackCatalogEntry => {
      const id = manifest.descriptor.id
      return {
        id,
        deployment,
        descriptor: manifest.descriptor,
        wikis: manifest.wikis,
        uiExtensions: manifest.uiExtensions,
        tools: tools.filter(entry => entry.source.pack === id).map(entry => entry.tool.name),
        skills: skills.filter(skill => skill.pack === id).map(skill => skill.name),
      }
    }
    return [
      ...BUNDLED_PACKS.map(pack => entryFor(pack.manifest, 'bundled')),
      ...installedPacks.map(pack => entryFor(pack.manifest, 'installed')),
    ]
  }

  return {
    list,
    has: packId => BUNDLED_PACKS.some(pack => pack.manifest.descriptor.id === packId)
      || installedPacks.some(pack => pack.id === packId),
    installed: () => installedPacks,
    replaceInstalled,
    reload: async () => {
      const packs = await scanPacks(deps.packsDir)
      replaceInstalled(packs)
      return packs
    },
    listAvailable: async () => {
      const available = await getAvailablePacks()
      const installedIds = new Set(installedPacks.map(pack => pack.id))
      return available.map(pack => ({ ...pack, installed: installedIds.has(pack.name) }))
    },
  }
}
