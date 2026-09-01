import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  readProcessDisplayLayout,
  readProcessDisplayWindowBounds,
  storeProcessDisplayLayout,
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

describe('process display layout storage', () => {
  test('stores widget positions per Simulation Run, Plant, and display', () => {
    const storage = createMemoryStorage()
    const simulationRunId = 'run-layout-test' as SimulationRunId
    storeProcessDisplayLayout({
      simulationRunId,
      plantId: 'unit-a',
      displayId: 'unit-overview',
      layout: {
        'reactor-vessel': { x: 120, y: 240 },
      },
    }, storage)

    expect(readProcessDisplayLayout({
      simulationRunId,
      plantId: 'unit-a',
      displayId: 'unit-overview',
    }, storage)).toEqual({
      'reactor-vessel': { x: 120, y: 240 },
    })
    expect(readProcessDisplayLayout({
      simulationRunId,
      plantId: 'unit-b',
      displayId: 'unit-overview',
    }, storage)).toEqual({})
  })

  test('rejects corrupted layout data visibly', () => {
    const storage = createMemoryStorage()
    storage.setItem('leitbild.processDisplayLayout.v1:run-layout-test:unit-a:unit-overview', '{"reactor-vessel":{"x":"bad","y":1}}')

    expect(() => readProcessDisplayLayout({
      simulationRunId: 'run-layout-test' as SimulationRunId,
      plantId: 'unit-a',
      displayId: 'unit-overview',
    }, storage)).toThrow('invalid coordinates')
  })

  test('stores window bounds per Simulation Run, Plant, and display', () => {
    const storage = createMemoryStorage()
    const simulationRunId = 'run-window-test' as SimulationRunId
    storeProcessDisplayWindowBounds({
      simulationRunId,
      plantId: 'unit-a',
      displayId: 'unit-overview',
      bounds: { x: 40, y: 50, width: 900, height: 640 },
    }, storage)

    expect(readProcessDisplayWindowBounds({
      simulationRunId,
      plantId: 'unit-a',
      displayId: 'unit-overview',
    }, storage)).toEqual({ x: 40, y: 50, width: 900, height: 640 })
    expect(readProcessDisplayWindowBounds({
      simulationRunId,
      plantId: 'unit-b',
      displayId: 'unit-overview',
    }, storage)).toBeNull()
  })

  test('rejects corrupted window bounds visibly', () => {
    const storage = createMemoryStorage()
    storage.setItem('leitbild.processDisplayWindow.v1:run-window-test:unit-a:unit-overview', '{"x":1,"y":2,"width":"wide","height":4}')

    expect(() => readProcessDisplayWindowBounds({
      simulationRunId: 'run-window-test' as SimulationRunId,
      plantId: 'unit-a',
      displayId: 'unit-overview',
    }, storage)).toThrow('invalid coordinates')
  })
})
