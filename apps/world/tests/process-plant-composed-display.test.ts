import { describe, expect, test } from 'bun:test'
import { embeddedViewPublicationSchema } from '@leitbild/contracts'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import {
  answerProcessPlantQuery,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { recordedPlantVariables } from '../src/packs/process-plant/recording.ts'
import { recordingSeriesIdFor } from '../src/core/model/index.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { icThresholdsForSignal } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import { composedDisplayStateSchema } from '../src/packs/process-plant/displays/composition.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'

const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:composed-display', loopCount: 4 }))
const runtime = createProcessPlantRuntime({ system: compiled })
const plant: ProcessPlantRuntimeInstance = {
  plant: compiled,
  runtime,
  ramps: createProcessPlantRampRunner({ runtime }),
  protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
  performance: createProcessPlantRuntimePerformance(),
}
const plants = new Map([[compiled.id, plant]])
const simulationTime = '2026-10-08T21:00:00.000Z' as IsoTimestamp
// The Run records the operations profile: tagged instruments, states, controls and power.
const recordedSeriesIds = new Set(recordedPlantVariables(compiled, 'operations').map(variable => recordingSeriesIdFor(compiled.id, variable.path)))
const ask = (capabilityId: string, input: unknown, at: IsoTimestamp | null = simulationTime) => answerProcessPlantQuery({
  request: { capabilityId, input },
  plants,
  objects: new Map(),
  recordedSeriesIds,
  ...(at === null ? {} : { simulationTime: at }),
})

const composition = (signals: ReadonlyArray<{ readonly ref: string; readonly role: string }>, horizon = '10m') => ({
  plantId: compiled.id,
  title: 'SG B level after feed valve failure',
  question: 'Is SG B level recovering after its feed valve failed?',
  need: 'Decide whether to take manual feed control before AFW actuates',
  panels: [{ kind: 'trend', horizon, signals }],
})

const rejectionOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the composition to be rejected')
}

describe('I&C thresholds for composed displays', () => {
  test('come from single-comparison rules on the exact signal, with qualified modes kept', () => {
    const pressure = compiled.graph.signalBindingByTagId.get('PT-455' as never)!.path
    const { thresholds } = icThresholdsForSignal(compiled, pressure)
    expect(thresholds.map(threshold => [threshold.value, threshold.kind, threshold.modeLabel ?? null])).toEqual([
      [13.8, 'trip', 'power operation'],
      [14.8, 'alarm', null],
      [15.35, 'control', null],
      [15.65, 'control', null],
      [15.85, 'control', null],
      [16, 'alarm', null],
      [16.18, 'trip', null],
      [16.35, 'trip', 'power operation'],
    ])
  })

  test('list combined-condition rules instead of drawing them', () => {
    const flow = compiled.graph.signalBindingByTagId.get('RCP-A-FLOW' as never)!.path
    const result = icThresholdsForSignal(compiled, flow)
    expect(result.thresholds.map(threshold => threshold.value)).toEqual([2500])
    expect(result.combinedRules.map(rule => rule.ruleId)).toContain('reactor-low-rcp-flow-trip')
  })
})

describe('world.process-plant.display.compose', () => {
  test('returns a view publication, what it shows and the issue time without storing anything', () => {
    const before = runtime.checkpoint()
    const result = ask('world.process-plant.display.compose', composition([
      { ref: 'SG-B-LVL-NR', role: 'primary' },
      { ref: 'SG-A-LVL-NR', role: 'context' },
    ])) as { view: unknown; shows: ReadonlyArray<string>; warnings: ReadonlyArray<string>; issuedAt: string }
    const view = embeddedViewPublicationSchema.parse(result.view)
    expect(String(view.viewType)).toBe('process-plant.display')
    expect(result.issuedAt).toBe(simulationTime)
    const state = composedDisplayStateSchema.parse(JSON.parse(view.state))
    expect(state).toMatchObject({ issuedAt: simulationTime, modelDigest: compiled.modelDigest })
    expect(result.shows.join('\n')).toContain('"LO ALM 30 %" alarm line: Steam generator B level low · Steam generator A level low, acts below 30 percent for SG-B-LVL-NR, SG-A-LVL-NR')
    expect((result as unknown as { signals: unknown }).signals).toEqual([
      { ref: 'SG-B-LVL-NR', tagId: 'SG-B-LVL-NR', path: 'sgB.levelPercent', label: 'Steam generator level', name: 'SG-B-LVL-NR', unit: 'percent' },
      { ref: 'SG-A-LVL-NR', tagId: 'SG-A-LVL-NR', path: 'sgA.levelPercent', label: 'Steam generator level', name: 'SG-A-LVL-NR', unit: 'percent' },
    ])
    expect(result.shows.join('\n')).toContain('"LO TRIP 20 %" trip line: Steam generator B low-low level · Steam generator A low-low level, acts below 20 percent for SG-B-LVL-NR, SG-A-LVL-NR')
    expect((result as unknown as { simulationClock: string }).simulationClock).toBe('21:00:00')
    const margins = (result as unknown as { margins: ReadonlyArray<string> }).margins
    expect(margins).toHaveLength(2)
    expect(margins[0]).toMatch(/^SG-[AB]-LVL-NR: [0-9.]+ %, LO ALM 30 % · [0-9.]+ above$/)
    expect(runtime.checkpoint()).toEqual(before)
  })

  test('rejects every issue at once with did-you-mean suggestions and never repairs', () => {
    const message = rejectionOf(() => ask('world.process-plant.display.compose', composition([
      { ref: 'SG-B-LEVEL-NR', role: 'context' },
      { ref: 'PT-455', role: 'context' },
    ])))
    expect(message).toContain('Display composition rejected (2 issues)')
    expect(message).toContain('panels.0.signals.0.ref: unknown signal "SG-B-LEVEL-NR"')
    expect(message).toContain('Did you mean: SG-B-LVL-NR')
    expect(message).toContain('at least one signal with role "primary"')
  })

  test('suggests signals by the words of a guessed name, tagged instruments first', () => {
    const suggestions = (ref: string): string => rejectionOf(() => ask('world.process-plant.display.compose', composition([{ ref, role: 'primary' }]))).split('Did you mean: ')[1] ?? ''
    expect(suggestions('FW-A-FLOW')).toContain('sgA.feedwaterFlowKgPerS (Feedwater inflow, kg/s)')
    expect(suggestions('PZR-PRESS')).toStartWith('PT-455 (Pressurizer pressure, MPa)')
    expect(suggestions('dieselGenA.running')).toStartWith('EDG-A-RUN (Diesel running, boolean)')
    expect(suggestions('SG1-LVL')).toStartWith('SG-A-LVL-NR (Steam generator level, percent)')
    expect(suggestions('RCS-TAVG')).toStartWith('TAVG (Mean primary coolant temperature, degC)')
  })

  test('says when a signal is a command, not a measured state', () => {
    const result = ask('world.process-plant.display.compose', {
      ...composition([{ ref: 'PT-455', role: 'primary' }]),
      panels: [{ kind: 'trend', horizon: '2m', signals: [{ ref: 'PT-455', role: 'primary' }] }, { kind: 'readouts', signals: [{ ref: 'PORV-456A', role: 'context' }] }],
    }) as { warnings: ReadonlyArray<string>; shows: ReadonlyArray<string> }
    expect(result.warnings).toContain("PORV-456A is a writable command (a demand), not a measured state; never present it as the equipment's actual state or position.")
    expect(result.shows.join('\n')).toContain('PORV-456A (Pressurizer relief valve position, fraction, context, a command (demand), shown as demand)')
  })

  test('says which trended signals the Run does not record', () => {
    const result = ask('world.process-plant.display.compose', composition([
      { ref: 'SG-B-LVL-NR', role: 'primary' },
      { ref: 'sgB.feedwaterFlowKgPerS', role: 'context' },
    ])) as { warnings: ReadonlyArray<string> }
    expect(result.warnings).toContain("sgB.feedwaterFlowKgPerS is not recorded by this Run's historian; its trend starts when the view opens. Do not describe its history from the display.")
    expect(result.warnings.some(warning => warning.startsWith('SG-B-LVL-NR is not recorded'))).toBe(false)
  })

  test('rejects state signals on a trend', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.compose', composition([
      { ref: 'RCP-A-RUN', role: 'primary' },
    ])))).toContain('is a boolean state signal')
  })

  test('rejects fields outside the composition vocabulary', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.compose', composition([{ ref: 'PT-455', role: 'primary' }], '5m')))).toContain('panels.0.horizon')
    expect(rejectionOf(() => ask('world.process-plant.display.compose', {
      ...composition([{ ref: 'PT-455', role: 'primary' }]),
      limits: { low: 14 },
    }))).toContain('limits')
  })

  test('requires the Simulation Run time of the answering runtime', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.compose', composition([{ ref: 'PT-455', role: 'primary' }]), null)))
      .toContain('requires the Simulation Run time')
  })
})

describe('thresholds drawn on composed trends', () => {
  const panelOf = (signals: ReadonlyArray<{ readonly ref: string; readonly role: string }>) => {
    const composed = ask('world.process-plant.display.compose', composition(signals)) as { view: { state: string } }
    const view = ask('world.process-plant.display.view', { plantId: compiled.id, state: composed.view.state }) as {
      display: { panels: ReadonlyArray<{ strips: ReadonlyArray<{ thresholds: ReadonlyArray<{ value: number; kind: string; signals: ReadonlyArray<string>; label: string }> }> }> }
    }
    return view.display.panels[0]!.strips[0]!
  }

  test('cover every displayed signal once per rule action', () => {
    const panel = panelOf([{ ref: 'SG-B-LVL-NR', role: 'primary' }, { ref: 'SG-A-LVL-NR', role: 'context' }, { ref: 'SG-C-LVL-NR', role: 'context' }])
    expect(panel.thresholds.map(threshold => [threshold.value, threshold.kind, threshold.signals])).toEqual([
      [20, 'trip', ['SG-B-LVL-NR', 'SG-A-LVL-NR', 'SG-C-LVL-NR']],
      [30, 'alarm', ['SG-B-LVL-NR', 'SG-A-LVL-NR', 'SG-C-LVL-NR']],
    ])
    expect((panel.thresholds[1] as unknown as { ruleIds: string[]; direction: string })).toMatchObject({
      direction: 'low', ruleIds: ['sg-b-level-low', 'sg-a-level-low', 'sg-c-level-low'],
    })
  })

  test('draw one line per shared set point of several primary signals', () => {
    const panel = panelOf([{ ref: 'SG-A-LVL-NR', role: 'primary' }, { ref: 'SG-B-LVL-NR', role: 'primary' }])
    expect(panel.thresholds.map(threshold => [threshold.value, threshold.signals])).toEqual([
      [20, ['SG-A-LVL-NR', 'SG-B-LVL-NR']],
      [30, ['SG-A-LVL-NR', 'SG-B-LVL-NR']],
    ])
    expect(panel.thresholds[1]!.label).toBe('Steam generator A level low · Steam generator B level low')
  })
})

describe('composed display panels', () => {
  const display = (panels: ReadonlyArray<unknown>) => ({ ...composition([]), panels })
  const composeView = (panels: ReadonlyArray<unknown>) => {
    const composed = ask('world.process-plant.display.compose', display(panels)) as { view: { state: string; height: number }; shows: ReadonlyArray<string> }
    const view = ask('world.process-plant.display.view', { plantId: compiled.id, state: composed.view.state }) as { display: { height: number; panels: ReadonlyArray<Record<string, unknown>> } }
    return { composed, view }
  }

  test('stack one strip per measurement, primary on top, with unrecorded signals as live rows', () => {
    const { composed, view } = composeView([
      { kind: 'trend', horizon: '10m', signals: [
        { ref: 'PT-455', role: 'counter-evidence' },
        { ref: 'SG-B-LVL-NR', role: 'primary' },
        { ref: 'SG-A-LVL-NR', role: 'context' },
        { ref: 'sgB.feedwaterFlowKgPerS', role: 'context' },
      ] },
    ])
    const trend = view.display.panels[0] as {
      strips: ReadonlyArray<{ unit: string; pens: ReadonlyArray<{ ref: string; name: string }> }>
      live: ReadonlyArray<{ ref: string; name: string }>
    }
    expect(trend.strips.map(strip => [strip.unit, strip.pens.map(pen => pen.ref)])).toEqual([
      ['percent', ['SG-B-LVL-NR', 'SG-A-LVL-NR']],
      ['MPa', ['PT-455']],
    ])
    expect(trend.live.map(pen => pen.name)).toEqual(['Feedwater inflow · Steam Generator B'])
    // Each strip: labels and plot (the last also the time axis) and a legend row per pen; then the live rows.
    expect(composed.view.height).toBe(124 + (18 + 72 + 4 + 16 * 2) + (18 + 72 + 22 + 4 + 16) + (4 + 16))
    expect(composed.shows[0]).toContain('in 2 stacked strips (one per measurement)')
    expect(composed.shows[1]).toStartWith('Current values only, not recorded by this Run (no history to describe): Feedwater inflow · Steam Generator B')
  })

  test('never share an axis between different measurements of one unit', () => {
    const { view } = composeView([
      { kind: 'trend', horizon: '2m', signals: ['CET-AVG', 'SUB-MARGIN', 'PT-455', 'SG-A-PRESS'].map((ref, index) => ({ ref, role: index === 0 ? 'primary' : 'context' })) },
    ])
    const trend = view.display.panels[0] as { strips: ReadonlyArray<{ pens: ReadonlyArray<{ ref: string }> }> }
    expect(trend.strips.map(strip => strip.pens.map(pen => pen.ref))).toEqual([['CET-AVG'], ['SUB-MARGIN'], ['PT-455'], ['SG-A-PRESS']])
  })

  test('name every fix in one rejection, with ways to fit the chat view', () => {
    // Evaluation run 7, turbine trip: three measurements beside six readouts and the alarms.
    const message = rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '2m', signals: ['PT-455', 'SG-A-PRESS', 'SG-A-LVL-NR', 'SG-B-LVL-NR', 'GEN-MW'].map((ref, index) => ({ ref, role: index === 0 ? 'primary' : 'context' })) },
      { kind: 'readouts', signals: ['TAVG', 'PZR-LVL', 'CET-AVG', 'SUB-MARGIN', 'CTMT-PR', 'SG-C-PRESS'].map(ref => ({ ref, role: 'context' })) },
      { kind: 'alarms', scope: 'related' },
    ])))
    expect(message).toContain('but chat views allow 640')
    expect(message).toContain('(panels.0 trend (4 strips) 382 px, panels.1 readouts 148 px, panels.2 alarms 110 px); it fits with at most 2 trend measurements (strips), or without panels.1 (readouts)')
    // Evaluation run 7, RCP trip: seven trended signals were rejected alone, then the size; now both at once.
    const both = rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '2m', signals: ['CET-AVG', 'SUB-MARGIN', 'PT-455', 'PZR-LVL', 'SG-A-LVL-NR', 'SG-B-LVL-NR', 'TAVG'].map((ref, index) => ({ ref, role: index === 0 ? 'primary' : 'context' })) },
      { kind: 'comparison', signals: ['A', 'B', 'C', 'D'].map(loop => ({ ref: `RCP-${loop}-FLOW`, role: 'context' })) },
      { kind: 'alarms', scope: 'related' },
    ])))
    expect(both).toContain('a trend shows at most 6 signals, but this one lists 7')
    expect(both).toContain('a trend stacks at most 4 strips')
    expect(both).toContain('but chat views allow 640')
  })

  test('reject a trend with no recorded signal', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.compose', composition([{ ref: 'sgB.feedwaterFlowKgPerS', role: 'primary' }]))))
      .toContain("is recorded by this Run's historian, so the trend would have no history; show them in a readouts panel")
  })

  test('shrink trend plots, not other panels, so a display fits the chat view', () => {
    // Two measurements beside six readouts and the alarms need 668 px at preferred size.
    const { composed, view } = composeView([
      { kind: 'trend', horizon: '2m', signals: ['SG-A-LVL-NR', 'SG-B-LVL-NR', 'SG-A-PRESS', 'SG-B-PRESS'].map((ref, index) => ({ ref, role: index === 0 ? 'primary' : 'context' })) },
      { kind: 'readouts', signals: ['TAVG', 'PZR-LVL', 'PT-455', 'CTMT-PR', 'CET-AVG', 'SUB-MARGIN'].map(ref => ({ ref, role: 'context' })) },
      { kind: 'alarms', scope: 'related' },
    ])
    const trend = view.display.panels[0] as { plot: number }
    expect(trend.plot).toBeLessThan(72)
    expect(trend.plot).toBeGreaterThanOrEqual(48)
    expect(composed.view.height).toBeLessThanOrEqual(640)
  })

  // The skill's size rule: three or four measurements leave room for alarms; two for alarms and three readouts.
  test('fit the largest trends the skill allows beside their companion panels', () => {
    const levels = ['A', 'B', 'C', 'D'].map(loop => ({ ref: `SG-${loop}-LVL-NR`, role: loop === 'B' ? 'primary' : 'context' }))
    const threeMeasurements = composeView([
      { kind: 'trend', horizon: '2m', signals: [...levels, { ref: 'PT-455', role: 'context' }, { ref: 'GEN-MW', role: 'context' }] },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(threeMeasurements.composed.view.height).toBeLessThanOrEqual(640)
    const fourMeasurements = composeView([
      { kind: 'trend', horizon: '2m', signals: ['SG-B-LVL-NR', 'PT-455', 'GEN-MW', 'TAVG'].map((ref, index) => ({ ref, role: index === 0 ? 'primary' : 'context' })) },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(fourMeasurements.composed.view.height).toBeLessThanOrEqual(640)
    const twoMeasurements = composeView([
      { kind: 'trend', horizon: '10m', signals: [...levels, { ref: 'SG-A-PRESS', role: 'context' }, { ref: 'SG-B-PRESS', role: 'context' }] },
      { kind: 'readouts', signals: ['TAVG', 'SUB-MARGIN', 'CET-AVG'].map(ref => ({ ref, role: 'context' })) },
      { kind: 'alarms', scope: 'related' },
    ])
    expect(twoMeasurements.composed.view.height).toBeLessThanOrEqual(640)
  })

  test('reject a second trend panel, too many strips, a lone alarms panel and oversized displays', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PT-455', role: 'primary' }] },
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PZR-LVL', role: 'context' }] },
    ])))).toContain('use one trend panel and list every signal whose history matters in it')
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '10m', signals: ['PT-455', 'PZR-LVL', 'GEN-MW', 'TAVG', 'SG-A-PRESS'].map((ref, index) => ({ ref, role: index === 0 ? 'primary' : 'context' })) },
    ])))).toContain('a trend stacks at most 4 strips, one per measurement (parallel equipment shares one), but these signals are 5 measurements: [Pressurizer pressure, MPa] PT-455')
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([{ kind: 'alarms', scope: 'plant' }]))))
      .toContain('an alarms panel accompanies signal panels')
    const six = ['A', 'B', 'C', 'D'].map(loop => ({ ref: `RCP-${loop}-FLOW`, role: 'context' }))
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PT-455', role: 'primary' }] },
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PZR-LVL', role: 'context' }] },
      { kind: 'comparison', signals: six },
      { kind: 'readouts', signals: [...six, { ref: 'TAVG', role: 'context' }, { ref: 'SUB-MARGIN', role: 'context' }] },
    ])))).toContain('panels: Too big')
    const oversized = rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PT-455', role: 'primary' }, { ref: 'PZR-LVL', role: 'context' }, { ref: 'GEN-MW', role: 'context' }] },
      { kind: 'comparison', signals: six },
      { kind: 'readouts', signals: ['TAVG', 'SUB-MARGIN', 'CET-AVG', 'SG-A-PRESS', 'SG-B-PRESS', 'SG-C-PRESS'].map(ref => ({ ref, role: 'context' })) },
    ])))
    expect(oversized).toContain('even with its trend at the smallest height, but chat views allow 640 (panels.0 trend (3 strips)')
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
      { kind: 'readouts', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
    ])))).toContain('"SG-B-LVL-NR" is already shown in panels.0 (trend); a readouts adds nothing for it')
    const { view } = composeView([
      { kind: 'comparison', signals: ['A', 'B', 'C', 'D'].map(loop => ({ ref: `SG-${loop}-LVL-NR`, role: loop === 'B' ? 'primary' : 'context' })) },
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
    ])
    expect(view.display.panels.map(panel => panel.kind)).toEqual(['comparison', 'trend'])
  })

  test('compare parallel loops of one unit with primary thresholds', () => {
    const { view } = composeView([{ kind: 'comparison', signals: ['A', 'B', 'C', 'D'].map(loop => ({ ref: `RCP-${loop}-FLOW`, role: loop === 'B' ? 'primary' : 'context' })) }])
    const panel = view.display.panels[0] as { kind: string; unit: string; pens: unknown[]; thresholds: Array<{ value: number; signals: string[] }> }
    expect([panel.kind, panel.unit, panel.pens.length]).toEqual(['comparison', 'kg/s', 4])
    expect(panel.thresholds.map(threshold => [threshold.value, threshold.signals])).toEqual([[2500, ['RCP-A-FLOW', 'RCP-B-FLOW', 'RCP-C-FLOW', 'RCP-D-FLOW']]])
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'comparison', signals: [{ ref: 'RCP-A-FLOW', role: 'primary' }, { ref: 'PT-455', role: 'context' }] },
    ])))).toContain('a comparison shares one value axis')
  })

  test('show on/off states as readouts but never as trends', () => {
    const { view } = composeView([{ kind: 'readouts', signals: [{ ref: 'RCP-A-RUN', role: 'primary' }, { ref: 'PT-455', role: 'context' }] }])
    const panel = view.display.panels[0] as { pens: Array<{ valueKind: string }> }
    expect(panel.pens.map(pen => pen.valueKind)).toEqual(['boolean', 'number'])
    expect(rejectionOf(() => ask('world.process-plant.display.compose', display([
      { kind: 'trend', horizon: '2m', signals: [{ ref: 'RCP-A-RUN', role: 'primary' }] },
    ])))).toContain('use a readouts panel for states')
  })

  test('relate an alarms panel to the I&C rules acting on the displayed signals and their equipment', () => {
    const { composed, view } = composeView([
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
      { kind: 'alarms', scope: 'related' },
    ])
    const alarms = view.display.panels[1] as { kind: string; ruleIds: string[] }
    expect(alarms.ruleIds).toEqual(expect.arrayContaining(['sg-b-feedwater-low', 'sg-b-level-low', 'sg-b-level-low-low-afw-actuation']))
    expect(alarms.ruleIds.every(ruleId => !ruleId.startsWith('sg-a-'))).toBe(true)
    expect(composed.shows.at(-1)).toContain(`${alarms.ruleIds.length} I&C rules acting on the displayed signals and their equipment`)
    const pressurizer = composeView([
      { kind: 'trend', horizon: '2m', signals: [{ ref: 'PT-455', role: 'primary' }] },
      { kind: 'alarms', scope: 'related' },
    ]).view.display.panels[1] as { ruleIds: string[] }
    expect(pressurizer.ruleIds.some(ruleId => ruleId.includes('relief'))).toBe(true)
  })
})

describe('world.process-plant.display.view and sample', () => {
  const composed = ask('world.process-plant.display.compose', composition([
    { ref: 'PT-455', role: 'primary' },
  ], '2m')) as { view: { state: string } }

  test('view recompiles the composed state for rendering', () => {
    const later = '2026-10-08T21:05:00.000Z' as IsoTimestamp
    const view = ask('world.process-plant.display.view', { plantId: compiled.id, state: composed.view.state }, later) as {
      issuedAt: string
      simulationTime: string
      modelChanged: boolean
      display: { panels: ReadonlyArray<{ horizonMs: number; strips: ReadonlyArray<{ unit: string; pens: ReadonlyArray<{ path: string; seriesId: string; thresholds: ReadonlyArray<unknown> }> }> }> }
    }
    expect(view).toMatchObject({ plantLabel: null, issuedAt: simulationTime, simulationTime: later, modelChanged: false })
    expect(view.display.panels[0]).toMatchObject({ horizonMs: 120_000 })
    const strip = view.display.panels[0]!.strips[0]!
    expect(strip.unit).toBe('MPa')
    expect(strip.pens[0]!.seriesId).toStartWith('series:')
    expect(strip.pens[0]!.thresholds.length).toBe(8)
  })

  test('view keeps rendering displays that later authoring rules would reject', () => {
    const repeated = {
      ...composition([]),
      panels: [
        { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
        { kind: 'readouts', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] },
      ],
    }
    expect(rejectionOf(() => ask('world.process-plant.display.compose', repeated))).toContain('a readouts adds nothing for it')
    const state = JSON.stringify({ composition: repeated, issuedAt: simulationTime, modelDigest: compiled.modelDigest })
    const view = ask('world.process-plant.display.view', { plantId: compiled.id, state }) as { display: { panels: unknown[] } }
    expect(view.display.panels).toHaveLength(2)
    // Displays composed before trends stacked their own strips keep rendering.
    const twoTrends = { ...repeated, panels: [
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PT-455', role: 'primary' }] },
      { kind: 'trend', horizon: '10m', signals: [{ ref: 'PZR-LVL', role: 'context' }] },
    ] }
    const earlier = ask('world.process-plant.display.view', { plantId: compiled.id, state: JSON.stringify({ composition: twoTrends, issuedAt: simulationTime, modelDigest: compiled.modelDigest }) }) as { display: { panels: unknown[] } }
    expect(earlier.display.panels).toHaveLength(2)
    const missing = JSON.stringify({ composition: { ...repeated, panels: [{ kind: 'trend', horizon: '10m', signals: [{ ref: 'NO-SUCH-TAG', role: 'primary' }] }] }, issuedAt: simulationTime, modelDigest: compiled.modelDigest })
    const message = rejectionOf(() => ask('world.process-plant.display.view', { plantId: compiled.id, state: missing }))
    expect(message).toStartWith('This display can no longer be shown for the current Plant model')
    expect(message).not.toContain('call world.process-plant.display.compose')
  })

  test('view refuses unsupported formats and another Plant', () => {
    expect(rejectionOf(() => ask('world.process-plant.display.view', { plantId: compiled.id, state: '{"composition":{}}' }))).toContain('Unsupported display format')
    const foreign = JSON.stringify({ ...JSON.parse(composed.view.state), composition: { ...JSON.parse(composed.view.state).composition, plantId: 'plant:other' } })
    expect(rejectionOf(() => ask('world.process-plant.display.view', { plantId: compiled.id, state: foreign }))).toContain('targets plant:other')
  })

  test('sample reads current values at the Run time and refuses unknown paths', () => {
    const pressure = compiled.graph.signalBindingByTagId.get('PT-455' as never)!.path
    const sample = ask('world.process-plant.display.sample', { plantId: compiled.id, paths: [pressure] }) as {
      simulationTime: string
      values: ReadonlyArray<{ path: string; value: unknown; quality: string }>
    }
    expect(sample.simulationTime).toBe(simulationTime)
    expect(sample.values[0]).toMatchObject({ path: pressure, quality: 'good' })
    const withAlarms = ask('world.process-plant.display.sample', { plantId: compiled.id, paths: [pressure], alarms: true })
    expect(withAlarms).toMatchObject({ alarms: [], plantElapsedMs: 0 })
    expect(typeof sample.values[0]!.value).toBe('number')
    expect(rejectionOf(() => ask('world.process-plant.display.sample', { plantId: compiled.id, paths: ['nowhere.value' as VariablePath] }))).toContain('signal path not found')
  })
})

test('composed display operations are published read-only Capabilities', () => {
  const ids = ['world.process-plant.display.compose', 'world.process-plant.display.view', 'world.process-plant.display.sample']
  for (const id of ids) {
    const capability = processPlantCapabilities.find(candidate => candidate.id === id)
    expect(capability?.kind).toBe('query')
  }
})
