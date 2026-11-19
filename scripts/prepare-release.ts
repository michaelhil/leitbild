import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertPublicWorldSource, createArtifact, normalizedRepositoryUrl, PUBLIC_CODE_REPOSITORY } from '../apps/leitbild/scripts/deploy.ts'
import { cleanRevision, withPreparedPlatform } from './prepare-platform.ts'

export const KNOWLEDGE_REPOSITORY = 'https://github.com/michaelhil/leitbild-wiki.git'
const repository = resolve(import.meta.dir, '..')
const commit = /^[a-f0-9]{40}$/
type Artifact = Awaited<ReturnType<typeof createArtifact>>
export type PreparedRelease = Pick<Artifact, 'manifest' | 'archiveChecksum' | 'lockChecksum'>

const within = (parent: string, child: string): boolean => {
  const path = relative(parent, child)
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

export const parsePrepareReleaseArgs = (args: readonly string[]): { codeRevision: string; knowledgeRevision: string; knowledgeRoot: string; outputDirectory: string } => {
  if (args.length !== 4 || !commit.test(args[0]!) || !commit.test(args[1]!) || !isAbsolute(args[2]!) || !isAbsolute(args[3]!)) {
    throw new Error('Usage: bun scripts/prepare-release.ts <full lowercase code SHA> <full lowercase wiki SHA> <absolute wiki checkout> <absolute output directory>')
  }
  const knowledgeRoot = resolve(args[2]!)
  const outputDirectory = resolve(args[3]!)
  if (within(repository, knowledgeRoot)) throw new Error('The knowledge checkout must be outside the code checkout')
  if (within(repository, outputDirectory) || within(knowledgeRoot, outputDirectory)) throw new Error('Prepared artifacts must be outside both checkouts')
  return { codeRevision: args[0]!, knowledgeRevision: args[1]!, knowledgeRoot, outputDirectory }
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`)
  return stdout.trim()
}

const digest = async (path: string): Promise<string> => new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex')

/** A successful full preparation is copied before its temporary archive is cleaned. Existing outputs are never overwritten. */
export const retainPreparedRelease = async (artifact: Pick<Artifact, 'archivePath' | 'manifest' | 'archiveChecksum' | 'lockChecksum'>, outputDirectory: string): Promise<PreparedRelease> => {
  await mkdir(outputDirectory, { mode: 0o700 })
  try {
    const archive = join(outputDirectory, 'release.tgz')
    await copyFile(artifact.archivePath, archive)
    if (await digest(archive) !== artifact.archiveChecksum) throw new Error('Copied release archive checksum differs from the prepared artifact')
    const metadata: PreparedRelease = { manifest: artifact.manifest, archiveChecksum: artifact.archiveChecksum, lockChecksum: artifact.lockChecksum }
    const descriptor = join(outputDirectory, 'artifact.json')
    await writeFile(descriptor, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(join(outputDirectory, 'SHA256SUMS'), `${artifact.archiveChecksum}  release.tgz\n${await digest(descriptor)}  artifact.json\n`, { flag: 'wx', mode: 0o600 })
    return metadata
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true })
    throw error
  }
}

const main = async (): Promise<void> => {
  const { codeRevision, knowledgeRevision, knowledgeRoot, outputDirectory } = parsePrepareReleaseArgs(process.argv.slice(2))
  const expectedBun = (await Bun.file(join(repository, '.bun-version')).text()).trim()
  if (Bun.version !== expectedBun) throw new Error(`Bun ${expectedBun} required; found ${Bun.version}`)
  if ((await assertPublicWorldSource(repository, PUBLIC_CODE_REPOSITORY)).baseCommit !== codeRevision) throw new Error('The clean public code checkout does not match the requested SHA')
  await git(repository, ['merge-base', '--is-ancestor', codeRevision, 'refs/remotes/origin/main'])
  if (normalizedRepositoryUrl(await git(knowledgeRoot, ['remote', 'get-url', 'origin'])) !== normalizedRepositoryUrl(KNOWLEDGE_REPOSITORY)) throw new Error('The knowledge checkout is not the canonical Leitbild wiki repository')
  if (await cleanRevision(knowledgeRoot) !== knowledgeRevision) throw new Error('The clean knowledge checkout does not match the requested SHA')
  const branch = await git(repository, ['branch', '--show-current']) || '(detached)'
  const artifact = await withPreparedPlatform({ codeRoot: repository, knowledgeRoot, codeRevision, full: true }, async (root, revision, knowledge) => {
    if (knowledge.revision !== knowledgeRevision) throw new Error('Prepared knowledge differs from the requested SHA')
    if ((await assertPublicWorldSource(repository, PUBLIC_CODE_REPOSITORY)).baseCommit !== revision) throw new Error('Public code changed during preparation')
    return await createArtifact(root, revision, branch, knowledge)
  })
  try {
    const metadata = await retainPreparedRelease(artifact, outputDirectory)
    console.log(JSON.stringify({ outputDirectory, releaseId: metadata.manifest.releaseId, codeRevision, knowledgeRevision }))
  } finally { await artifact.cleanup() }
}

if (import.meta.main) await main()
