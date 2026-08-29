import type { WorldPack } from './protocol.ts'

export interface PackRegistry {
  readonly list: () => ReadonlyArray<WorldPack>
  readonly get: (id: string) => WorldPack | undefined
  readonly require: (id: string) => WorldPack
}

export const createPackRegistry = (packs: ReadonlyArray<WorldPack>): PackRegistry => {
  const byId = new Map<string, WorldPack>()
  for (const pack of packs) {
    if (byId.has(pack.descriptor.id)) throw new Error(`duplicate pack id: ${pack.descriptor.id}`)
    byId.set(pack.descriptor.id, pack)
  }

  return {
    list: () => [...byId.values()],
    get: (id: string): WorldPack | undefined => byId.get(id),
    require: (id: string): WorldPack => {
      const pack = byId.get(id)
      if (!pack) throw new Error(`unknown pack: ${id}`)
      return pack
    },
  }
}
