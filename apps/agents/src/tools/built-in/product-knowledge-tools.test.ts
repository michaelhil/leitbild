import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProductKnowledgeTools } from './product-knowledge-tools.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-product-knowledge-'))
  roots.push(root)
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'apps/world/src'), { recursive: true })
  await mkdir(join(root, 'deploy'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# Leitbild\nA modular simulation system.\n')
  await writeFile(join(root, 'docs/architecture.md'), 'Simulation acceleration is controlled by the World execution capability.\n')
  await writeFile(join(root, 'apps/world/src/execution.ts'), 'export const accelerationMode = "maximum"\n')
  await writeFile(join(root, 'deploy/secret.json'), '{"token":"do-not-read"}\n')
  await writeFile(join(root, '.env'), 'SECRET=do-not-read\n')
  return root
}

describe('product knowledge tools', () => {
  test('searches and reads only the bounded product corpus', async () => {
    const root = await fixture()
    const [search, read] = createProductKnowledgeTools({ repoRoot: root })
    const context = { callerId: 'a', callerName: 'A' }
    const found = await search!.execute({ query: 'simulation acceleration' }, context)
    expect(found.success).toBe(true)
    expect(found.data).toMatchObject({ revision: 'development' })
    const paths = (found.data as { matches: Array<{ path: string }> }).matches.map(match => match.path)
    expect(paths).toContain('docs/architecture.md')
    expect(paths).not.toContain('deploy/secret.json')

    const excerpt = await read!.execute({ path: 'apps/world/src/execution.ts', startLine: 1, lineCount: 5 }, context)
    expect(excerpt.success).toBe(true)
    expect(JSON.stringify(excerpt.data)).toContain('accelerationMode')
    expect((await read!.execute({ path: '.env' }, context)).success).toBe(false)
    expect((await read!.execute({ path: '../outside' }, context)).success).toBe(false)
  })
})
