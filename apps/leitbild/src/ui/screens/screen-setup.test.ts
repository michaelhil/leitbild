import { describe, expect, test } from 'bun:test'
import {
  addScreen, assign, assignmentFor, contentFor, createBoundsReporter, createScreenStore, definitionKeyOf, EMPTY_SCREEN_SETUP, hasStoredAssignment, isTarget, miniature,
  newStamp, nextScreenId, offersShowOnScreens, openScreenWindow, removeScreen, renameScreen, scenarioTitle, SCREEN_ANSWER_KEY_PREFIX, SCREEN_BOUNDS_KEY_PREFIX,
  SCREEN_IDENTIFY_KEY, SCREEN_ROLL_CALL_KEY, SCREEN_SETUP_KEY, SCREEN_TARGET_KEY, screenLabel, screenName, screenOfAddress, screenStorageChange, screenUrl,
  screenWindowFeatures, screenWindowName, showOnScreens, windowBounds, type ScreenContent, type ScreenSetup, type ScreenStorage, type ScreensRun,
} from './screen-setup.ts'

const workspaceId = '0b4b9a52-2f7e-4c1a-9d3e-000000000001'
const otherWorkspaceId = '0b4b9a52-2f7e-4c1a-9d3e-000000000002'
const nuclear = 'world:world.scenario:halden'
const grid = 'world:world.scenario:grid'
const map: ScreenContent = { kind: 'run' }
const dashboard: ScreenContent = { kind: 'surface', moduleId: 'world', surface: 'display:dashboard', title: 'Dashboard' }
const unitOne: ScreenContent = { kind: 'surface', moduleId: 'world', surface: 'display:unit-1', title: 'Unit 1 overview' }
const procedures: ScreenContent = { kind: 'surface', moduleId: 'world', surface: 'procedures:unit-1', title: 'Unit 1 procedures' }
const fourScreens: ScreenSetup = {
  screens: [{ id: 'A', name: 'Desk' }, { id: 'B', name: 'Left wall' }, { id: 'C', name: 'Right wall' }, { id: 'D', name: 'Table' }],
  contentByDefinition: { [nuclear]: { A: procedures, B: unitOne, C: dashboard, D: map } },
  lastDefinition: nuclear,
}
const run: ScreensRun = { workspaceId, runId: 'run-1', definition: nuclear }

const fakeStorage = (initial: Record<string, string> = {}): ScreenStorage & { data: Map<string, string> } => {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: key => { data.delete(key) },
  }
}
const throwingStorage: ScreenStorage = {
  getItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError') },
  setItem: () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError') },
  removeItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError') },
}

describe('stored screen setup', () => {
  test('a setup, a target and a window position are read back as written', () => {
    const storage = fakeStorage()
    const store = createScreenStore(storage)
    expect(store.readSetup()).toEqual({ status: 'absent' })
    expect(store.readTarget()).toEqual({ status: 'absent' })
    expect(store.readBounds('B')).toEqual({ status: 'absent' })

    expect(store.writeSetup(fourScreens)).toEqual({ ok: true })
    expect(store.writeTarget({ workspaceId, runId: 'run-1', definition: nuclear, stamp: 's1' })).toEqual({ ok: true })
    expect(store.writeBounds('B', { x: -1920, y: 0, width: 1920, height: 1080 })).toEqual({ ok: true })
    expect(store.readSetup()).toEqual({ status: 'ok', value: fourScreens })
    expect(store.readTarget()).toEqual({ status: 'ok', value: { workspaceId, runId: 'run-1', definition: nuclear, stamp: 's1' } })
    expect(store.readBounds('B')).toEqual({ status: 'ok', value: { x: -1920, y: 0, width: 1920, height: 1080 } })
    expect([...storage.data.keys()].sort()).toEqual([`${SCREEN_BOUNDS_KEY_PREFIX}B`, SCREEN_SETUP_KEY, SCREEN_TARGET_KEY])
    expect(JSON.parse(storage.data.get(SCREEN_SETUP_KEY)!)).toEqual(fourScreens)
  })

  test('an unreadable value is reported and left as it is', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['{not json', 'it is not JSON'],
      ['[]', 'expected object'],
      [JSON.stringify({ screens: [], contentByDefinition: {} }), 'lastDefinition'],
      [JSON.stringify({ ...fourScreens, screens: [{ id: 'a', name: 'Desk' }] }), 'A screen id is one capital letter'],
      [JSON.stringify({ ...fourScreens, screens: [{ id: 'A', name: 'Desk' }, { id: 'A', name: 'Again' }] }), 'Screen A is listed twice'],
      [JSON.stringify({ ...fourScreens, contentByDefinition: { [nuclear]: { B: { kind: 'chat' } } } }), 'contentByDefinition'],
      [JSON.stringify({ ...fourScreens, contentByDefinition: { [nuclear]: { B: { ...unitOne, surface: 'unit 1' } } } }), 'A surface is <kind>:<subject>'],
    ]
    for (const [raw, expected] of cases) {
      const storage = fakeStorage({ [SCREEN_SETUP_KEY]: raw })
      const read = createScreenStore(storage).readSetup()
      expect(read.status).toBe('unreadable')
      expect(read.status === 'unreadable' ? read.reason.toLowerCase() : '').toContain(expected.toLowerCase())
      expect(storage.data.get(SCREEN_SETUP_KEY)).toBe(raw)
    }
    const storage = fakeStorage({ [SCREEN_TARGET_KEY]: JSON.stringify({ workspaceId: 'ws', runId: 'run-1', definition: nuclear, stamp: 's' }), [`${SCREEN_BOUNDS_KEY_PREFIX}B`]: '{"x":0,"y":0,"width":0,"height":900}' })
    expect(createScreenStore(storage).readTarget().status).toBe('unreadable')
    expect(createScreenStore(storage).readBounds('B').status).toBe('unreadable')
  })

  test('an unknown field makes a value unreadable: nothing is guessed about another version', () => {
    const store = createScreenStore(fakeStorage({
      [SCREEN_SETUP_KEY]: JSON.stringify({ ...fourScreens, arrangement: 'wall' }),
      [SCREEN_TARGET_KEY]: JSON.stringify({ workspaceId, runId: 'run-1', definition: nuclear, stamp: 's', follow: true }),
      [`${SCREEN_BOUNDS_KEY_PREFIX}A`]: JSON.stringify({ x: 0, y: 0, width: 800, height: 600, screen: 1 }),
    }))
    expect(store.readSetup().status).toBe('unreadable')
    expect(store.readTarget().status).toBe('unreadable')
    expect(store.readBounds('A').status).toBe('unreadable')
    const nested = createScreenStore(fakeStorage({
      [SCREEN_SETUP_KEY]: JSON.stringify({ ...fourScreens, screens: [{ id: 'A', name: 'Desk', bounds: null }] }),
    })).readSetup()
    expect(nested.status).toBe('unreadable')
    const content = createScreenStore(fakeStorage({
      [SCREEN_SETUP_KEY]: JSON.stringify({ ...fourScreens, contentByDefinition: { [nuclear]: { D: { kind: 'run', zoom: 2 } } } }),
    })).readSetup()
    expect(content.status).toBe('unreadable')
  })

  test('reset removes only the key it names', () => {
    const storage = fakeStorage({ [SCREEN_SETUP_KEY]: 'broken', [SCREEN_TARGET_KEY]: 'broken too' })
    const store = createScreenStore(storage)
    expect(store.resetSetup()).toEqual({ ok: true })
    expect(store.readSetup()).toEqual({ status: 'absent' })
    expect(store.readTarget().status).toBe('unreadable')
    expect(store.resetTarget()).toEqual({ ok: true })
    expect(storage.data.size).toBe(0)
  })

  test('storage that is missing or throws is said, and nothing is written', () => {
    for (const store of [createScreenStore(null), createScreenStore(throwingStorage)]) {
      expect(store.readSetup().status).toBe('unavailable')
      expect(store.readTarget().status).toBe('unavailable')
      expect(store.readBounds('A').status).toBe('unavailable')
      expect(store.writeSetup(fourScreens).ok).toBe(false)
      expect(showOnScreens(store, run).ok).toBe(false)
      expect(store.writeBounds('A', { x: 0, y: 0, width: 1, height: 1 }).ok).toBe(false)
      expect(store.resetSetup().ok).toBe(false)
      expect(store.call('identify', 's').ok).toBe(false)
      expect(store.answer('A', 's').ok).toBe(false)
    }
    const read = createScreenStore(throwingStorage).readSetup()
    expect(read.status === 'unavailable' ? read.reason : '').toBe('The operation is insecure.')
  })

  test('a value that would not read back is not written', () => {
    const storage = fakeStorage()
    const store = createScreenStore(storage)
    expect(store.writeSetup({ ...fourScreens, screens: [{ id: 'AA', name: 'Desk' }] }).ok).toBe(false)
    expect(store.writeBounds('A', { x: 0.5, y: 0, width: 800, height: 600 }).ok).toBe(false)
    expect(storage.data.size).toBe(0)
  })

  test('roll-call, Identify and the answers are stamps under their own keys', () => {
    const storage = fakeStorage()
    const store = createScreenStore(storage)
    store.call('roll-call', 'r1')
    store.call('identify', 'i1')
    store.answer('B', 'r1')
    expect(Object.fromEntries(storage.data)).toEqual({ [SCREEN_ROLL_CALL_KEY]: 'r1', [SCREEN_IDENTIFY_KEY]: 'i1', [`${SCREEN_ANSWER_KEY_PREFIX}B`]: 'r1' })
    store.writeBounds('B', { x: 0, y: 0, width: 800, height: 600 })
    expect(store.forgetScreen('B')).toEqual({ ok: true })
    expect([...storage.data.keys()].sort()).toEqual([SCREEN_IDENTIFY_KEY, SCREEN_ROLL_CALL_KEY])
  })

  test('a storage event is told apart by its key', () => {
    expect(screenStorageChange(SCREEN_SETUP_KEY)).toEqual({ kind: 'setup' })
    expect(screenStorageChange(SCREEN_TARGET_KEY)).toEqual({ kind: 'target' })
    expect(screenStorageChange(SCREEN_ROLL_CALL_KEY)).toEqual({ kind: 'roll-call' })
    expect(screenStorageChange(SCREEN_IDENTIFY_KEY)).toEqual({ kind: 'identify' })
    expect(screenStorageChange(`${SCREEN_BOUNDS_KEY_PREFIX}C`)).toEqual({ kind: 'bounds', screenId: 'C' })
    expect(screenStorageChange(`${SCREEN_ANSWER_KEY_PREFIX}D`)).toEqual({ kind: 'answer', screenId: 'D' })
    expect(screenStorageChange(null)).toEqual({ kind: 'cleared' })
    expect(screenStorageChange(`${SCREEN_BOUNDS_KEY_PREFIX}c`)).toBeNull()
    expect(screenStorageChange('leitbild:last-workspace')).toBeNull()
    expect(screenStorageChange('leitbild:screens')).toBeNull()
  })
})

describe('screens of a setup', () => {
  test('a new screen takes the next free letter', () => {
    const first = addScreen(EMPTY_SCREEN_SETUP)!
    expect(first.id).toBe('A')
    expect(first.setup.screens).toEqual([{ id: 'A', name: 'Screen A' }])
    expect(addScreen(fourScreens)!.id).toBe('E')
    expect(addScreen(removeScreen(fourScreens, 'B'))!.id).toBe('B')
    let full = EMPTY_SCREEN_SETUP
    for (let count = 0; count < 26; count += 1) full = addScreen(full)!.setup
    expect(full.screens.at(-1)).toEqual({ id: 'Z', name: 'Screen Z' })
    expect(nextScreenId(full)).toBeNull()
    expect(addScreen(full)).toBeNull()
  })

  test('a name is trimmed, and an empty or overlong one is refused', () => {
    expect(screenName('  Left   wall ')).toEqual({ name: 'Left wall' })
    expect(screenName('   ')).toEqual({ refused: 'A screen needs a name.' })
    expect(screenName('x'.repeat(41))).toEqual({ refused: 'A screen name has at most 40 characters.' })
    expect(renameScreen(fourScreens, 'B', 'Wall').screens[1]).toEqual({ id: 'B', name: 'Wall' })
    expect(renameScreen(fourScreens, 'B', 'Wall').contentByDefinition).toEqual(fourScreens.contentByDefinition)
  })

  test('a screen is named in one line that never says "Screen B" twice', () => {
    expect(screenLabel('B', 'Left wall')).toBe('Screen B · Left wall')
    expect(screenLabel('B', addScreen(removeScreen(fourScreens, 'B'))!.setup.screens.at(-1)!.name)).toBe('Screen B')
    expect(screenLabel('B', null)).toBe('Screen B')
    // Another screen's default name is a name like any other.
    expect(screenLabel('B', 'Screen A')).toBe('Screen B · Screen A')
  })

  test('removing a screen removes what it shows in every scenario', () => {
    const both = assign(fourScreens, grid, 'B', map)
    const removed = removeScreen(both, 'B')
    expect(removed.screens.map(screen => screen.id)).toEqual(['A', 'C', 'D'])
    expect(removed.contentByDefinition).toEqual({ [nuclear]: { A: procedures, C: dashboard, D: map }, [grid]: { C: dashboard, D: map } })
    expect(createScreenStore(fakeStorage()).writeSetup(removed)).toEqual({ ok: true })
  })
})

describe('what each screen shows per scenario', () => {
  test('a scenario shows its stored assignment', () => {
    expect(assignmentFor(fourScreens, nuclear)).toEqual({ A: procedures, B: unitOne, C: dashboard, D: map })
    expect(contentFor(fourScreens, nuclear, 'B')).toEqual(unitOne)
    expect(contentFor(fourScreens, nuclear, 'E')).toBeNull()
    expect(contentFor({ ...fourScreens, screens: fourScreens.screens.slice(1) }, nuclear, 'A')).toBeNull()
  })

  test('a new scenario starts from the last one used, carrying over only the map and the Run dashboard', () => {
    expect(hasStoredAssignment(fourScreens, grid)).toBe(false)
    expect(assignmentFor(fourScreens, grid)).toEqual({ C: dashboard, D: map })
    expect(contentFor(fourScreens, grid, 'A')).toBeNull()
    expect(contentFor(fourScreens, grid, 'B')).toBeNull()
    expect(contentFor(fourScreens, grid, 'C')).toEqual(dashboard)
    expect(contentFor(fourScreens, grid, 'D')).toEqual(map)
    expect(assignmentFor({ ...fourScreens, lastDefinition: null }, grid)).toEqual({})
    expect(assignmentFor(EMPTY_SCREEN_SETUP, grid)).toEqual({})
  })

  test('changing one screen gives the scenario an assignment of its own, from what was shown for it', () => {
    const placed = assign(fourScreens, grid, 'A', unitOne)
    expect(placed.contentByDefinition[grid]).toEqual({ A: unitOne, C: dashboard, D: map })
    expect(placed.contentByDefinition[nuclear]).toEqual(fourScreens.contentByDefinition[nuclear]!)
    expect(placed.lastDefinition).toBe(grid)
    const cleared = assign(placed, grid, 'C', null)
    expect(cleared.contentByDefinition[grid]).toEqual({ A: unitOne, D: map })
    // Once stored, an empty assignment is the scenario's own: nothing carries over into it again.
    const empty = assign(assign(cleared, grid, 'A', null), grid, 'D', null)
    expect(hasStoredAssignment(empty, grid)).toBe(true)
    expect(assignmentFor(empty, grid)).toEqual({})
  })

  test('the scenario of a Run is its source Definition without the revision; a Run without one uses `none`', () => {
    expect(definitionKeyOf({ sourceDefinition: { moduleId: 'world', type: 'world.scenario', id: 'halden' } })).toBe(nuclear)
    expect(definitionKeyOf({ sourceDefinition: { moduleId: 'world', type: 'world.scenario', id: 'halden', revisionId: 'r7' } as never })).toBe(nuclear)
    expect(definitionKeyOf({})).toBe('none')
    const definitions = [{ ref: { moduleId: 'world', type: 'world.scenario', id: 'halden' }, title: 'Halden offsite power' }]
    expect(scenarioTitle(nuclear, definitions)).toBe('Halden offsite power')
    expect(scenarioTitle('none', definitions)).toBe('Runs without a scenario')
    expect(scenarioTitle(grid, definitions)).toBe('this scenario')
  })
})

describe('Show on screens', () => {
  test('writes the Run as the target', () => {
    const store = createScreenStore(fakeStorage())
    expect(showOnScreens(store, run, () => 'stamp-1')).toEqual({ ok: true })
    expect(store.readTarget()).toEqual({ status: 'ok', value: { workspaceId, runId: 'run-1', definition: nuclear, stamp: 'stamp-1' } })
    expect(isTarget(store.readTarget(), run)).toBe(true)
    expect(isTarget(store.readTarget(), { ...run, runId: 'run-2' })).toBe(false)
    expect(isTarget(store.readTarget(), { ...run, workspaceId: otherWorkspaceId })).toBe(false)
  })

  test('a repeated press changes the stamp, so the stored value changes and the screens hear it', () => {
    const storage = fakeStorage()
    const store = createScreenStore(storage)
    showOnScreens(store, run)
    const first = storage.data.get(SCREEN_TARGET_KEY)
    showOnScreens(store, run)
    const second = storage.data.get(SCREEN_TARGET_KEY)
    expect(second).not.toBe(first)
    expect({ ...JSON.parse(second!), stamp: '' }).toEqual({ ...JSON.parse(first!), stamp: '' })
    expect(new Set(Array.from({ length: 200 }, () => newStamp())).size).toBe(200)
  })

  test('the Run bar offers it only with at least one screen and a Run the screens do not show', () => {
    const setup = { status: 'ok', value: fourScreens } as const
    const target = { status: 'ok', value: { workspaceId, runId: 'run-1', definition: nuclear, stamp: 's' } } as const
    expect(offersShowOnScreens({ status: 'absent' }, { status: 'absent' }, run)).toBe(false)
    expect(offersShowOnScreens({ status: 'ok', value: EMPTY_SCREEN_SETUP }, { status: 'absent' }, run)).toBe(false)
    expect(offersShowOnScreens(setup, { status: 'absent' }, run)).toBe(true)
    expect(offersShowOnScreens(setup, target, run)).toBe(false)
    expect(offersShowOnScreens(setup, target, { ...run, runId: 'run-2' })).toBe(true)
    expect(offersShowOnScreens(setup, target, { ...run, workspaceId: otherWorkspaceId })).toBe(true)
    // An unreadable target is reset in the panel, never overwritten by a press.
    expect(offersShowOnScreens(setup, { status: 'unreadable', reason: 'it is not JSON' }, run)).toBe(false)
    expect(offersShowOnScreens({ status: 'unreadable', reason: 'it is not JSON' }, { status: 'absent' }, run)).toBe(false)
    expect(offersShowOnScreens({ status: 'unavailable', reason: 'blocked' }, { status: 'unavailable', reason: 'blocked' }, run)).toBe(false)
  })
})

describe('screen windows', () => {
  test('the screen parameter is one capital letter, and anything else is said', () => {
    expect(screenOfAddress(null)).toEqual({ id: null, refused: null })
    expect(screenOfAddress('B')).toEqual({ id: 'B', refused: null })
    for (const value of ['b', 'AB', '', '1', 'B ']) {
      const read = screenOfAddress(value)
      expect(read.id).toBeNull()
      expect(read.refused).toContain('one capital letter')
    }
  })

  test('a screen window has a canonical address with its Workspace in the path', () => {
    expect(screenUrl(workspaceId, 'D', { runId: 'run-1', content: map })).toBe(`/workspaces/${workspaceId}?world=run-1&screen=D`)
    expect(screenUrl(workspaceId, 'B', { runId: 'run-1', content: unitOne })).toBe(`/workspaces/${workspaceId}?world=run-1&surface=display%3Aunit-1&screen=B`)
    expect(screenUrl(workspaceId, 'A', null)).toBe(`/workspaces/${workspaceId}?screen=A`)
  })

  test('a window opens under its screen name at its remembered rectangle, never with noopener', () => {
    expect(screenWindowName('B')).toBe('leitbild-screen-B')
    expect(screenWindowFeatures({ x: -1920, y: 40, width: 1920, height: 1040 })).toBe('popup,left=-1920,top=40,width=1920,height=1040')
    expect(screenWindowFeatures(null)).toBe('popup')
    expect(screenWindowFeatures({ x: 0, y: 0, width: 800, height: 600 })).not.toContain('noopener')
  })

  test('a window reports where it is and how big, in whole pixels', () => {
    expect(windowBounds({ screenX: -1919.6, screenY: 25, outerWidth: 1280.4, outerHeight: 800 })).toEqual({ x: -1920, y: 25, width: 1280, height: 800 })
  })

  test('a window that has no size yet at load reports once it is shown', () => {
    const storage = fakeStorage()
    const store = createScreenStore(storage)
    const writes: Array<unknown> = []
    const counted = { writeBounds: (id: string, bounds: Parameters<typeof store.writeBounds>[1]) => { writes.push(bounds); return store.writeBounds(id, bounds) } }
    const source = { screenX: 0, screenY: 0, outerWidth: 0, outerHeight: 0 }
    const reporter = createBoundsReporter(counted, 'A', source)

    reporter.report() // load, behind another window
    expect(writes).toEqual([])
    expect(store.readBounds('A')).toEqual({ status: 'absent' })
    reporter.shown() // took focus, still without a size
    expect(writes).toEqual([])

    Object.assign(source, { screenX: 0, screenY: 33, outerWidth: 1470, outerHeight: 923 })
    reporter.shown() // became visible
    expect(store.readBounds('A')).toEqual({ status: 'ok', value: { x: 0, y: 33, width: 1470, height: 923 } })
    reporter.shown() // later focus and visibility changes write nothing: only load, resize and leaving do
    reporter.shown()
    expect(writes).toHaveLength(1)

    Object.assign(source, { outerWidth: 1200 })
    reporter.report() // resize
    expect(store.readBounds('A')).toEqual({ status: 'ok', value: { x: 0, y: 33, width: 1200, height: 923 } })
    expect(writes).toHaveLength(2)
  })

  test('a window with a size at load reports at once, and a sizeless report never replaces a stored position', () => {
    const store = createScreenStore(fakeStorage())
    const source = { screenX: -1920, screenY: 0, outerWidth: 1920, outerHeight: 1080 }
    const reporter = createBoundsReporter(store, 'B', source)
    reporter.report()
    expect(store.readBounds('B')).toEqual({ status: 'ok', value: { x: -1920, y: 0, width: 1920, height: 1080 } })
    Object.assign(source, { outerWidth: 0, outerHeight: 0 })
    reporter.report() // left while hidden
    expect(store.readBounds('B')).toEqual({ status: 'ok', value: { x: -1920, y: 0, width: 1920, height: 1080 } })
    Object.assign(source, { screenX: 0, outerWidth: 800, outerHeight: 600 })
    reporter.shown()
    expect(store.readBounds('B')).toEqual({ status: 'ok', value: { x: 0, y: 0, width: 800, height: 600 } })
  })

  test('an opened window is sized to its remembered outer size, since the features size only the page area', () => {
    const calls: Array<ReadonlyArray<unknown>> = []
    const resized: Array<ReadonlyArray<number>> = []
    const open = (url: string, name: string, features: string) => {
      calls.push([url, name, features])
      return { resizeTo: (width: number, height: number) => { resized.push([width, height]) } }
    }
    const bounds = { x: -1920, y: 40, width: 1920, height: 1040 }
    expect(openScreenWindow(open, { id: 'B', url: '/workspaces/ws?screen=B', bounds })).toBe('opened')
    expect(calls).toEqual([['/workspaces/ws?screen=B', 'leitbild-screen-B', 'popup,left=-1920,top=40,width=1920,height=1040']])
    expect(resized).toEqual([[1920, 1040]])

    expect(openScreenWindow(open, { id: 'C', url: '/workspaces/ws?screen=C', bounds: null })).toBe('opened')
    expect(calls[1]).toEqual(['/workspaces/ws?screen=C', 'leitbild-screen-C', 'popup'])
    expect(resized).toHaveLength(1)
  })

  test('a browser that refuses to resize leaves the window open, and a blocked pop-up is told apart', () => {
    const refusing = () => ({ resizeTo: () => { throw new DOMException('Not allowed', 'SecurityError') } })
    expect(openScreenWindow(refusing, { id: 'B', url: '/workspaces/ws?screen=B', bounds: { x: 0, y: 0, width: 800, height: 600 } })).toBe('opened')
    expect(openScreenWindow(() => null, { id: 'B', url: '/workspaces/ws?screen=B', bounds: { x: 0, y: 0, width: 800, height: 600 } })).toBe('blocked')
    expect(openScreenWindow(() => null, { id: 'B', url: '/workspaces/ws?screen=B', bounds: null })).toBe('blocked')
  })

  test('the miniature keeps the windows where they are relative to each other', () => {
    expect(miniature([], { width: 300, height: 100 })).toEqual([])
    const rects = miniature([
      { id: 'A', bounds: { x: -1000, y: 0, width: 1000, height: 500 } },
      { id: 'B', bounds: { x: 0, y: 0, width: 2000, height: 1000 } },
    ], { width: 300, height: 200 })
    expect(rects).toEqual([
      { id: 'A', x: 0, y: 50, width: 100, height: 50 },
      { id: 'B', x: 100, y: 50, width: 200, height: 100 },
    ])
  })
})
