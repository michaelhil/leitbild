import { describe, expect, test } from 'bun:test'
import { runViewAddress, runViewMenuLabel, runViewOf } from './run-view.ts'

const WORKSPACE = 'https://leitbild.app/workspaces/ws'

describe('a Run\'s simulation or its plans', () => {
  test('the plans show while Planning is open beside the Run', () => {
    expect(runViewOf(null)).toBe('simulation')
    expect(runViewOf('library')).toBe('plans')
    expect(runViewOf('plan-1')).toBe('plans')
  })

  test('Plans opens the Library for this Run and keeps the rest of the address, so the World frame keeps its document', () => {
    const plans = runViewAddress(`${WORKSPACE}?world=run-1&focus=unit%3Atruck&surface=display%3Aunit-1&agents=room-1`, 'plans')
    expect(plans.searchParams.get('planning')).toBe('library')
    expect([...plans.searchParams.keys()]).toEqual(['world', 'focus', 'surface', 'agents', 'planning'])
    expect(plans.searchParams.get('focus')).toBe('unit:truck')
    expect(plans.pathname).toBe('/workspaces/ws')
    // An open plan gives way to the Library.
    expect(runViewAddress(`${WORKSPACE}?world=run-1&planning=plan-1`, 'plans').search).toBe('?world=run-1&planning=library')
  })

  test('Simulation leaves Planning and only Planning', () => {
    expect(runViewAddress(`${WORKSPACE}?world=run-1&planning=plan-1&agents=room-1`, 'simulation').search).toBe('?world=run-1&agents=room-1')
    expect(runViewAddress(`${WORKSPACE}?world=run-1&focus=unit%3Atruck&planning=library`, 'simulation').search).toBe('?world=run-1&focus=unit%3Atruck')
  })

  test('at phone width the More menu offers the other view', () => {
    expect(runViewMenuLabel('simulation')).toBe('Show plans')
    expect(runViewMenuLabel('plans')).toBe('Show the simulation')
  })
})
