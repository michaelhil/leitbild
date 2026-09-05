import { z } from 'zod'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { processPlantCatalog } from '../catalog-contributions.ts'
import { processPlantActionCatalog } from '../actions.ts'
import { processPlantAssessmentCatalog } from '../assessments.ts'
import { processPlantDefinitionCatalog } from '../plant-definitions.ts'
import { processPlantRecordingProfiles } from '../recording.ts'
import {
  paginateProcessPlantSearch,
  processPlantSearchPaginationShape,
} from './common.ts'

export const processPlantCatalogInputSchema = z.object({}).strict()
export const processPlantActionsSearchInputSchema = z.object({
  query: z.string().trim().min(1).optional().describe('Words, shorthand, or an action name to match against the action catalog.'),
  ...processPlantSearchPaginationShape,
}).strict()

export const processPlantCatalogQueryKinds = [
  'world.process-plant.catalog.list',
  'world.process-plant.actions.search',
] as const

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
  if (config.request.capabilityId === 'world.process-plant.catalog.list') {
    processPlantCatalogInputSchema.parse(config.request.input)
    return catalogView()
  }
  if (config.request.capabilityId !== 'world.process-plant.actions.search') return undefined
  const payload = processPlantActionsSearchInputSchema.parse(config.request.input)
  const queryTerms = [...new Set(payload.query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  const actions = processPlantActionCatalog()
    .map(action => {
      const terms = new Set(`${action.id} ${action.title} ${action.description}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      return { action, score: queryTerms.filter(term => terms.has(term)).length }
    })
    .filter(entry => queryTerms.length === 0 || entry.score > 0)
    .sort((left, right) => right.score - left.score || left.action.id.localeCompare(right.action.id))
    .map(entry => entry.action)
  const page = paginateProcessPlantSearch(actions, payload.offset, payload.limit)
  return {
    total: page.total,
    offset: page.offset,
    returned: page.returned,
    hasMore: page.hasMore,
    actions: page.items,
  }
}
