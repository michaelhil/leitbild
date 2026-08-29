import { describe, expect, test } from 'bun:test'
import { parseDeployArgs, remoteDeployScript, remotePreflightScript } from './deploy.ts'

const bashSyntaxExit = async (script: string): Promise<number> => {
  const child = Bun.spawn(['bash', '-n'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  child.stdin.write(script)
  child.stdin.end()
  return child.exited
}

describe('suite deployment', () => {
  test('parses dry-run and first-install options strictly', () => {
    expect(parseDeployArgs([])).toEqual({ dryRun: false, yes: false, install: false })
    expect(parseDeployArgs(['--dry-run', '--yes', '--install'])).toEqual({
      dryRun: true,
      yes: true,
      install: true,
    })
    expect(() => parseDeployArgs(['--unknown'])).toThrow('Unknown argument')
  })

  test('renders guarded first-install and activation scripts', async () => {
    expect(await bashSyntaxExit(remotePreflightScript(true))).toBe(0)
    expect(await bashSyntaxExit(remotePreflightScript(false))).toBe(0)
    const script = remoteDeployScript({
      archiveChecksum: 'a'.repeat(64),
      lockChecksum: 'b'.repeat(64),
      manifest: {
        schemaVersion: 1,
        app: 'suite',
        releaseId: 'release-1',
        createdAt: '2026-08-29T14:00:00.000Z',
        baseCommit: 'c'.repeat(40),
        branch: 'main',
        dirty: false,
        worktreeStatus: [],
        sourceDigest: 'd'.repeat(64),
        contractsDigest: 'e'.repeat(64),
        fileCount: 1,
        persistentRootsExcluded: ['/var/lib/samsinn-suite'],
      },
    }, '/tmp/suite.tgz', true)
    expect(await bashSyntaxExit(script)).toBe(0)
    expect(script).toContain('/run/lock/samsinn-stack-deploy.lock')
    expect(script).toContain('useradd --system')
    expect(script).toContain('caddy validate')
    expect(script).toContain('https://samsinn.app/suite/health')
    expect(script).toContain('/var/lib/samsinn-suite')
  })
})
