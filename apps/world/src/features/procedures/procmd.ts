import { parseProcedure } from '@leitbild/procmd'
import { procedureDocumentSchema, type ProcedureDocument, type ProcedureSource } from '../../core/model/index.ts'

/** The shared format parser owns content; World owns source identity and wire validation. */
export const parseProcedureMarkdown = (config: {
  readonly source: ProcedureSource
  readonly sourcePath: string
  readonly sourceUrl: string
  readonly rawMarkdown: string
}): ProcedureDocument => procedureDocumentSchema.parse({
  ...parseProcedure(config.rawMarkdown),
  source: config.source,
  sourcePath: config.sourcePath,
  sourceUrl: config.sourceUrl,
}) as ProcedureDocument
