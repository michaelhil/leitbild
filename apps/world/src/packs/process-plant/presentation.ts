import type { OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { PackObjectPresentation, PackPresentationContribution } from '../../core/packs/protocol.ts'
import {
  emptyProcessPlantProjection,
  processPlantUnitPackDataSchema,
  type ProcessPlantUnitPackData,
} from './model.ts'

const parseUnitData = (object: OperationalObject): ProcessPlantUnitPackData | null => {
  const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
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

export const processPlantPresentation: PackPresentationContribution = {
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
      fields: [packField('warning', 'Warning', 'Object is outside the process-plant Pack vocabulary')],
    }
  },
}
