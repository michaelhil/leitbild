// Test support: the frozen flagship case (maint/case-v0.2.json, sha256 a552c921…) as plan inputs.
// Settings, equipment, calendars, crews, purchases, methods, rules and goals come from lane A's Train A
// fragment; every job and link the fragment lacks is converted mechanically from the frozen case.
// No value is typed here: hours, demands, links and prices are read from the two files.
import { planInputsSchema, type PlanInputs } from '../../plan/schema.ts'
import fragmentJson from '../../plan/fixtures/train-a.fragment.json'
import caseJson from './train-a-case-v0.2.json'

export const TRAIN_A_CASE_SHA256 = 'a552c921c58fe982c3d413fe7ccd8ae505b9f312949f804f541706e6460ed9b1'

interface CaseJob {
  id: string; title: string; equipment: string; kind: 'isolate' | 'work' | 'restore-test'; hours: number; range?: number[]
  demands: Array<{ resource?: string; anyOf?: string[]; amount: number }>; interruptible: boolean; crewHandover?: boolean
  method?: string; release?: string; makesUnavailable?: boolean; passMakesAvailable?: string[]
}
interface CaseLink { from: string; to: string; type: 'FS' | 'SS' | 'FF'; lagHours: number; method?: string }

const frozen = caseJson as unknown as {
  jobs: CaseJob[]; links: CaseLink[]; resources: Array<{ id: string; label: string; count: number; crewSize?: number; words?: string }>
  functionGroups: Array<{ id: string; members: string[]; allowedOutageHours: number; singleEntry: boolean; words: string; basis: string }>
  costs: { stationOvertime: { nokPerPersonHour: number } }
}
const fragment = planInputsSchema.parse(fragmentJson)

const methodOf = (id: string | undefined) => {
  if (id === undefined) return undefined
  const choice = fragment.methods[0]!
  // The case names options M1-rebuild and M2-swap; the fragment keys them rebuild and swap.
  const option = choice.options.find(candidate => id.toLowerCase().endsWith(candidate.key))
  if (option === undefined) throw new Error(`No fragment method option for ${id}`)
  return { choice: choice.key, option: option.key }
}

/** The tag-out of CCW A also isolates HX A (its title says so); every other job names one item. */
const tagEquipment = (job: CaseJob): string[] =>
  job.id === 'CCWA-TAG' ? [job.equipment, ...frozen.jobs.filter(other => other.passMakesAvailable?.includes(job.equipment) && other.passMakesAvailable.length > 1).flatMap(other => other.passMakesAvailable!.filter(item => item !== job.equipment))] : [job.equipment]

const convertJob = (job: CaseJob): PlanInputs['jobs'][number] => ({
  key: job.id, title: job.title,
  kind: job.kind === 'isolate' ? 'tag-out' : job.kind === 'work' ? 'work' : 'test',
  equipment: job.kind === 'isolate' ? tagEquipment(job) : job.kind === 'restore-test' ? job.passMakesAvailable ?? [job.equipment] : [job.equipment],
  isolation: job.kind === 'work' && job.makesUnavailable !== false ? 'inside' : 'none',
  duration: { value: job.hours, unit: 'h', calendar: 'working', ...(job.range === undefined ? {} : { range: { low: job.range[0]!, high: job.range[2]! } }), origin: { by: 'planner' } },
  durationWith: [],
  needs: job.demands.map(demand => ({ anyOf: demand.anyOf ?? [demand.resource!], amount: demand.amount, handover: job.crewHandover === true })),
  continuous: !job.interruptible,
  ...(methodOf(job.method) === undefined ? {} : { method: methodOf(job.method)! }),
  checks: [], tags: [],
})

/** The full flagship: 34 jobs, 41 planner links, every 72 h group rule. */
export const trainAInputs = (): PlanInputs => {
  const byKey = new Map(fragment.jobs.map(job => [job.key, job]))
  const jobs = frozen.jobs.map(job => byKey.get(job.id) ?? convertJob(job))
  const links: PlanInputs['links'] = frozen.links.map(link => ({
    from: link.from, to: link.to, type: link.type, lag: { value: link.lagHours, unit: 'h' },
    ...(methodOf(link.method) === undefined ? {} : { method: methodOf(link.method)! }),
  }))
  const resources = [...fragment.resources]
  for (const crew of frozen.resources) {
    if (resources.some(resource => resource.key === crew.id)) continue
    resources.push({ key: crew.id, label: crew.label, kind: 'crew', count: crew.count, ...(crew.crewSize === undefined ? {} : { crewSize: crew.crewSize }), calendar: 'day', attributes: [], source: { by: 'planner' } })
  }
  const purchases = [...fragment.purchases]
  const overtime = fragment.purchases.find(purchase => 'calendar' in purchase.adds && purchase.price.perPersonHour !== undefined)!
  for (const resource of resources) {
    if (resource.kind !== 'crew' || resource.calendar !== 'day' || purchases.some(purchase => purchase.resource === resource.key)) continue
    purchases.push({ ...overtime, key: `ot-${resource.key}`, label: `${resource.label} overtime`, resource: resource.key, price: { perPersonHour: frozen.costs.stationOvertime.nokPerPersonHour } })
  }
  const rules = [...fragment.rules]
  const limit = fragment.rules.find(rule => rule.kind === 'span-limit')!
  for (const group of frozen.functionGroups) {
    if (rules.some(rule => rule.kind === 'span-limit' && rule.group === group.id)) continue
    if (limit.kind !== 'span-limit') throw new Error('unreachable')
    rules.push({ ...limit, key: `R2-${group.id}`, group: group.id, limit: { value: group.allowedOutageHours, unit: 'h' }, singleEntry: group.singleEntry })
  }
  return planInputsSchema.parse({ ...fragment, resources, purchases, jobs, links, rules })
}

/** The flagship with one variant edit applied to every job: the generate input decides purchases. */
export const withSettings = (inputs: PlanInputs, settings: Partial<PlanInputs['settings']>): PlanInputs => planInputsSchema.parse({ ...inputs, settings: { ...inputs.settings, ...settings } })
