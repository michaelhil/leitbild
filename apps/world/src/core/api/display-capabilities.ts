/**
 * World's display surface (architecture A6): the Assistant's display
 * Capabilities, `world.simulation-run.display.compose` and the dashboard's
 * read and update (A4), and the person routes that open, sample and default a
 * vignette and read and change a dashboard. Every one reads as its caller.
 * The routes take a vignette's state and read only what it names; none takes
 * free refs. Rows become pixels here, at this boundary, so features/displays
 * stays pixel-free.
 */
import {
  displayCardSchema, EMBEDDED_VIEW_MAX_HEIGHT, EMBEDDED_VIEW_MIN_HEIGHT, EMBEDDED_VIEW_STATE_MAX_LENGTH, embeddedViewPublicationSchema,
  moduleIdSchema, type ModuleCapabilityInvocation,
} from '@leitbild/contracts'
import type { CapabilityRegistration } from '@leitbild/module-runtime'
import { z } from 'zod'
import { composeDefault, composeVignette, type ComposeOutcome } from '../../features/displays/compose/compose.ts'
import { vignetteStateSchema, type VignetteState } from '../../features/displays/compose/model.ts'
import { isIssue } from '../../features/displays/compose/resolve.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../../features/displays/compose/view.ts'
import { changeDashboard, readDashboard, scopeInputSchema, type DashboardSection } from '../../features/displays/dashboards/dashboards.ts'
import { dashboardScopeSchema, DASHBOARD_MAX_PINS, pinIdSchema } from '../../features/displays/dashboards/store.ts'
import { requestPort } from '../../features/displays/observation/port.ts'
import { recordedHoldMs } from '../../features/historian/policy.ts'
import { capabilityJsonSchema } from '../../simulation/capabilities.ts'
import { VIGNETTE_ROW_PX } from '../../ui/embed/vignette/grid.ts'
import { observableRefSchema } from '../model/alerts.ts'
import type { ObjectId } from '../model/index.ts'
import { displaySpecSchema, subjectSchema } from '../observation/spec.ts'
import type { Actor } from '../simulation-runs/actors.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../simulation-runs/runtime.ts'
import { apiError, issuesReason, json } from './responses.ts'

export const VIGNETTE_VIEW_TYPE = 'display.vignette'
const MODULE_ID = moduleIdSchema.parse('world')

/** A frame of `rows` grid rows, within what an embedder reserves. */
export const vignetteHeight = (rows: number): number => Math.min(EMBEDDED_VIEW_MAX_HEIGHT, Math.max(EMBEDDED_VIEW_MIN_HEIGHT, rows * VIGNETTE_ROW_PX))

const composedSchema = z.object({ view: embeddedViewPublicationSchema, card: displayCardSchema }).strict()

/**
 * A loaded Run as the composer reads it, as this caller, for one request: its objects, Packs and clock, the Scenario
 * connections the Run was loaded with (checked once at load, never re-read per call), what the caller may not inspect,
 * and a port that reads each value once for the request (requestPort).
 */
export const displayRunOf = async (registry: SimulationRunRegistry, runtime: SimulationRunRuntime, actor: Actor, denied: ReadonlySet<string>): Promise<ViewRun> => {
  // The Run and its Scenario are one load: after a reset or copy reload it, this runtime is not the one loaded.
  if (registry.get(runtime.id) !== runtime) throw Object.assign(new Error(`Simulation Run ${runtime.id} was reloaded; ask again`), { code: 'simulation_run_closed' })
  const snapshot = runtime.snapshot()
  return {
    objects: snapshot.objects, denied, packs: runtime.packs(), port: requestPort(runtime.observations(actor)), clock: snapshot.clock,
    connections: registry.loadedCompiledScenario(runtime.id).connections,
    // The Historian's record, from one hold before `from`, so the value held into the window's start is drawn; with that hold.
    series: (seriesId, from, to) => {
      const page = runtime.recordedSamples({ mode: 'raw', seriesId, from: new Date(Date.parse(from) - recordedHoldMs).toISOString(), to, timeAxis: 'simulation', limit: 2_000 })
      return {
        holdMs: recordedHoldMs,
        points: page.mode !== 'raw' ? [] : page.samples.flatMap(sample => typeof sample.value === 'number' || typeof sample.value === 'boolean'
          ? [{ t: Date.parse(sample.simulationTime ?? sample.observedAt), v: Number(sample.value) }] : []).reverse(),
      }
    },
  }
}

/** A composed vignette as an embedded view and its card, or the composer's refusal with every issue. */
export const composedResponse = (outcome: ComposeOutcome): Response => {
  if (!outcome.ok) return apiError(422, outcome.issues[0]!.code, issuesReason(outcome.issues), { issues: outcome.issues })
  const state = JSON.stringify(outcome.state)
  return json({ result: composedSchema.parse({ view: { viewType: VIGNETTE_VIEW_TYPE, title: outcome.state.title, height: vignetteHeight(outcome.rows), state }, card: outcome.card }) })
}

const stateSchema = z.string().min(2).max(EMBEDDED_VIEW_STATE_MAX_LENGTH).transform((text, ctx): VignetteState => {
  const parsed = vignetteStateSchema.safeParse((() => { try { return JSON.parse(text) as unknown } catch { return undefined } })())
  if (!parsed.success) { ctx.addIssue({ code: 'custom', message: 'not a vignette state' }); return z.NEVER }
  return parsed.data
})
export const displayRouteInputs = {
  view: z.object({ state: stateSchema }).strict(),
  sample: z.object({ state: stateSchema, history: z.object({ fromMs: z.number().int().nonnegative(), refs: z.array(observableRefSchema).min(1).max(32).optional() }).strict().optional() }).strict(),
  default: z.object({ subject: subjectSchema }).strict(),
} as const

/** The person routes: POST displays/{view,sample,default}, each read as the caller. */
export const handleDisplayRoute = async (kind: string, body: unknown, run: ViewRun): Promise<Response | null> => {
  if (kind === 'view') return json({ view: await compileVignette(run, displayRouteInputs.view.parse(body).state) })
  if (kind === 'sample') {
    const input = displayRouteInputs.sample.parse(body)
    return json({ sample: await sampleVignette(run, input.state, input.history) })
  }
  if (kind === 'default') return composedResponse(await composeDefault(run, displayRouteInputs.default.parse(body).subject))
  return null
}

const byOf = z.enum(['agent', 'person'])
/** A pin as its caller gives it: a spec, as display.compose takes it, or the state of a view it holds. */
const pinInputSchema = z.union([z.object({ spec: displaySpecSchema }).strict(), z.object({ state: stateSchema }).strict()])
export const dashboardInputs = {
  read: z.object({ scope: scopeInputSchema }).strict(),
  update: z.object({
    scope: scopeInputSchema, expectedRevision: z.number().int().nonnegative(),
    pin: z.array(pinInputSchema).max(2).default([]), unpin: z.array(pinIdSchema).max(DASHBOARD_MAX_PINS).default([]),
  }).strict()
    .refine(input => input.pin.length + input.unpin.length > 0, { message: 'pin or unpin at least one' })
    .refine(input => new Set(input.unpin).size === input.unpin.length, { message: 'unpin each pin once', path: ['unpin'] }),
} as const
/** A section: a pin (its id and who pinned it) or a default section; its view where the caller draws it; why a pin no longer reads. */
const sectionSchema = z.object({
  id: pinIdSchema.optional(), by: byOf.optional(), title: z.string().min(1).max(80),
  view: embeddedViewPublicationSchema.optional(),
  refused: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(300) }).strict().optional(),
}).strict()
export const dashboardReadingSchema = z.object({
  scope: dashboardScopeSchema, revision: z.number().int().nonnegative(), stored: z.boolean(),
  sections: z.array(sectionSchema).max(DASHBOARD_MAX_PINS), more: z.number().int().positive().optional(), card: displayCardSchema,
}).strict()
export const dashboardChangedSchema = z.object({
  scope: dashboardScopeSchema, revision: z.number().int().positive(),
  pins: z.array(z.object({ id: pinIdSchema, by: byOf, title: z.string().min(1).max(80) }).strict()).max(DASHBOARD_MAX_PINS),
}).strict()

/** A section on the wire; its view only for a person, who draws it (the Assistant reads the card and presents no state). */
const sectionOut = (section: DashboardSection, drawn: boolean) => ({
  ...(section.id === undefined ? {} : { id: section.id, by: section.by }), title: section.title,
  ...(section.refused === undefined ? {} : { refused: section.refused }),
  ...(drawn && section.state !== undefined ? { view: { viewType: VIGNETTE_VIEW_TYPE, title: section.state.title, height: vignetteHeight(section.rows!), state: JSON.stringify(section.state) } } : {}),
})

/** One dashboard call: the Run as its caller reads it, and who calls, a person or the Assistant. */
export interface DashboardCall {
  readonly registry: SimulationRunRegistry
  readonly runtime: SimulationRunRuntime
  readonly run: ViewRun
  readonly by: 'agent' | 'person'
}

/** D-31: a Run whose roles see different sides offers no dashboard, so one never carries a side's names to the other. */
const sidedRefusal = (runtime: SimulationRunRuntime): Response | null => runtime.roles()?.sides === undefined ? null
  : apiError(403, 'dashboard_sided_run', 'Dashboards are not offered in a Run whose roles see different sides: one dashboard would carry one side\'s names to the other')

export const handleDashboard = async (kind: 'read' | 'update', body: unknown, call: DashboardCall): Promise<Response> => {
  const refused = sidedRefusal(call.runtime)
  if (refused !== null) return refused
  const file = call.registry.dashboards(call.runtime.id)
  if (kind === 'read') {
    const reading = await readDashboard(call.run, file, dashboardInputs.read.parse(body).scope)
    if (isIssue(reading)) return apiError(422, reading.code, issuesReason([reading]), { issues: [reading] })
    return json({ result: dashboardReadingSchema.parse({ ...reading, sections: reading.sections.map(section => sectionOut(section, call.by === 'person')) }) })
  }
  const outcome = await changeDashboard(call.run, file, call.by, dashboardInputs.update.parse(body))
  if (!outcome.ok) return apiError(outcome.status, outcome.code, typeof outcome.reason === 'string' ? outcome.reason : issuesReason(outcome.reason), outcome.details)
  return json({ result: dashboardChangedSchema.parse({ scope: outcome.scope, revision: outcome.revision, pins: outcome.pins }) })
}

type Invocation = ModuleCapabilityInvocation
/** The Assistant's display Capabilities; the API supplies how a Resource, an actor and the denied objects come from an invocation. */
export const displayCapabilities = (ports: {
  readonly runOf: (registry: SimulationRunRegistry, invocation: Invocation) => Promise<{ readonly runtime: SimulationRunRuntime; readonly actor: Actor; readonly denied: ReadonlySet<ObjectId | string> }>
}): ReadonlyArray<CapabilityRegistration<SimulationRunRegistry, Response>> => [{
  descriptor: {
    id: 'world.simulation-run.display.compose', moduleId: MODULE_ID, kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' },
    title: 'Compose a vignette',
    description: 'Composes one live vignette for an answer from up to 6 subjects (exact refs from the Run context, objectId#tag-or-label, an object id for its lead values, a Scenario connection id, or {of: {category}} for things that come and go) and up to 4 views (trend, values, alerts, topology, map); no views gives each subject\'s World default. An alerts view with scope run shows every alert of the Run, each object\'s worst first as the Run context ranks them, and needs no subject. World draws it from what Packs declare; never pass numbers, limits, colours or coordinates. Returns the view and a card whose keyed items an answer cites as ⟦k1⟧. An unknown name is refused with the nearest names.',
    searchTerms: ['show display', 'vignette', 'compose display', 'show trend', 'show alarms', 'show on map'],
    risk: 'read', idempotent: true, publishes: ['embedded-view'],
    inputSchema: capabilityJsonSchema(displaySpecSchema), outputSchema: capabilityJsonSchema(composedSchema),
  },
  invoke: async (registry: SimulationRunRegistry, invocation: Invocation): Promise<Response> => {
    const spec = displaySpecSchema.parse(invocation.input)
    const { runtime, actor, denied } = await ports.runOf(registry, invocation)
    return composedResponse(await composeVignette(await displayRunOf(registry, runtime, actor, denied), spec))
  },
}, ...(['read', 'update'] as const).map((kind): CapabilityRegistration<SimulationRunRegistry, Response> => ({
  descriptor: kind === 'read' ? {
    id: 'world.simulation-run.dashboard.read', moduleId: MODULE_ID, kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' },
    title: 'Read a dashboard',
    description: 'The Run\'s shared live dashboard for one scope: "run", {subject} (one object, by any name compose takes) or {of: {category}} (a collection). Its sections are the pins people and the Assistant put on it, each with its pin id, or World\'s default while none is pinned (the Run: each observed asset\'s leads; a subject: its default; a collection: its members\' leads side by side); a pin that no longer reads is refused alone. Returns the revision an update names and one card of what the sections show, cited as ⟦k1⟧. Refused in a Run whose roles see different sides.',
    searchTerms: ['dashboard', 'board', 'pinned displays', 'what is on the dashboard'],
    risk: 'read', idempotent: true,
    inputSchema: capabilityJsonSchema(dashboardInputs.read), outputSchema: capabilityJsonSchema(dashboardReadingSchema),
  } : {
    id: 'world.simulation-run.dashboard.update', moduleId: MODULE_ID, kind: 'command', scope: { kind: 'resource', resourceType: 'world.simulation-run' },
    title: 'Change a dashboard',
    description: 'Pins at most 2 vignettes on one scope\'s dashboard ({spec}: as display.compose takes it, composed now; {state}: a view\'s state) and unpins at most 8 by pin id; a dashboard holds 8 pins, and its first pin replaces World\'s default. Name the revision dashboard.read gave: a stale one is refused with the current revision. Returns the new revision and the pins.',
    searchTerms: ['pin to dashboard', 'unpin', 'change dashboard', 'add to board'],
    risk: 'write', idempotent: false,
    inputSchema: capabilityJsonSchema(dashboardInputs.update), outputSchema: capabilityJsonSchema(dashboardChangedSchema),
  },
  invoke: async (registry: SimulationRunRegistry, invocation: Invocation): Promise<Response> => {
    const { runtime, actor, denied } = await ports.runOf(registry, invocation)
    const run = await displayRunOf(registry, runtime, actor, denied)
    return handleDashboard(kind, invocation.input, { registry, runtime, run, by: invocation.access.actor.kind === 'ai' ? 'agent' : 'person' })
  },
}))]
