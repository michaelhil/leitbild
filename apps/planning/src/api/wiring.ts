// The real solver (lane S, solve/) and checker (lane K, check/) behind the operations' ports. index.ts
// wires these; tests use the doubles in api/fixtures. Nothing here touches World.
import { checkPlan, inputCodes, type CheckRow } from '../check/check.ts'
import { recheckOption } from '../check/recheck.ts'
import { verifyCertificate } from '../check/certificate.ts'
import { verifyBound } from '../check/optimal.ts'
import { checkForSolver } from '../solve/lane-k-ports.ts'
import { bounds } from '../solve/bounds.ts'
import { compile, formulationOf, type CompileIndex } from '../solve/compile.ts'
import { dateSchedule, undate } from '../solve/date.ts'
import { finishOf, nearestFit, prepare, repair, type Prepared } from '../solve/decode.ts'
import { makeExplainer, refusalLines, type ExplainItem } from '../solve/explain.ts'
import { totalFloat, withFloat } from '../solve/float.ts'
import { CERTIFIED_SIZE, generate } from '../solve/generate.ts'
import { SOLVER_BUSY_WORDS, type SolverPool } from '../solve/pool.ts'
import type { Schedule } from '../solve/problem.ts'
import type { CheckPlan } from '../solve/status.ts'
import type { Plan, PlanInputs } from '../plan/schema.ts'
import { clip, nameOf, timeWords } from '../plan/summary.ts'
import { planningError } from '../errors.ts'
import { byteLength } from '../plan/summary.ts'
import { resultLimitBytes } from './contract.ts'
import type { CheckerPort, ExplainResult, SolverPort } from './operations.ts'

type Option = NonNullable<Plan['options']>['options'][number]


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

/**
 * A lock judged against the SAVED plan (walk 2, R2-5): every other job at its saved option row, never where
 * a preview moved it. `findings` are lane K's on the saved rows with only the locked job at its lock time, so
 * their words match the plan on screen; `nearest` is the start nearest the lock where the job fits there
 * (links both ways, calendar, window, crews), confirmed by lane K on the saved rows with only that job moved.
 */
const lockAgainstSaved = (inputs: PlanInputs, option: Option, index: CompileIndex, prep: Prepared, saved: Schedule) => {
  const job = inputs.jobs.find(entry => entry.lock !== undefined && option.rows.some(row => row.job === entry.key && Date.parse(row.start) !== Date.parse(entry.lock!.start)))
  const a = job === undefined ? -1 : index.jobs.indexOf(job.key)
  const fixed = a < 0 ? undefined : prep.problem.activities[a]!.fixed
  if (job === undefined || fixed === undefined) return undefined
  const rowsWith = (t: number, mode: number): readonly CheckRow[] | undefined => {
    if (finishOf(prep, a, mode, t) < 0) return undefined
    const start = Int32Array.from(saved.start), modes = Int32Array.from(saved.mode)
    start[a] = t; modes[a] = mode
    const moved = dateSchedule(prep, index, { start, mode: modes }).find(row => row.job === job.key)!
    return option.rows.map(row => (row.job === job.key ? moved : row))
  }
  // Judged on every violation the moved job brings that the saved plan does not have (adversary recheck 3):
  // a span-limit or keep-in-service finding names only its rule and group, never the job, yet the move
  // causes it. A finding that names the job is always the job's own.
  const free = { ...inputs, jobs: inputs.jobs.map(entry => (entry.key === job.key ? (({ lock: _lock, ...rest }) => rest)(entry) : entry)) }
  const identity = (violation: { readonly code: string; readonly about: readonly string[] }) => `${violation.code}\u0000${violation.about.join('\u0000')}`
  const before = new Set(checkPlan(free, option.variant, option.rows).violations.filter(violation => !violation.about.includes(job.key)).map(identity))
  const brought = (violation: { readonly code: string; readonly about: readonly string[] }) => violation.about.includes(job.key) || !before.has(identity(violation))
  const atLock = rowsWith(fixed.start, fixed.mode)
  const findings = atLock === undefined ? [] : checkPlan(inputs, option.variant, atLock).violations.filter(brought).map(violation => ({ code: violation.code, about: violation.about, words: violation.words }))
  if (findings.length === 0) return { job: job.key, findings }
  // Without the lock: the nearest start where the job brings nothing new against the saved plan.
  const nearest = nearestFit(prep, saved, a, fixed.start, t => { const rows = rowsWith(t, saved.mode[a]!); return rows !== undefined && !checkPlan(free, option.variant, rows).violations.some(brought) })
  return { job: job.key, findings, ...(nearest < 0 ? {} : { nearest: new Date(index.origin + nearest * index.slotMs).toISOString() }) }
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
      const saved = scheduleOf(prep, index, option, true)
      const { decoded } = repair(prep, saved)
      const lost = decoded.finish.findIndex((finish, a) => index.jobs[a] !== null && finish >= prep.H)
      if (lost >= 0) throw planningError(409, 'option_stale', `After this edit ${nameOf(inputs, index.jobs[lost]!)} has no time left in the plan's horizon; generate again`, { about: [index.jobs[lost]!] })
      const schedule = { start: decoded.start, mode: decoded.mode }
      // A preview may show an edit that breaks a limit in every schedule (a test lengthened past the span
      // limit), with no repair penalty: float is measured as for an overrun, which is the same on a schedule
      // that keeps every limit; the check names the break.
      const rows = withFloat(dateSchedule(prep, index, schedule), totalFloat(prep, index, schedule, true), index)
      const check = checkPlan(inputs, option.variant, rows)
      const lock = lockAgainstSaved(inputs, option, index, prep, saved)
      const result = {
        rows,
        violations: check.violations.map(violation => ({ code: violation.code, about: violation.about, words: violation.words })),
        ...(lock === undefined ? {} : { lockFindings: lock.findings, ...(lock.nearest === undefined ? {} : { nearestAllowed: { job: lock.job, at: lock.nearest } }) }),
      }
      return result
    },
  }
}
