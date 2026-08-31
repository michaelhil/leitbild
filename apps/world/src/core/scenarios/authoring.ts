import { z } from 'zod'
import type { WorldPack } from '../packs/protocol.ts'

const pathSegmentSchema = z.union([z.string().min(1), z.number().int().nonnegative()])
const pathSchema = z.array(pathSegmentSchema).min(1)

const controlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), defaultValue: z.string() }).strict(),
  z.object({
    kind: z.literal('number'),
    defaultValue: z.number().finite(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
  }).strict(),
  z.object({ kind: z.literal('boolean'), defaultValue: z.boolean() }).strict(),
  z.object({
    kind: z.literal('select'),
    defaultValue: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string().min(1) }).strict()).min(1),
  }).strict(),
])

const authoringFieldSchema = z.object({
  target: z.enum(['item', 'system']),
  path: pathSchema,
  label: z.string().min(1),
  control: controlSchema,
}).strict()

const authoringItemTypeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  idPrefix: z.string().regex(/^[a-z][a-z0-9-]*$/),
  defaultItem: z.record(z.string(), z.unknown()),
  placement: z.object({ target: z.literal('item'), path: pathSchema }).strict().optional(),
  linkedSystem: z.object({
    idPrefix: z.string().regex(/^[a-z][a-z0-9-]*$/),
    itemReferencePath: pathSchema,
    defaults: z.record(z.string(), z.unknown()),
  }).strict().optional(),
  fields: z.array(authoringFieldSchema),
}).strict()

const scenarioAuthoringFeatureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  categoryIds: z.array(z.string().min(1)),
  itemTypes: z.array(authoringItemTypeSchema),
}).strict()

export const scenarioAuthoringCatalogSchema = z.object({
  features: z.array(scenarioAuthoringFeatureSchema),
}).strict()

export type ScenarioAuthoringCatalog = z.infer<typeof scenarioAuthoringCatalogSchema>

export const scenarioAuthoringCatalogFor = (packs: ReadonlyArray<WorldPack>): ScenarioAuthoringCatalog => {
  const features = packs.map(pack => ({
    id: pack.descriptor.id,
    title: pack.descriptor.name,
    description: pack.descriptor.description ?? '',
    categoryIds: pack.presentation.categories.map(category => category.id),
    itemTypes: pack.authoring?.itemTypes ?? [],
  }))
  const ids = new Set<string>()
  for (const feature of features) {
    if (ids.has(feature.id)) throw new Error(`duplicate Scenario authoring feature: ${feature.id}`)
    ids.add(feature.id)
  }
  return scenarioAuthoringCatalogSchema.parse({
    features: features.sort((left, right) => left.title.localeCompare(right.title)),
  })
}
