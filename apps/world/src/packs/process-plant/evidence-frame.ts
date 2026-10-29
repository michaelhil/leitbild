import { createHash } from 'node:crypto'
import type { IsoTimestamp } from '../../core/model/index.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import type { ProcessPlantProtectionConfig } from './runtime/ic/control-protection-model.ts'

const automationDigests = new WeakMap<ProcessPlantProtectionConfig, string>()

/** Identity of the actual immutable engineering definition, separate from changing I&C lifecycle state. */
export const processPlantAutomationDigest = (definition: ProcessPlantProtectionConfig): string => {
  const previous = automationDigests.get(definition)
  if (previous !== undefined) return previous
  const digest = createHash('sha256').update(JSON.stringify(definition)).digest('hex')
  automationDigests.set(definition, digest)
  return digest
}

export const processPlantEvidenceFrame = (system: ProcessPlantRuntimeInstance, simulationTime?: IsoTimestamp) => ({
  evidenceKind: 'engineering-diagnostic' as const,
  provenance: 'runtime-model' as const,
  ...(simulationTime === undefined ? {} : { simulationTime }),
  modelRef: system.plant.modelRef,
  modelDigest: system.plant.modelDigest,
  automationRef: system.plant.automationRef,
  automationDigest: processPlantAutomationDigest(system.plant.automation),
})
