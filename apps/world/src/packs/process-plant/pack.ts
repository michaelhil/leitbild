import type { PackId, GeoJsonPoint, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { geoPointFromLonLat, meters, objectIdSchema } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { WorldPack, PackObjectPresentation, PackScenarioItemSpec } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { processPlantControlWriteCommandKind } from './commands.ts'
import { emptyProcessPlantProjection, processPlantPackId, processPlantUnitPackDataSchema, type ProcessPlantUnitPackData } from './model.ts'
import { processPlantSimAdapterId, processPlantSimRuntimeId } from './sim/constants.ts'
import {
  processPlantAutomationSelectionSchema,
  processPlantModelSelectionSchema,
  processPlantOperatingPointSelectionSchema,
  processPlantPackConfigSchema,
} from './config.ts'
import {
  processPlantPwrFullPowerOperatingPointRef,
  processPlantPwrReferenceAutomationRef,
  processPlantPwrReferenceModelRef,
} from './plant-definitions.ts'
import { processPlantRecordingProfiles } from './recording.ts'
import { compileProcessPlant } from './plant-compiler.ts'
import { processPlantElectricalPortDefinitions } from './electrical-ports.ts'

const unsupported = (operation: string): never => {
  throw new Error(`process-plant pack does not support ${operation}`)
}

const parseUnitData = (object: OperationalObject): ProcessPlantUnitPackData | null => {
  const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

const pointFromSpec = (spec: PackScenarioItemSpec): GeoJsonPoint => {
  const location = spec.location
  if (!Array.isArray(location) || location.length !== 2 || typeof location[0] !== 'number' || typeof location[1] !== 'number') {
    throw new Error(`process-plant unit ${spec.id} requires location [lon, lat]`)
  }
  return geoPointFromLonLat(location[0], location[1])
}

const optionalString = (spec: PackScenarioItemSpec, key: string): string | undefined => {
  const value = spec[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`process-plant unit ${spec.id} has invalid ${key}`)
  return value
}

const optionalUnitData = (
  spec: PackScenarioItemSpec,
  key: string,
): Record<string, string> => {
  const value = optionalString(spec, key)
  return value === undefined ? {} : { [key]: value }
}

const expandPlantObject = (spec: PackScenarioItemSpec, at: IsoTimestamp): OperationalObject => {
  const model = processPlantModelSelectionSchema.parse(spec.model)
  const operatingPoint = processPlantOperatingPointSelectionSchema.parse(spec.operatingPoint)
  const automation = processPlantAutomationSelectionSchema.parse(spec.automation)
  const compiledPlant = compileProcessPlant({ id: spec.id, model, operatingPoint, automation })
  const packData: ProcessPlantUnitPackData = {
    type: 'process-plant',
    schemaVersion: 1,
    model,
    operatingPoint,
    automation,
    electricalPorts: [...processPlantElectricalPortDefinitions(compiledPlant)],
    ...optionalUnitData(spec, 'clusterId'),
    ...optionalUnitData(spec, 'coolingWater'),
    projection: emptyProcessPlantProjection(at),
  }
  return {
    id: objectIdSchema.parse(spec.id),
    kind: 'facility',
    packId: processPlantPackId as PackId,
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
      externalId: spec.id,
    },
    timestamps: {
      createdAt: at,
      updatedAt: at,
    },
    packData,
  }
}

const presentationForUnit = (object: OperationalObject, data: ProcessPlantUnitPackData): PackObjectPresentation => {
  const projection = data.projection ?? emptyProcessPlantProjection(object.timestamps.updatedAt)
  return {
    categoryId: 'process-plants',
    icon: 'plant',
    color: projection.statusTone === 'error' ? '#c7352b' : projection.statusTone === 'working' ? '#c77d13' : '#22845d',
    summary: projection.summary,
    status: packStatus(projection.statusTone, projection.statusLabel),
    fields: [
      packField('model', 'Model', data.model.ref),
      packField('operating-point', 'Operating point', data.operatingPoint.ref),
      ...(data.clusterId === undefined ? [] : [packField('cluster', 'Cluster', data.clusterId)]),
      ...(data.coolingWater === undefined ? [] : [packField('cooling-water', 'Cooling water', data.coolingWater)]),
      ...projection.fields,
    ],
    noteworthyUpdates: projection.statusTone !== 'ready',
  }
}

export const processPlantPack: WorldPack = {
  descriptor: createWorldPackDescriptor({
    id: 'process-plant', version: '1.0.0', name: 'Process Plant',
    contributions: ['runtime', 'recording', 'knowledge', 'scenario', 'presentation'],
  }),
  scenarioConfigSchema: processPlantPackConfigSchema,
  authoring: {
    itemTypes: [{
      id: 'plant',
      label: 'Process plant',
      description: 'A map-visible Plant backed by a selected model, operating point, and automation definition.',
      idPrefix: 'plant',
      defaultItem: {
        model: {
          ref: processPlantPwrReferenceModelRef,
          parameters: { loopCount: 4 },
        },
        operatingPoint: { ref: processPlantPwrFullPowerOperatingPointRef },
        automation: { ref: processPlantPwrReferenceAutomationRef },
      },
      placement: { target: 'item', path: ['location'] },
      fields: [{
        target: 'item', path: ['model', 'parameters', 'loopCount'], label: 'Primary loops',
        control: { kind: 'number', defaultValue: 4, min: 2, max: 6, step: 1 },
      }],
    }],
  },
  runtime: {
    runtimes: [{ id: processPlantSimRuntimeId, version: '1.0.0', label: 'Local process plant runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: processPlantSimRuntimeId,
  },
  recording: { profiles: processPlantRecordingProfiles },
  knowledge: { wikiRefs: [{ name: 'Leitbild PWR operations wiki', url: 'https://github.com/michaelhil/leitbild/blob/main/docs/wiki/pwr-ops.md' }] },
  scenario: {
    expandItem: (spec, context) => {
      if (spec.pack !== 'process-plant') unsupported(`scenario pack ${spec.pack}`)
      if (spec.type !== 'plant') unsupported(`scenario object type ${spec.type}`)
      return { objects: [expandPlantObject(spec, context.at)] }
    },
    applyOperation: () => unsupported('scenario operations'),
  },
  presentation: {
    categories: [{
      id: 'process-plants', label: 'Process plants', emptyLabel: 'No process plants',
      matches: (object): boolean => parseUnitData(object) !== null,
    }],
    presentObject: (object: OperationalObject): PackObjectPresentation => {
      const data = parseUnitData(object)
      if (data) return presentationForUnit(object, data)
      return {
        categoryId: 'unknown', icon: 'unknown', color: '#667085', summary: object.operational.status,
        status: packStatus('idle', object.operational.status),
        fields: [packField('warning', 'Warning', 'Object is outside the process-plant pack vocabulary')],
      }
    },
  },
}

export { processPlantControlWriteCommandKind }
