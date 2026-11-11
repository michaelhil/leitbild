// The real solver (lane S, solve/) and checker (lane K, check/) behind the operations' ports. index.ts
// wires these; tests use the doubles in api/fixtures. Nothing here touches World.
import { checkPlan, inputCodes } from '../check/check.ts'
import { recheckOption } from '../check/recheck.ts'
import { verifyCertificate } from '../check/certificate.ts'
import { bounds } from '../solve/bounds.ts'
import { compile, formulationOf, type CompileIndex } from '../solve/compile.ts'
import { dateSchedule, undate } from '../solve/date.ts'
import { prepare, repair, type Prepared } from '../solve/decode.ts'
import { makeExplainer, refusalLines, type ExplainItem } from '../solve/explain.ts'
import { totalFloat, withFloat } from '../solve/float.ts'
import { CERTIFIED_SIZE, generate } from '../solve/generate.ts'
import type { SolverPool } from '../solve/pool.ts'
import type { Schedule } from '../solve/problem.ts'
import type { CheckPlan } from '../solve/status.ts'
import type { Plan, PlanInputs } from '../plan/schema.ts'
import { nameOf, timeWords } from '../plan/summary.ts'
import { planningError } from '../errors.ts'
import { byteLength } from '../plan/summary.ts'
import { resultLimitBytes } from './contract.ts'
import type { CheckerPort, ExplainResult, SolverPort } from './operations.ts'

type Option = NonNullable<Plan['options']>['options'][number]

/** Lane K's checker in the shape lane S's Generate asks for: violations and the raw goal values. */
export const checkForSolver: CheckPlan = ({ inputs, variant, rows }) => {
  const result = checkPlan(inputs, variant, rows)
  return {
    violations: result.violations.map(violation => ({ code: violation.code, about: violation.about })),
    goals: result.goals.map(goal => goal.metric === 'span-over' ? goal.spans.map(span => span.value) : goal.value),
  }
}

/**
 * Every shown or stored status is re-checked by lane K; proof is decided on the certificate's `proves`, and
 * a "proven optimal" goal on lane K's own bound (check/optimal.ts verifyBound), passed on as bestFoundGoals.
 */
export const realChecker: CheckerPort = {
  recheck: (plan, option, formulation) => {
    const result = recheckOption(plan, option, formulation)
    return {
      usable: result.usable, baselineAllowed: result.baselineAllowed, reasons: result.reasons, bestFoundGoals: result.bestFoundGoals,
      ...(result.shownAs === undefined ? {} : { shownAs: result.shownAs }),
      violations: result.check.violations.map(violation => ({ code: violation.code, about: violation.about, input: inputCodes.has(violation.code) })),
      ...(result.certificate === undefined ? {} : { certificate: { proves: result.certificate.proves, ok: result.certificate.ok, unverified: result.certificate.unverified } }),
    }
  },
}

/** The option's schedule back on the compiled grid (date.ts `undate`); `edited` for a preview. */
const scheduleOf = (prep: Prepared, index: CompileIndex, option: Option, edited = false): Schedule => {
  const found = undate(prep, index, option.rows, edited)
  if (found.ok) return found.schedule
  throw planningError(409, 'option_stale', found.reason === 'no-row' ? `The option has no row for ${found.job}; generate again` : `The option's row for ${found.job} no longer fits the plan; generate again`, { about: [found.job] })
}

const compiled = (inputs: PlanInputs, option: Option) => {
  const result = compile(inputs, { methods: option.variant.methods, buy: option.variant.purchases })
  if (!result.ok) throw planningError(409, 'option_stale', 'The plan no longer compiles for this option; generate again', { about: [option.key] })
  return { ...result, prep: prepare(result.problem) }
}

const causeWords: Readonly<Record<ExplainItem['because'][number]['kind'], string>> = {
  link: 'waits for', crew: 'its crew is busy with', tool: 'its tool is busy with', shift: 'off shift:', availability: 'kept for', 'span-limit': 'outage limit:',
  window: 'the window', release: 'not before its release', lock: 'locked', 'data-date': 'the plan\'s now', 'late-as-possible': 'placed late', 'purchase-not-allowed': 'a purchase not allowed:',
}

/** One line per item, generated from its causes, in the plan's names and local time. */
const lineOf = (inputs: PlanInputs, item: ExplainItem): string => {
  const zone = inputs.settings.timeZone
  const causes = item.because.map(cause => `${causeWords[cause.kind]}${cause.about.length === 0 ? '' : ` ${cause.about.slice(0, 2).map(key => nameOf(inputs, key)).join(', ')}`}${cause.until === undefined ? '' : ` until ${timeWords(cause.until, zone)}`}`)
  const line = `${nameOf(inputs, item.job)} starts ${timeWords(item.start, zone)}: ${causes.join('; ')}${item.joint ? ' (together)' : ''}; float ${item.floatHours} h.`
  return line.length <= 240 ? line : `${line.slice(0, 239)}…`
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
export const createRealSolver = (pool: SolverPool): SolverPort => ({
  certifiedSize: CERTIFIED_SIZE,
  formulation: grid => formulationOf(grid),
  generate: async request => (await generate({ engine: pool, check: checkForSolver, verify: verifyCertificate, certifiedSize: CERTIFIED_SIZE }, {
    inputs: request.inputs, revision: request.inputsRevision, previous: request.stored,
    input: { ...(request.variants === undefined ? {} : { variants: [...request.variants] }), seconds: request.seconds },
    by: request.by, signal: request.signal, ...(request.stoppedByWho === undefined ? {} : { stoppedByWho: request.stoppedByWho }),
  })).optionSet,
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
      return bounded({ lines: refusalLines(option.status.cause, inputs, shown, option.variant.purchases), items: [] })
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
  preview: async ({ inputs, option }) => {
    // Repair from the option's own dated schedule: with no edit it comes back exactly; after an edit only
    // the jobs it forces, and what they push, move.
    const { index, prep } = compiled(inputs, option)
    const { decoded } = repair(prep, scheduleOf(prep, index, option, true))
    const lost = decoded.finish.findIndex((finish, a) => index.jobs[a] !== null && finish >= prep.H)
    if (lost >= 0) throw planningError(409, 'option_stale', `After this edit ${nameOf(inputs, index.jobs[lost]!)} has no time left in the plan's horizon; generate again`, { about: [index.jobs[lost]!] })
    const schedule = { start: decoded.start, mode: decoded.mode }
    const rows = withFloat(dateSchedule(prep, index, schedule), totalFloat(prep, index, schedule, decoded.penalty > 0), index)
    const check = checkPlan(inputs, option.variant, rows)
    const locked = check.violations.map(violation => violation.about[0]).find(key => key !== undefined && inputs.jobs.find(entry => entry.key === key)?.lock !== undefined)
    const at = locked === undefined ? undefined : rows.find(row => row.job === locked)?.start
    return {
      rows,
      violations: check.violations.map(violation => ({ code: violation.code, about: violation.about, words: violation.words })),
      ...(locked === undefined || at === undefined ? {} : { nearestAllowed: { job: locked, at } }),
    }
  },
})
