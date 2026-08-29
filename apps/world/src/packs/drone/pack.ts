import type { WorldPack } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { droneScenarioSupport } from './scenario.ts'
import { droneUiPack } from './ui-pack.ts'

export const dronePack: WorldPack = {
  ...droneUiPack,
  descriptor: createWorldPackDescriptor({
    id: 'drone', version: '1.0.0', name: 'Drone Operations',
    contributions: ['runtime', 'knowledge', 'scenario', 'presentation', 'commands', 'interactions'],
  }),
  scenario: droneScenarioSupport,
}
