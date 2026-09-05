import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

describe('browser bundle boundary', () => {
  test('the complete UI graph bundles without runtime module resolution', async () => {
    const process = Bun.spawn(['bun', 'run', 'scripts/build-ui.ts'], {
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })
})
