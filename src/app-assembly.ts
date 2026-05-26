import { createCompositePack } from './core/packs/composite.ts'
import type { LeitbildPack } from './core/packs/protocol.ts'
import { ambulancePack } from './packs/ambulance/pack.ts'
import { aviationPack } from './packs/aviation/pack.ts'
import { processPlantPack } from './packs/process-plant/pack.ts'
import { trafficPack } from './packs/traffic/pack.ts'
import { weatherPack } from './packs/weather/pack.ts'

export const leitbildPacks: ReadonlyArray<LeitbildPack> = [
  ambulancePack,
  trafficPack,
  weatherPack,
  processPlantPack,
  aviationPack,
]

export const createLeitbildControlPack = (): LeitbildPack =>
  createCompositePack({
    id: 'leitbild-control',
    name: 'Leitbild Control',
    packs: leitbildPacks,
  })
