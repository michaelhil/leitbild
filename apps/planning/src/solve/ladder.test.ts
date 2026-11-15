// "What overtime buys" (design §4.1, §8 C7 and D5): the rungs come from plan data; each rung is one Generate
// with `keep`, lowest first, and a higher rung solved after a lower one is never worse.
import { describe, expect, test } from 'bun:test'
import { checkPlan } from '../check/check.ts'
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import { formulationOf } from './compile.ts'
import { GENERATE_DEADLINE_MS, generate, rankableOf, subSolve, variantsOf, type GenerateDeps, type SubSolveTask } from './generate.ts'
import { ladderRungs, rungOptionKeys, rungRequest } from './ladder.ts'
import { compareOptions } from './rank.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

const by = { kind: 'service' as const, name: 'test' }
const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
const flagship = trainAInputs({ read: true })
const kindOf = (inputs: PlanInputs, key: string) => inputs.resources.find(resource => resource.key === inputs.purchases.find(purchase => purchase.key === key)!.resource)!.kind
const purchase = (inputs: PlanInputs, key: string) => inputs.purchases.find(entry => entry.key === key)!

describe('the rungs, from plan data', () => {
  test('Train A: rung 0 keeps what adds no crew time, rung 1 adds the per-person-hour crew time, rung 2 the rest', () => {
    const rungs = ladderRungs(flagship)
    // From the fixture: crew time is an allowed crew purchase that replaces nothing; the rest is a tool day or a rebooking.
    const crewTime = flagship.purchases.filter(entry => entry.allowed && kindOf(flagship, entry.key) === 'crew' && entry.replaces.length === 0).map(entry => entry.key)
    const other = flagship.purchases.filter(entry => entry.allowed && !crewTime.includes(entry.key)).map(entry => entry.key)
    const hourly = crewTime.filter(key => purchase(flagship, key).price.perPersonHour !== undefined)
    expect(hourly.length).toBeGreaterThan(0)
    expect(hourly.length).toBeLessThan(crewTime.length)
    expect(rungs.map(rung => rung.rung)).toEqual([0, 1, 2])
    expect(rungs.map(rung => rung.buy.toSorted())).toEqual([other.toSorted(), [...other, ...hourly].toSorted(), [...other, ...crewTime].toSorted()])
    expect(rungs.map(rung => rung.crewTime)).toEqual([[], hourly, crewTime])
  })

  test('the top rung is the default options: the same option keys', () => {
    const top = ladderRungs(flagship).at(-1)!
    expect(rungOptionKeys(flagship, top)).toEqual(variantsOf(flagship, {}).map(variant => variant.key))
    // Lower rungs are other options.
    for (const rung of ladderRungs(flagship).slice(0, -1)) for (const key of rungOptionKeys(flagship, rung)) expect(variantsOf(flagship, {}).map(variant => variant.key)).not.toContain(key)
  })

  test('an ordered purchase is in every rung, rung 0 included, and is not crew time still to buy', () => {
    const night = flagship.purchases.find(entry => entry.price.perPersonHour === undefined && kindOf(flagship, entry.key) === 'crew' && entry.replaces.length === 0)!
    const ordered = planInputsSchema.parse({ ...flagship, purchases: flagship.purchases.map(entry => (entry.key === night.key ? { ...entry, ordered: { at: flagship.settings.dataDate, by: { kind: 'human' } } } : entry)) })
    const rungs = ladderRungs(ordered)
    for (const rung of rungs) expect(rung.buy).toContain(night.key)
    for (const rung of rungs) expect(rung.crewTime).not.toContain(night.key)
    // The only other crew time is per person-hour: one price form, so rungs 0 and 1.
    expect(rungs.map(rung => rung.rung)).toEqual([0, 1])
  })

  test('one price form gives rungs 0 and 1; no crew time to buy gives rung 0 only', () => {
    const hourlyOnly = planInputsSchema.parse({ ...flagship, purchases: flagship.purchases.filter(entry => !(kindOf(flagship, entry.key) === 'crew' && entry.replaces.length === 0) || entry.price.perPersonHour !== undefined) })
    expect(ladderRungs(hourlyOnly).map(rung => rung.rung)).toEqual([0, 1])
    const none = planInputsSchema.parse({ ...flagship, purchases: flagship.purchases.filter(entry => !(kindOf(flagship, entry.key) === 'crew' && entry.replaces.length === 0)) })
    expect(ladderRungs(none).map(rung => rung.rung)).toEqual([0])
  })

  test('U1: a lower rung is "<method>: <what it allows>"; the top rung is the default options, keys and labels', () => {
    const [bottom, middle, top] = ladderRungs(flagship)
    const methodLabels = flagship.methods[0]!.options.map(option => option.label)
    expect(rungRequest(flagship, bottom!).variants.map(variant => variant.label)).toEqual(methodLabels.map(label => `${label}: days only`))
    const request = rungRequest(flagship, middle!)
    expect(request.keep).toBe(true)
    request.variants.forEach((variant, m) => {
      expect(variant.buy).toEqual([...middle!.buy])
      expect(variant.label).toBe(`${methodLabels[m]}: with ${middle!.crewTime.map(key => purchase(flagship, key).label).join(', ')}`)
    })
    // The top rung asks what a plain Generate asks: the same option keys and the methods' own labels.
    const plain = variantsOf(flagship, {})
    expect(variantsOf(flagship, rungRequest(flagship, top!)).map(variant => [variant.key, variant.label])).toEqual(plain.map(variant => [variant.key, variant.label]))
  })
})

describe('one Generate per rung, with keep, lowest first', () => {
  test('a higher rung solved after a lower one never ranks worse, and every rung stays in the set', async () => {
    const rungs = ladderRungs(flagship)
    let previous = null as Awaited<ReturnType<typeof generate>>['optionSet'] | null
    const sets: Array<NonNullable<typeof previous>> = []
    for (const rung of rungs) {
      const at = performance.now()
      // The upper rungs get a search too short to find a plan on their own: what they keep is the rung below's.
      const result = await generate(deps, { inputs: flagship, revision: 1, previous, input: rungRequest(flagship, rung), by, signal: new AbortController().signal, seed: 1, evals: rung.rung === 0 ? 600 : rung.rung === 1 ? 600 : 1 })
      expect(performance.now() - at).toBeLessThan(GENERATE_DEADLINE_MS)
      previous = result.optionSet
      sets.push(result.optionSet)
    }
    const last = sets.at(-1)!
    // Every rung's options are still there: 3 rungs of 2 method options.
    const keys = rungs.flatMap(rung => rungOptionKeys(flagship, rung))
    expect(last.options.map(option => option.key).toSorted()).toEqual(keys.toSorted())
    for (const [r, rung] of rungs.entries()) {
      if (r === 0) continue
      const lower = rungOptionKeys(flagship, rungs[r - 1]!), upper = rungOptionKeys(flagship, rung)
      upper.forEach((key, m) => {
        const high = last.options.find(option => option.key === key)!, low = last.options.find(option => option.key === lower[m])!
        if (low.status.word !== 'validated feasible') return
        expect(high.status.word).toBe('validated feasible')
        expect(compareOptions(rankableOf(high, flagship), { ...rankableOf(low, flagship), key: high.key })).toBeLessThanOrEqual(0)
      })
    }
    // With one evaluation the top rung's search finds nothing better: where rung 1 has a plan, the top rung
    // keeps its schedule, re-checked by lane K on the top rung's purchases.
    const middle = rungOptionKeys(flagship, rungs[1]!), top = rungOptionKeys(flagship, rungs[2]!)
    const startedFrom = top.flatMap((key, m) => {
      const kept = last.options.find(option => option.key === key)!, below = last.options.find(option => option.key === middle[m])!
      if (below.status.word !== 'validated feasible') return []
      expect(kept.rows).toEqual(below.rows)
      expect(laneKCheck({ inputs: flagship, variant: kept.variant, rows: kept.rows }).violations).toEqual([])
      return [key]
    })
    expect(startedFrom.length).toBeGreaterThan(0)
    // Each feasible rung option carries lane K's own figure of the crew time it buys, per purchase its rows use.
    for (const option of last.options.filter(entry => entry.status.word === 'validated feasible')) {
      const used = [...new Set(option.rows.flatMap(row => row.uses.flatMap(use => (use.purchase === undefined ? [] : [use.purchase]))))]
      const own = checkPlan(flagship, option.variant, option.rows).metrics.filter(metric => metric.id.startsWith('bought:'))
      expect(own.map(metric => metric.id).toSorted()).toEqual(used.map(key => `bought:${key}`).toSorted())
      expect(option.metrics.filter(metric => metric.id.startsWith('bought:'))).toEqual(own)
    }
    // Days only is proven impossible for both methods: the next rung "makes it possible".
    expect(sets[0]!.options.map(option => option.status.word)).toEqual(['proven infeasible', 'proven infeasible'])
  }, 120_000)

  test('keep on another revision keeps nothing and starts from nothing stored', async () => {
    const tasks: SubSolveTask[] = []
    const own = subSolve(deps)
    const recording: GenerateDeps = { ...deps, subSolver: (task, signal, who) => { tasks.push(task); return own(task, signal, who) } }
    const rung = ladderRungs(flagship)[1]!
    const first = await generate(recording, { inputs: flagship, revision: 1, previous: null, input: rungRequest(flagship, rung), by, signal: new AbortController().signal, seed: 1, evals: 300 })
    expect(first.optionSet.options.some(option => option.status.word === 'validated feasible')).toBe(true)
    tasks.length = 0
    const again = await generate(recording, { inputs: flagship, revision: 2, previous: first.optionSet, input: rungRequest(flagship, ladderRungs(flagship)[2]!), by, signal: new AbortController().signal, seed: 1, evals: 300 })
    expect(tasks.every(task => task.start === undefined)).toBe(true)
    expect(again.kept).toEqual([])
    expect(again.optionSet.options.every(option => option.inputsRevision === 2)).toBe(true)
    // On the same revision, the next rung starts from the stored one that buys no more.
    tasks.length = 0
    await generate(recording, { inputs: flagship, revision: 1, previous: first.optionSet, input: rungRequest(flagship, ladderRungs(flagship)[2]!), by, signal: new AbortController().signal, seed: 1, evals: 300 })
    const started = first.optionSet.options.filter(option => option.status.word === 'validated feasible')
    expect(tasks.filter(task => task.start !== undefined).map(task => task.start!.rows)).toEqual(started.map(option => option.rows))
    expect(formulationOf(flagship.settings.grid)).toBe(started[0]!.status.word === 'validated feasible' ? started[0]!.status.run.formulation : '')
  }, 120_000)
})
