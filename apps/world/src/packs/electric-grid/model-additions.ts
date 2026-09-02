import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { GridModelDefinition } from './grid-model.ts'

const identity = { id: z.string().min(1), label: z.string().min(1) }
const provenance = { sourceId: z.string().min(1), sourceFeatureId: z.string().min(1) }
const kv = z.number().finite().positive()
const mw = z.number().finite().nonnegative()

// Deliberately one level: named base topology plus explicit additional assets.
// No recursive inheritance, arbitrary patches, implicit nodes or scenario logic.
export const gridModelAdditionSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), description: z.string().min(1),
  baseModelRef: z.string().min(1), sourceIds: z.array(z.string().min(1)),
  buses: z.array(z.object({
    ...identity, nominalKv: kv,
    location: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    ...provenance,
  }).strict()),
  branches: z.array(z.object({
    ...identity,
    kind: z.enum(['ac_line', 'cable', 'transformer', 'hvdc_link', 'switch']),
    fromBusId: z.string().min(1), toBusId: z.string().min(1), nominalKv: kv,
    ratingMw: mw, emergencyRatingMw: mw,
    reactancePu: z.number().finite().positive(), resistancePu: z.number().finite().nonnegative(),
    weatherExposure: z.enum(['low', 'medium', 'high']),
    ...provenance,
  }).strict()),
  connectionPoints: z.array(z.object({
    ...identity, busId: z.string().min(1), nominalKv: kv,
    maximumExportMw: mw, maximumImportMw: mw,
  }).strict()),
}).strict()

const directory = join(dirname(fileURLToPath(import.meta.url)), 'models')
export const gridModelAdditions = readdirSync(directory)
  .filter(name => name.endsWith('.grid-model.json')).sort()
  .map(name => gridModelAdditionSchema.parse(JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown))
if (new Set(gridModelAdditions.map(model => model.id)).size !== gridModelAdditions.length) {
  throw new Error('duplicate Grid Model addition id')
}

export const addGridModelAssets = (base: GridModelDefinition, addition: z.infer<typeof gridModelAdditionSchema>): GridModelDefinition => {
  if (base.id !== addition.baseModelRef) throw new Error(`Grid Model base mismatch: ${addition.baseModelRef}`)
  return {
    ...base, id: addition.id, title: addition.title, description: addition.description,
    sourceIds: [...new Set([...base.sourceIds, ...addition.sourceIds])],
    buses: [...base.buses, ...addition.buses],
    branches: [...base.branches, ...addition.branches],
    connectionPoints: [...base.connectionPoints, ...addition.connectionPoints],
  }
}
