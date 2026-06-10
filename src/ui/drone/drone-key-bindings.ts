import type { DroneManualAxes } from '../../packs/drone/model.ts'

export type DroneKeyBindingAction =
  | 'flight.forward'
  | 'flight.backward'
  | 'flight.left'
  | 'flight.right'
  | 'flight.climb'
  | 'flight.descend'
  | 'flight.yawLeft'
  | 'flight.yawRight'
  | 'camera.view3d'
  | 'camera.viewFpv'
  | 'camera.view2d'

export interface DroneKeyBindingDefinition {
  readonly action: DroneKeyBindingAction
  readonly label: string
  readonly defaultCode: string
  readonly group: 'flight' | 'camera'
}

export type DroneKeyBindingMap = Readonly<Record<DroneKeyBindingAction, string>>

export interface DroneKeyBindingStorage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

export const droneKeyBindingStorageKey = 'leitbild.drone.keyBindings.v2'

export const droneKeyBindingDefinitions: ReadonlyArray<DroneKeyBindingDefinition> = [
  { action: 'flight.forward', label: 'Forward', defaultCode: 'KeyW', group: 'flight' },
  { action: 'flight.backward', label: 'Backward', defaultCode: 'KeyS', group: 'flight' },
  { action: 'flight.left', label: 'Left', defaultCode: 'KeyA', group: 'flight' },
  { action: 'flight.right', label: 'Right', defaultCode: 'KeyD', group: 'flight' },
  { action: 'flight.climb', label: 'Climb', defaultCode: 'Space', group: 'flight' },
  { action: 'flight.descend', label: 'Descend', defaultCode: 'KeyZ', group: 'flight' },
  { action: 'flight.yawLeft', label: 'Yaw left', defaultCode: 'KeyQ', group: 'flight' },
  { action: 'flight.yawRight', label: 'Yaw right', defaultCode: 'KeyE', group: 'flight' },
  { action: 'camera.view3d', label: '3D view', defaultCode: 'Digit1', group: 'camera' },
  { action: 'camera.viewFpv', label: 'FPV view', defaultCode: 'Digit2', group: 'camera' },
  { action: 'camera.view2d', label: '2D view', defaultCode: 'Digit3', group: 'camera' },
]

const actionSet = new Set<DroneKeyBindingAction>(droneKeyBindingDefinitions.map(definition => definition.action))

export const defaultDroneKeyBindings = (): DroneKeyBindingMap =>
  Object.fromEntries(droneKeyBindingDefinitions.map(definition => [definition.action, definition.defaultCode])) as DroneKeyBindingMap

export const formatKeyCode = (
  code: string,
): string => {
  if (code === '') return 'Unassigned'
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code === 'Space') return 'Space'
  if (code === 'ShiftLeft') return 'Left Shift'
  if (code === 'ShiftRight') return 'Right Shift'
  if (code === 'ArrowUp') return 'Up'
  if (code === 'ArrowDown') return 'Down'
  if (code === 'ArrowLeft') return 'Left Arrow'
  if (code === 'ArrowRight') return 'Right Arrow'
  return code.replace(/([a-z])([A-Z])/g, '$1 $2')
}

export const normalizeDroneKeyBindings = (
  value: unknown,
): DroneKeyBindingMap => {
  const defaults = defaultDroneKeyBindings()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const candidate = value as Record<string, unknown>
  const entries = droneKeyBindingDefinitions.map(definition => {
    const configured = candidate[definition.action]
    return [
      definition.action,
      typeof configured === 'string' ? configured : defaults[definition.action],
    ] as const
  })
  const seenCodes = new Set<string>()
  const uniqueEntries = entries.map(([action, code]) => {
    if (code === '') return [action, code] as const
    if (seenCodes.has(code)) return [action, ''] as const
    seenCodes.add(code)
    return [action, code] as const
  })
  return Object.fromEntries(uniqueEntries) as DroneKeyBindingMap
}

export const assignDroneKeyBinding = (
  bindings: DroneKeyBindingMap,
  action: DroneKeyBindingAction,
  code: string,
): DroneKeyBindingMap => {
  if (!actionSet.has(action)) return bindings
  const entries = droneKeyBindingDefinitions.map(definition => [
    definition.action,
    definition.action === action
      ? code
      : code !== '' && bindings[definition.action] === code
        ? ''
        : bindings[definition.action],
  ] as const)
  return Object.fromEntries(entries) as DroneKeyBindingMap
}

export const actionForKeyCode = (
  bindings: DroneKeyBindingMap,
  code: string,
): DroneKeyBindingAction | null => {
  for (const definition of droneKeyBindingDefinitions) {
    if (bindings[definition.action] === code) return definition.action
  }
  return null
}

const isPressed = (
  bindings: DroneKeyBindingMap,
  pressedCodes: ReadonlySet<string>,
  action: DroneKeyBindingAction,
): boolean => {
  const code = bindings[action]
  return code !== '' && pressedCodes.has(code)
}

export const droneManualAxesForPressedKeys = (
  bindings: DroneKeyBindingMap,
  pressedCodes: ReadonlySet<string>,
): DroneManualAxes => ({
  forward: (isPressed(bindings, pressedCodes, 'flight.forward') ? 1 : 0) + (isPressed(bindings, pressedCodes, 'flight.backward') ? -1 : 0),
  right: (isPressed(bindings, pressedCodes, 'flight.right') ? 1 : 0) + (isPressed(bindings, pressedCodes, 'flight.left') ? -1 : 0),
  vertical: (isPressed(bindings, pressedCodes, 'flight.climb') ? 1 : 0) + (isPressed(bindings, pressedCodes, 'flight.descend') ? -1 : 0),
  yaw: (isPressed(bindings, pressedCodes, 'flight.yawRight') ? 1 : 0) + (isPressed(bindings, pressedCodes, 'flight.yawLeft') ? -1 : 0),
})

export const readDroneKeyBindings = (
  storage: DroneKeyBindingStorage,
): DroneKeyBindingMap => {
  const raw = storage.getItem(droneKeyBindingStorageKey)
  if (!raw) return defaultDroneKeyBindings()
  return normalizeDroneKeyBindings(JSON.parse(raw))
}

export const writeDroneKeyBindings = (
  storage: DroneKeyBindingStorage,
  bindings: DroneKeyBindingMap,
): void => {
  storage.setItem(droneKeyBindingStorageKey, JSON.stringify(bindings))
}
