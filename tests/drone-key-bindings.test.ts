import { describe, expect, test } from 'bun:test'
import {
  actionForKeyCode,
  assignDroneKeyBinding,
  defaultDroneKeyBindings,
  formatKeyCode,
  normalizeDroneKeyBindings,
} from '../src/ui/drone/drone-key-bindings.ts'

describe('drone key bindings', () => {
  test('normalizes missing and unknown stored values to the default action map', () => {
    const bindings = normalizeDroneKeyBindings({ unknown: 'KeyX', 'flight.forward': 'KeyI' })

    expect(bindings['flight.forward']).toBe('KeyI')
    expect(bindings['flight.backward']).toBe('KeyS')
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
    expect(formatKeyCode('ShiftLeft')).toBe('Left Shift')
    expect(formatKeyCode('')).toBe('Unassigned')
  })
})
