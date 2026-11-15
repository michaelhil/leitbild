// Plan inputs + one sub-solve (every method chosen, a purchase permission) -> NormalizedProblem.
// Pure and deterministic. Off-grid durations and lags are rounded up and listed; off-grid calendar
// boundaries are refused (time/calendar.ts). No domain word appears here: every rule is generic.
import { combineWorldFacts, type PlanInputs } from '../plan/schema.ts'
import { CHECKER_VERSION } from '../check/check.ts'
import { expandCalendar, isOnGrid } from '../time/calendar.ts'
import { convertUnit, gridSlotMs, isTimeUnit, timeUnitMs, type TimeUnit } from '../time/units.ts'
import { zoneDataFingerprint, zoneOffGridOffset } from '../time/zone.ts'
import type { NormalizedProblem } from './problem.ts'
import { SOLVER_VERSIONS } from './search.ts'


/** At most this many modes per job (schema hard cap). */
export const MAX_MODES = 16

/**
 * Purchases a sub-solve may use. 'no-extra-crew-hours' is "days only": no purchase that adds working
 * time to a crew without replacing booked time; tool days and rebookings stay allowed (A5). It
 * overrides the planner's `allowed` flags, as every variant `buy` does.
 */
export type Buy = 'allowed' | 'none' | 'no-extra-crew-hours' | readonly string[]
export interface MethodPick { readonly choice: string; readonly option: string }
export interface SubSolve { readonly methods: readonly MethodPick[]; readonly buy: Buy }

export interface Problem { readonly about: readonly string[]; readonly code: string }
export type CompileFailure = { readonly ok: false; readonly word: 'invalid input' | 'unsupported feature'; readonly problems: readonly Problem[] }

export interface ModeInfo {
  /** Per need, in order: the resources that may serve it in this mode, and whether added time is allowed. */
  readonly needs: ReadonlyArray<{ readonly resources: readonly string[]; readonly pooled: boolean; readonly purchased: boolean }>
}
export interface GoalInfo {
  readonly metric: PlanInputs['goals'][number]['metric']
  /** The goal's unit (its tolerance unit): 'h', 'min', 's' or the currency. */
  readonly unit: string
}
export interface CompileIndex {
  readonly zone: string | null
  readonly grid: PlanInputs['settings']['grid']
  readonly origin: number
  readonly slotMs: number
  /** The window is slots [0, windowSlots); the horizon runs on so a late plan is graded, not lost. */
  readonly windowSlots: number
  /** Activity -> job key; null for a method's cost carrier. */
  readonly jobs: ReadonlyArray<string | null>
  /** Activity -> the due rule that sets its deadline before the window end, if any. */
  readonly dueRules: ReadonlyArray<string | undefined>
  readonly modes: ReadonlyArray<ReadonlyArray<ModeInfo>>
  /** Activity -> its needs, each the resource indexes that may serve it (anyOf), with or without hours here. */
  readonly needs: ReadonlyArray<ReadonlyArray<readonly number[]>>
  readonly resources: readonly string[]
  readonly resourceKinds: ReadonlyArray<'crew' | 'tool'>
  /** Plan calendar keys behind each resource's time, base first, then allowed purchases'. */
  readonly resourceCalendars: ReadonlyArray<readonly string[]>
  /** Allowed purchases; `slotPurchase[r][t]` names the one that added slot t of resource r (or -1). */
  readonly purchases: ReadonlyArray<{ readonly key: string; readonly resource: number; readonly committed: boolean }>
  readonly slotPurchase: readonly Int16Array[]
  readonly items: readonly string[]
  readonly spans: ReadonlyArray<{ readonly id: string; readonly group: string; readonly rule?: string }>
  readonly coverage: readonly string[]
  readonly goals: readonly GoalInfo[]
  readonly rounded: ReadonlyArray<{ readonly about: string; readonly code: 'duration_rounded_up' | 'lag_rounded_up' | 'limit_rounded_down'; readonly fromMs: number; readonly toMs: number }>
  readonly dropped: ReadonlyArray<{ readonly purchase: string; readonly code: 'order_deadline_passed' | 'not_in_variant' | 'adds_crew_hours' }>
  /** Every allowed purchase key (stored as the option's variant purchases). */
  readonly allowedPurchases: readonly string[]
}
export type Compiled = { readonly ok: true; readonly problem: NormalizedProblem; readonly index: CompileIndex } | CompileFailure

/**
 * What a stored status was made and checked under: the solver's versions, the grid, the zone data, and lane
 * K's rules (CHECKER_VERSION). With no re-check on read, a stored option stands only while all of these are
 * unchanged; a change to any makes it out of date by formulation.
 */
export const formulationOf = (grid: PlanInputs['settings']['grid']): string =>
  `planning solver: compile ${SOLVER_VERSIONS.compile}, bounds ${SOLVER_VERSIONS.bounds}, engine ${SOLVER_VERSIONS.engine}; ${CHECKER_VERSION}; grid ${grid}; ${zoneDataFingerprint()}`

/** Every combination of method options, each a full pick list; `fixed` narrows the choices. */
export const methodCombinations = (inputs: PlanInputs, fixed: readonly MethodPick[] = []): MethodPick[][] =>
  inputs.methods.reduce<MethodPick[][]>((combos, choice) => {
    const pinned = fixed.find(pick => pick.choice === choice.key)
    const options = pinned === undefined ? choice.options.map(option => option.key) : [pinned.option]
    return combos.flatMap(combo => options.map(option => [...combo, { choice: choice.key, option }]))
  }, [[]])

/**
 * Whether a sub-solve may use a purchase: unordered past its order deadline at the data date, never; under
 * "days only", never one that adds crew time without replacing booked time (even when ordered); an ordered one
 * always otherwise; else as `buy` says. The one rule, for compile and for an option's key.
 */
export const purchaseStanding = (purchase: PlanInputs['purchases'][number], resource: PlanInputs['resources'][number], buy: Buy, dataDate: number | undefined):
  { readonly ok: true } | { readonly ok: false; readonly code: CompileIndex['dropped'][number]['code'] } => {
  if (purchase.ordered === undefined && purchase.orderBy !== undefined && dataDate !== undefined && dataDate > Date.parse(purchase.orderBy)) return { ok: false, code: 'order_deadline_passed' }
  const addsCrewHours = resource.kind === 'crew' && purchase.replaces.length === 0
  if (buy === 'no-extra-crew-hours' && addsCrewHours) return { ok: false, code: 'adds_crew_hours' }
  if (purchase.ordered !== undefined) return { ok: true }
  const permitted = buy === 'allowed' ? purchase.allowed : buy === 'none' ? false : buy === 'no-extra-crew-hours' ? true : buy.includes(purchase.key)
  return permitted ? { ok: true } : { ok: false, code: 'not_in_variant' }
}

/**
 * The inputs a what-if is compiled on: the plan's rules with its extra rules (option.variant.also) after
 * them, never replacing one. Compile reads only these inputs; lane K reads `variant.also` itself.
 */
export const withExtraRules = (inputs: PlanInputs, also: ReadonlyArray<PlanInputs['rules'][number]> | undefined): PlanInputs =>
  also === undefined || also.length === 0 ? inputs : { ...inputs, rules: [...inputs.rules, ...also] }

/** The purchase keys a sub-solve under `buy` may use (purchaseStanding), in plan order. */
export const permittedPurchases = (inputs: PlanInputs, buy: Buy): string[] => {
  const dataDate = inputs.settings.dataDate === null ? undefined : Date.parse(inputs.settings.dataDate)
  return inputs.purchases.flatMap(purchase => {
    const resource = inputs.resources.find(candidate => candidate.key === purchase.resource)
    return resource !== undefined && purchaseStanding(purchase, resource, buy, dataDate).ok ? [purchase.key] : []
  })
}

const fail = (word: CompileFailure['word'], problems: Problem[]): CompileFailure => ({ ok: false, word, problems: problems.slice(0, 16) })
const runKey = (mask: Uint8Array): string => {
  const parts: number[] = []
  for (let t = 0; t < mask.length; t++) if (mask[t] !== (t === 0 ? 0 : mask[t - 1])) parts.push(t)
  return parts.join(',')
}
const union = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((x, t) => x | b[t]!)
const intersect = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((x, t) => x & b[t]!)
const minus = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((x, t) => x & (b[t]! ^ 1))
const empty = (mask: Uint8Array, until: number): boolean => { for (let t = 0; t < until; t++) if (mask[t]) return false; return true }

export const compile = (inputs: PlanInputs, sub: SubSolve): Compiled => {
  const { settings } = inputs
  const invalid: Problem[] = []
  const unsupported: Problem[] = []
  if (settings.window === null) return fail('invalid input', [{ about: [], code: 'window_missing' }])
  const slotMs = gridSlotMs[settings.grid]
  const origin = Date.parse(settings.window.start)
  const windowEnd = Date.parse(settings.window.end)
  if (!isOnGrid(origin, slotMs) || !isOnGrid(windowEnd, slotMs)) return fail('invalid input', [{ about: [], code: 'window_off_grid' }])
  const windowSlots = (windowEnd - origin) / slotMs
  // Search runs on a horizon twice the window (at most a week longer) so a late plan is graded.
  const horizon = windowSlots + Math.min(windowSlots, Math.round(7 * 86_400_000 / slotMs))
  const horizonEnd = origin + horizon * slotMs
  const zone = settings.timeZone
  if (zone !== null) {
    const offset = zoneOffGridOffset(zone, slotMs, origin, horizonEnd)
    if (offset !== undefined) return fail('invalid input', [{ about: [], code: 'zone_off_grid' }])
  }
  const toSlotUp = (ms: number): number => Math.ceil((ms - origin) / slotMs - 1e-9)
  const toSlotDown = (ms: number): number => Math.floor((ms - origin) / slotMs + 1e-9)
  const rounded: Array<CompileIndex['rounded'][number]> = []
  const slotsUp = (ms: number, about: string, code: 'duration_rounded_up' | 'lag_rounded_up'): number => {
    const slots = Math.ceil(ms / slotMs - 1e-9)
    if (Math.abs(slots * slotMs - ms) > 1e-6) rounded.push({ about, code, fromMs: ms, toMs: slots * slotMs })
    return slots
  }

  // ── calendars ──
  const always = new Uint8Array(horizon).fill(1)
  const planCalendar = new Map<string, Uint8Array>()
  for (const calendar of inputs.calendars) {
    const expanded = expandCalendar(calendar, { zone, slotMs, origin, slots: horizon })
    if (!expanded.ok) { invalid.push({ about: [calendar.key], code: expanded.problem.code }); continue }
    planCalendar.set(calendar.key, expanded.work)
  }
  const problemCalendars: Array<{ id: string; work: Uint8Array }> = []
  const calendarIds = new Map<string, number>()
  const calendarIndex = (mask: Uint8Array, id: string): number => {
    const key = runKey(mask)
    const known = calendarIds.get(key)
    if (known !== undefined) return known
    problemCalendars.push({ id, work: mask })
    calendarIds.set(key, problemCalendars.length - 1)
    return problemCalendars.length - 1
  }
  calendarIndex(always, 'always')

  // ── purchases allowed in this sub-solve ──
  const dataDate = settings.dataDate === null ? undefined : Date.parse(settings.dataDate)
  const resourceByKey = new Map(inputs.resources.map((resource, index) => [resource.key, index]))
  const dropped: Array<CompileIndex['dropped'][number]> = []
  const allowedPurchases = inputs.purchases.filter(purchase => {
    const resource = inputs.resources[resourceByKey.get(purchase.resource) ?? -1]
    if (resource === undefined) { invalid.push({ about: [purchase.key, purchase.resource], code: 'unknown_key' }); return false }
    const standing = purchaseStanding(purchase, resource, sub.buy, dataDate)
    if (!standing.ok) dropped.push({ purchase: purchase.key, code: standing.code })
    return standing.ok
  })
  if (Array.isArray(sub.buy)) for (const key of sub.buy) if (!inputs.purchases.some(purchase => purchase.key === key)) invalid.push({ about: [key], code: 'unknown_key' })

  // ── resources ──
  const slotHours = slotMs / timeUnitMs.h
  const purchaseList: Array<CompileIndex['purchases'][number]> = []
  const baseMask: Uint8Array[] = []
  const fullMask: Uint8Array[] = []
  const slotPurchase: Int16Array[] = []
  const resourceCalendars: string[][] = []
  const problemResources: Array<NormalizedProblem['resources'][number]> = inputs.resources.map((resource, r) => {
    const base = planCalendar.get(resource.calendar)
    if (base === undefined && !inputs.calendars.some(calendar => calendar.key === resource.calendar)) invalid.push({ about: [resource.key, resource.calendar], code: 'unknown_key' })
    const baseWork = base ?? new Uint8Array(horizon)
    const capacity = new Int16Array(horizon)
    const price = new Float64Array(horizon)
    const owner = new Int16Array(horizon).fill(-1)
    let full = baseWork
    for (let t = 0; t < horizon; t++) capacity[t] = baseWork[t]! * resource.count
    const periods: Array<NormalizedProblem['resources'][number]['periods'][number]> = []
    const once: Array<NormalizedProblem['resources'][number]['once'][number]> = []
    const forbidden: Array<NormalizedProblem['resources'][number]['forbiddenWhenUsed'][number]> = []
    const calendars = [resource.calendar]
    for (const purchase of allowedPurchases.filter(candidate => candidate.resource === resource.key)) {
      const index = purchaseList.length
      const committed = purchase.ordered !== undefined
      purchaseList.push({ key: purchase.key, resource: r, committed })
      let added: Uint8Array
      if ('calendar' in purchase.adds) {
        const mask = planCalendar.get(purchase.adds.calendar)
        if (mask === undefined) { invalid.push({ about: [purchase.key, purchase.adds.calendar], code: 'unknown_key' }); continue }
        added = mask
        calendars.push(purchase.adds.calendar)
      } else {
        added = new Uint8Array(horizon)
        for (const period of purchase.adds.periods) {
          const from = Date.parse(period.start), to = Date.parse(period.end)
          if (!isOnGrid(from, slotMs) || !isOnGrid(to, slotMs)) { invalid.push({ about: [purchase.key], code: 'purchase_off_grid' }); continue }
          added.fill(1, Math.max(0, toSlotDown(from)), Math.max(0, Math.min(horizon, toSlotDown(to))))
        }
      }
      if (!empty(intersect(added, full), horizon)) { unsupported.push({ about: [purchase.key, resource.key], code: 'purchase_overlaps_booked_time' }); continue }
      full = union(full, added)
      const perUnitSlot = (purchase.price.perPersonHour ?? 0) * (resource.crewSize ?? 1) * slotHours
      let addedHours = 0
      for (let t = 0; t < horizon; t++) {
        if (!added[t]) continue
        capacity[t] = capacity[t]! + resource.count
        owner[t] = index
        if (t < windowSlots) addedHours += slotHours * resource.count
        if (!committed) price[t] = perUnitSlot
      }
      // Each contiguous run of added time is one period; a run's price applies when any of it is used.
      for (let t = 0; t < horizon;) {
        if (!added[t]) { t++; continue }
        let end = t
        while (end < horizon && added[end]) end++
        periods.push({ purchase: purchase.key, from: t, to: end, price: purchase.price.perPeriodUsed ?? 0, committed })
        t = end
      }
      if ((purchase.price.once ?? 0) > 0) once.push({ purchase: purchase.key, price: purchase.price.once ?? 0, committed })
      // An ordered purchase is charged whether used or not, including its person-hours.
      if (committed && perUnitSlot > 0) once.push({ purchase: purchase.key, price: perUnitSlot / slotHours * addedHours, committed: true })
      for (const period of purchase.replaces) {
        const from = Math.max(0, toSlotDown(Date.parse(period.start))), to = Math.min(horizon, toSlotUp(Date.parse(period.end)))
        if (to > from) forbidden.push({ purchase: purchase.key, from, to })
      }
    }
    baseMask.push(baseWork)
    fullMask.push(full)
    slotPurchase.push(owner)
    resourceCalendars.push(calendars)
    return {
      id: resource.key, capacity, pricePerUnitSlot: price, periods, once,
      forbiddenWhenUsed: forbidden, ...(resource.maxJobs === undefined ? {} : { maxJobs: resource.maxJobs }),
    }
  })
  // Ordered purchases dropped by "days only" are still charged.
  for (const purchase of inputs.purchases) {
    if (purchase.ordered === undefined || allowedPurchases.includes(purchase)) continue
    const resource = inputs.resources[resourceByKey.get(purchase.resource) ?? -1]
    const target = problemResources[resourceByKey.get(purchase.resource) ?? -1]
    if (resource === undefined || target === undefined) continue
    const periodCount = 'periods' in purchase.adds ? purchase.adds.periods.length : 1
    const total = (purchase.price.once ?? 0) + (purchase.price.perPeriodUsed ?? 0) * periodCount
    ;(target.once as Array<{ purchase: string; price: number; committed: boolean }>).push({ purchase: purchase.key, price: total, committed: true })
  }
  for (let r = 0; r < problemResources.length; r++) {
    const forbidden = problemResources[r]!.forbiddenWhenUsed
    for (let i = 0; i < forbidden.length; i++) for (let j = i + 1; j < forbidden.length; j++) {
      if (forbidden[i]!.purchase !== forbidden[j]!.purchase && forbidden[i]!.from < forbidden[j]!.to && forbidden[j]!.from < forbidden[i]!.to) unsupported.push({ about: [forbidden[i]!.purchase, forbidden[j]!.purchase], code: 'replaced_time_overlaps' })
    }
  }

  // ── jobs in this sub-solve ──
  const picked = new Map(sub.methods.map(pick => [pick.choice, pick.option]))
  for (const choice of inputs.methods) if (!picked.has(choice.key)) return fail('invalid input', [{ about: [choice.key], code: 'method_not_chosen' }])
  const inMethod = (method: { choice: string; option: string } | undefined): boolean => method === undefined || picked.get(method.choice) === method.option
  const jobs = inputs.jobs.filter(job => inMethod(job.method))
  const jobIndex = new Map(jobs.map((job, index) => [job.key, index]))
  const equipmentIndex = new Map(inputs.equipment.map((item, index) => [item.key, index]))
  const protectedItems = new Set(inputs.rules.flatMap(rule => (rule.kind === 'protected' ? rule.equipment : [])))
  // Every job starts at or after the data date (controls review: no forecast in the past).
  const releaseFloor = dataDate !== undefined && dataDate > origin ? toSlotUp(dataDate) : 0

  const attributeRelease = (resourceKey: string, where: NonNullable<PlanInputs['jobs'][number]['needs'][number]['where']>, about: string): number | 'never' | 'unsupported' | 'invalid' => {
    const resource = inputs.resources[resourceByKey.get(resourceKey) ?? -1]
    const attribute = resource?.attributes.find(candidate => candidate.key === where.attribute)
    if (attribute === undefined) { invalid.push({ about: [about, resourceKey, where.attribute], code: 'attribute_missing' }); return 'invalid' }
    const convert = (value: number): number | undefined => { const converted = convertUnit(value, attribute.unit, where.unit); return converted.ok ? converted.value : undefined }
    let initial = attribute.value
    if (attribute.origin.by === 'world') {
      const combined = combineWorldFacts(attribute.origin.refs, inputs.world.facts, attribute.unit)
      if (!combined.ok) { invalid.push({ about: [about, resourceKey, where.attribute], code: combined.code }); return 'invalid' }
      initial = combined.value
    }
    if (initial === null) { invalid.push({ about: [about, resourceKey, where.attribute], code: 'world_value_unread' }); return 'invalid' }
    const timeline = [{ at: origin, value: initial }, ...[...attribute.changes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(change => ({ at: Date.parse(change.at), value: change.value }))]
    const holds = timeline.map(point => { const value = convert(point.value); return value === undefined ? undefined : value >= where.atLeast })
    if (holds.some(value => value === undefined)) { invalid.push({ about: [about, resourceKey, where.attribute], code: 'unit_mismatch' }); return 'invalid' }
    const firstHold = holds.findIndex(value => value === true)
    if (firstHold < 0) return 'never'
    if (holds.slice(firstHold).some(value => value === false)) { unsupported.push({ about: [about, resourceKey], code: 'eligibility_ends' }); return 'unsupported' }
    return firstHold === 0 ? 0 : Math.max(0, toSlotUp(timeline[firstHold]!.at))
  }

  interface NeedOption { mask: Uint8Array; demands: Array<{ resource: number; amount: number; whenMask: Uint8Array | null }>; release: number; resources: string[]; pooled: boolean; purchased: boolean }
  const activities: Array<NormalizedProblem['activities'][number]> = []
  const activityJobs: Array<string | null> = []
  const activityDue: Array<string | undefined> = []
  const activityNeeds: number[][][] = []
  const modeInfos: ModeInfo[][] = []
  for (const job of jobs) {
    for (const key of job.equipment) {
      if (!equipmentIndex.has(key)) invalid.push({ about: [job.key, key], code: 'unknown_key' })
      if (protectedItems.has(key)) invalid.push({ about: [job.key, key], code: 'protected_equipment' })
    }
    // A World value is never stored: it is computed from the read facts, and compile refuses without it.
    let baseValue = job.duration.value
    if (job.duration.origin.by === 'world') {
      const combined = combineWorldFacts(job.duration.origin.refs, inputs.world.facts, job.duration.unit)
      if (!combined.ok) { invalid.push({ about: [job.key], code: combined.code }); continue }
      baseValue = combined.value
    }
    if (baseValue === null) { invalid.push({ about: [job.key], code: 'world_value_unread' }); continue }
    const jobValue = baseValue
    if (job.kind === 'work' && job.isolation === 'inside' && job.equipment.length !== 1) { invalid.push({ about: [job.key], code: 'inside_work_needs_one_item' }); continue }
    const unitMs = timeUnitMs[job.duration.unit]
    const durationFor = (resourceKey: string | undefined): number | undefined => {
      const entry = resourceKey === undefined ? undefined : job.durationWith.find(candidate => candidate.resource === resourceKey)
      if (entry === undefined) return jobValue
      if ('value' in entry) return entry.value
      const combined = combineWorldFacts(entry.refs, inputs.world.facts, job.duration.unit)
      if (!combined.ok) { invalid.push({ about: [job.key, resourceKey ?? ''], code: combined.code }); return undefined }
      return combined.value
    }
    const needOptions: NeedOption[][] = []
    let usable = true
    for (const need of job.needs) {
      const options: NeedOption[] = []
      const eligible: Array<{ key: string; r: number; release: number }> = []
      for (const key of need.anyOf) {
        const r = resourceByKey.get(key)
        if (r === undefined) { invalid.push({ about: [job.key, key], code: 'unknown_key' }); usable = false; continue }
        const release = need.where === undefined ? 0 : attributeRelease(key, need.where, job.key)
        if (release === 'invalid' || release === 'unsupported') { usable = false; continue }
        if (release === 'never') continue
        eligible.push({ key, r, release })
      }
      for (const member of eligible) {
        const levels = fullMask[member.r] === baseMask[member.r] ? [false] : [false, true]
        for (const purchased of levels) {
          const mask = purchased ? fullMask[member.r]! : baseMask[member.r]!
          if (empty(mask, horizon)) continue
          options.push({ mask, demands: [{ resource: member.r, amount: need.amount, whenMask: null }], release: member.release, resources: [member.key], pooled: false, purchased })
        }
      }
      if (need.handover && eligible.length >= 2) {
        for (const purchased of [false, true]) {
          const masks = eligible.map(member => (purchased ? fullMask[member.r]! : baseMask[member.r]!))
          let covered: Uint8Array = new Uint8Array(horizon)
          const demands: NeedOption['demands'] = []
          eligible.forEach((member, k) => {
            const own = minus(masks[k]!, covered)
            covered = union(covered, masks[k]!)
            if (!empty(own, horizon)) demands.push({ resource: member.r, amount: need.amount, whenMask: own })
          })
          if (demands.length < 2) continue
          options.push({ mask: covered, demands, release: Math.max(...eligible.map(member => member.release)), resources: eligible.map(member => member.key), pooled: true, purchased })
        }
      }
      needOptions.push(options)
    }
    if (!usable) continue
    if (job.needs.length === 0 && job.duration.calendar === 'working') { invalid.push({ about: [job.key], code: 'working_time_without_resource' }); continue }
    let combos: NeedOption[][] = [[]]
    for (const options of needOptions) combos = combos.flatMap(combo => options.map(option => [...combo, option]))
    const notBefore = job.notBefore === undefined ? 0 : Math.max(0, toSlotUp(Date.parse(job.notBefore.at)))
    const release = Math.max(releaseFloor, notBefore)
    const modes: Array<NormalizedProblem['activities'][number]['modes'][number]> = []
    const infos: ModeInfo[] = []
    const seen = new Set<string>()
    for (const combo of combos) {
      const single = combo.find(option => !option.pooled && job.durationWith.some(entry => entry.resource === option.resources[0]))
      if (combo.some(option => option.pooled && option.resources.some(key => job.durationWith.some(entry => entry.resource === key)))) {
        unsupported.push({ about: [job.key], code: 'handover_with_resource_duration' }); usable = false; break
      }
      const value = durationFor(single?.resources[0])
      if (value === undefined) { usable = false; break }
      const work = slotsUp(value * unitMs, job.key, 'duration_rounded_up')
      const mask = combo.reduce<Uint8Array>((acc, option) => intersect(acc, option.mask), always)
      if (combo.length > 0 && empty(mask, horizon)) continue
      const calendar = calendarIndex(mask, `${job.key}#${modes.length}`)
      const demands = combo.flatMap(option => option.demands.map(demand => ({
        resource: demand.resource, amount: demand.amount, when: demand.whenMask === null ? -1 : calendarIndex(demand.whenMask, `${problemResources[demand.resource]!.id}#when`),
      })))
      const continuous = job.continuous || job.duration.calendar === 'elapsed'
      const modeRelease = Math.max(release, ...combo.map(option => option.release))
      const signature = JSON.stringify([work, calendar, continuous, demands, modeRelease])
      if (seen.has(signature)) continue
      seen.add(signature)
      modes.push({ work, calendar, continuous, demands, fixedCost: 0, release: modeRelease })
      infos.push({ needs: combo.map(option => ({ resources: option.resources, pooled: option.pooled, purchased: option.purchased })) })
    }
    if (!usable) continue
    if (modes.length > MAX_MODES) { unsupported.push({ about: [job.key], code: 'too_many_modes' }); continue }
    if (modes.length === 0) {
      // No resource can ever serve it: an empty mode keeps the job so bounds can name the cause.
      modes.push({ work: slotsUp(jobValue * unitMs, job.key, 'duration_rounded_up'), calendar: calendarIndex(new Uint8Array(horizon), 'never'), continuous: true, demands: [], fixedCost: 0, release })
      infos.push({ needs: job.needs.map(need => ({ resources: [...need.anyOf], pooled: false, purchased: false })) })
    }
    const target = job.target === undefined ? undefined : toSlotDown(Date.parse(job.target.finishBy))
    // A hard due rule ends the job's window early; the earliest one binds.
    const dues = inputs.rules.flatMap(rule => (rule.kind === 'due' && rule.job === job.key ? [{ key: rule.key, slot: toSlotDown(Date.parse(rule.finishBy)) }] : []))
    const due = dues.reduce<{ key: string; slot: number } | undefined>((earliest, entry) => (entry.slot < (earliest?.slot ?? windowSlots + 1) ? entry : earliest), undefined)
    const deadline = due !== undefined && due.slot < windowSlots ? due.slot : windowSlots
    let fixed: NormalizedProblem['activities'][number]['fixed']
    if (job.lock !== undefined) {
      const at = Date.parse(job.lock.start)
      if (!isOnGrid(at, slotMs) || at < origin || at >= windowEnd) { invalid.push({ about: [job.key], code: 'lock_off_grid' }); continue }
      if (dataDate !== undefined && at < dataDate) { invalid.push({ about: [job.key], code: 'lock_before_data_date' }); continue }
      const start = toSlotDown(at)
      const mode = Math.max(0, modes.findIndex(mode => problemCalendars[mode.calendar]!.work[start] === 1))
      fixed = { mode, start, history: false }
    }
    activities.push({ id: job.key, modes, release, deadline, ...(target === undefined ? {} : { target }), ...(fixed === undefined ? {} : { fixed }) })
    activityJobs.push(job.key)
    activityNeeds.push(job.needs.map(need => need.anyOf.flatMap(key => { const r = resourceByKey.get(key); return r === undefined ? [] : [r] })))
    activityDue.push(deadline < windowSlots ? due!.key : undefined)
    modeInfos.push(infos)
  }
  // A method's own cost is carried by a zero-work activity that exists only in sub-solves choosing it.
  for (const choice of inputs.methods) {
    const option = choice.options.find(candidate => candidate.key === picked.get(choice.key))
    if (option === undefined) { invalid.push({ about: [choice.key], code: 'unknown_key' }); continue }
    if (option.fixedCost <= 0) continue
    activities.push({ id: `method:${choice.key}`, modes: [{ work: 0, calendar: 0, continuous: true, demands: [], fixedCost: option.fixedCost, release: 0 }], release: 0, deadline: windowSlots })
    activityJobs.push(null)
    activityNeeds.push([])
    activityDue.push(undefined)
    modeInfos.push([{ needs: [] }])
  }
  if (invalid.length > 0) return fail('invalid input', invalid)
  if (unsupported.length > 0) return fail('unsupported feature', unsupported)
  const activityOf = new Map(activityJobs.flatMap((key, a) => (key === null ? [] : [[key, a] as const])))

  // ── links: planner links, bracketing, tag-before-test, support order ──
  const linkMap = new Map<string, NormalizedProblem['links'][number]>()
  const addLink = (from: number, to: number, type: 'FS' | 'SS' | 'FF', min: number, origin: NormalizedProblem['links'][number]['origin']): void => {
    if (from === to) return
    const key = `${from}>${to}>${type}`
    const known = linkMap.get(key)
    if (known === undefined || known.min < min) linkMap.set(key, { from, to, type, min, origin: known?.origin === 'link' ? 'link' : origin })
  }
  for (const link of inputs.links) {
    if (!inMethod(link.method)) continue
    const from = activityOf.get(link.from), to = activityOf.get(link.to)
    if (from === undefined || to === undefined) {
      const known = (key: string) => inputs.jobs.some(job => job.key === key)
      if (!known(link.from) || !known(link.to)) invalid.push({ about: [link.from, link.to], code: 'unknown_key' })
      continue   // an end belongs to a method option not chosen here
    }
    addLink(from, to, link.type, slotsUp(link.lag.value * timeUnitMs[link.lag.unit], `${link.from}>${link.to}`, 'lag_rounded_up'), 'link')
  }
  const coveringOf = (kind: 'tag-out' | 'test', item: string): number[] =>
    jobs.flatMap(job => (job.kind === kind && job.equipment.includes(item) ? [activityOf.get(job.key)!] : []))
  for (const job of jobs) {
    if (job.kind !== 'work' || job.isolation !== 'inside') continue
    const item = job.equipment[0]!
    const tags = coveringOf('tag-out', item), tests = coveringOf('test', item)
    if (tags.length === 0 || tests.length === 0) { invalid.push({ about: [job.key, item], code: 'inside_work_without_bracket' }); continue }
    const a = activityOf.get(job.key)!
    for (const tag of tags) addLink(tag, a, 'FS', 0, 'bracket')
    for (const test of tests) addLink(a, test, 'FS', 0, 'bracket')
  }
  for (const item of inputs.equipment) for (const tag of coveringOf('tag-out', item.key)) for (const test of coveringOf('test', item.key)) addLink(tag, test, 'FS', 0, 'tag-before-test')
  // Support cycles are refused; every supporter's tests, direct or through another supporter, precede the
  // supported item's tests (the order the checker reads, so lifting one link never hides another).
  const supportersOf = (key: string, path: readonly string[] = []): string[] => {
    if (path.includes(key)) { invalid.push({ about: [...path.slice(-3), key], code: 'support_cycle' }); return [] }
    const item = inputs.equipment[equipmentIndex.get(key) ?? -1]
    return (item?.supportedBy ?? []).flatMap(supporter => [supporter, ...supportersOf(supporter, [...path, key])])
  }
  for (const item of inputs.equipment) {
    for (const supporter of item.supportedBy) if (!equipmentIndex.has(supporter)) invalid.push({ about: [item.key, supporter], code: 'unknown_key' })
    for (const supporter of new Set(supportersOf(item.key))) for (const before of coveringOf('test', supporter)) for (const after of coveringOf('test', item.key)) addLink(before, after, 'FS', 0, 'support-order')
  }
  if (invalid.length > 0) return fail('invalid input', invalid)
  const links = [...linkMap.values()]
  // Positive cycles cannot be scheduled; any cycle over these lags is refused with its members.
  const indegree = activities.map(() => 0)
  const successors = activities.map((): number[] => [])
  for (const link of links) { indegree[link.to]!++; successors[link.from]!.push(link.to) }
  const queue = indegree.flatMap((degree, a) => (degree === 0 ? [a] : []))
  let ordered = 0
  while (queue.length > 0) { const a = queue.pop()!; ordered++; for (const next of successors[a]!) if (--indegree[next]! === 0) queue.push(next) }
  if (ordered < activities.length) return fail('invalid input', [{ about: activities.flatMap((activity, a) => (indegree[a]! > 0 ? [activity.id] : [])).slice(0, 4), code: 'link_cycle' }])

  // ── items, spans, coverage ──
  const items = inputs.equipment.map(item => ({
    id: item.key,
    openers: coveringOf('tag-out', item.key),
    closers: coveringOf('test', item.key),
    supportedBy: item.supportedBy.map(key => equipmentIndex.get(key)!),
  }))
  const spans: Array<NormalizedProblem['spans'][number]> = []
  const spanInfo: Array<CompileIndex['spans'][number]> = []
  const groupItems = (group: string): number[] => inputs.equipment.flatMap((item, index) => (item.group === group ? [index] : []))
  for (const rule of inputs.rules) {
    if (rule.kind !== 'span-limit') continue
    if (!inputs.groups.some(group => group.key === rule.group)) { invalid.push({ about: [rule.key, rule.group], code: 'unknown_key' }); continue }
    if (!rule.singleEntry) { unsupported.push({ about: [rule.key], code: 'span_limit_reentry' }); continue }
    const limitMs = rule.limit.value * timeUnitMs[rule.limit.unit]
    const limit = Math.floor(limitMs / slotMs + 1e-9)
    if (Math.abs(limit * slotMs - limitMs) > 1e-6) rounded.push({ about: rule.key, code: 'limit_rounded_down', fromMs: limitMs, toMs: limit * slotMs })
    spans.push({ id: rule.key, items: groupItems(rule.group), limit, singleEntry: true })
    spanInfo.push({ id: rule.key, group: rule.group, rule: rule.key })
  }
  const spanForGroup = (group: string): number => {
    const known = spanInfo.findIndex(span => span.group === group)
    if (known >= 0) return known
    if (!inputs.groups.some(candidate => candidate.key === group)) { invalid.push({ about: [group], code: 'unknown_key' }); return -1 }
    spans.push({ id: `group:${group}`, items: groupItems(group), singleEntry: true })
    spanInfo.push({ id: `group:${group}`, group })
    return spans.length - 1
  }
  for (const rule of inputs.rules) if (rule.kind === 'due' && !inputs.jobs.some(job => job.key === rule.job)) invalid.push({ about: [rule.key, rule.job], code: 'unknown_key' })
  const coverage: Array<NormalizedProblem['coverage'][number]> = []
  for (const rule of inputs.rules) {
    if (rule.kind !== 'keep-in-service') continue
    const equipment = rule.members.flatMap(member => ('equipment' in member ? [member.equipment] : []))
    const resources = rule.members.flatMap(member => ('resource' in member ? [member.resource] : []))
    if (equipment.length > 0 && resources.length > 0) { unsupported.push({ about: [rule.key], code: 'keep_in_service_mixed_members' }); continue }
    for (const key of equipment) if (!equipmentIndex.has(key)) invalid.push({ about: [rule.key, key], code: 'unknown_key' })
    for (const key of resources) if (!resourceByKey.has(key)) invalid.push({ about: [rule.key, key], code: 'unknown_key' })
    const from = rule.during === undefined ? 0 : Math.max(0, toSlotDown(Date.parse(rule.during.start)))
    const to = rule.during === undefined ? windowSlots : Math.min(horizon, toSlotUp(Date.parse(rule.during.end)))
    coverage.push({ id: rule.key, items: equipment.map(key => equipmentIndex.get(key)!), resources: resources.map(key => resourceByKey.get(key)!), atLeast: rule.atLeast, from, to })
  }

  // ── goals: in the tolerance's unit; metrics are raw, rank.ts alone subtracts the threshold ──
  const goals: Array<NormalizedProblem['goals'][number]> = []
  const goalInfo: GoalInfo[] = []
  for (const goal of inputs.goals) {
    const unit = goal.tolerance.unit
    const money = goal.metric === 'extra-cost'
    if (money ? unit !== settings.currency : !isTimeUnit(unit)) { invalid.push({ about: [goal.metric], code: 'goal_unit' }); continue }
    let threshold = 0
    if (goal.threshold !== undefined) {
      if (money ? goal.threshold.unit !== unit : !isTimeUnit(goal.threshold.unit)) { invalid.push({ about: [goal.metric], code: 'goal_unit' }); continue }
      threshold = money ? goal.threshold.value : goal.threshold.value * timeUnitMs[goal.threshold.unit as TimeUnit] / timeUnitMs[unit as TimeUnit]
    }
    const groups = goal.scope?.groups ?? (goal.metric === 'span-over' ? [...new Set(spanInfo.map(span => span.group))] : undefined)
    const spanIndexes = groups?.map(spanForGroup).filter(index => index >= 0)
    const tagged = goal.scope?.tags === undefined ? undefined
      : activityJobs.flatMap((key, a) => (key !== null && jobs[jobIndex.get(key)!]!.tags.some(tag => goal.scope!.tags!.includes(tag)) ? [a] : []))
    goals.push({ metric: goal.metric, unit, ...(spanIndexes === undefined ? {} : { spans: spanIndexes }), ...(tagged === undefined ? {} : { tagged }), threshold, step: goal.tolerance.value })
    goalInfo.push({ metric: goal.metric, unit })
  }
  if (invalid.length > 0) return fail('invalid input', invalid)
  if (unsupported.length > 0) return fail('unsupported feature', unsupported)

  const problem: NormalizedProblem = {
    slotMs, origin, horizon, formulation: formulationOf(settings.grid), calendars: problemCalendars, resources: problemResources,
    activities, links, items, spans, coverage, goals,
  }
  const index: CompileIndex = {
    zone, grid: settings.grid, origin, slotMs, windowSlots, jobs: activityJobs, dueRules: activityDue, modes: modeInfos, needs: activityNeeds,
    resources: inputs.resources.map(resource => resource.key), resourceKinds: inputs.resources.map(resource => resource.kind),
    resourceCalendars, purchases: purchaseList, slotPurchase, items: inputs.equipment.map(item => item.key),
    spans: spanInfo, coverage: coverage.map(rule => rule.id), goals: goalInfo, rounded, dropped,
    allowedPurchases: allowedPurchases.map(purchase => purchase.key),
  }
  return { ok: true, problem, index }
}
