import { describe, expect, test } from 'bun:test'
import {
  assertBunVersion,
  isSafeReleaseId,
  makeReleaseId,
  parseDeployArgs,
  REQUIRED_BUN_VERSION,
  remoteDeployScript,
  remotePreflightScript,
  remoteRollbackScript,
} from './deploy.ts'

const bashSyntaxExit = async (script: string): Promise<number> => {
  const child = Bun.spawn(['bash', '-n'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  child.stdin.write(script)
  child.stdin.end()
  return child.exited
}

describe('release deploy arguments', () => {
  test('defaults to a guarded production deployment', () => {
    expect(parseDeployArgs([])).toEqual({
      dryRun: false,
      yes: false,
      updateService: false,
      list: false,
      rollback: null,
    })
  })

  test('parses dry-run and first-service migration flags', () => {
    expect(parseDeployArgs(['--dry-run', '--yes', '--update-service'])).toEqual({
      dryRun: true,
      yes: true,
      updateService: true,
      list: false,
      rollback: null,
    })
  })

  test('rejects unsafe rollback ids and incompatible modes', () => {
    expect(() => parseDeployArgs(['--rollback', '../../current'])).toThrow('Invalid release id')
    expect(() => parseDeployArgs(['--list', '--rollback', 'release-1'])).toThrow('mutually exclusive')
    expect(() => parseDeployArgs(['--dry-run', '--list'])).toThrow('--dry-run')
  })
})

describe('release identity', () => {
  test('combines UTC time, commit, and source digest safely', () => {
    expect(makeReleaseId(
      '2026-08-28T18:12:34.567Z',
      '0123456789',
      'abcdef0123456789',
    )).toBe('20260828T181234Z-0123456789-abcdef0123')
  })

  test('accepts generated ids and rejects shell/path syntax', () => {
    expect(isSafeReleaseId('20260828T181234Z-0123456789-abcdef0123')).toBe(true)
    expect(isSafeReleaseId('../release')).toBe(false)
    expect(isSafeReleaseId('release;restart')).toBe(false)
    expect(isSafeReleaseId('')).toBe(false)
  })
})

describe('release runtime version', () => {
  test('pins Bun consistently and rejects runtime drift', async () => {
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json()
    expect(packageJson.packageManager).toBe(`bun@${REQUIRED_BUN_VERSION}`)
    expect(packageJson.engines.bun).toBe(REQUIRED_BUN_VERSION)
    expect(() => assertBunVersion(REQUIRED_BUN_VERSION)).not.toThrow()
    expect(() => assertBunVersion('1.3.14')).toThrow('Bun 1.4.0 is required')
    expect(remotePreflightScript(false)).toContain('/home/samsinn/.bun/bin/bun --version')
  })
})

describe('remote release transaction', () => {
  test('renders syntactically valid guarded shell', async () => {
    expect(await bashSyntaxExit(remotePreflightScript(true))).toBe(0)
    const deployScript = remoteDeployScript({
      manifest: {
        schemaVersion: 1,
        app: 'samsinn',
        releaseId: 'release-1',
        createdAt: '2026-08-28T18:12:34.567Z',
        baseCommit: '0123456789',
        branch: 'master',
        dirty: true,
        worktreeStatus: [' M src/main.ts'],
        sourceDigest: 'a'.repeat(64),
        fileCount: 1,
        validation: 'full',
        validationCommands: ['bun run check'],
      },
      archiveChecksum: 'b'.repeat(64),
      lockChecksum: 'c'.repeat(64),
    }, '/tmp/release.tgz', true)
    expect(await bashSyntaxExit(deployScript)).toBe(0)
    expect(deployScript).toContain('/run/lock/samsinn-stack-deploy.lock')
    expect(deployScript).toContain('scripts/smoke-streaming.ts')
    expect(deployScript).toContain('https://samsinn.app/health')
    const rollbackScript = remoteRollbackScript('release-1')
    expect(await bashSyntaxExit(rollbackScript)).toBe(0)
    expect(rollbackScript).toContain('/run/lock/samsinn-stack-deploy.lock')
    expect(rollbackScript).toContain('scripts/smoke-streaming.ts')
    expect(rollbackScript).toContain('https://samsinn.app/health')
  })
})
