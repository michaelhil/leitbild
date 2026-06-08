import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'

type SitlStack = 'px4' | 'ardupilot' | 'all'

const stackValue = process.argv[2] ?? process.env.LEITBILD_DRONE_SITL_STACK ?? 'px4'
const stack = ((): SitlStack => {
  if (stackValue === 'px4' || stackValue === 'ardupilot' || stackValue === 'all') return stackValue
  throw new Error(`LEITBILD_DRONE_SITL_STACK must be px4, ardupilot, or all; got ${stackValue}`)
})()

const installApt = process.env.LEITBILD_DRONE_SITL_SETUP_APT !== '0'
const root = process.env.LEITBILD_DRONE_SITL_ROOT ?? '/opt/leitbild'
const px4Home = process.env.PX4_HOME ?? `${root}/PX4-Autopilot`
const ardupilotHome = process.env.ARDUPILOT_HOME ?? `${root}/ardupilot`
const ardupilotGazeboHome = process.env.ARDUPILOT_GAZEBO_HOME ?? `${root}/ardupilot_gazebo`
const px4GazeboModelTarget = process.env.PX4_GAZEBO_MODEL_TARGET ?? 'gz_x500_depth'
const px4BuildDir = `${px4Home}/build/px4_sitl_default`

const run = async (cmd: string, args: ReadonlyArray<string>, cwd?: string): Promise<void> => {
  const child = Bun.spawn({
    cmd: [cmd, ...args],
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...process.env, DEBIAN_FRONTEND: process.env.DEBIAN_FRONTEND ?? 'noninteractive' },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with code ${exitCode}`)
}

const ensureLinuxHost = (): void => {
  if (process.platform !== 'linux') {
    throw new Error('Gazebo SITL setup must run on the Linux deployment host')
  }
}

const installCommonPackages = async (): Promise<void> => {
  if (!installApt) return
  ensureLinuxHost()
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Gazebo SITL package setup requires root; rerun as root or set LEITBILD_DRONE_SITL_SETUP_APT=0 after provisioning dependencies')
  }
  await run('apt-get', ['update'])
  await run('apt-get', [
    'install',
    '-y',
    'build-essential',
    'ccache',
    'cmake',
    'g++',
    'gcc',
    'gdb',
    'genromfs',
    'git',
    'libeigen3-dev',
    'libprotobuf-dev',
    'libxml2-dev',
    'libxslt-dev',
    'make',
    'ninja-build',
    'pkg-config',
    'protobuf-compiler',
    'python3-dev',
    'python3-empy',
    'python3-numpy',
    'python3-pip',
    'python3-setuptools',
    'python3-venv',
    'python3-wheel',
    'rsync',
  ])
}

const cloneIfMissing = async (repo: string, target: string, recursive: boolean): Promise<void> => {
  if (existsSync(target)) return
  await mkdir(root, { recursive: true })
  await run('git', recursive ? ['clone', '--recursive', repo, target] : ['clone', repo, target])
}

const px4BuildHasTarget = async (target: string): Promise<boolean> => {
  if (!existsSync(`${px4BuildDir}/build.ninja`)) return false
  const child = Bun.spawn({
    cmd: ['ninja', '-C', px4BuildDir, '-t', 'targets'],
    env: { ...process.env, DEBIAN_FRONTEND: process.env.DEBIAN_FRONTEND ?? 'noninteractive' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`ninja target inspection failed: ${stderr.trim()}`)
  return stdout.split('\n').some((line) => line.startsWith(`${target}:`))
}

const setupPx4 = async (): Promise<void> => {
  await cloneIfMissing('https://github.com/PX4/PX4-Autopilot.git', px4Home, true)
  await run('bash', ['./Tools/setup/ubuntu.sh', '--no-nuttx'], px4Home)
  if (existsSync(px4BuildDir) && !(await px4BuildHasTarget(px4GazeboModelTarget))) {
    await run('make', ['distclean'], px4Home)
  }
  await run('make', ['px4_sitl_default'], px4Home)
  if (!(await px4BuildHasTarget(px4GazeboModelTarget))) {
    throw new Error(`PX4 Gazebo target ${px4GazeboModelTarget} is unavailable after setup; verify Gazebo simulator dependencies on this host`)
  }
}

const setupArduPilot = async (): Promise<void> => {
  await cloneIfMissing('https://github.com/ArduPilot/ardupilot.git', ardupilotHome, true)
  await run('bash', ['./Tools/environment_install/install-prereqs-ubuntu.sh', '-y'], ardupilotHome)
  await run('./waf', ['configure', '--board', 'sitl'], ardupilotHome)
  await run('./waf', ['copter'], ardupilotHome)
  await cloneIfMissing('https://github.com/ArduPilot/ardupilot_gazebo.git', ardupilotGazeboHome, false)
  await run('cmake', ['-S', '.', '-B', 'build', '-DCMAKE_BUILD_TYPE=RelWithDebInfo'], ardupilotGazeboHome)
  await run('cmake', ['--build', 'build', '--target', 'install'], ardupilotGazeboHome)
}

await installCommonPackages()
if (stack === 'px4' || stack === 'all') await setupPx4()
if (stack === 'ardupilot' || stack === 'all') await setupArduPilot()

console.log(`Drone SITL setup complete for ${stack}`)
