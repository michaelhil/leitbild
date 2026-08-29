import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..')
const baselineRef = 'd212523'
const iterations = 75

const run = async (command: ReadonlyArray<string>, cwd = repositoryRoot): Promise<string> => {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed:\n${stderr}`)
  return stdout.trim()
}

const availablePort = (): number => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const port = server.port!
  server.stop(true)
  return port
}

const percentile = (values: ReadonlyArray<number>, fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0
}

const summarize = (values: ReadonlyArray<number>) => ({
  meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
  p50Ms: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
})

const waitForHealth = async (baseUrl: string, process: ReturnType<typeof Bun.spawn>): Promise<number> => {
  const startedAt = performance.now()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`server exited before health check: ${process.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return performance.now() - startedAt
    } catch {
      // A refused connection is expected while the process starts.
    }
    await Bun.sleep(20)
  }
  throw new Error(`server did not become healthy: ${baseUrl}`)
}

const benchmarkServer = async (config: {
  readonly kind: 'baseline' | 'experiment'
  readonly cwd: string
  readonly stateHome: string
}): Promise<{
  readonly startupMs: number
  readonly create: ReturnType<typeof summarize>
  readonly list: ReturnType<typeof summarize>
  readonly stateBytes: number
}> => {
  const port = availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const bun = Bun.which('bun')
  if (!bun) throw new Error('Bun executable not found')
  const environment = {
    ...process.env,
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    ...(config.kind === 'baseline'
      ? { SUITE_HOME: config.stateHome }
      : {
          WORKSPACE_HOST_HOME: config.stateHome,
          WORKSPACE_MODULES: '[]',
          WORKSPACE_EXPERIENCES: '[]',
        }),
  }
  const child = Bun.spawn([bun, 'run', 'src/index.ts'], {
    cwd: config.cwd,
    env: environment,
    stdout: 'ignore',
    stderr: 'inherit',
  })
  try {
    const startupMs = await waitForHealth(baseUrl, child)
    const createDurations: number[] = []
    const listDurations: number[] = []
    for (let index = 0; index < iterations; index += 1) {
      const createStarted = performance.now()
      const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config.kind === 'baseline'
          ? { displayName: `Workspace ${index}`, moduleIds: [] }
          : { name: `Workspace ${index}` }),
      })
      if (createResponse.status !== 201) throw new Error(`${config.kind} create returned HTTP ${createResponse.status}`)
      await createResponse.arrayBuffer()
      createDurations.push(performance.now() - createStarted)

      const listStarted = performance.now()
      const listResponse = await fetch(`${baseUrl}/api/workspaces`)
      if (!listResponse.ok) throw new Error(`${config.kind} list returned HTTP ${listResponse.status}`)
      await listResponse.arrayBuffer()
      listDurations.push(performance.now() - listStarted)
    }
    const statePath = config.kind === 'baseline'
      ? join(config.stateHome, 'workspaces.json')
      : join(config.stateHome, 'workspaces.sqlite')
    return {
      startupMs,
      create: summarize(createDurations),
      list: summarize(listDurations),
      stateBytes: (await stat(statePath)).size,
    }
  } finally {
    child.kill('SIGTERM')
    await child.exited
  }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'workspace-platform-benchmark-'))
const baselineRoot = join(temporaryRoot, 'baseline')
let worktreeCreated = false

try {
  await run(['git', 'worktree', 'add', '--detach', baselineRoot, baselineRef])
  worktreeCreated = true
  await run(['bun', 'install', '--frozen-lockfile'], baselineRoot)

  const baseline = await benchmarkServer({
    kind: 'baseline',
    cwd: join(baselineRoot, 'apps', 'suite'),
    stateHome: join(temporaryRoot, 'baseline-state'),
  })
  const experiment = await benchmarkServer({
    kind: 'experiment',
    cwd: join(repositoryRoot, 'apps', 'workspace-host'),
    stateHome: join(temporaryRoot, 'experiment-state'),
  })

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    iterations,
    baseline: { ref: baselineRef, controlPlane: 'Suite', ...baseline },
    experiment: { ref: 'HEAD', controlPlane: 'Workspace Host', ...experiment },
  }, null, 2))
} finally {
  if (worktreeCreated) await run(['git', 'worktree', 'remove', '--force', baselineRoot])
  await rm(temporaryRoot, { recursive: true, force: true })
}
