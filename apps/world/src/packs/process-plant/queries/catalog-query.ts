import { z } from 'zod'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { processPlantCatalog } from '../catalog-contributions.ts'
import { processPlantActionCatalog } from '../actions.ts'
import { processPlantAssessmentCatalog } from '../assessments.ts'
import { processPlantDefinitionCatalog } from '../plant-definitions.ts'
import { processPlantRecordingProfiles } from '../recording.ts'

export const processPlantCatalogInputSchema = z.object({}).strict()

export const processPlantCatalogQueryKinds = ['world.process-plant.catalog.list'] as const

const catalogView = (): Record<string, unknown> => ({
  ...processPlantDefinitionCatalog(),
  actions: processPlantActionCatalog(),
  assessments: processPlantAssessmentCatalog(),
  recordingProfiles: processPlantRecordingProfiles,
  displays: [...processPlantCatalog.displaysById.values()].map(entry => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
  })),
  credibilityEvidence: [...processPlantCatalog.credibilityEvidenceById.values()].map(entry => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    scope: entry.scope,
    artifacts: entry.artifacts.map(artifact => ({
      id: artifact.id,
      title: artifact.title,
      contentType: artifact.contentType,
    })),
  })),
})

export const answerProcessPlantCatalogQuery = (config: {
  readonly request: PackRuntimeQuery
}): unknown | undefined => {
  if (config.request.capabilityId !== 'world.process-plant.catalog.list') return undefined
  processPlantCatalogInputSchema.parse(config.request.input)
  return catalogView()
}
