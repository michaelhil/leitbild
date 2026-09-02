import { z } from 'zod'

export const sourceDocumentPathSchema = z.string().min(1).refine(
  value => !value.startsWith('/') && !value.split('/').includes('..'),
  'must be a relative path without parent traversal',
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

/** Published discovery index for one immutable revision of a procedure-backed wiki. */
export const wikiManifestSchema = z.object({
  version: z.literal(1),
  wiki: z.string().min(1),
  revision: sourceRevisionSchema,
  procmdVersion: z.string().min(1),
  procedures: z.array(procedureManifestEntrySchema),
  pages: z.array(wikiManifestPageEntrySchema),
}).passthrough().superRefine((manifest, ctx) => {
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
})

export type WikiManifest = z.infer<typeof wikiManifestSchema>
