// Test harness, the counterfactual check (acceptance row 7): an explanation "it starts then because of C"
// holds only if relaxing C lets the job start earlier, everything else fixed, as judged by the product
// checker. Each named cause alone must do it, or the named set together when the causes are joint.
import type { PlanInputs } from '../../src/plan/schema.ts'
import { checkPlan, prepare, type CheckRow, type CheckVariant } from '../../src/check/check.ts'
import { choicesFor, placeJob } from './place.ts'
import type { ExplainItem } from './ports.ts'

type Cause = ExplainItem['because'][number]

export interface CounterfactualFailure {
  readonly job: string
  readonly causes: readonly Cause[]
  readonly reason: 'did-not-move' | 'cannot-relax' | 'not-minimal' | 'unknown-name' | 'not-feasible-before' | 'row-mismatch'
  readonly detail: string
}

/** Relaxed inputs, plus derived orders the checker is told not to check (equipment and kinds untouched). */
interface Relaxed { readonly inputs: PlanInputs; readonly variant: CheckVariant; readonly waive?: ReadonlyArray<readonly [string, string]> }

const always = { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as Array<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'>, from: '00:00', to: '00:00' }

/**
 * The order from `first` to `second` lifted: its explicit links removed, and any derived order between the
 * two (bracketing, tag before test, support order) waived in the checker. Nothing else changes: the
 * items, equipment and kinds stay, so the item still returns to service.
 */
const liftOrder = (current: Relaxed, first: string, second: string): Relaxed | string => {
  const { inputs, variant } = current
  const from = inputs.jobs.find(job => job.key === first), to = inputs.jobs.find(job => job.key === second)
  if (from === undefined || to === undefined) return `no jobs ${first} and ${second}`
  // a named order must exist: an explicit link, or one the checker derives between the two
  const explicit = inputs.links.some(link => link.from === first && link.to === second)
  const covers = (job: typeof from, item: string): boolean => job.equipment.includes(item)
  const bracket = (from.kind === 'tag-out' && to.kind === 'work' && to.isolation === 'inside' && covers(from, to.equipment[0]!))
    || (from.kind === 'work' && from.isolation === 'inside' && to.kind === 'test' && covers(to, from.equipment[0]!))
  const tagThenTest = from.kind === 'tag-out' && to.kind === 'test' && to.equipment.some(item => covers(from, item))
  const supportersOf = (item: string, seen: ReadonlySet<string> = new Set()): string[] => (inputs.equipment.find(entry => entry.key === item)?.supportedBy ?? []).filter(key => !seen.has(key)).flatMap(key => [key, ...supportersOf(key, new Set([...seen, item, key]))])
  const supportOrder = from.kind === 'test' && to.kind === 'test' && to.equipment.some(item => supportersOf(item).some(supporter => covers(from, supporter)))
  if (!explicit && !bracket && !tagThenTest && !supportOrder) return `no link or derived order from ${first} to ${second}`
  return {
    variant,
    inputs: { ...inputs, links: inputs.links.filter(link => !(link.from === first && link.to === second)) },
    waive: [...(current.waive ?? []), [first, second]],
  }
}

/** The inputs with one cause lifted, or why it cannot be lifted, keeping the orders already waived for earlier causes of a joint set. */
export const relax = (current: Relaxed, cause: Cause, job: string): Relaxed | string => {
  const lifted = relaxOne(current, cause, job)
  return typeof lifted === 'string' ? lifted : { ...lifted, waive: lifted.waive ?? current.waive ?? [] }
}

const relaxOne = (current: Relaxed, cause: Cause, job: string): Relaxed | string => {
  const { inputs, variant } = current
  // each name is read as the kind it declares
  const named = (kind: Cause['about'][number]['kind']): string[] => cause.about.filter(entry => entry.kind === kind).map(entry => entry.key)
  const keys = cause.about.map(entry => entry.key)
  switch (cause.kind) {
    case 'link': {
      // The explainer names the predecessors (its 'about'); the successor is the job explained. Every key is a
      // predecessor: its link, or its derived order, into the job is lifted.
      const preds = named('job').filter(key => key !== job)
      if (preds.length === 0) return 'a link cause names no predecessor'
      let next: Relaxed = current
      for (const from of preds) {
        const lifted = liftOrder(next, from, job)
        if (typeof lifted === 'string') return lifted
        next = lifted
      }
      return next
    }
    case 'crew': case 'tool': {
      // the busy resource gains a unit; the jobs named as holding it stay where they are
      const first = named('resource')[0]
      if (first === undefined || !inputs.resources.some(resource => resource.key === first)) return `no resource named among ${keys.join(', ')}`
      return { variant, inputs: { ...inputs, resources: inputs.resources.map(resource => { if (resource.key !== first) return resource; const { maxJobs: _limit, ...rest } = resource; return { ...rest, count: resource.count + 1 } }) } }
    }
    case 'shift': {
      // The named resources work around the clock for this job only: a copy of each, on duty always, is
      // added to the job's needs, so every other job keeps its calendars ("everything else fixed").
      // a calendar named stands for the job's resources on that calendar
      const job_ = inputs.jobs.find(candidate => candidate.key === job)
      const onCalendar = named('calendar').flatMap(calendar => (job_?.needs ?? []).flatMap(need => need.anyOf).filter(key => inputs.resources.find(resource => resource.key === key)?.calendar === calendar))
      const named_ = [...new Set([...named('resource'), ...onCalendar])].filter(key => inputs.resources.some(resource => resource.key === key))
      if (named_.length === 0) return `no resource or calendar of the job among ${keys.join(', ')}`
      const calendar = `${job}.around-the-clock`
      const copies = named_.map(key => ({ ...inputs.resources.find(resource => resource.key === key)!, key: `${key}.${job}.on-duty`, calendar }))
      return {
        variant,
        inputs: {
          ...inputs,
          calendars: [...inputs.calendars, { key: calendar, label: 'Around the clock', weekly: [always], periods: [], except: [], source: { by: 'planner' as const } }],
          resources: [...inputs.resources, ...copies.map(({ maxJobs: _limit, ...copy }) => copy)],
          jobs: inputs.jobs.map(candidate => candidate.key !== job ? candidate : {
            ...candidate,
            needs: candidate.needs.map(need => ({ ...need, anyOf: [...need.anyOf, ...named_.filter(key => need.anyOf.includes(key)).map(key => `${key}.${job}.on-duty`)].slice(0, 8) })),
            durationWith: [...candidate.durationWith, ...candidate.durationWith.filter(entry => named_.includes(entry.resource)).map(entry => ({ ...entry, resource: `${entry.resource}.${job}.on-duty` }))].slice(0, 16),
          }),
        },
      }
    }
    case 'availability': case 'span-limit': {
      const first = named('rule')[0]
      if (first === undefined || !inputs.rules.some(rule => rule.key === first)) return `no rule ${first}`
      return { variant, inputs: { ...inputs, rules: inputs.rules.filter(rule => rule.key !== first) } }
    }
    case 'window': {
      const window = inputs.settings.window
      if (window === null) return 'no window'
      return { variant, inputs: { ...inputs, settings: { ...inputs.settings, window: { ...window, start: new Date(Date.parse(window.start) - 86_400_000).toISOString() } } } }
    }
    case 'release': case 'lock': {
      const target = named('job')[0] ?? job
      const field = cause.kind === 'release' ? 'notBefore' : 'lock'
      return { variant, inputs: { ...inputs, jobs: inputs.jobs.map(candidate => { if (candidate.key !== target) return candidate; const { [field]: _gone, ...rest } = candidate; return rest as typeof candidate }) } }
    }
    case 'purchase-not-allowed': {
      const first = named('purchase')[0]
      if (first === undefined || !inputs.purchases.some(purchase => purchase.key === first)) return `no purchase ${first}`
      return { inputs: { ...inputs, purchases: inputs.purchases.map(purchase => purchase.key === first ? { ...purchase, allowed: true } : purchase) }, variant: { ...variant, purchases: [...new Set([...variant.purchases, first])] } }
    }
    case 'late-as-possible':
      return current   // nothing binds: the job can start earlier as it is
    case 'data-date': {
      // nothing may start before the plan's now: move the data date one day earlier, nothing else
      const now = inputs.settings.dataDate
      if (now === null) return 'the plan has no data date'
      return { variant, inputs: { ...inputs, settings: { ...inputs.settings, dataDate: new Date(Date.parse(now) - 86_400_000).toISOString() } } }
    }
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
      if (moved !== undefined && checkPlan(relaxed.inputs, relaxed.variant, [...others, moved], { orders: relaxed.waive ?? [] }).feasible) return true
    }
  }
  return false
}

/**
 * The names a cause gives must exist in the plan as what its kind says they are, the way the screen reads
 * them (ui/explain-text.ts): a link names jobs; a busy crew or tool names resources; an off shift names
 * calendars; a rule cause names a rule of its kind; a purchase cause names purchases. Kinds the screen
 * words without names still may name only things the plan has. A name that resolves to nothing, or to the
 * wrong kind of thing, reads as "an item no longer in this plan" and is a failure.
 */
export const unknownNames = (inputs: PlanInputs, item: ExplainItem): string[] => {
  const has = <T extends { readonly key: string }>(list: readonly T[]) => (key: string) => list.some(entry => entry.key === key)
  const exists: Record<ExplainItem['because'][number]['about'][number]['kind'], (key: string) => boolean> = {
    job: has(inputs.jobs), resource: has(inputs.resources), calendar: has(inputs.calendars), purchase: has(inputs.purchases),
    equipment: has(inputs.equipment), rule: has(inputs.rules),
  }
  const isRule = (kind: string) => (key: string) => inputs.rules.some(rule => rule.key === key && rule.kind === kind)
  const problems: string[] = []
  if (!exists.job(item.job)) problems.push(`the explained job '${item.job}' is not in the plan`)
  for (const cause of item.because) {
    // What each cause kind may name, and a rule cause's rule kind.
    const allowed: ReadonlyArray<string> | undefined =
      cause.kind === 'link' || cause.kind === 'release' || cause.kind === 'lock' ? ['job']
        : cause.kind === 'crew' || cause.kind === 'tool' ? ['resource', 'job']
          : cause.kind === 'shift' ? ['resource', 'calendar']
            : cause.kind === 'availability' || cause.kind === 'span-limit' ? ['rule']
              : cause.kind === 'purchase-not-allowed' ? ['purchase'] : undefined
    for (const name of cause.about) {
      if (allowed !== undefined && !allowed.includes(name.kind)) problems.push(`${cause.kind} names the ${name.kind} '${name.key}', which a ${cause.kind} cause does not name`)
      else if (!exists[name.kind](name.key)) problems.push(`${cause.kind} names '${name.key}', which is not a ${name.kind} of the plan`)
      else if (cause.kind === 'availability' && !isRule('keep-in-service')(name.key)) problems.push(`availability names '${name.key}', which is not a keep-in-service rule of the plan`)
      else if (cause.kind === 'span-limit' && !isRule('span-limit')(name.key)) problems.push(`span-limit names '${name.key}', which is not a span-limit rule of the plan`)
    }
    if ((cause.kind === 'crew' || cause.kind === 'tool') && !cause.about.some(name => name.kind === 'resource')) problems.push(`${cause.kind} names no crew or tool`)
  }
  return problems
}

export const counterfactualCheck = (inputs: PlanInputs, variant: CheckVariant, rows: readonly CheckRow[], items: readonly ExplainItem[]): CounterfactualFailure[] => {
  const failures: CounterfactualFailure[] = []
  const baseline = checkPlan(inputs, variant, rows)
  if (!baseline.feasible) return [{ job: '', causes: [], reason: 'not-feasible-before', detail: baseline.violations.map(item => item.words).join(' ') }]
  for (const item of items) {
    const row = rows.find(candidate => candidate.job === item.job)
    if (row === undefined || Date.parse(row.start) !== Date.parse(item.start)) { failures.push({ job: item.job, causes: item.because, reason: 'row-mismatch', detail: 'the explanation does not describe the dated row' }); continue }
    const unknown = unknownNames(inputs, item)
    if (unknown.length > 0) failures.push({ job: item.job, causes: item.because, reason: 'unknown-name', detail: unknown.join('; ') })
    const sets = item.joint ? [item.because] : item.because.map(cause => [cause])
    const relaxAll = (set: readonly Cause[]): Relaxed | string => {
      let relaxed: Relaxed | string = { inputs, variant }
      for (const cause of set) relaxed = typeof relaxed === 'string' ? relaxed : relax(relaxed, cause, item.job)
      return relaxed
    }
    for (const set of sets) {
      const relaxed = relaxAll(set)
      if (typeof relaxed === 'string') { failures.push({ job: item.job, causes: set, reason: 'cannot-relax', detail: relaxed }); continue }
      if (!canStartEarlier(relaxed, rows, item.job)) { failures.push({ job: item.job, causes: set, reason: 'did-not-move', detail: `relaxing ${set.map(cause => `${cause.kind} ${cause.about.map(entry => entry.key).join('/')}`).join(' and ')} does not let it start earlier` }); continue }
      // a joint set is minimal: with any one cause kept, the job may not move (else that cause is padding)
      if (set.length < 2) continue
      set.forEach((kept, index) => {
        const others = relaxAll(set.filter((_, other) => other !== index))
        if (typeof others !== 'string' && canStartEarlier(others, rows, item.job)) {
          failures.push({ job: item.job, causes: set, reason: 'not-minimal', detail: `keeping ${kept.kind} ${kept.about.map(entry => entry.key).join('/')} and relaxing the rest still lets it start earlier, so ${kept.kind} is not needed in the set` })
        }
      })
    }
  }
  return failures
}
