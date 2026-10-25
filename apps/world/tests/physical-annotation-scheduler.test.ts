import { expect, test } from 'bun:test'
import { createPhysicalAnnotationScheduler, type PhysicalAnnotationProgress, type PhysicalWorkDeadline } from '../src/ui/physical-layout/annotation-scheduler.ts'

const fixture = () => {
  const work: Array<{ cancelled: boolean; callback: (deadline: PhysicalWorkDeadline) => void }> = [], states: PhysicalAnnotationProgress<number>[] = [], tested: number[] = []
  let clock = 0
  const scheduler = createPhysicalAnnotationScheduler<number>({ now: () => clock, test: value => { clock += 1; tested.push(value); return value % 2 === 0 }, onChange: state => states.push(state), schedule: callback => { const job = { cancelled: false, callback }; work.push(job); return () => { job.cancelled = true } } })
  const step = () => { const job = work.shift(); if (job && !job.cancelled) job.callback({ timeRemaining: () => 0 }) }
  const drain = () => { while (work.length) step() }
  return { scheduler, states, tested, step, drain }
}
const candidates = (count: number) => Array.from({ length: count }, (_, value) => ({ key: String(value), priority: 0, value }))
test('deadline scheduling makes resumable progress through arbitrary demand without a candidate cap', () => {
  const f = fixture(); f.scheduler.update('pose-a', candidates(137)); f.drain()
  expect(f.tested).toHaveLength(137); expect(f.tested.at(-1)).toBe(136)
  expect(f.states.at(-1)?.pending).toBe(0); expect(f.states.at(-1)?.visible).toHaveLength(69)
  f.scheduler.update('pose-a', candidates(137)); f.drain(); expect(f.tested).toHaveLength(137)
})
test('a new urgent candidate preempts without restarting older completed work or starving settled work', () => {
  const f = fixture(); f.scheduler.update('pose-a', candidates(20)); for (let index = 0; index < 12; index++) f.step()
  f.scheduler.update('pose-a', [...candidates(20), { key: 'urgent', priority: 4, value: 200 }]); f.step()
  expect(f.tested.at(-1)).toBe(200); f.drain(); expect(f.tested).toHaveLength(21); expect(new Set(f.tested).size).toBe(21)
})
test('generation, suspension and disposal cancel stale work while preserving same-generation progress', () => {
  const f = fixture(); f.scheduler.update('pose-a', candidates(10)); f.step(); f.scheduler.setActive(false); f.drain(); expect(f.tested).toEqual([0])
  f.scheduler.setActive(true); f.scheduler.update('pose-b', [{ key: 'new', priority: 0, value: 42 }]); f.drain()
  expect(f.tested).toEqual([0, 42]); expect(f.states.at(-1)?.generation).toBe('pose-b')
  f.scheduler.update('pose-c', candidates(30)); f.scheduler.destroy(); f.drain(); expect(f.tested).toEqual([0, 42])
})
