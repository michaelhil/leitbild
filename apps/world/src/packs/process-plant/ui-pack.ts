import type { WorldPackView } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { processPlantPackId } from './model.ts'
import { processPlantPresentation } from './presentation.ts'
import { processPlantSimRuntimeId } from './sim/constants.ts'

/** Browser-only Pack view. Simulation compilation and runtime code stay outside
 * the UI dependency graph. */
export const processPlantPackView = {
  descriptor: createWorldPackDescriptor({
    id: processPlantPackId,
    version: '1.0.0',
    name: 'Process Plant',
    description: 'Configurable component-graph process plants with transient dynamics, procedures, controls, and engineering views.',
    contributions: ['runtime', 'recording', 'knowledge', 'scenario', 'presentation'],
  }),
  runtime: {
    runtimes: [{ id: processPlantSimRuntimeId, version: '1.0.0', label: 'Local process plant runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: processPlantSimRuntimeId,
  },
  presentation: processPlantPresentation,
} satisfies WorldPackView
