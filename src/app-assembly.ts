import { createCompositePack } from './core/packs/composite.ts'
import type { LeitbildPack } from './core/packs/protocol.ts'
import { ambulancePack } from './packs/ambulance/pack.ts'
import { trafficPack } from './packs/traffic/pack.ts'
import { weatherPack } from './packs/weather/pack.ts'

export const leitbildPacks: ReadonlyArray<LeitbildPack> = [
  ambulancePack,
  trafficPack,
  weatherPack,
]

export const createLeitbildControlPack = (): LeitbildPack =>
  createCompositePack({
    id: 'leitbild-control',
    name: 'Leitbild Control',
    packs: leitbildPacks,
  })
