import { describe, expect, test } from 'bun:test'
import {
  compilePlantGraph,
  compileProcessSurface,
  pressurizedWaterReactorPlantSpec,
  processPlantComponentRegistry,
  processPlantUnitOverviewSurface,
} from '../src/packs/process-plant/index.ts'
import { pathDataFor, pathPointsFor } from '../src/ui/process-surface/process-surface-rendering.ts'

const referenceSurface = () => compileProcessSurface({
  definition: processPlantUnitOverviewSurface,
  graph: compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry),
})

describe('process surface rendering helpers', () => {
  test('preserves authored route points while following moved endpoints', () => {
    const surface = referenceSurface()
    const path = surface.paths.find(candidate => candidate.id === 'main-steam-to-turbine')
    if (!path) throw new Error('expected main steam path')

    const moved = pathPointsFor({
      surface,
      path,
      widgetPositions: {
        'sg-a': { x: 760, y: 220 },
        turbine: { x: 1250, y: 250 },
      },
    })

    expect(moved.length).toBe(path.points.length)
    expect(moved[1]?.x).not.toBe(moved[0]?.x)
    expect(moved[1]?.y).not.toBe(moved[0]?.y)
    const pathData = pathDataFor(moved)
    expect(pathData).toContain('L')
    expect(pathData).not.toContain('Q')
    expect(pathData).not.toContain('C')
  })
})
