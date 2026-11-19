import { describe, expect, test } from 'bun:test'
import { readSurfacePlace } from './surface-place.ts'

const workspaceId = '0b4b9a52-2f7e-4c1a-9d3e-000000000001'
const otherWorkspaceId = '0b4b9a52-2f7e-4c1a-9d3e-000000000002'
const page = { fromWorld: true, workspaceId, runId: 'run-1' }
const surface = (overrides: Record<string, unknown> = {}) => ({
  moduleId: 'world',
  subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
  surface: 'display:unit-1',
  title: 'Unit 1 overview',
  ...overrides,
})
const message = (overrides: Record<string, unknown> = {}) => ({ type: 'leitbild:surface-place', surface: surface(overrides) })

describe('"Open on another screen…" from the World page', () => {
  test('a valid request about the Run shown here is placed', () => {
    const read = readSurfacePlace(message(), page)
    expect(read.kind).toBe('place')
    expect(read.kind === 'place' ? read.surface : null).toEqual(surface() as never)
    // The surface string is carried whole, whatever it says.
    const opaque = readSurfacePlace(message({ surface: 'anything-new:a/b?c=d' }), page)
    expect(opaque.kind === 'place' ? opaque.surface.surface : null).toBe('anything-new:a/b?c=d')
  })

  test('other messages are not judged here', () => {
    for (const data of [null, 'leitbild:surface-place', 7, {}, { type: 'leitbild:view-window-ready' }, { type: 'leitbild:surface-placed' }]) {
      expect(readSurfacePlace(data, page)).toEqual({ kind: 'other' })
      expect(readSurfacePlace(data, { ...page, fromWorld: false })).toEqual({ kind: 'other' })
    }
  })

  test('only the World frame may send it', () => {
    expect(readSurfacePlace(message(), { ...page, fromWorld: false }))
      .toEqual({ kind: 'refused', message: 'Screen placement refused: only the World page sends leitbild:surface-place' })
  })

  test('a malformed request is refused with the first schema issue', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ type: 'leitbild:surface-place' }, 'surface'],
      [{ ...message(), screen: 'B' }, 'Unrecognized key'],
      [message({ surface: 'unit 1' }), 'A surface is <kind>:<subject>'],
      [message({ title: '' }), 'title'],
      [message({ extra: true }), 'Unrecognized key'],
      [message({ moduleId: 'agents' }), 'A surface subject must belong to the publishing Module'],
      [message({ subject: { workspaceId: 'ws', moduleId: 'world', type: 'world.simulation-run', id: 'run-1' } }), 'subject.workspaceId'],
    ]
    for (const [data, expected] of cases) {
      const read = readSurfacePlace(data, page)
      expect(read.kind).toBe('refused')
      expect(read.kind === 'refused' ? read.message : '').toStartWith('Screen placement refused: ')
      expect(read.kind === 'refused' ? read.message : '').toContain(expected)
    }
  })

  test('a request about another Workspace is refused', () => {
    const data = message({ subject: { workspaceId: otherWorkspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' } })
    expect(readSurfacePlace(data, page)).toEqual({ kind: 'refused', message: 'Screen placement refused: it belongs to another Workspace' })
  })

  test('a request that is not about the Run shown here is refused', () => {
    const refused = { kind: 'refused', message: 'Screen placement refused: it is not about the Run shown here' } as const
    expect(readSurfacePlace(message({ subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-2' } }), page)).toEqual(refused)
    expect(readSurfacePlace(message({ subject: { workspaceId, moduleId: 'world', type: 'world.run-family', id: 'run-1' } }), page)).toEqual(refused)
    expect(readSurfacePlace(message(), { ...page, runId: null })).toEqual(refused)
    const agents = message({ moduleId: 'agents', subject: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'run-1' } })
    expect(readSurfacePlace(agents, page)).toEqual(refused)
  })
})
