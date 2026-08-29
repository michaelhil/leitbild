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

describe('Leitbild release deploy arguments', () => {
  test('defaults to a guarded quick deployment', () => {
    expect(parseDeployArgs([])).toEqual({
      dryRun: false,
      yes: false,
      updateService: false,
      full: false,
      tests: [],
      list: false,
      rollback: null,
    })
  })

  test('accepts selected tests or the full suite, but not both', () => {
    expect(parseDeployArgs(['--dry-run', '--test', 'tests/discovery.test.ts'])).toMatchObject({
      dryRun: true,
      full: false,
      tests: ['tests/discovery.test.ts'],
    })
    expect(parseDeployArgs(['--full'])).toMatchObject({ full: true, tests: [] })
    expect(() => parseDeployArgs(['--full', '--test', 'tests/discovery.test.ts'])).toThrow('mutually exclusive')
  })

  test('rejects unsafe rollback ids and incompatible operation modes', () => {
    expect(() => parseDeployArgs(['--rollback', '../../current'])).toThrow('Invalid release id')
    expect(() => parseDeployArgs(['--list', '--full'])).toThrow('cannot be combined')
  })
})

describe('Leitbild release identity', () => {
  test('is deterministic and shell-safe', () => {
    const id = makeReleaseId('2026-08-28T18:12:34.567Z', '0123456789', 'abcdef0123456789')
    expect(id).toBe('20260828T181234Z-0123456789-abcdef0123')
    expect(isSafeReleaseId(id)).toBe(true)
    expect(isSafeReleaseId('bad/id')).toBe(false)
    expect(isSafeReleaseId('bad;id')).toBe(false)
  })
})

describe('Leitbild release runtime version', () => {
  test('pins Bun consistently and rejects runtime drift', async () => {
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json()
    expect(packageJson.packageManager).toBe(`bun@${REQUIRED_BUN_VERSION}`)
    expect(packageJson.engines.bun).toBe(REQUIRED_BUN_VERSION)
    expect(() => assertBunVersion(REQUIRED_BUN_VERSION)).not.toThrow()
    expect(() => assertBunVersion('1.3.14')).toThrow('Bun 1.4.0 is required')
    expect(remotePreflightScript(false)).toContain('/opt/leitbild/runtime/bun --version')
  })
})

describe('Leitbild remote release transaction', () => {
  test('renders syntactically valid guarded shell', async () => {
    expect(await bashSyntaxExit(remotePreflightScript(true))).toBe(0)
    const deployScript = remoteDeployScript({
      manifest: {
        schemaVersion: 1,
        app: 'leitbild',
        releaseId: 'release-1',
        createdAt: '2026-08-28T18:12:34.567Z',
        baseCommit: '0123456789',
        branch: 'main',
        dirty: true,
        worktreeStatus: [' M src/index.ts'],
        sourceDigest: 'a'.repeat(64),
        fileCount: 1,
        validation: 'quick',
        validationCommands: ['bun run check'],
        persistentRootsExcluded: ['/opt/leitbild/maps'],
      },
      archiveChecksum: 'b'.repeat(64),
      lockChecksum: 'c'.repeat(64),
    }, '/tmp/release.tgz', true)
    expect(await bashSyntaxExit(deployScript)).toBe(0)
    expect(deployScript).toContain('/run/lock/samsinn-stack-deploy.lock')
    expect(deployScript).toContain('https://leitbild.samsinn.app/health')
    expect(deployScript).toContain('/map/capabilities.json')
    const rollbackScript = remoteRollbackScript('release-1')
    expect(await bashSyntaxExit(rollbackScript)).toBe(0)
    expect(rollbackScript).toContain('/run/lock/samsinn-stack-deploy.lock')
    expect(rollbackScript).toContain('/api/scenarios')
    expect(rollbackScript).toContain('https://leitbild.samsinn.app/health')
  })
})
