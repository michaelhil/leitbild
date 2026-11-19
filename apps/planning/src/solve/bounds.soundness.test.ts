import { describe, expect, test } from 'bun:test'
import { boundsSoundness } from '../../tests/harness/bounds-soundness.ts'
import type { BoundsPort } from '../../tests/harness/ports.ts'
import { bounds } from './bounds.ts'
import { compile } from './compile.ts'
import { laneKVerify } from './fixtures/lane-k.ts'

// Bounds soundness (A5) through lane K's harness: every schedule of 120 small random instances is enumerated
// and judged by lane K's checker. No bound may exceed the exhaustive optimum, no certificate may stand where
// a valid schedule exists, and every certificate on an infeasible instance must re-verify in lane K with
// nothing left unverified (adversary fix 1: support-order steps are named as such).
// The timeout catches a hang, not slowness: the run takes about 60 s of CPU (76 s alone on the Mac, 19 Nov) and
// 125-149 s at nice 5 beside other sessions' work, past the 120 s it had.
describe('bounds soundness on small instances (lane K harness)', () => {
  test('120 seeds: no unsound bound, and every certificate proves in lane K', async () => {
    let certificates = 0
    const notProven: number[] = []
    const port: BoundsPort = {
      bounds: async (inputs, variant) => {
        const compiled = compile(inputs, { methods: [...variant.methods], buy: [...variant.purchases] })
        if (!compiled.ok) return { goals: [] }
        const found = bounds(compiled.problem, compiled.index)
        if (found.certificate !== undefined) {
          certificates++
          if (!laneKVerify(inputs, variant, found.certificate).proves) notProven.push(certificates)
        }
        // The harness compares one number per goal: span-over's per-group bounds give the largest.
        return { ...(found.certificate === undefined ? {} : { certificate: found.certificate }), goals: found.goals.map((goal, index) => ({ goal: index, value: Array.isArray(goal.value) ? Math.max(0, ...goal.value) : goal.value as number })) }
      },
    }
    const result = await boundsSoundness(port, Array.from({ length: 120 }, (_, i) => i + 1))
    expect(result.failures).toEqual([])
    expect(certificates).toBeGreaterThan(0)
    expect(notProven).toEqual([])
  }, 300_000)
})
