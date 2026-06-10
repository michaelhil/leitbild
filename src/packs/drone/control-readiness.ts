import type { DronePackData } from './model.ts'

export interface DroneManualControlReadiness {
  readonly ready: boolean
  readonly reason?: string
}

const externalControlNavigationKinds: ReadonlySet<DronePackData['navigation']['kind']> = new Set([
  'manual',
  'guided',
  'offboard',
  'hold',
  'takeoff',
  'land',
  'return_to_launch',
])

export const droneManualControlReadiness = (data: DronePackData): DroneManualControlReadiness => {
  if (data.link.state !== 'connected') {
    return { ready: false, reason: 'drone runtime link is not connected' }
  }
  if (!externalControlNavigationKinds.has(data.navigation.kind)) {
    return {
      ready: false,
      reason: `manual flight is not available while the drone is in ${data.navigation.mode}`,
    }
  }
  return { ready: true }
}
