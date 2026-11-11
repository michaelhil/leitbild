// Independent re-verification of an infeasibility certificate from the plan inputs. The solver's numbers
// are recomputed, never copied: a chain must be a chain, its work must be the jobs' least work, and its
// available hours must count every hour any eligible resource could work in the interval. What cannot
// be recomputed from inputs alone is named in `unverified`, so a reader never takes it as checked.
import type { Certificate, PlanInputs } from '../plan/schema.ts'
import { jobDuration, prepare, type CheckVariant, type Context } from './check.ts'

export interface CertificateCheck {
  readonly ok: boolean
  readonly problems: readonly string[]
  /** Parts of the claim the checker cannot recompute from inputs alone. */
  readonly unverified: readonly string[]
  /** The checker's own figures. */
  readonly figures: Readonly<Record<string, number>>
}

type Job = PlanInputs['jobs'][number]
const hourMs = 3_600_000

/** The least work a job can take over its possible resources, in hours. */
const leastWorkHours = (context: Context, job: Job): number | undefined => {
  const options = [new Set<string>(), ...job.durationWith.map(entry => new Set([entry.resource]))]
  const hours = options.flatMap(chosen => { const duration = jobDuration(context, job, chosen); return duration.ok ? [duration.slots * context.grid.slotMs / hourMs] : [] })
  return hours.length === 0 ? undefined : Math.min(...hours)
}

/** Slots when some eligible resource of the job could work: base calendars and permitted purchases. */
const eligibleSlots = (context: Context, job: Job, resources?: ReadonlySet<string>): Uint8Array => {
  const slots = new Uint8Array(context.grid.slots)
  for (const need of job.needs) {
    for (const key of need.anyOf) {
      if (resources !== undefined && !resources.has(key)) continue
      const resource = context.resources.get(key)
      if (resource === undefined) continue
      context.calendars.get(resource.calendar)?.forEach((slot, index) => { if (slot === 1) slots[index] = 1 })
      for (const purchase of context.inputs.purchases) {
        if (purchase.resource === key && context.permitted.has(purchase.key)) context.added.get(purchase.key)!.forEach((slot, index) => { if (slot === 1) slots[index] = 1 })
      }
    }
  }
  if (job.needs.length === 0 || job.duration.calendar === 'elapsed') slots.fill(1)
  return slots
}

const hoursIn = (slots: Uint8Array, context: Context, from: number, to: number): number => {
  let count = 0
  const first = Math.max(0, Math.floor(context.slotOf(from))), last = Math.min(context.grid.slots, Math.ceil(context.slotOf(to)))
  for (let slot = first; slot < last; slot++) count += slots[slot]!
  return count * context.grid.slotMs / hourMs
}

/** Finish-to-start precedence among active jobs: links, bracketing, tag before test. */
const precedes = (context: Context): Map<string, Set<string>> => {
  const next = new Map<string, Set<string>>()
  const add = (from: string, to: string): void => { const set = next.get(from) ?? new Set<string>(); set.add(to); next.set(from, set) }
  for (const link of context.inputs.links) {
    if (link.type !== 'FS' || !context.active.has(link.from) || !context.active.has(link.to)) continue
    if (link.method !== undefined && !context.variant.methods.some(chosen => chosen.choice === link.method!.choice && chosen.option === link.method!.option)) continue
    add(link.from, link.to)
  }
  const active = [...context.active].map(key => context.jobs.get(key)!)
  for (const work of active.filter(job => job.kind === 'work' && job.isolation === 'inside')) {
    for (const other of active) {
      if (!other.equipment.includes(work.equipment[0]!)) continue
      if (other.kind === 'tag-out') add(other.key, work.key)
      if (other.kind === 'test') add(work.key, other.key)
    }
  }
  return next
}

const reaches = (graph: ReadonlyMap<string, ReadonlySet<string>>, from: string, to: string): boolean => {
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const following of graph.get(current) ?? []) {
      if (following === to) return true
      if (!seen.has(following)) { seen.add(following); queue.push(following) }
    }
  }
  return false
}

export const verifyCertificate = (inputs: PlanInputs, variant: CheckVariant, certificate: Certificate): CertificateCheck => {
  const prepared = prepare(inputs, variant)
  if (!prepared.ok) return { ok: false, problems: prepared.problems.map(problem => problem.words), unverified: [], figures: {} }
  const context = prepared.context
  const problems: string[] = []
  const unverified: string[] = []
  const figures: Record<string, number> = {}
  const jobOf = (key: string): Job | undefined => {
    const job = context.jobs.get(key)
    if (job === undefined || !context.active.has(key)) { problems.push(`The certificate names '${key}', which is not a job of this variant.`); return undefined }
    return job
  }

  switch (certificate.kind) {
    case 'chain': {
      const jobs = certificate.jobs.map(jobOf).filter((job): job is Job => job !== undefined)
      if (jobs.length !== certificate.jobs.length) break
      const graph = precedes(context)
      for (let index = 1; index < jobs.length; index++) {
        if (!reaches(graph, jobs[index - 1]!.key, jobs[index]!.key)) problems.push(`'${jobs[index]!.title}' is not bound to follow '${jobs[index - 1]!.title}', so the jobs are not a chain.`)
      }
      const least = jobs.map(job => leastWorkHours(context, job))
      if (least.some(hours => hours === undefined)) { problems.push('A chain job has no readable duration.'); break }
      const work = least.reduce((sum: number, hours) => sum + hours!, 0)
      const from = Date.parse(certificate.from), by = Date.parse(certificate.by)
      const union = new Uint8Array(context.grid.slots)
      for (const job of jobs) eligibleSlots(context, job).forEach((slot, index) => { if (slot === 1) union[index] = 1 })
      const available = hoursIn(union, context, from, by)
      figures.workHours = work
      figures.availableHours = available
      if (certificate.workHours > work + 1e-9) problems.push(`The chain claims ${certificate.workHours} h of work; its jobs need at least ${work} h.`)
      if (certificate.availableHours + 1e-9 < available) problems.push(`The chain claims ${certificate.availableHours} h available; its resources can work ${available} h in that interval.`)
      if (!(work > available)) problems.push(`The chain's ${work} h of work fit in the ${available} h available, so it proves nothing.`)
      // the interval must hold every possible placement of the chain
      const first = jobs[0]!
      const earliestPossible = Math.max(context.windowStart, first.notBefore === undefined ? -Infinity : Date.parse(first.notBefore.at))
      const firstSlots = eligibleSlots(context, first)
      const firstWorking = firstSlots.findIndex((slot, index) => slot === 1 && context.windowStart + index * context.grid.slotMs >= earliestPossible)
      const earliest = firstWorking < 0 ? Infinity : context.windowStart + firstWorking * context.grid.slotMs
      if (from > earliest) problems.push(`The chain starts its count at ${new Date(from).toISOString()}, but '${first.title}' could start at ${new Date(earliest).toISOString()}.`)
      const last = jobs[jobs.length - 1]!
      const dueBy = Math.min(context.windowEnd, ...inputs.rules.flatMap(rule => rule.kind === 'due' && rule.job === last.key ? [Date.parse(rule.finishBy)] : []))
      if (by < dueBy) unverified.push('a deadline before the window end or the last job\'s due time (from a span limit or a later job) is not re-derived')
      break
    }
    case 'energy': {
      const jobs = certificate.jobs.map(jobOf).filter((job): job is Job => job !== undefined)
      const pool = new Set(certificate.resources)
      for (const key of pool) if (!context.resources.has(key)) problems.push(`The certificate names a resource '${key}' that the plan does not have.`)
      // the pool must hold every resource that could do the counted work (A5: unions of eligible resources)
      for (const job of jobs) for (const need of job.needs) {
        if (!need.anyOf.some(key => pool.has(key))) continue
        for (const key of need.anyOf) if (!pool.has(key)) problems.push(`'${job.title}' can also be done by '${context.resources.get(key)?.label ?? key}', which the certificate leaves out.`)
      }
      const work = jobs.reduce((sum, job) => {
        const amount = job.needs.filter(need => need.anyOf.some(key => pool.has(key))).reduce((total, need) => total + need.amount, 0)
        return sum + amount * (leastWorkHours(context, job) ?? 0)
      }, 0)
      const from = Date.parse(certificate.from), to = Date.parse(certificate.to)
      let capacity = 0
      for (const key of pool) {
        const resource = context.resources.get(key)
        if (resource === undefined) continue
        const slots = new Uint8Array(context.grid.slots)
        context.calendars.get(resource.calendar)?.forEach((slot, index) => { if (slot === 1) slots[index] = 1 })
        for (const purchase of context.inputs.purchases) if (purchase.resource === key && context.permitted.has(purchase.key)) context.added.get(purchase.key)!.forEach((slot, index) => { if (slot === 1) slots[index] = 1 })
        capacity += resource.count * hoursIn(slots, context, from, to)
      }
      figures.requiredHours = work
      figures.availableHours = capacity
      if (certificate.requiredHours > work + 1e-9) problems.push(`The certificate claims ${certificate.requiredHours} h required; the named jobs need at least ${work} h of the named resources.`)
      if (certificate.availableHours + 1e-9 < capacity) problems.push(`The certificate claims ${certificate.availableHours} h available; the named resources have ${capacity} h in that interval.`)
      if (!(certificate.requiredHours > capacity)) problems.push(`The required ${certificate.requiredHours} h fit in the ${capacity} h available, so it proves nothing.`)
      unverified.push('that the named work is forced inside the interval (propagation) is not re-derived')
      break
    }
    case 'availability': {
      const rule = inputs.rules.find(candidate => candidate.key === certificate.rule)
      if (rule === undefined || rule.kind !== 'keep-in-service') { problems.push(`The certificate names '${certificate.rule}', which is not a keep-in-service rule.`); break }
      const members = new Set(rule.members.map(member => 'equipment' in member ? member.equipment : member.resource))
      for (const item of certificate.items) if (!members.has(item)) problems.push(`'${item}' is not a member of the rule.`)
      if (certificate.items.length <= rule.members.length - rule.atLeast) problems.push(`Only ${certificate.items.length} items are named; the rule allows ${rule.members.length - rule.atLeast} out together, so this proves nothing.`)
      unverified.push('that the named items are forced out together is not re-derived')
      break
    }
    case 'temporal':
      for (const step of certificate.steps) jobOf(step.job)
      unverified.push('the propagation steps are not re-derived')
      break
  }
  return { ok: problems.length === 0, problems, unverified, figures }
}
