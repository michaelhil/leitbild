// Test support for increment 2 ("Choose"), not shipped. A Train A plan with the two options the real solver
// and checker made in increment 1 (plan/fixtures/increment-1-plan.json: Swap and Rebuild, their rows, metrics
// and statuses as stored), on that plan's own inputs (World values read) with the method caveats the bundled
// Definition now has. Their rows re-check feasible under today's checker, so they carry today's formulation,
// and what Generate now stores from the child's checker, counted here by lane K's checker on their own rows:
// the bought crew time ('bought:<purchase>') and the longest outage of each group a span rule names
// ('span:<group>').
// Nothing here is a typed schedule: tests vary only status words, keys and revisions, and compute every
// expected figure from these options or lane K's checker.
import { verifyCertificate } from '../../check/certificate.ts'
import { checkPlan } from '../../check/check.ts'
import { bundledPlanDefinitions } from '../../definitions/index.ts'
import { optionSchema, planInputsSchema, planSchema, type Plan, type PlanInputs, type Status } from '../../plan/schema.ts'
import { formulationOf } from '../../solve/compile.ts'
import { explainRefusal } from '../../solve/explain.ts'
import { methodCombinations } from '../../solve/keys.ts'
import { ladderRungs, rungOptionKeys } from '../../solve/ladder.ts'

export type Option = NonNullable<Plan['options']>['options'][number]
type Feasible = Extract<Status, { word: 'validated feasible' }>

const [, line] = (await Bun.file(new URL('../../plan/fixtures/increment-1-plan.json', import.meta.url)).text()).split('\n')
const stored = JSON.parse(line!) as { inputs: PlanInputs; options: { options: Option[]; at: string; by: Plan['changes'][number]['by'] } }

/** Increment 1's Train A plan inputs, World values read, with the method caveats lane A added for increment 2. */
export const trainAInputs: PlanInputs = planInputsSchema.parse({ ...stored.inputs, methods: bundledPlanDefinitions.find(definition => definition.id === 'train-a-work-week')!.inputs.methods })
const spanRuled = new Set(trainAInputs.rules.flatMap(rule => rule.kind === 'span-limit' ? [`span:${rule.group}`] : []))
/** Today's formulation on the Train A grid. */
export const formulation = formulationOf(trainAInputs.settings.grid)
/** Increment 1's two Train A options: swap (recommended there) and rebuild. */
export const [swap, rebuild] = stored.options.options.map(option => optionSchema.parse({
  ...option, status: { ...option.status, run: { ...(option.status as Feasible).run, formulation } },
  metrics: [...option.metrics, ...checkPlan(trainAInputs, option.variant, option.rows).metrics.filter(metric => metric.id.startsWith('bought:') || spanRuled.has(metric.id))],
})) as [Option, Option]
export const setAt = stored.options.at

/** The option at another key, label and revision, its status as given. */
export const variantOf = (option: Option, change: { readonly key?: string; readonly label?: string; readonly revision?: number; readonly status?: Status; readonly metrics?: Option['metrics'] }): Option => optionSchema.parse({
  ...option, ...(change.key === undefined ? {} : { key: change.key }), ...(change.label === undefined ? {} : { label: change.label }),
  ...(change.revision === undefined ? {} : { inputsRevision: change.revision }), ...(change.status === undefined ? {} : { status: change.status }),
  ...(change.metrics === undefined ? {} : { metrics: change.metrics }),
})

const feasible = (option: Option): Feasible => {
  if (option.status.word !== 'validated feasible') throw new Error(`${option.key} is not validated feasible`)
  return option.status
}

/** Every goal of a feasible status "best found under budget", with the bounds it had. */
export const found = (option: Option): Status => {
  const status = feasible(option)
  return { ...status, goals: status.goals.map(goal => ({ word: 'best found under budget' as const, goal: goal.goal, value: goal.value, unit: goal.unit, ...(goal.bound === undefined ? {} : { bound: goal.bound }) })) }
}

/** Goal `k` proven optimal at its own value (its bound raised to the value, with the bound's certificate); later goals best found. */
export const provenOn = (option: Option, k: number): Status => {
  const status = feasible(option)
  return {
    ...status,
    goals: status.goals.map(goal => goal.goal !== k ? { word: 'best found under budget' as const, goal: goal.goal, value: goal.value, unit: goal.unit }
      : { word: 'proven optimal' as const, goal: goal.goal, value: goal.value, unit: goal.unit, bound: { value: goal.value, source: goal.bound!.source, certificate: goal.bound!.certificate! } }),
  }
}

/** A proven infeasible status: a chain certificate over the plan's first two jobs (its hours are never read here). */
export const refused = (): Status => {
  const window = trainAInputs.settings.window!
  return { word: 'proven infeasible', run: feasible(swap).run, cause: { kind: 'chain', jobs: trainAInputs.jobs.slice(0, 2).map(job => job.key), workHours: 2, calendars: [trainAInputs.calendars[0]!.key], availableHours: 1, from: window.start, by: window.end } }
}

/**
 * The real refusal of `option`'s method with only `buy` allowed (days only refuses both Train A methods): the
 * bounds' certificate, re-verified by lane K, as Generate stores it. Throws when it does not prove.
 */
export const refusedWith = (option: Option, buy: readonly string[]): Option => {
  const refusal = explainRefusal(trainAInputs, { methods: option.variant.methods, buy }, verifyCertificate)
  if (refusal === undefined || !refusal.proves) throw new Error(`${option.key} is not refused with ${buy.join(', ')}`)
  const allowed = trainAInputs.purchases.filter(purchase => buy.includes(purchase.key) || purchase.ordered !== undefined).map(purchase => purchase.key)
  return optionSchema.parse({ ...option, variant: { methods: option.variant.methods, purchases: allowed }, status: { word: 'proven infeasible', cause: refusal.cause, run: feasible(swap).run }, rows: [], metrics: [] })
}

/**
 * `option`'s method's ladder as lane S keys and Generate stores it (rungOptionKeys): rung 0, days only,
 * refused with its real certificate; rungs 1 and 2 that option's own plan, the top rung under the method's
 * default key. Each at `revision`.
 */
export const ladderFor = (option: Option, revision = 3): Option[] => {
  const index = methodCombinations(trainAInputs).findIndex(combo => JSON.stringify(combo) === JSON.stringify(option.variant.methods))
  const rungs = ladderRungs(trainAInputs)
  const keys = rungs.map(rung => rungOptionKeys(trainAInputs, rung)[index]!)
  return [refusedWith(variantOf(option, { key: keys[0]!, revision }), rungs[0]!.buy), ...keys.slice(1).map(key => variantOf(option, { key, revision }))]
}

/** A search that found nothing in its time. */
export const unresolved = (): Status => ({ word: 'unresolved', run: feasible(swap).run })

/** A plan at `revision` holding `options` (all on that revision unless they say otherwise). */
export const planWith = (workspaceId: string, options: readonly Option[], revision = 3, extra: Partial<Plan> = {}): Plan => {
  const at = setAt
  // The first validated feasible option that is not a lead what-if is recommended, as Generate ranks them.
  const recommended = options.find(option => option.status.word === 'validated feasible' && option.variant.lead === undefined)
  return planSchema.parse({
    id: crypto.randomUUID(), workspaceId, revision, createdAt: at, updatedAt: at, inputs: trainAInputs,
    options: { at, by: stored.options.by, options, ...(recommended === undefined ? {} : { recommended: recommended.key }) },
    baselines: [],
    changes: Array.from({ length: revision }, (_, index) => ({ seq: index + 1, at, by: { kind: 'human' }, revision: index + 1, summary: index === 0 ? 'Created from the Train A Definition' : `Change ${index + 1}`, kinds: index === 0 ? [] : ['job'] })),
    droppedChanges: 0,
    ...extra,
  })
}
