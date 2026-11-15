// A what-if sent without methods is solved once per method combination (adversary server review, blockers
// 1 and 2). Its option is a proof only when every combination is one, whatever the method order, and every
// proof is re-derived by lane K on the purchases the sub-solve may use, not only those its rows use.
import { describe, expect, test } from 'bun:test'
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import { generate, subSolve, type GenerateDeps, type SubSolver } from './generate.ts'
import { ladderRungs } from './ladder.ts'
import { permittedPurchases } from './keys.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

const by = { kind: 'service' as const, name: 'test' }
const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
const flagship = trainAInputs({ read: true })
/** The flagship with its method options listed the other way round. */
const reversed: PlanInputs = planInputsSchema.parse({ ...flagship, methods: flagship.methods.map(choice => ({ ...choice, options: [...choice.options].reverse() })) })
const run = { grid: '30min' as const, engine: 'test', formulation: 'test', seed: 1, budget: { evals: 0, cpuMs: 0, wallMs: 0 }, evals: 0, cpuMs: 0 }
const refused = { word: 'proven infeasible' as const, cause: { kind: 'temporal' as const, steps: [] }, run: { ...run, stoppedBy: 'done' as const } }
const open = { word: 'unresolved' as const, run: { ...run, stoppedBy: 'wall' as const } }
/** A sub-solver that answers each method option with the status given for it, and no rows. */
const answering = (statuses: Readonly<Record<string, typeof refused | typeof open>>): SubSolver => async task => ({
  option: { key: task.variant.key, label: task.variant.label, inputsRevision: task.revision, variant: { methods: [...task.combo], purchases: [] }, status: statuses[task.combo[0]!.option]!, rows: [], metrics: [] },
  rounded: [], dropped: [],
})
const whatIf = (inputs: PlanInputs, subSolver: SubSolver) => generate({ ...deps, subSolver }, { inputs, revision: 1, previous: null, input: { variants: [{ label: 'At most 40 h out' }] }, by, signal: new AbortController().signal })

describe('F1: a what-if without methods is refused only when every method is', () => {
  test('one method proven infeasible, the other unresolved: unresolved, in either method order', async () => {
    for (const inputs of [flagship, reversed]) {
      const option = (await whatIf(inputs, answering({ rebuild: refused, swap: open }))).optionSet.options[0]!
      expect(option.status.word).toBe('unresolved')
    }
  })

  test('stopped after rebuild is refused and before swap runs: never "proven infeasible" (recheck R1)', async () => {
    const stop = new AbortController()
    const stopping: SubSolver = async (task, signal, who) => {
      const outcome = await answering({ rebuild: refused, swap: open })(task, signal, who)
      if (task.combo[0]!.option === 'rebuild') stop.abort()
      return outcome
    }
    const ran: string[] = []
    const recording: SubSolver = async (task, signal, who) => { ran.push(task.combo[0]!.option); return stopping(task, signal, who) }
    const result = await generate({ ...deps, subSolver: recording }, { inputs: flagship, revision: 1, previous: null, input: { variants: [{ label: 'At most 40 h out' }] }, by, signal: stop.signal, stoppedByWho: () => 'person' })
    expect(ran).toEqual(['rebuild'])
    const option = result.optionSet.options[0]!
    expect(option.status.word).toBe('cancelled')
    expect(option.status.word === 'cancelled' && option.status.run.stoppedByWho).toBe('person')
  })

  test('both methods proven infeasible: proven infeasible, the same option in either order', async () => {
    const [first, second] = await Promise.all([flagship, reversed].map(async inputs => (await whatIf(inputs, answering({ rebuild: refused, swap: refused }))).optionSet.options[0]!))
    expect(first!.status.word).toBe('proven infeasible')
    expect(second!.variant.methods).toEqual(first!.variant.methods)
  })
})

describe('F2: every proof is re-derived on the purchases the sub-solve may use', () => {
  test('the top rung\'s bounds go to lane K with every purchase that rung allows, not only those its rows use', async () => {
    const asked: string[][] = []
    const recording: GenerateDeps = { ...deps, verifyBound: (inputs, variant, goal, bound) => { asked.push([...variant.purchases].sort()); return laneKVerifyBound(inputs, variant, goal, bound) } }
    const top = ladderRungs(flagship).at(-1)!
    const result = await generate({ ...recording, subSolver: subSolve(recording) }, { inputs: flagship, revision: 1, previous: null, input: { variants: [{ label: 'Swap', methods: [{ choice: 'SWA-method', option: 'swap' }], buy: [...top.buy] }] }, by, signal: new AbortController().signal, seed: 1, evals: 6_000 })
    expect(result.optionSet.options[0]!.status.word).toBe('validated feasible')
    expect(asked.length).toBeGreaterThan(0)
    for (const purchases of asked) expect(purchases).toEqual(permittedPurchases(flagship, [...top.buy]).sort())
  }, 60_000)
})
