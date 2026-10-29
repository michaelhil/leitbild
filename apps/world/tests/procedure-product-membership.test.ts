import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledge } from '@leitbild/knowledge'
import { createProcedureSourceService } from '../src/features/procedures/source.ts'
import { procedureSources } from '../src/procedure-sources.ts'

const markdown = (id: string, title: string) => `---\ntype: procedure\nprocedure-md: 0.7\nprocedure-id: ${id}\ntitle: ${title}\n---\n# ${title}\n## Step 1 [id: inspect]\nCheck: Retained publication fixture.\n- Confirmed → END\n`

describe('product procedure content ownership', () => {
  test('model tasks are selected explicitly while prior references remain byte-exact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-product-procedures-'))
    try {
      const source = procedureSources[0]!
      const selected = source.documentPaths!
      expect(selected).toHaveLength(40)
      expect(selected.filter(path => path.startsWith('world/'))).toEqual([
        'world/packs/process-plant/procedures/E-0.md',
        'world/packs/process-plant/procedures/ES-0.1.md',
        'world/packs/process-plant/procedures/RHR-1.md',
      ])
      expect(selected.some(path => path.includes('/ld-01/'))).toBe(false)
      const archivedPath = 'archive/pwr-reference-model/procedures/ES-0.1.md'
      expect(selected).not.toContain(archivedPath)
      const original = markdown('ES-0.1', 'Original reference — not a modeled criterion').replaceAll('\n', '\r\n')
      const before = createProcedureSourceService({ sources: [{ ...source, documentPaths: [archivedPath] }], retentionDirectory: directory,
        loadKnowledge: async () => createKnowledge({ revision: 'a'.repeat(40), documents: [{ path: archivedPath, content: original }] }) })
      const pinned = await before.readDocument({ procedureId: 'ES-0.1' })
      const documents = selected.map(path => {
        const id = path.split('/').at(-1)!.slice(0, -3)
        return { path, content: markdown(id, path.startsWith('world/') ? `Finite model task ${id}` : `Unqualified reference ${id}`) }
      })
      const current = createProcedureSourceService({ sources: procedureSources, retentionDirectory: directory,
        loadKnowledge: async () => createKnowledge({ revision: 'b'.repeat(40), documents: [...documents, { path: archivedPath, content: original }] }) })
      expect((await current.readCatalog()).procedures).toHaveLength(40)
      expect((await current.readDocument({ procedureId: 'ES-0.1' })).title).toBe('Finite model task ES-0.1')
      expect((await current.readDocument({ procedureId: 'RHR-1' })).title).toBe('Finite model task RHR-1')
      expect((await current.readDocument({ procedureId: 'ES-1.3' })).sourcePath).toBe('archive/pwr-reference-model/procedures/ES-1.3.md')
      const retained = await current.readDocument({ procedureId: 'ES-0.1', sourceRevision: pinned.source.revision, sourcePath: archivedPath })
      expect(retained.rawMarkdown).toBe(original)
      expect(retained.sourcePath).toBe(archivedPath)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
