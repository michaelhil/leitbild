import { describe, expect, test } from 'bun:test'
import {
  controlInstanceIdForScenarioRun,
  defaultScenarioRunPath,
  parseControlSurfaceRoute,
  pathForScenarioRun,
} from '../src/ui/control-instance-route.ts'

describe('control instance route model', () => {
  test('uses scenario-specific run URLs and internal control instance ids', () => {
    expect(pathForScenarioRun('sandbox', 'halden')).toBe('/i/sandbox/halden')
    expect(String(controlInstanceIdForScenarioRun('sandbox', 'halden'))).toBe('sandbox:halden')

    const route = parseControlSurfaceRoute('/i/sandbox/halden')
    expect(route.mode).toBe('control-instance')
    if (route.mode !== 'control-instance') throw new Error('expected control instance route')
    expect(route.workspaceId).toBe('sandbox')
    expect(route.scenarioId).toBe('halden')
    expect(String(route.controlInstanceId)).toBe('sandbox:halden')
    expect(route.canonicalPath).toBe('/i/sandbox/halden')
  })

  test('keeps the picker route distinct from scenario runs', () => {
    expect(parseControlSurfaceRoute('/i')).toEqual({ mode: 'picker' })
    expect(defaultScenarioRunPath()).toBe('/i/sandbox/oslo-ambulance')
  })

  test('rejects ambiguous one-segment instance URLs instead of silently guessing a scenario', () => {
    expect(() => parseControlSurfaceRoute('/i/sandbox')).toThrow('workspace and scenario')
  })
})
