import type { LeitbildPack } from '../../core/packs/protocol.ts'
import { createLeitbildPackDescriptor } from '../../core/packs/protocol.ts'
import { droneScenarioSupport } from './scenario.ts'
import { droneUiPack } from './ui-pack.ts'

export const dronePack: LeitbildPack = {
  ...droneUiPack,
  descriptor: createLeitbildPackDescriptor({
    id: 'drone', version: '1.0.0', name: 'Drone Operations',
    contributions: ['runtime', 'knowledge', 'scenario', 'presentation', 'commands', 'interactions'],
  }),
  scenario: droneScenarioSupport,
}
