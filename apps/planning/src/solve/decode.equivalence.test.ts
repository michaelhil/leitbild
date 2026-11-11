import { describe, expect, test } from 'bun:test'
import { compile } from './compile.ts'
import { makeDecoder, precedenceOrder, prepare } from './decode.ts'
import { fromBenchInstance, type BenchInstance } from './fixtures/bench-instance.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'
import twinJson from './fixtures/twin-v3.json'

// The decoder's speed-up (finish and next-start tables, skipping past full slots, flagged picks) must not
// change a single plan. 150 random job orders and mode vectors on twin v3 and 150 on the flagship (swap,
// purchases allowed) are decoded, justified and evaluated; the sha256 of every start, mode, penalty and
// raw goal value equals the one the decoder gave before the change (commit 9417196aa, measured 11 Nov).
const BEFORE_SPEED_UP = '26d6269c202d5d800b0bbee4b535e19bb9bc96181b1179446fd0e773309387cd'

describe('decoder speed-up keeps every plan', () => {
  test('300 decodes match the decoder before the change exactly', () => {
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
        out.push({ start: [...decoded.start], mode: [...decoded.mode], penalty: decoded.penalty, raw: evaluation.raw })
      }
    }
    expect(new Bun.CryptoHasher('sha256').update(JSON.stringify(out)).digest('hex')).toBe(BEFORE_SPEED_UP)
  })
})
