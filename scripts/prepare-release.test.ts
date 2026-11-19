import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parsePrepareReleaseArgs, retainPreparedRelease } from './prepare-release.ts'

const code = 'a'.repeat(40), wiki = 'b'.repeat(40)
const checksum = (value: string): string => new Bun.CryptoHasher('sha256').update(value).digest('hex')

test('release preparation requires exact code/wiki commits and an output outside the checkout', () => {
  const output = resolve(tmpdir(), 'leitbild-prepared-input-test')
  const knowledgeRoot = resolve(tmpdir(), 'leitbild-knowledge-input-test')
  expect(parsePrepareReleaseArgs([code, wiki, knowledgeRoot, output])).toEqual({ codeRevision: code, knowledgeRevision: wiki, knowledgeRoot, outputDirectory: output })
  for (const args of [[], [code, wiki], ['main', wiki, knowledgeRoot, output], [code.slice(0, 12), wiki, knowledgeRoot, output], [code.toUpperCase(), wiki, knowledgeRoot, output], [code, `${wiki}suffix`, knowledgeRoot, output], [code, wiki, knowledgeRoot, 'relative'], [code, wiki, knowledgeRoot, output, '--skip-tests'], [code, wiki, knowledgeRoot, resolve(import.meta.dir, '../artifacts')], [code, wiki, knowledgeRoot, join(knowledgeRoot, 'artifact')], [code, wiki, resolve(import.meta.dir, '..'), output]]) {
    expect(() => parsePrepareReleaseArgs(args)).toThrow()
  }
})

const artifactOf = (archivePath: string, contents: string): Parameters<typeof retainPreparedRelease>[0] => ({
  archivePath, archiveChecksum: checksum(contents), lockChecksum: 'c'.repeat(64),
  manifest: {
    schemaVersion: 1, app: 'leitbild-platform', releaseId: 'test-release', createdAt: '2026-11-18T15:00:00Z', baseCommit: code,
    codeRepository: 'https://github.com/michaelhil/leitbild', knowledgeRevision: wiki, branch: '(detached)', dirty: false,
    worktreeStatus: [], sourceDigest: 'd'.repeat(64), dependencyPackagesDigest: 'e'.repeat(64), fileCount: 1, persistentRootsExcluded: ['/var/lib/leitbild'],
  },
})

test('the prepared archive survives source cleanup with exact manifest and checksum metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-retain-artifact-'))
  try {
    const source = join(root, 'original.tgz'), output = join(root, 'retained')
    const contents = 'Test-only immutable archive bytes\n'
    await writeFile(source, contents)
    const artifact = artifactOf(source, contents)
    const metadata = await retainPreparedRelease(artifact, output)
    await rm(source)
    expect(await readFile(join(output, 'release.tgz'), 'utf8')).toBe(contents)
    expect((await readdir(output)).sort()).toEqual(['SHA256SUMS', 'artifact.json', 'release.tgz'])
    expect(metadata).toEqual({ manifest: artifact.manifest, archiveChecksum: artifact.archiveChecksum, lockChecksum: artifact.lockChecksum })
    const descriptor = await readFile(join(output, 'artifact.json'), 'utf8')
    expect(JSON.parse(descriptor)).toEqual(metadata)
    expect(await readFile(join(output, 'SHA256SUMS'), 'utf8')).toBe(`${checksum(contents)}  release.tgz\n${checksum(descriptor)}  artifact.json\n`)
    expect(descriptor).not.toContain('archivePath')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('bad copied bytes never become a prepared result and an existing output is never overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-refuse-artifact-'))
  try {
    const source = join(root, 'original.tgz'), output = join(root, 'retained')
    await writeFile(source, 'changed after preparation')
    await expect(retainPreparedRelease(artifactOf(source, 'original bytes'), output)).rejects.toThrow('checksum differs')
    expect(await Bun.file(join(output, 'artifact.json')).exists()).toBe(false)
    expect(await readdir(root)).toEqual(['original.tgz'])
    await mkdir(output)
    await writeFile(join(output, 'keep'), 'An earlier result')
    await expect(retainPreparedRelease(artifactOf(source, 'changed after preparation'), output)).rejects.toThrow()
    expect(await readFile(join(output, 'keep'), 'utf8')).toBe('An earlier result')
  } finally { await rm(root, { recursive: true, force: true }) }
})
