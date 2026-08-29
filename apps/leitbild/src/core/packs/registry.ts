import type { LeitbildPack } from './protocol.ts'

export interface PackRegistry {
  readonly list: () => ReadonlyArray<LeitbildPack>
  readonly get: (id: string) => LeitbildPack | undefined
  readonly require: (id: string) => LeitbildPack
}

export const createPackRegistry = (packs: ReadonlyArray<LeitbildPack>): PackRegistry => {
  const byId = new Map<string, LeitbildPack>()
  for (const pack of packs) {
    if (byId.has(pack.id)) throw new Error(`duplicate pack id: ${pack.id}`)
    byId.set(pack.id, pack)
  }

  return {
    list: () => [...byId.values()],
    get: (id: string): LeitbildPack | undefined => byId.get(id),
    require: (id: string): LeitbildPack => {
      const pack = byId.get(id)
      if (!pack) throw new Error(`unknown pack: ${id}`)
      return pack
    },
  }
}
