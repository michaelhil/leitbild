import { expect, test } from 'bun:test'
import { createPhysicalPaintCoalescer } from '../src/ui/physical-layout/paint-coalescer.ts'

const deferred = () => {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}
const harness = <T>() => {
  const flushes: ReturnType<typeof deferred>[] = [], paints: T[] = [], errors: Error[] = []
  const queue = createPhysicalPaintCoalescer<T>({ flush: () => { const flush = deferred(); flushes.push(flush); return flush.promise }, paint: intent => paints.push(intent), reportError: error => errors.push(error) })
  return { queue, flushes, paints, errors }
}
const settle = async (flush: ReturnType<typeof deferred>): Promise<void> => { flush.resolve(); await flush.promise }

test('one settled reactive flush paints only the latest exact immutable intent without a frame scheduler', async () => {
  const h = harness<Readonly<{ source: string; frame: number; flow: readonly string[] }>>()
  const first = Object.freeze({ source: 'same-source', frame: 7, flow: Object.freeze(['old']) }), latest = Object.freeze({ source: 'same-source', frame: 8, flow: Object.freeze(['current']) })
  h.queue.request(first); h.queue.request(latest)
  expect(h.flushes).toHaveLength(1); expect(h.paints).toEqual([])
  await settle(h.flushes[0]!)
  expect(h.paints).toEqual([latest]); expect(h.paints[0]).toBe(latest); expect(h.errors).toEqual([])
})

test('cascading requests during the host flush replace the intent before that flush resolves', async () => {
  const h = harness<number>()
  h.queue.request(1)
  await Promise.resolve(); h.queue.request(2)
  await Promise.resolve(); h.queue.request(3)
  expect(h.flushes).toHaveLength(1)
  await settle(h.flushes[0]!)
  expect(h.paints).toEqual([3])
  h.queue.request(4); expect(h.flushes).toHaveLength(2)
  await settle(h.flushes[1]!)
  expect(h.paints).toEqual([3, 4])
})

test('cancellation immediately permits a new flush and a late obsolete completion cannot clear it', async () => {
  const h = harness<string>()
  h.queue.request('withdrawn'); h.queue.cancel(); h.queue.request('new source')
  expect(h.flushes).toHaveLength(2)
  await settle(h.flushes[0]!)
  expect(h.paints).toEqual([])
  h.queue.request('new source latest view'); expect(h.flushes).toHaveLength(2)
  await settle(h.flushes[1]!)
  expect(h.paints).toEqual(['new source latest view'])
})

test('an obsolete flush rejection cannot report a stale failure or erase a newer paint', async () => {
  const h = harness<string>()
  h.queue.request('old'); h.queue.cancel(); h.queue.request('current')
  h.flushes[0]!.reject(Error('withdrawn source')); await Promise.resolve()
  expect(h.errors).toEqual([])
  await settle(h.flushes[1]!)
  expect(h.paints).toEqual(['current'])
})

test('destroy drops current intent, suppresses late outcomes and permanently ignores new requests', async () => {
  const h = harness<string>()
  h.queue.request('old'); h.queue.destroy(); h.queue.request('must not be scheduled')
  await settle(h.flushes[0]!)
  expect(h.flushes).toHaveLength(1); expect(h.paints).toEqual([]); expect(h.errors).toEqual([])
  h.queue.cancel(); h.queue.request('still destroyed'); expect(h.flushes).toHaveLength(1)
  const rejected = harness<string>(); rejected.queue.request('old'); rejected.queue.destroy(); rejected.flushes[0]!.reject('stale refusal'); await Promise.resolve()
  expect(rejected.errors).toEqual([])
})

test('an active flush failure is explicit once, drops the failed intent and allows a deliberate new request', async () => {
  const h = harness<string>()
  h.queue.request('failed'); h.flushes[0]!.reject('flush failed'); await Promise.resolve()
  expect(h.errors.map(error => error.message)).toEqual(['flush failed']); expect(h.paints).toEqual([])
  h.queue.request('retry'); await settle(h.flushes[1]!)
  expect(h.paints).toEqual(['retry'])
})

test('synchronous host refusal and synchronous paint failure use the same explicit error port', async () => {
  const errors: Error[] = [], paints: string[] = []
  const failed = createPhysicalPaintCoalescer<string>({ flush: () => { throw Error('sync flush') }, paint: value => paints.push(value), reportError: error => errors.push(error) })
  failed.request('not paintable'); expect(errors.map(error => error.message)).toEqual(['sync flush']); expect(paints).toEqual([])
  const ready = deferred(), broken = createPhysicalPaintCoalescer<string>({ flush: () => ready.promise, paint: () => { throw 'native draw refused' }, reportError: error => errors.push(error) })
  broken.request('paint'); await settle(ready)
  expect(errors.map(error => error.message)).toEqual(['sync flush', 'native draw refused'])
})

test('a reentrant paint request owns a separate flush and is never erased by the preceding job', async () => {
  const flushes: ReturnType<typeof deferred>[] = [], paints: number[] = []
  const queue = createPhysicalPaintCoalescer<number>({ flush: () => { const value = deferred(); flushes.push(value); return value.promise }, paint: value => { paints.push(value); if (value === 1) queue.request(2) }, reportError: error => { throw error } })
  queue.request(1); await settle(flushes[0]!)
  expect(paints).toEqual([1]); expect(flushes).toHaveLength(2)
  await settle(flushes[1]!)
  expect(paints).toEqual([1, 2])
})

test('undefined and null are actual generic intents, not cancellation sentinels', async () => {
  const h = harness<undefined | null>()
  h.queue.request(undefined); await settle(h.flushes[0]!)
  h.queue.request(null); await settle(h.flushes[1]!)
  expect(h.paints).toEqual([undefined, null])
})
