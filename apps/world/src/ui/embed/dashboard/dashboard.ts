// A Run's shared dashboard as people read and change it (plan v5 R4 B4, A4):
// its view state (a scope, and for the whole Run the collections it offers to
// compare), its embedded view, World's two dashboard routes as a person calls
// them, and the one-press pin the display window offers on any vignette it
// shows. A change names the revision it was read at; one World refuses as stale
// (409) is read again and the person is told, never retried behind their back.
// The main app's display window imports this file: it reaches no vignette
// module and no OpenBridge (T28).
import { EMBEDDED_VIEW_MAX_HEIGHT, embeddedViewEnvelopeSchema, type EmbeddedViewEnvelope } from '@leitbild/contracts'
import { z } from 'zod'
import type { dashboardChangedSchema, dashboardReadingSchema } from '../../../core/api/display-capabilities.ts'
import type { SimulationRunId } from '../../../core/model/index.ts'
import { DASHBOARD_VIEW_TYPE } from '../../process-display/display-window-messages.ts'
import { withActiveRoleSet } from '../../roles/role-session.ts'
import { workspaceApiPath } from '../../workspace-context.ts'

/** A presentation category with several observed assets, as the rail groups them: a dashboard of the whole Run offers to compare its members. */
const collectionSchema = z.object({ category: z.string().min(1).max(128), label: z.string().min(1).max(120), count: z.number().int().min(2) }).strict()
const scopeSchema = z.union([
  z.literal('run'),
  z.object({ subject: z.string().min(1).max(160) }).strict(),
  z.object({ of: z.object({ category: z.string().min(1).max(128) }).strict() }).strict(),
])
export const dashboardStateSchema = z.object({
  scope: scopeSchema, collections: z.array(collectionSchema).max(8).optional(),
  /** A section to show and mark first, by its pin's id or its title (a line an answer cites, R4 §2.6). */
  focus: z.string().min(1).max(80).optional(),
}).strict()
  .refine(state => state.collections === undefined || state.scope === 'run', { message: 'only a dashboard of the whole Run offers collections' })
export type DashboardState = z.output<typeof dashboardStateSchema>
export type DashboardScope = DashboardState['scope']
export type DashboardCollection = z.output<typeof collectionSchema>

export type DashboardReading = z.output<typeof dashboardReadingSchema>
export type DashboardSection = DashboardReading['sections'][number]
export type DashboardChanged = z.output<typeof dashboardChangedSchema>

/** A dashboard holds at most this many pins (A4). */
export const DASHBOARD_PINS = 8
export const REVISION_CONFLICT = 'dashboard_revision_conflict'

/** A dashboard of one scope as the window frames it: drawn for its frame, live, about the Run. */
export const dashboardEnvelope = (config: {
  readonly workspaceId: string
  readonly simulationRunId: string
  readonly title: string
  readonly state: DashboardState
}): EmbeddedViewEnvelope => embeddedViewEnvelopeSchema.parse({
  moduleId: 'world',
  subject: { workspaceId: config.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.simulationRunId },
  viewType: DASHBOARD_VIEW_TYPE,
  title: config.title,
  height: EMBEDDED_VIEW_MAX_HEIGHT,
  state: JSON.stringify(dashboardStateSchema.parse(config.state)),
})

/** World's answer to a dashboard call: its result, or its refusal with the revision a stale change met. */
export type DashboardAnswer<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }

const call = async <T>(runId: SimulationRunId, action: 'read' | 'update', body: unknown): Promise<DashboardAnswer<T>> => {
  const response = await fetch(withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(runId)}/displays/dashboard/${action}`)), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await response.text()
  let answer: { readonly result?: T; readonly error?: { readonly code?: string; readonly message?: string } } = {}
  try { answer = JSON.parse(text) as typeof answer } catch (error) {
    // Not JSON (a proxy's page): the status says what happened.
    if (!(error instanceof SyntaxError)) throw error
  }
  if (response.ok && answer.result !== undefined) return { ok: true, result: answer.result }
  return { ok: false, status: response.status, code: answer.error?.code ?? `http_${response.status}`, message: answer.error?.message ?? `World answered HTTP ${response.status}` }
}

export const readDashboard = (runId: SimulationRunId, scope: DashboardScope): Promise<DashboardAnswer<DashboardReading>> => call(runId, 'read', { scope })

export const changeDashboard = (runId: SimulationRunId, change: {
  readonly scope: DashboardScope
  readonly expectedRevision: number
  readonly pin?: ReadonlyArray<{ readonly state: string }>
  readonly unpin?: ReadonlyArray<string>
}): Promise<DashboardAnswer<DashboardChanged>> => call(runId, 'update', change)

/** What a dashboard holds now, in words: its pins, or World's default. */
export const holdsText = (reading: Pick<DashboardReading, 'stored' | 'sections' | 'revision'>): string =>
  reading.stored ? `${reading.sections.length} of ${DASHBOARD_PINS} pins, revision ${reading.revision}` : `World's default, revision ${reading.revision}`

/** A change World refused as stale: what the person is told once the dashboard was read again (`again`, or why it could not be). */
export const staleText = (what: string, again: DashboardAnswer<DashboardReading>): string =>
  `${what}: the dashboard changed since it was read. ${again.ok ? `It was read again (${holdsText(again.result)})` : `Reading it again failed: ${again.message}`}; try again if you still want to.`

/**
 * Pins a vignette a person sees to the Run's dashboard, in one press: reads the dashboard's revision and pins the
 * vignette's state naming it. A dashboard that changed in between is read again and the person is told. Resolves to
 * what to tell them.
 */
export const pinToRunDashboard = async (runId: SimulationRunId, view: { readonly state: string; readonly title: string }): Promise<string> => {
  const read = await readDashboard(runId, 'run')
  if (!read.ok) return `${view.title} was not pinned: ${read.message}`
  const changed = await changeDashboard(runId, { scope: 'run', expectedRevision: read.result.revision, pin: [{ state: view.state }] })
  if (changed.ok) {
    const count = `${changed.result.pins.length} of ${DASHBOARD_PINS} pins`
    return read.result.stored ? `${view.title} is pinned to the dashboard (${count})` : `${view.title} is pinned to the dashboard (${count}); it shows its pins now, in place of World's default`
  }
  return changed.code === REVISION_CONFLICT ? staleText(`${view.title} was not pinned`, await readDashboard(runId, 'run')) : `${view.title} was not pinned: ${changed.message}`
}
