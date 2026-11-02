import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId } from '@leitbild/contracts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring, waitForCondition } from './helpers.ts'

test('playing timeline cues and command issues use simulation time, including a failed action', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scenario-clock-domain-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: newWorkspaceId(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver() })
  try {
    const source = { ...testScenarioDefinitions.find(source => source.id === 'test-response')!, id: 'cue-clock-domain', world: { startsAt: '2000-01-01T00:00:00.000Z' as never, environment: {} }, timeline: { cues: [
      { id: 'clock-success', at: { kind: 'after_scenario_start' as const, seconds: 0.02 }, actions: [{ type: 'invoke_capability' as const, capabilityId: 'world.fixture.set-priority', input: { taskId: 'task:alpha', priority: 'normal' } }] },
      { id: 'clock-failure', at: { kind: 'after_scenario_start' as const, seconds: 0.04 }, actions: [{ type: 'invoke_capability' as const, capabilityId: 'world.object.delete', input: { objectId: 'missing:target' } }] },
    ] } }
    await registry.createScenario(source)
    const run = await registry.create({ scenarioId: source.id })
    await waitForCondition('the playing cue and its failure notification finish', () => run.events().some(event => event.type === 'notification.emitted' && event.notification.title === 'Scenario cue failed'), { timeoutMs: 10_000 })
    await run.setClock({ paused: true })
    const started = Date.parse(source.world.startsAt), stopped = Date.parse(run.snapshot().clock!.currentTime)
    // Receipt acceptance/rejection times remain wall-clock facts; they do not schedule the domain action.
    const timed = run.events().filter(event => event.type.startsWith('scenario.cue.') || event.type === 'command.issued' || event.type === 'notification.emitted')
    expect(timed.length).toBeGreaterThanOrEqual(8)
    for (const event of timed) {
      expect(Date.parse(event.at)).toBeGreaterThanOrEqual(started)
      expect(Date.parse(event.at)).toBeLessThanOrEqual(stopped)
      if (event.type === 'command.issued') expect(Date.parse(event.command.issuedAt)).toBeLessThanOrEqual(stopped)
    }
    expect(run.snapshot().scenario?.timeline?.executions?.map(execution => execution.status)).toEqual(['complete', 'failed'])
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
}, 15_000)
