// Planning's place in the Workspace page. The Host gives Planning its frame address; every address Planning
// builds for the Host's page keeps the Run Planning is shown beside, so no link leaves that Run.
import { resourceIdSchema } from '@leitbild/contracts'

export interface PlanningQuery {
  readonly plan: string | null
  readonly demo: string | null
  /** The guided demo's Run: `run` given with `demo`. */
  readonly demoRun: string | null
  /** The Run Planning is shown beside: `run` given without `demo`. */
  readonly besideRun: string | null
  /** `run` was given without `demo` but names no Run: Planning says so, never shows all plans instead. */
  readonly unreadableRun: boolean
  readonly agents: string | null
  readonly option: string | null
}

const resourceId = (value: string | null): string | null => {
  const parsed = resourceIdSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Reads the Planning frame's query, as the Host builds it. */
export const readPlanningQuery = (search: string): PlanningQuery => {
  const query = new URLSearchParams(search)
  const demo = query.get('demo')
  const run = resourceId(query.get('run'))
  return {
    plan: query.get('plan'),
    demo,
    demoRun: demo === null ? null : run,
    besideRun: demo === null ? run : null,
    unreadableRun: demo === null && query.get('run') !== null && run === null,
    agents: resourceId(query.get('agents')),
    option: resourceId(query.get('option')),
  }
}

/**
 * The Host's addresses Planning links to. Beside a Run each one names it as `world`; a plan linked to another
 * Run opens beside that one. The open Assistant conversation (`agents`) is kept on each, as before.
 */
export const createHostAddresses = (workspaceId: string, query: Pick<PlanningQuery, 'agents' | 'besideRun'>) => {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}`
  const room = query.agents === null ? {} : { agents: query.agents }
  const at = (fields: Readonly<Record<string, string>>): string => {
    const selection = new URLSearchParams({ ...room, ...fields })
    return `${path}${selection.size === 0 ? '' : `?${selection}`}`
  }
  return {
    /** The Workspace page with Planning's selection ('library' or a plan id), beside the Run when there is one. */
    workspace: (planning?: string): string => at({ ...(query.besideRun === null ? {} : { world: query.besideRun }), ...(planning === undefined ? {} : { planning }) }),
    /** A plan beside the Run it is linked to. */
    planBeside: (plan: string, run: string): string => at({ world: run, planning: plan }),
    /** A Run's map, at an object, element or option: the guided demo pages' links. */
    world: (run: string, objectId?: string, elementId?: string, option?: string): string =>
      at({ world: run, ...(objectId === undefined ? {} : { focus: objectId }), ...(elementId === undefined ? {} : { element: elementId }), ...(option === undefined ? {} : { option }) }),
  }
}
export type HostAddresses = ReturnType<typeof createHostAddresses>
