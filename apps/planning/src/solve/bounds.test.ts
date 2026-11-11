import { describe, expect, test } from 'bun:test'
import { certificateSchema } from '../plan/schema.ts'
import { bounds, propagate } from './bounds.ts'
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

  test('V1 (rebuild, days only): the SW A chain needs more work than its day shifts hold', () => {
    const { result } = solveBounds(daysOnly('rebuild'))
    // The chain: disconnect, motor out, pump out, rebuild, pump in, motor in, reconnect, one after another.
    const chain = ['SWA-MOTOR-DISC', 'SWA-MOTOR-OUT', 'SWA-PUMP-OUT', 'SWA-REBUILD', 'SWA-PUMP-IN', 'SWA-MOTOR-IN', 'SWA-MOTOR-CONN']
    // From: SW A tagged at the window start (3 h, Mon 07:00-10:00), so disconnecting starts Mon 10:00.
    // By: reconnect is a 2 h continuous day-shift job that must end before SW A's 3.5 h test ends by
    // Sat 07:00; its latest finish is the end of Friday's shift, Fri 15:00.
    // Available: Mon 10:00-15:00 = 5 h, plus Tue to Fri 4 x 8 h = 32 h, so 37 h. Nights and overtime do not exist.
    expect(result.certificate).toEqual({
      kind: 'chain', jobs: chain, workHours: hoursOf(chain), calendars: ['day', 'crane'], availableHours: 5 + 4 * 8,
      from: iso('2026-11-16T10:00:00'), by: iso('2026-11-20T15:00:00'),
    })
    expect(hoursOf(chain)).toBe(38)
    expect(certificateSchema.safeParse(result.certificate).success).toBe(true)
  })

  test('V2 (swap, days only): in any 72 h cooling-chain span the station mechanical work exceeds two crews', () => {
    const { compiled, result } = solveBounds(daysOnly('swap'))
    // Work that must lie inside the span: every station-mechanical job on a cooling-chain item that sits
    // between a covering tag-out and test, read from the frozen case (10 jobs).
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
    // The first-out window, by hand:
    //   Earliest Mon 21:00. The ECT runs 8 h inside Wed 07:00-19:00, so it ends no earlier than Wed 15:00;
    //   closing the heads (4 h day shift) ends Thu 11:00; then the tests, one at a time on the test team:
    //   SW A 3.5 h to 14:30, CCW A 2.5 h to 17:00, RHR A 2.5 h and HHSI A 1.5 h to 21:00. All back by
    //   Thu 21:00 within 72 h means the first tag no earlier than Mon 21:00.
    //   Latest Tue 04:00. The ECT must start by Wed 11:00, so hydrolancing (8 h day shift) ends by Wed 11:00
    //   and starts by Tue 11:00; it starts 2 h after opening the heads (SS 2 h, case change C3), so opening
    //   starts by Tue 09:00; both tag-outs before it (SW A 3 h, CCW A 2 h) share the one work-control
    //   operator, so the first starts by Tue 04:00. (Under case v0.1's FS link this bound was Tue 02:00, the
    //   figure in design §6.4; the frozen v0.2 adds the 2 h SS lag.)
    expect(result.certificate).toEqual({
      kind: 'energy', resources: ['mech-station'], jobs: expect.any(Array), requiredHours: hoursOf(inside) + spareInside, availableHours: 2 * 3 * 8,
      from: iso('2026-11-16T21:00:00'), to: iso('2026-11-17T04:30:00'), span: 'R2',
    })
    const jobs = (result.certificate as { jobs: string[] }).jobs
    expect(jobs.toSorted()).toEqual([...inside, 'SWA-SPARE-PREP'].toSorted())
    expect(result.spanWindows[0]).toMatchObject({ rule: 'R2', feasibleStarts: 7 * 2 + 1 })   // Mon 21:00 to Tue 04:00 is 7 h: every half hour, both ends
    expect(certificateSchema.safeParse(result.certificate).success).toBe(true)
    // The case's own stated reason also holds, independently: with the lifts uninterrupted, logic and
    // calendars alone cannot keep the span within 72 h (after a tag at Mon 21:00 or later, disconnecting
    // waits for Tuesday's shift and the 5 h and 4 h lifts each slip a day).
    expect(propagate(prepare(compiled.problem)).ok).toBe(false)
  })

  test('with crew hours allowed, neither method is refused by a bound', () => {
    for (const option of ['rebuild', 'swap']) {
      const { result } = solveBounds({ methods: [{ choice: 'SWA-method', option }], buy: 'allowed' })
      expect(result.certificate).toBeUndefined()
    }
  })
})
