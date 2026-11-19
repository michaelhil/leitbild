import { describe, expect, test } from 'bun:test'
import { NOT_FOLLOWING_TEXT, screenAddress, screenShows, standbyText, type FollowTrigger, type ScreenAddressSelection, type ScreenShow } from './screen-follow.ts'
import { assign, type ScreenContent, type ScreenSetup, type ScreenTarget, type Stored } from './screen-setup.ts'

const here = '0b4b9a52-2f7e-4c1a-9d3e-000000000001'
const there = '0b4b9a52-2f7e-4c1a-9d3e-000000000002'
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
const nothing: ScreenAddressSelection = { world: null, surface: null, planning: null }
const stored = <T>(value: T): Stored<T> => ({ status: 'ok', value })
const target = (overrides: Partial<ScreenTarget> = {}): Stored<ScreenTarget> =>
  stored({ workspaceId: here, runId: 'run-2', definition: nuclear, stamp: 's1', ...overrides })
const shows = (overrides: {
  screenId?: string
  address?: ScreenAddressSelection
  target?: Stored<ScreenTarget>
  setup?: Stored<ScreenSetup>
  trigger?: FollowTrigger
} = {}): ScreenShow => screenShows({
  screenId: 'B', workspaceId: here, address: nothing, target: target(), setup: stored(fourScreens), trigger: 'load', ...overrides,
})

describe('what a screen window shows', () => {
  test('with no target in this browser it shows what its address says', () => {
    for (const trigger of ['load', 'storage'] as const) {
      expect(shows({ target: { status: 'absent' }, trigger })).toEqual({ kind: 'address', following: true })
      expect(shows({ target: { status: 'absent' }, setup: { status: 'absent' }, address: { world: 'run-1', surface: 'display:unit-9', planning: null }, trigger }))
        .toEqual({ kind: 'address', following: true })
      // Not even an unreadable setup matters to a window that follows nothing.
      expect(shows({ target: { status: 'absent' }, setup: { status: 'unreadable', reason: 'it is not JSON' }, trigger })).toEqual({ kind: 'address', following: true })
    }
  })

  test('a target in this Workspace selects its Run and this screen\'s content in the page', () => {
    for (const trigger of ['load', 'storage'] as const) {
      expect(shows({ trigger })).toEqual({ kind: 'select', runId: 'run-2', surface: 'display:unit-1', definition: nuclear })
      expect(shows({ screenId: 'A', trigger })).toEqual({ kind: 'select', runId: 'run-2', surface: 'procedures:unit-1', definition: nuclear })
      expect(shows({ screenId: 'D', trigger })).toEqual({ kind: 'select', runId: 'run-2', surface: null, definition: nuclear })
      // The address named yesterday's Run: the target wins inside the same Workspace.
      expect(shows({ address: { world: 'run-1', surface: 'display:unit-1', planning: null }, trigger }))
        .toEqual({ kind: 'select', runId: 'run-2', surface: 'display:unit-1', definition: nuclear })
      expect(shows({ screenId: 'D', address: { world: 'run-2', surface: 'display:unit-1', planning: null }, trigger }))
        .toEqual({ kind: 'select', runId: 'run-2', surface: null, definition: nuclear })
      expect(shows({ address: { world: 'run-2', surface: 'display:unit-1', planning: 'plan-1' }, trigger }))
        .toEqual({ kind: 'select', runId: 'run-2', surface: 'display:unit-1', definition: nuclear })
    }
  })

  test('an address that already shows the target stays as it is', () => {
    for (const trigger of ['load', 'storage'] as const) {
      expect(shows({ address: { world: 'run-2', surface: 'display:unit-1', planning: null }, trigger })).toEqual({ kind: 'address', following: true })
      expect(shows({ screenId: 'D', address: { world: 'run-2', surface: null, planning: null }, trigger })).toEqual({ kind: 'address', following: true })
    }
  })

  test('a target in another Workspace on page load is Standby with one link, never a navigation', () => {
    const show = shows({ target: target({ workspaceId: there }), address: { world: 'run-1', surface: 'display:unit-1', planning: null } })
    expect(show).toEqual({ kind: 'standby', reason: { kind: 'elsewhere', href: `/workspaces/${there}?world=run-2&surface=display%3Aunit-1&screen=B`, problem: null } })
    expect(shows({ screenId: 'D', target: target({ workspaceId: there }) }))
      .toEqual({ kind: 'standby', reason: { kind: 'elsewhere', href: `/workspaces/${there}?world=run-2&screen=D`, problem: null } })
    // A screen with nothing assigned there still only gets the link, to the screen itself.
    expect(shows({ screenId: 'E', target: target({ workspaceId: there }) }))
      .toEqual({ kind: 'standby', reason: { kind: 'elsewhere', href: `/workspaces/${there}?screen=E`, problem: null } })
    expect(shows({ target: target({ workspaceId: there }), setup: { status: 'absent' } }))
      .toEqual({ kind: 'standby', reason: { kind: 'elsewhere', href: `/workspaces/${there}?screen=B`, problem: null } })
  })

  test('a target in another Workspace on a storage event asks to navigate to the canonical address there', () => {
    expect(shows({ target: target({ workspaceId: there }), trigger: 'storage' }))
      .toEqual({ kind: 'navigate', workspaceId: there, href: `/workspaces/${there}?world=run-2&surface=display%3Aunit-1&screen=B` })
    expect(shows({ screenId: 'D', target: target({ workspaceId: there }), trigger: 'storage' }))
      .toEqual({ kind: 'navigate', workspaceId: there, href: `/workspaces/${there}?world=run-2&screen=D` })
    expect(shows({ screenId: 'E', target: target({ workspaceId: there }), trigger: 'storage' }))
      .toEqual({ kind: 'navigate', workspaceId: there, href: `/workspaces/${there}?screen=E` })
  })

  test('a screen with nothing assigned for the scenario is Standby and joins no Run', () => {
    for (const trigger of ['load', 'storage'] as const) {
      expect(shows({ screenId: 'E', trigger })).toEqual({ kind: 'standby', reason: { kind: 'unassigned', definition: nuclear } })
      expect(shows({ setup: stored(assign(fourScreens, nuclear, 'B', null)), trigger })).toEqual({ kind: 'standby', reason: { kind: 'unassigned', definition: nuclear } })
      expect(shows({ setup: { status: 'absent' }, trigger })).toEqual({ kind: 'standby', reason: { kind: 'unassigned', definition: nuclear } })
    }
  })

  test('a scenario with no assignment of its own carries over only the map and the Run dashboard', () => {
    const newScenario = target({ runId: 'run-9', definition: grid })
    for (const trigger of ['load', 'storage'] as const) {
      expect(shows({ screenId: 'D', target: newScenario, trigger })).toEqual({ kind: 'select', runId: 'run-9', surface: null, definition: grid })
      expect(shows({ screenId: 'C', target: newScenario, trigger })).toEqual({ kind: 'select', runId: 'run-9', surface: 'display:dashboard', definition: grid })
      expect(shows({ screenId: 'A', target: newScenario, trigger })).toEqual({ kind: 'standby', reason: { kind: 'unassigned', definition: grid } })
      expect(shows({ screenId: 'B', target: newScenario, trigger })).toEqual({ kind: 'standby', reason: { kind: 'unassigned', definition: grid } })
    }
    // Once something is placed for it, the scenario has its own assignment.
    const placed = stored(assign(fourScreens, grid, 'B', unitOne))
    expect(shows({ screenId: 'B', target: newScenario, setup: placed })).toEqual({ kind: 'select', runId: 'run-9', surface: 'display:unit-1', definition: grid })
    expect(shows({ screenId: 'A', target: newScenario, setup: placed })).toEqual({ kind: 'standby', reason: { kind: 'unassigned', definition: grid } })
    expect(shows({ screenId: 'D', target: newScenario, setup: placed })).toEqual({ kind: 'select', runId: 'run-9', surface: null, definition: grid })
  })

  test('an unreadable target or setup is said on the screen, in either Workspace', () => {
    for (const trigger of ['load', 'storage'] as const) {
      expect(shows({ target: { status: 'unreadable', reason: 'it is not JSON' }, trigger }))
        .toEqual({ kind: 'standby', reason: { kind: 'unreadable', what: 'target', detail: 'it is not JSON' } })
      expect(shows({ setup: { status: 'unreadable', reason: 'screens: Invalid input' }, trigger }))
        .toEqual({ kind: 'standby', reason: { kind: 'unreadable', what: 'setup', detail: 'screens: Invalid input' } })
      expect(shows({ target: target({ workspaceId: there }), setup: { status: 'unreadable', reason: 'screens: Invalid input' }, trigger }))
        .toEqual({ kind: 'standby', reason: { kind: 'unreadable', what: 'setup', detail: 'screens: Invalid input' } })
    }
  })

  test('without storage the window shows its address and says it does not follow', () => {
    const unavailable = { status: 'unavailable', reason: 'blocked' } as const
    for (const trigger of ['load', 'storage'] as const) {
      expect(shows({ target: unavailable, setup: unavailable, trigger })).toEqual({ kind: 'address', following: false })
      expect(shows({ setup: unavailable, trigger })).toEqual({ kind: 'address', following: false })
    }
    expect(NOT_FOLLOWING_TEXT).toContain('does not follow')
  })
})

describe('the address of what a screen window shows', () => {
  const page = { workspaceId: here, screenId: 'B', agents: null }

  test('a selected Run and surface are written to the page\'s own Workspace, with the conversation kept beside it', () => {
    const select: ScreenShow = { kind: 'select', runId: 'run-2', surface: 'display:unit-1', definition: nuclear }
    expect(screenAddress(select, page)).toBe(`/workspaces/${here}?world=run-2&surface=display%3Aunit-1&screen=B`)
    expect(screenAddress(select, { ...page, agents: 'room-1' })).toBe(`/workspaces/${here}?world=run-2&surface=display%3Aunit-1&agents=room-1&screen=B`)
    expect(screenAddress({ ...select, surface: null }, page)).toBe(`/workspaces/${here}?world=run-2&screen=B`)
  })

  test('a screen with nothing to show names no Run', () => {
    expect(screenAddress({ kind: 'standby', reason: { kind: 'unassigned', definition: nuclear } }, { ...page, agents: 'room-1' })).toBe(`/workspaces/${here}?screen=B`)
    expect(screenAddress({ kind: 'standby', reason: { kind: 'elsewhere', href: `/workspaces/${there}?screen=B`, problem: null } }, page)).toBe(`/workspaces/${here}?screen=B`)
  })

  test('otherwise the address stays as it is', () => {
    expect(screenAddress({ kind: 'address', following: true }, page)).toBeNull()
    expect(screenAddress({ kind: 'standby', reason: { kind: 'unreadable', what: 'setup', detail: 'x' } }, page)).toBeNull()
    expect(screenAddress({ kind: 'navigate', workspaceId: there, href: `/workspaces/${there}?screen=B` }, page)).toBeNull()
  })
})

describe('Standby says why', () => {
  const scenario = (definition: string): string => definition === nuclear ? 'Halden offsite power' : 'this scenario'

  test('each reason has its sentence, and only another Workspace has a link', () => {
    expect(standbyText({ kind: 'unassigned', definition: nuclear }, scenario)).toEqual({ why: 'Nothing assigned for Halden offsite power', link: null })
    expect(standbyText({ kind: 'run-gone' }, scenario)).toEqual({ why: 'Its Run no longer exists', link: null })
    expect(standbyText({ kind: 'no-run' }, scenario)).toEqual({ why: 'This address names no Run', link: null })
    expect(standbyText({ kind: 'elsewhere', href: `/workspaces/${there}?screen=B`, problem: null }, scenario)).toEqual({
      why: 'The screens now show a Run in another Workspace',
      link: { href: `/workspaces/${there}?screen=B`, label: 'Open it on this screen' },
    })
    expect(standbyText({ kind: 'elsewhere', href: `/workspaces/${there}?screen=B`, problem: 'This Workspace no longer exists.' }, scenario).why)
      .toBe('The screens now show a Run in another Workspace. This window could not go there by itself: This Workspace no longer exists.')
    expect(standbyText({ kind: 'unreadable', what: 'setup', detail: 'it is not JSON' }, scenario).why)
      .toBe('This browser\'s stored screen setup cannot be read (it is not JSON). Open Screens… in the main window to reset it.')
    expect(standbyText({ kind: 'unreadable', what: 'target', detail: 'it is not JSON' }, scenario).why)
      .toBe('This browser\'s stored record of what the screens show cannot be read (it is not JSON). Open Screens… in the main window to reset it.')
  })
})
