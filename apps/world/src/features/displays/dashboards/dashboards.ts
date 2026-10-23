/**
 * Dashboards (A4): one shared live board per scope of a Run (the Run, one object, or a live collection of one
 * presentation category), read and changed as the caller. Its sections are its pins, or World's default while none
 * is pinned: the Run's observed assets' leads, the object's default, the collection's members' leads side by side.
 * Every section is a vignette from the one composer, sampled live like any other, and a pin that no longer reads is
 * refused alone. People and the Assistant change a dashboard the same way, naming the revision they read.
 */
import { randomUUID } from 'node:crypto'
import type { DisplayCard } from '@leitbild/contracts'
import { z } from 'zod'
import { refObjectId } from '../../../core/model/alerts.ts'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import { selectorSchema, type DisplaySpec } from '../../../core/observation/spec.ts'
import { assembleCard } from '../compose/card.ts'
import { cardOfState, composeDefault, composeLeads, composeVignette, stateRows, type ComposeOutcome } from '../compose/compose.ts'
import { declarationOf, declaredRefs, visibleObject } from '../compose/declared.ts'
import type { ComposeIssue, ComposeIssueCode, VignetteState } from '../compose/model.ts'
import { isIssue, resolveSubject, type ComposeRun, type Subject } from '../compose/resolve.ts'
import { overviewOf, scopeWithin, topologyOf } from '../compose/topology.ts'
import { membersOf, readsOf } from '../compose/view.ts'
import { observationProviderFor } from '../observation/port.ts'
import { DASHBOARD_MAX_PINS, DASHBOARD_MAX_SCOPES, scopeKey, type DashboardFile, type DashboardPin, type DashboardScope, type DashboardsFile } from './store.ts'

/** A scope as a caller names it: the Run, one object by any name the composer takes, or a collection. */
export const scopeInputSchema = z.union([
  z.literal('run'),
  z.object({ subject: z.string().min(1).max(160) }).strict(),
  z.object({ of: selectorSchema }).strict(),
])
export type ScopeInput = z.output<typeof scopeInputSchema>

export interface DashboardSection {
  /** A pin's id and who pinned it; a default section has neither. */
  readonly id?: string
  readonly by?: DashboardPin['by']
  readonly title: string
  /** The vignette it draws and samples, in its rows; absent where it is refused. */
  readonly state?: VignetteState
  readonly rows?: number
  readonly refused?: { readonly code: ComposeIssueCode; readonly message: string }
}
export interface DashboardReading {
  readonly scope: DashboardScope
  /** What a change names; 0 for a scope never changed. */
  readonly revision: number
  /** The sections are its pins; otherwise World's default. */
  readonly stored: boolean
  readonly sections: ReadonlyArray<DashboardSection>
  /** Assets or members the default leaves out, beyond its eight sections. */
  readonly more?: number
  /** One card of what the sections show now, for the Assistant (≤ 48 items). */
  readonly card: DisplayCard
}
type Built = DashboardSection & { readonly card?: DisplayCard }

const resolveScope = async (run: ComposeRun, input: ScopeInput): Promise<DashboardScope | ComposeIssue> => {
  if (input === 'run') return 'run'
  if ('of' in input) {
    const collection = await resolveSubject(run, { of: input.of }, 'scope')
    return isIssue(collection) ? collection : { of: (collection as Extract<Subject, { kind: 'collection' }>).of }
  }
  const subject = await resolveSubject(run, input.subject, 'scope.subject')
  if (isIssue(subject)) return subject
  if (subject.kind === 'object') return { objectId: subject.objectId }
  return { path: 'scope.subject', code: 'unknown_name', message: `"${input.subject}" names ${subject.kind === 'element' ? 'an element' : subject.kind === 'observable' ? 'a value' : 'a connection'}, not an object: a subject's dashboard is about one object` }
}

/**
 * What an object's drawing writes on its parallel parts, which its Pack keeps on their symbols and out of its leads: the
 * parts its declared overview draws that stand in declared groups, but those whose symbol draws their state (a switch,
 * a mover). One list a class, each part's readings, so the composer sets each as a table of a line a part.
 */
const partsOf = async (run: ComposeRun, objectId: ObjectId): Promise<ReadonlyArray<ReadonlyArray<string>>> => {
  const graph = await topologyOf(run, objectId)
  const overview = graph === null ? null : overviewOf(graph)
  const declaration = overview === null ? null : await declarationOf(run, objectId)
  if (graph === null || overview === null || declaration === null) return []
  const byClass = new Map<string, { parts: number; refs: string[] }>()
  for (const node of graph.nodes) {
    if (!overview.nodes.includes(node.id) || node.class === 'switch' || node.class === 'mover') continue
    const element = declaration.elements.find(entry => entry.id === (node.element ?? node.id))
    if (element?.group === undefined) continue
    const parts = byClass.get(element.class) ?? { parts: 0, refs: [] }
    byClass.set(element.class, { parts: parts.parts + 1, refs: [...parts.refs, ...node.bindings.map(binding => binding.ref)] })
  }
  return [...byClass.values()].filter(entry => entry.parts > 1).map(entry => [...new Set(entry.refs)].slice(0, 16))
}

const sectionOf = (title: string, outcome: ComposeOutcome): Built => outcome.ok
  ? { title: outcome.state.title, state: outcome.state, rows: outcome.rows, card: outcome.card }
  : { title: title.slice(0, 80), refused: { code: outcome.issues[0]!.code, message: outcome.issues.map(issue => issue.message).join('; ').slice(0, 300) } }

/** An object's leads: what its Pack leads with each sample, and what its drawing writes on its parallel parts. */
const leadsOf = async (run: ComposeRun, object: OperationalObject): Promise<Built> => sectionOf(object.label, await composeLeads(run, object.id, await partsOf(run, object.id)))

/**
 * World's default, never stored. The Run: each observed asset's leads, in Run order. A subject: its default. A
 * collection: its observed members' leads side by side, in Run order (a section's place never follows its alerts); a
 * collection with none observed, its own default (its table, alerts and map). At most eight sections; the rest counted.
 */
const defaultsOf = async (run: ComposeRun, scope: DashboardScope, input: ScopeInput): Promise<{ readonly sections: ReadonlyArray<Built>; readonly more: number }> => {
  if (scope !== 'run' && 'objectId' in scope) return { sections: [sectionOf(visibleObject(run, scope.objectId)!.label, await composeDefault(run, scope.objectId))], more: 0 }
  const observed = observationProviderFor(run.packs)
  const members = scope === 'run' ? null : new Set(membersOf(run, scope.of).map(object => object.id))
  const objects = run.objects.filter(object => visibleObject(run, object.id) !== undefined && (members === null ? observed(object) !== undefined : members.has(object.id)))
  const shown = objects.filter(object => observed(object) !== undefined)
  if (members !== null && shown.length === 0 && input !== 'run' && 'of' in input) return { sections: [sectionOf(input.of.category, await composeDefault(run, { of: input.of }))], more: 0 }
  const sections: Built[] = []
  for (const object of shown.slice(0, DASHBOARD_MAX_PINS)) sections.push(await leadsOf(run, object))
  return { sections, more: objects.length - sections.length }
}

/**
 * Why a stored state no longer reads for this caller, or null: an object it names gone or hidden from the caller, a value
 * no longer declared, a category no Pack presents, a drawing that cannot be scoped.
 */
export const unresolved = async (run: ComposeRun, state: VignetteState): Promise<ComposeIssue | null> => {
  const { refs, objectIds } = readsOf(state)
  const hidden = [...objectIds, ...refs.map(refObjectId)].find(id => run.denied.has(id))
  if (hidden !== undefined) return { path: 'spec', code: 'agent_access_restricted', message: `AI inspection access is restricted for: ${hidden}` }
  const gone = objectIds.find(id => visibleObject(run, id) === undefined)
  if (gone !== undefined) return { path: 'spec', code: 'unknown_name', message: `${gone} is no longer in this Run` }
  const declared = await declaredRefs(run, refs)
  const undeclared = refs.find(ref => !declared.has(ref))
  if (undeclared !== undefined) return { path: 'spec', code: 'unknown_name', message: `${undeclared} is not declared in this Run` }
  for (const view of state.views) {
    const of = view.kind === 'collection' || view.kind === 'map' ? view.of : undefined
    if (of !== undefined && !run.packs.some(pack => pack.descriptor.id === of.packId && pack.presentation.categories.some(category => category.id === of.categoryId))) {
      return { path: 'spec', code: 'unknown_name', message: `No Pack in this Run presents the category ${of.categoryId} (${of.packId})` }
    }
    if (view.kind !== 'topology') continue
    const graph = await topologyOf(run, view.objectId)
    const scoped = graph === null ? null : scopeWithin(graph, view.request)
    if (scoped?.ok !== true) return { path: 'spec', code: 'not_observed', message: `${view.objectId}'s drawing cannot be drawn now (${scoped === null ? 'no topology' : scoped.reason})` }
  }
  return null
}

const pinnedOf = async (run: ComposeRun, pin: DashboardPin): Promise<Built> => {
  const issue = await unresolved(run, pin.spec)
  return issue === null
    ? { id: pin.id, by: pin.by, title: pin.spec.title, state: pin.spec, rows: await stateRows(run, pin.spec), card: await cardOfState(run, pin.spec) }
    : { id: pin.id, by: pin.by, title: pin.spec.title, refused: { code: issue.code, message: issue.message } }
}

/**
 * The sections' cards as one, read now, re-keyed and capped: each section's first item, then each one's second, so the
 * cap leaves every section its leading items and side-by-side sections read as a comparison; each adjustment says its
 * section.
 */
const cardOf = (run: ComposeRun, sections: ReadonlyArray<Built>): DisplayCard => {
  const cards = sections.flatMap(section => section.card === undefined ? [] : [{ title: section.title, card: section.card }])
  const lists = cards.map(({ card }) => card.items.map(({ key: _key, ...item }) => item))
  const at = run.clock === undefined ? { at: new Date().toISOString(), clock: 'wall' as const } : { at: run.clock.currentTime, clock: 'simulation' as const }
  return assembleCard(at,
    Array.from({ length: Math.max(0, ...lists.map(list => list.length)) }, (_, index) => lists.flatMap(list => (index < list.length ? [list[index]!] : []))).flat(),
    cards.flatMap(({ title, card }) => card.adjusted.map(adjustment => ({ ...adjustment, text: `${title}: ${adjustment.text}`.slice(0, 200) }))).slice(0, 8),
    cards.reduce((sum, { card }) => sum + card.more, 0))
}

const storedFor = (file: DashboardsFile, scope: DashboardScope) => file.dashboards.find(entry => scopeKey(entry.scope) === scopeKey(scope))

/** A scope's dashboard as the caller reads it now, or why its scope names nothing. */
export const readDashboard = async (run: ComposeRun, file: DashboardFile, input: ScopeInput): Promise<DashboardReading | ComposeIssue> => {
  const scope = await resolveScope(run, input)
  if (isIssue(scope)) return scope
  const stored = storedFor(await file.read(), scope)
  const pins = stored?.pins ?? []
  const sections: Built[] = []
  for (const pin of pins) sections.push(await pinnedOf(run, pin))
  const { sections: shown, more } = pins.length > 0 ? { sections, more: 0 } : await defaultsOf(run, scope, input)
  return {
    scope, revision: stored?.revision ?? 0, stored: pins.length > 0, sections: shown.map(({ card: _card, ...section }) => section),
    ...(more > 0 ? { more } : {}), card: cardOf(run, shown),
  }
}

/** A pin as a caller gives it: a spec the composer composes now as the caller, or a state the caller holds (a view's). */
export type PinInput = { readonly spec: DisplaySpec } | { readonly state: VignetteState }
export interface DashboardChange { readonly scope: ScopeInput; readonly expectedRevision: number; readonly pin: ReadonlyArray<PinInput>; readonly unpin: ReadonlyArray<string> }
export type ChangeOutcome =
  | { readonly ok: true; readonly scope: DashboardScope; readonly revision: number; readonly pins: ReadonlyArray<{ readonly id: string; readonly by: DashboardPin['by']; readonly title: string }> }
  | { readonly ok: false; readonly status: 404 | 409 | 422; readonly code: string; readonly message: string; readonly details?: Readonly<Record<string, unknown>> }

const refusal = (status: 404 | 409 | 422, code: string, message: string, details?: Readonly<Record<string, unknown>>): ChangeOutcome =>
  ({ ok: false, status, code, message, ...(details === undefined ? {} : { details }) })

/**
 * Pins and unpins on one scope's dashboard, as the caller: each pin composed or checked now, then the change written
 * only if the dashboard is still at the revision the caller read (else refused with the current one).
 */
export const changeDashboard = async (run: ComposeRun, file: DashboardFile, by: DashboardPin['by'], change: DashboardChange): Promise<ChangeOutcome> => {
  const scope = await resolveScope(run, change.scope)
  if (isIssue(scope)) return refusal(422, scope.code, `${scope.path}: ${scope.message}`, { issues: [scope] })
  const pinned: DashboardPin[] = []
  for (const [index, pin] of change.pin.entries()) {
    if ('spec' in pin) {
      const outcome = await composeVignette(run, pin.spec)
      if (!outcome.ok) return refusal(422, outcome.issues[0]!.code, outcome.issues.map(issue => `pin.${index}.spec.${issue.path}: ${issue.message}`).join('; '), { issues: outcome.issues })
      // The composer marks what it composes as the Assistant's; a spec a person pins is not.
      const { by: _composer, ...state } = outcome.state
      pinned.push({ id: `pin-${randomUUID().slice(0, 8)}`, by, spec: by === 'agent' ? outcome.state : state })
      continue
    }
    const issue = await unresolved(run, pin.state)
    if (issue !== null) return refusal(422, issue.code, `pin.${index}.state: ${issue.message}`, { issues: [issue] })
    pinned.push({ id: `pin-${randomUUID().slice(0, 8)}`, by, spec: pin.state })
  }
  return file.change(current => {
    const stored = storedFor(current, scope)
    const revision = stored?.revision ?? 0
    if (revision !== change.expectedRevision) {
      return { result: refusal(409, 'dashboard_revision_conflict', `The dashboard changed: you read revision ${change.expectedRevision}, it is at ${revision}; read it again`, { revision }) }
    }
    const missing = change.unpin.find(id => !(stored?.pins ?? []).some(pin => pin.id === id))
    if (missing !== undefined) return { result: refusal(404, 'dashboard_pin_not_found', `No pin ${missing} on this dashboard`) }
    const pins = [...(stored?.pins ?? []).filter(pin => !change.unpin.includes(pin.id)), ...pinned]
    if (pins.length > DASHBOARD_MAX_PINS) return { result: refusal(422, 'dashboard_full', `A dashboard holds ${DASHBOARD_MAX_PINS} pins; this change would leave ${pins.length}: unpin first`) }
    if (stored === undefined && current.dashboards.length >= DASHBOARD_MAX_SCOPES) return { result: refusal(422, 'dashboard_scopes_full', `A Run stores dashboards for at most ${DASHBOARD_MAX_SCOPES} scopes`) }
    const next = { scope, revision: revision + 1, pins }
    return {
      next: { dashboards: stored === undefined ? [...current.dashboards, next] : current.dashboards.map(entry => (entry === stored ? next : entry)) },
      result: { ok: true, scope, revision: next.revision, pins: pins.map(pin => ({ id: pin.id, by: pin.by, title: pin.spec.title })) },
    }
  })
}

/** The stored dashboards as the Run context names them: each scope holding pins, by id or category, never one naming an object hidden from the caller. */
export const storedDashboards = (file: DashboardsFile, denied: ReadonlySet<string>): ReadonlyArray<{ readonly scope: string; readonly pins: number }> =>
  file.dashboards.flatMap(({ scope, pins }) => pins.length === 0 || (scope !== 'run' && 'objectId' in scope && denied.has(scope.objectId)) ? []
    : [{ scope: scope === 'run' ? 'run' : 'objectId' in scope ? scope.objectId : `${scope.of.categoryId} (${scope.of.packId})`, pins: pins.length }])
