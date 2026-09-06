import {
  createProcedureSourceService,
  type ProcedureSourceConfig,
  type ProcedureSourceService,
} from './features/procedures/source.ts'
import { join } from 'node:path'

/** Product-owned procedure catalogs. The generic World procedure engine does not choose content. */
export const procedureSources: ReadonlyArray<ProcedureSourceConfig> = [{
  sourceId: 'leitbild',
  label: 'Leitbild PWR reference procedures — model annotated',
  repository: 'Leitbild-wiki',
  ref: 'publication',
  procedurePath: 'packs/process-plant/procedures',
}]

export const createConfiguredProcedureSourceService = (config: { readonly dataDir: string }): ProcedureSourceService =>
  createProcedureSourceService({ sources: procedureSources, retentionDirectory: join(config.dataDir, 'procedure-publications') })
