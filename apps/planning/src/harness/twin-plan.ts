// Test harness, the twin-plan generator: a frozen gate twin (or's bench instance, R/or/gate/runs/twin-v3.json
// 955824a9…, and twin v1, twin-v1-overloaded.json) as plan inputs, so the product engine can be gated on
// it, and any bench solution of it as dated rows, so the product checker can judge or's best-known plans.
// It reads the bench conventions of or's case adapter (helper milestones for spans with several openers or
// closers, per-night contractor resources, a Friday tool day, a rebooking mode with a fixed cost). It makes
// no judgement: what the plan schema cannot say is listed in `notes`.
//
//   bun apps/planning/src/harness/twin-plan.ts <twin.json> [<solution run.json> ...]
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import { checkPlan, type CheckRow, type CheckVariant } from '../check/check.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bench = any

export interface TwinOptions {
  readonly title: string
  /** The instant of slot 0, e.g. Mon 16 Nov 2026 07:00 CET = 2026-11-16T06:00:00Z. */
  readonly origin: string
  readonly zone: string
  readonly currency: string
  /** Every member of each k-of-G group, worked or not (the twin names only the worked ones). */
  readonly groupMembers?: Readonly<Record<string, readonly string[]>>
  /** Persons per crew, for per-person-hour overtime prices. */
  readonly crewSizes?: Readonly<Record<string, number>>
  readonly goals: PlanInputs['goals']
}

export interface TwinPlan {
  readonly inputs: PlanInputs
  readonly variant: CheckVariant
  readonly notes: readonly string[]
  readonly rowsOf: (solution: { readonly mode: readonly number[]; readonly start: readonly number[] }) => CheckRow[]
}

const planner = { by: 'planner' as const }
const runs = (slots: readonly boolean[]): Array<[number, number]> => {
  const found: Array<[number, number]> = []
  slots.forEach((on, index) => { const last = found.at(-1); if (!on) return; if (last !== undefined && last[1] === index) last[1] = index + 1; else found.push([index, index + 1]) })
  return found
}
const sameSlots = (left: readonly boolean[], right: readonly boolean[]): boolean => left.every((value, index) => value === right[index])

export const twinPlan = (bench: Bench, options: TwinOptions): TwinPlan => {
  const notes: string[] = []
  const horizon: number = bench.horizon
  const slotHours: number = bench.slotHours
  const origin = Date.parse(options.origin)
  const at = (slot: number): string => new Date(origin + slot * slotHours * 3_600_000).toISOString().replace('.000Z', 'Z')
  const periods = (slots: readonly boolean[]) => runs(slots).map(([from, to]) => ({ start: at(from), end: at(to) }))
  const calendarsById = new Map<string, boolean[]>(bench.calendars.map((calendar: any) => [calendar.id, calendar.work]))
  const benchResources = new Map<string, any>(bench.resources.map((resource: any) => [resource.id, resource]))

  // ── resources: capacity layers, overtime by rate, tool days and nights bought by period, a rebooking ──
  const calendars: PlanInputs['calendars'][number][] = [{ key: 'none', label: 'Bought time only', weekly: [], periods: [], except: [], source: planner }]
  const resources: PlanInputs['resources'][number][] = []
  const purchases: PlanInputs['purchases'][number][] = []
  /** bench resource -> its product resources, one per capacity layer group, with the slots each base works */
  const layersOf = new Map<string, Array<{ key: string; count: number; base: boolean[]; overtime?: string }>>()
  const rebooked = new Map<string, { purchase: string; adds: boolean[] }>()
  // a rebooking: a mode that costs a fixed sum to move a single-resource job to another calendar
  for (const activity of bench.activities) {
    const paid = activity.modes.find((mode: any) => mode.fixedCost > 0 && mode.demands.length === 1)
    const usual = activity.modes.find((mode: any) => mode.fixedCost === 0 && mode.demands.length === 1 && paid !== undefined && mode.demands[0].resource === paid.demands[0].resource)
    if (paid === undefined || usual === undefined || rebooked.has(paid.demands[0].resource)) continue
    const resource = paid.demands[0].resource
    const capacity: number[] = benchResources.get(resource).capacity
    const adds = calendarsById.get(paid.calendar)!.map((on, slot) => on && capacity[slot]! > 0)
    const replaced = calendarsById.get(usual.calendar)!.map((on, slot) => on && capacity[slot]! > 0)
    const key = `${resource}-rebooking`
    purchases.push({ key, label: `${resource}: ${paid.label}`, resource, adds: { periods: periods(adds) }, replaces: periods(replaced), price: { once: paid.fixedCost }, allowed: true })
    rebooked.set(resource, { purchase: key, adds })
  }
  for (const resource of bench.resources) {
    if (resource.id.includes('@')) continue
    const capacity: number[] = resource.capacity
    const rate: number[] = resource.rate
    const top = Math.max(...capacity)
    const groups: Array<{ levels: number; base: boolean[]; overtime: boolean[] }> = []
    for (let level = 1; level <= top; level++) {
      const on = capacity.map(count => count >= level)
      const base = on.map((value, slot) => value && rate[slot] === 0 && !(rebooked.get(resource.id)?.adds[slot] ?? false))
      const overtime = on.map((value, slot) => value && rate[slot]! > 0)
      const last = groups.at(-1)
      if (last !== undefined && sameSlots(last.base, base) && sameSlots(last.overtime, overtime)) last.levels++
      else groups.push({ levels: 1, base, overtime })
    }
    const crewSize = options.crewSizes?.[resource.id]
    const layers = groups.map((group, index) => {
      const key = index === 0 ? resource.id : `${resource.id}.${index + 1}`
      calendars.push({ key: `${key}-base`, label: `${resource.name ?? resource.id}${index === 0 ? '' : ` (layer ${index + 1})`}`, weekly: [], periods: periods(group.base), except: [], source: planner })
      resources.push({ key, label: `${resource.name ?? resource.id}${index === 0 ? '' : ` (layer ${index + 1})`}`, kind: 'crew', count: group.levels, ...(crewSize === undefined ? {} : { crewSize }), calendar: `${key}-base`, attributes: [], source: planner })
      let overtime: string | undefined
      if (group.overtime.some(Boolean)) {
        const rates = new Set(group.overtime.flatMap((on, slot) => on ? [rate[slot]!] : []))
        if (rates.size !== 1) throw new Error(`${resource.id}: overtime at more than one rate`)
        overtime = `${key}-overtime`
        purchases.push({ key: overtime, label: `${resource.name ?? resource.id} overtime`, resource: key, adds: { periods: periods(group.overtime) }, replaces: [], price: { perPersonHour: [...rates][0]! / slotHours / (crewSize ?? 1) }, allowed: true })
      }
      return { key, count: group.levels, base: group.base, ...(overtime === undefined ? {} : { overtime }) }
    })
    layersOf.set(resource.id, layers)
  }
  // tool days and nights: "<base>@<when>" resources, bought by the period, with a mobilisation once per group
  const atGroups = new Map<string, any[]>()
  for (const resource of bench.resources) if (resource.id.includes('@')) atGroups.set(resource.id.split('@')[0], [...(atGroups.get(resource.id.split('@')[0]) ?? []), resource])
  const boughtFor = new Map<string, { resource: string; purchase: string }>()
  for (const [base, members] of atGroups) {
    const prices = new Set(members.map(member => member.mobilization ?? 0))
    if (prices.size !== 1) throw new Error(`${base}: periods at more than one price`)
    const union = Array.from({ length: horizon }, (_, slot) => members.some(member => member.capacity[slot] > 0))
    const group = members[0].mobilizationGroup as string | undefined
    let resource = base
    if (!layersOf.has(base)) {
      resources.push({ key: base, label: base, kind: 'crew', count: Math.max(...members.flatMap(member => member.capacity)), ...(options.crewSizes?.[base] === undefined ? {} : { crewSize: options.crewSizes[base] }), calendar: 'none', attributes: [], source: planner })
      layersOf.set(base, [{ key: base, count: 1, base: Array.from({ length: horizon }, () => false) }])
    } else resource = layersOf.get(base)![0]!.key
    const key = `${base}-${members.length > 1 ? 'periods' : members[0].id.split('@')[1]}`
    purchases.push({ key, label: `${base}: bought periods`, resource, adds: { periods: periods(union) }, replaces: [], price: { perPeriodUsed: [...prices][0]!, ...(group === undefined ? {} : { once: bench.mobilizationGroups?.[group] ?? 0 }) }, allowed: true })
    for (const member of members) boughtFor.set(member.id, { resource, purchase: key })
  }
  if ((bench.fixedCost ?? 0) > 0) {
    // a committed fixed cost (the method's parts): an ordered purchase is charged whether used or not
    purchases.push({ key: 'committed', label: 'Committed parts', resource: resources[0]!.key, adds: { periods: [{ start: at(0), end: at(1) }] }, replaces: [], price: { once: bench.fixedCost }, ordered: { at: at(0), by: { kind: 'service', name: 'twin generator' } }, allowed: false })
    notes.push(`the fixed cost ${bench.fixedCost} is an ordered purchase, charged whether used or not`)
  }

  // ── spans: items with openers and closers, groups with limits ──
  const activityById = new Map<string, any>(bench.activities.map((activity: any) => [activity.id, activity]))
  const isHelper = (id: string): boolean => { const activity = activityById.get(id); return activity !== undefined && activity.modes.every((mode: any) => mode.work === 0 && mode.demands.length === 0) && /\.(start|end)$/.test(id) }
  const sourcesInto = (id: string, type: string) => bench.links.filter((link: any) => link.to === id && link.type === type).map((link: any) => link.from as string)
  const targetsOf = (id: string, type: string) => bench.links.filter((link: any) => link.from === id && link.type === type).map((link: any) => link.to as string)
  const openersOf = (span: any): string[] => isHelper(span.open) ? targetsOf(span.open, 'SS') : [span.open]
  const closersOf = (span: any): string[] => isHelper(span.close) ? sourcesInto(span.close, 'FS') : [span.close]
  const itemSpans = bench.spans.filter((span: any) => span.maxOut === undefined && span.exposure !== false)
  const groupSpans = bench.spans.filter((span: any) => span.maxOut !== undefined)
  const openers = new Map<string, Set<string>>(itemSpans.map((span: any) => [span.id, new Set(openersOf(span))]))
  const closer = new Map<string, string[]>(itemSpans.map((span: any) => [span.id, closersOf(span)]))
  const strictSubset = (small: ReadonlySet<string>, large: ReadonlySet<string>) => small.size < large.size && [...small].every(item => large.has(item))
  const supportersOf = new Map<string, string[]>()
  for (const span of itemSpans) {
    const mine = openers.get(span.id)!
    const below = itemSpans.filter((other: any) => strictSubset(openers.get(other.id)!, mine)).map((other: any) => other.id as string)
    // direct supporters: those not below another supporter
    supportersOf.set(span.id, below.filter((candidate: string) => !below.some((other: string) => other !== candidate && strictSubset(openers.get(candidate)!, openers.get(other)!))))
  }
  const ownTags = new Map<string, string[]>()
  for (const span of itemSpans) {
    const inherited = new Set((supportersOf.get(span.id) ?? []).flatMap(supporter => [...openers.get(supporter)!]))
    ownTags.set(span.id, [...openers.get(span.id)!].filter(tag => !inherited.has(tag)))
  }
  const groupOf = new Map<string, string>()
  for (const span of groupSpans) {
    const opening = new Set(openersOf(span)), closing = new Set(closersOf(span))
    for (const item of itemSpans) if ((ownTags.get(item.id) ?? []).some(tag => opening.has(tag)) || closer.get(item.id)!.some(test => closing.has(test))) groupOf.set(item.id, span.id)
  }
  const equipment: PlanInputs['equipment'][number][] = itemSpans.map((span: any) => ({ key: span.id, label: span.name.replace(/ unavailable$/, ''), ...(groupOf.has(span.id) ? { group: groupOf.get(span.id) } : {}), supportedBy: supportersOf.get(span.id) ?? [] }))
  const rules: PlanInputs['rules'][number][] = groupSpans.map((span: any) => ({ kind: 'span-limit', key: `limit-${span.id}`, group: span.id, limit: { value: span.maxOut * slotHours, unit: 'h' }, singleEntry: true, words: `${span.name}: ${span.maxOut * slotHours} h`, source: planner }))
  for (const group of bench.groups) {
    const members = options.groupMembers?.[group.id] ?? group.spans
    for (const member of members) if (!equipment.some(item => item.key === member)) equipment.push({ key: member, label: member, supportedBy: [] })
    if (members.length - group.maxOut < 1 || members.length < 2) { notes.push(`${group.id}: ${members.length} members with at most ${group.maxOut} out cannot bind; left out`); continue }
    rules.push({ kind: 'keep-in-service', key: group.id, members: members.map((member: string) => ({ equipment: member })), atLeast: members.length - group.maxOut, words: group.name, source: planner })
  }

  // ── jobs ──
  const tagFor = new Map<string, string[]>(), testFor = new Map<string, string[]>()
  for (const span of itemSpans) {
    for (const tag of ownTags.get(span.id)!) tagFor.set(tag, [...(tagFor.get(tag) ?? []), span.id])
    for (const test of closer.get(span.id)!) testFor.set(test, [...(testFor.get(test) ?? []), span.id])
  }
  const productOf = (benchResource: string): string[] => boughtFor.has(benchResource) ? [boughtFor.get(benchResource)!.resource] : (layersOf.get(benchResource) ?? []).map(layer => layer.key)
  const jobs: PlanInputs['jobs'][number][] = []
  let deadlines = 0
  for (const activity of bench.activities) {
    if (isHelper(activity.id)) continue
    const works = new Set(activity.modes.map((mode: any) => mode.work))
    if (works.size !== 1) throw new Error(`${activity.id}: modes of different work`)
    // needs: demands on the same product resources merge, and demands that split time between them
    // (station by day, contractor by night) become one need with handover
    const needs: Array<{ anyOf: Set<string>; amount: number; handover: boolean }> = []
    for (const mode of activity.modes) {
      const parts = mode.demands.map((demand: any) => ({ anyOf: new Set(productOf(demand.resource)), amount: demand.amount, when: demand.when }))
      const merged: typeof needs = []
      for (const part of parts) {
        const joined = merged.find(need => [...part.anyOf].some(key => need.anyOf.has(key)))
        if (joined !== undefined) { for (const key of part.anyOf) joined.anyOf.add(key); continue }
        const split = part.when !== undefined && merged.find(need => need.amount === part.amount && (need as any).when !== undefined && !calendarsById.get((need as any).when)!.some((on, slot) => on && calendarsById.get(part.when)![slot]))
        if (split) { for (const key of part.anyOf) split.anyOf.add(key); split.handover = true; continue }
        merged.push({ anyOf: new Set(part.anyOf), amount: part.amount, handover: false, ...(part.when === undefined ? {} : { when: part.when }) } as any)
      }
      for (const need of merged) {
        const known = needs.find(other => [...need.anyOf].some(key => other.anyOf.has(key)))
        if (known === undefined) needs.push({ anyOf: new Set(need.anyOf), amount: need.amount, handover: need.handover })
        else { for (const key of need.anyOf) known.anyOf.add(key); known.handover ||= need.handover }
      }
    }
    const kind = tagFor.has(activity.id) ? 'tag-out' : testFor.has(activity.id) ? 'test' : 'work'
    if (activity.deadline !== undefined && activity.deadline < horizon) {
      deadlines++
      rules.push({ kind: 'due', key: `due-${activity.id}`, job: activity.id, finishBy: at(activity.deadline), words: `${activity.name}: due ${at(activity.deadline)}`, source: planner })
    }
    jobs.push({
      key: activity.id, title: activity.name, kind,
      equipment: kind === 'tag-out' ? tagFor.get(activity.id)! : kind === 'test' ? testFor.get(activity.id)! : [],
      isolation: 'none',
      duration: { value: activity.modes[0].work * slotHours, unit: 'h', calendar: 'working', origin: planner },
      durationWith: [],
      needs: needs.map(need => ({ anyOf: [...need.anyOf], amount: need.amount, handover: need.handover })),
      continuous: !activity.modes[0].interruptible,
      ...(activity.release === undefined || activity.release === 0 ? {} : { notBefore: { at: at(activity.release), words: 'Release', source: planner } }),
      checks: [], tags: [],
    })
  }
  if (deadlines > 0) notes.push(`${deadlines} hard job deadlines are due rules`)
  const links: PlanInputs['links'][number][] = bench.links
    .filter((link: any) => !isHelper(link.from) && !isHelper(link.to))
    .map((link: any) => ({ from: link.from, to: link.to, type: link.type, lag: { value: link.min * slotHours, unit: 'h' } }))
  if (bench.links.some((link: any) => link.max !== undefined)) notes.push('maximum lags are not written: the plan schema has none')

  const inputs = planInputsSchema.parse({
    settings: { title: options.title, timeZone: options.zone, window: { start: at(0), end: at(horizon) }, dataDate: at(0), grid: '30min', currency: options.currency, run: null },
    equipment, groups: groupSpans.map((span: any) => ({ key: span.id, label: span.name.replace(/: allowed outage time$/, '') })),
    calendars, resources, purchases, methods: [], jobs, links, rules, goals: options.goals, world: { refreshedAt: null, facts: [] },
  })
  const variant: CheckVariant = { methods: [], purchases: purchases.filter(purchase => purchase.allowed).map(purchase => purchase.key) }

  const rowsOf = (solution: { readonly mode: readonly number[]; readonly start: readonly number[] }): CheckRow[] => {
    type Layer = { key: string; count: number; base: boolean[]; overtime?: string }
    interface Unit { readonly row: number; readonly resource: string; readonly slots: readonly number[]; layer?: Layer }
    const rows: Array<{ job: string; start: string; finish: string; uses: Array<CheckRow['uses'][number]> }> = []
    const units: Unit[] = []
    bench.activities.forEach((activity: any, index: number) => {
      if (isHelper(activity.id)) return
      const mode = activity.modes[solution.mode[index]!]
      const start = solution.start[index]!
      const work = calendarsById.get(mode.calendar)!
      const worked: number[] = []
      if (mode.interruptible) { for (let slot = start; slot < horizon && worked.length < mode.work; slot++) if (work[slot]) worked.push(slot) }
      else for (let slot = start; slot < start + mode.work; slot++) worked.push(slot)
      const row = rows.length
      rows.push({ job: activity.id, start: at(start), finish: at(worked.length === 0 ? start : worked[worked.length - 1]! + 1), uses: [] })
      for (const demand of mode.demands) {
        const when = demand.when === undefined ? undefined : calendarsById.get(demand.when)!
        const slots = worked.filter(slot => when === undefined || when[slot])
        if (slots.length > 0) for (let unit = 0; unit < demand.amount; unit++) units.push({ row, resource: demand.resource, slots })
      }
    })
    // capacity layers: the units that fit fewest layers choose first, so a job running into the night keeps
    // the all-hours layer and a day job takes the day-only one; each unit keeps one layer throughout
    const onDuty = (resource: string, layer: Layer, slot: number): boolean =>
      layer.base[slot] === true || (layer.overtime !== undefined && benchResources.get(resource).rate[slot] > 0) || rebooked.get(resource)?.adds[slot] === true
    const load = new Map<string, Int32Array>()
    const loadOf = (key: string) => { let array = load.get(key); if (array === undefined) { array = new Int32Array(horizon); load.set(key, array) } return array }
    const fitting = (unit: Unit) => (layersOf.get(unit.resource) ?? []).filter(layer => unit.slots.every(slot => onDuty(unit.resource, layer, slot)))
    const layered = units.filter(unit => !boughtFor.has(unit.resource))
    layered.sort((left, right) => fitting(left).length - fitting(right).length || left.slots[0]! - right.slots[0]!)
    for (const unit of layered) {
      const candidates = fitting(unit)
      unit.layer = candidates.find(layer => unit.slots.every(slot => loadOf(layer.key)[slot]! < layer.count)) ?? candidates[0] ?? layersOf.get(unit.resource)![0]!
      for (const slot of unit.slots) loadOf(unit.layer.key)[slot]!++
    }
    for (const unit of units) {
      const bought = boughtFor.get(unit.resource)
      const layer: Layer = bought !== undefined ? { key: bought.resource, count: 1, base: [] } : unit.layer!
      const rebooking = rebooked.get(unit.resource)
      const purchaseAt = (slot: number): string | undefined => bought !== undefined ? bought.purchase
        : layer.base[slot] === true ? undefined
        : rebooking?.adds[slot] === true ? rebooking.purchase
        : layer.overtime
      let open: { from: number; to: number; purchase: string | undefined } | undefined
      const close = () => { if (open !== undefined) rows[unit.row]!.uses.push({ resource: layer.key, from: at(open.from), to: at(open.to), ...(open.purchase === undefined ? {} : { purchase: open.purchase }) }); open = undefined }
      for (const slot of unit.slots) {
        const purchase = purchaseAt(slot)
        if (open !== undefined && open.to === slot && open.purchase === purchase) { open.to = slot + 1; continue }
        close()
        open = { from: slot, to: slot + 1, purchase }
      }
      close()
    }
    return rows
  }
  return { inputs, variant, notes, rowsOf }
}

/** The gate's goal order (maint/twin-v3-spec.md §5): guideline excess, finish (1 h steps), extra cost (NOK 5,000 steps). */
export const gateGoals = (bench: Bench): PlanInputs['goals'] => {
  const guided = bench.spans.filter((span: any) => span.guideline !== undefined)
  return [
    { metric: 'span-over', scope: { groups: guided.map((span: any) => span.id) }, threshold: { value: guided[0].guideline * bench.slotHours, unit: 'h' }, tolerance: { value: 0, unit: 'h' } },
    { metric: 'finish', tolerance: { value: 1, unit: 'h' } },
    { metric: 'extra-cost', tolerance: { value: 5_000, unit: 'NOK' } },
  ]
}

/** maint/twin-v3-spec.md §2 and §4: crew sizes and every member of each k-of-G group. */
export const twinV3Options = (bench: Bench): TwinOptions => ({
  title: 'Gate twin v3', origin: '2026-11-16T06:00:00Z', zone: 'Europe/Oslo', currency: 'NOK',
  crewSizes: { 'mech-station': 3, 'elec-station': 2, 'ic-station': 2, 'mech-contractor': 3 },
  groupMembers: Object.fromEntries(['U1', 'U2'].flatMap(unit => [
    [`${unit}-CP`, [1, 2, 3].map(index => `${unit}-CP${index}`)],
    [`${unit}-CTF`, [1, 2, 3, 4].map(index => `${unit}-CTF${index}`)],
    [`${unit}-IAC`, [1, 2, 3].map(index => `${unit}-IAC${index}`)],
    [`${unit}-CWP`, [1, 2, 3, 4].map(index => `${unit}-CWP${index}`)],
  ])),
  goals: gateGoals(bench),
})

/** Twin v1 names every group member itself. */
export const twinV1Options = (bench: Bench): TwinOptions => ({
  title: 'Gate twin v1 (stress case)', origin: '2026-11-16T06:00:00Z', zone: 'Europe/Oslo', currency: 'NOK',
  crewSizes: { 'mech-station': 3, 'elec-station': 2, 'ic-station': 2, 'mech-contractor': 3 },
  goals: gateGoals(bench),
})

if (import.meta.main) {
  const [twinFile, ...solutionFiles] = process.argv.slice(2)
  if (twinFile === undefined) throw new Error('usage: bun twin-plan.ts <twin.json> [<run.json> ...]')
  const text = await Bun.file(twinFile).text()
  const bench = JSON.parse(text)
  const sha256 = new Bun.CryptoHasher('sha256').update(text).digest('hex')
  const plan = twinPlan(bench, bench.name === 'gate-twin-v3' ? twinV3Options(bench) : twinV1Options(bench))
  const kinds = Object.fromEntries(['tag-out', 'work', 'test'].map(kind => [kind, plan.inputs.jobs.filter(job => job.kind === kind).length]))
  console.log(`${twinFile} sha256 ${sha256}: ${plan.inputs.jobs.length} jobs ${JSON.stringify(kinds)}, ${plan.inputs.links.length} links, ${plan.inputs.equipment.length} items, ${plan.inputs.rules.length} rules, ${plan.inputs.resources.length} resources, ${plan.inputs.purchases.length} purchases`)
  for (const note of plan.notes) console.log(`  note: ${note}`)
  for (const file of solutionFiles) {
    const run = JSON.parse(await Bun.file(file).text())
    const started = performance.now()
    const result = checkPlan(plan.inputs, plan.variant, plan.rowsOf(run.solution))
    const metrics = Object.fromEntries(result.metrics.map(item => [item.id, item.value]))
    const span = result.goals[0]
    const excess = span?.metric === 'span-over' ? span.spans.reduce((sum, item) => sum + Math.max(0, item.value - 54), 0) : NaN
    console.log(`${file}: ${result.violations.length} violations in ${(performance.now() - started).toFixed(0)} ms; guideline excess ${excess} h (run ${run.guidelineH}), finish ${metrics.finish} h (run ${run.finishH}), extra cost ${metrics['extra-cost']} (run ${run.costNok})`)
    for (const violation of result.violations.slice(0, 6)) console.log(`  ${violation.code}: ${violation.words}`)
  }
}
