import { describe, expect, test } from 'bun:test'
import {
  compilePlantGraph,
  compileProcessDisplay,
  assemblePwrReferencePlantGraph,
  processPlantUnitOverviewDisplay,
  processPlantComponentRegistry,
  projectCompiledProcessDisplay,
  projectProcessGraph,
  type ComponentId,
  type ConnectionId,
  type ConnectionService,
} from '../src/packs/process-plant/index.ts'

const pressurizedWaterReactorPlantSpec = assemblePwrReferencePlantGraph({ loopCount: 4 })
const graph = () => compilePlantGraph(pressurizedWaterReactorPlantSpec, processPlantComponentRegistry)

describe('process graph lens', () => {
  test('projects selected components without inventing connections', () => {
    const compiled = graph()
    const projection = projectProcessGraph({
      graph: compiled,
      mode: 'selected-only',
      selectedComponentIds: ['core' as ComponentId],
    })

    expect(projection.componentIds.map(String)).toEqual(['core'])
    expect(projection.connectionIds).toEqual([])
    expect(projection.componentReasons.get('core' as ComponentId)).toEqual(['selected'])
  })

  test('selected connections include their real endpoints', () => {
    const compiled = graph()
    const projection = projectProcessGraph({
      graph: compiled,
      mode: 'selected-only',
      selectedConnectionIds: ['sg-a-steam-to-msiv-a' as ConnectionId],
    })

    expect(projection.connectionIds.map(String)).toEqual(['sg-a-steam-to-msiv-a'])
    expect(projection.componentIds.map(String)).toEqual(['sgA', 'mainSteamIsolationValveA'])
    expect(projection.connectionReasons.get('sg-a-steam-to-msiv-a' as ConnectionId)).toEqual(['selected-connection'])
  })

  test('direct neighborhood follows compiled adjacency', () => {
    const compiled = graph()
    const coreIndex = compiled.componentIndexById.get('core' as ComponentId)
    if (coreIndex === undefined) throw new Error('expected core component')
    const adjacentConnectionIds = new Set([
      ...(compiled.incomingLinksByComponent[coreIndex] ?? []),
      ...(compiled.outgoingLinksByComponent[coreIndex] ?? []),
    ].map(index => String(compiled.links[index]?.id)))

    const projection = projectProcessGraph({
      graph: compiled,
      mode: 'direct-neighborhood',
      selectedComponentIds: ['core' as ComponentId],
    })

    expect(projection.componentIds.map(String)).toContain('core')
    expect(projection.connectionIds.map(String)).toEqual(
      compiled.links
        .filter(link => adjacentConnectionIds.has(String(link.id)))
        .map(link => String(link.id)),
    )
    expect(projection.connectionIds.length).toBeGreaterThan(1)
    expect(projection.componentIds.length).toBeGreaterThan(1)
  })

  test('service layer projects all links and endpoints for one service', () => {
    const compiled = graph()
    const service = 'primaryCoolant' as ConnectionService
    const expectedConnectionIds = (compiled.linksByService.get(service) ?? []).map(index => String(compiled.links[index]?.id))
    const projection = projectProcessGraph({
      graph: compiled,
      mode: 'service-layer',
      service,
    })

    expect(projection.connectionIds.map(String)).toEqual(expectedConnectionIds)
    expect(projection.connectionIds.length).toBeGreaterThanOrEqual(13)
    expect(projection.componentIds.map(String)).toContain('core')
    expect(projection.componentIds.map(String)).toContain('rcpA')
    expect(projection.componentIds.map(String)).toContain('sgA')
    expect(projection.diagnostics).toEqual([])
  })

  test('service layer reports empty projections without inventing components', () => {
    const compiled = graph()
    const projection = projectProcessGraph({
      graph: compiled,
      mode: 'service-layer',
      service: 'not-used-in-this-graph' as ConnectionService,
    })

    expect(projection.componentIds).toEqual([])
    expect(projection.connectionIds).toEqual([])
    expect(projection.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'empty-service-layer',
        service: 'not-used-in-this-graph',
      }),
    ])
  })

  test('path-to-visible traces real shortest links to an existing visible anchor', () => {
    const compiled = graph()
    const projection = projectProcessGraph({
      graph: compiled,
      mode: 'path-to-visible',
      selectedComponentIds: ['sgA' as ComponentId],
      visibleComponentIds: ['mainSteamHeader' as ComponentId],
    })

    expect(projection.componentIds.map(String)).toEqual(expect.arrayContaining([
      'sgA',
      'mainSteamIsolationValveA',
      'mainSteamHeader',
    ]))
    expect(projection.connectionIds.map(String)).toEqual([
      'sg-a-steam-to-msiv-a',
      'msiv-a-to-main-steam-header',
    ])
  })

  test('rejects unknown references instead of silently falling back', () => {
    const compiled = graph()

    expect(() => projectProcessGraph({
      graph: compiled,
      mode: 'selected-only',
      selectedComponentIds: ['missing-component' as ComponentId],
    })).toThrow('unknown component')

    expect(() => projectProcessGraph({
      graph: compiled,
      mode: 'selected-only',
      selectedConnectionIds: ['missing-connection' as ConnectionId],
    })).toThrow('unknown connection')

    expect(() => projectProcessGraph({
      graph: compiled,
      mode: 'service-layer',
    })).toThrow('requires a service')
  })

  test('projects compiled process displays from graph visibility without guessing by widget id', () => {
    const compiled = graph()
    const display = compileProcessDisplay({
      definition: processPlantUnitOverviewDisplay,
      graph: compiled,
    })
    const graphProjection = projectProcessGraph({
      graph: compiled,
      mode: 'service-layer',
      service: 'primaryCoolant' as ConnectionService,
    })
    const displayProjection = projectCompiledProcessDisplay({ display, graphProjection })

    expect(displayProjection.visibleWidgets.map(widget => widget.id)).toContain('reactor-vessel')
    expect(displayProjection.visibleWidgets.map(widget => widget.id)).toContain('rcp-a')
    expect(displayProjection.visibleWidgets.map(widget => widget.id)).toContain('sg-a')
    expect(displayProjection.visibleWidgets.map(widget => widget.id)).toContain('unit-status-banner')
    expect(displayProjection.visiblePaths.map(path => path.id)).toContain('primary-hot-leg-a')
    expect(displayProjection.visiblePaths.map(path => path.id)).not.toContain('turbine-exhaust-to-condenser')
    expect(displayProjection.hiddenPaths.map(path => path.id)).toContain('turbine-exhaust-to-condenser')
  })
})
