import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'

const px4Home = process.env.PX4_HOME ?? '/opt/leitbild/PX4-Autopilot'
const buildTarget = process.env.PX4_BUILD_TARGET ?? 'px4_sitl_default'
const px4BuildDir = `${px4Home}/build/${buildTarget}`
const px4Binary = `${px4BuildDir}/bin/px4`
const gazeboWorld = process.env.PX4_GZ_WORLD ?? 'default'
const headless = process.env.HEADLESS ?? '1'
const vehicleCount = Number(process.env.LEITBILD_DRONE_SITL_VEHICLES ?? '1')

if (!existsSync(px4Home)) throw new Error(`PX4 home does not exist: ${px4Home}`)
if (!existsSync(px4Binary)) throw new Error(`PX4 binary does not exist: ${px4Binary}; run bun run drone:sitl:setup first`)
if (!Number.isInteger(vehicleCount) || vehicleCount <= 0 || vehicleCount > 10) {
  throw new Error(`LEITBILD_DRONE_SITL_VEHICLES must be an integer from 1 to 10; got ${process.env.LEITBILD_DRONE_SITL_VEHICLES}`)
}

type Px4Process = ReturnType<typeof Bun.spawn>

const splitList = (value: string | undefined, fallback: string, separator: string): ReadonlyArray<string> => {
  const values = (value ?? fallback).split(separator).map(entry => entry.trim()).filter(entry => entry.length > 0)
  if (values.length === 0) throw new Error('expected at least one PX4 Gazebo value')
  return values
}

const normalizePx4Model = (model: string): string =>
  model.startsWith('gz_') ? model : `gz_${model}`

const modelByIndex = splitList(
  process.env.LEITBILD_DRONE_SITL_MODELS ?? process.env.PX4_GAZEBO_MODEL_TARGET,
  'gz_x500_depth',
  ',',
).map(normalizePx4Model)

const poseByIndex = splitList(
  process.env.LEITBILD_DRONE_SITL_POSES,
  '0,0,0.2,0,0,0|8,0,0.2,0,0,0|0,8,0.2,0,0,1.5708|8,8,0.2,0,0,3.1416',
  '|',
)

const appendPathEnv = (current: string | undefined, paths: ReadonlyArray<string>): string =>
  [...(current === undefined || current.length === 0 ? [] : [current]), ...paths].join(':')

const baseGazeboEnv = (): Record<string, string> => {
  const modelsPath = `${px4Home}/Tools/simulation/gz/models`
  const worldsPath = `${px4Home}/Tools/simulation/gz/worlds`
  const pluginsPath = `${px4BuildDir}/src/modules/simulation/gz_plugins`
  const serverConfig = `${px4Home}/src/modules/simulation/gz_bridge/server.config`
  return {
    ...process.env,
    HEADLESS: headless,
    GZ_IP: process.env.GZ_IP ?? '127.0.0.1',
    PX4_GZ_WORLD: gazeboWorld,
    PX4_GZ_MODELS: process.env.PX4_GZ_MODELS ?? modelsPath,
    PX4_GZ_WORLDS: process.env.PX4_GZ_WORLDS ?? worldsPath,
    PX4_GZ_PLUGINS: process.env.PX4_GZ_PLUGINS ?? pluginsPath,
    PX4_GZ_SERVER_CONFIG: process.env.PX4_GZ_SERVER_CONFIG ?? serverConfig,
    GZ_SIM_RESOURCE_PATH: appendPathEnv(process.env.GZ_SIM_RESOURCE_PATH, [modelsPath, worldsPath]),
    GZ_SIM_SYSTEM_PLUGIN_PATH: appendPathEnv(process.env.GZ_SIM_SYSTEM_PLUGIN_PATH, [pluginsPath]),
    GZ_SIM_SERVER_CONFIG_PATH: process.env.GZ_SIM_SERVER_CONFIG_PATH ?? serverConfig,
  }
}

const envForVehicle = (index: number): Record<string, string> => ({
  ...baseGazeboEnv(),
  PX4_SIM_MODEL: modelByIndex[index] ?? modelByIndex[modelByIndex.length - 1]!,
  PX4_GZ_MODEL_POSE: poseByIndex[index] ?? poseByIndex[poseByIndex.length - 1]!,
  ...(index === 0 ? {} : { PX4_GZ_NO_FOLLOW: process.env.PX4_GZ_NO_FOLLOW ?? '1' }),
})

const hasGazeboWorld = async (env: Record<string, string>): Promise<boolean> => {
  const child = Bun.spawn({
    cmd: ['gz', 'service', '-i', '--service', `/world/${gazeboWorld}/scene/info`],
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  const exitCode = await child.exited
  return exitCode === 0 && `${stdout}\n${stderr}`.includes('Service providers')
}

const waitForGazeboWorld = async (env: Record<string, string>): Promise<void> => {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (await hasGazeboWorld(env)) return
    await Bun.sleep(1_000)
  }
  throw new Error(`timed out waiting for Gazebo world "${gazeboWorld}"`)
}

const spawnVehicle = async (index: number): Promise<Px4Process> => {
  const workingDir = `${px4BuildDir}/leitbild_instance_${index}`
  await mkdir(workingDir, { recursive: true })
  const env = envForVehicle(index)
  console.log(`Starting PX4 Gazebo vehicle ${index + 1}/${vehicleCount}: ${env.PX4_SIM_MODEL} pose=${env.PX4_GZ_MODEL_POSE}`)
  return Bun.spawn({
    cmd: [px4Binary, '-i', String(index), '-d', `${px4BuildDir}/etc`],
    cwd: workingDir,
    env,
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  })
}

const children: Px4Process[] = []
children.push(await spawnVehicle(0))
if (vehicleCount > 1) await waitForGazeboWorld(envForVehicle(0))
for (let index = 1; index < vehicleCount; index += 1) {
  children.push(await spawnVehicle(index))
  await Bun.sleep(500)
}

const forwardSignal = (signal: NodeJS.Signals): void => {
  for (const child of children) child.kill(signal)
}

process.on('SIGINT', forwardSignal)
process.on('SIGTERM', forwardSignal)

const firstExit = await Promise.race(children.map(async (child, index) => ({
  index,
  exitCode: await child.exited,
})))
process.off('SIGINT', forwardSignal)
process.off('SIGTERM', forwardSignal)
for (const child of children) child.kill('SIGTERM')

if (firstExit.exitCode !== 0) {
  throw new Error(`PX4 Gazebo SITL vehicle ${firstExit.index} exited with code ${firstExit.exitCode}; expected ${px4Binary} to keep running`)
}
