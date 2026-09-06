import { z } from 'zod'

export const sourceDocumentPathSchema = z.string().min(1).refine(
  value => !/[\u0000-\u001f\u007f]/.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
  'must be a literal relative repository path without empty/dot segments or control characters; URL builders must encode each segment',
)

export const sourceRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/)

export const procedureManifestEntrySchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1),
  file: sourceDocumentPathSchema,
  profile: z.string().min(1).optional(),
  appliesTo: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  csfsMonitored: z.array(z.string().min(1)).default([]),
  entryTriggers: z.array(z.string().min(1)).default([]),
  coverage: z.enum(['developed', 'partial', 'stub']),
  stepCount: z.number().int().nonnegative(),
  tagDefinitionCount: z.number().int().nonnegative(),
}).passthrough()

export type ProcedureManifestEntry = z.infer<typeof procedureManifestEntrySchema>

export const wikiManifestPageEntrySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().min(1),
  file: sourceDocumentPathSchema,
  appliesTo: z.string().min(1).optional(),
  referencePlant: z.string().min(1).optional(),
  csfsRelated: z.array(z.string().min(1)).optional(),
}).passthrough()

export type WikiManifestPageEntry = z.infer<typeof wikiManifestPageEntrySchema>

/** Published discovery index for one immutable wiki revision. Paths are literal filenames, not URL fragments. */
export const wikiManifestSchema = z.object({
  version: z.literal(1),
  wiki: z.string().min(1),
  revision: sourceRevisionSchema,
  procmdVersion: z.string().min(1).optional(),
  procedures: z.array(procedureManifestEntrySchema),
  pages: z.array(wikiManifestPageEntrySchema),
}).passthrough().superRefine((manifest, ctx) => {
  if (manifest.procedures.length > 0 && manifest.procmdVersion === undefined) {
    ctx.addIssue({ code: 'custom', path: ['procmdVersion'], message: 'procmdVersion is required when procedures are declared' })
  }
  const procedureIds = new Set<string>()
  const procedureFiles = new Set<string>()
  manifest.procedures.forEach((procedure, index) => {
    if (procedureIds.has(procedure.id)) {
      ctx.addIssue({ code: 'custom', path: ['procedures', index, 'id'], message: `duplicate procedure id ${procedure.id}` })
    }
    if (procedureFiles.has(procedure.file)) {
      ctx.addIssue({ code: 'custom', path: ['procedures', index, 'file'], message: `duplicate procedure file ${procedure.file}` })
    }
    procedureIds.add(procedure.id)
    procedureFiles.add(procedure.file)
  })
  const pageIds = new Set<string>()
  const pageFiles = new Set<string>()
  manifest.pages.forEach((page, index) => {
    const identity = JSON.stringify([page.type, page.id])
    if (pageIds.has(identity)) {
      ctx.addIssue({ code: 'custom', path: ['pages', index, 'id'], message: `duplicate page identity ${page.type}/${page.id}` })
    }
    if (pageFiles.has(page.file)) {
      ctx.addIssue({ code: 'custom', path: ['pages', index, 'file'], message: `duplicate page file ${page.file}` })
    }
    pageIds.add(identity)
    pageFiles.add(page.file)
  })
})

export type WikiManifest = z.infer<typeof wikiManifestSchema>
