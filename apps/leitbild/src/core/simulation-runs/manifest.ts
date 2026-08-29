import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { semanticVersionSchema, workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import { simulationRunIdSchema } from '../model/index.ts'
import type { ScenarioRevisionId } from '../scenarios/library.ts'

const resolvedPackSchema = z.object({
  id: z.string().min(1),
  version: semanticVersionSchema,
}).strict()

const resolvedRuntimeSchema = z.object({
  id: z.string().min(1),
  version: semanticVersionSchema,
  packId: z.string().min(1),
}).strict()

export const simulationRunManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: simulationRunIdSchema,
  workspaceId: workspaceIdSchema,
  scenario: z.object({
    id: z.string().min(1),
    revisionId: z.string().regex(/^revision-[a-f0-9]{32}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  packs: z.array(resolvedPackSchema).min(1),
  runtimes: z.array(resolvedRuntimeSchema).min(1),
  createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((manifest, ctx) => {
  const packIds = new Set(manifest.packs.map(pack => pack.id))
  if (packIds.size !== manifest.packs.length) {
    ctx.addIssue({ code: 'custom', path: ['packs'], message: 'duplicate resolved Pack id' })
  }
  const runtimeIds = new Set(manifest.runtimes.map(runtime => runtime.id))
  if (runtimeIds.size !== manifest.runtimes.length) {
    ctx.addIssue({ code: 'custom', path: ['runtimes'], message: 'duplicate resolved Pack Runtime id' })
  }
  manifest.runtimes.forEach((runtime, index) => {
    if (!packIds.has(runtime.packId)) {
      ctx.addIssue({ code: 'custom', path: ['runtimes', index, 'packId'], message: `runtime references inactive Pack: ${runtime.packId}` })
    }
  })
})

export type SimulationRunManifest = z.infer<typeof simulationRunManifestSchema>

export interface SimulationRunManifestStore {
  readonly load: () => Promise<SimulationRunManifest | null>
  readonly create: (manifest: SimulationRunManifest) => Promise<void>
}

export const createSimulationRunManifestStore = (path: string): SimulationRunManifestStore => ({
  load: async () => {
    try {
      return simulationRunManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  create: async (manifest) => {
    const validated = simulationRunManifestSchema.parse(manifest)
    try {
      await readFile(path, 'utf8')
      throw new Error(`Simulation Run Manifest already exists: ${validated.id}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  },
})

export const scenarioRevisionIdFromManifest = (manifest: SimulationRunManifest): ScenarioRevisionId =>
  manifest.scenario.revisionId as ScenarioRevisionId
