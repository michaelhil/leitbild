#!/usr/bin/env bun
// Build then promote in two separate subprocesses. We can't `await import`
// these because each script ends with process.exit() — that would kill the
// rebuild before the second script runs.
import { join } from 'node:path'

const scriptsDir = join(import.meta.dir)
const buildScript = join(scriptsDir, 'build.ts')
const promoteScript = join(scriptsDir, 'promote.ts')
const args = process.argv.slice(2)

const run = async (label: string, script: string): Promise<number> => {
  const proc = Bun.spawn(['bun', 'run', script, ...args], { stdout: 'inherit', stderr: 'inherit' })
  const exitCode = await proc.exited
  if (exitCode !== 0) console.error(`reference:rebuild — ${label} failed with exit ${exitCode}`)
  return exitCode
}

const buildExit = await run('build', buildScript)
if (buildExit !== 0) process.exit(buildExit)

const promoteExit = await run('promote', promoteScript)
process.exit(promoteExit)
