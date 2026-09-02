import {
  electricalPortDefinitionSchema,
  type ElectricalPortDefinition,
  type IsoTimestamp,
} from '../../core/model/index.ts'
import type { CompiledGridDefinition } from './grid-model.ts'
import type { GridRuntimeInstance } from './runtime/instance.ts'

export const gridElectricalPortDefinitions = (
  definition: CompiledGridDefinition,
): ReadonlyArray<ElectricalPortDefinition> => definition.model.connectionPoints.map(point =>
  electricalPortDefinitionSchema.parse({
    id: point.id,
    label: point.label,
    nominalKv: point.nominalKv,
    maximumExportMw: point.maximumExportMw,
    maximumImportMw: point.maximumImportMw,
  }))

export const gridElectricalPortsAt = (config: {
  readonly grid: GridRuntimeInstance
  readonly at: IsoTimestamp
}): ReadonlyArray<ElectricalPortDefinition> => config.grid.definition.model.connectionPoints.map(point => {
  const bus = config.grid.busStates.get(point.busId)
  const connection = config.grid.externalConnections.get(point.id)
  const connected = connection?.connected === true
  return electricalPortDefinitionSchema.parse({
    id: point.id,
    label: point.label,
    nominalKv: point.nominalKv,
    maximumExportMw: point.maximumExportMw,
    maximumImportMw: point.maximumImportMw,
    state: {
      activePowerMw: connection?.connected === true ? -connection.systemActivePowerMw : 0,
      voltagePu: bus?.voltagePu ?? 0,
      frequencyHz: bus?.frequencyHz ?? 0,
      energized: (bus?.voltagePu ?? 0) >= 0.8,
      connected,
      observedAt: config.at,
    },
  })
})
