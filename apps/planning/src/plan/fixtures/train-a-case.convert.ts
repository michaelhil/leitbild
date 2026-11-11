// Test support, not shipped: the frozen flagship case (maint/case-v0.2.json, sha256 a552c921…) converted
// deterministically to the plan inputs in train-a.case.json, with every coordinator decision since the
// freeze applied. Values come from the case; the only values written here are the decisions the case does
// not hold (test minimums, the cost step, function keys, the switchyard of case change C10), each named.
// Every note is shown to planners, so notes are planner words: review traces (case versions, change ids,
// reviewer names) stay in comments, the .sha256 sibling and commit messages, never in a note.
// usage: bun apps/planning/src/plan/fixtures/train-a-case.convert.ts   (rewrites train-a.case.json)
import caseJson from '../../solve/fixtures/train-a-case-v0.2.json'
import { planInputsSchema, type PlanInputs } from '../schema.ts'

export const TRAIN_A_CASE_SHA256 = 'a552c921c58fe982c3d413fe7ccd8ae505b9f312949f804f541706e6460ed9b1'

interface CaseDemand { readonly resource?: string; readonly anyOf?: readonly string[]; readonly amount: number }
interface CaseJob {
  readonly id: string; readonly title: string; readonly equipment: string; readonly kind: 'isolate' | 'work' | 'restore-test'
  readonly hours: number; readonly range?: readonly number[]; readonly demands: readonly CaseDemand[]; readonly interruptible: boolean
  readonly crewHandover?: boolean; readonly method?: string; readonly release?: string; readonly makesUnavailable?: boolean
  readonly passMakesAvailable?: readonly string[]; readonly precondition?: string; readonly basis: string
}
interface CaseCase {
  readonly window: { readonly start: string; readonly end: string }
  readonly story: { readonly now: string }
  readonly equipment: ReadonlyArray<{ readonly id: string; readonly label: string; readonly worldComponentId: string; readonly group: string; readonly source: string; readonly note?: string }>
  readonly protectedEquipment: { readonly items: readonly string[]; readonly alsoProtectedNotInPlanningBasis: readonly string[]; readonly basis: string }
  readonly supportDependencies: ReadonlyArray<{ readonly supporter?: string; readonly supported?: readonly string[] }>
  readonly functionGroups: ReadonlyArray<{ readonly id: string; readonly label: string; readonly allowedOutageHours: number; readonly singleEntry: boolean; readonly words?: string; readonly basis: string; readonly guideline: { readonly maxPlannedHours: number } }>
  readonly calendars: {
    readonly day: { readonly weekly: ReadonlyArray<{ readonly days: readonly string[]; readonly from: string; readonly to: string }> }
    readonly overtime: { readonly weekly: ReadonlyArray<{ readonly days: readonly string[]; readonly from: string; readonly to: string }> }
    readonly night: { readonly nights: readonly string[]; readonly from: string; readonly to: string }
    readonly crane: { readonly intervals: ReadonlyArray<readonly string[]>; readonly optionalExtension: readonly string[] }
    readonly ect: { readonly intervals: ReadonlyArray<readonly string[]>; readonly rebookOption: { readonly interval: readonly string[]; readonly costNok: number } }
  }
  readonly resources: ReadonlyArray<{ readonly id: string; readonly label: string; readonly kind: string; readonly count: number; readonly crewSize?: number; readonly calendars: readonly string[]; readonly orderBy?: string; readonly words?: string }>
  readonly methods: { readonly SWA: ReadonlyArray<{ readonly id: string; readonly label: string; readonly spareArrivalBasis?: string }> }
  readonly jobs: readonly CaseJob[]
  readonly links: ReadonlyArray<{ readonly from: string; readonly to: string; readonly type: 'FS' | 'SS' | 'FF'; readonly lagHours: number; readonly method?: string; readonly words?: string }>
  readonly costs: {
    readonly currency: string
    readonly stationOvertime: { readonly nokPerPersonHour: number }
    readonly contractorNight: { readonly nokPerPersonHour: number; readonly minimumHoursPerNight: number; readonly mobilisationNok: number }
    readonly craneExtensionDayNok: number; readonly ectRebookNok: number; readonly methodParts: Readonly<Record<string, number>>
  }
}

const utc = (iso: string): string => new Date(Date.parse(iso)).toISOString().replace('.000Z', 'Z')
const pair = (interval: readonly string[]) => ({ start: utc(interval[0]!), end: utc(interval[1]!) })
const plantLocator = (componentId: string): string => `process-plant/${encodeURIComponent('plant:train-a')}/${componentId}`
const runningFact = (componentId: string): string => `plant:train-a/${componentId}/runningState`
const lower = (days: readonly string[]) => days.map(day => day.toLowerCase()) as Array<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'>
const planner = { by: 'planner' as const }
const once = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`The frozen case has no ${what}`)
  return value
}

// Decisions the case does not hold, each named by its source.
/** Plan keys of the protected items; World pump labels are the reference template graph's own. */
const protectedItem: Readonly<Record<string, { readonly key: string; readonly label: string }>> = {
  serviceWaterPumpB: { key: 'SWB', label: 'Service Water Pump B' },
  componentCoolingWaterPumpB: { key: 'CCWB', label: 'Component Cooling Water Pump B' },
  rhrPumpB: { key: 'RHRB', label: 'Residual Heat Removal Pump B' },
  safetyInjectionPumpB: { key: 'HHSIB', label: 'High-Head Safety Injection Pump B' },
  containmentSprayPumpB: { key: 'CSB', label: 'Containment Spray Pump B' },
  auxFeedwaterPumpMotorB: { key: 'AFWB', label: 'Motor-Driven Auxiliary Feedwater Pump B' },
  auxFeedwaterPumpTurbine: { key: 'AFWTD', label: 'Turbine-Driven Auxiliary Feedwater Pump' },
  dieselGeneratorB: { key: 'EDGB', label: 'Emergency Diesel Generator B' },
  safetyBusB: { key: 'BUSB', label: 'Safety Bus B' },
}
/** maint/case-changes.md C10: the switchyard/offsite supply is protected all week (wording only, no JSON change). */
const switchyard = {
  key: 'SWYD', label: 'Switchyard and offsite supply',
  note: 'Declared for this week: the switchyard and offsite supply are protected, and no job may touch the switchyard (risk-management practice for work at power; examples in NRC IMC 0308 Att 3 App K).',
}
/** Planner words for the provenance the case states in reviewer terms (equipment notes, protected-train and group bases). */
export const plannerNote = {
  /** case v0.2 protectedEquipment.basis */
  protectedTrain: 'Protected-train practice for work at power (NUMARC 93-01 section 11, endorsed by NRC RG 1.160; examples in NRC IMC 0308 Att 3 App K), declared as this plant\'s rule.',
  /** case v0.2 equipment notes for items outside the pump-only planning read */
  notRead: 'In the plant, but the World planning read covers pumps only, so the planner declares it here.',
  /** case v0.2 functionGroups[].basis, by group */
  groups: {
    'COOL-A': 'Modelled on the US Standard Technical Specifications (NUREG-1431): one emergency core cooling train out for 72 h (LCO 3.5.2), with the same 72 h for component cooling (3.7.7) and service water (3.7.8). The clock runs from the first removal from service. Declared as this plant\'s rule, not a licence.',
    'CS-A': 'Modelled on the US Standard Technical Specifications (NUREG-1431 LCO 3.6.6): 72 h for one containment spray train. Declared as this plant\'s rule.',
    'AFW-A': 'Modelled on the US Standard Technical Specifications (NUREG-1431 LCO 3.7.5 Condition B): 72 h for one auxiliary feedwater train. Declared as this plant\'s rule.',
  } as Readonly<Record<string, string>>,
}
/** Coordinator (lane S): items that back each other up share a key; case v0.2 pairs trains A and B and keeps the turbine-driven AFW pump apart. */
const functionOf: Readonly<Record<string, string>> = {
  SWA: 'service-water', SWB: 'service-water', CCWA: 'component-cooling', CCWB: 'component-cooling',
  RHRA: 'residual-heat-removal', RHRB: 'residual-heat-removal', HHSIA: 'high-head-injection', HHSIB: 'high-head-injection',
  CSA: 'containment-spray', CSB: 'containment-spray', AFWA: 'motor-driven-aux-feedwater', AFWB: 'motor-driven-aux-feedwater',
  AFWTD: 'turbine-driven-aux-feedwater',
}
const membership = { by: 'planner' as const, note: 'Backup pair: the planner\'s knowledge of the plant\'s trains.' }
/** The notes as shown, for the other Train A fixture (train-a.fragment.json) to use the same words. */
export const shownNotes = {
  membership: membership.note,
  unread: `Protected all week. ${plannerNote.notRead} ${plannerNote.protectedTrain}`,
  switchyard: switchyard.note,
  protectedRule: `${plannerNote.protectedTrain} Declared for this week: the switchyard and offsite supply are protected too.`,
} as const
/** maint/lane-a-fixture-check.md section 3: test minimums, planner judgement. */
const minimumHours: Readonly<Record<string, number>> = { 'SWA-RTS': 2.5, 'CCWA-RTS': 1.5, 'RHRA-RTS': 1.5, 'HHSIA-RTS': 1, 'CSA-RTS': 1.5, 'AFWA-RTS': 1.5 }
const minimumWords = "planner judgement, no procedure source; below it needs the test engineer's agreement and a reason"
/** maint/lane-a-fixture-check.md section 4: the cost step, about 8 overtime crew-hours, a changeable preference. */
const costStepNok = 25_000
/** The method choice and its option keys, as in the design's example and the solver tests. */
const methodChoice = 'SWA-method'
const optionKey: Readonly<Record<string, string>> = { 'M1-rebuild': 'rebuild', 'M2-swap': 'swap' }
const calendarOf: Readonly<Record<string, string>> = { day: 'day', 'overtime?': 'day', 'night (booked nights only)': 'none', always: 'always', crane: 'crane', ect: 'ect' }

export const convertTrainACase = (frozen: CaseCase): PlanInputs => {
  const supportedBy = new Map<string, string[]>()
  for (const dependency of frozen.supportDependencies) {
    if (dependency.supporter === undefined) continue
    for (const supported of dependency.supported ?? []) supportedBy.set(supported, [...(supportedBy.get(supported) ?? []), dependency.supporter])
  }
  const withFunction = <T extends { readonly key: string }>(item: T) =>
    functionOf[item.key] === undefined ? item : { ...item, function: functionOf[item.key]!, source: membership }
  const keyOf = (componentId: string): string => once(protectedItem[componentId], `plan key for ${componentId}`).key
  const unreadNote = shownNotes.unread
  const equipment = [
    ...frozen.equipment.map(item => withFunction({
      key: item.id, label: item.label, group: item.group, supportedBy: supportedBy.get(item.id) ?? [],
      ...(item.source === 'world' ? { locator: plantLocator(item.worldComponentId) } : { source: { by: 'planner' as const, note: plannerNote.notRead } }),
    })),
    ...frozen.protectedEquipment.items.map(id => withFunction({ key: keyOf(id), label: protectedItem[id]!.label, supportedBy: [], locator: plantLocator(id) })),
    ...frozen.protectedEquipment.alsoProtectedNotInPlanningBasis.map(id => ({ key: keyOf(id), label: protectedItem[id]!.label, supportedBy: [], source: { by: 'reference' as const, note: unreadNote } })),
    { key: switchyard.key, label: switchyard.label, supportedBy: [], source: { by: 'reference' as const, note: switchyard.note } },
  ]
  const componentKey = new Map(frozen.equipment.map(item => [item.worldComponentId, item.id]))
  const equipmentKey = (componentId: string): string => componentKey.get(componentId) ?? keyOf(componentId)

  const restoredBy = (item: string) => once(frozen.jobs.find(job => job.kind === 'restore-test' && job.equipment === item), `test of ${item}`)
  const precondition = (words: string) => {
    const component = once(frozen.protectedEquipment.items.find(id => words === `World shows ${protectedItem[id]?.key.replace(/B$/, ' B')} running`), `World item in "${words}"`)
    return { equipment: equipmentKey(component), fact: runningFact(component), expect: true, words }
  }
  const option = (id: string) => ({ choice: methodChoice, option: once(optionKey[id], `option key for ${id}`) })
  const swap = once(frozen.methods.SWA.find(method => method.id === 'M2-swap'), 'swap method')
  const jobs = frozen.jobs.map((job): PlanInputs['jobs'][number] => {
    const kind = job.kind === 'isolate' ? 'tag-out' as const : job.kind === 'work' ? 'work' as const : 'test' as const
    // A tag-out isolates what the item's return-to-service test restores: the CCW A tag-out also isolates HX A.
    const equipmentOf = kind === 'work' ? [job.equipment] : kind === 'test' ? [...once(job.passMakesAvailable, `${job.id} restored items`)] : [...once(restoredBy(job.equipment).passMakesAvailable, `${job.id} restored items`)]
    const minimum = minimumHours[job.id]
    if (kind === 'test' && minimum === undefined) throw new Error(`${job.id} has no minimum`)
    return {
      key: job.id, title: job.title, kind, equipment: equipmentOf,
      isolation: kind === 'work' && job.makesUnavailable !== false ? 'inside' : 'none',
      duration: { value: job.hours, unit: 'h', calendar: 'working', ...(job.range === undefined ? {} : { range: { low: job.range[0]!, high: job.range[job.range.length - 1]! } }), origin: { by: 'planner', note: job.basis } },
      durationWith: [],
      ...(minimum === undefined ? {} : { minimum: { value: minimum, unit: 'h' as const, words: minimumWords } }),
      needs: job.demands.map(demand => ({ anyOf: demand.anyOf === undefined ? [once(demand.resource, `${job.id} demand`)] : [...demand.anyOf], amount: demand.amount, handover: demand.anyOf !== undefined && job.crewHandover === true })),
      continuous: !job.interruptible,
      ...(job.method === undefined ? {} : { method: option(job.method) }),
      ...(job.release === undefined ? {} : { notBefore: { at: utc(job.release), words: 'The vendor promises the spare on site Mon 16 Nov 12:00', source: { by: 'assumption' as const, note: once(swap.spareArrivalBasis, 'spare arrival basis') } } }),
      checks: job.precondition === undefined ? [] : [precondition(job.precondition)],
      tags: [],
    }
  })
  const links = frozen.links.map(link => ({
    from: link.from, to: link.to, type: link.type, lag: { value: link.lagHours, unit: 'h' as const },
    ...(link.method === undefined ? {} : { method: option(link.method) }),
    ...(link.words === undefined ? {} : { words: link.words }),
  }))

  const resource = (id: string) => once(frozen.resources.find(entry => entry.id === id), `resource ${id}`)
  const contractor = resource('mech-contractor')
  const night = frozen.calendars.night
  const nightOf = (date: string) => ({ start: utc(`${date}T${night.from}:00+01:00`), end: utc(new Date(Date.parse(`${date}T${night.from}:00+01:00`) + 86_400_000).toISOString().slice(0, 10) + `T${night.to}:00+01:00`) })
  const nightPrice = frozen.costs.contractorNight.nokPerPersonHour * frozen.costs.contractorNight.minimumHoursPerNight * once(contractor.crewSize, 'contractor crew size')
  const overtimeOf = (id: string, label: string) => ({ key: id === 'mech-station' ? 'ot-mech' : 'ot-elec', label, resource: id, adds: { calendar: 'overtime' }, replaces: [], price: { perPersonHour: frozen.costs.stationOvertime.nokPerPersonHour }, allowed: true })
  const weeklyOf = (weekly: CaseCase['calendars']['day']['weekly']) => weekly.map(entry => ({ days: lower(entry.days), from: entry.from, to: entry.to }))
  const allDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

  const cool = once(frozen.functionGroups.find(group => group.id === 'COOL-A'), 'cooling-chain group')
  const r1Keys = [...frozen.protectedEquipment.items, ...frozen.protectedEquipment.alsoProtectedNotInPlanningBasis].map(keyOf).concat(switchyard.key)
  return planInputsSchema.parse({
    settings: {
      title: 'Train A work week',
      purpose: 'Every Train A item worked, tested and back inside its allowed outage time and the window, Train B untouched, least extra cost.',
      timeZone: 'Europe/Oslo', window: { start: utc(frozen.window.start), end: utc(frozen.window.end) }, dataDate: utc(frozen.story.now),
      grid: '30min', currency: frozen.costs.currency, run: null,
      scenario: { id: 'train-a-work-week', title: 'Train A work week (reference PWR, paused at full power)' },
    },
    equipment,
    groups: frozen.functionGroups.map(group => ({ key: group.id, label: group.label })),
    calendars: [
      { key: 'day', label: 'Day shift', weekly: weeklyOf(frozen.calendars.day.weekly), periods: [], except: [], source: planner },
      { key: 'overtime', label: 'Overtime to 19:00', weekly: weeklyOf(frozen.calendars.overtime.weekly), periods: [], except: [], source: planner },
      { key: 'always', label: '24/7 shift operation', weekly: [{ days: [...allDays], from: '00:00', to: '00:00' }], periods: [], except: [], source: planner },
      { key: 'none', label: 'Booked nights only', weekly: [], periods: [], except: [], source: planner },
      { key: 'crane', label: 'Lit crane-crew hours, Tue to Thu', weekly: [], periods: frozen.calendars.crane.intervals.map(pair), except: [], source: planner },
      { key: 'ect', label: 'Eddy-current team booked Wednesday', weekly: [], periods: frozen.calendars.ect.intervals.map(pair), except: [], source: planner },
    ],
    resources: frozen.resources.map(entry => ({
      key: entry.id, label: entry.label, kind: entry.kind === 'equipment' ? 'tool' : 'crew', count: entry.count,
      ...(entry.crewSize === undefined ? {} : { crewSize: entry.crewSize }),
      calendar: once(calendarOf[once(entry.calendars[0], `${entry.id} calendar`)], `${entry.id} calendar key`),
      attributes: [], ...(entry.words === undefined ? {} : { words: entry.words }), source: planner,
    })),
    purchases: [
      ...frozen.resources.filter(entry => entry.calendars.includes('overtime?')).map(entry => overtimeOf(entry.id, `${entry.label} overtime to 19:00`)),
      { key: 'contractor-nights', label: 'Contractor night crew (nights Mon to Thu)', resource: contractor.id, adds: { periods: night.nights.map(nightOf) }, replaces: [],
        price: { perPeriodUsed: nightPrice, once: frozen.costs.contractorNight.mobilisationNok }, orderBy: utc(once(contractor.orderBy, 'contractor order deadline')), allowed: true },
      { key: 'crane-fri', label: 'Crane extra day, Fri 20 Nov', resource: 'crane', adds: { periods: [pair(frozen.calendars.crane.optionalExtension)] }, replaces: [], price: { perPeriodUsed: frozen.costs.craneExtensionDayNok }, allowed: true },
      { key: 'ect-friday', label: 'Rebook the eddy-current team to Friday', resource: 'ect-team', adds: { periods: [pair(frozen.calendars.ect.rebookOption.interval)] },
        replaces: frozen.calendars.ect.intervals.map(pair), price: { once: frozen.costs.ectRebookNok }, allowed: true },
    ],
    methods: [{ key: methodChoice, label: 'SW A pump assembly', options: frozen.methods.SWA.map(method => ({ key: once(optionKey[method.id], method.id), label: method.label, fixedCost: once(frozen.costs.methodParts[method.id], `${method.id} parts`) })) }],
    jobs, links,
    rules: [
      { kind: 'protected', key: 'R1', equipment: r1Keys,
        words: 'Every Train B item (SW B, CCW B, RHR B, HHSI B, CS B, MD AFW B, EDG B, safety bus B), the turbine-driven AFW pump and the switchyard/offsite supply are never tagged, worked or tested.',
        source: { by: 'reference', note: shownNotes.protectedRule } },
      ...frozen.functionGroups.map(group => ({
        kind: 'span-limit', key: group.id === cool.id ? 'R2' : `R2-${group.id}`, group: group.id, limit: { value: group.allowedOutageHours, unit: 'h' }, singleEntry: group.singleEntry,
        words: group.words ?? `${group.label}: back and tested within ${group.allowedOutageHours} h of the first tag-out, in one continuous span.`,
        source: { by: 'reference', note: once(plannerNote.groups[group.id], `planner words for ${group.id}`) },
      })),
    ],
    goals: [
      { metric: 'span-over', scope: { groups: [cool.id] }, threshold: { value: cool.guideline.maxPlannedHours, unit: 'h' }, tolerance: { value: 0, unit: 'h' } },
      { metric: 'extra-cost', tolerance: { value: costStepNok, unit: frozen.costs.currency } },
      { metric: 'unavailable-hours', tolerance: { value: 0, unit: 'h' } },
    ],
    world: { refreshedAt: null, facts: [] },
  })
}

export const trainACase = (): PlanInputs => convertTrainACase(caseJson as unknown as CaseCase)

if (import.meta.main) {
  const sha = new Bun.CryptoHasher('sha256').update(await Bun.file(new URL('../../solve/fixtures/train-a-case-v0.2.json', import.meta.url)).text()).digest('hex')
  if (sha !== TRAIN_A_CASE_SHA256) throw new Error(`The frozen case changed: ${sha}`)
  await Bun.write(new URL('./train-a.case.json', import.meta.url), `${JSON.stringify(trainACase(), null, 2)}\n`)
  await Bun.write(new URL('./train-a.case.sha256', import.meta.url), `${sha}  case-v0.2.json\n`)
}
