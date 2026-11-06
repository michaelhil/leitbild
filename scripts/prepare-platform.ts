import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { KnowledgeSnapshot } from '../packages/knowledge/src/index.ts'

const repository = resolve(import.meta.dir, '..')

export const knowledgeRepositoryPath = (codeRoot: string): string =>
  resolve(process.env.LEITBILD_KNOWLEDGE_REPOSITORY ?? join(codeRoot, '../Leitbild-wiki'))

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${stderr.trim()}`)
  return stdout.trim()
}

export const cleanRevision = async (root: string): Promise<string> => {
  if (await git(root, 'status', '--porcelain', '--untracked-files=all')) {
    throw new Error(`Commit or move outstanding files before preparing a release: ${root}`)
  }
  return await git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
}

const run = async (cwd: string, ...args: string[]): Promise<void> => {
  const child = Bun.spawn([process.execPath, '--no-env-file', ...args], { cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) throw new Error(`bun ${args.join(' ')} failed with exit code ${code}`)
}

export const withPreparedPlatform = async <T>(options: {
  readonly codeRoot: string
  readonly knowledgeRoot: string
  readonly codeRevision?: string
  readonly full: boolean
}, consume: (root: string, codeRevision: string, knowledge: KnowledgeSnapshot) => Promise<T>): Promise<T> => {
  const { codeRoot, knowledgeRoot, full } = options
  const [codeRevision, knowledgeRevision] = await Promise.all([cleanRevision(codeRoot), cleanRevision(knowledgeRoot)])
  if (options.codeRevision !== undefined && options.codeRevision !== codeRevision) throw new Error('Code revision changed after release preflight')
  console.log(`Preparing code ${codeRevision} with knowledge ${knowledgeRevision}`)

  const directory = await mkdtemp(join(tmpdir(), 'leitbild-prepare-'))
  const root = join(directory, 'code')
  try {
    // Only committed inputs enter this checkout. In particular, an ignored
    // snapshot, build output or local configuration cannot enter the release.
    await git(directory, 'clone', '--quiet', '--shared', '--no-checkout', codeRoot, root)
    await git(root, 'checkout', '--quiet', '--detach', codeRevision)
    const expectedBun = (await Bun.file(join(root, '.bun-version')).text()).trim()
    if (Bun.version !== expectedBun) throw new Error(`Bun ${expectedBun} required; found ${Bun.version}`)
    await run(root, 'install', '--frozen-lockfile')
    await run(root, 'run', 'knowledge:publish', knowledgeRoot)
    const snapshot = join(root, 'knowledge/snapshot.json')
    const publication = await Bun.file(snapshot).text()
    const knowledge = JSON.parse(publication) as KnowledgeSnapshot
    if (knowledge.revision !== knowledgeRevision) throw new Error('Knowledge revision changed after release preflight')
    await run(root, 'run', full ? 'validate' : 'build')
    await run(root, 'run', 'dev:smoke', `--knowledge-revision=${knowledgeRevision}`)
    if (await Bun.file(snapshot).text() !== publication) throw new Error('Validation modified the prepared publication')
    return await consume(root, codeRevision, knowledge)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length > 1) throw new Error('Usage: bun run verify [path/to/Leitbild-wiki]')
  await withPreparedPlatform({ codeRoot: repository, knowledgeRoot: args[0] ? resolve(args[0]) : knowledgeRepositoryPath(repository), full: false },
    async () => console.log('Pinned platform verification passed'))
}
