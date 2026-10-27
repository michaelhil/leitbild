import { expect, test } from 'bun:test'
import { createMapPickingDemand } from '../src/ui/map-runtime/picking-demand.ts'

test('overlapping navigation leases preserve base policy and release idempotently', () => {
  const changes: boolean[] = [], demand = createMapPickingDemand(true, value => changes.push(value))
  const first = demand.suspend(), second = demand.suspend()
  expect(demand.enabled()).toBe(false); expect(changes).toEqual([false])
  first(); first(); expect(demand.enabled()).toBe(false)
  second(); expect(demand.enabled()).toBe(true); expect(changes).toEqual([false, true])
  const third = demand.suspend(); demand.setBaseEnabled(false); third()
  expect(demand.enabled()).toBe(false); expect(changes).toEqual([false, true, false])
  demand.setBaseEnabled(true); expect(demand.enabled()).toBe(true)
})

test('style/context invalidation cannot let an old release revoke a newer lease', () => {
  const changes: boolean[] = [], demand = createMapPickingDemand(true, value => changes.push(value))
  const stale = demand.suspend(); demand.cancelLeases()
  const current = demand.suspend(); stale(); expect(demand.enabled()).toBe(false)
  current(); expect(demand.enabled()).toBe(true); expect(changes).toEqual([false, true, false, true])
  demand.setBaseEnabled(false); const final = demand.suspend(); demand.dispose(); final()
  expect(demand.enabled()).toBe(false); expect(changes.at(-1)).toBe(false)
  expect(() => demand.suspend()).toThrow('disposed')
})
