import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishKnowledge, validateKnowledgeSources } from './publish.ts'
import { updateSchematicDocument } from './schematic.ts'

const roots: string[] = []
test('publication validates source against actually supplied artifact, including line ranges', async () => {
  const root=await mkdtemp(join(tmpdir(),'knowledge-artifact-')); roots.push(root)
  const snapshot={revision:'a'.repeat(40),documents:[{path:'index.md',content:'[Code](source:README.md:1-2)'}]}
  await expect(validateKnowledgeSources(snapshot,root)).rejects.toThrow('unavailable')
  await Bun.write(join(root,'README.md'),'# Shipped\nExplanation')
  await validateKnowledgeSources(snapshot,root)
  await expect(validateKnowledgeSources({...snapshot,documents:[{path:'index.md',content:'[Code](source:README.md:999)'}]},root)).rejects.toThrow('line range')
})
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
test('source inspection returns only exact validated canonical files, deduplicating aliases and ranges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-referenced-source-')); roots.push(root)
  await Bun.write(join(root, 'apps/world/scripts/balance.ts'), 'export const value = 1\n')
  await Bun.write(join(root, 'apps/world/scripts/unrelated.ts'), 'export const unrelated = true\n')
  const snapshot = { revision: 'a'.repeat(40), documents: [{ path: 'index.md', content:
    '[Full](source:apps/world/scripts/balance.ts) [Alias](source:balance.ts:1) [Range](source:apps/world/scripts/balance.ts#L1)' }] }
  expect(await validateKnowledgeSources(snapshot, root)).toEqual(['apps/world/scripts/balance.ts'])
  await expect(validateKnowledgeSources({ ...snapshot, documents: [{ path: 'index.md', content: '[Bad](source:.env)' }] }, root)).rejects.toThrow()
  await expect(validateKnowledgeSources({ ...snapshot, documents: [{ path: 'index.md', content: '[Missing](source:apps/world/scripts/missing.ts)' }] }, root)).rejects.toThrow('index.md: source:apps/world/scripts/missing.ts')
})
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

test('publication refuses stale diagram projections and accepts regenerated declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-schematic-'))
  roots.push(root)
  await run(root, ['init'])
  await run(root, ['config', 'user.name', 'Knowledge test'])
  await run(root, ['config', 'user.email', 'test@example.invalid'])
  const declaration = { id: 'EX', equipment: [{ id: 'A', label: 'Boundary', kind: 'boundary', ports: {} }], connections: [], views: [{ title: 'Overview', equipment: ['A'] }] }
  const doc = '# Drawing\n\n```plant-schematic\n' + JSON.stringify(declaration) + '\n```\n<!-- generated-schematic:start -->\n<!-- generated-schematic:end -->'
  await Bun.write(join(root, 'index.md'), doc)
  await run(root, ['add', '.']); await run(root, ['commit', '-m', 'Stale drawing'])
  await expect(publishKnowledge(root)).rejects.toThrow('Stale generated schematic')
  await Bun.write(join(root, 'index.md'), updateSchematicDocument(doc))
  await run(root, ['add', '.']); await run(root, ['commit', '-m', 'Generate drawing'])
  expect((await publishKnowledge(root)).documents).toHaveLength(1)
})

test('authored procedure assessment and tag owners resolve real publication sections before release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-assessment-publication-')); roots.push(root)
  await run(root, ['init']); await run(root, ['config', 'user.name', 'Knowledge test']); await run(root, ['config', 'user.email', 'test@example.invalid'])
  const criterion = { condition: { type: 'comparison', tagId: 'LD01.PCCTank.LT', operator: '>=', value: 1, unit: 'm', bound: 'lower', evidence: 'instrument', source: 'basis.md#level', maxAgeSeconds: 2 } }
  const procedure = `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: TEST\ntitle: Test\n---\n## Step 1 [id: check]\n\`\`\`procedure-assessment\n${JSON.stringify(criterion)}\n\`\`\`\n## Tags\n- id: LD01.PCCTank.LT\n  units: m\n  source: basis.md`
  await Bun.write(join(root, 'index.md'), procedure)
  await Bun.write(join(root, 'basis.md'), '# Owner\n\n## Level\nAcquired lower-bound criterion.')
  await run(root, ['add', '.']); await run(root, ['commit', '-m', 'Valid evidence'])
  expect((await publishKnowledge(root)).documents).toHaveLength(2)
  await Bun.write(join(root, 'index.md'), procedure.replace('basis.md#level', 'basis.md#missing'))
  await run(root, ['add', '.']); await run(root, ['commit', '-m', 'Invalid criterion owner'])
  await expect(publishKnowledge(root)).rejects.toThrow('Unknown section')
  await Bun.write(join(root, 'index.md'), procedure.replace('source: basis.md', 'source: missing.md'))
  await run(root, ['add', '.']); await run(root, ['commit', '-m', 'Invalid tag owner'])
  await expect(publishKnowledge(root)).rejects.toThrow('not found')
})
