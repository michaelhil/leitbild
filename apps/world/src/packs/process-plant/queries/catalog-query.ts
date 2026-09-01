import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { processPlantCatalog } from '../catalog-contributions.ts'
import { processPlantActionCatalog } from '../actions.ts'
import { processPlantAssessmentCatalog } from '../assessments.ts'
import { processPlantDefinitionCatalog } from '../plant-definitions.ts'
import { processPlantRecordingProfiles } from '../recording.ts'
import { success } from './common.ts'

const emptyPayloadSchema = z.object({}).strict()

export const processPlantCatalogQueryKinds = ['process-plant.catalog.list'] as const

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
  readonly request: PackQueryRequest
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (config.request.kind !== 'process-plant.catalog.list') return undefined
  emptyPayloadSchema.parse(config.request.payload ?? {})
  return success(config.request, catalogView(), config.at)
}
