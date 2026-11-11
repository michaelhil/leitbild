// Independent re-verification of an infeasibility certificate from the plan inputs. The solver's figures are
// recomputed, never copied, and its premises are re-derived with the checker's own propagation
// (check/propagate.ts) in every case of the variant's optional rebookings. A certificate proves
// infeasibility only when `ok` and nothing is left `unverified`; recheck shows anything less as unresolved.
//
// Re-derived: a chain (precedence, least work, the hours any job of it could work, its interval); a
// temporal contradiction; energy in a fixed interval, or in every window of a single-entry span limit, with
// the work forced into it; an availability rule broken by outages every schedule must contain.
import type { Certificate, PlanInputs } from '../plan/schema.ts'
import { prepare, type CheckVariant, type Context } from './check.ts'
import { jobSlots, leastWork, propagate, resourceSlots, worldsOf, type JobWindow, type World } from './propagate.ts'

export interface CertificateCheck {
  /** The certificate proves infeasibility: no problem found and nothing left unverified. Decide proof on this. */
  readonly proves: boolean
  /** No problem found in its figures; parts may still be unverified, so this alone is never a proof. */
  readonly ok: boolean
  readonly problems: readonly string[]
  /** Premises the checker could not re-derive; any entry means the certificate is not a proof. */
  readonly unverified: readonly string[]
  /**
   * Cases of the variant's optional rebookings that the checker's own time logic already rules out, so the
   * certificate's argument was not needed there. Each entry gives the case's cause in planner words: the
   * jobs, hours, calendars, links and limits that rule it out. When every case is listed, the refusal is
   * better worded from these than from the certificate's figures.
   */
  readonly refutedByTime: readonly string[]
  /** The checker's own figures (from the case with the least margin). */
  readonly figures: Readonly<Record<string, number>>
}

type Job = PlanInputs['jobs'][number]
const hourMs = 3_600_000

const countIn = (slots: Uint8Array, from: number, to: number): number => {
  let count = 0
  for (let slot = Math.max(0, from); slot < Math.min(slots.length, to); slot++) count += slots[slot]!
  return count
}

/** Finish-to-start precedence among active jobs: FS links and the brackets of single-outage items. */
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
    const tags = active.filter(other => other.kind === 'tag-out' && other.equipment.includes(work.equipment[0]!))
    if (tags.length !== 1) continue
    add(tags[0]!.key, work.key)
    for (const test of active.filter(other => other.kind === 'test' && other.equipment.includes(work.equipment[0]!))) add(work.key, test.key)
  }
  return next
}

const reaches = (graph: ReadonlyMap<string, ReadonlySet<string>>, from: string, to: string): boolean => {
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length > 0) {
    for (const following of graph.get(queue.shift()!) ?? []) {
      if (following === to) return true
      if (!seen.has(following)) { seen.add(following); queue.push(following) }
    }
  }
  return false
}

/** Work of a job forced into [from, to): its least work less what fits before `from` and after `to`. */
const forcedInto = (window: JobWindow, from: number, to: number, latestFinish: number): number => {
  const before = countIn(window.calendar, window.es, Math.min(from, latestFinish))
  const after = countIn(window.calendar, Math.max(to, window.es), latestFinish)
  return Math.max(0, window.work - before - after)
}

export const verifyCertificate = (inputs: PlanInputs, variant: CheckVariant, certificate: Certificate): CertificateCheck => {
  const prepared = prepare(inputs, variant)
  if (!prepared.ok) return { proves: false, ok: false, problems: prepared.problems.map(problem => problem.words), unverified: [], refutedByTime: [], figures: {} }
  const context = prepared.context
  const { grid } = context
  const problems: string[] = []
  const unverified: string[] = []
  const figures: Record<string, number> = {}
  const refutedByTime: string[] = []
  const slotOf = (instant: number): number => (instant - context.windowStart) / grid.slotMs
  const hours = (slots: number): number => slots * grid.slotMs / hourMs
  const iso = (slot: number): string => new Date(context.windowStart + slot * grid.slotMs).toISOString()
  const jobOf = (key: string): Job | undefined => {
    const job = context.jobs.get(key)
    if (job === undefined || !context.active.has(key)) { problems.push(`The certificate names '${key}', which is not a job of this variant.`); return undefined }
    return job
  }
  const worlds = worldsOf(context)
  /** Each case either contradicts itself in time, or must be refuted by `refute`. */
  const everyCase = (what: string, refute: (world: World, windows: ReadonlyMap<string, JobWindow>) => string | undefined): void => {
    for (const world of worlds) {
      const name = [...world].map(([key, taken]) => `${key} ${taken ? 'taken' : 'not taken'}`).join(', ') || 'the variant as given'
      const timed = propagate(context, world)
      if (!timed.ok) { refutedByTime.push(`With ${name}: ${timed.words}`); continue }
      const gap = refute(world, timed.windows)
      if (gap !== undefined) unverified.push(`${what} with ${name}: ${gap}`)
    }
  }

  switch (certificate.kind) {
    case 'chain': {
      const jobs = certificate.jobs.map(jobOf).filter((job): job is Job => job !== undefined)
      if (jobs.length !== certificate.jobs.length) break
      const graph = precedes(context)
      for (let index = 1; index < jobs.length; index++) {
        if (!reaches(graph, jobs[index - 1]!.key, jobs[index]!.key)) problems.push(`'${jobs[index]!.title}' is not bound to follow '${jobs[index - 1]!.title}', so the jobs are not a chain.`)
      }
      const least = jobs.map(job => leastWork(context, job))
      if (least.some(work => work === undefined)) { problems.push('A chain job has no readable duration.'); break }
      const work = least.reduce((sum: number, slots) => sum + slots!, 0)
      const from = slotOf(Date.parse(certificate.from)), by = slotOf(Date.parse(certificate.by))
      figures.workHours = hours(work)
      if (certificate.workHours > hours(work) + 1e-9) problems.push(`The chain claims ${certificate.workHours} h of work; its jobs need at least ${hours(work)} h.`)
      // the chain's own argument, in every case: work beyond the hours any of its jobs could work in [from, by)
      for (const world of worlds) {
        const name = [...world].map(([key, taken]) => `${key} ${taken ? 'taken' : 'not taken'}`).join(', ') || 'the variant as given'
        // a slot counts when the job could work in it: every one of its needs has an eligible resource on duty
        const union = new Uint8Array(grid.slots)
        for (const job of jobs) jobSlots(context, job, world).forEach((slot, index) => { if (slot === 1) union[index] = 1 })
        const available = countIn(union, Math.ceil(from), Math.floor(by))
        figures.availableHours = Math.max(figures.availableHours ?? 0, hours(available))
        if (certificate.availableHours + 1e-9 < hours(available)) problems.push(`The chain claims ${certificate.availableHours} h available; its jobs can work ${hours(available)} h in that interval (${name}).`)
        if (!(work > available)) { unverified.push(`the chain with ${name}: its ${hours(work)} h of work fit in the ${hours(available)} h available`); continue }
        // the interval must hold every placement: the first job cannot start before it, the last cannot end after
        const timed = propagate(context, world)
        const first = jobs[0]!, last = jobs[jobs.length - 1]!
        const firstSlots = jobSlots(context, first, world)
        const release = first.notBefore === undefined ? 0 : Math.ceil(slotOf(Date.parse(first.notBefore.at)))
        const earliest = timed.ok ? timed.windows.get(first.key)!.es : firstSlots.findIndex((slot, index) => slot === 1 && index >= release)
        if (earliest < from) unverified.push(`the chain with ${name}: '${first.title}' could start at ${iso(earliest)}, before the interval`)
        const lastWindow = timed.ok ? timed.windows.get(last.key)! : undefined
        const latestFinish = lastWindow !== undefined ? lastWindow.finishOf(lastWindow.ls)
          : Math.min(grid.slots, ...inputs.rules.flatMap(rule => rule.kind === 'due' && rule.job === last.key ? [Math.floor(slotOf(Date.parse(rule.finishBy)))] : []))
        if (latestFinish > by) unverified.push(`the chain with ${name}: '${last.title}' could finish at ${iso(latestFinish)}, after the interval`)
      }
      break
    }
    case 'temporal': {
      const steps = certificate.steps.map(step => ({ step, job: jobOf(step.job) }))
      const graph = precedes(context)
      // each step reached by a link, a bracket or the support order follows the step before it
      steps.forEach(({ step, job }, index) => {
        const previous = steps[index - 1]?.job
        if (index === 0 || job === undefined || previous === undefined || !['link', 'bracket', 'support-order'].includes(step.via)) return
        const linked = inputs.links.some(link => link.from === previous.key && link.to === job.key)
        const supported = step.via === 'support-order' && job.kind === 'test' && previous.kind === 'test'
        if (!linked && !supported && !reaches(graph, previous.key, job.key)) problems.push(`'${job.title}' is not bound by ${step.via} to follow '${previous.title}'.`)
      })
      everyCase('the time logic', () => 'the checker\'s own propagation finds no contradiction')
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
      const amountOf = (job: Job): number => job.needs.filter(need => need.anyOf.some(key => pool.has(key))).reduce((total, need) => total + need.amount, 0)
      const capacityIn = (world: World, from: number, to: number): number => [...pool].reduce((sum, key) => sum + (context.resources.get(key)?.count ?? 0) * countIn(resourceSlots(context, key, world), from, to), 0)
      const spanRule = certificate.span === undefined ? undefined : inputs.rules.find(rule => rule.kind === 'span-limit' && (rule.key === certificate.span || rule.group === certificate.span))
      if (certificate.span !== undefined && (spanRule === undefined || spanRule.kind !== 'span-limit' || !spanRule.singleEntry)) { problems.push(`The certificate names '${certificate.span}', which is not a single-entry span limit.`); break }
      everyCase('the energy count', (world, windows) => {
        if (spanRule === undefined || spanRule.kind !== 'span-limit') {
          const from = Math.ceil(slotOf(Date.parse(certificate.from))), to = Math.floor(slotOf(Date.parse(certificate.to)))
          const required = jobs.reduce((sum, job) => { const window = windows.get(job.key)!; return sum + amountOf(job) * forcedInto(window, from, to, window.finishOf(window.ls)) }, 0)
          const capacity = capacityIn(world, from, to)
          figures.requiredHours = hours(required)
          figures.availableHours = hours(capacity)
          if (certificate.availableHours + 1e-9 < hours(capacity)) problems.push(`The certificate claims ${certificate.availableHours} h available; the named resources have ${hours(capacity)} h in that interval.`)
          return required > capacity ? undefined : `only ${hours(required)} h is forced into the interval, against ${hours(capacity)} h available`
        }
        // every window [s, s + limit) the group's span could start in: the members' bracketed work lies
        // inside; another job's work counts where it is forced inside
        const limit = Math.floor(spanRule.limit.value * ({ s: 1_000, min: 60_000, h: hourMs, d: 86_400_000 } as Record<string, number>)[spanRule.limit.unit]! / grid.slotMs + 1e-9)
        const members = new Set(inputs.equipment.filter(item => item.group === spanRule.group).map(item => item.key))
        const inGroup = (job: Job): boolean => job.equipment.some(item => members.has(item)) && (job.kind !== 'work' || job.isolation === 'inside')
        // the span opens at the first outage of a member, its own or a supporter's
        const supportersOf = (item: string): string[] => inputs.equipment.find(entry => entry.key === item)?.supportedBy.flatMap(key => [key, ...supportersOf(key)]) ?? []
        const covered = new Set([...members].flatMap(member => [member, ...supportersOf(member)]))
        const openers = [...windows.values()].filter(window => (window.job.kind === 'tag-out' || window.job.kind === 'test') && window.job.equipment.some(item => covered.has(item)))
        if (openers.length === 0) return 'the group has no tag-out'
        const graph = precedes(context)
        const groupJobs = [...windows.values()].filter(window => inGroup(window.job)).map(window => window.job.key)
        const beforeGroup = new Set([...context.active].filter(key => groupJobs.some(target => target !== key && reaches(graph, key, target))))
        const lo = Math.min(...openers.map(window => window.es)), hi = Math.min(...openers.map(window => window.ls))
        let tightest: { required: number; capacity: number } | undefined
        for (let start = lo; start <= hi; start++) {
          const end = start + limit
          let required = 0
          for (const job of jobs) {
            const window = windows.get(job.key)!
            const latestFinish = beforeGroup.has(job.key) ? Math.min(window.finishOf(window.ls), end) : window.finishOf(window.ls)
            required += amountOf(job) * (inGroup(job) ? window.work : forcedInto(window, start, end, latestFinish))
          }
          const capacity = capacityIn(world, start, end)
          if (tightest === undefined || required - capacity < tightest.required - tightest.capacity) tightest = { required, capacity }
          if (required <= capacity) {
            figures.requiredHours = hours(required)
            figures.availableHours = hours(capacity)
            return `a span starting at ${iso(start)} needs ${hours(required)} h against ${hours(capacity)} h available`
          }
        }
        figures.requiredHours = hours(tightest?.required ?? 0)
        figures.availableHours = hours(tightest?.capacity ?? 0)
        return undefined
      })
      break
    }
    case 'availability': {
      const rule = inputs.rules.find(candidate => candidate.key === certificate.rule)
      if (rule === undefined || rule.kind !== 'keep-in-service') { problems.push(`The certificate names '${certificate.rule}', which is not a keep-in-service rule.`); break }
      const members = rule.members.map(member => 'equipment' in member ? member.equipment : member.resource)
      for (const item of certificate.items) if (!members.includes(item)) problems.push(`'${item}' is not a member of the rule.`)
      if (certificate.items.length <= rule.members.length - rule.atLeast) { problems.push(`Only ${certificate.items.length} items are named; the rule allows ${rule.members.length - rule.atLeast} out together, so this proves nothing.`); break }
      everyCase('the forced outages', (_world, windows) => {
        // an item with one tag-out is certainly out from that tag's latest start to its tests' earliest finish
        const forcedOut = (item: string): [number, number] | undefined => {
          const tags = [...windows.values()].filter(window => window.job.kind === 'tag-out' && window.job.equipment.includes(item))
          const tests = [...windows.values()].filter(window => window.job.kind === 'test' && window.job.equipment.includes(item))
          if (tags.length !== 1 || tests.length === 0) return undefined
          const from = tags[0]!.ls, to = Math.max(...tests.map(test => test.finishOf(test.es)))
          return from < to ? [from, to] : undefined
        }
        const supporters = (item: string): string[] => inputs.equipment.find(entry => entry.key === item)?.supportedBy.flatMap(key => [key, ...supporters(key)]) ?? []
        const outOf = (item: string) => [item, ...supporters(item)].flatMap(key => { const interval = forcedOut(key); return interval === undefined ? [] : [interval] })
        const from = Math.ceil(slotOf(Date.parse(certificate.from))), to = Math.floor(slotOf(Date.parse(certificate.to)))
        for (let slot = from; slot < to; slot++) {
          const out = certificate.items.filter(item => outOf(item).some(([start, end]) => start <= slot && slot < end)).length
          if (out > rule.members.length - rule.atLeast) return undefined
        }
        return 'no slot in the interval where every schedule has the named items out together'
      })
      break
    }
  }
  return { proves: problems.length === 0 && unverified.length === 0, ok: problems.length === 0, problems, unverified, refutedByTime, figures }
}
