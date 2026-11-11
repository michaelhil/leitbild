// The real solver (lane S, solve/) and checker (lane K, check/) behind the operations' ports. index.ts
// wires these; tests use the doubles in api/fixtures. Nothing here touches World.
import { verifyCertificate } from '../check/certificate.ts'
import { verifyBound } from '../check/optimal.ts'
import { checkForSolver } from '../solve/lane-k-ports.ts'
import { bounds } from '../solve/bounds.ts'
import { formulationOf } from '../solve/compile.ts'
import { compiled, scheduleOf } from '../solve/preview.ts'
import { makeExplainer, refusalLines, type ExplainItem } from '../solve/explain.ts'
import { totalFloat } from '../solve/float.ts'
import { CERTIFIED_SIZE, generate } from '../solve/generate.ts'
import { SOLVER_BUSY_WORDS, type SolverPool } from '../solve/pool.ts'
import type { Plan, PlanInputs } from '../plan/schema.ts'
import { clip, nameOf, timeWords } from '../plan/summary.ts'
import { planningError } from '../errors.ts'
import { byteLength } from '../plan/summary.ts'
import { resultLimitBytes } from './contract.ts'
import type { ExplainResult, SolverPort } from './operations.ts'

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
          input: { ...(request.variants === undefined ? {} : { variants: [...request.variants] }), seconds: request.seconds },
          by: request.by, signal: request.signal, ...(request.stoppedByWho === undefined ? {} : { stoppedByWho: request.stoppedByWho }),
        })).optionSet
      } finally { generating = false }
    },
    explain: async ({ inputs, option, ask, job }) => {
      const { problem, index, prep } = compiled(inputs, option)
      if (ask === 'refusal') {
        if (option.status.word !== 'proven infeasible') {
          const attempt = option.status.word === 'unresolved' ? option.status.attempt : undefined
          return { lines: [attempt === undefined ? 'No proof either way: the search found no plan in the time allowed. That is not proof that none exists.'
            : `No proof either way: the best attempt finishes ${nameOf(inputs, attempt.job)} ${attempt.pastWindowHours} h past the window. That is not proof that none exists.`], items: [] }
        }
        // The second (energy) proof is worded only when lane K re-verifies it too.
        const span = bounds(problem, index, prep).span
        const shown = span?.alsoProven === undefined || verifyCertificate(inputs, option.variant, span.alsoProven).proves ? span : (({ alsoProven: _also, ...rest }) => rest)(span)
        return bounded({ lines: refusalLines(option.status.cause, inputs, shown, option.variant.purchases, option.variant.methods), items: [] })
      }
      const schedule = scheduleOf(prep, index, option)
      const dataDate = inputs.settings.dataDate === null ? undefined : Math.floor((Date.parse(inputs.settings.dataDate) - index.origin) / index.slotMs)
      const explainer = makeExplainer({ prep, index, schedule, floats: totalFloat(prep, index, schedule), purchases: option.variant.purchases, inputs, ...(dataDate === undefined || dataDate < 0 || dataDate >= index.windowSlots ? {} : { dataDateSlot: dataDate }) })
      const activity = job === undefined ? undefined : index.jobs.indexOf(job)
      if (job !== undefined && (activity === undefined || activity < 0)) throw planningError(400, 'unknown_reference', `${job} is not in this option's schedule`, { about: [job] })
      const items = ask === 'why-start'
        ? [explainer.whyStart(activity ?? index.jobs.findIndex(key => key !== null))]
        : explainer.finishChain(activity)
      return bounded({ lines: items.map(item => lineOf(inputs, item)), items })
    },
    // In a solver child, like Generate: one child at a time across the service, so a preview while a Generate
    // runs is refused 'solver_busy'.
    preview: async ({ inputs, option, signal }) => {
      if (generating) throw planningError(409, 'solver_busy', SOLVER_BUSY_WORDS)
      return pool.preview(inputs, option, signal)
    },
  }
}
