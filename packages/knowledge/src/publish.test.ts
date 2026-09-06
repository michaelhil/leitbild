import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishKnowledge } from './publish.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const run = async (root: string, args: string[]) => {
  const p = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
  expect(await p.exited).toBe(0)
}
test('publishes a named clean commit with valid links, refuses dirty or broken content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-knowledge-'))
  roots.push(root)
  await run(root, ['init'])
  await run(root, ['config', 'user.name', 'Knowledge test'])
  await run(root, ['config', 'user.email', 'test@example.invalid'])
  await Bun.write(join(root, 'index.md'), '# Knowledge\n\n[More](more.md#details)')
  await Bun.write(join(root, 'more.md'), '# More\n\n## Details\nText.')
  await run(root, ['add', '.']); await run(root, ['commit', '-m', 'Knowledge'])
  const snapshot = await publishKnowledge(root)
  expect(snapshot.documents).toHaveLength(2)
  expect(snapshot.revision).toMatch(/^[a-f0-9]{40}$/)
  await Bun.write(join(root, 'index.md'), '# Changed\n[Missing](missing.md)')
  await expect(publishKnowledge(root)).rejects.toThrow('Commit')
  await run(root, ['add', '.']); await run(root, ['commit', '-m', 'Broken'])
  await expect(publishKnowledge(root)).rejects.toThrow('not found')
})
