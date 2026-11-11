import { planningProjectionInputSchema, type PlanningFact, type PlanningFactBasis, type PlanningSubject } from '@leitbild/contracts'
import { planningProjectionCapability } from '../../simulation/planning-facts.ts'
import { unavailableQueryReadScope, type QueryReadPolicy } from '../../simulation/query-read-policy.ts'
import type { EngineState } from './engine/model.ts'
import { unitTypeOf } from './engine/model.ts'
import { motionOf } from './engine/model.ts'
import { planIntent } from './engine/engine.ts'
import { prepareLeg } from './engine/movement.ts'
import { etasTo } from './eta.ts'
import type { RoutingAdapter } from '../../routing/protocol.ts'

export const einsatzPlanningCapability = planningProjectionCapability('world.einsatz.planning-basis')
const locator = (kind: 'unit' | 'task', id: string): string => `einsatz/${kind}/${encodeURIComponent(id)}`

/**
 * Bases: unit-type component values are design; typed unit properties are configured (set by the Scenario or
 * unit.adjust); phases, loads and acceptance are observed; eligibility, arrivals and transfers are this Pack's
 * estimates. `index` lists every subject without routing; `facts` adds the estimates between the units and tasks
 * read in the same request.
 */
export const readEinsatzPlanningSource = async (config: {
  readonly state: EngineState
  readonly input: unknown
  readonly policy: QueryReadPolicy
  readonly routing: RoutingAdapter
}) => {
  const { state, policy } = config
  const input = planningProjectionInputSchema.parse(config.input)
  // Eligibility and receiving load depend on the owner's commitments. Omitting
  // a hidden contribution would invent a different dispatch problem.
  if ([...state.units.keys(), ...state.tasks.keys()].some(id => !policy.canInspect(id))) {
    unavailableQueryReadScope('Einsatz planning facts depend on records unavailable to the shared research audience')
  }
  const available = new Map<string, { readonly kind: 'unit' | 'task'; readonly id: string }>([
    ...[...state.units.values()].map(unit => [locator('unit', unit.id), { kind: 'unit' as const, id: unit.id }] as const),
    ...[...state.tasks.values()].map(task => [locator('task', task.id), { kind: 'task' as const, id: task.id }] as const),
  ])
  // A locator this Pack does not hold is left out; World core names it as unknown.
  const selected = (input.subjects ?? [...available.keys()]).filter(id => available.has(id))
  const at = new Date(state.timeMs).toISOString()
  const fact = (id: string, label: string, quantity: string, value: PlanningFact['value'], basis: PlanningFactBasis, unit?: string): PlanningFact =>
    ({ id, label, quantity, value, ...(unit === undefined ? {} : { unit }), basis, at })
  const estimates = input.detail === 'facts'
  const selectedUnits = selected.flatMap(id => { const record = available.get(id)!; return record.kind === 'unit' ? [state.units.get(record.id)!] : [] })
  const mobile = selectedUnits.filter(unit => unitTypeOf(state.catalog, unit).components.mobility !== undefined)
  const tasks = selected.flatMap(id => { const record = available.get(id)!; return record.kind === 'task' ? [state.tasks.get(record.id)!] : [] })
  const sites = selectedUnits.filter(unit => unitTypeOf(state.catalog, unit).components.receiving !== undefined)
  const arrivals = new Map<string, Awaited<ReturnType<typeof etasTo>>>()
  const transfers = new Map<string, Awaited<ReturnType<typeof prepareLeg>>>()
  if (estimates) {
    for (const task of tasks) arrivals.set(task.id, await etasTo(state, mobile, task.point, config.routing))
    for (const unit of mobile) for (const task of tasks) for (const site of sites) {
      transfers.set(`${unit.id}/${task.id}/${site.id}`, await prepareLeg(config.routing, unitTypeOf(state.catalog, unit).components.mobility!, task.point, motionOf(state, site.id).point, unit.label))
    }
  }
  const subjects: PlanningSubject[] = selected.map(id => {
    const record = available.get(id)!
    if (record.kind === 'task') {
      const task = state.tasks.get(record.id)!
      return { locator: id, label: task.label, kind: 'task', facts: [
        fact(`${task.id}/rank`, 'Priority class', 'state', task.rank, 'observed'),
        fact(`${task.id}/closed`, 'Work closed', 'state', task.closedAtMs !== undefined, 'observed'),
        ...Object.entries(task.loads).map(([key, count]) => fact(`${task.id}/waiting/${key}`, `Waiting ${key}`, 'count', count, 'observed', '1')),
      ] }
    }
    const unit = state.units.get(record.id)!, type = unitTypeOf(state.catalog, unit)
    const { mobility, service, carry, receiving } = type.components
    const facts: PlanningFact[] = [
      fact(`${unit.id}/phase`, 'Current phase', 'state', unit.phase, 'observed'),
      fact(`${unit.id}/integrity`, 'Integrity', 'state', unit.integrity, 'observed'),
      fact(`${unit.id}/queued-steps`, 'Committed job steps', 'count', unit.orders.length, 'observed', '1'),
    ]
    if (mobility !== undefined) facts.push(fact(`${unit.id}/mobilization-seconds`, 'Mobilization duration', 'time', mobility.mobilizeS, 'design', 's'))
    if (service !== undefined) facts.push(fact(`${unit.id}/service-seconds`, 'On-task duration', 'time', service.onSceneS, 'design', 's'))
    if (carry !== undefined) facts.push(fact(`${unit.id}/carry-capacity`, 'Load capacity', 'count', carry.capacity, 'design', '1'))
    if (receiving !== undefined) facts.push(
      fact(`${unit.id}/handover-seconds`, 'Handover duration', 'time', receiving.handoverS, 'design', 's'),
      fact(`${unit.id}/receiving-slots`, 'Receiving slots', 'count', receiving.slots, 'design', '1'),
      fact(`${unit.id}/occupied-slots`, 'Currently occupied receiving slots', 'count', [...state.units.values()].filter(other => other.siteId === unit.id && other.phase === 'at-site').length, 'observed', '1'),
      fact(`${unit.id}/accepting`, 'Accepting arrivals', 'state', unit.accepting ?? receiving.accepting, 'observed'),
    )
    for (const property of type.properties) {
      const value = unit.properties[property.id]
      if (value === undefined) throw new Error('Declared Einsatz property has no current value')
      // A number property declared without a unit is reported in the SI dimensionless unit 1.
      facts.push(fact(`${unit.id}/property/${property.id}`, property.label, property.id, value, 'configured', property.kind === 'number' ? property.unit ?? '1' : undefined))
    }
    if (mobility !== undefined && estimates) for (const task of tasks) {
      const eligibility = planIntent(state, { kind: 'send', units: [unit.id], to: { taskId: task.id } }, { by: 'planning-research', commandable: () => true })
      const eta = arrivals.get(task.id)!.get(unit.id)!
      facts.push(fact(`${unit.id}/eligible/${task.id}`, `Can serve ${task.label}`, 'state', eligibility.ok && eta.kind !== 'unavailable', 'owner-estimate'))
      if (eta.kind !== 'unavailable') facts.push(fact(`${unit.id}/arrival-seconds/${task.id}`, `Arrival at ${task.label}`, 'time', eta.seconds, 'owner-estimate', 's'))
      else facts.push(fact(`${unit.id}/arrival-unavailable/${task.id}`, `Arrival at ${task.label}`, 'state', 'unavailable', 'owner-estimate'))
      for (const site of sites) {
        const transfer = transfers.get(`${unit.id}/${task.id}/${site.id}`)!
        const key = `${unit.id}/transfer-seconds/${task.id}/${site.id}`
        facts.push(transfer.ok
          ? fact(key, `${task.label} to ${site.label}`, 'time', transfer.leg.durationMs / 1_000, 'owner-estimate', 's')
          : fact(key, `${task.label} to ${site.label}`, 'state', 'unavailable', 'owner-estimate'))
      }
    }
    return { locator: id, label: unit.label, kind: receiving === undefined ? 'unit' : 'receiving-site', facts }
  })
  return { simulationAt: at, subjects }
}
