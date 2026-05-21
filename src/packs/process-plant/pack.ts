import type { LeitbildPack, PackCommandRequest, PackCreationGeometry, PackObjectPresentation } from '../../core/packs/protocol.ts'
import type { OperationalObject } from '../../core/model/index.ts'
import { processPlantControlWriteCommandKind } from './commands.ts'
import { processPlantSimProviderId } from './sim/constants.ts'

const unsupported = (operation: string): never => {
  throw new Error(`process-plant pack does not support ${operation}`)
}

export const processPlantPack: LeitbildPack = {
  id: 'process-plant',
  name: 'Process Plant',
  domain: 'process-plant',
  simulationProviders: [{
    id: processPlantSimProviderId,
    label: 'Local process plant simulator',
    kind: 'local',
  }],
  defaultSimulationProviderId: processPlantSimProviderId,
  categories: [],
  createObjectTypes: [],
  presentObject: (_object: OperationalObject): PackObjectPresentation =>
    unsupported('object presentation'),
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
