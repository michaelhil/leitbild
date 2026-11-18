import { z } from 'zod'
import { engineeringContinuationReceiptSchema } from '@leitbild/contracts'
import { compiledScenarioSchema } from '../model/scenario.ts'
import { scenarioDefinitionSchema } from '../scenarios/definition.ts'
import { simulationRunManifestSchema } from '../simulation-runs/manifest.ts'
import { simulationRunStateSnapshotSchema } from '../simulation-runs/state-store.ts'
import type { RunContinuationSeed } from '../simulation-runs/execution.ts'

export const continuationSeedSchema = z.object({
  manifest: simulationRunManifestSchema, definition: scenarioDefinitionSchema,
  compiledScenario: compiledScenarioSchema,
  checkpoint: z.object({ snapshot: simulationRunStateSnapshotSchema, runtimeStates: z.record(z.string(), z.unknown()), reads: z.array(z.unknown()).optional() }).strict(),
}).strict() as unknown as z.ZodType<RunContinuationSeed>
export const continuationWorkerInputSchema = z.object({
  token: z.string().uuid(), codeDigest: z.string(), seed: continuationSeedSchema,
  receipt: engineeringContinuationReceiptSchema,
}).strict()
export const continuationWorkerOutputSchema = z.object({ token: z.string().uuid(), receipt: engineeringContinuationReceiptSchema }).strict()
