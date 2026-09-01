import type { OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { PackMapLayerGroup, PackObjectPresentation, WorldPack } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor, emptyPackScenarioConfigSchema } from '../../core/packs/protocol.ts'
import { asDatasetId } from '../../reference-data/types.ts'
import { electricGridPackId, parseElectricGridObjectData } from './model.ts'
import { electricGridRuntimeId } from './sim/constants.ts'

const mw = (value: number): string => `${Math.round(value).toLocaleString()} MW`

const layerGroups: ReadonlyArray<PackMapLayerGroup> = [{
  id: 'electric-grid:reference-lines',
  label: 'Reference lines',
  defaultVisible: true,
  layerIdPattern: 'reference:grid-norway:line:*',
}, {
  id: 'electric-grid:reference-cables',
  label: 'Reference cables',
  defaultVisible: true,
  layerIdPattern: 'reference:grid-norway:cable:*',
}, {
  id: 'electric-grid:reference-substations',
  label: 'Reference substations',
  defaultVisible: true,
  layerIdPattern: 'reference:grid-norway:substation:*',
}, {
  id: 'electric-grid:reference-generation',
  label: 'Reference generation',
  defaultVisible: true,
  layerIdPattern: 'reference:grid-norway:plant:*',
}]

const presentationForGrid = (object: OperationalObject): PackObjectPresentation => {
  const data = parseElectricGridObjectData(object)
  if (!data) {
    return {
      categoryId: 'electric-grids',
      icon: 'grid',
      color: '#64748b',
      summary: 'Invalid Grid data',
      status: packStatus('error', 'Invalid data'),
      fields: [packField('error', 'Error', 'Invalid electric-grid Pack data')],
    }
  }
  const projection = data.projection
  return {
    categoryId: 'electric-grids',
    icon: 'grid',
    color: projection.statusTone === 'error' ? '#dc2626' : projection.statusTone === 'working' ? '#d97706' : '#0f766e',
    summary: projection.summary,
    status: packStatus(projection.statusTone, projection.statusLabel),
    fields: [
      packField('model', 'Model', data.model.ref),
      packField('operating-point', 'Operating point', data.operatingPoint.ref),
      packField('frequency', 'Frequency', `${projection.frequencyHz.toFixed(2)} Hz`),
      packField('generation', 'Generation', mw(projection.totalGenerationMw)),
      packField('load', 'Served load', `${mw(projection.servedLoadMw)} / ${mw(projection.totalLoadMw)}`),
      packField('reserve', 'Reserve margin', mw(projection.reserveMarginMw)),
      packField('islands', 'Islands', String(projection.activeIslandCount)),
      packField('alarms', 'Active alarms', String(projection.activeAlarmCount)),
    ],
    mapIconVisible: true,
    mapIconSizePx: 18,
    noteworthyUpdates: projection.statusTone !== 'ready',
  }
}

export const electricGridUiPack: WorldPack = {
  descriptor: createWorldPackDescriptor({
    id: electricGridPackId,
    version: '1.0.0',
    name: 'Electric Grid',
    contributions: ['runtime', 'reference-data', 'presentation'],
  }),
  scenarioConfigSchema: emptyPackScenarioConfigSchema,
  runtime: {
    runtimes: [{ id: electricGridRuntimeId, version: '1.0.0', label: 'Local electric grid runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: electricGridRuntimeId,
  },
  referenceData: { builders: [], datasetIds: [asDatasetId('grid-norway')] },
  presentation: {
    mapLayerGroups: layerGroups,
    categories: [{
      id: 'electric-grids',
      label: 'Electric grids',
      emptyLabel: 'No electric grids',
      matches: object => parseElectricGridObjectData(object) !== null,
    }],
    presentObject: presentationForGrid,
  },
  ui: {
    surfacePanels: [{
      id: 'electric-grid.overview',
      label: 'Grid operations',
      defaultOpen: true,
      load: async () => await import('../../ui/grid/GridOverviewPanel.svelte'),
    }],
  },
}
