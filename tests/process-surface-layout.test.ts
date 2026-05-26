import { describe, expect, test } from 'bun:test'
import type { ControlInstanceId } from '../src/core/model/index.ts'
import {
  readProcessSurfaceLayout,
  readProcessSurfaceWindowBounds,
  storeProcessSurfaceLayout,
  storeProcessSurfaceWindowBounds,
} from '../src/ui/process-surface/process-surface-layout.ts'

const createMemoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    },
  }
}

describe('process surface layout storage', () => {
  test('stores widget positions per control instance, system, and surface', () => {
    const storage = createMemoryStorage()
    const controlInstanceId = 'control-instance:layout-test' as ControlInstanceId
    storeProcessSurfaceLayout({
      controlInstanceId,
      systemId: 'unit-a',
      surfaceId: 'unit-overview',
      layout: {
        'reactor-vessel': { x: 120, y: 240 },
      },
    }, storage)

    expect(readProcessSurfaceLayout({
      controlInstanceId,
      systemId: 'unit-a',
      surfaceId: 'unit-overview',
    }, storage)).toEqual({
      'reactor-vessel': { x: 120, y: 240 },
    })
    expect(readProcessSurfaceLayout({
      controlInstanceId,
      systemId: 'unit-b',
      surfaceId: 'unit-overview',
    }, storage)).toEqual({})
  })

  test('rejects corrupted layout data visibly', () => {
    const storage = createMemoryStorage()
    storage.setItem('leitbild.processSurfaceLayout.v1:control-instance:layout-test:unit-a:unit-overview', '{"reactor-vessel":{"x":"bad","y":1}}')

    expect(() => readProcessSurfaceLayout({
      controlInstanceId: 'control-instance:layout-test' as ControlInstanceId,
      systemId: 'unit-a',
      surfaceId: 'unit-overview',
    }, storage)).toThrow('invalid coordinates')
  })

  test('stores window bounds per control instance, system, and surface', () => {
    const storage = createMemoryStorage()
    const controlInstanceId = 'control-instance:window-test' as ControlInstanceId
    storeProcessSurfaceWindowBounds({
      controlInstanceId,
      systemId: 'unit-a',
      surfaceId: 'unit-overview',
      bounds: { x: 40, y: 50, width: 900, height: 640 },
    }, storage)

    expect(readProcessSurfaceWindowBounds({
      controlInstanceId,
      systemId: 'unit-a',
      surfaceId: 'unit-overview',
    }, storage)).toEqual({ x: 40, y: 50, width: 900, height: 640 })
    expect(readProcessSurfaceWindowBounds({
      controlInstanceId,
      systemId: 'unit-b',
      surfaceId: 'unit-overview',
    }, storage)).toBeNull()
  })

  test('rejects corrupted window bounds visibly', () => {
    const storage = createMemoryStorage()
    storage.setItem('leitbild.processSurfaceWindow.v1:control-instance:window-test:unit-a:unit-overview', '{"x":1,"y":2,"width":"wide","height":4}')

    expect(() => readProcessSurfaceWindowBounds({
      controlInstanceId: 'control-instance:window-test' as ControlInstanceId,
      systemId: 'unit-a',
      surfaceId: 'unit-overview',
    }, storage)).toThrow('invalid coordinates')
  })
})
