import { expect, test } from 'bun:test'
import { createSimulationClock, simulationClockUpdateSchema, type IsoTimestamp } from '../src/core/model/time.ts'
import { scenarioUsesSimulationTime } from '../src/ui/simulation-clock.ts'
import { processPlantPackView } from '../src/packs/process-plant/ui-pack.ts'
import { situationMonitorPackView } from '../src/packs/situation-monitor/ui-pack.ts'
import { responseScenario } from './fixtures/scenarios.ts'

test('clock-independent monitoring hides physics controls but timed orchestration retains them', () => {
  const monitor = { ...responseScenario, packs: ['situation-monitor'], packRuntimes: { 'situation-monitor': 'situation-monitor-local' }, timeline: { cues: [] } }
  expect(scenarioUsesSimulationTime(monitor, [situationMonitorPackView])).toBe(false)
  expect(scenarioUsesSimulationTime({ ...monitor, timeline: { cues: [{ id: 'later', at: { kind: 'after_scenario_start', seconds: 300 }, actions: [] }] } }, [situationMonitorPackView])).toBe(true)
})

test('a Pack default simulation runtime exposes physics controls without an explicit runtime override', () => {
  const plant = { ...responseScenario, packs: ['process-plant'], packRuntimes: {}, timeline: { cues: [] } }
  expect(scenarioUsesSimulationTime(plant, [processPlantPackView])).toBe(true)
})

test('Run clock separates simulation epoch, monotonic elapsed duration and wall observation time', () => {
  let wall = Date.parse('2026-09-02T12:00:00Z')
  let mono = 1000
  const epoch = '2000-01-01T00:00:00.000Z' as IsoTimestamp
  const clock = createSimulationClock({ currentTime: epoch, updatedAt: new Date(wall).toISOString() as IsoTimestamp, paused: false }, { wallMs: () => wall, monotonicMs: () => mono })
  mono += 2500
  wall -= 100_000 // calendar correction must not reverse simulation physics
  expect(String(clock.read().currentTime)).toBe('2000-01-01T00:00:02.500Z')
  expect(String(clock.read().updatedAt)).toBe(new Date(wall).toISOString())
  clock.set({ ...clock.read(), paused: true })
  mono += 10_000
  wall += 10_000
  expect(String(clock.read().currentTime)).toBe('2000-01-01T00:00:02.500Z')
  clock.set({ ...clock.read(), paused: false })
  mono += 1000
  expect(String(clock.read().currentTime)).toBe('2000-01-01T00:00:03.500Z')
  const saved = clock.read()
  wall += 86_400_000
  const restored = createSimulationClock({ ...saved, updatedAt: new Date(wall).toISOString() as IsoTimestamp }, { wallMs: () => wall, monotonicMs: () => mono })
  expect(restored.read().currentTime).toBe(saved.currentTime)
})

test('clock controls only pause or resume realtime progression', () => {
  expect(simulationClockUpdateSchema.safeParse({ currentTime: '2030-01-01T00:00:00Z' }).success).toBe(false)
  expect(simulationClockUpdateSchema.safeParse({ speed: 0 }).success).toBe(false)
  expect(simulationClockUpdateSchema.safeParse({ speed: 10, paused: false }).success).toBe(false)
  expect(simulationClockUpdateSchema.safeParse({ paused: false }).success).toBe(true)
})
