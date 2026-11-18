import { describe, expect, test } from 'bun:test'
import { compile } from './compile.ts'
import { finishOf, makeDecoder, precedenceOrder, prepare } from './decode.ts'
import { fromBenchInstance, type BenchInstance } from './fixtures/bench-instance.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'
import twinJson from './fixtures/twin-v3.json'
import beforeFix from './fixtures/decode-before-deadlock-fix.json'

// The decoder's speed-up (finish and next-start tables, skipping past full slots, flagged picks) must not
// change a single plan. 150 random job orders and mode vectors on twin v3 and 150 on the flagship (swap,
// purchases allowed) are decoded, justified and evaluated. Before the keep-in-service dead-end fix, the
// sha256 of all 300 equalled the decoder before the speed-up (commit 9417196aa): BEFORE_SPEED_UP.
// The dead-end fix (a ready opener its rule blocks at every slot now waits for an outage to close) changes
// exactly the decodes that hit it: decode-before-deadlock-fix.json holds each decode's hash before the fix
// and whether it hit the dead end (measured on the decoder at 6ed449b6f; 101 of the 300, all on twin v3).
const BEFORE_SPEED_UP = '26d6269c202d5d800b0bbee4b535e19bb9bc96181b1179446fd0e773309387cd'
void BEFORE_SPEED_UP

describe('decoder speed-up keeps every plan', () => {
  test('300 decodes match the decoder before the changes, except where the dead end was hit', () => {
    const twin = fromBenchInstance(twinJson as unknown as BenchInstance).problem
    const flagship = compile(trainAInputs({ read: true }), { methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'allowed' })
    if (!flagship.ok) throw new Error(JSON.stringify(flagship.problems))
    let seed = 11
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }
    const out: unknown[] = []
    for (const problem of [twin, flagship.problem]) {
      const prep = prepare(problem)
      const decoder = makeDecoder(prep)
      for (let i = 0; i < 150; i++) {
        const keyed = [...prep.topo].map(a => ({ a, k: random() }))
        const list = precedenceOrder(prep, keyed.sort((x, y) => x.k - y.k).map(entry => entry.a))
        const modes = problem.activities.map(activity => Math.floor(random() * activity.modes.length))
        const decoded = decoder.decode(list, modes)
        decoder.justify(decoded)
        const evaluation = decoder.evaluate(decoded)
        const hash = new Bun.CryptoHasher('sha256').update(JSON.stringify({ start: [...decoded.start], mode: [...decoded.mode], penalty: decoded.penalty, raw: evaluation.raw })).digest('hex').slice(0, 16)
        const before = beforeFix[out.length]!
        if (!before.deadEnd) expect(hash).toBe(before.hash)
        else {
          // Never a keep-in-service opener placed without a slot: it waits, or the plan reports a deadlock.
          for (let a = 0; a < prep.n; a++) {
            if (prep.opensCoverage[a]!.length === 0 || decoded.start[a]! >= prep.H) continue
            expect(finishOf(prep, a, decoded.mode[a]!, decoded.start[a]!)).toBeGreaterThanOrEqual(0)
          }
        }
        out.push(hash)
      }
    }
    expect(out.length).toBe(beforeFix.length)
  })

  test("the backward pass's finishBy cap leaves the default unchanged", () => {
    // justify(d, true) on the same 300 random orders and modes, hashed on the decoder before finishBy was
    // added (commit 4e756f917); the default (no cap) must give exactly that.
    const BEFORE_FINISH_BY = '661e6a9c5b0971224fe7a5a84b837cc0f3eb6da4cbb8f8dff78f722b63f1f4cd'
    const twin = fromBenchInstance(twinJson as unknown as BenchInstance).problem
    const flagship = compile(trainAInputs({ read: true }), { methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'allowed' })
    if (!flagship.ok) throw new Error(JSON.stringify(flagship.problems))
    let seed = 11
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }
    const out: unknown[] = []
    for (const problem of [twin, flagship.problem]) {
      const prep = prepare(problem)
      const decoder = makeDecoder(prep)
      for (let i = 0; i < 150; i++) {
        const list = precedenceOrder(prep, [...prep.topo].map(a => ({ a, k: random() })).sort((x, y) => x.k - y.k).map(entry => entry.a))
        const modes = problem.activities.map(activity => Math.floor(random() * activity.modes.length))
        const decoded = decoder.decode(list, modes)
        decoder.justify(decoded, true)
        out.push({ start: [...decoded.start], mode: [...decoded.mode], penalty: decoded.penalty })
      }
    }
    expect(new Bun.CryptoHasher('sha256').update(JSON.stringify(out)).digest('hex')).toBe(BEFORE_FINISH_BY)
  })
})
