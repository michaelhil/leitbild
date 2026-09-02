import { describe, expect, test } from 'bun:test'
import { createProcedureSourceService, type ProcedureSourceConfig } from '../src/features/procedures/source.ts'

const revisionA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const revisionB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const manifestUrl = 'https://procedures.test/_manifest.json'

const source: ProcedureSourceConfig = {
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'samsinn-wikis/pwr-ops',
  ref: 'main',
  manifestUrl,
  manifestPath: 'wiki/_manifest.json',
  procedurePath: 'wiki/procedures',
}

const markdownFor = (id: string, title: string): string => `---
type: procedure
procedure-md: 0.7
procedure-id: ${id}
title: ${title}
profile: nuclear-erg
---

# ${id} — ${title}

## Step 1 [id: first-step]
Check: verify the initial condition
- Verified → END
`

const manifestFor = (
  revision: string,
  procedures: ReadonlyArray<{ readonly id: string; readonly title: string }>,
) => ({
  version: 1,
  wiki: 'pwr-ops',
  revision,
  procmdVersion: '0.7',
  procedures: procedures.map(procedure => ({
    id: procedure.id,
    title: procedure.title,
    file: `wiki/procedures/${procedure.id}.md`,
    profile: 'nuclear-erg',
    coverage: 'developed',
    stepCount: 1,
    tagDefinitionCount: 0,
    csfsMonitored: [],
    entryTriggers: [],
  })),
  pages: [],
})

describe('procedure source discovery', () => {
  test('builds the catalog from one manifest request and fetches no documents eagerly', async () => {
    const calls: string[] = []
    const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
      const url = input.toString()
      calls.push(url)
      if (url === manifestUrl) {
        return Response.json(manifestFor(revisionA, [
          { id: 'E-0', title: 'Reactor Trip' },
          { id: 'FR-S.1', title: 'Response to Nuclear Power Generation' },
        ]))
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    const service = createProcedureSourceService({ sources: [source], fetchFn })

    const catalog = await service.readCatalog()

    expect(catalog.source.revision).toBe(revisionA)
    expect(catalog.procedures.map(procedure => procedure.procedureId)).toEqual(['E-0', 'FR-S.1'])
    expect(calls).toEqual([manifestUrl])
  })

  test('loads only the requested document and coalesces concurrent reads', async () => {
    const calls: string[] = []
    const rawUrl = `https://raw.githubusercontent.com/samsinn-wikis/pwr-ops/${revisionA}/wiki/procedures/E-0.md`
    const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
      const url = input.toString()
      calls.push(url)
      if (url === manifestUrl) return Response.json(manifestFor(revisionA, [{ id: 'E-0', title: 'Reactor Trip' }]))
      if (url === rawUrl) {
        await new Promise(resolve => setTimeout(resolve, 5))
        return new Response(markdownFor('E-0', 'Reactor Trip'))
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    const service = createProcedureSourceService({ sources: [source], fetchFn })

    const [first, second] = await Promise.all([
      service.readDocument({ procedureId: 'E-0' }),
      service.readDocument({ procedureId: 'E-0' }),
    ])

    expect(first.procedureId).toBe('E-0')
    expect(second).toBe(first)
    expect(calls).toEqual([manifestUrl, rawUrl])
  })

  test('refreshes the manifest once and reads documents from the newly published revision', async () => {
    let currentRevision = revisionA
    const calls: string[] = []
    const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
      const url = input.toString()
      calls.push(url)
      if (url === manifestUrl) return Response.json(manifestFor(currentRevision, [{ id: 'E-0', title: 'Reactor Trip' }]))
      if (url.includes('/wiki/procedures/E-0.md')) return new Response(markdownFor('E-0', 'Reactor Trip'))
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    const service = createProcedureSourceService({ sources: [source], fetchFn })

    await service.readCatalog()
    currentRevision = revisionB
    const refreshed = await service.readCatalog({ refresh: true })
    const document = await service.readDocument({ procedureId: 'E-0' })

    expect(refreshed.source.revision).toBe(revisionB)
    expect(document.source.revision).toBe(revisionB)
    expect(calls.filter(url => url === manifestUrl)).toHaveLength(2)
    expect(calls.at(-1)).toContain(`/${revisionB}/wiki/procedures/E-0.md`)
  })

  test('reads an active Run document from its pinned revision without consulting the current catalog', async () => {
    const calls: string[] = []
    const rawUrl = `https://raw.githubusercontent.com/samsinn-wikis/pwr-ops/${revisionA}/wiki/procedures/E-0.md`
    const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
      const url = input.toString()
      calls.push(url)
      if (url === rawUrl) return new Response(markdownFor('E-0', 'Reactor Trip'))
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    const service = createProcedureSourceService({ sources: [source], fetchFn })

    const document = await service.readDocument({
      procedureId: 'E-0',
      sourceRevision: revisionA,
      sourcePath: 'wiki/procedures/E-0.md',
    })

    expect(document.source.revision).toBe(revisionA)
    expect(calls).toEqual([rawUrl])
  })
})
