import { expect, test } from 'bun:test'
import { isoTimestampSchema } from '../src/core/model/time.ts'
import type { Observation } from '../src/core/observation/model.ts'
import type { TopologyBinding } from '../src/core/observation/topology.ts'
import type { VignetteValue } from '../src/features/displays/compose/model.ts'
import type { LayoutOperationalSubject, LayoutSubjectTopology } from '../src/features/displays/layout/operation.ts'
import { resolvePhysicalSubjectOperation } from '../src/ui/physical-layout/operation.ts'
import { layoutSubjectTopologies, layoutTopologyRefs } from '../src/features/displays/layout/topology.ts'
import { topologyGraphSchema } from '../src/core/observation/topology.ts'
import { physicalOperationContext, physicalOperationBadgeWord, physicalOperationWord } from '../src/ui/physical-layout/operation-presentation.ts'
import { layoutLiveResponseSchema } from '../src/ui/physical-layout/read-model.ts'
import { physicalSubjectStatus } from '../src/ui/physical-layout/status.ts'

const at = isoTimestampSchema.parse('2026-10-28T00:00:00Z')
const value = (ref: string, patch: Partial<VignetteValue> = {}): VignetteValue => ({ ref: `plant:one#${ref}`, label: ref, quantity: 'flow', unit: 'kg/s', valueType: 'number', thresholds: [], series: null, ...patch })
const observation = (declared: VignetteValue, raw: Observation['value'], quality: Observation['quality'] = 'good'): Observation => ({ ref: declared.ref, at, clock: 'simulation', value: raw, quality, priority: 'none' })
const binding = (role: TopologyBinding['role'], declaration: VignetteValue, patch: Partial<TopologyBinding> = {}): TopologyBinding => ({ role, ref: declaration.ref, ...patch })
const subject = (bindings: TopologyBinding[], values: VignetteValue[], node = false): LayoutOperationalSubject => ({ elementId: node ? 'pump' : 'pipe', label: node ? 'Pump' : 'Pump to valve', topology: {
  bindings, values, ...(node ? { kind: 'node', class: 'mover', equipmentKind: 'centrifugal-pump' } : { kind: 'connection', from: { elementId: 'pump', label: 'Pump', port: 'outlet' }, to: { elementId: 'valve', label: 'Valve', port: 'inlet' }, medium: { id: 'feedwater', label: 'Feedwater', kind: 'fluid' }, directed: true }),
} as LayoutSubjectTopology })

test('layout status uses actual owner conduction before a false degraded flag, preserving unknown and frozen state', () => {
  const degradation = value('bus.degraded', { quantity: 'state', unit: '', valueType: 'boolean', states: [{ value: 'true', label: 'Voltage degraded' }, { value: 'false', label: 'Voltage normal' }] })
  const conducting = value('bus.state', { quantity: 'state', unit: '', valueType: 'enum', states: [{ value: 'on', label: 'LIVE', active: true }, { value: 'off', label: 'DEAD' }] })
  const bus = subject([binding('conducting', conducting)], [conducting], true)
  const owner = { packId: 'process-plant', objectId: 'plant:one', elementId: bus.elementId, label: bus.label }
  for (const [raw, word] of [['on', 'LIVE'], ['off', 'DEAD']] as const) {
    const observations = [observation(degradation, false), observation(conducting, raw)]
    const operation = resolvePhysicalSubjectOperation(bus, observations, false)
    expect(physicalSubjectStatus({ subject: owner, values: [degradation], observations, operation }, [], false).word).toBe(word)
  }
  for (const quality of ['bad', 'uncertain', 'stale', 'not-applicable'] as const) {
    const observations = [observation(degradation, false), observation(conducting, 'off', quality)]
    const operation = resolvePhysicalSubjectOperation(bus, observations, false)
    const status = physicalSubjectStatus({ subject: owner, values: [degradation], observations, operation }, [], false)
    expect(status.word).toBeNull()
    if (quality !== 'not-applicable') expect(status.quality).toBe(quality)
  }
  const observations = [observation(degradation, false)]
  const operation = resolvePhysicalSubjectOperation(bus, observations, false)
  expect(physicalSubjectStatus({ subject: owner, values: [degradation], observations, operation }, [], false)).toMatchObject({ word: null, quality: 'bad' })
  expect(physicalSubjectStatus({ subject: owner, values: [degradation], observations, operation }, [], true)).toMatchObject({ word: null, quality: 'stale' })
})

test('default state words follow actuating topology classes while repeated converter labels remain opt-in', () => {
  const run = value('running', { quantity: 'state', unit: '', valueType: 'boolean' }), source = subject([binding('running', run)], [run], true)
  const mover = resolvePhysicalSubjectOperation(source, [observation(run, true)], false)
  expect(physicalOperationBadgeWord(mover, false)).toBe(physicalOperationWord(mover))
  const converter = { ...mover, equipment: { ...mover.equipment!, class: 'converter' as const } }
  expect(physicalOperationBadgeWord(converter, false)).toBeNull()
  expect(physicalOperationBadgeWord(converter, true)).toBe(physicalOperationWord(converter))
  const control = { ...mover, equipment: { ...mover.equipment!, class: 'switch' as const } }
  expect(physicalOperationBadgeWord(control, false)).toBe(physicalOperationWord(control))
  expect(physicalOperationContext(converter).some(row => row.label === 'Equipment')).toBe(true)
})

test('actual signed flow follows admitted endpoint order and exact zero, without a UI no-flow band', () => {
  const flow = value('pipe.flow'), s = subject([binding('flow', flow)], [flow])
  for (const [raw, direction, state] of [[10, 'forward', 'flowing'], [-2, 'reverse', 'flowing'], [0, 'stopped', 'stopped'], [-0, 'stopped', 'stopped'], [1e-15, 'forward', 'flowing']] as const) {
    const result = resolvePhysicalSubjectOperation(s, [observation(flow, raw)], false)
    expect(result.flow?.direction).toBe(direction); expect(result.flow?.state).toBe(state); expect(result.flow?.value).toBe(raw)
    expect(result.connection?.from).toEqual({ elementId: 'pump', label: 'Pump', port: 'outlet' })
    const context = physicalOperationContext(result)
    expect(context.map(row => row.label)).toEqual(['From', 'To', 'Medium', 'Flow'])
    expect(context[0]).toEqual({ label: 'From', value: 'Pump · outlet' })
    expect(context[1]).toEqual({ label: 'To', value: 'Valve · inlet' })
  }
})

test('missing, stale, uncertain and bad readings never fabricate no-flow or stopped equipment', () => {
  const flow = value('flow'), run = value('running', { quantity: 'state', unit: '', valueType: 'boolean' }), s = subject([binding('flow', flow), binding('running', run)], [flow, run], true)
  for (const quality of ['bad', 'stale', 'uncertain', 'not-applicable'] as const) {
    const result = resolvePhysicalSubjectOperation(s, [observation(flow, 0, quality), observation(run, false, quality)], false)
    expect(result.flow?.state).toBe('unknown'); expect(result.equipment?.running?.active).toBeNull()
  }
  const frozen = resolvePhysicalSubjectOperation(s, [observation(flow, 5), observation(run, true)], true)
  expect(frozen.flow?.direction).toBe('unknown'); expect(frozen.flow?.quality).toBe('stale'); expect(frozen.equipment?.running?.active).toBeNull()
  expect(resolvePhysicalSubjectOperation(s, [], false).flow?.quality).toBe('not-observed')
  expect(resolvePhysicalSubjectOperation(s, [{ ...observation(run, null, 'not-applicable'), why: 'position not measured' }], false).equipment?.running?.reason).toBe('position not measured')
})

test('equipment throughput and energized-only electrical links do not invent spatial flow direction', () => {
  const flow = value('throughput'), node = subject([binding('flow', flow)], [flow], true)
  const result = resolvePhysicalSubjectOperation(node, [observation(flow, 100)], false)
  expect(result.flow?.state).toBe('flowing'); expect(result.flow?.direction).toBe('unknown')
  const energized = value('energized', { quantity: 'state', unit: '', valueType: 'boolean' }), cable = subject([binding('conducting', energized)], [energized])
  const live = resolvePhysicalSubjectOperation(cable, [observation(energized, true)], false)
  expect(live.flow).toBeNull(); expect(live.conducting?.active).toBe(true)
})

test('pump state uses actual owner state words and active flags, independently from flow', () => {
  const running = value('pump.state', { quantity: 'state', unit: '', valueType: 'enum', states: [{ value: 'on', label: 'RUN', active: true }, { value: 'off', label: 'STOP' }] })
  const s = subject([binding('running', running)], [running], true)
  expect(resolvePhysicalSubjectOperation(s, [observation(running, 'off')], false).equipment?.running).toMatchObject({ active: false, word: 'STOP' })
  expect(resolvePhysicalSubjectOperation(s, [observation(running, 'on')], false).equipment?.running).toMatchObject({ active: true, word: 'RUN' })
  expect(resolvePhysicalSubjectOperation(s, [observation(running, 'undeclared')], false).equipment?.running?.active).toBeNull()
})

test('valve position retains owner travel words and units without deriving flow or clamping invalid travel', () => {
  const position = value('position', { quantity: 'fraction', unit: '%', travel: { below: 2, above: 98, low: 'SHUT', high: 'OPEN' } }), s = subject([binding('position', position)], [position], true)
  expect(resolvePhysicalSubjectOperation(s, [observation(position, 1)], false).equipment?.positions[0]).toMatchObject({ fraction: .01, word: 'SHUT', value: 1 })
  expect(resolvePhysicalSubjectOperation(s, [observation(position, 99)], false).equipment?.positions[0]).toMatchObject({ fraction: .99, word: 'OPEN' })
  const middle = resolvePhysicalSubjectOperation(s, [observation(position, 40)], false)
  expect(middle.equipment?.positions[0]?.fraction).toBe(.4); expect(middle.flow).toBeNull()
  expect(resolvePhysicalSubjectOperation(s, [observation(position, 110)], false).equipment?.positions[0]?.fraction).toBeNull()
})

test('conditional bindings acquire their guard and unknown guards prevent a definite fallback', () => {
  const first = value('first'), alternate = value('alternate'), guard = value('guard', { quantity: 'state', unit: '', valueType: 'boolean' })
  const s = subject([binding('flow', first), binding('flow', alternate, { while: guard.ref })], [first, alternate, guard])
  const readings = [observation(first, 2), observation(alternate, -3)]
  expect(resolvePhysicalSubjectOperation(s, [...readings, observation(guard, false)], false).flow?.direction).toBe('forward')
  expect(resolvePhysicalSubjectOperation(s, [...readings, observation(guard, true)], false).flow?.direction).toBe('reverse')
  expect(resolvePhysicalSubjectOperation(s, readings, false).flow?.state).toBe('unknown')
  expect(resolvePhysicalSubjectOperation(s, [...readings, observation(guard, false)], true).flow?.quality).toBe('stale')
})

test('separate independent flows are retained and never silently collapsed into one arrow', () => {
  const a = value('a'), b = value('b'), result = resolvePhysicalSubjectOperation(subject([binding('flow', a), binding('flow', b)], [a, b]), [observation(a, 3), observation(b, -5)], false)
  expect(result.flow).toBeNull(); expect(result.flows.map(flow => flow.direction)).toEqual(['forward', 'reverse'])
  expect(resolvePhysicalSubjectOperation({ elementId: 'old', label: 'Retained source' }, [], false).flow).toBeNull()
})

test('client boundary refuses cross-owner, unacquired and undeclared semantic bindings', () => {
  const flow = value('flow'), s = subject([binding('flow', flow)], [flow]), response = {
    scope: { runId: 'run-test', layoutObjectId: 'layout:one', revision: 'rev', objectId: 'plant:one', packId: 'process-plant', modelDigest: 'a'.repeat(64), epoch: 'epoch', sequence: 1 }, acquiredAt: at,
    sample: { at: { at, clock: 'simulation', paused: true }, observations: [observation(flow, 10)], alerts: [], entities: {}, slots: {}, maps: {} }, subjects: [{ ...s, values: [], word: null, devices: [] }],
  }
  expect(layoutLiveResponseSchema.safeParse(response).success).toBe(true)
  expect(layoutLiveResponseSchema.safeParse({ ...response, sample: { ...response.sample, observations: [] } }).success).toBe(false)
  const foreign = { ...flow, ref: 'plant:other#flow' }
  expect(layoutLiveResponseSchema.safeParse({ ...response, subjects: [{ ...response.subjects[0], topology: { ...s.topology, values: [foreign] } }] }).success).toBe(false)
  expect(layoutLiveResponseSchema.safeParse({ ...response, subjects: [{ ...response.subjects[0], topology: { ...s.topology, bindings: [{ role: 'flow', ref: 'plant:one#not-read' }] } }] }).success).toBe(false)
})


test('hover connection context retains exact incident owner links, with element aliases and no extra observation acquisition', () => {
  const flow = value('header.flow')
  const graph = topologyGraphSchema.parse({ objectId: 'plant:one', revision: 'same-owner', family: 'flow', media: [{ id: 'water', label: 'Water', kind: 'fluid' }], groups: [], boundaries: [],
    nodes: ['header-node', 'valve-node', 'unrelated-node', 'isolated-node'].map((id, index) => ({ id, element: ['header', 'valve', 'unrelated', 'isolated'][index], label: id, rank: id, kind: 'header', class: 'junction', ports: [{ id: 'port', rank: 'port', media: ['water'], direction: 'both' }], bindings: index ? [] : [binding('flow', flow)] })),
    edges: [{ id: 'header-to-valve', rank: 'one', from: { node: 'header-node', port: 'port' }, to: { node: 'valve-node', port: 'port' }, medium: 'water', directed: true, bindings: [] },
      { id: 'unrelated-loop', rank: 'two', from: { node: 'unrelated-node', port: 'port' }, to: { node: 'unrelated-node', port: 'port' }, medium: 'water', directed: false, bindings: [] }] })
  const projected = layoutSubjectTopologies(graph, ['header', 'valve', 'unrelated', 'isolated', 'header-to-valve']), header = projected.get('header')!
  expect(header.kind).toBe('node'); if (header.kind !== 'node') throw Error('Expected node')
  expect(header.connections).toEqual([{ id: 'header-to-valve', from: { elementId: 'header', label: 'header-node', port: 'port' }, to: { elementId: 'valve', label: 'valve-node', port: 'port' }, medium: graph.media[0]!, directed: true }])
  expect(layoutTopologyRefs(header)).toEqual([flow.ref]);expect(layoutTopologyRefs(projected.get('header-to-valve')!)).toEqual([])
  const unrelated = projected.get('unrelated')!; expect(unrelated.kind === 'node' && unrelated.connections).toHaveLength(1)
  const isolated = projected.get('isolated')!; expect(isolated.kind === 'node' && isolated.connections).toEqual([])
  const operation = resolvePhysicalSubjectOperation({ elementId: 'header', label: 'Header', topology: { ...header, values: [flow] } }, [observation(flow, 10)], false)
  expect(operation.connection).toBeNull(); expect(operation.flow?.direction).toBe('unknown')
  expect(physicalOperationContext(operation)[0]).toEqual({ label: 'Component-level connection', value: 'header-node · port → valve-node · port · Water' })
})

test('component-level context distinguishes omitted topology connectivity from an explicitly empty declaration', () => {
  const node = subject([], [], true)
  expect(physicalOperationContext(resolvePhysicalSubjectOperation(node, [], false))).toEqual([])
  const topology = node.topology!; if (topology.kind !== 'node') throw Error('Expected node')
  expect(physicalOperationContext(resolvePhysicalSubjectOperation({ ...node, topology: { ...topology, connections: [] } }, [], false))).toEqual([{ label: 'Component-level connections', value: 'None declared in owner topology' }])
})

test('client rejects duplicate/nonincident node connectivity and retains exact current-owner acquisition scope', () => {
  const node = subject([], [], true), topology = node.topology!; if (topology.kind !== 'node') throw Error('Expected node')
  const connection = { id: 'pump-to-valve', from: { elementId: 'pump', label: 'Pump', port: 'out' }, to: { elementId: 'valve', label: 'Valve', port: 'in' }, medium: { id: 'water', label: 'Water', kind: 'fluid' }, directed: true }
  const response = { scope: { runId: 'run-test', layoutObjectId: 'layout:one', revision: 'rev', objectId: 'plant:one', packId: 'process-plant', modelDigest: 'a'.repeat(64), epoch: 'epoch', sequence: 1 }, acquiredAt: at,
    sample: { at: { at, clock: 'simulation', paused: true }, observations: [], alerts: [], entities: {}, slots: {}, maps: {} }, subjects: [{ ...node, values: [], word: null, devices: [], topology: { ...topology, connections: [connection] } }] }
  expect(layoutLiveResponseSchema.safeParse(response).success).toBe(true)
  for (const connections of [[connection, connection], [{ ...connection, from: { ...connection.from, elementId: 'foreign-node' } }], [{ ...connection, objectId: 'plant:other' }]]) {
    expect(layoutLiveResponseSchema.safeParse({ ...response, subjects: [{ ...response.subjects[0], topology: { ...topology, connections } }] }).success).toBe(false)
  }
})
