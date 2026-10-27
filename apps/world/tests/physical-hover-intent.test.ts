import { expect, test } from 'bun:test'
import { createPhysicalHoverIntent } from '../src/ui/physical-layout/hover-intent.ts'
import type { PhysicalSceneHit } from '../src/ui/map/physical-scene/types.ts'

const hit = (sceneId: string, occurrenceId = 'pump', x = 10): PhysicalSceneHit => ({ sceneId, occurrenceId, targetObjectId: sceneId, subjectIds: ['pump-a'], label: 'Pump A', screen: { x, y: 20 } })
const harness = () => {
  const jobs: Array<{ work: () => void; delay: number; cancelled: boolean }> = [], opened: PhysicalSceneHit[] = []
  const intent = createPhysicalHoverIntent(value => opened.push(value), (work, delay) => { const job = { work, delay, cancelled: false }; jobs.push(job); return () => { job.cancelled = true } })
  return { intent, jobs, opened }
}

test('rest belongs to the same occurrence, retaining its newest pointer anchor without restarting the timer', () => {
  const { intent, jobs, opened } = harness()
  intent.update(hit('unit-a')); intent.update(hit('unit-a', 'pump', 15))
  expect(jobs).toHaveLength(1); expect(jobs[0]!.delay).toBe(2_000)
  jobs[0]!.work()
  expect(opened).toEqual([hit('unit-a', 'pump', 15)])
})

test('owner-qualified target replacement invalidates even an already queued cancelled callback', () => {
  const { intent, jobs, opened } = harness()
  intent.update(hit('unit-a')); intent.update(hit('unit-b'))
  expect(jobs[0]!.cancelled).toBe(true)
  jobs[0]!.work(); expect(opened).toHaveLength(0)
  jobs[1]!.work(); expect(opened.map(value => value.sceneId)).toEqual(['unit-b'])
})

test('leave, operational capture, source changes and unmount can clear pending inspection without a late card', () => {
  const { intent, jobs, opened } = harness()
  intent.update(hit('unit-a')); intent.update(null); jobs[0]!.work()
  intent.update(hit('unit-a')); intent.clear(); jobs[1]!.work()
  expect(opened).toHaveLength(0)
})
