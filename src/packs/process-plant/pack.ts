import type { DomainId, GeoJsonPoint, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { geoPointFromLonLat, meters, objectIdSchema } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectPresentation, PackScenarioObjectSpec } from '../../core/packs/protocol.ts'
import { processPlantControlWriteCommandKind } from './commands.ts'
import { emptyProcessPlantProjection, processPlantDomainId, processPlantUnitDomainDataSchema, type ProcessPlantUnitDomainData } from './model.ts'
import { processPlantSimAdapterId, processPlantSimProviderId } from './sim/constants.ts'

const unsupported = (operation: string): never => {
  throw new Error(`process-plant pack does not support ${operation}`)
}

const parseUnitData = (object: OperationalObject): ProcessPlantUnitDomainData | null => {
  const parsed = processPlantUnitDomainDataSchema.safeParse(object.domainData)
  return parsed.success ? parsed.data : null
}

const pointFromSpec = (spec: PackScenarioObjectSpec): GeoJsonPoint => {
  const location = spec.location
  if (!Array.isArray(location) || location.length !== 2 || typeof location[0] !== 'number' || typeof location[1] !== 'number') {
    throw new Error(`process-plant unit ${spec.id} requires location [lon, lat]`)
  }
  return geoPointFromLonLat(location[0], location[1])
}

const requiredString = (spec: PackScenarioObjectSpec, key: string): string => {
  const value = spec[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`process-plant unit ${spec.id} requires ${key}`)
  return value
}

const optionalString = (spec: PackScenarioObjectSpec, key: string): string | undefined => {
  const value = spec[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`process-plant unit ${spec.id} has invalid ${key}`)
  return value
}

const optionalUnitData = (
  spec: PackScenarioObjectSpec,
  key: string,
): Record<string, string> => {
  const value = optionalString(spec, key)
  return value === undefined ? {} : { [key]: value }
}

const expandUnitObject = (spec: PackScenarioObjectSpec, at: IsoTimestamp): OperationalObject => {
  const systemId = requiredString(spec, 'systemId')
  const domainData: ProcessPlantUnitDomainData = {
    type: 'process-plant-unit',
    schemaVersion: 1,
    systemId,
    ...optionalUnitData(spec, 'clusterId'),
    ...optionalUnitData(spec, 'coolingWater'),
    projection: emptyProcessPlantProjection(at),
  }
  return {
    id: objectIdSchema.parse(spec.id),
    kind: 'facility',
    domain: processPlantDomainId as DomainId,
    label: spec.label,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: pointFromSpec(spec),
        accuracyM: meters(10),
        observedAt: at,
        staleAfterMs: 60_000,
      },
      frame: { kind: 'wgs84' },
    },
    operational: {
      status: 'initializing',
      priority: 'normal',
      mode: 'simulated',
    },
    alerts: [],
    provenance: {
      source: 'simulator',
      adapterId: processPlantSimAdapterId,
      externalId: systemId,
    },
    timestamps: {
      createdAt: at,
      updatedAt: at,
    },
    domainData,
  }
}

const presentationForUnit = (object: OperationalObject, data: ProcessPlantUnitDomainData): PackObjectPresentation => {
  const projection = data.projection ?? emptyProcessPlantProjection(object.timestamps.updatedAt)
  return {
    categoryId: 'process-plants',
    icon: 'plant',
    color: projection.statusTone === 'error' ? '#c7352b' : projection.statusTone === 'working' ? '#c77d13' : '#22845d',
    summary: projection.summary,
    status: packStatus(projection.statusTone, projection.statusLabel),
    fields: [
      packField('system-id', 'System', data.systemId),
      ...(data.clusterId === undefined ? [] : [packField('cluster', 'Cluster', data.clusterId)]),
      ...(data.coolingWater === undefined ? [] : [packField('cooling-water', 'Cooling water', data.coolingWater)]),
      ...projection.fields,
    ],
    noteworthyUpdates: projection.statusTone !== 'ready',
  }
}

export const processPlantPack: LeitbildPack = {
  id: 'process-plant',
  name: 'Process Plant',
  domain: processPlantDomainId,
  simulationProviders: [{
    id: processPlantSimProviderId,
    label: 'Local process plant simulator',
    kind: 'local',
  }],
  defaultSimulationProviderId: processPlantSimProviderId,
  scenario: {
    expandObject: (spec, context): OperationalObject => {
      if (spec.type !== 'unit') unsupported(`scenario object type ${spec.type}`)
      return expandUnitObject(spec, context.at)
    },
    applyOperation: () => unsupported('scenario operations'),
  },
  categories: [{
    id: 'process-plants',
    label: 'Process plants',
    emptyLabel: 'No process plants',
    matches: (object): boolean => parseUnitData(object) !== null,
  }],
  createObjectTypes: [],
  presentObject: (object: OperationalObject): PackObjectPresentation => {
    const data = parseUnitData(object)
    if (data) return presentationForUnit(object, data)
    return {
      categoryId: 'unknown',
      icon: 'unknown',
      color: '#667085',
      summary: object.operational.status,
      status: packStatus('idle', object.operational.status),
      fields: [packField('warning', 'Warning', 'Object is outside the process-plant pack vocabulary')],
    }
  },
  defaultObjectLabel: (typeId: string): string =>
    unsupported(`default label for create type ${typeId}`),
  buildCreateObjectCommand: (
    typeId: string,
    _label: string,
    _geometry: PackCreationGeometry,
    _parameters?: unknown,
  ): PackCommandRequest =>
    unsupported(`create-object command for type ${typeId}`),
  isController: (): boolean => false,
  isTarget: (): boolean => false,
  buildSetTargetCommand: (): PackCommandRequest =>
    unsupported('target commands'),
  buildCancelTargetCommand: (): PackCommandRequest =>
    unsupported('cancel-target commands'),
}

export { processPlantControlWriteCommandKind }
