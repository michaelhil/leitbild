import { afterEach, expect, test } from 'bun:test'
import { createKnowledge } from '@leitbild/knowledge'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProcedureSourceService, type ProcedureSourceConfig } from '../src/features/procedures/source.ts'

const revision = 'a'.repeat(40)
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
const workspace = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-procedure-reuse-'))
  directories.push(directory)
  return directory
}
const source: ProcedureSourceConfig = {
  sourceId: 'fixture', label: 'Reuse regression fixture', repository: 'fixture-wiki',
  ref: 'publication', procedurePath: 'procedures',
}
const markdown = (id: string, title: string, target = 'END') => `---
type: procedure
procedure-md: 0.7
procedure-id: ${id}
title: ${title}
csfs-monitored: [cooling]
---
# ${title}

## Step 1 [id: check]
Basis: [Criterion](../evidence.md#criterion)
Check: Observe the actual state.
- Continue → ${target}

## Tags
- id: POSITION
  description: Acquired position
  units: boolean
`
const publication = (sourceRevision = revision, criterion = 'Original evidence.') => createKnowledge({
  revision: sourceRevision,
  documents: [
    { path: 'procedures/entry.md', content: markdown('ENTRY', 'Entry', '[[TARGET]]') },
    { path: 'procedures/target.md', content: markdown('TARGET', 'Transfer target') },
    { path: 'evidence.md', content: `# Evidence\n\n## Criterion\n${criterion}\n\n## Other\nSeparate evidence.` },
  ],
})

test('mutating returned catalog, document and evidence data never poisons subsequent reads', async () => {
  const directory = await workspace()
  const knowledge = publication()
  const service = createProcedureSourceService({ sources: [source], retentionDirectory: directory, loadKnowledge: async () => knowledge })
  const catalog = await service.readCatalog()
  catalog.procedures[0]!.title = 'Caller edit'
  catalog.procedures[0]!.csfsMonitored.push('caller-condition')
  catalog.source.label = 'Caller label'
  catalog.procedures.length = 0

  const document = await service.readDocument({ procedureId: 'ENTRY' })
  document.title = 'Caller title'
  document.source.label = 'Caller label'
  document.csfsMonitored.push('caller-condition')
  document.steps[0]!.branches[0]!.target = 'CALLER-TARGET'
  document.tags[0]!.description = 'Caller tag'
  document.steps.length = 0

  const evidence = await service.readEvidence({ sourceRevision: revision, sourcePath: 'evidence.md' })
  // JavaScript callers can mutate returned values despite readonly type annotations.
  const headings = evidence.headings as unknown as Array<{ title: string }>
  headings[0]!.title = 'Caller heading'
  headings.length = 0
  evidence.children.length = 0

  const nextCatalog = await service.readCatalog()
  expect(nextCatalog.source.label).toBe(source.label)
  expect(nextCatalog.procedures.map(item => item.title)).toEqual(['Entry', 'Transfer target'])
  expect(nextCatalog.procedures[0]!.csfsMonitored).toEqual(['cooling'])
  const nextDocument = await service.readDocument({ procedureId: 'ENTRY', sourceRevision: revision })
  expect(nextDocument.title).toBe('Entry')
  expect(nextDocument.source.label).toBe(source.label)
  expect(nextDocument.csfsMonitored).toEqual(['cooling'])
  expect(nextDocument.steps[0]!.branches[0]!.target).toBe('TARGET')
  expect(nextDocument.tags[0]!.description).toBe('Acquired position')
  expect((await service.readEvidence({ sourceRevision: revision, sourcePath: 'evidence.md', section: 'criterion' })).content).toContain('Original evidence.')
})

test('warm source reuse still detects changed evidence bytes at the same revision', async () => {
  const directory = await workspace()
  let current = publication()
  const service = createProcedureSourceService({ sources: [source], retentionDirectory: directory, loadKnowledge: async () => current })
  await service.readDocument({ procedureId: 'ENTRY' })
  await service.readCatalog()
  const retainedPath = join(directory, `${source.sourceId}-${revision}.json`)
  const retainedBytes = await readFile(retainedPath, 'utf8')

  current = publication(revision, 'Different evidence under the same claimed revision.')
  await service.readCatalog({ refresh: true })
  await expect(service.readDocument({ procedureId: 'ENTRY' })).rejects.toThrow('conflicts with the same source revision')
  expect(await readFile(retainedPath, 'utf8')).toBe(retainedBytes)
  expect((await service.readEvidence({ sourceRevision: revision, sourcePath: 'evidence.md', section: 'criterion' })).content).toContain('Original evidence.')
})

test('failed directory admission and failed publication writes can be repaired and retried on the same service', async () => {
  const directory = await workspace()
  const retentionDirectory = join(directory, 'publications')
  await writeFile(retentionDirectory, 'blocking file')
  const knowledge = publication()
  const service = createProcedureSourceService({ sources: [source], retentionDirectory, loadKnowledge: async () => knowledge })
  await expect(service.readDocument({ procedureId: 'ENTRY' })).rejects.toThrow()
  await rm(retentionDirectory)
  await mkdir(retentionDirectory)
  const retainedPath = join(retentionDirectory, `${source.sourceId}-${revision}.json`)
  await mkdir(retainedPath)
  await expect(service.readDocument({ procedureId: 'ENTRY' })).rejects.toThrow()
  await rm(retainedPath, { recursive: true })

  const document = await service.readDocument({ procedureId: 'ENTRY' })
  expect(document.source.revision).toBe(revision)
  expect(await readdir(retentionDirectory)).toEqual([`${source.sourceId}-${revision}.json`])
  const offline = createProcedureSourceService({
    sources: [source], retentionDirectory, loadKnowledge: async () => { throw new Error('Offline after successful retry') },
  })
  expect((await offline.readDocument({ procedureId: 'TARGET', sourceRevision: revision })).title).toBe('Transfer target')
})

test('independent concurrent writers retain one complete publication without temporary files', async () => {
  const directory = await workspace()
  const retentionDirectory = join(directory, 'publications')
  const services = [0, 1].map(() => createProcedureSourceService({
    sources: [source], retentionDirectory, loadKnowledge: async () => publication(),
  }))
  const documents = await Promise.all(services.flatMap(service => [
    service.readDocument({ procedureId: 'ENTRY' }),
    service.readDocument({ procedureId: 'TARGET' }),
  ]))
  expect(documents.map(document => document.procedureId)).toEqual(['ENTRY', 'TARGET', 'ENTRY', 'TARGET'])
  expect(await readdir(retentionDirectory)).toEqual([`${source.sourceId}-${revision}.json`])
  const retained = createKnowledge(JSON.parse(await readFile(join(retentionDirectory, `${source.sourceId}-${revision}.json`), 'utf8')))
  expect(retained.read('procedures/entry.md').content).toBe(publication().read('procedures/entry.md').content)
  expect(retained.read('procedures/target.md').content).toBe(publication().read('procedures/target.md').content)
  expect(retained.read('evidence.md', { section: 'criterion' }).content).toContain('Original evidence.')
})

test('identical revision and procedure IDs remain isolated by source membership and workspace', async () => {
  const directory = await workspace()
  const sources = [
    { ...source, sourceId: 'north', procedurePath: 'north', documentPaths: ['north/entry.md'] },
    { ...source, sourceId: 'south', procedurePath: 'south', documentPaths: ['south/entry.md'] },
  ]
  const knowledge = createKnowledge({ revision, documents: [
    { path: 'north/entry.md', content: markdown('ENTRY', 'North') },
    { path: 'south/entry.md', content: markdown('ENTRY', 'South') },
    { path: 'evidence.md', content: '# Evidence\n\n## Criterion\nShared owner.' },
  ] })
  const service = createProcedureSourceService({ sources, retentionDirectory: directory, loadKnowledge: async () => knowledge })
  const [north, south] = await Promise.all(sources.map(selected => service.readDocument({ sourceId: selected.sourceId, procedureId: 'ENTRY' })))
  expect([north!.title, south!.title]).toEqual(['North', 'South'])
  expect([north!.sourcePath, south!.sourcePath]).toEqual(['north/entry.md', 'south/entry.md'])

  const otherWorkspace = await workspace()
  const otherKnowledge = createKnowledge({ revision, documents: [
    { path: 'north/entry.md', content: markdown('ENTRY', 'Other workspace') },
    { path: 'evidence.md', content: '# Evidence\n\n## Criterion\nDifferent workspace evidence.' },
  ] })
  const other = createProcedureSourceService({ sources: [sources[0]!], retentionDirectory: otherWorkspace, loadKnowledge: async () => otherKnowledge })
  expect((await other.readDocument({ procedureId: 'ENTRY' })).title).toBe('Other workspace')
  expect((await service.readDocument({ sourceId: 'north', procedureId: 'ENTRY', sourceRevision: revision })).title).toBe('North')
  await expect(service.readDocument({ sourceId: 'north', procedureId: 'ENTRY', sourceRevision: revision, sourcePath: 'south/entry.md' })).rejects.toThrow('does not match')
})

test('refresh follows the current publication while historical churn preserves the original transfer and evidence pin', async () => {
  const directory = await workspace()
  let current = publication()
  const service = createProcedureSourceService({ sources: [source], retentionDirectory: directory, loadKnowledge: async () => current })
  await service.readDocument({ procedureId: 'ENTRY' })
  for (let number = 1; number <= 24; number++) {
    const nextRevision = number.toString(16).padStart(40, '0')
    current = publication(nextRevision, `Evidence revision ${number}.`)
    expect((await service.readCatalog({ refresh: true })).source.revision).toBe(nextRevision)
    expect((await service.readDocument({ procedureId: 'ENTRY' })).source.revision).toBe(nextRevision)
  }
  const pinned = await service.readDocument({ procedureId: 'ENTRY', sourceRevision: revision })
  expect(pinned.steps[0]!.branches[0]!.target).toBe('TARGET')
  expect((await service.readDocument({ procedureId: 'TARGET', sourceRevision: pinned.source.revision })).source.revision).toBe(revision)
  expect((await service.readEvidence({ sourceRevision: revision, sourcePath: 'evidence.md', section: 'criterion', startLine: 4, lineCount: 1 })).content).toBe('Original evidence.')
  await expect(service.readEvidence({ sourceRevision: revision, sourcePath: 'evidence.md', section: 'criterion', startLine: 7 })).rejects.toMatchObject({ code: 'capability_input_rejected' })
})

test('warm retained reads recheck replacement bytes and refuse a deleted publication', async () => {
  const directory = await workspace()
  let offline = false
  const knowledge = publication()
  const service = createProcedureSourceService({
    sources: [source], retentionDirectory: directory,
    loadKnowledge: async () => { if (offline) throw new Error('Current publication offline'); return knowledge },
  })
  await service.readDocument({ procedureId: 'ENTRY', sourceRevision: revision })
  await service.readDocument({ procedureId: 'ENTRY', sourceRevision: revision })
  await service.readEvidence({ sourceRevision: revision, sourcePath: 'evidence.md', section: 'criterion' })
  const retainedPath = join(directory, `${source.sourceId}-${revision}.json`)
  const original = await readFile(retainedPath, 'utf8')
  try {
    const replacement = JSON.parse(original) as { revision: string; documents: Array<{ path: string; content: string }> }
    replacement.documents.find(document => document.path === 'evidence.md')!.content =
      '# Evidence\n\n## Criterion\nReplacement retained owner.'
    replacement.documents.find(document => document.path === 'procedures/entry.md')!.content =
      markdown('ENTRY', 'Replacement retained entry', '[[TARGET]]')
    await writeFile(retainedPath, JSON.stringify(replacement) + '\n')
    expect((await service.readEvidence({ sourceRevision: revision, sourcePath: 'evidence.md', section: 'criterion' })).content).toContain('Replacement retained owner.')
    expect((await service.readDocument({ procedureId: 'ENTRY', sourceRevision: revision })).title).toBe('Replacement retained entry')

    await rm(retainedPath)
    offline = true
    await expect(service.readDocument({ procedureId: 'ENTRY', sourceRevision: revision })).rejects.toThrow('Current publication offline')
    await expect(service.readEvidence({ sourceRevision: revision, sourcePath: 'evidence.md' })).rejects.toThrow('has no retained publication')
  } finally {
    await writeFile(retainedPath, original)
  }
})
