// The real solver (lane S, solve/) and checker (lane K, check/) behind the operations' ports. index.ts
// wires these; tests use the doubles in api/fixtures. Nothing here touches World.
import { verifyCertificate } from '../check/certificate.ts'
import { verifyBound } from '../check/optimal.ts'
import { checkForSolver } from '../solve/lane-k-ports.ts'
import { formulationOf } from '../solve/compile.ts'
import { compiled, scheduleOf } from '../solve/preview.ts'
import { withExtraRules } from '../solve/keys.ts'
import { makeExplainer, mostLimiting, refusalLines, type ExplainItem } from '../solve/explain.ts'
import { totalFloat } from '../solve/float.ts'
import { CERTIFIED_SIZE, generate } from '../solve/generate.ts'
import { SOLVER_BUSY_WORDS, type SolverPool } from '../solve/pool.ts'
import type { Plan, PlanInputs } from '../plan/schema.ts'
import { clip, methodWords, nameOf, timeWords, valueWords } from '../plan/summary.ts'
import { isPlanningError, planningError } from '../errors.ts'
import { byteLength } from '../plan/summary.ts'
import { resultLimitBytes } from './contract.ts'
import type { ExplainResult, SolverAsk, SolverPort } from './operations.ts'

type Option = NonNullable<Plan['options']>['options'][number]


const causeWords: Readonly<Record<ExplainItem['because'][number]['kind'], string>> = {
  link: 'waits for', crew: 'its crew is busy with', tool: 'its tool is busy with', shift: 'off shift:', availability: 'kept for', 'span-limit': 'outage limit:',
  window: 'the window', release: 'not before its release', lock: 'locked', 'data-date': 'the plan\'s now', 'late-as-possible': 'placed late', 'purchase-not-allowed': 'a purchase not allowed:',
}

/** One line per item, generated from its causes, in the plan's names and local time. */
const lineOf = (inputs: PlanInputs, item: ExplainItem): string => {
  const zone = inputs.settings.timeZone
  const causes = item.because.map(cause => `${causeWords[cause.kind]}${cause.about.length === 0 ? '' : ` ${cause.about.slice(0, 2).map(entry => nameOf(inputs, entry.key)).join(', ')}`}${cause.until === undefined ? '' : ` until ${timeWords(cause.until, zone)}`}`)
  const line = `${nameOf(inputs, item.job)} starts ${timeWords(item.start, zone)}: ${causes.join('; ')}${item.joint ? ' (together)' : ''}; float ${item.floatHours} h.`
  return clip(line, 240)
}

/** Within the 4 KB result: trailing items and lines go first. */
const bounded = (result: ExplainResult): ExplainResult => {
  let next = result
  while (byteLength(next) > resultLimitBytes - 64 && (next.items.length > 0 || next.lines.length > 1)) {
    next = { ...next, items: next.items.slice(0, -1), lines: next.lines.length > next.items.length ? next.lines.slice(0, -1) : next.lines.slice(0, -1) }
  }
  return next
}

/** The explainer on `option`'s own compile and schedule, in this process. */
const explainerOf = (inputs: PlanInputs, option: Option) => {
  const { problem, index, prep } = compiled(inputs, option)
  const schedule = scheduleOf(prep, index, option)
  const dataDate = inputs.settings.dataDate === null ? undefined : Math.floor((Date.parse(inputs.settings.dataDate) - index.origin) / index.slotMs)
  const explainer = makeExplainer({ prep, index, schedule, floats: totalFloat(prep, index, schedule), purchases: option.variant.purchases, inputs, ...(dataDate === undefined || dataDate < 0 || dataDate >= index.windowSlots ? {} : { dataDateSlot: dataDate }) })
  return { explainer, index }
}

/** Each solver ask by name: an ask with no answer here is a programming error, never the finish chain. */
const solverAsks: Readonly<Record<SolverAsk, true>> = { 'why-start': true, finish: true, refusal: true }

/** Lane S's Generate on the Worker pool, its explainer and preview re-timing, checked by lane K. */
export const createRealSolver = (pool: SolverPool): SolverPort => {
  let generating = false
  return {
    certifiedSize: CERTIFIED_SIZE,
    formulation: grid => formulationOf(grid),
    // One Generate at a time across the service, from any plan or Workspace: a second is refused, never queued.
    generate: async request => {
      if (generating) throw planningError(409, 'solver_busy', SOLVER_BUSY_WORDS)
      generating = true
      try {
        return (await generate({ engine: pool, check: checkForSolver, verify: verifyCertificate, verifyBound, subSolver: pool.subSolver, certifiedSize: CERTIFIED_SIZE }, {
          inputs: request.inputs, revision: request.inputsRevision, previous: request.stored,
          input: { ...(request.variants === undefined ? {} : { variants: [...request.variants] }), seconds: request.seconds, ...(request.keep === undefined ? {} : { keep: request.keep }) },
          by: request.by, signal: request.signal, ...(request.stoppedByWho === undefined ? {} : { stoppedByWho: request.stoppedByWho }),
        })).optionSet
      } finally { generating = false }
    },
    explain: async ({ inputs, option, ask, job }) => {
      // Why recommended and versus are the service's (api/operations.ts), from stored options; any other ask is refused.
      if (!Object.hasOwn(solverAsks, ask)) throw planningError(500, 'invalid_planning_request', `The solver has no explain ask ${String(ask)}`)
      if (ask === 'refusal') {
        if (option.status.word !== 'proven infeasible') {
          const attempt = option.status.word === 'unresolved' ? option.status.attempt : undefined
          return { lines: [attempt === undefined ? 'No proof either way: the search found no plan in the time allowed. That is not proof that none exists.'
            : `No proof either way: the best attempt finishes ${nameOf(inputs, attempt.job)} ${attempt.pastWindowHours} h past the window. That is not proof that none exists.`], items: [] }
        }
        // Worded from the status as stored only (re-walk N2, N4): the cause, and the span lane K proved in the
        // solver child, with its path, later start and energy proof. No checker, compile or bounds runs on a
        // read, so an out-of-date refusal keeps its words exactly. A what-if is worded on the inputs with its own
        // rule, so the rule reads in its words, never its key (B3).
        const ruled = withExtraRules(inputs, option.variant.also)
        const span = option.status.span
        const whatIf = option.variant.also !== undefined || option.variant.lead !== undefined || option.status.byMethod !== undefined
        const method = methodWords(inputs, option.variant.methods)
        if (!whatIf || method === undefined) return bounded({ lines: refusalLines(option.status.cause, ruled, span, option.variant.purchases, option.variant.methods), items: [] })
        // A what-if refused for every method: each method's least outage against the hours asked (N2), then its
        // own method's proof, named, and the first line of each other method's proof that has no span (B3).
        const asked = new Set((option.variant.also ?? []).map(rule => rule.key))
        const byMethod = option.status.byMethod ?? []
        const least = byMethod.flatMap(entry => entry.span === undefined ? [] : [clip(`${methodWords(inputs, entry.methods) ?? 'Another method'}: out at least ${valueWords(entry.span.leastHours, 'h')}, against the ${valueWords(entry.span.limitHours, 'h')} ${asked.has(entry.span.rule) ? 'asked' : 'limit'}.`, 240)])
        const [first = '', ...rest] = refusalLines(option.status.cause, ruled, span, option.variant.purchases, option.variant.methods, `this option (${method})`)
        const others = byMethod.filter(entry => entry.span === undefined && JSON.stringify(entry.methods) !== JSON.stringify(option.variant.methods)).map(entry =>
          clip(`For ${methodWords(inputs, entry.methods) ?? 'another method'}: ${refusalLines(entry.cause, ruled, entry.span, entry.purchases, entry.methods)[0] ?? ''}`, 240))
        return bounded({ lines: [...least, clip(`For ${method}: ${first}`, 240), ...others, ...rest].slice(0, 20), items: [] })
      }
      const { explainer, index } = explainerOf(inputs, option)
      const activity = job === undefined ? undefined : index.jobs.indexOf(job)
      if (job !== undefined && (activity === undefined || activity < 0)) throw planningError(400, 'unknown_reference', `${job} is not in this option's schedule`, { about: [job] })
      const items = ask === 'why-start'
        ? [explainer.whyStart(activity ?? index.jobs.findIndex(key => key !== null))]
        : explainer.finishChain(activity)
      // 'finish': what one more unit of the most limiting resource does, checked by lane K in a solver child
      // (a gain in hours, or no gain). Left out when not computed: the chain names no resource, a Generate
      // holds the solver, or the child fails. Absent never means "no gain".
      const candidates = ask === 'finish' ? mostLimiting(items) : []
      const limiting = candidates.length === 0 || generating ? null : await pool.limiting(inputs, option, candidates).catch((error: unknown) => {
        if (isPlanningError(error) && error.code === 'solver_busy') return null
        throw error
      })
      return bounded({ lines: items.map(item => lineOf(inputs, item)), items, ...(limiting === null ? {} : { limiting }) })
    },
    // The first cause on the finish chain of the option's own schedule; no solver child.
    finishCause: async ({ inputs, option }) => explainerOf(inputs, option).explainer.finishChain()[0]?.because[0],
    // In a solver child, like Generate: one child at a time across the service, so a preview while a Generate
    // runs is refused 'solver_busy'.
    preview: async ({ inputs, option, signal }) => {
      if (generating) throw planningError(409, 'solver_busy', SOLVER_BUSY_WORDS)
      return pool.preview(inputs, option, signal)
    },
  }
}
