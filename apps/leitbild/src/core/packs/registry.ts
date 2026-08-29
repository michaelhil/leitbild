import type { MicroworldPack } from './protocol.ts'

export interface PackRegistry {
  readonly list: () => ReadonlyArray<MicroworldPack>
  readonly get: (id: string) => MicroworldPack | undefined
  readonly require: (id: string) => MicroworldPack
}

export const createPackRegistry = (packs: ReadonlyArray<MicroworldPack>): PackRegistry => {
  const byId = new Map<string, MicroworldPack>()
  for (const pack of packs) {
    if (byId.has(pack.descriptor.id)) throw new Error(`duplicate pack id: ${pack.descriptor.id}`)
    byId.set(pack.descriptor.id, pack)
  }

  return {
    list: () => [...byId.values()],
    get: (id: string): MicroworldPack | undefined => byId.get(id),
    require: (id: string): MicroworldPack => {
      const pack = byId.get(id)
      if (!pack) throw new Error(`unknown pack: ${id}`)
      return pack
    },
  }
}
