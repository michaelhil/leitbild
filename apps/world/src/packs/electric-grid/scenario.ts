import type { GeoJsonPoint, IsoTimestamp, OperationalObject, PackId } from '../../core/model/index.ts'
import { geoPointFromLonLat, meters, objectIdSchema } from '../../core/model/index.ts'
import type { PackScenarioItemSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import {
  gridAutomationSelectionSchema,
  gridModelSelectionSchema,
  gridOperatingPointSelectionSchema,
} from './config.ts'
import { electricGridDefinitionCatalog } from './definition-refs.ts'
import { electricGridPackId, emptyGridProjection, type ElectricGridPackData } from './model.ts'
import { electricGridAdapterId } from './sim/constants.ts'
import { compileGridDefinition } from './definitions.ts'
import { gridDefinitionSchema } from './config.ts'
import { gridElectricalPortDefinitions } from './electrical-ports.ts'

const unsupported = (operation: string): never => {
  throw new Error(`electric-grid Pack does not support ${operation}`)
}

const pointFromSpec = (spec: PackScenarioItemSpec): GeoJsonPoint => {
  const location = spec.location
  if (!Array.isArray(location) || location.length !== 2 || typeof location[0] !== 'number' || typeof location[1] !== 'number') {
    throw new Error(`Grid ${spec.id} requires location [lon, lat]`)
  }
  return geoPointFromLonLat(location[0], location[1])
}

const expandGridObject = (spec: PackScenarioItemSpec, at: IsoTimestamp): OperationalObject => {
  const model = gridModelSelectionSchema.parse(spec.model)
  const modelMetadata = electricGridDefinitionCatalog.models.find(candidate => candidate.id === model.ref)
  if (!modelMetadata) throw new Error(`unknown Grid Model: ${model.ref}`)
  const operatingPoint = gridOperatingPointSelectionSchema.parse(spec.operatingPoint)
  const automation = gridAutomationSelectionSchema.parse(spec.automation)
  const compiledGrid = compileGridDefinition(gridDefinitionSchema.parse({ id: spec.id, model, operatingPoint, automation }))
  const packData: ElectricGridPackData = {
    type: 'electric-grid',
    schemaVersion: 1,
    model,
    operatingPoint,
    automation,
    electricalPorts: [...gridElectricalPortDefinitions(compiledGrid)],
    projection: emptyGridProjection(at, modelMetadata.nominalFrequencyHz),
  }
  return {
    id: objectIdSchema.parse(spec.id),
    kind: 'facility',
    packId: electricGridPackId as PackId,
    label: spec.label,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: pointFromSpec(spec),
        accuracyM: meters(10_000),
        observedAt: at,
        staleAfterMs: 60_000,
      },
      frame: { kind: 'wgs84' },
    },
    operational: { status: 'initializing', priority: 'normal', mode: 'simulated' },
    alerts: [],
    provenance: { source: 'simulator', adapterId: electricGridAdapterId, externalId: spec.id },
    timestamps: { createdAt: at, updatedAt: at },
    packData,
  }
}

export const electricGridScenarioSupport: PackScenarioSupport = {
  expandItem: (spec, context) => {
    if (spec.pack !== electricGridPackId) unsupported(`scenario Pack ${spec.pack}`)
    if (spec.type !== 'grid') unsupported(`scenario item type ${spec.type}`)
    return { objects: [expandGridObject(spec, context.at)] }
  },
  applyOperation: () => unsupported('scenario operations'),
}
