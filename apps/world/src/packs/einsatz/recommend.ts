import { capabilityRejection } from '../../simulation/capability-rejection.ts'
import type { Eta, RecommendAnswer } from './recommendation-schema.ts'
import { asAssigned, assignedTo, contributionOf, coverageOf, freeToHelp, loadAllocation, needsFrom, roleViewFor, type RoleView } from './engine/coverage.ts'
import { countedWithPlanned, plannedStops } from './engine/planned.ts'
import { committedText, loadedText } from './engine/intent-support.ts'
import { templateOf, unitTypeOf, type EngineState, type TaskCoverage, type TaskRecord, type UnitRecord } from './engine/model.ts'
import { acceptingSitesFor } from './engine/delivery.ts'
import { conditionReasons, hasLoad, isDestroyed, linksToTask, providesFor } from './engine/rules.ts'
import { byId, countOf, total } from './engine/values.ts'
import { classCode, loadText, unitWord } from './engine/wording.ts'
import { etaSeconds, etasFrom, etasTo, type TablePort } from './eta.ts'
import { refusal } from './refusal.ts'
import { priorityRefOf } from './situation/situation.ts'
import { commandsUnit, inPicture, taskAuthority, type EinsatzViewer } from './viewer.ts'
import { motionOf } from './engine/model.ts'

/**
 * Recommendations for a task. It reads one engine state, the snapshot it is
 * given, outside the engine's queue, and changes nothing. Coverage and need
 * are the engine's own, so what is proposed is what an order of it commits.
 *
 * - Proposal: the smallest set of free units that serves the task for the
 *   caller's units, by fit then ETA; failing that, the free units' best
 *   partial set, with the remainder named. It counts the units already on
 *   the task and those whose plan holds it as a later stop (`planned.ts`) as
 *   on their way, so it never proposes a unit for what a later stop will
 *   cover; once they cover it all, there is no proposal. Only free units are proposed (no
 *   task, no load), so an order between two recommendations never lets
 *   both propose the same unit. `proposal.order` is the order to send.
 * - Fit is how much of the task a unit fills. Units filling the same
 *   requirements and load classes with the same free capacity fill alike, so
 *   the search picks among them by ETA, nearest first.
 * - Alternatives: per need, the other free units that add to it, nearest
 *   first, each with its own ready order.
 * - Why not: units that provide what the task needs but are not offered,
 *   with the reasons in property and lexicon words.
 * - Deliver to: for each proposed carrier that will pick up load, the
 *   accepting sites for that load, nearest first from the task.
 */

/** The most combinations a search may judge before it refuses as too large to answer. */
const searchBudget = 20_000

interface Candidate {
  readonly unit: UnitRecord
  readonly eta: Eta
}

/** How far each requirement is filled, up to its count, then the load covered per class: what a unit's fit is judged on. */
const fillOf = (coverage: TaskCoverage): number[] => [
  ...coverage.requirements.map(entry => Math.min(entry.count, entry.enRoute + entry.onTask + entry.completed)),
  ...coverage.loads.map(entry => entry.covered),
]
/** The units counted on their way before any proposal: assigned to the task, and those holding it as a later stop. */
type Base = ReadonlyArray<UnitRecord>
const counted = (task: TaskRecord, base: Base, units: ReadonlyArray<UnitRecord>): UnitRecord[] => [...base, ...asAssigned(units, task)]
const fillWith = (state: EngineState, task: TaskRecord, base: Base, units: ReadonlyArray<UnitRecord>): number[] =>
  fillOf(coverageOf(state.catalog, task, counted(task, base, units)))
const sameFill = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => a.every((value, index) => value === b[index])
const sum = (values: ReadonlyArray<number>): number => values.reduce((total, value) => total + value, 0)

/** Units that fill a task alike: the same requirements met, the same load classes and the same free capacity. */
const fillSignature = (state: EngineState, task: TaskRecord, unit: UnitRecord): string => {
  const type = unitTypeOf(state.catalog, unit)
  const carry = type.components.carry
  const freeCapacity = carry === undefined ? 0 : carry.capacity - sum(Object.values(unit.load))
  const meets = templateOf(state.catalog, task).requires.map(requirement => providesFor(type, requirement) && conditionReasons(state.catalog, unit, requirement).length === 0)
  return JSON.stringify([meets, carry === undefined ? [] : [...carry.classes].sort(), freeCapacity])
}

/** Better first: the earlier complete arrival, then the earlier arrivals overall, then unit ids. */
const compareSets = (a: ReadonlyArray<Candidate>, b: ReadonlyArray<Candidate>): number => {
  const latest = (set: ReadonlyArray<Candidate>) => Math.max(0, ...set.map(entry => etaSeconds(entry.eta)))
  const total = (set: ReadonlyArray<Candidate>) => sum(set.map(entry => Math.min(etaSeconds(entry.eta), Number.MAX_VALUE)))
  const ids = (set: ReadonlyArray<Candidate>) => set.map(entry => entry.unit.id).sort().join(' ')
  return latest(a) - latest(b) || total(a) - total(b) || (ids(a) < ids(b) ? -1 : ids(a) > ids(b) ? 1 : 0)
}

const byEta = (a: Candidate, b: Candidate): number => etaSeconds(a.eta) - etaSeconds(b.eta) || byId(a.unit, b.unit)

/**
 * The smallest set of candidates that serves the task for the
 * caller's units, by fit then ETA. Candidates are grouped by how they fill
 * the task and taken nearest first within a group; sizes are tried from the
 * smallest up.
 */
const smallestCover = (state: EngineState, task: TaskRecord, base: Base, view: RoleView, candidates: ReadonlyArray<Candidate>): ReadonlyArray<Candidate> | undefined => {
  const grouped = new Map<string, Candidate[]>()
  for (const entry of [...candidates].sort(byEta)) {
    const signature = fillSignature(state, task, entry.unit)
    grouped.set(signature, [...grouped.get(signature) ?? [], entry])
  }
  const groups = [...grouped.values()]
  let judged = 0
  const serves = (set: ReadonlyArray<Candidate>): boolean => {
    judged += 1
    if (judged > searchBudget) throw capabilityRejection('capability_work_limit', `${task.label} has too many unit combinations to recommend; send units directly`)
    return !needsFrom(state.catalog, task, coverageOf(state.catalog, task, counted(task, base, set.map(entry => entry.unit))), view)
  }
  // Coverage only grows as units are added, so when all of them together do not serve, no subset does.
  if (!serves(candidates)) return undefined
  for (let size = 0; size <= candidates.length; size++) {
    let best: ReadonlyArray<Candidate> | undefined
    const choose = (group: number, left: number, chosen: ReadonlyArray<Candidate>): void => {
      if (group === groups.length) {
        if (left === 0 && serves(chosen) && (best === undefined || compareSets(chosen, best) < 0)) best = chosen
        return
      }
      const members = groups[group]!
      for (let count = Math.min(left, members.length); count >= 0; count--) choose(group + 1, left - count, [...chosen, ...members.slice(0, count)])
    }
    choose(0, size, [])
    if (best !== undefined) return best
  }
  return undefined
}

/**
 * Drops members that add nothing beside the rest, latest arrival first, so a
 * partial set fills as much as all of them with as few units as it can.
 */
const pruned = (state: EngineState, task: TaskRecord, base: Base, set: ReadonlyArray<Candidate>): ReadonlyArray<Candidate> => {
  let current = [...set]
  const full = fillWith(state, task, base, current.map(entry => entry.unit))
  for (const entry of [...set].sort(byEta).reverse()) {
    const without = current.filter(other => other !== entry)
    if (sameFill(fillWith(state, task, base, without.map(other => other.unit)), full)) current = without
  }
  return current.sort(byEta)
}

/** What the task still needs from the caller's units after the proposal, in configuration words. */
const remainderOf = (state: EngineState, task: TaskRecord, base: Base, view: RoleView, proposal: ReadonlyArray<UnitRecord>): string[] => {
  const coverage = coverageOf(state.catalog, task, counted(task, base, proposal))
  const requirements = templateOf(state.catalog, task).requires
  return [
    ...coverage.requirements.flatMap((entry, index) => {
      const missing = entry.count - Math.min(entry.count, entry.enRoute + entry.onTask + entry.completed)
      const label = requirements[index]!.label
      return view.provides.has(entry.provides) && missing > 0 ? [`${missing} more ${missing === 1 ? label.one : label.other}`] : []
    }),
    ...coverage.loads.flatMap(entry => {
      const missing = entry.waiting - entry.covered
      return view.carries.has(entry.classId) && missing > 0 ? [`${classCode(state.catalog, entry.classId)}×${missing}`] : []
    }),
  ]
}

interface Survey {
  /** Free units that add to the task now. */
  readonly free: ReadonlyArray<UnitRecord>
  /** Units that would add but are not free, or fail a condition, with the reasons. */
  readonly whyNot: RecommendAnswer['whyNot']
}

/** The caller's units of the task's side that provide what it requires or carry what it holds, sorted into free and why not; a unit that adds only what a later stop will cover is neither. */
const survey = (state: EngineState, task: TaskRecord, base: Base, commandable: (unit: UnitRecord) => boolean): Survey => {
  const requires = templateOf(state.catalog, task).requires
  const free: UnitRecord[] = []
  const whyNot: Array<RecommendAnswer['whyNot'][number]> = []
  for (const unit of [...state.units.values()].sort(byId)) {
    if (!commandable(unit) || !linksToTask(unit, task) || unit.taskId === task.id) continue
    if (freeToHelp(state, task, base, unit)) {
      free.push(unit)
      continue
    }
    const type = unitTypeOf(state.catalog, unit)
    const relevant = requires.some(requirement => providesFor(type, requirement))
      || (type.components.carry?.classes.some(classId => countOf(task.loads, classId) > 0) ?? false)
    if (!relevant) continue
    const refuse = (reasons: ReadonlyArray<string>) => whyNot.push({ unitId: unit.id, label: unit.label, reasons: [...reasons] })
    if (isDestroyed(unit)) refuse([`${unit.label} is ${unitWord(state.catalog, unit, 'destroyed')}`])
    else if (type.components.mobility === undefined) refuse([`${unit.label} cannot move`])
    else {
      const contribution = contributionOf(state.catalog, task, base, unit)
      if (!contribution.adds) {
        if (contribution.unmet.length > 0) refuse(contribution.unmet)
      } else refuse([hasLoad(unit) ? loadedText(state, unit) : committedText(state, unit)])
    }
  }
  return { free, whyNot }
}

const rejected = (reason: { readonly reason: string }, code: 'capability_target_not_found' | 'capability_input_rejected') => capabilityRejection(code, reason.reason)

/** How many units the task's needs add up to, and how many of them are covered with these units counted on their way. */
const coversOf = (coverage: TaskCoverage): { readonly covered: number; readonly needed: number } => ({
  covered: fillOf(coverage).reduce((sum, value) => sum + value, 0),
  needed: coverage.requirements.reduce((sum, entry) => sum + entry.count, 0) + coverage.loads.reduce((sum, entry) => sum + entry.waiting, 0),
})

/**
 * The recommendation for a task as the viewer sees it. A task outside the
 * viewer's picture is not in it; one outside its queue or closed is refused.
 */
export const recommend = async (input: {
  readonly state: EngineState
  readonly viewer: EinsatzViewer
  readonly taskId: string
  readonly routing: TablePort
}): Promise<RecommendAnswer> => {
  const { state, viewer } = input
  const task = state.tasks.get(input.taskId)
  if (task === undefined) throw rejected({ reason: refusal('not_in_picture', 'Not in your picture') }, 'capability_target_not_found')
  const unauthorized = taskAuthority(state, viewer, task)
  if (unauthorized) throw rejected(unauthorized, unauthorized.reason.startsWith('not_in_picture') ? 'capability_target_not_found' : 'capability_input_rejected')
  if (task.closedAtMs !== undefined) throw rejected({ reason: refusal('task_closed', `${task.label} is closed`) }, 'capability_input_rejected')

  const commandable = (unit: UnitRecord): boolean => commandsUnit(state.catalog, viewer, unit)
  const view = roleViewFor(state, commandable, task)
  const base = countedWithPlanned(state, task, plannedStops(state, task).filter(entry => inPicture(state.catalog, viewer, entry.unit)))
  const units = survey(state, task, base, commandable)
  const etas = await etasTo(state, units.free, task.point, input.routing)
  const free = units.free.map((unit): Candidate => ({ unit, eta: etas.get(unit.id)! }))

  const proposal = smallestCover(state, task, base, view, free) ?? pruned(state, task, base, free)
  const proposed = proposal.map(entry => entry.unit)
  const inProposal = new Set(proposed.map(unit => unit.id))
  const unitEta = (entry: Candidate) => ({ unitId: entry.unit.id, label: entry.unit.label, eta: entry.eta })
  const orderFor = (ids: ReadonlyArray<string>) => ({ units: [...ids], stops: [{ taskId: task.id }] })

  const assigned = assignedTo(state.units.values(), task)
  const template = templateOf(state.catalog, task)
  const others = free.filter(entry => !inProposal.has(entry.unit.id)).sort(byEta)
  /** A free unit that could serve a need: it meets the requirement, or carries the class with room to spare. */
  const serves = (unit: UnitRecord, need: { readonly requirement: number } | { readonly classId: string }): boolean => {
    const type = unitTypeOf(state.catalog, unit)
    if ('requirement' in need) {
      const requirement = template.requires[need.requirement]!
      return providesFor(type, requirement) && conditionReasons(state.catalog, unit, requirement).length === 0
    }
    const carry = type.components.carry
    return carry !== undefined && carry.classes.includes(need.classId) && carry.capacity - total(unit.load) > 0
  }
  const coverage = coverageOf(state.catalog, task, assigned)
  const alternatives: RecommendAnswer['alternatives'] = [
    ...template.requires.map((requirement, index) => ({
      need: { kind: 'requirement' as const, id: requirement.provides, label: requirement.label.other },
      units: others.filter(entry => serves(entry.unit, { requirement: index })).map(entry => ({ ...unitEta(entry), order: orderFor([entry.unit.id]) })),
    })),
    ...coverage.loads.map(entry => ({
      need: { kind: 'load' as const, id: entry.classId, label: `${loadText(state.catalog, { [entry.classId]: entry.waiting })} (${classCode(state.catalog, entry.classId)})` },
      units: others.filter(candidate => serves(candidate.unit, { classId: entry.classId })).map(candidate => ({ ...unitEta(candidate), order: orderFor([candidate.unit.id]) })),
    })),
  ].filter(entry => entry.units.length > 0)

  const shares = loadAllocation(state.catalog, task, counted(task, base, proposed))
  const deliverTo: Array<RecommendAnswer['deliverTo'][number]> = []
  for (const carrier of proposed) {
    const share = shares.get(carrier.id) ?? {}
    if (total(share) === 0) continue
    const usable = acceptingSitesFor(state, carrier, share)
    if (usable.length === 0) continue
    const legs = await etasFrom(state, carrier, task.point, usable.map(site => ({ point: motionOf(state, site.id).point, turnoutS: 0 })), input.routing)
    const listed = usable.map((site, index) => ({ siteId: site.id, label: site.label, eta: legs[index]! }))
      .sort((a, b) => etaSeconds(a.eta) - etaSeconds(b.eta) || (a.siteId < b.siteId ? -1 : 1))
    deliverTo.push({ unitId: carrier.id, label: carrier.label, sites: listed })
  }

  const offered = new Set([...inProposal, ...alternatives.flatMap(entry => entry.units.map(unit => unit.unitId))])
  return {
    taskId: task.id,
    priority: priorityRefOf(state, task.priority),
    proposal: proposal.length === 0 ? null : {
      order: orderFor(proposed.map(unit => unit.id)),
      units: proposal.map(unitEta),
      covers: coversOf(coverageOf(state.catalog, task, counted(task, base, proposed))),
      remainder: remainderOf(state, task, base, view, proposed),
    },
    alternatives,
    whyNot: units.whyNot.filter(entry => !offered.has(entry.unitId)),
    deliverTo,
  }
}
