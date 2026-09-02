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
  manifestUrl: 'https://samsinn-wikis.github.io/pwr-ops/_manifest.json',
  manifestPath: 'wiki/_manifest.json',
  procedurePath: 'wiki/procedures',
}]

export const createConfiguredProcedureSourceService = (): ProcedureSourceService =>
  createProcedureSourceService({ sources: procedureSources })
