import type { WorldPack } from '../../core/packs/protocol.ts'
import { situationConfigSchema } from './model.ts'
import { situationMonitorPackView } from './ui-pack.ts'

export const situationMonitorPack: WorldPack = {
  descriptor: situationMonitorPackView.descriptor,
  runtime: situationMonitorPackView.runtime!,
  presentation: situationMonitorPackView.presentation,
  ui: situationMonitorPackView.ui!,
  scenarioConfigSchema: situationConfigSchema,
  authoring: { itemTypes: [], configFields: [] },
}
