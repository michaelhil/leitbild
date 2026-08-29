import { describe, expect, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { simulationRunIdSchema } from '../src/core/model/index.ts'
import {
  pathForNewSimulationRun,
  pathForSimulationRun,
  pathForWorkspace,
  parseControlSurfaceRoute,
} from '../src/ui/simulation-run-route.ts'

const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')

describe('Simulation Run route model', () => {
  test('uses Workspace-scoped opaque Simulation Run URLs', () => {
    const simulationRunId = simulationRunIdSchema.parse('run-abc123')
    expect(pathForSimulationRun(workspaceId, simulationRunId))
      .toBe(`/workspaces/${workspaceId}/world/runs/run-abc123`)

    const route = parseControlSurfaceRoute(`/workspaces/${workspaceId}/world/runs/run-abc123`)
    expect(route).toEqual({
      mode: 'simulation-run',
      workspaceId,
      simulationRunId,
      canonicalPath: `/workspaces/${workspaceId}/world/runs/run-abc123`,
    })
  })

  test('keeps Workspace home and new-run routes distinct', () => {
    expect(parseControlSurfaceRoute(`/workspaces/${workspaceId}/world`)).toEqual({
      mode: 'run-picker',
      workspaceId,
      canonicalPath: `/workspaces/${workspaceId}/world`,
    })
    expect(parseControlSurfaceRoute(`/workspaces/${workspaceId}/world/scenarios/halden/runs/new`)).toEqual({
      mode: 'new-run',
      workspaceId,
      scenarioId: 'halden',
      canonicalPath: `/workspaces/${workspaceId}/world/scenarios/halden/runs/new`,
    })
    expect(pathForWorkspace(workspaceId)).toBe(`/workspaces/${workspaceId}/world`)
    expect(pathForNewSimulationRun(workspaceId, 'halden'))
      .toBe(`/workspaces/${workspaceId}/world/scenarios/halden/runs/new`)
  })

  test('rejects invalid Workspace, run id, and route shapes', () => {
    expect(() => parseControlSurfaceRoute('/')).toThrow()
    expect(() => parseControlSurfaceRoute('/workspaces/not-a-workspace')).toThrow()
    expect(() => parseControlSurfaceRoute(`/workspaces/${workspaceId}/world/runs/sandbox`)).toThrow()
    expect(() => parseControlSurfaceRoute(`/workspaces/${workspaceId}/world/runs/run-abc123/extra`))
      .toThrow('Workspace or Simulation Run')
  })
})
