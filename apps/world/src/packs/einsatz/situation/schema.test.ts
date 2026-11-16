import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { commandIdSchema } from '../../../core/model/index.ts'
import { capabilityJsonSchema } from '../../../simulation/capabilities.ts'
import { unitOrderInputSchema, unitRecallInputSchema, unitStopRemoveInputSchema, unitUndoInputSchema } from '../order-schema.ts'
import { recommendAnswerSchema } from '../recommendation-schema.ts'
import { refusal, refusalCode } from '../refusal.ts'
import { situationInputSchema, situationSchema, unitOptionsInputSchema, unitOptionsSchema } from './schema.ts'

/** Through JSON and back: what a Capability answers is what the browser and agents read. */
const roundTrip = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => schema.parse(JSON.parse(JSON.stringify(schema.parse(value))))

const point = { type: 'Point', coordinates: [10.5, 59.9] }
const routed = { kind: 'routed', seconds: 240, distanceM: 3_100 }
const viewer = { label: 'Operator', isViewer: true }
const priority = { id: 'p1', label: 'Highest', code: 'P1', rank: 0, responseTargetS: 720 }
const order = { units: ['unit:u-1'], stops: [{ taskId: 'task:t-1' }] }

const situation = {
  counts: { calls: [{ priorityId: 'p1', code: 'P1', count: 1 }], oldestWaitingS: 160, freeUnits: 1, units: 2, acceptingSites: 1, sites: 1 },
  calls: [{
    id: 'task:t-1', label: 'T-1 First', icon: 'circle', templateLabel: 'Job', priority, waitingS: 160, overdue: false,
    needs: [
      { kind: 'requirement', provides: 'svc', label: '2 movers', where: ['Capacity ≥ 2,000 l'], count: 2, enRoute: 1, onTask: 0, completed: 0 },
      { kind: 'load', classId: 'k1', code: 'K', label: '1 item', waiting: 1, covered: 0 },
    ],
    assigned: [{ unitId: 'unit:u-2', label: 'U-2', phase: 'en-route', status: { word: 'En route', tone: 'busy' }, eta: routed, by: viewer }],
    states: [{ code: 'overdue', text: 'Overdue' }],
  }],
  units: [{
    id: 'unit:u-2', label: 'U-2', icon: 'circle', typeLabel: 'Mover', group: { id: 'g1', label: 'Movers' },
    status: { word: 'En route', tone: 'busy' }, phase: 'en-route', phaseDueInS: null,
    plan: [
      { id: 'step-1', verb: 'pick-up', target: { taskId: 'task:t-1' }, label: 'T-1 First', state: 'active', eta: routed, by: viewer },
      { id: 'step-2', verb: 'go-to', target: { point }, label: 'a map point', state: 'queued', eta: { kind: 'straight-line', seconds: 300, distanceM: 4_000 }, by: { label: 'Assistant', isViewer: false } },
    ],
    predictedDelivery: { siteId: 'unit:s-1', label: 'S-1', eta: { kind: 'unavailable', reason: 'no_road_near_point: 1.4 km from a road', straightDistanceM: 2_000 } },
    lastOrder: { by: viewer, commandId: 'cmd-1' },
    carry: { capacity: 1, load: [] },
    properties: [{ id: 'cap', label: 'Capacity', value: '3,000 l' }],
    commandedBy: null,
    states: [],
  }],
  sites: [{
    id: 'unit:s-1', label: 'S-1', icon: 'square', typeLabel: 'Depot', accepting: true, slots: { used: 0, total: 2 },
    inbound: [{ unitId: 'unit:u-2', label: 'U-2', eta: null }], states: [],
  }],
  words: { calls: 'Tasks', units: 'Units', sites: 'Sites', send: 'Dispatch', return: 'Return', move: 'Move', close: 'Close', plan: 'Plan', stop: 'Stop', noCalls: 'No tasks', noUnits: 'No units' },
  features: { hasCarry: true, hasSites: true, hasContacts: false, propertyColumns: [{ id: 'cap', label: 'Capacity' }] },
}

const options = {
  unitId: 'unit:u-2',
  busy: { taskId: 'task:t-1', label: 'T-1 First', code: 'P1', freeInS: 400 },
  targets: [{ target: { taskId: 'task:t-2' }, verb: 'serve', label: 'T-2 Second', etaS: 300 }],
  refused: [{ target: { siteId: 'unit:s-1' }, label: 'S-1', code: 'site_not_accepting', text: 'S-1 accepts no arrivals' }],
}

const recommendation = {
  taskId: 'task:t-1',
  priority,
  proposal: { order, units: [{ unitId: 'unit:u-1', label: 'U-1', eta: routed }], covers: { covered: 2, needed: 3 }, remainder: ['1 viewer'] },
  alternatives: [{ need: { kind: 'requirement', id: 'svc', label: 'mover' }, units: [{ unitId: 'unit:u-3', label: 'U-3', eta: routed, order: { units: ['unit:u-3'], stops: [{ taskId: 'task:t-1' }] } }] }],
  whyNot: [{ unitId: 'unit:u-4', label: 'U-4', reasons: ['Capacity 300 l · needs ≥ 2,000 l'] }],
  deliverTo: [{ unitId: 'unit:u-1', label: 'U-1', sites: [{ siteId: 'unit:s-1', label: 'S-1', eta: routed }] }],
}

describe('Einsatz wire schemas', () => {
  test('answers survive JSON unchanged', () => {
    expect(roundTrip(situationSchema, situation)).toEqual(situationSchema.parse(situation))
    expect(roundTrip(unitOptionsSchema, options)).toEqual(unitOptionsSchema.parse(options))
    expect(roundTrip(unitOptionsSchema, { ...options, busy: null })).toEqual(unitOptionsSchema.parse({ ...options, busy: null }))
    expect(roundTrip(recommendAnswerSchema, recommendation)).toEqual(recommendAnswerSchema.parse(recommendation))
    expect(roundTrip(recommendAnswerSchema, { ...recommendation, proposal: null, deliverTo: [] }).proposal).toBeNull()
  })

  test('a proposal is a valid unit.order input', () => {
    const answer = recommendAnswerSchema.parse(recommendation)
    expect(unitOrderInputSchema.parse(answer.proposal!.order)).toEqual(order)
    expect(unitOrderInputSchema.parse(answer.alternatives[0]!.units[0]!.order).units).toEqual(['unit:u-3'])
  })

  test('answers are strict and closed', () => {
    expect(situationSchema.safeParse({ ...situation, extra: 1 }).success).toBe(false)
    expect(situationSchema.safeParse({ ...situation, calls: [{ ...situation.calls[0], new: true }] }).success).toBe(false)
    expect(situationSchema.safeParse({ ...situation, words: { ...situation.words, board: 'Board' } }).success).toBe(false)
    expect(unitOptionsSchema.safeParse({ ...options, refused: [{ ...options.refused[0], code: 'not_a_code' }] }).success).toBe(false)
    expect(situationSchema.safeParse({ ...situation, units: [{ ...situation.units[0], status: { word: 'Free', tone: 'green' } }] }).success).toBe(false)
  })

  test('unit.order takes 1–10 distinct units, 1–20 stops, and drops only with when now', () => {
    const stops = [{ taskId: 'task:t-1' }, { siteId: 'unit:s-1' }, { point }, { trackId: 'track:k-1' }]
    expect(unitOrderInputSchema.parse({ units: ['unit:u-1'], stops }).stops).toHaveLength(4)
    expect(unitOrderInputSchema.parse({ ...order, when: 'after' }).when).toBe('after')
    expect(unitOrderInputSchema.parse({ ...order, when: 'now', drops: 'task:t-9' }).drops).toBe('task:t-9')
    const refused = (input: unknown): boolean => !unitOrderInputSchema.safeParse(input).success
    expect(refused({ units: [], stops: order.stops })).toBe(true)
    expect(refused({ units: Array.from({ length: 11 }, (_, index) => `unit:u-${index}`), stops: order.stops })).toBe(true)
    expect(refused({ units: ['unit:u-1', 'unit:u-1'], stops: order.stops })).toBe(true)
    expect(refused({ units: ['unit:u-1'], stops: [] })).toBe(true)
    expect(refused({ units: ['unit:u-1'], stops: Array.from({ length: 21 }, () => ({ taskId: 'task:t-1' })) })).toBe(true)
    expect(refused({ ...order, drops: 'task:t-9' })).toBe(true)
    expect(refused({ ...order, when: 'after', drops: 'task:t-9' })).toBe(true)
    expect(refused({ ...order, when: 'later' })).toBe(true)
    expect(refused({ units: ['unit:u-1'], stops: [{ taskId: 'task:t-1', siteId: 'unit:s-1' }] })).toBe(true)
    expect(refused({ ...order, divert: [] })).toBe(true)
  })

  test('the plan commands and queries take exactly their fields', () => {
    expect(unitUndoInputSchema.parse({ unitId: 'unit:u-1', commandId: 'cmd-1' })).toEqual({ unitId: 'unit:u-1', commandId: commandIdSchema.parse('cmd-1') })
    expect(unitUndoInputSchema.safeParse({ unitId: 'unit:u-1' }).success).toBe(false)
    expect(unitStopRemoveInputSchema.parse({ unitId: 'unit:u-1', stopId: 'step-2' }).stopId).toBe('step-2')
    expect(unitRecallInputSchema.safeParse({ unitId: 'unit:u-1', fromTaskId: 'task:t-1' }).success).toBe(false)
    expect(situationInputSchema.parse({})).toEqual({})
    expect(situationInputSchema.parse({ group: 'g1' }).group).toBe('g1')
    expect(unitOptionsInputSchema.safeParse({}).success).toBe(false)
  })

  test('the new refusal codes follow the convention', () => {
    for (const code of ['when_required', 'drops_mismatch', 'newer_order_exists', 'nothing_to_undo'] as const)
      expect(refusalCode(refusal(code, 'words'))).toBe(code)
  })

  test('every field is described for agents', () => {
    const undescribed: string[] = []
    // GeoJSON's own members are the standard's; the field holding a point is described.
    const isGeoJsonPoint = (properties: Record<string, unknown>): boolean => (properties.type as { const?: unknown } | undefined)?.const === 'Point'
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) { node.forEach((entry, index) => walk(entry, `${path}[${index}]`)); return }
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key !== 'properties') { walk(value, `${path}/${key}`); continue }
        const properties = value as Record<string, unknown>
        if (isGeoJsonPoint(properties)) continue
        for (const [field, property] of Object.entries(properties)) {
          if (typeof (property as { description?: unknown }).description !== 'string') undescribed.push(`${path}.${field}`)
          walk(property, `${path}.${field}`)
        }
      }
    }
    const schemas = { situationInputSchema, situationSchema, unitOptionsInputSchema, unitOptionsSchema, recommendAnswerSchema, unitOrderInputSchema, unitUndoInputSchema, unitStopRemoveInputSchema, unitRecallInputSchema }
    for (const [name, schema] of Object.entries(schemas)) walk(capabilityJsonSchema(schema), name)
    expect(undescribed).toEqual([])
  })
})
