import type { WorldPack } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor, emptyPackScenarioConfigSchema } from '../../core/packs/protocol.ts'
import { processPlantPackId } from './model.ts'
import { processPlantPresentation } from './presentation.ts'
import { processPlantSimRuntimeId } from './sim/constants.ts'

/** Browser-only Pack view. Simulation compilation and runtime code stay outside
 * the UI dependency graph. */
export const processPlantUiPack: WorldPack = {
  descriptor: createWorldPackDescriptor({
    id: processPlantPackId,
    version: '1.0.0',
    name: 'Process Plant',
    contributions: ['runtime', 'knowledge', 'presentation'],
  }),
  scenarioConfigSchema: emptyPackScenarioConfigSchema,
  runtime: {
    runtimes: [{ id: processPlantSimRuntimeId, version: '1.0.0', label: 'Local process plant runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: processPlantSimRuntimeId,
  },
  knowledge: { wikiRefs: [{ name: 'Leitbild PWR operations wiki', url: 'https://github.com/michaelhil/leitbild/blob/main/docs/wiki/pwr-ops.md' }] },
  presentation: processPlantPresentation,
}
