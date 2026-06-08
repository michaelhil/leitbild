import type { LeitbildPack } from '../../core/packs/protocol.ts'
import { droneScenarioSupport } from './scenario.ts'
import { droneUiPack } from './ui-pack.ts'

export const dronePack: LeitbildPack = {
  ...droneUiPack,
  scenario: droneScenarioSupport,
}
