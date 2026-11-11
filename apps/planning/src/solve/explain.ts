// Explanations from structure (design §6.7). "Why it starts then": every slot between the earliest time
// the links allow and the start is refused by something; the distinct causes, in time order, are the
// joint cause set (at most 4; above that, the four that hold longest, each of which binds). "What sets
// the finish": a chain of up to 20 hops back from a job through the cause that held it last. Each item
// carries its float. Prose is rendered elsewhere from these items.
import type { z } from 'zod'
import type { explainResultSchema } from '../api/contract.ts'
import type { CompileIndex } from './compile.ts'
import { ffHolds, finishOf, makeDecoder, progressAt, workedSlots, type Prepared } from './decode.ts'
import type { Float } from './float.ts'
import type { Schedule } from './problem.ts'

export type ExplainItem = z.infer<typeof explainResultSchema>['items'][number]
type Cause = ExplainItem['because'][number]

export interface ExplainContext {
  readonly prep: Prepared
  readonly index: CompileIndex
  readonly schedule: Schedule
  readonly floats: readonly Float[]
  /** settings.dataDate as a slot, when it is inside the window. */
  readonly dataDateSlot?: number
}

const iso = (index: CompileIndex, slot: number) => new Date(index.origin + slot * index.slotMs).toISOString()
const keyOf = (ctx: ExplainContext, a: number) => ctx.index.jobs[a] ?? ctx.prep.problem.activities[a]!.id.replace(/[^A-Za-z0-9._-]/g, '-')

/** Activities using resource r at slot x in the schedule, except a. */
const usersAt = (ctx: ExplainContext, r: number, x: number, except: number): number[] => {
  const { prep, schedule } = ctx
  const out: number[] = []
  prep.problem.activities.forEach((activity, b) => {
    if (b === except) return
    const m = schedule.mode[b]!
    if (!activity.modes[m]!.demands.some(d => d.resource === r)) return
    if (finishOf(prep, b, m, schedule.start[b]!) < 0) return
    if (workedSlots(prep, b, m, schedule.start[b]!).includes(x)) out.push(b)
  })
  return out
}

/** Out intervals per item in the schedule, own and supporters', as [first out, last back). */
const itemOut = (ctx: ExplainContext): Array<[number, number] | undefined> => {
  const { prep, schedule } = ctx
  return prep.problem.items.map((_, i) => {
    const openers = prep.itemOpeners[i]!, closers = prep.itemClosers[i]!
    if (openers.length === 0) return undefined
    const from = Math.min(...openers.map(o => schedule.start[o]!))
    const to = closers.length === 0 ? prep.H : Math.max(...closers.map(c => finishOf(prep, c, schedule.mode[c]!, schedule.start[c]!)))
    return [from, to]
  })
}

export const makeExplainer = (ctx: ExplainContext) => {
  const { prep, index, schedule } = ctx
  const { problem } = prep
  const decoder = makeDecoder(prep)
  const out = itemOut(ctx)

  const whyStart = (a: number): ExplainItem & { readonly next?: number } => {
    const activity = problem.activities[a]!
    const m = schedule.mode[a]!, start = schedule.start[a]!
    const finish = finishOf(prep, a, m, start)
    const base = { job: keyOf(ctx, a), start: iso(index, start), finish: iso(index, finish), floatHours: ctx.floats[a]?.workingHours ?? 0 }
    if (activity.fixed !== undefined) return { ...base, because: [{ kind: 'lock', about: [keyOf(ctx, a)] }], joint: false }
    // The earliest start the links and releases allow, and what sets it.
    let earliest = Math.max(activity.release, activity.modes[m]!.release)
    const ffLinks: Array<{ finish: number; lag: number }> = []
    const binding: Cause[] = []
    let bindingPred = -1
    const consider = (value: number, cause: Cause, pred = -1): void => {
      if (value > earliest) { earliest = value; binding.length = 0; bindingPred = pred }
      if (value === earliest) { binding.push(cause); if (pred >= 0 && bindingPred < 0) bindingPred = pred }
    }
    if (earliest > 0) consider(earliest, ctx.dataDateSlot !== undefined && earliest === ctx.dataDateSlot ? { kind: 'data-date', about: [] } : { kind: 'release', about: [keyOf(ctx, a)] })
    else binding.push({ kind: 'window', about: [] })
    for (const l of prep.preds[a]!) {
      const kind: Cause['kind'] = l.origin === 'link' ? 'link' : 'link'
      const pred = l.from, predFinish = finishOf(prep, pred, schedule.mode[pred]!, schedule.start[pred]!)
      if (l.type === 'FS') consider(predFinish + l.min, { kind, about: [keyOf(ctx, pred)], until: iso(index, predFinish + l.min) }, pred)
      else if (l.type === 'SS') { const ready = progressAt(prep, pred, schedule.mode[pred]!, schedule.start[pred]!, l.min); consider(ready, { kind, about: [keyOf(ctx, pred)], until: iso(index, ready) }, pred) }
      else ffLinks.push({ finish: predFinish, lag: l.min })
    }
    // Every slot from there to the start is refused by something, in every mode (another crew or
    // truck could have served it): name what refuses it.
    decoder.load(schedule, a)
    const stretches: Array<{ cause: Cause; slots: number; last: number; blocker?: number }> = []
    const note = (cause: Cause, t: number, blocker?: number): void => {
      const known = stretches.find(entry => entry.cause.kind === cause.kind && entry.cause.about.join() === cause.about.join())
      if (known !== undefined) { known.slots++; known.last = Math.max(known.last, t); if (blocker !== undefined) known.blocker = blocker }
      else stretches.push({ cause, slots: 1, last: t, ...(blocker === undefined ? {} : { blocker }) })
    }
    activity.modes.forEach((mode, k) => {
      const from = k === m ? earliest : Math.max(earliest, mode.release)
      if (k !== m && mode.release > earliest) for (let t = earliest; t < Math.min(mode.release, start); t++) note({ kind: 'release', about: mode.demands.map(d => index.resources[d.resource]!).slice(0, 6) }, t)
      const resourcesOf = mode.demands.map(d => index.resources[d.resource]!)
      for (let t = from; t < start; t++) {
        const f = finishOf(prep, a, k, t)
        if (f < 0) { note({ kind: 'shift', about: resourcesOf.slice(0, 6) }, t); continue }
        if (!ffLinks.every(link => ffHolds(prep, a, k, t, link.finish, link.lag))) { note({ kind: 'link', about: prep.preds[a]!.filter(l => l.type === 'FF').map(l => keyOf(ctx, l.from)).slice(0, 6) }, t); continue }
        const coverage = prep.opensCoverage[a]!.find(c => {
          const rule = problem.coverage[c]!
          const opening = new Set(prep.opensItems[a]!)
          const outAt = rule.items.filter(i => opening.has(i) || (out[i] !== undefined && out[i]![0] <= t && t < out[i]![1] && !prep.itemOpeners[i]!.every(o => o === a)))
          return outAt.length > rule.items.length - rule.atLeast
        })
        if (coverage !== undefined) { note({ kind: 'availability', about: [problem.coverage[coverage]!.id] }, t); continue }
        const refusal = decoder.refusal(a, k, t)
        if (refusal.kind === 'capacity') {
          const users = usersAt(ctx, refusal.resource, refusal.slot, a)
          note({ kind: index.resourceKinds[refusal.resource] === 'tool' ? 'tool' : 'crew', about: [index.resources[refusal.resource]!, ...users.map(b => keyOf(ctx, b))].slice(0, 6) }, t, users[0])
        } else if (refusal.kind === 'replaced') note({ kind: 'tool', about: [index.resources[refusal.resource]!, refusal.purchase] }, t)
        else if (refusal.kind === 'max-jobs') note({ kind: index.resourceKinds[refusal.resource] === 'tool' ? 'tool' : 'crew', about: [index.resources[refusal.resource]!] }, t)
        else if (refusal.kind === 'coverage') note({ kind: 'availability', about: [problem.coverage[refusal.rule]!.id] }, t)
        else if (k === m) {
          // Free, yet later: moved late on purpose (shorter outage) or held by a span limit's repair.
          const span = prep.opensSpans[a]!.find(s => problem.spans[s]!.limit !== undefined)
          note(span !== undefined && index.spans[span]?.rule !== undefined ? { kind: 'span-limit', about: [index.spans[span]!.rule!] } : { kind: 'late-as-possible', about: [] }, t)
        }
      }
    })
    const delays = stretches.sort((x, y) => y.slots - x.slots || x.last - y.last).slice(0, 4 - Math.min(binding.length, 1)).sort((x, y) => x.last - y.last)
    const causes: Cause[] = [...binding.slice(0, delays.length > 0 ? 1 : 4), ...delays.map(entry => ({ ...entry.cause, until: iso(index, entry.last + 1) }))].slice(0, 4)
    const blocker = delays.at(-1)?.blocker
    const next = blocker ?? (bindingPred >= 0 ? bindingPred : undefined)
    return { ...base, because: causes, joint: causes.length > 1, ...(next === undefined ? {} : { next }) }
  }

  /** The chain that sets a job's finish (default: the last to finish), at most 20 hops. */
  const finishChain = (target?: number): ExplainItem[] => {
    let a = target ?? problem.activities.reduce((best, _, b) => (finishOf(prep, b, schedule.mode[b]!, schedule.start[b]!) > finishOf(prep, best, schedule.mode[best]!, schedule.start[best]!) && index.jobs[b] !== null ? b : best), 0)
    const items: ExplainItem[] = []
    const seen = new Set<number>()
    for (let hop = 0; hop < 20 && !seen.has(a); hop++) {
      seen.add(a)
      const { next, ...item } = whyStart(a)
      items.push(item)
      if (next === undefined) break
      a = next
    }
    return items
  }

  return { whyStart: (a: number): ExplainItem => { const { next: _next, ...item } = whyStart(a); return item }, finishChain }
}
