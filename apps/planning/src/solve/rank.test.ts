import { describe, expect, test } from 'bun:test'
import { compareKeys, compareStaged, goalExcess, goalKey, goalKeys, rankOptions, recommend, type Rankable } from './rank.ts'

// Train A's goal order: span over 54 h (step 0), extra cost (step NOK 25,000), unavailable hours (step 0).
const goals = [{ threshold: 54, step: 0 }, { threshold: 0, step: 25_000 }, { threshold: 0, step: 0 }]
const option = (key: string, raw: Array<number | number[]>, feasible = true): Rankable => ({ key, feasible, keys: goalKeys(raw, goals) })

describe('ranking keys (adversary r2 item 6)', () => {
  test('the threshold is subtracted once: a 56 h span is 2 h over the 54 h guideline', () => {
    expect(goalExcess(56, 54)).toBe(2)
    expect(goalExcess(50, 54)).toBe(0)
    expect(goalKeys([56, 0, 0], goals)[0]).toBe(2)
  })

  test('a step of 0 keeps the raw excess; a step buckets it', () => {
    expect(goalKey(2.5, 0)).toBe(2.5)
    // NOK 464,250 / 25,000 = 18.57 -> bucket 18; NOK 474,999 -> 18; NOK 475,000 -> 19
    expect(goalKey(464_250, 25_000)).toBe(18)
    expect(goalKey(474_999, 25_000)).toBe(18)
    expect(goalKey(475_000, 25_000)).toBe(19)
  })

  test('span-over with several groups sums each group excess, once', () => {
    // COOL-A 60 h (6 over), CS-A 50 h (0 over), AFW-A 55 h (1 over): 7 h
    expect(goalExcess([60, 50, 55], 54)).toBe(6 + 0 + 1)
  })

  test('exact ties are broken by the option key', () => {
    const ranked = rankOptions([option('b', [[50], 400_000, 100]), option('a', [[50], 400_000, 100])])
    expect(ranked.map(entry => entry.key)).toEqual(['a', 'b'])
  })

  test('infeasible options rank last, whatever their numbers', () => {
    expect(rankOptions([option('x', [[0], 0, 0], false), option('y', [[60], 900_000, 300])]).map(entry => entry.key)).toEqual(['y', 'x'])
  })

  test('adding any what-if that is not itself recommended never changes the recommendation', () => {
    // A fixed set and many random what-ifs; the recommendation changes only to the new option itself.
    let seed = 7
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }
    const base = [option('swap', [[54], 464_250, 230]), option('rebuild', [[65], 243_200, 320]), option('swap-ot', [[56.5], 398_800, 250])]
    const before = recommend(base)!
    for (let i = 0; i < 500; i++) {
      const whatIf = option(`what-if-${i}`, [[48 + random() * 30], 200_000 + random() * 400_000, 150 + random() * 200], random() > 0.2)
      const after = recommend([...base, whatIf])!
      expect(after.key === before.key || after.key === whatIf.key).toBe(true)
      // and the order among the original options is unchanged
      expect(rankOptions([...base, whatIf]).filter(entry => entry !== whatIf).map(entry => entry.key)).toEqual(rankOptions(base).map(entry => entry.key))
    }
  })

  test('within one search, cost is compared only inside the earlier goals band of the incumbent', () => {
    const band = [{ threshold: 0, step: 0 }, { threshold: 0, step: 1 }, { threshold: 0, step: 0 }]
    const incumbent = [0, 70, 400_000]
    // Both within 1 h of the best finish: the cheaper wins although it finishes later.
    expect(compareStaged([0, 70.5, 390_000], [0, 70, 400_000], incumbent, band)).toBeLessThan(0)
    // Outside the band: finish decides.
    expect(compareStaged([0, 72, 300_000], [0, 70, 400_000], incumbent, band)).toBeGreaterThan(0)
    expect(compareKeys([0, 1], [0, 1])).toBe(0)
  })
})
