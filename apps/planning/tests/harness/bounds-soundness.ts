// Test harness, bounds soundness re-verification (A5): on random small instances, every schedule is
// enumerated and judged by the product checker. A bound may never exceed the exhaustive optimum of its
// goal (lexicographically, given the earlier goals at their optimum), and no certificate may be issued
// where a checker-validated schedule exists. A certificate on a truly infeasible instance must still pass
// the checker's own re-verification.
import { planInputsSchema, type PlanInputs } from '../../src/plan/schema.ts'
import { checkPlan, prepare, type CheckRow, type CheckVariant } from '../../src/check/check.ts'
import { verifyCertificate } from '../../src/check/certificate.ts'
import { random } from './goals-property.ts'
import { choicesFor, placeJob } from './place.ts'
import type { BoundsPort } from './ports.ts'

export interface SmallInstance { readonly seed: number; readonly inputs: PlanInputs; readonly variant: CheckVariant }

const planner = { by: 'planner' as const }
const at = (slot: number): string => new Date(Date.parse('2026-11-16T06:00:00Z') + slot * 1_800_000).toISOString().replace('.000Z', 'Z')

/**
 * A deterministic small plan: two items in one group, tag-out, work and test jobs, two crews and a tool, one
 * purchase. Work is done by either crew (a pooled need); some instances also need the tool at the same time.
 */
export const smallInstance = (seed: number): SmallInstance => {
  const next = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const slots = 10
  const crewEarly = next() < 0.5
  const supported = next() < 0.5
  const keepOne = next() < 0.5
  const buy = next() < 0.5
  const withTool = next() < 0.5
  const keepFree = next() < 0.35   // "keep the operator or the crew free": a keep-in-service rule over resources
  const limit = pick([2.5, 3, 4, 5])
  const workHours = [pick([0.5, 1, 1.5]), pick([0.5, 1])]
  const goalOrder = (['finish', 'extra-cost', 'unavailable-hours'] as const).map(metric => ({ metric, key: next() })).sort((left, right) => left.key - right.key)
  const tagOut = (key: string, item: string) => ({ key, title: `Tag out ${item}`, kind: 'tag-out', equipment: [item], isolation: 'none', duration: { value: 0.5, unit: 'h', calendar: 'working', origin: planner }, durationWith: [], needs: [{ anyOf: ['ops'], amount: 1, handover: false }], continuous: true, checks: [], tags: [] })
  const test = (key: string, item: string) => ({ ...tagOut(key, item), title: `Test ${item}`, kind: 'test' })
  const work = (key: string, item: string, hours: number) => ({
    key, title: `Work ${item}`, kind: 'work', equipment: [item], isolation: 'inside', duration: { value: hours, unit: 'h', calendar: 'working', origin: planner }, durationWith: [],
    needs: [{ anyOf: ['crew', 'ops'], amount: 1, handover: false }, ...(withTool && item === 'P' ? [{ anyOf: ['kit'], amount: 1, handover: false }] : [])],
    continuous: next() < 0.5, checks: [], tags: [],
  })
  const inputs = planInputsSchema.parse({
    settings: { title: `Small ${seed}`, timeZone: 'Europe/Oslo', window: { start: at(0), end: at(slots) }, dataDate: at(0), grid: '30min', currency: 'NOK', run: null },
    equipment: [{ key: 'P', label: 'Item P', group: 'G', supportedBy: [] }, { key: 'Q', label: 'Item Q', group: 'G', supportedBy: supported ? ['P'] : [] }],
    groups: [{ key: 'G', label: 'Group G' }],
    calendars: [
      { key: 'always', label: 'Always', weekly: [], periods: [{ start: at(0), end: at(slots) }], except: [], source: planner },
      { key: 'part', label: 'Part shift', weekly: [], periods: [crewEarly ? { start: at(0), end: at(5) } : { start: at(5), end: at(slots) }], except: [], source: planner },
    ],
    resources: [
      { key: 'ops', label: 'Operator', kind: 'crew', count: 1, calendar: 'always', attributes: [], source: planner },
      { key: 'crew', label: 'Crew', kind: 'crew', count: 1, crewSize: 2, calendar: 'part', attributes: [], source: planner },
      { key: 'kit', label: 'Tool kit', kind: 'tool', count: 1, calendar: 'part', attributes: [], source: planner },
    ],
    purchases: [{ key: 'extra', label: 'Extra crew time', resource: 'crew', adds: { periods: [crewEarly ? { start: at(5), end: at(slots) } : { start: at(0), end: at(5) }] }, replaces: [], price: { perPeriodUsed: 100 }, allowed: true }],
    methods: [],
    jobs: [tagOut('P-TAG', 'P'), work('P-WORK', 'P', workHours[0]!), test('P-TEST', 'P'), tagOut('Q-TAG', 'Q'), work('Q-WORK', 'Q', workHours[1]!), test('Q-TEST', 'Q')],
    links: [],
    rules: [
      { kind: 'span-limit', key: 'L', group: 'G', limit: { value: limit, unit: 'h' }, singleEntry: true, words: `Group G back within ${limit} h`, source: planner },
      ...(keepOne ? [{ kind: 'keep-in-service', key: 'K', members: [{ equipment: 'P' }, { equipment: 'Q' }], atLeast: 1, words: 'Keep P or Q in service', source: planner }] : []),
      ...(keepFree ? [{ kind: 'keep-in-service', key: 'F', members: [{ resource: 'ops' }, { resource: 'crew' }], atLeast: 1, words: 'Keep the operator or the crew free', source: planner }] : []),
    ],
    goals: goalOrder.map(({ metric }) => ({ metric, tolerance: { value: 0, unit: metric === 'extra-cost' ? 'NOK' : 'h' } })),
    world: { refreshedAt: null, facts: [] },
  })
  return { seed, inputs, variant: { methods: [], purchases: buy ? ['extra'] : [] } }
}

/** Every complete schedule the checker accepts, by backtracking in job order (tag-out, work, test). */
export const enumerate = (inputs: PlanInputs, variant: CheckVariant): CheckRow[][] => {
  const prepared = prepare(inputs, variant)
  if (!prepared.ok) return []
  const context = prepared.context
  const jobs = inputs.jobs.filter(job => context.active.has(job.key))
  const options = jobs.map(job => {
    const rows: CheckRow[] = []
    for (let slot = 0; slot < context.grid.slots; slot++) for (const choice of choicesFor(context, job)) { const row = placeJob(context, job, slot, choice); if (row !== undefined) rows.push(row) }
    return rows
  })
  // every job here belongs to the one group, so no complete schedule is longer than the tightest limit
  const spanLimitMs = Math.min(Infinity, ...inputs.rules.flatMap(rule => rule.kind === 'span-limit' && rule.singleEntry && inputs.equipment.every(item => item.group === rule.group) && jobs.every(job => job.equipment.length > 0) ? [rule.limit.value * 3_600_000] : []))
  const feasible: CheckRow[][] = []
  const chosen: CheckRow[] = []
  const extend = (index: number): void => {
    if (index === jobs.length) { if (checkPlan(inputs, variant, chosen).feasible) feasible.push([...chosen]); return }
    for (const row of options[index]!) {
      // prune: the tag-out of the same item before its work, its work before its test
      const job = jobs[index]!
      const before = chosen.filter((other, otherIndex) => jobs[otherIndex]!.equipment[0] === job.equipment[0])
      if (before.some(other => Date.parse(other.finish) > Date.parse(row.start))) continue
      // prune: a resource booked beyond its count (the checker still judges every complete schedule)
      if (row.uses.some(use => {
        const from = Date.parse(use.from), to = Date.parse(use.to)
        const overlapping = chosen.flatMap(other => other.uses).filter(other => other.resource === use.resource && Date.parse(other.from) < to && Date.parse(other.to) > from)
        return overlapping.length >= (context.resources.get(use.resource)?.count ?? 0)
      })) continue
      // prune: the group span already longer than any span limit on it
      const opened = [...chosen, row].filter((_, otherIndex) => otherIndex < index + 1)
      const span = Math.max(...opened.map(other => Date.parse(other.finish))) - Math.min(...opened.map(other => Date.parse(other.start)))
      if (span > spanLimitMs) continue
      chosen.push(row)
      extend(index + 1)
      chosen.pop()
    }
  }
  extend(0)
  return feasible
}

/** The lexicographic optimum of each goal, given the earlier goals at theirs; undefined when infeasible. */
export const lexicographicOptimum = (inputs: PlanInputs, variant: CheckVariant, schedules: readonly CheckRow[][]): number[] | undefined => {
  if (schedules.length === 0) return undefined
  let pool = schedules.map(rows => checkPlan(inputs, variant, rows).goals.map(goal => 'value' in goal ? goal.value : Math.max(...goal.spans.map(span => span.value))))
  const optimum: number[] = []
  for (let goal = 0; goal < inputs.goals.length; goal++) {
    const best = Math.min(...pool.map(values => values[goal]!))
    optimum.push(best)
    pool = pool.filter(values => Math.abs(values[goal]! - best) < 1e-9)
  }
  return optimum
}

export interface SoundnessFailure { readonly seed: number; readonly problem: string }

export const boundsSoundness = async (port: BoundsPort, seeds: readonly number[]): Promise<{ readonly failures: SoundnessFailure[]; readonly infeasible: number; readonly feasible: number }> => {
  const failures: SoundnessFailure[] = []
  let infeasible = 0
  for (const seed of seeds) {
    const { inputs, variant } = smallInstance(seed)
    const schedules = enumerate(inputs, variant)
    const optimum = lexicographicOptimum(inputs, variant, schedules)
    if (optimum === undefined) infeasible++
    const answer = await port.bounds(inputs, variant)
    if (answer.certificate !== undefined) {
      if (optimum !== undefined) failures.push({ seed, problem: `a ${answer.certificate.kind} certificate is issued, but ${schedules.length} checker-validated schedules exist` })
      else {
        const verified = verifyCertificate(inputs, variant, answer.certificate)
        if (!verified.proves) failures.push({ seed, problem: `the certificate does not re-verify: ${[...verified.problems, ...verified.unverified].join(' ')}` })
      }
    }
    if (optimum === undefined) continue
    for (const bound of answer.goals) {
      const best = optimum[bound.goal]
      if (best !== undefined && bound.value > best + 1e-9) failures.push({ seed, problem: `goal ${bound.goal} (${inputs.goals[bound.goal]!.metric}) has bound ${bound.value} above the exhaustive optimum ${best}` })
    }
  }
  return { failures, infeasible, feasible: seeds.length - infeasible }
}
