// Explanations from structure (design §6.7). "Why it starts then": the smallest set of causes that together
// stop the job starting earlier with every other job fixed (links with their lag, releases, shifts and
// booking windows, full crews and what fills them, purchases not bought, keep-in-service and span rules);
// relaxing the set lets it start earlier (the counterfactual check). "What sets the finish": a chain of up
// to 20 hops back through those causes. Each item carries its float. Prose is rendered elsewhere.
import type { z } from 'zod'
import type { explainResultSchema } from '../api/contract.ts'
import type { Certificate, PlanInputs } from '../plan/schema.ts'
import { clip as clipWords } from '../plan/summary.ts'
import { dueTimeWords } from '../plan/refusal-words.ts'
import type { CheckVariant } from '../check/check.ts'
import { expandCalendar } from '../time/calendar.ts'
import { gridSlotMs } from '../time/units.ts'
import { localParts } from '../time/zone.ts'
import { bounds, type SpanRefusal } from './bounds.ts'
import { compile, type CompileIndex, type SubSolve } from './compile.ts'
import type { VerifyCertificate } from './status.ts'
import { ffHolds, finishOf, progressAt, workedSlots, type Prepared } from './decode.ts'
import type { Float } from './float.ts'
import type { Schedule } from './problem.ts'

export type ExplainItem = z.infer<typeof explainResultSchema>['items'][number]
type Cause = ExplainItem['because'][number]
type Named = Cause['about'][number]
const named = (kind: Named['kind'], keys: readonly string[]): Named[] => keys.map(key => ({ kind, key }))
const keysOf = (cause: Cause): string[] => cause.about.map(entry => entry.key)

export interface ExplainContext {
  readonly prep: Prepared
  readonly index: CompileIndex
  readonly schedule: Schedule
  readonly floats: readonly Float[]
  /** settings.dataDate as a slot, when it is inside the window. */
  readonly dataDateSlot?: number
  /** The option's purchases: time bought from any other purchase is "a purchase not allowed". */
  readonly purchases?: readonly string[]
  /** The plan's inputs, to read what holds a job at the window's first slot (the time just before the grid). */
  readonly inputs?: PlanInputs
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
  const out = itemOut(ctx)

  // Usage by everything except the job explained, for "what fills the slot before".
  const usageWithout = (a: number): Int16Array[] => {
    const usage = problem.resources.map(() => new Int16Array(prep.H))
    problem.activities.forEach((activity, b) => {
      if (b === a) return
      const m = schedule.mode[b]!, t = schedule.start[b]!
      if (finishOf(prep, b, m, t) < 0) return
      const slots = workedSlots(prep, b, m, t)
      for (const d of activity.modes[m]!.demands) for (const x of slots) if (d.when < 0 || prep.cal[d.when]!.pos[x]! >= 0) usage[d.resource]![x] = usage[d.resource]![x]! + d.amount
    })
    return usage
  }
  const name = (r: number) => index.resources[r]!
  const ruleKey = (c: number) => problem.coverage[c]!.id

  /**
   * What holds a job at the window's first slot: the window itself, and of what lies just before it, the data
   * date, the job's release, the resources of a mode that are off duty then (base time and the option's
   * purchases; the smallest set over the job's modes) and keep-in-service rules over resources that too few
   * members on duty would break then. Relaxing all of it lets the job start earlier.
   */
  const atWindowStart = (a: number): Cause[] => {
    const inputs = ctx.inputs
    if (inputs === undefined) return [{ kind: 'window', about: [] }]
    const before = index.origin - index.slotMs
    const held: Cause[] = [{ kind: 'window', about: [] }]
    if (inputs.settings.dataDate !== null && Date.parse(inputs.settings.dataDate) > before) held.push({ kind: 'data-date', about: [] })
    const job = inputs.jobs.find(entry => entry.key === index.jobs[a])
    if (job?.notBefore !== undefined && Date.parse(job.notBefore.at) > before) held.push({ kind: 'release', about: named('job', [job.key]) })
    const worksBefore = (calendarKey: string): boolean => {
      const calendar = inputs.calendars.find(entry => entry.key === calendarKey)
      if (calendar === undefined) return false
      const expanded = expandCalendar(calendar, { zone: inputs.settings.timeZone, slotMs: index.slotMs, origin: before, slots: 1 })
      return !expanded.ok || expanded.work[0] === 1
    }
    const onDuty = (key: string): boolean => {
      const resource = inputs.resources.find(entry => entry.key === key)
      if (resource === undefined || worksBefore(resource.calendar)) return true
      return inputs.purchases.some(purchase => purchase.resource === key && (ctx.purchases ?? []).includes(purchase.key)
        && ('calendar' in purchase.adds ? worksBefore(purchase.adds.calendar) : purchase.adds.periods.some(period => Date.parse(period.start) <= before && Date.parse(period.end) > before)))
    }
    // The scheduled mode first, so a tie names the resources the job uses.
    const modes = problem.activities[a]!.modes, scheduled = modes[schedule.mode[a]!]!
    let off: string[] | undefined, used: string[] = []
    for (const mode of [scheduled, ...modes.filter(entry => entry !== scheduled)]) {
      const keys = [...new Set(mode.demands.map(d => name(d.resource)))]
      const missing = keys.filter(key => !onDuty(key))
      if (off === undefined || missing.length < off.length) { off = missing; used = keys }
    }
    if (off !== undefined && off.length > 0) held.push({ kind: 'shift', about: named('resource', off.slice(0, 6)) })
    // A keep-in-service rule over resources that holds just before the window too, with too few of them on duty then.
    for (const rule of inputs.rules) {
      if (rule.kind !== 'keep-in-service' || (rule.during !== undefined && !(Date.parse(rule.during.start) <= before && before < Date.parse(rule.during.end)))) continue
      const members = rule.members.flatMap(member => ('resource' in member ? [member.resource] : []))
      if (members.length === 0) continue
      const free = members.filter(key => onDuty(key) && !(used.includes(key) && (inputs.resources.find(entry => entry.key === key)?.count ?? 1) <= 1)).length
      if (free + rule.members.length - members.length < rule.atLeast) held.push({ kind: 'availability', about: named('rule', [rule.key]) })
    }
    return held
  }

  /**
   * Everything that stops activity a starting at slot t in mode k with every other job where it is, as
   * relaxable causes (a link and its predecessors, a release, a crew's shift or booking window, a full
   * crew or tool and what fills it, a purchase the option does not use, a keep-in-service or span rule),
   * or 'fixed' when a reason cannot be relaxed (the data date, an eligibility change, replaced time).
   */
  const blockers = (a: number, k: number, t: number, usage: readonly Int16Array[]): Cause[] | 'fixed' => {
    const activity = problem.activities[a]!
    const mode = activity.modes[k]!
    const causes: Cause[] = []
    const floor = ctx.dataDateSlot ?? 0
    if (t < floor || t < mode.release && mode.release > activity.release) return 'fixed'
    if (t < activity.release) causes.push({ kind: 'release', about: named('job', [keyOf(ctx, a)]) })
    const contiguous = t + mode.work
    let f = finishOf(prep, a, k, t)
    // Predecessors whose link (with its lag) would be broken.
    const bound: string[] = []
    for (const l of prep.preds[a]!) {
      const p = l.from, pm = schedule.mode[p]!, ps = schedule.start[p]!, pf = finishOf(prep, p, pm, ps)
      const broken = l.type === 'FS' ? t < pf + l.min
        : l.type === 'SS' ? t < progressAt(prep, p, pm, ps, l.min)
        : f >= 0 ? !ffHolds(prep, a, k, t, pf, l.min) : contiguous < pf || contiguous - Math.max(t, pf) < l.min
      // A test never precedes the tag-out that isolates its own item: that order is not a planner's to lift.
      if (broken && l.origin === 'tag-before-test') return 'fixed'
      if (broken && !bound.includes(keyOf(ctx, p))) bound.push(keyOf(ctx, p))
    }
    // One cause per predecessor: each link (with its lag) is its own reason, and counts as one.
    for (const pred of bound) causes.push({ kind: 'link', about: named('job', [pred]) })
    // The shift or booking window: who is off duty for a start at t (the job would then run unbroken).
    let slots: ArrayLike<number>
    const offDuty = new Set<number>()
    if (f < 0) {
      if (mode.work === 0 || contiguous > prep.H || mode.demands.some(d => d.when >= 0)) return 'fixed'
      slots = Array.from({ length: mode.work }, (_, q) => t + q)
      for (const d of mode.demands) for (let q = 0; q < mode.work; q++) if (problem.resources[d.resource]!.capacity[t + q]! === 0) { offDuty.add(d.resource); break }
      if (offDuty.size === 0) return 'fixed'   // only this mode's own hours exclude it; another mode covers it
      causes.push({ kind: 'shift', about: named('resource', [...offDuty].map(name).slice(0, 6)) })
      f = contiguous
    } else slots = workedSlots(prep, a, k, t)
    // Full crews and tools at the worked slots, and purchased time the option does not buy.
    const full = new Map<number, Set<number>>()
    const unbought = new Set<string>()
    for (const d of mode.demands) {
      if (offDuty.has(d.resource)) continue
      const capacity = problem.resources[d.resource]!.capacity, used = usage[d.resource]!
      for (let q = 0; q < slots.length; q++) {
        const x = slots[q]!
        if (d.when >= 0 && prep.cal[d.when]!.pos[x]! < 0) continue
        const short = used[x]! + d.amount - capacity[x]!
        if (short > 1) return 'fixed'   // one more crew would not be enough
        if (short > 0 && !full.has(d.resource)) full.set(d.resource, new Set(usersAt(ctx, d.resource, x, a)))
        if (prep.forbiddenBy[d.resource]![x]! >= 0) return 'fixed'
        const owner = index.slotPurchase[d.resource]![x]!
        if (owner >= 0 && ctx.purchases !== undefined && !ctx.purchases.includes(index.purchases[owner]!.key)) unbought.add(index.purchases[owner]!.key)
      }
    }
    for (const [r, users] of full) causes.push({ kind: index.resourceKinds[r] === 'tool' ? 'tool' : 'crew', about: [...named('resource', [name(r)]), ...named('job', [...users].map(b => keyOf(ctx, b)))].slice(0, 6) })
    for (const key of unbought) causes.push({ kind: 'purchase-not-allowed', about: named('purchase', [key]) })
    // Keep-in-service: tagging out earlier must not put more items out together than the rule allows.
    const start = schedule.start[a]!
    for (const c of prep.opensCoverage[a]!) {
      const rule = problem.coverage[c]!
      const mine = rule.items.filter(i => prep.opensItems[a]!.includes(i))
      for (let x = t; x < Math.min(start, rule.to); x++) {
        const others = rule.items.filter(i => !mine.includes(i) && out[i] !== undefined && out[i]![0] <= x && x < out[i]![1]).length
        if (others + mine.length > rule.items.length - rule.atLeast) { causes.push({ kind: 'availability', about: named('rule', [ruleKey(c)]) }); break }
      }
    }
    for (const d of mode.demands) for (const c of prep.resourceCoverage[d.resource]!) {
      const rule = problem.coverage[c]!
      for (let q = 0; q < slots.length; q++) {
        const x = slots[q]!
        if (x < rule.from || x >= rule.to) continue
        let free = 0
        for (const r of rule.resources) if (problem.resources[r]!.capacity[x]! - usage[r]![x]! - (mode.demands.some(e => e.resource === r) ? 1 : 0) > 0) free++
        if (free < rule.atLeast) { if (!causes.some(cause => cause.kind === 'availability' && cause.about[0]?.key === ruleKey(c))) causes.push({ kind: 'availability', about: named('rule', [ruleKey(c)]) }); break }
      }
    }
    // A span limit: an earlier first tag-out with the same last test back makes the span longer.
    for (const s of prep.opensSpans[a]!) {
      const limit = problem.spans[s]!.limit, rule = index.spans[s]!.rule
      if (limit === undefined || rule === undefined) continue
      const first = Math.min(...prep.spanOpeners[s]!.map(o => (o === a ? t : schedule.start[o]!)))
      const back = Math.max(...prep.spanClosers[s]!.map(cl => (cl === a ? f : finishOf(prep, cl, schedule.mode[cl]!, schedule.start[cl]!))))
      if (back - first > limit) causes.push({ kind: 'span-limit', about: named('rule', [rule]) })
    }
    return causes
  }

  /**
   * Why a job starts when it does: the smallest set of causes that together stop it starting at any earlier
   * slot, in any of its modes, with every other job where it is. Relaxing the whole set lets it start earlier
   * (at the slot found); with two or more, no one of them alone does, or a smaller set would have been found.
   */
  const whyStart = (a: number): ExplainItem & { readonly next?: number } => {
    const activity = problem.activities[a]!
    const m = schedule.mode[a]!, start = schedule.start[a]!
    const finish = finishOf(prep, a, m, start)
    const base = { job: keyOf(ctx, a), start: iso(index, start), finish: iso(index, finish), floatHours: ctx.floats[a]?.workingHours ?? 0 }
    if (activity.fixed !== undefined) return { ...base, because: [{ kind: 'lock', about: named('job', [keyOf(ctx, a)]) }], joint: false }
    // At the window's first slot: everything that holds it there, together.
    if (start === 0) { const held = atWindowStart(a).slice(0, 4); return { ...base, because: held.map(cause => ({ ...cause, until: iso(index, start) })), joint: held.length > 1 } }
    const usage = usageWithout(a)
    let best: { causes: Cause[]; t: number } | undefined
    // Single causes that alone let it start earlier at the best slot, in any mode (alternatives, not joint).
    const singles: Cause[] = []
    for (let t = start - 1; t >= 0 && (best === undefined || best.causes.length > 0); t--) {
      for (let k = 0; k < activity.modes.length; k++) {
        const found = blockers(a, k, t, usage)
        if (found === 'fixed') continue
        if (best === undefined || found.length < best.causes.length) { best = { causes: found, t }; singles.length = 0 }
        if (found.length === 1 && best.t === t && !singles.some(cause => cause.kind === found[0]!.kind && keysOf(cause).join() === keysOf(found[0]!).join())) singles.push(found[0]!)
        if (found.length === 0) break
      }
    }
    if (best === undefined) return { ...base, because: [{ kind: ctx.dataDateSlot !== undefined && start <= ctx.dataDateSlot ? 'data-date' : 'window', about: [] }], joint: false }
    if (best.causes.length === 0) return { ...base, because: [{ kind: 'late-as-possible', about: [] }], joint: false }
    // Each named cause holds until the job's start. One cause, or several alternatives that each suffice
    // alone (joint false); or the smallest set that holds it only together (joint true).
    const chosen = best.causes.length === 1 ? singles : best.causes
    const because = chosen.slice(0, 4).map(cause => ({ ...cause, until: iso(index, start) }))
    const joint = best.causes.length > 1
    // Follow the chain through what holds it longest: the first named predecessor, else the first job filling a crew.
    const link = best.causes.find(cause => cause.kind === 'link')
    const filler = best.causes.find(cause => (cause.kind === 'crew' || cause.kind === 'tool') && cause.about.length > 1)
    const nextKey = link?.about[0]?.key ?? filler?.about[1]?.key
    const next = nextKey === undefined ? -1 : index.jobs.indexOf(nextKey)
    return { ...base, because, joint, ...(next >= 0 ? { next } : {}) }
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

// ───────────── refusals in planner words ─────────────

const weekday = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' } as const
/** "Thu 09:00" in the plan's zone (UTC when the plan has none). */
export const localTime = (instant: string, zone: string | null): string => {
  const parts = localParts(zone ?? 'UTC', Date.parse(instant))
  return `${weekday[parts.weekday]} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}
const hoursText = (value: number): string => `${Number.isInteger(value) ? value : value.toFixed(1)} h`
const list = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)
/** One line within 240 characters, cut at a word boundary with "…", never mid-word (walk 2 N-02, walk 3). */
const clip = (line: string): string => clipWords(line, 240)

/**
 * A proven-infeasible refusal in planner words and hours, generated from the certificate (and, for a
 * span limit, the least span bounds() found). Never a raw propagation fact.
 */
export const refusalLines = (cause: Certificate, inputs: PlanInputs, span?: SpanRefusal, purchases?: readonly string[], methods?: CheckVariant['methods'], subject = 'this plan'): string[] => {
  const lines = refusalBody(cause, inputs, span, { methods: methods ?? [], purchases: purchases ?? [] }, subject)
  if (purchases === undefined) return lines
  // Say what the answer assumes may be bought (e.g. "days only": a tool day and a rebooking, no crew hours).
  const label = (key: string) => inputs.purchases.find(purchase => purchase.key === key)?.label ?? key
  const without = inputs.purchases.filter(purchase => !purchases.includes(purchase.key)).map(purchase => purchase.label)
  // Two sentences, each its own line, so neither is cut at the line length.
  const assumes = purchases.length === 0 ? ['This request allowed no purchases.']
    : [clip(`This request allowed: ${list(purchases.map(label))}.`), ...(without.length === 0 ? [] : [clip(`It did not allow: ${list(without)}.`)])]
  // At most 20 lines: a long body gives up a middle line and keeps its last (as refusalBody itself does).
  const room = 20 - assumes.length
  return [...(lines.length <= room ? lines : [...lines.slice(0, room - 1), lines.at(-1)!]), ...assumes]
}

/**
 * The refusal of one sub-solve, from the inputs: compiles, finds the bounds, and keeps the second proof
 * only when lane K's re-verification confirms it. Undefined when bounds find no proof.
 */
export const explainRefusal = (inputs: PlanInputs, sub: SubSolve, verify: VerifyCertificate): { readonly cause: Certificate; readonly proves: boolean; readonly lines: string[] } | undefined => {
  const compiled = compile(inputs, sub)
  if (!compiled.ok) return undefined
  const found = bounds(compiled.problem, compiled.index)
  if (found.certificate === undefined) return undefined
  const variant = { methods: sub.methods, purchases: compiled.index.allowedPurchases }
  const proves = verify(inputs, variant, found.certificate).proves
  const also = found.span?.alsoProven
  const span = found.span === undefined ? undefined
    : also !== undefined && verify(inputs, variant, also).proves ? found.span : (({ alsoProven: _also, ...rest }) => rest)(found.span)
  return { cause: found.certificate, proves, lines: refusalLines(found.certificate, inputs, span, compiled.index.allowedPurchases, sub.methods) }
}

/** `subject`: what the span line says allows the least span: "this plan", or for a what-if "this option (<method>)". */
const refusalBody = (cause: Certificate, inputs: PlanInputs, span: SpanRefusal | undefined, variant: CheckVariant, subject: string): string[] => {
  const zone = inputs.settings.timeZone
  const slotMs = gridSlotMs[inputs.settings.grid]
  const lastStart = (to: string) => localTime(new Date(Date.parse(to) - slotMs).toISOString(), zone)
  const title = (key: string) => inputs.jobs.find(job => job.key === key)?.title ?? key
  const job = (key: string) => inputs.jobs.find(entry => entry.key === key)
  const crew = (key: string) => inputs.resources.find(resource => resource.key === key)?.label ?? key
  const ruleWords = (key: string) => inputs.rules.find(entry => entry.key === key)?.words ?? key
  const step = (entry: ChainStepText) => clip(`- ${title(entry.job)}: ${localTime(entry.start, zone)} to ${localTime(entry.finish, zone)}${job(entry.job)?.continuous ? ', unbroken' : ''}`)
  if (cause.kind === 'chain') {
    return [
      clip(`Not possible: ${cause.jobs.length} jobs must run one after another and need ${hoursText(cause.workHours)} of work, but from ${localTime(cause.from, zone)} to ${localTime(cause.by, zone)} their crews and tools are on duty together for only ${hoursText(cause.availableHours)}.`),
      ...cause.jobs.map(key => clip(`- ${title(key)}: ${hoursText(job(key)?.duration.value ?? 0)}`)),
    ].slice(0, 20)
  }
  if (cause.kind === 'energy') {
    const resources = list(cause.resources.map(crew))
    return [
      clip(`Not possible: ${cause.span === undefined ? '' : `${ruleWords(cause.span)} `}In any such span starting between ${localTime(cause.from, zone)} and ${lastStart(cause.to)}, ${hoursText(cause.requiredHours)} of ${resources} work must fall inside it, but ${resources} can give at most ${hoursText(cause.availableHours)} there.`),
      ...(cause.jobs.length === 0 ? [] : [clip(`The work: ${list(cause.jobs.map(title))}.`)]),
    ]
  }
  if (cause.kind === 'availability') {
    // The times first: a long rule is cut, never the hours that make the proof (walk 3, R3-1).
    return [
      clip(`Not possible: ${cause.items.length === 0 ? 'the items of this rule' : list(cause.items)} must be out together between ${localTime(cause.from, zone)} and ${localTime(cause.to, zone)}.`),
      clip(`The rule: ${ruleWords(cause.rule)}`),
    ]
  }
  if (span !== undefined) {
    const lines = [
      clip(`Not possible: ${ruleWords(span.rule)}`),
      clip(`The shortest span ${subject} allows is ${hoursText(span.leastHours)}, against ${hoursText(span.limitHours)}: first tag-out ${localTime(span.firstOut, zone)}, last test passed ${localTime(span.lastBack, zone)}.`),
      'What sets the last test, each job at its earliest:',
      ...span.path.slice(0, 9).map(step),
    ]
    if (span.later !== undefined) {
      const changed = span.later.path.filter(entry => !span.path.some(known => known.job === entry.job && known.start === entry.start))
      lines.push(clip(`A later first tag-out does not help: from ${localTime(span.later.firstOut, zone)} the span is ${hoursText(span.later.hours)}, because:`), ...(changed.length > 0 ? changed : span.later.path).slice(0, 6).map(step))
    }
    if (span.alsoProven?.kind === 'energy') {
      const energy = span.alsoProven
      lines.push(clip(`Also: in any such span starting between ${localTime(energy.from, zone)} and ${lastStart(energy.to)}, ${hoursText(energy.requiredHours)} of ${list(energy.resources.map(crew))} work must fit, and only ${hoursText(energy.availableHours)} exist.`))
    }
    return lines.length <= 19 ? lines : [...lines.slice(0, 18), lines.at(-1)!]
  }
  // A due time no plan meets is said in the preview's words, with the hours and the rule (walk 4, R4-2).
  const due = cause.steps.map(entry => dueTimeWords(inputs, variant, entry.job)).find(words => words !== undefined)
  if (due !== undefined) return [clip(`Not possible: ${due}`)]
  const first = cause.steps.at(0)
  // Each slot is filled or left out: never "after ." (walk 3, R3-1); no solver words such as "release".
  const before = cause.steps.slice(1).map(entry => title(entry.job))
  const notBefore = first === undefined ? undefined : job(first.job)?.notBefore?.words
  const where = first?.via === 'due' ? 'before its due time' : first?.via === 'release' ? `after its earliest start${notBefore === undefined ? '' : ` ('${notBefore}')`}` : first?.via === 'lock' ? 'at its fixed start' : 'inside the plan window'
  return [clip(`Not possible: ${first === undefined ? 'the plan' : title(first.job)} cannot fit ${where}${before.length === 0 ? '' : `, after ${list(before)}`}.`)]
}

type ChainStepText = { readonly job: string; readonly start: string; readonly finish: string }

/**
 * The most limiting resources along a finish chain: those named in the most crew, tool or shift causes
 * (ties kept, for the caller to break by what one more unit would gain).
 */
export const mostLimiting = (items: readonly ExplainItem[]): string[] => {
  const counts = new Map<string, number>()
  for (const item of items) {
    const named = new Set(item.because.filter(cause => cause.kind === 'crew' || cause.kind === 'tool' || cause.kind === 'shift')
      .flatMap(cause => cause.about.filter(name => name.kind === 'resource').map(name => name.key)))
    for (const key of named) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const most = Math.max(0, ...counts.values())
  return most === 0 ? [] : [...counts].filter(([, count]) => count === most).map(([key]) => key)
}
