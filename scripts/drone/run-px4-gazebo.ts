import { existsSync } from 'node:fs'

const px4Home = process.env.PX4_HOME ?? '/opt/leitbild/PX4-Autopilot'
const makeTarget = process.env.PX4_SITL_TARGET ?? 'px4_sitl'
const gazeboModelTarget = process.env.PX4_GAZEBO_MODEL_TARGET ?? 'gz_x500_depth'
const gazeboWorld = process.env.PX4_GZ_WORLD
const headless = process.env.HEADLESS ?? '1'

const px4Binary = `${px4Home}/build/px4_sitl_default/bin/px4`
if (!existsSync(px4Home)) throw new Error(`PX4 home does not exist: ${px4Home}`)

const env = {
  ...process.env,
  HEADLESS: headless,
  ...(gazeboWorld === undefined ? {} : { PX4_GZ_WORLD: gazeboWorld }),
}

const child = Bun.spawn({
  cmd: ['make', makeTarget, gazeboModelTarget],
  cwd: px4Home,
  env,
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

if (exitCode !== 0) {
  throw new Error(`PX4 Gazebo SITL exited with code ${exitCode}; expected ${px4Binary} to be runnable after setup`)
}
