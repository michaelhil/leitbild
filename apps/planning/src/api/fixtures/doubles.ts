// Test doubles for the parallel lanes, used only by tests (fixtures/ never ships). The real solver (lane S),
// and World facts query (lane W) replace them at integration; lane K's checker runs inside the real solver.
import { createHash } from 'node:crypto'
import {
  planningFactsInputSchema, planningFactsOutputSchema,
  type PlanningSubject, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { planningError } from '../../errors.ts'
import { combineWorldFacts, type Plan, type PlanInputs } from '../../plan/schema.ts'
import { durationMs } from '../../time/units.ts'
import type { CheckViolation, SolverPort, WorldFactsPort } from '../operations.ts'

type Option = NonNullable<Plan['options']>['options'][number]

export const testCertifiedSize = { decided: true, family: 'test plans', maxJobs: 100, evidence: 'test double' }
const formulation = (grid: string) => `double 1; grid ${grid}`

/** A job's duration in ms on the double's elapsed clock, or undefined while a World value is unread. */
const durationOf = (inputs: PlanInputs, job: PlanInputs['jobs'][number]): number | undefined => {
  if (job.duration.origin.by !== 'world') return durationMs(job.duration.value!, job.duration.unit)
  const combined = combineWorldFacts(job.duration.origin.refs, inputs.world.facts, job.duration.unit)
  return combined.ok ? durationMs(combined.value, job.duration.unit) : undefined
}

/**
 * Lane S stand-in: one option per method option (or per given variant). Jobs run one after another from the
 * window start, ignoring every rule: the double exists to exercise Planning's own paths, not to solve.
 */
export const createSolverDouble = (options: { readonly calls?: Array<{ readonly kind: string }> } = {}): SolverPort => ({
  certifiedSize: testCertifiedSize,
  formulation,
  generate: async request => {
    options.calls?.push({ kind: 'generate' })
    const inputs = request.inputs
    const methodChoices = inputs.methods[0]?.options.map(option => [{ choice: inputs.methods[0]!.key, option: option.key }]) ?? [[]]
    const variants = request.variants?.map(variant => variant.methods ?? []) ?? methodChoices
    const unread = inputs.jobs.filter(job => durationOf(inputs, job) === undefined)
    const run = { grid: inputs.settings.grid, engine: 'double', formulation: formulation(inputs.settings.grid), seed: 1, budget: { evals: 1, cpuMs: 1, wallMs: 1 }, stoppedBy: 'done' as const, evals: 1, cpuMs: 1 }
    const built: Option[] = variants.map((methods, index) => {
      const key = `O${index + 1}`
      const label = methods.length === 0 ? 'As planned' : methods.map(method => inputs.methods.find(entry => entry.key === method.choice)?.options.find(option => option.key === method.option)?.label ?? method.option).join(', ')
      if (unread.length > 0 || inputs.settings.window === null) {
        return { key, label, variant: { methods, purchases: [] }, status: { word: 'invalid input' as const, problems: unread.length > 0 ? unread.slice(0, 16).map(job => ({ about: [job.key], code: 'world_value_unread' })) : [{ about: [], code: 'window_missing' }] }, rows: [], metrics: [], inputsRevision: request.inputsRevision }
      }
      let at = Date.parse(inputs.settings.window.start)
      const rows = inputs.jobs.filter(job => job.method === undefined || methods.some(method => method.choice === job.method!.choice && method.option === job.method!.option)).map(job => {
        const start = job.lock === undefined ? at : Date.parse(job.lock.start)
        const finish = start + durationOf(inputs, job)!
        at = finish
        const resource = job.needs[0]?.anyOf[0]
        return {
          job: job.key, start: new Date(start).toISOString(), finish: new Date(finish).toISOString(),
          uses: resource === undefined ? [] : [{ resource, from: new Date(start).toISOString(), to: new Date(finish).toISOString() }],
          float: { workingHours: 0, limitedBy: { kind: 'window-end' as const } },
        }
      })
      const spanHours = rows.length === 0 ? 0 : (Date.parse(rows.at(-1)!.finish) - Date.parse(rows[0]!.start)) / 3_600_000
      return {
        key, label, variant: { methods, purchases: [] },
        status: { word: 'validated feasible' as const, run, goals: inputs.goals.map((goal, goalIndex) => ({ word: 'best found under budget' as const, goal: goalIndex, value: goal.metric === 'extra-cost' ? 0 : spanHours, unit: goal.tolerance.unit })) },
        rows, metrics: [{ id: 'span', value: spanHours, unit: 'h' }, { id: 'extra-cost', value: 0, unit: inputs.settings.currency }],
        inputsRevision: request.inputsRevision,
      }
    })
    const feasible = built.find(option => option.status.word === 'validated feasible')
    return { at: request.at, by: request.by, options: built, ...(feasible === undefined ? {} : { recommended: feasible.key }) }
  },
  explain: async request => {
    options.calls?.push({ kind: 'explain' })
    const row = request.option.rows.find(entry => entry.job === (request.job ?? request.option.rows.at(-1)?.job)) ?? request.option.rows[0]
    if (row === undefined) return { lines: ['No schedule to explain.'], items: [] }
    return {
      lines: [`${row.job} starts when the job before it ends.`],
      items: [{ job: row.job, start: row.start, finish: row.finish, floatHours: row.float.workingHours, because: [{ kind: 'link', about: [{ kind: 'job', key: row.job }] }], joint: false }],
    }
  },
  preview: async request => {
    options.calls?.push({ kind: 'preview' })
    const locked = request.inputs.jobs.filter(job => job.lock !== undefined)
    const window = request.inputs.settings.window
    const violations: CheckViolation[] = window === null ? [] : locked.filter(job => Date.parse(job.lock!.start) < Date.parse(window.start)).map(job => ({ code: 'before-window', about: [job.key] }))
    const rows = request.option.rows.map(row => {
      const lock = locked.find(job => job.key === row.job)?.lock
      if (lock === undefined) return row
      const shift = Date.parse(lock.start) - Date.parse(row.start)
      return { ...row, start: new Date(Date.parse(row.start) + shift).toISOString(), finish: new Date(Date.parse(row.finish) + shift).toISOString() }
    })
    return { rows, violations, ...(violations.length === 0 || window === null ? {} : { nearestAllowed: { job: violations[0]!.about[0]!, at: window.start } }) }
  },
})

// ───────────── World facts, as lane W answers them ─────────────

const pageBytes = 4_096
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const longestCursor = `999.${'f'.repeat(16)}.${'f'.repeat(16)}`

/**
 * Lane W stand-in with W's contract: exact subjects read together, pages of at most 4 KB in which an item
 * larger than a page continues under the same locator, a cursor bound to its query, 404 unknown_subject
 * listing every unknown locator, 400 for a repeated subject. Every call goes to `journal`; World has no
 * other port here, so a journal of reads only is a World that Planning did not write.
 */
export const createWorldDouble = (
  subjects: () => readonly PlanningSubject[],
  journal: Array<{ readonly capabilityId: string; readonly run: string; readonly input: unknown }> = [],
  options: { readonly answerAfterMs?: number } = {},
): WorldFactsPort => ({
  read: async (_access, run: WorkspaceResourceReference, raw, signal) => {
    journal.push({ capabilityId: 'world.simulation-run.planning-facts', run: run.id, input: raw })
    // A slow World: the answer comes after `answerAfterMs`, unless the caller gives up first.
    if (options.answerAfterMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.answerAfterMs)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
    }
    const input = planningFactsInputSchema.parse(raw)
    if (input.subjects === undefined) throw new Error('The double reads exact subjects only')
    const repeated = input.subjects.filter((locator, index) => input.subjects!.indexOf(locator) !== index)
    if (repeated.length > 0) throw planningError(400, 'invalid_request', `Name each subject once: ${repeated.join(', ')}`)
    const known = new Map(subjects().map(subject => [subject.locator, subject]))
    const missing = input.subjects.filter(locator => !known.has(locator))
    if (missing.length > 0) throw planningError(404, 'unknown_subject', `No item in this Run has the locator ${missing.join(', ')}`, { subjects: missing })
    const items = input.subjects.map(locator => known.get(locator)!)
    const frame = { run: { workspaceId: String(run.workspaceId), moduleId: 'world' as const, type: 'world.simulation-run' as const, id: String(run.id) }, observedAt: new Date().toISOString() }
    const query = digest(JSON.stringify([input.subjects, null, null, null]))
    let start = { item: 0, fact: 0 }
    if (input.cursor !== undefined) {
      const parsed = /^(\d{1,3})\.([0-9a-f]{16})\.([0-9a-f]{16})$/.exec(input.cursor)
      if (parsed === null || parsed[3] !== query) throw planningError(400, 'invalid_cursor', 'This cursor belongs to another question; ask again without it')
      start = { item: items.findIndex(item => digest(item.locator) === parsed[2]), fact: Number(parsed[1]) }
    }
    const fits = (candidate: readonly PlanningSubject[]) => bytes({ ...frame, items: candidate, more: longestCursor }) <= pageBytes
    const out: PlanningSubject[] = []
    let next = start
    while (next.item < items.length) {
      const rest = { ...items[next.item]!, facts: items[next.item]!.facts.slice(next.fact) }
      if (fits([...out, rest])) { out.push(rest); next = { item: next.item + 1, fact: 0 }; continue }
      if (out.length > 0) break
      let count = 0
      while (count < rest.facts.length && fits([{ ...rest, facts: rest.facts.slice(0, count + 1) }])) count++
      out.push({ ...rest, facts: rest.facts.slice(0, count) })
      next = { item: next.item, fact: next.fact + count }
      break
    }
    const following = items[next.item]
    return planningFactsOutputSchema.parse({ ...frame, items: out, ...(following === undefined ? {} : { more: `${next.fact}.${digest(following.locator)}.${query}` }) })
  },
})

/** World subjects for a plan's locators, with the facts its references and checks name. Values are given per fact id. */
export const subjectsFor = (inputs: PlanInputs, values: Readonly<Record<string, { readonly value: number | string | boolean; readonly unit?: string; readonly basis?: 'design' | 'configured' | 'observed' | 'owner-estimate' }>>, at: string): PlanningSubject[] => {
  const locators = new Set<string>([
    ...inputs.equipment.flatMap(item => item.locator === undefined ? [] : [item.locator]),
    ...inputs.resources.flatMap(resource => resource.locator === undefined ? [] : [resource.locator]),
    ...inputs.jobs.flatMap(job => job.locator === undefined ? [] : [job.locator]),
  ])
  const refs = [
    ...inputs.jobs.flatMap(job => [...(job.duration.origin.by === 'world' ? job.duration.origin.refs : []), ...job.durationWith.flatMap(entry => 'refs' in entry ? entry.refs : [])]),
    ...inputs.resources.flatMap(resource => resource.attributes.flatMap(attribute => attribute.origin.by === 'world' ? attribute.origin.refs : [])),
    ...inputs.jobs.flatMap(job => job.checks.map(check => ({ locator: inputs.equipment.find(item => item.key === check.equipment)!.locator!, fact: check.fact }))),
  ]
  for (const ref of refs) locators.add(ref.locator)
  return [...locators].sort().map(locator => ({
    locator, label: inputs.equipment.find(item => item.locator === locator)?.label ?? inputs.resources.find(resource => resource.locator === locator)?.label ?? locator.split('/').at(-1)!, kind: locator.split('/')[1] ?? 'item',
    facts: [...new Set(refs.filter(ref => ref.locator === locator).map(ref => ref.fact))].filter(id => values[id] !== undefined).map(id => {
      const given = values[id]!
      return { id, label: id.split('/').slice(1).join(' '), quantity: typeof given.value === 'number' ? (given.unit === 's' ? 'time' : id.split('/').at(-1)!) : 'state', ...(given.unit === undefined ? {} : { unit: given.unit }), value: given.value, basis: given.basis ?? 'observed', at }
    }),
  }))
}
