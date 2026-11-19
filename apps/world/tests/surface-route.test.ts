import { describe, expect, test } from 'bun:test'
import { embeddedViewListingSchema, workspaceSurfacePlaceMessageSchema } from '@leitbild/contracts'
import type { ObjectId } from '../src/core/model/index.ts'
import { dashboardDeckEntry, type AnswerDeckEntry, type AssetDeckEntry } from '../src/ui/process-display/display-deck.ts'
import {
  deckEntrySurface,
  formatWorldSurface,
  parseWorldSurface,
  presentSurface,
  procedureWindowSurface,
  readSurfaceRoute,
  requestSurfacePlace,
  surfacePlaceMessage,
  surfaceRouteQuery,
  type SurfaceSubject,
  type WorldSurface,
} from '../src/ui/surface-route.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const run = { workspaceId, simulationRunId: 'run-1' }
const unit1 = 'plant:u1' as ObjectId
const unit2 = 'plant:u2' as ObjectId

const surfaces: ReadonlyArray<readonly [string, WorldSurface]> = [
  ['display:plant:u1', { kind: 'display', objectId: unit1 }],
  ['display:dashboard', { kind: 'dashboard' }],
  ['procedures:plant:u1', { kind: 'procedures', objectId: unit1 }],
]

describe('World\'s surface strings', () => {
  test.each(surfaces)('%s parses and formats back to itself', (text, surface) => {
    expect(parseWorldSurface(text)).toEqual(surface)
    expect(formatWorldSurface(surface)).toBe(text)
  })

  test('an object id keeps its own colons, dots and dashes', () => {
    const objectId = 'grid:substation.NO-1:bay_2' as ObjectId
    expect(parseWorldSurface(`procedures:${objectId}`)).toEqual({ kind: 'procedures', objectId })
    expect(parseWorldSurface(formatWorldSurface({ kind: 'display', objectId }))).toEqual({ kind: 'display', objectId })
  })

  test.each([
    'map', 'display', 'display:', 'procedures:', 'dashboard', 'Display:plant:u1', 'displays:plant:u1', 'procedure:plant:u1',
    'chat:room-1', 'procedures:dashboard page', 'display:plant u1', 'display::u1', 'display:-u1', ' display:plant:u1',
    `display:${'a'.repeat(129)}`, `display:${'a'.repeat(300)}`,
  ])('%p is no surface', text => {
    expect(parseWorldSurface(text)).toBeNull()
  })

  test('the dashboard\'s word is not an object\'s display, and formats to nothing else', () => {
    expect(parseWorldSurface('display:dashboard')).toEqual({ kind: 'dashboard' })
    expect(() => formatWorldSurface({ kind: 'display', objectId: 'dashboard' as ObjectId })).toThrow('has no display surface')
    // Procedures have no such word: a unit of that id is a unit.
    expect(parseWorldSurface('procedures:dashboard')).toEqual({ kind: 'procedures', objectId: 'dashboard' as ObjectId })
  })

  test('the page\'s query names a surface beside the Run\'s own selection', () => {
    expect(readSurfaceRoute('')).toEqual({ kind: 'run' })
    expect(readSurfaceRoute('?focus=plant:u1&element=sgA')).toEqual({ kind: 'run' })
    expect(readSurfaceRoute('?surface=display%3Aplant%3Au1')).toEqual({ kind: 'surface', surface: { kind: 'display', objectId: unit1 } })
    expect(readSurfaceRoute('?focus=plant:u2&surface=procedures:plant:u1&roles=a')).toEqual({ kind: 'surface', surface: { kind: 'procedures', objectId: unit1 } })
    expect(readSurfaceRoute('?surface=display:dashboard')).toEqual({ kind: 'surface', surface: { kind: 'dashboard' } })
    // Text that is no surface is kept to be refused in place; it never reads as "no surface".
    expect(readSurfaceRoute('?surface=')).toEqual({ kind: 'unknown', text: '' })
    expect(readSurfaceRoute('?surface=map')).toEqual({ kind: 'unknown', text: 'map' })
    expect(readSurfaceRoute('?surface=chat:room-1')).toEqual({ kind: 'unknown', text: 'chat:room-1' })
  })

  test('the page names the same surface again when it rewrites its address, and keeps text it will refuse', () => {
    for (const search of ['?surface=display:plant:u1', '?surface=display:dashboard', '?surface=procedures:plant:u1', '?surface=map', '?surface=']) {
      const route = readSurfaceRoute(search)
      expect(readSurfaceRoute(`?${new URLSearchParams(surfaceRouteQuery(route))}`)).toEqual(route)
    }
    expect(surfaceRouteQuery(readSurfaceRoute('?focus=plant:u1'))).toEqual({})
    expect(surfaceRouteQuery(readSurfaceRoute('?surface=procedures:plant:u1'))).toEqual({ surface: 'procedures:plant:u1' })
  })
})

describe('what a surface opens in the joined Run', () => {
  const subjects: Readonly<Record<string, SurfaceSubject>> = {
    [unit1]: { label: 'Unit 1', hasOverview: true, runsProcedures: true },
    'weather:front': { label: 'Cold front', hasOverview: false, runsProcedures: false },
  }
  const asked: string[] = []
  const subjectOf = (objectId: ObjectId): SurfaceSubject | null => { asked.push(objectId); return subjects[objectId] ?? null }
  const present = (text: string) => {
    const route = readSurfaceRoute(`?${new URLSearchParams({ surface: text })}`)
    if (route.kind === 'run') throw new Error('a surface was expected')
    return presentSurface(route, subjectOf)
  }

  test('an observed asset\'s overview opens the display window on that asset', () => {
    expect(present('display:plant:u1')).toEqual({ kind: 'display', target: { kind: 'asset', objectId: unit1 } })
  })

  test('the dashboard opens whatever the Run holds, and asks about no object', () => {
    asked.length = 0
    expect(present('display:dashboard')).toEqual({ kind: 'display', target: { kind: 'dashboard' } })
    expect(asked).toEqual([])
  })

  test('a unit that runs procedures opens its procedure window', () => {
    expect(present('procedures:plant:u1')).toEqual({ kind: 'procedures', objectId: unit1 })
  })

  test('text that is no surface is refused with what a screen can show', () => {
    expect(present('map')).toEqual({ kind: 'refused', reason: 'World has nothing to show for “map”. A screen shows an asset\'s overview display, the Run\'s dashboard or a unit\'s procedures.' })
    expect(present('')).toMatchObject({ kind: 'refused', reason: expect.stringContaining('World has nothing to show for “”.') })
    const long = present(`display:${'x'.repeat(400)}`)
    expect(long).toMatchObject({ kind: 'refused', reason: expect.stringContaining(`“display:${'x'.repeat(72)}…”`) })
  })

  test('an object this screen does not see is refused by name, for a display and for procedures', () => {
    expect(present('display:plant:u2')).toEqual({ kind: 'refused', reason: 'This Run has no object “plant:u2” that this screen can see, so its overview display cannot be shown.' })
    expect(present('procedures:plant:u2')).toEqual({ kind: 'refused', reason: 'This Run has no object “plant:u2” that this screen can see, so its procedures cannot be shown.' })
  })

  test('an object without an overview display is refused by its label', () => {
    expect(present('display:weather:front')).toEqual({ kind: 'refused', reason: 'Cold front has no overview display in this Run.' })
  })

  test('an object no Pack runs procedures for is refused by its label', () => {
    expect(present('procedures:weather:front')).toEqual({ kind: 'refused', reason: 'Cold front has no procedures in this Run.' })
  })

  test('an overview does not stand in for procedures, nor procedures for an overview', () => {
    const only = (subject: SurfaceSubject) => (text: string) => {
      const route = readSurfaceRoute(`?surface=${text}`)
      if (route.kind === 'run') throw new Error('a surface was expected')
      return presentSurface(route, () => subject).kind
    }
    expect(only({ label: 'Unit 2', hasOverview: true, runsProcedures: false })('procedures:plant:u2')).toBe('refused')
    expect(only({ label: 'Unit 2', hasOverview: false, runsProcedures: true })('display:plant:u2')).toBe('refused')
  })
})

describe('"Open on another screen…"', () => {
  const asset: AssetDeckEntry = { source: 'asset', key: 'asset:run-1:plant:u1', title: 'Unit 1', caption: 'Overview', kind: 'generated', asset: { objectId: unit1, packId: 'process-plant', label: 'Unit 1' }, inRun: true }
  const listing = (viewType: string) => embeddedViewListingSchema.parse({
    key: 'a1',
    caption: 'Answer',
    envelope: { moduleId: 'world', viewType, subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }, title: 'Dashboard', height: 600, state: '{"scope":"run"}' },
  })

  test('an asset\'s overview and the dashboard have an address; no other display of the window has', () => {
    expect(deckEntrySurface(asset)).toEqual({ surface: { kind: 'display', objectId: unit1 }, title: 'Unit 1 · Overview' })
    expect(deckEntrySurface(dashboardDeckEntry('run-1', listing('display.dashboard').envelope))).toEqual({ surface: { kind: 'dashboard' }, title: 'Dashboard · Whole Run' })
    expect(deckEntrySurface({ ...asset, inRun: false, caption: 'No longer in this Run' })).toBeNull()
    expect(deckEntrySurface({ ...asset, asset: { ...asset.asset, objectId: 'dashboard' as ObjectId } })).toBeNull()
    const answer: AnswerDeckEntry = { source: 'answer', key: 'answer:a1', title: 'SG A level', caption: 'Answer', kind: 'advice', listing: listing('display.vignette'), otherRun: false, listed: true, refusal: null }
    expect(deckEntrySurface(answer)).toBeNull()
  })

  test('a unit\'s procedure window is its procedures surface', () => {
    expect(procedureWindowSurface({ objectId: unit2, label: 'Unit 2' })).toEqual({ surface: { kind: 'procedures', objectId: unit2 }, title: 'Procedures · Unit 2' })
  })

  test('a title longer than the contract allows is cut, never refused', () => {
    const placed = procedureWindowSurface({ objectId: unit1, label: 'U'.repeat(200) })
    expect(placed.title).toHaveLength(120)
    expect(placed.title.endsWith('…')).toBe(true)
    expect(() => surfacePlaceMessage(run, placed)).not.toThrow()
  })

  test('asks the Host, at its origin, with the contract\'s message about this page\'s Run', () => {
    const posted: Array<{ readonly message: unknown; readonly origin: string }> = []
    const host = { parent: { postMessage: (message: unknown, origin: string) => { posted.push({ message, origin }) } }, origin: 'https://leitbild.test' }
    requestSurfacePlace(run, deckEntrySurface(asset)!, host)
    requestSurfacePlace(run, procedureWindowSurface({ objectId: unit2, label: 'Unit 2' }), host)
    const subject = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
    expect(posted).toEqual([
      { message: { type: 'leitbild:surface-place', surface: { moduleId: 'world', subject, surface: 'display:plant:u1', title: 'Unit 1 · Overview' } }, origin: 'https://leitbild.test' },
      { message: { type: 'leitbild:surface-place', surface: { moduleId: 'world', subject, surface: 'procedures:plant:u2', title: 'Procedures · Unit 2' } }, origin: 'https://leitbild.test' },
    ])
    // What the Host parses is what was sent, and a frame can be sent it: a plain object, no proxy.
    for (const { message } of posted) {
      expect(workspaceSurfacePlaceMessageSchema.parse(message)).toEqual(message as never)
      expect(structuredClone(message)).toEqual(message)
    }
  })

  test('never asks for a Run it cannot name', () => {
    const placed = procedureWindowSurface({ objectId: unit1, label: 'Unit 1' })
    expect(() => surfacePlaceMessage({ workspaceId: 'not-a-workspace', simulationRunId: 'run-1' }, placed)).toThrow()
    expect(() => surfacePlaceMessage({ workspaceId, simulationRunId: '' }, placed)).toThrow()
    expect(() => surfacePlaceMessage(run, { surface: placed.surface, title: '' })).toThrow()
  })
})
