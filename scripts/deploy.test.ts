import { describe, expect, test } from 'bun:test'
import {
  isSafeReleaseId,
  makeReleaseId,
  parseDeployArgs,
  remoteDeployScript,
  remotePreflightScript,
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

describe('Leitbild remote release transaction', () => {
  test('renders syntactically valid guarded shell', async () => {
    expect(await bashSyntaxExit(remotePreflightScript(true))).toBe(0)
    expect(await bashSyntaxExit(remoteDeployScript({
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
    }, '/tmp/release.tgz', true))).toBe(0)
  })
})
