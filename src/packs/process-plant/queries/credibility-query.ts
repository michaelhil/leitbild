import { readFileSync } from 'node:fs'
import { normalize } from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { requireSystem, success } from './common.ts'

type CredibilityArtifactLanguage = 'json' | 'svg'

interface CredibilityArtifactRef {
  readonly id: string
  readonly title: string
  readonly language: CredibilityArtifactLanguage
  readonly contentType: string
  readonly path: string
}

interface CredibilityEvidenceRef {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly scope: string
  readonly generatedFromCommand: string
  readonly appliesToSystem: (system: ProcessPlantSystemRuntime) => boolean
  readonly artifacts: ReadonlyArray<CredibilityArtifactRef>
}

const credibilityListPayloadSchema = z.object({
  systemId: idSchema,
}).strict()

const credibilityReadPayloadSchema = z.object({
  systemId: idSchema,
  evidenceId: idSchema,
  artifactId: idSchema,
}).strict()

const sourceRoot = fileURLToPath(new URL('../../../..', import.meta.url))

export const processPlantCredibilityQueryKinds = [
  'process-plant.credibility.list',
  'process-plant.credibility.read',
] as const

const pwrReferenceEvidence: CredibilityEvidenceRef = {
  id: 'process-plant.pwr.reference.credibility.v1',
  title: 'PWR reference credibility targets',
  description: 'Source-backed operational target envelopes for reference PWR transients and accident families.',
  scope: 'Operational/training credibility for the process-plant PWR reference family; not licensing-basis safety analysis.',
  generatedFromCommand: 'bun run process-plant:credibility',
  appliesToSystem: system =>
    String(system.system.graph.specId) === 'process-plant.pressurized-water-reactor.v1'
    || /^process-plant\.pressurized-water-reactor-\d+-loop\.assembled\.v2$/.test(String(system.system.graph.specId)),
  artifacts: [
    {
      id: 'summary',
      title: 'Target summary JSON',
      language: 'json',
      contentType: 'application/json',
      path: 'docs/assets/process-plant-pwr-credibility-summary.json',
    },
    {
      id: 'report',
      title: 'Target report SVG',
      language: 'svg',
      contentType: 'image/svg+xml',
      path: 'docs/assets/process-plant-pwr-credibility-report.svg',
    },
  ],
}

const credibilityEvidenceRefs: ReadonlyArray<CredibilityEvidenceRef> = [
  pwrReferenceEvidence,
]

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

const artifactRefView = (artifact: CredibilityArtifactRef): Record<string, unknown> => ({
  id: artifact.id,
  title: artifact.title,
  language: artifact.language,
  contentType: artifact.contentType,
  path: artifact.path,
})

const evidenceRefView = (evidence: CredibilityEvidenceRef): Record<string, unknown> => ({
  id: evidence.id,
  title: evidence.title,
  description: evidence.description,
  scope: evidence.scope,
  generatedFromCommand: evidence.generatedFromCommand,
  artifacts: evidence.artifacts.map(artifactRefView),
})

const evidenceForSystem = (system: ProcessPlantSystemRuntime): ReadonlyArray<CredibilityEvidenceRef> =>
  credibilityEvidenceRefs.filter(evidence => evidence.appliesToSystem(system))

const requireEvidence = (
  system: ProcessPlantSystemRuntime,
  evidenceId: string,
): CredibilityEvidenceRef => {
  const evidence = evidenceForSystem(system).find(candidate => candidate.id === evidenceId)
  if (!evidence) throw new Error(`process plant credibility evidence not found for system ${system.system.id}: ${evidenceId}`)
  return evidence
}

const requireArtifact = (
  evidence: CredibilityEvidenceRef,
  artifactId: string,
): CredibilityArtifactRef => {
  const artifact = evidence.artifacts.find(candidate => candidate.id === artifactId)
  if (!artifact) throw new Error(`process plant credibility artifact not found for ${evidence.id}: ${artifactId}`)
  return artifact
}

export const answerProcessPlantCredibilityQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantCredibilityQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.credibility.list') {
    const payload = credibilityListPayloadSchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, {
      systemId: payload.systemId,
      evidence: evidenceForSystem(system).map(evidenceRefView),
    }, config.at)
  }
  const payload = credibilityReadPayloadSchema.parse(config.request.payload)
  const system = requireSystem(config.systems, payload.systemId)
  const evidence = requireEvidence(system, payload.evidenceId)
  const artifact = requireArtifact(evidence, payload.artifactId)
  return success(config.request, {
    systemId: payload.systemId,
    evidence: evidenceRefView(evidence),
    artifact: artifactRefView(artifact),
    content: artifactContentFor(artifact.path),
  }, config.at)
}
