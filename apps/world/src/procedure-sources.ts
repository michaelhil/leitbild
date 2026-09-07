import {
  createProcedureSourceService,
  type ProcedureSourceConfig,
  type ProcedureSourceService,
} from './features/procedures/source.ts'
import { join, resolve } from 'node:path'
import { loadKnowledge, knowledgeSnapshotPath } from '@leitbild/knowledge'

/** Product-owned procedure catalogs. The generic World procedure engine does not choose content. */
export const procedureSources: ReadonlyArray<ProcedureSourceConfig> = [{
  sourceId: 'leitbild',
  label: 'Leitbild PWR reference procedures — model annotated',
  repository: 'Leitbild-wiki',
  ref: 'publication',
  procedurePath: 'world/packs/process-plant/pwr/procedures',
}]

export const createConfiguredProcedureSourceService = (config: { readonly dataDir: string }): ProcedureSourceService =>
  createProcedureSourceService({
    sources: procedureSources,
    retentionDirectory: join(config.dataDir, 'procedure-publications'),
    loadKnowledge: () => loadKnowledge(knowledgeSnapshotPath(resolve(import.meta.dir, '../../..'))),
  })
