type SitlStack = 'px4' | 'ardupilot'

const stackValue = process.env.LEITBILD_DRONE_SITL_STACK ?? 'px4'
const stack = ((): SitlStack => {
  if (stackValue === 'px4' || stackValue === 'ardupilot') return stackValue
  throw new Error(`LEITBILD_DRONE_SITL_STACK must be px4 or ardupilot; got ${stackValue}`)
})()

const script = stack === 'px4'
  ? 'scripts/drone/run-px4-gazebo.ts'
  : 'scripts/drone/run-ardupilot-gazebo.ts'

const child = Bun.spawn({
  cmd: [process.execPath, 'run', script],
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

if (exitCode !== 0) throw new Error(`Drone ${stack} SITL exited with code ${exitCode}`)
