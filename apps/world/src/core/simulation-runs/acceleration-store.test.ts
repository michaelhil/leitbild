import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccelerationStore } from './acceleration-store.ts'
import { accelerationJobStateSchema } from './acceleration.ts'

test('a running acceleration is restored paused after process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-acceleration-store-'))
  const path = join(directory, 'acceleration.json')
  const store = createAccelerationStore(path)
  const startedAt = '2026-09-03T10:00:00.000Z'
  await store.save(accelerationJobStateSchema.parse({
    status: 'running',
    startedSimulationTime: startedAt,
    targetSimulationTime: '2026-09-03T11:00:00.000Z',
    currentSimulationTime: '2026-09-03T10:10:00.000Z',
    startedAt,
    updatedAt: startedAt,
    activeWallMs: 1_000,
    simulatedMs: 600_000,
    measuredSpeed: 600,
  }))

  expect(await createAccelerationStore(path).load()).toMatchObject({
    status: 'paused',
    currentSimulationTime: '2026-09-03T10:10:00.000Z',
    targetSimulationTime: '2026-09-03T11:00:00.000Z',
  })
})
