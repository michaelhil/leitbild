import { loadKnowledge, knowledgeSnapshotPath, type Knowledge } from '@leitbild/knowledge'
import { z } from 'zod'
import { resolve } from 'node:path'
import { readProductSource } from '@leitbild/knowledge/source'

const deployedCodeSource = async (): Promise<string | undefined> => {
  const file = Bun.file(resolve(import.meta.dir, '../../../DEPLOYMENT.json'))
  if (!await file.exists()) return undefined // Local development has no deployed source provenance.
  const value = await file.json() as { baseCommit?: string; codeRepository?: string; dirty?: boolean }
  return value.dirty === false && value.codeRepository && value.baseCommit ? `${value.codeRepository}/blob/${value.baseCommit}/` : undefined
}

const searchSchema = z.object({ query: z.string().default(''), prefix: z.string().optional(),
  offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().positive().default(10),
  includeQuality: z.enum(['true', 'false']).default('false'),
})

export const knowledgeResponse = async (request: Request, load: () => Promise<Knowledge> = () => loadKnowledge(knowledgeSnapshotPath(resolve(import.meta.dir, '../../..'))), codeSource: () => Promise<string | undefined> = deployedCodeSource): Promise<Response> => {
  const url = new URL(request.url)
  try {
    if (url.pathname === '/api/knowledge/source') {
      const path = url.searchParams.get('path')
      if (!path) return Response.json({ error: 'path is required' }, { status: 400 })
      return Response.json(await readProductSource(path, resolve(import.meta.dir, '../../..')))
    }
    const knowledge = await load()
    if (url.pathname === '/api/knowledge/index') return Response.json({ revision: knowledge.revision, documents: knowledge.index(), sourceBaseUrl: await codeSource() })
    if (url.pathname === '/api/knowledge/search') {
      const input = searchSchema.parse(Object.fromEntries(url.searchParams))
      return Response.json(knowledge.search(input.query, { offset: input.offset, limit: input.limit,
        includeQuality: input.includeQuality === 'true', ...(input.prefix ? { prefix: input.prefix } : {}) }))
    }
    if (url.pathname === '/api/knowledge/read') {
      const path = url.searchParams.get('path')
      if (!path) return Response.json({ error: 'path is required' }, { status: 400 })
      const revision = url.searchParams.get('revision')
      const section = url.searchParams.get('section')
      return Response.json(knowledge.read(path, { ...(revision ? { revision } : {}), ...(section ? { section } : {}) }))
    }
    return Response.json({ error: 'Unknown knowledge route' }, { status: 404 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Knowledge unavailable'
    return Response.json({ error: message }, { status: error instanceof z.ZodError ? 400 : message.includes('publication is unavailable') ? 503 : 404 })
  }
}
