import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import type { MimicNode, MimicPipe } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import type { ComposedDisplayAlarm, ComposedDisplaySample } from '../src/ui/embed/composed-display/composed-display-client.ts'
import { openBridgeIcons } from '../src/ui/embed/composed-display/mimic/openbridge-icons.ts'
import { chevrons, crossings, flowLook, indexSample, levelLook, nodeAlarm, pumpLook, reliefLook, valveLook } from '../src/ui/embed/composed-display/mimic/mimic-state.ts'

const sample = (values: Record<string, number | boolean>, quality: Record<string, string> = {}): ComposedDisplaySample => ({
  simulationTime: '2026-10-09T10:00:00.000Z',
  plantElapsedMs: 0,
  values: Object.entries(values).map(([path, value]) => ({ path, value, quality: (quality[path] ?? 'good') as 'good' })),
})

const node = (overrides: Partial<MimicNode>): MimicNode => ({
  id: 'n', componentId: 'c', symbol: 'pump', label: 'P', x: 0, y: 0, width: 16, height: 16, orientation: 'horizontal',
  state: { kind: 'none' }, values: [], ruleIds: [], ...overrides,
} as MimicNode)

const pump = node({ state: { kind: 'pump', speedPath: 'p.speedRpm', commandPath: 'p.running' } as never })
const valve = node({ symbol: 'valve', state: { kind: 'valve', positionPath: 'v.effectivePositionFraction', commandPath: 'v.positionFraction' } as never })
const pipe: MimicPipe = { id: 'pipe', linkId: 'l', service: 'feedwater', points: [[0, 0], [0, 30], [40, 30]], flowPath: 'l.flowKgPerS' as never, noFlowBelow: 2 }

describe('mimic symbol states', () => {
  test('a pump runs only when it turns, and says when its command disagrees', () => {
    expect(pumpLook(pump, indexSample(sample({ 'p.speedRpm': 4500, 'p.running': true })))).toEqual({ look: 'on', mismatch: null })
    // Loss of power: commanded on, not turning.
    expect(pumpLook(pump, indexSample(sample({ 'p.speedRpm': 0, 'p.running': true })))).toEqual({ look: 'off', mismatch: 'CMD RUN · STOPPED' })
    expect(pumpLook(pump, indexSample(sample({ 'p.running': true }))).look).toBe('unknown')
  })

  test('a valve is drawn from its actual position, a stuck one says so, and full positions need no number', () => {
    const stuck = valveLook(valve, indexSample(sample({ 'v.effectivePositionFraction': 0.35, 'v.positionFraction': 1 })))
    expect(stuck).toEqual({ icon: 'twoway-analog-25', position: 0.35, mismatch: 'CMD 100 % · POS 35 %', tagged: true })
    expect(valveLook(valve, indexSample(sample({ 'v.effectivePositionFraction': 1, 'v.positionFraction': 1 })))).toEqual({ icon: 'twoway-analog-open', position: 1, mismatch: null, tagged: false })
    expect(valveLook(valve, indexSample(sample({ 'v.effectivePositionFraction': 0, 'v.positionFraction': 0 }))).icon).toBe('twoway-analog-closed')
    // An unknown or out-of-range position is never drawn as a position.
    expect(valveLook(valve, indexSample(sample({ 'v.effectivePositionFraction': 2 }, { 'v.effectivePositionFraction': 'outside-hard-range' })))).toEqual({ icon: 'twoway-digital-static', position: null, mismatch: null, tagged: true })
  })

  test('a relief valve the model does not measure reads by its flow, and a stuck-open one says so', () => {
    const porv = node({ symbol: 'relief-valve', state: { kind: 'relief', flowPath: 'r.flow', commandPath: 'r.command', noFlowBelow: 0.2 } as never })
    // PORV stuck open (run 7): commanded shut, passing 7.7 kg/s.
    expect(reliefLook(porv, indexSample(sample({ 'r.flow': 7.69, 'r.command': 0 })))).toEqual({ icon: 'twoway-analog-open', passing: true, mismatch: 'CMD SHUT · PASSING' })
    expect(reliefLook(porv, indexSample(sample({ 'r.flow': 0, 'r.command': 0 })))).toEqual({ icon: 'twoway-analog-closed', passing: false, mismatch: null })
    expect(reliefLook(porv, indexSample(sample({ 'r.flow': 0, 'r.command': 1 }))).mismatch).toBe('CMD OPEN · NO FLOW')
  })

  test('pipes show flow, reverse flow, no flow below their band, or unknown', () => {
    expect(flowLook(pipe, indexSample(sample({ 'l.flowKgPerS': 83 })))).toEqual({ look: 'forward', value: 83 })
    expect(flowLook(pipe, indexSample(sample({ 'l.flowKgPerS': -12 }))).look).toBe('reverse')
    expect(flowLook(pipe, indexSample(sample({ 'l.flowKgPerS': 6.9e-7 }))).look).toBe('none')
    expect(flowLook(pipe, indexSample(sample({}))).look).toBe('unknown')
  })

  test('levels fill their vessel and flag values beyond its span', () => {
    const sg = node({ symbol: 'steam-generator', state: { kind: 'level', levelPath: 's.levelPercent', unit: 'percent' } as never })
    const level = levelLook(sg, indexSample(sample({ 's.levelPercent': 29.6 })))
    expect(level.fraction).toBeCloseTo(0.296, 9)
    expect(level.offScale).toBeNull()
    expect(levelLook(sg, indexSample(sample({ 's.levelPercent': 104 })))).toEqual({ fraction: 1, offScale: 'high' })
  })

  test('the most severe active alarm on the equipment frames it, trips first', () => {
    const alarm = (ruleId: string, kind: 'alarm' | 'trip', severity: ComposedDisplayAlarm['severity']): ComposedDisplayAlarm =>
      ({ id: ruleId, ruleId, kind, title: ruleId, severity, acknowledged: false, firstOut: false })
    const framed = node({ ruleIds: ['low', 'low-low'] })
    expect(nodeAlarm(framed, [alarm('low', 'alarm', 'warning'), alarm('low-low', 'trip', 'critical'), alarm('other', 'trip', 'critical')])?.ruleId).toBe('low-low')
    expect(nodeAlarm(framed, [alarm('other', 'trip', 'critical')])).toBeNull()
  })

  test('chevrons sit a third along the longest segment; crossings bridge headers and pipes', () => {
    expect(chevrons([[0, 0], [0, 30], [40, 30]])).toEqual([{ x: 40 / 3, y: 30, angle: 0 }])
    expect(chevrons([[0, 0], [0, 8]])).toEqual([])
    const drop: MimicPipe = { ...pipe, id: 'drop', points: [[50, 60], [50, 0]] }
    expect(crossings([drop], [{ id: 'header', x: 0, y: 30, width: 100 }])).toEqual([{ x: 50, y: 30, over: 'header' }])
  })
})

describe('OpenBridge drawings', () => {
  // The mimic copies OpenBridge's token-styled icon drawings; an upgrade that
  // changes them must fail here so the copy is regenerated and reviewed.
  test('match the installed OpenBridge icons', async () => {
    const iconsDir = join(dirname(Bun.resolveSync('@oicl/openbridge-webcomponents/dist/icons/icon-pump-on-horizontal.js', import.meta.dir)))
    for (const [name, inner] of Object.entries(openBridgeIcons)) {
      const source = await Bun.file(join(iconsDir, `icon-${name}.js`)).text()
      const drawn = source.match(/this\.iconCss = svg`([\s\S]*?)`;/)?.[1]?.trim().replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').trim()
      expect(drawn).toBe(inner)
    }
  })
})
