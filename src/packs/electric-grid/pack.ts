import type { OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { LeitbildPack, PackCommandRequest, PackMapLayerGroup, PackObjectField, PackObjectPresentation } from '../../core/packs/protocol.ts'
import {
  gridClearDerateCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridDispatchGeneratorCommandKind,
  gridOpenBranchCommandKind,
  gridRestoreLoadCommandKind,
  gridSetEvChargingPolicyCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridShedLoadCommandKind,
  gridTripGeneratorCommandKind,
} from './commands.ts'
import { asDatasetId } from '../../reference-data/types.ts'
import { electricGridScenarioSupport } from './scenario.ts'
import { electricGridRuntimeId } from './sim/constants.ts'
import { electricGridPackId, parseElectricGridObjectData, type ElectricGridPackData } from './model.ts'

const gridNorwayDatasetIdValue = asDatasetId('grid-norway')

const parseGridData = (object: OperationalObject): ElectricGridPackData | null => {
  return parseElectricGridObjectData(object)
}

const mw = (value: number): string => `${Math.round(value).toLocaleString()} MW`
const percent = (value: number): string => `${Math.round(value).toLocaleString()}%`
const pu = (value: number): string => `${value.toFixed(3)} pu`

const toneFor = (data: ElectricGridPackData): 'ready' | 'working' | 'error' | 'idle' => {
  if (data.type === 'grid_system') return data.activeAlarmCount > 0 ? 'error' : 'ready'
  if (data.type === 'grid_branch') return data.loadingPercent >= 100 || data.state === 'faulted' ? 'error' : data.loadingPercent >= 85 || data.state === 'derated' ? 'working' : 'ready'
  if (data.type === 'grid_load') return data.serviceState === 'outage' || data.serviceState === 'shed' ? 'error' : data.serviceState === 'constrained' ? 'working' : 'ready'
  if (data.type === 'grid_substation') return data.state === 'normal' ? 'ready' : data.state === 'outage' ? 'error' : 'working'
  if (data.type === 'grid_generator') return data.state === 'online' ? 'ready' : data.state === 'derated' ? 'working' : 'error'
  if (data.type === 'grid_storage') return data.state === 'unavailable' ? 'error' : data.state === 'idle' ? 'idle' : 'working'
  return data.constrained ? 'working' : 'ready'
}

const colorFor = (data: ElectricGridPackData): string => {
  const tone = toneFor(data)
  if (tone === 'error') return '#dc2626'
  if (tone === 'working') return '#d97706'
  if (data.assetKind === 'generator') return '#15803d'
  if (data.assetKind === 'load' || data.assetKind === 'ev_charging') return '#2563eb'
  if (data.assetKind === 'branch') return '#64748b'
  if (data.assetKind === 'substation') return '#475569'
  return '#0f766e'
}

const iconFor = (data: ElectricGridPackData): 'grid' | 'plant' | 'hospital' | 'traffic' => {
  if (data.type === 'grid_generator') return 'plant'
  if (data.type === 'grid_load' && data.loadKind === 'hospital') return 'hospital'
  if (data.type === 'grid_load' && data.loadKind === 'ev_charging') return 'traffic'
  return 'grid'
}

const fieldsFor = (data: ElectricGridPackData): ReadonlyArray<PackObjectField> => {
  if (data.type === 'grid_system') {
    return [
      packField('frequency', 'Frequency', `${data.frequencyHz.toFixed(2)} Hz`),
      packField('generation', 'Generation', mw(data.totalGenerationMw)),
      packField('load', 'Load', `${mw(data.servedLoadMw)} / ${mw(data.totalLoadMw)}`),
      packField('reserve', 'Reserve margin', mw(data.reserveMarginMw)),
      packField('branch-loading', 'Max branch loading', percent(data.highestBranchLoadingPercent)),
      packField('voltage', 'Lowest voltage', pu(data.lowestVoltagePu)),
      packField('islands', 'Islands', String(data.activeIslandCount)),
      packField('alarms', 'Active alarms', String(data.activeAlarmCount)),
    ]
  }
  if (data.type === 'grid_branch') {
    return [
      packField('kind', 'Kind', data.branchKind.replaceAll('_', ' ')),
      packField('from-to', 'Buses', `${data.fromBusId} → ${data.toBusId}`),
      packField('voltage', 'Voltage', `${data.nominalKv} kV`),
      packField('flow', 'Flow', mw(data.flowMw)),
      packField('rating', 'Rating', mw(data.ratingMw)),
      packField('loading', 'Loading', percent(data.loadingPercent)),
      packField('state', 'State', data.state),
      packField('provenance', 'Provenance', `${data.provenance.method} · ${data.provenance.confidence}`),
    ]
  }
  if (data.type === 'grid_generator') {
    return [
      packField('kind', 'Kind', data.generationKind),
      packField('bus', 'Bus', data.busId),
      packField('dispatch', 'Dispatch', mw(data.dispatchMw)),
      packField('available', 'Available', `${mw(data.availableMw)} / ${mw(data.capacityMw)}`),
      packField('reserve', 'Reserve', mw(data.reserveMw)),
      ...(data.annualProductionGwh === undefined ? [] : [packField('annual-production', 'Normal annual production', `${Math.round(data.annualProductionGwh).toLocaleString()} GWh`)]),
      ...(data.operator === undefined ? [] : [packField('operator', 'Operator', data.operator)]),
      ...(data.priceArea === undefined ? [] : [packField('price-area', 'Price area', data.priceArea)]),
      packField('state', 'State', data.state),
    ]
  }
  if (data.type === 'grid_load') {
    return [
      packField('kind', 'Kind', data.loadKind.replaceAll('_', ' ')),
      packField('bus', 'Bus', data.busId),
      packField('served', 'Served', `${mw(data.servedMw)} / ${mw(data.demandMw)}`),
      packField('shed', 'Shed', mw(data.shedMw)),
      packField('critical', 'Critical', mw(data.criticalMw)),
      packField('voltage', 'Voltage', pu(data.voltagePu)),
      packField('service', 'Service', data.serviceState),
    ]
  }
  if (data.type === 'grid_substation') {
    return [
      packField('bus', 'Bus', data.busId),
      packField('voltage', 'Voltage', `${data.nominalKv} kV · ${pu(data.voltagePu)}`),
      packField('frequency', 'Frequency', `${data.frequencyHz.toFixed(2)} Hz`),
      packField('branches', 'Branches', String(data.connectedBranchCount)),
      packField('loading', 'Loading', percent(data.loadingPercent)),
      packField('reactive', 'Reactive margin', `${Math.round(data.reactiveMarginMvar)} Mvar`),
    ]
  }
  if (data.type === 'grid_storage') {
    return [
      packField('bus', 'Bus', data.busId),
      packField('soc', 'State of charge', percent(data.stateOfChargeFraction * 100)),
      packField('dispatch', 'Dispatch', mw(data.dispatchMw)),
      packField('state', 'State', data.state),
    ]
  }
  return [
    packField('area', 'Area', data.areaId),
    packField('price', 'Price', `${Math.round(data.priceNokPerMwh)} NOK/MWh`),
    packField('net', 'Net export', mw(data.netExportMw)),
    packField('state', 'State', data.constrained ? 'constrained' : 'normal'),
  ]
}

const summaryFor = (data: ElectricGridPackData): string => {
  if (data.type === 'grid_system') return `${data.frequencyHz.toFixed(2)} Hz · ${mw(data.servedLoadMw)} served · ${data.activeAlarmCount} alarms`
  if (data.type === 'grid_branch') return `${mw(data.flowMw)} · ${percent(data.loadingPercent)} · ${data.state}`
  if (data.type === 'grid_generator') return `${data.generationKind} · ${mw(data.dispatchMw)} / ${mw(data.availableMw)}`
  if (data.type === 'grid_load') return `${data.loadKind.replaceAll('_', ' ')} · ${mw(data.servedMw)} served`
  if (data.type === 'grid_substation') return `${data.nominalKv} kV · ${pu(data.voltagePu)} · ${data.state}`
  if (data.type === 'grid_storage') return `${data.state} · ${mw(data.dispatchMw)}`
  return `${data.areaId} · ${Math.round(data.priceNokPerMwh)} NOK/MWh`
}

const commandFor = (kind: string, object: OperationalObject, payload: unknown): PackCommandRequest => ({
  kind,
  targetObjectIds: [object.id],
  payload,
})

const layerGroups: ReadonlyArray<PackMapLayerGroup> = [
  {
    id: 'electric-grid:reference-lines',
    label: 'Reference lines',
    defaultVisible: true,
    layerIdPattern: 'reference:grid-norway:line:*',
  },
  {
    id: 'electric-grid:reference-cables',
    label: 'Reference cables',
    defaultVisible: true,
    layerIdPattern: 'reference:grid-norway:cable:*',
  },
  {
    id: 'electric-grid:reference-substations',
    label: 'Reference substations',
    defaultVisible: true,
    layerIdPattern: 'reference:grid-norway:substation:*',
  },
  {
    id: 'electric-grid:reference-generation',
    label: 'Reference generation',
    defaultVisible: true,
    layerIdPattern: 'reference:grid-norway:plant:*',
  },
]

const unsupportedCommand = (): PackCommandRequest => {
  throw new Error('electric-grid pack does not support this interaction')
}

export const electricGridPack: LeitbildPack = {
  id: electricGridPackId,
  name: 'Electric Grid',
  runtimes: [
    { id: electricGridRuntimeId, label: 'Local electric grid runtime', kind: 'local' },
  ],
  defaultRuntimeId: electricGridRuntimeId,
  wikiRefs: [
    { name: 'Leitbild electric grid pack wiki', url: 'https://samsinn-wikis.github.io/leitbild/packs/electric-grid/' },
  ],
  referenceDatasetIds: [gridNorwayDatasetIdValue],
  mapLayerGroups: layerGroups,
  scenario: electricGridScenarioSupport,
  categories: [
    { id: 'grid-system', label: 'Grid Overview', emptyLabel: 'No grid overview', matches: object => parseGridData(object)?.assetKind === 'system' },
    { id: 'grid-generation', label: 'Generation', emptyLabel: 'No generators', matches: object => parseGridData(object)?.assetKind === 'generator' || parseGridData(object)?.assetKind === 'storage' },
    { id: 'grid-branches', label: 'Lines & Transformers', emptyLabel: 'No grid branches', matches: object => parseGridData(object)?.assetKind === 'branch' },
    { id: 'grid-substations', label: 'Substations', emptyLabel: 'No substations', matches: object => parseGridData(object)?.assetKind === 'substation' },
    { id: 'grid-consumers', label: 'Consumers', emptyLabel: 'No consumers', matches: object => {
      const data = parseGridData(object)
      return data?.assetKind === 'load' || data?.assetKind === 'ev_charging'
    } },
  ],
  createObjectTypes: [],
  presentObject: (object: OperationalObject): PackObjectPresentation => {
    const data = parseGridData(object)
    if (!data) {
      return {
        categoryId: 'grid-system',
        icon: 'grid',
        color: '#64748b',
        summary: 'Invalid electric-grid data',
        status: packStatus('error', 'Invalid data'),
        fields: [packField('error', 'Error', 'Invalid electric-grid pack data')],
      }
    }
    const tone = toneFor(data)
    return {
      categoryId: data.assetKind === 'system'
        ? 'grid-system'
        : data.assetKind === 'generator' || data.assetKind === 'storage'
          ? 'grid-generation'
          : data.assetKind === 'branch'
            ? 'grid-branches'
            : data.assetKind === 'substation'
              ? 'grid-substations'
              : 'grid-consumers',
      icon: iconFor(data),
      color: colorFor(data),
      summary: summaryFor(data),
      status: packStatus(tone, summaryFor(data)),
      fields: fieldsFor(data),
      mapIconVisible: data.assetKind !== 'system' && data.assetKind !== 'branch' && data.assetKind !== 'market_area',
      noteworthyUpdates: data.assetKind === 'system' || tone !== 'ready',
    }
  },
  defaultObjectLabel: (typeId: string): string => {
    throw new Error(`electric-grid pack does not support object creation yet: ${typeId}`)
  },
  buildCreateObjectCommand: (): PackCommandRequest => unsupportedCommand(),
  isController: (object: OperationalObject): boolean => {
    const data = parseGridData(object)
    return data?.type === 'grid_generator' || data?.type === 'grid_branch' || data?.type === 'grid_load'
  },
  isTarget: () => false,
  buildSetTargetCommand: (controller: OperationalObject): PackCommandRequest => {
    const data = parseGridData(controller)
    if (data?.type === 'grid_generator') return commandFor(gridDispatchGeneratorCommandKind, controller, { targetMw: Math.max(0, data.targetMw * 0.9) })
    if (data?.type === 'grid_branch') return commandFor(data.state === 'closed' ? gridDerateBranchCommandKind : gridClearDerateCommandKind, controller, data.state === 'closed' ? { availability: 0.65 } : {})
    if (data?.type === 'grid_load') return commandFor(gridShedLoadCommandKind, controller, { shedMw: data.interruptibleMw * 0.25 })
    return unsupportedCommand()
  },
  buildCancelTargetCommand: (controller: OperationalObject): PackCommandRequest => {
    const data = parseGridData(controller)
    if (data?.type === 'grid_generator') return commandFor(data.state === 'tripped' ? gridSetGeneratorAvailabilityCommandKind : gridTripGeneratorCommandKind, controller, data.state === 'tripped' ? { availableMw: data.capacityMw } : {})
    if (data?.type === 'grid_branch') return commandFor(data.state === 'open' ? gridCloseBranchCommandKind : gridOpenBranchCommandKind, controller, {})
    if (data?.type === 'grid_load' && data.loadKind === 'ev_charging') return commandFor(gridSetEvChargingPolicyCommandKind, controller, { demandMw: Math.max(data.criticalMw, data.demandMw * 0.65) })
    if (data?.type === 'grid_load') return commandFor(gridRestoreLoadCommandKind, controller, {})
    return unsupportedCommand()
  },
}
