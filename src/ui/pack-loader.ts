import { createCompositePack } from '../core/packs/composite.ts'
import type { LeitbildPack } from '../core/packs/protocol.ts'

type PackLoader = () => Promise<LeitbildPack>
type KnownUiPackId = 'ambulance' | 'traffic' | 'weather' | 'drone' | 'process-plant' | 'aviation' | 'electric-grid'

const packLoaders: Record<KnownUiPackId, PackLoader> = {
  ambulance: async () => (await import('../packs/ambulance/pack.ts')).ambulancePack,
  traffic: async () => (await import('../packs/traffic/pack.ts')).trafficPack,
  weather: async () => (await import('../packs/weather/pack.ts')).weatherPack,
  drone: async () => (await import('../packs/drone/pack.ts')).dronePack,
  'process-plant': async () => (await import('../packs/process-plant/pack.ts')).processPlantPack,
  aviation: async () => (await import('../packs/aviation/pack.ts')).aviationPack,
  'electric-grid': async () => (await import('../packs/electric-grid/pack.ts')).electricGridPack,
}

const loadedPacks = new Map<string, LeitbildPack>()

const isKnownUiPackId = (packId: string): packId is KnownUiPackId =>
  Object.hasOwn(packLoaders, packId)

export const loadUiPack = async (packId: string): Promise<LeitbildPack> => {
  const loaded = loadedPacks.get(packId)
  if (loaded) return loaded
  if (!isKnownUiPackId(packId)) throw new Error(`scenario references unknown UI pack: ${packId}`)
  const pack = await packLoaders[packId]()
  if (pack.id !== packId) throw new Error(`UI pack loader for ${packId} returned ${pack.id}`)
  loadedPacks.set(packId, pack)
  return pack
}

export const createScenarioControlPack = async (
  packIds: ReadonlyArray<string>,
): Promise<LeitbildPack> => {
  if (packIds.length === 0) throw new Error('scenario declares no active packs')
  const uniquePackIds = new Set(packIds)
  if (uniquePackIds.size !== packIds.length) {
    const duplicates = packIds.filter((packId, index) => packIds.indexOf(packId) !== index)
    throw new Error(`scenario declares duplicate packs: ${[...new Set(duplicates)].join(', ')}`)
  }
  const packs = await Promise.all(packIds.map(loadUiPack))
  return createCompositePack({
    id: `scenario-control:${packIds.join('+')}`,
    name: 'Scenario Control',
    packs,
  })
}
