import { readFileSync } from 'node:fs'
import { normalize } from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { listProcessPlantAssemblyCatalogEntries } from '../assembly/catalog.ts'
import { processPlantCatalog } from '../catalog-contributions.ts'
import { success } from './common.ts'

const catalogListPayloadSchema = z.object({}).strict()
const catalogEntrySectionSchema = z.enum([
  'graphRefs',
  'assemblyRefs',
  'graphFragmentRefs',
  'graphFragmentInstancePresetRefs',
  'icRefs',
  'dynamicIcRefPatterns',
  'surfaceIds',
])
type CatalogEntrySection = z.infer<typeof catalogEntrySectionSchema>

const catalogSourcePayloadSchema = z.object({
  section: catalogEntrySectionSchema,
  id: z.string().min(1),
}).strict()

const sourceRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const catalogSourceCache = new Map<string, string>()

interface CatalogSourceTarget {
  readonly section: CatalogEntrySection
  readonly id: string
  readonly value: string
  readonly sourcePath?: string
}

export const processPlantCatalogQueryKinds = [
  'process-plant.catalog.list',
  'process-plant.catalog.source',
] as const

const sourceView = (sourcePath: string | undefined): Record<string, unknown> | undefined =>
  sourcePath === undefined ? undefined : { path: sourcePath }

const refEntryView = (entry: { readonly ref: string; readonly sourcePath?: string }): Record<string, unknown> => ({
  id: entry.ref,
  value: entry.ref,
  ...(entry.sourcePath === undefined ? {} : { source: sourceView(entry.sourcePath) }),
})

const idEntryView = (entry: { readonly id: string; readonly sourcePath?: string }): Record<string, unknown> => ({
  id: entry.id,
  value: entry.id,
  ...(entry.sourcePath === undefined ? {} : { source: sourceView(entry.sourcePath) }),
})

const catalogListView = (): Record<string, unknown> => ({
  graphRefs: [...processPlantCatalog.graphSpecsByRef.values()].map(refEntryView),
  assemblyRefs: listProcessPlantAssemblyCatalogEntries().map(refEntryView),
  graphFragmentRefs: [...processPlantCatalog.graphFragmentsByRef.values()].map(refEntryView),
  graphFragmentInstancePresetRefs: [...processPlantCatalog.graphFragmentInstancePresetsByRef.values()].map(refEntryView),
  icRefs: [
    ...processPlantCatalog.icConfigsByRef.values(),
    ...processPlantCatalog.graphIcConfigsByRef.values(),
    ...[...processPlantCatalog.dynamicIcConfigsById.values()].flatMap(entry =>
      (entry.listedRefs?.() ?? []).map(ref => ({
        ref,
        ...(entry.sourcePath === undefined ? {} : { sourcePath: entry.sourcePath }),
      })),
    ),
  ].map(refEntryView),
  dynamicIcRefPatterns: [...processPlantCatalog.dynamicIcConfigsById.values()].map(entry => ({
    id: entry.id,
    pattern: entry.refPattern,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.sourcePath === undefined ? {} : { source: sourceView(entry.sourcePath) }),
  })),
  surfaceIds: [...processPlantCatalog.surfacesById.values()].map(idEntryView),
})

const targetFromRefEntry = (
  section: CatalogEntrySection,
  id: string,
  entry: { readonly ref: string; readonly sourcePath?: string } | undefined,
): CatalogSourceTarget | null =>
  entry === undefined ? null : {
    section,
    id,
    value: entry.ref,
    ...(entry.sourcePath === undefined ? {} : { sourcePath: entry.sourcePath }),
  }

const targetFromIdEntry = (
  section: CatalogEntrySection,
  id: string,
  entry: { readonly id: string; readonly sourcePath?: string } | undefined,
): CatalogSourceTarget | null =>
  entry === undefined ? null : {
    section,
    id,
    value: entry.id,
    ...(entry.sourcePath === undefined ? {} : { sourcePath: entry.sourcePath }),
  }

const catalogSourceTarget = (section: CatalogEntrySection, id: string): CatalogSourceTarget & { readonly sourcePath: string } => {
  const target = (() => {
    switch (section) {
      case 'graphRefs':
        return targetFromRefEntry(section, id, processPlantCatalog.graphSpecsByRef.get(id))
      case 'assemblyRefs':
        return targetFromRefEntry(section, id, listProcessPlantAssemblyCatalogEntries().find(entry => entry.ref === id))
      case 'graphFragmentRefs':
        return targetFromRefEntry(section, id, processPlantCatalog.graphFragmentsByRef.get(id))
      case 'graphFragmentInstancePresetRefs':
        return targetFromRefEntry(section, id, processPlantCatalog.graphFragmentInstancePresetsByRef.get(id))
      case 'icRefs': {
        const exactEntry = processPlantCatalog.icConfigsByRef.get(id) ?? processPlantCatalog.graphIcConfigsByRef.get(id)
        if (exactEntry !== undefined) return targetFromRefEntry(section, id, exactEntry)
        const dynamicEntry = [...processPlantCatalog.dynamicIcConfigsById.values()]
          .find(entry => (entry.listedRefs?.() ?? []).includes(id))
        return dynamicEntry === undefined ? null : {
          section,
          id,
          value: id,
          ...(dynamicEntry.sourcePath === undefined ? {} : { sourcePath: dynamicEntry.sourcePath }),
        }
      }
      case 'dynamicIcRefPatterns': {
        const entry = processPlantCatalog.dynamicIcConfigsById.get(id)
        return entry === undefined ? null : {
          section,
          id,
          value: entry.refPattern,
          ...(entry.sourcePath === undefined ? {} : { sourcePath: entry.sourcePath }),
        }
      }
      case 'surfaceIds':
        return targetFromIdEntry(section, id, processPlantCatalog.surfacesById.get(id))
    }
  })()
  if (target === null) throw new Error(`process plant catalog entry not found: ${section}/${id}`)
  if (target.sourcePath === undefined) throw new Error(`process plant catalog entry has no source file: ${section}/${id}`)
  return { ...target, sourcePath: target.sourcePath }
}

const safeCatalogSourcePath = (sourcePath: string): string => {
  const normalized = normalize(sourcePath)
  if (
    normalized !== sourcePath
    || normalized.includes('..')
    || !normalized.startsWith('src/packs/process-plant/')
    || (!normalized.endsWith('.ts') && !normalized.endsWith('.json'))
  ) {
    throw new Error(`invalid process plant catalog source path: ${sourcePath}`)
  }
  return normalized
}

const sourceTextFor = (sourcePath: string): string => {
  const safePath = safeCatalogSourcePath(sourcePath)
  const existing = catalogSourceCache.get(safePath)
  if (existing !== undefined) return existing
  const content = readFileSync(`${sourceRoot}/${safePath}`, 'utf8')
  catalogSourceCache.set(safePath, content)
  return content
}

const targetLineIndexFor = (content: string, target: CatalogSourceTarget): number | null => {
  const candidates = [target.value, target.id].filter((value, index, values) =>
    value.length > 0 && values.indexOf(value) === index)
  const lines = content.split(/\r\n|\r|\n/)
  for (const candidate of candidates) {
    const lineIndex = lines.findIndex(line => line.includes(candidate))
    if (lineIndex >= 0) return lineIndex
  }
  return null
}

const catalogSourceView = (section: CatalogEntrySection, id: string): Record<string, unknown> => {
  const target = catalogSourceTarget(section, id)
  const sourcePath = safeCatalogSourcePath(target.sourcePath)
  const content = sourceTextFor(sourcePath)
  return {
    section,
    id,
    value: target.value,
    path: sourcePath,
    language: sourcePath.endsWith('.json') ? 'json' : 'typescript',
    targetLineIndex: targetLineIndexFor(content, target),
    content,
  }
}

export const answerProcessPlantCatalogQuery = (config: {
  readonly request: PackQueryRequest
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantCatalogQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.catalog.list') {
    catalogListPayloadSchema.parse(config.request.payload ?? {})
    return success(config.request, catalogListView(), config.at)
  }
  const payload = catalogSourcePayloadSchema.parse(config.request.payload ?? {})
  return success(config.request, catalogSourceView(payload.section, payload.id), config.at)
}
