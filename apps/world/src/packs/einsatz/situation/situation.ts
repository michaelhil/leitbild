import { capabilityRejection } from '../../../simulation/capability-rejection.ts'
import { aiByPrefix, chainStepBy, isStandingOrderBy } from '../ids.ts'
import { wordFor, surfaceLexiconKeys } from '../lexicon.ts'
import { refusal } from '../refusal.ts'
import type { PriorityRef } from '../recommendation-schema.ts'
import type { StepKind, StepTarget } from '../steps.ts'
import { assignedTo, freeToHelp } from '../engine/coverage.ts'
import { priorityOf, priorityRankOf, templateOf, unitTypeOf, type EngineState, type TaskRecord, type UnitRecord } from '../engine/model.ts'
import { committedPhases, isDestroyed, isFree } from '../engine/rules.ts'
import { takesArrivals } from '../engine/delivery.ts'
import { byId, countOf } from '../engine/values.ts'
import { loadText, propertyValueText } from '../engine/wording.ts'
import { targetLabel } from '../engine/chain-steps.ts'
import { commandsUnit, inPicture, rolesText, type EinsatzViewer } from '../viewer.ts'
import type { ScenarioRole } from '../../../core/model/index.ts'
import { roleCommands } from '../picture.ts'
import { planEstimate } from './estimates.ts'
import type { Situation, SituationCall, SituationSite, SituationUnit, StopVerb, UnitTone } from './schema.ts'

/**
 * `world.einsatz.situation`: what is running, as the caller sees it, built
 * on each read from the engine state and never stored. It routes nothing
 * and suggests nothing: arrival estimates come from the units' own legs
 * (`estimates.ts`), and who should go from `world.einsatz.recommend`.
 *
 * Moved here from the Board's pure code, re-expressed over the engine state
 * instead of the browser records: the order of the calls (now priority rank,
 * then creation time), the units grouped by group or type, the sites a unit
 * can use, the coverage counts per need and the lexicon words.
 */

/** A task's priority as the wire names it. */
export const priorityRefOf = (state: EngineState, priorityId: string): PriorityRef => {
  const priority = priorityOf(state.catalog, priorityId)
  return {
    id: priority.id, label: priority.label, code: priority.code, rank: priorityRankOf(state.catalog, priority.id),
    ...(priority.responseTargetS === undefined ? {} : { responseTargetS: priority.responseTargetS }),
  }
}

/**
 * Who gave an order, in words: the roles that gave it in a sided Run, an AI
 * agent, an operator, the Scenario, the plan going on by itself, or a
 * standing order. `isViewer` holds only where the caller can be told apart:
 * in a sided Run, by its roles. An open Run's query names no caller.
 */
export const actorWords = (by: string, viewer: EinsatzViewer): { readonly label: string; readonly isViewer: boolean } => {
  const isViewer = viewer.roles.length > 0 && by === rolesText(viewer.roles)
  if (by === chainStepBy) return { label: 'Plan', isViewer: false }
  if (isStandingOrderBy(by)) return { label: 'Standing order', isViewer: false }
  if (by === 'scenario') return { label: 'Scenario', isViewer: false }
  if (by.startsWith(aiByPrefix)) return { label: 'AI agent', isViewer: false }
  if (by.startsWith('actor:')) return { label: 'Operator', isViewer: false }
  return { label: by, isViewer }
}


/**
 * The verb a stop of this kind gives the unit at its target: a task is
 * served, or its waiting load picked up by a carrier; a site takes a
 * delivery or is gone to, as a point is; a track is engaged.
 */
export const stopVerb = (state: EngineState, unit: UnitRecord, kind: StepKind, target: StepTarget): StopVerb => {
  if (kind === 'deliver') return 'deliver'
  if (kind === 'move') return 'go-to'
  if (kind === 'engage') return 'engage'
  const task = 'taskId' in target ? state.tasks.get(target.taskId) : undefined
  const carry = unitTypeOf(state.catalog, unit).components.carry
  const picksUp = task !== undefined && carry !== undefined && carry.classes.some(classId => countOf(task.loads, classId) > 0)
  return picksUp ? 'pick-up' : 'serve'
}

/** Free is the engine's `isFree`, no task and no load: a unit going to a point or a place is free to send, as recommend proposes it. */
const toneOf = (unit: UnitRecord): UnitTone => {
  if (isDestroyed(unit)) return 'out'
  if (unit.alerts.length > 0) return 'attention'
  if (unit.phase === 'returning') return 'returning'
  return isFree(unit) ? 'free' : 'busy'
}

const statusOf = (state: EngineState, unit: UnitRecord) => ({ word: wordFor(state.catalog.config.lexicon, unit.phase, unitTypeOf(state.catalog, unit).lexicon), tone: toneOf(unit) })

const naturalOrder = (a: { readonly label: string; readonly id: string }, b: { readonly label: string; readonly id: string }): number =>
  a.label.localeCompare(b.label, 'en', { numeric: true }) || byId(a, b)

const loadCounts = (state: EngineState, load: UnitRecord['load']) => state.catalog.classes
  .filter(loadClass => countOf(load, loadClass.id) > 0)
  .map(loadClass => ({ classId: loadClass.id, code: loadClass.code, label: loadText(state.catalog, { [loadClass.id]: countOf(load, loadClass.id) }), count: countOf(load, loadClass.id) }))

/** Who commands a unit the caller does not, in role words; null when the caller commands it. */
const commandedByOf = (state: EngineState, viewer: EinsatzViewer, roles: ReadonlyArray<ScenarioRole>, unit: UnitRecord): string | null => {
  if (commandsUnit(state.catalog, viewer, unit)) return null
  const types = { unitType: (id: string) => state.catalog.types.get(id)!, taskTemplate: (id: string) => state.catalog.templates.get(id)! }
  const commanders = roles.filter(role => role.class === 'operator' && roleCommands(types, role, unit)).map(role => role.label)
  return commanders.length === 0 ? 'No role' : commanders.join(', ')
}

const unitRow = (state: EngineState, viewer: EinsatzViewer, roles: ReadonlyArray<ScenarioRole>, unit: UnitRecord): SituationUnit => {
  const type = unitTypeOf(state.catalog, unit)
  const group = unit.group === undefined ? undefined : state.catalog.config.groups.find(entry => entry.id === unit.group)
  const estimate = planEstimate(state, unit)
  const last = unit.lastAction !== undefined && unit.lastAction.verb !== 'create' ? unit.lastAction : undefined
  return {
    id: unit.id,
    label: unit.label,
    icon: type.icon,
    typeLabel: type.label,
    group: group === undefined ? null : { id: group.id, label: group.label },
    status: statusOf(state, unit),
    phase: unit.phase,
    phaseDueInS: unit.phaseDueMs === undefined ? null : Math.max(0, (unit.phaseDueMs - state.timeMs) / 1_000),
    plan: unit.orders.map((step, index) => ({
      id: step.id,
      verb: stopVerb(state, unit, step.kind, step.target),
      target: step.target,
      label: targetLabel(state, step.target),
      state: step.state,
      eta: estimate.stops[index] ?? null,
      by: actorWords(step.by, viewer),
    })),
    predictedDelivery: estimate.delivery === undefined ? null : { siteId: estimate.delivery.site.id, label: estimate.delivery.site.label, eta: estimate.delivery.eta },
    lastOrder: last === undefined ? null : { by: actorWords(last.by, viewer), commandId: unit.lastCommand?.id ?? null },
    carry: type.components.carry === undefined ? null : { capacity: type.components.carry.capacity, load: loadCounts(state, unit.load) },
    properties: type.properties.filter(property => property.show).map(property => ({ id: property.id, label: property.label, value: propertyValueText(property, unit.properties[property.id]!) })),
    commandedBy: commandedByOf(state, viewer, roles, unit),
    states: unit.alerts.map(alert => ({ code: alert.code, text: alert.message })),
  }
}

/** Overdue: waited past its priority's response target with no unit there yet. Undefined when the priority declares no target. */
const overdueOf = (state: EngineState, task: TaskRecord): boolean | undefined => {
  const target = priorityOf(state.catalog, task.priority).responseTargetS
  if (target === undefined) return undefined
  const reached = task.coverage.requirements.some(entry => entry.onTask + entry.completed > 0)
    || Object.keys(task.pickedUp).length > 0
    || assignedTo(state.units.values(), task).some(unit => unit.phase === 'on-task')
  return !reached && (state.timeMs - task.createdAtMs) / 1_000 > target
}

const callRow = (state: EngineState, viewer: EinsatzViewer, task: TaskRecord, rows: ReadonlyMap<string, SituationUnit>): SituationCall => {
  const template = templateOf(state.catalog, task)
  const assigned = [...state.units.values()].filter(unit => unit.taskId === task.id && committedPhases.includes(unit.phase)).sort(naturalOrder)
  const overdue = overdueOf(state, task)
  const commandable = (unit: UnitRecord): boolean => commandsUnit(state.catalog, viewer, unit)
  // Unserved: a requirement still short or load not yet covered; a report needs attention, not a unit.
  const needs = task.coverage.requirements.some(entry => entry.enRoute + entry.onTask + entry.completed < entry.count)
    || task.coverage.loads.some(entry => entry.covered < entry.waiting)
  const assignedNow = assignedTo(state.units.values(), task)
  // The units recommend would propose from: free, on the task's side, adding to it.
  const freeCanHelp = [...state.units.values()].some(unit => commandable(unit) && freeToHelp(state, task, assignedNow, unit))
  return {
    id: task.id,
    label: task.label,
    icon: template.icon,
    templateLabel: template.label,
    priority: priorityRefOf(state, task.priority),
    waitingS: Math.max(0, (state.timeMs - task.createdAtMs) / 1_000),
    ...(overdue === undefined ? {} : { overdue }),
    ...(task.observed === undefined ? {} : { observed: { by: task.observed.by, at: new Date(task.observed.atMs).toISOString() } }),
    needs: [
      ...task.coverage.requirements.map((entry, index) => {
        const requirement = template.requires[index]!
        return {
          kind: 'requirement' as const,
          provides: entry.provides,
          label: `${entry.count} ${entry.count === 1 ? requirement.label.one : requirement.label.other}`,
          where: requirement.where.map(condition => {
            const property = state.catalog.config.unitTypes.flatMap(type => type.properties).find(entry => entry.id === condition.property)!
            if ('equals' in condition) return `${property.label} ${propertyValueText(property, condition.equals)}`
            const unit = property.kind === 'number' && property.unit !== undefined ? ` ${property.unit}` : ''
            const atLeast = 'atLeast' in condition ? `≥ ${condition.atLeast}${unit}` : undefined
            const atMost = condition.atMost === undefined ? undefined : `≤ ${condition.atMost}${unit}`
            return `${property.label} ${[atLeast, atMost].filter(part => part !== undefined).join(' and ')}`
          }),
          count: entry.count,
          enRoute: entry.enRoute,
          onTask: entry.onTask,
          completed: entry.completed,
        }
      }),
      ...task.coverage.loads.map(entry => {
        const loadClass = state.catalog.classes.find(candidate => candidate.id === entry.classId)!
        return { kind: 'load' as const, classId: entry.classId, code: loadClass.code, label: loadText(state.catalog, { [entry.classId]: entry.waiting }), waiting: entry.waiting, covered: entry.covered }
      }),
    ],
    assigned: assigned.map(unit => {
      const row = rows.get(unit.id)
      const active = unit.orders[0]
      return {
        unitId: unit.id,
        label: unit.label,
        phase: unit.phase,
        status: statusOf(state, unit),
        eta: row?.plan[0]?.eta ?? null,
        by: actorWords(active?.by ?? unit.lastAction?.by ?? 'scenario', viewer),
      }
    }),
    states: [
      ...task.alerts.map(alert => ({ code: alert.code, text: alert.message })),
      ...(overdue === true ? [{ code: 'overdue', text: `Waiting past its ${priorityOf(state.catalog, task.priority).code} response target` }] : []),
      ...(needs && !freeCanHelp ? [{ code: 'no_free_unit', text: 'No free unit can serve what it still needs' }] : []),
    ],
  }
}

/**
 * A site: a unit of a type that does not move, which units go to (`{siteId}`
 * in an order). One that receives load takes deliveries in its slots while
 * it takes arrivals (`takesArrivals`); any other, such as a depot, an
 * objective or a sensor post, is a place units only go to.
 */
const siteRow = (state: EngineState, site: UnitRecord, units: ReadonlyArray<UnitRecord>, rows: ReadonlyMap<string, SituationUnit>): SituationSite => {
  const type = unitTypeOf(state.catalog, site)
  const receiving = type.components.receiving
  const inbound = units.flatMap(unit => {
    const row = rows.get(unit.id)
    if (row === undefined) return []
    const stop = row.plan.find(entry => 'siteId' in entry.target && entry.target.siteId === site.id)
    if (stop !== undefined) return [{ unitId: unit.id, label: unit.label, eta: stop.eta }]
    return row.predictedDelivery?.siteId === site.id ? [{ unitId: unit.id, label: unit.label, eta: row.predictedDelivery.eta }] : []
  })
  const seconds = (eta: typeof inbound[number]['eta']): number => eta === null ? 0 : eta.kind === 'unavailable' ? Number.POSITIVE_INFINITY : eta.seconds
  return {
    id: site.id,
    label: site.label,
    icon: type.icon,
    typeLabel: type.label,
    accepting: receiving === undefined ? null : takesArrivals(state, site),
    slots: receiving === undefined ? null : { used: units.filter(unit => unit.siteId === site.id && unit.phase === 'at-site' && unit.phaseDueMs !== undefined).length, total: receiving.slots },
    inbound: inbound.sort((a, b) => seconds(a.eta) - seconds(b.eta) || (a.unitId < b.unitId ? -1 : 1)),
    states: site.alerts.map(alert => ({ code: alert.code, text: alert.message })),
  }
}

/** The situation as the viewer sees it; with `group`, only the units of that declared group. */
export const readSituation = (input: {
  readonly state: EngineState
  readonly viewer: EinsatzViewer
  readonly roles: ReadonlyArray<ScenarioRole>
  readonly group?: string | undefined
}): Situation => {
  const { state, viewer } = input
  const config = state.catalog.config
  if (input.group !== undefined && !config.groups.some(group => group.id === input.group)) {
    throw capabilityRejection('capability_input_rejected', refusal('unknown_group', `Group "${input.group}" is not declared`))
  }
  const seen = (record: UnitRecord | TaskRecord): boolean => inPicture(state.catalog, viewer, record)
  const groupIndex = (unit: UnitRecord): number => {
    const index = config.groups.findIndex(group => group.id === unit.group)
    return index < 0 ? config.groups.length : index
  }
  const typeIndex = (unit: UnitRecord): number => config.unitTypes.findIndex(type => type.id === unit.unitType)
  // Every unit record is listed once: a unit when its type moves, else a site.
  const allUnits = [...state.units.values()].filter(seen)
  const moves = (unit: UnitRecord): boolean => unitTypeOf(state.catalog, unit).components.mobility !== undefined
  const movers = allUnits.filter(moves)
  const listed = movers
    .filter(unit => input.group === undefined || unit.group === input.group)
    .sort((a, b) => (config.groups.length > 0 ? groupIndex(a) - groupIndex(b) : typeIndex(a) - typeIndex(b)) || typeIndex(a) - typeIndex(b) || naturalOrder(a, b))
  const rows = new Map(movers.map(unit => [unit.id, unitRow(state, viewer, input.roles, unit)]))
  const units = listed.map(unit => rows.get(unit.id)!)
  const calls = [...state.tasks.values()]
    .filter(task => task.closedAtMs === undefined && seen(task))
    .sort((a, b) => priorityRankOf(state.catalog, a.priority) - priorityRankOf(state.catalog, b.priority) || a.createdAtMs - b.createdAtMs || byId(a, b))
    .map(task => callRow(state, viewer, task, rows))
  const sites = allUnits.filter(unit => !moves(unit)).sort(naturalOrder).map(site => siteRow(state, site, movers, rows))
  const receiving = sites.filter(site => site.accepting !== null)
  const types = config.unitTypes
  const shown = types.flatMap(type => type.properties.filter(property => property.show))
  return {
    counts: {
      calls: state.catalog.priorities.map(priority => ({ priorityId: priority.id, code: priority.code, count: calls.filter(call => call.priority.id === priority.id).length })),
      oldestWaitingS: calls.length === 0 ? null : Math.max(...calls.map(call => call.waitingS)),
      freeUnits: listed.filter(isFree).length,
      units: units.length,
      acceptingSites: receiving.filter(site => site.accepting === true).length,
      sites: receiving.length,
    },
    calls,
    units,
    sites,
    words: Object.fromEntries(surfaceLexiconKeys.map(key => [key, wordFor(config.lexicon, key)])) as Situation['words'],
    features: {
      hasCarry: types.some(type => type.components.carry !== undefined),
      hasSites: types.some(type => type.components.receiving !== undefined),
      hasContacts: types.some(type => type.components.sensor !== undefined || type.components.effector !== undefined),
      propertyColumns: shown.filter((property, index) => shown.findIndex(entry => entry.id === property.id) === index).map(property => ({ id: property.id, label: property.label })),
    },
  }
}
