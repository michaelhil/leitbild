import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  readProcessDisplayWindowBounds,
  storeProcessDisplayWindowBounds,
} from '../src/ui/process-display/process-display-layout.ts'

const createMemoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    },
  }
}

describe('process display window storage', () => {
  test('stores window bounds per Simulation Run and Plant', () => {
    const storage = createMemoryStorage()
    const simulationRunId = 'run-window-test' as SimulationRunId
    storeProcessDisplayWindowBounds({
      simulationRunId,
      plantId: 'unit-a',
      bounds: { x: 40, y: 50, width: 900, height: 640 },
    }, storage)

    expect(readProcessDisplayWindowBounds({ simulationRunId, plantId: 'unit-a' }, storage)).toEqual({ x: 40, y: 50, width: 900, height: 640 })
    expect(readProcessDisplayWindowBounds({ simulationRunId, plantId: 'unit-b' }, storage)).toBeNull()
  })

  test('rejects corrupted window bounds visibly', () => {
    const storage = createMemoryStorage()
    storage.setItem('leitbild.processDisplayWindow.v1:run-window-test:unit-a', '{"x":1,"y":2,"width":"wide","height":4}')

    expect(() => readProcessDisplayWindowBounds({
      simulationRunId: 'run-window-test' as SimulationRunId,
      plantId: 'unit-a',
    }, storage)).toThrow('invalid coordinates')
  })
})
