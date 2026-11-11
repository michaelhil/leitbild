import { describe, expect, test } from 'bun:test'
import { certificateSchema } from '../plan/schema.ts'
import { bounds, propagate } from './bounds.ts'
import { explainRefusal, refusalLines } from './explain.ts'
import { laneKVerify } from './fixtures/lane-k.ts'
import { compile, type SubSolve } from './compile.ts'
import { prepare } from './decode.ts'
import caseJson from './fixtures/train-a-case-v0.2.json'
import { TRAIN_A_CASE_SHA256, trainAInputs } from './fixtures/train-a-case.ts'

// V1 and V2 of the frozen flagship (maint/case-v0.2.json): "days only" (no-extra-crew-hours), rebuild
// and swap. Expected figures are computed by hand below or read from the frozen case, never typed.
// Window Mon 16 Nov 07:00 to Sat 21 Nov 07:00 CET (UTC+01:00, no DST change). Day shift Mon-Fri
// 07:00-15:00; two station mechanical crews; the crane Tue-Thu 07:00-19:00 (Friday is a tool day,
// still allowed in days only); the eddy-current team Wednesday 07:00-19:00 (Friday rebooking allowed).
const frozen = caseJson as unknown as { jobs: Array<{ id: string; hours: number; equipment: string; kind: string; method?: string; demands: Array<{ resource?: string; anyOf?: string[] }> }>; functionGroups: Array<{ id: string; members: string[] }> }
const hoursOf = (ids: readonly string[]) => ids.reduce((sum, id) => sum + frozen.jobs.find(job => job.id === id)!.hours, 0)
const iso = (local: string) => new Date(`${local}+01:00`).toISOString()

const solveBounds = (sub: SubSolve) => {
  const compiled = compile(trainAInputs(), sub)
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.problems))
  return { compiled, result: bounds(compiled.problem, compiled.index) }
}
const daysOnly = (option: string): SubSolve => ({ methods: [{ choice: 'SWA-method', option }], buy: 'no-extra-crew-hours' })

describe('V1 and V2 are proven infeasible with their cause', () => {
  test('the fixture is the frozen case', async () => {
    const bytes = await Bun.file(new URL('./fixtures/train-a-case-v0.2.json', import.meta.url)).arrayBuffer()
    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(TRAIN_A_CASE_SHA256)
  })

  test('days only drops every purchase that adds crew hours and keeps the crane day and the rebooking', () => {
    const { compiled } = solveBounds(daysOnly('swap'))
    expect(compiled.index.allowedPurchases.toSorted()).toEqual(['crane-fri', 'ect-friday'])
    expect(compiled.index.dropped.map(entry => entry.code)).toEqual(compiled.index.dropped.map(() => 'adds_crew_hours'))
  })

  test('V1 (rebuild, days only): the SW A chain needs more work than crew and crane hours hold', () => {
    const { result } = solveBounds(daysOnly('rebuild'))
    // The chain from the crane's arrival: motor out, pump out, rebuild, pump in, motor in, reconnect.
    const chain = ['SWA-MOTOR-OUT', 'SWA-PUMP-OUT', 'SWA-REBUILD', 'SWA-PUMP-IN', 'SWA-MOTOR-IN', 'SWA-MOTOR-CONN']
    // From: the crane arrives Tue 07:00. By: reconnect is a 2 h unbroken day-shift job that must end
    // before SW A's test can end by Sat 07:00, so it ends by Friday's shift end, Fri 15:00.
    // Available: the jobs' crews and the crane are on duty together in the day shifts Tue to Fri, 4 x 8 h.
    expect(result.certificate).toEqual({
      kind: 'chain', jobs: chain, workHours: hoursOf(chain), calendars: ['day', 'crane'], availableHours: 4 * 8,
      from: iso('2026-11-17T07:00:00'), by: iso('2026-11-20T15:00:00'),
    })
    expect(hoursOf(chain)).toBe(37)
    expect(certificateSchema.safeParse(result.certificate).success).toBe(true)
    // Lane K re-verifies it: proven, nothing left unverified.
    expect(laneKVerify(trainAInputs(), { methods: daysOnly('rebuild').methods, purchases: ['crane-fri', 'ect-friday'] }, result.certificate!).proves).toBe(true)
    const refusal = explainRefusal(trainAInputs(), daysOnly('rebuild'), laneKVerify)!
    expect(refusal.proves).toBe(true)
    expect(refusal.lines[0]).toBe('Not possible: 6 jobs must run one after another and need 37 h of work, but from Tue 07:00 to Fri 15:00 their crews and tools are on duty together for only 32 h.')
    expect(refusal.lines.slice(1, 7)).toEqual(chain.map(key => `- ${trainAInputs().jobs.find(job => job.key === key)!.title}: ${hoursOf([key])} h`))
    // "Days only" says what it assumes: the crane's Friday and the ECT rebooking, no overtime or nights.
    expect(refusal.lines.at(-1)).toBe('This answer allows Crane extra day, Fri 20 Nov and Rebook the eddy-current team to Friday, and not Station mechanical overtime to 19:00, Contractor night crew (nights Mon to Thu) and Station electrical crew overtime.')
  })

  test('V2 (swap, days only): refused by time, with the span energy count as a second proof', () => {
    const { compiled, result } = solveBounds(daysOnly('swap'))
    // By time. With no limit, the shortest cooling-chain span starts with SW A tagged Mon 11:00-14:00:
    // the heads open Mon 14:00-15:00 and Tue 07:00-10:00; lancing starts after 2 h of opening (SS 2 h
    // counts the opening's own work: Tue 08:00) and runs 8 day hours to Wed 08:00; the eddy-current test
    // Wed 08:00-16:00; closing the heads Thu 07:00-11:00; then the tests one at a time: SW A 3.5 h to
    // 14:30, CCW A 2.5 h to 17:00, RHR A 2.5 h to 19:30. Mon 11:00 to Thu 19:30 is 80.5 h, against 72 h.
    // Tagging later cannot shorten it: SW A's motor must then be disconnected in Tuesday's shift, and
    // the 5 h and 4 h lifts, unbroken in 8 h day shifts after it, each slip a day.
    expect(result.certificate?.kind).toBe('temporal')
    expect(result.span).toMatchObject({ rule: 'R2', limitHours: 72, leastHours: 80.5, firstOut: iso('2026-11-16T11:00:00'), lastBack: iso('2026-11-19T19:30:00') })
    expect(result.span!.path.map(step => [step.job, step.via])).toEqual([
      ['SWA-TAG', 'span-limit'], ['CCWHXA-OPEN', 'link'], ['CCWHXA-CLEAN', 'link'], ['CCWHXA-ECT', 'link'], ['CCWHXA-CLOSE', 'link'], ['SWA-RTS', 'link'], ['CCWA-RTS', 'link'], ['RHRA-RTS', 'link'],   // the case links the tests in support order itself
    ])
    // Over every later first tag-out the least span is 85.5 h, from Tue 04:00 (SW A's motor waits for
    // Tuesday's shift; the lifts slip; SW A's test ends Fri 12:30, the last test Fri 17:30).
    expect(result.span!.later).toMatchObject({ firstOut: iso('2026-11-17T04:00:00'), hours: 85.5 })
    expect(result.span!.path.find(step => step.job === 'CCWHXA-CLEAN')!.start).toBe(iso('2026-11-17T08:00:00'))
    // By energy, independently. Work that must lie inside the span: every station-mechanical job on a
    // cooling-chain item between a covering tag-out and test, read from the frozen case (10 jobs).
    const group = frozen.functionGroups.find(entry => entry.id === 'COOL-A')!.members
    const inside = frozen.jobs.filter(job => group.includes(job.equipment) && job.kind === 'work' && (job.method === undefined || job.method === 'M2-swap')
      && job.id !== 'SWA-SPARE-PREP' && job.demands.some(demand => demand.resource === 'mech-station' || demand.anyOf?.includes('mech-station'))).map(job => job.id)
    expect(hoursOf(inside)).toBe(48)
    // Plus the spare preparation (4 h, not behind a tag-out) that must end before the pump goes in: it is
    // released Mon 12:00, so at most Mon 12:00-15:00 = 3 h fall before any first tag, and 1 h falls inside.
    const spareInside = hoursOf(['SWA-SPARE-PREP']) - 3
    // Available: any 72 h window starting Mon 21:00 to Tue 04:00 holds the Tue, Wed and Thu day shifts:
    // 2 crews x 3 x 8 h = 48 crew-hours. Hydrolancing could go to the contractor, but days only books no nights.
    //
    // The first-out window, by hand (continuous jobs allowed to pause, a relaxation, so that the count
    // is tested on every slot that time alone does not already rule out):
    //   Earliest Mon 21:00. The ECT runs 8 h inside Wed 07:00-19:00, so it ends no earlier than Wed 15:00;
    //   closing the heads (4 h day shift) ends Thu 11:00; then the tests, one at a time on the test team:
    //   SW A 3.5 h to 14:30, CCW A 2.5 h to 17:00, RHR A 2.5 h and HHSI A 1.5 h to 21:00. All back by
    //   Thu 21:00 within 72 h means the first tag no earlier than Mon 21:00.
    //   Latest Tue 04:00. The ECT must start by Wed 11:00, so hydrolancing (8 h day shift) ends by Wed 11:00
    //   and starts by Tue 11:00; it starts after 2 h of opening (SS 2 h, case change C3), so opening
    //   starts by Tue 09:00; both tag-outs before it (SW A 3 h, CCW A 2 h) share the one work-control
    //   operator, so the first starts by Tue 04:00. (Under case v0.1's FS link this bound was Tue 02:00, the
    //   figure in design §6.4; the frozen v0.2 adds the 2 h SS lag.)
    // The pool counts every crew that could do the work: the contractor may lance the tubes but has no
    // hours without nights, so it is in the pool with 0 h.
    expect(result.span!.alsoProven).toEqual({
      kind: 'energy', resources: ['mech-station', 'mech-contractor'], jobs: expect.any(Array), requiredHours: hoursOf(inside) + spareInside, availableHours: 2 * 3 * 8 + 0,
      from: iso('2026-11-16T21:00:00'), to: iso('2026-11-17T04:30:00'), span: 'R2',
    })
    const jobs = (result.span!.alsoProven as { jobs: string[] }).jobs
    expect(jobs.toSorted()).toEqual([...inside, 'SWA-SPARE-PREP'].toSorted())
    expect(certificateSchema.safeParse(result.certificate).success).toBe(true)
    expect(certificateSchema.safeParse(result.span!.alsoProven).success).toBe(true)
    // Logic and calendars alone, with the span limit as max-lags, also fail (the case's own reason).
    expect(propagate(prepare(compiled.problem)).ok).toBe(false)
    // Lane K re-verifies both proofs, with nothing left unverified.
    const variant = { methods: daysOnly('swap').methods, purchases: ['crane-fri', 'ect-friday'] }
    expect(laneKVerify(trainAInputs(), variant, result.certificate!).proves).toBe(true)
    expect(laneKVerify(trainAInputs(), variant, result.span!.alsoProven!).proves).toBe(true)
    const lines = explainRefusal(trainAInputs(), daysOnly('swap'), laneKVerify)!.lines
    expect(lines[0]).toBe(`Not possible: ${trainAInputs().rules.find(rule => rule.key === 'R2')!.words} The shortest span this plan allows is 80.5 h, against 72 h: first tag-out Mon 11:00, last test passed Thu 19:30.`)
    expect(lines).toContain('A later first tag-out does not help: from Tue 04:00 the span is 85.5 h, because:')
    expect(lines).toContain('Also: in any such span starting between Mon 21:00 and Tue 04:00, 49 h of Station mechanical crew and Contractor mechanical night crew work must fit, and only 48 h exist.')
    expect(lines.every(line => line.length <= 240 && !/earliest start|latest start|slot/i.test(line))).toBe(true)
    // With a verifier that does not confirm the energy count, it is not shown.
    const strict = explainRefusal(trainAInputs(), daysOnly('swap'), (inputs, used, cause) => (cause.kind === 'energy' ? { proves: false } : laneKVerify(inputs, used, cause)))!
    expect(strict.lines.some(line => line.startsWith('Also:'))).toBe(false)
  })

  test('with crew hours allowed, neither method is refused by a bound', () => {
    for (const option of ['rebuild', 'swap']) {
      const { result } = solveBounds({ methods: [{ choice: 'SWA-method', option }], buy: 'allowed' })
      expect(result.certificate).toBeUndefined()
    }
  })
})
