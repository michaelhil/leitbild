import {
  createProcedureSourceService,
  type ProcedureSourceConfig,
  type ProcedureSourceService,
} from './features/procedures/source.ts'

/** Product-owned procedure catalogs. The generic World procedure engine does not choose content. */
export const procedureSources: ReadonlyArray<ProcedureSourceConfig> = [{
  sourceId: 'pwr-ops',
  label: 'PWR operations procedures',
  repository: 'samsinn-wikis/pwr-ops',
  ref: 'main',
  path: 'wiki/procedures',
}]

export const createConfiguredProcedureSourceService = (): ProcedureSourceService =>
  createProcedureSourceService({ sources: procedureSources })
