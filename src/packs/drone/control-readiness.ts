import type { DronePackData } from './model.ts'

export interface DroneManualControlReadiness {
  readonly ready: boolean
  readonly reason?: string
}

const minimumManualRelativeAltitudeM = 0.8
const externalControlNavigationKinds: ReadonlySet<DronePackData['navigation']['kind']> = new Set([
  'manual',
  'guided',
  'offboard',
  'hold',
  'takeoff',
])

export const droneManualControlReadiness = (data: DronePackData): DroneManualControlReadiness => {
  if (data.link.state !== 'connected') {
    return { ready: false, reason: `MAVLink system ${data.vehicle.systemId} is not connected` }
  }
  if (!data.arming.armed) {
    return { ready: false, reason: 'manual flight requires an armed drone' }
  }
  const relativeAltitudeM = data.pose.relativeAltitudeM ?? data.pose.altitudeM
  if (relativeAltitudeM < minimumManualRelativeAltitudeM) {
    return { ready: false, reason: 'manual flight requires takeoff before stick input' }
  }
  if (!externalControlNavigationKinds.has(data.navigation.kind)) {
    return {
      ready: false,
      reason: `manual flight is not available while the autopilot is in ${data.navigation.mode}`,
    }
  }
  return { ready: true }
}
