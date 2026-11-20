// Planning's frame address and the Host addresses it builds: `run` without `demo` is the Run Planning is
// shown beside, and every address built beside it keeps it as `world` (lanes.md, Plans in the Run).
import { describe, expect, test } from 'bun:test'
import { createHostAddresses, readPlanningQuery } from './address.ts'

const workspace = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'

describe('the router', () => {
  test('`run` without `demo` is the Run Planning is shown beside', () => {
    expect(readPlanningQuery('?run=run-1')).toEqual({ plan: null, demo: null, demoRun: null, besideRun: 'run-1', unreadableRun: false, agents: null, option: null })
    expect(readPlanningQuery('?run=run-1&plan=plan-7&agents=room-2')).toMatchObject({ plan: 'plan-7', besideRun: 'run-1', demoRun: null, agents: 'room-2' })
  })

  test('`run` with `demo` stays the guided demo\'s Run, never a Run to be beside', () => {
    expect(readPlanningQuery('?demo=nuclear-maintenance-planning&run=run-1&option=opt-1')).toEqual({
      plan: null, demo: 'nuclear-maintenance-planning', demoRun: 'run-1', besideRun: null, unreadableRun: false, agents: null, option: 'opt-1',
    })
  })

  test('without `run` Planning is beside no Run, as before', () => {
    expect(readPlanningQuery('')).toMatchObject({ besideRun: null, demoRun: null, unreadableRun: false })
    expect(readPlanningQuery('?plan=plan-7')).toMatchObject({ plan: 'plan-7', besideRun: null, unreadableRun: false })
  })

  test('a `run` that names no Run is said, never read as "beside no Run"', () => {
    expect(readPlanningQuery('?run=%20bad%2Fid')).toMatchObject({ besideRun: null, unreadableRun: true })
    // With `demo` the guided page says it, as before.
    expect(readPlanningQuery('?demo=halden-delivery-planning&run=%20bad')).toMatchObject({ demoRun: null, besideRun: null, unreadableRun: false })
  })
})

describe('Host addresses', () => {
  test('beside a Run every address names it as `world`', () => {
    const beside = createHostAddresses(workspace, { agents: null, besideRun: 'run-1' })
    expect(beside.workspace('library')).toBe(`/workspaces/${workspace}?world=run-1&planning=library`)
    expect(beside.workspace('plan-7')).toBe(`/workspaces/${workspace}?world=run-1&planning=plan-7`)
    expect(beside.workspace()).toBe(`/workspaces/${workspace}?world=run-1`)
  })

  test('the open Assistant conversation is kept beside a Run', () => {
    const beside = createHostAddresses(workspace, { agents: 'room-2', besideRun: 'run-1' })
    expect(beside.workspace('plan-7')).toBe(`/workspaces/${workspace}?agents=room-2&world=run-1&planning=plan-7`)
  })

  test('a plan linked to another Run opens beside that Run', () => {
    const beside = createHostAddresses(workspace, { agents: null, besideRun: 'run-1' })
    expect(beside.planBeside('plan-7', 'run-9')).toBe(`/workspaces/${workspace}?world=run-9&planning=plan-7`)
  })

  test('beside no Run the addresses are as before', () => {
    const alone = createHostAddresses(workspace, { agents: null, besideRun: null })
    expect(alone.workspace('library')).toBe(`/workspaces/${workspace}?planning=library`)
    expect(alone.workspace()).toBe(`/workspaces/${workspace}`)
    const withRoom = createHostAddresses(workspace, { agents: 'room-2', besideRun: null })
    expect(withRoom.workspace('plan-7')).toBe(`/workspaces/${workspace}?agents=room-2&planning=plan-7`)
    // The guided demo pages' map links.
    expect(withRoom.world('run-1', 'unit:delivery-truck')).toBe(`/workspaces/${workspace}?agents=room-2&world=run-1&focus=unit%3Adelivery-truck`)
    expect(alone.world('run-1', 'plant:maintenance', 'serviceWaterPumpA', 'opt-1')).toBe(`/workspaces/${workspace}?world=run-1&focus=plant%3Amaintenance&element=serviceWaterPumpA&option=opt-1`)
  })
})
