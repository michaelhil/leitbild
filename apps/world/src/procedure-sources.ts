import {
  createProcedureSourceService,
  type ProcedureSourceConfig,
  type ProcedureSourceService,
} from './features/procedures/source.ts'
import { join, resolve } from 'node:path'
import { loadKnowledge, knowledgeSnapshotPath } from '@leitbild/knowledge'
import { assertLd01ProcedureTarget, assertPwrReferenceProcedureTarget } from './packs/process-plant/procedure-applicability.ts'
import { resolveLd01UnitArtifact } from './packs/process-plant/engine/artifact.ts'

/** Product-owned procedure catalogs. The generic World procedure engine does not choose content. */
const pwrProcedureSource: ProcedureSourceConfig = {
  sourceId: 'leitbild',
  label: 'Leitbild model-scoped PWR tasks and reference transfer procedures',
  repository: 'Leitbild-wiki',
  ref: 'publication',
  procedurePath: 'world/packs/process-plant/procedures',
  // Explicit publication membership preserves each document's authored owner.
  // The original reference E-0 remains wiki evidence, not an implicit override.
  documentPaths: [
    'world/packs/process-plant/procedures/E-0.md',
    'world/packs/process-plant/procedures/ES-0.1.md',
    'world/packs/process-plant/procedures/ES-1.3.md',
    'world/packs/process-plant/procedures/RHR-1.md',
    'world/packs/process-plant/procedures/RHR-2.md',
    'world/packs/process-plant/procedures/ECA-0.0.md',
    'world/packs/process-plant/procedures/FR-H.3.md',
    'world/packs/process-plant/procedures/FR-H.4.md',
    'world/packs/process-plant/procedures/FR-H.5.md',
    ...[
      'E-1', 'E-2', 'E-3', 'ECA-1.1', 'ECA-1.2', 'ECA-2.1',
      'ECA-3.1', 'ECA-3.2', 'ECA-3.3', 'ES-0.0', 'ES-0.2',
      'ES-1.1', 'ES-1.2', 'ES-1.4', 'ES-3.1', 'ES-3.2', 'ES-3.3',
      'FR-C.1', 'FR-C.2', 'FR-C.3', 'FR-H.1', 'FR-H.2',
      'FR-I.1', 'FR-I.2', 'FR-I.3', 'FR-P.1', 'FR-P.2', 'FR-S.1',
      'FR-S.2', 'FR-Z.1', 'FR-Z.2', 'FR-Z.3',
    ].map(id => `archive/pwr-reference-model/procedures/${id}.md`),
  ],
  assertTargetApplicable: (_document, object) => assertPwrReferenceProcedureTarget(object),
}

/** LD-01's X4 procedure set (owner 1 Nov: E0, ES0, A2, ECA0), only where the LD-01 native engine is installed
 * (LD01_UNIT_ARTIFACT names a usable artifact). Production installs none, so it lists no LD-01 procedure; an LD-01
 * procedure applies only to an LD-01 Plant. Each stays uninstalled until its wiki page installs it. */
const ld01ProcedureSource: ProcedureSourceConfig = {
  sourceId: 'leitbild-ld01',
  label: 'LD-01 X4 procedures (local native unit only)',
  repository: 'Leitbild-wiki',
  ref: 'publication',
  procedurePath: 'world/packs/process-plant/reference-designs/ld-01/procedures',
  documentPaths: ['trip-and-safety-response', 'post-trip-stabilization', 'control-and-power-assessment', 'loss-of-ac-power']
    .map(name => `world/packs/process-plant/reference-designs/ld-01/procedures/${name}.md`),
  assertTargetApplicable: (_document, object) => assertLd01ProcedureTarget(object),
}

export const procedureSources: ReadonlyArray<ProcedureSourceConfig> = resolveLd01UnitArtifact().ok
  ? [pwrProcedureSource, ld01ProcedureSource]
  : [pwrProcedureSource]

export const createConfiguredProcedureSourceService = (config: { readonly dataDir: string }): ProcedureSourceService =>
  createProcedureSourceService({
    sources: procedureSources,
    retentionDirectory: join(config.dataDir, 'procedure-publications'),
    loadKnowledge: () => loadKnowledge(knowledgeSnapshotPath(resolve(import.meta.dir, '../../..'))),
  })
