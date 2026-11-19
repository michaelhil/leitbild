import { describe, expect, test } from 'bun:test'
import { WORKSPACE_SURFACE_PARAMETER } from '@leitbild/contracts'
import { launchDestination, WORKSPACE_URL_SURFACE_PARAMETER, workspacePath, workspaceUrl } from './launch-destination.ts'

const run = { moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
const room = { moduleId: 'agents', type: 'agents.room', id: 'room-1' }

describe('launch destination', () => {
  test('opens a created Run in the World pane of its Workspace', () => {
    expect(launchDestination('ws', [run])).toBe('/workspaces/ws?world=run-1')
    expect(launchDestination('ws', [run, room])).toBe('/workspaces/ws?world=run-1&agents=room-1')
  })

  test('keeps the current Run for a created conversation, but never carries a conversation into a new Run', () => {
    expect(launchDestination('ws', [room], { world: 'open-run', agents: 'old-room' })).toBe('/workspaces/ws?world=open-run&agents=room-1')
    expect(launchDestination('ws', [run], { world: 'open-run', agents: 'old-room' })).toBe('/workspaces/ws?world=run-1')
    expect(launchDestination('ws', [], { world: 'open-run', agents: 'old-room' })).toBe('/workspaces/ws?world=open-run&agents=old-room')
    expect(launchDestination('ws', [])).toBe('/workspaces/ws')
  })

  test('ignores unrelated created resources and encodes identities', () => {
    expect(launchDestination('ws', [{ moduleId: 'world', type: 'world.scenario', id: 's' }])).toBe('/workspaces/ws')
    expect(workspacePath('a/b c')).toBe('/workspaces/a%2Fb%20c')
    expect(new URL(workspaceUrl('ws', { agents: 'room/id & test' }), 'https://leitbild.app').searchParams.get('agents')).toBe('room/id & test')
  })

  test('a Run can be addressed on one surface and a window as a screen', () => {
    expect(WORKSPACE_URL_SURFACE_PARAMETER).toBe(WORKSPACE_SURFACE_PARAMETER)
    expect(workspaceUrl('ws', { world: 'run-1', surface: 'display:unit-1' })).toBe('/workspaces/ws?world=run-1&surface=display%3Aunit-1')
    expect(workspaceUrl('ws', { world: 'run-1', surface: 'procedures:unit-1', agents: 'room-1', screen: 'B' }))
      .toBe('/workspaces/ws?world=run-1&surface=procedures%3Aunit-1&agents=room-1&screen=B')
    expect(workspaceUrl('ws', { world: 'run-1', screen: 'D' })).toBe('/workspaces/ws?world=run-1&screen=D')
    expect(workspaceUrl('ws', { screen: 'A' })).toBe('/workspaces/ws?screen=A')
    expect(new URL(workspaceUrl('ws', { world: 'run-1', surface: 'display:a b&c' }), 'https://leitbild.app').searchParams.get('surface')).toBe('display:a b&c')
  })

  test('a surface is relative to a Run, so it is never written without one', () => {
    expect(workspaceUrl('ws', { surface: 'display:unit-1' })).toBe('/workspaces/ws')
    expect(workspaceUrl('ws', { surface: 'display:unit-1', agents: 'room-1' })).toBe('/workspaces/ws?agents=room-1')
    expect(launchDestination('ws', [run], { world: 'open-run', surface: 'display:unit-1', screen: 'B' })).toBe('/workspaces/ws?world=run-1')
  })

  test('a created plan opens Planning even when its use case also creates a World Run', () => {
    const plan = { moduleId: 'planning', type: 'planning.plan', id: 'plan-1' }
    expect(launchDestination('ws', [plan])).toBe('/workspaces/ws?planning=plan-1')
    expect(launchDestination('ws', [run, plan], { world: 'old-run', agents: 'old-room' })).toBe('/workspaces/ws?planning=plan-1')
    expect(launchDestination('ws', [room], { planning: 'plan-1' })).toBe('/workspaces/ws?agents=room-1&planning=plan-1')
    expect(launchDestination('ws', [run], { planning: 'plan-1' })).toBe('/workspaces/ws?world=run-1')
    expect(launchDestination('ws', [{ moduleId: 'planning', type: 'planning.study', id: 'old' }])).toBe('/workspaces/ws')
  })
})
