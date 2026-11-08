import type { PlanningSourceFact, PlanningSourceSubject } from '@leitbild/contracts'
import { planningProjectionCapability, planningProjectionInputSchema } from '../../simulation/planning-source.ts'
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
const fact = (id: string, label: string, semantic: PlanningSourceFact['semantic'], value: PlanningSourceFact['value'], unit?: string, basis: PlanningSourceFact['basis'] = 'observation'): PlanningSourceFact => ({ id, label, semantic, value, ...(unit === undefined ? {} : { unit }), basis })

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
  const selected = input.subjectIds === undefined ? [...available.keys()] : input.subjectIds.map(id => {
    if (available.has(id)) return id
    const unit = locator('unit', id), task = locator('task', id)
    return available.has(unit) ? unit : available.has(task) ? task : id
  })
  if (!selected.length || selected.length > 32 || new Set(selected).size !== selected.length || selected.some(id => !available.has(id))) {
    unavailableQueryReadScope('The selected Einsatz planning source set is unavailable or exceeds 32 subjects')
  }
  if (input.purpose === 'qualify') return { allowed: true }
  const selectedUnits = selected.flatMap(id => { const record = available.get(id)!; return record.kind === 'unit' ? [state.units.get(record.id)!] : [] })
  const mobile = selectedUnits.filter(unit => unitTypeOf(state.catalog, unit).components.mobility !== undefined)
  const tasks = selected.flatMap(id => { const record = available.get(id)!; return record.kind === 'task' ? [state.tasks.get(record.id)!] : [] })
  const sites = selectedUnits.filter(unit => unitTypeOf(state.catalog, unit).components.receiving !== undefined)
  const arrivals = new Map<string, Awaited<ReturnType<typeof etasTo>>>()
  for (const task of tasks) arrivals.set(task.id, await etasTo(state, mobile, task.point, config.routing))
  const transfers = new Map<string, Awaited<ReturnType<typeof prepareLeg>>>()
  for (const unit of mobile) for (const task of tasks) for (const site of sites) {
    transfers.set(`${unit.id}/${task.id}/${site.id}`, await prepareLeg(config.routing, unitTypeOf(state.catalog, unit).components.mobility!, task.point, motionOf(state, site.id).point, unit.label))
  }
  const subjects: PlanningSourceSubject[] = selected.map(id => {
    const record = available.get(id)!
    if (record.kind === 'task') {
      const task = state.tasks.get(record.id)!
      return { locator: id, label: task.label, kind: 'task', facts: [
        fact(`${task.id}/rank`, 'Priority class', 'state', task.rank),
        fact(`${task.id}/closed`, 'Work closed', 'state', task.closedAtMs !== undefined),
        ...Object.entries(task.loads).map(([key, count]) => fact(`${task.id}/waiting/${key}`, `Waiting ${key}`, 'quantity', count, '1')),
      ] }
    }
    const unit = state.units.get(record.id)!, type = unitTypeOf(state.catalog, unit)
    const { mobility, service, carry, receiving } = type.components
    const facts: PlanningSourceFact[] = [
      fact(`${unit.id}/phase`, 'Current phase', 'state', unit.phase),
      fact(`${unit.id}/integrity`, 'Integrity', 'state', unit.integrity),
      fact(`${unit.id}/queued-steps`, 'Committed job steps', 'quantity', unit.orders.length, '1'),
    ]
    if (mobility !== undefined) facts.push(fact(`${unit.id}/mobilization-seconds`, 'Mobilization duration', 'duration', mobility.mobilizeS, 's', 'owner-estimate'))
    if (service !== undefined) facts.push(fact(`${unit.id}/service-seconds`, 'On-task duration', 'duration', service.onSceneS, 's', 'owner-estimate'))
    if (carry !== undefined) facts.push(fact(`${unit.id}/carry-capacity`, 'Load capacity', 'capacity', carry.capacity, '1'))
    if (receiving !== undefined) facts.push(
      fact(`${unit.id}/handover-seconds`, 'Handover duration', 'duration', receiving.handoverS, 's', 'owner-estimate'),
      fact(`${unit.id}/receiving-slots`, 'Receiving slots', 'capacity', receiving.slots, '1'),
      fact(`${unit.id}/occupied-slots`, 'Currently occupied receiving slots', 'quantity', [...state.units.values()].filter(other => other.siteId === unit.id && other.phase === 'at-site').length, '1'),
      fact(`${unit.id}/accepting`, 'Accepting arrivals', 'state', unit.accepting ?? receiving.accepting),
    )
    for (const property of type.properties) {
      const value = unit.properties[property.id]
      if (value === undefined) throw new Error('Declared Einsatz property has no current value')
      facts.push(fact(`${unit.id}/property/${property.id}`, property.label, 'quantity', value, property.kind === 'number' ? property.unit : undefined))
    }
    if (mobility !== undefined) for (const task of tasks) {
      const eligibility = planIntent(state, { kind: 'send', units: [unit.id], to: { taskId: task.id } }, { by: 'planning-research', commandable: () => true })
      const eta = arrivals.get(task.id)!.get(unit.id)!
      facts.push(fact(`${unit.id}/eligible/${task.id}`, `Can serve ${task.label}`, 'state', eligibility.ok && eta.kind !== 'unavailable'))
      if (eta.kind !== 'unavailable') facts.push(fact(`${unit.id}/arrival-seconds/${task.id}`, `Arrival at ${task.label}`, 'duration', eta.seconds, 's', 'owner-estimate'))
      else facts.push(fact(`${unit.id}/arrival-unavailable/${task.id}`, `Arrival at ${task.label}`, 'state', 'unavailable'))
      for (const site of sites) {
        const transfer = transfers.get(`${unit.id}/${task.id}/${site.id}`)!
        const key = `${unit.id}/transfer-seconds/${task.id}/${site.id}`
        facts.push(transfer.ok
          ? fact(key, `${task.label} to ${site.label}`, 'duration', transfer.leg.durationMs / 1_000, 's', 'owner-estimate')
          : fact(key, `${task.label} to ${site.label}`, 'state', 'unavailable'))
      }
    }
    return { locator: id, label: unit.label, kind: receiving === undefined ? 'unit' : 'receiving-site', facts }
  })
  return { simulationAt: new Date(state.timeMs).toISOString(), subjects }
}
