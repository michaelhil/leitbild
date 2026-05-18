import { describe, expect, test } from 'bun:test'
import {
  controlInstanceIdForScenarioRun,
  pathForNewScenarioRun,
  parseControlSurfaceRoute,
  pathForScenarioRun,
} from '../src/ui/control-instance-route.ts'

describe('control instance route model', () => {
  test('uses scenario-specific run URLs and internal control instance ids', () => {
    expect(pathForScenarioRun('halden', 'sandbox')).toBe('/i/halden/sandbox')
    expect(String(controlInstanceIdForScenarioRun('halden', 'sandbox'))).toBe('halden:sandbox')

    const route = parseControlSurfaceRoute('/i/halden/sandbox')
    expect(route.mode).toBe('control-instance')
    if (route.mode !== 'control-instance') throw new Error('expected control instance route')
    expect(route.scenarioId).toBe('halden')
    expect(route.runId).toBe('sandbox')
    expect(String(route.controlInstanceId)).toBe('halden:sandbox')
    expect(route.canonicalPath).toBe('/i/halden/sandbox')
  })

  test('keeps the picker route distinct from scenario run creation', () => {
    expect(parseControlSurfaceRoute('/')).toEqual({ mode: 'picker' })
    expect(parseControlSurfaceRoute('/i')).toEqual({ mode: 'picker' })
    expect(parseControlSurfaceRoute('/i/halden')).toEqual({
      mode: 'new-run',
      scenarioId: 'halden',
      canonicalPath: '/i/halden',
    })
    expect(pathForNewScenarioRun('halden')).toBe('/i/halden')
  })

  test('rejects invalid route shapes instead of silently guessing a scenario or run', () => {
    expect(() => parseControlSurfaceRoute('/i/halden/sandbox/extra')).toThrow('scenario and run')
  })
})
