import { createActivePackViews, type ActivePackViews } from '../core/packs/active-views.ts'
import type { WorldPack } from '../core/packs/protocol.ts'

type PackLoader = () => Promise<WorldPack>
type KnownUiPackId = 'ambulance' | 'traffic' | 'weather' | 'drone' | 'process-plant' | 'aviation' | 'electric-grid'

const packLoaders: Record<KnownUiPackId, PackLoader> = {
  ambulance: async () => (await import('../packs/ambulance/pack.ts')).ambulancePack,
  traffic: async () => (await import('../packs/traffic/pack.ts')).trafficPack,
  weather: async () => (await import('../packs/weather/pack.ts')).weatherPack,
  drone: async () => (await import('../packs/drone/ui-pack.ts')).droneUiPack,
  'process-plant': async () => (await import('../packs/process-plant/ui-pack.ts')).processPlantUiPack,
  aviation: async () => (await import('../packs/aviation/pack.ts')).aviationPack,
  'electric-grid': async () => (await import('../packs/electric-grid/ui-pack.ts')).electricGridUiPack,
}

/** Reviewed browser entry points. A parity test keeps this boundary aligned with the server assembly. */
export const knownUiPackIds: ReadonlyArray<string> = Object.keys(packLoaders).sort()

const loadedPacks = new Map<string, WorldPack>()

const isKnownUiPackId = (packId: string): packId is KnownUiPackId =>
  Object.hasOwn(packLoaders, packId)

export const loadUiPack = async (packId: string): Promise<WorldPack> => {
  const loaded = loadedPacks.get(packId)
  if (loaded) return loaded
  if (!isKnownUiPackId(packId)) throw new Error(`scenario references unknown UI pack: ${packId}`)
  const pack = await packLoaders[packId]()
  if (pack.descriptor.id !== packId) throw new Error(`UI pack loader for ${packId} returned ${pack.descriptor.id}`)
  loadedPacks.set(packId, pack)
  return pack
}

export const loadActivePackViews = async (
  packIds: ReadonlyArray<string>,
): Promise<ActivePackViews> => {
  if (packIds.length === 0) throw new Error('scenario declares no active packs')
  const uniquePackIds = new Set(packIds)
  if (uniquePackIds.size !== packIds.length) {
    const duplicates = packIds.filter((packId, index) => packIds.indexOf(packId) !== index)
    throw new Error(`scenario declares duplicate packs: ${[...new Set(duplicates)].join(', ')}`)
  }
  const packs = await Promise.all(packIds.map(loadUiPack))
  return createActivePackViews(packs)
}
