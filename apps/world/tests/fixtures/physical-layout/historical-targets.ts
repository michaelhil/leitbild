import type { OperationalObject } from '../../../src/core/model/index.ts'
import type { PackPhysicalTargetDescription } from '../../../src/core/packs/protocol.ts'
import { processPlantPack } from '../../../src/packs/process-plant/pack.ts'
import { processPlantUnitPackDataSchema } from '../../../src/packs/process-plant/model.ts'
import { canonicalPhysicalJson } from '../../../src/packs/physical-layout/model.ts'
import captured from './historical-targets-20261029.json'

// These are actual frozen descriptions, not current-model descriptions with an
// old digest stamped on. This test-only port exercises old physical admission,
// audience, retention and rendering contracts, never old numerical behavior.
if (captured.sourceCommit !== '5c2342cf71772a364d96cd213e49a43d6735a849') throw Error('Unexpected historical physical-target source')
const key = (selection: unknown) => canonicalPhysicalJson(selection)
const entries = new Map(captured.entries.map(entry => [key(entry.selection), entry.description]))
export const historicalPhysicalTargets = (owner: OperationalObject): PackPhysicalTargetDescription => {
  const { model, operatingPoint, automation } = processPlantUnitPackDataSchema.parse(owner.packData)
  const retained = entries.get(key({ model, operatingPoint, automation }))
  if (!retained) throw Error('Historical physical-target fixture does not contain this exact model selection')
  return { ...retained, objectId: owner.id }
}
export const historicalPhysicalProcessPlantPack = { ...processPlantPack, physicalTargets: historicalPhysicalTargets }
