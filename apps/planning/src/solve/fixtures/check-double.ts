// TEST DOUBLE of lane K's independent checker, for solver tests only. It is NOT independent: it rebuilds
// the schedule from the dated rows and measures it with the solver's own decoder, and it reports no
// violations unless a row cannot be placed. Lane K's checker replaces it at integration.
import { compile } from '../compile.ts'
import { finishOf, makeDecoder, prepare } from '../decode.ts'
import type { CheckPlan } from '../status.ts'

export const checkDouble = (options: { readonly violate?: boolean } = {}): CheckPlan => ({ inputs, variant, rows }) => {
  const compiled = compile(inputs, { methods: variant.methods, buy: variant.purchases })
  if (!compiled.ok) return { violations: compiled.problems.map(problem => ({ code: problem.code, about: problem.about })), goals: [] }
  const { problem, index } = compiled
  const prep = prepare(problem)
  const n = problem.activities.length
  const start = new Int32Array(n), mode = new Int32Array(n), finish = new Int32Array(n)
  const violations: Array<{ code: string; about: string[] }> = []
  for (let a = 0; a < n; a++) {
    const job = index.jobs[a]
    if (job === null || job === undefined) continue
    const row = rows.find(entry => entry.job === job)
    if (row === undefined) { violations.push({ code: 'job_not_scheduled', about: [job] }); continue }
    const s = (Date.parse(row.start) - index.origin) / index.slotMs, f = (Date.parse(row.finish) - index.origin) / index.slotMs
    const used = new Set(row.uses.map(use => use.resource))
    const m = problem.activities[a]!.modes.findIndex((candidate, k) => finishOf(prep, a, k, s) === f && candidate.demands.every(d => used.has(index.resources[d.resource]!)))
    if (m < 0) { violations.push({ code: 'row_not_placeable', about: [job] }); continue }
    start[a] = s; mode[a] = m; finish[a] = f
  }
  if (options.violate === true) violations.push({ code: 'test_violation', about: [] })
  const evaluation = makeDecoder(prep).evaluate({ start, finish, mode, penalty: 0, restarts: 0, note: '' })
  return { violations, goals: evaluation.raw }
}
