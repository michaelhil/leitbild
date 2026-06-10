import { describe, expect, test } from 'bun:test'
import {
  actionForKeyCode,
  assignDroneKeyBinding,
  defaultDroneKeyBindings,
  droneManualAxesForPressedKeys,
  droneRuntimeAxesForPilotIntent,
  formatKeyCode,
  normalizeDroneKeyBindings,
} from '../src/ui/drone/drone-key-bindings.ts'

describe('drone key bindings', () => {
  test('normalizes missing and unknown stored values to the default action map', () => {
    const bindings = normalizeDroneKeyBindings({ unknown: 'KeyX', 'flight.forward': 'KeyI' })

    expect(bindings['flight.forward']).toBe('KeyI')
    expect(bindings['flight.backward']).toBe('KeyS')
    expect(bindings['flight.descend']).toBe('KeyZ')
    expect(bindings['camera.viewFpv']).toBe('Digit2')
  })

  test('assigning a key removes that key from the previous action', () => {
    const bindings = defaultDroneKeyBindings()
    const reassigned = assignDroneKeyBinding(bindings, 'flight.yawLeft', 'KeyD')

    expect(reassigned['flight.yawLeft']).toBe('KeyD')
    expect(reassigned['flight.right']).toBe('')
    expect(actionForKeyCode(reassigned, 'KeyD')).toBe('flight.yawLeft')
  })

  test('formats physical key codes for the binding editor', () => {
    expect(formatKeyCode('KeyQ')).toBe('Q')
    expect(formatKeyCode('Digit3')).toBe('3')
    expect(formatKeyCode('KeyZ')).toBe('Z')
    expect(formatKeyCode('ShiftLeft')).toBe('Left Shift')
    expect(formatKeyCode('')).toBe('Unassigned')
  })

  test('combines forward and vertical keys into one manual flight intent', () => {
    const bindings = defaultDroneKeyBindings()

    expect(droneManualAxesForPressedKeys(bindings, new Set(['KeyW', 'Space']))).toEqual({
      forward: 1,
      right: 0,
      vertical: 1,
      yaw: 0,
    })
    expect(droneManualAxesForPressedKeys(bindings, new Set(['KeyW', 'KeyZ']))).toEqual({
      forward: 1,
      right: 0,
      vertical: -1,
      yaw: 0,
    })
  })

  test('keeps lateral pilot intent natural and adapts it for the runtime body frame', () => {
    const bindings = defaultDroneKeyBindings()
    const rightIntent = droneManualAxesForPressedKeys(bindings, new Set(['KeyD']))
    const leftIntent = droneManualAxesForPressedKeys(bindings, new Set(['KeyA']))

    expect(rightIntent.right).toBe(1)
    expect(leftIntent.right).toBe(-1)
    expect(droneRuntimeAxesForPilotIntent(rightIntent).right).toBe(-1)
    expect(droneRuntimeAxesForPilotIntent(leftIntent).right).toBe(1)
  })

  test('cancels opposing movement keys without affecting independent axes', () => {
    const bindings = defaultDroneKeyBindings()

    expect(droneManualAxesForPressedKeys(bindings, new Set(['KeyW', 'KeyS', 'KeyA', 'KeyE']))).toEqual({
      forward: 0,
      right: -1,
      vertical: 0,
      yaw: 1,
    })
  })
})
