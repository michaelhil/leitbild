import { describe, expect, test } from 'bun:test'
import { recordingSeriesIdFor, type ObjectId } from '../src/core/model/index.ts'
import type { VignetteSection, VignetteView } from '../src/features/displays/compose/model.ts'
import { bindingRefs, FLOW_ROOM, overviewOf, topologySection, tracedRefs } from '../src/features/displays/compose/topology.ts'
import { flowLayout } from '../src/features/displays/topology/flow-sizing.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { recordedPlantVariables } from '../src/packs/process-plant/recording.ts'
import { flowDrawing } from '../src/ui/embed/vignette/flow-symbols.ts'
import { shownSeries } from '../src/ui/embed/vignette/kept-series.ts'
import { SPARK_WINDOW_MS } from '../src/ui/sparkline.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The vessels trace their readings over the last ten minutes (plan v5 W6.6, owner finding 8; U-15, #36, C5; the old
// mimic-vessel test's "vessels trace their readings" re-expressed): tanks their own level beside them, heat exchangers
// their level in their tile (D-D), the core its exit temperature under it (D-C), each with the registered sparkline;
// a tank's level program marked on it as OpenBridge's set point; each traced record served with the samples.

type Topology = Extract<VignetteSection, { kind: 'topology' }>
const objectId = 'plant:traces' as ObjectId
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount: 4 }))
const graph = servedPlantTopology(objectId, plant)
// Recorded as a Run records its Plant: the traced levels and the core-exit temperature have their series.
const recording = { seriesIds: new Set(recordedPlantVariables(plant, 'operations').map(variable => recordingSeriesIdFor(plant.id, variable.path))), intervalMs: 1_000 }
const declared = new Map(plantDeclaration(objectId, plant, recording).observables.map(observable => [observable.ref, observable]))
const scoped = overviewOf(graph)!
const section = topologySection(objectId, 'process-plant', scoped, flowLayout(scoped, FLOW_ROOM, ref => declared.get(ref))!, 39, ref => declared.get(ref)) as Topology
const ref = (path: string): string => `${objectId}#${path}`
const traced = (node: string) => graph.nodes.find(entry => entry.id === node)!.bindings.filter(binding => binding.trace === true).map(binding => binding.ref)

describe('what a drawing traces (W6.6)', () => {
  test('tanks their own level, heat exchangers theirs, the core its own readings outside what its instruments read in turn', () => {
    expect(traced('pressurizer')).toEqual([ref('pressurizer.levelPercent')])
    expect(traced('feedwaterTank')).toEqual([ref('feedwaterTank.levelPercent')])
    for (const sg of ['sgA', 'sgB', 'sgC', 'sgD']) expect(traced(sg)).toEqual([ref(`${sg}.levelPercent`)])
    expect(traced('condenser')).toEqual([ref('condenser.condensateLevelPercent')])
    // The core-exit temperature; not the flux its instruments read in turn, not the vessel's level.
    expect(traced('core')).toEqual([ref('core.coreExitTemperatureC')])
    // What the overview keeps the records of: each of them once.
    expect([...tracedRefs(scoped)].sort()).toEqual([
      'condenser.condensateLevelPercent', 'core.coreExitTemperatureC', 'feedwaterTank.levelPercent', 'pressurizer.levelPercent',
      ...['A', 'B', 'C', 'D'].map(sg => `sg${sg}.levelPercent`),
    ].map(ref).sort())
  })

  test('a tank\'s binding names the program its level is held to, sampled with the drawing', () => {
    expect(graph.nodes.find(node => node.id === 'pressurizer')!.bindings.filter(binding => binding.role === 'program').map(binding => binding.ref)).toEqual([ref('pressurizer.levelProgramPercent')])
    expect(bindingRefs(scoped)).toContain(ref('pressurizer.levelProgramPercent'))
    expect(graph.nodes.find(node => node.id === 'feedwaterTank')!.bindings.some(binding => binding.role === 'program')).toBe(false)
  })

  test('the drawing: a tank and the core trace under their readings, an exchanger in its tile; a tank marks its program', () => {
    const at = '2026-10-23T12:00:00.000Z'
    const drawing = flowDrawing(section, [{ ref: ref('pressurizer.levelProgramPercent'), value: 41.5, quality: 'good', at } as never], [], false)
    const traceOf = (id: string) => drawing.texts.find(text => text.id === id)!.lines.filter(line => line.kind === 'trace').map(line => line.ref)
    expect(traceOf('pressurizer')).toEqual([ref('pressurizer.levelPercent')])
    expect(traceOf('feedwaterTank')).toEqual([ref('feedwaterTank.levelPercent')])
    expect(traceOf('core')).toEqual([ref('core.coreExitTemperatureC')])
    // The trace stands after the readings, as the last line.
    expect(drawing.texts.find(text => text.id === 'core')!.lines.at(-1)!.kind).toBe('trace')
    for (const id of ['sgA', 'sgB', 'sgC', 'sgD', 'condenser']) {
      expect(traceOf(id)).toEqual([])
      expect(drawing.vessels.find(vessel => vessel.id === id)!.trace).toBe(graph.nodes.find(node => node.id === id)!.bindings.find(binding => binding.trace === true)!.ref)
    }
    expect(drawing.vessels.find(vessel => vessel.id === 'pressurizer')!.program).toBe(41.5)
    expect(drawing.vessels.find(vessel => vessel.id === 'feedwaterTank')!.program).toBeNull()
  })

  test('each traced reading carries its record\'s series to the client, which keeps it over a sparkline\'s ten minutes', () => {
    const recorded = section.nodes.flatMap(node => node.bindings.filter(binding => binding.series !== undefined).map(binding => binding.ref))
    expect(recorded.sort()).toEqual([...tracedRefs(scoped)].filter(entry => declared.get(entry)?.series !== null).sort())
    expect(recorded.length).toBe(tracedRefs(scoped).length)
    const view = { title: 'Unit', sections: [section] } as unknown as VignetteView
    const shown = shownSeries(view)
    expect(shown.map(entry => entry.ref).sort()).toEqual(recorded.sort())
    expect(shown.every(entry => entry.horizonMs === SPARK_WINDOW_MS)).toBe(true)
  })
})
