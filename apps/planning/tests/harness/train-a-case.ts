// Test harness, not shipped logic: the frozen flagship case (maint/case-v0.2.json, sha256 a552c921…)
// converted to plan inputs, with or's run choices and replan progress, so the product checker can judge
// or's schedules. It changes no case value. Written independently of the Definition builder (lane P).
import { planInputsSchema, type PlanInputs } from '../../src/plan/schema.ts'
import type { CheckVariant } from '../../src/check/check.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type CaseJson = any

export interface CaseChoices {
  readonly method: string
  readonly overtime: boolean
  readonly nights: readonly string[]
  readonly craneFriday: boolean
  readonly ectFriday: boolean
  readonly spareRelease?: string
  /** Short-notice contractor ordering (disruption X1): prices times this factor. */
  readonly contractorFactor?: number
}
export interface CaseActual { readonly job: string; readonly start: string; readonly finish?: string; readonly remainingHours?: number }
export interface CaseProgress {
  readonly asOf: string
  readonly actuals: readonly CaseActual[]
  readonly addJobs: readonly any[]
  readonly addLinks: readonly any[]
  readonly failedTests: readonly string[]
  readonly capacityLoss: ReadonlyArray<{ readonly resource: string; readonly from: string; readonly to: string; readonly reason: string }>
}

const utc = (iso: string): string => new Date(Date.parse(iso)).toISOString().replace('.000Z', 'Z')
const hoursBetween = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 3_600_000
const methodChoice = 'SWA-method'
const plantLocator = (componentId: string): string => `process-plant/plant%3Atrain-a/${componentId}`
const preconditions: Readonly<Record<string, { readonly equipment: string; readonly words: string }>> = {
  'World shows SW B running': { equipment: 'serviceWaterPumpB', words: 'World shows SW B running' },
  'World shows CCW B running': { equipment: 'componentCoolingWaterPumpB', words: 'World shows CCW B running' },
}
const runningFact = (componentId: string): string => `plant:train-a/${componentId}/runningState`
const restKey = (job: string): string => `${job}.rest`

/** The case's jobs for a choice of method, with replan progress applied as locks, cut and added work. */
export const trainAInputs = (cj: CaseJson, choices: CaseChoices, progress?: CaseProgress): { readonly inputs: PlanInputs; readonly variant: CheckVariant } => {
  const factor = choices.contractorFactor ?? 1
  const contractor = cj.resources.find((resource: any) => resource.id === 'mech-contractor')
  const nightPrice = cj.costs.contractorNight.nokPerPersonHour * cj.costs.contractorNight.minimumHoursPerNight * contractor.crewSize * factor
  const nights = (cj.calendars.night.nights as string[]).map(date => ({ start: utc(`${date}T19:00:00+01:00`), end: new Date(Date.parse(`${date}T19:00:00+01:00`) + 12 * 3_600_000).toISOString().replace('.000Z', 'Z') }))
  const interval = (pair: readonly string[]) => ({ start: utc(pair[0]!), end: utc(pair[1]!) })
  const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'] as const
  const allDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
  const planner = { by: 'planner' as const }

  const groupOf = new Map<string, string>((cj.equipment as any[]).map(item => [item.id, item.group]))
  const supportedBy = new Map<string, string[]>()
  for (const dependency of cj.supportDependencies as any[]) {
    if (dependency.supporter === undefined) continue
    for (const supported of dependency.supported) supportedBy.set(supported, [...(supportedBy.get(supported) ?? []), dependency.supporter])
  }
  const protectedItems: string[] = cj.protectedEquipment.items
  const equipment: PlanInputs['equipment'] = [
    ...(cj.equipment as any[]).map(item => ({
      key: item.id, label: item.label, group: groupOf.get(item.id), supportedBy: supportedBy.get(item.id) ?? [],
      ...(item.source === 'world' ? { locator: plantLocator(item.worldComponentId) } : {}),
    })),
    ...protectedItems.map(id => ({ key: id, label: `Protected ${id}`, supportedBy: [], locator: plantLocator(id) })),
  ]

  // which items a tag-out isolates and a test restores: the CCW A tag-out covers its heat exchanger too
  const coveredBy = (job: any): string[] => job.kind === 'restore-test' ? [...job.passMakesAvailable] : job.title.includes('HX A') && job.equipment === 'CCWA' ? ['CCWA', 'CCWHXA'] : [job.equipment]
  const failed = new Set(progress?.failedTests ?? [])
  const toJob = (job: any): PlanInputs['jobs'][number] => {
    const kind = job.kind === 'isolate' ? 'tag-out' : job.kind === 'restore-test' ? (failed.has(job.id) ? 'work' : 'test') : 'work'
    const release = job.method === 'M2-swap' && job.release !== undefined ? (choices.spareRelease ?? job.release) : job.release
    const precondition = job.precondition === undefined ? undefined : preconditions[job.precondition]
    return {
      key: job.id, title: job.title, kind,
      equipment: kind === 'work' ? [job.equipment] : coveredBy(job),
      isolation: kind === 'work' && job.makesUnavailable !== false ? 'inside' : 'none',
      duration: { value: job.hours, unit: 'h', calendar: 'working', ...(job.range === undefined ? {} : { range: { low: job.range[0], high: job.range[job.range.length - 1] } }), origin: planner },
      durationWith: [],
      needs: (job.demands as any[]).map(demand => ({ anyOf: demand.anyOf ?? [demand.resource], amount: demand.amount, handover: demand.anyOf !== undefined && job.crewHandover === true })),
      continuous: !job.interruptible,
      ...(job.method === undefined ? {} : { method: { choice: methodChoice, option: job.method } }),
      ...(release === undefined ? {} : { notBefore: { at: utc(release), words: 'Spare on site (vendor promise)', source: { by: 'assumption' as const, note: 'vendor promise' } } }),
      checks: precondition === undefined ? [] : [{ equipment: precondition.equipment, fact: runningFact(precondition.equipment), expect: true, words: precondition.words }],
      tags: [],
    }
  }
  const jobs: PlanInputs['jobs'][number][] = []
  const links: PlanInputs['links'][number][] = []
  const caseLinks: any[] = [...cj.links, ...(progress?.addLinks ?? [])]
  const caseJobs: any[] = [...cj.jobs, ...(progress?.addJobs ?? [])]
  const renamed = new Map<string, string>()
  const fixed = new Set<string>()
  for (const caseJob of caseJobs) {
    const job = toJob(caseJob)
    const actual = progress?.actuals.find(candidate => candidate.job === caseJob.id)
    const cut = progress === undefined ? undefined : utc(progress.asOf)
    const later = (at: string | undefined): string | undefined => cut === undefined ? at : at === undefined || Date.parse(at) < Date.parse(cut) ? cut : at
    if (actual === undefined) {
      const notBefore = later(job.notBefore?.at)
      jobs.push({ ...job, ...(notBefore === undefined ? {} : { notBefore: { at: notBefore, words: job.notBefore?.words ?? 'Not before the replan cut', source: job.notBefore?.source ?? planner } }) })
      continue
    }
    // recorded history: a lock at the actual start, its elapsed time, no crew to plan
    const recorded = (key: string, title: string, finish: string): PlanInputs['jobs'][number] => {
      const { notBefore: _notBefore, ...rest } = job
      return { ...rest, key, title, duration: { value: hoursBetween(actual.start, finish), unit: 'h', calendar: 'elapsed', origin: planner }, needs: [], continuous: true, lock: { start: utc(actual.start), words: 'Recorded' } }
    }
    fixed.add(caseJob.id)
    if (actual.finish !== undefined) { jobs.push(recorded(job.key, job.title, actual.finish)); continue }
    jobs.push(recorded(job.key, `${job.title} (work done so far)`, progress!.asOf))
    jobs.push({ ...job, key: restKey(job.key), title: `${job.title} (remaining work)`, duration: { ...job.duration, value: actual.remainingHours ?? job.duration.value }, notBefore: { at: later(job.notBefore?.at)!, words: 'Not before the replan cut', source: planner } })
    renamed.set(caseJob.id, restKey(caseJob.id))
    links.push({ from: job.key, to: restKey(job.key), type: 'FS', lag: { value: 0, unit: 'h' } })
  }
  for (const link of caseLinks) {
    // recorded history is not re-checked against planned logic; links into a started job bind its remaining work
    if (fixed.has(link.to) && !renamed.has(link.to)) continue
    links.push({
      from: renamed.get(link.from) ?? link.from, to: renamed.get(link.to) ?? link.to, type: link.type, lag: { value: link.lagHours, unit: 'h' },
      ...(link.method === undefined ? {} : { method: { choice: methodChoice, option: link.method } }),
    })
  }
  for (const [index, loss] of (progress?.capacityLoss ?? []).entries()) {
    jobs.push({
      key: `breakin-${index}`, title: `Crew taken: ${loss.reason}`, kind: 'work', equipment: [], isolation: 'none',
      duration: { value: hoursBetween(loss.from, loss.to), unit: 'h', calendar: 'working', origin: planner }, durationWith: [],
      needs: [{ anyOf: [loss.resource], amount: 1, handover: false }], continuous: true, lock: { start: utc(loss.from), words: loss.reason }, checks: [], tags: [],
    })
  }

  const groups = cj.functionGroups as any[]
  const inputs = {
    settings: {
      title: 'Train A work week', timeZone: 'Europe/Oslo',
      window: { start: utc(cj.window.start), end: utc(cj.window.end) },
      dataDate: utc(cj.story.now), grid: '30min', currency: 'NOK', run: null,
    },
    equipment,
    groups: groups.map(group => ({ key: group.id, label: group.label })),
    calendars: [
      { key: 'day', label: 'Day shift', weekly: [{ days: [...weekdays], from: '07:00', to: '15:00' }], periods: [], except: [], source: planner },
      { key: 'overtime', label: 'Overtime to 19:00', weekly: [{ days: [...weekdays], from: '15:00', to: '19:00' }], periods: [], except: [], source: planner },
      { key: 'always', label: '24/7 shift operation', weekly: [{ days: [...allDays], from: '00:00', to: '00:00' }], periods: [], except: [], source: planner },
      { key: 'none', label: 'Booked nights only', weekly: [], periods: [], except: [], source: planner },
      { key: 'crane', label: 'Crane hours', weekly: [], periods: (cj.calendars.crane.intervals as string[][]).map(interval), except: [], source: planner },
      { key: 'ect', label: 'Eddy-current team booked', weekly: [], periods: (cj.calendars.ect.intervals as string[][]).map(interval), except: [], source: planner },
    ],
    resources: (cj.resources as any[]).map(resource => ({
      key: resource.id, label: resource.label, kind: resource.kind === 'equipment' ? 'tool' : 'crew', count: resource.count,
      ...(resource.crewSize === undefined ? {} : { crewSize: resource.crewSize }),
      calendar: { 'mech-station': 'day', 'elec-station': 'day', 'mech-contractor': 'none', 'work-control': 'always', 'test-team': 'always', crane: 'crane', 'ect-team': 'ect' }[resource.id as string] ?? 'none',
      attributes: [], source: planner,
    })),
    purchases: [
      { key: 'ot-mech', label: 'Mechanical overtime', resource: 'mech-station', adds: { calendar: 'overtime' }, replaces: [], price: { perPersonHour: cj.costs.stationOvertime.nokPerPersonHour }, allowed: true },
      { key: 'ot-elec', label: 'Electrical overtime', resource: 'elec-station', adds: { calendar: 'overtime' }, replaces: [], price: { perPersonHour: cj.costs.stationOvertime.nokPerPersonHour }, allowed: true },
      { key: 'contractor-nights', label: 'Contractor nights', resource: 'mech-contractor', adds: { periods: nights }, replaces: [], price: { perPeriodUsed: nightPrice, once: cj.costs.contractorNight.mobilisationNok * factor }, orderBy: utc(contractor.orderBy), allowed: true },
      { key: 'crane-fri', label: 'Crane Friday', resource: 'crane', adds: { periods: [interval(cj.calendars.crane.optionalExtension)] }, replaces: [], price: { perPeriodUsed: cj.costs.craneExtensionDayNok }, allowed: true },
      { key: 'ect-friday', label: 'Eddy-current rebooked to Friday', resource: 'ect-team', adds: { periods: [interval(cj.calendars.ect.rebookOption.interval)] }, replaces: (cj.calendars.ect.intervals as string[][]).map(interval), price: { once: cj.costs.ectRebookNok }, allowed: true },
    ],
    methods: [{ key: methodChoice, label: 'SW A pump assembly', options: (cj.methods.SWA as any[]).map(option => ({ key: option.id, label: option.label, fixedCost: cj.costs.methodParts[option.id] })) }],
    jobs, links,
    rules: [
      { kind: 'protected', key: 'R1', equipment: protectedItems, words: cj.rules[0].words, source: { by: 'reference', note: 'Protected-train practice (NUMARC 93-01 section 11), declared as this plant rule' } },
      ...groups.map(group => ({ kind: 'span-limit', key: `R2-${group.id}`, group: group.id, limit: { value: group.allowedOutageHours, unit: 'h' }, singleEntry: group.singleEntry, words: `${group.label}: back and tested within ${group.allowedOutageHours} h of the first tag-out.`, source: { by: 'reference', note: 'Modelled on NUREG-1431; declared fictional plant rule' } })),
    ],
    goals: [
      { metric: 'span-over', scope: { groups: groups.map(group => group.id) }, threshold: { value: 54, unit: 'h' }, tolerance: { value: 0, unit: 'h' } },
      { metric: 'extra-cost', tolerance: { value: 0, unit: 'NOK' } },
      { metric: 'unavailable-hours', tolerance: { value: 0, unit: 'h' } },
    ],
    world: {
      refreshedAt: utc(cj.story.now),
      // The case's own expectation at full power ("expectedAtFullPower": true), standing in for a World read.
      facts: Object.values(preconditions).map(item => ({ locator: plantLocator(item.equipment), id: runningFact(item.equipment), label: 'Running', quantity: 'state', value: true, basis: 'observed' as const, at: utc(cj.story.now) })),
    },
  }
  const variant: CheckVariant = {
    methods: [{ choice: methodChoice, option: choices.method }],
    purchases: [
      ...(choices.overtime ? ['ot-mech', 'ot-elec'] : []),
      ...(choices.nights.length > 0 ? ['contractor-nights'] : []),
      ...(choices.craneFriday ? ['crane-fri'] : []),
      ...(choices.ectFriday ? ['ect-friday'] : []),
    ],
  }
  return { inputs: planInputsSchema.parse(inputs), variant }
}
