import { readFileSync } from 'node:fs'
import { normalize } from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import {
  processPlantCatalog,
  type ProcessPlantCatalog,
  type ProcessPlantCredibilityArtifactCatalogEntry,
  type ProcessPlantCredibilityEvidenceCatalogEntry,
} from '../catalog-contributions.ts'
import type { CompiledPlantGraph } from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { requirePlant } from './common.ts'

export const credibilityListPayloadSchema = z.object({
  plantId: idSchema,
}).strict()

export const credibilityReadPayloadSchema = z.object({
  plantId: idSchema,
  evidenceId: idSchema,
  artifactId: idSchema,
}).strict()

const sourceRoot = fileURLToPath(new URL('../../../..', import.meta.url))

export const processPlantCredibilityQueryKinds = [
  'world.process-plant.credibility.list',
  'world.process-plant.credibility.read',
] as const

const safeEvidenceArtifactPath = (path: string): string => {
  const normalized = normalize(path)
  if (
    normalized !== path
    || normalized.includes('..')
    || !normalized.startsWith('docs/assets/')
    || (!normalized.endsWith('.json') && !normalized.endsWith('.svg'))
  ) {
    throw new Error(`invalid process plant credibility artifact path: ${path}`)
  }
  return normalized
}

const artifactContentFor = (path: string): string => {
  const safePath = safeEvidenceArtifactPath(path)
  return readFileSync(`${sourceRoot}/${safePath}`, 'utf8')
}

const artifactRefView = (artifact: ProcessPlantCredibilityArtifactCatalogEntry): Record<string, unknown> => ({
  id: artifact.id,
  title: artifact.title,
  language: artifact.language,
  contentType: artifact.contentType,
  path: artifact.path,
})

const evidenceRefView = (evidence: ProcessPlantCredibilityEvidenceCatalogEntry): Record<string, unknown> => ({
  id: evidence.id,
  title: evidence.title,
  description: evidence.description,
  scope: evidence.scope,
  generatedFromCommand: evidence.generatedFromCommand,
  artifacts: evidence.artifacts.map(artifactRefView),
})

export const processPlantCredibilityEvidenceForGraph = (
  graph: CompiledPlantGraph,
  catalog: ProcessPlantCatalog = processPlantCatalog,
): ReadonlyArray<ProcessPlantCredibilityEvidenceCatalogEntry> =>
  [...catalog.credibilityEvidenceById.values()].filter(evidence => evidence.appliesToGraph(graph))

const evidenceForSystem = (system: ProcessPlantRuntimeInstance): ReadonlyArray<ProcessPlantCredibilityEvidenceCatalogEntry> =>
  processPlantCredibilityEvidenceForGraph(system.plant.graph)

const requireEvidence = (
  system: ProcessPlantRuntimeInstance,
  evidenceId: string,
): ProcessPlantCredibilityEvidenceCatalogEntry => {
  const evidence = evidenceForSystem(system).find(candidate => candidate.id === evidenceId)
  if (!evidence) throw new Error(`process plant credibility evidence not found for system ${system.plant.id}: ${evidenceId}`)
  return evidence
}

const requireArtifact = (
  evidence: ProcessPlantCredibilityEvidenceCatalogEntry,
  artifactId: string,
): ProcessPlantCredibilityArtifactCatalogEntry => {
  const artifact = evidence.artifacts.find(candidate => candidate.id === artifactId)
  if (!artifact) throw new Error(`process plant credibility artifact not found for ${evidence.id}: ${artifactId}`)
  return artifact
}

export const answerProcessPlantCredibilityQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): unknown | undefined => {
  if (!processPlantCredibilityQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.credibility.list') {
    const payload = credibilityListPayloadSchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return {
      plantId: payload.plantId,
      evidence: evidenceForSystem(system).map(evidenceRefView),
    }
  }
  const payload = credibilityReadPayloadSchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  const evidence = requireEvidence(system, payload.evidenceId)
  const artifact = requireArtifact(evidence, payload.artifactId)
  return {
    plantId: payload.plantId,
    evidence: evidenceRefView(evidence),
    artifact: artifactRefView(artifact),
    content: artifactContentFor(artifact.path),
  }
}
