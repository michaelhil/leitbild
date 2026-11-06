import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LEITBILD_SOURCE_URL } from '../../world/src/ui/embed/openbridge-notice.ts'
import {
  assertPublicWorldSource,
  normalizedRepositoryUrl,
  PUBLIC_CODE_REPOSITORY,
  publicSourceRefusal,
} from './deploy.ts'

// World's browser bundle contains AGPL-3.0-only OpenBridge: a release may only
// be built from committed source that a branch of the public origin contains.

describe('deploy source guards', () => {
  test('the deploy requires the repository the bundle notice names as its corresponding source', () => {
    expect(PUBLIC_CODE_REPOSITORY).toBe(LEITBILD_SOURCE_URL)
  })

  test('the base commit must be on a branch of the public origin', () => {
    const base = { publicRepository: PUBLIC_CODE_REPOSITORY, codeRepository: 'git@github.com:michaelhil/leitbild.git', baseCommit: 'abc123' }
    expect(normalizedRepositoryUrl('git@github.com:michaelhil/leitbild.git')).toBe(PUBLIC_CODE_REPOSITORY)
    expect(normalizedRepositoryUrl('https://github.com/michaelhil/leitbild.git')).toBe(PUBLIC_CODE_REPOSITORY)
    expect(publicSourceRefusal({ ...base, containingRefs: ['refs/remotes/origin/main'] })).toBeNull()
    expect(publicSourceRefusal({ ...base, containingRefs: [] })).toContain('base commit abc123 is on no branch of the public origin')
    expect(publicSourceRefusal({ ...base, codeRepository: 'https://github.com/michaelhil/leitbild-archive.git', containingRefs: ['refs/remotes/origin/main'] }))
      .toContain('not the public repository https://github.com/michaelhil/leitbild')
  })
})

describe('deploy source guards on a repository', () => {
  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const child = Bun.spawn(['git', '-c', 'user.name=Deploy Test', '-c', 'user.email=deploy@test.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
    return stdout
  }
  const put = async (root: string, path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }

  test('refuses dirty or untracked input across Modules and requires a publicly reachable commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-deploy-source-'))
    try {
      const origin = join(directory, 'public.git')
      const work = join(directory, 'work')
      await git(directory, 'init', '--bare', origin)
      await git(directory, 'clone', '--quiet', origin, work)
      await put(work, 'apps/world/src/ui/embed/embed.css', ':root {}\n')
      await put(work, 'apps/agents/src/main.ts', 'export {}\n')
      await git(work, 'add', '.')
      await git(work, 'commit', '--quiet', '-m', 'first')
      await git(work, 'push', '--quiet', 'origin', 'main')
      const guard = () => assertPublicWorldSource(work, origin)

      const head = (await git(work, 'rev-parse', 'HEAD')).trim()
      expect(await guard()).toEqual({ baseCommit: head, containingRefs: ['refs/remotes/origin/main'] })

      // A dirty World UI file.
      await put(work, 'apps/world/src/ui/embed/embed.css', ':root { color: red }\n')
      await expect(guard()).rejects.toThrow('Commit or move outstanding files')
      await git(work, 'checkout', '--', 'apps/world/src/ui/embed/embed.css')
      // An untracked one.
      await put(work, 'apps/world/src/packs/new-panel.ts', 'export {}\n')
      await expect(guard()).rejects.toThrow('Commit or move outstanding files')
      await rm(join(work, 'apps/world/src/packs'), { recursive: true })
      await put(work, 'apps/agents/src/main.ts', 'export const changed = true\n')
      await expect(guard()).rejects.toThrow('Commit or move outstanding files')
      await git(work, 'checkout', '--', 'apps/agents/src/main.ts')

      // Committed but not pushed: the public origin lacks the base commit.
      await put(work, 'apps/world/src/ui/embed/embed.css', ':root { color: blue }\n')
      await git(work, 'commit', '--quiet', '-am', 'second')
      await expect(guard()).rejects.toThrow('is on no branch of the public origin')
      await git(work, 'push', '--quiet', 'origin', 'main')
      expect((await guard()).containingRefs).toEqual(['refs/remotes/origin/main'])

      // An origin that is not the public repository.
      await expect(assertPublicWorldSource(work, 'https://github.com/michaelhil/leitbild')).rejects.toThrow('not the public repository')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 60_000)
})
