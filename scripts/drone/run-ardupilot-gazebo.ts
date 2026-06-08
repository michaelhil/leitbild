import { existsSync } from 'node:fs'

const ardupilotHome = process.env.ARDUPILOT_HOME ?? '/opt/leitbild/ardupilot'
const vehicle = process.env.ARDUPILOT_VEHICLE ?? 'ArduCopter'
const frame = process.env.ARDUPILOT_FRAME ?? 'gazebo-iris'
const mavlinkOut = process.env.ARDUPILOT_MAVLINK_OUT ?? 'udp:127.0.0.1:14540'
const simVehicle = `${ardupilotHome}/Tools/autotest/sim_vehicle.py`

if (!existsSync(simVehicle)) throw new Error(`ArduPilot sim_vehicle.py does not exist: ${simVehicle}`)

const child = Bun.spawn({
  cmd: [
    simVehicle,
    '-v',
    vehicle,
    '-f',
    frame,
    '--out',
    mavlinkOut,
    '--no-rebuild',
  ],
  cwd: ardupilotHome,
  env: process.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

const forwardSignal = (signal: NodeJS.Signals): void => {
  child.kill(signal)
}

process.on('SIGINT', forwardSignal)
process.on('SIGTERM', forwardSignal)

const exitCode = await child.exited
process.off('SIGINT', forwardSignal)
process.off('SIGTERM', forwardSignal)

if (exitCode !== 0) throw new Error(`ArduPilot Gazebo SITL exited with code ${exitCode}`)
