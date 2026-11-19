// What the Workspace page keeps open (the Run in `?world`, the conversation
// in `?agents`) once it has read the Workspace's Resources. A Run or room the
// list no longer holds closes (deleted here or elsewhere), but only when its
// Module answered: a Module that failed to answer never closes what it owns.
// A room that does not serve the open Run closes too.

import { definitionIdSchema, resourceIdSchema, type ModuleQueryOutcome, type ModuleResourceDescriptor } from '@leitbild/contracts'
import { roomServesRun } from './run-room-scope.ts'

export interface OpenSelection {
  readonly world: string | null
  readonly agents: string | null
  readonly agentsVisible: boolean
  readonly planning?: string | null
}

export const planningDemoQuery = (selection: URLSearchParams): string | null => {
  if (selection.get('planning') !== 'demo') return null
  const definition = definitionIdSchema.safeParse(selection.get('definition'))
  const run = resourceIdSchema.safeParse(selection.get('run'))
  if (!definition.success || !run.success) return null
  const option = resourceIdSchema.safeParse(selection.get('option'))
  return new URLSearchParams({ demo: definition.data, run: run.data, ...(option.success ? { option: option.data } : {}) }).toString()
}

export const keptSelection = (
  selection: OpenSelection,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
  modules: ReadonlyArray<ModuleQueryOutcome>,
): OpenSelection => {
  const answered = (moduleId: string): boolean => !modules.some(outcome => outcome.moduleId === moduleId && outcome.status === 'failed')
  const run = resources.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === selection.world)
  const room = resources.find(resource => resource.ref.type === 'agents.room' && resource.ref.id === selection.agents)
  const world = selection.world !== null && run === undefined && answered('world') ? null : selection.world
  const roomGone = selection.agents !== null && room === undefined && answered('agents')
  const roomOutsideRun = run !== undefined && room !== undefined && !roomServesRun(room, run)
  const planning = selection.planning === 'library' || selection.planning === 'demo'
    ? modules.some(module => module.moduleId === 'planning') ? selection.planning : null
    : selection.planning !== undefined && selection.planning !== null
      && !resources.some(resource => resource.ref.type === 'planning.plan' && resource.ref.id === selection.planning)
      && answered('planning') ? null : selection.planning
  const planningSelection = 'planning' in selection ? { planning: planning ?? null } : {}
  return roomGone || roomOutsideRun
    ? { world, agents: null, agentsVisible: false, ...planningSelection }
    : { world, agents: selection.agents, agentsVisible: selection.agentsVisible, ...planningSelection }
}
