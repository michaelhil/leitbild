import type { WorldPackView } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { processPlantPackId, processPlantUnitPackDataSchema } from './model.ts'
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
    contributions: ['runtime', 'recording', 'knowledge', 'scenario', 'presentation', 'observation'],
  }),
  runtime: {
    runtimes: [{ id: processPlantSimRuntimeId, version: '1.0.0', label: 'Local process plant runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: processPlantSimRuntimeId,
  },
  presentation: processPlantPresentation,
  procedures: {
    scopeIdForObject: object => {
      const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
      return parsed.success ? String(object.id) : null
    },
    signalReadQuery: (plantId, tags) => ({
      capabilityId: 'world.process-plant.signals.read',
      input: { plantId, evidence: true, signals: tags.map(tag => ({ tagId: tag.id, ...(tag.units === undefined ? {} : { requestedUnit: tag.units }) })) },
    }),
    tagValidationQuery: (plantId, tags) => ({
      capabilityId: 'world.process-plant.procedure-tags.validate',
      input: { plantId, tags: tags.map(tag => ({
        id: tag.id,
        ...(tag.description === undefined ? {} : { description: tag.description }),
        ...(tag.simPath === undefined ? {} : { simPath: tag.simPath }),
        ...(tag.units === undefined ? {} : { units: tag.units }),
        ...(tag.equipment === undefined ? {} : { equipment: tag.equipment }),
        ...(tag.source === undefined ? {} : { source: tag.source }),
        ...(tag.range === undefined ? {} : { range: tag.range }),
      })) },
    }),
    assessmentsQuery: (plantId, assessmentIds) => ({
      capabilityId: 'world.process-plant.assessments.evaluate', input: { plantId, assessmentIds },
    }),
  },
  ui: {
    surfacePanels: [],
    // The display window's header, for a Plant's display: its runtime not started, pending proposals, the procedure its
    // worst safety function calls for, the operations log, the Run's Assistant, its engineering views and the Plant
    // catalog, the Instructor's actions.
    windowTools: async () => await import('./ui/displays/WindowTools.svelte'),
    // A press on a unit's map icon or rail row opens its overview display.
    displayOnPress: true,
  },
} satisfies WorldPackView
