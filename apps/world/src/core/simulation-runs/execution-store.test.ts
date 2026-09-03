import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionStore } from './execution-store.ts'
import { runExecutionStateSchema } from './execution.ts'

test('a running fast-forward is restored stopped and paused after process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-execution-store-'))
  const path = join(directory, 'execution.json')
  const store = createExecutionStore(path)
  const startedAt = '2026-09-03T10:00:00.000Z'
  await store.save(runExecutionStateSchema.parse({
    mode: 'fast-forward',
    currentSimulationTime: '2026-09-03T10:10:00.000Z',
    updatedAt: startedAt,
    fastForward: {
      kind: 'timed', status: 'running', startedSimulationTime: startedAt,
      targetSimulationTime: '2026-09-03T11:00:00.000Z', currentSimulationTime: '2026-09-03T10:10:00.000Z',
      onComplete: 'paused', startedAt, updatedAt: startedAt, activeWallMs: 1_000, simulatedMs: 600_000, measuredSpeed: 600,
    },
  }))

  expect(await createExecutionStore(path).load()).toMatchObject({
    mode: 'paused',
    currentSimulationTime: '2026-09-03T10:10:00.000Z',
    fastForward: { status: 'stopped', targetSimulationTime: '2026-09-03T11:00:00.000Z' },
  })
})
