// Test harness, the counterfactual check (acceptance row 7): an explanation "it starts then because of C"
// holds only if relaxing C lets the job start earlier, everything else fixed, as judged by the product
// checker. Each named cause alone must do it, or the named set together when the causes are joint.
import type { PlanInputs } from '../plan/schema.ts'
import { checkPlan, prepare, type CheckRow, type CheckVariant } from '../check/check.ts'
import { choicesFor, placeJob } from './place.ts'
import type { ExplainItem } from './ports.ts'

type Cause = ExplainItem['because'][number]

export interface CounterfactualFailure {
  readonly job: string
  readonly causes: readonly Cause[]
  readonly reason: 'did-not-move' | 'cannot-relax' | 'not-feasible-before' | 'row-mismatch'
  readonly detail: string
}

interface Relaxed { readonly inputs: PlanInputs; readonly variant: CheckVariant }

const always = { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as Array<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'>, from: '00:00', to: '00:00' }

/** The inputs with one cause lifted, or why it cannot be lifted. */
export const relax = (current: Relaxed, cause: Cause, job: string): Relaxed | string => {
  const { inputs, variant } = current
  const [first, second] = cause.about
  switch (cause.kind) {
    case 'link': {
      if (first === undefined || second === undefined) return 'a link cause names both jobs'
      const explicit = inputs.links.some(link => link.from === first && link.to === second)
      if (explicit) return { variant, inputs: { ...inputs, links: inputs.links.filter(link => !(link.from === first && link.to === second)) } }
      // a derived relation: bracketing, tag before test, or support order
      const from = inputs.jobs.find(candidate => candidate.key === first), to = inputs.jobs.find(candidate => candidate.key === second)
      if (from === undefined || to === undefined) return `no jobs ${first} and ${second}`
      const shared = to.equipment.filter(item => from.equipment.includes(item))
      if (shared.length > 0) {
        const unbracket = (target: string) => inputs.jobs.map(candidate => candidate.key === target ? { ...candidate, isolation: 'none' as const } : candidate)
        if (from.kind === 'tag-out' && to.kind === 'work') return { variant, inputs: { ...inputs, jobs: unbracket(to.key) } }
        if (from.kind === 'work' && to.kind === 'test') return { variant, inputs: { ...inputs, jobs: unbracket(from.key) } }
        if (from.kind === 'tag-out' && to.kind === 'test') return { variant, inputs: { ...inputs, jobs: inputs.jobs.map(candidate => candidate.key === to.key ? { ...candidate, equipment: candidate.equipment.filter(item => !shared.includes(item)) } : candidate) } }
      }
      if (from.kind === 'test' && to.kind === 'test') {
        return { variant, inputs: { ...inputs, equipment: inputs.equipment.map(item => to.equipment.includes(item.key) ? { ...item, supportedBy: [] } : item) } }
      }
      return `no link or derived order from ${first} to ${second}`
    }
    case 'crew': case 'tool': {
      if (first === undefined || !inputs.resources.some(resource => resource.key === first)) return `no resource ${first}`
      return { variant, inputs: { ...inputs, resources: inputs.resources.map(resource => { if (resource.key !== first) return resource; const { maxJobs: _limit, ...rest } = resource; return { ...rest, count: resource.count + 1 } }) } }
    }
    case 'shift': {
      const calendar = inputs.calendars.find(candidate => candidate.key === first)?.key ?? inputs.resources.find(resource => resource.key === first)?.calendar
      if (calendar === undefined) return `no calendar or resource ${first}`
      return { variant, inputs: { ...inputs, calendars: inputs.calendars.map(candidate => candidate.key === calendar ? { ...candidate, weekly: [always], except: [] } : candidate) } }
    }
    case 'availability': case 'span-limit': {
      if (first === undefined || !inputs.rules.some(rule => rule.key === first)) return `no rule ${first}`
      return { variant, inputs: { ...inputs, rules: inputs.rules.filter(rule => rule.key !== first) } }
    }
    case 'window': {
      const window = inputs.settings.window
      if (window === null) return 'no window'
      return { variant, inputs: { ...inputs, settings: { ...inputs.settings, window: { ...window, start: new Date(Date.parse(window.start) - 86_400_000).toISOString() } } } }
    }
    case 'release': case 'lock': {
      const target = first ?? job
      const field = cause.kind === 'release' ? 'notBefore' : 'lock'
      return { variant, inputs: { ...inputs, jobs: inputs.jobs.map(candidate => { if (candidate.key !== target) return candidate; const { [field]: _gone, ...rest } = candidate; return rest as typeof candidate }) } }
    }
    case 'purchase-not-allowed': {
      if (first === undefined || !inputs.purchases.some(purchase => purchase.key === first)) return `no purchase ${first}`
      return { inputs: { ...inputs, purchases: inputs.purchases.map(purchase => purchase.key === first ? { ...purchase, allowed: true } : purchase) }, variant: { ...variant, purchases: [...new Set([...variant.purchases, first])] } }
    }
    case 'late-as-possible':
      return current   // nothing binds: the job can start earlier as it is
    case 'data-date':
      return 'the data date is an increment 3 field; increment 1 explanations do not name it'
  }
}

/** Whether `job` can start before its current start with every other row fixed. */
const canStartEarlier = (relaxed: Relaxed, rows: readonly CheckRow[], job: string): boolean => {
  const prepared = prepare(relaxed.inputs, relaxed.variant)
  if (!prepared.ok) return false
  const context = prepared.context
  const entry = context.jobs.get(job)
  const current = rows.find(candidate => candidate.job === job)
  if (entry === undefined || current === undefined) return false
  const currentSlot = Math.round(context.slotOf(Date.parse(current.start)))
  const others = rows.filter(candidate => candidate.job !== job)
  const choices = choicesFor(context, entry)
  for (let slot = currentSlot - 1; slot >= 0; slot--) {
    for (const choice of choices) {
      const moved = placeJob(context, entry, slot, choice)
      if (moved !== undefined && checkPlan(relaxed.inputs, relaxed.variant, [...others, moved]).feasible) return true
    }
  }
  return false
}

export const counterfactualCheck = (inputs: PlanInputs, variant: CheckVariant, rows: readonly CheckRow[], items: readonly ExplainItem[]): CounterfactualFailure[] => {
  const failures: CounterfactualFailure[] = []
  const baseline = checkPlan(inputs, variant, rows)
  if (!baseline.feasible) return [{ job: '', causes: [], reason: 'not-feasible-before', detail: baseline.violations.map(item => item.words).join(' ') }]
  for (const item of items) {
    const row = rows.find(candidate => candidate.job === item.job)
    if (row === undefined || Date.parse(row.start) !== Date.parse(item.start)) { failures.push({ job: item.job, causes: item.because, reason: 'row-mismatch', detail: 'the explanation does not describe the dated row' }); continue }
    const sets = item.joint ? [item.because] : item.because.map(cause => [cause])
    for (const set of sets) {
      let relaxed: Relaxed | string = { inputs, variant }
      for (const cause of set) relaxed = typeof relaxed === 'string' ? relaxed : relax(relaxed, cause, item.job)
      if (typeof relaxed === 'string') { failures.push({ job: item.job, causes: set, reason: 'cannot-relax', detail: relaxed }); continue }
      if (!canStartEarlier(relaxed, rows, item.job)) failures.push({ job: item.job, causes: set, reason: 'did-not-move', detail: `relaxing ${set.map(cause => `${cause.kind} ${cause.about.join('/')}`).join(' and ')} does not let it start earlier` })
    }
  }
  return failures
}
