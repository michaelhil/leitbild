import { expect, test } from 'bun:test'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorageBudget } from '@leitbild/module-runtime'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

test('Halden recording preview uses Pack-owned series selection and sampling cadence', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'recording-preview-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: 'a0b0402e-d94c-4d70-92d5-258c2cf9d202' as never, ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver() })
  try {
    const definition = testScenarioDefinitions.find(source => source.id === 'halden-power-complex')!
    const preview = await registry.previewScenario(definition)
    const plants = preview.recording.selections.find(selection => selection.packId === 'process-plant')!
    // Four current Plants, each with 955 operations series including the
    // source-transfer, closed RHR, finite DC and SG energy readouts.
    // Fault-injection truth remains excluded by the profile.
    expect(plants.initialSeriesCount).toBe(3820)
    expect(plants.samplesPerSimulationSecond).toBe(3820)
    expect(preview.recording.selections.every(selection => selection.initialSeriesCount !== null)).toBe(true)
    // At full sampling, before exception recording: the derived sample budget over the selections' rate (just over three minutes).
    const rate = preview.recording.selections.reduce((sum, selection) => sum + selection.samplesPerSimulationSecond!, 0)
    expect(preview.recording.sampleWindowSimulationSeconds).toBe(preview.recording.sampleBudget / rate)
    expect(preview.recording.sampleWindowSimulationSeconds).toBeLessThan(240)
    const slower = await registry.previewScenario({ ...definition, packs: definition.packs.map(pack => pack.id === 'process-plant' ? { ...pack, recording: { profileId: 'operations', intervalMs: 5000 } } : pack) })
    expect(slower.recording.sampleWindowSimulationSeconds!).toBeGreaterThan(preview.recording.sampleWindowSimulationSeconds! * 4)
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})

test('Run admission refuses low capacity without creating a partial Run', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'run-admission-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId: 'a0b0402e-d94c-4d70-92d5-258c2cf9d202' as never, ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), storageBudget: createStorageBudget({ root: dataDir, maxBytes: 1024, minFreeBytes: 0 }) })
  try {
    await expect(registry.create({ scenarioId: 'test-response' })).rejects.toThrow('budget reached')
    expect(await registry.listKnown()).toEqual([])
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})
